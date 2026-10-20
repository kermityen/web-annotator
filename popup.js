// Popup logic: read annotations for current tab, display list, export markdown

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

function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function truncate(text, max = 80) {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const kb = bytes / 1024;
  if (kb < 1024) return kb.toFixed(1) + ' KB';
  const mb = kb / 1024;
  return mb.toFixed(2) + ' MB';
}

// Copy text is built by export-format.js (WA_EXPORT), shared with the in-page panel.

async function writeClipboard(text, html) {
  if (!html) return navigator.clipboard.writeText(text);
  return navigator.clipboard.write([new ClipboardItem({
    'text/plain': new Blob([text], { type: 'text/plain' }),
    'text/html': new Blob([html], { type: 'text/html' }),
  })]);
}

// Highlight ids in the order they appear on the page, asked of the page itself. Empty when
// the page has no content script (restricted page, or the site is switched off).
async function pageOrder(tabId) {
  try { return (await chrome.tabs.sendMessage(tabId, { type: 'WA_GET_PAGE_ORDER' })) || []; }
  catch { return []; }
}

function renderList(annotations, container, selectedIds, onToggle) {
  container.innerHTML = '';

  if (annotations.length === 0) {
    container.innerHTML = '<div class="empty-state">Nothing here yet.</div>';
    return;
  }

  for (const ann of annotations) {
    const item = document.createElement('div');
    item.className = 'annotation-item';
    item.innerHTML = `
      <input type="checkbox" class="annotation-check" ${selectedIds.has(ann.id) ? 'checked' : ''}>
      <div class="annotation-body">
        <div class="annotation-text">${escapeHtml(truncate(ann.text))}</div>
        ${ann.comment && ann.comment.trim() ? `<div class="annotation-comment">${escapeHtml(ann.comment)}</div>` : ''}
        <div class="annotation-time">${timeAgo(ann.createdAt)}</div>
      </div>
    `;
    const cb = item.querySelector('.annotation-check');
    cb.addEventListener('change', () => {
      if (cb.checked) selectedIds.add(ann.id); else selectedIds.delete(ann.id);
      if (onToggle) onToggle();
    });
    container.appendChild(item);
  }
}

function renderSitesList(sites, container, onDelete) {
  container.innerHTML = '';

  if (sites.length === 0) {
    container.innerHTML = '<div class="empty-state">No annotated sites.</div>';
    return;
  }

  for (const site of sites) {
    const item = document.createElement('div');
    item.className = 'site-item';

    const hostName = (() => {
      try { return new URL(site.url).hostname; } catch { return site.url; }
    })();

    item.innerHTML = `
      <div class="site-info">
        <div class="site-title">${escapeHtml(site.title || hostName)}</div>
        <div class="site-url">${escapeHtml(hostName)}</div>
        <div class="site-meta">${site.count} highlight${site.count !== 1 ? 's' : ''}${site.notesCount > 0 ? ' · ' + site.notesCount + ' note' + (site.notesCount !== 1 ? 's' : '') : ''}</div>
      </div>
      <button class="site-delete" title="Delete all annotations for this site">✕</button>
    `;

    item.querySelector('.site-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove all annotations for "${site.title || hostName}"?`)) return;
      await chrome.storage.local.remove(site.url);
      if (onDelete) onDelete();
    });

    item.querySelector('.site-info').style.cursor = 'pointer';
    item.querySelector('.site-info').addEventListener('click', () => {
      chrome.tabs.create({ url: site.url });
    });

    container.appendChild(item);
  }
}

async function getAllSites() {
  const allData = await chrome.storage.local.get(null);
  return Object.entries(allData)
    .filter(([, value]) => value && value.annotations && value.annotations.length > 0)
    .map(([url, data]) => ({
      url,
      title: data.title || '',
      count: data.annotations.length,
      notesCount: data.annotations.filter(a => a.comment && a.comment.trim()).length,
      lastVisited: data.lastVisited || 0
    }))
    .sort((a, b) => b.lastVisited - a.lastVisited);
}

async function updateStorageBar() {
  const bar = document.getElementById('storage-bar');
  try {
    const bytesInUse = await chrome.storage.local.getBytesInUse(null);
    const limit = 10 * 1024 * 1024; // 10 MB default
    bar.textContent = `Storage: ${formatBytes(bytesInUse)} / ${formatBytes(limit)}`;
  } catch {
    bar.textContent = '';
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = normalizeUrl(tab.url || '');

  document.getElementById('page-url').textContent = url;

  // Site toggle
  const siteToggle = document.getElementById('site-toggle');
  const hostname = (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })();
  const toggleData = await chrome.storage.local.get('wa_disabled_sites');
  const disabledSites = toggleData.wa_disabled_sites || [];
  siteToggle.checked = !disabledSites.includes(hostname);
  const panelBtn = document.getElementById('panel-btn');
  panelBtn.disabled = !siteToggle.checked;

  // Open tabs pick the change up through chrome.storage.onChanged, so every tab on this site
  // switches together.
  siteToggle.addEventListener('change', async () => {
    const data = await chrome.storage.local.get('wa_disabled_sites');
    const sites = data.wa_disabled_sites || [];
    if (siteToggle.checked) {
      const updated = sites.filter(s => s !== hostname);
      await chrome.storage.local.set({ wa_disabled_sites: updated });
    } else {
      if (!sites.includes(hostname)) sites.push(hostname);
      await chrome.storage.local.set({ wa_disabled_sites: sites });
    }
    panelBtn.disabled = !siteToggle.checked;
  });

  const result = await chrome.storage.local.get(url);
  const pageData = result[url];

  const titleEl = document.getElementById('page-title');
  titleEl.textContent = pageData ? pageData.title : (tab.title || 'This page');

  const list = document.getElementById('annotation-list');
  const footer = document.getElementById('footer');

  const sorted = pageData ? WA_EXPORT.orderBy(pageData.annotations, await pageOrder(tab.id)) : [];
  const withNotes = sorted.filter(a => a.comment && a.comment.trim());

  document.getElementById('count-all').textContent = sorted.length;
  document.getElementById('count-notes').textContent = withNotes.length;

  // Get all sites count
  const allSites = await getAllSites();
  document.getElementById('count-sites').textContent = allSites.length;

  if (sorted.length > 0) {
    footer.style.display = 'block';
  }

  // Selection state — default: everything selected
  const selectedIds = new Set(sorted.map(a => a.id));
  const selectAllRow = document.getElementById('select-all-row');
  const selectAllBox = document.getElementById('select-all');
  const copyLlmBtn = document.getElementById('copy-llm-btn');
  const copyNotesBtn = document.getElementById('copy-notes-btn');

  let activeTab = 'all';

  function currentTabList() {
    return activeTab === 'notes' ? withNotes : sorted;
  }

  function selectedOf(listArr) {
    return listArr.filter(a => selectedIds.has(a.id));
  }

  function updateSelectionUI() {
    const listArr = currentTabList();
    const sel = selectedOf(listArr).length;
    selectAllBox.checked = listArr.length > 0 && sel === listArr.length;
    selectAllBox.indeterminate = sel > 0 && sel < listArr.length;
    const countEl = document.getElementById('export-count');
    countEl.textContent = listArr.length === 0 ? '' : `${sel} / ${listArr.length} selected`;
    copyLlmBtn.disabled = sel === 0;
    copyNotesBtn.disabled = sel === 0;
  }

  selectAllBox.addEventListener('change', () => {
    const listArr = currentTabList();
    if (selectAllBox.checked) {
      listArr.forEach(a => selectedIds.add(a.id));
    } else {
      listArr.forEach(a => selectedIds.delete(a.id));
    }
    renderList(listArr, list, selectedIds, updateSelectionUI);
    updateSelectionUI();
  });

  // Initial render
  renderList(sorted, list, selectedIds, updateSelectionUI);
  if (sorted.length > 0) selectAllRow.style.display = 'flex';
  updateSelectionUI();

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.tab;

      if (activeTab === 'sites') {
        footer.style.display = 'none';
        selectAllRow.style.display = 'none';
        const sites = await getAllSites();
        document.getElementById('count-sites').textContent = sites.length;
        renderSitesList(sites, list, async () => {
          const refreshed = await getAllSites();
          document.getElementById('count-sites').textContent = refreshed.length;
          renderSitesList(refreshed, list, null);
          updateStorageBar();
        });
      } else {
        if (sorted.length > 0) footer.style.display = 'block';
        const listArr = currentTabList();
        selectAllRow.style.display = listArr.length > 0 ? 'flex' : 'none';
        renderList(listArr, list, selectedIds, updateSelectionUI);
        updateSelectionUI();
      }
    });
  });

  // Toggle Review Panel
  panelBtn.addEventListener('click', async () => {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'WA_TOGGLE_PANEL' }); } catch { }
    window.close();
  });

  // Copy for LLM
  copyLlmBtn.addEventListener('click', async () => {
    const currentList = selectedOf(currentTabList());
    if (currentList.length === 0) return;
    await writeClipboard(WA_EXPORT.forLlm(pageData, currentList));
    copyLlmBtn.textContent = 'Copied!';
    setTimeout(() => { copyLlmBtn.textContent = 'Copy for LLM'; }, 2000);
  });

  // Copy as Notes
  copyNotesBtn.addEventListener('click', async () => {
    const currentList = selectedOf(currentTabList());
    if (currentList.length === 0) return;
    const { text, html } = WA_EXPORT.forNotes(pageData, currentList);
    await writeClipboard(text, html);
    copyNotesBtn.textContent = 'Copied!';
    setTimeout(() => { copyNotesBtn.textContent = 'Copy as Notes'; }, 2000);
  });

  // Clear All
  document.getElementById('clear-btn').addEventListener('click', async () => {
    if (!confirm('Remove all annotations for this page? This will also clear all highlights.')) return;
    await chrome.storage.local.remove(url);
    try { await chrome.tabs.sendMessage(tab.id, { type: 'WA_CLEAR_ALL' }); } catch { }
    list.innerHTML = '<div class="empty-state">No annotations on this page.</div>';
    footer.style.display = 'none';
    selectAllRow.style.display = 'none';
    selectedIds.clear();
    document.getElementById('count-all').textContent = '0';
    document.getElementById('count-notes').textContent = '0';
    // Refresh sites count
    const sites = await getAllSites();
    document.getElementById('count-sites').textContent = sites.length;
    updateStorageBar();
  });

  // Storage usage
  updateStorageBar();
}

init();
