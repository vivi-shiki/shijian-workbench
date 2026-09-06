import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { workspace, task, suite } from "./fixtures.mjs";
import { EbookStore } from "../src/ebook-store.mjs";
import { hashJson } from "../src/change-history.mjs";

test("generation records frozen evidence and candidate without touching production", async t => {
  const w = await workspace(t);
  const before = await fs.readFile(w.filename, "utf8");
  const result = await w.review.generate("book", task(), { suite: suite(), config: w.config });
  assert.equal(w.calls.length, 1);
  assert.equal(await fs.readFile(w.filename, "utf8"), before);
  const run = await w.history.readRun("book", result.run_id);
  assert.equal(run.output.candidate_hash, hashJson(result.candidate));
  const payload = JSON.parse(w.calls[0].messages[1].content);
  assert.equal(payload.evidence.length, 2);
  assert.equal(payload.evidence[0].pages[1].regions[0].text, "");
  assert.equal(payload.evidence[0].pages[0].context_only, true);
  assert.equal(payload.context_entries[0].id, "entry-0002");
  assert.doesNotMatch(JSON.stringify(run), /TEST-KEY-NOT-REAL/);
  assert.equal(run.input.versions.prompt_version, hashJson(w.calls[0].messages));
});

test("model failures are archived with no production changes", async t => {
  for (const fetchImpl of [async () => new Response("bad", { status: 503 }), async () => new Response("invalid json")]) {
    const w = await workspace(t, fetchImpl);
    const before = await fs.readFile(w.filename, "utf8");
    await assert.rejects(w.review.generate("book", task(), { config: w.config }), /run=/);
    assert.equal(await fs.readFile(w.filename, "utf8"), before);
    assert.equal(w.calls.length, 1);
    const [id] = await fs.readdir(path.join(w.root, "book/history/runs"));
    const run = await w.history.readRun("book", id);
    assert.equal(run.manifest.status, "failed");
  }
});

test("three-round limit, changed-rule gate and frozen tests are enforced", async t => {
  const w = await workspace(t);
  const first = await w.review.generate("book", task(), { suite: suite(), config: w.config });
  await assert.rejects(w.review.generate("book", task(), { previousRunId: first.run_id, config: w.config }), /Change prompt/);
  const secondTask = { ...task(), rules: ["Inspect neighbouring pages before splitting a work."] };
  const second = await w.review.generate("book", secondTask, { previousRunId: first.run_id, config: w.config });
  assert.equal(second.round, 2);
  assert.deepEqual((await w.history.readRun("book", second.run_id)).input.suite, suite());
  const thirdTask = { ...task(), rules: ["Preserve continuation evidence and record unresolved boundaries."] };
  const changedSuite = suite(); changedSuite.cases[0].expect.line_count = 3;
  await assert.rejects(w.review.generate("book", thirdTask, { previousRunId: second.run_id, suite: changedSuite, config: w.config }), /frozen/);
  const third = await w.review.generate("book", thirdTask, { previousRunId: second.run_id, config: w.config });
  await assert.rejects(w.review.generate("book", task(), { previousRunId: third.run_id, config: w.config }), /Three-round/);
  assert.equal(w.calls.length, 3);
});

test("apply requires approval, rechecks independent tests and detects stale production", async t => {
  const w = await workspace(t);
  const generated = await w.review.generate("book", task(), { config: w.config });
  const store = new EbookStore(w.root, { index: async () => ({ id: "book" }) }, w.history);
  const approval = { candidate_hash: generated.candidate_hash, note: "Explicit test approval" };
  await assert.rejects(w.review.apply("book", generated.run_id, {}, store), /approval/);
  const stale = structuredClone(w.document); stale.title = "Human edit";
  await fs.writeFile(w.filename, JSON.stringify(stale));
  await assert.rejects(w.review.apply("book", generated.run_id, approval, store), { status: 409 });
  assert.equal(JSON.parse(await fs.readFile(w.filename, "utf8")).title, "Human edit");
  await fs.writeFile(w.filename, JSON.stringify(w.document));
  const failing = suite(); failing.cases[0].expect.line_count = 8;
  const report = await w.review.evaluate("book", generated.run_id, failing);
  assert.equal(report.mechanical_pass, false);
  await assert.rejects(w.review.apply("book", generated.run_id, approval, store), /failed evaluation/);
});

test("approved apply uses shared save and attaches run attribution", async t => {
  const w = await workspace(t);
  const generated = await w.review.generate("book", task(), { config: w.config });
  const store = new EbookStore(w.root, { index: async () => ({ id: "book" }) }, w.history);
  const approval = { candidate_hash: generated.candidate_hash, note: "Explicit test approval" };
  store.running.add("book");
  await assert.rejects(w.review.apply("book", generated.run_id, approval, store), { status: 409 });
  store.running.clear();
  const applied = await w.review.apply("book", generated.run_id, approval, store);
  assert.deepEqual(applied.document.entries, generated.candidate.entries);
  assert.ok((await w.history.readRun("book", generated.run_id)).steps.some(s => s.kind === "human-approval"));
  const history = await w.history.read("book");
  assert.ok(history.events.some(e => e.run_id === generated.run_id && e.source === "approved-ebook-candidate"));
});

test("run artifacts cannot be edited unnoticed", async t => {
  const w = await workspace(t);
  const generated = await w.review.generate("book", task(), { config: w.config });
  const run = await w.history.readRun("book", generated.run_id);
  const artifact = path.join(w.root, "book/history/runs", generated.run_id, run.manifest.artifacts[0].path);
  await fs.writeFile(artifact, "{}");
  await assert.rejects(w.history.readRun("book", generated.run_id), /artifact hash mismatch/);
});

test("concurrent conditional saves cannot both overwrite the same baseline", async t => {
  const w = await workspace(t);
  const store = new EbookStore(w.root, { index: async () => ({ id: "book" }) }, w.history);
  const one = structuredClone(w.document); one.title = "First";
  const two = structuredClone(w.document); two.title = "Second";
  const audit = { expected_hash: hashJson(w.document) };
  const first = store.save("book", one, audit);
  const second = store.save("book", two, audit);
  const rejected = assert.rejects(second, { status: 409 });
  await first;
  await rejected;
  assert.equal(JSON.parse(await fs.readFile(w.filename, "utf8")).title, "First");
});

test("retry retains additional independent assertions and counts them as a code-first change", async t => {
  const w = await workspace(t);
  const first = await w.review.generate("book", task(), { config: w.config });
  await w.review.evaluate("book", first.run_id, suite());
  const second = await w.review.generate("book", task(), { previousRunId: first.run_id, config: w.config });
  assert.deepEqual((await w.history.readRun("book", second.run_id)).input.suite, suite());
  assert.equal(second.round, 2);
});

test("failed OCR sources are not sent to the model as blank evidence", async t => {
  const w = await workspace(t);
  const filename = path.join(w.root, "book/results/vl.json");
  const result = JSON.parse(await fs.readFile(filename, "utf8"));
  result.pages[1].ocr_status = "failed";
  await fs.writeFile(filename, JSON.stringify(result));
  await assert.rejects(w.review.generate("book", task(), { config: w.config }), /Incomplete core OCR/);
  assert.equal(w.calls.length, 0);
});
