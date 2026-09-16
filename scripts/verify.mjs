import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, open, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const root = process.argv[2];
assert(root, 'Pass the installed DSH directory');
assert.equal(process.platform, 'android', 'Run these checks in Termux');
const require = createRequire(join(root, 'package.json'));
const loader = pathToFileURL(join(root, 'node_modules/@deepseek-ai/node-addon-system/lib/flock.js')).href;
const { tryLockExclusive, renameNoReplace } = await import(loader);
const dir = await mkdtemp(join(tmpdir(), 'dsh-check-'));
try {
  const lockPath = join(dir, 'lock');
  const holder = await open(lockPath, 'w');
  const child = `
    import {open} from 'node:fs/promises';
    const {tryLockExclusive} = await import(process.argv[1]);
    const file = await open(process.argv[2], 'r');
    try { await tryLockExclusive(file.fd); console.log('acquired'); }
    catch(e) { if (!['EAGAIN','EWOULDBLOCK'].includes(e.code)) throw e; console.log('contended'); }
    finally { await file.close(); }
  `;
  const acquireChild = () => execFileSync(process.execPath,
    ['--input-type=module', '-e', child, loader, lockPath], {encoding: 'utf8', timeout: 15000}).trim();
  try {
    await tryLockExclusive(holder.fd);
    assert.equal(acquireChild(), 'contended', 'A second process must not acquire an existing lock');
  } finally { await holder.close(); }
  assert.equal(acquireChild(), 'acquired');
  console.log('PASS: file locking across processes');

  const source = join(dir, 'staged'), target = join(dir, 'published');
  await writeFile(source, 'first');
  await renameNoReplace(source, target);
  assert.equal(await readFile(target, 'utf8'), 'first');
  await writeFile(source, 'second');
  await assert.rejects(renameNoReplace(source, target), {code: 'EEXIST'});
  assert.equal(await readFile(target, 'utf8'), 'first');
  assert.equal(await readFile(source, 'utf8'), 'second');
  await assert.rejects(renameNoReplace(join(dir, 'absent'), join(dir, 'other')), {code: 'ENOENT'});
  console.log('PASS: new files cannot replace an existing file');

  const { Context } = require('@deepseek-ai/cordis');
  const { LocalFileSystem } = require('@deepseek-ai/dsh-fs-local');
  const fsContext = new Context();
  try {
    const files = new LocalFileSystem(fsContext, {cwd: dir, diffBasisMaxBytes: 1024 * 1024});
    const file = await files.resolve('agent-created.txt');
    const created = await files.writeText(file, 'original', {kind: 'createIfAbsent'});
    assert.equal(created.operation, 'create');
    await files.editText(file, {oldString: 'original', newString: 'edited', replaceAll: false}, {version: created.version});
    assert.equal(await readFile(file.targetKey, 'utf8'), 'edited');
    const collision = await files.resolve('concurrent.txt');
    files.internals.inspectTemp = async () => writeFile(collision.targetKey, 'other writer');
    files.internals.linkFile = async () => { throw Object.assign(new Error('link denied'), {code: 'EACCES'}); };
    await assert.rejects(files.writeText(collision, 'must not overwrite', {kind: 'createIfAbsent'}), {code: 'FS_NOT_OBSERVED'});
    assert.equal(await readFile(collision.targetKey, 'utf8'), 'other writer');
    console.log('PASS: DSH creates and edits files and preserves a concurrent writer');
  } finally { await fsContext.fiber.dispose(); }

  const JsonlSessionPersistence = require('@deepseek-ai/dsh-session-persistence-jsonl').default;
  const sessionContext = new Context();
  try {
    const storage = new JsonlSessionPersistence(sessionContext, {root: join(dir, 'sessions')});
    const header = {id: randomUUID(), cwd: dir, createdAt: Date.now(), isSeeded: false, delegationDepth: 0,
      version: require('@deepseek-ai/dsh-session').SESSION_FORMAT_VERSION};
    const session = await storage.create(header);
    try { await session.flush(); } finally { await session.close(); }
    const reopened = await storage.open(header.id, 'write');
    try { assert.equal(reopened.header.id, header.id); await reopened.read(); }
    finally { await reopened.close(); }
    console.log('PASS: DSH saves and reopens a conversation file');
  } finally { await sessionContext.fiber.dispose(); }

  const sharp = require('sharp');
  const png = await sharp({create: {width: 2, height: 2, channels: 3, background: '#ffffff'}}).png().toBuffer();
  assert.equal((await sharp(png).metadata()).width, 2);
  console.log('PASS: image creation and reading');

  require('koffi');
  const pty = require('node-pty');
  await new Promise((resolve, reject) => {
    const terminal = pty.spawn(join(process.env.PREFIX, 'bin/sh'), ['-c', 'printf DSH_PTY_OK'], {cwd: dir});
    let output = '';
    const timer = setTimeout(() => { terminal.kill(); reject(new Error('Terminal check timed out')); }, 10000);
    terminal.onData(text => { output += text; });
    terminal.onExit(({exitCode}) => {
      clearTimeout(timer);
      try { assert.equal(exitCode, 0); assert.match(output, /DSH_PTY_OK/); resolve(); }
      catch (error) { reject(error); }
    });
  });
  console.log('PASS: terminal command execution');

  const searchFile = join(root, 'node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js');
  const text = await readFile(searchFile, 'utf8');
  const start = text.indexOf('let rgPathPromise;');
  const end = text.indexOf('\n}', text.indexOf('function resolveRgPath()', start)) + 2;
  assert(start >= 0 && end > start, 'Cannot locate the installed search resolver');
  const {parse, join: joinPath} = await import('node:path');
  const {existsSync} = await import('node:fs');
  const resolve = new Function('parse', 'join', 'existsSync', text.slice(start, end) + '\nreturn resolveRgPath;')(parse, joinPath, existsSync);
  const rg = await resolve();
  await writeFile(join(dir, 'search.txt'), 'DSH_SEARCH_OK\n');
  assert.match(execFileSync(rg, ['--no-config', 'DSH_SEARCH_OK', join(dir, 'search.txt')], {encoding: 'utf8', timeout: 10000}), /DSH_SEARCH_OK/);
  console.log('PASS: installed search resolver and file search');
} finally {
  await rm(dir, {recursive: true, force: true});
}
