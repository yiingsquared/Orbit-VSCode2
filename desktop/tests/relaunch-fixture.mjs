import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// No-window native activation fixture

const executable = fileURLToPath(new URL("../release/Orbit.exe", import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), "orbit-native-relaunch-"));
const tickets = ["x".repeat(43), "y".repeat(43)];
const tokens = ["a".repeat(43), "b".repeat(43)];
let activations = 0;
let pairedReads = 0;
let base;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const part of request) chunks.push(part);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  response.setHeader("Content-Type", "application/json");

  if (request.headers.origin) { response.writeHead(403); response.end("{}"); return; }
  if (request.method === "POST" && request.url === "/api/companion/activate" && body.ticket === tickets[activations]) {
    const token = tokens[activations++];
    response.end(JSON.stringify({ token, baseUrl: base, kind: "desktop" }));
  } else if (request.url === "/api/companion/state" && request.headers.authorization === `Bearer ${tokens[activations - 1]}`) {
    pairedReads += 1;
    response.end(JSON.stringify({ paired: true }));
  } else {
    response.writeHead(401);
    response.end(JSON.stringify({ message: "Invalid synthetic activation request" }));
  }
});

try {
  let port;
  for (const candidate of [4319, 4318, 4317, 4320, 4315]) {
    try {
      server.listen(candidate, "127.0.0.1");
      await once(server, "listening");
      port = candidate;
      break;
    } catch (issue) { if (issue.code !== "EADDRINUSE") throw issue; }
  }
  assert.ok(port, "A free synthetic loopback port is required");
  base = `http://127.0.0.1:${port}`;
  const urls = tickets.map((ticket) => {
    const url = new URL("orbit-companion://launch");
    url.searchParams.set("baseUrl", base);
    url.searchParams.set("ticket", ticket);
    return url.href;
  });
  const report = path.join(directory, "report.txt");
  const config = path.join(directory, "synthetic-config.json");
  const process = spawn(executable, ["--activation-test", ...urls, report, config], { windowsHide: true, stdio: "ignore" });
  const timeout = setTimeout(() => process.kill(), 20000);
  const [exit] = await once(process, "exit");
  clearTimeout(timeout);
  assert.equal(exit, 0, await readFile(report, "utf8").catch(() => "Native activation test did not finish"));
  assert.equal(activations, 2);
  assert.equal(pairedReads, 2);
  const stored = await readFile(config, "utf8");
  for (const value of [...tokens, ...tickets]) assert.equal(stored.includes(value), false);
  console.log(await readFile(report, "utf8"));
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
