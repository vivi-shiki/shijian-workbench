import { safeId } from "./project-store.mjs";
import { isDeepStrictEqual } from "node:util";

export const DEFAULT_REVISION_OPTIONS = Object.freeze({
  single_revision: false,
  direct_overwrite: false,
  require_approval: true
});

export function planPageCorrection({ pageId, resultId }) {
  if (!/^page-\d+$/i.test(pageId || "")) throw new Error("A page id is required for page OCR correction");
  return { kind: "page_ocr", page_id: pageId, result_id: safeId(resultId) };
}

export function planEntryRevision(document, entryId, resultIds) {
  safeId(entryId);
  const entries = document?.entries || [];
  const entry = entries.find(item => item.id === entryId);
  if (!entry) throw new Error(`Poem not found: ${entryId}`);
  if (entry.kind !== "poem") throw new Error("Only poem entries can use this revision action");
  const sourcePages = [...new Set(entry.source_pages || [])].sort((a, b) => a - b);
  if (!sourcePages.length || sourcePages.some(page => !Number.isInteger(page) || page < 1)) {
    throw new Error("Poem needs valid source pages");
  }
  const evidencePages = [...new Set(sourcePages.flatMap(page => [page - 1, page, page + 1])
    .filter(page => page > 0))].sort((a, b) => a - b);
  const evidenceSet = new Set(evidencePages);
  return { kind: "entry_revision", entry_ids: [entryId], source_pages: sourcePages,
    evidence_pages: evidencePages,
    context_entry_ids: entries.filter(item => item.id !== entryId &&
      item.source_pages?.some(page => evidenceSet.has(page))).map(item => item.id),
    result_ids: [...new Set(resultIds || [])].map(safeId) };
}

export function assertSingleEntryCandidate(baseline, candidate, entryId) {
  const original = baseline?.entries || [];
  const revised = candidate?.entries || [];
  if (original.length !== revised.length || original.some((entry, index) =>
    entry.id !== revised[index]?.id || (entry.id !== entryId && !isDeepStrictEqual(entry, revised[index])))) {
    throw new Error("Candidate changed works outside the selected poem");
  }
  if (!original.some(entry => entry.id === entryId)) throw new Error("Selected poem is missing");
  return candidate;
}
