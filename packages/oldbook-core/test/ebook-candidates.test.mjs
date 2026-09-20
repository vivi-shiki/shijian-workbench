import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { EbookCandidates, buildCandidateOutput } from "../src/ebook-candidates.mjs";
import { baseline, workspace } from "./fixtures.mjs";

async function candidateRun(history, source, output) {
  const run = await history.startRun("book", { actor: "ai:test", source, input: { purpose: "test" } });
  await history.finishRun("book", run.id, { status: "awaiting_approval", output });
  return run.id;
}

test("all ebook candidate kinds share listing and immutable abandonment", async t => {
  const w = await workspace(t);
  const candidates = new EbookCandidates(w.history);
  const original = baseline();
  const changed = structuredClone(original);
  changed.title = "候選";
  const manual = buildCandidateOutput({ kind: "manual-page-revision-candidate", baseline: original,
    candidate: changed, warnings: [{ code: "review", message: "人工复核" }], page_number: 2 });
  const batch = buildCandidateOutput({ kind: "ebook-generation-candidate", baseline: original,
    candidate: changed, page_range: { start: 1, end: 3 } });
  const review = { kind: "ebook-candidate", baseline_hash: manual.baseline_hash,
    candidate_hash: manual.candidate_hash, candidate: changed, diff: manual.diff, evaluation: { mechanical_pass: true } };
  const ids = [
    await candidateRun(w.history, "manual-page-revision", manual),
    await candidateRun(w.history, "deepseek-structure", batch),
    await candidateRun(w.history, "ebook-candidate", review)
  ];

  const listed = await candidates.list("book");
  assert.equal(listed.length, 3);
  assert.deepEqual(new Set(listed.map(item => item.kind)), new Set([
    "manual-page-revision-candidate", "ebook-generation-candidate", "ebook-candidate"
  ]));
  assert.equal((await candidates.get("book", ids[0])).warnings[0].code, "review");

  const before = await fs.readFile(w.filename, "utf8");
  const abandoned = await candidates.abandon("book", ids[1], { note: "用户不采用", channel: "web" },
    { actor: "human", requested_by: "human" });
  assert.equal(abandoned.state, "abandoned");
  assert.equal(await fs.readFile(w.filename, "utf8"), before);
  await assert.rejects(candidates.abandon("book", ids[1], { note: "again" }), { status: 409 });
});
