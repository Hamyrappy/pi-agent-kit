import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, cp, access, chmod } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { root, piCli } from './common.mjs';
import { configureOpenRouterModel } from './model-config.mjs';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} завершился с ошибкой (${result.status ?? result.error?.code})`);
}
export function validName(value) { return /^[a-z_][a-z0-9_-]{0,30}$/.test(value); }
export function unitText({ directory, user, service, timezone, node = process.execPath, home }) {
  for (const value of [directory, home, node]) if (!/^\/[a-zA-Z0-9_./-]+$/.test(value)) throw new Error('В системных путях допустимы только буквы, цифры, _, -, / и точка.');
  if (!validName(user) || !validName(service) || !/^[A-Za-z0-9_+/-]+$/.test(timezone)) throw new Error('Неверное имя службы/пользователя или часовой пояс.');
  return `[Unit]\nDescription=Personal Pi Telegram assistant\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nUser=${user}\nWorkingDirectory=${directory}\nEnvironment=HOME=${home}\nEnvironment=TZ=${timezone}\nEnvironment=PATH=${path.dirname(node)}:/usr/local/bin:/usr/bin:/bin\nExecStart=${node} ${directory}/scripts/start.mjs\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nKillMode=control-group\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n`;
}
async function exists(file) { try { await access(file); return true; } catch { return false; } }
function prompt(label, fallback = '', secret = false) {
  if (process.env.PI_KIT_NONINTERACTIVE === '1') {
    if (!fallback) throw new Error(`Не задано: ${label}`);
    return fallback;
  }
  if (fallback) return fallback;
  // Read directly from /dev/tty: works with curl | sudo bash, never echoes secrets.
  const result = spawnSync('bash', ['-c', 'read -r ' + (secret ? '-s ' : '') + '-p "$1" answer </dev/tty; result=$?; printf "\\n" >/dev/tty; [ "$result" = 0 ] && printf "%s" "$answer"', 'prompt', `${label}: `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`Нужно значение: ${label}`);
  return result.stdout.trim();
}
export async function provision() {
  if (process.getuid?.() !== 0) throw new Error('Нужен root: sudo node scripts/provision.mjs');
  const service = process.env.PI_KIT_SERVICE || 'pi-agent-kit';
  const user = process.env.PI_KIT_USER || 'pi-agent-kit';
  const backupDir = path.resolve(process.env.PI_KIT_BACKUP_DIR || '/var/backups/pi-agent-kit');
  const home = `/home/${user}`;
  if (!validName(user) || !validName(service)) throw new Error('Недопустимое имя пользователя или службы.');
  const configured = await exists(path.join(root, 'config.json'));
  if (configured !== await exists(path.join(root, '.env'))) throw new Error('Существуют только config.json или .env. Дополните настройку вручную; файлы не перезаписаны.');
  let timezone = process.env.PI_KIT_TIMEZONE || '';
  let credentials;
  if (!configured) {
    const token = prompt('Токен от @BotFather (скрыт)', process.env.PI_KIT_BOT_TOKEN, true);
    const ownerText = prompt('Ваш числовой Telegram user ID', process.env.PI_KIT_OWNER_ID);
    const key = prompt('OpenRouter API key (скрыт)', process.env.PI_KIT_OPENROUTER_KEY, true);
    const name = process.env.PI_KIT_BOT_NAME || (process.env.PI_KIT_NONINTERACTIVE === '1' ? 'Помощник' : prompt('Имя бота (например, Помощник)'));
    timezone ||= process.env.PI_KIT_NONINTERACTIVE === '1' ? 'UTC' : prompt('Часовой пояс (например, Europe/Moscow)');
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('Некорректный формат токена/API key.');
    const ownerId = Number(ownerText);
    if (!/^\d+$/.test(ownerText) || !Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error('Нужен положительный Telegram user ID.');
    if (!name || name.length > 64) throw new Error('Имя бота: от 1 до 64 символов.');
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error('Неизвестный часовой пояс IANA.'); }
    // Validate before writing secrets or starting a service. Never include token in errors.
    let me;
    try { const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(20_000) }); me = await response.json(); } catch { throw new Error('Telegram getMe недоступен. Проверьте сеть и повторите установку.'); }
    if (!me.ok || !me.result?.is_bot) throw new Error('Telegram отклонил токен (getMe).');
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/setMyName`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }), signal: AbortSignal.timeout(20_000) });
      if (!(await response.json()).ok) throw new Error();
    } catch { throw new Error('Telegram не принял имя бота. Повторите установку.'); }
    credentials = { token, ownerId, key, name };
  }
  timezone ||= 'UTC';
  const text = unitText({ directory: root, user, service, timezone, home });
  if (spawnSync('id', ['-u', user], { stdio: 'ignore' }).status !== 0) run('useradd', ['--system', '--create-home', '--home-dir', home, '--shell', '/bin/bash', user]);
  run('chown', ['-R', `${user}:${user}`, root]);
  run('runuser', ['-u', user, '--', path.join(path.dirname(process.execPath), 'npm'), 'ci', '--ignore-scripts'], { cwd: root });
  if (credentials) {
    const config = { telegram: { tokenEnv: 'TELEGRAM_BOT_TOKEN', allowedUserIds: [credentials.ownerId] }, pi: { command: process.execPath, args: [await piCli()], provider: 'openrouter', model: process.env.PI_KIT_MODEL || 'deepseek/deepseek-v4.1-flash' }, vaultRoot: path.join(root, 'vault'), stateDir: path.join(root, '.state'), defaultFace: 'assistant', botName: credentials.name, timezone };
    await cp(path.join(root, 'template', 'vault'), config.vaultRoot, { recursive: true, force: false });
    await writeFile(path.join(root, '.env'), `TELEGRAM_BOT_TOKEN=${credentials.token}\nOPENROUTER_API_KEY=${credentials.key}\n`, { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(root, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await configureOpenRouterModel(config, path.join(root, '.pi-agent'));
  }
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, '.deployment.json'), JSON.stringify({ service, user, backupDir, timezone }, null, 2) + '\n', { mode: 0o600 });
  run('chown', ['-R', `${user}:${user}`, root]);
  await chmod(path.join(root, '.env'), 0o600);
  await writeFile(`/etc/systemd/system/${service}.service`, text);
  const backupRunner = `/usr/local/lib/pi-agent-kit/${service}-backup.mjs`;
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(backupDir)) throw new Error('Для systemd путь копий должен содержать только буквы, цифры, _, -, / и точку.');
  await mkdir(path.dirname(backupRunner), { recursive: true, mode: 0o755 });
  await cp(path.join(root, 'deploy/backup.mjs'), backupRunner);
  run('chown', ['root:root', backupRunner]);
  await chmod(backupRunner, 0o644);
  await writeFile(`/etc/systemd/system/${service}-backup.service`, `[Unit]\nDescription=Pi assistant daily backup\n[Service]\nType=oneshot\nExecStart=${process.execPath} ${backupRunner} ${root} ${backupDir} ${service} ${user}\nUMask=0077\n`);
  await writeFile(`/etc/systemd/system/${service}-backup.timer`, `[Unit]\nDescription=Pi assistant daily backup\n[Timer]\nOnCalendar=daily\nRandomizedDelaySec=20min\nPersistent=true\n[Install]\nWantedBy=timers.target\n`);
  run('runuser', ['-u', user, '--', process.execPath, path.join(root, 'scripts/doctor.mjs')], { cwd: root });
  run('systemctl', ['daemon-reload']);
  run('systemctl', ['enable', '--now', `${service}.service`, `${service}-backup.timer`]);
  run('systemctl', ['is-active', `${service}.service`]);
  run(process.execPath, [path.join(root, 'scripts/lifecycle.mjs'), 'backup']);
  console.log(`Готово. Напишите боту /start. Логи: journalctl -u ${service} -f\nОбслуживание: sudo ${root}/deploy/pi-kit help`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(root, 'scripts/provision.mjs')) provision().catch(error => { console.error(`Установка: ${error.message}`); process.exitCode = 1; });
