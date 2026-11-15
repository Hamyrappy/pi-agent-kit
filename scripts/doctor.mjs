import { access, readFile, constants } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvironment, loadConfig, piCli } from './common.mjs';
let failed = false;
function result(ok, text) { console.log(`${ok ? 'OK' : 'FAIL'} ${text}`); if (!ok) failed = true; }
const [major, minor] = process.versions.node.split('.').map(Number);
result(major > 22 || major === 22 && minor >= 19, `Node ${process.versions.node} (нужен >=22.19)`);
try { await loadEnvironment(); result(true, 'Локальное окружение загружено'); }
catch (error) { result(false, `Окружение: ${error.message}`); }
try { await piCli(); result(true, 'Pi установлен из lockfile'); }
catch { result(false, 'Pi не найден: npm ci --ignore-scripts'); }
try {
  const config = await loadConfig();
  result(config.telegram?.allowedUserIds?.length > 0 && config.telegram.allowedUserIds.every(id => Number.isSafeInteger(id) && id > 0), 'Telegram allowlist содержит числовые ID');
  result(Boolean(process.env[config.telegram?.tokenEnv || 'TELEGRAM_BOT_TOKEN']), 'Telegram token задан (значение скрыто)');
  await access(config.vaultRoot, constants.R_OK | constants.W_OK);
  result(true, 'Папка памяти доступна для чтения и записи');
  const face = config.defaultFace || 'assistant';
  await access(path.join(config.facesDir || path.join(config.vaultRoot, 'faces'), face, 'AGENTS.md'));
  result(true, `Лицо ${face} существует`);
  const authFile = path.join(process.env.PI_CODING_AGENT_DIR, 'auth.json');
  let hasAuth = false;
  try { const auth = JSON.parse(await readFile(authFile, 'utf8')); hasAuth = Object.keys(auth).length > 0; } catch {}
  const hasEnvKey = Object.keys(process.env).some(key => /(?:API_KEY|AUTH_TOKEN)$/.test(key) && process.env[key]);
  result(hasAuth || hasEnvKey, 'Pi: сохранена авторизация или задан API key (доступ к модели проверяется запуском)');
} catch (error) { result(false, `Конфигурация: ${error.message}. Выполните npm run init.`); }
console.log('Проверка локальная: Telegram и модель не вызываются.');
process.exitCode = failed ? 1 : 0;
