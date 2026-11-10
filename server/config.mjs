import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));

// Local credentials

const allowedKeys = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "OPENAI_MODEL",
  "ANTHROPIC_MODEL",
  "GEMINI_MODEL",
  "DEEPSEEK_MODEL",
  "XAI_MODEL",
  "PERPLEXITY_MODEL",
]);

export async function ensureLocalConfig(root = projectRoot) {
  const localFile = path.join(root, ".env.local");

  try {
    const template = await readFile(path.join(root, ".env.example"), "utf8");

    await writeFile(localFile, template, {
      flag: "wx",
      mode: 0o600,
    });
    return;
  } catch (error) {
    if (error.code === "ENOENT") return;
    if (error.code !== "EEXIST") throw error;
  }

  // Missing sign-in fields

  const contents = await readFile(localFile, "utf8");
  const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].filter(
    (key) => !new RegExp(`^\\s*${key}\\s*=`, "m").test(contents),
  );

  if (!missing.length) return;

  const separator = contents.endsWith("\n") ? "\n" : "\n\n";

  await appendFile(
    localFile,
    `${separator}# Google sign-in\n\n${missing.map((key) => `${key}=`).join("\n")}\n`,
    "utf8",
  );
}

export async function readConfig() {
  const config = {};

  for (const key of allowedKeys) {
    if (process.env[key]?.trim()) config[key] = process.env[key].trim();
  }

  try {
    const contents = await readFile(
      path.join(projectRoot, ".env.local"),
      "utf8",
    );

    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);

      if (!match || !allowedKeys.has(match[1]) || config[match[1]]) continue;

      let value = match[2];

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (value && !/^(your[_ -]|replace[_ -]|sk-example)/i.test(value)) {
        config[match[1]] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  return config;
}
