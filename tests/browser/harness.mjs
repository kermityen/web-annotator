// Real-browser test suite for the Web Annotator extension.
// Drives Chrome for Testing over the DevTools Protocol with TRUSTED input events.
//
// Usage: node tests/browser/harness.mjs <unpackedExtensionDir> [testNameFilter]
// Needs Chrome for Testing (Playwright's cached copy works). Override with CHROME=/path/to/binary.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || '/Users/kermityen/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const EXT = resolve(process.argv[2] || '');
const FILTER = process.argv[3] || '';
const PORT = 8765;
const SECURE = `http://127.0.0.1:${PORT}`;      // 127.0.0.1 is a secure context
const INSECURE = `http://insecure.test:${PORT}`; // mapped to 127.0.0.1, NOT a secure context
const PAGE = '/article.html';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── static server ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  try {
    const strict = p === '/csp.html'; // article.html served under a strict Content-Security-Policy
    const body = readFileSync(join(HERE, 'site', strict || p === '/' ? 'article.html' : p));
    const headers = { 'content-type': p.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8' };
    if (strict) headers['content-security-policy'] = "default-src 'self'; style-src 'self'; script-src 'self'";
    res.writeHead(200, headers);
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

// ── launch chrome ───────────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'wa-profile-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForTypicallySecureUsers',
  '--host-resolver-rules=MAP insecure.test 127.0.0.1',
  '--window-size=1280,900',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const wsUrl = await new Promise((resolveUrl, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('chrome did not start')), 20000);
  chrome.stderr.on('data', d => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) { clearTimeout(t); resolveUrl(m[1]); }
  });
});

// ── CDP client ──────────────────────────────────────────────────────────────
class Client {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Set();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) rej(new Error(`${m.error.message} ${m.error.data || ''}`)); else res(m.result);
      } else if (m.method) {
        for (const l of this.listeners) l(m);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const cdp = new Client(ws);

// Auto-accept confirm() dialogs in every session.
cdp.on(m => {
  if (m.method === 'Page.javascriptDialogOpening') {
    cdp.send('Page.handleJavaScriptDialog', { accept: true }, m.sessionId).catch(() => {});
  }
});

function attrs(n) {
  const a = {}; const arr = n.attributes || [];
  for (let i = 0; i < arr.length; i += 2) a[arr[i]] = arr[i + 1];
  return a;
}

class Page {
  constructor(sessionId, targetId) {
    this.s = sessionId; this.targetId = targetId; this.contexts = new Map(); this.errors = [];
    cdp.on(m => {
      if (m.sessionId !== this.s) return;
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        const where = d.url || d.stackTrace?.callFrames?.[0]?.url || '';
        if (where.startsWith('chrome-extension://')) this.errors.push(`${d.exception?.description || d.text} @ ${where}:${d.lineNumber}`);
      }
      if (m.method === 'Runtime.executionContextCreated') this.contexts.set(m.params.context.id, m.params.context);
      if (m.method === 'Runtime.executionContextDestroyed') this.contexts.delete(m.params.executionContextId);
      if (m.method === 'Runtime.executionContextsCleared') this.contexts.clear();
    });
  }
  send(method, params) { return cdp.send(method, params, this.s); }

  static async create() {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const p = new Page(sessionId, targetId);
    await p.send('Page.enable');
    await p.send('Runtime.enable');
    await p.send('DOM.enable');
    await p.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return p;
  }

  async close() { await cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {}); }

  waitEvent(name, timeout = 15000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { off(); rej(new Error(`timeout waiting for ${name}`)); }, timeout);
      const off = cdp.on(m => {
        if (m.sessionId === this.s && m.method === name) { clearTimeout(t); off(); res(m.params); }
      });
    });
  }

  async goto(url) {
    const loaded = this.waitEvent('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
    await this.waitIsolated();
  }

  // Clear storage first, then load the page, so no earlier test's data gets restored.
  async fresh(url) { await this.goto(url); await this.reset(); await this.goto(url); }

  async waitIsolated(timeout = 5000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      for (const c of this.contexts.values()) {
        if (c.auxData?.type === 'isolated' && String(c.origin).startsWith('chrome-extension://')) return c;
      }
      await sleep(50);
    }
    throw new Error('content script isolated world never appeared');
  }

  async evalIn(expr, contextId) {
    const params = { expression: expr, awaitPromise: true, returnByValue: true };
    if (contextId) params.contextId = contextId;
    const r = await this.send('Runtime.evaluate', params);
    if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  evalMain(expr) { return this.evalIn(expr); }                                       // the PAGE's world
  async evalExt(expr) { return this.evalIn(expr, (await this.waitIsolated()).id); } // content-script world

  // Walk the full DOM including CLOSED shadow roots (DevTools can see them; the page cannot).
  async findNodes(pred) {
    const { root } = await this.send('DOM.getDocument', { depth: -1, pierce: true });
    const out = [];
    const walk = (n) => {
      if (pred(n)) out.push(n);
      for (const k of ['children', 'shadowRoots', 'templateContent', 'contentDocument']) {
        const v = n[k]; if (!v) continue;
        (Array.isArray(v) ? v : [v]).forEach(walk);
      }
    };
    walk(root);
    return out;
  }
  byClass(cls, not) {
    return this.findNodes(n => {
      const c = (attrs(n).class || '').split(/\s+/);
      return c.includes(cls) && !(not && c.includes(not));
    });
  }
  async toastTexts() {
    return (await this.byClass('wa-toast')).map(t => (t.children || []).map(c => c.nodeValue || '').join(''));
  }
  async hasToast(re) { return (await this.toastTexts()).some(t => re.test(t)); }

  async quads(n) {
    let quads = [];
    for (let i = 0; i < 20 && !quads.length; i++) { // freshly inserted nodes may not be laid out yet
      ({ quads } = await this.send('DOM.getContentQuads', { nodeId: n.nodeId }));
      if (!quads.length) await sleep(50);
    }
    if (!quads.length) throw new Error(`node has no layout box: <${n.nodeName} class="${attrs(n).class || ''}">`);
    return quads[0];
  }
  async clickNode(n) {
    const q = await this.quads(n);
    const x = (q[0] + q[2] + q[4] + q[6]) / 4, y = (q[1] + q[3] + q[5] + q[7]) / 4;
    await this.mouse('mousePressed', x, y);
    await this.mouse('mouseReleased', x, y);
  }
  async clickClass(cls, not) {
    const nodes = await this.byClass(cls, not);
    if (!nodes.length) return false;
    await this.clickNode(nodes[0]);
    return true;
  }
  async box(cls) {
    const nodes = await this.byClass(cls);
    if (!nodes.length) return null;
    const q = await this.quads(nodes[0]);
    return { x: Math.min(q[0], q[6]), y: Math.min(q[1], q[3]), w: Math.abs(q[2] - q[0]), h: Math.abs(q[5] - q[3]) };
  }
  mouse(type, x, y, extra = {}) {
    return this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  }

  // Real drag-select of a phrase with trusted mouse events.
  async selectPhrase(selector, phrase) {
    const r = await this.evalMain(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let tn;
      while ((tn = w.nextNode())) {
        const i = tn.data.indexOf(${JSON.stringify(phrase)});
        if (i >= 0) {
          const r = document.createRange();
          r.setStart(tn, i); r.setEnd(tn, i + ${phrase.length});
          const rs = [...r.getClientRects()];
          const a = rs[0], b = rs[rs.length - 1];
          return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
        }
      }
      return null;
    })()`);
    if (!r) throw new Error(`phrase not found: ${phrase}`);
    await this.mouse('mousePressed', r.x1, r.y1);
    for (let i = 1; i <= 5; i++) {
      await this.mouse('mouseMoved', r.x1 + (r.x2 - r.x1) * i / 5, r.y1 + (r.y2 - r.y1) * i / 5, { buttons: 1 });
    }
    await this.mouse('mouseReleased', r.x2, r.y2);
    await sleep(200);
  }

  async type(text) { await this.send('Input.insertText', { text }); }
  async typeKeys(text) { // real key events, one per character
    for (const ch of text) {
      const up = ch.toUpperCase();
      const base = { key: ch, code: 'Key' + up, windowsVirtualKeyCode: up.charCodeAt(0), nativeVirtualKeyCode: up.charCodeAt(0) };
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, ...base });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }
  }
  async key(key, modifiers = 0) {
    const code = key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0;
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers });
  }

  markCount() { return this.evalMain(`document.querySelectorAll('.wa-highlight').length`); }
  async stored(origin, path = PAGE) {
    const key = JSON.stringify(origin + path);
    return this.evalExt(`chrome.storage.local.get(${key}).then(r => r[${key}] || null)`);
  }
  async reset() { await this.evalExt(`chrome.storage.local.clear().then(() => true)`); }
  async seed(origin, anns, path = PAGE) {
    const key = origin + path;
    const rec = { url: key, title: 'Test Article', annotations: anns, lastVisited: 1 };
    await this.evalExt(`chrome.storage.local.set({ ${JSON.stringify(key)}: ${JSON.stringify(rec)} }).then(() => true)`);
  }
  async waitFor(fn, timeout = 5000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await fn()) return true; await sleep(100); }
    return false;
  }
}

const ann = (id, text, comment = '') => ({ id, text, comment, createdAt: Date.now(), startOffset: 0, endOffset: 0, parentSelector: 'p' });

// ── tests ───────────────────────────────────────────────────────────────────
const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail }); }

const tests = {
  async T1_highlight_works_on_http_page(p) {
    await p.fresh(INSECURE + PAGE);
    const secure = await p.evalMain('isSecureContext');
    await p.selectPhrase('#p1', 'quick brown fox');
    const pop = (await p.byClass('wa-sel-popover')).length;
    await p.clickClass('wa-sel-hl-btn', 'wa-sel-note-btn');
    await sleep(500);
    const rec = await p.stored(INSECURE);
    const n = rec ? rec.annotations.length : 0;
    const marks = await p.markCount();
    check('T1 http:// 頁面可以標記', n === 1 && marks === 1, `isSecureContext=${secure} popover=${pop} stored=${n} marks=${marks}`);
  },

  async T2_disabled_site_stays_clean_on_load(p) {
    await p.fresh(SECURE + PAGE);
    await p.seed(SECURE, [ann('seed-1', 'quick brown fox')]);
    await p.evalExt(`chrome.storage.local.set({ wa_disabled_sites: ['127.0.0.1'] }).then(() => true)`);
    await p.goto(SECURE + PAGE);
    await sleep(4600); // outlast every restore retry
    const marks = await p.markCount();
    const tab = (await p.byClass('wa-panel-tab')).length;
    check('T2 關閉的網站：重新整理後不標記、不出現頁籤', marks === 0 && tab === 0, `marks=${marks} panelTab=${tab}`);
  },

  async T2b_toggle_applies_live(p) {
    await p.fresh(SECURE + PAGE);
    await p.seed(SECURE, [ann('seed-1', 'quick brown fox')]);
    await p.goto(SECURE + PAGE);
    await p.waitFor(async () => (await p.markCount()) === 1);
    await p.evalExt(`chrome.storage.local.set({ wa_disabled_sites: ['127.0.0.1'] }).then(() => true)`);
    const off = await p.waitFor(async () => (await p.markCount()) === 0 && (await p.byClass('wa-panel-tab')).length === 0, 3000);
    await p.evalExt(`chrome.storage.local.set({ wa_disabled_sites: [] }).then(() => true)`);
    const on = await p.waitFor(async () => (await p.markCount()) === 1 && (await p.byClass('wa-panel-tab')).length === 1, 3000);
    check('T2b 開關即時生效（所有分頁同步）', off && on, `turnedOff=${off} turnedBackOn=${on}`);
  },

  async T3_note_text_never_reaches_page_dom(p) {
    const SECRET = 'SECRET-NOTE-7731';
    const leak = `document.documentElement.outerHTML.includes(${JSON.stringify(SECRET)}) || document.documentElement.innerText.includes(${JSON.stringify(SECRET)}) || [...document.querySelectorAll('textarea')].some(t => t.value.includes(${JSON.stringify(SECRET)}))`;
    await p.fresh(SECURE + PAGE);
    await p.selectPhrase('#p1', 'quick brown fox');
    await p.clickClass('wa-sel-note-btn');
    await p.waitFor(async () => (await p.byClass('wa-mp-textarea')).length === 1, 2000);
    await p.type(SECRET);
    const whileTyping = await p.evalMain(leak);
    await p.clickClass('wa-mp-save');
    await sleep(500);
    const rec = await p.stored(SECURE);
    const saved = !!rec && rec.annotations.some(a => a.comment === SECRET);
    const afterSave = await p.evalMain(leak);
    await p.clickClass('wa-panel-tab');
    await sleep(600);
    const panelOpen = (await p.byClass('wa-panel')).length === 1;
    const withPanel = await p.evalMain(leak);
    check('T3 網頁讀不到筆記內容（打字中／存檔後／開側欄）', saved && panelOpen && !whileTyping && !afterSave && !withPanel,
      `saved=${saved} leakWhileTyping=${whileTyping} leakAfterSave=${afterSave} leakWithPanel=${withPanel} panelOpen=${panelOpen}`);
  },

  async T4_storage_full_is_reported_not_faked(p) {
    await p.fresh(SECURE + PAGE);
    await p.evalExt(`(async () => {
      const used = await chrome.storage.local.getBytesInUse(null);
      const len = chrome.storage.local.QUOTA_BYTES - used - '__filler'.length - 2 - 40;
      await chrome.storage.local.set({ __filler: 'x'.repeat(len) });
      return true;
    })()`);
    await p.selectPhrase('#p1', 'quick brown fox');
    await p.clickClass('wa-sel-hl-btn', 'wa-sel-note-btn');
    const toast = await p.waitFor(() => p.hasToast(/storage|full|space/i), 2000);
    const marks = await p.markCount();
    const rec = await p.stored(SECURE);
    await p.evalExt(`chrome.storage.local.remove('__filler').then(() => true)`);
    check('T4 儲存空間滿了：不假裝存好，要告訴使用者', marks === 0 && !rec && toast, `marksLeftOnPage=${marks} stored=${!!rec} toastShown=${toast}`);
  },

  async T5_no_highlighting_inside_editable_text(p) {
    await p.fresh(SECURE + PAGE);
    const before = await p.evalMain(`document.getElementById('editor').innerHTML`);
    await p.selectPhrase('#editor', 'Editable draft text');
    const pop = (await p.byClass('wa-sel-popover')).length;
    const after = await p.evalMain(`document.getElementById('editor').innerHTML`);
    check('T5 在可編輯區（草稿）選字不跳出標記按鈕', pop === 0 && before === after, `popoverShown=${pop} editorChanged=${before !== after}`);
  },

  async T6_restore_never_touches_style_or_textarea(p) {
    await p.fresh(SECURE + PAGE);
    await p.seed(SECURE, [ann('seed-z', 'zebra-marker')]);
    await p.goto(SECURE + PAGE);
    await sleep(1500);
    const styleOk = await p.evalMain(`(() => { const s = document.querySelector('body style'); return s.children.length === 0 && s.textContent.includes('zebra-marker'); })()`);
    const taOk = await p.evalMain(`document.getElementById('ta').value === 'zebra-marker default text' && document.getElementById('ta').children.length === 0`);
    const inP4 = await p.evalMain(`!!document.querySelector('#p4 .wa-highlight')`);
    check('T6 還原時不動 <style> 和 <textarea>，標在正確段落', styleOk && taOk && inP4, `styleIntact=${styleOk} textareaIntact=${taOk} landedInP4=${inP4}`);
  },

  async T7_page_script_cannot_drive_the_extension(p) {
    await p.fresh(SECURE + PAGE);
    await p.seed(SECURE, [ann('seed-1', 'quick brown fox')]);
    await p.goto(SECURE + PAGE);
    await p.waitFor(async () => (await p.markCount()) === 1);
    await p.evalMain(`document.querySelector('.wa-highlight').click()`); // synthetic, untrusted
    await sleep(300);
    const toolbar = (await p.byClass('wa-hover-toolbar')).length;
    await p.evalMain(`(() => { const b = document.querySelector('.wa-ht-unhighlight'); if (b) b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
    await sleep(400);
    const rec = await p.stored(SECURE);
    const n = rec ? rec.annotations.length : 0;
    check('T7 網頁的程式不能假裝點擊來刪你的標記', toolbar === 0 && n === 1, `toolbarOpenedBySyntheticClick=${toolbar} annotationsLeft=${n}`);
  },

  async T8_ctrl_enter_saves_note(p) {
    await p.fresh(SECURE + PAGE);
    await p.selectPhrase('#p1', 'quick brown fox');
    await p.clickClass('wa-sel-note-btn');
    await p.waitFor(async () => (await p.byClass('wa-mp-textarea')).length === 1, 2000);
    await p.type('ctrl-enter-note');
    await p.key('Enter', 2); // Ctrl
    await sleep(500);
    const rec = await p.stored(SECURE);
    const saved = !!rec && rec.annotations.some(a => a.comment === 'ctrl-enter-note');
    const closed = (await p.byClass('wa-mark-popover')).length === 0;
    check('T8 Ctrl+Enter 可以存筆記', saved && closed, `saved=${saved} popoverClosed=${closed}`);
  },

  async T9_core_flow_and_no_orphan_record(p) {
    await p.fresh(SECURE + PAGE);
    await p.selectPhrase('#p1', 'quick brown fox');
    await p.clickClass('wa-sel-hl-btn', 'wa-sel-note-btn');
    await sleep(500);
    const made = (await p.markCount()) === 1 && (await p.stored(SECURE))?.annotations.length === 1;
    await p.goto(SECURE + PAGE);
    const restored = await p.waitFor(async () => (await p.markCount()) === 1);
    await p.clickClass('wa-highlight');
    await sleep(300);
    const toolbar = (await p.byClass('wa-hover-toolbar')).length === 1;
    await p.clickClass('wa-ht-unhighlight');
    await sleep(500);
    const gone = (await p.markCount()) === 0;
    const rec = await p.stored(SECURE);
    check('T9 基本流程：標記→重新整理還原→取消標記', made && restored && toolbar && gone,
      `created=${made} restored=${restored} toolbar=${toolbar} unhighlighted=${gone}`);
    check('T9b 刪掉最後一個標記後，不留下看不見的空紀錄', rec === null, `leftoverRecord=${JSON.stringify(rec)}`);
  },

  async T10_panel_clear_all(p) {
    await p.fresh(SECURE + PAGE);
    await p.seed(SECURE, [ann('seed-1', 'quick brown fox'), ann('seed-2', 'Second sentence', 'a note')]);
    await p.goto(SECURE + PAGE);
    await p.waitFor(async () => (await p.markCount()) === 2);
    await p.clickClass('wa-panel-tab');
    await sleep(600);
    const items = (await p.byClass('wa-panel-item')).length;
    await p.clickClass('wa-panel-clear'); // confirm() auto-accepted
    await sleep(700);
    const marks = await p.markCount();
    const rec = await p.stored(SECURE);
    check('T10 側欄：列出標記、Clear All 清乾淨', items === 2 && marks === 0 && rec === null, `panelItems=${items} marksLeft=${marks} recordLeft=${!!rec}`);
  },

  async T11_copy_for_llm(p) {
    await p.fresh(SECURE + PAGE);
    await cdp.send('Browser.grantPermissions', { origin: SECURE, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await p.seed(SECURE, [ann('seed-1', 'quick brown fox', 'my note')]);
    await p.goto(SECURE + PAGE);
    await p.waitFor(async () => (await p.markCount()) === 1);
    await p.clickClass('wa-panel-tab');
    await sleep(600);
    await p.clickClass('wa-panel-copy-llm');
    await sleep(400);
    let clip = '';
    try { clip = await p.evalMain(`navigator.clipboard.readText()`); } catch (e) { clip = 'ERR ' + e.message; }
    check('T11 Copy for LLM 內容正確', clip.includes('> quick brown fox') && clip.includes('my note'), JSON.stringify(clip.slice(0, 160)));
  },

  async T12_ui_renders_on_strict_csp_page(p) {
    const PATH = '/csp.html';
    await p.fresh(SECURE + PATH);
    await p.seed(SECURE, [ann('seed-1', 'quick brown fox')], PATH);
    await p.goto(SECURE + PATH);
    await p.waitFor(async () => (await p.markCount()) === 1);
    const tab = await p.box('wa-panel-tab');
    await p.clickClass('wa-panel-tab');
    await sleep(700);
    const panel = await p.box('wa-panel');
    const ok = !!tab && Math.round(tab.w) === 30 && !!panel && Math.round(panel.w) === 360 && panel.x >= 1280 - 362;
    check('T12 網站有嚴格 CSP 時，UI 樣式照樣正常', ok, `tab=${JSON.stringify(tab)} panel=${JSON.stringify(panel)}`);
  },

  async T13_typing_a_note_does_not_trigger_page_shortcuts(p) {
    const PATH = '/shortcuts.html';
    await p.fresh(SECURE + PATH);
    await p.selectPhrase('#p1', 'quick brown fox');
    await p.clickClass('wa-sel-note-btn');
    await p.waitFor(async () => (await p.byClass('wa-mp-textarea')).length === 1, 2000);
    await p.evalMain(`window.__keys = ''`);
    await p.typeKeys('kjl');
    const pageSaw = await p.evalMain('window.__keys');
    await p.key('Enter', 2);
    await sleep(500);
    const rec = await p.stored(SECURE, PATH);
    const saved = !!rec && rec.annotations.some(a => a.comment === 'kjl');
    check('T13 打筆記時不會觸發網頁快捷鍵，網頁也看不到你打的字', pageSaw === '' && saved, `pageKeydownListenerSaw=${JSON.stringify(pageSaw)} noteSaved=${saved}`);
  },

  async T14_hostile_page_css_cannot_hide_ui(p) {
    const PATH = '/hostile.html';
    await p.fresh(SECURE + PATH);
    await p.seed(SECURE, [ann('seed-1', 'quick brown fox')], PATH);
    await p.goto(SECURE + PATH);
    await p.waitFor(async () => (await p.markCount()) === 1);
    await p.clickClass('wa-panel-tab');
    await sleep(700);
    const panel = await p.box('wa-panel');
    const btn = await p.box('wa-panel-copy-llm');
    const ok = !!panel && Math.round(panel.w) === 360 && !!btn && btn.h > 10 && btn.h < 60;
    check('T14 網頁的 CSS 無法把 UI 藏起來或弄壞', ok, `panel=${JSON.stringify(panel)} copyButton=${JSON.stringify(btn)}`);
  },

  async T15_popup_toggle_panel_button_and_clear(p) {
    await p.fresh(SECURE + PAGE);
    await p.seed(SECURE, [ann('seed-1', 'quick brown fox'), ann('seed-2', 'Second sentence', 'n')]);
    await p.goto(SECURE + PAGE);
    await p.waitFor(async () => (await p.markCount()) === 2);
    const extOrigin = String((await p.waitIsolated()).origin);
    // popup.html in a background tab, so the article stays the active tab it inspects
    const { targetId } = await cdp.send('Target.createTarget', { url: extOrigin + '/popup.html', background: true });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const errs = [];
    const off = cdp.on(m => { if (m.sessionId === sessionId && m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    const pop = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
    await sleep(800);
    const sees = await pop(`document.getElementById('page-url').textContent`);
    const count = await pop(`document.getElementById('count-all').textContent`);
    const btnBefore = await pop(`document.getElementById('panel-btn').disabled`);

    await pop(`document.getElementById('site-toggle').click(), true`);
    const offOk = await p.waitFor(async () => (await p.markCount()) === 0 && (await p.byClass('wa-panel-tab')).length === 0, 3000);
    const btnOff = await pop(`document.getElementById('panel-btn').disabled`);

    await pop(`document.getElementById('site-toggle').click(), true`);
    const onOk = await p.waitFor(async () => (await p.markCount()) === 2 && (await p.byClass('wa-panel-tab')).length === 1, 3000);
    const btnOn = await pop(`document.getElementById('panel-btn').disabled`);

    await pop(`document.getElementById('clear-btn').click(), true`); // confirm() auto-accepted
    const cleared = await p.waitFor(async () => (await p.markCount()) === 0, 3000);
    const rec = await p.stored(SECURE);
    off();
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    check('T15 popup：開關同步到頁面、Panel 按鈕跟著停用、Clear All 有效',
      sees === SECURE + PAGE && count === '2' && btnBefore === false && offOk && btnOff === true && onOk && btnOn === false && cleared && rec === null && errs.length === 0,
      `popupSees=${sees} count=${count} panelBtnDisabled(before/off/on)=${btnBefore}/${btnOff}/${btnOn} pageOff=${offOk} pageOn=${onOk} cleared=${cleared} recordLeft=${!!rec} popupErrors=${JSON.stringify(errs)}`);
  },

  async T16_svg_file_opened_in_a_tab(p) {
    await p.goto(SECURE + '/image.svg');
    await sleep(1500);
    const injected = await p.evalMain(`document.querySelectorAll('div, mark').length`);
    check('T16 直接打開 SVG 檔：不丟錯、不塞東西', injected === 0, `extensionElementsInDoc=${injected} (uncaught errors are reported separately)`);
  },

  // Must run LAST: reloads the extension, orphaning the content script in the open tab.
  async T99_extension_updated_while_page_open(p) {
    await p.fresh(SECURE + PAGE);
    // Let the content script finish starting up (it reads the per-site setting first).
    await p.waitFor(async () => (await p.byClass('wa-panel-tab')).length === 1);
    const extOrigin = String((await p.waitIsolated()).origin);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find(t => t.type === 'service_worker' && t.url.startsWith(extOrigin + '/'));
    if (!sw) { check('T99 擴充功能更新後：存不了要講，不能假裝存好', false, 'no service worker target for our extension'); return; }
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    await cdp.send('Runtime.evaluate', { expression: 'chrome.runtime.reload()' }, sessionId).catch(() => {});
    await sleep(1500);
    await p.selectPhrase('#p1', 'quick brown fox');
    const popoverShown = (await p.byClass('wa-sel-popover')).length;
    await p.clickClass('wa-sel-hl-btn', 'wa-sel-note-btn');
    const toast = await p.waitFor(() => p.hasToast(/reload/i), 2000);
    const marks = await p.markCount();
    check('T99 擴充功能更新後：存不了要講，不能假裝存好', marks === 0 && toast,
      `marksLeftOnPage=${marks} toastShown=${toast} popoverShown=${popoverShown} toasts=${JSON.stringify(await p.toastTexts())}`);
  },
};

// ── run ─────────────────────────────────────────────────────────────────────
let exitCode = 0;
try {
  for (const [name, fn] of Object.entries(tests)) {
    if (FILTER && !name.includes(FILTER)) continue;
    const p = await Page.create();
    try { await fn(p); }
    catch (e) { check(name, false, 'CRASH: ' + e.message); }
    finally {
      if (p.errors.length) check(`${name}: 擴充功能沒有丟出未處理的錯誤`, false, p.errors.join(' | '));
      await p.close();
    }
  }
} finally {
  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    console.log(`        ${r.detail}`);
    if (!r.ok) exitCode = 1;
  }
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`);
  ws.close(); chrome.kill('SIGKILL'); server.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(exitCode);
}
