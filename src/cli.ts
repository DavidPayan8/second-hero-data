import { config } from './config.js';
import { closePool, pool } from './db/pool.js';
import { captureSec, secJobs } from './sec/client.js';
import { runValidation } from './validation/runner.js';
import { capture } from './eodhd/ingest.js';
import { buildJobs } from './eodhd/jobs.js';
import { keepPrimaryListings } from './eodhd/universe.js';
import { replay } from './eodhd/replay.js';

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

try {
  if (cmd === 'capture') {
    const scope = flag('scope');
    if (!scope) throw new Error('Falta --scope=...');
    const symbols = (flag('symbols') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const filtered = await keepPrimaryListings(buildJobs(scope, symbols));
    const jobs = filtered.jobs;
    for (const k of filtered.skipped) console.log(`  [omitido] ${k.endpoint} ${k.symbol}: ${k.reason}`);
    const budget = Number(flag('budget') ?? config.runBudget);
    const cost = jobs.reduce((n, j) => n + j.cost, 0);
    console.log(`Scope ${scope}: ${jobs.length} llamadas, coste ${cost}, tope de la corrida ${budget}.`);
    if (!args.includes('--go')) {
      for (const j of jobs) console.log(`  [dry-run] ${j.endpoint} ${j.symbol ?? ''} ${JSON.stringify(j.params)} (coste ${j.cost})`);
      console.log('Sin --go no se llama a la API.');
    } else {
      // --demo usa la clave pública "demo" de EODHD (otra cuota, solo algunos símbolos) en lugar de la clave propia.
      const s = await capture(scope, jobs, { budget, log: (m) => console.log(m), ...(args.includes('--demo') ? { apiKey: 'demo' } : {}) });
      console.log(`Corrida ${s.runId}: ${s.status}. Intentos ${s.attempts}, ok ${s.ok}, errores ${s.errors}, coste ${s.spent}/${s.budget}, trabajos ${s.jobsDone}/${jobs.length}${s.stoppedBy ? `, parada por ${s.stoppedBy}` : ''}.`);
    }
  } else if (cmd === 'replay') {
    const s = await replay({ runId: flag('run'), all: args.includes('--all') });
    console.log(`Replay: ${s.checked} filas revisadas, ${s.ok} ok, ${s.error} con error${s.deferred ? `, ${s.deferred} pendientes (sin listing todavía)` : ''}.`);
    if (s.prices) console.log('Precios:', JSON.stringify(s.prices));
    if (s.dividends) console.log('Dividendos:', JSON.stringify(s.dividends));
    if (s.splits) console.log('Splits:', JSON.stringify(s.splits));
    if (s.fx) console.log('FX:', JSON.stringify(s.fx));
    if (s.fundamentals) console.log('Fundamentals:', JSON.stringify(s.fundamentals));
    if (s.news) console.log('Noticias:', JSON.stringify(s.news));
    if (s.listings) console.log(`Listings (${s.listingsSweeps} pasada${s.listingsSweeps === 1 ? '' : 's'}):`, JSON.stringify(s.listings));
  } else if (cmd === 'validate') {
    const s = await runValidation({ ...(flag('today') ? { today: flag('today')! } : {}), ...(flag('rules') ? { only: flag('rules')!.split(',') } : {}) });
    console.log(`Validación a ${s.today}:`);
    for (const [rule, c] of Object.entries(s.ran)) console.log(`  ${rule}: ${JSON.stringify(c)}`);
    for (const [rule, m] of Object.entries(s.failed)) console.log(`  ${rule}: ERROR ${m}`);
    if (s.disabled.length) console.log(`  Apagadas: ${s.disabled.join(', ')}`);
    if (s.withoutLogic.length) console.log(`  Sin lógica en el runner (las emite el normalizador): ${s.withoutLogic.join(', ')}`);
    if (Object.keys(s.failed).length) process.exitCode = 1;
  } else if (cmd === 'sec-capture') {
    // Segunda fuente (SEC companyfacts) para las empresas con CIK y fundamentals. Sin --go es un dry-run; con --go exige SEC_USER_AGENT.
    const ciks = flag('ciks')?.split(',').map((x) => x.trim()).filter(Boolean)
      ?? (await pool.query<{ cik: string }>('SELECT DISTINCT c.cik FROM company c JOIN fundamentals f USING (company_id) WHERE c.cik IS NOT NULL ORDER BY 1')).rows.map((r) => r.cik);
    const jobs = secJobs(ciks);
    console.log(`SEC companyfacts: ${jobs.length} llamadas (sin cuota; máximo 10 por segundo).`);
    if (!args.includes('--go')) { for (const j of jobs) console.log(`  [dry-run] ${j.endpoint} ${j.symbol}`); console.log('Sin --go no se llama a la SEC.'); }
    else {
      const s = await captureSec(ciks, { log: (m) => console.log(m) });
      console.log(`Corrida ${s.runId}: ${s.status}. Intentos ${s.attempts}, ok ${s.ok}, errores ${s.errors}, trabajos ${s.jobsDone}/${jobs.length}.`);
    }
  } else {
    console.log([
      'Uso:',
      '  npm run capture -- --scope=symbols:LSE [--symbols=AAPL.US,...] [--budget=N] [--demo] [--go]   (sin --go es dry-run; --demo usa la clave pública demo)',
      '  npm run replay [-- --run=ID] [--all]   (--all vuelve a pasar también lo ya marcado)',
      '  npm run validate [-- --today=YYYY-MM-DD] [--rules=A,B]   (ejecuta las reglas activas del catálogo)',
      '  npm run sec-capture [-- --ciks=0000320193,...] [--go]   (companyfacts de la SEC; exige SEC_USER_AGENT en .env)',
    ].join('\n'));
  }
} finally {
  await closePool();
}
