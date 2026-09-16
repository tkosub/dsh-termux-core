// Functional test of the prebuilt flock addon, CJS.
//
// Self-contained: takes the binding path from DSH_FLOCK_TEST_BINDING (or
// argv[2]) and writes its child helper to a temp dir — no absolute host
// paths. Verifies exclusive flock acquisition, contention (EAGAIN), and
// release/re-acquire across processes.
//
// Usage:
//   DSH_FLOCK_TEST_BINDING=path/to/system.node node test-flock-addon.cjs
const { open } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');
const { getSystemErrorName } = require('node:util');
const { writeFileSync, mkdtempSync } = require('node:fs');
const assert = require('node:assert/strict');
const { rmSync } = require('node:fs');

const BINDING = process.env.DSH_FLOCK_TEST_BINDING || process.argv[2];
if (!BINDING) {
  console.error('ERR: set DSH_FLOCK_TEST_BINDING to the prebuilt system.node path');
  process.exit(1);
}
const binding = require(BINDING);

function tryLock(fd) {
  return new Promise((resolve, reject) => {
    binding.tryLock(fd, (errno) => {
      if (errno === 0) return resolve();
      const code = getSystemErrorName(-errno);
      reject(Object.assign(new Error(code + ': flock failed'), { code, errno, syscall: 'flock' }));
    });
  });
}

// Child as a FILE (avoid -e argv/runtime issues): same binding, fd from real path.
const CHILD_DIR = mkdtempSync(join(tmpdir(), 'flock-child-'));
const CHILD_FILE = join(CHILD_DIR, 'flock-child.cjs');
writeFileSync(CHILD_FILE, `const { open } = require('node:fs/promises');
const binding = require(process.argv[2]);
(async () => {
  const fd = await open(process.argv[3], 'w');
  const errno = await new Promise((res) => binding.tryLock(fd.fd, res));
  console.log('CHILD errno=' + errno + (errno === 0 ? ' (ACQUIRED)' : ' (EAGAIN)'));
})();
`);

function runChild(lockFile) {
  const out = execFileSync(process.execPath, [CHILD_FILE, BINDING, lockFile], { encoding: 'utf8' });
  return out.trim();
}

(async () => {
  const lf = join(tmpdir(), '.session.lock.' + process.pid);
  const h = await open(lf, 'w');
  await tryLock(h.fd);
  console.log('holder: acquired flock on', lf);

  const child1 = runChild(lf);
  console.log('child while held:', child1);
  assert.match(child1, /CHILD errno=(11|35) \(EAGAIN\)/, 'second process acquired a held lock');

  await h.close();
  const child2 = runChild(lf);
  console.log('child after release:', child2);
  assert.match(child2, /CHILD errno=0 \(ACQUIRED\)/);
  rmSync(lf, {force: true});

  console.log('DONE');
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; })
  .finally(() => rmSync(CHILD_DIR, {recursive: true, force: true}));
