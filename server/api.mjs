import { once } from "node:events";
import { readConfig } from "./config.mjs";
import { extractMemories, validateMemoryPayload } from "./shared-memory.mjs";
import {
  providers,
  getProvider,
  getKey,
  getModels,
  isModelId,
  buildUpstreamRequest,
  readSse,
  normalizeEvent,
} from "./providers.mjs";

// JSON responses

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export function validatePayload(body) {
  const provider = getProvider(body?.provider);

  if (!provider) throw new Error("Choose a supported AI provider.");
  if (!isModelId(body.model)) throw new Error("Choose a valid model.");

  if (
    !Array.isArray(body.messages) ||
    body.messages.length < 1 ||
    body.messages.length > 60
  ) {
    throw new Error("Send between 1 and 60 conversation messages.");
  }

  const messages = body.messages.map((message) => {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.text !== "string" ||
      !message.text.trim() ||
      message.text.length > 30000
    ) {
      throw new Error("The conversation contains an invalid message.");
    }

    return { role: message.role, text: message.text };
  });

  if (messages[0].role !== "user" || messages.at(-1).role !== "user") {
    throw new Error("The conversation must start and end with a user message.");
  }

  const memories = Array.isArray(body.memories)
    ? body.memories.slice(0, 100)
    : [];

  if (memories.some((text) => typeof text !== "string" || text.length > 2000)) {
    throw new Error("A saved note is invalid.");
  }

  const attachments = Array.isArray(body.attachments)
    ? body.attachments.slice(0, 3)
    : [];

  if (
    attachments.some(
      (file) =>
        !file ||
        typeof file.name !== "string" ||
        file.name.length > 180 ||
        typeof file.text !== "string" ||
        file.text.length > 30000,
    )
  ) {
    throw new Error("A text attachment is invalid.");
  }

  const total =
    messages.reduce((sum, item) => sum + item.text.length, 0) +
    memories.join("").length +
    attachments.reduce((sum, item) => sum + item.text.length, 0);

  if (total > 120000)
    throw new Error(
      "This conversation is too long. Start a new chat or remove attachments.",
    );

  return {
    provider,
    payload: {
      provider: provider.id,
      model: body.model,
      messages,
      memories,
      attachments: attachments.map((file) => ({
        name: file.name,
        text: file.text,
      })),
    },
  };
}

async function readJson(request) {
  if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new Error("Use a JSON request.");
  }

  const parts = [];
  let size = 0;

  for await (const part of request) {
    size += part.length;
    if (size > 900000) throw new Error("The message is too large.");
    parts.push(part);
  }

  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new Error("The request is not valid JSON.");
  }
}

// Local request boundaries

function sameOrigin(request) {
  const origin = request.headers.origin;

  return (
    origin === `http://${request.headers.host}` &&
    !["cross-site", "none"].includes(request.headers["sec-fetch-site"])
  );
}

function redact(message, key) {
  let text =
    typeof message === "string"
      ? message
      : "The provider could not complete this request.";

  if (key) text = text.split(key).join("[redacted]");

  return text
    .replace(
      /\b(?:sk-[a-zA-Z0-9_-]{8,}|AIza[a-zA-Z0-9_-]{10,}|pplx-[a-zA-Z0-9_-]{8,})\b/g,
      "[redacted]",
    )
    .slice(0, 400);
}

const rateLimits = new Map();

function allowRequest(address) {
  const now = Date.now();
  const entry = rateLimits.get(address);

  if (!entry || entry.until < now) {
    rateLimits.set(address, { count: 1, until: now + 60000 });
    return true;
  }

  entry.count += 1;
  return entry.count <= 20;
}

// Streaming response bridge

async function relayChat(
  request,
  response,
  provider,
  payload,
  config,
  fetcher,
) {
  const key = getKey(provider, config);

  if (!key) {
    sendJson(response, 503, {
      code: "missing_key",
      message: `Orbit's ${provider.name} connection is not configured yet. Ask the website owner to connect it, then retry.`,
    });
    return;
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 180000);

  response.on("close", () => abort.abort());

  try {
    const upstreamRequest = buildUpstreamRequest(provider, payload, key);
    const upstream = await fetcher(upstreamRequest.url, {
      ...upstreamRequest.options,
      signal: abort.signal,
    });

    if (!upstream.ok) {
      let message = "";

      try {
        const detail = await upstream.json();
        message = detail.error?.message ?? detail.message ?? "";
      } catch {}

      const hint =
        upstream.status === 401 || upstream.status === 403
          ? `Check ${provider.key} and its model permissions.`
          : upstream.status === 429
            ? "The provider is rate-limiting requests or the API account has no remaining credit."
            : "The selected provider could not complete this request.";

      sendJson(response, upstream.status === 429 ? 429 : 502, {
        code: "provider_error",
        message: redact(message || hint, key),
      });
      return;
    }

    if (
      !(upstream.headers.get("content-type") ?? "").includes(
        "text/event-stream",
      )
    ) {
      await upstream.body?.cancel();
      throw new Error("The provider did not return a streaming response.");
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();

    async function emit(event) {
      if (response.destroyed) return;

      if (!response.write(`data: ${JSON.stringify(event)}\n\n`)) {
        await once(response, "drain", { signal: abort.signal });
      }
    }

    await emit({ type: "start", provider: provider.id, model: payload.model });

    let hasText = false;
    let outputSize = 0;
    let complete = false;

    for await (const event of readSse(upstream.body)) {
      const normalized = normalizeEvent(provider, event);

      if (!normalized) continue;
      if (normalized.type === "done") {
        complete = true;
        break;
      }

      if (normalized.type === "error")
        throw new Error(redact(normalized.message, key));

      if (normalized.type === "delta" && normalized.text) {
        hasText = true;
        outputSize += normalized.text.length;
        if (outputSize > 150000)
          throw new Error("The response reached Orbit’s display limit.");
        await emit(normalized);
        if (normalized.complete) {
          complete = true;
          break;
        }
      }
    }

    if (!hasText)
      throw new Error(
        "The provider returned no text. Try another model or ask again.",
      );

    if (!complete) {
      throw new Error(
        "The response stream ended early. You can retry this message.",
      );
    }

    await emit({ type: "done" });
    response.end();
  } catch (error) {
    if (response.destroyed) return;

    const message = abort.signal.aborted
      ? "The request timed out. Please try again."
      : redact(error.message, key);

    if (response.headersSent) {
      response.end(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
    } else {
      sendJson(response, 502, { code: "connection_error", message });
    }
  } finally {
    clearTimeout(timer);
  }
}

// API routing

export async function handleApi(request, response, options = {}) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const fetcher = options.fetcher ?? fetch;
  const config = options.config ?? (await readConfig());

  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, {
      providers: providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        keyName: provider.key,
        configured: Boolean(getKey(provider, config)),
      })),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/models") {
    const provider = getProvider(url.searchParams.get("provider"));

    if (!provider) {
      sendJson(response, 400, { message: "Choose a supported AI." });
      return;
    }

    sendJson(response, 200, await getModels(provider, config, fetcher));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    if (!sameOrigin(request)) {
      sendJson(response, 403, {
        message: "Open Orbit from its local address before sending a message.",
      });
      return;
    }
    if (!allowRequest(request.socket.remoteAddress)) {
      sendJson(response, 429, {
        message: "Too many messages. Try again in a minute.",
      });
      return;
    }

    let data;

    try {
      data = validatePayload(await readJson(request));
    } catch (error) {
      sendJson(response, 400, { message: error.message });
      return;
    }

    await relayChat(
      request,
      response,
      data.provider,
      data.payload,
      config,
      fetcher,
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/memory/extract") {
    if (!sameOrigin(request)) {
      sendJson(response, 403, {
        message: "Open Orbit before saving a memory.",
      });
      return;
    }

    if (!allowRequest(`memory:${request.socket.remoteAddress}`)) {
      sendJson(response, 429, {
        message: "Automatic memory will resume in a minute.",
      });
      return;
    }

    let data;

    try {
      data = validateMemoryPayload(await readJson(request));
    } catch (error) {
      sendJson(response, 400, { message: error.message });
      return;
    }

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 45000);

    response.on("close", () => abort.abort());

    try {
      const memories = await extractMemories(
        data,
        config,
        fetcher,
        abort.signal,
      );

      if (!response.destroyed) sendJson(response, 200, { memories });
    } catch {
      if (!response.destroyed)
        sendJson(response, 503, {
          message:
            "Automatic memory is temporarily unavailable. Your chat is saved.",
        });
    } finally {
      clearTimeout(timer);
    }

    return;
  }

  sendJson(response, 404, { message: "API route not found." });
}
