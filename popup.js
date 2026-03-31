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

function buildLlmMarkdown(pageData, annotationsList) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    '# Page Notes',
    '',
    `**Source:** [${pageData.title}](${pageData.url})`,
    `**Annotated:** ${date}`,
    '',
  ];

  const sorted = [...annotationsList].sort((a, b) => a.createdAt - b.createdAt);

  for (const ann of sorted) {
    lines.push('---', '');
    lines.push('> ' + ann.text, '');
    if (ann.comment && ann.comment.trim()) {
      lines.push(ann.comment, '');
    }
  }

  return lines.join('\n');
}

function buildNotesMarkdown(pageData, annotationsList) {
  const lines = [
    `# ${pageData.title}`,
    `${pageData.url}`,
    '',
  ];

  const sorted = [...annotationsList].sort((a, b) => a.createdAt - b.createdAt);

  for (const ann of sorted) {
    lines.push('- ' + ann.text);
    if (ann.comment && ann.comment.trim()) {
      lines.push('  - ' + ann.comment);
    }
  }

  return lines.join('\n');
}


function renderList(annotations, container) {
  container.innerHTML = '';

  if (annotations.length === 0) {
    container.innerHTML = '<div class="empty-state">Nothing here yet.</div>';
    return;
  }

  for (const ann of annotations) {
    const item = document.createElement('div');
    item.className = 'annotation-item';
    item.innerHTML = `
      <div class="annotation-text">${escapeHtml(truncate(ann.text))}</div>
      ${ann.comment && ann.comment.trim() ? `<div class="annotation-comment">${escapeHtml(ann.comment)}</div>` : ''}
      <div class="annotation-time">${timeAgo(ann.createdAt)}</div>
    `;
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

  const result = await chrome.storage.local.get(url);
  const pageData = result[url];

  const titleEl = document.getElementById('page-title');
  titleEl.textContent = pageData ? pageData.title : (tab.title || 'This page');

  const list = document.getElementById('annotation-list');
  const footer = document.getElementById('footer');

  const sorted = pageData ? [...pageData.annotations].sort((a, b) => a.createdAt - b.createdAt) : [];
  const withNotes = sorted.filter(a => a.comment && a.comment.trim());

  document.getElementById('count-all').textContent = sorted.length;
  document.getElementById('count-notes').textContent = withNotes.length;

  // Get all sites count
  const allSites = await getAllSites();
  document.getElementById('count-sites').textContent = allSites.length;

  if (sorted.length > 0) {
    footer.style.display = 'block';
  }

  // Initial render
  let activeTab = 'all';
  renderList(sorted, list);

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.tab;

      if (activeTab === 'sites') {
        footer.style.display = 'none';
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
        renderList(activeTab === 'all' ? sorted : withNotes, list);
      }
    });
  });

  // Toggle Review Panel
  document.getElementById('panel-btn').addEventListener('click', async () => {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'WA_TOGGLE_PANEL' }); } catch { }
    window.close();
  });

  // Copy for LLM
  const copyLlmBtn = document.getElementById('copy-llm-btn');
  copyLlmBtn.addEventListener('click', async () => {
    const currentList = activeTab === 'notes' ? withNotes : sorted;
    const md = buildLlmMarkdown(pageData, currentList);
    await navigator.clipboard.writeText(md);
    copyLlmBtn.textContent = 'Copied!';
    setTimeout(() => { copyLlmBtn.textContent = 'Copy for LLM'; }, 2000);
  });

  // Copy as Notes
  const copyNotesBtn = document.getElementById('copy-notes-btn');
  copyNotesBtn.addEventListener('click', async () => {
    const currentList = activeTab === 'notes' ? withNotes : sorted;
    const md = buildNotesMarkdown(pageData, currentList);
    await navigator.clipboard.writeText(md);
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
