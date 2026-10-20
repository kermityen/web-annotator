// Unit tests for export-format.js (the text "Copy for LLM" / "Copy as Notes" produce).
// Usage: node tests/unit/export-format.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const src = readFileSync(fileURLToPath(new URL('../../export-format.js', import.meta.url)), 'utf8');
const X = new Function(src + '; return WA_EXPORT;')();

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS ', name); }
  catch (e) { failed++; console.log('FAIL ', name, '\n      ', e.message.split('\n').join('\n       ')); }
}

const page = { url: 'https://news.example/story?id=7&utm_source=x&access_token=SECRET&t=30', title: 'A Story' };
const ann = (id, text, comment = '', createdAt = 0) => ({ id, text, comment, createdAt });

test('cleanUrl keeps real params, drops trackers and credentials', () => {
  assert.equal(X.cleanUrl(page.url), 'https://news.example/story?id=7&t=30');
  assert.equal(X.cleanUrl('https://a.example/p?session_id=1&utm_medium=m'), 'https://a.example/p');
  assert.equal(X.cleanUrl('https://a.example/watch?v=abc'), 'https://a.example/watch?v=abc');
  assert.equal(X.cleanUrl('not a url'), 'not a url');
});

test('orderBy follows page order; unknown ids go last, oldest first', () => {
  const list = [ann('a', 'A', '', 1), ann('b', 'B', '', 2), ann('c', 'C', '', 3), ann('d', 'D', '', 0)];
  assert.deepEqual(X.orderBy(list, ['c', 'a']).map(a => a.id), ['c', 'a', 'd', 'b']);
  assert.deepEqual(X.orderBy(list, []).map(a => a.id), ['d', 'a', 'b', 'c']);
});

test('forLlm: every quoted line starts with ">" and notes are labelled', () => {
  const out = X.forLlm(page, [ann('a', 'first line\n\n  second   line ', 'note one\nnote two')]);
  assert.match(out, /^# Highlights from "A Story"\n/);
  assert.match(out, /\nSource: https:\/\/news\.example\/story\?id=7&t=30\n/);
  assert.ok(!out.includes('SECRET'), 'token leaked');
  assert.match(out, /\n> first line\n>\n> second line\n\nMy note: note one\nnote two\n/);
});

test('forLlm: no note line when the note is empty', () => {
  const out = X.forLlm(page, [ann('a', 'quote', '   ')]);
  assert.ok(!out.includes('My note'));
});

test('forNotes markdown: continuation lines stay inside their bullet', () => {
  const { text } = X.forNotes(page, [ann('a', 'line one\nline two', 'n1\nn2')]);
  assert.equal(text, '# A Story\nhttps://news.example/story?id=7&t=30\n\n- line one\n  line two\n  - n1\n    n2\n');
});

test('forNotes html: real list, escaped content', () => {
  const { html } = X.forNotes({ ...page, title: '<b>x</b>' }, [ann('a', 'a < b', 'n & m')]);
  assert.ok(html.startsWith('<h2>&lt;b&gt;x&lt;/b&gt;</h2>'));
  assert.ok(html.includes('<ul><li>a &lt; b<ul><li>n &amp; m</li></ul></li></ul>'));
  assert.ok(!html.includes('SECRET'));
});

test('forNotes html: multi-line text keeps a space where <br> is dropped', () => {
  const { html } = X.forNotes(page, [ann('a', 'q', 'week.\nTry')]);
  assert.ok(html.includes('<li>week.<br>\nTry</li>'));
  assert.ok(!/week\.Try/.test(html.replace(/<br>/g, '')), 'lines would run together without <br>');
});

test('empty title falls back to the hostname', () => {
  assert.match(X.forLlm({ url: 'https://h.example/x', title: '' }, []), /^# Highlights from "h\.example"/);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
