import { readFile } from "node:fs/promises";
import path from "node:path";
import { compileSources, projectRoot } from "./compile.mjs";

// Source syntax

try {
  const fileCount = await compileSources(undefined, false);

  // Project configuration

  for (const filename of [
    "package.json",
    "tsconfig.json",
    ".vscode/launch.json",
    ".vscode/tasks.json",
  ]) {
    JSON.parse(await readFile(path.join(projectRoot, filename), "utf8"));
  }

  console.log(
    `Checked ${fileCount} TypeScript files and project configuration`,
  );
} catch (error) {
  console.error("Check error:", error.message);
  process.exitCode = 1;
}
