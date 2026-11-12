import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  initCompanion,
  notifyCompanionSelection,
  resetCompanionSession,
} from "../src/companion.ts";

// Isolated browser transport surface

async function withPage(action) {
  const descriptors = new Map(
    ["window", "document", "sessionStorage", "fetch", "crypto"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const calls = [];
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const window = Object.assign(new EventTarget(), {
    sessionStorage: storage,
    localStorage: storage,
  });
  let downloads = 0;
  let installerStatus = 200;
  let installerBytes = "MZ-isolated-installer";
  let linkFailure = false;
  let inbox = [];
  const acknowledged = new Set();
  const cleanups = [];

  class Element extends EventTarget {
    hidden = false;
    disabled = false;
    textContent = "";
    href = "";
    download = "";
    open = false;
    attributes = new Map();
    setAttribute(key, value) {
      this.attributes.set(key, value);
    }
    toggleAttribute(key, force) {
      if (force) this.attributes.set(key, "");
      else this.attributes.delete(key);
    }
    append() {}
    remove() {}
    click() {
      if (this.href.startsWith("blob:")) {
        if (linkFailure) throw new Error("Download trigger blocked");
        downloads += 1;
      } else this.dispatchEvent(new Event("click", { cancelable: true }));
    }
  }

  const elements = new Map(
    [
      "companion-status",
      "hide-companion",
      "pause-companion",
      "quit-companion",
      "companion-controls",
      "companion-dialog",
      "download-companion",
      "download-companion-label",
      "download-companion-arrow",
      "download-companion-check",
    ].map((id) => [id, new Element()]),
  );
  const document = {
    getElementById: (id) => elements.get(id) || null,
    hasFocus: () => true,
    visibilityState: "visible",
    body: new Element(),
    createElement: () => new Element(),
  };

  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: window,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: document,
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: webcrypto,
    });
    globalThis.fetch = async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;

      calls.push({ url, body });

      if (url === "/downloads/installer.json")
        return Response.json({ sha256: "a".repeat(64) });
      if (url === "/api/companion/installer")
        return new Response(installerBytes, { status: installerStatus });
      if (url === "/api/companion/status")
        return Response.json({
          desktopConnected: true,
          extensionConnected: false,
          pairedDesktop: 1,
          pairedExtension: 0,
          paused: false,
          hidden: false,
          contextSource: null,
          contextFresh: false,
        });
      if (url.startsWith("/api/companion/events?"))
        return Response.json({
          instanceId: "instance-fixture-123",
          events: inbox.filter((event) => !acknowledged.has(event.id)),
          cursor: 0,
          active: true,
        });
      if (url === "/api/companion/ack") acknowledged.add(body.eventId);

      return Response.json({ ok: true, active: true });
    };

    await action({
      window,
      elements,
      calls,
      values,
      get downloads() {
        return downloads;
      },
      setInstaller(status, bytes = installerBytes) {
        installerStatus = status;
        installerBytes = bytes;
      },
      failLink() {
        linkFailure = true;
      },
      setInbox(events) {
        inbox = events;
      },
      start(options) {
        const stop = initCompanion(options);
        cleanups.push(stop);
        return stop;
      },
    });
  } finally {
    for (const stop of cleanups) stop();
    resetCompanionSession();

    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

async function until(condition) {
  const deadline = Date.now() + 1500;

  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(
    Boolean(condition()),
    true,
    "Expected transport condition was not reached",
  );
}

const selection = () => ({ provider: "openai", model: "gpt-6.1-sol" });

test("setup keeps status and controls available without selection or inbox registration", async () => {
  await withPage(async (page) => {
    page.start({
      enabled: () => false,
      getSelection: selection,
      isBusy: () => false,
      onMessage: async () => {
        throw new Error("Must not process");
      },
    });
    await until(() =>
      page.calls.some((call) => call.url === "/api/companion/status"),
    );
    notifyCompanionSelection();
    page.elements.get("hide-companion").click();
    page.elements.get("pause-companion").click();
    page.elements.get("quit-companion").click();
    await until(() =>
      page.calls.some((call) => call.url === "/api/companion/quit"),
    );

    assert.equal(
      page.calls.some((call) => call.url === "/api/companion/selection"),
      false,
    );
    assert.equal(
      page.calls.some((call) => call.url.startsWith("/api/companion/events?")),
      false,
    );
    assert.equal(
      page.calls.some((call) => call.url === "/api/companion/visibility"),
      true,
    );
    assert.equal(
      page.calls.some((call) => call.url === "/api/companion/pause"),
      true,
    );
  });
});

test("notify immediately enables registration and message delivery after setup", async () => {
  await withPage(async (page) => {
    let enabled = false;
    let received = 0;

    page.setInbox([
      { id: 1, type: "message", text: "Synthetic routing check" },
    ]);
    page.start({
      enabled: () => enabled,
      getSelection: selection,
      isBusy: () => false,
      onMessage: async () => {
        received += 1;
        return { text: "Test reply" };
      },
    });
    await until(() =>
      page.calls.some((call) => call.url === "/api/companion/status"),
    );
    assert.equal(received, 0);
    enabled = true;
    notifyCompanionSelection();
    await until(() =>
      page.calls.some((call) => call.url === "/api/companion/reply"),
    );

    assert.equal(received, 1);
    assert.equal(
      page.calls.filter((call) => call.url === "/api/companion/selection")
        .length,
      1,
    );
  });
});

test("session reset clears old IDs and outbox state and waits for explicit reactivation with a fresh ID", async () => {
  await withPage(async (page) => {
    const options = {
      enabled: () => true,
      getSelection: selection,
      isBusy: () => false,
      onMessage: async () => ({ text: "" }),
    };

    page.start(options);
    await until(() =>
      page.calls.some((call) => call.url === "/api/companion/selection"),
    );
    const first = page.calls.find(
      (call) => call.url === "/api/companion/selection",
    ).body.clientId;

    page.values.set("orbit.companion.outbox.v1", "private-old-outbox");
    page.values.set(
      "orbit.companion.notifications.v1",
      "private-old-notifications",
    );
    resetCompanionSession();
    resetCompanionSession();

    assert.equal(page.values.has("orbit.companion.client.v1"), false);
    assert.equal(page.values.has("orbit.companion.outbox.v1"), false);
    assert.equal(page.values.has("orbit.companion.notifications.v1"), false);
    assert.equal(
      page.calls.filter((call) => call.url === "/api/companion/selection")
        .length,
      1,
    );

    notifyCompanionSelection();
    await until(
      () =>
        page.calls.filter((call) => call.url === "/api/companion/selection")
          .length === 2,
    );
    const last = page.calls
      .filter((call) => call.url === "/api/companion/selection")
      .at(-1).body.clientId;

    assert.notEqual(last, first);
  });
});

test("only a successful personalized blob download emits the onboarding receipt", async () => {
  await withPage(async (page) => {
    let receipts = 0;

    page.window.addEventListener("orbit:companion-downloaded", () => {
      receipts += 1;
    });
    page.start({
      enabled: () => false,
      getSelection: selection,
      isBusy: () => false,
      onMessage: async () => ({ text: "" }),
    });
    page.elements.get("download-companion").click();
    await until(() => receipts === 1);

    assert.equal(page.downloads, 1);
    assert.equal(
      page.calls.filter((call) => call.url === "/api/companion/installer")
        .length,
      1,
    );
    assert.equal(
      page.calls.some((call) => call.url === "/api/companion/selection"),
      false,
    );
  });
});

test("failed installer responses and failed download triggers do not advance onboarding", async () => {
  await withPage(async (page) => {
    let receipts = 0;

    page.window.addEventListener("orbit:companion-downloaded", () => {
      receipts += 1;
    });
    page.start({
      enabled: () => false,
      getSelection: selection,
      isBusy: () => false,
      onMessage: async () => ({ text: "" }),
    });
    page.setInstaller(503);
    page.elements.get("download-companion").click();
    await until(
      () =>
        page.elements.get("download-companion").attributes.get("aria-busy") ===
        "false",
    );
    assert.equal(receipts, 0);

    page.setInstaller(200, "MZ-isolated-installer");
    page.failLink();
    page.elements.get("download-companion").click();
    await until(
      () =>
        page.elements.get("download-companion").attributes.get("aria-busy") ===
        "false",
    );
    assert.equal(receipts, 0);
    assert.equal(page.downloads, 0);
  });
});

test("repeat initialization removes previous DOM listeners and cleanup disables later downloads", async () => {
  await withPage(async (page) => {
    const options = {
      enabled: () => false,
      getSelection: selection,
      isBusy: () => false,
      onMessage: async () => ({ text: "" }),
    };

    page.start(options);
    const stop = page.start(options);

    page.elements.get("download-companion").click();
    await until(() => page.downloads === 1);
    assert.equal(
      page.calls.filter((call) => call.url === "/api/companion/installer")
        .length,
      1,
    );

    stop();
    page.elements.get("download-companion").click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(
      page.calls.filter((call) => call.url === "/api/companion/installer")
        .length,
      1,
    );
  });
});
