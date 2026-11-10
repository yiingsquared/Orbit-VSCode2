import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Actual startup with isolated dependencies

async function fixture(action) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "orbit-startup-test-"),
  );

  try {
    for (const name of ["scripts", "server", "src", "generated", "public"]) {
      await mkdir(path.join(directory, name));
    }

    await writeFile(
      path.join(directory, "scripts/dev.mjs"),
      await readFile(new URL("../scripts/dev.mjs", import.meta.url), "utf8"),
    );
    await writeFile(
      path.join(directory, "scripts/compile.mjs"),
      `
      import { fileURLToPath } from 'node:url';
      import path from 'node:path';
      export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
      export const sourceRoot = path.join(projectRoot, 'src');
      export const generatedRoot = path.join(projectRoot, 'generated');
      export async function compileSources() { return 0; }
    `,
    );
    await writeFile(
      path.join(directory, "server/config.mjs"),
      "export async function ensureLocalConfig() {}",
    );

    for (const name of ["api", "auth", "companion", "owner"]) {
      const handler = `handle${name[0].toUpperCase()}${name.slice(1)}`;

      await writeFile(
        path.join(directory, `server/${name}.mjs`),
        `export async function ${handler}(_request, response) { response.end('test'); }`,
      );
    }

    await writeFile(
      path.join(directory, "index.html"),
      "<!doctype html><title>Orbit startup test</title>",
    );
    await action(directory);
  } finally {
    const resolved = path.resolve(directory);

    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("orbit-startup-test-"));
    await rm(resolved, { recursive: true, force: true });
  }
}

function run(directory, port) {
  const env = { ...process.env };

  if (port === undefined) delete env.ORBIT_PORT;
  else env.ORBIT_PORT = port;

  const child = spawn(
    process.execPath,
    [path.join(directory, "scripts/dev.mjs")],
    {
      cwd: directory,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";

  child.stdout.on("data", (part) => {
    output += part;
  });
  child.stderr.on("data", (part) => {
    output += part;
  });

  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, output }));
  });

  return { child, exited, output: () => output };
}

async function exitWithin(process) {
  const timer = setTimeout(() => process.child.kill(), 5000);

  try {
    return await process.exited;
  } finally {
    clearTimeout(timer);
  }
}

async function blocker(port) {
  const server = createServer((_request, response) => response.end("occupied"));

  try {
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    return server;
  } catch (error) {
    if (error.code === "EADDRINUSE") return null;
    throw error;
  }
}

test("occupied default4310 fails clearly without silently switching ports", async () => {
  const listener = await blocker(4310);

  try {
    await fixture(async (directory) => {
      const result = await exitWithin(run(directory));

      assert.equal(result.code, 1);
      assert.match(result.output, /Port 4310 is already in use/);
      assert.match(result.output, /http:\/\/127\.0\.0\.1:4310\//);
      assert.match(result.output, /Ctrl\+C/);
      assert.doesNotMatch(
        result.output,
        /Local: http:\/\/127\.0\.0\.1:431[1-9]/,
      );
    });
  } finally {
    if (listener) await new Promise((resolve) => listener.close(resolve));
  }
});

test("ORBIT_PORT rejects out-of-range and nonnumeric values before startup", async () => {
  await fixture(async (directory) => {
    for (const port of [
      "",
      "4309",
      "4321",
      "0",
      "abc",
      "4310.5",
      " 4310",
      "04310",
    ]) {
      const result = await exitWithin(run(directory, port));

      assert.equal(result.code, 1, `port ${JSON.stringify(port)}`);
      assert.match(
        result.output,
        /ORBIT_PORT must be a whole number from 4310 to 4320/,
      );
      assert.doesNotMatch(result.output, /Local:/);
    }
  });
});

test("an explicit allowed port starts at that port and refuses collisions", async (context) => {
  let listener;
  let selectedPort;

  for (let port = 4320; port > 4310; port -= 1) {
    listener = await blocker(port);

    if (listener) {
      selectedPort = port;
      break;
    }
  }

  if (!listener) {
    context.skip("No isolated QA port is available");
    return;
  }

  try {
    await fixture(async (directory) => {
      const collision = await exitWithin(run(directory, String(selectedPort)));

      assert.equal(collision.code, 1);
      assert.match(
        collision.output,
        new RegExp(`Port ${selectedPort} is already in use`),
      );

      await new Promise((resolve) => listener.close(resolve));
      listener = null;

      const process = run(directory, String(selectedPort));
      const timeout = setTimeout(() => process.child.kill(), 5000);

      try {
        await Promise.race([
          new Promise((resolve) => {
            process.child.stdout.on("data", () => {
              if (
                process
                  .output()
                  .includes(`Local: http://127.0.0.1:${selectedPort}/`)
              )
                resolve();
            });
          }),
          process.exited.then(() => {
            throw new Error(`Server did not start: ${process.output()}`);
          }),
        ]);

        const response = await fetch(`http://127.0.0.1:${selectedPort}/`);

        assert.equal(response.status, 200);
        assert.match(await response.text(), /Orbit startup test/);
      } finally {
        clearTimeout(timeout);
        process.child.kill();
        await process.exited;
      }
    });
  } finally {
    if (listener) await new Promise((resolve) => listener.close(resolve));
  }
});
