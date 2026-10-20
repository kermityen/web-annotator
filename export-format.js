// Builds the text that "Copy for LLM" and "Copy as Notes" put on the clipboard.
// Shared by the in-page panel (content.js) and the toolbar popup (popup.js) so both copy the
// exact same thing.

const WA_EXPORT = (() => {
  // Query parameters that are dropped from the copied source link: ad/campaign trackers, plus
  // anything that looks like a credential, so a pasted link never carries a login token.
  const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi|ref_src)$/i;
  const SENSITIVE_EXACT = /^(sid|key|apikey|api_key|code|state|sig|email)$/i;
  const SENSITIVE_PART = /token|auth|session|secret|password|passwd|signature|credential|jwt|otp|nonce/i;

  function cleanUrl(url) {
    try {
      const u = new URL(url);
      for (const name of [...u.searchParams.keys()]) {
        if (TRACKING.test(name) || SENSITIVE_EXACT.test(name) || SENSITIVE_PART.test(name)) {
          u.searchParams.delete(name);
        }
      }
      u.hash = '';
      return u.toString().replace(/\?$/, '');
    } catch {
      return url;
    }
  }

  // Highlights in the order they appear in the article. `idsInPageOrder` comes from the page;
  // anything not found there (e.g. the page changed) goes last, oldest first.
  function orderBy(annotations, idsInPageOrder) {
    const rank = new Map((idsInPageOrder || []).map((id, i) => [id, i]));
    return annotations.slice().sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
      const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
      if (ra !== rb) return ra - rb;
      return a.createdAt - b.createdAt;
    });
  }

  // Selected text often carries stray whitespace from the page's layout.
  function lines(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(l => l.replace(/[ \t ]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .split('\n');
  }

  function title(page) {
    const t = String(page.title || '').trim();
    if (t) return t;
    try { return new URL(page.url).hostname; } catch { return 'Untitled page'; }
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  // Markdown for an AI assistant: every quoted line starts with ">", and the user's own words
  // are labelled, so the model never mistakes a note for the article's text.
  function forLlm(page, annotations) {
    const out = [
      `# Highlights from "${title(page)}"`,
      '',
      `Source: ${cleanUrl(page.url)}`,
      `Copied: ${today()}`,
      '',
    ];
    for (const ann of annotations) {
      out.push('---', '');
      out.push(...lines(ann.text).map(l => (l ? '> ' + l : '>')), '');
      const note = lines(ann.comment);
      if (note.join('').trim()) {
        out.push('My note: ' + note[0], ...note.slice(1), '');
      }
    }
    return out.join('\n').trimEnd() + '\n';
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // A plain markdown list for Obsidian, plus the same content as HTML, which Notion and
  // Apple Notes turn into a real heading and bullet list when pasted.
  function forNotes(page, annotations) {
    const url = cleanUrl(page.url);
    const md = [`# ${title(page)}`, url, ''];
    const html = [`<h2>${escapeHtml(title(page))}</h2>`, `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`, '<ul>'];

    for (const ann of annotations) {
      const quote = lines(ann.text);
      const note = lines(ann.comment);
      const hasNote = !!note.join('').trim();

      md.push('- ' + quote[0], ...quote.slice(1).map(l => (l ? '  ' + l : '')));
      if (hasNote) md.push('  - ' + note[0], ...note.slice(1).map(l => (l ? '    ' + l : '')));

      // The newline after each <br> keeps a space between lines in apps that drop <br> (Notion).
      html.push('<li>' + quote.map(escapeHtml).join('<br>\n'));
      if (hasNote) html.push('<ul><li>' + note.map(escapeHtml).join('<br>\n') + '</li></ul>');
      html.push('</li>');
    }
    html.push('</ul>');

    return { text: md.join('\n').trimEnd() + '\n', html: html.join('') };
  }

  return { cleanUrl, orderBy, forLlm, forNotes };
})();
