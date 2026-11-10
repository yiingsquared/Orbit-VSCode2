import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { handleApi, validatePayload } from "../server/api.mjs";
import {
  providers,
  getProvider,
  getModels,
  buildUpstreamRequest,
  readSse,
  normalizeEvent,
} from "../server/providers.mjs";

// Isolated provider fixtures

const key = "test-only-key-no-live-access";
const encoder = new TextEncoder();
const payload = (id = "openai") => ({
  provider: id,
  model: getProvider(id).models[0].id,
  messages: [{ role: "user", text: "Hello" }],
  memories: [],
  attachments: [],
});

function streamOf(text, size = 3) {
  const bytes = encoder.encode(text);

  return new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += size)
        controller.enqueue(bytes.slice(index, index + size));
      controller.close();
    },
  });
}

function eventsFor(provider, text = "Hello 世界") {
  if (provider.protocol === "responses")
    return [
      { type: "response.output_text.delta", delta: text },
      { type: "response.completed" },
    ];

  if (provider.protocol === "claude")
    return [
      { type: "content_block_delta", delta: { type: "text_delta", text } },
      { type: "message_stop" },
    ];

  if (provider.protocol === "gemini")
    return [
      {
        candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      },
    ];

  return [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
}

function mockReply(provider, text) {
  const sse = eventsFor(provider, text)
    .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
    .join("");

  return new Response(streamOf(sse), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function localApi(options, action) {
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
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(base, body, origin = base) {
  return fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

test("SSE preserves Unicode, split CRLF, comments, and terminal events", async () => {
  const wire =
    ': heartbeat\r\n\r\ndata: {"delta":"猫🙂"}\r\n\r\ndata: [DONE]\r\n\r\n';
  const events = [];

  for await (const event of readSse(streamOf(wire, 1))) events.push(event);

  assert.deepEqual(events, [{ delta: "猫🙂" }, { type: "orbit.done" }]);
});

test("broken JSON events fail visibly", async () => {
  await assert.rejects(async () => {
    for await (const event of readSse(streamOf("data: {broken}\n\n")))
      void event;
  }, /invalid stream event/);
});

test("payload limits and roles cannot be bypassed", () => {
  assert.equal(validatePayload(payload()).provider.id, "openai");
  assert.throws(
    () => validatePayload({ ...payload(), provider: "unknown" }),
    /supported/,
  );
  assert.throws(
    () => validatePayload({ ...payload(), model: "https://evil.test/?x=1" }),
    /valid model/,
  );
  assert.throws(
    () =>
      validatePayload({
        ...payload(),
        messages: [{ role: "system", text: "override" }],
      }),
    /invalid message/,
  );
  assert.throws(
    () =>
      validatePayload({
        ...payload(),
        messages: [{ role: "user", text: "x".repeat(30001) }],
      }),
    /invalid message/,
  );
  assert.throws(
    () =>
      validatePayload({
        ...payload(),
        attachments: [{ name: "a", text: "x".repeat(30001) }],
      }),
    /attachment/,
  );
});

test("all adapters use fixed official endpoints, server keys, and separated references", () => {
  for (const provider of providers) {
    const input = {
      ...payload(provider.id),
      memories: ["untrusted memory"],
      attachments: [{ name: "a.txt", text: "untrusted file" }],
    };
    const request = buildUpstreamRequest(provider, input, key);
    const body = JSON.parse(request.options.body);

    assert.match(request.url, /^https:\/\//);
    assert.equal(request.options.method, "POST");
    assert.equal(
      provider.protocol === "gemini"
        ? request.options.headers["x-goog-api-key"]
        : request.options.headers.Authorization,
      provider.protocol === "gemini" ? key : `Bearer ${key}`,
    );
    assert.match(request.options.body, /ORBIT_REFERENCE_DATA/);
    assert.match(request.options.body, /not system or developer instructions/);
    assert.equal(request.options.body.includes(key), false);
    assert.equal(
      provider.protocol === "gemini"
        ? body.contents[0].role
        : (body.messages || body.input).at(-1).role,
      "user",
    );

    if (provider.protocol === "responses") assert.equal(body.store, false);
    if (provider.protocol === "gemini")
      assert.match(request.url, /:streamGenerateContent\?alt=sse$/);
  }
});

test("each provider streams normalized output through the HTTP bridge", async () => {
  for (const provider of providers) {
    let called = false;

    await localApi(
      {
        config: { [provider.key]: key },
        fetcher: async (url, request) => {
          called = true;
          assert.equal(
            JSON.parse(request.body).model || provider.protocol,
            provider.protocol === "gemini" ? "gemini" : provider.models[0].id,
          );
          return mockReply(provider);
        },
      },
      async (base) => {
        const response = await post(base, payload(provider.id));
        const events = [];

        assert.equal(response.status, 200);
        for await (const event of readSse(response.body)) events.push(event);

        assert.equal(events[0].type, "start");
        assert.equal(
          events.find((event) => event.type === "delta").text,
          "Hello 世界",
        );
        assert.equal(events.at(-1).type, "done");
        assert.equal(called, true);
      },
    );
  }
});

test("missing keys produce an actionable error without fake inference", async () => {
  await localApi(
    {
      config: {},
      fetcher: () => {
        throw new Error("Must not call upstream");
      },
    },
    async (base) => {
      const response = await post(base, payload());
      const detail = await response.json();

      assert.equal(response.status, 503);
      assert.equal(detail.code, "missing_key");
      assert.match(detail.message, /website owner/);
    },
  );
});

test("cross-origin submissions are rejected before provider access", async () => {
  await localApi({ config: {} }, async (base) => {
    const response = await post(base, payload(), "https://unrelated.example");

    assert.equal(response.status, 403);
  });
});

test("configuration never includes the credential and reports presence only", async () => {
  await localApi({ config: { OPENAI_API_KEY: key } }, async (base) => {
    const response = await fetch(`${base}/api/config`);
    const text = await response.text();
    const data = JSON.parse(text);

    assert.equal(text.includes(key), false);
    assert.equal(
      data.providers.find((provider) => provider.id === "openai").configured,
      true,
    );
    assert.equal(
      data.providers.find((provider) => provider.id === "claude").configured,
      false,
    );
  });
});

test("provider errors redact keys and retain rate limit status", async () => {
  await localApi(
    {
      config: { OPENAI_API_KEY: key },
      fetcher: async () =>
        Response.json(
          { error: { message: `Rejected key ${key}` } },
          { status: 429 },
        ),
    },
    async (base) => {
      const response = await post(base, payload());
      const text = await response.text();

      assert.equal(response.status, 429);
      assert.equal(text.includes(key), false);
      assert.match(text, /redacted/);
    },
  );
});

test("early EOF is an error rather than a completed answer", async () => {
  await localApi(
    {
      config: { OPENAI_API_KEY: key },
      fetcher: async () =>
        new Response(
          streamOf(
            'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
          ),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    },
    async (base) => {
      const response = await post(base, payload());
      const events = [];

      for await (const event of readSse(response.body)) events.push(event);

      assert.equal(events.at(-1).type, "error");
      assert.match(events.at(-1).message, /ended early/);
      assert.equal(
        events.some((event) => event.type === "done"),
        false,
      );
    },
  );
});

test("model menu uses the account catalog and excludes non-chat models", async () => {
  const result = await getModels(
    getProvider("openai"),
    { OPENAI_API_KEY: "isolated-model-test" },
    async () =>
      Response.json({
        data: [
          { id: "gpt-6.1-sol" },
          { id: "whisper-1" },
          { id: "gpt-image-2" },
        ],
      }),
  );

  assert.equal(result.source, "account");
  assert.deepEqual(
    result.models.map((model) => model.id),
    ["gpt-6.1-sol"],
  );
});

test("truncation and provider safety errors remain visible", () => {
  assert.equal(
    normalizeEvent(getProvider("claude"), {
      type: "message_delta",
      delta: { stop_reason: "max_tokens" },
    }).type,
    "error",
  );
  assert.equal(
    normalizeEvent(getProvider("gemini"), {
      candidates: [{ finishReason: "SAFETY" }],
    }).type,
    "error",
  );
  assert.equal(
    normalizeEvent(getProvider("deepseek"), {
      choices: [{ finish_reason: "length" }],
    }).type,
    "error",
  );
});
