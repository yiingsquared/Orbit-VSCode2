let captureBusy = false;
let lastCapture = 0;
let lastIdentity = "";
let generation = 0;
let pendingCapture = null;
let contextWrites = Promise.resolve();

// Trusted extension storage

async function lockStorage() {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void lockStorage();
});
chrome.runtime.onStartup.addListener(() => {
  void lockStorage();
});
void lockStorage();

async function configuration() {
  const { orbitConnection, orbitPaused } = await chrome.storage.local.get([
    "orbitConnection",
    "orbitPaused",
  ]);

  return { connection: orbitConnection, paused: orbitPaused === true };
}

async function bridge(path, body, connection) {
  const headers = { "X-Orbit-Extension": chrome.runtime.id };

  if (connection.token) headers.Authorization = `Bearer ${connection.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${connection.baseUrl}/api/companion/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
    credentials: "omit",
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok)
    throw new Error(data.message || "Orbit could not complete this request.");

  return data;
}

function ordinaryPage(url) {
  try {
    const parsed = new URL(url);

    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) &&
      !/^(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com)$/.test(
        parsed.hostname,
      ) &&
      !/(^|\/)(login|sign-?in|oauth|authorize|password)(\/|$)/i.test(
        parsed.pathname,
      ) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function ownOrbitPage(url, connection) {
  try {
    const page = new URL(url);
    const orbit = new URL(connection.baseUrl);

    return (
      page.protocol === orbit.protocol &&
      page.port === orbit.port &&
      ["127.0.0.1", "localhost", "[::1]"].includes(page.hostname) &&
      ["/", "/index.html"].includes(page.pathname)
    );
  } catch {
    return false;
  }
}

async function activeFocusedTab(tabId) {
  const tab = await chrome.tabs.get(tabId);

  if (!tab.active || tab.incognito || !ordinaryPage(tab.url)) return null;

  const window = await chrome.windows.get(tab.windowId);

  return window.focused && window.state !== "minimized" ? tab : null;
}

// Ordered current-tab transitions

function writeContext(action) {
  const pending = contextWrites.then(action);

  contextWrites = pending.catch(() => {});
  return pending;
}

async function transitionTab(tabId, windowId) {
  const window = await chrome.windows.get(windowId);

  if (!window.focused || window.state === "minimized") return null;

  if (tabId !== null)
    return chrome.tabs
      .get(tabId)
      .catch(() => ({ id: tabId, windowId, url: "" }));

  const [tab] = await chrome.tabs.query({ active: true, windowId });

  return tab || null;
}

function changedTab(tabId, windowId, reason) {
  const version = ++generation;

  if (windowId === chrome.windows.WINDOW_ID_NONE) return;

  const tabPromise = transitionTab(tabId, windowId).catch(() => null);
  const invalidated = writeContext(async () => {
    const { connection } = await configuration();
    const tab = await tabPromise;

    if (!connection?.token || !tab || ownOrbitPage(tab.url, connection)) return;

    await bridge("invalidate", { source: "browser", reason }, connection);
  });

  // Every transition invalidates even if a newer tab wins the queue

  pendingCapture = { version, tabPromise, invalidated, forced: true };
  void drainCaptures();
}

function capture(tabId) {
  if (captureBusy || pendingCapture) return;

  pendingCapture = {
    version: generation,
    tabPromise: chrome.tabs.get(tabId).catch(() => null),
    invalidated: Promise.resolve(),
    forced: false,
  };
  void drainCaptures();
}

async function readCurrent(task) {
  await task.invalidated;

  if (task.version !== generation) return;

  const tab = await task.tabPromise;
  const { connection, paused } = await configuration();

  if (!tab || !connection?.token || paused || task.version !== generation)
    return;

  const current = await activeFocusedTab(tab.id);

  if (!current || task.version !== generation) return;
  if (current.status === "loading") return;

  const identity = `${current.windowId}:${current.id}:${current.url}`;

  if (
    !task.forced &&
    identity === lastIdentity &&
    Date.now() - lastCapture < 1400
  )
    return;

  const status = await bridge("state", undefined, connection);

  if (status.paused || task.version !== generation) return;

  const content = await chrome.tabs.sendMessage(current.id, {
    type: "orbit:read-visible",
  });
  const latest = await activeFocusedTab(current.id);

  if (!latest || latest.url !== current.url || task.version !== generation)
    return;

  await writeContext(async () => {
    if (task.version !== generation) return;

    if (!content?.text || content.url !== current.url) {
      await bridge(
        "invalidate",
        { source: "browser", reason: "unreadable-tab" },
        connection,
      );
      return;
    }

    await bridge(
      "context",
      {
        source: "browser",
        app: "chrome",
        title: latest.title || content.title || "",
        windowTitle: latest.title || content.title || "",
        url: latest.url,
        text: content.text,
        capturedAt: content.capturedAt,
      },
      connection,
    );
    lastIdentity = identity;
    lastCapture = Date.now();
  });
}

async function drainCaptures() {
  if (captureBusy) return;

  captureBusy = true;

  try {
    while (pendingCapture) {
      const task = pendingCapture;

      pendingCapture = null;

      try {
        await readCurrent(task);
      } catch {
        // Closed tabs and offline Orbit
      }
    }
  } finally {
    captureBusy = false;
    if (pendingCapture) void drainCaptures();
  }
}

chrome.tabs.onActivated.addListener((info) => {
  changedTab(info.tabId, info.windowId, "active-tab-changed");
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!tab.active) return;

  if (change.url || change.status === "loading")
    changedTab(tabId, tab.windowId, "tab-navigation");
  else if (change.status === "complete") {
    const version = ++generation;

    pendingCapture = {
      version,
      tabPromise: Promise.resolve(tab),
      invalidated: Promise.resolve(),
      forced: true,
    };
    void drainCaptures();
  }
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  changedTab(null, windowId, "focused-window-changed");
});

// Popup controls

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;

  if (message?.type === "orbit:capture-ready") {
    if (sender.tab?.id !== undefined && sender.frameId === 0)
      void capture(sender.tab.id);
    respond({ ok: true });
    return;
  }

  if (sender.tab) return;

  const action = (async () => {
    if (message?.type === "orbit:pair") {
      const code = String(message.code || "").trim();
      const match = /^(431\d|4320)-\d{8}$/.exec(code);

      if (!match)
        throw new Error(
          "Enter the pairing code shown in Orbit, including its port prefix.",
        );

      const baseUrl = `http://127.0.0.1:${match[1]}`;
      const result = await bridge(
        "pair",
        { code, kind: "extension", name: "Orbit Current Tab for Chrome" },
        { baseUrl },
      );

      await chrome.storage.local.set({
        orbitConnection: { baseUrl, token: result.token },
        orbitPaused: false,
      });
      return { paired: true, paused: false };
    }

    if (message?.type === "orbit:pause") {
      if (message.paused === true) {
        generation += 1;
        pendingCapture = null;

        const { connection } = await configuration();

        if (connection?.token)
          await writeContext(() =>
            bridge(
              "invalidate",
              { source: "browser", reason: "reading-paused" },
              connection,
            ),
          );
      }

      await chrome.storage.local.set({ orbitPaused: message.paused === true });
      return { ok: true };
    }

    if (message?.type === "orbit:disconnect") {
      generation += 1;
      pendingCapture = null;

      const { connection } = await configuration();

      if (connection?.token)
        await writeContext(() =>
          bridge(
            "invalidate",
            { source: "browser", reason: "extension-disconnected" },
            connection,
          ),
        );

      await chrome.storage.local.remove("orbitConnection");
      return { paired: false };
    }

    if (message?.type === "orbit:status") {
      const { connection, paused } = await configuration();

      if (!connection?.token) return { paired: false, paused };

      try {
        const status = await bridge("state", undefined, connection);

        return {
          paired: true,
          online: true,
          paused,
          serverPaused: status.paused,
          baseUrl: connection.baseUrl,
        };
      } catch {
        return {
          paired: true,
          online: false,
          paused,
          baseUrl: connection.baseUrl,
        };
      }
    }

    throw new Error("Unknown Orbit extension action.");
  })();

  action.then(
    (data) => respond({ ok: true, ...data }),
    (error) =>
      respond({
        ok: false,
        message: error.message || "Could not connect to Orbit.",
      }),
  );
  return true;
});
