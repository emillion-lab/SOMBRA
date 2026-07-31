/**
 * SOMBRA · одитор на твърдения
 * Cloudflare Worker + D1
 *
 * Secrets:  ANTHROPIC_API_KEY, ADMIN_TOKEN
 * Bindings: DB (D1)
 */

const MODEL = 'claude-sonnet-4-6';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

const uid = (p) => p + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const now = () => new Date().toISOString();

/* ─────────────────────────── промптове ─────────────────────────── */

const RULES = `
ПРАВИЛА (задължителни):
1. Използвай уеб търсене. Никога не измисляй източник, ръкопис, сигнатура, находка или изследване.
   Ако не можеш да посочиш проверима референция, задай "resolvable": false. Това е позволен и очакван изход.
2. За всеки източник преценявай дали е САМОСТОЯТЕЛНО свидетелство ("independent": true) или преразказва
   друг източник ("independent": false + "derives_from"). Двайсет преразказа на един извор са едно свидетелство.
3. Разграничавай "няма запазено доказателство" от "има доказателство за обратното". Това са различни неща.
4. Увереността е интервал. "low" не под 2, "high" не над 95. Ако доказателствата са оскъдни, интервалът е широк.
5. За всеки ред в "silence" дай "prior" — груба оценка (0..1) какъв дял от такива документи изобщо оцелява
   за съответния период и регион. Ако не знаеш, 0.5 и "cause":"неизвестно".
Върни САМО валиден JSON, без Markdown, без предговор и без текст след него.`;

const SHAPE = `{
 "atoms":[{"claim":"кратко проверимо твърдение","status":"supported|disputed|unverifiable","note":"едно изречение",
   "sources":[{"ref":"автор/издание/сигнатура","url":"https://... или празно","kind":"първичен|вторичен",
               "resolvable":true,"independent":true,"derives_from":""}]}],
 "silence":[{"expected":"какво би трябвало да е оцеляло","cause":"унищожено|неизследвано|никога не е съществувало|неизвестно","prior":0.5}],
 "falsifier":"конкретно откритие, което би оборило твърдението",
 "confidence":{"low":0,"high":0,"note":"защо интервалът е толкова широк"}
}`;

const proPrompt = (t) =>
`Ти си архивен одитор. Работиш на български.
Търси НАЙ-СИЛНИТЕ реални доказателства В ПОДКРЕПА на твърдението. Не разкрасявай: ако доказателства няма, кажи го.
${RULES}
Формат: ${SHAPE}

ТВЪРДЕНИЕ: ${t}`;

const conPrompt = (t) =>
`Ти си архивен одитор. Работиш на български.
Търси НАЙ-СИЛНИТЕ реални доказателства СРЕЩУ твърдението — опровержения, конкурентни обяснения, известни фалшификати,
хронологични несъвместимости. "confidence" тук изразява правдоподобността на ОТРИЧАНЕТО на твърдението.
${RULES}
Формат: ${SHAPE}

ТВЪРДЕНИЕ: ${t}`;

/* ─────────────────────────── Anthropic ─────────────────────────── */

async function ask(env, prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
    }),
  });

  if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + (await r.text()).slice(0, 300));

  const data = await r.json();
  if (data.stop_reason === 'max_tokens') throw new Error('Отговорът е прерязан от лимита на токените.');

  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const clean = text.replace(/```json|```/g, '').trim();
  const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('Отговорът не съдържа JSON.');
  return JSON.parse(clean.slice(a, b + 1));
}

/* ───────────────── обединяване на двата паса ─────────────────
   Пасът "срещу" оценява отричането, затова се обръща: 100-high .. 100-low.
   Взима се ОБЕДИНЕНИЕТО на двата интервала — несъгласието разширява
   несигурността и никога не я стеснява.                        */

function merge(pro, con) {
  const cl = (v, d) => Math.max(0, Math.min(100, Number.isFinite(+v) ? +v : d));
  const pl = cl(pro?.confidence?.low, 2),  ph = cl(pro?.confidence?.high, 95);
  const cl_ = cl(con?.confidence?.low, 2), ch = cl(con?.confidence?.high, 95);
  const invLow = 100 - ch, invHigh = 100 - cl_;
  return {
    low:  Math.max(2,  Math.min(pl, invLow)),
    high: Math.min(95, Math.max(ph, invHigh)),
    pro:  { low: pl, high: ph },
    con:  { low: cl_, high: ch },
  };
}

/* ─────────────────────────── запис на пас ─────────────────────────── */

async function persist(db, runId, side, res) {
  for (const a of (res.atoms || []).slice(0, 8)) {
    const status = ['supported', 'disputed', 'unverifiable'].includes(a.status) ? a.status : 'unverifiable';
    const ins = await db
      .prepare('INSERT INTO atoms (run_id,side,claim,status,note) VALUES (?,?,?,?,?)')
      .bind(runId, side, String(a.claim || '').slice(0, 500), status, String(a.note || '').slice(0, 500))
      .run();
    const atomId = ins.meta.last_row_id;

    for (const s of (a.sources || []).slice(0, 10)) {
      const ok = s.resolvable === true && !!s.url;
      await db
        .prepare(
          'INSERT INTO sources (atom_id,ref,url,kind,resolvable,independent,derives_from) VALUES (?,?,?,?,?,?,?)'
        )
        .bind(
          atomId,
          String(s.ref || '').slice(0, 300),
          ok ? String(s.url).slice(0, 500) : '',
          String(s.kind || '').slice(0, 40),
          ok ? 1 : 0,
          s.independent === false ? 0 : 1,
          String(s.derives_from || '').slice(0, 300)
        )
        .run();
    }
  }

  if (side === 'pro') {
    for (const g of (res.silence || []).slice(0, 6)) {
      await db
        .prepare('INSERT INTO silence (run_id,expected,cause,prior) VALUES (?,?,?,?)')
        .bind(runId, String(g.expected || '').slice(0, 400), String(g.cause || 'неизвестно'), Number(g.prior) || 0.5)
        .run();
    }
  }
}

/* ─────────────────────────── изпълнение ─────────────────────────── */

async function execute(env, runId, claimText) {
  const db = env.DB;
  try {
    await db.prepare("UPDATE runs SET status='running' WHERE id=?").bind(runId).run();

    // двата паса вървят паралелно и не се виждат един друг
    const [pro, con] = await Promise.all([ask(env, proPrompt(claimText)), ask(env, conPrompt(claimText))]);

    const m = merge(pro, con);
    await persist(db, runId, 'pro', pro);
    await persist(db, runId, 'contra', con);

    await db
      .prepare(
        `UPDATE runs SET status='done', finished_at=?, low=?, high=?,
         pro_low=?, pro_high=?, con_low=?, con_high=?, falsifier=?, note=? WHERE id=?`
      )
      .bind(
        now(), m.low, m.high, m.pro.low, m.pro.high, m.con.low, m.con.high,
        String(pro.falsifier || con.falsifier || '').slice(0, 800),
        String(pro?.confidence?.note || '').slice(0, 800),
        runId
      )
      .run();
  } catch (e) {
    await db
      .prepare("UPDATE runs SET status='error', finished_at=?, error=? WHERE id=?")
      .bind(now(), String(e.message).slice(0, 500), runId)
      .run();
  }
}

/* ─────────────────────────── калибрация ─────────────────────────── */

async function calibration(db) {
  const { results } = await db
    .prepare(
      `SELECT c.resolution, r.low, r.high
       FROM claims c JOIN runs r ON r.claim_id = c.id
       WHERE c.resolution IN ('true','false') AND r.status='done'
       GROUP BY c.id HAVING r.started_at = MAX(r.started_at)`
    )
    .all();

  if (!results.length) return { n: 0, brier: null, bias: null, note: 'Още няма разрешени твърдения.' };

  let sum = 0, biasSum = 0;
  for (const r of results) {
    const p = (r.low + r.high) / 200;      // среден залог 0..1
    const o = r.resolution === 'true' ? 1 : 0;
    sum += (p - o) ** 2;
    biasSum += p - o;
  }
  const brier = sum / results.length;
  const bias = biasSum / results.length;
  return {
    n: results.length,
    brier: +brier.toFixed(4),
    bias: +bias.toFixed(4),
    note:
      bias > 0.1 ? 'Инструментът системно надценява.'
      : bias < -0.1 ? 'Инструментът системно подценява.'
      : 'Без изразен системен наклон.',
  };
}

/* ─────────────────────────── рутер ─────────────────────────── */

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const p = url.pathname;
    const db = env.DB;
    const authed = req.headers.get('Authorization') === 'Bearer ' + env.ADMIN_TOKEN;

    try {
      /* нов одит */
      if (p === '/api/audit' && req.method === 'POST') {
        if (!authed) return json({ error: 'Липсва валиден токен.' }, 401);
        const body = await req.json();
        const text = String(body.text || '').trim();
        if (text.length < 8) return json({ error: 'Твърдението е твърде кратко.' }, 400);

        let claimId = body.claim_id;
        if (!claimId) {
          claimId = uid('clm');
          await db
            .prepare('INSERT INTO claims (id,text,domain,created_at) VALUES (?,?,?,?)')
            .bind(claimId, text.slice(0, 2000), String(body.domain || '').slice(0, 80), now())
            .run();
        }

        const runId = uid('run');
        await db
          .prepare("INSERT INTO runs (id,claim_id,status,started_at) VALUES (?,?,'queued',?)")
          .bind(runId, claimId, now())
          .run();

        ctx.waitUntil(execute(env, runId, text));
        return json({ claim_id: claimId, run_id: runId, status: 'queued' });
      }

      /* състояние на пускане */
      if (p.startsWith('/api/run/') && req.method === 'GET') {
        const id = p.split('/')[3];
        const run = await db.prepare('SELECT * FROM runs WHERE id=?').bind(id).first();
        if (!run) return json({ error: 'Няма такова пускане.' }, 404);
        if (run.status !== 'done') return json({ run });

        const atoms = (await db.prepare('SELECT * FROM atoms WHERE run_id=?').bind(id).all()).results;
        const gaps = (await db.prepare('SELECT * FROM silence WHERE run_id=?').bind(id).all()).results;
        for (const a of atoms) {
          a.sources = (await db.prepare('SELECT * FROM sources WHERE atom_id=?').bind(a.id).all()).results;
        }
        return json({ run, atoms, silence: gaps });
      }

      /* история на едно твърдение */
      if (p.startsWith('/api/claim/') && req.method === 'GET') {
        const id = p.split('/')[3];
        const claim = await db.prepare('SELECT * FROM claims WHERE id=?').bind(id).first();
        if (!claim) return json({ error: 'Няма такова твърдение.' }, 404);
        const runs = (
          await db
            .prepare('SELECT id,status,started_at,low,high,pro_low,pro_high,con_low,con_high FROM runs WHERE claim_id=? ORDER BY started_at DESC')
            .bind(id)
            .all()
        ).results;
        return json({ claim, runs });
      }

      /* списък */
      if (p === '/api/claims' && req.method === 'GET') {
        const { results } = await db
          .prepare('SELECT id,text,resolution,created_at FROM claims ORDER BY created_at DESC LIMIT 100')
          .all();
        return json({ claims: results });
      }

      /* разрешаване — храни калибрацията */
      if (p === '/api/resolve' && req.method === 'POST') {
        if (!authed) return json({ error: 'Липсва валиден токен.' }, 401);
        const b = await req.json();
        if (!['true', 'false', 'undetermined'].includes(b.resolution))
          return json({ error: 'resolution трябва да е true, false или undetermined.' }, 400);
        await db
          .prepare('UPDATE claims SET resolution=?, resolved_at=?, resolution_note=? WHERE id=?')
          .bind(b.resolution, now(), String(b.note || '').slice(0, 800), b.claim_id)
          .run();
        return json({ ok: true });
      }

      if (p === '/api/calibration' && req.method === 'GET') return json(await calibration(db));

      return json({ error: 'Няма такъв endpoint.' }, 404);
    } catch (e) {
      return json({ error: String(e.message).slice(0, 400) }, 500);
    }
  },
};
