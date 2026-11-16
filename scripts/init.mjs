import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { access, chmod, cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, configPath, piCli } from './common.mjs';
import { configureOpenRouterModel } from './model-config.mjs';
async function exists(file) { try { await access(file); return true; } catch { return false; } }
if (await exists(configPath) || await exists(path.join(root, '.env'))) {
  console.error('config.json or .env already exists. Edit it manually; init does not overwrite existing settings.');
  process.exit(1);
}
const rl = createInterface({ input: stdin, output: stdout });
try {
  console.log('Personal Telegram assistant setup. The token will be visible in the terminal.');
  const token = (await rl.question('Bot token from @BotFather: ')).trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid token format.');
  const ownerText = (await rl.question('Your numeric Telegram user ID: ')).trim();
  const ownerId = Number(ownerText);
  if (!/^\d+$/.test(ownerText) || !Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error('A positive numeric user ID is required.');
  const vaultInput = (await rl.question(`Markdown/Obsidian directory [${path.join(root, 'vault')}]: `)).trim();
  const vaultRoot = path.resolve(vaultInput || path.join(root, 'vault'));
  if (!(await exists(vaultRoot))) await cp(path.join(root, 'template', 'vault'), vaultRoot, { recursive: true, force: false, errorOnExist: true });
  else {
    for (const file of ['AGENTS.md', 'memory.md', 'onboarding.md', 'faces/assistant/AGENTS.md', 'faces/engineer/AGENTS.md']) {
      const dest = path.join(vaultRoot, file);
      if (!(await exists(dest))) { await mkdir(path.dirname(dest), { recursive: true }); await cp(path.join(root, 'template', 'vault', file), dest, { force: false, errorOnExist: true }); }
    }
  }
  const provider = (await rl.question('Pi provider (Enter to select using Pi /model): ')).trim();
  const model = (await rl.question('Pi model (Enter to select using Pi /model): ')).trim();
  const config = {
    telegram: { tokenEnv: 'TELEGRAM_BOT_TOKEN', allowedUserIds: [ownerId] },
    pi: { command: process.execPath, args: [await piCli()], ...(provider && { provider }), ...(model && { model }) },
    vaultRoot, stateDir: path.join(root, '.state'), defaultFace: 'assistant'
  };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(root, '.env'), `TELEGRAM_BOT_TOKEN=${token}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(configPath, 0o600);
  await configureOpenRouterModel(config, process.env.PI_CODING_AGENT_DIR || path.join(root, '.pi-agent'));
  console.log('\nReady. npm run login → /login → /model → Ctrl+C. Then run npm run doctor and npm start.');
} catch (error) { console.error(`Setup did not finish: ${error.message}`); process.exitCode = 1; }
finally { rl.close(); }
