import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt,
  timingSafeEqual,
  createPublicKey,
  verify,
} from "node:crypto";
import { promisify } from "node:util";
import { projectRoot, readConfig } from "./config.mjs";

const deriveKey = promisify(scrypt);
const sessionCookie = "orbit_session";
const oauthCookie = "orbit_oauth";
const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
const stateLifetime = 10 * 60 * 1000;
const hashOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const googleAuthorization = "https://accounts.google.com/o/oauth2/v2/auth";
const googleToken = "https://oauth2.googleapis.com/token";
const googleKeys = "https://www.googleapis.com/oauth2/v3/certs";
const googleUserInfo = "https://openidconnect.googleapis.com/v1/userinfo";

let defaultStore;
let activeHashes = 0;

// Local account storage

export function createAuthStore(
  directory = path.join(projectRoot, ".orbit-data"),
) {
  let filename = ":memory:";

  if (directory !== ":memory:") {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    filename = path.join(directory, "accounts.sqlite");
  }

  const db = new DatabaseSync(filename);

  if (filename !== ":memory:") chmodSync(filename, 0o600);

  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      password_hash TEXT,
      google_sub TEXT UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash TEXT PRIMARY KEY,
      browser_hash TEXT NOT NULL,
      verifier TEXT NOT NULL,
      nonce TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  return {
    db,
    close: () => db.close(),
    byEmail: (email) =>
      db.prepare("SELECT * FROM users WHERE email = ?").get(email),
    byGoogleSub: (sub) =>
      db.prepare("SELECT * FROM users WHERE google_sub = ?").get(sub),
    addUser(user) {
      db.prepare(
        `INSERT INTO users (id, email, name, provider, password_hash, google_sub, email_verified, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        user.id,
        user.email,
        user.name,
        user.provider,
        user.password_hash ?? null,
        user.google_sub ?? null,
        user.email_verified ? 1 : 0,
        Date.now(),
      );
      return this.byEmail(user.email);
    },
    addSession(token, userId, expires) {
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
      db.prepare(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
      ).run(digest(token), userId, expires);
    },
    sessionUser(token) {
      return db
        .prepare(
          `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
        )
        .get(digest(token), Date.now());
    },
    deleteSession(token) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(
        digest(token),
      );
    },
    addState(state, browser, verifier, nonce, redirectUri) {
      db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").run(
        Date.now(),
      );
      db.prepare(
        `INSERT INTO oauth_states (state_hash, browser_hash, verifier, nonce, redirect_uri, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        digest(state),
        digest(browser),
        verifier,
        nonce,
        redirectUri,
        Date.now() + stateLifetime,
      );
    },
    consumeState(state, browser) {
      const entry = db
        .prepare("SELECT * FROM oauth_states WHERE state_hash = ?")
        .get(digest(state));

      if (
        !entry ||
        entry.expires_at <= Date.now() ||
        !safeEqual(entry.browser_hash, digest(browser))
      )
        return null;

      db.prepare("DELETE FROM oauth_states WHERE state_hash = ?").run(
        digest(state),
      );
      return entry;
    },
  };
}

function storeFor(options) {
  if (options.store) return options.store;
  defaultStore ??= createAuthStore();
  return defaultStore;
}

function digest(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));

  return a.length === b.length && timingSafeEqual(a, b);
}

function publicUser(user) {
  return user
    ? {
        id: user.id,
        email: user.email,
        name: user.name,
        provider: user.provider,
        emailVerified: Boolean(user.email_verified),
      }
    : null;
}

// Password hashing

export function normalizeEmail(value) {
  if (typeof value !== "string" || value.length > 254)
    throw new Error("Enter a valid email address.");

  const email = value.trim().toLowerCase();

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    /[\x00-\x1f\x7f]/.test(email)
  ) {
    throw new Error("Enter a valid email address.");
  }

  return email;
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 6) {
    throw Object.assign(new Error("Use at least 6 characters"), {
      code: "password_too_short",
    });
  }

  if (password.length > 128) {
    throw Object.assign(new Error("Use no more than 128 characters"), {
      code: "password_too_long",
    });
  }
}

export async function hashPassword(password) {
  validatePassword(password);

  if (activeHashes >= 4)
    throw new Error("Sign-in is busy. Please try again shortly.");

  activeHashes += 1;

  try {
    const salt = randomBytes(16).toString("hex");
    const key = await deriveKey(password, salt, 64, hashOptions);

    return `scrypt$32768$8$1$${salt}$${key.toString("hex")}`;
  } finally {
    activeHashes -= 1;
  }
}

export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || password.length > 128) return false;

  const parts = typeof stored === "string" ? stored.split("$") : [];
  const valid =
    parts.length === 6 &&
    parts.slice(0, 4).join("$") === "scrypt$32768$8$1" &&
    /^[a-f0-9]{32}$/.test(parts[4]) &&
    /^[a-f0-9]{128}$/.test(parts[5]);
  const salt = valid ? parts[4] : "0".repeat(32);

  if (activeHashes >= 4) return false;

  activeHashes += 1;

  try {
    const key = await deriveKey(password, salt, 64, hashOptions);

    return valid && timingSafeEqual(key, Buffer.from(parts[5], "hex"));
  } finally {
    activeHashes -= 1;
  }
}

// Cookie sessions

function cookies(request) {
  const result = Object.create(null);

  for (const part of String(request.headers.cookie || "").split(";")) {
    const split = part.indexOf("=");

    if (split > 0)
      result[part.slice(0, split).trim()] = part.slice(split + 1).trim();
  }

  return result;
}

function cookieKey(request, name) {
  const port = new URL(localBase(request)).port;

  return `${name}_${port}`;
}

function setCookie(response, name, value, maxAge) {
  const existing = response.getHeader("Set-Cookie");
  const list = existing
    ? Array.isArray(existing)
      ? existing
      : [existing]
    : [];

  list.push(
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  );
  response.setHeader("Set-Cookie", list);
}

function startSession(request, response, store, user) {
  const oldToken = cookies(request)[cookieKey(request, sessionCookie)];

  if (oldToken) store.deleteSession(oldToken);

  const token = randomBytes(32).toString("base64url");

  store.addSession(token, user.id, Date.now() + sessionLifetime);
  setCookie(
    response,
    cookieKey(request, sessionCookie),
    token,
    Math.floor(sessionLifetime / 1000),
  );
}

function localBase(request) {
  const host = String(request.headers.host || "");
  const match = /^(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(host);

  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535)
    throw new Error("Use Orbit’s local server address.");

  return `http://${host}`;
}

function sameOrigin(request, base) {
  return (
    request.headers.origin === base &&
    !["cross-site", "none"].includes(request.headers["sec-fetch-site"])
  );
}

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function redirect(response, pathName) {
  response.writeHead(303, {
    Location: pathName,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  response.end();
}

async function readBody(request) {
  if (!(request.headers["content-type"] || "").startsWith("application/json"))
    throw new Error("Send a JSON request.");

  const parts = [];
  let length = 0;

  for await (const part of request) {
    length += part.length;
    if (length > 16000) throw new Error("The sign-in request is too large.");
    parts.push(part);
  }

  try {
    const body = JSON.parse(Buffer.concat(parts).toString("utf8"));

    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();

    return body;
  } catch {
    throw new Error("Send a valid sign-in request.");
  }
}

const attempts = new Map();

function allowAttempt(request) {
  const key = request.socket.remoteAddress || "local";
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || entry.expires < now) {
    attempts.set(key, { count: 1, expires: now + 60000 });
    return true;
  }

  entry.count += 1;
  return entry.count <= 40;
}

// Google identity validation

const jwksCache = new Map();

export async function verifyGoogleIdToken(
  token,
  clientId,
  nonce,
  fetcher = fetch,
) {
  if (typeof token !== "string" || token.length > 16000)
    throw new Error("Invalid Google identity.");

  const parts = token.split(".");

  if (parts.length !== 3) throw new Error("Invalid Google identity.");

  let header;
  let claims;

  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid Google identity.");
  }

  if (
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    header.kid.length > 200
  )
    throw new Error("Invalid Google identity.");

  let cached = jwksCache.get(fetcher);

  if (
    !cached ||
    cached.expires < Date.now() ||
    !cached.keys.some((key) => key.kid === header.kid)
  ) {
    const response = await fetcher(googleKeys, {
      signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) throw new Error("Could not verify Google identity.");

    const body = await response.json();

    if (!Array.isArray(body.keys) || body.keys.length > 20)
      throw new Error("Could not verify Google identity.");

    cached = { keys: body.keys, expires: Date.now() + 30 * 60 * 1000 };
    jwksCache.set(fetcher, cached);
  }

  const jwk = cached.keys.find(
    (key) => key.kid === header.kid && key.kty === "RSA",
  );

  if (
    !jwk ||
    !verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(parts[2], "base64url"),
    )
  ) {
    throw new Error("Invalid Google identity.");
  }

  const now = Math.floor(Date.now() / 1000);
  const audienceValid =
    claims.aud === clientId ||
    (Array.isArray(claims.aud) &&
      claims.aud.includes(clientId) &&
      claims.azp === clientId);

  if (
    !["https://accounts.google.com", "accounts.google.com"].includes(
      claims.iss,
    ) ||
    !audienceValid ||
    (claims.azp && claims.azp !== clientId) ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    !Number.isFinite(claims.iat) ||
    claims.iat > now + 60 ||
    !safeEqual(claims.nonce || "", nonce) ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    claims.sub.length > 255 ||
    claims.email_verified !== true
  ) {
    throw new Error("Invalid Google identity.");
  }

  return claims;
}

async function googleCallback(
  request,
  response,
  url,
  store,
  config,
  fetcher,
  base,
) {
  const state = url.searchParams.get("state") || "";
  const browser = cookies(request)[cookieKey(request, oauthCookie)] || "";
  const entry =
    state.length <= 200 && browser.length <= 200
      ? store.consumeState(state, browser)
      : null;

  setCookie(response, cookieKey(request, oauthCookie), "", 0);

  if (!entry || entry.redirect_uri !== `${base}/api/auth/google/callback`) {
    redirect(response, "/?auth_error=invalid_state");
    return;
  }

  if (url.searchParams.has("error")) {
    redirect(response, "/?auth_error=cancelled");
    return;
  }

  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    redirect(response, "/?auth_error=google_not_configured");
    return;
  }

  try {
    const code = url.searchParams.get("code");

    if (!code || code.length > 4096)
      throw new Error("Missing authorization code");

    const tokenResponse = await fetcher(googleToken, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.GOOGLE_CLIENT_ID,
        client_secret: config.GOOGLE_CLIENT_SECRET,
        redirect_uri: entry.redirect_uri,
        grant_type: "authorization_code",
        code_verifier: entry.verifier,
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (!tokenResponse.ok) throw new Error("Google token exchange failed");

    const token = await tokenResponse.json();
    const claims = await verifyGoogleIdToken(
      token.id_token,
      config.GOOGLE_CLIENT_ID,
      entry.nonce,
      fetcher,
    );

    if (
      typeof token.access_token !== "string" ||
      token.token_type?.toLowerCase() !== "bearer"
    )
      throw new Error("Missing Google token");

    const infoResponse = await fetcher(googleUserInfo, {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(12000),
    });

    if (!infoResponse.ok) throw new Error("Google user info failed");

    const info = await infoResponse.json();

    if (info.sub !== claims.sub || info.email_verified !== true)
      throw new Error("Google identity mismatch");

    const email = normalizeEmail(info.email);
    let user = store.byGoogleSub(info.sub);
    let isNewAccount = false;

    if (!user) {
      if (store.byEmail(email)) {
        redirect(response, "/?auth_error=account_exists");
        return;
      }

      user = store.addUser({
        id: randomUUID(),
        email,
        name: String(info.name || email.split("@")[0]).slice(0, 80),
        provider: "google",
        google_sub: info.sub,
        email_verified: true,
      });
      isNewAccount = true;
    }

    startSession(request, response, store, user);
    redirect(
      response,
      isNewAccount ? "/?auth=success&new_account=1" : "/?auth=success",
    );
  } catch {
    redirect(response, "/?auth_error=google_failed");
  }
}

// Authentication routes

export async function handleAuth(request, response, options = {}) {
  let base;

  try {
    base = localBase(request);
  } catch {
    json(response, 403, { message: "Use Orbit’s local server address." });
    return;
  }

  const url = new URL(request.url, base);
  const config = options.config ?? (await readConfig());
  const fetcher = options.fetcher ?? fetch;
  const store = storeFor(options);
  const googleConfigured = Boolean(
    config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET,
  );

  if (
    request.method === "GET" &&
    ["/api/auth/session", "/api/auth/config"].includes(url.pathname)
  ) {
    const token = cookies(request)[cookieKey(request, sessionCookie)];
    const user = token && token.length <= 200 ? store.sessionUser(token) : null;

    json(response, 200, {
      user: publicUser(user),
      googleConfigured,
      googleCallbackUrl: `${base}/api/auth/google/callback`,
    });
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/auth/google/callback"
  ) {
    await googleCallback(request, response, url, store, config, fetcher, base);
    return;
  }

  if (request.method !== "POST") {
    json(response, 404, { message: "Authentication route not found." });
    return;
  }
  if (!sameOrigin(request, base)) {
    json(response, 403, {
      message: "Open Orbit from its local address before signing in.",
    });
    return;
  }
  if (!allowAttempt(request)) {
    json(response, 429, {
      message: "Too many sign-in attempts. Try again in a minute.",
    });
    return;
  }

  if (url.pathname === "/api/auth/logout") {
    const token = cookies(request)[cookieKey(request, sessionCookie)];

    if (token) store.deleteSession(token);

    setCookie(response, cookieKey(request, sessionCookie), "", 0);
    json(response, 200, { user: null });
    return;
  }

  if (url.pathname === "/api/auth/google") {
    if (!googleConfigured) {
      json(response, 503, {
        code: "google_not_configured",
        message:
          "Google sign-in needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local.",
      });
      return;
    }

    const state = randomBytes(32).toString("base64url");
    const browser = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const redirectUri = `${base}/api/auth/google/callback`;
    const authorization = new URL(googleAuthorization);

    authorization.search = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();

    store.addState(state, browser, verifier, nonce, redirectUri);
    setCookie(
      response,
      cookieKey(request, oauthCookie),
      browser,
      Math.floor(stateLifetime / 1000),
    );
    json(response, 200, { url: authorization.href });
    return;
  }

  if (
    !["/api/auth/email", "/api/auth/signup", "/api/auth/login"].includes(
      url.pathname,
    )
  ) {
    json(response, 404, { message: "Authentication route not found." });
    return;
  }

  let body;
  let email;

  try {
    body = await readBody(request);
    email = normalizeEmail(body.email);

    if (url.pathname !== "/api/auth/email") validatePassword(body.password);
  } catch (error) {
    json(response, 400, {
      message: error.message,
      code: error.code || "invalid_request",
    });
    return;
  }

  let user = store.byEmail(email);

  if (url.pathname === "/api/auth/email") {
    json(response, 200, {
      email,
      step: user ? (user.provider === "google" ? "google" : "login") : "signup",
    });
    return;
  }

  if (url.pathname === "/api/auth/signup") {
    if (user) {
      json(response, 409, {
        message: "An account already exists. Log in to continue.",
      });
      return;
    }

    const passwordHash = await hashPassword(body.password);

    try {
      user = store.addUser({
        id: randomUUID(),
        email,
        name: email.split("@")[0].slice(0, 80),
        provider: "email",
        password_hash: passwordHash,
        email_verified: false,
      });
    } catch {
      json(response, 409, {
        message: "An account already exists. Log in to continue.",
      });
      return;
    }
  } else {
    const valid = await verifyPassword(body.password, user?.password_hash);

    if (!valid || !user || user.provider !== "email") {
      json(response, 401, { message: "The email or password is incorrect." });
      return;
    }
  }

  startSession(request, response, store, user);
  json(response, 200, { user: publicUser(user) });
}
