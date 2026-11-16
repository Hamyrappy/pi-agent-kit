import { spawn } from 'node:child_process';
import { loadEnvironment, loadConfig, piCli, root } from './common.mjs';
await loadEnvironment();
let config;
try { config = await loadConfig(); }
catch { console.error('Run npm run init first.'); process.exit(1); }
console.log(`Pi credentials: ${process.env.PI_CODING_AGENT_DIR}`);
console.log('In Pi, run /login, then /model. Exit with Ctrl+C.');
const child = spawn(process.execPath, [await piCli()], {
  cwd: config.vaultRoot || root, env: process.env, stdio: 'inherit'
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
