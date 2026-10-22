// Keyboard guard: injected at document_start, before any page script runs.
//
// The note editor lives in a closed shadow root, but keyboard, input and clipboard events from
// it still travel through window, document and the shadow host on their way in (capture phase).
// A page listening there in capture phase would see every key and every pasted word. Listeners
// on the same node fire in the order they were added, so these window listeners, added before
// the page could add its own, run first and stop the event from going any further.
//
// Stopping propagation does not cancel the browser's default action, so typing, IME input and
// paste still work in the editor. content.js sets WA_GUARD.host once its UI exists, and
// WA_GUARD.onKeydown to handle the editor's own shortcuts, since the event no longer reaches it.

const WA_GUARD = { host: null, onKeydown: null };

(function () {
  'use strict';

  const TYPES = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'textInput',
    'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'copy', 'cut'];

  for (const type of TYPES) {
    window.addEventListener(type, (e) => {
      // Seen from outside the closed shadow root, an event from our UI targets the host.
      if (!WA_GUARD.host || e.target !== WA_GUARD.host) return;
      e.stopImmediatePropagation();
      if (type === 'keydown' && e.isTrusted && WA_GUARD.onKeydown) WA_GUARD.onKeydown(e);
    }, true);
  }
})();
