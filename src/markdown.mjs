#!/usr/bin/env node
/**
 * Minimal Markdown -> Telegram HTML renderer.
 * Telegram supports only b, strong, i, em, u, s, a, code, pre, blockquote, tg-spoiler.
 * Everything else (headings, lists, tables) is expressed with those tags and characters.
 * Output is always balanced, so a chunk cut in the middle of code or bold stays valid.
 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const escapeHtml = value => String(value).replace(/[&<>"]/g, char => ESCAPES[char]);

const BOLD = [/\*\*([\s\S]+?)\*\*/g, /__([\s\S]+?)__/g];
const STRIKE = /~~([\s\S]+?)~~/g;
const ITALIC = [/(^|[\s(«"'])\*(\S(?:[^*\n]*?\S)?)\*(?=$|[\s.,;:!?)»"'])/g,
  /(^|[\s(«"'])_(\S(?:[^_\n]*?\S)?)_(?=$|[\s.,;:!?)»"'])/g];
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|?\s*$/;
const TABLE_MARKERS = /^[|\s:-]+$/;

/** Inline markup for one line of already-line-broken text. Code spans are protected first. */
export function inlineHtml(line) {
  const split = String(line).split('`');
  const balanced = split.length % 2 === 1;
  const parts = balanced ? split : [String(line)];
  let html = '';
  for (let index = 0; index < parts.length; index++) {
    const raw = parts[index];
    if (balanced && index % 2 === 1) {
      html += `<code>${escapeHtml(raw)}</code>`;
      continue;
    }
    let text = escapeHtml(raw);
    text = text.replace(LINK, (_match, label, url) => `<a href="${url}">${label}</a>`);
    for (const pattern of BOLD) text = text.replace(pattern, '<b>$1</b>');
    text = text.replace(STRIKE, '<s>$1</s>');
    for (const pattern of ITALIC) text = text.replace(pattern, '$1<i>$2</i>');
    html += text;
  }
  return html;
}

function tableRow(line) {
  const cells = TABLE_ROW.exec(line)[1].split('|').map(cell => cell.trim()).filter(Boolean);
  return cells.length ? cells.map(cell => inlineHtml(cell)).join(' · ') : '';
}

/** Render markdown for Telegram HTML parse mode. Text without markup is returned unchanged. */
export function markdownToTelegramHtml(source) {
  const lines = String(source).split('\n');
  const out = [];
  let fence = null;
  for (const line of lines) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (fence) { out.push('</pre>'); fence = null; }
      else { fence = fenceMatch[1][0]; out.push('<pre>'); }
      continue;
    }
    if (fence) { out.push(escapeHtml(line)); continue; }
    const heading = HEADING.exec(line);
    if (heading && heading[1]) { out.push(`<b>${inlineHtml(heading[1])}</b>`); continue; }
    if (RULE.test(line)) { out.push('──────────'); continue; }
    if (TABLE_SEPARATOR.test(line) && TABLE_MARKERS.test(line)) continue;
    if (TABLE_ROW.test(line)) { out.push(tableRow(line)); continue; }
    const bullet = BULLET.exec(line);
    if (bullet && bullet[2]) { out.push(`${bullet[1]}• ${inlineHtml(bullet[2])}`); continue; }
    const ordered = ORDERED.exec(line);
    if (ordered && ordered[3]) { out.push(`${ordered[1]}${ordered[2]}. ${inlineHtml(ordered[3])}`); continue; }
    const quote = QUOTE.exec(line);
    if (quote) { out.push(quote[1] ? `<blockquote>${inlineHtml(quote[1])}</blockquote>` : ''); continue; }
    out.push(inlineHtml(line));
  }
  if (fence) out.push('</pre>');
  return out.join('\n');
}

/** True when rendering produced real markup, so parse mode can be requested. */
export const hasMarkup = html => /<(?:b|i|s|u|code|pre|blockquote|a)\b/.test(html);