// Start only an isolated test instance; never read the user's settings.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const root = process.argv[2];
assert(root, 'Pass the DSH package directory');
const home = await mkdtemp(join(tmpdir(), 'dsh-web-check-'));
const env = Object.fromEntries(['PATH','PREFIX','TMPDIR','LD_PRELOAD','LD_LIBRARY_PATH','LANG','TERM']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, {HOME: home, DSH_HOME: join(home, '.dsh'),
  DSH_FLOCK_PREBUILD_DIR: process.env.DSH_FLOCK_PREBUILD_DIR || join(process.env.HOME, '.dsh/flock')});
const child = spawn(process.execPath, ['--expose-internals', join(root, 'lib/bin.js'),
  'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {env, cwd: home});
let output = '';
const exited = new Promise(resolve => child.once('exit', resolve));
try {
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test web server did not start within 90 seconds')), 90000);
    const onOutput = data => {
      output += data.toString().replace(/\x1b\[[0-9;]*m/g, '');
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+[^\s]*token=[^\s]+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Test web server exited (${code})`)); });
  });
  const request = (url, headers = {}) => new Promise((resolve, reject) => {
    const req = http.get(url, {headers, timeout: 15000}, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body}));
    });
    req.on('timeout', () => req.destroy(new Error('HTTP check timed out')));
    req.on('error', reject);
  });
  let response = await request(address);
  if ([302,303].includes(response.status)) {
    const cookie = (response.headers['set-cookie'] || []).map(v => v.split(';')[0]).join('; ');
    response = await request(new URL(response.headers.location, address), {Cookie: cookie});
  }
  assert.equal(response.status, 200);
  assert.match(response.body, /<html/i);
  console.log('PASS: DSH starts with empty settings and serves its authenticated web page');
} catch (error) {
  // Never print the launch token, including when startup fails.
  const summary = output.split('\n').filter(line => /error|failed|exception/i.test(line))
    .map(line => line.replace(/token=[^\s]+/gi, 'token=[redacted]')).slice(-8).join('\n');
  if (summary) console.error(summary);
  throw error;
} finally {
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
  await rm(home, {recursive: true, force: true});
}
