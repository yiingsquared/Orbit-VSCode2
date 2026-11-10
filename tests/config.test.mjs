import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ensureLocalConfig } from "../server/config.mjs";

// Existing configuration preservation

test("startup appends only missing Google fields without changing existing values", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "orbit-config-test-"));

  try {
    const template =
      "# Template\nOPENAI_API_KEY=\nGOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=\n";
    const existing =
      "# Existing settings\r\nOPENAI_API_KEY=test-local-key\r\nGOOGLE_CLIENT_ID=preserved-client\r\nCUSTOM_SETTING=keep-this";

    await writeFile(path.join(temporary, ".env.example"), template);
    await writeFile(path.join(temporary, ".env.local"), existing);
    await ensureLocalConfig(temporary);

    const updated = await readFile(path.join(temporary, ".env.local"), "utf8");

    assert.ok(updated.startsWith(existing));
    assert.equal((updated.match(/^GOOGLE_CLIENT_ID=/gm) || []).length, 1);
    assert.equal((updated.match(/^GOOGLE_CLIENT_SECRET=$/gm) || []).length, 1);
    assert.equal(updated.includes("OPENAI_API_KEY=\n"), false);

    await ensureLocalConfig(temporary);
    assert.equal(
      await readFile(path.join(temporary, ".env.local"), "utf8"),
      updated,
    );

    const fresh = path.join(temporary, "fresh");

    await mkdir(fresh);
    await writeFile(path.join(fresh, ".env.example"), template);
    await ensureLocalConfig(fresh);
    assert.equal(
      await readFile(path.join(fresh, ".env.local"), "utf8"),
      template,
    );
  } finally {
    const resolved = path.resolve(temporary);

    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("orbit-config-test-"));
    await rm(resolved, { recursive: true, force: true });
  }
});
