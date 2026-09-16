// Flock loader smoke test: load the android-aware loader (env-parameterized)
// with the prebuilt addon and acquire an exclusive flock.
//
// Usage (Termux/Android):
//   DSH_FLOCK_PREBUILD_DIR=../prebuilt node flock-load-smoke.mjs ../lib/flock.js
// The loader path is argv[2]; the prebuild dir comes from the environment so
// this test exercises the SAME env path the runtime uses.
import { tryLockExclusive } from '../lib/flock.js';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

console.log('platform =', process.platform);
const lf = join(tmpdir(), '.flock-smoke-lock.' + process.pid);
const h = await open(lf, 'w');
try {
  await tryLockExclusive(h.fd);
  console.log('flock OK: tryLockExclusive acquired on android');
} catch (e) {
  console.log('flock FAILED:', e.code, e.message);
  process.exit(1);
}
await h.close();
console.log('DONE');
