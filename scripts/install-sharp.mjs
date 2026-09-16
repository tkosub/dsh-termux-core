import { createRequire } from 'node:module';
import { readFile, mkdir, lstat, rename, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.argv[2];
const require = createRequire(join(root, 'package.json'));
let sharpRoot = dirname(require.resolve('sharp'));
for (;;) {
  try {
    if (JSON.parse(await readFile(join(sharpRoot, 'package.json'), 'utf8')).name === 'sharp') break;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parent = dirname(sharpRoot);
  if (parent === sharpRoot) throw new Error('Cannot locate the sharp package');
  sharpRoot = parent;
}
const version = JSON.parse(await readFile(join(sharpRoot, 'package.json'), 'utf8')).version;
const target = join(sharpRoot, 'node_modules/@img/sharp-wasm32');
try {
  if (JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).version === version) {
    console.log(`Image runtime ${version} already installed.`);
    process.exit(0);
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }

// Install in an independent package to avoid installing sharp's development tools.
const store = join(root, '.termux', `sharp-${version}`);
await mkdir(store, { recursive: true });
execFileSync('npm', ['install', '--prefix', store, '--omit=dev', '--ignore-scripts',
  '--no-audit', '--no-fund', `@img/sharp-wasm32@${version}`], {stdio: 'inherit'});
await mkdir(dirname(target), {recursive: true});
try {
  await lstat(target);
  await rename(target, `${target}.previous-${Date.now()}`);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await symlink(join(store, 'node_modules/@img/sharp-wasm32'), target, 'dir');
console.log(`Installed image runtime ${version}.`);
