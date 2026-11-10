import test from "node:test";
import assert from "node:assert/strict";
import { streamChat } from "../src/stream.ts";

// Browser transport fixtures

function responseStream(events, chunkSize = 1) {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );

  return new Response(
    new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          controller.enqueue(bytes.slice(offset, offset + chunkSize));
        }

        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

test("client forwards the selected model and renders incremental Unicode events", async (context) => {
  const received = [];
  const abort = new AbortController();

  context.mock.method(globalThis, "fetch", async (url, request) => {
    assert.equal(url, "/api/chat");
    assert.equal(JSON.parse(request.body).model, "chosen-model");
    assert.equal(request.signal, abort.signal);

    return responseStream([
      { type: "start" },
      { type: "delta", text: "猫" },
      { type: "delta", text: "🙂" },
      { type: "done" },
    ]);
  });

  await streamChat({ model: "chosen-model" }, abort.signal, (event) =>
    received.push(event),
  );

  assert.equal(
    received
      .filter((event) => event.type === "delta")
      .map((event) => event.text)
      .join(""),
    "猫🙂",
  );
  assert.equal(received.at(-1).type, "done");
});

test("client surfaces missing credentials without synthesizing a reply", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { message: "Add OPENAI_API_KEY to .env.local" },
      { status: 503 },
    ),
  );

  let received = false;

  await assert.rejects(
    streamChat({}, new AbortController().signal, () => {
      received = true;
    }),
    /OPENAI_API_KEY/,
  );
  assert.equal(received, false);
});

test("client distinguishes interrupted responses from complete answers", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    responseStream([{ type: "delta", text: "Partial" }]),
  );

  await assert.rejects(
    streamChat({}, new AbortController().signal, () => {}),
    /before the reply was complete/,
  );
});

test("client retains partial text while reporting stream errors", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    responseStream([
      { type: "delta", text: "Partial" },
      { type: "error", message: "Provider disconnected" },
    ]),
  );

  let text = "";

  await assert.rejects(
    streamChat({}, new AbortController().signal, (event) => {
      text += event.text || "";
    }),
    /Provider disconnected/,
  );
  assert.equal(text, "Partial");
});
