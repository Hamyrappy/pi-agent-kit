import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

// Preserve user overrides; constrain new OpenRouter models to a modest output budget.
export async function configureOpenRouterModel(config, agentDir) {
  const ids = [config.pi, config.pi?.fallback]
    .filter(target => target?.provider === 'openrouter' && target.model)
    .map(target => target.model.replace(/^openrouter\//, ''));
  if (!ids.length) return false;
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const file = path.join(agentDir, 'models.json');
  let data = {};
  try { data = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  data.providers ??= {};
  data.providers.openrouter ??= {};
  data.providers.openrouter.modelOverrides ??= {};
  let changed = false;
  for (const id of ids) {
    const override = data.providers.openrouter.modelOverrides[id] ??= {};
    if (override.maxTokens === undefined) { override.maxTokens = 8192; changed = true; }
  }
  if (!changed) return false;
  const temp = file + `.tmp-${process.pid}`;
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
  return true;
}
