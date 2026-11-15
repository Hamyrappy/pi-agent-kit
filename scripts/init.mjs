import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { access, chmod, cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, configPath, piCli } from './common.mjs';
import { configureOpenRouterModel } from './model-config.mjs';
async function exists(file) { try { await access(file); return true; } catch { return false; } }
if (await exists(configPath) || await exists(path.join(root, '.env'))) {
  console.error('config.json или .env уже существует. Измените их вручную; init не перезаписывает настройки.');
  process.exit(1);
}
const rl = createInterface({ input: stdin, output: stdout });
try {
  console.log('Настройка личного Telegram-ассистента. Токен вводится в видимом терминале.');
  const token = (await rl.question('Токен бота от @BotFather: ')).trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Неверный формат токена.');
  const ownerText = (await rl.question('Ваш числовой Telegram user ID: ')).trim();
  const ownerId = Number(ownerText);
  if (!/^\d+$/.test(ownerText) || !Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error('Нужен положительный числовой user ID.');
  const vaultInput = (await rl.question(`Папка Markdown/Obsidian [${path.join(root, 'vault')}]: `)).trim();
  const vaultRoot = path.resolve(vaultInput || path.join(root, 'vault'));
  if (!(await exists(vaultRoot))) await cp(path.join(root, 'template', 'vault'), vaultRoot, { recursive: true, force: false, errorOnExist: true });
  else {
    for (const file of ['AGENTS.md', 'memory.md', 'onboarding.md', 'faces/assistant/AGENTS.md', 'faces/engineer/AGENTS.md']) {
      const dest = path.join(vaultRoot, file);
      if (!(await exists(dest))) { await mkdir(path.dirname(dest), { recursive: true }); await cp(path.join(root, 'template', 'vault', file), dest, { force: false, errorOnExist: true }); }
    }
  }
  const provider = (await rl.question('Pi provider (Enter — выбор в Pi /model): ')).trim();
  const model = (await rl.question('Pi model (Enter — выбор в Pi /model): ')).trim();
  const config = {
    telegram: { tokenEnv: 'TELEGRAM_BOT_TOKEN', allowedUserIds: [ownerId] },
    pi: { command: process.execPath, args: [await piCli()], ...(provider && { provider }), ...(model && { model }) },
    vaultRoot, stateDir: path.join(root, '.state'), defaultFace: 'assistant'
  };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(root, '.env'), `TELEGRAM_BOT_TOKEN=${token}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(configPath, 0o600);
  await configureOpenRouterModel(config, process.env.PI_CODING_AGENT_DIR || path.join(root, '.pi-agent'));
  console.log('\nГотово. npm run login → /login → /model → Ctrl+C. Затем npm run doctor и npm start.');
} catch (error) { console.error(`Настройка не завершена: ${error.message}`); process.exitCode = 1; }
finally { rl.close(); }
