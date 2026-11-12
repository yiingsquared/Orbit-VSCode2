import test from "node:test";
import assert from "node:assert/strict";
import {
  companionDemoFrame,
  chatDemoFrame,
  productDemoMarkup,
  productDemoOverlay,
  createProductDemoMotion,
} from "../src/intro-demo.ts";

// Isolated motion clock

function motionFixture(context, view = "companion", reduced = false) {
  const originals = new Map();
  const queue = new Map();
  const listeners = new Set();
  let nextId = 1;
  let now = 0;
  let currentView = view;
  let elements = new Map();

  function part(name) {
    return {
      dataset: { productPart: name },
      attributes: new Map(),
      style: {},
      textContent: "",
      setAttribute(attribute, value) {
        this.attributes.set(attribute, String(value));
      },
      getAttribute(attribute) {
        return this.attributes.get(attribute);
      },
    };
  }

  function setView(next) {
    currentView = next;
    elements = new Map(
      [
        "cat",
        "notch",
        "landing",
        "tether",
        "gradient",
        "cursor",
        "input",
        "draft",
        "caret",
        "enter",
        "welcome",
        "sent",
        "response",
        "loading",
        "reply",
        "unread",
        "packet",
      ].map((name) => [name, part(name)]),
    );
  }

  setView(view);

  const screen = {
    querySelector() {
      return ["companion", "chat"].includes(currentView)
        ? { dataset: { productView: currentView } }
        : null;
    },
    querySelectorAll() {
      return ["companion", "chat"].includes(currentView)
        ? [...elements.values()]
        : [];
    },
  };
  const media = {
    matches: reduced,
    addEventListener(name, listener) {
      assert.equal(name, "change");
      listeners.add(listener);
    },
    removeEventListener(name, listener) {
      assert.equal(name, "change");
      listeners.delete(listener);
    },
    change(value) {
      this.matches = value;
      for (const listener of [...listeners]) listener({ matches: value });
    },
  };

  for (const [name, value] of Object.entries({
    matchMedia: (query) => {
      assert.equal(query, "(prefers-reduced-motion: reduce)");
      return media;
    },
    requestAnimationFrame: (callback) => {
      const id = nextId++;
      queue.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => queue.delete(id),
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }

  const motion = createProductDemoMotion(screen);

  context.after(() => {
    motion.dispose();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  function step(time) {
    now = time;
    const callbacks = [...queue.values()];
    queue.clear();
    for (const callback of callbacks) callback(time);
  }

  function advanceTo(time) {
    while (now + 100 < time) step(now + 100);
    step(time);
  }

  return {
    motion,
    media,
    setView,
    step,
    advanceTo,
    queued: () => queue.size,
    listenerCount: () => listeners.size,
    part: (name) => elements.get(name),
    opacity: (name) => Number(elements.get(name).getAttribute("opacity")),
  };
}

test("Companion shows a connected pull before release, then a docked cat without a cursor", () => {
  const resting = companionDemoFrame(0);
  const pulled = companionDemoFrame(1.4);
  const released = companionDemoFrame(2.7);
  const docked = companionDemoFrame(4.2);

  assert.equal(resting.cat, 0);
  assert.equal(pulled.cat, 1);
  assert.equal(pulled.tether, 1);
  assert.equal(pulled.dock, 0);
  assert.ok(pulled.y > resting.y);
  assert.equal(released.tether, 0);
  assert.ok(released.x !== resting.x);
  assert.equal(docked.dock, 1);
  assert.ok(docked.scale < pulled.scale);
  assert.equal(docked.cursor, 0);
  assert.equal(docked.x, 434);
  assert.ok(Math.abs(docked.y - 90) < 0.02);
});

test("Chat progresses through typing, Enter, delivery, loading, reply, and unread notification", () => {
  const opening = chatDemoFrame(0.6);
  const typing = chatDemoFrame(1.8);
  const entered = chatDemoFrame(3.1);
  const delivered = chatDemoFrame(4);
  const finished = chatDemoFrame(6.6);

  assert.ok(opening.open > 0 && opening.open < 1);
  assert.equal(opening.draft, "");
  assert.ok(typing.draft.length > 0);
  assert.ok(typing.draft.length < entered.draft.length);
  assert.equal(typing.sent, 0);
  assert.equal(entered.enter, true);
  assert.equal(entered.draft, "Summarize this page");
  assert.equal(delivered.sent, 1);
  assert.equal(delivered.loading, true);
  assert.equal(delivered.reply, "");
  assert.equal(finished.open, 0);
  assert.equal(finished.loading, false);
  assert.equal(finished.reply, "Reply ready in Orbit");
  assert.equal(finished.unread, true);
});

test("the demos show one independent desktop window and an external companion", () => {
  const companionContent = productDemoMarkup("companion");
  const chatContent = productDemoMarkup("chat");
  const companionOverlay = productDemoOverlay("companion");
  const chatOverlay = productDemoOverlay("chat");
  const companion = companionContent;
  const chat = chatContent;

  assert.match(companionContent, /data-product-view="companion"/);
  assert.match(chatContent, /data-product-view="chat"/);
  assert.doesNotMatch(companionContent, /intro-desktop-ai/);
  assert.match(chatContent, /intro-desktop-ai/);
  assert.match(companionOverlay, /class="intro-product-overlay"/);
  assert.match(chatOverlay, /class="intro-product-overlay"/);
  assert.match(companion, /data-product-part="tether"/);
  assert.match(companion, /data-product-part="landing"/);
  assert.doesNotMatch(companion, /data-product-part="draft"/);
  assert.match(chat, /data-product-part="packet"/);
  assert.match(chat, /data-product-part="reply"/);
  assert.doesNotMatch(chat, /data-product-part="tether"/);
  for (const markup of [companion, chat]) {
    const targets = [...markup.matchAll(/data-product-part="([^"]+)"/g)].map(
      (match) => match[1],
    );

    assert.equal(new Set(targets).size, targets.length);
    assert.equal(targets.filter((name) => name === "cursor").length, 1);
    assert.equal(targets.filter((name) => name === "cat").length, 1);
    assert.equal(
      [...markup.matchAll(/class="intro-desktop-window"/g)].length,
      1,
    );
    assert.match(markup, /Project notes — Notes/);
    assert.match(markup, /intro-desktop-taskbar/);
    assert.match(markup, /intro-desktop-note-cards/);
    assert.doesNotMatch(markup, /intro-mini-(?:app|sidebar|composer|welcome)/);
    assert.doesNotMatch(markup, /<(?:form|input|button)\b/);
    assert.doesNotMatch(markup, /id="demo-/);
  }
});

test("the desktop AI status uses visible CSS opacity and pixel transforms", (context) => {
  const fixture = motionFixture(context, "chat");

  assert.equal(fixture.part("welcome").style.opacity, "1");
  assert.equal(fixture.part("sent").style.opacity, "0");
  assert.equal(fixture.part("sent").style.transform, "translateY(5px)");
  fixture.motion.setActive(true);
  fixture.step(0);
  fixture.advanceTo(3725);

  const bubble = fixture.part("sent");

  assert.ok(
    Number(bubble.style.opacity) > 0 && Number(bubble.style.opacity) < 1,
  );
  assert.match(bubble.style.transform, /^translateY\([0-9.]+px\)$/);
  assert.notEqual(bubble.style.transform, "translateY(5px)");
  assert.equal(bubble.getAttribute("transform"), undefined);

  fixture.advanceTo(6700);
  assert.equal(bubble.style.opacity, "1");
  assert.equal(bubble.style.transform, "translateY(0px)");
  assert.equal(fixture.part("welcome").style.opacity, "0");
  assert.equal(fixture.part("response").style.opacity, "1");
  assert.equal(fixture.part("loading").style.opacity, "0");
  assert.equal(fixture.part("input").style.opacity, "0");
});

test("the controller runs exactly one animation loop only while active", (context) => {
  const fixture = motionFixture(context);

  assert.equal(fixture.queued(), 0);
  fixture.motion.setActive(true);
  fixture.motion.setActive(true);
  assert.equal(fixture.queued(), 1);
  fixture.step(0);
  fixture.advanceTo(1400);
  assert.equal(fixture.queued(), 1);
  assert.equal(fixture.opacity("tether"), 1);
  fixture.motion.setActive(false);
  assert.equal(fixture.queued(), 0);
});

test("switching tabs replaces old drawing targets and restarts the new timeline", (context) => {
  const fixture = motionFixture(context);
  fixture.motion.setActive(true);
  fixture.step(0);
  fixture.advanceTo(1500);
  const previousCat = fixture.part("cat");
  const oldTransform = previousCat.getAttribute("transform");

  fixture.setView("chat");
  fixture.motion.reset();
  assert.equal(fixture.queued(), 1);
  assert.equal(fixture.opacity("sent"), 0);
  assert.equal(fixture.part("draft").textContent, "");
  fixture.step(1600);
  fixture.advanceTo(3400);
  assert.ok(fixture.part("draft").textContent.length > 0);
  assert.equal(previousCat.getAttribute("transform"), oldTransform);
});

test("Memory and Models contain no product timeline, and returning starts Companion fresh", (context) => {
  const fixture = motionFixture(context, "chat");
  fixture.motion.setActive(true);
  fixture.step(0);
  fixture.advanceTo(2000);

  for (const view of ["memory", "models"]) {
    fixture.setView(view);
    fixture.motion.reset();
    fixture.motion.setActive(true);
    assert.equal(fixture.queued(), 0);
  }

  fixture.setView("companion");
  fixture.motion.reset();
  assert.equal(fixture.opacity("cat"), 0);
  assert.equal(fixture.opacity("notch"), 0);
  assert.equal(fixture.queued(), 1);
});

test("pause and resume preserve progress without adding hidden-tab time", (context) => {
  const fixture = motionFixture(context);
  fixture.motion.setActive(true);
  fixture.step(0);
  fixture.advanceTo(1400);
  const pausedTransform = fixture.part("cat").getAttribute("transform");

  fixture.motion.setActive(false);
  fixture.step(20000);
  assert.equal(fixture.part("cat").getAttribute("transform"), pausedTransform);
  fixture.motion.setActive(true);
  fixture.step(20100);
  assert.equal(fixture.part("cat").getAttribute("transform"), pausedTransform);
  fixture.step(20200);
  assert.notEqual(
    fixture.part("cat").getAttribute("transform"),
    pausedTransform,
  );
});

test("reduced motion initially shows the completed Companion scene without scheduling frames", (context) => {
  const fixture = motionFixture(context, "companion", true);
  fixture.motion.setActive(true);

  assert.equal(fixture.queued(), 0);
  assert.equal(fixture.opacity("cat"), 1);
  assert.equal(fixture.opacity("notch"), 1);
  assert.equal(fixture.opacity("tether"), 0);
  assert.equal(fixture.opacity("cursor"), 0);
});

test("reduced motion initially shows the delivered Chat response", (context) => {
  const fixture = motionFixture(context, "chat", true);
  fixture.motion.setActive(true);

  assert.equal(fixture.queued(), 0);
  assert.equal(fixture.opacity("input"), 0);
  assert.equal(fixture.opacity("sent"), 1);
  assert.equal(fixture.opacity("loading"), 0);
  assert.equal(fixture.part("reply").textContent, "Reply ready in Orbit");
  assert.equal(fixture.opacity("unread"), 1);
});

test("runtime motion changes stop playback and restart one fresh loop when motion is reenabled", (context) => {
  const fixture = motionFixture(context);
  fixture.motion.setActive(true);
  fixture.step(0);
  fixture.advanceTo(1200);
  assert.equal(fixture.listenerCount(), 1);

  fixture.media.change(true);
  assert.equal(fixture.queued(), 0);
  assert.equal(fixture.opacity("notch"), 1);
  fixture.media.change(false);
  assert.equal(fixture.queued(), 1);
  assert.equal(fixture.opacity("cat"), 0);
  fixture.media.change(false);
  assert.equal(fixture.queued(), 1);
  fixture.motion.dispose();
  assert.equal(fixture.queued(), 0);
  assert.equal(fixture.listenerCount(), 0);
  fixture.media.change(true);
  assert.equal(fixture.queued(), 0);
});
