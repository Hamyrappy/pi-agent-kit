import { mkdir, readdir, readFile, rename, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
const validName = name => /^[a-zA-Z0-9_-]+\.json$/.test(name);
const jobsRoot = config => path.join(config.stateDir, 'jobs');
const locks = new Map();
async function locked(config, operation) {
  const root = jobsRoot(config), previous = locks.get(root) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  locks.set(root, next);
  try { return await next; } finally { if (locks.get(root) === next) locks.delete(root); }
}
async function save(file, job) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}
export async function listJobs(config, chatId) {
  const root = jobsRoot(config);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const result = [];
  for (const name of (await readdir(root)).filter(validName).sort()) {
    try {
      const job = JSON.parse(await readFile(path.join(root, name), 'utf8'));
      if (String(job.chatId) === String(chatId)) result.push({ id: name.slice(0, -5), ...job });
    } catch {}
  }
  return result;
}
export async function cancelJob(config, chatId, id) {
  return locked(config, () => cancelJobUnlocked(config, chatId, id));
}
async function cancelJobUnlocked(config, chatId, id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return false;
  const root = jobsRoot(config), file = path.join(root, `${id}.json`);
  let job;
  try { job = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (String(job.chatId) !== String(chatId)) return false;
  await mkdir(path.join(root, 'cancelled'), { recursive: true });
  // Keep the cancelled occurrence on disk so an in-progress scan can recheck it.
  await rename(file, path.join(root, 'cancelled', `${id}.json`));
  return true;
}

export async function scanJobs(bridge, config, options = {}) {
  return locked(config, () => scanJobsUnlocked(bridge, config, options));
}
async function scanJobsUnlocked(bridge, config, { now = Date.now(), log = console.error } = {}) {
  const root = jobsRoot(config);
  for (const dir of ['done', 'failed', 'cancelled']) await mkdir(path.join(root, dir), { recursive: true, mode: 0o700 });
  for (const name of (await readdir(root)).filter(validName).sort()) {
    const file = path.join(root, name);
    let job;
    try {
      const raw = await readFile(file, 'utf8');
      if (raw.length > 64000) throw new Error('Job too large');
      job = JSON.parse(raw);
      if (job.face) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(job.face)) throw new Error('Invalid face');
        await access(path.join(config.facesDir ?? path.join(config.vaultRoot, 'faces'), job.face, 'AGENTS.md'));
      }
      if (!Number.isFinite(Date.parse(job.dueAt)) || !/[zZ]|[+-]\d\d:\d\d$/.test(job.dueAt) || typeof job.prompt !== 'string' || !job.prompt.trim()) throw new Error('Invalid dueAt (timezone required) or prompt');
      if (job.everySeconds !== undefined) {
        if (!Number.isSafeInteger(job.everySeconds) || job.everySeconds < 3600) throw new Error('Repeat interval must be at least one hour');
        if (!Number.isSafeInteger(job.remainingRuns) || job.remainingRuns < 1 || job.remainingRuns > 366) throw new Error('Recurring jobs require remainingRuns between 1 and 366');
      }
      const destinations = [...(config.telegram.allowedUserIds ?? []), ...(config.telegram.allowedChatIds ?? [])].map(String);
      if (!destinations.includes(String(job.chatId))) throw new Error('Job destination is not allowed');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      log(`Invalid scheduled job ${name}: ${error.message}`);
      await rename(file, path.join(root, 'failed', name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
      continue;
    }
    if (Date.parse(job.dueAt) > now) continue;
    try {
      await access(file);
      const sourceId = job.everySeconds ? `job:${name}:${job.dueAt}` : `job:${name}`;
      await bridge.enqueue({ chatId: job.chatId, prompt: job.prompt, face: job.face, sourceId });
      // Cancellation after acceptance prevents further occurrences, not the already queued one.
      await access(file);
      if (job.everySeconds && job.remainingRuns > 1) {
        const due = Date.parse(job.dueAt), interval = job.everySeconds * 1000;
        const next = due + (Math.floor((now - due) / interval) + 1) * interval;
        await save(file, { ...job, dueAt: new Date(next).toISOString(), remainingRuns: job.remainingRuns - 1 });
      } else await rename(file, path.join(root, 'done', name));
    } catch (error) { if (error.code !== 'ENOENT') log(`Scheduled job ${name} deferred: ${error.message}`); }
  }
}

export function startScheduler(bridge, config, { log = console.error } = {}) {
  let busy = false;
  const scan = async () => {
    if (busy) return;
    busy = true;
    try { await scanJobs(bridge, config, { log }); } catch (error) { log(`Scheduler: ${error.message}`); }
    finally { busy = false; }
  };
  const timer = setInterval(scan, 5000);
  timer.unref();
  void scan();
  return () => clearInterval(timer);
}
