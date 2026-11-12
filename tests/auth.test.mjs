import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createAuthStore,
  handleAuth,
  hashPassword,
  verifyPassword,
  normalizeEmail,
  verifyGoogleIdToken,
} from "../server/auth.mjs";

const password = "test password 12345";
const googleConfig = {
  GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
};
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "test-rsa-key",
  alg: "RS256",
};

// Isolated local server

async function withServer(options, action) {
  const store = options.store || createAuthStore(":memory:");
  const server = createServer((request, response) => {
    void handleAuth(request, response, { config: {}, ...options, store }).catch(
      () => {
        response.writeHead(500);
        response.end("Unexpected authentication error");
      },
    );
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await action(base, store);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (!options.store) store.close();
  }
}

function post(base, route, body = {}, cookie = "", origin = base) {
  return fetch(base + route, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response, name = "orbit_session") {
  return (
    response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${name}_`))
      ?.split(";")[0] || ""
  );
}

function idToken(overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://accounts.google.com",
      aud: googleConfig.GOOGLE_CLIENT_ID,
      sub: "123456789-google-user",
      email: "google@example.com",
      email_verified: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: "test-nonce",
      ...overrides,
    }),
  ).toString("base64url");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    privateKey,
  ).toString("base64url");

  return `${header}.${payload}.${signature}`;
}

const keyFetcher = async (url) => {
  assert.equal(url, "https://www.googleapis.com/oauth2/v3/certs");
  return Response.json({ keys: [jwk] });
};

test("password hashing uses unique salts and never stores raw passwords", async () => {
  const first = await hashPassword(password);
  const second = await hashPassword(password);

  assert.notEqual(first, second);
  assert.equal(first.includes(password), false);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("incorrect password", first), false);
  assert.equal(await verifyPassword(password, undefined), false);
  await assert.rejects(hashPassword("short"), /at least 6/);
  await assert.rejects(hashPassword("x".repeat(129)), /no more than 128/);

  const minimumHash = await hashPassword("123456");
  const maximum = "x".repeat(128);
  const maximumHash = await hashPassword(maximum);

  assert.equal(await verifyPassword("123456", minimumHash), true);
  assert.equal(await verifyPassword(maximum, maximumHash), true);
  assert.equal(normalizeEmail(" User@Example.COM "), "user@example.com");
  assert.throws(() => normalizeEmail("not-email"), /valid email/);
});

test("email signup, cookie session, logout, and login work without cloud credentials", async () => {
  await withServer({}, async (base, store) => {
    const empty = await fetch(base + "/api/auth/session");
    const emptyBody = await empty.json();

    assert.equal(emptyBody.user, null);
    assert.equal(emptyBody.googleConfigured, false);
    assert.equal(
      emptyBody.googleCallbackUrl,
      base + "/api/auth/google/callback",
    );

    const check = await post(base, "/api/auth/email", {
      email: "Test@example.com",
    });

    assert.equal((await check.json()).step, "signup");

    const signup = await post(base, "/api/auth/signup", {
      email: "Test@example.com",
      password,
    });
    const user = (await signup.json()).user;
    const cookie = cookieFrom(signup);

    assert.equal(signup.status, 200);
    assert.equal(user.email, "test@example.com");
    assert.equal(user.provider, "email");
    assert.equal(user.emailVerified, false);
    assert.equal(user.password_hash, undefined);
    assert.match(signup.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);

    const session = await fetch(base + "/api/auth/session", {
      headers: { Cookie: cookie },
    });

    assert.equal((await session.json()).user.id, user.id);
    assert.equal(
      store.db
        .prepare("SELECT token_hash FROM sessions")
        .get()
        .token_hash.includes(cookie.split("=")[1]),
      false,
    );

    const logout = await post(base, "/api/auth/logout", {}, cookie);

    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal(
      (
        await (
          await fetch(base + "/api/auth/session", {
            headers: { Cookie: cookie },
          })
        ).json()
      ).user,
      null,
    );

    const existing = await post(base, "/api/auth/email", {
      email: "test@example.com",
    });

    assert.equal((await existing.json()).step, "login");

    const wrong = await post(base, "/api/auth/login", {
      email: "test@example.com",
      password: "wrong password 123",
    });

    assert.equal(wrong.status, 401);

    const login = await post(base, "/api/auth/login", {
      email: "test@example.com",
      password,
    });

    assert.equal(login.status, 200);
    assert.notEqual(cookieFrom(login), cookie);
  });
});

test("six-character passwords work and limit errors are explicit", async () => {
  await withServer({}, async (base) => {
    for (const [candidate, code, message] of [
      ["short", "password_too_short", "Use at least 6 characters"],
      ["x".repeat(129), "password_too_long", "Use no more than 128 characters"],
    ]) {
      const invalid = await post(base, "/api/auth/signup", {
        email: "limits@example.com",
        password: candidate,
      });
      const detail = await invalid.json();

      assert.equal(invalid.status, 400);
      assert.equal(detail.code, code);
      assert.equal(detail.message, message);
    }

    const signup = await post(base, "/api/auth/signup", {
      email: "limits@example.com",
      password: "123456",
    });

    assert.equal(signup.status, 200);

    const login = await post(base, "/api/auth/login", {
      email: "limits@example.com",
      password: "123456",
    });

    assert.equal(login.status, 200);
  });
});

test("accounts persist across database reopen without raw credentials", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "orbit-auth-test-"));
  let store;

  try {
    store = createAuthStore(temporary);
    const passwordHash = await hashPassword(password);

    store.addUser({
      id: "persisted",
      email: "persist@example.com",
      name: "Persist",
      provider: "email",
      password_hash: passwordHash,
    });
    store.close();
    store = createAuthStore(temporary);

    assert.equal(
      await verifyPassword(
        password,
        store.byEmail("persist@example.com").password_hash,
      ),
      true,
    );
  } finally {
    store?.close();
    const resolved = path.resolve(temporary);

    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("orbit-auth-test-"));
    await rm(resolved, { recursive: true, force: true });
  }
});

test("cross-origin requests, invalid passwords, duplicate signup, and invalid hosts fail", async () => {
  await withServer({}, async (base) => {
    assert.equal(
      (
        await post(
          base,
          "/api/auth/signup",
          { email: "one@example.com", password },
          "",
          "https://unrelated.example",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(base, "/api/auth/signup", {
          email: "one@example.com",
          password: "short",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post(base, "/api/auth/signup", {
          email: "one@example.com",
          password,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await post(base, "/api/auth/signup", {
          email: "one@example.com",
          password,
        })
      ).status,
      409,
    );

    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(
        base + "/api/auth/session",
        {
          headers: { Host: "evil.example:1234" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );

      request.on("error", reject);
      request.end();
    });

    assert.equal(status, 403);
  });
});

test("missing Google credentials produce explicit configuration status", async () => {
  await withServer({}, async (base) => {
    const response = await post(base, "/api/auth/google");
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.code, "google_not_configured");
    assert.match(body.message, /GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET/);
  });
});

test("simultaneous local Orbit ports keep login cookies separate", async () => {
  await withServer({}, async (firstBase) => {
    await withServer({}, async (secondBase) => {
      const first = await post(firstBase, "/api/auth/signup", {
        email: "ports@example.com",
        password,
      });
      const second = await post(secondBase, "/api/auth/signup", {
        email: "ports@example.com",
        password,
      });
      const firstCookie = cookieFrom(first);
      const secondCookie = cookieFrom(second);

      assert.notEqual(firstCookie.split("=")[0], secondCookie.split("=")[0]);

      const cookies = `${firstCookie}; ${secondCookie}`;
      const firstUser = (
        await (
          await fetch(firstBase + "/api/auth/session", {
            headers: { Cookie: cookies },
          })
        ).json()
      ).user;
      const secondUser = (
        await (
          await fetch(secondBase + "/api/auth/session", {
            headers: { Cookie: cookies },
          })
        ).json()
      ).user;

      assert.ok(firstUser);
      assert.ok(secondUser);
      assert.notEqual(firstUser.id, secondUser.id);
    });
  });
});

test("Google authorization uses account chooser, PKCE, browser-bound state, and nonce", async () => {
  await withServer({ config: googleConfig }, async (base, store) => {
    const response = await post(base, "/api/auth/google");
    const text = await response.text();
    const authorization = new URL(JSON.parse(text).url);
    const cookie = cookieFrom(response, "orbit_oauth");
    const state = authorization.searchParams.get("state");

    assert.equal(
      authorization.origin + authorization.pathname,
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    assert.equal(authorization.searchParams.get("prompt"), "select_account");
    assert.equal(
      authorization.searchParams.get("code_challenge_method"),
      "S256",
    );
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      base + "/api/auth/google/callback",
    );
    assert.equal(text.includes(googleConfig.GOOGLE_CLIENT_SECRET), false);
    assert.ok(authorization.searchParams.get("nonce"));

    const failed = await fetch(
      base + `/api/auth/google/callback?state=${state}&code=test`,
      { redirect: "manual" },
    );

    assert.equal(failed.headers.get("location"), "/?auth_error=invalid_state");
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM oauth_states").get()
        .count,
      1,
    );

    const cancelled = await fetch(
      base + `/api/auth/google/callback?state=${state}&error=access_denied`,
      { headers: { Cookie: cookie }, redirect: "manual" },
    );

    assert.equal(cancelled.headers.get("location"), "/?auth_error=cancelled");
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM oauth_states").get()
        .count,
      0,
    );
  });
});

test("Google ID token validation checks signatures, audience, nonce, issuer, verification, and expiry", async () => {
  const valid = idToken();

  assert.equal(
    (
      await verifyGoogleIdToken(
        valid,
        googleConfig.GOOGLE_CLIENT_ID,
        "test-nonce",
        keyFetcher,
      )
    ).sub,
    "123456789-google-user",
  );

  for (const override of [
    { aud: "another-client" },
    { nonce: "another-nonce" },
    { iss: "https://untrusted.example" },
    { email_verified: false },
    { exp: Math.floor(Date.now() / 1000) - 10 },
  ]) {
    await assert.rejects(
      verifyGoogleIdToken(
        idToken(override),
        googleConfig.GOOGLE_CLIENT_ID,
        "test-nonce",
        keyFetcher,
      ),
      /Invalid Google identity/,
    );
  }

  await assert.rejects(
    verifyGoogleIdToken(
      valid.slice(0, -8) + "AAAAAAAA",
      googleConfig.GOOGLE_CLIENT_ID,
      "test-nonce",
      keyFetcher,
    ),
    /Invalid Google identity/,
  );
});

test("Google callback distinguishes a newly created account from an existing Google login without exposing tokens", async () => {
  let nonce;
  let verifier;

  const fetcher = async (url, request = {}) => {
    if (url === "https://oauth2.googleapis.com/token") {
      verifier = request.body.get("code_verifier");
      assert.equal(
        request.body.get("client_secret"),
        googleConfig.GOOGLE_CLIENT_SECRET,
      );
      return Response.json({
        id_token: idToken({ nonce }),
        access_token: "test-access-token",
        token_type: "Bearer",
      });
    }

    if (url === "https://www.googleapis.com/oauth2/v3/certs")
      return Response.json({ keys: [jwk] });

    assert.equal(url, "https://openidconnect.googleapis.com/v1/userinfo");
    assert.equal(request.headers.Authorization, "Bearer test-access-token");
    return Response.json({
      sub: "123456789-google-user",
      email: "google@example.com",
      email_verified: true,
      name: "Google User",
    });
  };

  await withServer({ config: googleConfig, fetcher }, async (base, store) => {
    const start = await post(base, "/api/auth/google");
    const authorization = new URL((await start.json()).url);
    const cookie = cookieFrom(start, "orbit_oauth");

    nonce = authorization.searchParams.get("nonce");

    const callback = await fetch(
      base +
        `/api/auth/google/callback?state=${authorization.searchParams.get("state")}&code=test`,
      {
        headers: { Cookie: cookie },
        redirect: "manual",
      },
    );

    assert.equal(
      callback.headers.get("location"),
      "/?auth=success&new_account=1",
    );
    assert.equal(
      createHash("sha256").update(verifier).digest("base64url"),
      authorization.searchParams.get("code_challenge"),
    );
    assert.equal(store.byGoogleSub("123456789-google-user").email_verified, 1);

    const session = await fetch(base + "/api/auth/session", {
      headers: { Cookie: cookieFrom(callback) },
    });
    const text = await session.text();

    assert.equal(JSON.parse(text).user.provider, "google");
    assert.equal(text.includes("test-access-token"), false);
    assert.equal(text.includes(googleConfig.GOOGLE_CLIENT_SECRET), false);

    const replay = await fetch(
      base +
        `/api/auth/google/callback?state=${authorization.searchParams.get("state")}&code=test`,
      {
        headers: { Cookie: cookie },
        redirect: "manual",
      },
    );

    assert.equal(replay.headers.get("location"), "/?auth_error=invalid_state");

    const loginStart = await post(base, "/api/auth/google");
    const loginAuthorization = new URL((await loginStart.json()).url);
    const loginCookie = cookieFrom(loginStart, "orbit_oauth");

    nonce = loginAuthorization.searchParams.get("nonce");

    const existing = await fetch(
      base +
        `/api/auth/google/callback?state=${loginAuthorization.searchParams.get("state")}&code=existing-account`,
      {
        headers: { Cookie: loginCookie },
        redirect: "manual",
      },
    );

    assert.equal(existing.headers.get("location"), "/?auth=success");
    assert.equal(
      new URL(existing.headers.get("location"), base).searchParams.has(
        "new_account",
      ),
      false,
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
      1,
    );

    const existingSession = await fetch(base + "/api/auth/session", {
      headers: { Cookie: cookieFrom(existing) },
    });

    assert.equal(
      (await existingSession.json()).user.id,
      JSON.parse(text).user.id,
    );
  });
});

test("Google cannot silently take over an existing password account with the same email", async () => {
  let nonce;
  const fetcher = async (url) => {
    if (url.endsWith("/token"))
      return Response.json({
        id_token: idToken({ nonce }),
        access_token: "test-token",
        token_type: "Bearer",
      });
    if (url.endsWith("/certs")) return Response.json({ keys: [jwk] });
    return Response.json({
      sub: "123456789-google-user",
      email: "google@example.com",
      email_verified: true,
    });
  };

  await withServer({ config: googleConfig, fetcher }, async (base) => {
    await post(base, "/api/auth/signup", {
      email: "google@example.com",
      password,
    });

    const start = await post(base, "/api/auth/google");
    const authorization = new URL((await start.json()).url);

    nonce = authorization.searchParams.get("nonce");

    const callback = await fetch(
      base +
        `/api/auth/google/callback?state=${authorization.searchParams.get("state")}&code=test`,
      {
        headers: { Cookie: cookieFrom(start, "orbit_oauth") },
        redirect: "manual",
      },
    );

    assert.equal(
      callback.headers.get("location"),
      "/?auth_error=account_exists",
    );
    assert.equal(cookieFrom(callback), "");
  });
});
