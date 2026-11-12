import test from "node:test";
import assert from "node:assert/strict";
import {
  entryStage,
  isCompanionLaunchUrl,
  relaunchCompanion,
} from "../src/onboarding.ts";

const user = { id: "account-one", email: "orbit@example.test" };
const baseUrl = "http://127.0.0.1:4310";
const launchUrl = `orbit-companion://launch?baseUrl=${encodeURIComponent(baseUrl)}&ticket=${"a".repeat(43)}`;

// New, returning and refreshed sessions

test("entry routes require an account and distinguish signup from returning login", () => {
  assert.equal(
    entryStage(null, { source: "initial", isNewAccount: false }, true),
    "intro",
  );
  assert.equal(
    entryStage(user, { source: "signup", isNewAccount: true }, false),
    "download",
  );
  assert.equal(
    entryStage(user, { source: "oauth", isNewAccount: true }, true),
    "download",
  );
  assert.equal(
    entryStage(user, { source: "login", isNewAccount: false }, true),
    "relaunch",
  );
  assert.equal(
    entryStage(user, { source: "oauth", isNewAccount: false }, true),
    "relaunch",
  );
  assert.equal(
    entryStage(user, { source: "initial", isNewAccount: false }, false),
    "relaunch",
  );
  assert.equal(
    entryStage(user, { source: "initial", isNewAccount: false }, true),
    "workspace",
  );
});

test("launch links must belong to this local Orbit instance", () => {
  assert.equal(isCompanionLaunchUrl(launchUrl, baseUrl), true);
  assert.equal(isCompanionLaunchUrl(launchUrl, "http://localhost:4310"), true);
  assert.equal(
    isCompanionLaunchUrl(launchUrl, "http://example.com:4310"),
    false,
  );
  assert.equal(
    isCompanionLaunchUrl(launchUrl, "https://127.0.0.1:4310"),
    false,
  );

  for (const value of [
    launchUrl.replace("orbit-companion:", "https:"),
    launchUrl.replace("launch?", "other?"),
    `${launchUrl}&ticket=${"b".repeat(43)}`,
    `${launchUrl}&extra=1`,
    `${launchUrl}#fragment`,
    `${launchUrl}%0A`,
    launchUrl.replace(
      encodeURIComponent(baseUrl),
      encodeURIComponent("http://127.0.0.1:4311"),
    ),
  ])
    assert.equal(isCompanionLaunchUrl(value, baseUrl), false, value);
});

// Realistic desktop handoff outcomes

test("an already connected companion needs no external launch", async () => {
  let launches = 0;
  const connected = await relaunchCompanion({
    baseUrl,
    signal: new AbortController().signal,
    launch: () => {
      launches += 1;
    },
    fetcher: async (_url, options) => {
      assert.equal(options.method, "POST");
      assert.equal(options.body, "{}");
      return Response.json({ connected: true });
    },
  });

  assert.equal(connected, true);
  assert.equal(launches, 0);
});

test("offline relaunch waits for a fresh desktop heartbeat before entering chat", async () => {
  let polls = 0;
  const launches = [];
  const connected = await relaunchCompanion({
    baseUrl,
    signal: new AbortController().signal,
    launch: (url) => launches.push(url),
    wait: async () => {},
    attempts: 3,
    fetcher: async (url) =>
      url.endsWith("relaunch")
        ? Response.json({ connected: false, url: launchUrl })
        : Response.json({ desktopConnected: ++polls === 2 }),
  });

  assert.equal(connected, true);
  assert.deepEqual(launches, [launchUrl]);
  assert.equal(polls, 2);
});

test("missing installation or denied OS launch offers installation fallback", async () => {
  let polls = 0;
  const connected = await relaunchCompanion({
    baseUrl,
    signal: new AbortController().signal,
    launch: () => {},
    wait: async () => {},
    attempts: 2,
    fetcher: async (url) =>
      url.endsWith("relaunch")
        ? Response.json({ connected: false, url: launchUrl })
        : (++polls, Response.json({ desktopConnected: false })),
  });

  assert.equal(connected, false);
  assert.equal(polls, 2);
});

test("cancelled setup cannot complete a late launch", async () => {
  const controller = new AbortController();
  let launched = false;

  await assert.rejects(
    relaunchCompanion({
      baseUrl,
      signal: controller.signal,
      launch: () => {
        launched = true;
      },
      fetcher: async () => {
        controller.abort();
        return Response.json({ connected: false, url: launchUrl });
      },
    }),
    { name: "AbortError" },
  );

  assert.equal(launched, false);
});

test("malformed server links are never handed to the operating system", async () => {
  await assert.rejects(
    relaunchCompanion({
      baseUrl,
      signal: new AbortController().signal,
      launch: () => assert.fail("Unsafe launch"),
      fetcher: async () =>
        Response.json({ connected: false, url: "file:///bad.exe" }),
    }),
    /invalid/,
  );
});
