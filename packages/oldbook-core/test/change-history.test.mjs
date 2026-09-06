import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HistoryStore, diffJson } from "../src/change-history.mjs";
import { atomicJson } from "../src/project-store.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oldbook-history-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "book");
  await atomicJson(path.join(project, "project.json"), {
    schema_version: 2, id: "book", title: "Book", active_result_id: "ocr", results: []
  });
  return { root, project, history: new HistoryStore(root) };
}

test("identified arrays produce stable entity paths and exact before/after values", () => {
  const before = { pages: [{ id: "page-001", regions: [{ id: "r1", edited_text: "雨集" }] }] };
  const after = { pages: [{ id: "page-001", regions: [{ id: "r1", edited_text: "疑雨集" }] }] };
  assert.deepEqual(diffJson(before, after), [{
    op: "replace",
    path: "/pages/page-001/regions/r1/edited_text",
    before: "雨集",
    after: "疑雨集"
  }]);
});

test("human changes update append-only events and AI memory", async t => {
  const { history } = await fixture(t);
  const before = { entries: [{ id: "entry-0001", title: "疑雨集", lines: [], notes: [], source_pages: [1] }], issues: [] };
  const after = structuredClone(before);
  after.entries[0].title = "疑雨集註";
  const event = await history.recordChange({
    projectId: "book", target: { kind: "ebook" }, before, after,
    actor: "human", source: "ebook-json-editor", operation: "edit_ebook"
  });
  assert.equal(event.actor.id, "human");
  assert.equal(event.changes[0].entry_id, "entry-0001");
  assert.equal(event.changes[0].before, "疑雨集");
  assert.equal(event.changes[0].after, "疑雨集註");

  const data = await history.read("book", 10);
  assert.equal(data.total, 2); // project baseline is created while reconciling managed files
  assert.equal(data.integrity.valid, true);
  assert.equal(data.overview.totals.text_changes, 1);
  const context = await history.aiContext("book");
  assert.match(context, /疑雨集/);
  assert.match(context, /人工校订优先/);
});

test("begin and commit attribute direct JSON edits to Codex", async t => {
  const { history, project } = await fixture(t);
  await history.reconcileProject("book");
  await history.beginAttribution("book", { actor: "ai:codex", source: "codex-direct-edit", note: "校正书名" });
  const filename = path.join(project, "project.json");
  const document = JSON.parse(await fs.readFile(filename, "utf8"));
  document.title = "New Book";
  await atomicJson(filename, document);
  const events = await history.commitAttribution("book");
  assert.equal(events.length, 1);
  assert.equal(events[0].actor.id, "ai:codex");
  assert.equal(events[0].source, "codex-direct-edit");
  assert.equal(events[0].changes.find(change => change.path === "/title").after, "New Book");
});

test("AI runs retain manifest, request steps, output, and linked change event", async t => {
  const { history, project } = await fixture(t);
  const run = await history.startRun("book", {
    actor: "ai:siliconflow", source: "deepseek-structure", provider: "siliconflow", model: "deepseek",
    input: { page: 1 }
  });
  await history.recordRunStep("book", run.id, {
    kind: "structure-chunk", request: { messages: ["prompt"] }, response: { content: "{}" }
  });
  await history.recordChange({
    projectId: "book", target: { kind: "ebook" }, before: { entries: [] }, after: { entries: [{ id: "e1" }] },
    actor: "ai:siliconflow", source: "deepseek-structure", operation: "ai_chunk", runId: run.id
  });
  await history.finishRun("book", run.id, { status: "complete", output: { entries: [{ id: "e1" }] } });

  const directory = path.join(project, "history", "runs", run.id);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.steps, 1);
  assert.equal((await fs.readdir(path.join(directory, "steps"))).length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "output.json"), "utf8")), { entries: [{ id: "e1" }] });
  const data = await history.read("book", 10);
  assert.ok(data.events.some(event => event.run_id === run.id));
});
