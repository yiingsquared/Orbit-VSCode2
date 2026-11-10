import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileSources,
  projectRoot,
  sourceRoot,
} from "../../scripts/compile.mjs";
import {
  createCompanionState,
  handleCompanion,
} from "../../server/companion.mjs";
import { handleApi } from "../../server/api.mjs";
import { createAuthStore, handleAuth } from "../../server/auth.mjs";

// Isolated synthetic inference

export async function startCompanionRoundtripFixture(options = {}) {
  const state = createCompanionState({ directory: null });
  const auth = createAuthStore(":memory:");
  const proof = { synthetic: true, upstreamCalls: 0, messages: [] };
  const config = {
    OPENAI_API_KEY: "qa-transport-only-no-live-access",
    OPENAI_MODEL: "gpt-6.1-sol",
  };
  let baseUrl = "";
  let watcher;
  let compileTimer;
  let compileQueue = Promise.resolve();

  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".woff2": "font/woff2",
    ".zip": "application/zip",
    ".exe": "application/vnd.microsoft.portable-executable",
  };

  async function fakeUpstream(url, request) {
    if (url.includes("/models"))
      return Response.json({ data: [{ id: "gpt-6.1-sol" }] });

    proof.upstreamCalls += 1;

    const body = JSON.parse(request.body);
    const lastUser =
      body.input.filter((message) => message.role === "user").at(-1)?.content ||
      "";
    const userText = String(lastUser).split("\n\nUSER_MESSAGE\n").at(-1);

    proof.messages.push({
      model: body.model,
      text: userText.slice(0, 180),
      contextIncluded: request.body.includes("ORBIT_REFERENCE_DATA"),
    });

    const reply =
      "QA transport verified: your cat message reached Orbit, streamed through the selected model interface, and returned successfully.";
    const events = [
      { type: "response.output_text.delta", delta: reply.slice(0, 36) },
      { type: "response.output_text.delta", delta: reply.slice(36) },
      { type: "response.completed" },
    ];
    const encoder = new TextEncoder();

    return new Response(
      new ReadableStream({
        start(controller) {
          for (const event of events)
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }

  function sendJson(response, status, body) {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(body));
  }

  async function staticFile(url, response) {
    let directory;
    let relative;

    if (["/", "/index.html"].includes(url.pathname)) {
      directory = projectRoot;
      relative = "index.html";
    } else if (url.pathname === "/styles.css") {
      directory = projectRoot;
      relative = "styles.css";
    } else if (url.pathname.startsWith("/generated/")) {
      directory = path.join(projectRoot, "generated");
      relative = url.pathname.slice(11);
    } else if (url.pathname.startsWith("/assets/")) {
      directory = path.join(projectRoot, "public/assets");
      relative = url.pathname.slice(8);
    } else if (url.pathname.startsWith("/downloads/")) {
      directory = path.join(projectRoot, "public/downloads");
      relative = url.pathname.slice(11);
    } else {
      sendJson(response, 404, { message: "QA route not found" });
      return;
    }

    const target = path.resolve(directory, decodeURIComponent(relative));
    const within = path.relative(directory, target);

    if (within.startsWith("..") || path.isAbsolute(within)) {
      sendJson(response, 403, { message: "Invalid QA path" });
      return;
    }

    const realTarget = await realpath(target);
    const realDirectory = await realpath(directory);
    const resolved = path.relative(realDirectory, realTarget);

    if (
      resolved.startsWith("..") ||
      path.isAbsolute(resolved) ||
      !(await stat(realTarget)).isFile()
    ) {
      sendJson(response, 403, { message: "Invalid QA file" });
      return;
    }

    let bytes = await readFile(realTarget);

    if (relative === "index.html") {
      bytes = Buffer.from(
        bytes
          .toString("utf8")
          .replace("<title>Orbit</title>", "<title>Orbit · Local QA</title>")
          .replace(
            "<body>",
            '<body><div style="position:fixed;right:14px;bottom:4px;z-index:10000;font:10px Arial;color:#777;pointer-events:none">Local QA · synthetic replies · no external inference</div>',
          ),
      );
    }

    response.writeHead(200, {
      "Content-Type":
        contentTypes[path.extname(realTarget)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(bytes);
  }

  const server = createServer((request, response) => {
    void (async () => {
      const expected = new URL(baseUrl).host;

      if (
        ![expected, expected.replace("127.0.0.1", "localhost")].includes(
          request.headers.host,
        )
      ) {
        sendJson(response, 403, { message: "Use the QA loopback URL" });
        return;
      }

      const url = new URL(request.url, baseUrl);

      if (url.pathname === "/__qa/proof") {
        sendJson(response, 200, {
          ...proof,
          pairedDesktop: [...state.peers.values()].filter(
            (peer) => peer.kind === "desktop",
          ).length,
          activeSelection: state.clients.get(state.activeClient) || null,
          pendingMessages: state.pendingMessages.size,
          latestReply: state.latestReply
            ? { text: state.latestReply.text, error: state.latestReply.error }
            : null,
        });
      } else if (url.pathname.startsWith("/api/companion/"))
        await handleCompanion(request, response, { state });
      else if (url.pathname.startsWith("/api/auth/"))
        await handleAuth(request, response, { store: auth, config: {} });
      else if (url.pathname.startsWith("/api/"))
        await handleApi(request, response, { config, fetcher: fakeUpstream });
      else await staticFile(url, response);
    })().catch((error) => {
      if (!response.headersSent)
        sendJson(response, error.code === "ENOENT" ? 404 : 500, {
          message: "The isolated QA request failed",
        });
      else response.destroy();
    });
  });

  if (options.compile !== false) {
    await compileSources();

    watcher = watch(sourceRoot, { recursive: true }, (_event, filename) => {
      if (!filename?.endsWith(".ts")) return;

      clearTimeout(compileTimer);
      compileTimer = setTimeout(() => {
        compileQueue = compileQueue
          .then(() => compileSources())
          .catch(() => {});
      }, 100);
    });
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port || 0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    state,
    proof,
    async close() {
      clearTimeout(compileTimer);
      watcher?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      auth.close();
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const fixture = await startCompanionRoundtripFixture({ port: 4316 });

  console.log(`Orbit isolated QA fixture: ${fixture.baseUrl}`);
  console.log(
    "Synthetic responses only; no API keys, real account data, or external inference",
  );
  console.log(`PID: ${process.pid}`);
  console.log(`Proof: ${fixture.baseUrl}/__qa/proof`);

  process.on("SIGINT", () => {
    void fixture.close();
  });
  process.on("SIGTERM", () => {
    void fixture.close();
  });
}
