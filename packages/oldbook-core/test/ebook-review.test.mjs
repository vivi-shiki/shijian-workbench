import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { entry, workspace, task, suite } from "./fixtures.mjs";
import { EbookStore } from "../src/ebook-store.mjs";
import { hashJson } from "../src/change-history.mjs";
import { buildCandidateOutput } from "../src/ebook-candidates.mjs";

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

test("apply requires approval, detects stale production, and retains failed checks as warnings", async t => {
  const w = await workspace(t);
  const generated = await w.review.generate("book", task(), { config: w.config });
  const store = new EbookStore(w.root, { index: async () => ({ id: "book" }) }, w.history);
  const approval = { candidate_hash: generated.candidate_hash, note: "Explicit test approval" };
  await assert.rejects(w.review.apply("book", generated.run_id, {}, store), /candidate_hash/);
  const stale = structuredClone(w.document); stale.title = "Human edit";
  await fs.writeFile(w.filename, JSON.stringify(stale));
  await assert.rejects(w.review.apply("book", generated.run_id, approval, store), { status: 409 });
  assert.equal(JSON.parse(await fs.readFile(w.filename, "utf8")).title, "Human edit");
  await fs.writeFile(w.filename, JSON.stringify(w.document));
  const failing = suite(); failing.cases[0].expect.line_count = 8;
  const report = await w.review.evaluate("book", generated.run_id, failing);
  assert.equal(report.mechanical_pass, false);
  const applied = await w.review.apply("book", generated.run_id, approval, store);
  assert.deepEqual(applied.document.entries, generated.candidate.entries);
  assert.ok(applied.candidate.warnings.length > 0);
});

test("approved apply uses shared save and attaches run attribution", async t => {
  const w = await workspace(t);
  const generated = await w.review.generate("book", task(), { config: w.config });
  const store = new EbookStore(w.root, { index: async () => ({ id: "book" }) }, w.history);
  const approval = { candidate_hash: generated.candidate_hash, note: "Explicit test approval" };
  store.running.add("book");
  await assert.rejects(w.review.apply("book", generated.run_id, approval, store), { status: 409 });
  store.running.clear();
  const applied = await w.review.apply("book", generated.run_id, approval, store,
    { actor: "ai:codex", channel: "agent", requested_by: "human" });
  assert.deepEqual(applied.document.entries, generated.candidate.entries);
  assert.ok((await w.history.readRun("book", generated.run_id)).steps.some(s => s.kind === "candidate-approval"));
  const history = await w.history.read("book");
  const event = history.events.find(e => e.run_id === generated.run_id && e.source === "approved-ebook-candidate");
  assert.equal(event.actor.id, "ai:codex");
  assert.equal(event.metadata.channel, "agent");
  assert.equal(event.metadata.requested_by, "human");
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

test("SKILL review can refine an unapproved single-pass candidate without changing production", async t => {
  const w = await workspace(t);
  const initial = structuredClone(w.document);
  initial.entries.push({ ...structuredClone(initial.entries[0]), id: "entry-0003", title: "初稿候選" });
  initial.source.page_range = { start: 2, end: 2 };
  initial.generation.pipeline = "single-pass-v1";
  const generationRun = await w.history.startRun("book", {
    actor: "ai:siliconflow", source: "deepseek-structure", provider: "siliconflow", model: "test-model",
    input: { document: w.document }, options: { pipeline: "single-pass-v1", start_page: 2, end_page: 2 }
  });
  await w.history.finishRun("book", generationRun.id, { status: "awaiting_approval", output: buildCandidateOutput({
    kind: "ebook-generation-candidate", baseline: w.document, candidate: initial,
    page_range: { start: 2, end: 2 }, pipeline: "single-pass-v1"
  }) });
  const reviewTask = { ...task(), id: "review-generated-page", entry_ids: ["entry-0003"],
    base_candidate_run_id: generationRun.id };
  const reviewed = await w.review.generate("book", reviewTask, { config: w.config });
  assert.equal(reviewed.base_candidate_run_id, generationRun.id);
  assert.equal(reviewed.baseline_hash, hashJson(w.document));
  assert.ok(reviewed.candidate.entries.some(entry => entry.id === "entry-0003"));
  assert.equal(await fs.readFile(w.filename, "utf8"), JSON.stringify(w.document));

  const store = new EbookStore(w.root, { index: async () => ({ id: "book" }) }, w.history);
  const applied = await w.review.apply("book", reviewed.run_id,
    { candidate_hash: reviewed.candidate_hash, note: "Approve reviewed candidate" }, store,
    { actor: "ai:codex", channel: "agent", requested_by: "human" });
  assert.ok(applied.document.entries.some(entry => entry.id === "entry-0003"));
});

test("review candidates mechanically demote impossible fixed-form claims without changing lines", async t => {
  const modelEntry = { ...entry(), form: "五律",
    notes: [{ text: "原注", position: { field: "lines", line: 1, offset: 99 } }] };
  const { root, review } = await workspace(t, async () => ({
    ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      entries: [modelEntry], issues: []
    }) } }] })
  }));
  const output = await review.generate("book", task(), { config: { apiKey: "test-key" } });
  const stored = JSON.parse(await fs.readFile(path.join(root, "book/history/runs", output.run_id, "output.json"), "utf8"));
  assert.equal(stored.candidate.entries[0].form, "");
  assert.deepEqual(stored.candidate.entries[0].lines, entry().lines);
  assert.equal(stored.mechanical_repairs[0].entry_id, "entry-0001");
  assert.equal(stored.candidate.entries[0].notes[0].position.offset, [...entry().lines[0]].length);
  assert.equal(stored.mechanical_repairs[1].note_index, 0);
  assert.match(stored.model_issues[0], /程序已保留正文并清空 form/);
  assert.match(stored.model_issues[1], /程序已收缩到有效边界/);
});
