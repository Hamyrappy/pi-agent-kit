import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Bridge, normalizeConfig } from '../src/bridge.mjs';
import { buildPiArgs } from '../src/pi.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const update = (id, text, sender = 42, chatId = 42) => ({ update_id: id, message: { text, from: { id: sender }, chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' } } });
async function idle(bridge) { while (bridge.jobs.size || bridge.controlTasks.size) await Promise.allSettled([...bridge.jobs.values(), ...bridge.controlTasks]); await bridge.readyWrites; }
async function until(predicate) { for (let n = 0; n < 500; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Lifecycle fixture timed out'); }
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-bridge-lifecycle-'));
  const env = { TELEGRAM_BOT_TOKEN: '123456:fake-telegram-token-no-real-network', PI_KIT_ROOT: dir,
    PI_KIT_CONTROL_DIR: path.join(dir, 'control'), PI_KIT_SUPERVISOR_EPOCH: 'fixture-generation-one' };
  const config = normalizeConfig({ vaultRoot: dir, memoryFile: null, stateDir: path.join(dir, 'state'), telegram: { allowedUserIds: [42], allowedChatIds: [-100] } }, env);
  await mkdir(path.join(dir, 'faces', 'assistant'), { recursive: true });
  await writeFile(path.join(dir, 'faces', 'assistant', 'AGENTS.md'), 'Assistant');
  const bridges = [];
  t.after(async () => { for (const bridge of bridges) await bridge.shutdown(); await rm(dir, { recursive: true, force: true }); });
  return { dir, env, config, status: async () => JSON.parse(await readFile(path.join(config.controlDir, 'ready.json'), 'utf8')),
    request: async (id = 'request-one') => writeFile(path.join(config.controlDir, 'request.json'), JSON.stringify({ id, action: 'apply', chatId: '42', createdAt: new Date().toISOString() })),
    create: (options = {}) => { const bridge = new Bridge(config, { env, log: () => {}, telegram: { send: async () => {} }, ...options }); bridges.push(bridge); return bridge; } };
}

test('runtime readiness identifies pid and epoch and is busy before a model turn starts', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const bridge = f.create({ runner: async input => {
    const status = await f.status(); assert.equal(status.idle, false);
    assert.equal(input.env.PI_KIT_ROOT, f.dir); assert.equal(input.env.PI_KIT_CONTROL_DIR, f.config.controlDir);
    entered.resolve(); await release.promise; return 'Готово.';
  } });
  await bridge.init(); await bridge.startLifecycle();
  const status = await f.status();
  assert.equal(status.pid, process.pid); assert.equal(status.epoch, f.env.PI_KIT_SUPERVISOR_EPOCH);
  assert.equal(status.ready, true); assert.equal(status.idle, true);
  await bridge.handleUpdate(update(1, 'Поработай')); await entered.promise;
  assert.equal((await f.status()).idle, false);
  release.resolve(); await idle(bridge);
  assert.equal((await f.status()).idle, true);
});

test('restart waits for text and file delivery, then preserves next queued turn without replaying the completed one', async t => {
  const f = await fixture(t), entered = deferred(), finish = deferred(), textSent = deferred(), deliverText = deferred(), fileSent = deferred(), deliverFile = deferred();
  const calls = [], sent = [];
  const bridge = f.create({ telegram: {
    send: async (_id, text) => { sent.push(text); if (text === 'Первый ответ') { textSent.resolve(); await deliverText.promise; } },
    sendFile: async () => { fileSent.resolve(); await deliverFile.promise; return { message_id: 7 }; },
  }, runner: async input => {
    calls.push(input.prompt); entered.resolve(); await finish.promise;
    await writeFile(path.join(input.outboxDir, 'reply.txt'), 'deliverable'); return 'Первый ответ';
  } });
  await bridge.init(); await bridge.startLifecycle();
  await bridge.handleUpdate(update(1, 'first')); await entered.promise;
  await bridge.handleUpdate(update(2, 'second'));
  await f.request(); finish.resolve(); await textSent.promise;
  assert.equal((await f.status()).idle, false);
  deliverText.resolve(); await fileSent.promise;
  assert.equal((await f.status()).idle, false);
  deliverFile.resolve(); await idle(bridge);
  assert.deepEqual(calls, ['first']);
  assert.equal(bridge.state.chats['42'].queue.length, 1);
  assert.equal(bridge.state.chats['42'].active, undefined);
  assert.equal((await f.status()).idle, true); assert.equal((await f.status()).quiescing, true);
  const originalSession = bridge.state.chats['42'].sessions.assistant;
  await bridge.shutdown(); await unlink(path.join(f.config.controlDir, 'request.json'));
  const resumed = [];
  const next = f.create({ env: { ...f.env, PI_KIT_SUPERVISOR_EPOCH: 'fixture-generation-two' }, runner: async input => { resumed.push(input); return 'Второй ответ'; } });
  await next.init({ resume: false }); assert.equal(resumed.length, 0);
  await next.startLifecycle(); await idle(next);
  assert.deepEqual(resumed.map(input => input.prompt), ['second']);
  assert.equal(resumed[0].sessionId, originalSession);
  assert.equal((await f.status()).epoch, 'fixture-generation-two');
});

test('startup result is enqueued durably once even when crash leaves result.json unacknowledged', async t => {
  const f = await fixture(t), notice = { id: 'operation-one', chatId: 42, status: 'applied', message: 'Изменения применены, помощник снова работает.' };
  const resultFile = path.join(f.config.controlDir, 'result.json'); await mkdir(f.config.controlDir);
  await writeFile(resultFile, JSON.stringify(notice));
  const first = f.create({ telegram: { send: async () => { throw new Error('offline'); } } });
  await first.init({ resume: false }); await first.startLifecycle(); await idle(first);
  const persisted = JSON.parse(await readFile(path.join(f.config.stateDir, 'state.json'), 'utf8'));
  assert.ok(persisted.acceptedSources['self-change-result:operation-one']);
  assert.deepEqual(persisted.chats['42'].outbox, [notice.message]);
  await first.shutdown();
  // Simulate a crash after state save but before unlink acknowledged the result.
  await writeFile(resultFile, JSON.stringify(notice));
  const sent = [];
  const second = f.create({ telegram: { send: async (_id, text) => sent.push(text) } });
  await second.init({ resume: false }); await second.startLifecycle(); await idle(second);
  assert.deepEqual(sent, [notice.message]);
  assert.equal(second.state.chats['42'].queue.length, 0);
});

test('a rejected restart resumes retained queue when the supervisor removes its request', async t => {
  const f = await fixture(t), calls = [], sent = [];
  const bridge = f.create({ telegram: { send: async (_id, text) => sent.push(text) }, runner: async input => { calls.push(input.prompt); return 'Ответ'; } });
  await bridge.init(); await bridge.startLifecycle(); await f.request(); await bridge.refreshRestartRequest();
  await bridge.handleUpdate(update(1, 'preserved')); await idle(bridge);
  assert.equal(calls.length, 0); assert.equal(bridge.state.chats['42'].queue.length, 1);
  await writeFile(path.join(f.config.controlDir, 'result.json'), JSON.stringify({ id: 'request-one', chatId: 42, status: 'failed', message: 'Проверка не прошла, продолжаю работать.' }));
  await unlink(path.join(f.config.controlDir, 'request.json'));
  await until(() => calls.length === 1); await idle(bridge);
  assert.ok(sent.includes('Проверка не прошла, продолжаю работать.'));
  assert.equal((await f.status()).quiescing, false);
});

test('restart commands require owner, stay responsive during checks and deliver acknowledgement before idle', async t => {
  const f = await fixture(t), validating = deferred(), validate = deferred(), sent = [], controls = [];
  const bridge = f.create({ telegram: { send: async (_id, text) => sent.push(text) }, selfChange: async (action, id) => {
    controls.push({ action, id });
    if (action === 'status') return { message: 'Проверка выполняется.' };
    validating.resolve(); await validate.promise; await f.request(); return { id: 'request-one', message: 'Перезапуск поставлен в очередь.' };
  } });
  bridge.bot = { id: 7, username: 'test_bot' };
  await bridge.init(); await bridge.startLifecycle();
  await bridge.handleUpdate(update(1, '/restart@test_bot', 99, -100));
  assert.equal(controls.length, 0); assert.ok(sent.some(text => text.includes('only to the owner')));
  await bridge.handleUpdate(update(2, '/restart')); await validating.promise;
  assert.equal((await f.status()).idle, false);
  await bridge.handleUpdate(update(3, '/restart_status'));
  assert.ok(sent.includes('Проверка выполняется.'));
  await bridge.handleUpdate(update(4, '/stop'));
  assert.ok(sent.some(text => text.includes('Restart preparation is still in progress')));
  validate.resolve(); await idle(bridge);
  assert.deepEqual(controls.map(call => call.action), ['restart', 'status']);
  assert.ok(sent.includes('Перезапуск поставлен в очередь.'));
  assert.equal((await f.status()).idle, true);
});

test('owner system context describes saved-code self-change and nonowner has no such instructions', async t => {
  const f = await fixture(t);
  const args = await buildPiArgs({ config: f.config, face: 'assistant', sessionId: 'test-session', caller: { chatId: '42', isOwner: true } });
  assert.ok(args.some(arg => arg.includes('self-change.mjs') && arg.includes('begin') && arg.includes('apply')));
  const guest = await buildPiArgs({ config: f.config, face: 'assistant', sessionId: 'test-session', caller: { chatId: '-100', isOwner: false } });
  assert.equal(guest.some(arg => arg.includes('self-change.mjs')), false);
});
