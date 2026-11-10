import { createServer } from "node:http";
import { createReadStream, watch } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { handleApi } from "../server/api.mjs";
import { handleAuth } from "../server/auth.mjs";
import { handleCompanion } from "../server/companion.mjs";
import { handleOwner } from "../server/owner.mjs";
import { ensureLocalConfig } from "../server/config.mjs";
import {
  compileSources,
  generatedRoot,
  projectRoot,
  sourceRoot,
} from "./compile.mjs";

// Static file types

const contentTypes = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".exe": "application/octet-stream",
  ".zip": "application/zip",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const publicRoot = path.join(projectRoot, "public");
let activePort = 4310;
let sourceWatcher;

// Local file boundaries

function staysInside(directory, target) {
  const relativePath = path.relative(directory, target);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

async function resolveFile(requestPath) {
  let allowedRoot;
  let relativePath;

  if (requestPath === "/" || requestPath === "/index.html") {
    allowedRoot = projectRoot;
    relativePath = "index.html";
  } else if (requestPath === "/styles.css") {
    allowedRoot = projectRoot;
    relativePath = "styles.css";
  } else if (requestPath.startsWith("/generated/")) {
    allowedRoot = generatedRoot;
    relativePath = requestPath.slice("/generated/".length);
  } else if (requestPath.startsWith("/assets/")) {
    allowedRoot = path.join(publicRoot, "assets");
    relativePath = requestPath.slice("/assets/".length);
  } else if (requestPath.startsWith("/downloads/")) {
    allowedRoot = path.join(publicRoot, "downloads");
    relativePath = requestPath.slice("/downloads/".length);
  } else if (requestPath === "/favicon.svg") {
    allowedRoot = publicRoot;
    relativePath = "favicon.svg";
  } else {
    return null;
  }

  const target = path.resolve(allowedRoot, relativePath);

  if (!staysInside(allowedRoot, target)) {
    return null;
  }

  const resolvedTarget = await realpath(target);
  const resolvedRoot = await realpath(allowedRoot);

  if (!staysInside(resolvedRoot, resolvedTarget)) {
    return null;
  }

  const metadata = await stat(resolvedTarget);

  return metadata.isFile() ? { target: resolvedTarget, metadata } : null;
}

// Download byte ranges

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);

  if (!match || (!match[1] && !match[2]) || size === 0) {
    return null;
  }

  let start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  let end = match[2] && match[1] ? Number(match[2]) : size - 1;

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    return null;
  }

  if (start < 0 || start >= size || end < start) {
    return null;
  }

  end = Math.min(end, size - 1);

  return { start, end };
}

// HTTP responses

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(text);
}

async function handleRequest(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");

  const validHosts = new Set([
    `127.0.0.1:${activePort}`,
    `localhost:${activePort}`,
  ]);

  if (!validHosts.has(request.headers.host)) {
    sendText(response, 403, "Use the local URL printed in the terminal");
    return;
  }

  let requestPath;

  try {
    requestPath = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    );
  } catch {
    sendText(response, 400, "Invalid URL");
    return;
  }

  if (requestPath.includes("\0") || requestPath.includes("\\")) {
    sendText(response, 400, "Invalid path");
    return;
  }

  if (requestPath.startsWith("/api/owner/")) {
    await handleOwner(request, response);
    return;
  }

  if (requestPath.startsWith("/api/companion/")) {
    await handleCompanion(request, response);
    return;
  }

  if (requestPath.startsWith("/api/auth/")) {
    await handleAuth(request, response);
    return;
  }

  if (requestPath.startsWith("/api/")) {
    await handleApi(request, response);
    return;
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    response.setHeader("Allow", "GET, HEAD");
    sendText(response, 405, "Method not allowed");
    return;
  }

  try {
    const file = await resolveFile(requestPath);

    if (!file) {
      sendText(response, 404, "File not found");
      return;
    }

    const { target, metadata } = file;
    if (requestPath.startsWith("/downloads/")) {
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="${path.basename(target).replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
      );
    }
    const headers = {
      "Content-Type":
        contentTypes[path.extname(target).toLowerCase()] ??
        "application/octet-stream",
      "Accept-Ranges": "bytes",
    };

    let start = 0;
    let end = metadata.size - 1;
    let statusCode = 200;

    if (request.headers.range) {
      const range = parseRange(request.headers.range, metadata.size);

      if (!range) {
        response.writeHead(416, {
          "Content-Range": `bytes */${metadata.size}`,
        });
        response.end();
        return;
      }

      ({ start, end } = range);
      statusCode = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${metadata.size}`;
    }

    headers["Content-Length"] = Math.max(0, end - start + 1);
    response.writeHead(statusCode, headers);

    if (request.method === "HEAD" || metadata.size === 0) {
      response.end();
      return;
    }

    const stream = createReadStream(target, { start, end });

    stream.on("error", () => response.destroy());
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      sendText(response, 404, "File not found");
    } else {
      console.error("File error:", error.message);
      sendText(response, 500, "Unable to read this file");
    }
  }
}

// Development server

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    console.error("Request error:", error.message);

    if (!response.headersSent) {
      sendText(response, 500, "Unable to serve this page");
    } else {
      response.destroy();
    }
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && activePort < 4320) {
    activePort += 1;
    server.listen(activePort, "127.0.0.1");
  } else {
    console.error("Server error:", error.message);
    sourceWatcher?.close();
    process.exitCode = 1;
  }
});

server.on("listening", () => {
  console.log(`\n  Orbit\n\n  Local: http://127.0.0.1:${activePort}/\n`);
  console.log(
    "  Edit src, index.html, or styles.css, then refresh your browser",
  );
  console.log("  Press Ctrl+C to stop\n");
});

// TypeScript changes

let compileTimer;
let compileQueue = Promise.resolve();

function scheduleCompile() {
  clearTimeout(compileTimer);

  compileTimer = setTimeout(() => {
    compileQueue = compileQueue.then(async () => {
      try {
        const fileCount = await compileSources();
        console.log(
          `  Updated ${fileCount} TypeScript files — refresh your browser`,
        );
      } catch (error) {
        console.error("\n  TypeScript error:", error.message, "\n");
      }
    });
  }, 120);
}

try {
  await ensureLocalConfig();
  await compileSources();

  sourceWatcher = watch(sourceRoot, { recursive: true }, (_event, filename) => {
    if (filename?.endsWith(".ts")) {
      scheduleCompile();
    }
  });

  sourceWatcher.on("error", (error) =>
    console.error("Watch error:", error.message),
  );

  function stop() {
    clearTimeout(compileTimer);
    sourceWatcher.close();
    server.close();
    server.closeAllConnections();
  }

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  server.listen(activePort, "127.0.0.1");
} catch (error) {
  console.error("\n  Startup error:", error.message, "\n");
  process.exitCode = 1;
}
