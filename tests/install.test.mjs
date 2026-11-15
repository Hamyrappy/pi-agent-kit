import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { unitText } from '../scripts/provision.mjs';
import { assertArchivePaths, snapshotsToRemove, validateBackupLocation } from '../scripts/lifecycle.mjs';

test('system service has explicit Node path, user home and timezone; rejects unit injection', () => {
  const data = { directory: '/opt/pi-agent-kit', user: 'pi-agent-kit', service: 'pi-agent-kit', timezone: 'Europe/Moscow', node: '/opt/node/bin/node', home: '/home/pi-agent-kit' };
  const text = unitText(data);
  assert.match(text, /User=pi-agent-kit/);
  assert.match(text, /Environment=PATH=\/opt\/node\/bin:/);
  assert.match(text, /Environment=TZ=Europe\/Moscow/);
  assert.throws(() => unitText({ ...data, directory: '/opt/kit\nExecStart=/bin/evil' }));
});
test('backup paths, retention and archive traversal guards', () => {
  assert.throws(() => validateBackupLocation('/opt/kit/backups', '/opt/kit', '/home/me/vault'));
  assert.throws(() => validateBackupLocation('/home/me/vault/backups', '/opt/kit', '/home/me/vault'));
  validateBackupLocation('/backups', '/opt/kit', '/home/me/vault');
  assert.deepEqual(snapshotsToRemove(['latest.tar.gz', 'snapshot-1.tar.gz', 'snapshot-2.tar.gz', 'snapshot-3.tar.gz', 'snapshot-4.tar.gz', 'unrelated']), ['snapshot-1.tar.gz']);
  assert.throws(() => assertArchivePaths('./safe\n../../secret'));
  assert.throws(() => assertArchivePaths('/etc/passwd'));
  assertArchivePaths('./vault/memory.md\n./.env');
});
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${program}: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-install-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'app'), bin = path.join(dir, 'bin');
  await mkdir(app); await mkdir(bin);
  await cp(new URL('../scripts/', import.meta.url), path.join(app, 'scripts'), { recursive: true });
  await writeFile(path.join(app, 'scripts/doctor.mjs'), 'process.exit(0);\n');
  await mkdir(path.join(app, 'vault'));
  await writeFile(path.join(app, 'vault/memory.md'), 'private memory');
  await writeFile(path.join(app, '.env'), 'PRIVATE_TEST_SECRET=never-publish\n');
  await writeFile(path.join(app, 'config.json'), JSON.stringify({ vaultRoot: path.join(app, 'vault') }));
  await writeFile(path.join(app, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(app, '.gitignore'), '.env\nconfig.json\n.deployment.json\nvault/\nnode_modules/\n');
  await writeFile(path.join(app, '.deployment.json'), JSON.stringify({ user: 'test-bot', service: 'test-bot', backupDir: path.join(dir, 'backups') }));
  for (const name of ['chown', 'systemctl', 'runuser']) await writeFile(path.join(bin, name), '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$TEST_COMMAND_LOG"\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_COMMAND_LOG: path.join(dir, 'commands'), ENTRY: path.join(app, 'scripts/lifecycle.mjs') };
  const call = (...args) => spawnSync(process.execPath, ['--input-type=module', '-e', 'process.getuid=()=>0; const {main}=await import(process.env.ENTRY); try { await main(process.argv.slice(1)); } catch(e) { console.error(e.message); process.exitCode=1; }', ...args], { encoding: 'utf8', env });
  return { dir, app, env, call };
}
test('backup retains latest and three snapshots, includes secrets/memory and excludes dependencies', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.app, 'node_modules'));
  await writeFile(path.join(f.app, 'node_modules/huge-marker'), 'excluded');
  for (let index = 0; index < 5; index++) { const result = f.call('backup'); assert.equal(result.status, 0, result.stderr); }
  const files = await readdir(path.join(f.dir, 'backups'));
  assert.equal(files.length, 4);
  assert.ok(files.includes('latest.tar.gz'));
  const unpack = path.join(f.dir, 'unpack'); await mkdir(unpack);
  command('tar', ['-xzf', path.join(f.dir, 'backups/latest.tar.gz'), '-C', unpack]);
  const names = command('tar', ['-tzf', path.join(unpack, 'app.tar.gz')]);
  assert.match(names, /\.env/); assert.match(names, /vault\/memory.md/); assert.doesNotMatch(names, /huge-marker|node_modules/);
});
test('restore stops and restarts service, restores private data, preserves pre-restore code', async t => {
  const f = await fixture(t);
  assert.equal(f.call('backup').status, 0);
  await writeFile(path.join(f.app, 'vault/memory.md'), 'later memory');
  const result = f.call('restore', path.join(f.dir, 'backups/latest.tar.gz'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(f.app, 'vault/memory.md'), 'utf8'), 'private memory');
  assert.equal(await readFile(path.join(`${f.app}.previous`, 'vault/memory.md'), 'utf8'), 'later memory');
  const log = await readFile(path.join(f.dir, 'commands'), 'utf8');
  assert.match(log, /systemctl stop test-bot.service[\s\S]*systemctl start test-bot.service/);
});
test('update refuses edited code before touching private files or contacting upstream', async t => {
  const f = await fixture(t);
  command('git', ['init', '-q', f.app]);
  command('git', ['-C', f.app, 'add', '.']);
  command('git', ['-C', f.app, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  await writeFile(path.join(f.app, 'scripts/start.mjs'), '// owner edit\n');
  const result = f.call('update');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Исходники изменены/);
  assert.equal(await readFile(path.join(f.app, 'vault/memory.md'), 'utf8'), 'private memory');
});
test('update and rollback preserve clean committed owner changes absent from origin', async t => {
  const f = await fixture(t);
  command('git', ['init', '-q', f.app]);
  command('git', ['-C', f.app, 'add', '.']);
  command('git', ['-C', f.app, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'published fixture']);
  command('git', ['-C', f.app, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
  await writeFile(path.join(f.app, 'scripts/start.mjs'), '// committed owner improvement\n');
  command('git', ['-C', f.app, 'add', 'scripts/start.mjs']);
  command('git', ['-C', f.app, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'owner improvement']);
  assert.equal(command('git', ['-C', f.app, 'status', '--porcelain']).trim(), '');
  await mkdir(`${f.app}.previous`);
  await writeFile(path.join(`${f.app}.previous`, 'package.json'), '{}');
  for (const operation of ['update', 'rollback']) {
    const result = f.call(operation);
    assert.equal(result.status, 1, operation);
    assert.match(result.stderr, /локальные коммиты, отсутствующие в origin/);
    assert.match(result.stderr, /согласуйте локальные изменения с upstream вручную/);
    assert.equal(await readFile(path.join(f.app, 'scripts/start.mjs'), 'utf8'), '// committed owner improvement\n');
    assert.equal(await readFile(path.join(f.app, 'vault/memory.md'), 'utf8'), 'private memory');
  }
  assert.deepEqual((await readdir(f.dir)).sort(), ['app', 'app.previous', 'bin']);
});
