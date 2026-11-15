// Installed root-owned under /usr/local/lib. No imports or execution from the writable checkout.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, realpath, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
const [root, directory, service, user] = process.argv.slice(2);
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0 || result.error) throw new Error(`${command}: ${result.status ?? result.error?.code}`);
}
function tarAsUser(output, source) {
  const fd = openSync(output, 'wx', 0o600);
  try { run('/usr/sbin/runuser', ['-u', user, '--', '/usr/bin/tar', '-czf', '-', '--exclude=node_modules', '--exclude=.git', '--exclude=*.log', '-C', source, '.'], { stdio: ['ignore', fd, 'inherit'] }); }
  finally { closeSync(fd); }
}
let temporary, active = false;
try {
  if (process.getuid() !== 0 || ![root, directory].every(item => item?.startsWith('/')) || ![service, user].every(item => /^[a-z_][a-z0-9_-]{0,30}$/.test(item))) throw new Error('Invalid fixed backup arguments');
  const vault = path.resolve(JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')).vaultRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const backupPath = await realpath(directory);
  if (inside(await realpath(root), backupPath) || inside(await realpath(vault), backupPath)) throw new Error('Backup destination must be outside code and vault');
  const lock = `${root}.maintenance-lock`;
  await mkdir(lock); // Shares the maintenance lock, but never executes mutable maintenance code.
  try {
    temporary = await mkdtemp(path.join(directory, '.building-'));
    active = spawnSync('/usr/bin/systemctl', ['is-active', '--quiet', `${service}.service`], { stdio: 'ignore' }).status === 0;
    if (active) run('/usr/bin/systemctl', ['stop', `${service}.service`]);
    const externalVault = !inside(root, vault);
    await writeFile(path.join(temporary, 'manifest.json'), JSON.stringify({ format: 1, root, vault, externalVault, createdAt: new Date().toISOString() }));
    tarAsUser(path.join(temporary, 'app.tar.gz'), root);
    if (externalVault) tarAsUser(path.join(temporary, 'vault.tar.gz'), vault);
    const pending = path.join(directory, `.latest-${process.pid}.tar.gz`);
    const fd = openSync(pending, 'wx', 0o600);
    try { run('/usr/bin/tar', ['-czf', '-', '-C', temporary, ...await readdir(temporary)], { stdio: ['ignore', fd, 'inherit'] }); } finally { closeSync(fd); }
    const latest = path.join(directory, 'latest.tar.gz');
    try { await rename(latest, path.join(directory, `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(pending, latest);
    const old = (await readdir(directory)).filter(item => /^snapshot-.*\.tar\.gz$/.test(item)).sort().reverse().slice(3);
    for (const file of old) await rm(path.join(directory, file));
    console.log(`Backup: ${latest}`);
  } finally {
    if (active) run('/usr/bin/systemctl', ['start', `${service}.service`]);
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
} catch (error) { console.error(`Backup failed: ${error.message}`); process.exitCode = 1; }
