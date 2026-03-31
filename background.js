// Service worker: handles storage read/write messages from content scripts

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_PAGE_DATA") {
    const key = message.url;
    chrome.storage.local.get(key, (result) => {
      sendResponse({ pageData: result[key] || null });
    });
    return true; // keep channel open for async response
  }

  if (message.type === "SAVE_PAGE_DATA") {
    const key = message.url;
    chrome.storage.local.set({ [key]: message.pageData }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "DELETE_ANNOTATION") {
    const key = message.url;
    chrome.storage.local.get(key, (result) => {
      const pageData = result[key];
      if (!pageData) { sendResponse({ ok: false }); return; }
      pageData.annotations = pageData.annotations.filter(a => a.id !== message.annotationId);
      chrome.storage.local.set({ [key]: pageData }, () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (message.type === "UPDATE_COMMENT") {
    const key = message.url;
    chrome.storage.local.get(key, (result) => {
      const pageData = result[key];
      if (!pageData) { sendResponse({ ok: false }); return; }
      const annotation = pageData.annotations.find(a => a.id === message.annotationId);
      if (annotation) annotation.comment = message.comment;
      chrome.storage.local.set({ [key]: pageData }, () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }
});
