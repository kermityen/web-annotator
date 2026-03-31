// Content script: injected into every page

(function () {
  'use strict';

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

  // ── Extension context guard ───────────────────────────────────────────────

  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  async function getPageData() {
    if (!isContextValid()) return { url: PAGE_URL, title: document.title, annotations: [], lastVisited: Date.now() };
    try {
      const result = await chrome.storage.local.get(PAGE_URL);
      return result[PAGE_URL] || { url: PAGE_URL, title: document.title, annotations: [], lastVisited: Date.now() };
    } catch { return { url: PAGE_URL, title: document.title, annotations: [], lastVisited: Date.now() }; }
  }

  async function saveAnnotation(annotation) {
    if (!isContextValid()) return;
    try {
      const pageData = await getPageData();
      pageData.annotations.push(annotation);
      pageData.lastVisited = Date.now();
      await chrome.storage.local.set({ [PAGE_URL]: pageData });
    } catch { }
  }

  async function deleteAnnotationById(id) {
    if (!isContextValid()) return;
    try {
      const pageData = await getPageData();
      pageData.annotations = pageData.annotations.filter(a => a.id !== id);
      await chrome.storage.local.set({ [PAGE_URL]: pageData });
    } catch { }
  }

  async function updateCommentById(id, comment) {
    if (!isContextValid()) return;
    try {
      const pageData = await getPageData();
      const ann = pageData.annotations.find(a => a.id === id);
      if (ann) ann.comment = comment;
      await chrome.storage.local.set({ [PAGE_URL]: pageData });
    } catch { }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function getParentSelector(node) {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el) return '';
    if (el.id) return '#' + el.id;
    if (el.className) return el.tagName.toLowerCase() + '.' + [...el.classList].join('.');
    return el.tagName.toLowerCase();
  }

  function isInsideExtensionUI(node) {
    if (!node) return false;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return !!(el && el.closest('.wa-sel-popover, .wa-mark-popover, .wa-hover-toolbar, .wa-panel, .wa-panel-tab'));
  }

  // Returns true if the selection overlaps ANY existing highlight (full or partial)
  function selectionOverlapsHighlight(sel) {
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    return Array.from(document.querySelectorAll('.wa-highlight'))
      .some(mark => range.intersectsNode(mark));
  }

  function syncCommentToMarks(id, comment) {
    document.querySelectorAll(`.wa-highlight[data-annotation-id="${CSS.escape(id)}"]`).forEach(mark => {
      mark.dataset.comment = comment;
      mark.classList.toggle('has-comment', !!comment.trim());
    });
  }

  function unwrapHighlight(id) {
    document.querySelectorAll(`.wa-highlight[data-annotation-id="${CSS.escape(id)}"]`).forEach(mark => {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      mark.remove();
    });
  }

  // ── Toast ─────────────────────────────────────────────────────────────────

  function showToast(msg) {
    const toast = document.createElement('div');
    toast.textContent = msg;
    Object.assign(toast.style, {
      position: 'fixed', bottom: '24px', left: '50%',
      transform: 'translateX(-50%)',
      background: '#1a1a1a', color: '#fff',
      padding: '8px 16px', borderRadius: '6px',
      fontSize: '13px', zIndex: '2147483647',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      pointerEvents: 'none'
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
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
      const mark = document.createElement('mark');
      mark.className = 'wa-highlight';
      mark.dataset.annotationId = id;
      mark.dataset.comment = '';
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
    if (!el.parentNode) document.body.appendChild(el);
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
      e.preventDefault();
      e.stopPropagation();
      const r = capturedRange;
      removeSelPopover();
      applyHighlight(r, '');
    });

    // Note: immediately highlight, then open note input on the new mark
    el.querySelector('.wa-sel-note-btn').addEventListener('mousedown', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = capturedRange;
      removeSelPopover();
      if (!r) return;
      const id = await applyHighlight(r, '');
      if (!id) return;
      const mark = document.querySelector(`.wa-highlight[data-annotation-id="${CSS.escape(id)}"]`);
      if (mark) openMarkPopover(mark);
    });

    positionAbove(el, rect);
    selPopover = el;
  }

  document.addEventListener('mouseup', (e) => {
    setTimeout(() => {
      if (selPopover && selPopover.contains(e.target)) return;
      if (activeMarkPopover && activeMarkPopover.contains(e.target)) return;

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) { removeSelPopover(); return; }
      const text = sel.toString().trim();
      if (!text) { removeSelPopover(); return; }
      if (isInsideExtensionUI(sel.anchorNode)) { removeSelPopover(); return; }
      if (selectionOverlapsHighlight(sel)) { removeSelPopover(); return; }

      const range = sel.getRangeAt(0);
      showSelPopover(range.getBoundingClientRect(), range);
    }, 10);
  });

  document.addEventListener('mousedown', (e) => {
    if (selPopover && !selPopover.contains(e.target)) removeSelPopover();
  });

  // ── Apply highlight ───────────────────────────────────────────────────────

  // Returns the annotation id on success, null on failure
  async function applyHighlight(range, comment) {
    if (!range) return null;
    const text = range.toString();
    if (!text.trim()) return null;

    const id = crypto.randomUUID();
    const parentSelector = getParentSelector(range.startContainer);
    const startOffset = range.startOffset;
    const endOffset = range.endOffset;
    let success = false;

    try {
      const mark = document.createElement('mark');
      mark.className = 'wa-highlight';
      mark.dataset.annotationId = id;
      mark.dataset.comment = comment || '';
      if (comment && comment.trim()) mark.classList.add('has-comment');
      range.surroundContents(mark);
      success = true;
    } catch {
      success = wrapRangeInMarks(range, id);
      if (success && comment && comment.trim()) {
        syncCommentToMarks(id, comment);
      }
    }

    window.getSelection()?.removeAllRanges();

    if (!success) {
      showToast("Couldn't highlight that selection.");
      return null;
    }

    await saveAnnotation({ id, text, comment: comment || '', createdAt: Date.now(), startOffset, endOffset, parentSelector });
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
      e.preventDefault();
      e.stopPropagation();
      unwrapHighlight(id);
      closeMarkPopover(false);
      removeHoverToolbar();
      await deleteAnnotationById(id);
      if (reviewPanel) refreshReviewPanel();
    });

    toolbar.querySelector('.wa-ht-note').addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const targetMark = markEl;
      removeHoverToolbar();
      openMarkPopover(targetMark);
    });

    document.body.appendChild(toolbar);
    positionAbove(toolbar, markEl.getBoundingClientRect());
    hoverToolbar = toolbar;
    hoverTarget = markEl;
  }

  document.addEventListener('mousedown', (e) => {
    if (hoverToolbar && !hoverToolbar.contains(e.target) && !e.target.closest('.wa-highlight')) {
      removeHoverToolbar();
    }
  });

  document.addEventListener('click', (e) => {
    const mark = e.target.closest('.wa-highlight');
    if (mark) {
      e.stopPropagation();
      showHoverToolbar(mark);
    }
  });

  // ── Note / comment popover ────────────────────────────────────────────────

  let activeMarkPopover = null;
  let activeMarkEl = null;

  function closeMarkPopover(save) {
    if (!activeMarkPopover) return;
    if (save && activeMarkEl) {
      const textarea = activeMarkPopover.querySelector('textarea');
      const comment = textarea ? textarea.value : '';
      syncCommentToMarks(activeMarkEl.dataset.annotationId, comment);
      updateCommentById(activeMarkEl.dataset.annotationId, comment);
      if (reviewPanel) refreshReviewPanel();
    }
    activeMarkPopover.remove();
    activeMarkPopover = null;
    activeMarkEl = null;
  }

  function openMarkPopover(markEl) {
    closeMarkPopover(true);

    const rect = markEl.getBoundingClientRect();
    const existingComment = markEl.dataset.comment || '';

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

    positionAbove(popover, rect);

    popover.querySelector('.wa-mp-save').addEventListener('click', () => closeMarkPopover(true));
    popover.querySelector('.wa-mp-cancel').addEventListener('click', () => closeMarkPopover(false));

    textarea.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); closeMarkPopover(true); }
      if (e.key === 'Escape') closeMarkPopover(false);
    });

    activeMarkPopover = popover;
    activeMarkEl = markEl;
    textarea.focus();
  }

  document.addEventListener('mousedown', (e) => {
    if (
      activeMarkPopover &&
      !activeMarkPopover.contains(e.target) &&
      !e.target.closest('.wa-hover-toolbar')
    ) {
      closeMarkPopover(true);
    }
  });

  // ── Review Panel ──────────────────────────────────────────────────────────

  let reviewPanel = null;
  let panelTab = null;

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function truncateText(str, max = 100) {
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  function closeReviewPanel() {
    if (!reviewPanel) return;
    reviewPanel.classList.remove('wa-panel-open');
    setTimeout(() => { if (reviewPanel) { reviewPanel.remove(); reviewPanel = null; } }, 240);
    if (panelTab) panelTab.classList.remove('wa-panel-tab-active');
  }

  async function refreshReviewPanel() {
    if (!reviewPanel) return;
    const pageData = await getPageData();
    const annotations = (pageData.annotations || []).slice().sort((a, b) => a.createdAt - b.createdAt);

    const count = reviewPanel.querySelector('.wa-panel-count');
    if (count) count.textContent = annotations.length;

    const body = reviewPanel.querySelector('.wa-panel-body');
    if (!body) return;

    if (annotations.length === 0) {
      body.innerHTML = '<div class="wa-panel-empty">No highlights on this page yet.</div>';
      return;
    }

    body.innerHTML = annotations.map(ann => `
      <div class="wa-panel-item" data-id="${escapeHtml(ann.id)}">
        <div class="wa-panel-quote">${escapeHtml(truncateText(ann.text))}</div>
        ${ann.comment && ann.comment.trim()
          ? `<div class="wa-panel-note">${escapeHtml(ann.comment)}</div>`
          : ''}
      </div>
    `).join('');

    body.querySelectorAll('.wa-panel-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id;
        const mark = document.querySelector(`.wa-highlight[data-annotation-id="${CSS.escape(id)}"]`);
        if (!mark) return;
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        mark.classList.add('wa-highlight-flash');
        setTimeout(() => mark.classList.remove('wa-highlight-flash'), 1400);
      });
    });
  }

  async function openReviewPanel() {
    const pageData = await getPageData();
    const annotations = (pageData.annotations || []).slice().sort((a, b) => a.createdAt - b.createdAt);

    const panel = document.createElement('div');
    panel.className = 'wa-panel';

    const itemsHtml = annotations.length === 0
      ? '<div class="wa-panel-empty">No highlights on this page yet.</div>'
      : annotations.map(ann => `
          <div class="wa-panel-item" data-id="${escapeHtml(ann.id)}">
            <div class="wa-panel-quote">${escapeHtml(truncateText(ann.text))}</div>
            ${ann.comment && ann.comment.trim()
              ? `<div class="wa-panel-note">${escapeHtml(ann.comment)}</div>`
              : ''}
          </div>
        `).join('');

    panel.innerHTML = `
      <div class="wa-panel-header">
        <span class="wa-panel-title">Highlights <span class="wa-panel-count">${annotations.length}</span></span>
        <button class="wa-panel-close">✕</button>
      </div>
      <div class="wa-panel-body">${itemsHtml}</div>
      <div class="wa-panel-footer">
        <button class="wa-panel-copy-llm">Copy for LLM</button>
        <button class="wa-panel-copy-notes">Copy as Notes</button>
        <button class="wa-panel-clear">Clear All</button>
      </div>
    `;

    panel.querySelector('.wa-panel-close').addEventListener('click', () => {
      closeReviewPanel();
    });

    panel.querySelectorAll('.wa-panel-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id;
        const mark = document.querySelector(`.wa-highlight[data-annotation-id="${CSS.escape(id)}"]`);
        if (!mark) return;
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        mark.classList.add('wa-highlight-flash');
        setTimeout(() => mark.classList.remove('wa-highlight-flash'), 1400);
      });
    });

    // Copy for LLM
    panel.querySelector('.wa-panel-copy-llm').addEventListener('click', async () => {
      const pd = await getPageData();
      const sorted = (pd.annotations || []).slice().sort((a, b) => a.createdAt - b.createdAt);
      const date = new Date().toISOString().slice(0, 10);
      const lines = [
        '# Page Notes', '',
        `**Source:** [${pd.title}](${pd.url})`,
        `**Annotated:** ${date}`, '',
      ];
      for (const ann of sorted) {
        lines.push('---', '', '> ' + ann.text, '');
        if (ann.comment && ann.comment.trim()) lines.push(ann.comment, '');
      }
      await navigator.clipboard.writeText(lines.join('\n'));
      const btn = panel.querySelector('.wa-panel-copy-llm');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy for LLM'; }, 2000);
    });

    // Copy as Notes
    panel.querySelector('.wa-panel-copy-notes').addEventListener('click', async () => {
      const pd = await getPageData();
      const sorted = (pd.annotations || []).slice().sort((a, b) => a.createdAt - b.createdAt);
      const lines = [
        `# ${pd.title}`,
        `${pd.url}`,
        '',
      ];
      for (const ann of sorted) {
        lines.push('- ' + ann.text);
        if (ann.comment && ann.comment.trim()) lines.push('  - ' + ann.comment);
      }
      await navigator.clipboard.writeText(lines.join('\n'));
      const btn = panel.querySelector('.wa-panel-copy-notes');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy as Notes'; }, 2000);
    });

    // Clear All
    panel.querySelector('.wa-panel-clear').addEventListener('click', async () => {
      if (!confirm('Remove all annotations for this page? This will also clear all highlights.')) return;
      if (isContextValid()) {
        try { await chrome.storage.local.remove(PAGE_URL); } catch { }
      }
      document.querySelectorAll('.wa-highlight').forEach(mark => {
        const parent = mark.parentNode;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        mark.remove();
      });
      closeMarkPopover(false);
      removeHoverToolbar();
      refreshReviewPanel();
    });

    document.body.appendChild(panel);
    reviewPanel = panel;
    requestAnimationFrame(() => panel.classList.add('wa-panel-open'));
    if (panelTab) panelTab.classList.add('wa-panel-tab-active');
  }

  function toggleReviewPanel() {
    if (reviewPanel) { closeReviewPanel(); } else { openReviewPanel(); }
  }

  // Inject persistent toggle tab on the right edge of the page
  function initPanelTab() {
    if (panelTab) return;
    panelTab = document.createElement('button');
    panelTab.className = 'wa-panel-tab';
    panelTab.title = 'Toggle Highlights Panel';
    panelTab.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18.85 1.1L22.9 5.15a.5.5 0 010 .7L11.16 17.6l-4.95.55a1 1 0 01-1.1-1.1l.55-4.95L17.15 1.1a.5.5 0 01.7 0zM3 21h18v2H3v-2z"/>
      </svg>
    `;
    panelTab.addEventListener('click', toggleReviewPanel);
    document.body.appendChild(panelTab);
  }

  initPanelTab();

  // ── Restore highlights on page load ─────────────────────────────────────

  async function restoreHighlights() {
    if (!isContextValid()) return;

    // Re-inject panel tab if it was removed by SPA hydration
    if (!document.body.contains(panelTab)) {
      panelTab = null;
      initPanelTab();
    }

    try {
      const pageData = await getPageData();
      const annotations = pageData.annotations || [];
      if (annotations.length === 0) return;

      for (const ann of annotations) {
        if (document.querySelector(`.wa-highlight[data-annotation-id="${CSS.escape(ann.id)}"]`)) continue;
        findAndHighlightText(ann.text, ann.id, ann.comment);
      }
    } catch { }
  }

  function findAndHighlightText(searchText, id, comment) {
    if (!searchText || !searchText.trim()) return false;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;

    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('.wa-sel-popover, .wa-mark-popover, .wa-hover-toolbar, .wa-panel, .wa-panel-tab, .wa-highlight')) continue;
      textNodes.push(node);
    }

    // Single-node match (fast path)
    for (const tn of textNodes) {
      const idx = tn.textContent.indexOf(searchText);
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(tn, idx);
        range.setEnd(tn, idx + searchText.length);

        const mark = document.createElement('mark');
        mark.className = 'wa-highlight';
        mark.dataset.annotationId = id;
        mark.dataset.comment = comment || '';
        if (comment && comment.trim()) mark.classList.add('has-comment');

        try {
          range.surroundContents(mark);
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

      const mark = document.createElement('mark');
      mark.className = 'wa-highlight';
      mark.dataset.annotationId = id;
      mark.dataset.comment = comment || '';
      if (comment && comment.trim()) mark.classList.add('has-comment');
      mark.textContent = tn.textContent.slice(localStart, localEnd);

      const frag = document.createDocumentFragment();
      if (localStart > 0) frag.appendChild(document.createTextNode(tn.textContent.slice(0, localStart)));
      frag.appendChild(mark);
      if (localEnd < tn.textContent.length) frag.appendChild(document.createTextNode(tn.textContent.slice(localEnd)));

      tn.parentNode.replaceChild(frag, tn);
    }

    return true;
  }

  // Restore with retries — SPA frameworks (React, Vue, etc.) hydrate the DOM
  // after initial load, which destroys our <mark> elements. Retrying after
  // increasing delays ensures we restore after hydration finishes.
  (function scheduleRestore() {
    const delays = [0, 800, 2000, 4000];
    for (const delay of delays) {
      setTimeout(restoreHighlights, delay);
    }
  })();

  // ── Message listener (from popup) ────────────────────────────────────────

  if (isContextValid()) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'WA_CLEAR_ALL') {
        closeMarkPopover(false);
        removeHoverToolbar();
        closeReviewPanel();
        document.querySelectorAll('.wa-highlight').forEach(mark => {
          const parent = mark.parentNode;
          while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
          mark.remove();
        });
        if (panelTab) panelTab.remove(), panelTab = null;
        setTimeout(initPanelTab, 50);
      }
      if (msg.type === 'WA_TOGGLE_PANEL') toggleReviewPanel();
    });
  }

})();
