import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { handleOwner } from "../server/owner.mjs";

const openaiKey = "sk-owner-test-only-not-a-live-key-123456789";
const googleId = "123456789-owner-test.apps.googleusercontent.com";
const googleSecret = "GOCSPX-owner-test-only-no-live-access";

// Isolated local setup

async function withOwner(action) {
  const root = await mkdtemp(path.join(os.tmpdir(), "orbit-owner-test-"));
  const server = createServer((request, response) => {
    void handleOwner(request, response, { root }).catch(() => {
      response.writeHead(500);
      response.end("Unexpected test server error");
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await action(base, root);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));

    const resolved = path.resolve(root);

    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("orbit-owner-test-"));
    await rm(resolved, { recursive: true, force: true });
  }
}

function save(base, body, origin = base, headers = {}) {
  return fetch(`${base}/api/owner/credentials`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function directRequest(overrides = {}, options = {}) {
  let status;
  let body;
  const response = {
    writeHead(value) {
      status = value;
    },
    end(value) {
      body = JSON.parse(value);
    },
  };

  await handleOwner(
    {
      method: "GET",
      url: "/api/owner/status",
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "localhost:4310" },
      ...overrides,
    },
    response,
    options,
  );

  return { status, body };
}

test("owner status reports missing connections without creating or disclosing a file", async () => {
  await withOwner(async (base, root) => {
    const response = await fetch(`${base}/api/owner/status`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      available: true,
      openaiConfigured: false,
      googleConfigured: false,
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await readdir(root), []);
  });
});

test("OpenAI saves preserve comments, line endings, model defaults, and other credentials", async () => {
  await withOwner(async (base, root) => {
    const previous =
      "# Keep this comment\r\nOPENAI_API_KEY=old-owner-key\r\nOPENAI_MODEL=custom-model\r\n\r\nGOOGLE_CLIENT_ID=other-client\r\nGOOGLE_CLIENT_SECRET=other-secret\r\nANTHROPIC_API_KEY=leave-this-value\r\n";

    await writeFile(path.join(root, ".env.local"), previous);

    const response = await save(base, {
      action: "save",
      provider: "openai",
      openaiKey,
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), {
      status: "saved",
      available: true,
      openaiConfigured: true,
      googleConfigured: true,
    });
    assert.equal(text.includes(openaiKey), false);
    assert.equal(
      await readFile(path.join(root, ".env.local"), "utf8"),
      previous.replace("old-owner-key", openaiKey),
    );
    assert.deepEqual(await readdir(root), [".env.local"]);
  });
});

test("downloaded Google Web OAuth JSON saves only the two supported values", async () => {
  await withOwner(async (base, root) => {
    await writeFile(
      path.join(root, ".env.local"),
      `OPENAI_API_KEY=${openaiKey}\nOPENAI_MODEL=keep-model\n`,
    );

    const response = await save(base, {
      action: "save",
      provider: "google",
      googleOAuth: JSON.stringify({
        web: {
          client_id: googleId,
          client_secret: googleSecret,
          project_id: "do-not-store",
          token_uri: "https://untrusted.example/token",
          redirect_uris: ["https://untrusted.example/callback"],
        },
      }),
    });
    const text = await response.text();
    const contents = await readFile(path.join(root, ".env.local"), "utf8");

    assert.equal(response.status, 200);
    assert.equal(JSON.parse(text).googleConfigured, true);
    assert.equal(text.includes(googleSecret), false);
    assert.equal(contents.includes(`OPENAI_API_KEY=${openaiKey}`), true);
    assert.equal(contents.includes(`GOOGLE_CLIENT_ID=${googleId}`), true);
    assert.equal(
      contents.includes(`GOOGLE_CLIENT_SECRET=${googleSecret}`),
      true,
    );
    assert.equal(contents.includes("untrusted.example"), false);
    assert.equal(contents.includes("do-not-store"), false);
  });
});

test("blank optional Google fields preserve existing values", async () => {
  await withOwner(async (base, root) => {
    await writeFile(
      path.join(root, ".env.local"),
      `# Existing Google setup\nGOOGLE_CLIENT_ID=old.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=${googleSecret}\n`,
    );

    const response = await save(base, {
      action: "save",
      provider: "google",
      googleClientId: googleId,
      googleClientSecret: "",
    });
    const contents = await readFile(path.join(root, ".env.local"), "utf8");

    assert.equal(response.status, 200);
    assert.equal((await response.json()).googleConfigured, true);
    assert.equal(
      contents.includes(`GOOGLE_CLIENT_SECRET=${googleSecret}`),
      true,
    );
    assert.equal(
      contents.includes(
        `# Existing Google setup\nGOOGLE_CLIENT_ID=${googleId}`,
      ),
      true,
    );
  });
});

test("explicit action, provider, nonempty values, and field whitelist are required", async () => {
  await withOwner(async (base, root) => {
    const original = "# Untouched\nOPENAI_MODEL=keep-model\n";

    await writeFile(path.join(root, ".env.local"), original);

    for (const body of [
      { provider: "openai", openaiKey },
      { action: "save", openaiKey },
      { action: "save", provider: "openai", openaiKey: "" },
      {
        action: "save",
        provider: "openai",
        openaiKey,
        OPENAI_MODEL: "changed",
      },
      { action: "save", provider: "google", googleClientSecret: "" },
      {
        action: "save",
        provider: "openai",
        openaiKey,
        googleClientId: googleId,
      },
      {
        action: "save",
        provider: "google",
        googleOAuth: {
          installed: { client_id: googleId, client_secret: googleSecret },
        },
      },
    ]) {
      const response = await save(base, body);

      assert.equal(response.status, 400);
      assert.equal(
        await readFile(path.join(root, ".env.local"), "utf8"),
        original,
      );
    }
  });
});

test("invalid secret contents cannot inject environment variables or appear in errors", async () => {
  await withOwner(async (base, root) => {
    const injected = `${openaiKey}\nANTHROPIC_API_KEY=injected`;
    const response = await save(base, {
      action: "save",
      provider: "openai",
      openaiKey: injected,
    });
    const text = await response.text();

    assert.equal(response.status, 400);
    assert.equal(text.includes(openaiKey), false);
    assert.equal(text.includes("injected"), false);
    assert.deepEqual(await readdir(root), []);
  });
});

test("cross-origin and missing-origin credential writes are rejected", async () => {
  await withOwner(async (base, root) => {
    for (const origin of ["https://unrelated.example", "null", ""]) {
      const response = await save(
        base,
        { action: "save", provider: "openai", openaiKey },
        origin,
      );

      assert.equal(response.status, 403);
    }

    const response = await save(
      base,
      { action: "save", provider: "openai", openaiKey },
      base,
      { "Sec-Fetch-Site": "cross-site" },
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await readdir(root), []);
  });
});

test("public hosts, nonloopback sockets, and forwarding proxies cannot access owner setup", async () => {
  for (const overrides of [
    { headers: { host: "orbit.example:4310" } },
    { headers: { host: "localhost.attacker.example:4310" } },
    { headers: { host: "localhost:99999" } },
    { socket: { remoteAddress: "203.0.113.42" } },
    {
      headers: { host: "localhost:4310", "x-forwarded-host": "public.example" },
    },
    { headers: { host: "localhost:4310", "x-forwarded-for": "203.0.113.42" } },
    { headers: { host: "localhost:4310", forwarded: "host=public.example" } },
  ]) {
    const result = await directRequest(overrides, {
      readConfig: async () => ({ OPENAI_API_KEY: openaiKey }),
    });

    assert.equal(result.status, 403);
    assert.equal(result.body.available, false);
    assert.equal(JSON.stringify(result.body).includes(openaiKey), false);
  }

  const mapped = await directRequest(
    { socket: { remoteAddress: "::ffff:127.0.0.1" } },
    { readConfig: async () => ({}) },
  );

  assert.equal(mapped.status, 200);
});

test("oversized bodies fail without storing or echoing submitted data", async () => {
  await withOwner(async (base, root) => {
    const response = await save(base, {
      action: "save",
      provider: "openai",
      openaiKey: "x".repeat(66000),
    });
    const text = await response.text();

    assert.equal(response.status, 400);
    assert.equal(JSON.parse(text).code, "body_too_large");
    assert.ok(text.length < 250);
    assert.deepEqual(await readdir(root), []);
  });
});

test("concurrent updates preserve both connections", async () => {
  await withOwner(async (base, root) => {
    const responses = await Promise.all([
      save(base, { action: "save", provider: "openai", openaiKey }),
      save(base, {
        action: "save",
        provider: "google",
        googleClientId: googleId,
        googleClientSecret: googleSecret,
      }),
    ]);

    assert.ok(responses.every((response) => response.status === 200));

    const contents = await readFile(path.join(root, ".env.local"), "utf8");
    const status = await (await fetch(`${base}/api/owner/status`)).json();

    assert.equal(contents.includes(`OPENAI_API_KEY=${openaiKey}`), true);
    assert.equal(
      contents.includes(`GOOGLE_CLIENT_SECRET=${googleSecret}`),
      true,
    );
    assert.deepEqual(status, {
      available: true,
      openaiConfigured: true,
      googleConfigured: true,
    });
  });
});

test("credentials in URL queries are rejected and never reflected", async () => {
  const result = await directRequest({
    url: `/api/owner/status?openaiKey=${openaiKey}`,
  });

  assert.equal(result.status, 400);
  assert.equal(JSON.stringify(result.body).includes(openaiKey), false);
});

test("filesystem failures do not disclose paths or credentials", async () => {
  const sensitive = "private-owner-location";
  const result = await directRequest(
    {},
    {
      readConfig: async () => {
        throw new Error(sensitive);
      },
    },
  );

  assert.equal(result.status, 500);
  assert.equal(JSON.stringify(result.body).includes(sensitive), false);
});
