// Lance le scrape en masse sur les salons importés (status = 'pending').
//
// Usage :
//   node scripts/run-batch.mjs                              # tout ce qui est pending
//   node scripts/run-batch.mjs --source ain                 # juste un département
//   node scripts/run-batch.mjs --concurrency 8 --delay 1500 # tuning

import { runBatch } from '../src/batch-runner.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source') out.csvSource = args[++i];
    else if (args[i] === '--concurrency') out.concurrency = parseInt(args[++i], 10);
    else if (args[i] === '--delay') out.delayMs = parseInt(args[++i], 10);
  }
  return out;
}

const opts = parseArgs(process.argv);
opts.concurrency = opts.concurrency || parseInt(process.env.SCRAPE_CONCURRENCY || '4', 10);
opts.delayMs = opts.delayMs ?? parseInt(process.env.SCRAPE_DELAY_MS || '2000', 10);

console.log('Batch options :', opts);
console.log('---');

const startedAt = Date.now();
const result = await runBatch(opts);
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);

console.log('---');
console.log(`Terminé en ${elapsed}s : ${result.processed} salons traités sur ${result.totalPending} pending.`);
process.exit(0);
