// Generates Chrome Web Store screenshots (1280x800 PNG) from the REAL extension running in
// Chrome for Testing: every UI element in the shots is the actual extension, not a mockup.
//
// Usage: node store-assets/make-screenshots.mjs <unpackedExtensionDir>
// Output: store-assets/screenshots/*.png

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || '/Users/kermityen/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const EXT = resolve(process.argv[2] || '');
const OUT = join(HERE, 'screenshots');
const RAW = mkdtempSync(join(tmpdir(), 'wa-raw-'));
mkdirSync(OUT, { recursive: true });

const HOST = 'fieldnotes.example'; // reserved demo domain, mapped to localhost
const ORIGIN = `http://${HOST}`;
const ARTICLE = '/sourdough-schedule';
const URL_TEXT = `${HOST}${ARTICLE}`;
const W = 1120, VIEW_H = 620; // content area of the browser frame in the final 1280x800 image
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ARTICLE_HTML = readFileSync(join(HERE, 'demo', 'article.html')).toString('base64');

// ── chrome + CDP ────────────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'wa-shots-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForTypicallySecureUsers',
  `--host-resolver-rules=MAP ${HOST} 127.0.0.1`, '--hide-scrollbars', '--force-color-profile=srgb',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res, rej) => {
  let buf = ''; const t = setTimeout(() => rej(new Error('chrome did not start')), 20000);
  chrome.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); res(m[1]); } });
});
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 0; const pending = new Map(); const listeners = new Set();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  else for (const l of listeners) l(m);
};
const send = (method, params = {}, sessionId) => {
  const id = ++nextId; ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};

function attrs(n) { const a = {}; const arr = n.attributes || []; for (let i = 0; i < arr.length; i += 2) a[arr[i]] = arr[i + 1]; return a; }

async function openTab(url, width, height, background = false) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', background });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  const contexts = new Map();
  listeners.add(m => {
    if (m.sessionId !== s) return;
    if (m.method === 'Runtime.executionContextCreated') contexts.set(m.params.context.id, m.params.context);
    if (m.method === 'Runtime.executionContextsCleared') contexts.clear();
  });
  const tab = {
    s, targetId,
    send: (method, params) => send(method, params, s),
    async evalIn(expr, contextId) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, s);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async ext(expr) {
      for (let i = 0; i < 100; i++) {
        const c = [...contexts.values()].find(c => c.auxData?.type === 'isolated' && String(c.origin).startsWith('chrome-extension://'));
        if (c) return this.evalIn(expr, c.id);
        await sleep(50);
      }
      throw new Error('content script not found');
    },
    async goto(u) {
      const loaded = new Promise(r => { const l = (m) => { if (m.sessionId === s && m.method === 'Page.loadEventFired') { listeners.delete(l); r(); } }; listeners.add(l); });
      await send('Page.navigate', { url: u }, s); await loaded;
    },
    async nodes(cls) {
      const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }, s);
      const out = []; const walk = (n) => { if ((attrs(n).class || '').split(/\s+/).includes(cls)) out.push(n); for (const k of ['children', 'shadowRoots']) (n[k] || []).forEach(walk); };
      walk(root); return out;
    },
    async click(cls, index = 0) {
      const n = (await this.nodes(cls))[index];
      if (!n) throw new Error('no element .' + cls);
      const { quads } = await send('DOM.getContentQuads', { nodeId: n.nodeId }, s);
      const q = quads[0]; const x = (q[0] + q[2] + q[4] + q[6]) / 4, y = (q[1] + q[3] + q[5] + q[7]) / 4;
      await this.mouse('mouseMoved', x, y);
      await this.mouse('mousePressed', x, y); await this.mouse('mouseReleased', x, y);
    },
    mouse(type, x, y, extra = {}) { return send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra }, s); },
    async select(phrase) {
      const r = await this.evalIn(`(() => {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let tn;
        while ((tn = w.nextNode())) { const i = tn.data.indexOf(${JSON.stringify(phrase)}); if (i >= 0) {
          const r = document.createRange(); r.setStart(tn, i); r.setEnd(tn, i + ${phrase.length});
          const rs = [...r.getClientRects()]; const a = rs[0], b = rs[rs.length - 1];
          return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 }; } }
        return null; })()`);
      if (!r) throw new Error('phrase not found: ' + phrase);
      await this.mouse('mousePressed', r.x1, r.y1);
      for (let i = 1; i <= 8; i++) await this.mouse('mouseMoved', r.x1 + (r.x2 - r.x1) * i / 8, r.y1 + (r.y2 - r.y1) * i / 8, { buttons: 1 });
      await this.mouse('mouseReleased', r.x2, r.y2);
      await sleep(300);
    },
    async capture(file, clip) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, s);
      writeFileSync(file, Buffer.from(data, 'base64'));
    },
    close: () => send('Target.closeTarget', { targetId }),
  };
  listeners.add(m => {
    if (m.sessionId !== s || m.method !== 'Fetch.requestPaused') return;
    const ok = new URL(m.params.request.url).pathname === ARTICLE;
    send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: ok ? 200 : 404,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: ok ? ARTICLE_HTML : '' }, s).catch(() => {});
  });
  await tab.send('Fetch.enable', { patterns: [{ urlPattern: `${ORIGIN}/*` }] });
  await tab.send('Page.enable'); await tab.send('Runtime.enable'); await tab.send('DOM.enable');
  await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await tab.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await tab.goto(url);
  return tab;
}

// ── demo data ───────────────────────────────────────────────────────────────
const KEY = ORIGIN + ARTICLE;
const HL = [
  { id: 'h1', text: 'a small ecosystem of wild yeast and lactic acid bacteria', comment: '' },
  { id: 'h2', text: 'Most problems with a starter come from inconsistency rather than from the recipe.', comment: 'This is why my loaves vary week to week.' },
  { id: 'h3', text: 'feed at the same time every day', comment: '' },
  { id: 'h4', text: 'If it collapses before you use it, it has already run out of food.', comment: 'Bake earlier, around the five hour mark.' },
].map((a, i) => ({ ...a, createdAt: Date.now() - (60 - i * 12) * 60000, startOffset: 0, endOffset: 0, parentSelector: 'p' }));

async function articleWith(highlights) {
  const tab = await openTab(ORIGIN + ARTICLE, W, VIEW_H);
  await tab.ext(`chrome.storage.local.clear().then(() => chrome.storage.local.set({ wa_disabled_sites: [''], ${JSON.stringify(KEY)}: ${JSON.stringify({ url: KEY, title: 'Why your sourdough starter needs a schedule', annotations: highlights, lastVisited: Date.now() })} })).then(() => true)`);
  await tab.goto(ORIGIN + ARTICLE);
  await sleep(1200);
  return tab;
}

// The card shows exactly what "Copy for LLM" produces, built by the extension's own formatter.
const WA_EXPORT = new Function(readFileSync(join(EXT, 'export-format.js'), 'utf8') + '; return WA_EXPORT;')();
const markdownFor = (anns) => WA_EXPORT.forLlm({ url: KEY, title: 'Why your sourdough starter needs a schedule' }, anns);

// ── composite: caption + generic browser frame + raw capture (+ optional overlay) ─
function composite(name, title, sub, rawFile, overlay = '') {
  const file = join(RAW, `c-${name}.html`);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
    body { background: linear-gradient(160deg, #fff8e1 0%, #f6efe2 55%, #efe7d8 100%); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; }
    .cap { position: absolute; top: 26px; left: 0; right: 0; text-align: center; }
    .cap h1 { margin: 0; font-size: 31px; font-weight: 700; letter-spacing: -.01em; }
    .cap p { margin: 7px 0 0; font-size: 16px; color: #6b6458; }
    .win { position: absolute; left: 80px; top: 114px; width: 1120px; border-radius: 12px; overflow: hidden; background: #fff;
           box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 18px 50px rgba(60,45,20,.22); }
    .chrome { height: 34px; background: #ece9e3; display: flex; align-items: center; padding: 0 14px; gap: 7px; }
    .dot { width: 11px; height: 11px; border-radius: 50%; background: #cfcac0; }
    .url { margin-left: 18px; flex: 1; height: 22px; border-radius: 11px; background: #fff; font-size: 12px; color: #6b6458; display: flex; align-items: center; padding: 0 12px; }
    .ext { width: 22px; height: 22px; border-radius: 5px; background: #1a1a1a; display: flex; align-items: center; justify-content: center; }
    .shot { display: block; width: 1120px; height: 620px; }
    .overlay { position: absolute; }
  </style></head><body>
    <div class="cap"><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>
    <div class="win">
      <div class="chrome"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <div class="url">${esc(URL_TEXT)}</div>
        <div class="ext"><svg width="12" height="12" viewBox="0 0 24 24" fill="#fff"><path d="M18.85 1.1L22.9 5.15a.5.5 0 010 .7L11.16 17.6l-4.95.55a1 1 0 01-1.1-1.1l.55-4.95L17.15 1.1a.5.5 0 01.7 0zM3 21h18v2H3v-2z"/></svg></div>
      </div>
      <img class="shot" src="${rawFile}">
    </div>
    ${overlay}
  </body></html>`);
  return 'file://' + file;
}

async function render(name, url) {
  const tab = await openTab(url, 1280, 800);
  await sleep(400);
  await tab.capture(join(OUT, name + '.png'), { x: 0, y: 0, width: 1280, height: 800 });
  await tab.close();
}

// ── shots ───────────────────────────────────────────────────────────────────
try {
  // 1. selection toolbar
  {
    const t = await articleWith([HL[0], HL[1]]);
    await t.select('keep the jar somewhere with a steady temperature');
    await t.capture(join(RAW, '1.png'));
    await t.close();
    await render('1-highlight', composite('1', 'Highlight any text in one click', 'Select text on any webpage, then choose Highlight or Note.', '1.png'));
  }
  // 2. note editor
  {
    const t = await articleWith([HL[0], HL[1], HL[2]]);
    await t.evalIn('window.scrollTo(0, 395)');
    await sleep(300);
    await t.select('A layer of grey liquid on top is a sign of hunger, not spoilage.');
    await t.click('wa-sel-note-btn');
    await sleep(500);
    await t.send('Input.insertText', { text: 'Good to know. I almost threw mine out last week.' });
    await sleep(200);
    await t.capture(join(RAW, '2.png'));
    await t.close();
    await render('2-notes', composite('2', 'Add notes to your highlights', 'Your notes are saved locally on your device, never uploaded.', '2.png'));
  }
  // 3 + 4. side panel with export selection
  {
    const t = await articleWith(HL);
    await t.click('wa-panel-tab');
    await sleep(700);
    await t.click('wa-panel-check', 2); // untick the third highlight: "3 / 4 selected"
    await sleep(300);
    await t.capture(join(RAW, '3.png'));
    await t.close();
    await render('3-panel', composite('3', 'Review every highlight in a side panel', 'Click one to jump to it. Tick exactly what you want to export.', '3.png'));

    const md = markdownFor([HL[0], HL[1], HL[3]]).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const card = `<div class="overlay" style="left:120px; top:236px; width:560px; background:#1e1d1a; color:#e9e4d8; border-radius:12px;
      box-shadow:0 24px 60px rgba(0,0,0,.35); padding:18px 22px 20px; font:13px/1.55 ui-monospace, Menlo, monospace;">
      <div style="font:600 11px -apple-system,sans-serif; letter-spacing:.1em; text-transform:uppercase; color:#d9a441; margin-bottom:10px;">Copied for LLM</div>
      <pre style="margin:0; white-space:pre-wrap; word-break:break-word;">${md}</pre></div>`;
    await render('4-copy-for-llm', composite('4', 'Copy as markdown for any AI assistant', 'Quotes, notes and the source link, ready to paste into a chat or your notes app.', '3.png', card));
  }
  // 5. popup
  {
    const t = await articleWith([HL[0], HL[1], HL[3]]);
    const extOrigin = await t.ext(`chrome.runtime.getURL('').replace(/\\/$/, '')`);
    const pop = await openTab(extOrigin + '/popup.html', 420, 700, true);
    await sleep(800);
    const h = await pop.evalIn('Math.ceil(document.body.getBoundingClientRect().height)');
    console.log('popup height', h);
    await pop.capture(join(RAW, 'popup.png'), { x: 0, y: 0, width: 420, height: Math.min(h, 612) });
    await pop.close();
    await t.capture(join(RAW, '5.png'));
    await t.close();
    const popup = `<div class="overlay" style="right:92px; top:152px; width:420px; border-radius:10px; overflow:hidden;
      box-shadow:0 2px 6px rgba(0,0,0,.12), 0 24px 60px rgba(0,0,0,.28); background:#fff;"> <img src="popup.png" style="display:block; width:420px;"></div>`;
    await render('5-private', composite('5', 'Your highlights stay in your browser', 'No account, no tracking, nothing uploaded. Switch it off on any site.', '5.png', popup));
  }
  console.log('done →', OUT);
} finally {
  ws.close(); chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true }); rmSync(RAW, { recursive: true, force: true });
}
