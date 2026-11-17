import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Bridge, StateStore, normalizeConfig, splitTelegram, TelegramClient } from '../src/bridge.mjs';
import { runPi, buildPiArgs, redact } from '../src/pi.mjs';

const env = { ...process.env, TELEGRAM_BOT_TOKEN: '123456:secret-token-for-test-only-abcdef' };
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-bridge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const face of ['assistant', 'engineer']) {
    await mkdir(path.join(dir, 'faces', face), { recursive: true });
    await writeFile(path.join(dir, 'faces', face, 'AGENTS.md'), `Face ${face}`);
  }
  await writeFile(path.join(dir, 'memory.md'), 'Shared memory');
  const config = normalizeConfig({ vaultRoot: dir, stateDir: path.join(dir, 'state'), telegram: { allowedUserIds: [42], allowedChatIds: [-100] } }, env);
  return { dir, config };
}
const update = (id, text, sender = 42, chatId = 42, extra = {}) => ({ update_id: id, message: { from: { id: sender }, chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' }, text, ...extra } });
async function idle(bridge) { while (bridge.jobs.size) await Promise.all([...bridge.jobs.values()]); }

test('config requires explicit vault, owner and token; chunks preserve unicode; redaction', () => {
  assert.throws(() => normalizeConfig({ telegram: { allowedUserIds: [42] } }, {}), /Set TELEGRAM/);
  assert.throws(() => normalizeConfig({ telegram: { allowedUserIds: [42] } }, env), /vaultRoot/);
  const text = 'a'.repeat(3999) + '😀\n' + 'z'.repeat(8000);
  const chunks = splitTelegram(text);
  assert.equal(chunks.join(''), text); assert.ok(chunks.every(chunk => chunk.length <= 4000));
  assert.ok(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk)));
  assert.equal(redact(`oops ${env.TELEGRAM_BOT_TOKEN}`, env), 'oops [redacted]');
});

test('owner filtering, durable offsets, face sessions and /new', async t => {
  const { config } = await fixture(t), calls = [], sent = [];
  const bridge = new Bridge(config, { env, telegram: { send: async (id, text) => sent.push({ id, text }) }, runner: async input => { calls.push(input); return 'answer'; } });
  await bridge.init();
  await bridge.handleUpdate(update(1, 'unauthorized', 99));
  await bridge.handleUpdate(update(2, 'first')); await idle(bridge);
  await bridge.handleUpdate(update(3, '/face engineer'));
  await bridge.handleUpdate(update(4, 'second')); await idle(bridge);
  await bridge.handleUpdate(update(5, '/face assistant'));
  await bridge.handleUpdate(update(6, 'third')); await idle(bridge);
  assert.equal(calls.length, 3); assert.equal(calls[0].sessionId, calls[2].sessionId);
  assert.notEqual(calls[0].sessionId, calls[1].sessionId);
  await bridge.handleUpdate(update(7, '/new'));
  await bridge.handleUpdate(update(8, 'fourth')); await idle(bridge);
  assert.notEqual(calls[0].sessionId, calls[3].sessionId);
  await bridge.handleUpdate(update(8, 'duplicate')); await idle(bridge);
  assert.equal(calls.length, 4);
  const persisted = JSON.parse(await readFile(path.join(config.stateDir, 'state.json'), 'utf8'));
  assert.equal(persisted.offset, 9); assert.equal(persisted.chats['42'].queue.length, 0);
  assert.equal(sent.filter(item => item.text === 'answer').length, 4);
  await bridge.shutdown();
});

test('one active turn, queued messages and immediate /stop', async t => {
  const { config } = await fixture(t), calls = [], sent = [];
  const bridge = new Bridge(config, { env, telegram: { send: async (_id, text) => sent.push(text) }, runner: input => {
    calls.push(input);
    return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await bridge.init(); await bridge.handleUpdate(update(1, 'first'));
  while (!calls.length) await new Promise(resolve => setTimeout(resolve, 1));
  await bridge.handleUpdate(update(2, 'second'));
  assert.equal(calls.length, 1); assert.equal(bridge.state.chats['42'].queue.length, 1);
  await bridge.handleUpdate(update(3, '/status'));
  assert.ok(sent.some(text => text.includes('Preparing a response')));
  await bridge.handleUpdate(update(4, '/stop')); await idle(bridge);
  assert.equal(calls[0].signal.aborted, true); assert.equal(calls.length, 1);
  assert.equal(bridge.state.chats['42'].queue.length, 0);
  await bridge.shutdown();
});

test('groups require explicit allowlist and mention or reply; commands require owner', async t => {
  const { config } = await fixture(t), calls = [], sent = [];
  const bridge = new Bridge(config, { env, telegram: { send: async (_id, text) => sent.push(text) }, runner: async input => { calls.push(input); return 'answer'; } });
  bridge.bot = { id: 7, username: 'test_bot' };
  await bridge.init();
  await bridge.handleUpdate(update(1, 'hello', 42, -100));
  await bridge.handleUpdate(update(2, '@test_bot hello', 99, -999));
  await bridge.handleUpdate(update(3, '@test_bot hello', 99, -100)); await idle(bridge);
  assert.equal(calls.length, 1); assert.equal(calls[0].prompt, 'hello');
  assert.equal(calls[0].caller.isOwner, false); assert.equal(calls[0].caller.senderId, '99');
  assert.equal(calls[0].env.PI_KIT_CHAT_ID, '-100'); assert.equal(calls[0].env.PI_KIT_STATE_DIR, config.stateDir);
  await bridge.handleUpdate(update(4, '/face@test_bot engineer', 99, -100));
  assert.equal(bridge.state.chats['-100'].face, 'assistant');
  await bridge.handleUpdate(update(5, 'reply', 99, -100, { reply_to_message: { from: { id: 7 } } })); await idle(bridge);
  await bridge.handleUpdate(update(6, '/new@other_bot', 42));
  assert.equal(calls.length, 2); assert.ok(sent.some(text => text.includes('only to the owner')));
  await bridge.shutdown();
});

test('durable source dedup and interrupted active turn recovery', async t => {
  const { config } = await fixture(t);
  const store = new StateStore(config.stateDir); await store.load();
  store.state.chats['42'] = { face: 'assistant', sessions: {}, queue: [], active: { prompt: 'interrupted', face: 'assistant', sessionId: 'session-test' } };
  await store.save();
  const calls = [];
  const bridge = new Bridge(config, { env, telegram: { send: async () => {} }, runner: async input => { calls.push(input); return 'ok'; } });
  await bridge.init(); await idle(bridge);
  assert.equal(calls[0].prompt, 'interrupted');
  assert.equal(await bridge.enqueue({ chatId: 42, prompt: 'job', sourceId: 'job:one' }), true); await idle(bridge);
  assert.equal(await bridge.enqueue({ chatId: 42, prompt: 'job', sourceId: 'job:one' }), false);
  await bridge.shutdown();
  const reopened = new StateStore(config.stateDir); await reopened.load();
  assert.ok(reopened.state.acceptedSources['job:one']);
});

test('reply remains in durable outbox when Telegram send fails', async t => {
  const { config } = await fixture(t);
  const bridge = new Bridge(config, { env, log: () => {}, telegram: { send: async () => { throw new Error('network'); } }, runner: async () => 'retained answer' });
  await bridge.init(); await bridge.handleUpdate(update(1, 'hello')); await idle(bridge);
  assert.deepEqual(bridge.state.chats['42'].outbox, ['retained answer']);
  const saved = JSON.parse(await readFile(path.join(config.stateDir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.chats['42'].outbox, ['retained answer']);
  await bridge.shutdown();
});

test('Telegram client uses native fetch POST and never exposes token on network failure', async t => {
  const { config } = await fixture(t), calls = [];
  const client = new TelegramClient(config, { env, fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ ok: true, result: { id: 1 } }) }; } });
  await client.send(42, 'hello');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(JSON.parse(calls[0].options.body).text, 'hello');
  await client.send(42, '**hi** there');
  const styled = JSON.parse(calls[1].options.body);
  assert.equal(styled.parse_mode, 'HTML'); assert.equal(styled.text, '<b>hi</b> there');
  await client.send(42, '- one\n- two');
  assert.equal(JSON.parse(calls[2].options.body).text, '• one\n• two');
  const rejected = [];
  const picky = new TelegramClient(config, { env, fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body); rejected.push(payload);
    if (payload.parse_mode) return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: 'can not parse entities' }) };
    return { ok: true, json: async () => ({ ok: true, result: { id: 1 } }) };
  } });
  await picky.send(42, '**hi** there');
  assert.equal(rejected[1].parse_mode, undefined); assert.equal(rejected[1].text, '**hi** there');
  assert.equal(rejected[0].parse_mode, 'HTML');
  const failing = new TelegramClient(config, { env, fetchImpl: async () => { throw new Error(env.TELEGRAM_BOT_TOKEN); } });
  await assert.rejects(failing.call('getMe'), error => !error.message.includes(env.TELEGRAM_BOT_TOKEN));
});

test('Pi process parses JSONL including unicode separators and retains explicit session/face', async t => {
  const { config, dir } = await fixture(t);
  const fake = path.join(dir, 'fake-pi.mjs');
  await writeFile(fake, `let prompt=''; for await (const part of process.stdin) prompt+=part; process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:prompt+'\\u2028done'}],stopReason:'stop'}})+'\\n');`);
  config.pi = { command: process.execPath, args: [fake], timeoutMs: 2000, provider: 'test', model: 'test-model' };
  const args = await buildPiArgs({ config, face: 'engineer', sessionId: 'test-session' });
  assert.ok(args.includes('--session-id')); assert.ok(args.includes('test-session'));
  assert.ok(args.includes(path.join(config.facesDir, 'engineer', 'AGENTS.md')));
  assert.ok(args.includes(config.memoryFile)); assert.ok(args.includes('--provider'));
  const groupArgs = await buildPiArgs({ config, face: 'engineer', sessionId: 'test-session', caller: { isOwner: false, chatId: '-100' } });
  assert.ok(groupArgs.includes('--no-tools')); assert.ok(groupArgs.includes('--no-mcp')); assert.ok(groupArgs.includes('--no-extensions'));
  assert.equal(await runPi({ config, face: 'engineer', sessionId: 'test-session', prompt: 'hello', env }), 'hello\u2028done');
});

test('Pi recognizes provider errors even at exit zero; timeout and stop terminate child', async t => {
  const { config, dir } = await fixture(t), fake = path.join(dir, 'fake-error.mjs');
  await writeFile(fake, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'provider rejected'}}));`);
  config.pi = { command: process.execPath, args: [fake], timeoutMs: 2000 };
  const input = { config, face: 'assistant', sessionId: 'test-session', prompt: 'hello', env };
  await assert.rejects(runPi(input), /provider rejected/);
  await writeFile(fake, 'setInterval(()=>{},1000);'); config.pi.timeoutMs = 100;
  await assert.rejects(runPi(input), /Pi timed out/);
  config.pi.timeoutMs = 5000;
  const controller = new AbortController(); const turn = runPi({ ...input, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(turn, /Stopped/);
});

test('a failed primary model falls back once, but never after a tool ran or on stop', async t => {
  const { config, dir } = await fixture(t), fake = path.join(dir, 'fake-fallback.mjs'), logs = [];
  await writeFile(fake, `const a=process.argv, m=a[a.indexOf('--model')+1], tool=process.env.FAKE_TOOL==='1';
const out=o=>console.log(JSON.stringify(o));
if (m==='primary') { if (tool) out({type:'tool_execution_start'}); out({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'quota exceeded'}}); }
else out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'from '+m+' thinking '+a[a.indexOf('--thinking')+1]}],stopReason:'stop'}});`);
  config.pi = { command: process.execPath, args: [fake], timeoutMs: 2000, provider: 'p', model: 'primary', thinking: 'low',
    fallback: { provider: 'openrouter', model: 'backup' } };
  const input = { config, face: 'assistant', sessionId: 'test-session', prompt: 'hello', env, log: m => logs.push(m) };
  const text = await runPi(input);
  assert.match(text, /^from backup thinking low/);
  assert.match(text, /Fallback model backup answered/);
  assert.match(logs[0], /quota exceeded/);
  config.pi.fallback.notify = false;
  assert.equal(await runPi(input), 'from backup thinking low');
  await assert.rejects(runPi({ ...input, env: { ...env, FAKE_TOOL: '1' } }), /quota exceeded/);
  delete config.pi.fallback;
  await assert.rejects(runPi(input), /quota exceeded/);
  config.pi.fallback = { model: 'backup' };
  await writeFile(fake, 'setInterval(()=>{},1000);'); config.pi.timeoutMs = 5000;
  const controller = new AbortController(); const turn = runPi({ ...input, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(turn, /Stopped/);
});

test('start greeting, reminders and cancellation are readable and scoped to the owner chat', async t => {
  const { config } = await fixture(t), sent = [];
  config.botName = 'Искра'; config.timezone = 'Europe/Moscow';
  const bridge = new Bridge(config, { env, telegram: { send: async (_id, text) => sent.push(text) }, runner: async () => 'ok' });
  await bridge.init();
  const jobs = path.join(config.stateDir, 'jobs'); await mkdir(jobs);
  await writeFile(path.join(jobs, 'tea.json'), JSON.stringify({ chatId: 42, dueAt: '2026-12-01T09:00:00Z', prompt: 'Выпить чай' }));
  await writeFile(path.join(jobs, 'other.json'), JSON.stringify({ chatId: -100, dueAt: '2026-12-01T09:00:00Z', prompt: 'Чужое дело' }));
  await bridge.handleUpdate(update(1, '/start'));
  assert.match(sent.at(-1), /I'm Искра/); assert.match(sent.at(-1), /voice message/);
  await bridge.handleUpdate(update(2, '/reminders'));
  assert.match(sent.at(-1), /tea: Выпить чай/); assert.match(sent.at(-1), /12:00/); assert.doesNotMatch(sent.at(-1), /Чужое дело/);
  await bridge.handleUpdate(update(3, '/cancel other')); assert.match(sent.at(-1), /not found/);
  await bridge.handleUpdate(update(4, '/cancel tea')); assert.equal(sent.at(-1), 'Reminder cancelled. If it has already started, use /stop.');
  await bridge.handleUpdate(update(5, '/reminders')); assert.match(sent.at(-1), /No active reminders/);
  await bridge.shutdown();
});
