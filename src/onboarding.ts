import type { AuthChangeMeta, AuthController, OrbitUser } from "./auth.js";

export type EntryStage = "intro" | "download" | "relaunch" | "workspace";

type EntryOptions = {
  getAuth: () => AuthController;
  onStageChange: (stage: EntryStage) => void;
  onInstalled: () => void;
};

// Account entry rules

export function entryStage(
  user: OrbitUser | null,
  meta: AuthChangeMeta,
  workspaceReady: boolean,
): EntryStage {
  if (!user) return "intro";
  if (meta.isNewAccount) return "download";
  if (meta.source === "initial" && workspaceReady) return "workspace";
  return "relaunch";
}

export function isCompanionLaunchUrl(value: string, baseUrl: string): boolean {
  try {
    const url = new URL(value);
    const base = new URL(baseUrl);
    const keys = [...url.searchParams.keys()];

    if (
      base.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(base.hostname) ||
      !/^(431\d|4320)$/.test(base.port) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/"
    )
      return false;

    const nativeBase = `http://127.0.0.1:${base.port}`;

    return (
      url.protocol === "orbit-companion:" &&
      url.hostname === "launch" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      ["", "/"].includes(url.pathname) &&
      keys.length === 2 &&
      keys.includes("baseUrl") &&
      keys.includes("ticket") &&
      url.searchParams.get("baseUrl") === nativeBase &&
      /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("ticket") || "")
    );
  } catch {
    return false;
  }
}

// Bounded desktop handoff

export async function relaunchCompanion(options: {
  baseUrl: string;
  signal: AbortSignal;
  launch: (url: string) => void;
  fetcher?: typeof fetch;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  attempts?: number;
}): Promise<boolean> {
  const fetcher = options.fetcher || fetch;
  const wait = options.wait || abortableWait;
  const request = await fetcher("/api/companion/relaunch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: options.signal,
    credentials: "same-origin",
  });
  const result = await request.json();

  if (!request.ok)
    throw new Error(result.message || "Could not relaunch Orbit Companion.");
  options.signal.throwIfAborted();
  if (result.connected === true) return true;
  if (!isCompanionLaunchUrl(result.url, options.baseUrl))
    throw new Error("The companion launch link was invalid. Try again.");

  try {
    options.launch(result.url);
  } catch {
    return false;
  }

  for (let attempt = 0; attempt < (options.attempts ?? 16); attempt += 1) {
    await wait(750, options.signal);

    try {
      const response = await fetcher("/api/companion/status", {
        signal: options.signal,
        cache: "no-store",
        credentials: "same-origin",
      });
      const status = await response.json();

      options.signal.throwIfAborted();
      if (response.ok && status.desktopConnected === true) return true;
    } catch (error) {
      options.signal.throwIfAborted();
      if (attempt === (options.attempts ?? 16) - 1) throw error;
    }
  }

  return false;
}

function abortableWait(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };

    signal.addEventListener("abort", abort, { once: true });
  });
}

// Introduction and companion setup

export function initOnboarding(options: EntryOptions) {
  const intro = document.getElementById("intro-page")!;
  const workspace = document.getElementById("orbit-app")!;
  const dialog = document.getElementById(
    "companion-dialog",
  ) as HTMLDialogElement;
  const title = document.getElementById("companion-title")!;
  const description = document.getElementById("onboarding-description")!;
  const download = document.getElementById("download-companion")!;
  const relaunch = document.getElementById(
    "relaunch-companion",
  ) as HTMLButtonElement;
  const fallback = document.getElementById(
    "install-companion-fallback",
  ) as HTMLButtonElement;
  const status = document.getElementById("onboarding-status")!;
  let stage: EntryStage = "intro";
  let user: OrbitUser | null = null;
  let launchRequest: AbortController | null = null;
  let changingDialog = false;

  function readyKey(): string {
    return `orbit.workspace.ready.v2:${user?.id || ""}`;
  }

  function remembered(): boolean {
    try {
      return sessionStorage.getItem(readyKey()) === "1";
    } catch {
      return false;
    }
  }

  function remember(ready: boolean): void {
    try {
      if (ready) sessionStorage.setItem(readyKey(), "1");
      else sessionStorage.removeItem(readyKey());
    } catch {
      // Private browser storage
    }
  }

  function closeDialog(): void {
    changingDialog = true;
    if (dialog.open) dialog.close();
    changingDialog = false;
  }

  function setStage(next: EntryStage): void {
    launchRequest?.abort();
    launchRequest = null;
    stage = next;
    intro.hidden = next === "workspace";
    workspace.hidden = next !== "workspace";
    document.body.dataset.view = next === "workspace" ? "workspace" : "intro";
    document.title = "Orbit";
    options.onStageChange(next);

    if (next === "workspace" || next === "intro") {
      closeDialog();
      delete dialog.dataset.onboarding;

      if (next === "workspace") {
        remember(true);
        requestAnimationFrame(() =>
          workspace.querySelector<HTMLElement>("#message-input")?.focus(),
        );
      }
      return;
    }

    dialog.dataset.onboarding = next;
    title.textContent =
      next === "download"
        ? "Bring Orbit to your desktop."
        : "Welcome back to your orbit.";
    description.textContent =
      next === "download"
        ? "Your AI, one little companion away. Download Orbit for Windows to get started."
        : "Relaunch your companion and pick up where you left off.";
    description.hidden = false;
    status.hidden = true;
    status.textContent = "";
    relaunch.hidden = next !== "relaunch";
    relaunch.disabled = false;
    relaunch.querySelector("span")!.textContent = "Relaunch";
    fallback.hidden = true;
    download.hidden = next !== "download";
    options.getAuth().close();
    if (!dialog.open) dialog.showModal();
  }

  async function launch(): Promise<void> {
    if (!user || launchRequest) return;

    const request = new AbortController();
    const deadline = setTimeout(
      () => request.abort(new Error("Orbit Companion did not respond.")),
      15000,
    );

    launchRequest = request;
    relaunch.disabled = true;
    relaunch.querySelector("span")!.textContent = "Launching…";
    status.hidden = false;
    status.textContent = "If Chrome asks, choose Open Orbit Companion.";
    fallback.hidden = true;

    try {
      const connected = await relaunchCompanion({
        baseUrl: window.location.origin,
        signal: request.signal,
        launch: (url) => window.location.assign(url),
      });

      if (launchRequest !== request) return;
      if (connected) {
        setStage("workspace");
        return;
      }

      status.textContent =
        "Couldn’t reach your companion. You can try again or install it on this computer.";
      fallback.hidden = false;
    } catch (error) {
      if (launchRequest !== request) return;

      status.textContent =
        error instanceof Error
          ? error.message
          : "Couldn’t reach your companion. Try again or install it on this computer.";
      fallback.hidden = false;
    } finally {
      clearTimeout(deadline);
      if (launchRequest === request) {
        launchRequest = null;
        relaunch.disabled = false;
        relaunch.querySelector("span")!.textContent = "Relaunch";
      }
    }
  }

  relaunch.addEventListener("click", () => void launch());
  fallback.addEventListener("click", () => setStage("download"));
  dialog.addEventListener("close", () => {
    if (!changingDialog && stage !== "workspace" && stage !== "intro")
      setStage("intro");
  });
  window.addEventListener("orbit:companion-downloaded", () => {
    if (user && (stage === "download" || stage === "relaunch")) {
      setStage("workspace");
      options.onInstalled();
    }
  });

  setStage("intro");

  return {
    getStage: () => stage,
    authChanged(next: OrbitUser | null, meta: AuthChangeMeta): void {
      if (!next && user) remember(false);
      user = next;
      setStage(entryStage(next, meta, remembered()));
    },
    async getStarted(): Promise<void> {
      const auth = options.getAuth();

      await auth.ready;
      if (!auth.getUser()) auth.open();
      else setStage("relaunch");
    },
    openCompanion(): void {
      if (stage !== "workspace") return;

      delete dialog.dataset.onboarding;
      title.textContent = "A little closer to your work.";
      description.hidden = true;
      relaunch.hidden = true;
      fallback.hidden = true;
      status.hidden = true;
      download.hidden = false;
      if (!dialog.open) dialog.showModal();
    },
  };
}
