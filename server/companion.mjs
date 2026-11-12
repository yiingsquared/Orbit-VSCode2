import { randomBytes, randomInt, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./config.mjs";
import { getProvider, isModelId } from "./providers.mjs";

const pairingLifetime = 120000;
const relaunchLifetime = 120000;
const installLifetime = 86400000;
const resumeLifetime = 30 * installLifetime;
const selectionLifetime = 150000;
const contextLifetime = 15000;
const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;

// Private pairing state

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createCompanionState(options = {}) {
  const state = {
    instanceId: randomBytes(12).toString("base64url"),
    directory:
      options.directory === undefined
        ? path.join(projectRoot, ".orbit-data")
        : options.directory,
    clock: options.clock || Date.now,
    peers: new Map(),
    pendingControls: new Map(),
    installTickets: new Map(),
    pairings: new Map(),
    attempts: new Map(),
    clients: new Map(),
    signedOutClients: new Set(),
    activeClient: null,
    events: [],
    sequence: 0,
    paused: false,
    hidden: false,
    currentContext: null,
    contextHash: "",
    invalidatedAt: 0,
    latestReply: null,
    replyNotices: new Map(),
    replyReadReceipts: new Map(),
    pendingMessages: new Map(),
    deliveredReplies: new Map(),
    writeQueue: Promise.resolve(),
  };

  state.ready = (async () => {
    if (!state.directory) return;

    try {
      const saved = JSON.parse(
        await readFile(
          path.join(state.directory, "companion-peers.json"),
          "utf8",
        ),
      );

      for (const peer of saved.peers || []) {
        if (
          /^[a-f0-9]{64}$/.test(peer.hash) &&
          ["desktop", "extension"].includes(peer.kind) &&
          (peer.kind !== "extension" || extensionOrigin.test(peer.origin))
        ) {
          state.peers.set(peer.hash, { ...peer, lastSeen: 0 });
        }
      }

      for (const grant of (saved.installs || []).slice(-64)) {
        if (
          /^[a-f0-9]{64}$/.test(grant.hash) &&
          Number.isSafeInteger(grant.expiresAt) &&
          grant.expiresAt > state.clock() &&
          grant.expiresAt <= state.clock() + resumeLifetime
        )
          state.installTickets.set(grant.hash, { expiresAt: grant.expiresAt });
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
  })();

  return state;
}

let defaultState;

async function savePeers(state) {
  if (!state.directory) return;

  const save = state.writeQueue.then(async () => {
    await mkdir(state.directory, { recursive: true, mode: 0o700 });

    const filename = path.join(state.directory, "companion-peers.json");
    const temporary = `${filename}.tmp`;
    const peers = [...state.peers.values()].map(
      ({ hash, kind, name, origin, createdAt }) => ({
        hash,
        kind,
        name,
        origin,
        createdAt,
      }),
    );

    const installs = [...state.installTickets]
      .filter(([, grant]) => grant.expiresAt > state.clock())
      .map(([hash, grant]) => ({ hash, expiresAt: grant.expiresAt }));

    await writeFile(
      temporary,
      JSON.stringify({ version: 1, peers, installs }),
      {
        mode: 0o600,
      },
    );
    await rename(temporary, filename);
  });

  state.writeQueue = save.catch(() => {});
  await save;
}

// Request boundaries

function localBase(request) {
  const host = String(request.headers.host || "");

  if (!/^(127\.0\.0\.1|localhost):\d{1,5}$/.test(host)) return null;

  const url = new URL(`http://${host}`);

  return Number(url.port) > 0 && Number(url.port) <= 65535 ? url.origin : null;
}

function sameOrigin(request, base) {
  const origin = request.headers.origin;

  if (origin)
    return (
      origin === base &&
      !["cross-site", "same-site"].includes(request.headers["sec-fetch-site"])
    );

  return (
    request.method === "GET" &&
    !["cross-site", "same-site"].includes(request.headers["sec-fetch-site"])
  );
}

function extensionIdentity(request) {
  const origin = request.headers.origin;
  const id = request.headers["x-orbit-extension"];

  if (origin && extensionOrigin.test(origin)) return origin;
  if (!origin && typeof id === "string" && /^[a-p]{32}$/.test(id))
    return `chrome-extension://${id}`;

  return null;
}

function cors(response, origin) {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Orbit-Extension",
  );
  response.setHeader("Access-Control-Max-Age", "600");
}

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (!(request.headers["content-type"] || "").startsWith("application/json"))
    throw new Error("Use a JSON request.");

  let total = 0;
  const parts = [];

  for await (const part of request) {
    total += part.length;
    if (total > 160000) throw new Error("The companion request is too large.");
    parts.push(part);
  }

  const result = JSON.parse(Buffer.concat(parts).toString("utf8"));

  if (!result || Array.isArray(result) || typeof result !== "object")
    throw new Error("Use a JSON object.");

  return result;
}

function peerFor(request, state) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    request.headers.authorization || "",
  );

  if (!match) return null;

  const peer = state.peers.get(digest(match[1]));

  if (!peer) return null;
  if (peer.kind === "desktop" && request.headers.origin) return null;
  if (peer.kind === "extension" && extensionIdentity(request) !== peer.origin)
    return null;

  peer.lastSeen = state.clock();
  return peer;
}

// Revoked peers can only receive their final control

function pendingControl(request, state) {
  if (request.headers.origin || request.headers["x-orbit-extension"])
    return null;

  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    request.headers.authorization || "",
  );
  if (!match) return null;

  const control = state.pendingControls.get(digest(match[1]));
  return control && control.expiresAt > state.clock() ? control : null;
}

function issueInstallTicket(state, lifetime = installLifetime) {
  for (const [hash, grant] of state.installTickets)
    if (grant.expiresAt <= state.clock()) state.installTickets.delete(hash);

  while (state.installTickets.size >= 64)
    state.installTickets.delete(state.installTickets.keys().next().value);
  const ticket = randomBytes(32).toString("base64url");
  state.installTickets.set(digest(ticket), {
    expiresAt: state.clock() + lifetime,
  });
  return ticket;
}

function nativeBase(base) {
  const url = new URL(base);
  url.hostname = "127.0.0.1";
  return url.origin;
}

export function makeInstallerBundle(installer, baseUrl, ticket) {
  const grant = Buffer.from(JSON.stringify({ baseUrl, ticket }));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(grant.length);
  return Buffer.concat([
    installer,
    grant,
    size,
    Buffer.from("ORBIT_INSTALL_V1"),
  ]);
}

function allowAttempt(state, address) {
  const now = state.clock();
  let entry = state.attempts.get(address);

  if (!entry || entry.until <= now) {
    entry = { count: 0, until: now + 60000 };
    state.attempts.set(address, entry);
  }

  entry.count += 1;
  return entry.count <= 8;
}

// Selected Orbit conversation

function validClientId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(value);
}

// Reply notification identities

function replyIdentity(body) {
  if (
    !validClientId(body.clientId) ||
    !validClientId(body.chatId) ||
    !validClientId(body.messageId) ||
    !validClientId(body.revision)
  ) {
    throw new Error("Use a valid conversation reply identity.");
  }

  return {
    clientId: body.clientId,
    chatId: body.chatId,
    messageId: body.messageId,
    revision: body.revision,
  };
}

function replyKey(identity) {
  return JSON.stringify([
    identity.chatId,
    identity.messageId,
    identity.revision,
  ]);
}

function trimReplyNotifications(state) {
  const oldest = state.clock() - 86400000;

  for (const [key, receipt] of state.replyReadReceipts)
    if (receipt.createdAt < oldest) state.replyReadReceipts.delete(key);

  while (state.replyReadReceipts.size > 5000)
    state.replyReadReceipts.delete(state.replyReadReceipts.keys().next().value);

  while (state.replyNotices.size > 5000)
    state.replyNotices.delete(state.replyNotices.keys().next().value);
}

function unreadReplies(state) {
  let count = 0;

  for (const notice of state.replyNotices.values())
    if (!notice.read) count += 1;

  return count;
}

function activeSelection(state) {
  const selection = state.clients.get(state.activeClient);

  return selection && state.clock() - selection.lastSeen < selectionLifetime
    ? selection
    : null;
}

function pushEvent(state, type, data) {
  const selection = activeSelection(state);

  if (!selection) return null;

  const event = {
    id: ++state.sequence,
    type,
    clientId: selection.clientId,
    createdAt: state.clock(),
    ...data,
  };

  state.events.push(event);

  while (state.events.length > 200) {
    const disposable = state.events.findIndex(
      (item) => item.type !== "message",
    );

    state.events.splice(disposable < 0 ? 0 : disposable, 1);
  }

  return event;
}

export function redactCapturedSecrets(value) {
  return String(value)
    .replace(
      /\b([A-Z_][A-Z0-9_]*(?:API_KEY|CLIENT_SECRET|ACCESS_TOKEN|SECRET_KEY|PASSWORD)|API_KEY|CLIENT_SECRET|ACCESS_TOKEN|SECRET_KEY|PASSWORD)[ \t]*=[ \t]*[^\r\n]*/gi,
      "$1=[redacted]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|xai-[A-Za-z0-9_-]{12,}|GOCSPX-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{12,}|pplx-[A-Za-z0-9_-]{12,}|ya29\.[A-Za-z0-9._-]{10,})\b/gi,
      "[redacted]",
    );
}

export function normalizeContext(input, source, now = Date.now()) {
  if (!input || typeof input.text !== "string" || input.text.length > 30000)
    throw new Error("Capture up to 30,000 characters of visible text.");

  const text = redactCapturedSecrets(input.text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim()
    .slice(0, 30000);

  if (!text)
    throw new Error("No readable text was found in the current window.");

  let url = "";

  if (input.url) {
    const parsed = new URL(String(input.url));

    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new Error("Use a normal browser page.");

    url = redactCapturedSecrets(`${parsed.origin}${parsed.pathname}`).slice(
      0,
      2048,
    );
  }

  const title = redactCapturedSecrets(
    input.title || input.windowTitle || "",
  ).slice(0, 300);
  const candidateTime = Date.parse(String(input.capturedAt || ""));
  const timestamp = Number.isFinite(candidateTime)
    ? Math.max(now - 300000, Math.min(now, candidateTime))
    : now;

  return {
    source,
    title,
    windowTitle: redactCapturedSecrets(input.windowTitle || title).slice(
      0,
      300,
    ),
    app: redactCapturedSecrets(
      input.app || (source === "browser" ? "chrome" : "Windows"),
    ).slice(0, 100),
    text,
    url,
    capturedAt: new Date(timestamp).toISOString(),
    receivedAt: now,
  };
}

function acceptContext(state, input, peer) {
  const source =
    peer.kind === "extension"
      ? "browser"
      : input.source === "browser"
        ? "browser"
        : "desktop";
  const context = normalizeContext(input, source, state.clock());

  if (Date.parse(context.capturedAt) < state.invalidatedAt)
    throw new Error(
      "The active tab changed. Capture the current window again.",
    );
  const hash = digest(
    JSON.stringify([
      context.source,
      context.app,
      context.title,
      context.url,
      context.text,
    ]),
  );

  state.currentContext = context;

  if (hash !== state.contextHash) {
    state.contextHash = hash;
    pushEvent(state, "context", { context });
  }

  return context;
}

function invalidateContext(state, reason) {
  state.currentContext = null;
  state.contextHash = "";
  state.invalidatedAt = state.clock();
  pushEvent(state, "context-invalidated", { reason });
}

function freshContext(state) {
  const current = state.currentContext;

  if (state.paused || !current) return null;

  const now = state.clock();
  const capturedAt = Date.parse(current.capturedAt);

  return now - current.receivedAt <= contextLifetime &&
    now - capturedAt <= contextLifetime
    ? current
    : null;
}

function publicStatus(state) {
  const now = state.clock();
  const peers = [...state.peers.values()];
  const selection = activeSelection(state);

  return {
    desktopConnected: peers.some(
      (peer) => peer.kind === "desktop" && now - peer.lastSeen < 20000,
    ),
    extensionConnected: peers.some(
      (peer) => peer.kind === "extension" && now - peer.lastSeen < 20000,
    ),
    pairedDesktop: peers.filter((peer) => peer.kind === "desktop").length,
    pairedExtension: peers.filter((peer) => peer.kind === "extension").length,
    paused: state.paused,
    hidden: state.hidden,
    selection: selection
      ? {
          clientId: selection.clientId,
          provider: selection.provider,
          model: selection.model,
        }
      : null,
    contextSource: state.currentContext?.source || null,
    contextFresh: Boolean(freshContext(state)),
    contextPreview: state.currentContext
      ? {
          title: state.currentContext.title,
          app: state.currentContext.app,
          capturedAt: state.currentContext.capturedAt,
        }
      : null,
  };
}

// Companion routes

export async function handleCompanion(request, response, options = {}) {
  const state = options.state || (defaultState ??= createCompanionState());

  await state.ready;

  const base = localBase(request);

  if (!base) {
    json(response, 403, { message: "Use the Orbit loopback address." });
    return;
  }

  const url = new URL(request.url, base);
  const identity = extensionIdentity(request);
  const knownExtension =
    identity &&
    [...state.peers.values()].some((peer) => peer.origin === identity);

  if (request.method === "OPTIONS") {
    if (
      identity &&
      (url.pathname === "/api/companion/pair" || knownExtension)
    ) {
      cors(response, identity);
      response.writeHead(204);
      response.end();
    } else
      json(response, 403, { message: "This origin is not paired with Orbit." });

    return;
  }

  if (identity && (url.pathname === "/api/companion/pair" || knownExtension))
    cors(response, identity);

  const web = sameOrigin(request, base);
  const peer = peerFor(request, state);

  for (const [hash, control] of state.pendingControls)
    if (control.expiresAt <= state.clock()) state.pendingControls.delete(hash);

  for (const [id, pending] of state.pendingMessages) {
    if (state.clock() - pending.createdAt > 600000) {
      state.pendingMessages.delete(id);
      state.events = state.events.filter((event) => event.id !== id);
    }
  }

  try {
    // One-use local relaunch

    if (
      request.method === "POST" &&
      url.pathname === "/api/companion/relaunch"
    ) {
      if (!web) {
        json(response, 403, { message: "Relaunch the companion from Orbit." });
        return;
      }
      await readJson(request);
      if (!/^(431[0-9]|4320)$/.test(new URL(base).port)) {
        json(response, 400, { message: "Start Orbit on a supported local port (4310–4320)." });
        return;
      }
      state.hidden = false;
      if (publicStatus(state).desktopConnected) {
        json(response, 200, { connected: true });
        return;
      }
      const ticket = issueInstallTicket(state, relaunchLifetime);
      await savePeers(state);
      const launch = new URL("orbit-companion://launch");
      launch.searchParams.set("baseUrl", nativeBase(base));
      launch.searchParams.set("ticket", ticket);
      json(response, 200, {
        connected: false,
        url: launch.href,
        expiresAt: state.clock() + relaunchLifetime,
      });
      return;
    }

    // Installer handoff without manual pairing

    if (
      request.method === "POST" &&
      url.pathname === "/api/companion/installer"
    ) {
      if (!web) {
        json(response, 403, { message: "Download the installer from Orbit." });
        return;
      }
      await readJson(request);
      const installer =
        options.installer ??
        (await readFile(
          path.join(projectRoot, "public", "downloads", "Orbit-Setup.exe"),
        ));
      const ticket = issueInstallTicket(state);
      await savePeers(state);
      const bundle = makeInstallerBundle(installer, nativeBase(base), ticket);
      response.writeHead(200, {
        "Content-Type": "application/vnd.microsoft.portable-executable",
        "Content-Disposition": 'attachment; filename="Orbit-Setup.exe"',
        "Content-Length": bundle.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(bundle);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/companion/activate"
    ) {
      if (request.headers.origin || identity) {
        json(response, 403, {
          message: "Activate from the installed Windows companion.",
        });
        return;
      }
      if (!allowAttempt(state, request.socket.remoteAddress || "local")) {
        json(response, 429, {
          message: "Too many activation attempts. Try again in a minute.",
        });
        return;
      }
      const body = await readJson(request);
      const ticket = typeof body.ticket === "string" ? body.ticket : "";
      const hash = digest(ticket);
      const grant = state.installTickets.get(hash);
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(ticket) ||
        !grant ||
        grant.expiresAt <= state.clock()
      ) {
        json(response, 401, {
          message: "Download a new installer from Orbit → Get Started.",
        });
        return;
      }
      state.installTickets.delete(hash);
      const token = randomBytes(32).toString("base64url");
      const saved = {
        hash: digest(token),
        kind: "desktop",
        name: "Orbit for Windows",
        origin: "",
        createdAt: state.clock(),
        lastSeen: state.clock(),
      };
      state.peers.set(saved.hash, saved);
      try {
        await savePeers(state);
      } catch (error) {
        state.peers.delete(saved.hash);
        state.installTickets.set(hash, grant);
        throw error;
      }
      json(response, 200, {
        token,
        baseUrl: nativeBase(base),
        kind: "desktop",
      });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/companion/pair-code"
    ) {
      if (!web) {
        json(response, 403, { message: "Create a pairing code from Orbit." });
        return;
      }

      const code = `${new URL(base).port}-${String(randomInt(0, 100000000)).padStart(8, "0")}`;
      const expiresAt = state.clock() + pairingLifetime;

      for (const [savedCode, entry] of state.pairings)
        if (entry.expiresAt <= state.clock()) state.pairings.delete(savedCode);

      state.pairings.clear();
      state.pairings.set(digest(code), { expiresAt, attempts: 0 });
      json(response, 200, { code, expiresAt, baseUrl: base });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/companion/pair") {
      if (request.headers.origin && !identity) {
        json(response, 403, {
          message: "Pair from the Orbit companion or Chrome extension.",
        });
        return;
      }
      if (!allowAttempt(state, request.socket.remoteAddress || "local")) {
        json(response, 429, {
          message: "Too many pairing attempts. Try again in a minute.",
        });
        return;
      }

      const body = await readJson(request);
      const code = typeof body.code === "string" ? body.code.trim() : "";
      const pairing = state.pairings.get(digest(code));

      if (
        !/^\d{1,5}-\d{8}$/.test(code) ||
        !pairing ||
        pairing.expiresAt <= state.clock() ||
        code.split("-")[0] !== new URL(base).port
      ) {
        json(response, 401, {
          message:
            "The pairing code is invalid or expired. Generate a new code in Orbit.",
        });
        return;
      }

      if (
        !["desktop", "extension"].includes(body.kind) ||
        (body.kind === "extension" && !identity) ||
        (body.kind === "desktop" && identity)
      ) {
        json(response, 400, {
          message: "Use the correct companion pairing type.",
        });
        return;
      }

      state.pairings.delete(digest(code));

      const token = randomBytes(32).toString("base64url");
      const saved = {
        hash: digest(token),
        kind: body.kind,
        name: String(body.name || body.kind).slice(0, 100),
        origin: identity || "",
        createdAt: state.clock(),
        lastSeen: state.clock(),
      };

      state.peers.set(saved.hash, saved);
      await savePeers(state);
      json(response, 200, { token, baseUrl: base, kind: body.kind });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/companion/state") {
      if (!peer) {
        const control = pendingControl(request, state);
        if (control) {
          json(response, 200, {
            paired: false,
            command: control.command,
            ...(control.signOut ? { signOut: true } : {}),
            ...(control.reconnectTicket
              ? {
                  reconnect: {
                    baseUrl: nativeBase(base),
                    ticket: control.reconnectTicket,
                  },
                }
              : {}),
          });
          return;
        }
        json(response, 401, { message: "Pair the Orbit companion first." });
        return;
      }

      const selection = activeSelection(state);
      const current = state.currentContext;

      json(
        response,
        200,
        peer.kind === "extension"
          ? { paired: true, paused: state.paused }
          : {
              paired: true,
              provider: selection?.provider || null,
              model: selection?.model || null,
              paused: state.paused,
              hidden: state.hidden,
              contextSource: current?.source || null,
              context: freshContext(state),
              latestReply: state.latestReply,
              unreadReplyCount: unreadReplies(state),
              hasUnreadReplies: unreadReplies(state) > 0,
            },
      );
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/companion/invalidate"
    ) {
      if (peer?.kind !== "extension") {
        json(response, peer ? 403 : 401, {
          message:
            "Only the paired Chrome extension can clear a tab transition.",
        });
        return;
      }

      const body = await readJson(request);
      if (state.peers.get(peer.hash) !== peer) {
        json(response, 401, { message: "Pair the Orbit companion first." });
        return;
      }
      const reasons = [
        "active-tab-changed",
        "tab-navigation",
        "focused-window-changed",
        "unreadable-tab",
        "reading-paused",
        "extension-disconnected",
      ];

      if (body.source !== "browser" || !reasons.includes(body.reason))
        throw new Error("Use a valid Chrome tab transition.");

      invalidateContext(state, body.reason);
      json(response, 200, { ok: true });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/companion/context"
    ) {
      if (!peer) {
        json(response, 401, { message: "Pair the Orbit companion first." });
        return;
      }
      if (state.paused) {
        json(response, 200, { ok: true, stored: false, paused: true });
        return;
      }

      const body = await readJson(request);
      if (state.peers.get(peer.hash) !== peer) {
        json(response, 401, { message: "Pair the Orbit companion first." });
        return;
      }
      if (state.paused) {
        json(response, 200, { ok: true, stored: false, paused: true });
        return;
      }
      const context = acceptContext(state, body, peer);

      json(response, 200, {
        ok: true,
        stored: true,
        capturedAt: context.capturedAt,
      });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/companion/message"
    ) {
      if (peer?.kind !== "desktop") {
        json(response, 401, { message: "Pair the Windows companion first." });
        return;
      }

      const body = await readJson(request);
      if (state.peers.get(peer.hash) !== peer) {
        json(response, 401, { message: "Pair the Windows companion first." });
        return;
      }
      const text = typeof body.text === "string" ? body.text.trim() : "";

      if (!text || text.length > 30000) {
        json(response, 400, {
          message: "Enter a message up to 30,000 characters.",
        });
        return;
      }
      if (!activeSelection(state)) {
        json(response, 409, {
          message:
            "Keep Orbit open and select an AI before sending from the cat.",
        });
        return;
      }
      if (state.pendingMessages.size >= 30) {
        json(response, 429, {
          message: "Orbit has too many queued messages. Wait for a reply.",
        });
        return;
      }

      let context = null;

      if (!state.paused && body.useCurrentContext !== false) {
        if (body.context) {
          const capturedAt = Date.parse(String(body.context.capturedAt || ""));

          if (
            !Number.isFinite(capturedAt) ||
            (state.clock() - capturedAt <= contextLifetime &&
              capturedAt >= state.invalidatedAt)
          ) {
            acceptContext(state, body.context, peer);
            context = freshContext(state);
          }
        } else context = freshContext(state);
      }
      const event = pushEvent(state, "message", { text, context });

      state.pendingMessages.set(event.id, {
        clientId: event.clientId,
        createdAt: state.clock(),
      });
      json(response, 200, { ok: true, messageId: event.id });
      return;
    }

    if (!web) {
      json(response, 403, { message: "Open this control in Orbit." });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/companion/current-context"
    ) {
      if (peer || request.headers.authorization || identity) {
        json(response, 403, {
          message: "Read the current context from the Orbit website.",
        });
        return;
      }

      json(response, 200, {
        context: freshContext(state),
        paused: state.paused,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/companion/status") {
      json(response, 200, publicStatus(state));
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/companion/selection"
    ) {
      const body = await readJson(request);

      if (state.signedOutClients.has(body.clientId)) {
        json(response, 409, { message: "Sign in again to start a new Orbit companion session." });
        return;
      }
      if (
        !validClientId(body.clientId) ||
        !getProvider(body.provider) ||
        !isModelId(body.model)
      )
        throw new Error("Choose a supported Orbit AI and model.");

      const previous = activeSelection(state);
      const selection = {
        clientId: body.clientId,
        provider: body.provider,
        model: body.model,
        lastSeen: state.clock(),
        visible: body.visible !== false,
      };

      state.clients.set(body.clientId, selection);
      if (
        !previous ||
        previous.clientId === body.clientId ||
        body.takeControl === true ||
        body.focused === true
      )
        state.activeClient = body.clientId;

      if (
        state.activeClient === body.clientId &&
        previous?.clientId !== body.clientId &&
        !state.paused &&
        state.currentContext &&
        state.clock() - state.currentContext.receivedAt <= contextLifetime
      ) {
        pushEvent(state, "context", { context: state.currentContext });
      }

      for (const [id, entry] of state.clients)
        if (state.clock() - entry.lastSeen >= selectionLifetime * 2)
          state.clients.delete(id);

      json(response, 200, {
        ok: true,
        active: state.activeClient === body.clientId,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/companion/events") {
      const clientId = url.searchParams.get("clientId");
      const requestedAfter = Math.max(
        0,
        Number(url.searchParams.get("after")) || 0,
      );
      const after = requestedAfter > state.sequence ? 0 : requestedAfter;

      if (!validClientId(clientId))
        throw new Error("Use a valid Orbit client.");

      const selection = activeSelection(state);
      const events =
        selection?.clientId === clientId
          ? state.events
              .filter(
                (event) => event.id > after && event.clientId === clientId,
              )
              .slice(0, 50)
          : [];

      json(response, 200, {
        events,
        instanceId: state.instanceId,
        cursor: events.at(-1)?.id || after,
        active: selection?.clientId === clientId,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/companion/ack") {
      const body = await readJson(request);

      if (!validClientId(body.clientId) || !Number.isSafeInteger(body.eventId))
        throw new Error("Use a valid event acknowledgement.");

      state.events = state.events.filter(
        (event) => event.clientId !== body.clientId || event.id > body.eventId,
      );
      json(response, 200, { ok: true });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/companion/reply-published"
    ) {
      const body = await readJson(request);
      const identity = replyIdentity(body);

      if (!state.clients.has(identity.clientId)) {
        json(response, 409, {
          message: "Open Orbit before publishing a reply.",
        });
        return;
      }

      if (typeof body.text !== "string" || body.text.length > 150000)
        throw new Error("The AI reply is invalid.");

      if (!body.text.trim() || body.error) {
        json(response, 200, { ok: true, ignored: true });
        return;
      }

      const key = replyKey(identity);
      const contentHash = digest(body.text);
      const previous = state.replyNotices.get(key);

      if (previous && previous.contentHash !== contentHash) {
        json(response, 409, {
          message: "Use a new revision for another response.",
        });
        return;
      }

      if (!previous) {
        state.replyNotices.set(key, {
          ...identity,
          contentHash,
          createdAt: state.clock(),
          read: body.read === true || state.replyReadReceipts.has(key),
        });
      } else if (body.read === true || state.replyReadReceipts.has(key)) {
        previous.read = true;
      }

      trimReplyNotifications(state);
      json(response, 200, {
        ok: true,
        duplicate: Boolean(previous),
        unreadReplyCount: unreadReplies(state),
      });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/companion/reply-read"
    ) {
      const body = await readJson(request);
      const identity = replyIdentity(body);

      if (!state.clients.has(identity.clientId)) {
        json(response, 409, {
          message: "Open Orbit before marking a reply read.",
        });
        return;
      }

      const key = replyKey(identity);

      state.replyReadReceipts.set(key, {
        ...identity,
        createdAt: state.clock(),
      });

      const notice = state.replyNotices.get(key);

      if (notice) notice.read = true;

      trimReplyNotifications(state);
      json(response, 200, { ok: true, unreadReplyCount: unreadReplies(state) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/companion/reply") {
      const body = await readJson(request);
      const pending = state.pendingMessages.get(body.messageId);
      const delivered = state.deliveredReplies.get(body.messageId);

      if (!pending && delivered?.clientId === body.clientId) {
        json(response, 200, { ok: true, duplicate: true });
        return;
      }

      if (!pending || pending.clientId !== body.clientId) {
        json(response, 409, {
          message: "This message does not belong to this Orbit chat.",
        });
        return;
      }
      if (
        typeof body.text !== "string" ||
        body.text.length > 150000 ||
        (body.error && String(body.error).length > 500)
      )
        throw new Error("The companion reply is invalid.");

      state.latestReply = {
        messageId: body.messageId,
        text: body.text,
        error: body.error ? String(body.error) : null,
        createdAt: state.clock(),
      };
      state.pendingMessages.delete(body.messageId);
      state.deliveredReplies.set(body.messageId, { clientId: body.clientId });

      if (state.deliveredReplies.size > 100)
        state.deliveredReplies.delete(
          state.deliveredReplies.keys().next().value,
        );
      json(response, 200, { ok: true });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/companion/visibility"
    ) {
      const body = await readJson(request);
      if (typeof body.hidden !== "boolean")
        throw new Error("Choose whether to hide the companion.");
      state.hidden = body.hidden;
      json(response, 200, { ok: true, hidden: state.hidden });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/companion/pause") {
      const body = await readJson(request);

      if (typeof body.paused !== "boolean")
        throw new Error("Choose a capture state.");

      state.paused = body.paused;
      if (state.paused) {
        invalidateContext(state, "reading-paused");
      }

      json(response, 200, { ok: true, paused: state.paused });
      return;
    }

    if (
      request.method === "POST" &&
      [
        "/api/companion/revoke",
        "/api/companion/disconnect",
        "/api/companion/quit",
      ].includes(url.pathname)
    ) {
      const body = await readJson(request);
      const command = url.pathname.endsWith("/quit")
        ? "quit"
        : url.pathname.endsWith("/disconnect")
          ? "disconnect"
          : null;

      if (body.kind && !["desktop", "extension"].includes(body.kind))
        throw new Error("Choose a companion type.");

      if (body.signOut !== undefined && typeof body.signOut !== "boolean")
        throw new Error("Choose a valid sign-out state.");
      const signOut = command === "quit" && body.signOut === true;
      if (signOut && body.kind) throw new Error("Sign out of all companion connections.");

      if (signOut || (command !== "quit" && (!body.kind || body.kind === "desktop"))) {
        state.installTickets.clear();
        state.pendingControls.clear();
      }

      for (const [hash, saved] of state.peers) {
        if (body.kind && saved.kind !== body.kind) continue;
        state.peers.delete(hash);
        if (command && saved.kind === "desktop") {
          state.pendingControls.set(hash, {
            command,
            expiresAt: state.clock() + pairingLifetime,
            ...(signOut ? { signOut: true } : {}),
            ...(command === "quit" && !signOut
              ? { reconnectTicket: issueInstallTicket(state, resumeLifetime) }
              : {}),
          });
        }
      }

      if (!state.peers.size) {
        state.paused = false;
        state.hidden = false;
      }
      state.pairings.clear();

      if (signOut) {
        for (const clientId of state.clients.keys()) state.signedOutClients.add(clientId);
        state.clients.clear();
        state.activeClient = null;
      }

      state.currentContext = null;
      state.contextHash = "";
      state.events = [];
      state.pendingMessages.clear();
      state.invalidatedAt = state.clock();
      state.deliveredReplies.clear();
      state.latestReply = null;
      state.replyNotices.clear();
      state.replyReadReceipts.clear();
      await savePeers(state);
      json(response, 200, { ok: true });
      return;
    }

    json(response, 404, { message: "Companion route not found." });
  } catch (error) {
    json(response, 400, {
      message:
        error instanceof SyntaxError
          ? "Use valid JSON."
          : error.message || "The companion request failed.",
    });
  }
}
