import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToTelegramHtml, inlineHtml, hasMarkup, escapeHtml } from '../src/markdown.mjs';
import { splitTelegram } from '../src/bridge.mjs';

test('inline markup maps to Telegram tags and escapes html', () => {
  assert.equal(inlineHtml('**bold** and *italic* and ~~gone~~'), '<b>bold</b> and <i>italic</i> and <s>gone</s>');
  assert.equal(inlineHtml('snake_case_name stays'), 'snake_case_name stays');
  assert.equal(inlineHtml('`a < b`'), '<code>a &lt; b</code>');
  assert.equal(inlineHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  assert.equal(inlineHtml('[docs](https://example.com/a?b=1&c=2)'), '<a href="https://example.com/a?b=1&amp;c=2">docs</a>');
  assert.equal(inlineHtml('unclosed `code'), 'unclosed `code');
  assert.equal(inlineHtml('2 * 3 * 4'), '2 * 3 * 4');
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
});

test('block markup: headings, lists, quotes, rules, tables and code fences', () => {
  assert.equal(markdownToTelegramHtml('# Title'), '<b>Title</b>');
  assert.equal(markdownToTelegramHtml('- one\n  - two\n1. first'), '• one\n  • two\n1. first');
  assert.equal(markdownToTelegramHtml('> quoted'), '<blockquote>quoted</blockquote>');
  assert.equal(markdownToTelegramHtml('***'), '──────────');
  assert.equal(markdownToTelegramHtml('| a | b |\n|---|---|\n| 1 | 2 |'), 'a · b\n1 · 2');
  assert.equal(markdownToTelegramHtml('```js\nconst a = "<b>";\n```'), '<pre>\nconst a = &quot;&lt;b&gt;&quot;;\n</pre>');
});

test('unbalanced chunk output stays valid html and plain text is untouched', () => {
  assert.equal(markdownToTelegramHtml('```\nunfinished'), '<pre>\nunfinished\n</pre>');
  assert.equal(markdownToTelegramHtml('**bold cut'), '**bold cut');
  assert.equal(hasMarkup(markdownToTelegramHtml('just words')), false);
  assert.equal(hasMarkup(markdownToTelegramHtml('**bold**')), true);
  const text = `${'a'.repeat(3990)}**bold**`;
  for (const chunk of splitTelegram(text)) assert.doesNotThrow(() => markdownToTelegramHtml(chunk));
});