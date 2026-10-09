// Styles for the extension's own UI (popovers, toolbar, note editor, review panel, toast).
// They are applied inside a closed shadow root created by content.js, so the host page can
// neither read that UI nor restyle it. Highlight <mark> styles stay in content.css, because
// the marks have to live in the page's own DOM.

const WA_UI_CSS = `
/* ── Selection popover (dark, Medium-style toolbar) ─────────────────────── */

.wa-sel-popover {
  position: absolute;
  z-index: 2147483647;
  background: #1a1a1a;
  border-radius: 8px;
  padding: 5px 6px;
  box-shadow: 0 3px 14px rgba(0, 0, 0, 0.28);
  display: flex;
  align-items: center;
  filter: drop-shadow(0 3px 8px rgba(0,0,0,0.2));
}

.wa-sel-popover::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 6px solid transparent;
  border-top-color: #1a1a1a;
}

.wa-sel-hl-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: #fff;
  padding: 5px 10px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 5px;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  white-space: nowrap;
  line-height: 1;
}

.wa-sel-hl-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.wa-sel-hl-btn svg {
  flex-shrink: 0;
}

/* ── Hover toolbar (Unhighlight / Note) ─────────────────────────────────── */

.wa-hover-toolbar {
  position: absolute;
  z-index: 2147483647;
  background: #1a1a1a;
  border-radius: 8px;
  padding: 4px 5px;
  box-shadow: 0 3px 14px rgba(0, 0, 0, 0.28);
  display: flex;
  align-items: center;
  gap: 1px;
  filter: drop-shadow(0 3px 8px rgba(0,0,0,0.2));
  pointer-events: all;
}

.wa-hover-toolbar::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 6px solid transparent;
  border-top-color: #1a1a1a;
}

.wa-ht-btn {
  background: none;
  border: none;
  color: #fff;
  padding: 4px 9px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 5px;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  white-space: nowrap;
  line-height: 1;
}

.wa-ht-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.wa-ht-unhighlight {
  color: #fff;
}

.wa-ht-sep {
  width: 1px;
  height: 14px;
  background: rgba(255, 255, 255, 0.18);
  margin: 0 1px;
  flex-shrink: 0;
}

/* ── Note / comment popover (Medium Private Notes style) ──────────────── */

.wa-mark-popover {
  position: absolute;
  z-index: 2147483647;
  background: #fff;
  border: none;
  border-radius: 6px;
  padding: 16px 18px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15), 0 4px 16px rgba(0, 0, 0, 0.08);
  width: 400px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.wa-mp-textarea {
  width: 100%;
  border: none;
  border-radius: 0;
  padding: 0;
  font-size: 14px;
  resize: none;
  font-family: inherit;
  box-sizing: border-box;
  outline: none;
  line-height: 1.6;
  color: #292929;
  background: transparent;
  min-height: 220px;
}

.wa-mp-textarea::placeholder {
  color: #b3b3b1;
}

.wa-mp-footer {
  display: flex;
  gap: 16px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #f0f0f0;
}

.wa-mp-footer button {
  flex: 1;
  padding: 8px 0;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}

.wa-mp-save {
  background: #1a1a1a;
  color: #fff;
}

.wa-mp-save:hover {
  background: #333;
}

.wa-mp-cancel {
  background: #f5f5f5;
  color: #666;
}

.wa-mp-cancel:hover {
  background: #e8e8e8;
}

/* ── Panel toggle tab ───────────────────────────────────────────────────── */

.wa-panel-tab {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2147483645;
  background: #1a1a1a;
  color: #fff;
  border: none;
  width: 30px;
  height: 52px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px 0 0 8px;
  box-shadow: -2px 0 10px rgba(0,0,0,0.18);
  transition: right 0.24s ease, background 0.15s;
  padding: 0;
}

.wa-panel-tab:hover {
  background: #333;
}

.wa-panel-tab.wa-panel-tab-active {
  right: 360px;
  background: #1a73e8;
}

/* ── Review Panel ───────────────────────────────────────────────────────── */

.wa-panel {
  position: fixed;
  top: 0;
  right: 0;
  width: 360px;
  height: 100%;
  background: #fff;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.13);
  z-index: 2147483644;
  display: flex;
  flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  transform: translateX(100%);
  transition: transform 0.24s ease;
  overflow: hidden;
}

.wa-panel-open {
  transform: translateX(0);
}

.wa-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid #f0f0f0;
  flex-shrink: 0;
  background: #fff;
}

.wa-panel-title {
  font-size: 14px;
  font-weight: 600;
  color: #1a1a1a;
}

.wa-panel-count {
  display: inline-block;
  background: #f0f0f0;
  color: #666;
  font-size: 10px;
  font-weight: 600;
  border-radius: 10px;
  padding: 1px 7px;
  margin-left: 5px;
  vertical-align: middle;
}

.wa-panel-close {
  background: none;
  border: none;
  color: #999;
  font-size: 13px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
  line-height: 1;
  font-family: inherit;
}

.wa-panel-close:hover {
  background: #f5f5f5;
  color: #1a1a1a;
}

.wa-panel-body {
  overflow-y: auto;
  flex: 1;
  padding: 4px 0;
}

.wa-panel-empty {
  padding: 36px 16px;
  text-align: center;
  color: #aaa;
  font-size: 13px;
}

.wa-panel-item {
  padding: 11px 16px;
  border-bottom: 1px solid #f5f5f5;
  cursor: pointer;
  transition: background 0.1s;
}

.wa-panel-item:hover {
  background: #fafafa;
}

.wa-panel-item:last-child {
  border-bottom: none;
}

.wa-panel-quote {
  font-size: 13px;
  line-height: 1.45;
  color: #1a1a1a;
  background: rgba(255, 220, 0, 0.32);
  border-radius: 2px;
  padding: 1px 4px;
  display: inline;
}

.wa-panel-quote::before {
  content: '"';
  color: #e8a000;
  font-weight: 700;
  margin-right: 1px;
}

.wa-panel-note {
  font-size: 12px;
  color: #555;
  font-style: italic;
  margin-top: 6px;
  line-height: 1.45;
  padding-left: 2px;
}

/* ── Panel footer ──────────────────────────────────────────────────────── */

.wa-panel-footer {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid #f0f0f0;
  flex-shrink: 0;
}

.wa-panel-footer button {
  flex: 1;
  padding: 7px 0;
  border-radius: 6px;
  font-size: 12px;
  white-space: nowrap;
  font-weight: 500;
  cursor: pointer;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  border: none;
}

.wa-panel-copy-llm {
  background: #1a1a1a;
  color: #fff;
}

.wa-panel-copy-llm:hover {
  background: #333;
}

.wa-panel-copy-notes {
  background: #1a1a1a;
  color: #fff;
}

.wa-panel-copy-notes:hover {
  background: #333;
}

.wa-panel-clear {
  background: #f5f5f5;
  color: #d32f2f;
}

.wa-panel-clear:hover {
  background: #ffe0e0;
}


/* ── Export multi-select ── */

.wa-panel-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
}

.wa-panel-check {
  margin-top: 3px;
  flex-shrink: 0;
  accent-color: #1a73e8;
  cursor: pointer;
}

.wa-panel-item-body {
  flex: 1;
  min-width: 0;
}

.wa-panel-selectbar {
  padding: 8px 16px;
  border-bottom: 1px solid #f5f5f5;
  font-size: 12px;
  color: #666;
  background: #fff;
  flex-shrink: 0;
}

.wa-panel-selectbar label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  width: max-content;
}

.wa-panel-selectbar input {
  accent-color: #1a73e8;
  cursor: pointer;
}

.wa-panel-footer button:disabled {
  opacity: 0.45;
  cursor: default;
}

/* ── Panel footer: 2/1 layout + export count ── */

.wa-panel-footer {
  flex-direction: column;
  gap: 6px;
}

.wa-panel-footer-row {
  display: flex;
  gap: 8px;
}

.wa-panel-footer-row button {
  flex: 1;
}

.wa-panel-export-count {
  font-size: 11px;
  color: #888;
}

.wa-panel-export-count:empty {
  display: none;
}

/* ── Toast ─────────────────────────────────────────────────────────────── */

.wa-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(480px, calc(100vw - 32px));
  background: #1a1a1a;
  color: #fff;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.4;
  text-align: center;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  pointer-events: none;
}

`;
