import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { initCompanion } from "../src/companion.ts";
import { streamChat } from "../src/stream.ts";
import { startCompanionRoundtripFixture } from "./helpers/companion-roundtrip-fixture.mjs";

// Native HTTP to website streaming

test("native inline messages reach the website and stream a reply without window-memory storage", async () => {
  const fixture = await startCompanionRoundtripFixture({ compile: false });
  const realFetch = globalThis.fetch;
  const original = new Map(
    ["window", "document", "sessionStorage", "fetch", "crypto"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const storage = new Map();
  let busy = false;
  let received = 0;
  let stop;

  try {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: webcrypto,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { addEventListener() {}, removeEventListener() {} },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        getElementById: () => null,
        hasFocus: () => true,
        visibilityState: "visible",
      },
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (key) => storage.get(key) || null,
        setItem: (key, value) => storage.set(key, value),
      },
    });
    globalThis.fetch = (input, options = {}) => {
      if (typeof input === "string" && input.startsWith("/")) {
        const headers = new Headers(options.headers);

        headers.set("Origin", fixture.baseUrl);
        return realFetch(fixture.baseUrl + input, { ...options, headers });
      }

      return realFetch(input, options);
    };

    stop = initCompanion({
      getSelection: () => ({ provider: "openai", model: "gpt-6.1-sol" }),
      isBusy: () => busy,
      onContext: async () => {
        throw new Error("No window-memory storage is available");
      },
      onMessage: async (message) => {
        received += 1;
        busy = true;
        let text = "";

        try {
          await streamChat(
            {
              provider: "openai",
              model: "gpt-6.1-sol",
              messages: [{ role: "user", text: message.text }],
              memories: [],
              attachments: message.context
                ? [{ name: "Current QA window", text: message.context.text }]
                : [],
            },
            new AbortController().signal,
            (event) => {
              if (event.type === "delta") text += event.text;
            },
          );
          return { text };
        } finally {
          busy = false;
        }
      },
    });

    const deadline = Date.now() + 7000;

    while (!fixture.state.activeClient && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 15));

    assert.ok(fixture.state.activeClient);

    const pairing = await (
      await realFetch(`${fixture.baseUrl}/api/companion/pair-code`, {
        method: "POST",
        headers: {
          Origin: fixture.baseUrl,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).json();
    const paired = await (
      await realFetch(`${fixture.baseUrl}/api/companion/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: pairing.code,
          kind: "desktop",
          name: "Isolated native sender",
        }),
      })
    ).json();
    const sent = await realFetch(`${fixture.baseUrl}/api/companion/message`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${paired.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "Native Enter transport check",
        useCurrentContext: true,
        context: {
          source: "desktop",
          app: "orbit-qa",
          windowTitle: "Orbit QA host",
          text: "Synthetic current-window content",
          capturedAt: new Date().toISOString(),
        },
      }),
    });

    assert.equal(sent.status, 200);

    while (!fixture.state.latestReply && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(received, 1);
    assert.equal(fixture.proof.upstreamCalls, 1);
    assert.equal(fixture.proof.messages[0].contextIncluded, true);
    assert.match(
      fixture.state.latestReply?.text || "",
      /^QA transport verified:/,
    );
    assert.equal(fixture.state.latestReply?.error, null);
    assert.equal(fixture.state.pendingMessages.size, 0);
  } finally {
    stop?.();
    globalThis.fetch = realFetch;

    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }

    await fixture.close();
  }
});
