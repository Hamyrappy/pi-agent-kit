import { root } from './common.mjs';
import { begin, check, requestChange, status } from '../src/self-change.mjs';
const [command = 'status', ...args] = process.argv.slice(2);
try {
  const index = args.indexOf('--chat-id');
  const chatId = index === -1 ? process.env.PI_KIT_CHAT_ID ? Number(process.env.PI_KIT_CHAT_ID) : undefined : Number(args[index + 1]);
  if (chatId !== undefined && (!Number.isSafeInteger(chatId) || chatId === 0)) throw new Error('--chat-id must be a nonzero numeric ID.');
  let result;
  if (command === 'begin') result = await begin(root, { chatId });
  else if (command === 'check') result = await check(root);
  else if (['apply', 'restart', 'rollback'].includes(command)) result = await requestChange(root, { action: command, chatId });
  else if (command === 'status') result = await status(root);
  else throw new Error('Commands: begin | check | apply | restart | rollback | status [--chat-id ID]');
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
