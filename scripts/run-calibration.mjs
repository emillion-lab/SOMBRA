#!/usr/bin/env node
/**
 * SOMBRA · калибрационен тест
 *
 * Пуска регистър от твърдения с ПРЕДВАРИТЕЛНО ИЗВЕСТЕН верен отговор през
 * /api/audit, изчаква приключване на всеки одит, маркира резултата през
 * /api/resolve (така се храни собствената калибрация) и накрая отпечатва
 * /api/calibration (Brier score + системен наклон).
 *
 * Употреба:
 *   SOMBRA_EP="https://sombra.mihov-emil.workers.dev" \
 *   SOMBRA_TOKEN="som_..." \
 *   node scripts/run-calibration.mjs [път/до/dataset.json]
 *
 * По подразбиране чете calibration/calibration-set-2026-08.json.
 * Изисква Node 18+ (вграден fetch).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const EP = (process.env.SOMBRA_EP || 'https://sombra.mihov-emil.workers.dev').replace(/\/$/, '');
const TOKEN = process.env.SOMBRA_TOKEN;

if (!TOKEN) {
  console.error('Липсва SOMBRA_TOKEN (същия ADMIN_TOKEN, който е зададен в Cloudflare secrets).');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(here, '..', 'calibration', 'calibration-set-2026-08.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts = {}) {
  const r = await fetch(EP + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN, ...(opts.headers || {}) },
  });
  const d = await r.json().catch(() => ({ error: 'Отговорът не е JSON.' }));
  if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
  return d;
}

async function pollRun(runId, { tries = 90, delayMs = 2500 } = {}) {
  for (let i = 0; i < tries; i++) {
    await sleep(delayMs);
    const d = await api('/api/run/' + runId);
    if (d.run.status === 'done' || d.run.status === 'error') return d.run;
  }
  throw new Error('Одитът се проточи над лимита от ' + Math.round((tries * delayMs) / 1000) + 'с.');
}

async function main() {
  const items = JSON.parse(await readFile(FILE, 'utf8'));
  console.log(`Зареждам ${items.length} калибрационни твърдения от ${path.relative(process.cwd(), FILE)}`);
  console.log(`Worker: ${EP}\n`);

  const rows = [];

  for (const item of items) {
    process.stdout.write(`[${item.id}] `);
    try {
      const { claim_id, run_id } = await api('/api/audit', {
        method: 'POST',
        body: JSON.stringify({ text: item.claim, lang: 'bg' }),
      });

      const run = await pollRun(run_id);

      if (run.status === 'error') {
        console.log(`грешка при одита: ${run.error}`);
        rows.push({ ...item, ok: false, error: run.error });
        continue;
      }

      const resolution = item.expected_verdict === 'TRUE' ? 'true' : 'false';
      const note = `[${item.category}] очаквана несигурност ${item.expected_uncertainty} · ${item.verification_method}`.slice(0, 800);
      await api('/api/resolve', {
        method: 'POST',
        body: JSON.stringify({ claim_id, resolution, note }),
      });

      const mid = (run.low + run.high) / 2;
      const matched = (resolution === 'true' && mid >= 50) || (resolution === 'false' && mid < 50);
      console.log(
        `${run.low}–${run.high}% (среда ${mid.toFixed(0)}%) · очаквано ${item.expected_verdict} → ${matched ? 'съвпада' : 'РАЗМИНАВАНЕ'}`
      );
      rows.push({ ...item, claim_id, run_id, low: run.low, high: run.high, matched });
    } catch (e) {
      console.log(`провал: ${e.message}`);
      rows.push({ ...item, ok: false, error: e.message });
    }
    await sleep(1000); // да не се блъскаме в Crossref/OpenAlex/Wikipedia
  }

  const done = rows.filter((r) => r.matched !== undefined);
  const mism = done.filter((r) => r.matched === false);
  const failed = rows.filter((r) => r.ok === false);

  console.log(`\nОбработени: ${rows.length}. Успешни одити: ${done.length}. Провалени: ${failed.length}.`);
  if (mism.length) console.log(`Разминавания по посока (грешна страна на 50%): ${mism.length} → ${mism.map((r) => r.id).join(', ')}`);
  if (failed.length) console.log(`Провалени заявки: ${failed.map((r) => r.id).join(', ')}`);

  try {
    const calib = await api('/api/calibration');
    console.log('\nСобствена калибрация (/api/calibration):');
    console.log(calib);
  } catch (e) {
    console.log('\nНе успях да прочета /api/calibration: ' + e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
