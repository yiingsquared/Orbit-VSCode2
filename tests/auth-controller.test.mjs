import test from "node:test";
import assert from "node:assert/strict";
import { initAuth } from "../src/auth.ts";

const user = {
  id: "isolated-user-123",
  email: "fixture@example.com",
  name: "Fixture",
  provider: "email",
  emailVerified: false,
};

// Controller state without real accounts

async function withAuthPage(
  { query = "", sessionStatus = 200, logoutStatus = 200 } = {},
  action,
) {
  const original = new Map(
    ["window", "document", "fetch"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const window = Object.assign(new EventTarget(), {
    location: { href: `http://127.0.0.1:4310/${query}` },
    history: {
      replaceState(_state, _title, path) {
        window.location.href = new URL(path, window.location.href).href;
      },
    },
  });
  const calls = [];

  class Element extends EventTarget {
    open = false;
    textContent = "";
    classList = { toggle() {} };
    append() {}
    replaceChildren() {}
    setAttribute() {}
    removeAttribute() {}
    querySelector() {
      return null;
    }
    querySelectorAll() {
      return [];
    }
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    }
  }

  const button = new Element();
  const dialog = new Element();
  const document = {
    getElementById: (id) =>
      id === "rail-auth-button" ? button : id === "auth-dialog" ? dialog : null,
    createElementNS: () => new Element(),
    createElement: () => new Element(),
  };

  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: window,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: document,
    });
    globalThis.fetch = async (url) => {
      calls.push(url);

      return url === "/api/auth/session"
        ? Response.json({ user }, { status: sessionStatus })
        : Response.json(
            logoutStatus === 200
              ? { user: null }
              : { message: "Try signing out again" },
            { status: logoutStatus },
          );
    };
    await action({ window, dialog, calls });
  } finally {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("OAuth new-account metadata is delivered once without opening the v2 account modal", async () => {
  await withAuthPage(
    { query: "?auth=success&new_account=1" },
    async ({ window, dialog }) => {
      const changes = [];
      const controller = initAuth({
        showAccountAfterOAuth: false,
        onChange: (next, meta) => changes.push({ next, meta }),
      });

      assert.equal((await controller.ready).id, user.id);
      assert.equal(controller.getUser().id, user.id);
      assert.deepEqual(
        changes.map((change) => change.meta),
        [{ source: "oauth", isNewAccount: true }],
      );
      assert.equal(dialog.open, false);
      assert.equal(new URL(window.location.href).search, "");
    },
  );
});

test("existing OAuth login and ordinary session hydration do not become new-account flows", async () => {
  for (const [query, source] of [
    ["?auth=success", "oauth"],
    ["", "initial"],
  ]) {
    await withAuthPage({ query }, async () => {
      const changes = [];
      const controller = initAuth({
        showAccountAfterOAuth: false,
        onChange: (_user, meta) => changes.push(meta),
      });

      await controller.ready;
      assert.deepEqual(changes, [{ source, isNewAccount: false }]);
    });
  }
});

test("session hydration failures deterministically resolve null", async () => {
  await withAuthPage({ sessionStatus: 503 }, async () => {
    const changes = [];
    const controller = initAuth({
      onChange: (next, meta) => changes.push({ next, meta }),
    });

    assert.equal(await controller.ready, null);
    assert.equal(controller.getUser(), null);
    assert.deepEqual(changes, [
      { next: null, meta: { source: "initial", isNewAccount: false } },
    ]);
  });
});

test("signout awaits its companion hook, deduplicates calls, and emits logout only after server success", async () => {
  await withAuthPage({}, async ({ calls }) => {
    const changes = [];
    const controller = initAuth({
      beforeSignOut: async () => {
        calls.push("quit-hook");
      },
      onChange: (_user, meta) => changes.push(meta),
    });

    await controller.ready;
    const first = controller.signOut();
    const duplicate = controller.signOut();

    assert.equal(first, duplicate);
    await first;
    assert.deepEqual(calls, [
      "/api/auth/session",
      "quit-hook",
      "/api/auth/logout",
    ]);
    assert.equal(controller.getUser(), null);
    assert.deepEqual(changes.at(-1), { source: "logout", isNewAccount: false });
  });
});

test("logout request failures emit the restoration event without sensitive detail or a false logged-out state", async () => {
  await withAuthPage({ logoutStatus: 503 }, async ({ window }) => {
    const failures = [];
    const controller = initAuth({ beforeSignOut: async () => {} });

    window.addEventListener("orbit:authsignouterror", (event) =>
      failures.push(event),
    );
    await controller.ready;
    await assert.rejects(controller.signOut(), /Try signing out again/);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].detail, null);
    assert.equal(controller.getUser().id, user.id);
  });
});

test("a failed beforeSignOut hook leaves the session active and skips the logout request", async () => {
  await withAuthPage({}, async ({ window, calls }) => {
    let failures = 0;
    const controller = initAuth({
      beforeSignOut: async () => {
        throw new Error("Quit failed");
      },
    });

    window.addEventListener("orbit:authsignouterror", () => {
      failures += 1;
    });
    await controller.ready;
    await assert.rejects(controller.signOut(), /Quit failed/);
    assert.equal(calls.includes("/api/auth/logout"), false);
    assert.equal(failures, 1);
    assert.equal(controller.getUser().id, user.id);
  });
});
