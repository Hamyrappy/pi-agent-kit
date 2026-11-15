import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, symlink, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { root } from './common.mjs';
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-kit-setup-'));
  await cp(path.join(root, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  await cp(path.join(root, 'template'), path.join(dir, 'template'), { recursive: true });
  await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}
function runInit(dir, answers) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/init.mjs'], { cwd: dir, env: { ...process.env, PI_KIT_CONFIG: path.join(dir, 'config.json') } });
    const prompts = ['Токен бота', 'Ваш числовой', 'Папка Markdown', 'Pi provider', 'Pi model'];
    let output = '', pending = '', index = 0;
    const timeout = setTimeout(() => { child.kill(); reject(new Error('init hung: ' + output)); }, 10000);
    child.stdout.on('data', data => {
      const text = data.toString(); output += text; pending += text;
      if (index < answers.length && pending.includes(prompts[index])) {
        child.stdin.write(answers[index++] + '\n'); pending = '';
      }
    });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
}
test('init creates isolated private configuration and a usable two-face vault', async () => {
  const dir = await fixture();
  try {
    const result = await runInit(dir, ['123456:fake_test_token', '12345', '', '', '']);
    assert.equal(result.code, 0, result.output);
    const config = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(config.telegram.allowedUserIds, [12345]);
    assert.equal(config.defaultFace, 'assistant');
    assert.equal(config.pi.command, process.execPath);
    for (const file of ['AGENTS.md', 'memory.md', 'onboarding.md', 'faces/assistant/AGENTS.md', 'faces/engineer/AGENTS.md']) {
      assert.ok((await readFile(path.join(config.vaultRoot, file), 'utf8')).length > 0);
    }
    assert.equal((await stat(path.join(dir, '.env'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(dir, 'config.json'))).mode & 0o777, 0o600);
    const again = await runInit(dir, []);
    assert.equal(again.code, 1);
    assert.match(again.output, /не перезаписывает/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('init rejects invalid owner IDs before creating configuration', async () => {
  const dir = await fixture();
  try {
    const result = await runInit(dir, ['123456:fake_test_token', 'anybody']);
    assert.equal(result.code, 1);
    assert.match(result.output, /положительный числовой/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('OpenRouter configuration caps output and preserves existing provider overrides', async () => {
  const { configureOpenRouterModel } = await import('./model-config.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-kit-model-'));
  try {
    const config = { pi: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' } };
    assert.equal(await configureOpenRouterModel(config, dir), true);
    let data = JSON.parse(await readFile(path.join(dir, 'models.json'), 'utf8'));
    assert.equal(data.providers.openrouter.modelOverrides[config.pi.model].maxTokens, 8192);
    assert.equal(await configureOpenRouterModel(config, dir), false);
    assert.equal(await configureOpenRouterModel({ pi: { provider: 'openai', model: 'anything' } }, dir), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
