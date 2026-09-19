import assert from "node:assert/strict";
import test from "node:test";
import { readPromptHistory, recentPrompts, rememberPrompt } from "../src/prompt-history.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

test("prompt history is project scoped, newest first, and de-duplicated", () => {
  const storage = memoryStorage();
  rememberPrompt("book-a", "第一条", storage);
  rememberPrompt("book-a", "第二条", storage);
  rememberPrompt("book-a", "第一条", storage);
  rememberPrompt("book-b", "另一项目", storage);

  assert.deepEqual(readPromptHistory("book-a", storage).map((record) => record.prompt), ["第一条", "第二条"]);
  assert.deepEqual(readPromptHistory("book-b", storage).map((record) => record.prompt), ["另一项目"]);
});

test("recent prompt shortcut returns only the requested leading records", () => {
  const storage = memoryStorage();
  for (let index = 1; index <= 14; index += 1) rememberPrompt("book", `提示 ${index}`, storage);
  assert.deepEqual(recentPrompts("book", 10, storage).map((record) => record.prompt),
    ["提示 14", "提示 13", "提示 12", "提示 11", "提示 10", "提示 9", "提示 8", "提示 7", "提示 6", "提示 5"]);
});

test("malformed local history is ignored", () => {
  const storage = memoryStorage();
  storage.setItem("oldbook.revision-prompt-history.v1:book", "not json");
  assert.deepEqual(readPromptHistory("book", storage), []);
});
