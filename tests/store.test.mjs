import test from "node:test";
import assert from "node:assert/strict";
import {
  setStorageAccount,
  readStored,
  writeStored,
  loadChats,
  loadNotes,
} from "../src/store.ts";

// Isolated browser storage

function storageFixture() {
  const values = new Map();
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  let blocked = () => false;
  const storage = {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem(key, value) {
      if (blocked(key)) throw new Error("Storage quota exceeded");

      values.set(key, String(value));
    },
    removeItem: (key) => values.delete(key),
  };

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  setStorageAccount(null);

  return {
    values,
    storage,
    block: (predicate) => {
      blocked = predicate;
    },
    restore() {
      setStorageAccount(null);
      if (descriptor)
        Object.defineProperty(globalThis, "localStorage", descriptor);
      else delete globalThis.localStorage;
    },
  };
}

function chat(id, text = "Saved message", state = "complete") {
  return {
    id,
    provider: "openai",
    model: "gpt-6.1-sol",
    title: id,
    updated: 1000,
    messages: [{ id: `message-${id}`, role: "assistant", text, state }],
    saved: true,
  };
}

const note = (id, text) => ({ id, text, created: 1000 });

test("the first signed-in account imports legacy history and preferences without deleting originals", () => {
  const fixture = storageFixture();

  try {
    const legacyChats = JSON.stringify([
      chat("legacy-chat", "In progress", "pending"),
    ]);
    const legacyNotes = JSON.stringify([note("legacy-note", "Remember this")]);

    fixture.values.set("orbit.chats.v1", legacyChats);
    fixture.values.set("orbit.notes.v1", legacyNotes);
    fixture.values.set(
      "orbit.preview.notes.v1",
      JSON.stringify([note("older-note", "Old fallback note")]),
    );
    fixture.values.set("orbit.includeMemory.v1", "false");
    setStorageAccount("account-a");

    assert.equal(loadChats()[0].id, "legacy-chat");
    assert.equal(loadChats()[0].messages[0].state, "stopped");
    assert.equal(loadNotes()[0].text, "Remember this");
    assert.equal(readStored("orbit.includeMemory.v1", true), false);
    assert.equal(fixture.values.get("orbit.chats.v1"), legacyChats);
    assert.equal(fixture.values.get("orbit.notes.v1"), legacyNotes);
    assert.equal(
      JSON.parse(fixture.values.get("orbit.chats.v1"))[0].messages[0].state,
      "pending",
    );
  } finally {
    fixture.restore();
  }
});

test("different accounts have separate chats, both note keys, and memory preferences", () => {
  const fixture = storageFixture();

  try {
    fixture.values.set(
      "orbit.chats.v1",
      JSON.stringify([chat("legacy-private")]),
    );
    setStorageAccount("account-a");
    writeStored("orbit.notes.v1", [note("a-note", "Account A")]);
    writeStored("orbit.preview.notes.v1", [
      note("a-preview", "Account A fallback"),
    ]);
    writeStored("orbit.includeMemory.v1", false);

    setStorageAccount("account-b");
    assert.deepEqual(loadChats(), []);
    assert.deepEqual(loadNotes(), []);
    assert.deepEqual(readStored("orbit.preview.notes.v1", []), []);
    assert.equal(readStored("orbit.includeMemory.v1", true), true);
    writeStored("orbit.chats.v1", [chat("b-chat")]);
    writeStored("orbit.notes.v1", [note("b-note", "Account B")]);
    writeStored("orbit.preview.notes.v1", [
      note("b-preview", "Account B fallback"),
    ]);

    setStorageAccount("account-a");
    assert.equal(loadChats()[0].id, "legacy-private");
    assert.equal(loadNotes()[0].text, "Account A");
    assert.equal(readStored("orbit.preview.notes.v1", [])[0].id, "a-preview");
    assert.equal(readStored("orbit.includeMemory.v1", true), false);

    setStorageAccount("account-b");
    assert.equal(loadChats()[0].id, "b-chat");
    assert.equal(loadNotes()[0].text, "Account B");
  } finally {
    fixture.restore();
  }
});

test("signed-out access exposes no account data and never changes legacy global data", () => {
  const fixture = storageFixture();

  try {
    const originals = [
      "orbit.chats.v1",
      "orbit.notes.v1",
      "orbit.preview.notes.v1",
      "orbit.includeMemory.v1",
    ];

    for (const key of originals) fixture.values.set(key, JSON.stringify(key));

    const before = new Map(fixture.values);

    assert.deepEqual(loadChats(), []);
    assert.deepEqual(loadNotes(), []);
    for (const key of originals)
      assert.equal(writeStored(key, ["Should not be saved"]), false);
    assert.deepEqual(fixture.values, before);

    setStorageAccount("account-a");
    writeStored("orbit.chats.v1", [chat("account-private")]);
    setStorageAccount(null);
    assert.deepEqual(loadChats(), []);
    assert.deepEqual(loadNotes(), []);
  } finally {
    fixture.restore();
  }
});

test("model selection remains shared while imported history is not resurrected after deletion", () => {
  const fixture = storageFixture();

  try {
    fixture.values.set("orbit.chats.v1", JSON.stringify([chat("old-chat")]));
    setStorageAccount("account-a");
    writeStored("orbit.models.v1", { openai: "chosen-model" });
    writeStored("orbit.chats.v1", []);
    setStorageAccount("account-b");
    assert.deepEqual(readStored("orbit.models.v1", {}), {
      openai: "chosen-model",
    });
    setStorageAccount("account-a");
    assert.deepEqual(loadChats(), []);
    assert.equal(
      JSON.parse(fixture.values.get("orbit.chats.v1"))[0].id,
      "old-chat",
    );
    setStorageAccount(null);
    assert.equal(
      writeStored("orbit.models.v1", { openai: "guest-model" }),
      true,
    );
    assert.deepEqual(readStored("orbit.models.v1", {}), {
      openai: "guest-model",
    });
  } finally {
    fixture.restore();
  }
});

test("partial migration resumes for its owner without assigning legacy data to another account", () => {
  const fixture = storageFixture();

  try {
    fixture.values.set(
      "orbit.chats.v1",
      JSON.stringify([chat("retained-chat")]),
    );
    fixture.values.set(
      "orbit.notes.v1",
      JSON.stringify([note("retained-note", "Original note")]),
    );
    fixture.block((key) => key.includes(":orbit.notes.v1"));
    setStorageAccount("account-a");
    assert.equal(loadChats()[0].id, "retained-chat");
    assert.deepEqual(loadNotes(), []);
    setStorageAccount("account-b");
    assert.deepEqual(loadChats(), []);
    assert.deepEqual(loadNotes(), []);
    fixture.block(() => false);
    setStorageAccount("account-a");
    assert.equal(loadNotes()[0].text, "Original note");
    assert.equal(
      JSON.parse(fixture.values.get("orbit.notes.v1"))[0].id,
      "retained-note",
    );
  } finally {
    fixture.restore();
  }
});

test("legacy import preserves existing scoped rows and normalizes only loaded pending messages", () => {
  const fixture = storageFixture();

  try {
    fixture.values.set(
      "orbit.chats.v1",
      JSON.stringify([chat("shared-id", "Old version"), chat("legacy-only")]),
    );
    fixture.values.set(
      "orbit.account.v1:account-a:orbit.chats.v1",
      JSON.stringify([
        chat("shared-id", "Account version"),
        chat("private-pending", "Partial text", "pending"),
      ]),
    );
    fixture.values.set(
      "orbit.preview.notes.v1",
      JSON.stringify([note("preview-note", "Legacy fallback")]),
    );
    setStorageAccount("account-a");

    const loaded = loadChats();

    assert.equal(loaded.length, 3);
    assert.equal(
      loaded.find((item) => item.id === "shared-id").messages[0].text,
      "Account version",
    );
    assert.equal(
      loaded.find((item) => item.id === "private-pending").messages[0].state,
      "stopped",
    );
    assert.equal(
      JSON.parse(
        fixture.values.get("orbit.account.v1:account-a:orbit.chats.v1"),
      ).find((item) => item.id === "private-pending").messages[0].state,
      "pending",
    );
    assert.equal(loadNotes()[0].text, "Legacy fallback");
  } finally {
    fixture.restore();
  }
});

test("a failed ownership write cannot hand legacy history to the next account in the same page", () => {
  const fixture = storageFixture();

  try {
    fixture.values.set(
      "orbit.chats.v1",
      JSON.stringify([chat("retained-private-history")]),
    );
    fixture.block(() => true);
    setStorageAccount("account-a");
    fixture.block(() => false);
    setStorageAccount("account-b");
    assert.deepEqual(loadChats(), []);
    setStorageAccount("account-a");
    assert.equal(loadChats()[0].id, "retained-private-history");
    setStorageAccount("\ud800");
    assert.deepEqual(loadChats(), []);
    assert.equal(writeStored("orbit.chats.v1", []), false);
  } finally {
    fixture.restore();
  }
});

test("a new signup skips legacy ownership permanently while an existing account can still import", async () => {
  const fixture = storageFixture();

  try {
    const legacyChats = JSON.stringify([chat("existing-private-history")]);
    const legacyNotes = JSON.stringify([
      note("existing-note", "Old private note"),
    ]);

    fixture.values.set("orbit.chats.v1", legacyChats);
    fixture.values.set("orbit.notes.v1", legacyNotes);
    setStorageAccount("fresh-signup", false);
    assert.deepEqual(loadChats(), []);
    assert.deepEqual(loadNotes(), []);
    assert.equal(fixture.values.has("orbit.storage.legacy-owner.v1"), false);

    // Fresh module after page reload

    const reloaded = await import("../src/store.ts?signup-reload");

    reloaded.setStorageAccount("fresh-signup");
    assert.deepEqual(reloaded.loadChats(), []);
    assert.deepEqual(reloaded.loadNotes(), []);
    assert.equal(fixture.values.has("orbit.storage.legacy-owner.v1"), false);

    setStorageAccount("existing-account");
    assert.equal(loadChats()[0].id, "existing-private-history");
    assert.equal(loadNotes()[0].id, "existing-note");
    setStorageAccount("fresh-signup");
    assert.deepEqual(loadChats(), []);
    assert.deepEqual(loadNotes(), []);
    assert.equal(fixture.values.get("orbit.chats.v1"), legacyChats);
    assert.equal(fixture.values.get("orbit.notes.v1"), legacyNotes);
  } finally {
    fixture.restore();
  }
});
