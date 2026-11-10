import {
  readFile,
  writeFile,
  lstat,
  realpath,
  rename,
  chmod,
  unlink,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { projectRoot, readConfig } from "./config.mjs";

const maximumBody = 64 * 1024;
const writes = new Map();
const ownerKeys = [
  "OPENAI_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
];

// Local owner boundaries

function localBase(request) {
  const address = String(request.socket?.remoteAddress || "");
  const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  const loopback =
    address === "::1" || (isIP(ipv4) === 4 && ipv4.startsWith("127."));
  const host = String(request.headers.host || "").toLowerCase();
  const match = /^(localhost|127\.0\.0\.1):([1-9]\d{0,4})$/.exec(host);
  const proxied = [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "via",
  ].some((header) => request.headers[header] !== undefined);

  if (!loopback || !match || Number(match[2]) > 65535 || proxied) return null;

  return `http://${host}`;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
  });
  response.end(JSON.stringify(body));
}

function invalid(message, code = "invalid_credentials") {
  return Object.assign(new Error(message), { ownerSafe: true, code });
}

async function readBody(request) {
  if (
    !(request.headers["content-type"] || "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    throw invalid("Send connection settings as JSON.", "invalid_request");
  }

  const contents = await new Promise((resolve, reject) => {
    const parts = [];
    let length = 0;
    let failed = false;

    request.on("data", (part) => {
      length += part.length;

      if (length > maximumBody) {
        if (!failed)
          reject(
            invalid(
              "The connection settings file must be smaller than 64 KB.",
              "body_too_large",
            ),
          );
        failed = true;
        parts.length = 0;
        return;
      }

      if (!failed) parts.push(part);
    });
    request.on("end", () => {
      if (!failed) resolve(Buffer.concat(parts).toString("utf8"));
    });
    request.on("aborted", () =>
      reject(
        invalid("The connection request was interrupted.", "invalid_request"),
      ),
    );
    request.on("error", () =>
      reject(
        invalid("Could not read the connection request.", "invalid_request"),
      ),
    );
  });

  try {
    const body = JSON.parse(contents);

    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();

    return body;
  } catch {
    throw invalid(
      "Send a valid connection settings request.",
      "invalid_request",
    );
  }
}

// Explicit credential fields

function valueOf(value, label) {
  if (value === undefined) return "";
  if (typeof value !== "string") throw invalid(`${label} must be text.`);

  return value.trim();
}

function googleValues(body) {
  let clientId = valueOf(body.googleClientId, "Google client ID");
  let clientSecret = valueOf(body.googleClientSecret, "Google client secret");

  if (body.googleOAuth !== undefined) {
    if (clientId || clientSecret)
      throw invalid(
        "Upload Google credentials or enter the two Google fields, then save.",
      );

    let credentials = body.googleOAuth;

    if (typeof credentials === "string") {
      try {
        credentials = JSON.parse(credentials);
      } catch {
        throw invalid("Choose the Google OAuth JSON credentials file.");
      }
    }

    if (
      !credentials ||
      typeof credentials !== "object" ||
      Array.isArray(credentials) ||
      !Object.hasOwn(credentials, "web") ||
      !credentials.web ||
      typeof credentials.web !== "object" ||
      Array.isArray(credentials.web)
    ) {
      throw invalid("Choose Google OAuth credentials for a Web application.");
    }

    clientId = valueOf(credentials.web.client_id, "Google client ID");
    clientSecret = valueOf(
      credentials.web.client_secret,
      "Google client secret",
    );

    if (!clientId || !clientSecret)
      throw invalid(
        "The Google JSON file must contain its Web client ID and client secret.",
      );
  }

  if (
    clientId &&
    (clientId.length > 255 ||
      !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId))
  ) {
    throw invalid(
      "Enter the Google OAuth Web client ID ending in .apps.googleusercontent.com.",
    );
  }

  if (clientSecret && !/^[A-Za-z0-9._~-]{8,256}$/.test(clientSecret)) {
    throw invalid("Enter a valid Google OAuth client secret.");
  }

  return {
    ...(clientId ? { GOOGLE_CLIENT_ID: clientId } : {}),
    ...(clientSecret ? { GOOGLE_CLIENT_SECRET: clientSecret } : {}),
  };
}

function credentialValues(body) {
  const allowed =
    body.provider === "openai"
      ? ["action", "provider", "openaiKey"]
      : [
          "action",
          "provider",
          "googleClientId",
          "googleClientSecret",
          "googleOAuth",
        ];

  if (body.action !== "save" || !["openai", "google"].includes(body.provider)) {
    throw invalid("Choose which connection to save.", "invalid_request");
  }

  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw invalid(
      "Only the selected connection fields can be saved.",
      "invalid_request",
    );
  }

  if (body.provider === "openai") {
    const key = valueOf(body.openaiKey, "OpenAI API key");

    if (!key) throw invalid("Enter an OpenAI API key before saving.");
    if (!/^sk-[A-Za-z0-9_-]{16,1020}$/.test(key))
      throw invalid("Enter a valid OpenAI API key starting with sk-.");

    return { OPENAI_API_KEY: key };
  }

  const values = googleValues(body);

  if (!Object.keys(values).length)
    throw invalid(
      "Enter Google credentials or choose the downloaded Google OAuth JSON file.",
    );

  return values;
}

// Private environment updates

async function saveEnvironment(root, values) {
  const directory = await realpath(root);
  const filename = path.join(directory, ".env.local");
  const previous = writes.get(filename) || Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      let contents = "";

      try {
        const entry = await lstat(filename);

        if (entry.isSymbolicLink() || !entry.isFile())
          throw new Error("Invalid environment file");

        contents = await readFile(filename, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      const newline = contents.includes("\r\n") ? "\r\n" : "\n";

      for (const [key, value] of Object.entries(values)) {
        const pattern = new RegExp(
          `^([ \\t]*${key}[ \\t]*=[ \\t]*)[^\\r\\n]*`,
          "gm",
        );

        if (pattern.test(contents)) {
          contents = contents.replace(
            pattern,
            (_match, prefix) => `${prefix}${value}`,
          );
        } else {
          if (contents && !contents.endsWith("\n")) contents += newline;
          contents += `${key}=${value}${newline}`;
        }
      }

      const temporary = path.join(
        directory,
        `.env.local.${randomBytes(12).toString("hex")}.tmp`,
      );

      try {
        await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, filename);
        await chmod(filename, 0o600);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });

  writes.set(filename, operation);

  try {
    await operation;
  } finally {
    if (writes.get(filename) === operation) writes.delete(filename);
  }
}

async function isolatedConfig(root) {
  let contents;

  try {
    contents = await readFile(path.join(root, ".env.local"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }

  const config = {};

  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);

    if (!match || !ownerKeys.includes(match[1]) || config[match[1]]) continue;

    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");

    if (value && !/^(your[_ -]|replace[_ -]|sk-example)/i.test(value))
      config[match[1]] = value;
  }

  return config;
}

function connectionStatus(config) {
  return {
    available: true,
    openaiConfigured: Boolean(config.OPENAI_API_KEY),
    googleConfigured: Boolean(
      config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET,
    ),
  };
}

export async function handleOwner(request, response, options = {}) {
  const base = localBase(request);

  if (!base) {
    sendJson(response, 403, {
      available: false,
      code: "local_only",
      message:
        "Owner connection setup is available only on this computer through Orbit’s local address.",
    });
    return;
  }

  let url;

  try {
    url = new URL(request.url, base);
  } catch {
    sendJson(response, 400, {
      code: "invalid_request",
      message: "Use a valid local setup address.",
    });
    return;
  }

  if (url.origin !== base || url.search) {
    sendJson(response, 400, {
      code: "invalid_request",
      message:
        "Send connection settings in the request body, never in the URL.",
    });
    return;
  }

  const root = options.root || projectRoot;
  const loadConfig =
    options.readConfig ||
    (options.root ? () => isolatedConfig(root) : readConfig);

  try {
    if (request.method === "GET" && url.pathname === "/api/owner/status") {
      sendJson(response, 200, connectionStatus(await loadConfig()));
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/owner/credentials"
    ) {
      if (
        request.headers.origin !== base ||
        ["cross-site", "none"].includes(request.headers["sec-fetch-site"])
      ) {
        sendJson(response, 403, {
          code: "same_origin_required",
          message:
            "Open Orbit from its local address before saving connection settings.",
        });
        return;
      }

      const values = credentialValues(await readBody(request));

      await saveEnvironment(root, values);
      sendJson(response, 200, {
        status: "saved",
        ...connectionStatus(await loadConfig()),
      });
      return;
    }

    sendJson(response, 404, {
      code: "not_found",
      message: "Local setup route not found.",
    });
  } catch (error) {
    sendJson(response, error.ownerSafe ? 400 : 500, {
      code: error.ownerSafe ? error.code : "save_failed",
      message: error.ownerSafe
        ? error.message
        : "Could not save local connection settings. Check that this project folder is writable, then try again.",
    });
  }
}
