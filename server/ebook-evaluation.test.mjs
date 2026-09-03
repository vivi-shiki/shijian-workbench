import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { baseline, entry, task, suite } from "../tests/ebook/fixtures.mjs";
import { evaluateCandidate, validateCases } from "./ebook-evaluation.mjs";
import { assembleCandidate, buildReviewMessages } from "./ebook-review.mjs";

test("regression evaluation is independent and never marks semantic truth approved", () => {
  const book = baseline();
  const report = evaluateCandidate(book, structuredClone(book), task(), suite());
  assert.equal(report.status, "needs_review");
  assert.equal(report.mechanical_pass, true);
  assert.equal(report.cases[0].approved, false);
  const changed = structuredClone(book);
  changed.entries[0].lines.pop();
  assert.equal(evaluateCandidate(book, changed, task(), suite()).cases[0].status, "failed");
  const out = suite(); out.cases[0].pages = [99];
  assert.equal(evaluateCandidate(book, book, task(), out).cases[0].status, "not_exercised");
});

test("malformed candidates fail closed instead of crashing", () => {
  for (const bad of [null, { ...baseline(), entries: [null] }, { ...baseline(), entries: [{ ...entry(), lines: [42] }] },
    { ...baseline(), entries: [{ ...entry(), source_pages: "2" }] }]) {
    const report = evaluateCandidate(baseline(), bad, task());
    assert.equal(report.mechanical_pass, false);
    assert.equal(report.status, "failed");
  }
});

test("outside scope, missing punctuation and invalid note anchors are rejected", () => {
  const book = baseline();
  let next = structuredClone(book); next.entries[1].title = "Changed";
  assert.ok(evaluateCandidate(book, next, task()).failures.some(f => f.code === "outside_scope_changed"));
  next = structuredClone(book); next.entries[0].lines[0] = "甲乙丙丁戊";
  assert.ok(evaluateCandidate(book, next, task()).failures.some(f => f.code === "missing_punctuation"));
  next = structuredClone(book); next.entries[0].notes = [{ text: "原注", position: { field: "lines", line: 1, offset: 99 } }];
  assert.equal(evaluateCandidate(book, next, task()).mechanical_pass, false);
});

test("formatting preserves characters, note anchors and fields outside its mode", () => {
  const book = baseline();
  book.entries[0].notes = [{ text: "原注曰甲乙", position: { field: "lines", line: 1, offset: 2 } }];
  const next = structuredClone(book);
  const config = { ...task(), mode: "notes" };
  next.entries[0].notes[0].text = "原注曰：甲乙。";
  assert.equal(evaluateCandidate(book, next, config).mechanical_pass, true);
  next.entries[0].notes[0].text = "原注曰：甲丙。";
  assert.ok(evaluateCandidate(book, next, config).failures.some(f => f.code === "note_characters_changed"));
  next.entries[0].notes[0].text = "原注曰甲乙";
  next.entries[0].notes[0].position.offset = 3;
  assert.ok(evaluateCandidate(book, next, config).failures.some(f => f.code === "formatting_changed_other_fields"));
  book.entries[0].kind = "preface"; book.entries[0].prose = "甲乙丙丁";
  const prose = structuredClone(book); prose.entries[0].prose = "甲乙。\n\n丙丁。";
  assert.equal(evaluateCandidate(book, prose, { ...task(), mode: "prose" }).mechanical_pass, true);
  prose.entries[0].prose = "甲乙丁";
  assert.equal(evaluateCandidate(book, prose, { ...task(), mode: "prose" }).mechanical_pass, false);
});

test("oracle assertions and raw feedback do not leak into model messages", () => {
  const messages = buildReviewMessages("Book", { ...task(), raw_feedback: "RAW-SECRET", expect: "ORACLE-SECRET" }, [entry()], []);
  assert.doesNotMatch(JSON.stringify(messages), /RAW-SECRET|ORACLE-SECRET/);
  assert.match(JSON.stringify(messages), /Check boundaries/);
});

test("candidate assembly enforces identity and leaves model errors visible to evaluation", () => {
  const book = baseline();
  const make = entries => assembleCandidate(book, task(), { entries, issues: [] });
  assert.throws(() => make([entry("entry-0002")]), /out-of-scope/);
  assert.throws(() => make([entry(), entry()]), /duplicate/);
  const next = make([entry(), entry("")]);
  assert.deepEqual(next.entries.map(e => e.id), ["entry-0001", "entry-0003", "entry-0002"]);
  const bad = entry(); bad.notes = [{ text: "原注", position: { field: "lines", line: 1, offset: 99 } }];
  assert.equal(make([bad]).entries[0].notes[0].position.offset, 99);
});

test("regression suites reject unknown assertions instead of silently passing", () => {
  const checks = suite(); checks.cases[0].expect.typo = true;
  assert.throws(() => validateCases(checks, "book"), /Unsupported expectation/);
  assert.throws(() => validateCases(suite(), "another-book"), /project_id/);
});

test("historical case data is valid but explicitly unapproved", async () => {
  const cases = JSON.parse(await fs.readFile(new URL("../tests/ebook/cases/yiyuji.json", import.meta.url), "utf8"));
  validateCases(cases, "yiyuji-four-volumes");
  assert.equal(cases.cases.length, 5);
  assert.ok(cases.cases.every(c => c.status === "proposed"));
});
