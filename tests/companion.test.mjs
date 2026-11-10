import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runInNewContext } from "node:vm";
import {
  createCompanionState,
  handleCompanion,
  normalizeContext,
} from "../server/companion.mjs";

const chromeOrigin = `chrome-extension://${"a".repeat(32)}`;
const otherOrigin = `chrome-extension://${"b".repeat(32)}`;

// Isolated loopback bridge

async function withServer(action, options = {}) {
  const state = options.state || createCompanionState({ directory: null });
  const server = createServer((request, response) => {
    void handleCompanion(request, response, { state }).catch(() => {
      response.writeHead(500);
      response.end("Unexpected bridge error");
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await action(base, state);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function webPost(base, route, body = {}, origin = base) {
  return fetch(`${base}/api/companion/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

function nativeRequest(base, route, token, body, origin) {
  const headers = {};

  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (origin) headers.Origin = origin;

  return fetch(`${base}/api/companion/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function pair(base, kind = "desktop", origin) {
  const codeResponse = await webPost(base, "pair-code");
  const { code } = await codeResponse.json();
  const response = await nativeRequest(
    base,
    "pair",
    "",
    { code, kind, name: "Test companion" },
    origin,
  );

  assert.equal(response.status, 200);
  return response.json();
}

async function select(base, clientId = "test-client-123", overrides = {}) {
  return webPost(base, "selection", {
    clientId,
    provider: "openai",
    model: "gpt-6.1-sol",
    visible: true,
    ...overrides,
  });
}

async function events(base, clientId = "test-client-123") {
  const response = await fetch(
    `${base}/api/companion/events?clientId=${clientId}&after=0`,
  );

  return response.json();
}

test("pairing codes are one-use and cannot be created cross-origin", async () => {
  await withServer(async (base) => {
    assert.equal(
      (await webPost(base, "pair-code", {}, "https://unrelated.example"))
        .status,
      403,
    );

    const { code } = await (await webPost(base, "pair-code")).json();
    const first = await nativeRequest(base, "pair", "", {
      code,
      kind: "desktop",
    });

    assert.equal(first.status, 200);
    assert.equal(
      (await nativeRequest(base, "pair", "", { code, kind: "desktop" })).status,
      401,
    );
    assert.equal((await nativeRequest(base, "state")).status, 401);
  });
});

test("pairing expiration and attempt limits reject guessing", async () => {
  let now = Date.now();

  await withServer(
    async (base) => {
      const { code } = await (await webPost(base, "pair-code")).json();

      now += 120001;
      assert.equal(
        (await nativeRequest(base, "pair", "", { code, kind: "desktop" }))
          .status,
        401,
      );

      for (let index = 0; index < 7; index += 1)
        await nativeRequest(base, "pair", "", {
          code: "4310-00000000",
          kind: "desktop",
        });

      assert.equal(
        (await nativeRequest(base, "pair", "", { code, kind: "desktop" }))
          .status,
        429,
      );
    },
    { state: createCompanionState({ directory: null, clock: () => now }) },
  );
});

test("native context and inline messages route to the selected Orbit client", async () => {
  await withServer(async (base) => {
    const { token } = await pair(base);

    assert.equal((await select(base)).status, 200);

    const context = {
      source: "desktop",
      app: "notepad",
      windowTitle: "Current note",
      text: "Only the focused window",
      capturedAt: new Date().toISOString(),
    };

    assert.equal(
      (await nativeRequest(base, "context", token, context)).status,
      200,
    );

    const sent = await (
      await nativeRequest(base, "message", token, {
        text: "Explain this note",
        context,
      })
    ).json();
    const inbox = await events(base);

    assert.equal(inbox.events[0].type, "context");
    assert.equal(inbox.events[0].context.text, context.text);
    assert.equal(inbox.events[1].type, "message");
    assert.equal(inbox.events[1].id, sent.messageId);
    assert.equal((await events(base, "other-client-123")).events.length, 0);

    await webPost(base, "reply", {
      clientId: "test-client-123",
      messageId: sent.messageId,
      text: "A reply from the selected provider",
    });

    const status = await (await nativeRequest(base, "state", token)).json();

    assert.equal(status.provider, "openai");
    assert.equal(status.model, "gpt-6.1-sol");
    assert.equal(status.latestReply.text, "A reply from the selected provider");
    assert.equal(
      (
        await webPost(base, "reply", {
          clientId: "test-client-123",
          messageId: sent.messageId,
          text: "A reply from the selected provider",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await webPost(base, "reply", {
          clientId: "other-client-123",
          messageId: sent.messageId,
          text: "Wrong chat",
        })
      ).status,
      409,
    );
  });
});

test("background Orbit tabs do not steal the selected AI", async () => {
  await withServer(async (base) => {
    const { token } = await pair(base);

    await select(base, "first-client-123");
    await select(base, "second-client-123", {
      provider: "claude",
      model: "claude-sonnet-5-5",
    });

    let status = await (await nativeRequest(base, "state", token)).json();

    assert.equal(status.provider, "openai");

    await select(base, "second-client-123", {
      provider: "claude",
      model: "claude-sonnet-5-5",
      takeControl: true,
    });
    status = await (await nativeRequest(base, "state", token)).json();

    assert.equal(status.provider, "claude");
  });
});

test("stale website selection cannot silently accept a native message", async () => {
  let now = Date.now();

  await withServer(
    async (base) => {
      const { token } = await pair(base);

      await select(base);
      now += 150001;

      assert.equal(
        (await nativeRequest(base, "message", token, { text: "Hello" })).status,
        409,
      );
    },
    { state: createCompanionState({ directory: null, clock: () => now }) },
  );
});

test("Chrome extension tokens are origin-bound and cannot send user messages", async () => {
  await withServer(async (base) => {
    const { token } = await pair(base, "extension", chromeOrigin);

    const good = await nativeRequest(
      base,
      "state",
      token,
      undefined,
      chromeOrigin,
    );

    assert.equal(good.status, 200);
    assert.equal(good.headers.get("Access-Control-Allow-Origin"), chromeOrigin);
    assert.equal(
      (await nativeRequest(base, "state", token, undefined, otherOrigin))
        .status,
      401,
    );
    assert.equal(
      (
        await nativeRequest(
          base,
          "message",
          token,
          { text: "Not a Windows sender" },
          chromeOrigin,
        )
      ).status,
      401,
    );

    const blocked = await fetch(`${base}/api/companion/state`, {
      method: "OPTIONS",
      headers: { Origin: "https://unrelated.example" },
    });

    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get("Access-Control-Allow-Origin"), null);
  });
});

test("browser snapshots exclude URL queries and become stale after fifteen seconds", async () => {
  let now = Date.now();

  await withServer(
    async (base) => {
      const desktop = await pair(base);
      const extension = await pair(base, "extension", chromeOrigin);

      await select(base);
      await nativeRequest(
        base,
        "context",
        extension.token,
        {
          text: "Visible page",
          title: "Article",
          url: "https://example.com/article?secret=token#fragment",
        },
        chromeOrigin,
      );

      let status = await (
        await nativeRequest(base, "state", desktop.token)
      ).json();

      assert.equal(status.context.source, "browser");
      assert.equal(status.context.app, "chrome");
      assert.equal(status.context.url, "https://example.com/article");

      now += 15001;
      status = await (await nativeRequest(base, "state", desktop.token)).json();

      assert.equal(status.context, null);
    },
    { state: createCompanionState({ directory: null, clock: () => now }) },
  );
});

test("pause and revoke immediately stop capture and invalidate tokens", async () => {
  await withServer(async (base) => {
    const { token } = await pair(base);

    await select(base);
    await webPost(base, "pause", { paused: true });

    const capture = await (
      await nativeRequest(base, "context", token, {
        text: "Should not enter memory",
      })
    ).json();

    assert.equal(capture.stored, false);
    assert.equal(
      (await events(base)).events.some((event) =>
        ["context", "message"].includes(event.type),
      ),
      false,
    );

    await webPost(base, "revoke", { kind: "desktop" });

    assert.equal((await nativeRequest(base, "state", token)).status, 401);
  });
});

// Website lifecycle controls

test("Hide and Unhide preserve connection and reading, with Quit available while hidden", async () => {
  await withServer(async (base, state) => {
    const { token } = await pair(base);
    assert.equal(
      (await (await nativeRequest(base, "state", token)).json()).hidden,
      false,
    );
    assert.equal(
      (
        await webPost(
          base,
          "visibility",
          { hidden: true },
          "https://unrelated.example",
        )
      ).status,
      403,
    );
    assert.equal(
      (await nativeRequest(base, "visibility", token, { hidden: true })).status,
      403,
    );
    assert.equal(
      (await webPost(base, "visibility", { hidden: "true" })).status,
      400,
    );
    assert.equal(state.hidden, false);

    assert.equal(
      (await webPost(base, "visibility", { hidden: true })).status,
      200,
    );
    assert.equal(
      (await (await nativeRequest(base, "state", token)).json()).hidden,
      true,
    );
    const status = await (await fetch(`${base}/api/companion/status`)).json();
    assert.equal(status.hidden, true);
    assert.equal(status.desktopConnected, true);
    assert.equal(status.paused, false);
    const context = await (
      await nativeRequest(base, "context", token, {
        text: "Synthetic window while cat is hidden",
      })
    ).json();
    assert.equal(context.stored, true);
    assert.equal(state.peers.size, 1);

    await webPost(base, "visibility", { hidden: false });
    assert.equal(
      (await (await nativeRequest(base, "state", token)).json()).hidden,
      false,
    );
    await webPost(base, "visibility", { hidden: true });
    await webPost(base, "quit");
    assert.equal(state.hidden, false);
    assert.equal(
      (await (await nativeRequest(base, "state", token)).json()).command,
      "quit",
    );
  });
});

for (const command of ["disconnect", "quit"]) {
  test(`${command} clears pairing immediately and delivers only a bounded native control`, async () => {
    let now = Date.now();
    await withServer(
      async (base, state) => {
        const { token } = await pair(base);
        const extension = await pair(base, "extension", chromeOrigin);
        await select(base);
        await nativeRequest(base, "context", token, {
          text: "Current synthetic window",
        });
        await webPost(base, "pause", { paused: true });

        assert.equal(
          (await webPost(base, command, {}, "https://unrelated.example"))
            .status,
          403,
        );
        assert.equal(
          (await nativeRequest(base, command, token, {})).status,
          403,
        );
        assert.equal(state.peers.size, 2);

        assert.equal((await webPost(base, command)).status, 200);
        const status = await (
          await fetch(`${base}/api/companion/status`)
        ).json();
        assert.equal(status.desktopConnected, false);
        assert.equal(status.extensionConnected, false);
        assert.equal(status.pairedDesktop, 0);
        assert.equal(status.pairedExtension, 0);
        assert.equal(status.paused, false);
        assert.equal(status.contextFresh, false);

        const control = await (
          await nativeRequest(base, "state", token)
        ).json();
        assert.equal(control.paired, false);
        assert.equal(control.command, command);
        if (command === "quit") {
          assert.equal(control.reconnect.baseUrl, base);
          assert.match(control.reconnect.ticket, /^[A-Za-z0-9_-]{43}$/);
        } else assert.equal(control.reconnect, undefined);
        assert.deepEqual(
          await (await nativeRequest(base, "state", token)).json(),
          control,
        );
        assert.equal(
          (
            await nativeRequest(
              base,
              "state",
              token,
              undefined,
              "https://unrelated.example",
            )
          ).status,
          401,
        );
        assert.equal(
          (
            await nativeRequest(
              base,
              "state",
              extension.token,
              undefined,
              chromeOrigin,
            )
          ).status,
          401,
        );
        assert.equal(
          (
            await nativeRequest(base, "context", token, {
              text: "Revoked capture",
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await nativeRequest(base, "message", token, {
              text: "Revoked message",
            })
          ).status,
          401,
        );
        assert.equal(state.currentContext, null);
        assert.equal(state.pendingMessages.size, 0);

        const replacement = await pair(base);
        assert.equal(
          (await nativeRequest(base, "state", replacement.token)).status,
          200,
        );
        now += 120001;
        assert.equal((await nativeRequest(base, "state", token)).status, 401);
        assert.equal(state.pendingControls.size, 0);
        if (command === "quit") {
          const resumed = await nativeRequest(base, "activate", "", {
            ticket: control.reconnect.ticket,
          });
          assert.equal(resumed.status, 200);
          const fresh = await resumed.json();
          assert.equal(
            (await nativeRequest(base, "state", fresh.token)).status,
            200,
          );
          assert.equal(
            (
              await nativeRequest(base, "activate", "", {
                ticket: control.reconnect.ticket,
              })
            ).status,
            401,
          );
        }
      },
      { state: createCompanionState({ directory: null, clock: () => now }) },
    );
  });
}

// Automatic installer activation

async function downloadInstall(base) {
  const response = await webPost(base, "installer");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /attachment/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const bytes = Buffer.from(await response.arrayBuffer());
  const marker = Buffer.from("ORBIT_INSTALL_V1");
  assert.equal(bytes.subarray(0, 2).toString(), "MZ");
  assert.ok(bytes.subarray(-marker.length).equals(marker));
  const size = bytes.readUInt32LE(bytes.length - marker.length - 4);
  assert.ok(size > 0 && size <= 2048);
  return JSON.parse(
    bytes.subarray(-marker.length - 4 - size, -marker.length - 4).toString(),
  );
}

test("downloaded installer activates once without a manual pairing code", async () => {
  await withServer(async (base, state) => {
    assert.equal(
      (await webPost(base, "installer", {}, "https://unrelated.example"))
        .status,
      403,
    );
    assert.equal((await nativeRequest(base, "installer", "", {})).status, 403);
    const grant = await downloadInstall(base);
    assert.equal(grant.baseUrl, base);
    assert.match(grant.ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(state.peers.size, 0);
    assert.equal(
      (await (await fetch(`${base}/api/companion/status`)).json())
        .desktopConnected,
      false,
    );
    assert.equal(
      (await webPost(base, "activate", { ticket: grant.ticket })).status,
      403,
    );
    assert.equal(
      (
        await nativeRequest(
          base,
          "activate",
          "",
          { ticket: grant.ticket },
          chromeOrigin,
        )
      ).status,
      403,
    );
    const activated = await nativeRequest(base, "activate", "", {
      ticket: grant.ticket,
    });
    assert.equal(activated.status, 200);
    const credentials = await activated.json();
    assert.equal(credentials.kind, "desktop");
    assert.equal(credentials.baseUrl, base);
    assert.equal(
      (await nativeRequest(base, "state", credentials.token)).status,
      200,
    );
    assert.equal(
      (await nativeRequest(base, "activate", "", { ticket: grant.ticket }))
        .status,
      401,
    );
  });
});

test("installer activation survives a server restart with only hashed grants stored", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "orbit-install-test-"),
  );
  let grant;
  try {
    await withServer(
      async (base) => {
        grant = await downloadInstall(base);
      },
      { state: createCompanionState({ directory }) },
    );
    const saved = await readFile(
      path.join(directory, "companion-peers.json"),
      "utf8",
    );
    assert.equal(saved.includes(grant.ticket), false);
    assert.match(saved, /"installs":\[\{"hash":"[a-f0-9]{64}"/);
    await withServer(
      async (base) => {
        const activated = await nativeRequest(base, "activate", "", {
          ticket: grant.ticket,
        });
        assert.equal(activated.status, 200);
      },
      { state: createCompanionState({ directory }) },
    );
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired and revoked installer grants cannot start a companion", async () => {
  let now = Date.now();
  await withServer(
    async (base, state) => {
      const expired = await downloadInstall(base);
      now += 86400001;
      assert.equal(
        (await nativeRequest(base, "activate", "", { ticket: expired.ticket }))
          .status,
        401,
      );
      const revoked = await downloadInstall(base);
      await webPost(base, "revoke");
      assert.equal(
        (await nativeRequest(base, "activate", "", { ticket: revoked.ticket }))
          .status,
        401,
      );
      assert.equal(state.peers.size, 0);
    },
    { state: createCompanionState({ directory: null, clock: () => now }) },
  );
});

test("only hashed pairing credentials persist across server restarts", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "orbit-companion-test-"),
  );
  let token;

  try {
    await withServer(
      async (base) => {
        ({ token } = await pair(base));
      },
      { state: createCompanionState({ directory }) },
    );

    const saved = await readFile(
      path.join(directory, "companion-peers.json"),
      "utf8",
    );

    assert.equal(saved.includes(token), false);
    assert.match(saved, /"hash":"[a-f0-9]{64}"/);

    await withServer(
      async (base) => {
        assert.equal((await nativeRequest(base, "state", token)).status, 200);
      },
      { state: createCompanionState({ directory }) },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("snapshot input boundaries reject oversized text and unsafe URLs", () => {
  assert.throws(
    () => normalizeContext({ text: "x".repeat(30001) }, "desktop"),
    /30,000/,
  );
  assert.throws(
    () =>
      normalizeContext({ text: "Text", url: "file:///C:/private" }, "browser"),
    /normal browser page/,
  );
  assert.throws(
    () =>
      normalizeContext(
        { text: "Text", url: "https://secret:password@example.com" },
        "browser",
      ),
    /normal browser page/,
  );
});

test("a website cursor recovers after the bridge restarts", async () => {
  await withServer(async (base) => {
    await select(base);

    const response = await fetch(
      `${base}/api/companion/events?clientId=test-client-123&after=999`,
    );
    const inbox = await response.json();

    assert.equal(inbox.cursor, 0);
    assert.equal(typeof inbox.instanceId, "string");
  });
});

test("web current-context requires the Orbit origin and expires stale snapshots", async () => {
  let now = Date.now();

  await withServer(
    async (base) => {
      const { token } = await pair(base);

      await select(base);
      await nativeRequest(base, "context", token, {
        text: "Fresh visible text",
        app: "notepad",
      });

      let current = await (
        await fetch(`${base}/api/companion/current-context`)
      ).json();

      assert.equal(current.context.text, "Fresh visible text");
      assert.equal(current.paused, false);
      assert.equal(
        (await nativeRequest(base, "current-context", token)).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${base}/api/companion/current-context`, {
            headers: { Origin: "https://unrelated.example" },
          })
        ).status,
        403,
      );

      now += 15001;
      current = await (
        await fetch(`${base}/api/companion/current-context`)
      ).json();

      assert.equal(current.context, null);
      assert.equal(
        (await (await fetch(`${base}/api/companion/status`)).json())
          .contextFresh,
        false,
      );

      await nativeRequest(base, "context", token, {
        text: "Updated visible text",
        app: "notepad",
      });
      await webPost(base, "pause", { paused: true });
      current = await (
        await fetch(`${base}/api/companion/current-context`)
      ).json();

      assert.equal(current.context, null);
      assert.equal(current.paused, true);
    },
    { state: createCompanionState({ directory: null, clock: () => now }) },
  );
});

test("native messages never attach stale or explicitly excluded prior-window context", async () => {
  let now = Date.now();

  await withServer(
    async (base) => {
      const { token } = await pair(base);

      await select(base);
      await nativeRequest(base, "context", token, {
        text: "Previous app text",
        app: "notepad",
      });
      await nativeRequest(base, "message", token, {
        text: "No current readable target",
        useCurrentContext: false,
      });

      let inbox = await events(base);

      assert.equal(
        inbox.events.find((event) => event.type === "message").context,
        null,
      );

      now += 15001;
      await nativeRequest(base, "message", token, { text: "Expired snapshot" });
      inbox = await events(base);

      assert.equal(
        inbox.events.filter((event) => event.type === "message").at(-1).context,
        null,
      );

      await nativeRequest(base, "message", token, {
        text: "Explicit expired snapshot",
        context: {
          text: "Old secret",
          app: "notepad",
          capturedAt: new Date(now - 30000).toISOString(),
        },
      });
      inbox = await events(base);

      assert.equal(
        inbox.events.filter((event) => event.type === "message").at(-1).context,
        null,
      );
    },
    { state: createCompanionState({ directory: null, clock: () => now }) },
  );
});

test("unchanged foreground capture heartbeats refresh freshness without duplicate memories", async () => {
  let now = Date.now();

  await withServer(
    async (base) => {
      const { token } = await pair(base);

      await select(base);
      await nativeRequest(base, "context", token, {
        text: "Unchanged focused document",
        app: "notepad",
      });
      now += 10000;
      await nativeRequest(base, "context", token, {
        text: "Unchanged focused document",
        app: "notepad",
      });
      now += 10000;

      const current = await (
        await fetch(`${base}/api/companion/current-context`)
      ).json();

      assert.equal(current.context.text, "Unchanged focused document");
      assert.equal(
        (await events(base)).events.filter((event) => event.type === "context")
          .length,
        1,
      );
    },
    { state: createCompanionState({ directory: null, clock: () => now }) },
  );
});

test("tab invalidation is extension-only and rejects delayed captures from the previous tab", async () => {
  let now = Date.now();

  await withServer(
    async (base) => {
      const desktop = await pair(base);
      const extension = await pair(base, "extension", chromeOrigin);

      await select(base);

      const oldCapture = {
        text: "Tab A",
        app: "chrome",
        url: "https://example.test/a",
        capturedAt: new Date(now).toISOString(),
      };

      await nativeRequest(
        base,
        "context",
        extension.token,
        oldCapture,
        chromeOrigin,
      );

      const invalidation = { source: "browser", reason: "active-tab-changed" };

      assert.equal(
        (await nativeRequest(base, "invalidate", "", invalidation)).status,
        401,
      );
      assert.equal(
        (await nativeRequest(base, "invalidate", desktop.token, invalidation))
          .status,
        403,
      );
      assert.equal(
        (
          await nativeRequest(
            base,
            "invalidate",
            extension.token,
            invalidation,
            otherOrigin,
          )
        ).status,
        401,
      );

      now += 5;
      assert.equal(
        (
          await nativeRequest(
            base,
            "invalidate",
            extension.token,
            invalidation,
            chromeOrigin,
          )
        ).status,
        200,
      );
      assert.equal(
        (await (await fetch(`${base}/api/companion/current-context`)).json())
          .context,
        null,
      );
      assert.equal(
        (
          await nativeRequest(
            base,
            "context",
            extension.token,
            oldCapture,
            chromeOrigin,
          )
        ).status,
        400,
      );

      await nativeRequest(base, "message", desktop.token, {
        text: "Explain the loading page",
        context: oldCapture,
      });

      assert.equal(
        (await events(base)).events
          .filter((event) => event.type === "message")
          .at(-1).context,
        null,
      );

      now += 1;
      await nativeRequest(
        base,
        "context",
        extension.token,
        {
          ...oldCapture,
          text: "Tab B",
          capturedAt: new Date(now).toISOString(),
        },
        chromeOrigin,
      );

      assert.equal(
        (await (await fetch(`${base}/api/companion/current-context`)).json())
          .context.text,
        "Tab B",
      );
      assert.ok(
        (await events(base)).events.some(
          (event) => event.type === "context-invalidated",
        ),
      );
    },
    { state: createCompanionState({ directory: null, clock: () => now }) },
  );
});

test("automatic captured context redacts credentials before memory or AI delivery", () => {
  const tokens = [
    "sk-" + "a".repeat(24),
    "GOCSPX-" + "b".repeat(24),
    "AIza" + "c".repeat(24),
    "pplx-" + "d".repeat(24),
    "xai-" + "e".repeat(24),
  ];
  const context = normalizeContext(
    {
      title: `Settings ${tokens[0]}`,
      text: `Normal document heading\nOPENAI_API_KEY=${tokens[0]}\nGOOGLE_CLIENT_SECRET="${tokens[1]}"\nMY_ACCESS_TOKEN=plain-access-value\nDATABASE_PASSWORD=plain-password-value\n${tokens.join("\n")}\nNormal document tail`,
    },
    "desktop",
  );
  const serialized = JSON.stringify(context);

  for (const token of [...tokens, "plain-access-value", "plain-password-value"])
    assert.equal(serialized.includes(token), false);

  assert.match(context.text, /OPENAI_API_KEY=\[redacted\]/);
  assert.match(context.text, /DATABASE_PASSWORD=\[redacted\]/);
  assert.match(context.text, /^Normal document heading/);
  assert.match(context.text, /Normal document tail$/);
  assert.equal(
    normalizeContext(
      { text: "A normal document without credentials" },
      "browser",
    ).text,
    "A normal document without credentials",
  );
});

// Chrome service-worker event fixtures

async function chromeWorkerFixture() {
  const handlers = {};
  const tabs = new Map([
    [
      1,
      {
        id: 1,
        windowId: 10,
        active: true,
        incognito: false,
        title: "Tab A",
        url: "https://example.test/a",
        status: "complete",
      },
    ],
    [
      2,
      {
        id: 2,
        windowId: 10,
        active: false,
        incognito: false,
        title: "Tab B",
        url: "https://example.test/b",
        status: "complete",
      },
    ],
    [
      3,
      {
        id: 3,
        windowId: 10,
        active: false,
        incognito: false,
        title: "Orbit",
        url: "http://127.0.0.1:4310/",
        status: "complete",
      },
    ],
    [
      4,
      {
        id: 4,
        windowId: 20,
        active: false,
        incognito: false,
        title: "Background tab",
        url: "https://example.test/background",
        status: "complete",
      },
    ],
  ]);
  const reads = [];
  const writes = [];
  const readers = new Map();
  const storage = {
    orbitConnection: {
      baseUrl: "http://127.0.0.1:4310",
      token: "test-only-token",
    },
    orbitPaused: false,
  };
  const runtimeId = "a".repeat(32);
  let current = null;
  let now = Date.now();

  function event(name) {
    return {
      addListener(listener) {
        handlers[name] = listener;
      },
    };
  }

  const chrome = {
    runtime: {
      id: runtimeId,
      onInstalled: event("installed"),
      onStartup: event("startup"),
      onMessage: event("message"),
    },
    storage: {
      local: {
        setAccessLevel: async () => {},
        get: async () => ({ ...storage }),
        set: async (values) => Object.assign(storage, values),
        remove: async (key) => {
          delete storage[key];
        },
      },
    },
    tabs: {
      get: async (id) => ({ ...tabs.get(id) }),
      query: async ({ windowId }) =>
        [...tabs.values()]
          .filter((tab) => tab.active && tab.windowId === windowId)
          .map((tab) => ({ ...tab })),
      sendMessage: async (id) => {
        reads.push(id);

        if (readers.has(id)) return readers.get(id)();

        const tab = tabs.get(id);

        return {
          text: tab.title,
          title: tab.title,
          url: tab.url,
          capturedAt: new Date(now).toISOString(),
        };
      },
      onActivated: event("activated"),
      onUpdated: event("updated"),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      get: async (id) => ({ id, focused: id === 10, state: "normal" }),
      onFocusChanged: event("focused"),
    },
  };

  class FixedDate extends Date {
    static now() {
      return now;
    }
  }

  const fetcher = async (url, request) => {
    const route = new URL(url).pathname.split("/").at(-1);
    const body = request.body ? JSON.parse(request.body) : null;

    if (route === "invalidate") {
      writes.push({ route, body });
      current = null;
    }
    if (route === "context") {
      writes.push({ route, body });
      current = body;
    }

    return Response.json(
      route === "state" ? { paired: true, paused: false } : { ok: true },
    );
  };

  const source = await readFile(
    new URL("../extension/worker.js", import.meta.url),
    "utf8",
  );

  runInNewContext(source, {
    chrome,
    fetch: fetcher,
    URL,
    AbortSignal,
    Date: FixedDate,
  });

  async function flush() {
    for (let count = 0; count < 24; count += 1) await new Promise(setImmediate);
  }

  function activate(id) {
    const next = tabs.get(id);

    for (const tab of tabs.values())
      if (tab.windowId === next.windowId) tab.active = false;

    next.active = true;
    handlers.activated({ tabId: id, windowId: next.windowId });
  }

  return {
    reads,
    writes,
    readers,
    tabs,
    handlers,
    flush,
    activate,
    current: () => current,
    pulse(id) {
      handlers.message(
        { type: "orbit:capture-ready" },
        { id: runtimeId, tab: { ...tabs.get(id) }, frameId: 0 },
        () => {},
      );
    },
    navigate(id, url, status = "loading") {
      Object.assign(tabs.get(id), { url, status });
      handlers.updated(id, { url, status }, { ...tabs.get(id) });
    },
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

test("Chrome tab transitions force B capture inside the old 1400ms throttle", async () => {
  const worker = await chromeWorkerFixture();

  worker.pulse(1);
  await worker.flush();
  assert.equal(worker.current().text, "Tab A");

  worker.activate(2);
  await worker.flush();

  assert.equal(worker.current().text, "Tab B");
  const clearIndex = worker.writes.findIndex(
    (write) => write.route === "invalidate",
  );
  const captureIndex = worker.writes.findIndex(
    (write) => write.route === "context" && write.body.text === "Tab B",
  );

  assert.ok(clearIndex >= 0 && captureIndex > clearIndex);
});

test("rapid A to B to Orbit never retains A when B was not readable in time", async () => {
  const worker = await chromeWorkerFixture();

  worker.pulse(1);
  await worker.flush();
  worker.activate(2);
  worker.activate(3);
  await worker.flush();

  assert.equal(worker.current(), null);
  assert.equal(worker.reads.includes(3), false);
});

test("a pending A read cannot overwrite B after a forced tab switch", async () => {
  const worker = await chromeWorkerFixture();

  worker.pulse(1);
  await worker.flush();

  let finishA;

  worker.readers.set(
    1,
    () =>
      new Promise((resolve) => {
        finishA = resolve;
      }),
  );
  worker.handlers.updated(1, { status: "complete" }, { ...worker.tabs.get(1) });
  await worker.flush();
  assert.equal(typeof finishA, "function");
  worker.activate(2);
  await worker.flush();
  assert.equal(worker.current(), null);
  finishA({
    text: "Late A",
    title: "Tab A",
    url: "https://example.test/a",
    capturedAt: new Date().toISOString(),
  });
  await worker.flush();

  assert.equal(worker.current().text, "Tab B");
  assert.equal(
    worker.writes.some((write) => write.body.text === "Late A"),
    false,
  );
});

test("returning directly to Orbit preserves the last useful external tab", async () => {
  const worker = await chromeWorkerFixture();

  worker.pulse(1);
  await worker.flush();
  worker.activate(3);
  await worker.flush();

  assert.equal(worker.current().text, "Tab A");
  assert.equal(
    worker.writes.some((write) => write.route === "invalidate"),
    false,
  );
  assert.equal(worker.reads.includes(3), false);
});

test("loading or protected tabs clear the previous capture without reading inactive tabs", async () => {
  const worker = await chromeWorkerFixture();

  worker.pulse(1);
  await worker.flush();
  worker.navigate(1, "https://example.test/new-document", "loading");
  await worker.flush();

  assert.equal(worker.current(), null);
  assert.equal(worker.reads.length, 1);

  worker.navigate(1, "https://accounts.google.com/signin", "complete");
  await worker.flush();

  assert.equal(worker.current(), null);
  assert.equal(worker.reads.length, 1);
});

test("background Chrome activation never clears the focused window capture", async () => {
  const worker = await chromeWorkerFixture();

  worker.pulse(1);
  await worker.flush();
  worker.activate(4);
  await worker.flush();

  assert.equal(worker.current().text, "Tab A");
  assert.equal(worker.reads.includes(4), false);
});
