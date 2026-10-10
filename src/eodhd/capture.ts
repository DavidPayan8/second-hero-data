import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { fetchRaw } from './client.js';
import { QUEUE, type Job } from './endpoints.js';

const dir = config.fixturesDir;
const quotaFile = join(dir, 'quota.json');
const manifestFile = join(dir, 'manifest.json');

interface Quota { day: string; used: number }
interface ManifestEntry { endpoint: string; key: string; url: string; status: number; fetched_at: string; sha256: string; cost: number }

const today = () => new Date().toISOString().slice(0, 10); // EODHD reinicia a medianoche UTC
const readJson = <T>(f: string, fallback: T): T => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as T : fallback);
const writeJson = (f: string, v: unknown) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2)); };
const fixturePath = (j: Job) => join(dir, j.endpoint, `${j.key}.json`);

export async function capture(opts: { dryRun: boolean; only?: string }) {
  let quota = readJson<Quota>(quotaFile, { day: today(), used: 0 });
  if (quota.day !== today()) quota = { day: today(), used: 0 };
  const manifest = readJson<ManifestEntry[]>(manifestFile, []);

  const pending = QUEUE.filter((j) => !existsSync(fixturePath(j)))
    .filter((j) => !opts.only || `${j.endpoint}/${j.key}`.includes(opts.only));
  console.log(`Cuota hoy (${quota.day}): ${quota.used}/${config.dailyBudget}. Pendientes: ${pending.length}`);

  for (const job of pending) {
    if (quota.used + job.cost > config.dailyBudget) {
      console.log(`PARA: ${job.endpoint}/${job.key} cuesta ${job.cost}, quedan ${config.dailyBudget - quota.used}.`);
      break;
    }
    if (opts.dryRun) {
      console.log(`[dry-run] ${job.endpoint}/${job.key} (coste ${job.cost})`);
      quota.used += job.cost; // simulado, no se guarda
      continue;
    }
    const r = await fetchRaw(job.path, job.params);
    quota.used += job.cost; // se cuenta aunque falle: el error también puede gastar cuota
    writeJson(quotaFile, quota);
    manifest.push({ endpoint: job.endpoint, key: job.key, url: r.url, status: r.status, fetched_at: r.fetchedAt, sha256: r.sha256, cost: job.cost });
    writeJson(manifestFile, manifest);
    if (r.status !== 200) {
      console.log(`ERROR ${r.status} en ${job.endpoint}/${job.key}: ${r.body.slice(0, 200)}. Paro.`);
      break; // no se guarda el fichero: se reintentará, pero no insistimos
    }
    mkdirSync(dirname(fixturePath(job)), { recursive: true });
    writeFileSync(fixturePath(job), r.body); // cuerpo exacto
    console.log(`OK ${job.endpoint}/${job.key} (${r.body.length} bytes). Cuota ${quota.used}/${config.dailyBudget}`);
  }
}
