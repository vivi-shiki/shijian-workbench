import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson, safeId } from "./project-store.mjs";
import { hashJson } from "./change-history.mjs";
import { buildCandidateOutput, EbookCandidates } from "./ebook-candidates.mjs";
import { validateGeneratedChunk, validateGeneratedDocument } from "./ebook-generation-validation.mjs";
import {
  buildAnnotationReviewPrompt,
  buildCanonicalPage,
  buildClassificationPrompt,
  buildGroupingPrompt,
  dedupeExactCandidateNotes,
  demoteInvalidRegulatedForms,
  mergeExactCandidateEntries,
  normalizeDeterministicCitationMarks,
  materializeReferencePlan,
  normalizeClassifications
} from "./tri-pass-structuring.mjs";

const ENTRY_KINDS = new Set(["heading", "book_text", "biography", "poem", "preface", "note", "colophon", "other"]);
const LEGACY_HEADING_LEVELS = new Map([["volume", 1], ["year", 2], ["section", 3]]);
const MIN_HEADING_LEVEL = 1;
const MAX_HEADING_LEVEL = 6;
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3.2";
const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_CHUNK_SIZE = 5;
const DEFAULT_CONTEXT_OVERLAP = 1;
const TRI_PASS_PIPELINE = "tri-pass-regions-v1";
const CLASSIC_POETRY_PIPELINE = "classic-poetry-v1";
const CLASSIC_POETRY_MODEL = "deepseek-ai/DeepSeek-V4-Flash";
function now() {
  return new Date().toISOString();
}

export function warningOnlyGenerationPolicy() {
  return { validation_mode: "warnings", max_attempts: 1 };
}

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedText(value) {
  return asText(value).replace(/[\s，。！？；：、,.!?;:“”‘’「」『』《》（）()【】\[\]—…·]/gu, "");
}

export function validationDiagnosticsToIssues(diagnostics, pageStart, pageEnd) {
  return (Array.isArray(diagnostics) ? diagnostics : []).map(item => {
    const pages = uniqueNumbers(item?.source_pages, pageStart, pageEnd);
    return {
      source_pages: pages.length ? pages : Array.from(
        { length: pageEnd - pageStart + 1 }, (_, index) => pageStart + index),
      description: `[自动校验警示:${asText(item?.code) || "unknown"}] ${asText(item?.message) || "候选需要人工复核"}`,
      candidates: []
    };
  });
}

function appendValidationIssues(document, diagnostics, pageStart, pageEnd) {
  const existing = new Set((document.issues || []).map(issue =>
    `${(issue.source_pages || []).join(",")}:${asText(issue.description)}`));
  const ids = new Set((document.issues || []).map(issue => issue.id));
  const addedIds = [];
  let nextIssue = 1;
  for (const issue of validationDiagnosticsToIssues(diagnostics, pageStart, pageEnd)) {
    const key = `${issue.source_pages.join(",")}:${issue.description}`;
    if (existing.has(key)) continue;
    while (ids.has(`issue-${String(nextIssue).padStart(4, "0")}`)) nextIssue += 1;
    const id = `issue-${String(nextIssue).padStart(4, "0")}`;
    nextIssue += 1;
    ids.add(id);
    existing.add(key);
    document.issues.push({ id, ...issue, resolved: false });
    addedIds.push(id);
  }
  return addedIds;
}

function uniqueNumbers(values, min = 1, max = Number.MAX_SAFE_INTEGER) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(Number)
    .filter(value => Number.isInteger(value) && value >= min && value <= max))]
    .sort((a, b) => a - b);
}

function normalizeLines(value) {
  if (typeof value === "string") return value.split(/\r?\n/).map(asText).filter(Boolean);
  return (Array.isArray(value) ? value : []).map(asText).filter(Boolean);
}

function normalizeNotePosition(value) {
  if (!value || typeof value !== "object") return null;
  const field = ["title", "series", "lines"].includes(value.field) ? value.field : null;
  const line = Number(value.line);
  const offset = Number(value.offset);
  if (!field || !Number.isInteger(offset) || offset < 0) return null;
  if (field === "lines" && (!Number.isInteger(line) || line < 1)) return null;
  return field === "lines" ? { field, line, offset } : { field, offset };
}

function codePointEnd(source, marker) {
  const text = [...source];
  const anchor = [...marker];
  if (!anchor.length) return null;
  for (let start = 0; start <= text.length - anchor.length; start += 1) {
    if (anchor.every((character, index) => character === text[start + index])) return start + anchor.length;
  }
  return null;
}

function defaultNotePosition(entry) {
  if (asText(entry.title)) return { field: "title", offset: [...asText(entry.title)].length };
  if (asText(entry.series?.title)) return { field: "series", offset: [...asText(entry.series.title)].length };
  if (entry.lines?.length) return { field: "lines", line: 1, offset: 0 };
  return null;
}

function locateMarker(entry, marker) {
  const anchor = asText(marker);
  if (anchor && anchor !== "題注") {
    const titleOffset = codePointEnd(asText(entry.title), anchor);
    if (titleOffset != null) return { field: "title", offset: titleOffset };
    const seriesOffset = codePointEnd(asText(entry.series?.title), anchor);
    if (seriesOffset != null) return { field: "series", offset: seriesOffset };
    for (let index = 0; index < (entry.lines || []).length; index += 1) {
      const offset = codePointEnd(asText(entry.lines[index]), anchor);
      if (offset != null) return { field: "lines", line: index + 1, offset };
    }
  }
  return defaultNotePosition(entry);
}

function normalizeGeneratedNotes(value, entry) {
  return (Array.isArray(value) ? value : []).flatMap((note) => {
    if (typeof note === "string" && note.trim()) {
      const position = defaultNotePosition(entry);
      return position ? [{ position, text: note.trim() }] : [];
    }
    if (!note || typeof note !== "object" || !asText(note.text)) return [];
    const requested = normalizeNotePosition(note.position);
    const position = requested && positionFitsEntry(requested, entry) ? requested : locateMarker(entry, note.marker);
    return position ? [{ position, text: asText(note.text) }] : [];
  });
}

export function migrateLegacyNotePositions(document) {
  for (const entry of document.entries || []) {
    entry.notes = (Array.isArray(entry.notes) ? entry.notes : []).map(note => {
      if (!note || typeof note !== "object" || note.position != null) return note;
      const position = locateMarker(entry, note.marker);
      return position ? { position, text: asText(note.text) } : note;
    });
  }
  return document;
}

function positionFitsEntry(position, entry) {
  const normalized = normalizeNotePosition(position);
  if (!normalized) return false;
  if (normalized.field === "title") return normalized.offset <= [...asText(entry.title)].length;
  if (normalized.field === "series") return normalized.offset <= [...asText(entry.series?.title)].length;
  const line = entry.lines[normalized.line - 1];
  return typeof line === "string" && normalized.offset <= [...line].length;
}

function normalizeSeries(value) {
  if (!value || typeof value !== "object" || !asText(value.title)) return null;
  const index = Number(value.index);
  const total = Number(value.total);
  return {
    title: asText(value.title),
    ...(Number.isInteger(index) && index > 0 ? { index } : {}),
    ...(Number.isInteger(total) && total > 0 ? { total } : {})
  };
}

function normalizeHeadingLevel(value) {
  if (LEGACY_HEADING_LEVELS.has(value)) return LEGACY_HEADING_LEVELS.get(value);
  const level = Number(value);
  return Number.isInteger(level) && level >= MIN_HEADING_LEVEL && level <= MAX_HEADING_LEVEL ? level : null;
}

function normalizeDocumentHeadings(document) {
  for (const entry of document.entries || []) {
    if (LEGACY_HEADING_LEVELS.has(entry.heading_level)) {
      entry.heading_level = LEGACY_HEADING_LEVELS.get(entry.heading_level);
      continue;
    }
    const level = Number(entry.heading_level);
    if (entry.heading_level != null && Number.isInteger(level) && level >= MIN_HEADING_LEVEL && level <= MAX_HEADING_LEVEL) {
      entry.heading_level = level;
    }
  }
  return document;
}

function nextEntryId(entries) {
  const used = new Set(entries.map(entry => entry.id));
  for (let index = 1; ; index += 1) {
    const id = `entry-${String(index).padStart(4, "0")}`;
    if (!used.has(id)) return id;
  }
}

export function emptyEbook(project) {
  return {
    schema_version: 1,
    project_id: project.id,
    title: project.title,
    language: "zh-Hant",
    source: {
      result_ids: [],
      page_range: { start: 1, end: Math.min(30, project.results?.[0]?.page_count || 30) }
    },
    generation: {
      provider: "siliconflow",
      model: process.env.SILICONFLOW_MODEL || DEFAULT_MODEL,
      status: "not_started",
      chunk_size: DEFAULT_CHUNK_SIZE,
      completed_through: 0,
      chunks: [],
      updated_at: now()
    },
    entries: [],
    issues: []
  };
}

export function validateEbook(document, projectId) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw Object.assign(new Error("电子书 JSON 必须是对象"), { status: 400 });
  }
  if (document.schema_version !== 1 || document.project_id !== projectId) {
    throw Object.assign(new Error("schema_version 或 project_id 不匹配"), { status: 400 });
  }
  if (!Array.isArray(document.entries) || !Array.isArray(document.issues)) {
    throw Object.assign(new Error("entries 和 issues 必须是数组"), { status: 400 });
  }
  const ids = new Set();
  for (const entry of document.entries) {
    if (!entry || typeof entry !== "object" || !asText(entry.id) || ids.has(entry.id)) {
      throw Object.assign(new Error("每个条目必须有唯一的 id"), { status: 400 });
    }
    ids.add(entry.id);
    if (!ENTRY_KINDS.has(entry.kind) || !Array.isArray(entry.source_pages) ||
        !Array.isArray(entry.lines) || !Array.isArray(entry.notes)) {
      throw Object.assign(new Error(`条目 ${entry.id} 的 kind 或数组字段无效`), { status: 400 });
    }
    if (entry.series != null && !normalizeSeries(entry.series)) {
      throw Object.assign(new Error(`条目 ${entry.id} 的 series 无效`), { status: 400 });
    }
    if (entry.heading_level != null && !normalizeHeadingLevel(entry.heading_level)) {
      throw Object.assign(new Error(`条目 ${entry.id} 的 heading_level 无效`), { status: 400 });
    }
    if (entry.notes.some(note => !note || !asText(note.text) || !positionFitsEntry(note.position, entry))) {
      throw Object.assign(new Error(`条目 ${entry.id} 的注释 position 无效或越界`), { status: 400 });
    }
  }
  return document;
}

export function parseModelJson(content) {
  let source = asText(content)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start >= 0 && end > start) source = source.slice(start, end + 1);
    try {
      return JSON.parse(source);
    } catch (error) {
      throw Object.assign(new Error(`模型未返回有效 JSON：${error.message}`), { status: 502 });
    }
  }
}

export function mergeGenerated(document, payload, pageStart, pageEnd, options = {}) {
  const outputEntries = Array.isArray(payload?.entries) ? payload.entries : [];
  const openEntries = new Set(document.generation?.open_entries || []);
  const allowedContinuations = new Set([...openEntries, ...(options.allowedContinuationIds || [])]);
  for (const raw of outputEntries) {
    if (!raw || typeof raw !== "object") continue;
    const continuation = asText(raw.continuation_of);
    const sourcePages = uniqueNumbers(raw.source_pages, pageStart, pageEnd);
    const normalized = {
      id: nextEntryId(document.entries),
      kind: ENTRY_KINDS.has(raw.kind) ? raw.kind : "other",
      title: asText(raw.title),
      subtitle: asText(raw.subtitle),
      author: asText(raw.author),
      form: asText(raw.form),
      heading_level: normalizeHeadingLevel(raw.heading_level),
      series: normalizeSeries(raw.series),
      lines: normalizeLines(raw.lines),
      prose: asText(raw.prose),
      notes: [],
      source_pages: sourcePages,
      evidence_refs: [...new Set((Array.isArray(raw.evidence_refs) ? raw.evidence_refs : []).map(asText).filter(Boolean))],
      confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
      review_status: "needs_review"
    };
    normalized.notes = normalizeGeneratedNotes(raw.notes, normalized);

    let target = continuation && document.entries.find(entry => entry.id === continuation);
    if (continuation && (!target || !allowedContinuations.has(continuation))) {
      options.warningDiagnostics?.push({ code: "invalid_continuation",
        message: `无效的 continuation_of 已按新条目保留：${continuation}`,
        source_pages: sourcePages.length ? sourcePages : [pageStart] });
      target = null;
    }
    let targetId;
    if (target) {
      targetId = target.id;
      const lineOffset = target.lines.length;
      const continuationNotes = normalized.notes.map(note => note.position.field === "lines"
        ? { ...note, position: { ...note.position, line: note.position.line + lineOffset } }
        : note);
      const combinedEntry = { ...normalized, lines: [...target.lines, ...normalized.lines] };
      const absoluteContinuationNotes = (Array.isArray(raw.notes) ? raw.notes : []).flatMap(note => {
        const position = normalizeNotePosition(note?.position);
        if (!position || position.field !== "lines" || position.line <= normalized.lines.length ||
            !positionFitsEntry(position, combinedEntry) || !asText(note?.text)) return [];
        return [{ position, text: asText(note.text) }];
      });
      target.lines = [...target.lines, ...normalized.lines];
      target.prose = [target.prose, normalized.prose].filter(Boolean).join("\n");
      target.notes = [...target.notes, ...continuationNotes, ...absoluteContinuationNotes];
      target.source_pages = uniqueNumbers([...target.source_pages, ...normalized.source_pages]);
      target.evidence_refs = [...new Set([...(target.evidence_refs || []), ...normalized.evidence_refs])];
      target.confidence = Math.min(target.confidence || 1, normalized.confidence || 1);
      if (!target.title) target.title = normalized.title;
      if (!target.subtitle) target.subtitle = normalized.subtitle;
      if (!target.author) target.author = normalized.author;
      if (!target.form) target.form = normalized.form;
      if (!target.heading_level && normalized.heading_level) target.heading_level = normalized.heading_level;
      if (!target.series && normalized.series) target.series = normalized.series;
    } else if (normalized.title || normalized.lines.length || normalized.prose || normalized.notes.length) {
      document.entries.push(normalized);
      targetId = normalized.id;
    }
    if (targetId) {
      const explicitOpen = asText(raw.boundary_state) === "open";
      const finalEntry = target || normalized;
      const expectedLines = expectedRegulatedLineCount(finalEntry.form) || 0;
      const inferredOpen = normalized.source_pages.includes(pageEnd) &&
        ((!finalEntry.lines.length && Boolean(finalEntry.title)) || (expectedLines && finalEntry.lines.length < expectedLines));
      const incompleteRegulatedVerse = expectedLines > 0 && finalEntry.lines.length < expectedLines;
      const nonRegulatedOpen = expectedLines === 0 && (explicitOpen || inferredOpen);
      if (incompleteRegulatedVerse || nonRegulatedOpen) openEntries.add(targetId);
      else openEntries.delete(targetId);
    }
  }
  document.generation = { ...(document.generation || {}), open_entries: [...openEntries] };

  const issues = Array.isArray(payload?.issues) ? payload.issues : [];
  for (const raw of issues) {
    const issue = typeof raw === "string" ? { description: raw } : raw;
    if (!issue || !asText(issue.description)) continue;
    document.issues.push({
      id: `issue-${String(document.issues.length + 1).padStart(4, "0")}`,
      source_pages: uniqueNumbers(issue.source_pages, pageStart, pageEnd),
      description: asText(issue.description),
      candidates: (Array.isArray(issue.candidates) ? issue.candidates : []).map(asText).filter(Boolean),
      resolved: false
    });
  }
  return document;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function manualRevisionEntry(raw, existing, pageStart, pageEnd, allowedEvidenceRefs, usedIds, warnings) {
  const scopePages = Array.from({ length: pageEnd - pageStart + 1 }, (_, index) => pageStart + index);
  const targetPages = new Set(scopePages);
  let sourcePages = uniqueNumbers(hasOwn(raw, "source_pages") ? raw.source_pages : existing?.source_pages);
  if (existing) {
    const allowedPages = new Set([...(existing.source_pages || []), ...scopePages]);
    if (sourcePages.some(page => !allowedPages.has(page))) {
      warnings.push({ code: "revision_context_page_ignored",
        message: `条目 ${existing.id} 新增的上下文页已忽略`, source_pages: scopePages });
      sourcePages = sourcePages.filter(page => allowedPages.has(page));
    }
  } else if (sourcePages.some(page => !targetPages.has(page))) {
    warnings.push({ code: "revision_context_page_ignored",
      message: "新条目引用的目标范围外页码已忽略", source_pages: scopePages });
    sourcePages = sourcePages.filter(page => targetPages.has(page));
  }

  const id = existing?.id || nextEntryId([...usedIds].map(value => ({ id: value })));
  usedIds.add(id);
  const lines = hasOwn(raw, "lines") ? normalizeLines(raw.lines) : [...(existing?.lines || [])];
  const title = hasOwn(raw, "title") ? asText(raw.title) : asText(existing?.title);
  const series = hasOwn(raw, "series") ? normalizeSeries(raw.series) : normalizeSeries(existing?.series);
  const normalized = {
    ...(existing || {}),
    id,
    kind: ENTRY_KINDS.has(raw.kind) ? raw.kind : existing?.kind || "other",
    title,
    subtitle: hasOwn(raw, "subtitle") ? asText(raw.subtitle) : asText(existing?.subtitle),
    author: hasOwn(raw, "author") ? asText(raw.author) : asText(existing?.author),
    form: hasOwn(raw, "form") ? asText(raw.form) : asText(existing?.form),
    heading_level: hasOwn(raw, "heading_level") ? normalizeHeadingLevel(raw.heading_level) : normalizeHeadingLevel(existing?.heading_level),
    series,
    lines,
    prose: hasOwn(raw, "prose") ? asText(raw.prose) : asText(existing?.prose),
    notes: [],
    source_pages: sourcePages.length ? sourcePages : existing?.source_pages?.length ? [...existing.source_pages] : [pageStart],
    confidence: Math.max(0, Math.min(1, Number(hasOwn(raw, "confidence") ? raw.confidence : existing?.confidence) || 0)),
    review_status: "needs_review",
    boundary_state: hasOwn(raw, "boundary_state") ? asText(raw.boundary_state) || "closed" : asText(existing?.boundary_state) || "closed"
  };
  normalized.notes = hasOwn(raw, "notes")
    ? normalizeGeneratedNotes(raw.notes, normalized)
    : structuredClone(existing?.notes || []);

  const requestedRefs = [...new Set((Array.isArray(raw.evidence_refs) ? raw.evidence_refs : []).map(asText).filter(Boolean))];
  const invalidRefs = requestedRefs.filter(reference => !allowedEvidenceRefs.has(reference));
  if (invalidRefs.length) {
    warnings.push({ code: "revision_external_evidence_ignored",
      message: `目标范围之外的证据引用已忽略：${invalidRefs.slice(0, 3).join(", ")}`,
      source_pages: scopePages });
  }
  const validRefs = requestedRefs.filter(reference => allowedEvidenceRefs.has(reference));
  normalized.evidence_refs = validRefs.length
    ? validRefs
    : existing?.evidence_refs?.length ? [...existing.evidence_refs] : [...allowedEvidenceRefs];
  return normalized;
}

export function applyManualRangeRevision(document, payload, { pageStart, pageEnd, allowedEvidenceRefs = [] }) {
  const scopePages = Number.isInteger(pageStart) && Number.isInteger(pageEnd) && pageEnd >= pageStart
    ? Array.from({ length: pageEnd - pageStart + 1 }, (_, index) => pageStart + index)
    : [];
  if (!document || !Array.isArray(document.entries) || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      document: structuredClone(document), updated_entry_ids: [], created_entry_ids: [],
      deleted_entry_ids: [], added_issue_ids: [],
      warnings: [{ code: "invalid_revision_payload", message: "范围修订候选格式无效", source_pages: scopePages }]
    };
  }
  const revised = structuredClone(document);
  const warnings = [];
  const editable = new Map(revised.entries
    .filter(entry => entry.source_pages?.some(page => page >= pageStart && page <= pageEnd))
    .map(entry => [entry.id, entry]));
  const requestedDeleteIds = [...new Set((Array.isArray(payload.delete_entry_ids) ? payload.delete_entry_ids : [])
    .map(asText).filter(Boolean))];
  const deleteIds = new Set();
  for (const id of requestedDeleteIds) {
    if (editable.has(id)) deleteIds.add(id);
    else warnings.push({ code: "revision_out_of_scope_delete_ignored",
      message: `目标范围之外的删除请求已忽略：${id}`, source_pages: scopePages });
  }

  const targetRefs = new Set(allowedEvidenceRefs.map(asText).filter(Boolean));
  const usedIds = new Set(revised.entries.map(entry => entry.id));
  const updates = new Map();
  const created = [];
  for (const raw of Array.isArray(payload.entries) ? payload.entries : []) {
    if (!raw || typeof raw !== "object") continue;
    const requestedId = asText(raw.id);
    if (requestedId && !editable.has(requestedId)) {
      warnings.push({ code: "revision_out_of_scope_update_ignored",
        message: `目标范围之外的修改请求已忽略：${requestedId}`, source_pages: scopePages });
      continue;
    }
    if (requestedId && updates.has(requestedId)) {
      warnings.push({ code: "revision_duplicate_update_ignored",
        message: `同一条目的重复修改已忽略：${requestedId}`, source_pages: scopePages });
      continue;
    }
    if (requestedId && deleteIds.has(requestedId)) {
      deleteIds.delete(requestedId);
      warnings.push({ code: "revision_delete_update_conflict",
        message: `条目 ${requestedId} 同时请求修改和删除，已保留修改`, source_pages: scopePages });
    }
    const existing = requestedId ? editable.get(requestedId) : null;
    const allowedRefs = new Set([...targetRefs, ...(existing?.evidence_refs || [])]);
    const normalized = manualRevisionEntry(raw, existing,
      pageStart, pageEnd, allowedRefs, usedIds, warnings);
    if (requestedId) updates.set(requestedId, normalized);
    else created.push(normalized);
  }

  const lastEditableIndex = revised.entries.reduce((last, entry, index) => editable.has(entry.id) ? index : last, -1);
  const outputEntries = [];
  revised.entries.forEach((entry, index) => {
    if (!deleteIds.has(entry.id)) outputEntries.push(updates.get(entry.id) || entry);
    if (index === lastEditableIndex) outputEntries.push(...created);
  });
  if (lastEditableIndex < 0 && created.length) {
    const insertion = outputEntries.findIndex(entry => Math.min(...(entry.source_pages || [Number.MAX_SAFE_INTEGER])) > pageEnd);
    if (insertion < 0) outputEntries.push(...created);
    else outputEntries.splice(insertion, 0, ...created);
  }
  revised.entries = outputEntries;

  const addedIssues = [];
  const issueIds = new Set(revised.issues.map(issue => issue.id));
  let nextIssue = 1;
  for (const raw of Array.isArray(payload.issues) ? payload.issues : []) {
    if (!raw || !asText(raw.description)) continue;
    while (issueIds.has(`issue-${String(nextIssue).padStart(4, "0")}`)) nextIssue += 1;
    const issueId = `issue-${String(nextIssue).padStart(4, "0")}`;
    issueIds.add(issueId);
    nextIssue += 1;
    const issue = {
      id: issueId,
      source_pages: uniqueNumbers(raw.source_pages, pageStart, pageEnd).length
        ? uniqueNumbers(raw.source_pages, pageStart, pageEnd) : [pageStart],
      description: asText(raw.description),
      candidates: (Array.isArray(raw.candidates) ? raw.candidates : []).map(asText).filter(Boolean),
      resolved: false
    };
    revised.issues.push(issue);
    addedIssues.push(issue.id);
  }
  const warningIssueIds = appendValidationIssues(revised, warnings, pageStart, pageEnd);
  validateEbook(revised, revised.project_id);
  return {
    document: revised,
    updated_entry_ids: [...updates.keys()],
    created_entry_ids: created.map(entry => entry.id),
    deleted_entry_ids: [...deleteIds],
    added_issue_ids: [...addedIssues, ...warningIssueIds],
    warnings
  };
}

export function applyManualPageRevision(document, payload, { pageNumber, allowedEvidenceRefs = [] }) {
  return applyManualRangeRevision(document, payload, {
    pageStart: pageNumber,
    pageEnd: pageNumber,
    allowedEvidenceRefs
  });
}

function regionText(region) {
  return asText(region?.edited_text ?? region?.raw_text ?? "");
}

function expectedRegulatedLineCount(form) {
  const value = asText(form).replace(/绝/gu, "絕");
  if (/^[五七]言?絕(?:句|詩)?$/u.test(value)) return 4;
  if (/^[五七]言?律(?:詩)?$/u.test(value)) return 8;
  return null;
}

function pageEvidence(page, resultId) {
  return {
    page_number: page.page_number,
    volume: page.volume || null,
    source_page: page.source_page || page.page_number,
    regions: [...(page.regions || [])]
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .flatMap(region => {
        const text = regionText(region);
        const regionId = asText(region.id) || `order-${region.order || 0}`;
        return text ? [{ evidence_id: `p${page.page_number}:${resultId}:${regionId}`,
          order: region.order, kind: region.kind || "other", text }] : [];
      })
  };
}

export function buildEbookRules() {
  return [
    "1. 不翻译、不改写、不补写原书没有的句子；保留繁体字、异体字、人名和原注。",
    "2. 删除扫描机构、数位化、典藏等后加水印，不把版心、页码、书口和刻印信息混入正文。",
    "3. 恢复竖排从右到左、每栏从上到下的阅读顺序。大字正文旁的双行小字通常是逐句注文，不得混入诗句。",
    "4. 卷名、年次（如乙卯年、丙辰年）和其他目录标题不能遗漏。所有目录标题都使用 kind=heading，并用数字 heading_level=1..6 表示抽象层级（1 最高）；通常卷名为 1、卷内年次为 2，但应按原书实际目录关系判断，不把年份写进某首诗的 title/subtitle。作品组题使用 series，不属于目录层级。扉页题字、卷端撰注者、出版题记等使用 book_text。作者传使用 biography 和 prose。",
    "5. 诗歌放入 lines，lines 的每个数组元素必须是一个完整诗句并带现代标点，不得把两句、四句或整首粘成一个元素。绝句、律诗的奇数句末通常用逗号，偶数句末通常用句号；前台会把相邻两句合为一个排版段落，所以 JSON 中仍须一项一句。古体诗依句意断句，一般也以相邻两句为一个语意段。词、曲必须按词牌或曲牌句式断句，并用一个空字符串作为上下阕分隔。散文放入 prose；夹注放入 notes。小字中的引诗、典故和自注，即使恰好是五言或七言，也不得为凑足绝句或律诗句数而放入 lines；紧接“某人诗也”“自注”“详案”等说明的引文应保留在 notes。若去除注文后大字正文只有四句，就按四句保存，不得用注文补成八句。每条注必须用 position 记录圈号插入位置，不得用所注的几个字或整句作为 marker：诗句位置为 {field:'lines',line:从1开始的行号,offset:该行第几个Unicode字符后}，独立题下注为 {field:'title',offset:标题第几个Unicode字符后}，组题下注为 {field:'series',offset:组题第几个Unicode字符后}。必须先从注文内容和原版位置找出被注的具体词语，再把 offset 设在该词语之后；不得为省事统一挂在诗句末尾，也不得把同句中所注词语不同的两条注文合并。notes[].text 必须按完整句意添加现代中文标点，正确断开书名、人名、篇名、引诗和按语，不得只在末尾机械加句号，也不得改变任何原文字词。注文中的书名、篇名一律使用全角书名号《》，不得一部分加书名号、一部分保留裸写；书名下的篇章合写为《书名·篇名》，作者加作品名写为“作者《作品名》”，书名与篇名分别出现时分别加书名号。例：《诗·魏风·葛屦》：掺掺女手。《吴越春秋》：越王愁心苦志。庾信《愁赋》：攻许愁城终不破。《晋书·阮籍传》：车驾所穷，辄痛哭而返。《韩非子》有《孤愤》篇。《楚辞》有《卜居》篇。《宋史·王陶传》：微时苦贫。《魏志·管辂传》：倚树哀吟。《虞翻别传》：死以青蝇为吊客。只有作品名不明、仅作泛称的“陆游诗：……”或“李贺诗：……”不加书名号；单独的“书曰”“诗云”等引述语也不是书名。输出前逐条扫描 notes[].text，确认每个可识别的书名和篇名都已成对使用《》。书名号只属于现代标点，不得借此改动原文字词。序题附近出现的署名只有版面明确表明作者关系时才写入 author，不能从文末落款臆造标题作者。",
    "6. 组诗必须拆成一首一个 poem 条目，并用相同 series.title、递增 series.index 和可确认的 series.total 关联。组诗总题只能写在 series.title；除非原书另有子题，各首 title 留空，禁止把总题或首句复制为每首题名。若版面上“感怀杂咏”一类总题只出现一次，后面连续多首诗都应写为 title=''、series.title='感怀杂咏'，不得让每首 poem 的 title 都重复“感怀杂咏”。只有版面确实再次印出同一题名时，才能新建同名 title。前台依据 series.index 显示“其一、其二”等中文序次，JSON 只记录数字。近体诗按每句字数、句数、偶数句押韵及版面题名共同判体：七绝为四个七言句，七律为八个七言句，五绝为四个五言句，五律为八个五言句。没有独立题名的连续作品不得用首句冒充题名，应结合上方总题建立 series。古体诗、乐府、词、曲、联句等须按原书题名、体式、分阕和版面边界处理，不得强行套用绝句或律诗句数。每首的 notes 必须紧随该首保存，不得汇总到组末。",
    "7. 序跋、传记等 prose 必须按文意添加现代中文标点，并按论旨转换、叙事阶段、评议、作序缘起和落款划分自然段，以两个换行符分段；不要按固定字数机械断句或分段。只能增加标点和空白，不得改变字词。无法确认的字或边界不要擅断，在 issues 中记录候选；不要使用 Markdown。",
    "8. 辨认题名必须结合字号、栏位、题名后的注文和下一题名位置，不得把正文首句当题名，也不得因换页把同一首诗拆开。较长题名按现代句意添加逗号、句号、冒号或引号；嵌在题名旁的小字注文仍进入 notes，不得混进 title。版面以连续方框、空格或明显缺刻表示缺字时，按每个缺字保留一个“□”，不得猜补。相邻题名之间若同时出现前作续文和后作正文，应按题名所在栏位及五七言句数分别归属；证据不足时保留原边界并写入 issues。",
  ];
}

export function buildClassicPoetryPrompt(pageBundles, previousEntries, options = {}) {
  const manualPrompt = asText(options.manual_prompt);
  const revisionEntries = Array.isArray(options.current_entries) ? options.current_entries : null;
  const revisionContext = Array.isArray(options.context_entries) ? options.context_entries : [];
  const expected = revisionEntries ? {
    entries: [{
      id: "已有条目必须填写原 id；新条目留空",
      kind: "heading|book_text|biography|poem|preface|note|colophon|other",
      title: "",
      subtitle: "",
      author: "",
      form: "",
      heading_level: "目录层级 1-6；1 最高，非目录标题时为 null",
      series: { title: "组诗总题；非组诗时为 null", index: 1, total: 6 },
      lines: ["诗词逐句；非诗词为空数组"],
      prose: "序跋等散文；诗词为空字符串",
      notes: [{ position: { field: "lines", line: 1, offset: 7 }, text: "注文正文" }],
      source_pages: [1],
      evidence_refs: ["目标页证据 ID"],
      confidence: 0.9,
      boundary_state: "closed|open"
    }],
    delete_entry_ids: ["只列出确实应删除的当前页条目 id"],
    issues: [{ source_pages: [1], description: "无法可靠判定之处", candidates: ["候选一", "候选二"] }]
  } : {
    entries: [{
      continuation_of: "若续接上一批条目，填写上一批 entry id，否则为空字符串",
      boundary_state: "closed|open；目标页末作品未完时必须为 open",
      kind: "heading|book_text|biography|poem|preface|note|colophon|other",
      title: "",
      subtitle: "",
      author: "",
      form: "",
      heading_level: "目录层级 1-6；1 最高，非目录标题时为 null",
      series: { title: "组诗总题；非组诗时为 null", index: 1, total: 6 },
      lines: ["诗词逐行；非诗词为空数组"],
      prose: "序跋等散文；诗词为空字符串",
      notes: [{ position: { field: "lines", line: 1, offset: 7 }, text: "注文正文" }],
      source_pages: [1],
      confidence: 0.9
    }],
    issues: [{ source_pages: [1], description: "无法可靠判定之处", candidates: ["候选一", "候选二"] }]
  };
  const targetPages = pageBundles.filter(bundle => !bundle.context_only).map(bundle => bundle.page_number);
  const rangeRevision = revisionEntries && targetPages.length > 1;
  const revisionModeRule = rangeRevision
    ? "连续多页人工修订模式：只返回需要修改或新建的条目；未改变的已有条目不要重复输出。已有条目沿用原 id，新条目 id 留空。确需删除时才把 id 放入 delete_entry_ids。范围外 JSON 和 context_only OCR 只用于判断边界，不得修改范围外独有条目。跨页条目可保留它原有的 source_pages，但不得给条目新增只在上下文页出现的正文。"
    : "单页人工修订模式：只返回需要修改或新建的条目；未改变的已有条目不要重复输出。已有条目沿用原 id，新条目 id 留空。确需删除时才把 id 放入 delete_entry_ids。前后页 JSON 和 context_only OCR 只用于判断边界，不得修改前后页独有条目。跨页条目可保留它原有的 source_pages，但不得给条目新增只在上下文页出现的正文。";

  return [
    "你正在整理一部中国诗词类古籍的 OCR 校对稿，目标是生成忠实、可校订的现代电子排版数据。",
    "同一页可能提供两套 OCR。它们不是两篇文本：请逐项比对，以人工校正后的文字为最高优先级，并利用另一套结果补足明显漏字或版面类别。",
    "严格要求：",
    "1. 不翻译、不改写、不补写原书没有的句子；保留繁体字、异体字、人名和原注。",
    "2. 删除扫描机构、数位化、典藏等后加水印，不把版心、页码、书口和刻印信息混入正文。",
    "3. 恢复竖排从右到左、每栏从上到下的阅读顺序。大字正文旁的双行小字通常是逐句注文，不得混入诗句。",
    "4. 卷名、年次和其他目录标题不能遗漏。目录标题使用 kind=heading 和数字 heading_level；作品组题使用 series，不属于目录层级。扉页题字、撰注者题署和出版题记使用 book_text；作者传使用 biography 和 prose。",
    "5. 诗词放入 lines，每一个数组元素只能保存一个完整诗句，并以现代中文逗号、句号等标点结束；严禁把相邻两句粘进同一元素。五言、七言近体诗必须据字数拆成逐句数据；绝句、律诗、排律和古诗的最终阅读版必须把相邻两句组成一个排版段落，但这只是显示规则，JSON 仍须一句一项，不能为了视觉上的两句一行而合并字段。长篇排律也必须一句一项、两句成联。散文放入 prose；夹注放入 notes。每条注必须用 position 记录圈号插入位置，不得用所注文字作为 marker。序题附近的署名只有版面明确表明作者关系时才写入 author。",
    "6. 输出前逐条检查 lines：不得出现完全相同的重复诗句或重复正文片段。发现重复时必须回查两套 OCR、字号和注文归属，不能只机械删除，也不能把注文引诗当正文重复录入。",
    "7. 题名必须有独立版面证据，应结合字号、栏位、题名位置和下一题边界判断。不得把作品第一句复制到 title；没有明确题名时 title 留空。诗前若有叙事、交游缘起或作诗说明等散文式长题序，应按版面放入 title、subtitle 或相应散文字段并添加句读；后续五言、七言等字数正文才进入 lines。不得把长题序切碎、并入或改写成诗句来凑格律。题名旁的小字说明属于 notes，不得并入 title。",
    "8. 组诗必须拆成一首一个 poem 条目，并用相同 series.title、递增 series.index 和可确认的 series.total 关联。按每句字数、句数、偶数句押韵及版面题名共同判体；每首的 notes 必须紧随该首保存，不得汇总到组末。",
    "9. 绝句、律诗必须检查完整句数与每句字数。四句五言或七言的完整作品应判为绝句，八句五言或七言的完整作品才可判为律诗；超过相应固定句数的长篇作品不得继续标作绝句或律诗，应依据版面和体式判断为古诗、歌行、排律等，证据不足时 form 留空并写入 issues。不得为了符合已猜测的体裁而补造、复制或挪用诗句。目标页结束但作品尚未完成时写 boundary_state=open，并利用只读后页确认边界；开放状态只表示作品尚未录完，不能用来绕过已经超出固定句数的错误体裁。下一批只补尚缺诗句。不得因换页提前关闭作品，不得用注文凑足句数，也不得重复上一批已经保存的诗句。",
    "10. 可补现代标点，但不得改变字词。无法确认的字或边界不要擅断，在 issues 中记录候选；不要使用 Markdown。",
    `11. 只输出目标页 ${JSON.stringify(targetPages)} 的 JSON。context_only=true 的前后页只用于判断跨页续接和作品边界，禁止把这些页独有的题名、正文、注文写入输出。若目标页开头明显承接上一批条目，用 continuation_of 指向给出的 entry id。`,
    revisionEntries ? revisionModeRule : "",
    revisionEntries ? `${rangeRevision ? "目标范围" : "当前页"}正式 JSON（允许修订）：${JSON.stringify(revisionEntries)}` : "",
    revisionEntries ? `${rangeRevision ? "范围外相邻页" : "前后页"}正式 JSON（只读上下文）：${JSON.stringify(revisionContext)}` : "",
    `输出形状：${JSON.stringify(expected)}`,
    `上一批末尾条目：${JSON.stringify(previousEntries)}`,
    `本批双 OCR 证据（含只读前后页）：${JSON.stringify(pageBundles)}`,
    manualPrompt ? `人工输入提示词（最高优先级）：\n校订者针对${rangeRevision ? "本次连续页范围" : "本页"}给出了以下明确要求。在不突破目标页范围、来源证据和 JSON 输出格式的前提下，它在题名、作品边界、分句、体裁、注文归属和文字取舍等判断中优先于上方的一般启发式规则。不得把这段要求原样写入正文或 issues。\n` + manualPrompt : ""
  ].join("\n");
}

export function buildClassicRetryPrompt(diagnostics) {
  const safeDiagnostics = (Array.isArray(diagnostics) ? diagnostics : []).map(item => ({
    code: asText(item?.code) || "invalid_candidate",
    entry_index: Number.isInteger(item?.entry_index) ? item.entry_index : null,
    expected: Number.isInteger(item?.expected) ? item.expected : null,
    actual: Number.isInteger(item?.actual) ? item.actual : null,
    invalid_lines: Array.isArray(item?.invalid_lines) ? item.invalid_lines.map(line => ({
      index: Number.isInteger(line?.index) ? line.index : null,
      scope: line?.scope === "previous" ? "previous" : "candidate",
      width: Number.isInteger(line?.width) ? line.width : null
    })) : [],
    lines: Array.isArray(item?.lines) ? item.lines.filter(Number.isInteger) : [],
    source_pages: Array.isArray(item?.source_pages) ? item.source_pages.filter(Number.isInteger) : []
  }));
  return [
    "上一候选存在程序可以确定的问题。请按原规则重新生成同一目标批次的完整 JSON，不得输出解释。",
    "只根据双 OCR 和版面证据修正，不得为满足句数或字数而补造、复制、挪用正文。",
    "若完整作品实际只有四句，应按绝句判断；只有八句且每句字数相符时才能判为律诗。超过固定句数时即使 boundary_state=open 也不得沿用绝句或律诗体裁。证据不足时 form 留空并在 issues 记录，不要用错误体裁强行闭合。",
    "title_matches_first_line 表示首句被误当题名：没有独立题名证据时 title 必须留空。duplicate_line 表示正文重复：回查 OCR 后只保留有证据的唯一位置。continuation_overlap 表示续接时再次输出了开放条目中已有的诗句：只输出目标页新增部分。regulated_verse_line_width 表示诗句尚未逐句拆开、混入注文，或把散文式长题序误放进了 lines；真正的诗句按一个完整诗句一个 lines 元素重新分开，题序按版面移入 title、subtitle 或相应散文字段，严禁把题序切碎凑字数。missing_line_punctuation 表示逐句后仍缺现代标点。",
    `机器诊断：${JSON.stringify(safeDiagnostics)}`
  ].join("\n");
}

function attachPageEvidenceRefs(payload, pageBundles) {
  const refsByPage = new Map(pageBundles.filter(bundle => !bundle.context_only).map(bundle => [
    bundle.page_number,
    (bundle.results || []).flatMap(result => result.regions || [])
      .map(region => region.evidence_id).filter(Boolean)
  ]));
  for (const entry of Array.isArray(payload?.entries) ? payload.entries : []) {
    if (Array.isArray(entry.evidence_refs) && entry.evidence_refs.length) continue;
    entry.evidence_refs = [...new Set((Array.isArray(entry.source_pages) ? entry.source_pages : [])
      .flatMap(page => refsByPage.get(Number(page)) || []))];
  }
  return payload;
}

function compactEvidenceText(bundles) {
  return bundles.flatMap(bundle => bundle.results || [])
    .flatMap(result => result.regions || [])
    .map(region => asText(region.text).replace(/[\s，。！？；：、,.!?;:“”‘’「」『』《》（）()【】\[\]—…·]/gu, ""))
    .filter(Boolean)
    .join("");
}

function supportScore(value, evidence) {
  const text = asText(value).replace(/[\s，。！？；：、,.!?;:“”‘’「」『』《》（）()【】\[\]—…·]/gu, "");
  if (!text || !evidence) return 0;
  if (evidence.includes(text)) return 1;
  const characters = [...text];
  if (characters.length < 3) return evidence.includes(text) ? 1 : 0;
  let matches = 0;
  for (let index = 0; index <= characters.length - 3; index += 1) {
    if (evidence.includes(characters.slice(index, index + 3).join(""))) matches += 1;
  }
  return matches / (characters.length - 2);
}

export function trimClassicContextOutput(payload, pageBundles, pageStart, pageEnd, document = null) {
  const targetEvidence = compactEvidenceText(pageBundles.filter(bundle => !bundle.context_only));
  const contextEvidence = compactEvidenceText(pageBundles.filter(bundle => bundle.context_only));
  const repairs = [];
  const contextOnly = value => {
    const target = supportScore(value, targetEvidence);
    const context = supportScore(value, contextEvidence);
    return context >= 0.72 && target < 0.35 && context - target >= 0.35;
  };

  payload.entries = (Array.isArray(payload?.entries) ? payload.entries : []).flatMap((entry, entryIndex) => {
    if (!entry || typeof entry !== "object") return [entry];
    const pages = (Array.isArray(entry.source_pages) ? entry.source_pages : []).map(Number);
    const targetPages = pages.filter(page => Number.isInteger(page) && page >= pageStart && page <= pageEnd);
    const originalLines = typeof entry.lines === "string" ? entry.lines.split(/\r?\n/) : entry.lines;
    const lines = (Array.isArray(originalLines) ? originalLines : []).filter(line => !contextOnly(line));
    const notes = (Array.isArray(entry.notes) ? entry.notes : []).filter(note => !contextOnly(note?.text));
    const bodyValues = [entry.title, ...(Array.isArray(originalLines) ? originalLines : []), entry.prose,
      ...(Array.isArray(entry.notes) ? entry.notes.map(note => note?.text) : [])].filter(Boolean);
    const hasTargetSupport = bodyValues.some(value => supportScore(value, targetEvidence) >= 0.35);

    if (!hasTargetSupport) {
      repairs.push({ code: "context_only_entry_removed", entry_index: entryIndex, source_pages: pages });
      return [];
    }
    const title = contextOnly(entry.title) ? "" : entry.title;
    const inferredTargetPages = pageBundles
      .filter(bundle => !bundle.context_only)
      .filter(bundle => bodyValues.some(value => supportScore(value, compactEvidenceText([bundle])) >= 0.35))
      .map(bundle => Number(bundle.page_number))
      .filter(Number.isInteger);
    const outputPages = targetPages.length ? targetPages : inferredTargetPages;
    const removedContent = lines.length !== (Array.isArray(originalLines) ? originalLines.length : 0) ||
      notes.length !== (Array.isArray(entry.notes) ? entry.notes.length : 0) ||
      outputPages.join(",") !== pages.join(",") ||
      title !== entry.title;
    if (removedContent) {
      repairs.push({ code: "context_only_content_removed", entry_index: entryIndex, source_pages: pages });
    }
    return [{
      ...entry,
      title,
      source_pages: outputPages,
      lines,
      notes,
      ...(removedContent ? { boundary_state: "open" } : {})
    }];
  });
  payload.entries.forEach((entry, entryIndex) => {
    const lines = Array.isArray(entry?.lines) ? entry.lines : [];
    if (normalizedText(entry?.title) && normalizedText(entry.title) === normalizedText(lines[0])) {
      entry.title = "";
      repairs.push({ code: "first_line_title_removed", entry_index: entryIndex,
        source_pages: entry.source_pages || [] });
    }

    const continuation = asText(entry?.continuation_of);
    const target = continuation && document?.entries?.find(item => item.id === continuation);
    if (!target) return;
    const previousLines = new Set((target.lines || []).map(normalizedText).filter(Boolean));
    const retainedLines = lines.filter(line => !previousLines.has(normalizedText(line)));
    if (retainedLines.length === lines.length) return;
    entry.lines = retainedLines;
    if (!retainedLines.length && !asText(target.form)) entry.form = "";
    const hasFollowingEntry = payload.entries.slice(entryIndex + 1)
      .some(item => !asText(item?.continuation_of));
    if (!retainedLines.length && hasFollowingEntry) entry.boundary_state = "closed";
    repairs.push({ code: "continuation_overlap_removed", entry_index: entryIndex,
      removed_lines: lines.length - retainedLines.length, source_pages: entry.source_pages || [] });
  });
  if (repairs.length) payload.classic_repairs = repairs;
  return payload;
}

function validateClassicChunk(document, payload, options) {
  try {
    return validateGeneratedChunk(document, payload, options);
  } catch (error) {
    if (!Array.isArray(error.diagnostics)) throw error;
    return { ok: true, mode: "warnings", entries: payload.entries?.length || 0,
      warnings: error.diagnostics };
  }
}

export function buildEbookPrompt(documentTitle, pageBundles, previousEntries, learningContext = "", options = {}) {
  const manualPrompt = asText(options.manual_prompt);
  const currentEntries = Array.isArray(options.current_entries) ? options.current_entries : [];
  const expected = {
    entries: [{
      action: "create|continue",
      continuation_of: "若续接 open_entries 中的条目，填写其 entry id；新条目为空字符串",
      boundary_state: "closed|open；目标页末作品未完时必须为 open",
      kind: "heading|book_text|biography|poem|preface|note|colophon|other",
      title: "",
      subtitle: "",
      author: "",
      form: "",
      heading_level: "目录层级 1-6；1 最高，非目录标题时为 null",
      series: { title: "组诗总题；非组诗时为 null", index: 1, total: 6 },
      lines: ["诗歌正文逐行；非诗歌为空数组"],
      prose: "序跋、传记等散文，按文意添加现代标点，并用两个换行符分隔自然段；诗歌为空字符串",
      notes: [{ position: { field: "lines|title|series", line: 1, offset: 7 }, text: "注文正文" }],
      source_pages: [1],
      evidence_refs: ["只能引用 target_pages 中给出的 evidence_id"],
      confidence: 0.9
    }],
    issues: [{ source_pages: [1], description: "无法可靠判定之处", candidates: ["候选一", "候选二"] }]
  };

  const targetPages = pageBundles.filter(bundle => !bundle.context_only);
  const contextBefore = pageBundles.filter(bundle => bundle.context_only &&
    bundle.page_number < (targetPages[0]?.page_number ?? Number.MAX_SAFE_INTEGER));
  const contextAfter = pageBundles.filter(bundle => bundle.context_only &&
    bundle.page_number > (targetPages.at(-1)?.page_number ?? 0));
  const contextSummary = bundles => bundles.map(bundle => ({
    page_number: bundle.page_number,
    context_only: true,
    results: (bundle.results || []).map(result => ({
      result_id: result.result_id,
      region_count: (result.regions || []).length
    }))
  }));
  const allowedPages = targetPages.map(bundle => bundle.page_number);
  const allowedEvidence = targetPages.flatMap(bundle => bundle.results || [])
    .flatMap(result => result.regions || []).map(region => region.evidence_id).filter(Boolean);

  return [
    "你正在整理一部以诗歌为主要内容的中国古籍 OCR 校对稿，目标是生成忠实、可校订的现代电子排版数据。此类文献可能是诗集、词集、曲集、诗文合集或带笺注、评点的选本。",
    `当前项目书名：${JSON.stringify(asText(documentTitle) || "书名待定")}。只把它作为识别上下文，不得凭书名补写正文。`,
    "同一页可能提供两套 OCR。它们不是两篇文本：请逐项比对，以人工校正后的文字为最高优先级，并利用另一套结果补足明显漏字或版面类别。",
    "严格要求：",
    ...buildEbookRules(),
    `9. 本次唯一允许输出的目标页是 ${JSON.stringify(allowedPages)}。context_before 和 context_after 只能判断边界，任何来自这些页的题名、正文、注文都不得输出。程序会逐条检查 source_pages 和 evidence_refs，越界候选会被拒绝。`,
    "10. 每个条目必须列出目标页 OCR 区域的 evidence_refs；不得虚构 ID。source_pages 必须由这些目标证据所在页组成，不能为空。",
    "11. 只有 open_entries 中列出的条目可以 action=continue。目标页末作品未完时，只输出目标页实际出现的部分并设 boundary_state=open；下一批再续接。不要为了凑足绝句或律诗而读取 context_after。",
    "12. 禁止重复已经存在于 open_entries 中的正文。续接时只输出本目标页新增的句子；同一候选内不得重复整首、连续两句或注文。",
    "边界示例：若目标页47只有《某诗》题名、上下文页48才出现正文，则本批只输出题名，source_pages=[47]，boundary_state=open；处理第48页时 action=continue 并只输出第48页正文。若上下文页49出现《下一诗》，处理第48页时完全不得输出它。",
    learningContext ? `以下是本项目由修改历史自动提炼的经验。它只用于提示可能的惯例和易错点；当前原图、人工校正文和本批 OCR 证据优先，不得机械套用：\n${learningContext}` : "",
    `输出形状：${JSON.stringify(expected)}`,
    `open_entries（唯一允许续接的条目）：${JSON.stringify(previousEntries)}`,
    `allowed_evidence_ids：${JSON.stringify(allowedEvidence)}`,
    `target_pages：${JSON.stringify(targetPages)}`,
    `context_before（正文已隔离，只用于说明页序）：${JSON.stringify(contextSummary(contextBefore))}`,
    `context_after（正文已隔离，只用于说明页序）：${JSON.stringify(contextSummary(contextAfter))}`,
    currentEntries.length ? `上一工作流步骤在本批页范围内生成的候选 JSON：${JSON.stringify(currentEntries)}\n请以它作为本轮复核起点，保留其中已有证据支持且不属于本轮问题的结构与文字；仍须根据双 OCR 独立核对，不得把候选本身当作原文证据。输出完整的本批条目，不要只输出差异。` : "",
    manualPrompt ? "人工选择的后续校订步骤（最高优先级）：\n在不突破目标页范围、来源证据和 JSON 输出格式的前提下，重点执行以下复核要求。不得把这段要求原样写入正文或 issues。\n" + manualPrompt : ""
  ].join("\n");
}

async function siliconFlowRequest({ apiKey, baseUrl, model, messages, maxTokens }) {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const common = {
    model,
    messages,
    temperature: 0.1,
    max_tokens: maxTokens
  };
  const variants = [
    { ...common, enable_thinking: false, response_format: { type: "json_object" } },
    common
  ];
  let lastError;

  for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(variants[variantIndex]),
          signal: AbortSignal.timeout(180_000)
        });
        const body = await response.json().catch(() => ({}));
        if (response.ok) {
          const content = body.choices?.[0]?.message?.content;
          if (!content) throw Object.assign(new Error("硅基流动响应中没有 message.content"), { status: 502 });
          return { content, usage: body.usage || null };
        }
        const message = body.message || body.error?.message || `SiliconFlow HTTP ${response.status}`;
        const error = Object.assign(new Error(message), { status: response.status });
        if (response.status === 400 && variantIndex === 0) { lastError = error; break; }
        if (![429, 503, 504].includes(response.status) || attempt === 3) throw error;
        lastError = error;
        await delay(1_000 * 2 ** attempt);
      } catch (error) {
        lastError = error;
        if (error.status === 400 && variantIndex === 0) break;
        if (error.status && ![429, 503, 504].includes(error.status)) throw error;
        if (attempt === 3) throw error;
        await delay(1_000 * 2 ** attempt);
      }
    }
  }
  throw lastError || Object.assign(new Error("硅基流动请求失败"), { status: 502 });
}

function canonicalValidationBundles(canonicalPages) {
  return canonicalPages.map(page => ({
    page_number: page.page_number,
    context_only: page.context_only,
    results: [{
      result_id: "canonical",
      regions: page.regions.flatMap(region => region.sources.map(source => ({
        evidence_id: source.source_id,
        text: source.text
      })))
    }]
  }));
}

async function bestCandidateCheckpoint(history, projectId, criteria) {
  if (!history?.historyDirectory) return null;
  const directory = path.join(history.historyDirectory(projectId), "runs");
  const candidates = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    try {
      const run = await history.readRun(projectId, entry.name);
      if (criteria.workflowStepId !== undefined &&
          asText(run.manifest.options?.workflow_step_id) !== criteria.workflowStepId) continue;
      if (criteria.baseCandidateRunId !== undefined &&
          asText(run.manifest.options?.base_candidate_run_id) !== criteria.baseCandidateRunId) continue;
      const documents = run.steps.filter(step => step.kind === "structure-candidate-checkpoint" && step.candidate_document)
        .map(step => step.candidate_document);
      if (run.output && run.manifest.status === "failed") documents.push(run.output);
      for (const output of documents) {
        // A checkpoint is a complete document through completed_through; later chunks may safely use a smaller size.
        if (output.generation?.pipeline !== criteria.pipeline) continue;
        if (output.source?.page_range?.start !== criteria.start || output.source?.page_range?.end !== criteria.end) continue;
        if ((output.source?.result_ids || []).join(",") !== criteria.resultIds.join(",")) continue;
        const completedThrough = Number(output.generation?.completed_through) || criteria.start - 1;
        if (completedThrough < criteria.start) continue;
        if (Number.isInteger(criteria.resumeThrough) && completedThrough > criteria.resumeThrough) continue;
        candidates.push({ run_id: run.manifest.id, completed_through: completedThrough, document: output });
      }
    } catch {
      // Ignore incomplete or integrity-invalid runs; they are not safe resume points.
    }
  }
  return candidates.sort((left, right) => right.completed_through - left.completed_through)[0] || null;
}

async function runTriPassChunk({
  apiKey, baseUrl, model, maxTokens, projectId, documentTitle, document, canonicalPages,
  previousEntries, openEntryIds, pageStart, pageEnd, history, runRecord
}) {
  const usage = [];
  const requestStage = async (stage, system, prompt, normalize = value => value) => {
    const messages = [{ role: "system", content: system }, { role: "user", content: prompt }];
    const response = await siliconFlowRequest({ apiKey, baseUrl, model, maxTokens, messages });
    usage.push(response.usage);
    let parsed;
    let error;
    try { parsed = normalize(parseModelJson(response.content)); }
    catch (caught) { error = caught; }
    if (runRecord) {
      await history.recordRunStep(projectId, runRecord.id, {
        kind: `structure-${stage}`, start_page: pageStart, end_page: pageEnd,
        request: { model, messages },
        response: { content: response.content, parsed, usage: response.usage },
        validation: error ? { ok: false, diagnostics: error.diagnostics || [{ code: "invalid_json", message: error.message }] }
          : { ok: true }
      });
    }
    return { parsed, error, response };
  };

  const classification = await requestStage(
    "classification",
    "你是古籍版面分类器。只返回 JSON 对象，不抄写或改写 OCR 原文。",
    buildClassificationPrompt(documentTitle, canonicalPages, previousEntries),
    parsed => normalizeClassifications(parsed, canonicalPages)
  );
  const classifications = classification.parsed || normalizeClassifications({}, canonicalPages);

  const grouping = await requestStage(
    "grouping",
    "你是古籍作品边界分组器。只返回引用 OCR region 的 JSON 对象，不抄写原文。",
    buildGroupingPrompt(documentTitle, canonicalPages, classifications, previousEntries, buildEbookRules())
  );
  const draftPlan = grouping.parsed || { entries: [], issues: [] };
  const draftDiagnostics = [];
  if (grouping.error) draftDiagnostics.push(...(grouping.error.diagnostics || [{ code: "invalid_grouping_json", message: grouping.error.message }]));
  else {
    try {
      const draft = materializeReferencePlan(draftPlan, canonicalPages);
      validateGeneratedChunk(document, draft, {
        pageStart, pageEnd, pageBundles: canonicalValidationBundles(canonicalPages), openEntryIds
      });
    } catch (error) {
      draftDiagnostics.push(...(error.diagnostics || [{ code: "invalid_grouping_plan", message: error.message }]));
    }
  }
  if (runRecord) {
    await history.recordRunStep(projectId, runRecord.id, {
      kind: "structure-grouping-materialization", start_page: pageStart, end_page: pageEnd,
      validation: { ok: draftDiagnostics.length === 0, diagnostics: draftDiagnostics }
    });
  }

  const review = await requestStage(
    "annotation-review",
    "你是古籍注文挂接和结构终审器。只返回引用 OCR region 的完整 JSON 对象，不抄写原文。",
    buildAnnotationReviewPrompt(documentTitle, canonicalPages, classifications, draftPlan,
      draftDiagnostics, previousEntries, buildEbookRules())
  );
  const warnings = [
    ...(classification.error?.diagnostics || (classification.error
      ? [{ code: "invalid_classification_json", message: classification.error.message }]
      : [])),
    ...draftDiagnostics
  ];
  if (review.error) warnings.push(...(review.error.diagnostics || [{ code: "invalid_review_json", message: review.error.message }]));
  let accepted;
  for (const plan of [review.parsed, draftPlan]) {
    if (!plan || accepted) continue;
    try { accepted = materializeReferencePlan(plan, canonicalPages); }
    catch (error) {
      warnings.push(...(error.diagnostics || [{ code: "invalid_reference_plan", message: error.message }]));
    }
  }
  accepted ||= { entries: [], issues: [] };
  const entryMerge = mergeExactCandidateEntries(accepted);
  accepted = entryMerge.candidate;
  const noteDedupe = dedupeExactCandidateNotes(accepted);
  accepted = noteDedupe.candidate;
  const citationMarks = normalizeDeterministicCitationMarks(accepted);
  accepted = citationMarks.candidate;
  const validationOptions = { pageStart, pageEnd,
    pageBundles: canonicalValidationBundles(canonicalPages), openEntryIds };
  let validation;
  try { validation = validateGeneratedChunk(document, accepted, validationOptions); }
  catch (error) {
    const diagnostics = error.diagnostics || [{ code: "invalid_tri_pass_candidate", message: error.message }];
    const demoted = demoteInvalidRegulatedForms(accepted, error.diagnostics || []);
    if (demoted.changed) accepted = demoted.candidate;
    warnings.push(...diagnostics);
    validation = { ok: true, mode: "warnings", bypassed: true, entries: accepted.entries?.length || 0,
      warnings, repairs: [...entryMerge.repairs, ...noteDedupe.repairs, ...citationMarks.repairs, ...demoted.repairs] };
  }
  validation = { ...validation, mode: "warnings",
    warnings: [...warnings, ...(validation.warnings || [])],
    repairs: validation.repairs || [...entryMerge.repairs, ...noteDedupe.repairs, ...citationMarks.repairs] };
  if (runRecord) {
    await history.recordRunStep(projectId, runRecord.id, {
      kind: "structure-annotation-materialization", start_page: pageStart, end_page: pageEnd,
      response: { parsed: accepted }, validation
    });
  }
  return { accepted, validation, usage, stages: ["classification", "grouping", "annotation-review"] };
}

export class EbookStore {
  constructor(projectsRoot, projectStore, history = null) {
    this.projectsRoot = projectsRoot;
    this.projectStore = projectStore;
    this.history = history;
    this.candidates = history ? new EbookCandidates(history) : null;
    this.running = new Set();
    this.writes = new Map();
  }

  directory(projectId) {
    return path.join(this.projectsRoot, safeId(projectId), "ebook");
  }

  filename(projectId) {
    return path.join(this.directory(projectId), "structured.json");
  }

  config() {
    return {
      provider: "siliconflow",
      configured: Boolean(process.env.SILICONFLOW_API_KEY),
      base_url: process.env.SILICONFLOW_BASE_URL || DEFAULT_BASE_URL,
      model: process.env.SILICONFLOW_MODEL || DEFAULT_MODEL,
      chunk_size: DEFAULT_CHUNK_SIZE,
      context_overlap: DEFAULT_CONTEXT_OVERLAP,
      ...warningOnlyGenerationPolicy()
    };
  }

  async read(projectId) {
    const project = await this.projectStore.index(safeId(projectId));
    const document = await fs.readFile(this.filename(projectId), "utf8")
      .then(JSON.parse)
      .catch(error => {
        if (error.code === "ENOENT") return emptyEbook(project);
        throw error;
      });
    return { document: migrateLegacyNotePositions(normalizeDocumentHeadings(document)), config: this.config() };
  }

  async save(projectId, document, audit = {}) {
    const id = safeId(projectId);
    const previous = this.writes.get(id) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.saveUnlocked(id, document, audit));
    this.writes.set(id, pending);
    try { return await pending; }
    finally { if (this.writes.get(id) === pending) this.writes.delete(id); }
  }

  async saveUnlocked(id, document, audit) {
    if (this.running.has(id)) throw Object.assign(new Error("Generation is running; cannot save concurrently"), { status: 409 });
    await this.projectStore.index(id);
    const before = await fs.readFile(this.filename(id), "utf8").then(JSON.parse).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (audit.expected_hash !== undefined && hashJson(before) !== audit.expected_hash) {
      throw Object.assign(new Error("Baseline changed; review current edits before applying the candidate"), { status: 409 });
    }
    // Approved candidates must not be silently normalized after their hash was reviewed.
    if (audit.expected_hash === undefined) migrateLegacyNotePositions(normalizeDocumentHeadings(document));
    validateEbook(document, id);
    document.generation = { ...document.generation, updated_at: now() };
    await atomicJson(this.filename(id), document);
    await this.history?.recordChange({ projectId: id, target: { kind: "ebook" }, before, after: document,
      actor: audit.actor || "human", source: audit.source || "ebook-json-editor", operation: "edit_ebook",
      note: audit.note || "", metadata: audit.metadata || {}, runId: audit.run_id });
    return { document, config: this.config() };
  }

  async revisePage(projectId, options = {}) {
    const id = safeId(projectId);
    if (this.running.has(id) || this.writes.has(id)) {
      throw Object.assign(new Error("该项目正在生成或保存，请稍后再试"), { status: 409 });
    }
    const config = this.config();
    if (!config.configured) {
      throw Object.assign(new Error("未配置 SILICONFLOW_API_KEY，请在 .env.local 中设置后重启 API"), { status: 400 });
    }
    const requestedPage = Number(options.page_number);
    const pageStart = Number(options.start_page ?? requestedPage);
    const pageEnd = Number(options.end_page ?? requestedPage);
    const rangePages = Number.isInteger(pageStart) && Number.isInteger(pageEnd) && pageEnd >= pageStart
      ? Array.from({ length: pageEnd - pageStart + 1 }, (_, index) => pageStart + index)
      : [];
    const singlePage = pageStart === pageEnd;
    const manualPrompt = asText(options.manual_prompt);
    if (!Number.isInteger(pageStart) || !Number.isInteger(pageEnd) || pageStart < 1 || pageEnd < pageStart) {
      throw Object.assign(new Error("start_page 和 end_page 必须是有效的连续页码范围"), { status: 400 });
    }
    if (rangePages.length > 5) {
      throw Object.assign(new Error("连续多页修订单次最多支持 5 页，请缩小范围"), { status: 400 });
    }
    if (!manualPrompt) throw Object.assign(new Error("请输入范围修订提示词"), { status: 400 });
    if (manualPrompt.length > 6000) throw Object.assign(new Error("范围修订提示词不能超过 6000 字"), { status: 400 });

    this.running.add(id);
    let runRecord;
    try {
      const project = await this.projectStore.index(id);
      const formalDocument = (await this.read(id)).document;
      const projectPages = project.source?.pages || [];
      const projectPageNumbers = new Set(projectPages.map(page => Number(page.page_number)));
      const missingProjectPage = rangePages.find(page => projectPages.length && !projectPageNumbers.has(page));
      if (missingProjectPage) {
        throw Object.assign(new Error(`P${missingProjectPage} 不在当前项目范围内`), { status: 400 });
      }
      const resultIds = (formalDocument.source?.result_ids || [])
        .filter(resultId => project.results.some(result => result.id === resultId))
        .slice(0, 2);
      if (!resultIds.length) {
        resultIds.push(...project.results.filter(result => !result.archived).slice(0, 2).map(result => result.id));
      }
      if (!resultIds.length) throw Object.assign(new Error("当前项目没有可用 OCR 结果"), { status: 400 });

      const loaded = await Promise.all(resultIds.map(resultId => this.projectStore.view(id, resultId)));
      const resultMaps = loaded.map(result => new Map(result.pages.map(page => [Number(page.page_number), page])));
      const missingOcrPage = rangePages.find(page => !resultMaps.some(result => result.has(page)));
      if (missingOcrPage) {
        throw Object.assign(new Error(`P${missingOcrPage} 没有 OCR 数据`), { status: 404 });
      }
      const bundles = [];
      for (let contextPage = pageStart - 1; contextPage <= pageEnd + 1; contextPage += 1) {
        if (contextPage < 1 || !resultMaps.some(result => result.has(contextPage))) continue;
        bundles.push({
          page_number: contextPage,
          context_only: contextPage < pageStart || contextPage > pageEnd,
          results: resultIds.map((resultId, index) => ({
            result_id: resultId,
            ...pageEvidence(resultMaps[index].get(contextPage) || { page_number: contextPage, regions: [] }, resultId)
          }))
        });
      }
      const currentEntries = formalDocument.entries.filter(entry =>
        entry.source_pages?.some(page => page >= pageStart && page <= pageEnd));
      const currentIds = new Set(currentEntries.map(entry => entry.id));
      const contextEntries = formalDocument.entries.filter(entry => !currentIds.has(entry.id) &&
        entry.source_pages?.some(page => page === pageStart - 1 || page === pageEnd + 1));
      const prompt = buildClassicPoetryPrompt(bundles, [], {
        current_entries: currentEntries,
        context_entries: contextEntries,
        manual_prompt: manualPrompt
      });
      const model = config.model;
      const messages = [
        { role: "system", content: `你是中国诗词类古籍的${singlePage ? "单页" : "连续多页"}校订专家。只返回符合要求的 JSON 对象。人工输入提示词是本次校订的最高优先级领域指令，但不得突破来源证据、目标范围和 JSON 格式。` },
        { role: "user", content: prompt }
      ];
      runRecord = await this.history?.startRun(id, {
        actor: "ai:siliconflow",
        source: "manual-page-revision",
        provider: "siliconflow",
        model,
        note: `人工提示驱动的 ${singlePage ? `P${pageStart} 单页` : `P${pageStart}-${pageEnd} 连续多页`}模型修订`,
        options: {
          page_number: singlePage ? pageStart : null,
          page_range: { start: pageStart, end: pageEnd },
          context_pages: bundles.filter(bundle => bundle.context_only).map(bundle => bundle.page_number),
          result_ids: resultIds,
          attempts: 1,
          manual_prompt_priority: "highest"
        },
        input: {
          document_hash: hashJson(formalDocument),
          current_entries: currentEntries,
          context_entries: contextEntries,
          manual_prompt: manualPrompt,
          messages
        }
      });

      const response = await siliconFlowRequest({
        apiKey: process.env.SILICONFLOW_API_KEY,
        baseUrl: config.base_url,
        model,
        maxTokens: Math.max(1024, Number(process.env.SILICONFLOW_MAX_TOKENS) || 8192),
        messages
      });
      let parsed;
      let diagnostics = [];
      try { parsed = parseModelJson(response.content); }
      catch (error) {
        parsed = { entries: [], delete_entry_ids: [], issues: [] };
        diagnostics.push({ code: "invalid_revision_json", message: error.message, source_pages: rangePages });
      }
      const targetEvidenceRefs = bundles.filter(bundle => !bundle.context_only)
        .flatMap(bundle => bundle.results || [])
        .flatMap(result => result.regions || [])
        .map(region => region.evidence_id).filter(Boolean);
      const applied = applyManualRangeRevision(formalDocument, parsed, {
        pageStart,
        pageEnd,
        allowedEvidenceRefs: targetEvidenceRefs
      });
      const document = applied.document;
      diagnostics.push(...(applied.warnings || []));
      try {
        validateGeneratedDocument(document, {
          pageStart: Number(document.source?.page_range?.start) || pageStart,
          pageEnd: Number(document.source?.page_range?.end) || pageEnd
        });
      } catch (error) {
        diagnostics.push(...(error.diagnostics || [{ code: "invalid_revision_candidate", message: error.message,
          source_pages: rangePages }]));
      }
      const validationIssueIds = appendValidationIssues(document, diagnostics, pageStart, pageEnd);
      applied.added_issue_ids.push(...validationIssueIds);
      const completedAt = now();
      document.generation = {
        ...(document.generation || {}),
        updated_at: completedAt,
        last_manual_revision: {
          ...(singlePage ? { page_number: pageStart } : {}),
          page_range: { start: pageStart, end: pageEnd },
          provider: "siliconflow",
          model,
          run_id: runRecord?.id || null,
          manual_prompt_priority: "highest",
          diagnostics_count: diagnostics.length,
          completed_at: completedAt
        }
      };
      validateEbook(document, id);

      if (runRecord) {
        await this.history.recordRunStep(id, runRecord.id, {
          kind: "manual-page-revision",
          page_number: singlePage ? pageStart : null,
          page_range: { start: pageStart, end: pageEnd },
          request: { model, messages },
          response: { content: response.content, parsed, usage: response.usage },
          applied: {
            updated_entry_ids: applied.updated_entry_ids,
            created_entry_ids: applied.created_entry_ids,
            deleted_entry_ids: applied.deleted_entry_ids,
            added_issue_ids: applied.added_issue_ids
          },
          validation: { ok: true, mode: "warnings", diagnostics }
        });
      }
      const candidateOutput = buildCandidateOutput({
        kind: "manual-page-revision-candidate",
        baseline: formalDocument,
        candidate: document,
        candidate_payload: parsed,
        ...(singlePage ? { page_number: pageStart } : {}),
        page_range: { start: pageStart, end: pageEnd },
        manual_prompt: manualPrompt,
        model,
        result_ids: resultIds,
        updated_entry_ids: applied.updated_entry_ids,
        created_entry_ids: applied.created_entry_ids,
        deleted_entry_ids: applied.deleted_entry_ids,
        added_issue_ids: applied.added_issue_ids,
        diagnostics,
        warnings: diagnostics
      });
      if (runRecord) {
        await this.history.finishRun(id, runRecord.id, {
          status: "awaiting_approval",
          output: candidateOutput
        });
      }
      return {
        config,
        revision: {
          page_number: singlePage ? pageStart : null,
          page_range: { start: pageStart, end: pageEnd },
          model,
          run_id: runRecord?.id || null,
          candidate_hash: candidateOutput.candidate_hash,
          candidate: parsed,
          preview_entries: document.entries.filter(entry =>
            entry.source_pages?.some(page => page >= pageStart && page <= pageEnd)),
          updated_entry_ids: applied.updated_entry_ids,
          created_entry_ids: applied.created_entry_ids,
          deleted_entry_ids: applied.deleted_entry_ids,
          added_issue_ids: applied.added_issue_ids,
          diagnostics
        }
      };
    } catch (error) {
      if (runRecord) {
        await this.history?.finishRun(id, runRecord.id, {
          status: "failed",
          error: error.message
        }).catch(() => {});
      }
      throw error;
    } finally {
      this.running.delete(id);
    }
  }

  async applyPageRevision(projectId, runId, approval = {}) {
    if (!this.candidates) throw Object.assign(new Error("当前项目没有历史记录服务"), { status: 500 });
    return this.candidates.approve(projectId, runId, approval, this, {
      actor: approval.actor || "human",
      channel: approval.channel || "web",
      requested_by: approval.requested_by || "human"
    });
  }

  async run(projectId, options = {}) {
    const id = safeId(projectId);
    if (this.running.has(id) || this.writes.has(id)) throw Object.assign(new Error("该项目正在生成或保存，请稍后再试"), { status: 409 });
    const config = this.config();
    if (!config.configured) {
      throw Object.assign(new Error("未配置 SILICONFLOW_API_KEY，请在 .env.local 中设置后重启 API"), { status: 400 });
    }
    this.running.add(id);

    let document;
    let runRecord;
    try {
      const project = await this.projectStore.index(id);
      const resultIds = (Array.isArray(options.result_ids) ? options.result_ids : [])
        .filter(resultId => project.results.some(result => result.id === resultId))
        .slice(0, 2);
      if (!resultIds.length) throw Object.assign(new Error("至少选择一套 OCR 结果"), { status: 400 });

      const loaded = await Promise.all(resultIds.map(resultId => this.projectStore.view(id, resultId)));
      const pageCount = Math.min(...loaded.map(result => result.pages.length));
      const start = Math.max(1, Math.min(pageCount, Number(options.start_page) || 1));
      const end = Math.max(start, Math.min(pageCount, Number(options.end_page) || Math.min(30, pageCount)));
      const pipeline = asText(options.pipeline) || "single-pass-v1";
      if (!["single-pass-v1", CLASSIC_POETRY_PIPELINE, TRI_PASS_PIPELINE].includes(pipeline)) {
        throw Object.assign(new Error(`不支持的生成流程：${pipeline}`), { status: 400 });
      }
      const model = asText(options.model) || (pipeline === CLASSIC_POETRY_PIPELINE ? CLASSIC_POETRY_MODEL : config.model);
      const manualPrompt = asText(options.manual_prompt);
      const workflowStepId = asText(options.workflow_step_id);
      const baseCandidateRunId = asText(options.base_candidate_run_id);
      if (manualPrompt.length > 6000) {
        throw Object.assign(new Error("后续校订提示词不能超过 6000 字"), { status: 400 });
      }
      if (manualPrompt && pipeline === TRI_PASS_PIPELINE) {
        throw Object.assign(new Error("tri-pass-regions-v1 暂不支持后续校订预设"), { status: 400 });
      }
      if (baseCandidateRunId && pipeline !== "single-pass-v1") {
        throw Object.assign(new Error("候选链后续校订目前只支持 single-pass-v1"), { status: 400 });
      }
      const policy = warningOnlyGenerationPolicy();
      const validationMode = policy.validation_mode;
      const maxAttempts = policy.max_attempts;
      if (pipeline === TRI_PASS_PIPELINE && resultIds.length < 2) {
        throw Object.assign(new Error("tri-pass-regions-v1 必须选择两套 OCR 结果"), { status: 400 });
      }
      const force = Boolean(options.force);
      const chunkSize = Number(options.chunk_size ?? DEFAULT_CHUNK_SIZE);
      if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 20) {
        throw Object.assign(new Error("chunk_size 必须是 1-20 的整数"), { status: 400 });
      }
      const formalDocument = (await this.read(id)).document;
      const baseCandidate = baseCandidateRunId
        ? await this.candidates?.get(id, baseCandidateRunId, { includeDocument: true })
        : null;
      if (baseCandidate && baseCandidate.state !== "awaiting_approval") {
        throw Object.assign(new Error(`上一步候选状态为 ${baseCandidate.state}，不能继续校订`), { status: 409 });
      }
      if (baseCandidate && baseCandidate.baseline_hash !== hashJson(formalDocument)) {
        throw Object.assign(new Error("正式结果已变化，不能从旧候选继续校订"), { status: 409 });
      }
      if (baseCandidate && !force) {
        throw Object.assign(new Error("候选链后续校订必须启用覆盖范围重跑"), { status: 400 });
      }
      const checkpoint = options.resume_candidate !== false
        ? await bestCandidateCheckpoint(this.history, id, { pipeline, chunkSize, start, end, resultIds,
          workflowStepId: workflowStepId || "", baseCandidateRunId: baseCandidateRunId || "",
          resumeThrough: Number.isInteger(Number(options.resume_through)) ? Number(options.resume_through) : null })
        : null;
      document = checkpoint ? structuredClone(checkpoint.document)
        : baseCandidate ? structuredClone(baseCandidate.candidate_document) : formalDocument;
      const inheritedEntries = baseCandidate
        ? structuredClone(document.entries.filter(entry => entry.source_pages.some(page => page >= start && page <= end)))
        : [];
      if (checkpoint) {
        document.generation.open_entries = (document.generation.open_entries || []).filter(entryId => {
          const entry = document.entries.find(item => item.id === entryId);
          const expected = expectedRegulatedLineCount(entry?.form);
          return expected === null || (entry?.lines?.length || 0) < expected;
        });
      }
      const learningContext = pipeline === CLASSIC_POETRY_PIPELINE || options.include_learning_context === false
        ? ""
        : await this.history?.aiContext(id) || "";
      const documentBeforeRun = structuredClone(formalDocument);

      if (force && !checkpoint) {
        document.entries = document.entries.filter(entry => !entry.source_pages.some(page => page >= start && page <= end));
        document.issues = document.issues.filter(issue => !issue.source_pages.some(page => page >= start && page <= end));
      } else if (document.generation?.status === "complete" &&
                 document.source?.page_range?.start === start && document.source?.page_range?.end === end &&
                 resultIds.join(",") === (document.source?.result_ids || []).join(",")) {
        return { document, config };
      }

      const resumeAt = checkpoint ? checkpoint.completed_through + 1 : !force && ["failed", "running"].includes(document.generation?.status) &&
        document.source?.page_range?.start === start && document.source?.page_range?.end === end &&
        resultIds.join(",") === (document.source?.result_ids || []).join(",")
          ? Math.max(start, (document.generation.completed_through || start - 1) + 1)
          : start;

      runRecord = await this.history?.startRun(id, {
        actor: "ai:siliconflow", source: "deepseek-structure", provider: "siliconflow", model,
        note: manualPrompt ? `后续校订步骤${workflowStepId ? `：${workflowStepId}` : ""}` : force ? "覆盖指定页范围重新结构化" : "分批结构化",
        options: { result_ids: resultIds, start_page: start, end_page: end, force,
          include_learning_context: options.include_learning_context !== false,
          chunk_size: chunkSize, context_overlap: DEFAULT_CONTEXT_OVERLAP,
          adaptive_single_page_fallback: pipeline !== CLASSIC_POETRY_PIPELINE, pipeline,
          validation_mode: validationMode, max_attempts: maxAttempts,
          workflow_step_id: workflowStepId || null, manual_prompt: manualPrompt || null,
          base_candidate_run_id: baseCandidateRunId || null },
        input: { document: documentBeforeRun, learning_context: learningContext,
          manual_prompt: manualPrompt || null,
          base_candidate: baseCandidate ? {
            run_id: baseCandidateRunId,
            candidate_hash: baseCandidate.candidate_hash,
            baseline_hash: baseCandidate.baseline_hash
          } : null,
          candidate_checkpoint: checkpoint ? { run_id: checkpoint.run_id, completed_through: checkpoint.completed_through } : null }
      });

      document.source = { result_ids: resultIds, page_range: { start, end } };
      document.generation = {
        provider: "siliconflow",
        model,
        pipeline,
        status: "running",
        chunk_size: chunkSize,
        context_overlap: DEFAULT_CONTEXT_OVERLAP,
        adaptive_single_page_fallback: pipeline !== CLASSIC_POETRY_PIPELINE,
        validation_mode: validationMode,
        max_attempts: maxAttempts,
        completed_through: resumeAt - 1,
        chunks: resumeAt === start ? [] : (document.generation.chunks || []),
        open_entries: resumeAt === start ? [] : (document.generation.open_entries || []),
        resumed_from_run: checkpoint?.run_id || null,
        base_candidate_run_id: baseCandidateRunId || null,
        started_at: now(),
        updated_at: now(),
        error: ""
      };

      const resultMaps = loaded.map(result => new Map(result.pages.map(page => [page.page_number, page])));
      const processChunk = async (pageStart, pageEnd, adaptiveDepth = 0) => {
        const contextStart = Math.max(1, pageStart - DEFAULT_CONTEXT_OVERLAP);
        const contextEnd = Math.min(pageCount, pageEnd + DEFAULT_CONTEXT_OVERLAP);
        const bundles = [];
        for (let pageNumber = contextStart; pageNumber <= contextEnd; pageNumber += 1) {
          bundles.push({
            page_number: pageNumber,
            context_only: pageNumber < pageStart || pageNumber > pageEnd,
            results: resultIds.map((resultId, index) => ({
              result_id: resultId,
              ...pageEvidence(resultMaps[index].get(pageNumber) || { page_number: pageNumber, regions: [] }, resultId)
            }))
          });
        }
        const openEntryIds = (document.generation.open_entries || []).filter(entryId => {
          const entry = document.entries.find(item => item.id === entryId);
          return Math.max(...(entry?.source_pages || [0])) >= pageStart - 1;
        });
        const previousEntries = openEntryIds.flatMap(entryId => {
          const entry = document.entries.find(item => item.id === entryId);
          const expectedLineCount = expectedRegulatedLineCount(entry?.form);
          return entry ? [{
          id: entry.id, kind: entry.kind, title: entry.title, form: entry.form,
          series: entry.series, lines: entry.lines.slice(-4), line_count: entry.lines.length,
          expected_line_count: expectedLineCount,
          remaining_line_count: expectedLineCount === null ? null : Math.max(0, expectedLineCount - entry.lines.length),
          prose_tail: entry.prose.slice(-180), source_pages: entry.source_pages,
          boundary_state: "open"
          }] : [];
        });
        let accepted;
        let acceptedResponse;
        let acceptedValidation;
        let lastError;
        if (pipeline === TRI_PASS_PIPELINE) {
          const canonicalPages = [];
          for (let pageNumber = contextStart; pageNumber <= contextEnd; pageNumber += 1) {
            canonicalPages.push(buildCanonicalPage(pageNumber,
              resultIds.map((resultId, index) => ({ resultId, page: resultMaps[index].get(pageNumber) })),
              pageNumber < pageStart || pageNumber > pageEnd));
          }
          try {
            const triPass = await runTriPassChunk({
              apiKey: process.env.SILICONFLOW_API_KEY,
              baseUrl: config.base_url,
              model,
              maxTokens: Math.max(16384, Number(process.env.SILICONFLOW_MAX_TOKENS) || 0),
              projectId: id,
              documentTitle: project.source?.book_title || project.title,
              document,
              canonicalPages,
              previousEntries,
              openEntryIds,
              pageStart,
              pageEnd,
              history: this.history,
              runRecord
            });
            accepted = triPass.accepted;
            acceptedValidation = triPass.validation;
            acceptedResponse = { usage: triPass.usage, stages: triPass.stages };
          } catch (error) {
            lastError = error;
            if (!lastError.diagnostics) lastError.diagnostics = [{ code: "invalid_tri_pass_candidate", message: error.message }];
          }
        } else {
          const classic = pipeline === CLASSIC_POETRY_PIPELINE;
          const baseMessages = [
            { role: "system", content: classic
              ? "你是中国诗词类古籍整理专家，只返回符合要求的 JSON 对象。"
              : "你是中国诗歌类古籍整理专家，只返回符合要求的 JSON 对象。" },
            { role: "user", content: classic
              ? buildClassicPoetryPrompt(bundles, previousEntries, { manual_prompt: manualPrompt })
              : buildEbookPrompt(project.source?.book_title || project.title, bundles, previousEntries, learningContext,
                { manual_prompt: manualPrompt, current_entries: inheritedEntries.filter(entry =>
                  entry.source_pages.some(page => page >= pageStart && page <= pageEnd)) }) }
          ];
          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const messages = baseMessages;
          const response = await siliconFlowRequest({
            apiKey: process.env.SILICONFLOW_API_KEY,
            baseUrl: config.base_url,
            model,
            maxTokens: Math.max(1024, Number(process.env.SILICONFLOW_MAX_TOKENS) || 8192),
            messages
          });
          let parsed;
          let validation;
          try {
            parsed = parseModelJson(response.content);
          } catch (error) {
            if (!error.diagnostics) error.diagnostics = [{ code: "invalid_candidate", message: error.message }];
            validation = { ok: false, mode: "parse", warnings: error.diagnostics, entries: 0 };
            if (runRecord) {
              await this.history.recordRunStep(id, runRecord.id, {
                kind: "structure-chunk", start_page: pageStart, end_page: pageEnd, attempt,
                request: { model, messages }, response: { content: response.content, parsed: null, usage: response.usage },
                validation
              });
            }
            throw error;
          }
          try {
            if (classic) {
              trimClassicContextOutput(parsed, bundles, pageStart, pageEnd, document);
              attachPageEvidenceRefs(parsed, bundles);
            }
            validation = (classic ? validateClassicChunk : validateGeneratedChunk)(document, parsed, {
              pageStart, pageEnd, pageBundles: bundles, openEntryIds
            });
          } catch (error) {
            if (!error.diagnostics) error.diagnostics = [{ code: "invalid_candidate", message: error.message }];
            validation = { ok: true, mode: "warnings", bypassed: true, warnings: error.diagnostics,
              entries: Array.isArray(parsed.entries) ? parsed.entries.length : 0 };
          }
          if (runRecord) {
            await this.history.recordRunStep(id, runRecord.id, {
              kind: "structure-chunk", start_page: pageStart, end_page: pageEnd, attempt,
              request: { model, messages }, response: { content: response.content, parsed, usage: response.usage },
              validation
            });
          }
          accepted = parsed;
          acceptedResponse = response;
          acceptedValidation = validation;
          break;
        }
        }
        if (!accepted) {
          if (pipeline === TRI_PASS_PIPELINE || pipeline === CLASSIC_POETRY_PIPELINE) throw lastError;
          if (pageStart >= pageEnd) throw lastError;
          const failedPages = [...new Set((lastError?.diagnostics || [])
            .flatMap(item => item.source_pages || [])
            .map(Number)
            .filter(page => Number.isInteger(page) && page >= pageStart && page <= pageEnd))].sort((a, b) => a - b);
          const splitPages = failedPages.length && failedPages.length < pageEnd - pageStart + 1
            ? failedPages
            : Array.from({ length: pageEnd - pageStart + 1 }, (_, index) => pageStart + index);
          if (runRecord) {
            await this.history.recordRunStep(id, runRecord.id, {
              kind: "structure-chunk-split", start_page: pageStart, end_page: pageEnd,
              adaptive_depth: adaptiveDepth, split_pages: splitPages,
              validation: { ok: false, diagnostics: lastError?.diagnostics || [] }
            });
          }
          let cursor = pageStart;
          for (const splitPage of splitPages) {
            if (cursor < splitPage) await processChunk(cursor, splitPage - 1, adaptiveDepth + 1);
            await processChunk(splitPage, splitPage, adaptiveDepth + 1);
            cursor = splitPage + 1;
          }
          if (cursor <= pageEnd) await processChunk(cursor, pageEnd, adaptiveDepth + 1);
          return;
        }
        const chunkWarnings = [...(acceptedValidation?.warnings || [])];
        mergeGenerated(document, accepted, pageStart, pageEnd,
          { allowedContinuationIds: openEntryIds, warningDiagnostics: chunkWarnings });
        acceptedValidation = { ...acceptedValidation, ok: true, mode: "warnings", warnings: chunkWarnings };
        appendValidationIssues(document, chunkWarnings, pageStart, pageEnd);
        document.generation.completed_through = pageEnd;
        document.generation.updated_at = now();
        document.generation.chunks.push({
          start_page: pageStart,
          end_page: pageEnd,
          context_start_page: contextStart,
          context_end_page: contextEnd,
          adaptive_depth: adaptiveDepth,
          status: "complete",
          entries_returned: Array.isArray(accepted.entries) ? accepted.entries.length : 0,
          validation: acceptedValidation,
          usage: acceptedResponse.usage,
          completed_at: now()
        });
        if (runRecord) {
          await this.history.recordRunStep(id, runRecord.id, {
            kind: "structure-candidate-checkpoint",
            start_page: pageStart,
            end_page: pageEnd,
            completed_through: pageEnd,
            candidate_document: structuredClone(document)
          });
        }
      };
      for (let pageStart = resumeAt; pageStart <= end; pageStart += chunkSize) {
        const pageEnd = Math.min(end, pageStart + chunkSize - 1);
        await processChunk(pageStart, pageEnd);
      }

      let finalValidation;
      try {
        finalValidation = validateGeneratedDocument(document, { pageStart: start, pageEnd: end });
      } catch (error) {
        finalValidation = { ok: true, mode: "warnings", bypassed: true, entries: document.entries.length,
          warnings: error.diagnostics || [{ code: "invalid_document_candidate", message: error.message }] };
      }
      finalValidation = { ...finalValidation, ok: true, mode: "warnings",
        warnings: finalValidation.warnings || [] };
      appendValidationIssues(document, finalValidation.warnings, start, end);
      validateEbook(document, id);
      document.generation.status = "complete";
      document.generation.validation = finalValidation;
      document.generation.updated_at = now();
      const candidateOutput = buildCandidateOutput({
        kind: "ebook-generation-candidate",
        baseline: documentBeforeRun,
        candidate: document,
        warnings: finalValidation.warnings,
        page_range: { start, end },
        result_ids: resultIds,
        model,
        pipeline,
        workflow_step_id: workflowStepId || null,
        base_candidate_run_id: baseCandidateRunId || null,
        validation: finalValidation
      });
      if (runRecord) await this.history.finishRun(id, runRecord.id, {
        status: "awaiting_approval",
        output: candidateOutput
      });
      return {
        document: formalDocument,
        config,
        candidate: {
          run_id: runRecord?.id || null,
          kind: candidateOutput.kind,
          state: "awaiting_approval",
          candidate_hash: candidateOutput.candidate_hash,
          baseline_hash: candidateOutput.baseline_hash,
          candidate_document: document,
          diff: candidateOutput.diff,
          warnings: candidateOutput.warnings,
          summary: { page_range: candidateOutput.page_range, entries: document.entries.length,
            changes: candidateOutput.diff.length }
        }
      };
    } catch (error) {
      if (document) {
        document.generation = { ...document.generation, status: "failed", error: error.message, updated_at: now() };
      }
      if (runRecord) await this.history?.finishRun(id, runRecord.id, { status: "failed", error: error.message, output: document }).catch(() => {});
      throw error;
    } finally {
      this.running.delete(id);
    }
  }
}
