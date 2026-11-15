import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, loadConfig } from './common.mjs';
if (process.platform !== 'linux') { console.error('Установка user service доступна в Linux с systemd.'); process.exit(1); }
await loadConfig();
const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
await mkdir(unitDir, { recursive: true });
const unit = `[Unit]\nDescription=Personal Pi Telegram assistant\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${quote(root)}\nExecStart=${quote(process.execPath)} ${quote(path.join(root, 'scripts', 'start.mjs'))}\nEnvironment=PATH=${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
const dest = path.join(unitDir, 'pi-agent-kit.service');
await writeFile(dest, unit, { mode: 0o600 });
for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'pi-agent-kit.service']]) {
  const result = spawnSync('systemctl', args, { stdio: 'inherit' });
  if (result.status !== 0) { console.error(`Unit сохранён: ${dest}. Нужен доступный systemd --user.`); process.exit(1); }
}
console.log('Сервис запущен. Логи: journalctl --user -u pi-agent-kit -f');
console.log('После выхода из сеанса: loginctl enable-linger "$USER" (если разрешено администратором).');
