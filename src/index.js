/**
 * SOMBRA · claim auditor — free tier
 *
 * Sources come from real catalogues (Crossref, OpenAlex, Wikipedia).
 * The model only ever sees numbered records and answers with numbers.
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

/* Claim (any language) → English catalogue queries. */
async function makeQueries(env, claim) {
  const out = await llm(
    env,
    'You turn a claim into literature search queries. Answer ONLY with JSON, no prose.',
    `Claim (may be in Bulgarian): "${claim}"

Produce 4 short English search queries for academic catalogues. Two should look for evidence
supporting the claim, two for evidence against it or for competing explanations.
Use scholarly vocabulary, 3-7 words each, no quotes inside.

JSON: {"queries":["...","...","...","..."]}`
  );
  const q = (out.queries || []).map((s) => String(s).slice(0, 120)).filter(Boolean);
  return q.length ? q.slice(0, 4) : [claim.slice(0, 100)];
}

/* ─────────────── retrieval from free catalogues ─────────────── */

async function crossref(q) {
  const u = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=4&select=DOI,title,author,issued,container-title`;
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
  }));
}

async function openalex(q) {
  const u = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=4&mailto=sombra@emillion-lab`;
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
  }));
}

async function wiki(q, lang) {
  const u = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=3&format=json&origin=*`;
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.query?.search || []).map((s) => ({
    ref: 'Wikipedia (' + lang + '): ' + s.title,
    url: `https://${lang}.wikipedia.org/wiki/` + encodeURIComponent(s.title.replace(/ /g, '_')),
    kind: 'tertiary',
  }));
}

async function gather(queries, claim) {
  const jobs = [];
  for (const q of queries) { jobs.push(crossref(q)); jobs.push(openalex(q)); }
  jobs.push(wiki(claim.slice(0, 100), 'bg'));
  jobs.push(wiki(queries[0] || claim.slice(0, 100), 'en'));

  const all = (await Promise.all(jobs.map((p) => p.catch(() => [])))).flat();

  const seen = new Set(), out = [];
  for (const s of all) {
    const key = (s.url || s.ref).toLowerCase();
    if (!s.url || !s.ref || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 24) break;
  }
  return out;
}

/* ─────────────── judgement over what was retrieved ─────────────── */

async function judge(env, claim, pack, lang) {
  const list = pack.map((s, i) => `[${i + 1}] ${s.ref}`).join('\n');
  const prose = lang === 'bg' ? 'Bulgarian' : 'English';

  const out = await llm(
    env,
    `You audit claims against a fixed list of retrieved records. Answer ONLY with JSON. Write all prose fields in ${prose}.`,
    `CLAIM: "${claim}"

RETRIEVED RECORDS (this is the ONLY evidence you may cite; refer to them by number):
${list || '(nothing was retrieved)'}

Rules:
- Never invent a record. Only use numbers from the list above.
- If a record does not actually address the claim, do not cite it.
- If the list contains nothing relevant, say so and keep the interval very wide.
- "supported" only if a listed record really addresses and supports the atom.
- Distinguish "no surviving evidence" from "evidence of the opposite".
- low >= 2, high <= 95. Sparse evidence means a wide interval.
- All prose fields in ${prose}. Maximum 4 atoms, 3 silence rows.

JSON:
{"atoms":[{"claim":"...","status":"supported|disputed|unverifiable","note":"...","cite":[1,2]}],
 "silence":[{"expected":"...","cause":"destroyed|unstudied|never existed|unknown","prior":0.5}],
 "falsifier":"...",
 "confidence":{"low":10,"high":60,"note":"..."}}`
  );
  return out;
}

/* ─────────────── persistence ─────────────── */

async function persist(db, runId, res, pack) {
  for (const a of (res.atoms || []).slice(0, 6)) {
    const status = ['supported', 'disputed', 'unverifiable'].includes(a.status) ? a.status : 'unverifiable';
    const ins = await db
      .prepare('INSERT INTO atoms (run_id,side,claim,status,note) VALUES (?,?,?,?,?)')
      .bind(runId, 'pro', String(a.claim || '').slice(0, 500), status, String(a.note || '').slice(0, 500))
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

  for (const g of (res.silence || []).slice(0, 5)) {
    await db
      .prepare('INSERT INTO silence (run_id,expected,cause,prior) VALUES (?,?,?,?)')
      .bind(runId, String(g.expected || '').slice(0, 400), String(g.cause || 'unknown'), Number(g.prior) || 0.5)
      .run();
  }
}

async function execute(env, runId, claim, lang) {
  const db = env.DB;
  try {
    await db.prepare("UPDATE runs SET status='running' WHERE id=?").bind(runId).run();

    const queries = await makeQueries(env, claim);
    const pack = await gather(queries, claim);
    const res = await judge(env, claim, pack, lang);

    const cl = (v, d) => Math.max(0, Math.min(100, Number.isFinite(+v) ? +v : d));
    let low = Math.max(2, cl(res?.confidence?.low, 2));
    let high = Math.min(95, cl(res?.confidence?.high, 95));
    if (high < low) [low, high] = [high, low];

    // nothing retrieved => the interval cannot be narrow
    if (!pack.length) { low = Math.min(low, 5); high = Math.max(high, 90); }

    await persist(db, runId, res, pack);

    const note =
      String(res?.confidence?.note || '').slice(0, 700) +
      ` · Reviewed ${pack.length} records from Crossref, OpenAlex and Wikipedia.`;

    await db
      .prepare(
        `UPDATE runs SET status='done', finished_at=?, low=?, high=?, pro_low=?, pro_high=?,
         con_low=?, con_high=?, falsifier=?, note=? WHERE id=?`
      )
      .bind(now(), low, high, low, high, 100 - high, 100 - low, String(res.falsifier || '').slice(0, 800), note, runId)
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
        return json({ run, atoms, silence: gaps });
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
