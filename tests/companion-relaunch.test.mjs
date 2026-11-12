import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createCompanionState, handleCompanion } from "../server/companion.mjs";

const origin = "http://127.0.0.1:4316";
const clientId = "relaunch-client-one";

// Synthetic loopback requests

async function fixture(action, options = {}) {
  const state = options.state || createCompanionState({ directory: null });
  const server = createServer((request, response) => {
    void handleCompanion(request, response, { state, installer: Buffer.from("MZ synthetic installer") });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, body, extra = {}) => new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/companion/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Host: "127.0.0.1:4316",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...extra,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const web = (route, body = {}, extra = {}) => call(route, body, { Origin: origin, ...extra });
  const pair = async () => {
    const { code } = await (await web("pair-code")).json();
    const response = await call("pair", { code, kind: "desktop" });
    assert.equal(response.status, 200);
    return response.json();
  };
  const select = (id = clientId) => web("selection", { clientId: id, provider: "openai", model: "gpt-6.1-sol", visible: true });

  try { await action({ state, server, base, call, web, pair, select }); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("relaunch requires the same website origin and a supported local port", async () => {
  await fixture(async ({ state, call, web }) => {
    assert.equal((await call("relaunch", {})).status, 403);
    assert.equal((await web("relaunch", {}, { Origin: "https://unrelated.example" })).status, 403);
    assert.equal((await web("relaunch", {}, { Origin: `chrome-extension://${"a".repeat(32)}` })).status, 403);
    assert.equal((await web("relaunch", {}, { Host: "127.0.0.1:4330", Origin: "http://127.0.0.1:4330" })).status, 400);
    assert.equal(state.installTickets.size, 0);
  });
});

test("relaunch reveals a live desktop without another grant or capture-state change", async () => {
  await fixture(async ({ state, web, pair, call }) => {
    const { token } = await pair();
    await web("visibility", { hidden: true });
    await web("pause", { paused: true });
    const response = await web("relaunch");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { connected: true });
    assert.equal(state.installTickets.size, 0);
    const status = await (await call("state", undefined, { Authorization: `Bearer ${token}` })).json();
    assert.equal(status.hidden, false);
    assert.equal(status.paused, true);
  });
});

test("offline relaunch returns a short-lived one-use launch URL and clears hidden", async () => {
  let now = Date.now();
  await fixture(async ({ state, web, pair, call }) => {
    await pair();
    now += 20001;
    await web("visibility", { hidden: true });
    const result = await (await web("relaunch")).json();
    assert.equal(result.connected, false);
    assert.equal(result.expiresAt, now + 120000);
    assert.equal(state.hidden, false);
    const url = new URL(result.url);
    assert.equal(url.protocol, "orbit-companion:");
    assert.equal(url.hostname, "launch");
    assert.equal(url.searchParams.get("baseUrl"), origin);
    const ticket = url.searchParams.get("ticket");
    assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(JSON.stringify([...state.installTickets]).includes(ticket), false);
    assert.equal((await web("activate", { ticket })).status, 403);
    assert.equal((await call("activate", { ticket })).status, 200);
    assert.equal((await call("activate", { ticket })).status, 401);
  }, { state: createCompanionState({ directory: null, clock: () => now }) });
});

test("expired relaunch grants fail and only hashed grants survive restart", async () => {
  let now = Date.now();
  const directory = await mkdtemp(path.join(os.tmpdir(), "orbit-relaunch-"));
  try {
    let ticket;
    await fixture(async ({ web }) => {
      ticket = new URL((await (await web("relaunch")).json()).url).searchParams.get("ticket");
    }, { state: createCompanionState({ directory, clock: () => now }) });
    assert.equal((await readFile(path.join(directory, "companion-peers.json"), "utf8")).includes(ticket), false);
    now += 120001;
    await fixture(async ({ call }) => {
      assert.equal((await call("activate", { ticket })).status, 401);
    }, { state: createCompanionState({ directory, clock: () => now }) });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("sign-out stops old browser clients and grants while ordinary quit preserves selection", async () => {
  await fixture(async ({ state, web, pair, call, select }) => {
    const { token } = await pair();
    await select();
    await web("quit");
    const ordinary = await (await call("state", undefined, { Authorization: `Bearer ${token}` })).json();
    assert.equal(ordinary.command, "quit");
    assert.match(ordinary.reconnect.ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(state.clients.size, 1);
    assert.equal((await select()).status, 200);
    const extraGrant = new URL((await (await web("relaunch")).json()).url).searchParams.get("ticket");
    const resumed = await (await call("activate", { ticket: ordinary.reconnect.ticket })).json();
    await web("quit", { signOut: true });
    assert.equal(state.clients.size, 0);
    assert.equal(state.activeClient, null);
    assert.equal(state.installTickets.size, 0);
    const signedOut = await (await call("state", undefined, { Authorization: `Bearer ${resumed.token}` })).json();
    assert.equal(signedOut.command, "quit");
    assert.equal(signedOut.signOut, true);
    assert.equal(signedOut.reconnect, undefined);
    assert.equal((await select()).status, 409);
    assert.equal((await select("relaunch-new-login")).status, 200);
    assert.equal((await call("activate", { ticket: ordinary.reconnect.ticket })).status, 401);
    assert.equal((await call("activate", { ticket: extraGrant })).status, 401);
    assert.equal(state.pendingMessages.size, 0);
  });
});

// Revocation while a body is incomplete

async function beginPartial(server, base, route, body, token, web = false) {
  const bytes = Buffer.from(JSON.stringify(body));
  const began = once(server, "request");
  let request;
  const result = new Promise((resolve, reject) => {
    request = httpRequest(`${base}/api/companion/${route}`, {
      method: "POST",
      headers: { Host: "127.0.0.1:4316", "Content-Type": "application/json", "Content-Length": bytes.length,
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(web ? { Origin: origin } : {}) },
    }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject);
  });
  request.write(bytes.subarray(0, 5));
  await began;
  await new Promise(setImmediate);
  return { finish: () => request.end(bytes.subarray(5)), result };
}

for (const route of ["message", "context"]) {
  test(`a ${route} started before quit cannot use its revoked peer afterward`, async () => {
    await fixture(async ({ server, base, state, web, pair, select }) => {
      const { token } = await pair();
      await select();
      const partial = await beginPartial(server, base, route, { text: "Synthetic delayed request" }, token);
      await web("quit");
      partial.finish();
      assert.equal(await partial.result, 401);
      assert.equal(state.pendingMessages.size, 0);
      assert.equal(state.currentContext, null);
    });
  });
}

test("an in-flight old selection cannot revive a signed-out client", async () => {
  await fixture(async ({ server, base, state, web, select }) => {
    await select();
    const partial = await beginPartial(server, base, "selection", { clientId, provider: "openai", model: "gpt-6.1-sol" }, "", true);
    await web("quit", { signOut: true });
    partial.finish();
    assert.equal(await partial.result, 409);
    assert.equal(state.clients.size, 0);
  });
});
