(() => {
  let lastRequest = 0;
  let pending;

  // Visible document text

  function visibleText() {
    if (
      document.visibilityState !== "visible" ||
      !document.hasFocus() ||
      !document.body
    )
      return null;
    if (
      [...document.querySelectorAll('input[type="password"]')].some(
        (field) =>
          field.getClientRects().length &&
          getComputedStyle(field).visibility !== "hidden",
      )
    )
      return null;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    const parts = [];
    let length = 0;
    let visited = 0;
    let current;

    while (
      (current = walker.nextNode()) &&
      visited++ < 15000 &&
      length < 30000
    ) {
      const parent = current.parentElement;
      const text = current.textContent?.replace(/\s+/g, " ").trim();

      if (
        !parent ||
        !text ||
        parent.closest(
          'script,style,noscript,input,textarea,select,[contenteditable],[hidden],[aria-hidden="true"]',
        )
      )
        continue;

      const style = getComputedStyle(parent);

      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        !parent.getClientRects().length
      )
        continue;

      const excerpt = text.slice(0, 30000 - length);

      parts.push(excerpt);
      length += excerpt.length + 1;
    }

    return {
      text: parts.join("\n").slice(0, 30000),
      title: document.title,
      url: location.href,
      capturedAt: new Date().toISOString(),
    };
  }

  function requestCapture() {
    if (
      document.visibilityState !== "visible" ||
      !document.hasFocus() ||
      Date.now() - lastRequest < 1800
    )
      return;

    lastRequest = Date.now();
    chrome.runtime.sendMessage({ type: "orbit:capture-ready" }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (
      sender.id === chrome.runtime.id &&
      message?.type === "orbit:read-visible"
    )
      respond(visibleText());
  });

  document.addEventListener("visibilitychange", requestCapture);
  window.addEventListener("focus", requestCapture);
  window.addEventListener("pageshow", requestCapture);

  new MutationObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(requestCapture, 800);
  }).observe(document.documentElement, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  setInterval(requestCapture, 3000);
  requestCapture();
})();
