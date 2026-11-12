import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { handleApi } from "../server/api.mjs";
import { providers, buildUpstreamRequest } from "../server/providers.mjs";
import {
  parseMemories,
  validateMemoryPayload,
} from "../server/shared-memory.mjs";
import {
  createMemoryLearner,
  mergeAutomaticMemories,
  selectSharedMemories,
} from "../src/shared-memory.ts";

// Synthetic conversation facts

const turn = {
  provider: "openai",
  model: "gpt-6.1-sol",
  chatId: "chat-a",
  messageId: "user-a",
  message: "My project is called Orbit.",
};
const fact = {
  key: "project_name",
  text: "The user's project is called Orbit.",
};
const evidence = { ...fact, evidence: "My project is called Orbit" };

function fixture() {
  let notes = [];
  let processed = [];
  let enabled = true;
  let current = true;
  let writes = 0;
  const statuses = [];
  const learner = createMemoryLearner({
    getNotes: () => notes,
    saveNotes: (next) => {
      notes = next;
      writes += 1;
      return true;
    },
    getProcessed: () => processed,
    saveProcessed: (next) => {
      processed = next;
    },
    enabled: () => enabled,
    isCurrent: () => current,
    status: (message, busy) => statuses.push({ message, busy }),
  });

  return {
    learner,
    statuses,
    notes: () => notes,
    writes: () => writes,
    setNotes: (next) => {
      notes = next;
    },
    disable: () => {
      enabled = false;
    },
    invalidate: () => {
      current = false;
    },
  };
}

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function upstream(provider, text) {
  const events =
    provider.protocol === "responses"
      ? [
          { type: "response.output_text.delta", delta: text },
          { type: "response.completed" },
        ]
      : provider.protocol === "claude"
        ? [
            {
              type: "content_block_delta",
              delta: { type: "text_delta", text },
            },
            { type: "message_stop" },
          ]
        : provider.protocol === "gemini"
          ? [
              {
                candidates: [
                  { content: { parts: [{ text }] }, finishReason: "STOP" },
                ],
              },
            ]
          : [
              { choices: [{ delta: { content: text } }] },
              { choices: [{ delta: {}, finish_reason: "stop" }] },
            ];

  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

async function withApi(options, action) {
  const server = createServer((request, response) => {
    void handleApi(request, response, options).catch((error) => {
      response.writeHead(500);
      response.end(error.message);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await action(base);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

const post = (base, body, origin = base) =>
  fetch(`${base}/api/memory/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });

test("memory extraction requires evidence from the user and rejects fabricated facts and credentials", () => {
  const output = {
    memories: [
      evidence,
      {
        key: "fake",
        text: "The user lives in Paris.",
        evidence: "I live in Paris",
      },
      {
        key: "secret",
        text: "password: hunter2",
        evidence: "My project is called Orbit",
      },
    ],
  };

  assert.deepEqual(parseMemories(JSON.stringify(output), turn.message), [fact]);
  assert.throws(() => parseMemories('{"memories":', turn.message));
  assert.deepEqual(
    parseMemories('```json\n{"memories":[]}\n```', turn.message),
    [],
  );
});

test("memory input accepts only bounded user text and registered providers", () => {
  assert.equal(
    validateMemoryPayload({ ...turn, existing: [] }).provider.id,
    "openai",
  );
  for (const change of [
    { provider: "unknown" },
    { model: "https://evil.test?bad=1" },
    { message: "x".repeat(30001) },
    { existing: Array(101).fill({ text: "x" }) },
    { existing: [{ text: "x", key: "../bad" }] },
  ])
    assert.throws(() => validateMemoryPayload({ ...turn, ...change }));
});

test("automatic facts keep provider attribution and update instead of duplicating", () => {
  const saved = mergeAutomaticMemories([], [fact], turn);

  assert.equal(saved[0].source.provider, "openai");
  assert.equal(saved[0].source.messageId, turn.messageId);
  assert.equal(
    mergeAutomaticMemories(saved, [fact], { ...turn, provider: "claude" })
      .length,
    1,
  );

  const updated = mergeAutomaticMemories(
    saved,
    [{ ...fact, text: "The project is called Nova." }],
    { ...turn, provider: "claude" },
  );

  assert.equal(updated[0].id, saved[0].id);
  assert.equal(updated[0].source.provider, "claude");
  assert.equal(saved[0].text, fact.text);
});

test("manual memories survive automatic merging and share context with every provider", () => {
  const manual = { id: "manual", text: "Prefer concise answers", created: 1 };
  const notes = mergeAutomaticMemories([manual], [fact], turn);

  assert.equal(notes[0], manual);

  for (const provider of providers) {
    const request = buildUpstreamRequest(
      provider,
      {
        model: provider.models[0].id,
        messages: [{ role: "user", text: "What is my project called?" }],
        memories: selectSharedMemories(notes).map((note) => note.text),
        attachments: [],
      },
      "synthetic-key",
    );

    assert.ok(request.options.body.includes(fact.text));
    assert.ok(request.options.body.includes(manual.text));
  }
});

test("shared context stays within its memory budget and supports more than 20 facts", () => {
  const notes = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    text: "a".repeat(500),
    created: index,
  }));
  const selected = selectSharedMemories(notes);

  assert.equal(selected.length, 48);
  assert.ok(
    selected.reduce((size, note) => size + note.text.length, 0) <= 24000,
  );
  assert.equal(selected[0].id, "99");
});

test("all six provider adapters extract real structured memories through the HTTP route", async () => {
  for (const provider of providers) {
    await withApi(
      {
        config: { [provider.key]: "synthetic-key" },
        fetcher: async (url, options) => {
          assert.ok(url.startsWith(provider.endpoint));
          const body = JSON.parse(options.body);
          const content = JSON.stringify(body);

          assert.ok(content.includes("CURRENT_USER_MESSAGE"));
          assert.ok(content.includes("EXISTING_MEMORIES"));
          assert.equal(content.includes("synthetic-key"), false);
          if (provider.id === "openai")
            assert.equal(body.text.format.strict, true);
          return upstream(provider, JSON.stringify({ memories: [evidence] }));
        },
      },
      async (base) => {
        const response = await post(base, {
          ...turn,
          provider: provider.id,
          model: provider.models[0].id,
        });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { memories: [fact] });
      },
    );
  }
});

test("memory route rejects other origins, bad payloads, and malformed upstream data", async () => {
  let calls = 0;
  await withApi(
    {
      config: { OPENAI_API_KEY: "synthetic-key" },
      fetcher: async () => {
        calls += 1;
        return upstream(providers[0], "not JSON");
      },
    },
    async (base) => {
      assert.equal((await post(base, turn, "https://other.test")).status, 403);
      assert.equal((await post(base, { ...turn, message: "" })).status, 400);
      assert.equal(calls, 0);
      const failure = await post(base, turn);
      assert.equal(failure.status, 503);
      assert.match((await failure.json()).message, /chat is saved/);
      assert.equal(calls, 1);
    },
  );
});

test("learning completes before the next request and does not repeat a processed turn", async (context) => {
  const state = fixture();
  const response = deferred();
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return response.promise;
  });

  const saving = state.learner.learn(turn);
  let ready = false;
  const waiting = state.learner.ready(new AbortController().signal).then(() => {
    ready = true;
  });

  await Promise.resolve();
  assert.equal(ready, false);
  response.resolve(Response.json({ memories: [fact] }));
  await Promise.all([saving, waiting]);
  assert.equal(ready, true);
  assert.equal(state.notes()[0].source.provider, "openai");
  await state.learner.learn(turn);
  assert.equal(calls, 1);
});

test("deleting memory prevents an already-running extraction from restoring it", async (context) => {
  const state = fixture();
  const original = mergeAutomaticMemories([], [fact], turn)[0];
  state.setNotes([original]);
  const response = deferred();
  context.mock.method(globalThis, "fetch", () => response.promise);

  const saving = state.learner.learn(turn);
  await Promise.resolve();
  state.learner.forget(original);
  state.setNotes([]);
  response.resolve(Response.json({ memories: [fact] }));
  await saving;
  assert.deepEqual(state.notes(), []);
});

test("account changes abort extraction and discard late responses", async (context) => {
  const state = fixture();
  const response = deferred();
  let signal;
  context.mock.method(globalThis, "fetch", (_, options) => {
    signal = options.signal;
    return response.promise;
  });

  const saving = state.learner.learn(turn);
  await Promise.resolve();
  state.learner.reset();
  assert.equal(signal.aborted, true);
  response.resolve(Response.json({ memories: [fact] }));
  await saving;
  assert.equal(state.writes(), 0);
});

test("disabled memory and deleted or edited source messages never create facts", async (context) => {
  const state = fixture();
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({ memories: [fact] });
  });

  state.invalidate();
  await state.learner.learn(turn);
  state.disable();
  await state.learner.learn({ ...turn, messageId: "user-b" });
  assert.equal(calls, 0);
});

test("failed extraction keeps existing notes and never blocks chat continuation", async (context) => {
  const state = fixture();
  const manual = { id: "manual", text: "Manual memory", created: 1 };
  state.setNotes([manual]);
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({}, { status: 503 }),
  );

  await state.learner.learn(turn);
  await state.learner.ready(new AbortController().signal);
  assert.deepEqual(state.notes(), [manual]);
  assert.match(state.statuses.at(-1).message, /could not be updated/);
});

test("stopping a chat also stops waiting for unfinished memory extraction", async (context) => {
  const state = fixture();
  const response = deferred();
  context.mock.method(globalThis, "fetch", () => response.promise);
  const saving = state.learner.learn(turn);
  const abort = new AbortController();
  const waiting = state.learner.ready(abort.signal);

  abort.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  response.resolve(Response.json({ memories: [] }));
  await saving;
});
