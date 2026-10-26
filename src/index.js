/**
 * SOMBRA · claim auditor — free tier
 *
 * Sources come from real catalogues (Wikipedia, OpenAlex, Crossref) together with an excerpt
 * of their content. The model only ever sees numbered records and answers with numbers.
 * Two passes — for and against — judge the same records independently.
 * The code accepts numbers from that list alone — an invented source is impossible.
 *
 * Bindings: DB (D1), AI (Workers AI)
 * Secrets:  ADMIN_TOKEN
 */

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const UA = 'SombraAudit/1.0 (https://github.com/emillion-lab/SOMBRA)';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
const uid = (p) => p + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const now = () => new Date().toISOString();

/* ─────────────── the model does language, never facts ─────────────── */

/* Extract the first balanced {...} object, ignoring braces inside strings. */
function carve(text) {
  const t = String(text || '').replace(/```json|```/g, '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return t.slice(start, i + 1); }
  }
  return null;
}

/* Workers AI has returned several shapes over time; accept all of them. */
function textOf(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r.response === 'string') return r.response;
  if (r.response && typeof r.response === 'object') return JSON.stringify(r.response);
  const c = Array.isArray(r.choices) ? r.choices[0] : null;
  if (c) return (c.message && c.message.content) || c.text || '';
  if (r.result && typeof r.result.response === 'string') return r.result.response;
  if (typeof r.output_text === 'string') return r.output_text;
  return '';
}

function shapeOf(r) {
  try {
    return 'keys=' + Object.keys(r || {}).join('|') +
 ' head=' + JSON.stringify(r).slice(0, 180);
  } catch (e) { return 'unserialisable reply'; }
}

async function llm(env, system, user) {
  let lastErr = 'no attempt';
  for (let attempt = 0; attempt < 3; attempt++) {
    const nudge = attempt === 0 ? '' :
      '\n\nYour previous reply could not be parsed. Output the JSON object and nothing else: ' +
      'no greeting, no explanation, no code fence. Start with { and end with }.';
    const opts = {
      messages: [
        { role: 'system', content: system + ' Output raw JSON only.' },
        { role: 'user', content: user + nudge },
      ],
      max_tokens: 1800,
      temperature: attempt === 0 ? 0.1 : 0,
    };
    // Първият опит иска изричен JSON режим; ако моделът не го
    // поддържа, следващите минават без него.
    if (attempt === 0) opts.response_format = { type: 'json_object' };

    try {
      const r = await env.AI.run(MODEL, opts);
      const raw = textOf(r);
      if (!raw) { lastErr = 'empty reply · ' + shapeOf(r); continue; }
      const body = carve(raw);
      if (!body) { lastErr = 'no JSON in: ' + raw.slice(0, 180); continue; }
      return JSON.parse(body);
    } catch (e) {
      lastErr = e.message;
    }
  }
  throw new Error('Model gave no usable JSON in 3 attempts. Last: ' + lastErr);
}

/* Claim (any language) → search plan.
 * Научните каталози не знаят нищо за избори, фирми и новини — затова първо се решава
 * какъв е видът на твърдението и къде има смисъл да се търси. */
async function makeQueries(env, claim) {
  const out = await llm(
    env,
    'You plan searches that could settle a claim. Answer ONLY with JSON, no prose.',
    `Claim (may be in Bulgarian): "${claim}"

1. type: "event" if it is about recent or current facts (elections and their results, who holds
   an office, companies, organisations, prices, sports, news); "scholarly" if it is about history,
   science, medicine or anything studied in academic literature.
2. wiki_bg: a 2-6 word Bulgarian Wikipedia search for the ONE article most likely to settle it.
3. wiki_en: the same for English Wikipedia.
4. academic: 2 English queries for academic catalogues, 3-7 words each.
5. keywords: 6-12 words, names or numbers that a passage settling the claim would contain.
   Give names BOTH in Cyrillic and in Latin transliteration; give both Bulgarian and English words.

JSON: {"type":"event","wiki_bg":"...","wiki_en":"...","academic":["...","..."],"keywords":["..."]}`
  );
  const s = (v, n) => String(v || '').replace(/["']/g, ' ').trim().slice(0, n);
  const academic = (out.academic || []).map((q) => s(q, 120)).filter(Boolean).slice(0, 2);
  const keywords = (out.keywords || []).map((k) => s(k, 40)).filter((k) => k.length > 1).slice(0, 14);
  return {
    type: out.type === 'scholarly' ? 'scholarly' : 'event',
    wiki_bg: s(out.wiki_bg, 100) || claim.slice(0, 100),
    wiki_en: s(out.wiki_en, 100),
    academic: academic.length ? academic : [claim.slice(0, 100)],
    keywords,
  };
}

/* ─────────────── retrieval: records WITH their content ─────────────── */
// Моделът вижда не само заглавието, а и откъс от съдържанието — иначе може да
// потвърди само, че „има статия по темата“, но никога какво пише в нея.

const stripTags = (t) => String(t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// OpenAlex пази резюмето като обърнат индекс {дума:[позиции]}
function abstractOf(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const words = [];
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) words[p] = w;
  return words.filter(Boolean).join(' ');
}

async function crossref(q, rows) {
  const u = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=${rows}&select=DOI,title,author,issued,container-title,abstract`;
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.message?.items || []).map((it) => ({
    ref: [
      (it.author || []).slice(0, 2).map((a) => a.family).filter(Boolean).join(', '),
      (it.title || [])[0],
      (it['container-title'] || [])[0],
      it.issued?.['date-parts']?.[0]?.[0],
    ].filter(Boolean).join(' · ').slice(0, 280),
    url: 'https://doi.org/' + it.DOI,
    kind: 'secondary',
    text: stripTags(it.abstract).slice(0, 500),
  }));
}

async function openalex(q, rows) {
  const u = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${rows}&mailto=sombra@emillion-lab`;
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.results || []).map((w) => ({
    ref: [
      (w.authorships || []).slice(0, 2).map((a) => a.author?.display_name).filter(Boolean).join(', '),
      w.title,
      w.primary_location?.source?.display_name,
      w.publication_year,
    ].filter(Boolean).join(' · ').slice(0, 280),
    url: w.doi || w.id,
    kind: 'secondary',
    text: abstractOf(w.abstract_inverted_index).slice(0, 500),
  }));
}

async function wikiSearch(q, lang, limit) {
  if (!q) return [];
  const u = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=${limit}&format=json&origin=*`;
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.query?.search || []).map((s) => ({ lang, title: s.title, snippet: stripTags(s.snippet) }));
}

// Суровият wikitext пази и таблиците, и инфобоксовете — там са резултатите и числата.
// Обикновеният текстов извадък ги изпуска.
async function wikiPage(lang, title) {
  const u = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&formatversion=2&format=json&origin=*&titles=${encodeURIComponent(title)}`;
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!r.ok) return '';
  const d = await r.json();
  return d.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content || '';
}

function cleanWikitext(w) {
  return String(w || '').slice(0, 200000)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>]*\/>/g, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/\[\[(?:Файл|File|Image|Картинка|Category|Категория):[^\]]*\]\]/gi, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s([^\]]*)\]/g, '$1')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{\{|\}\}/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

// Кратка основа на думата — българските окончания („изборите“ / „избори“) не бива да пречат.
const stem = (w) => { w = w.toLowerCase(); return w.length > 6 ? w.slice(0, w.length - 2) : w; };

function termsOf(claim, keywords) {
  const words = [...keywords, ...String(claim).split(/[^\p{L}\p{N}]+/u)]
    .flatMap((k) => String(k).split(/\s+/))
    .filter((w) => w.length >= 4 || /^\d{2,}$/.test(w));
  return [...new Set(words.map(stem))];
}

/* Откъсите с най-много съвпадения, с по 2 реда около всеки — така редът с името
 * идва заедно с числата под него в таблицата или инфобокса. */
function excerpt(text, terms, max) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 1 && !/^[|!{}-]+$/.test(l));
  if (!lines.length || !terms.length) return '';
  const score = lines.map((l) => {
    const low = l.toLowerCase();
    let s = 0;
    for (const t of terms) if (low.includes(t)) s += 1;
    if (s && /\d/.test(l)) s += 0.5;
    return s;
  });
  const order = score.map((s, i) => [s, i]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]);
  const take = new Set();
  let len = 0;
  for (const [, i] of order) {
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
      if (take.has(j)) continue;
      take.add(j);
      len += lines[j].length + 3;
    }
    if (len >= max) break;
  }
  return [...take].sort((a, b) => a - b).map((j) => lines[j]).join(' / ').slice(0, max);
}

async function gather(plan, claim) {
  const terms = termsOf(claim, plan.keywords);
  const event = plan.type === 'event';

  // Wikipedia: две търсения на български, едно на английски; до 4 статии с откъси
  const hits = (await Promise.all([
    wikiSearch(plan.wiki_bg, 'bg', 2),
    wikiSearch(claim.slice(0, 100), 'bg', 2),
    wikiSearch(plan.wiki_en, 'en', 2),
  ].map((p) => p.catch(() => [])))).flat();
  const seenT = new Set();
  const pages = hits.filter((h) => { const k = h.lang + ':' + h.title; if (seenT.has(k)) return false; seenT.add(k); return true; }).slice(0, 4);
  const wiki = await Promise.all(pages.map(async (h) => {
    let text = '';
    try { text = excerpt(cleanWikitext(await wikiPage(h.lang, h.title)), terms, 1100); } catch (e) {}
    return {
      ref: 'Wikipedia (' + h.lang + '): ' + h.title,
      url: `https://${h.lang}.wikipedia.org/wiki/` + encodeURIComponent(h.title.replace(/ /g, '_')),
      kind: 'tertiary',
      text: text || h.snippet,
    };
  }));

  // Научни каталози: за събития едно леко търсене, за научни твърдения пълно
  const qs = event ? plan.academic.slice(0, 1) : plan.academic;
  const rows = event ? 2 : 4;
  const acad = (await Promise.all(qs.flatMap((q) => [openalex(q, rows), crossref(q, rows)])
    .map((p) => p.catch(() => [])))).flat();

  const all = event ? [...wiki, ...acad] : [...acad, ...wiki];
  const seen = new Set(), out = [];
  for (const s of all) {
    const key = (s.url || s.ref).toLowerCase();
    if (!s.url || !s.ref || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 14) break;
  }
  return out;
}

/* ─────────────── judgement: two independent passes ─────────────── */
// Пас ЗА търси какво подкрепя твърдението, пас СРЕЩУ — какво го опровергава.
// И двата дават правдоподобност, че твърдението е ВЯРНО; разминаването им разширява интервала.

const SIDE = {
  pro: 'Your job in this pass: find what in the records SUPPORTS the claim. Be strict: support must be stated in an excerpt, not implied by a title.',
  contra: 'Your job in this pass: find what in the records CONTRADICTS the claim or makes it false (a different person, number, ranking, date or place). Be strict: contradiction must be stated in an excerpt.',
};

async function judge(env, claim, pack, lang, side) {
  const list = pack.map((s, i) =>
    `[${i + 1}] ${s.ref}\n    ${s.text ? '"' + s.text.replace(/\s+/g, ' ') + '"' : '(no content available — title only)'}`
  ).join('\n');
  const prose = lang === 'bg' ? 'Bulgarian' : 'English';

  return llm(
    env,
    `You audit claims against a fixed list of retrieved records. ${SIDE[side]} Answer ONLY with JSON. Write all prose fields in ${prose}.`,
    `CLAIM: "${claim}"

RETRIEVED RECORDS — the ONLY evidence you may cite; refer to them by number. Each has an excerpt of its content:
${list || '(nothing was retrieved)'}

Rules:
- Judge by what the EXCERPTS say. A title alone proves nothing.
- Never invent a record. Only use numbers from the list above.
- If a record does not actually address the claim, do not cite it.
- "supported" only if an excerpt states it; "disputed" if an excerpt states something incompatible;
  otherwise "unverifiable".
- Distinguish "no surviving evidence" from "evidence of the opposite".
- confidence low/high = how plausible it is that the claim is TRUE, 2..95. Sparse evidence = wide interval.
- All prose fields in ${prose}. Maximum 4 atoms, 3 silence rows.

JSON:
{"atoms":[{"claim":"...","status":"supported|disputed|unverifiable","note":"...","cite":[1,2]}],
 "silence":[{"expected":"...","cause":"destroyed|unstudied|never existed|unknown","prior":0.5}],
 "falsifier":"...",
 "confidence":{"low":10,"high":60,"note":"..."}}`
  );
}

/* ─────────────── persistence ─────────────── */

async function persist(db, runId, passes, pack) {
  for (const { side, res } of passes) {
    for (const a of (res.atoms || []).slice(0, 4)) {
      const status = ['supported', 'disputed', 'unverifiable'].includes(a.status) ? a.status : 'unverifiable';
      const ins = await db
        .prepare('INSERT INTO atoms (run_id,side,claim,status,note) VALUES (?,?,?,?,?)')
        .bind(runId, side, String(a.claim || '').slice(0, 500), status, String(a.note || '').slice(0, 500))
        .run();
      const atomId = ins.meta.last_row_id;

      // only indices from the retrieved list survive; everything else is dropped
      const cites = [...new Set((a.cite || []).map((n) => parseInt(n, 10)))].filter((n) => n >= 1 && n <= pack.length);
      for (const n of cites.slice(0, 6)) {
        const s = pack[n - 1];
        await db
          .prepare('INSERT INTO sources (atom_id,ref,url,kind,resolvable,independent,derives_from) VALUES (?,?,?,?,1,?,?)')
          .bind(atomId, s.ref, s.url, s.kind, s.kind === 'tertiary' ? 0 : 1, s.kind === 'tertiary' ? 'secondary literature' : '')
          .run();
      }
    }
  }

  // мълчанието идва и от двата паса; без празни редове и без измислен дял
  const seen = new Set();
  const gaps = passes.flatMap((p) => p.res.silence || [])
    .filter((g) => { const k = String(g.expected || '').trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 4);
  for (const g of gaps) {
    const prior = Number(g.prior);
    await db
      .prepare('INSERT INTO silence (run_id,expected,cause,prior) VALUES (?,?,?,?)')
      .bind(runId, String(g.expected).slice(0, 400), String(g.cause || 'unknown'), Number.isFinite(prior) ? Math.max(0, Math.min(1, prior)) : null)
      .run();
  }
}

const interval = (res) => {
  const cl = (v, d) => Math.max(2, Math.min(95, Number.isFinite(+v) ? +v : d));
  let lo = cl(res?.confidence?.low, 2), hi = cl(res?.confidence?.high, 95);
  if (hi < lo) [lo, hi] = [hi, lo];
  return [lo, hi];
};

async function execute(env, runId, claim, lang) {
  const db = env.DB;
  try {
    await db.prepare("UPDATE runs SET status='running' WHERE id=?").bind(runId).run();

    const plan = await makeQueries(env, claim);
    const pack = await gather(plan, claim);
    const [pro, contra] = await Promise.all([
      judge(env, claim, pack, lang, 'pro'),
      judge(env, claim, pack, lang, 'contra'),
    ]);

    const [pLo, pHi] = interval(pro);
    const [cLo, cHi] = interval(contra);
    // обединеният интервал покрива и двата паса — несъгласието го разширява
    let low = Math.min(pLo, cLo), high = Math.max(pHi, cHi);
    if (!pack.length) { low = Math.min(low, 5); high = Math.max(high, 90); }

    await persist(db, runId, [{ side: 'pro', res: pro }, { side: 'contra', res: contra }], pack);

    const withText = pack.filter((s) => s.text).length;
    const note = [pro?.confidence?.note, contra?.confidence?.note]
      .map((n) => String(n || '').trim()).filter(Boolean).join(' / ').slice(0, 700) +
      ` · Reviewed ${pack.length} records (${withText} with content) from Wikipedia, OpenAlex and Crossref.`;
    const falsifier = String(pro.falsifier || contra.falsifier || '').slice(0, 800);

    // con_low/con_high пазят пас СРЕЩУ „обърнат“ — страницата го връща обратно с 100−x
    await db
      .prepare(
        `UPDATE runs SET status='done', finished_at=?, low=?, high=?, pro_low=?, pro_high=?,
         con_low=?, con_high=?, falsifier=?, note=?, pack=? WHERE id=?`
      )
      .bind(now(), low, high, pLo, pHi, 100 - cHi, 100 - cLo, falsifier, note,
        JSON.stringify(pack).slice(0, 60000), runId)
      .run();
  } catch (e) {
    await db
      .prepare("UPDATE runs SET status='error', finished_at=?, error=? WHERE id=?")
      .bind(now(), String(e.message).slice(0, 500), runId)
      .run();
  }
}

/* ─────────────── calibration ─────────────── */

async function calibration(db) {
  const { results } = await db
    .prepare(
      `SELECT c.resolution, r.low, r.high FROM claims c JOIN runs r ON r.claim_id=c.id
       WHERE c.resolution IN ('true','false') AND r.status='done'
       GROUP BY c.id HAVING r.started_at = MAX(r.started_at)`
    )
    .all();

  if (!results.length) return { n: 0, brier: null, bias: null, note: 'No resolved claims yet.' };

  let sum = 0, bs = 0;
  for (const r of results) {
    const p = (r.low + r.high) / 200;
    const o = r.resolution === 'true' ? 1 : 0;
    sum += (p - o) ** 2;
    bs += p - o;
  }
  const bias = bs / results.length;
  return {
    n: results.length,
    brier: +(sum / results.length).toFixed(4),
    bias: +bias.toFixed(4),
    note: bias > 0.1 ? 'The tool systematically overrates.' : bias < -0.1 ? 'The tool systematically underrates.' : 'No pronounced systematic bias.',
  };
}

/* ─────────────── router ─────────────── */

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const p = new URL(req.url).pathname;
    const db = env.DB;
    const authed = req.headers.get('Authorization') === 'Bearer ' + env.ADMIN_TOKEN;

    try {
      if (p === '/api/audit' && req.method === 'POST') {
        if (!authed) return json({ error: 'Missing or invalid token.' }, 401);
        const body = await req.json();
        const text = String(body.text || '').trim();
        if (text.length < 8) return json({ error: 'Claim is too short.' }, 400);
        const lang = body.lang === 'bg' ? 'bg' : 'en';

        const claimId = uid('clm');
        await db
          .prepare('INSERT INTO claims (id,text,domain,created_at) VALUES (?,?,?,?)')
          .bind(claimId, text.slice(0, 2000), lang, now())
          .run();

        const runId = uid('run');
        await db
          .prepare("INSERT INTO runs (id,claim_id,status,started_at) VALUES (?,?,'queued',?)")
          .bind(runId, claimId, now())
          .run();

        ctx.waitUntil(execute(env, runId, text, lang));
        return json({ claim_id: claimId, run_id: runId, status: 'queued' });
      }

      if (p.startsWith('/api/run/') && req.method === 'GET') {
        const id = p.split('/')[3];
        const run = await db.prepare('SELECT * FROM runs WHERE id=?').bind(id).first();
        if (!run) return json({ error: 'No such run.' }, 404);
        if (run.status !== 'done') return json({ run });

        const atoms = (await db.prepare('SELECT * FROM atoms WHERE run_id=?').bind(id).all()).results;
        const gaps = (await db.prepare('SELECT * FROM silence WHERE run_id=?').bind(id).all()).results;
        for (const a of atoms) {
          a.sources = (await db.prepare('SELECT * FROM sources WHERE atom_id=?').bind(a.id).all()).results;
        }
        let pack = [];
      try { pack = JSON.parse(run.pack || '[]'); } catch (e) { pack = []; }
      const cited = new Set();
      for (const a of atoms) for (const s of a.sources) cited.add(s.url);
      const reviewed = pack.map((r) => ({ ...r, cited: cited.has(r.url) }));
      return json({ run, atoms, silence: gaps, reviewed });
      }

      if (p === '/api/claims' && req.method === 'GET') {
        const { results } = await db
          .prepare('SELECT id,text,resolution,created_at FROM claims ORDER BY created_at DESC LIMIT 100')
          .all();
        return json({ claims: results });
      }

      if (p === '/api/resolve' && req.method === 'POST') {
        if (!authed) return json({ error: 'Missing or invalid token.' }, 401);
        const b = await req.json();
        if (!['true', 'false', 'undetermined'].includes(b.resolution))
          return json({ error: 'resolution must be true, false or undetermined.' }, 400);
        await db
          .prepare('UPDATE claims SET resolution=?, resolved_at=?, resolution_note=? WHERE id=?')
          .bind(b.resolution, now(), String(b.note || '').slice(0, 800), b.claim_id)
          .run();
        return json({ ok: true });
      }

      if (p === '/api/calibration' && req.method === 'GET') return json(await calibration(db));

      return json({ error: 'No such endpoint.' }, 404);
    } catch (e) {
      return json({ error: String(e.message).slice(0, 400) }, 500);
    }
  },
};
