import test from "node:test";
import assert from "node:assert/strict";
import {
  rankChatTitles,
  selectSidebarChats,
  titleMatchScore,
  chatSortTimestamp,
} from "../src/chat-sidebar.ts";

// Conversation fixtures

const chat = (id, title, updated, extra = {}) => ({
  id,
  title,
  updated,
  provider: "openai",
  ...extra,
});

test("Saved and Recents contain each active chat once in latest-used order", () => {
  const chats = [
    chat("old", "Older chat", 1),
    chat("saved", "Important", 3, { saved: true }),
    chat("new", "Latest chat", 9),
    chat("archived", "Archived", 20, { archived: true, saved: true }),
    chat("other", "Other provider", 30, { provider: "claude" }),
  ];
  const before = structuredClone(chats);
  const result = selectSidebarChats(chats, "openai");

  assert.deepEqual(
    result.saved.map((entry) => entry.id),
    ["saved"],
  );
  assert.deepEqual(
    result.recents.map((entry) => entry.id),
    ["new", "old"],
  );
  assert.deepEqual(chats, before);
});

test("search ranks closest titles before recency, ignoring case and accents", () => {
  const chats = [
    chat("long", "Hello world planning", 99),
    chat("exact", "HELLO", 1),
    chat("inside", "Say hello today", 40),
    chat("accent", "Héllo there", 2),
    chat("unrelated", "Goodbye", 999),
  ];

  assert.deepEqual(
    rankChatTitles(chats, "hello").map((entry) => entry.id),
    ["exact", "accent", "long", "inside"],
  );
  assert.equal(titleMatchScore("Héllo", "HELLO"), 0);
});

test("token and small typo matches remain available without matching unrelated names", () => {
  assert.notEqual(
    titleMatchScore("Quarterly project planning", "planning quarterly"),
    null,
  );
  assert.notEqual(titleMatchScore("Story ideas", "stroy"), null);
  assert.equal(titleMatchScore("Travel plans", "database"), null);
  assert.equal(titleMatchScore("Travel plans", "zzz"), null);
});

test("search merges Saved and Recents into one ranked list and excludes archived chats", () => {
  const result = selectSidebarChats(
    [
      chat("recent", "Plan for tomorrow", 20),
      chat("saved", "Plan", 1, { saved: true }),
      chat("archived", "Plan", 30, { archived: true }),
    ],
    "openai",
    "plan",
  );

  assert.deepEqual(result.saved, []);
  assert.deepEqual(
    result.recents.map((entry) => entry.id),
    ["saved", "recent"],
  );
});

test("clearing a search restores latest-used ordering", () => {
  const chats = [
    chat("exact", "Plan", 1),
    chat("latest", "Plan for next week", 50),
  ];

  assert.deepEqual(
    selectSidebarChats(chats, "openai", "plan").recents.map(
      (entry) => entry.id,
    ),
    ["exact", "latest"],
  );
  assert.deepEqual(
    selectSidebarChats(chats, "openai", "").recents.map((entry) => entry.id),
    ["latest", "exact"],
  );
});

test("archive view retrieves saved and ordinary archived conversations without leaking other providers", () => {
  const chats = [
    chat("active", "Live", 10),
    chat("old", "Older archive", 2, { archived: true }),
    chat("saved", "Saved archive", 5, { archived: true, saved: true }),
    chat("other", "Other archive", 9, { archived: true, provider: "gemini" }),
  ];

  assert.deepEqual(
    selectSidebarChats(chats, "openai", "", true).recents.map(
      (entry) => entry.id,
    ),
    ["saved", "old"],
  );
  assert.deepEqual(
    selectSidebarChats(chats, "openai", "older", true).recents.map(
      (entry) => entry.id,
    ),
    ["old"],
  );

  chats[1].archived = false;

  assert.deepEqual(
    selectSidebarChats(chats, "openai").recents.map((entry) => entry.id),
    ["active", "old"],
  );
});

test("last message timestamps keep opening and renaming chats from changing order", () => {
  const chats = [
    chat("old", "Older chat", 900, { lastSentAt: 20 }),
    chat("new", "Newest message", 30, { lastSentAt: 100 }),
  ];

  assert.deepEqual(
    selectSidebarChats(chats, "openai").recents.map((item) => item.id),
    ["new", "old"],
  );

  chats[0].updated = 5000;
  chats[0].title = "Renamed older chat";

  assert.deepEqual(
    selectSidebarChats(chats, "openai").recents.map((item) => item.id),
    ["new", "old"],
  );
});

test("legacy fallback prefers user send and edit times over assistant or conversation updates", () => {
  const derived = chat("derived", "Derived time", 9999, {
    messages: [
      { role: "user", createdAt: 10, editedAt: 50 },
      { role: "assistant", createdAt: 900 },
      { role: "user", createdAt: 30 },
    ],
  });

  assert.equal(chatSortTimestamp(derived), 50);
  assert.equal(chatSortTimestamp({ ...derived, lastSentAt: 80 }), 80);
  assert.equal(chatSortTimestamp(chat("legacy", "No timestamp yet", 35)), 35);
});

test("equally matched search titles use last sent time as their recency tie-break", () => {
  const chats = [
    chat("opened-old", "Plan", 9999, { lastSentAt: 10 }),
    chat("sent-new", "Plan", 20, { lastSentAt: 90 }),
  ];

  assert.deepEqual(
    rankChatTitles(chats, "plan").map((item) => item.id),
    ["sent-new", "opened-old"],
  );
});
