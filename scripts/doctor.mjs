import { access, readFile, constants } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvironment, loadConfig, piCli } from './common.mjs';
let failed = false;
function result(ok, text) { console.log(`${ok ? 'OK' : 'FAIL'} ${text}`); if (!ok) failed = true; }
const [major, minor] = process.versions.node.split('.').map(Number);
result(major > 22 || major === 22 && minor >= 19, `Node ${process.versions.node} (requires >=22.19)`);
try { await loadEnvironment(); result(true, 'Local environment loaded'); }
catch (error) { result(false, `Environment: ${error.message}`); }
try { await piCli(); result(true, 'Pi installed from the lockfile'); }
catch { result(false, 'Pi not found: npm ci --ignore-scripts'); }
try {
  const config = await loadConfig();
  result(config.telegram?.allowedUserIds?.length > 0 && config.telegram.allowedUserIds.every(id => Number.isSafeInteger(id) && id > 0), 'Telegram allowlist contains numeric IDs');
  result(Boolean(process.env[config.telegram?.tokenEnv || 'TELEGRAM_BOT_TOKEN']), 'Telegram token is set (value hidden)');
  await access(config.vaultRoot, constants.R_OK | constants.W_OK);
  result(true, 'Memory directory is readable and writable');
  const face = config.defaultFace || 'assistant';
  await access(path.join(config.facesDir || path.join(config.vaultRoot, 'faces'), face, 'AGENTS.md'));
  result(true, `Face ${face} exists`);
  const authFile = path.join(process.env.PI_CODING_AGENT_DIR, 'auth.json');
  let hasAuth = false;
  try { const auth = JSON.parse(await readFile(authFile, 'utf8')); hasAuth = Object.keys(auth).length > 0; } catch {}
  const hasEnvKey = Object.keys(process.env).some(key => /(?:API_KEY|AUTH_TOKEN)$/.test(key) && process.env[key]);
  result(hasAuth || hasEnvKey, 'Pi: saved credentials or an API key are present (model access is checked at runtime)');
} catch (error) { result(false, `Configuration: ${error.message}. Run npm run init.`); }
console.log('Local checks only: Telegram and the model are not contacted.');
process.exitCode = failed ? 1 : 0;
