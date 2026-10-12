import { config } from './config.js';
import { closePool } from './db/pool.js';
import { capture } from './eodhd/ingest.js';
import { buildJobs } from './eodhd/jobs.js';
import { replay } from './eodhd/replay.js';

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

try {
  if (cmd === 'capture') {
    const scope = flag('scope');
    if (!scope) throw new Error('Falta --scope=...');
    const symbols = (flag('symbols') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const jobs = buildJobs(scope, symbols);
    const budget = Number(flag('budget') ?? config.runBudget);
    const cost = jobs.reduce((n, j) => n + j.cost, 0);
    console.log(`Scope ${scope}: ${jobs.length} llamadas, coste ${cost}, tope de la corrida ${budget}.`);
    if (!args.includes('--go')) {
      for (const j of jobs) console.log(`  [dry-run] ${j.endpoint} ${j.symbol ?? ''} ${JSON.stringify(j.params)} (coste ${j.cost})`);
      console.log('Sin --go no se llama a la API.');
    } else {
      const s = await capture(scope, jobs, { budget, log: (m) => console.log(m) });
      console.log(`Corrida ${s.runId}: ${s.status}. Intentos ${s.attempts}, ok ${s.ok}, errores ${s.errors}, coste ${s.spent}/${s.budget}, trabajos ${s.jobsDone}/${jobs.length}${s.stoppedBy ? `, parada por ${s.stoppedBy}` : ''}.`);
    }
  } else if (cmd === 'replay') {
    const s = await replay({ runId: flag('run') });
    console.log(`Replay: ${s.checked} filas revisadas, ${s.ok} ok, ${s.error} con error.`);
  } else {
    console.log('Uso:\n  npm run capture -- --scope=symbols:LSE [--symbols=AAPL.US,...] [--budget=N] [--go]   (sin --go es dry-run)\n  npm run replay [-- --run=ID]');
  }
} finally {
  await closePool();
}
