import { mkdir, readdir, readFile, rename, access } from 'node:fs/promises';
import path from 'node:path';

export async function scanJobs(bridge, config, { now = Date.now(), log = console.error } = {}) {
  const root = path.join(config.stateDir, 'jobs');
  await mkdir(path.join(root, 'done'), { recursive: true });
  await mkdir(path.join(root, 'failed'), { recursive: true });
  for (const name of (await readdir(root)).filter(n => /^[a-zA-Z0-9_-]+\.json$/.test(n)).sort()) {
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
      if (!Number.isFinite(Date.parse(job.dueAt)) || typeof job.prompt !== 'string' || !job.prompt.trim()) throw new Error('Invalid dueAt or prompt');
      const destinations = [...(config.telegram.allowedUserIds ?? []), ...(config.telegram.allowedChatIds ?? [])].map(String);
      if (!destinations.includes(String(job.chatId))) throw new Error('Job destination is not allowed');
    } catch (error) {
      log(`Invalid scheduled job ${name}: ${error.message}`);
      await rename(file, path.join(root, 'failed', name));
      continue;
    }
    if (Date.parse(job.dueAt) > now) continue;
    try {
      await bridge.enqueue({ chatId: job.chatId, prompt: job.prompt, face: job.face, sourceId: `job:${name}` });
      await rename(file, path.join(root, 'done', name));
    } catch (error) { log(`Scheduled job ${name} deferred: ${error.message}`); }
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
