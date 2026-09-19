import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectStore, atomicJson } from "../src/project-store.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oldbook-store-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ProjectStore(root);
}

const page = (id, text, extra = {}) => ({ id, page_number: 1, image_url: `/${text}.jpg`, width: 100, height: 200,
  regions: [{ id: `${id}-r1`, raw_text: text, edited_text: text, bbox: [10, 20, 30, 40], order: 1 }], ...extra });
const result = (id, pages) => ({ id, label: id, model: id, pages, status: "complete", workflow: { ocr_provider: id } });

test("migration preserves every page field and backup, does not guess remote model", async t => {
  const store = await fixture(t);
  const legacy = { id: "book", title: "Book", schema_version: 1, workflow: { ocr_provider: "remote-paddlevl" },
    pages: [page("page-001", "edited", { custom_field: "preserve", reading_order: "oldbook" })] };
  await atomicJson(path.join(store.directory("book"), "project.json"), legacy);
  await store.migrate("book", true);
  const view = await store.view("book");
  assert.deepEqual(view.pages, legacy.pages);
  assert.equal(view.archived, true);
  assert.equal(view.active_result_id, "archive");
  assert.equal(view.results[0].model, null);
  assert.deepEqual(await store.json(path.join(store.directory("book"), "backups/project-v1.json")), legacy);
  await store.migrate("book", true);
  assert.deepEqual((await store.view("book")).pages, legacy.pages);
});

test("known legacy model is retained", async t => {
  const store = await fixture(t);
  await atomicJson(path.join(store.directory("book"), "project.json"), {
    id: "book", workflow: { ocr_provider: "paddleocr-vl-1.6" }, pages: [page("page-001", "vl")]
  });
  const view = await store.view("book");
  assert.equal(view.active_result_id, "paddleocr-vl-1-6");
  assert.equal(view.results[0].archived, false);
});

test("project archive state can change without rewriting OCR results", async t => {
  const store = await fixture(t);
  const original = result("vl", [page("page-001", "vl")]);
  await store.importResult("book", { title: "Book", result: original });
  const resultBefore = await store.json(store.resultPath("book", "vl"));
  assert.equal((await store.setArchived("book", true)).archived, true);
  assert.equal((await store.setArchived("book", false)).archived, false);
  assert.deepEqual(await store.json(store.resultPath("book", "vl")), resultBefore);
});

test("switch saves edits, deletions and image geometry only to their own model", async t => {
  const store = await fixture(t);
  const vl = page("page-001", "vl");
  const pp = page("page-001", "pp", { width: 300 });
  await store.importResult("book", { title: "Book", result: result("vl", [vl]) });
  await store.importResult("book", { title: "Book", result: result("pp", [pp]) });
  const next = await store.save("book", { active_result_id: "vl", target_result_id: "pp", pages: [{ ...vl, regions: [] }] });
  assert.equal(next.active_result_id, "pp");
  assert.deepEqual(next.pages[0], pp);
  const back = await store.save("book", { active_result_id: "pp", target_result_id: "vl", pages: [], archived: true });
  assert.deepEqual(back.pages[0].regions, []);
  assert.equal(back.archived, true);
  assert.equal(back.pages[0].image_url, vl.image_url);
  const unarchived = await store.save("book", { active_result_id: "vl", pages: [], archived: false });
  assert.equal(unarchived.archived, false);
});

test("stale save fails without switching or destroying newer edits", async t => {
  const store = await fixture(t);
  const original = page("page-001", "vl");
  await store.importResult("book", { title: "Book", result: result("vl", [original]) });
  await store.save("book", { active_result_id: "vl", pages: [{ ...original, regions: [] }] });
  await assert.rejects(store.save("book", { active_result_id: "vl", pages: [original] }), { status: 409 });
  assert.deepEqual((await store.view("book")).pages[0].regions, []);
});

test("batch imports and editor saves serialize; resume cannot overwrite corrected pages", async t => {
  const store = await fixture(t);
  const first = page("page-001", "vl");
  await store.importResult("book", { title: "Book", result: result("vl", [first,
    page("page-002", "pending", { ocr_status: "pending", regions: [] })]) });
  await Promise.all([
    store.save("book", { active_result_id: "vl", pages: [{ ...first, regions: [] }] }),
    store.importPage("book", "vl", page("page-002", "recognized"))
  ]);
  const view = await store.view("book");
  assert.deepEqual(view.pages[0].regions, []);
  assert.equal(view.pages[1].regions[0].raw_text, "recognized");
  assert.equal((await store.importPage("book", "vl", first)).skipped, true);
  assert.deepEqual((await store.view("book")).pages[0].regions, []);
});

test("reader windows return lightweight page summaries and invalidate edited result cache", async t => {
  const store = await fixture(t);
  const pages = [
    page("page-001", "one"),
    page("page-002", "two", { page_number: 2 }),
    page("page-003", "three", { page_number: 3 })
  ];
  await store.importResult("book", { title: "Book", result: result("vl", pages) });

  const first = await store.readerWindow("book", 2, 2);
  assert.equal(first.project.source.pages.length, 3);
  assert.equal(first.project.source.pages[1].regions, undefined);
  assert.deepEqual(first.results[0].pages.map(item => item.page_number), [2]);

  await store.save("book", {
    active_result_id: "vl",
    pages: [{ ...pages[1], regions: [{ ...pages[1].regions[0], edited_text: "corrected" }] }]
  });
  const refreshed = await store.readerWindow("book", 2, 2);
  assert.equal(refreshed.results[0].pages[0].regions[0].edited_text, "corrected");
});
