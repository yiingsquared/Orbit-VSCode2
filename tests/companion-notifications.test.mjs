import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createCompanionState, handleCompanion } from "../server/companion.mjs";
import { createCompanionReplyNotifier } from "../src/companion.ts";

// Isolated reply indicator bridge

const identity = {
  chatId: "chat-test-123",
  messageId: "message-test-123",
  revision: "attempt-test-123",
};
const clientId = "reply-client-123";

async function withBridge(action) {
  const state = createCompanionState({ directory: null });
  const server = createServer((request, response) => {
    void handleCompanion(request, response, { state }).catch(() => {
      response.writeHead(500);
      response.end("{}");
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  async function post(route, body, origin = base) {
    return fetch(`${base}/api/companion/${route}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  try {
    await post("selection", {
      clientId,
      provider: "openai",
      model: "gpt-6.1-sol",
      visible: true,
    });
    const pairing = await (await post("pair-code", {})).json();
    const paired = await fetch(`${base}/api/companion/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairing.code, kind: "desktop" }),
    });
    const { token } = await paired.json();
    const nativeState = async () =>
      (
        await fetch(`${base}/api/companion/state`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json();

    await action({ base, state, post, nativeState });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("unread indicator is absent initially, appears for a successful unread reply, and clears on read", async () => {
  await withBridge(async ({ post, nativeState }) => {
    assert.equal((await nativeState()).hasUnreadReplies, false);
    assert.equal(
      (
        await post("reply-published", {
          clientId,
          ...identity,
          text: "A new AI reply",
        })
      ).status,
      200,
    );
    assert.equal((await nativeState()).hasUnreadReplies, true);
    await post("reply-read", { clientId, ...identity });
    assert.equal((await nativeState()).hasUnreadReplies, false);
  });
});

test("reading before publishing and duplicate deliveries never restore a cleared unread indicator", async () => {
  await withBridge(async ({ post, nativeState }) => {
    await post("reply-read", { clientId, ...identity });
    await post("reply-published", {
      clientId,
      ...identity,
      text: "Already visible",
    });
    await post("reply-published", {
      clientId,
      ...identity,
      text: "Already visible",
    });
    assert.equal((await nativeState()).unreadReplyCount, 0);
  });
});

test("another reply revision remains unread when an old revision is read", async () => {
  await withBridge(async ({ post, nativeState }) => {
    await post("reply-published", {
      clientId,
      ...identity,
      text: "First attempt",
    });
    await post("reply-published", {
      clientId,
      ...identity,
      revision: "attempt-test-456",
      text: "Second attempt",
    });
    await post("reply-read", { clientId, ...identity });
    assert.equal((await nativeState()).unreadReplyCount, 1);
    await post("reply-read", {
      clientId,
      ...identity,
      revision: "attempt-test-456",
    });
    assert.equal((await nativeState()).unreadReplyCount, 0);
  });
});

test("reopened Orbit clients can read the same saved conversation revision", async () => {
  await withBridge(async ({ post, nativeState }) => {
    await post("reply-published", {
      clientId,
      ...identity,
      text: "Open in another tab",
    });
    const other = "reply-client-456";
    await post("selection", {
      clientId: other,
      provider: "openai",
      model: "gpt-6.1-sol",
      visible: true,
    });
    await post("reply-read", { clientId: other, ...identity });
    assert.equal((await nativeState()).hasUnreadReplies, false);
  });
});

test("failed AI requests and cross-origin writes do not light the notification dot", async () => {
  await withBridge(async ({ post, nativeState }) => {
    await post("reply-published", {
      clientId,
      ...identity,
      text: "",
      error: "Missing API key",
    });
    const denied = await post(
      "reply-published",
      { clientId, ...identity, text: "Cross-origin reply" },
      "https://unrelated.example",
    );
    assert.equal(denied.status, 403);
    assert.equal((await nativeState()).hasUnreadReplies, false);
    assert.equal(
      (await post("reply-read", { clientId, ...identity, revision: "bad" }))
        .status,
      400,
    );
  });
});

test("notifier queues calls before connection and sends read receipts ahead of publication", async () => {
  const calls = [];
  const notifier = createCompanionReplyNotifier();
  await notifier.read(identity);
  await notifier.publish({ ...identity, text: "Visible before bridge start" });
  notifier.connect(async (route, body) => {
    calls.push({ route, body });
  }, clientId);
  await notifier.flush();
  notifier.disconnect();
  assert.deepEqual(
    calls.map((call) => call.route),
    ["reply-read", "reply-published"],
  );
  assert.equal(calls[1].body.read, true);
});

test("a read arriving during in-flight publication is delivered without losing the new queue entry", async () => {
  let release;
  const calls = [];
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const notifier = createCompanionReplyNotifier();
  notifier.connect(async (route) => {
    calls.push(route);
    if (route === "reply-published") await barrier;
  }, clientId);
  const publishing = notifier.publish({ ...identity, text: "In flight" });
  const reading = notifier.read(identity);
  release();
  await Promise.all([publishing, reading]);
  await notifier.flush();
  notifier.disconnect();
  assert.deepEqual(calls, ["reply-published", "reply-read"]);
});

test("pending notifications survive reload and completed calls are idempotent", async () => {
  let saved = "";
  const storage = {
    getItem: () => saved,
    setItem: (_name, value) => {
      saved = value;
    },
  };
  const first = createCompanionReplyNotifier(storage);
  await first.read(identity);
  await first.publish({ ...identity, text: "Pending across reload" });
  const calls = [];
  const restored = createCompanionReplyNotifier(storage);
  restored.connect(async (route, body) => {
    calls.push({ route, body });
  }, clientId);
  await restored.flush();
  await restored.publish({ ...identity, text: "Pending across reload" });
  await restored.read(identity);
  restored.disconnect();
  assert.deepEqual(
    calls.map((call) => call.route),
    ["reply-read", "reply-published"],
  );
});

test("offline publication remains queued for a later transport connection", async () => {
  const notifier = createCompanionReplyNotifier();
  notifier.connect(async () => {
    throw new Error("Offline");
  }, clientId);
  await notifier.publish({ ...identity, text: "Keep this completion" });
  notifier.disconnect();
  const calls = [];
  notifier.connect(async (route) => {
    calls.push(route);
  }, clientId);
  await notifier.flush();
  notifier.disconnect();
  assert.deepEqual(calls, ["reply-published"]);
});

test("reset clears queued notifications and previous read receipts before a new client connects", async () => {
  let saved = "";
  const storage = {
    getItem: () => saved,
    setItem: (_key, value) => {
      saved = value;
    },
  };
  const notifier = createCompanionReplyNotifier(storage);

  await notifier.read(identity);
  await notifier.publish({ ...identity, text: "Old session reply" });
  notifier.reset();

  const calls = [];

  notifier.connect(async (route) => {
    calls.push(route);
  }, "new-client-123");
  await notifier.flush();
  notifier.disconnect();

  assert.deepEqual(calls, []);
  assert.deepEqual(JSON.parse(saved), { entries: [], read: [], published: [] });
});

test("late completion from a reset transport cannot repopulate notification state or block a fresh client", async () => {
  let release;
  let saved = "";
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const notifier = createCompanionReplyNotifier({
    getItem: () => saved,
    setItem: (_key, value) => {
      saved = value;
    },
  });

  notifier.connect(async () => {
    await barrier;
  }, clientId);
  const old = notifier.publish({ ...identity, text: "In-flight old session" });

  notifier.reset();

  const calls = [];
  const fresh = { ...identity, revision: "attempt-new-123" };

  notifier.connect(async (route, body) => {
    calls.push({ route, body });
  }, "new-client-123");
  await notifier.publish({ ...fresh, text: "Fresh session reply" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.clientId, "new-client-123");
  assert.equal(calls[0].body.revision, fresh.revision);

  release();
  await old;
  await notifier.flush();
  notifier.disconnect();

  assert.equal(calls.length, 1);
  assert.equal(
    JSON.parse(saved).published.some((entry) =>
      entry.includes(identity.revision),
    ),
    false,
  );
});
