import { spawn } from 'node:child_process';
import { loadEnvironment, loadConfig, piCli, root } from './common.mjs';
await loadEnvironment();
let config;
try { config = await loadConfig(); }
catch { console.error('Сначала выполните npm run init.'); process.exit(1); }
console.log(`Pi credentials: ${process.env.PI_CODING_AGENT_DIR}`);
console.log('В Pi выполните /login, затем /model. Выход: Ctrl+C.');
const child = spawn(process.execPath, [await piCli()], {
  cwd: config.vaultRoot || root, env: process.env, stdio: 'inherit'
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
