import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

// Preserve user overrides; constrain new OpenRouter models to a modest output budget.
export async function configureOpenRouterModel(config, agentDir) {
  if (config.pi?.provider !== 'openrouter' || !config.pi?.model) return false;
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const file = path.join(agentDir, 'models.json');
  let data = {};
  try { data = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  data.providers ??= {};
  data.providers.openrouter ??= {};
  data.providers.openrouter.modelOverrides ??= {};
  const id = config.pi.model.replace(/^openrouter\//, '');
  const override = data.providers.openrouter.modelOverrides[id] ??= {};
  if (override.maxTokens !== undefined) return false;
  override.maxTokens = 8192;
  const temp = file + `.tmp-${process.pid}`;
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
  return true;
}
