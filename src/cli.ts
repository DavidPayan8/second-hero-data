import { hashPassword, parseUsers } from './admin/auth.js';
import { crearServidor } from './admin/server.js';
import pg from 'pg';
import { config } from './config.js';
import { closePool, pool } from './db/pool.js';
import { captureSec, secJobs } from './sec/client.js';
import { runValidation } from './validation/runner.js';
import { capture } from './eodhd/ingest.js';
import { buildJobs } from './eodhd/jobs.js';
import { keepPrimaryListings } from './eodhd/universe.js';
import { replay } from './eodhd/replay.js';
import { captureBatch, captureIndex, planBatch } from './esef/capture.js';
import { extractAll } from './esef/extract.js';
import { identifyAll, loadListIndex } from './esef/identify.js';
import { insertarSiFalta, leerTodas, planPull, planPush, upsertRevision } from './esef/sync.js';
import { ESEF_CONFIG } from './esef/config.js';

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
  } else if (cmd === 'esef-capture') {
    // Segunda fuente europea (ESEF/UKSEF, filings.xbrl.org). Sin --go es un dry-run; con --go exige SEC_USER_AGENT (se reutiliza), máximo 1 petición por segundo.
    // --index: foto del índice completo (una vez). --batch: informes de esa foto filtrando por --country, --year o --leis.
    const list = (n: string) => flag(n)?.split(',').map((x) => x.trim()).filter(Boolean);
    const go = args.includes('--go');
    const ac = new AbortController();
    process.once('SIGINT', () => { console.log('Interrumpido: se cierra la corrida tras la llamada en curso.'); ac.abort(); });
    if (args.includes('--index')) {
      if (!go) console.log('ESEF índice: se descargarían todas las páginas del índice de filings.xbrl.org (una foto de referencia). Sin --go no se llama.');
      else {
        const s = await captureIndex({ log: (m) => console.log(m), signal: ac.signal });
        console.log(`Corrida ${s.runId}: ${s.status}. Intentos ${s.attempts}, ok ${s.ok}, errores ${s.errors}, páginas ${s.jobsDone}/${s.jobsDone + s.jobsSkipped}${s.stoppedBy ? `, parada por ${s.stoppedBy}` : ''}.`);
      }
    } else if (args.includes('--batch')) {
      const limit = flag('limit');
      const filters = { ...(list('country') ? { countries: list('country')! } : {}), ...(list('year') ? { years: list('year')! } : {}), ...(list('leis') ? { leis: list('leis')! } : {}), ...(limit ? { limit: Number(limit) } : {}) };
      if (!go) {
        const plan = await planBatch(filters);
        console.log(`ESEF lote ${plan.scope} (foto del índice: corrida ${plan.indexRunId}): ${plan.candidates} informes cumplen los filtros, ${plan.alreadyCaptured} ya capturados, ${plan.jobs.length} por descargar (~${Math.ceil(plan.jobs.length * ESEF_CONFIG.minIntervalMs / 60000)} min como mínimo).`);
        for (const j of plan.jobs.slice(0, 20)) console.log(`  [dry-run] ${j.params.fxo_id}`);
        if (plan.jobs.length > 20) console.log(`  … y ${plan.jobs.length - 20} más`);
        console.log('Sin --go no se llama.');
      } else {
        const s = await captureBatch(filters, { log: (m) => console.log(m), signal: ac.signal });
        console.log(`Corrida ${s.runId} (${s.scope}): ${s.status}. ${s.plan.candidates} candidatos, ${s.plan.alreadyCaptured} ya capturados. Intentos ${s.attempts}, ok ${s.ok}, errores ${s.errors}, trabajos ${s.jobsDone}/${s.plan.jobs}${s.stoppedBy ? `, parada por ${s.stoppedBy}` : ''}.`);
      }
    } else throw new Error('esef-capture necesita --index o --batch');
  } else if (cmd === 'esef-extract') {
    // Extractor de ESEF: del crudo (raw_payload + payload_blob) a esef_filing + esef_fact. Sin red.
    const s = await extractAll({ ...(flag('run') ? { runId: flag('run')! } : {}), all: args.includes('--all') });
    console.log(`Extractor ${ESEF_CONFIG.extractorVersion}: ${s.checked} payloads revisados, ${s.filings} informes anuales, ${s.facts} hechos, ${s.skippedNotAnnual} sin periodo anual (descartados), ${s.error} con error.`);
  } else if (cmd === 'esef-identify') {
    // Candidatos LEI -> ISIN (P20): GLEIF filtrado contra las listas de bolsa capturadas. Sin --go es un dry-run (no llama a GLEIF ni escribe).
    const leis = flag('leis')?.split(',').map((x) => x.trim()).filter(Boolean);
    if (!args.includes('--go')) {
      const listed = await loadListIndex();
      console.log(`ESEF identificar: ${listed.size} ISIN en las listas de bolsa capturadas (sin EEUU). Se pedirían a GLEIF los ISIN de ${leis?.length ?? 'todos los'} LEI de esef_filing (~1 petición por segundo). Sin --go no se llama.`);
    } else {
      if (!config.secUserAgent) throw new Error('esef-identify necesita SEC_USER_AGENT en .env (User-Agent con nombre y contacto)');
      const ac = new AbortController();
      process.once('SIGINT', () => { console.log('Interrumpido: se cierra tras el LEI en curso.'); ac.abort(); });
      const s = await identifyAll({ ...(leis ? { leis } : {}), log: (m) => console.log(m), signal: ac.signal });
      console.log(`Identificar: ${s.leis} LEI, ${s.listIsins} ISIN en listas. Con candidato ${s.withCandidate} (aceptados automáticos ${s.accepted}, propuestos ${s.proposed}); GLEIF sin ISIN ${s.noGleifIsin}; listas truncadas ${s.truncated}; errores ${s.failed}.`);
    }
  } else if (cmd === 'esef-push-candidates' || cmd === 'esef-pull-reviews') {
    // Sincroniza esef_lei_isin con Azure: push = candidatos que faltan allí (no pisa nada); pull = revisiones hechas allí. Sin --go es dry-run.
    if (!config.azureDatabaseUrl) throw new Error(`${cmd} necesita AZURE_DATABASE_URL en .env (con ?sslmode=require)`);
    const azure = new pg.Pool({ connectionString: config.azureDatabaseUrl, max: 2 });
    try {
      const [local, remoto] = [await leerTodas(pool), await leerTodas(azure)];
      const plan = cmd === 'esef-push-candidates' ? planPush(local, remoto) : planPull(remoto, local);
      console.log(`${cmd}: local ${local.length} filas, Azure ${remoto.length}; se escribirían ${plan.length} en ${cmd === 'esef-push-candidates' ? 'Azure' : 'local'}.`);
      if (args.includes('--go')) {
        const n = cmd === 'esef-push-candidates' ? await insertarSiFalta(azure, plan) : await upsertRevision(pool, plan);
        console.log(`Escritas ${n}.`);
      } else console.log('Sin --go no se escribe.');
    } finally { await azure.end(); }
  } else if (cmd === 'admin') {
    // Panel web de revisión de esef_lei_isin y visor de payload_blob. Se queda escuchando hasta Ctrl+C.
    const users = parseUsers(config.adminUsers);
    if (users.size === 0) throw new Error('admin necesita ADMIN_USERS en .env (genera cada hash con: npm run admin-hash -- <clave>)');
    if (config.adminSessionSecret.length < 16) throw new Error('admin necesita ADMIN_SESSION_SECRET (≥ 16 caracteres) en .env');
    const srv = crearServidor({ db: pool, users, secret: config.adminSessionSecret });
    await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(config.adminPort, config.adminHost, resolve); });
    console.log(`Panel en http://${config.adminHost}:${config.adminPort} (usuarios: ${[...users.keys()].join(', ')}). Ctrl+C para parar.`);
    await new Promise<void>((resolve) => process.once('SIGINT', () => { srv.close(); resolve(); }));
  } else if (cmd === 'admin-hash') {
    if (!args[0]) throw new Error('uso: npm run admin-hash -- <clave>');
    console.log(hashPassword(args[0]));
  } else {
    console.log([
      'Uso:',
      '  npm run admin   (panel web de revisión ESEF y visor de payload; exige ADMIN_USERS y ADMIN_SESSION_SECRET)',
      '  npm run admin-hash -- <clave>   (hash para ADMIN_USERS)',
      '  npm run esef-push-candidates [-- --go]   (sube a Azure los candidatos de esef_lei_isin que faltan; exige AZURE_DATABASE_URL; sin --go es dry-run)',
      '  npm run esef-pull-reviews [-- --go]   (trae a local las revisiones hechas en Azure; sin --go es dry-run)',
      '  npm run capture -- --scope=symbols:LSE [--symbols=AAPL.US,...] [--budget=N] [--demo] [--go]   (sin --go es dry-run; --demo usa la clave pública demo)',
      '  npm run replay [-- --run=ID] [--all]   (--all vuelve a pasar también lo ya marcado)',
      '  npm run validate [-- --today=YYYY-MM-DD] [--rules=A,B]   (ejecuta las reglas activas del catálogo)',
      '  npm run sec-capture [-- --ciks=0000320193,...] [--go]   (companyfacts de la SEC; exige SEC_USER_AGENT en .env)',
      '  npm run esef-capture -- --index [--go]   (foto del índice de filings.xbrl.org; ≤ 1 petición/s; exige SEC_USER_AGENT)',
      '  npm run esef-capture -- --batch [--country=ES,GB] [--year=2023] [--leis=...] [--limit=N] [--go]   (informes de la foto; reanudable)',
      '  npm run esef-extract [-- --run=ID] [--all]   (xBRL-JSON crudo -> esef_filing y esef_fact; sin red)',
      '  npm run esef-identify [-- --leis=...] [--go]   (candidatos LEI -> ISIN con GLEIF contra las listas de bolsa; exige SEC_USER_AGENT; sin --go es dry-run)',
    ].join('\n'));
  }
} finally {
  await closePool();
}
