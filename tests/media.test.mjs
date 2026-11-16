import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Bridge, TelegramClient, StateStore, normalizeConfig } from '../src/bridge.mjs';
import { safeFilename, telegramAttachment, collectOutbox, MAX_MEDIA_BYTES } from '../src/media.mjs';
import { buildPiArgs } from '../src/pi.mjs';

const token = '123456:fake-private-telegram-token-abcdef';
const testEnv = { TELEGRAM_BOT_TOKEN: token, OPENROUTER_API_KEY: 'fake-openrouter-key' };
const update = (id, payload, sender = 42, chatId = 42) => ({ update_id: id, message: { from: { id: sender }, chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' }, ...payload } });
async function idle(bridge) { while (bridge.jobs.size) await Promise.all([...bridge.jobs.values()]); }
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for fake endpoint');
}
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-media-'));
  const requests = [], uploads = [], sent = [];
  let onGetFile = null, onDownload = null, onTranscribe = null, onUpload = null;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      requests.push({ url: request.url, body, headers: request.headers });
      const json = value => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
      if (request.url.endsWith('/getFile')) {
        if (onGetFile) return await onGetFile(request, response, JSON.parse(body));
        return json({ ok: true, result: { file_path: 'files/incoming.ogg', file_size: 5 } });
      }
      if (request.url.startsWith('/file/')) {
        if (onDownload) return await onDownload(request, response);
        return response.end('audio');
      }
      if (request.url === '/transcriptions') {
        if (onTranscribe) return await onTranscribe(request, response, JSON.parse(body));
        return json({ text: 'Купи молока завтра.' });
      }
      if (request.url.endsWith('/sendDocument')) {
        uploads.push(body.toString());
        if (onUpload) return await onUpload(request, response);
        return json({ ok: true, result: { message_id: 123 } });
      }
      if (request.url.endsWith('/sendMessage')) { sent.push(JSON.parse(body).text); return json({ ok: true, result: { message_id: 10 } }); }
      return json({ ok: true, result: true });
    } catch { response.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  await mkdir(path.join(dir, 'faces', 'assistant'), { recursive: true });
  await writeFile(path.join(dir, 'faces', 'assistant', 'AGENTS.md'), 'Everyday assistant');
  const config = normalizeConfig({ vaultRoot: dir, stateDir: path.join(dir, 'state'), memoryFile: null,
    telegram: { allowedUserIds: [42], allowedChatIds: [-100], apiBase },
    media: { ...overrides, transcription: { endpoint: `${apiBase}/transcriptions`, ...overrides.transcription } }, timezone: 'Europe/Moscow' }, testEnv);
  let bridge;
  t.after(async () => { await bridge?.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { dir, config, requests, uploads, sent, apiBase,
    start: async (runner, env = testEnv) => { bridge = new Bridge(config, { env, runner, log: () => {} }); await bridge.init(); return bridge; },
    getFile: fn => { onGetFile = fn; }, download: fn => { onDownload = fn; }, transcribe: fn => { onTranscribe = fn; }, upload: fn => { onUpload = fn; } };
}

test('media defaults and safe filenames reject unsafe sizes and keep Telegram attachment metadata bounded', () => {
  assert.equal(safeFilename('../../a\u0000.txt'), 'a_.txt');
  assert.equal(safeFilename('..'), 'attachment');
  assert.equal(safeFilename('a'.repeat(200)).length, 120);
  const attachment = telegramAttachment({ photo: [{ file_id: 'small', width: 10, height: 10 }, { file_id: 'large', width: 20, height: 20 }] });
  assert.equal(attachment.fileId, 'large');
  assert.throws(() => normalizeConfig({ vaultRoot: '/tmp', telegram: { allowedUserIds: [42] }, media: { maxDownloadBytes: MAX_MEDIA_BYTES + 1 } }, testEnv), /maxDownloadBytes/);
});

test('voice is downloaded privately and transcribed with OpenRouter JSON, caption and reply preserved', async t => {
  const f = await fixture(t), calls = [];
  const bridge = await f.start(async input => { calls.push(input); return 'Конечно.'; });
  await bridge.handleUpdate(update(1, { voice: { file_id: 'voice-one', file_size: 5, mime_type: 'audio/ogg' }, caption: 'Запиши дело', reply_to_message: { text: 'Что добавить?' } }));
  await idle(bridge);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /Запиши дело/); assert.match(calls[0].prompt, /Купи молока завтра/); assert.match(calls[0].prompt, /Что добавить/);
  const request = f.requests.find(item => item.url === '/transcriptions');
  assert.deepEqual(JSON.parse(request.body), { model: 'elevenlabs/scribe-v2', input_audio: { data: Buffer.from('audio').toString('base64'), format: 'ogg' } });
  assert.equal(request.headers.authorization, `Bearer ${testEnv.OPENROUTER_API_KEY}`);
  const mediaDir = path.join(f.config.stateDir, 'media', '42');
  assert.equal((await stat(mediaDir)).mode & 0o777, 0o700);
  assert.match(calls[0].env.PI_KIT_OUTBOX, /outbox\/42\//);
  assert.ok(f.sent.includes('Конечно.'));
});

test('photo caption and document filename reach the correct input without becoming commands', async t => {
  const f = await fixture(t), calls = [];
  const bridge = await f.start(async input => { calls.push(input); return 'Получено.'; });
  await bridge.handleUpdate(update(1, { photo: [{ file_id: 'photo-one', width: 2, height: 2 }], caption: 'Что на фото?' })); await idle(bridge);
  assert.equal(calls[0].attachments[0].kind, 'photo');
  assert.match(calls[0].prompt, /Что на фото/);
  const args = await buildPiArgs({ ...calls[0], config: f.config });
  assert.ok(args.includes(`@${calls[0].attachments[0].path}`));
  assert.ok(args.some(value => value.includes('Europe/Moscow')));
  assert.ok(args.some(value => value.includes('currentTime')));
  await bridge.handleUpdate(update(2, { document: { file_id: 'doc-one', file_name: '../../private.txt', mime_type: 'text/plain' }, caption: '/new' })); await idle(bridge);
  assert.equal(calls.length, 2); assert.equal(calls[1].attachments.length, 0);
  assert.match(calls[1].prompt, /^\/new/); assert.match(calls[1].prompt, /private\.txt/);
  assert.equal(calls[0].sessionId, calls[1].sessionId);
});

test('audio uses the media format rather than the Telegram storage suffix', async t => {
  const f = await fixture(t);
  const bridge = await f.start(async () => 'Хорошо.');
  await bridge.handleUpdate(update(1, { audio: { file_id: 'mp3-one', file_name: 'meeting.mp3', mime_type: 'audio/mpeg' }, caption: 'Что решили?' })); await idle(bridge);
  assert.equal(JSON.parse(f.requests.find(request => request.url === '/transcriptions').body).input_audio.format, 'mp3');
});

test('denied users and unaddressed groups never download media; addressed caption works', async t => {
  const f = await fixture(t), calls = [];
  const bridge = await f.start(async input => { calls.push(input); return 'Да.'; });
  bridge.bot = { id: 7, username: 'test_bot' };
  const photo = { photo: [{ file_id: 'photo', width: 1, height: 1 }] };
  await bridge.handleUpdate(update(1, photo, 99));
  await bridge.handleUpdate(update(2, photo, 42, -100));
  await bridge.handleUpdate(update(3, { ...photo, caption: '@test_bot фото' }, 99, -999));
  await idle(bridge); assert.equal(f.requests.length, 0);
  await bridge.handleUpdate(update(4, { ...photo, caption: '@test_bot фото' }, 99, -100)); await idle(bridge);
  assert.equal(calls.length, 1); assert.equal(calls[0].caller.isOwner, false);
  assert.match(calls[0].prompt, /^фото/);
});

test('oversized metadata is refused before getFile and streamed files are bounded', async t => {
  const f = await fixture(t, { maxDownloadBytes: 8 }); let calls = 0;
  const bridge = await f.start(async () => { calls++; return 'unexpected'; });
  await bridge.handleUpdate(update(1, { document: { file_id: 'too-large', file_size: 9 } })); await idle(bridge);
  assert.equal(f.requests.filter(item => item.url.endsWith('/getFile')).length, 0);
  f.download((_request, response) => { response.write('12345'); response.end('67890'); });
  await bridge.handleUpdate(update(2, { document: { file_id: 'unknown-size' } })); await idle(bridge);
  assert.equal(calls, 0); assert.equal(f.sent.filter(text => /File too large/.test(text)).length, 2);
});

test('raw media acceptance is durable before download; /stop remains responsive during getFile', async t => {
  const f = await fixture(t); let accepted, received = false, calls = 0;
  f.getFile(async (_request, _response) => {
    accepted = JSON.parse(await readFile(path.join(f.config.stateDir, 'state.json'), 'utf8'));
    received = true; // Leave request open until its AbortSignal is cancelled.
  });
  const bridge = await f.start(async () => { calls++; return 'unexpected'; });
  await bridge.handleUpdate(update(1, { voice: { file_id: 'durable-voice' } }));
  await until(() => received);
  assert.equal(accepted.offset, 2); assert.equal(accepted.chats['42'].active.media.fileId, 'durable-voice');
  await bridge.handleUpdate(update(2, { text: '/stop' })); await idle(bridge);
  assert.equal(calls, 0); assert.equal(bridge.state.chats['42'].queue.length, 0);
  assert.ok(f.sent.some(text => text.includes('Stopping the response')));
});

test('/stop cancels transcription without waiting for its endpoint', async t => {
  const f = await fixture(t); let received = false, calls = 0;
  f.transcribe(() => { received = true; });
  const bridge = await f.start(async () => { calls++; return 'unexpected'; });
  await bridge.handleUpdate(update(1, { voice: { file_id: 'stop-voice' } })); await until(() => received);
  await bridge.handleUpdate(update(2, { text: '/stop' })); await idle(bridge);
  assert.equal(calls, 0);
});

test('missing transcription credentials and upstream failures give a useful message with no secrets', async t => {
  const f = await fixture(t); let calls = 0;
  const bridge = await f.start(async () => { calls++; return 'unexpected'; }, { TELEGRAM_BOT_TOKEN: token });
  await bridge.handleUpdate(update(1, { voice: { file_id: 'voice' } })); await idle(bridge);
  assert.equal(calls, 0); assert.ok(f.sent.some(text => text.includes('OPENROUTER_API_KEY')));
  assert.ok(f.sent.every(text => !text.includes(token)));
  bridge.env = testEnv;
  f.transcribe((_request, response) => { response.statusCode = 401; response.end(JSON.stringify({ error: token })); });
  await bridge.handleUpdate(update(2, { voice: { file_id: 'voice' } })); await idle(bridge);
  assert.ok(f.sent.some(text => text.includes('Could not transcribe')));
});

test('a completed turn sends only its own outbox files after text and records delivery', async t => {
  const f = await fixture(t), directories = [];
  const bridge = await f.start(async input => {
    directories.push(input.env.PI_KIT_OUTBOX);
    await writeFile(path.join(input.env.PI_KIT_OUTBOX, 'answer.txt'), 'Your personal plan');
    return 'План готов.';
  });
  await bridge.handleUpdate(update(1, { text: 'Сделай план файлом' })); await idle(bridge);
  await bridge.handleUpdate(update(2, { text: 'И ещё один' })); await idle(bridge);
  assert.notEqual(directories[0], directories[1]);
  assert.equal(f.uploads.length, 2); assert.match(f.uploads[0], /Your personal plan/);
  assert.equal(bridge.state.chats['42'].fileDeliveries.length, 2);
  assert.equal(bridge.state.chats['42'].fileDeliveries[0].status, 'sent');
  assert.equal(bridge.state.chats['42'].fileDeliveries[0].messageId, 123);
  const methods = f.requests.map(request => request.url.split('/').at(-1));
  assert.ok(methods.indexOf('sendMessage') < methods.indexOf('sendDocument'));
});

test('uncertain upload is not blindly retried or sent on a subsequent turn', async t => {
  const f = await fixture(t);
  f.upload((_request, response) => response.destroy());
  const bridge = await f.start(async input => { await writeFile(path.join(input.env.PI_KIT_OUTBOX, 'result.txt'), 'result'); return 'Готово.'; });
  await bridge.handleUpdate(update(1, { text: 'Файл' })); await idle(bridge);
  assert.equal(f.uploads.length, 1); assert.equal(bridge.state.chats['42'].fileDeliveries[0].status, 'unknown');
  assert.equal(bridge.state.chats['42'].outbox.length, 0);
  await bridge.handleUpdate(update(2, { text: '/status' })); await idle(bridge);
  assert.equal(f.uploads.length, 1);
});

test('crash during upload preserves unknown delivery and recovers queued raw media', async t => {
  const f = await fixture(t), store = new StateStore(f.config.stateDir); await store.load();
  store.state.chats['42'] = { face: 'assistant', sessions: { assistant: 'existing-session' }, queue: [],
    active: { media: { kind: 'voice', fileId: 'recovered-voice' }, prompt: '', face: 'assistant', sessionId: 'existing-session', caller: { chatId: '42', isOwner: true } },
    outbox: [{ id: 'unknown-file', type: 'file', status: 'sending', path: '/tmp/never-replay', filename: 'result.txt' }] };
  await store.save(); const calls = [];
  const bridge = await f.start(async input => { calls.push(input); return 'Восстановлено.'; }); await idle(bridge);
  assert.equal(f.uploads.length, 0); assert.equal(calls[0].sessionId, 'existing-session');
  assert.match(calls[0].prompt, /Купи молока/);
  assert.equal(bridge.state.chats['42'].fileDeliveries[0].status, 'unknown');
});

test('outbox never follows symlinks or collects files outside its turn directory', async t => {
  const f = await fixture(t), outbox = path.join(f.dir, 'outbox'); await mkdir(outbox);
  await writeFile(path.join(f.dir, 'private.txt'), 'private');
  await symlink(path.join(f.dir, 'private.txt'), path.join(outbox, 'leak.txt'));
  await mkdir(path.join(outbox, 'subdir')); await writeFile(path.join(outbox, 'subdir', 'ignored.txt'), 'nested');
  await writeFile(path.join(outbox, 'result.txt'), 'result');
  const collected = await collectOutbox(outbox);
  assert.equal(collected.length, 1); assert.equal(collected[0].filename, 'result.txt');
});

test('/stop persists cancellation before an uncooperative download finishes', async t => {
  const f = await fixture(t); let release, started = false;
  const bridge = await f.start(async () => 'unexpected');
  bridge.telegram.download = async () => { started = true; return new Promise(resolve => { release = resolve; }); };
  await bridge.handleUpdate(update(1, { voice: { file_id: 'cancelled-durably' } })); await until(() => started);
  await bridge.handleUpdate(update(2, { text: '/stop' }));
  const saved = JSON.parse(await readFile(path.join(f.config.stateDir, 'state.json'), 'utf8'));
  assert.equal(saved.chats['42'].active.cancelled, true);
  // Reproduce crash recovery from the exact state after /stop, before drain cleanup.
  const recoveredDir = path.join(f.dir, 'recovery'); await mkdir(recoveredDir);
  await writeFile(path.join(recoveredDir, 'state.json'), JSON.stringify(saved));
  const recovered = new StateStore(recoveredDir); await recovered.load();
  assert.equal(recovered.state.chats['42'].queue.length, 0);
  release({ kind: 'voice', filename: 'voice.ogg', path: '/nonexistent' }); await idle(bridge);
});

test('DOCX is extracted locally to private text before the model reads it', async t => {
  const f = await fixture(t), docx = path.join(f.dir, 'fixture.docx');
  execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("word/document.xml", \'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Personal travel checklist</w:t></w:r></w:p></w:body></w:document>\'); z.close()', docx]);
  const data = await readFile(docx); f.download((_request, response) => response.end(data));
  let extracted;
  const bridge = await f.start(async input => {
    const textPath = JSON.parse(input.prompt.match(/Extracted text: ("[^"\n]+")/)[1]);
    extracted = await readFile(textPath, 'utf8');
    assert.equal((await stat(textPath)).mode & 0o777, 0o600);
    return 'Список прочитан.';
  }, { TELEGRAM_BOT_TOKEN: token });
  await bridge.handleUpdate(update(1, { document: { file_id: 'document-docx', file_name: 'checklist', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, caption: 'Разбери список' })); await idle(bridge);
  assert.match(extracted, /Personal travel checklist/);
  assert.equal(f.requests.some(item => item.url === '/transcriptions'), false);
});

test('damaged or scanned PDF gives an honest readable-format request', async t => {
  const f = await fixture(t); let calls = 0;
  f.download((_request, response) => response.end('%PDF damaged'));
  const bridge = await f.start(async () => { calls++; return 'unexpected'; });
  await bridge.handleUpdate(update(1, { document: { file_id: 'bad-pdf', file_name: 'scanned.pdf', mime_type: 'application/pdf' } })); await idle(bridge);
  assert.equal(calls, 0);
  assert.ok(f.sent.some(text => text.includes('photos of the relevant pages')));
});
