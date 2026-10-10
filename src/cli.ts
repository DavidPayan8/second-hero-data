import { capture } from './eodhd/capture.js';

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'capture') {
  const only = args.find((a) => a.startsWith('--only='))?.slice(7);
  await capture({ dryRun: !args.includes('--go'), only });
} else {
  console.log('Uso: npm run capture [-- --go] [-- --only=fundamentals/AAPL.US]\nSin --go es dry-run: no llama a la API.');
}
