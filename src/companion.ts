export type CompanionContext = {
  source: "browser" | "desktop";
  title: string;
  windowTitle: string;
  app: string;
  text: string;
  url: string;
  capturedAt: string;
  receivedAt: number;
};

type Selection = { provider: string; model: string };
type Reply = { text: string; error?: string };
type MessageEvent = {
  id: number;
  text: string;
  context?: CompanionContext | null;
};
type InboxEvent = {
  id: number;
  type: "context" | "message" | "context-invalidated";
  text?: string;
  context?: CompanionContext | null;
};
type Status = {
  desktopConnected: boolean;
  extensionConnected: boolean;
  pairedDesktop: number;
  pairedExtension: number;
  paused: boolean;
  hidden: boolean;
  contextSource: string | null;
  contextFresh: boolean;
};

export type InitCompanionOptions = {
  enabled?: () => boolean;
  getSelection: () => Selection;
  isBusy: () => boolean;
  onContext?: (context: CompanionContext) => Promise<void>;
  onMessage: (message: MessageEvent) => Promise<Reply>;
};

export type CompanionOptions = InitCompanionOptions;

type SavedReply = Reply & {
  messageId: number;
  createdAt: number;
  instanceId: string;
};
let selectionChanged = (): void => {};
let stopPrevious = (): void => {};
let resetCurrentSession = (): void => {};
let canPublishReplies = (): boolean => false;

export type CompanionReplyIdentity = {
  chatId: string;
  messageId: string;
  revision: string;
};

export type CompanionReplyNotice = CompanionReplyIdentity & {
  text: string;
  error?: string;
};

type NoticeEntry = CompanionReplyIdentity & {
  text?: string;
  read: boolean;
  version: number;
};

type NoticeTransport = (route: string, body: unknown) => Promise<unknown>;

// Completion and read delivery

export function createCompanionReplyNotifier(
  storage: Pick<Storage, "getItem" | "setItem"> | null = null,
) {
  const entries = new Map<string, NoticeEntry>();
  const read = new Set<string>();
  const published = new Set<string>();
  let transport: NoticeTransport | null = null;
  let clientId = "";
  let running: Promise<void> | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let connection = 0;

  function key(identity: CompanionReplyIdentity): string {
    return JSON.stringify([
      identity.chatId,
      identity.messageId,
      identity.revision,
    ]);
  }

  function valid(identity: CompanionReplyIdentity): boolean {
    return [identity.chatId, identity.messageId, identity.revision].every(
      (value) =>
        typeof value === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(value),
    );
  }

  function save(): void {
    while (read.size > 1000) read.delete(read.values().next().value!);
    while (published.size > 1000)
      published.delete(published.values().next().value!);

    try {
      storage?.setItem(
        "orbit.companion.notifications.v1",
        JSON.stringify({
          entries: [...entries.values()].slice(-100),
          read: [...read],
          published: [...published],
        }),
      );
    } catch {
      // Current page retains pending notifications
    }
  }

  try {
    const saved = JSON.parse(
      storage?.getItem("orbit.companion.notifications.v1") || "{}",
    );

    for (const identity of Array.isArray(saved.entries) ? saved.entries : []) {
      if (valid(identity))
        entries.set(key(identity), {
          chatId: identity.chatId,
          messageId: identity.messageId,
          revision: identity.revision,
          text:
            typeof identity.text === "string"
              ? identity.text.slice(0, 4096)
              : undefined,
          read: identity.read === true,
          version: 0,
        });
    }

    for (const value of Array.isArray(saved.read) ? saved.read : [])
      if (typeof value === "string" && value.length < 400) read.add(value);

    for (const value of Array.isArray(saved.published) ? saved.published : [])
      if (typeof value === "string" && value.length < 400) published.add(value);
  } catch {
    // Storage unavailable
  }

  function schedule(): void {
    if (!transport || retry) return;

    retry = setTimeout(() => {
      retry = undefined;
      void flush();
    }, 1200);
  }

  async function drain(): Promise<void> {
    const generation = connection;

    while (transport && connection === generation && entries.size) {
      const [id, entry] = entries.entries().next().value!;
      const version = entry.version;
      const send = transport;
      const identity = {
        clientId,
        chatId: entry.chatId,
        messageId: entry.messageId,
        revision: entry.revision,
      };

      try {
        if (entry.read && !read.has(id)) {
          await send("reply-read", identity);
          if (!transport || connection !== generation) return;
          read.add(id);
          save();
        }

        if (entry.text !== undefined && !published.has(id)) {
          await send("reply-published", {
            ...identity,
            text: entry.text,
            read: entry.read || read.has(id),
          });
          if (!transport || connection !== generation) return;
          published.add(id);
          save();
        }

        if (entries.get(id)?.version === version) entries.delete(id);
        save();
      } catch {
        schedule();
        return;
      }
    }
  }

  function flush(): Promise<void> {
    if (running) return running;
    if (!transport || !entries.size) return Promise.resolve();

    const operation = drain().finally(() => {
      if (running === operation) running = null;
      if (transport && entries.size) schedule();
    });
    running = operation;
    return running;
  }

  function enqueue(
    identity: CompanionReplyIdentity,
    text?: string,
    isRead = false,
  ): Promise<void> {
    if (!valid(identity)) return Promise.resolve();

    const id = key(identity);
    if (isRead && read.has(id)) return Promise.resolve();
    if (text !== undefined && published.has(id)) return Promise.resolve();

    const previous = entries.get(id);

    entries.set(id, {
      ...identity,
      text: text === undefined ? previous?.text : text.slice(0, 4096),
      read: isRead || previous?.read === true || read.has(id),
      version: (previous?.version || 0) + 1,
    });
    save();
    return flush();
  }

  return {
    publish: (notice: CompanionReplyNotice): Promise<void> =>
      !notice.error && notice.text.trim()
        ? enqueue(notice, notice.text)
        : Promise.resolve(),
    read: (identity: CompanionReplyIdentity): Promise<void> =>
      enqueue(identity, undefined, true),
    connect(send: NoticeTransport, id: string): void {
      connection += 1;
      transport = send;
      clientId = id;
      if (retry) clearTimeout(retry);
      retry = undefined;
      void flush();
    },
    disconnect(): void {
      connection += 1;
      transport = null;
      if (retry) clearTimeout(retry);
      retry = undefined;
    },
    reset(): void {
      connection += 1;
      transport = null;
      clientId = "";
      running = null;
      if (retry) clearTimeout(retry);
      retry = undefined;
      entries.clear();
      read.clear();
      published.clear();
      save();
    },
    flush,
  };
}

function notificationStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

const replyNotifications = createCompanionReplyNotifier(notificationStorage());

export function publishCompanionReply(
  notice: CompanionReplyNotice,
): Promise<void> {
  return canPublishReplies()
    ? replyNotifications.publish(notice)
    : Promise.resolve();
}

export function markCompanionReplyRead(
  identity: CompanionReplyIdentity,
): Promise<void> {
  return canPublishReplies()
    ? replyNotifications.read(identity)
    : Promise.resolve();
}

export function resetCompanionSession(): void {
  replyNotifications.reset();

  try {
    const storage =
      typeof sessionStorage === "undefined"
        ? notificationStorage()
        : sessionStorage;

    for (const key of [
      "orbit.companion.client.v1",
      "orbit.companion.outbox.v1",
      "orbit.companion.notifications.v1",
    ]) {
      storage?.removeItem(key);
    }
  } catch {
    // Current transport still resets
  }

  resetCurrentSession();
}

// Selection changes from Orbit

export function notifyCompanionSelection(): void {
  selectionChanged();
}

export function initCompanion(options: InitCompanionOptions): () => void {
  stopPrevious();

  const statusElement = document.getElementById("companion-status");
  const hideButton = document.getElementById(
    "hide-companion",
  ) as HTMLButtonElement | null;
  const pauseButton = document.getElementById(
    "pause-companion",
  ) as HTMLButtonElement | null;
  const quitButton = document.getElementById(
    "quit-companion",
  ) as HTMLButtonElement | null;
  const controlsPanel = document.getElementById("companion-controls");
  const companionDialog = document.getElementById(
    "companion-dialog",
  ) as HTMLDialogElement | null;
  let clientId = "";
  const completed = new Map<number, SavedReply>();
  const lifecycle = new AbortController();
  const listener = { signal: lifecycle.signal };

  let cursor = 0;
  let instanceId = "";
  let paused = false;
  let hidden = false;
  let polling = false;
  let pollAgain = false;
  let stopped = true;
  let disposed = false;
  let sessionSuspended = false;
  let transportGeneration = 0;
  let notificationsConnected = false;
  let pollTimer: ReturnType<typeof setTimeout>;
  let heartbeat: ReturnType<typeof setInterval>;
  let bridgeAbort = new AbortController();
  let statusCount = 0;
  let desktopConnected = false;

  try {
    const saved = JSON.parse(
      sessionStorage.getItem("orbit.companion.outbox.v1") || "[]",
    );

    if (Array.isArray(saved))
      for (const reply of saved) {
        if (
          reply &&
          Number.isSafeInteger(reply.messageId) &&
          typeof reply.text === "string" &&
          typeof reply.instanceId === "string" &&
          reply.text.length <= 150000 &&
          Date.now() - reply.createdAt < 600000
        )
          completed.set(reply.messageId, reply);
      }
  } catch {
    // Storage unavailable
  }

  function savedClientId(): string {
    try {
      const existing = sessionStorage.getItem("orbit.companion.client.v1");

      if (existing && /^[a-zA-Z0-9_-]{8,100}$/.test(existing)) return existing;

      const id = crypto.randomUUID();

      sessionStorage.setItem("orbit.companion.client.v1", id);
      return id;
    } catch {
      return crypto.randomUUID();
    }
  }

  function saveOutbox(): void {
    try {
      sessionStorage.setItem(
        "orbit.companion.outbox.v1",
        JSON.stringify([...completed.values()].slice(-10)),
      );
    } catch {
      // Current session still retains replies
    }
  }

  function ensureClientId(): string {
    clientId ||= savedClientId();
    return clientId;
  }

  function routeEnabled(): boolean {
    try {
      return options.enabled?.() !== false;
    } catch {
      return false;
    }
  }

  function canProcessMessages(): boolean {
    return !disposed && !stopped && !sessionSuspended && routeEnabled();
  }

  function syncNotifications(): void {
    const enabled = canProcessMessages();

    if (enabled && !notificationsConnected) {
      notificationsConnected = true;
      replyNotifications.connect((route, body) => {
        if (!canProcessMessages())
          return Promise.reject(
            new DOMException("Companion routing is paused", "AbortError"),
          );
        return request(route, body);
      }, ensureClientId());
    } else if (!enabled && notificationsConnected) {
      notificationsConnected = false;
      replyNotifications.disconnect();
    }
  }

  async function request<T>(route: string, body?: unknown): Promise<T> {
    if (disposed || stopped)
      throw new DOMException("Companion transport stopped", "AbortError");

    const response = await fetch(`/api/companion/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: bridgeAbort.signal,
      credentials: "same-origin",
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok)
      throw new Error(
        data.message || "Orbit could not connect to the companion.",
      );

    return data as T;
  }

  function showStatus(text: string): void {
    if (disposed || stopped) return;
    if (statusElement) {
      statusElement.textContent = text;
      statusElement.hidden = !text;
    }
  }

  // Download receipt for this installer

  const downloadButton = document.getElementById(
    "download-companion",
  ) as HTMLAnchorElement | null;
  const downloadLabel = document.getElementById("download-companion-label");
  const downloadArrow = document.getElementById("download-companion-arrow");
  const downloadCheck = document.getElementById("download-companion-check");
  let downloaded = false;
  let downloading = false;
  let installerId = "";

  function renderDownload(): void {
    if (disposed) return;
    if (downloadLabel)
      downloadLabel.textContent = downloading
        ? "Downloading…"
        : downloaded
          ? "Downloaded"
          : "Download";
    downloadArrow?.toggleAttribute("hidden", downloaded || downloading);
    downloadCheck?.toggleAttribute("hidden", !downloaded || downloading);
    downloadButton?.setAttribute("aria-busy", String(downloading));
    renderControls();
  }

  const installerReady = downloadButton
    ? fetch("/downloads/installer.json", {
        cache: "no-store",
        signal: lifecycle.signal,
      })
        .then(async (response) => {
          if (disposed) return;
          if (!response.ok) throw new Error("Installer metadata unavailable");
          const metadata = await response.json();
          if (disposed) return;
          if (!/^[a-f0-9]{64}$/.test(metadata.sha256)) return;
          installerId = metadata.sha256;
          try {
            downloaded ||=
              window.localStorage.getItem("orbit.companion.download.v1") ===
              installerId;
          } catch {
            // Current visit retains download state
          }
          renderDownload();
        })
        .catch(() => {})
    : Promise.resolve();

  downloadButton?.addEventListener(
    "click",
    (event) => {
      event.preventDefault();
      if (downloading || disposed || stopped) return;
      const generation = transportGeneration;
      const signal = bridgeAbort.signal;
      downloading = true;
      renderDownload();

      void (async () => {
        await installerReady;
        if (disposed || stopped || generation !== transportGeneration) return;
        const response = await fetch("/api/companion/installer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          credentials: "same-origin",
          cache: "no-store",
          signal,
        });
        if (!response.ok)
          throw new Error("Could not download Orbit. Please try again.");
        const file = await response.blob();
        if (disposed || stopped || generation !== transportGeneration) return;
        if (!file.size)
          throw new Error(
            "The installer download was empty. Please try again.",
          );

        const address = URL.createObjectURL(file);
        const link = document.createElement("a");
        link.href = address;
        link.download = "Orbit-Setup.exe";
        link.hidden = true;
        document.body.append(link);
        try {
          link.click();
        } finally {
          link.remove();
          setTimeout(() => URL.revokeObjectURL(address), 1000);
        }
        downloaded = true;
        try {
          if (installerId)
            window.localStorage.setItem(
              "orbit.companion.download.v1",
              installerId,
            );
        } catch {
          // Download remains available
        }
        window.dispatchEvent(
          new CustomEvent("orbit:companion-downloaded", {
            detail: { installerId: installerId || null },
          }),
        );
      })()
        .catch((error) => {
          if (
            !disposed &&
            generation === transportGeneration &&
            !signal.aborted
          )
            showStatus(error.message || "Could not download Orbit.");
        })
        .finally(() => {
          if (generation !== transportGeneration || disposed) return;
          downloading = false;
          renderDownload();
        });
    },
    listener,
  );

  function renderControls(): void {
    if (disposed) return;
    const available = downloaded || desktopConnected;
    if (controlsPanel) controlsPanel.hidden = !available;
    if (hideButton) {
      hideButton.hidden = !available;
      hideButton.disabled = !desktopConnected;
      hideButton.textContent = hidden ? "Unhide" : "Hide";
      hideButton.setAttribute("aria-pressed", String(hidden));
    }
    if (pauseButton) {
      pauseButton.hidden = !available;
      pauseButton.disabled = !desktopConnected;
      pauseButton.textContent = paused ? "Resume reading" : "Pause reading";
    }
    if (quitButton) {
      quitButton.hidden = !available;
      quitButton.disabled = !desktopConnected;
    }
  }

  async function updateSelection(takeControl = false): Promise<void> {
    if (!canProcessMessages()) {
      syncNotifications();
      return;
    }
    const selection = options.getSelection();

    if (stopped || !selection.provider || !selection.model) return;

    await request("selection", {
      clientId: ensureClientId(),
      ...selection,
      visible: document.visibilityState === "visible",
      focused: document.hasFocus(),
      takeControl,
    });
  }

  async function refreshStatus(): Promise<void> {
    const generation = transportGeneration;
    const status = await request<Status>("status");

    if (disposed || stopped || generation !== transportGeneration) return;

    paused = status.paused;
    hidden = status.hidden === true;
    desktopConnected = status.desktopConnected;
    if (desktopConnected) downloaded = true;
    renderDownload();

    if (paused && status.desktopConnected) {
      showStatus("Reading paused");
    } else showStatus("");
  }

  async function acknowledge(eventId: number): Promise<void> {
    if (!canProcessMessages()) return;
    await request("ack", { clientId, eventId });
    cursor = eventId;
  }

  // Sequential delivery and reply outbox

  async function deliverContext(context: CompanionContext): Promise<void> {
    try {
      await options.onContext?.(context);
    } catch {
      // Optional context display must not block delivery
    }
  }

  async function processEvent(event: InboxEvent): Promise<boolean> {
    const generation = transportGeneration;
    if (!canProcessMessages()) return false;
    if (event.type === "context-invalidated") {
      await acknowledge(event.id);
      return true;
    }

    if (event.type === "context") {
      if (event.context) {
        await deliverContext(event.context);
        if (!canProcessMessages() || generation !== transportGeneration)
          return false;
      }

      await acknowledge(event.id);
      return true;
    }

    if (event.type !== "message" || !event.text) {
      await acknowledge(event.id);
      return true;
    }

    let result = completed.get(event.id);

    if (!result) {
      if (options.isBusy()) return false;

      if (event.context) {
        await deliverContext(event.context);
        if (!canProcessMessages() || generation !== transportGeneration)
          return false;
      }

      if (
        options.isBusy() ||
        !canProcessMessages() ||
        generation !== transportGeneration
      )
        return false;

      let response: Reply;

      try {
        response = await options.onMessage({
          id: event.id,
          text: event.text,
          context: event.context,
        });
      } catch (error) {
        response = {
          text: "",
          error:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Orbit could not complete this message.",
        };
      }

      if (!canProcessMessages() || generation !== transportGeneration)
        return false;

      result = {
        messageId: event.id,
        text: response.text || "",
        error: response.error,
        createdAt: Date.now(),
        instanceId,
      };
      completed.set(event.id, result);
      saveOutbox();
    }

    if (!canProcessMessages() || generation !== transportGeneration)
      return false;

    await request("reply", {
      clientId,
      messageId: event.id,
      text: result.text,
      error: result.error,
    });
    await acknowledge(event.id);
    completed.delete(event.id);
    saveOutbox();
    return true;
  }

  async function poll(): Promise<void> {
    if (stopped || polling) return;

    polling = true;
    const generation = transportGeneration;
    syncNotifications();

    try {
      if (!canProcessMessages()) {
        await refreshStatus();
        return;
      }

      const inbox = await request<{
        instanceId: string;
        events: InboxEvent[];
        cursor: number;
        active: boolean;
      }>(
        `events?clientId=${encodeURIComponent(ensureClientId())}&after=${cursor}`,
      );

      if (!canProcessMessages() || generation !== transportGeneration) return;

      if (instanceId !== inbox.instanceId) {
        instanceId = inbox.instanceId;
        cursor = 0;

        for (const [id, reply] of completed)
          if (reply.instanceId !== instanceId) completed.delete(id);

        saveOutbox();
      }

      if (inbox.active) {
        for (const event of inbox.events) {
          if (
            !canProcessMessages() ||
            generation !== transportGeneration ||
            !(await processEvent(event))
          )
            break;
        }
      }

      if (inbox.cursor < cursor && !inbox.events.length) cursor = inbox.cursor;
      if (++statusCount % 4 === 0) await refreshStatus();
    } catch {
      if (!stopped && generation === transportGeneration)
        showStatus("Orbit is reconnecting to the companion…");
    } finally {
      if (generation === transportGeneration) polling = false;
      if (!stopped && !disposed && generation === transportGeneration)
        pollTimer = setTimeout(
          () => {
            void poll();
          },
          pollAgain ? 0 : 1200,
        );
      if (generation === transportGeneration) pollAgain = false;
    }
  }

  function onFocus(): void {
    syncNotifications();
    void updateSelection(true).catch(() => {});
  }

  function onSelection(): void {
    if (disposed) return;
    if (routeEnabled()) sessionSuspended = false;
    if (stopped) start();
    syncNotifications();
    void updateSelection(document.hasFocus()).catch(() => {});
    clearTimeout(pollTimer);
    if (polling) pollAgain = true;
    else void poll();
  }

  function stop(): void {
    stopped = true;
    transportGeneration += 1;
    polling = false;
    pollAgain = false;
    clearTimeout(pollTimer);
    clearInterval(heartbeat);
    bridgeAbort.abort();
    replyNotifications.disconnect();
    notificationsConnected = false;
  }

  function start(): void {
    if (disposed || !stopped) return;
    stopped = false;
    transportGeneration += 1;
    bridgeAbort = new AbortController();
    syncNotifications();
    void updateSelection(document.hasFocus()).catch(() => {});
    void refreshStatus().catch(() =>
      showStatus("Open Orbit to connect the companion"),
    );
    void poll();
    heartbeat = setInterval(() => {
      syncNotifications();
      void updateSelection().catch(() => {});
    }, 5000);
  }

  function resume(event: PageTransitionEvent): void {
    if (event.persisted && stopped) start();
  }

  hideButton?.addEventListener(
    "click",
    () => {
      hideButton.disabled = true;

      void request("visibility", { hidden: !hidden })
        .then(refreshStatus)
        .catch((error) =>
          showStatus(error.message || "Could not change companion visibility."),
        )
        .finally(renderControls);
    },
    listener,
  );

  pauseButton?.addEventListener(
    "click",
    () => {
      pauseButton.disabled = true;

      void request("pause", { paused: !paused })
        .then(refreshStatus)
        .catch((error) =>
          showStatus(error.message || "Could not change capture state."),
        )
        .finally(() => {
          renderControls();
        });
    },
    listener,
  );

  function quitCompanion(): void {
    const buttons = [hideButton, pauseButton, quitButton];
    for (const button of buttons) if (button) button.disabled = true;

    void request("quit", {})
      .then(refreshStatus)
      .catch((error) =>
        showStatus(error.message || "Could not quit the companion."),
      )
      .finally(() => {
        renderControls();
      });
  }

  quitButton?.addEventListener("click", quitCompanion, listener);
  companionDialog?.addEventListener(
    "toggle",
    () => {
      if (companionDialog.open) void refreshStatus().catch(() => {});
    },
    listener,
  );

  selectionChanged = onSelection;
  canPublishReplies = canProcessMessages;
  window.addEventListener("focus", onFocus, listener);
  window.addEventListener("pagehide", stop, listener);
  window.addEventListener("pageshow", resume, listener);
  start();

  const resetSession = (): void => {
    stop();
    sessionSuspended = true;
    clientId = "";
    completed.clear();
    cursor = 0;
    instanceId = "";
    statusCount = 0;
    downloading = false;
    start();
    renderDownload();
  };
  resetCurrentSession = resetSession;

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    stop();
    lifecycle.abort();
    if (selectionChanged === onSelection) selectionChanged = () => {};
    if (resetCurrentSession === resetSession) resetCurrentSession = () => {};
    if (canPublishReplies === canProcessMessages)
      canPublishReplies = () => false;
  };
  stopPrevious = cleanup;

  return cleanup;
}
