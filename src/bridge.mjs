#!/usr/bin/env node
import { readFile, writeFile, rename, mkdir, readdir, open, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runPi, redact } from './pi.mjs';
import { startScheduler } from './scheduler.mjs';

const HELP = 'Команды:\n/face — список лиц\n/face имя — выбрать лицо\n/new — новая сессия текущего лица\n/status — состояние\n/stop — остановить ответ и очистить очередь\n/help — эта справка\n\nОтправьте текст, чтобы начать разговор.';
const expand = value => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : path.resolve(value);

export function normalizeConfig(raw, env = process.env) {
  if (!raw || typeof raw !== 'object') throw new Error('Config must be a JSON object');
  if (!raw.telegram?.allowedUserIds?.length) throw new Error('telegram.allowedUserIds must not be empty');
  const allowedUserIds = raw.telegram.allowedUserIds.map(String);
  if (allowedUserIds.some(id => !/^\d+$/.test(id))) throw new Error('Invalid Telegram user ID');
  const tokenEnv = raw.telegram.tokenEnv ?? 'TELEGRAM_BOT_TOKEN';
  if (!env[tokenEnv]) throw new Error(`Set ${tokenEnv} before starting`);
  if (!raw.vaultRoot) throw new Error('vaultRoot is required');
  const vaultRoot = expand(raw.vaultRoot);
  const config = { ...raw, vaultRoot,
    telegram: { pollTimeoutSeconds: 25, ...raw.telegram, tokenEnv, allowedUserIds },
    pi: { timeoutMs: 600000, ...raw.pi },
    stateDir: expand(raw.stateDir ?? '~/.local/state/pi-agent-kit'),
    facesDir: expand(raw.facesDir ?? path.join(vaultRoot, 'faces')),
    memoryFile: raw.memoryFile === null ? null : expand(raw.memoryFile ?? path.join(vaultRoot, 'memory.md')),
    defaultFace: raw.defaultFace ?? 'assistant',
  };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(config.defaultFace)) throw new Error('Invalid defaultFace');
  if (!Number.isFinite(config.pi.timeoutMs) || config.pi.timeoutMs < 100) throw new Error('Invalid pi.timeoutMs');
  if (config.pi.provider && !config.pi.model) throw new Error('pi.provider requires pi.model');
  if (config.pi.args && (!Array.isArray(config.pi.args) || config.pi.args.some(arg => typeof arg !== 'string'))) throw new Error('pi.args must contain strings');
  if (!Number.isInteger(config.telegram.pollTimeoutSeconds) || config.telegram.pollTimeoutSeconds < 0 || config.telegram.pollTimeoutSeconds > 50) throw new Error('Invalid pollTimeoutSeconds');
  config.telegram.allowedChatIds = (config.telegram.allowedChatIds ?? []).map(String);
  if (config.telegram.allowedChatIds.some(id => !/^-?\d+$/.test(id))) throw new Error('Invalid Telegram chat ID');
  return config;
}

/** Telegram counts UTF-16 units; never split a surrogate pair. Plain text avoids markup injection. */
export function splitTelegram(text, limit = 4000) {
  if (limit < 2) throw new Error('Chunk limit must be at least 2');
  const chunks = [];
  let remaining = String(text);
  while (remaining.length > limit) {
    let end = limit;
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    const newline = remaining.lastIndexOf('\n', end - 1);
    if (newline >= end / 2) end = newline + 1;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export class TelegramClient {
  constructor(config, { env = process.env, fetchImpl = fetch } = {}) {
    this.config = config;
    this.env = env;
    this.fetch = fetchImpl;
    this.token = env[config.telegram.tokenEnv];
  }
  async call(method, payload = {}, signal) {
    const timeout = AbortSignal.timeout((method === 'getUpdates' ? this.config.telegram.pollTimeoutSeconds + 15 : 30) * 1000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await this.fetch(`${this.config.telegram.apiBase ?? 'https://api.telegram.org'}/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`Telegram ${method}: network request failed`);
    }
    let body;
    try { body = await response.json(); } catch { throw new Error(`Telegram ${method}: invalid server response`); }
    if (!response.ok || !body.ok) {
      const error = new Error(`Telegram ${method}: ${redact(body.description ?? `HTTP ${response.status}`, this.env)}`);
      error.retryAfter = body.parameters?.retry_after;
      error.telegramCode = body.error_code ?? response.status;
      throw error;
    }
    return body.result;
  }
  async send(chatId, text) {
    for (const chunk of splitTelegram(text)) {
      let attempts = 0;
      while (true) {
        try { await this.call('sendMessage', { chat_id: chatId, text: chunk }); break; }
        catch (error) {
          if (!error.retryAfter || attempts++ >= 3) throw error;
          await new Promise(resolve => setTimeout(resolve, Math.min(error.retryAfter, 60) * 1000));
        }
      }
    }
  }
}

export class StateStore {
  constructor(directory) { this.directory = directory; this.file = path.join(directory, 'state.json'); this.state = { version: 1, offset: 0, chats: {}, acceptedSources: {} }; this.writes = Promise.resolve(); }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.state = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot load state: ${error.message}`); }
    if (this.state.version !== 1 || !Number.isSafeInteger(this.state.offset) || !this.state.chats || typeof this.state.chats !== 'object' || Array.isArray(this.state.chats)) throw new Error('Unsupported or invalid state file');
    this.state.acceptedSources ??= {};
    // A crash may interrupt a turn. Keep it at the front for replay in its original session.
    for (const chat of Object.values(this.state.chats)) {
      if (!Array.isArray(chat.queue) || !chat.sessions || typeof chat.face !== 'string') throw new Error('Invalid chat state');
      chat.outbox ??= [];
      if (chat.active) { chat.queue.unshift(chat.active); delete chat.active; }
    }
    await this.save();
    return this.state;
  }
  save() {
    const serialized = JSON.stringify(this.state, null, 2) + '\n';
    const write = async () => {
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, this.file);
    };
    this.writes = this.writes.then(write);
    return this.writes;
  }
}

export class Bridge {
  constructor(config, { telegram, store, runner = runPi, env = process.env, log = message => console.error(message) } = {}) {
    this.config = config; this.env = env;
    this.telegram = telegram ?? new TelegramClient(config, { env });
    this.store = store ?? new StateStore(config.stateDir);
    this.runner = runner; this.log = log;
    this.running = new Map(); this.jobs = new Map(); this.closed = false;
  }
  async init() {
    this.state = await this.store.load();
    await access(path.join(this.config.facesDir, this.config.defaultFace, 'AGENTS.md'));
    if (this.config.memoryFile) await access(this.config.memoryFile);
    for (const id of Object.keys(this.state.chats)) this.kick(id);
  }
  async faces() {
    const entries = await readdir(this.config.facesDir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry.name)) continue;
      try { await access(path.join(this.config.facesDir, entry.name, 'AGENTS.md')); result.push(entry.name); } catch {}
    }
    return result.sort();
  }
  chat(id) {
    return this.state.chats[id] ??= { face: this.config.defaultFace, sessions: {}, queue: [], outbox: [] };
  }
  session(chat, face) { return chat.sessions[face] ??= randomUUID(); }
  async enqueue({ chatId, prompt, face, sourceId }) {
    const id = String(chatId);
    if (!this.config.telegram.allowedUserIds.includes(id) && !this.config.telegram.allowedChatIds.includes(id)) throw new Error('Job chat is not allowed');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Job prompt is empty');
    if (sourceId && Object.hasOwn(this.state.acceptedSources, sourceId)) return false;
    const chat = this.chat(id), selectedFace = face ?? chat.face;
    if (!(await this.faces()).includes(selectedFace)) throw new Error('Unknown job face');
    if (sourceId && Object.hasOwn(this.state.acceptedSources, sourceId)) return false;
    if (chat.queue.length >= 20) throw new Error('Chat queue is full');
    chat.queue.push({ prompt, face: selectedFace, sessionId: this.session(chat, selectedFace), sourceId,
      caller: { chatId: id, isOwner: true, source: 'scheduled-owner-job' } });
    if (sourceId) this.state.acceptedSources[sourceId] = new Date().toISOString();
    await this.store.save();
    this.kick(id);
    return true;
  }
  async send(id, text) {
    try { await this.telegram.send(id, redact(text, this.env)); }
    catch (error) { this.log(`Could not send Telegram response: ${redact(error.message, this.env)}`); }
  }
  /** Record acceptance and offset in one atomic file before acknowledging Telegram. */
  async handleUpdate(update) {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < this.state.offset) return;
    const message = update.message;
    this.state.offset = update.update_id + 1;
    const isOwner = this.config.telegram.allowedUserIds.includes(String(message?.from?.id));
    const isGroup = message?.chat?.type === 'group' || message?.chat?.type === 'supergroup';
    const allowedGroup = isGroup && this.config.telegram.allowedChatIds.includes(String(message.chat.id));
    if (!message || message.from?.is_bot || (isGroup ? !allowedGroup : !isOwner)) {
      await this.store.save(); return;
    }
    const id = String(message.chat.id), chat = this.chat(id);
    if (typeof message.text !== 'string') {
      if (isGroup && !(this.bot?.id && message.reply_to_message?.from?.id === this.bot.id)) { await this.store.save(); return; }
      await this.store.save(); await this.send(id, 'Пока поддерживаются только текстовые сообщения.'); return;
    }
    let text = message.text.trim();
    const addressedCommand = /^\/\w+@([\w_]+)/.exec(text);
    if (addressedCommand && addressedCommand[1].toLowerCase() !== this.bot?.username?.toLowerCase()) { await this.store.save(); return; }
    if (isGroup) {
      const username = this.bot?.username;
      const mention = username ? new RegExp(`@${username}\\b`, 'ig') : null;
      const isReply = this.bot?.id && message.reply_to_message?.from?.id === this.bot.id;
      if (!isReply && !(mention && mention.test(text))) { await this.store.save(); return; }
      // Keep /command@bot parsing intact; remove standalone conversational mentions.
      if (!addressedCommand && mention) text = text.replace(mention, '').trim();
    }
    const match = /^\/(\w+)(?:@[\w_]+)?(?:\s+([\s\S]*))?$/.exec(text);
    let reply;
    if (match) {
      const [, command, rawArgument = ''] = match, argument = rawArgument.trim();
      if (!isOwner && !['start', 'help'].includes(command)) { await this.store.save(); await this.send(id, 'Эта команда доступна только владельцу.'); return; }
      if (command === 'start' || command === 'help') reply = HELP;
      else if (command === 'status') reply = `Лицо: ${chat.face}\nСессия: ${this.session(chat, chat.face)}\n${this.running.has(id) ? 'Готовлю ответ' : 'Свободен'}\nВ очереди: ${chat.queue.length}\nМодель: ${this.config.pi.model ?? 'настройки Pi'}`;
      else if (command === 'face') {
        const faces = await this.faces();
        if (!argument) reply = `Лицо: ${chat.face}\nДоступны: ${faces.join(', ')}\nВыбор: /face имя`;
        else if (!faces.includes(argument)) reply = `Неизвестное лицо. Доступны: ${faces.join(', ')}`;
        else { chat.face = argument; this.session(chat, argument); reply = `Выбрано лицо: ${argument}`; }
      } else if (command === 'new') {
        chat.sessions[chat.face] = randomUUID(); reply = `Новая сессия: ${chat.face}.`;
      } else if (command === 'stop') {
        chat.queue.length = 0;
        chat.outbox.length = 0;
        this.running.get(id)?.abort();
        reply = this.running.has(id) ? 'Останавливаю ответ. Очередь очищена.' : 'Очередь очищена.';
      } else reply = 'Неизвестная команда. /help';
    } else if (text) {
      if (chat.queue.length >= 20) reply = 'В очереди уже 20 сообщений. Дождитесь ответа или используйте /stop.';
      else {
        chat.queue.push({ updateId: update.update_id, prompt: text, face: chat.face, sessionId: this.session(chat, chat.face),
          caller: { chatId: id, senderId: String(message.from.id), isOwner, chatType: message.chat.type } });
        if (this.jobs.has(id) || chat.active) reply = `Сообщение в очереди: ${chat.queue.length}.`;
      }
    }
    await this.store.save();
    if (reply) await this.send(id, reply);
    this.kick(id);
  }
  kick(id) {
    if (this.closed || this.jobs.has(id) || !(this.chat(id).queue.length || this.chat(id).outbox.length)) return;
    // Defer until job registration so immediate failures cannot leave a stale job.
    let failed = false;
    const job = Promise.resolve().then(() => this.drain(id)).catch(error => {
      failed = true;
      this.log(`Chat job failed: ${redact(error.message, this.env)}`);
    }).finally(() => {
      this.jobs.delete(id);
      if (!this.closed) {
        if (failed) { const retry = setTimeout(() => this.kick(id), 5000); retry.unref(); }
        else this.kick(id);
      }
    });
    this.jobs.set(id, job);
  }
  async drain(id) {
    const chat = this.chat(id);
    const flush = async () => {
      while (!this.closed && chat.outbox.length) {
        const next = chat.outbox[0];
        await this.telegram.send(id, next);
        // /stop may have cleared the outbox during the HTTP request.
        if (chat.outbox[0] === next) chat.outbox.shift();
        await this.store.save();
      }
    };
    await flush();
    while (!this.closed && chat.queue.length) {
      const turn = chat.queue.shift(); chat.active = turn;
      const controller = new AbortController(); this.running.set(id, controller);
      let completed = false;
      await this.store.save();
      const typing = setInterval(() => {
        void this.telegram.call?.('sendChatAction', { chat_id: id, action: 'typing' }).catch(() => {});
      }, 4000);
      typing.unref();
      try {
        const response = await this.runner({ config: this.config, ...turn, signal: controller.signal,
          env: { ...this.env, PI_KIT_STATE_DIR: this.config.stateDir, PI_KIT_CHAT_ID: id } });
        // /stop wins even if Pi finishes at the same moment.
        if (!controller.signal.aborted) {
          completed = true;
          chat.outbox.push(...splitTelegram(redact(response, this.env)));
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          completed = true;
          chat.outbox.push(...splitTelegram(`Ошибка: ${redact(error.message, this.env)}`));
        }
      } finally {
        clearInterval(typing);
        this.running.delete(id);
        if (this.closed && !completed) chat.queue.unshift(turn);
        delete chat.active;
        await this.store.save();
      }
      await flush();
    }
  }
  async poll(signal) {
    let failures = 0;
    while (!signal.aborted && !this.closed) {
      try {
        const updates = await this.telegram.call('getUpdates', {
          offset: this.state.offset, timeout: this.config.telegram.pollTimeoutSeconds, allowed_updates: ['message'],
        }, signal);
        failures = 0;
        for (const update of updates) {
          if (signal.aborted || this.closed) break;
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (signal.aborted || this.closed) break;
        this.log(`Polling error: ${redact(error.message, this.env)}`);
        if ([401, 409].includes(error.telegramCode)) throw error;
        const delay = Math.min(30000, Math.max((error.retryAfter ?? 0) * 1000, 1000 * 2 ** Math.min(failures++, 5)));
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, delay); signal.addEventListener('abort', done, { once: true });
        });
      }
    }
  }
  async shutdown() {
    this.closed = true;
    for (const controller of this.running.values()) controller.abort();
    await Promise.allSettled(this.jobs.values());
    await this.store.save();
  }
}

async function acquireLock(stateDir) {
  const lockPath = path.join(stateDir, 'bridge.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(String(process.pid)); await handle.close();
      return () => unlink(lockPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(lockPath, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid bridge lock; inspect bridge.lock before removing it');
      try { process.kill(pid, 0); } catch (probe) {
        if (probe.code === 'ESRCH') { await unlink(lockPath); continue; }
      }
      throw new Error('Another bridge is using this state directory');
    }
  }
  throw new Error('Could not acquire bridge lock');
}

export async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  if (argv.length !== 2 || argv[0] !== '--config') throw new Error('Usage: node src/bridge.mjs --config /absolute/config.json');
  const config = normalizeConfig(JSON.parse(await readFile(expand(argv[1]), 'utf8')), env);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const release = await acquireLock(config.stateDir);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const bridge = new Bridge(config, { env });
  let initialized = false, stopScheduler;
  try {
    await bridge.init();
    initialized = true;
    const me = await bridge.telegram.call('getMe');
    bridge.bot = me;
    stopScheduler = startScheduler(bridge, config);
    console.error(`Bridge ready: @${me.username ?? me.id}; face=${config.defaultFace}`);
    await bridge.poll(controller.signal);
  } finally {
    controller.abort(); stopScheduler?.();
    if (initialized) await bridge.shutdown();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
}
