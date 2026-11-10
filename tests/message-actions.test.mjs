import test from "node:test";
import assert from "node:assert/strict";
import { formatMessageTime, splitSpeechText } from "../src/message-actions.ts";

// Historic timestamp integrity

test("message time never invents a sent time for legacy records", () => {
  assert.equal(formatMessageTime(), null);
  assert.equal(formatMessageTime(NaN, Infinity), null);

  const legacy = formatMessageTime(undefined, Date.UTC(2026, 10, 9, 14, 30));

  assert.match(legacy.label, /^Updated /);
  assert.match(legacy.title, /^Conversation last updated /);
  assert.equal(legacy.dateTime, "2026-11-09T14:30:00.000Z");
});

test("message creation time takes precedence over conversation updates", () => {
  const value = formatMessageTime(
    Date.UTC(2026, 10, 8, 18, 15),
    Date.UTC(2026, 10, 9),
  );

  assert.match(value.title, /^Sent /);
  assert.doesNotMatch(value.label, /^Updated /);
  assert.equal(value.dateTime, "2026-11-08T18:15:00.000Z");
});

// Complete browser speech chunks

test("long replies retain every character across bounded speech chunks", () => {
  const text =
    "A useful answer.\nAnother sentence with code and numbers 123. ".repeat(
      2000,
    );
  const chunks = splitSpeechText(text);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 1600));
});

test("speech boundaries never split Unicode surrogate pairs", () => {
  const text = "A🙂猫".repeat(3000);
  const chunks = splitSpeechText(text, 151);

  assert.equal(chunks.join(""), text);

  for (const chunk of chunks) {
    const first = chunk.charCodeAt(0);
    const last = chunk.charCodeAt(chunk.length - 1);

    assert.equal(first >= 0xdc00 && first <= 0xdfff, false);
    assert.equal(last >= 0xd800 && last <= 0xdbff, false);
  }
});

test("empty replies do not create speech work", () => {
  assert.deepEqual(splitSpeechText(""), []);
});
