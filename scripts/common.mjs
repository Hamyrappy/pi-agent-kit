import { readFile, access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const configPath = path.resolve(process.env.PI_KIT_CONFIG || path.join(root, 'config.json'));
export async function loadEnvironment() {
  try { process.loadEnvFile(path.join(root, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  process.env.PI_CODING_AGENT_DIR ||= path.join(root, '.pi-agent');
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true, mode: 0o700 });
}
export async function loadConfig() { return JSON.parse(await readFile(configPath, 'utf8')); }
export async function piCli() {
  const packageDir = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const metadata = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  const cli = path.join(packageDir, typeof metadata.bin === 'string' ? metadata.bin : metadata.bin.pi);
  await access(cli);
  return cli;
}
