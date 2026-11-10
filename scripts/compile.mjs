import * as nodeModule from "node:module";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Project paths

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const sourceRoot = path.join(projectRoot, "src");
export const generatedRoot = path.join(projectRoot, "generated");

// TypeScript support

export function assertNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);

  if (major < 22 || (major === 22 && minor < 18)) {
    throw new Error(
      "Please use Node.js 22.18 or newer, then run npm start again",
    );
  }

  if (typeof nodeModule.stripTypeScriptTypes !== "function") {
    throw new Error("This Node.js version cannot compile TypeScript");
  }
}

// Source files

async function collectSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectSources(absolutePath)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(absolutePath);
    }
  }

  return files.sort();
}

// Browser JavaScript

export async function compileSources(
  outputDirectory = generatedRoot,
  writeOutput = true,
) {
  assertNodeVersion();

  const sources = await collectSources(sourceRoot);
  const outputFiles = [];

  for (const sourcePath of sources) {
    const source = await readFile(sourcePath, "utf8");
    const relativePath = path
      .relative(sourceRoot, sourcePath)
      .replace(/\.ts$/, ".js");
    const outputPath = path.join(outputDirectory, relativePath);
    const javascript = nodeModule.stripTypeScriptTypes(source, {
      mode: "strip",
    });

    outputFiles.push({ outputPath, javascript });
  }

  if (writeOutput) {
    for (const { outputPath, javascript } of outputFiles) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, javascript, "utf8");
    }
  }

  return sources.length;
}
