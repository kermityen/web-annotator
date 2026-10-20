// Content script: injected into every page
//
// Privacy model: the extension's own UI (popovers, note editor, review panel, toast) lives in a
// CLOSED shadow root, so page scripts can neither read your notes nor click our buttons. The only
// thing written into the page's own DOM is the <mark> around highlighted text, and it never
// carries note text.

(function () {
  'use strict';

  // Only regular web pages. An SVG image or XML file opened in a tab has no HTML body to work with.
  if (!document.body || document.documentElement.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;

  // ── URL normalization ─────────────────────────────────────────────────────

  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      let href = u.toString();
      if (href.endsWith('/') && u.pathname !== '/') href = href.slice(0, -1);
      return href;
    } catch {
      return url;
    }
  }

  const PAGE_URL = normalizeUrl(window.location.href);
  const PAGE_HOST = (() => { try { return new URL(window.location.href).hostname; } catch { return ''; } })();
  let siteEnabled = false; // stays inert until the per-site setting has been read

  // ── Extension context guard ───────────────────────────────────────────────

  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  // ── IDs ───────────────────────────────────────────────────────────────────

  // crypto.randomUUID() only exists in secure contexts, so it is undefined on plain http://
  // pages. getRandomValues() is available everywhere.
  function newId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  // ── Storage ───────────────────────────────────────────────────────────────
  // Writes return true on success. On failure they tell the user why and return false, so the
  // UI never shows a highlight or note as saved when it is not.

  function emptyPageData() {
    return { url: PAGE_URL, title: document.title, annotations: [], lastVisited: Date.now() };
  }

  // Lenient read, for display only.
  async function getPageData() {
    if (!isContextValid()) return emptyPageData();
    try {
      const result = await chrome.storage.local.get(PAGE_URL);
      return result[PAGE_URL] || emptyPageData();
    } catch { return emptyPageData(); }
  }

  function reportWriteFailure(err) {
    const reason = String((err && err.message) || err || '');
    // Right after an update, chrome.runtime.id can still be set while every call already
    // throws "Extension context invalidated", so check the error too.
    if (!isContextValid() || /context invalidated/i.test(reason)) {
      showToast('Web Annotator was updated. Reload this page to keep saving highlights.');
    } else if (/quota/i.test(reason)) {
      showToast('Storage is full, so this was not saved. Delete old highlights from the extension popup to free up space.');
    } else {
      showToast('Web Annotator could not save this change.');
    }
  }

  // Strict read-modify-write. A failed read must never be mistaken for an empty page, or the
  // write would wipe the page's other highlights. `mutate` returns false to abort the write.
  async function writePage(mutate) {
    if (!isContextValid()) { reportWriteFailure(); return false; }
    try {
      const result = await chrome.storage.local.get(PAGE_URL);
      const pageData = result[PAGE_URL] || emptyPageData();
      if (mutate(pageData) === false) return false;
      if (pageData.annotations.length === 0) {
        await chrome.storage.local.remove(PAGE_URL); // no invisible empty records left behind
      } else {
        await chrome.storage.local.set({ [PAGE_URL]: pageData });
      }
      return true;
    } catch (err) {
      reportWriteFailure(err);
      return false;
    }
  }

  function saveAnnotation(annotation) {
    return writePage(pageData => {
      pageData.annotations.push(annotation);
      pageData.lastVisited = Date.now();
    });
  }

  function deleteAnnotationById(id) {
    return writePage(pageData => {
      pageData.annotations = pageData.annotations.filter(a => a.id !== id);
    });
  }

  function updateCommentById(id, comment) {
    return writePage(pageData => {
      const ann = pageData.annotations.find(a => a.id === id);
      if (!ann) {
        showToast('This highlight was removed, so the note could not be saved.');
        return false;
      }
      ann.comment = comment;
    });
  }

  async function clearPageData() {
    if (!isContextValid()) { reportWriteFailure(); return false; }
    try {
      await chrome.storage.local.remove(PAGE_URL);
      return true;
    } catch (err) {
      reportWriteFailure(err);
      return false;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function getParentSelector(node) {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el) return '';
    if (el.id) return '#' + el.id;
    if (el.className) return el.tagName.toLowerCase() + '.' + [...el.classList].join('.');
    return el.tagName.toLowerCase();
  }

  // Text that must never be wrapped in <mark>: code, stylesheets, form fields, SVG/MathML, and
  // anything editable (a <mark> inside someone's draft would end up in what they send).
  const NON_CONTENT = 'script, style, noscript, textarea, template, title, option, select, svg, math';

  function isHighlightableElement(el) {
    return !!el && !el.isContentEditable && !el.closest(NON_CONTENT);
  }

  function isHighlightableTextNode(node) {
    return isHighlightableElement(node.parentElement);
  }

  function rangeIsHighlightable(range) {
    const toEl = n => (n.nodeType === Node.TEXT_NODE ? n.parentElement : n);
    if (uiHost && range.intersectsNode(uiHost)) return false;
    return isHighlightableElement(toEl(range.startContainer)) && isHighlightableElement(toEl(range.endContainer));
  }

  function focusIsInEditableField() {
    const el = document.activeElement;
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  // Returns true if the range overlaps ANY existing highlight (full or partial)
  function selectionOverlapsHighlight(range) {
    return Array.from(document.querySelectorAll('.wa-highlight'))
      .some(mark => range.intersectsNode(mark));
  }

  function marksFor(id) {
    return document.querySelectorAll(`.wa-highlight[data-annotation-id="${CSS.escape(id)}"]`);
  }

  // Marks carry only the annotation id and a has-comment flag, never the note itself.
  function makeMark(id, hasComment) {
    const mark = document.createElement('mark');
    mark.className = hasComment ? 'wa-highlight has-comment' : 'wa-highlight';
    mark.dataset.annotationId = id;
    return mark;
  }

  function setHasComment(id, comment) {
    marksFor(id).forEach(mark => mark.classList.toggle('has-comment', !!comment.trim()));
  }

  function unwrapMark(mark) {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
  }

  function unwrapHighlight(id) {
    marksFor(id).forEach(unwrapMark);
  }

  function unwrapAll() {
    document.querySelectorAll('.wa-highlight').forEach(unwrapMark);
  }

  // Annotation ids in the order their highlights appear on the page.
  function idsInPageOrder() {
    return [...new Set([...document.querySelectorAll('.wa-highlight')].map(m => m.dataset.annotationId))];
  }

  function inPageOrder(annotations) {
    return WA_EXPORT.orderBy(annotations || [], idsInPageOrder()); // defined in export-format.js
  }

  // ── UI host (closed shadow root) ──────────────────────────────────────────

  let uiHost = null;
  let uiRoot = null;

  function ui() {
    if (!uiHost) {
      uiHost = document.createElement('div');
      // Inline !important so page CSS cannot hide, move, or restyle the host.
      const hostStyle = {
        all: 'initial', position: 'absolute', top: '0', left: '0', width: '0', height: '0',
        overflow: 'visible', display: 'block', 'z-index': '2147483647',
      };
      for (const [prop, value] of Object.entries(hostStyle)) uiHost.style.setProperty(prop, value, 'important');
      uiRoot = uiHost.attachShadow({ mode: 'closed' });
      applyUiStyles(uiRoot);
      bindUiRootEvents(uiRoot);
    }
    if (!uiHost.isConnected) document.documentElement.appendChild(uiHost);
    return uiRoot;
  }

  function applyUiStyles(root) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(WA_UI_CSS); // defined in ui-styles.js
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = WA_UI_CSS;
      root.appendChild(style);
    }
  }

  function detachUi() {
    if (uiHost) uiHost.remove();
  }

  // True when an event started inside our UI. Seen from outside the closed shadow root, the
  // event's path stops at the host.
  function fromUI(e) {
    return !!uiHost && e.composedPath().includes(uiHost);
  }

  function pathHasClass(path, cls) {
    return path.some(n => n.classList && n.classList.contains(cls));
  }

  function bindUiRootEvents(root) {
    // Keep typing inside our UI to ourselves: page keyboard shortcuts must not fire while you
    // write a note, and the page's key listeners should not see what you type.
    for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input',
      'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'copy', 'cut']) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }

    // A press inside our UI dismisses whichever floating piece it did not land on.
    root.addEventListener('mousedown', (e) => {
      if (!e.isTrusted) return;
      const path = e.composedPath();
      const inSel = pathHasClass(path, 'wa-sel-popover');
      const inToolbar = pathHasClass(path, 'wa-hover-toolbar');
      const inNote = pathHasClass(path, 'wa-mark-popover');
      if (selPopover && !inSel) removeSelPopover();
      if (hoverToolbar && !inToolbar) removeHoverToolbar();
      if (activeMarkPopover && !inNote && !inToolbar) closeMarkPopover(true);
    });
  }

  // ── Toast ─────────────────────────────────────────────────────────────────

  function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'wa-toast';
    toast.textContent = msg;
    ui().appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ── Multi-node highlight helpers ──────────────────────────────────────────

  function getTextNodesInRange(range) {
    const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let node;

    while ((node = walker.nextNode())) {
      if (!range.intersectsNode(node)) continue;
      if (!isHighlightableTextNode(node)) continue;
      let start = 0;
      let end = node.textContent.length;
      if (node === range.startContainer) start = range.startOffset;
      if (node === range.endContainer) end = range.endOffset;
      if (start < end) nodes.push({ node, start, end });
    }
    return nodes;
  }

  function wrapRangeInMarks(range, id) {
    const textNodes = getTextNodesInRange(range);
    if (textNodes.length === 0) return false;

    for (const { node, start, end } of textNodes) {
      const full = node.textContent;
      const mark = makeMark(id, false);
      mark.textContent = full.slice(start, end);

      const frag = document.createDocumentFragment();
      if (start > 0) frag.appendChild(document.createTextNode(full.slice(0, start)));
      frag.appendChild(mark);
      if (end < full.length) frag.appendChild(document.createTextNode(full.slice(end)));

      node.parentNode.replaceChild(frag, node);
    }
    return true;
  }

  // ── Position helper ───────────────────────────────────────────────────────

  function positionAbove(el, rect) {
    if (!el.parentNode) ui().appendChild(el);
    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    const centerX = window.scrollX + rect.left + rect.width / 2;
    let left = centerX - pw / 2;
    left = Math.max(window.scrollX + 8, Math.min(left, window.scrollX + window.innerWidth - pw - 8));
    const top = window.scrollY + rect.top - ph - 12;
    el.style.left = left + 'px';
    el.style.top = (top < window.scrollY + 8 ? window.scrollY + rect.bottom + 12 : top) + 'px';
  }

  // ── Selection popover (Highlight + Note) ─────────────────────────────────

  let selPopover = null;
  let capturedRange = null;

  function removeSelPopover() {
    if (selPopover) { selPopover.remove(); selPopover = null; }
    capturedRange = null;
  }

  function showSelPopover(rect, range) {
    removeSelPopover();
    capturedRange = range.cloneRange();

    const el = document.createElement('div');
    el.className = 'wa-sel-popover';
    el.innerHTML = `
      <button class="wa-sel-hl-btn">Highlight</button>
      <div class="wa-ht-sep"></div>
      <button class="wa-sel-hl-btn wa-sel-note-btn">Note</button>
    `;

    el.querySelector('.wa-sel-hl-btn').addEventListener('mousedown', (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      const r = capturedRange;
      removeSelPopover();
      applyHighlight(r, '');
    });

    // Note: immediately highlight, then open note input on the new mark
    el.querySelector('.wa-sel-note-btn').addEventListener('mousedown', async (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      const r = capturedRange;
      removeSelPopover();
      if (!r) return;
      const id = await applyHighlight(r, '');
      if (!id) return;
      const mark = marksFor(id)[0];
      if (mark) openMarkPopover(mark);
    });

    positionAbove(el, rect);
    selPopover = el;
  }

  document.addEventListener('mouseup', (e) => {
    if (!e.isTrusted || fromUI(e)) return;
    setTimeout(() => {
      if (!siteEnabled) return;

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) { removeSelPopover(); return; }
      const text = sel.toString().trim();
      if (!text) { removeSelPopover(); return; }
      const range = sel.getRangeAt(0);
      if (focusIsInEditableField() || !rangeIsHighlightable(range)) { removeSelPopover(); return; }
      if (selectionOverlapsHighlight(range)) { removeSelPopover(); return; }

      showSelPopover(range.getBoundingClientRect(), range);
    }, 10);
  });

  // Presses outside our UI close whatever is floating. Presses inside it are handled on the
  // shadow root (see bindUiRootEvents).
  document.addEventListener('mousedown', (e) => {
    if (!e.isTrusted || fromUI(e)) return;
    removeSelPopover();
    if (hoverToolbar && !e.target.closest?.('.wa-highlight')) removeHoverToolbar();
    if (activeMarkPopover) closeMarkPopover(true);
  });

  // ── Apply highlight ───────────────────────────────────────────────────────

  // Returns the annotation id on success, null on failure
  async function applyHighlight(range, comment = '') {
    if (!range) return null;
    const text = range.toString();
    if (!text.trim()) return null;
    if (!rangeIsHighlightable(range)) return null;

    const id = newId();
    const parentSelector = getParentSelector(range.startContainer);
    const startOffset = range.startOffset;
    const endOffset = range.endOffset;
    const hasComment = !!comment.trim();
    let success = false;

    try {
      range.surroundContents(makeMark(id, hasComment));
      success = true;
    } catch {
      success = wrapRangeInMarks(range, id);
      if (success && hasComment) setHasComment(id, comment);
    }

    window.getSelection()?.removeAllRanges();

    if (!success) {
      showToast("Couldn't highlight that selection.");
      return null;
    }

    const saved = await saveAnnotation({ id, text, comment, createdAt: Date.now(), startOffset, endOffset, parentSelector });
    if (!saved) {
      unwrapHighlight(id); // never leave a highlight on screen that is not actually saved
      return null;
    }
    return id;
  }

  // ── Hover toolbar (Unhighlight / Note) ───────────────────────────────────

  let hoverToolbar = null;
  let hoverTarget = null;
  let hoverTimer = null;

  function removeHoverToolbar() {
    clearTimeout(hoverTimer);
    if (hoverToolbar) { hoverToolbar.remove(); hoverToolbar = null; hoverTarget = null; }
  }

  function scheduleHideHover() {
    hoverTimer = setTimeout(removeHoverToolbar, 160);
  }

  function showHoverToolbar(markEl) {
    clearTimeout(hoverTimer);
    const id = markEl.dataset.annotationId;
    if (hoverTarget === markEl) return; // already showing for this mark

    removeHoverToolbar();

    const toolbar = document.createElement('div');
    toolbar.className = 'wa-hover-toolbar';
    toolbar.innerHTML = `
      <button class="wa-ht-btn wa-ht-unhighlight">Unhighlight</button>
      <div class="wa-ht-sep"></div>
      <button class="wa-ht-btn wa-ht-note">Note</button>
    `;

    toolbar.querySelector('.wa-ht-unhighlight').addEventListener('mousedown', async (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      removeHoverToolbar();
      if (activeMarkId === id) closeMarkPopover(false);
      if (!(await deleteAnnotationById(id))) return; // still saved, so keep it on screen
      unwrapHighlight(id);
      if (reviewPanel) refreshReviewPanel();
    });

    toolbar.querySelector('.wa-ht-note').addEventListener('mousedown', (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      removeHoverToolbar();
      openMarkPopover(markEl);
    });

    ui().appendChild(toolbar);
    positionAbove(toolbar, markEl.getBoundingClientRect());
    hoverToolbar = toolbar;
    hoverTarget = markEl;
  }

  document.addEventListener('click', (e) => {
    if (!e.isTrusted || !siteEnabled) return;
    const mark = e.target.closest?.('.wa-highlight');
    if (mark) {
      e.stopPropagation();
      showHoverToolbar(mark);
    }
  });

  // ── Note / comment popover ────────────────────────────────────────────────

  let activeMarkPopover = null;
  let activeMarkId = null;
  let activeMarkOriginal = '';
  let noteSaving = false;
  let noteOpenToken = 0;

  async function closeMarkPopover(save) {
    const popover = activeMarkPopover;
    if (!popover || noteSaving) return;
    const id = activeMarkId;

    if (save && id) {
      const comment = popover.querySelector('textarea').value;
      if (comment !== activeMarkOriginal) {
        noteSaving = true;
        const ok = await updateCommentById(id, comment);
        noteSaving = false;
        if (!ok) return; // keep the editor open so what was typed is not lost
        setHasComment(id, comment);
        if (reviewPanel) refreshReviewPanel();
      }
    }

    if (activeMarkPopover === popover) {
      popover.remove();
      activeMarkPopover = null;
      activeMarkId = null;
      activeMarkOriginal = '';
    }
  }

  async function openMarkPopover(markEl) {
    const token = ++noteOpenToken;
    await closeMarkPopover(true);
    if (activeMarkPopover) return; // the previous note could not be saved, so it stays open
    if (!isContextValid()) { reportWriteFailure(); return; }

    // The note is read from storage on demand; it is never kept in the page's DOM.
    const id = markEl.dataset.annotationId;
    const pageData = await getPageData();
    if (token !== noteOpenToken) return; // a newer open request won
    const ann = (pageData.annotations || []).find(a => a.id === id);
    const existingComment = (ann && ann.comment) || '';
    const target = markEl.isConnected ? markEl : marksFor(id)[0];
    if (!target) return;

    const popover = document.createElement('div');
    popover.className = 'wa-mark-popover';
    popover.innerHTML = `
      <textarea class="wa-mp-textarea" rows="4" placeholder="Write a note…"></textarea>
      <div class="wa-mp-footer">
        <button class="wa-mp-save">Save</button>
        <button class="wa-mp-cancel">Cancel</button>
      </div>
    `;

    const textarea = popover.querySelector('.wa-mp-textarea');
    textarea.value = existingComment;

    positionAbove(popover, target.getBoundingClientRect());

    popover.querySelector('.wa-mp-save').addEventListener('click', (e) => { if (e.isTrusted) closeMarkPopover(true); });
    popover.querySelector('.wa-mp-cancel').addEventListener('click', (e) => { if (e.isTrusted) closeMarkPopover(false); });

    textarea.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); closeMarkPopover(true); }
      if (e.key === 'Escape') closeMarkPopover(false);
    });

    activeMarkPopover = popover;
    activeMarkId = id;
    activeMarkOriginal = existingComment;
    textarea.focus();
  }

  // ── Review Panel ──────────────────────────────────────────────────────────

  let reviewPanel = null;
  let panelOpening = false;
  let panelTab = null;
  let panelDeselected = new Set(); // ids excluded from export; default = everything selected

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function truncateText(str, max = 100) {
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  function panelItemHtml(ann) {
    return `
      <div class="wa-panel-item" data-id="${escapeHtml(ann.id)}">
        <input type="checkbox" class="wa-panel-check" ${panelDeselected.has(ann.id) ? '' : 'checked'}>
        <div class="wa-panel-item-body">
          <div class="wa-panel-quote">${escapeHtml(truncateText(ann.text))}</div>
          ${ann.comment && ann.comment.trim()
            ? `<div class="wa-panel-note">${escapeHtml(ann.comment)}</div>`
            : ''}
        </div>
      </div>
    `;
  }

  function updatePanelExportUI() {
    if (!reviewPanel) return;
    const boxes = reviewPanel.querySelectorAll('.wa-panel-check');
    const sel = reviewPanel.querySelectorAll('.wa-panel-check:checked').length;
    const llmBtn = reviewPanel.querySelector('.wa-panel-copy-llm');
    const notesBtn = reviewPanel.querySelector('.wa-panel-copy-notes');
    if (llmBtn) llmBtn.disabled = sel === 0;
    if (notesBtn) notesBtn.disabled = sel === 0;
    const countEl = reviewPanel.querySelector('.wa-panel-export-count');
    if (countEl) {
      countEl.textContent = boxes.length === 0 ? '' : `${sel} / ${boxes.length} selected`;
    }
    const selectAll = reviewPanel.querySelector('.wa-panel-select-all');
    if (selectAll) {
      selectAll.checked = boxes.length > 0 && sel === boxes.length;
      selectAll.indeterminate = sel > 0 && sel < boxes.length;
    }
  }

  function bindPanelItems(rootEl) {
    rootEl.querySelectorAll('.wa-panel-item').forEach(item => {
      item.addEventListener('click', () => {
        const mark = marksFor(item.dataset.id)[0];
        if (!mark) return;
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        mark.classList.add('wa-highlight-flash');
        setTimeout(() => mark.classList.remove('wa-highlight-flash'), 1400);
      });
      const cb = item.querySelector('.wa-panel-check');
      if (cb) {
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
          const id = item.dataset.id;
          if (cb.checked) panelDeselected.delete(id); else panelDeselected.add(id);
          updatePanelExportUI();
        });
      }
    });
  }

  function closeReviewPanel() {
    if (!reviewPanel) return;
    const panel = reviewPanel;
    reviewPanel = null;
    panel.classList.remove('wa-panel-open');
    setTimeout(() => panel.remove(), 240);
    if (panelTab) panelTab.classList.remove('wa-panel-tab-active');
  }

  async function refreshReviewPanel() {
    if (!reviewPanel) return;
    const pageData = await getPageData();
    if (!reviewPanel) return;
    const annotations = inPageOrder(pageData.annotations);

    const count = reviewPanel.querySelector('.wa-panel-count');
    if (count) count.textContent = annotations.length;

    const body = reviewPanel.querySelector('.wa-panel-body');
    if (!body) return;

    if (annotations.length === 0) {
      body.innerHTML = '<div class="wa-panel-empty">No highlights on this page yet.</div>';
      updatePanelExportUI();
      return;
    }

    body.innerHTML = annotations.map(panelItemHtml).join('');
    bindPanelItems(body);
    updatePanelExportUI();
  }

  async function copyToClipboard(text, btn, label, html) {
    try {
      if (html) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = label; }, 2000);
    } catch {
      showToast("Couldn't copy to the clipboard. Click the page once, then try again.");
    }
  }

  async function openReviewPanel() {
    if (!siteEnabled || reviewPanel || panelOpening) return;
    panelOpening = true;
    const pageData = await getPageData();
    panelOpening = false;
    if (!siteEnabled || reviewPanel) return;
    const annotations = inPageOrder(pageData.annotations);

    const panel = document.createElement('div');
    panel.className = 'wa-panel';

    const itemsHtml = annotations.length === 0
      ? '<div class="wa-panel-empty">No highlights on this page yet.</div>'
      : annotations.map(panelItemHtml).join('');

    panel.innerHTML = `
      <div class="wa-panel-header">
        <span class="wa-panel-title">Highlights <span class="wa-panel-count">${annotations.length}</span></span>
        <button class="wa-panel-close">✕</button>
      </div>
      <div class="wa-panel-selectbar">
        <label><input type="checkbox" class="wa-panel-select-all" checked> Select all</label>
      </div>
      <div class="wa-panel-body">${itemsHtml}</div>
      <div class="wa-panel-footer">
        <div class="wa-panel-export-count"></div>
        <div class="wa-panel-footer-row">
          <button class="wa-panel-copy-llm">Copy for LLM</button>
          <button class="wa-panel-copy-notes">Copy as Notes</button>
        </div>
        <div class="wa-panel-footer-row">
          <button class="wa-panel-clear">Clear All</button>
        </div>
      </div>
    `;

    panel.querySelector('.wa-panel-close').addEventListener('click', () => {
      closeReviewPanel();
    });

    bindPanelItems(panel);

    // Select all / deselect all
    panel.querySelector('.wa-panel-select-all').addEventListener('change', (e) => {
      const boxes = panel.querySelectorAll('.wa-panel-check');
      boxes.forEach(cb => {
        cb.checked = e.target.checked;
        const id = cb.closest('.wa-panel-item').dataset.id;
        if (e.target.checked) panelDeselected.delete(id); else panelDeselected.add(id);
      });
      updatePanelExportUI();
    });

    // Copy for LLM
    panel.querySelector('.wa-panel-copy-llm').addEventListener('click', async (e) => {
      if (!e.isTrusted) return;
      const pd = await getPageData();
      const selected = inPageOrder(pd.annotations).filter(ann => !panelDeselected.has(ann.id));
      if (selected.length === 0) return;
      await copyToClipboard(WA_EXPORT.forLlm(pd, selected), panel.querySelector('.wa-panel-copy-llm'), 'Copy for LLM');
    });

    // Copy as Notes
    panel.querySelector('.wa-panel-copy-notes').addEventListener('click', async (e) => {
      if (!e.isTrusted) return;
      const pd = await getPageData();
      const selected = inPageOrder(pd.annotations).filter(ann => !panelDeselected.has(ann.id));
      if (selected.length === 0) return;
      const { text, html } = WA_EXPORT.forNotes(pd, selected);
      await copyToClipboard(text, panel.querySelector('.wa-panel-copy-notes'), 'Copy as Notes', html);
    });

    // Clear All
    panel.querySelector('.wa-panel-clear').addEventListener('click', async (e) => {
      if (!e.isTrusted) return;
      if (!confirm('Remove all annotations for this page? This will also clear all highlights.')) return;
      if (!(await clearPageData())) return;
      closeMarkPopover(false);
      removeHoverToolbar();
      unwrapAll();
      refreshReviewPanel();
    });

    ui().appendChild(panel);
    reviewPanel = panel;
    updatePanelExportUI();
    requestAnimationFrame(() => panel.classList.add('wa-panel-open'));
    if (panelTab) panelTab.classList.add('wa-panel-tab-active');
  }

  function toggleReviewPanel() {
    if (!siteEnabled) return;
    if (reviewPanel) { closeReviewPanel(); } else { openReviewPanel(); }
  }

  // Persistent toggle tab on the right edge of the page
  function initPanelTab() {
    if (!siteEnabled || panelTab) return;
    panelTab = document.createElement('button');
    panelTab.className = 'wa-panel-tab';
    panelTab.title = 'Toggle Highlights Panel';
    panelTab.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18.85 1.1L22.9 5.15a.5.5 0 010 .7L11.16 17.6l-4.95.55a1 1 0 01-1.1-1.1l.55-4.95L17.15 1.1a.5.5 0 01.7 0zM3 21h18v2H3v-2z"/>
      </svg>
    `;
    panelTab.addEventListener('click', (e) => { if (e.isTrusted) toggleReviewPanel(); });
    ui().appendChild(panelTab);
  }

  // ── Per-site on/off ───────────────────────────────────────────────────────
  // Driven by storage, so turning a site off applies to every open tab on that site.

  function applySiteEnabled(enabled) {
    if (enabled === siteEnabled) return;
    siteEnabled = enabled;
    if (enabled) {
      initPanelTab();
      restoreHighlights();
    } else {
      removeSelPopover();
      removeHoverToolbar();
      closeMarkPopover(false);
      closeReviewPanel();
      if (panelTab) { panelTab.remove(); panelTab = null; }
      unwrapAll(); // leave the page exactly as the site served it
      detachUi();
    }
  }

  async function readSiteEnabled() {
    if (!isContextValid()) return false;
    try {
      const result = await chrome.storage.local.get('wa_disabled_sites');
      return !(result.wa_disabled_sites || []).includes(PAGE_HOST);
    } catch { return false; }
  }

  let siteStateKnown = false;

  if (isContextValid()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !('wa_disabled_sites' in changes)) return;
      siteStateKnown = true;
      applySiteEnabled(!(changes.wa_disabled_sites.newValue || []).includes(PAGE_HOST));
    });
  }

  // ── Restore highlights on page load ─────────────────────────────────────

  async function restoreHighlights() {
    if (!siteEnabled || !isContextValid()) return;

    // Put our UI back if the page removed it (SPA re-renders can do that)
    if (uiHost && !uiHost.isConnected) document.documentElement.appendChild(uiHost);
    initPanelTab();

    try {
      const pageData = await getPageData();
      if (!siteEnabled) return; // turned off while we were reading
      for (const ann of pageData.annotations || []) {
        if (marksFor(ann.id).length) continue;
        findAndHighlightText(ann.text, ann.id, !!(ann.comment && ann.comment.trim()));
      }
    } catch { }
  }

  function findAndHighlightText(searchText, id, hasComment) {
    if (!searchText || !searchText.trim() || !document.body) return false;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (isHighlightableTextNode(node) && !node.parentElement.closest('.wa-highlight'))
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
    });
    const textNodes = [];
    let node;

    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }

    // Single-node match (fast path)
    for (const tn of textNodes) {
      const idx = tn.textContent.indexOf(searchText);
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(tn, idx);
        range.setEnd(tn, idx + searchText.length);

        try {
          range.surroundContents(makeMark(id, hasComment));
          return true;
        } catch { }
      }
    }

    // Multi-node match: build concatenated text map and search across nodes
    let fullText = '';
    const nodeMap = [];

    for (const tn of textNodes) {
      const start = fullText.length;
      fullText += tn.textContent;
      nodeMap.push({ node: tn, start, end: fullText.length });
    }

    const matchIdx = fullText.indexOf(searchText);
    if (matchIdx === -1) return false;

    const matchEnd = matchIdx + searchText.length;
    const involved = nodeMap.filter(n => n.start < matchEnd && n.end > matchIdx);
    if (involved.length === 0) return false;

    for (const { node: tn, start: ns } of involved) {
      const localStart = Math.max(0, matchIdx - ns);
      const localEnd = Math.min(tn.textContent.length, matchEnd - ns);
      if (localStart >= localEnd) continue;

      const mark = makeMark(id, hasComment);
      mark.textContent = tn.textContent.slice(localStart, localEnd);

      const frag = document.createDocumentFragment();
      if (localStart > 0) frag.appendChild(document.createTextNode(tn.textContent.slice(0, localStart)));
      frag.appendChild(mark);
      if (localEnd < tn.textContent.length) frag.appendChild(document.createTextNode(tn.textContent.slice(localEnd)));

      tn.parentNode.replaceChild(frag, tn);
    }

    return true;
  }

  // Read the per-site setting first; nothing is injected into the page until we know the site
  // is enabled. Then retry restore a few times — SPA frameworks (React, Vue, etc.) hydrate the
  // DOM after load, which destroys our <mark> elements.
  readSiteEnabled().then((enabled) => {
    if (!siteStateKnown) {
      siteStateKnown = true;
      applySiteEnabled(enabled); // restores immediately when enabled
    }
    for (const delay of [800, 2000, 4000]) {
      setTimeout(restoreHighlights, delay);
    }
  });

  // ── Message listener (from popup) ────────────────────────────────────────

  if (isContextValid()) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'WA_GET_PAGE_ORDER') { sendResponse(idsInPageOrder()); return; }
      if (msg.type === 'WA_CLEAR_ALL') {
        closeMarkPopover(false);
        removeHoverToolbar();
        closeReviewPanel();
        unwrapAll();
      }
      if (msg.type === 'WA_TOGGLE_PANEL') toggleReviewPanel();
    });
  }

})();
