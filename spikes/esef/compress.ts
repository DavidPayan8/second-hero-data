// Medición: tamaño comprimido y tiempos de gzip -9, brotli 11 y zstd 19 sobre los xBRL-JSON de fixtures/esef/json/.
// Solo lectura de fixtures; escribe el resultado en fixtures/esef/compress-out.json (no se sube).
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { constants as Z, brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const dir = 'fixtures/esef/json';
const t = (f: () => Buffer): { out: Buffer; ms: number } => { const t0 = performance.now(); const out = f(); return { out, ms: performance.now() - t0 }; };

type Row = { fxo: string; raw: number; [k: string]: number | string };
const rows: Row[] = [];
for (const f of (await readdir(dir)).sort()) {
  const raw = await readFile(`${dir}/${f}`);
  const row: Row = { fxo: f.replace(/\.json$/, ''), raw: raw.length };
  const methods: Record<string, [() => Buffer, (b: Buffer) => Buffer]> = {
    gzip9: [() => gzipSync(raw, { level: 9 }), gunzipSync],
    brotli11: [() => brotliCompressSync(raw, { params: { [Z.BROTLI_PARAM_QUALITY]: 11, [Z.BROTLI_PARAM_SIZE_HINT]: raw.length, [Z.BROTLI_PARAM_LGWIN]: 24 } }), brotliDecompressSync],
    zstd19: [() => zstdCompressSync(raw, { params: { [Z.ZSTD_c_compressionLevel]: 19 } }), zstdDecompressSync],
  };
  for (const [name, [c, d]] of Object.entries(methods)) {
    const a = t(c);
    const b = t(() => d(a.out));
    if (!b.out.equals(raw)) throw new Error(`${name}: la descompresión no devuelve el original (${f})`);
    row[`${name}_bytes`] = a.out.length; row[`${name}_cms`] = Math.round(a.ms); row[`${name}_dms`] = Math.round(b.ms);
  }
  rows.push(row);
  console.log(row.fxo, (row.raw as number) / 1e6, 'MB', ['gzip9', 'brotli11', 'zstd19'].map((n) => `${n}=${((row[`${n}_bytes`] as number) / 1e6).toFixed(2)}MB c${row[`${n}_cms`]}ms d${row[`${n}_dms`]}ms`).join(' '));
}
await writeFile('fixtures/esef/compress-out.json', JSON.stringify(rows, null, 1));
console.log('listo');
