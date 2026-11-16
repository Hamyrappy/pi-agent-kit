import { spawnSync } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { root } from './common.mjs';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${options.capture ? result.stderr?.trim() : 'command failed'} (${result.status ?? result.error?.code})`);
  return result.stdout?.trim();
}
async function exists(file) { try { await access(file); return true; } catch { return false; } }
function inside(parent, child) { return child === parent || child.startsWith(parent + path.sep); }
export function validateBackupLocation(directory, application, vault) {
  if (!path.isAbsolute(directory) || inside(application, directory) || inside(vault, directory)) throw new Error('Backups must be outside the source and memory directories.');
}
export function snapshotsToRemove(names) { return names.filter(name => /^snapshot-.*\.tar\.gz$/.test(name)).sort().reverse().slice(3); }
export function assertArchivePaths(names) {
  for (const name of names.split('\n').filter(Boolean)) if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('Archive contains an unsafe path.');
}
async function deployment() {
  let data = {};
  try { data = JSON.parse(await readFile(path.join(root, '.deployment.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const value = { service: process.env.PI_KIT_SERVICE || data.service || 'pi-agent-kit', user: process.env.PI_KIT_USER || data.user || 'pi-agent-kit', backupDir: path.resolve(process.env.PI_KIT_BACKUP_DIR || data.backupDir || '/var/backups/pi-agent-kit') };
  if (![value.service, value.user].every(item => /^[a-z_][a-z0-9_-]{0,30}$/.test(item))) throw new Error('Invalid service name or username.');
  return value;
}
async function configuration() { return JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')); }
function service(settings, action) { run('systemctl', [action, `${settings.service}.service`]); }
async function backup(settings) {
  const config = await configuration();
  const vault = path.resolve(config.vaultRoot);
  validateBackupLocation(settings.backupDir, root, vault);
  // Resolve symlinks as well: a backup path inside a symlinked vault would recurse.
  const { realpath } = await import('node:fs/promises');
  await mkdir(settings.backupDir, { recursive: true, mode: 0o700 });
  validateBackupLocation(await realpath(settings.backupDir), await realpath(root), await realpath(vault));
  const temporary = await mkdtemp(path.join(settings.backupDir, '.building-'));
  const wasActive = spawnSync('systemctl', ['is-active', '--quiet', `${settings.service}.service`], { stdio: 'ignore' }).status === 0;
  try {
    if (wasActive) service(settings, 'stop');
    const externalVault = !inside(root, vault);
    const manifest = { format: 1, root, vault, externalVault, createdAt: new Date().toISOString() };
    await writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(manifest));
    run('tar', ['-czf', path.join(temporary, 'app.tar.gz'), '--exclude=node_modules', '--exclude=.git', '--exclude=*.log', '-C', root, '.']);
    if (externalVault) run('tar', ['-czf', path.join(temporary, 'vault.tar.gz'), '--exclude=node_modules', '--exclude=.git', '-C', vault, '.']);
    const pending = path.join(settings.backupDir, `.latest-${process.pid}.tar.gz`);
    run('tar', ['-czf', pending, '-C', temporary, ...await readdir(temporary)]);
    await chmod(pending, 0o600);
    const latest = path.join(settings.backupDir, 'latest.tar.gz');
    if (await exists(latest)) await rename(latest, path.join(settings.backupDir, `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`));
    await rename(pending, latest);
    for (const file of snapshotsToRemove(await readdir(settings.backupDir))) await rm(path.join(settings.backupDir, file));
    console.log(`Backup: ${latest} (contains secrets; keep it private).`);
    return latest;
  } finally {
    if (wasActive) service(settings, 'start');
    await rm(temporary, { recursive: true, force: true });
  }
}
function ensureClean() {
  const changes = run('git', ['-c', `safe.directory=${root}`, '-C', root, 'status', '--porcelain', '--untracked-files=normal'], { capture: true });
  if (changes) throw new Error(`Source files have changed. Back them up first: sudo ${root}/deploy/pi-kit backup. Merge your changes with upstream manually before updating or rolling back.\n${changes}`);
  const unpublished = run('git', ['-c', `safe.directory=${root}`, '-C', root, 'rev-list', 'HEAD', '--not', '--remotes=origin'], { capture: true });
  if (unpublished) throw new Error(`Local commits are absent from origin. Update and rollback were stopped to preserve your source. First run: sudo ${root}/deploy/pi-kit backup. Then refresh origin refs and merge local changes with upstream manually; preserve your branch before replacing source.`);
}
async function switchDirectories(stage, settings, { persistent = true } = {}) {
  const previous = `${root}.previous`;
  service(settings, 'stop');
  let switched = false;
  let rootMoved = false;
  const moved = [];
  try {
    if (persistent) {
      // Every ignored local file is owner data. Preserve custom vault names too.
      const ignored = run('git', ['-c', `safe.directory=${root}`, '-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], { capture: true }).split('\n').filter(Boolean);
      const paths = [...new Set(['config.json', '.env', '.deployment.json', '.pi-agent', '.state', 'state', 'vault', ...ignored.map(file => file.replace(/\/$/, ''))])].filter(file => file !== 'node_modules' && !file.startsWith('node_modules/'));
      for (const file of paths.sort((a, b) => a.length - b.length)) {
        if (!await exists(path.join(root, file)) || moved.some(parent => inside(parent, file))) continue;
        await mkdir(path.dirname(path.join(stage, file)), { recursive: true });
        await rm(path.join(stage, file), { recursive: true, force: true });
        await rename(path.join(root, file), path.join(stage, file)); moved.push(file);
      }
    }
    await rm(previous, { recursive: true, force: true });
    await rename(root, previous); rootMoved = true;
    await rename(stage, root); switched = true;
    run('chown', ['-R', `${settings.user}:${settings.user}`, root]);
    run(process.execPath, [path.join(root, 'scripts/doctor.mjs')], { cwd: root });
    service(settings, 'start');
    service(settings, 'is-active');
  } catch (error) {
    service(settings, 'stop');
    if (switched) await rename(root, stage);
    if (rootMoved) await rename(previous, root);
    for (const file of moved) if (await exists(path.join(stage, file))) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await rename(path.join(stage, file), path.join(root, file)); }
    service(settings, 'start');
    throw error;
  }
}
async function update(settings, version = 'main') {
  ensureClean();
  await backup(settings);
  const stage = await mkdtemp(`${root}.stage-`);
  try {
    run('git', ['clone', '--quiet', 'https://github.com/Hamyrappy/pi-agent-kit.git', stage]);
    run('git', ['-C', stage, 'checkout', '--quiet', version]);
    // Run package installation and tests without root privileges.
    run('chown', ['-R', `${settings.user}:${settings.user}`, stage]);
    const npm = path.join(path.dirname(process.execPath), 'npm');
    run('runuser', ['-u', settings.user, '--', npm, 'ci', '--ignore-scripts'], { cwd: stage });
    run('runuser', ['-u', settings.user, '--', npm, 'test'], { cwd: stage });
    await switchDirectories(stage, settings);
    console.log(`Updated. Previous source: ${root}.previous. Rollback: sudo ${root}/deploy/pi-kit rollback`);
  } finally { await rm(stage, { recursive: true, force: true }); }
}
async function rollback(settings) {
  const previous = `${root}.previous`;
  if (!await exists(path.join(previous, 'package.json'))) throw new Error('No previous release is available. Use restore <archive>.');
  ensureClean();
  await backup(settings);
  const stage = `${root}.rollback-${process.pid}`;
  await rename(previous, stage);
  try { await switchDirectories(stage, settings); }
  catch (error) { if (await exists(stage)) await rename(stage, previous); throw error; }
  console.log('Previous release started; memory and settings were preserved.');
}
async function restore(settings, archive) {
  if (!archive) throw new Error('Specify an archive: restore /var/backups/pi-agent-kit/latest.tar.gz');
  const stage = await mkdtemp(`${root}.restore-`);
  const unpack = await mkdtemp(path.join(os.tmpdir(), 'pi-kit-restore-'));
  let externalPrevious;
  let externalVault;
  let completed = false;
  try {
    archive = path.resolve(archive);
    const listing = run('tar', ['-tzf', archive], { capture: true });
    if (listing.split('\n').some(file => !['manifest.json', 'app.tar.gz', 'vault.tar.gz'].includes(file))) throw new Error('Unknown archive format.');
    run('tar', ['-xzf', archive, '--no-same-owner', '-C', unpack]);
    const manifest = JSON.parse(await readFile(path.join(unpack, 'manifest.json'), 'utf8'));
    if (manifest.format !== 1 || manifest.root !== root || !path.isAbsolute(manifest.vault)) throw new Error('Archive belongs to another installation.');
    assertArchivePaths(run('tar', ['-tzf', path.join(unpack, 'app.tar.gz')], { capture: true }));
    run('tar', ['-xzf', path.join(unpack, 'app.tar.gz'), '--no-same-owner', '-C', stage]);
    // Keep git history for later updates; restored source differences remain visible.
    if (await exists(path.join(root, '.git'))) await cp(path.join(root, '.git'), path.join(stage, '.git'), { recursive: true });
    run('chown', ['-R', `${settings.user}:${settings.user}`, stage]);
    run('runuser', ['-u', settings.user, '--', path.join(path.dirname(process.execPath), 'npm'), 'ci', '--ignore-scripts'], { cwd: stage });
    if (manifest.externalVault) {
      const current = await configuration();
      if (path.resolve(current.vaultRoot) !== manifest.vault || inside(root, manifest.vault) || manifest.vault === '/') throw new Error('External memory path differs; restore was stopped.');
      assertArchivePaths(run('tar', ['-tzf', path.join(unpack, 'vault.tar.gz')], { capture: true }));
      service(settings, 'stop');
      externalVault = manifest.vault;
      externalPrevious = `${manifest.vault}.before-restore-${Date.now()}`;
      await rename(manifest.vault, externalPrevious);
      await mkdir(manifest.vault);
      run('tar', ['-xzf', path.join(unpack, 'vault.tar.gz'), '--no-same-owner', '-C', manifest.vault]);
      run('chown', ['-R', `${settings.user}:${settings.user}`, manifest.vault]);
    }
    await switchDirectories(stage, settings, { persistent: false });
    completed = true;
    if (externalPrevious) console.log(`Previous external memory saved: ${externalPrevious}`);
    console.log('Archive restored; service started.');
  } finally {
    if (!completed && externalPrevious && await exists(externalPrevious)) {
      service(settings, 'stop'); await rm(externalVault, { recursive: true, force: true }); await rename(externalPrevious, externalVault); service(settings, 'start');
    }
    await rm(stage, { recursive: true, force: true }); await rm(unpack, { recursive: true, force: true });
  }
}
async function adopt(settings, version = 'main') {
  if (await exists(path.join(root, '.git'))) throw new Error('Git is already configured. Use update.');
  await backup(settings);
  const stage = await mkdtemp(`${root}.adopt-`);
  try {
    run('git', ['clone', '--quiet', 'https://github.com/Hamyrappy/pi-agent-kit.git', stage]);
    run('git', ['-C', stage, 'checkout', '--quiet', version]);
    const files = run('git', ['-C', stage, 'ls-files'], { capture: true }).split('\n');
    for (const file of files) {
      const expected = await readFile(path.join(stage, file));
      let actual; try { actual = await readFile(path.join(root, file)); } catch { throw new Error(`Missing ${file}. Copy the reviewed release files manually first; private data was not changed.`); }
      if (!actual.equals(expected)) throw new Error(`Local ${file} differs. Preserve and merge your changes manually before adopt; a backup is available.`);
    }
    await rename(path.join(stage, '.git'), path.join(root, '.git'));
    run('chown', ['-R', `${settings.user}:${settings.user}`, path.join(root, '.git')]);
    console.log('Existing installation adopted into Git. Data and source were preserved.');
  } finally { await rm(stage, { recursive: true, force: true }); }
}
export async function main(args = process.argv.slice(2)) {
  const [command = 'help', value] = args;
  if (command === 'help') { console.log('sudo ./deploy/pi-kit backup | update [tag/commit/main] | rollback | restore <archive> | adopt [version]\nbackup: latest plus up to 3 snapshots; update refuses uncommitted or unpublished source.'); return; }
  if (process.getuid?.() !== 0) throw new Error('sudo/root is required to manage the service and backups.');
  const settings = await deployment();
  // A shared lock prevents timer/update/restore races. A killed command leaves a visible lock.
  const lock = `${root}.maintenance-lock`;
  try { await mkdir(lock); } catch { throw new Error(`Another operation is running (${lock}). If its process has ended, remove the empty lock directory manually.`); }
  try {
    if (command === 'backup') await backup(settings);
    else if (command === 'update') await update(settings, value);
    else if (command === 'rollback') await rollback(settings);
    else if (command === 'restore') await restore(settings, value);
    else if (command === 'adopt') await adopt(settings, value);
    else throw new Error('Unknown command. See help.');
  } finally { await rm(lock, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(root, 'scripts/lifecycle.mjs')) main().catch(error => { console.error(error.message); process.exitCode = 1; });
