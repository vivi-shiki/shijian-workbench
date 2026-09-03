import { isDeepStrictEqual } from "node:util";
import { validateEbook } from "./ebook-store.mjs";

export const textCharacters = value => String(value ?? "").replace(/[\p{P}\p{Z}\s]/gu, "");

export function validateCases(suite, projectId) {
  if (!suite || suite.schema_version !== 1 || suite.project_id !== projectId || !Array.isArray(suite.cases)) {
    throw new Error("Invalid regression suite or project_id");
  }
  const ids = new Set();
  for (const item of suite.cases) {
    if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id) || !["proposed", "approved"].includes(item.status) ||
        !Array.isArray(item.pages) || !item.pages.length || item.pages.some(p => !Number.isInteger(p) || p < 1) ||
        !item.selector || !Object.keys(item.selector).length || !item.expect || !Object.keys(item.expect).length) {
      throw new Error("Invalid regression case");
    }
    ids.add(item.id);
    for (const key of Object.keys(item.selector)) {
      if (!["id", "title", "series_title", "first_line"].includes(key) || typeof item.selector[key] !== "string") {
        throw new Error(`Unsupported selector: ${key}`);
      }
    }
    for (const [key, value] of Object.entries(item.expect)) {
      if (["count", "line_count", "characters_per_line", "series_total"].includes(key)) {
        if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid expectation: ${key}`);
      } else if (key === "series_indices") {
        if (!Array.isArray(value) || value.some(n => !Number.isInteger(n) || n < 1)) throw new Error("Invalid series indices");
      } else if (key === "contains_lines") {
        if (!Array.isArray(value) || value.some(s => typeof s !== "string" || !s)) throw new Error("Invalid required lines");
      } else if (key === "note_anchors") {
        if (!Array.isArray(value) || value.some(n => !n || typeof n.text_includes !== "string" || !n.text_includes || !n.position ||
            !["lines", "title", "series"].includes(n.position.field) ||
            !Number.isInteger(n.position.offset) || n.position.offset < 0 ||
            (n.position.field === "lines" && (!Number.isInteger(n.position.line) || n.position.line < 1)))) {
          throw new Error("Invalid note anchor assertion");
        }
      } else throw new Error(`Unsupported expectation: ${key}`);
    }
  }
  return suite;
}

function matches(entry, selector) {
  const fields = { id: entry.id, title: entry.title, series_title: entry.series?.title, first_line: entry.lines?.[0] };
  return Object.entries(selector).every(([key, value]) => key === "id" ? fields[key] === value : textCharacters(fields[key]) === textCharacters(value));
}

export function evaluateCandidate(baseline, candidate, task, suite = null) {
  const failures = [];
  const warnings = ["Semantic fidelity, work boundaries and note anchors still require human review."];
  const fail = (code, details) => failures.push({ code, ...details });
  try { validateEbook(candidate, baseline.project_id); }
  catch (error) {
    fail("schema", { message: error.message });
    return { status: "failed", mechanical_pass: false, failures, warnings, cases: [] };
  }
  if (candidate.entries.some(e => !e || !Array.isArray(e.source_pages) || !Array.isArray(e.notes) ||
      e.notes.some(n => !n || typeof n.text !== "string") || !Array.isArray(e.lines) || e.lines.some(l => typeof l !== "string"))) {
    fail("schema", { message: "Invalid entry arrays or note text" });
    return { status: "failed", mechanical_pass: false, failures, warnings, cases: [] };
  }
  const targetIds = new Set(task.entry_ids);
  const outside = baseline.entries.filter(e => !targetIds.has(e.id));
  const outsideIds = new Set(outside.map(e => e.id));
  if (!isDeepStrictEqual(outside, candidate.entries.filter(e => outsideIds.has(e.id)))) fail("outside_scope_changed", {});
  const { entries: ignoredBefore, ...headBefore } = baseline;
  const { entries: ignoredAfter, ...headAfter } = candidate;
  if (!isDeepStrictEqual(headBefore, headAfter)) fail("document_metadata_changed", {});
  const selected = candidate.entries.filter(e => !outsideIds.has(e.id));
  const pages = new Set(baseline.entries.filter(e => targetIds.has(e.id)).flatMap(e => e.source_pages));
  if (!selected.length) fail("empty_candidate", {});
  for (const e of selected) {
    const details = { entry_id: e.id };
    if (!["title", "subtitle", "author", "form", "prose"].every(k => typeof e[k] === "string") ||
        !Array.isArray(e.lines) || e.lines.some(s => typeof s !== "string")) {
      fail("invalid_text_fields", details);
      continue;
    }
    if (!e.source_pages?.length || e.source_pages.some(p => !Number.isInteger(p) || !pages.has(p))) fail("invalid_source_pages", details);
    if (e.kind !== "poem") continue;
    const lines = e.lines.filter(s => textCharacters(s));
    if (!lines.length) fail("missing_lines", details);
    if (e.title && textCharacters(e.title) === textCharacters(lines[0])) fail("title_is_first_line", details);
    if (e.series?.title && textCharacters(e.title) === textCharacters(e.series.title)) fail("duplicated_series_title", details);
    // Exact form matching avoids treating pailu, ancient verse or all ci as regulated eight-line verse.
    const form = e.form.replace(/言/g, "");
    const metre = /^(五|七)(绝|絕|律)$/.exec(form);
    if (metre) {
      const count = metre[2] === "律" ? 8 : 4;
      const width = metre[1] === "五" ? 5 : 7;
      if (lines.length !== count) fail("line_count", { ...details, expected: count, actual: lines.length });
      if (lines.some(s => [...textCharacters(s)].length !== width)) fail("line_width", { ...details, expected: width });
    }
    if (lines.some(s => !/[，。！？；：][”’」』]*$/u.test(s.trim()))) fail("missing_punctuation", details);
    if (e.series && (!Number.isInteger(e.series.index) || e.series.index < 1 ||
        (e.series.total != null && (!Number.isInteger(e.series.total) || e.series.total < e.series.index)))) fail("invalid_series_index", details);
  }
  if (task.mode !== "structure") {
    const original = baseline.entries.filter(e => targetIds.has(e.id));
    if (!isDeepStrictEqual(selected.map(e => e.id), original.map(e => e.id))) fail("formatting_changed_entries", {});
    for (const old of original) {
      const next = selected.find(e => e.id === old.id);
      if (!next) continue;
      const oldFixed = structuredClone(old);
      const newFixed = structuredClone(next);
      delete oldFixed.review_status;
      delete newFixed.review_status;
      if (task.mode === "notes") {
        if (old.notes.length !== next.notes?.length) fail("note_count_changed", { entry_id: old.id });
        for (let i = 0; i < old.notes.length; i++) {
          if (textCharacters(old.notes[i].text) !== textCharacters(next.notes?.[i]?.text)) fail("note_characters_changed", { entry_id: old.id, note: i });
        }
        oldFixed.notes = old.notes.map(n => ({ ...n, text: "" }));
        newFixed.notes = (next.notes || []).map(n => ({ ...n, text: "" }));
      } else {
        if (textCharacters(old.prose) !== textCharacters(next.prose)) fail("prose_characters_changed", { entry_id: old.id });
        oldFixed.prose = newFixed.prose = "";
      }
      if (!isDeepStrictEqual(oldFixed, newFixed)) fail("formatting_changed_other_fields", { entry_id: old.id });
    }
  }
  const reports = [];
  if (suite) {
    validateCases(suite, baseline.project_id);
    for (const test of suite.cases) {
      const exercised = test.pages.every(p => pages.has(p));
      const found = candidate.entries.filter(e => matches(e, test.selector));
      if (!exercised || found.some(e => outsideIds.has(e.id))) {
        reports.push({ id: test.id, status: "not_exercised", approved: test.status === "approved" });
        continue;
      }
      const errors = [];
      const check = (ok, label) => { if (!ok) errors.push(label); };
      check(found.length > 0 || test.expect.count === 0, "missing_entry");
      for (const [key, expected] of Object.entries(test.expect)) {
        if (key === "count") check(found.length === expected, key);
        if (key === "line_count") check(found.every(e => e.lines.filter(s => textCharacters(s)).length === expected), key);
        if (key === "characters_per_line") check(found.every(e => e.lines.filter(s => textCharacters(s)).every(s => [...textCharacters(s)].length === expected)), key);
        if (key === "series_indices") check(isDeepStrictEqual(found.map(e => e.series?.index), expected), key);
        if (key === "series_total") check(found.every(e => e.series?.total === expected), key);
        if (key === "contains_lines") check(expected.every(s => found.some(e => e.lines.some(l => textCharacters(l) === textCharacters(s)))), key);
        if (key === "note_anchors") check(expected.every(n => found.some(e => e.notes.some(note =>
          note.text.includes(n.text_includes) && isDeepStrictEqual(note.position, n.position)))), key);
      }
      reports.push({ id: test.id, status: errors.length ? "failed" : "passed", approved: test.status === "approved", errors });
      for (const code of errors) fail("regression", { case_id: test.id, assertion: code });
    }
  }
  if (!reports.length) warnings.push("No independent regression cases supplied.");
  if (reports.some(c => !c.approved)) warnings.push("Proposed cases are not human-approved ground truth.");
  if (reports.some(c => c.status === "not_exercised")) warnings.push("Some regression cases were outside this task; they have not passed.");
  return { status: failures.length ? "failed" : "needs_review", mechanical_pass: !failures.length, failures, warnings, cases: reports };
}
