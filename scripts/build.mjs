import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { compileSources, projectRoot } from "./compile.mjs";

// Runnable distribution

const outputDirectory = path.resolve(projectRoot, "dist");

if (path.relative(projectRoot, outputDirectory) !== "dist") {
  throw new Error("Invalid build directory");
}

try {
  await mkdir(outputDirectory, { recursive: true });

  // Preserve local accounts and credentials

  for (const entry of [
    "public",
    "desktop",
    "extension",
    "server",
    "scripts",
    "src",
    "tests",
    "generated",
    ".vscode",
  ]) {
    const target = path.resolve(outputDirectory, entry);

    if (path.dirname(target) !== outputDirectory)
      throw new Error("Invalid generated path");

    await rm(target, { recursive: true, force: true });
  }

  for (const filename of [
    "index.html",
    "styles.css",
    "package.json",
    ".env.example",
    "public",
    "desktop",
    "extension",
    "server",
    "scripts",
    "src",
    "tests",
    "tsconfig.json",
    ".vscode",
  ]) {
    await cp(
      path.join(projectRoot, filename),
      path.join(outputDirectory, filename),
      { recursive: true },
    );
  }

  const count = await compileSources(path.join(outputDirectory, "generated"));

  console.log(`Built Orbit in dist with ${count} TypeScript files`);
  console.log("Run npm start from dist to launch the website and API server");
} catch (error) {
  console.error("Build error:", error.message);
  process.exitCode = 1;
}
