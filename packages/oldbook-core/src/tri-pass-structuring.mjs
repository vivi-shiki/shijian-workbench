import { projectFormatting, textSignature } from "./text-formatting.mjs";

const INSERTION_CHARACTERS = new Set([..."，。！？；：、,.!?;:“”‘’「」『』《》（）()【】[]—…·\n"]);
const REGION_ROLES = new Set([
  "header", "footer", "page_number", "volume_title", "section_heading", "work_title",
  "main_text", "annotation", "book_text", "colophon", "watermark", "uncertain"
]);

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function box(value) {
  const [x = 0, y = 0, width = 1, height = 1] = Array.isArray(value) ? value.map(Number) : [];
  return { x: finite(x), y: finite(y), width: Math.max(1, finite(width, 1)), height: Math.max(1, finite(height, 1)) };
}

function intersection(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

function overlap(anchor, candidate) {
  const area = intersection(anchor, candidate);
  const anchorArea = anchor.width * anchor.height;
  const candidateArea = candidate.width * candidate.height;
  const union = anchorArea + candidateArea - area;
  return {
    anchor_coverage: anchorArea ? area / anchorArea : 0,
    candidate_coverage: candidateArea ? area / candidateArea : 0,
    iou: union ? area / union : 0
  };
}

function round(value, digits = 3) {
  return Number(finite(value).toFixed(digits));
}

function sourceRegion(pageNumber, resultId, region, match = "anchor", metrics = {}) {
  const id = asText(region?.id) || `order-${region?.order || 0}`;
  return {
    source_id: `p${pageNumber}:${resultId}:${id}`,
    result_id: resultId,
    region_id: id,
    text: asText(region?.edited_text ?? region?.raw_text),
    confidence: round(region?.confidence),
    bbox: Array.isArray(region?.bbox) ? region.bbox.map(Number) : [],
    match,
    ...(metrics.anchor_coverage != null ? {
      anchor_coverage: round(metrics.anchor_coverage),
      candidate_coverage: round(metrics.candidate_coverage),
      iou: round(metrics.iou)
    } : {})
  };
}

function closest(items, current, direction) {
  const candidates = items.filter(item => direction === "right" ? item.cx > current.cx : item.cx < current.cx);
  candidates.sort((left, right) => Math.abs(left.cx - current.cx) - Math.abs(right.cx - current.cx));
  return candidates[0] || null;
}

function verticalOverlap(left, right) {
  const overlapHeight = Math.max(0,
    Math.min(left.box.y + left.box.height, right.box.y + right.box.height) - Math.max(left.box.y, right.box.y));
  return overlapHeight / Math.max(1, Math.min(left.box.height, right.box.height));
}

export function buildCanonicalPage(pageNumber, resultPages, contextOnly = false) {
  const pages = resultPages.filter(item => item?.page);
  const width = Math.max(1, ...pages.map(item => finite(item.page.width, 1)));
  const height = Math.max(1, ...pages.map(item => finite(item.page.height, 1)));
  const fine = [...pages].sort((left, right) =>
    (right.page.regions?.length || 0) - (left.page.regions?.length || 0))[0];
  if (!fine) return { page_number: pageNumber, context_only: contextOnly, width, height, regions: [] };

  const anchors = (fine.page.regions || []).flatMap((region, index) => {
    const text = asText(region?.edited_text ?? region?.raw_text);
    if (!text) return [];
    const geometry = box(region.bbox);
    return [{
      canonical_id: `p${pageNumber}:r${String(index + 1).padStart(3, "0")}`,
      page_number: pageNumber,
      box: geometry,
      cx: geometry.x + geometry.width / 2,
      cy: geometry.y + geometry.height / 2,
      anchor: sourceRegion(pageNumber, fine.resultId, region)
    }];
  });
  const medianWidth = Math.max(1, median(anchors.map(item => item.box.width)));
  const ranked = [...anchors].sort((left, right) => right.cx - left.cx || left.box.y - right.box.y);

  const regions = anchors.map(anchor => {
    const sources = [anchor.anchor];
    for (const item of pages) {
      if (item === fine) continue;
      for (const region of item.page.regions || []) {
        const text = asText(region?.edited_text ?? region?.raw_text);
        if (!text) continue;
        const metrics = overlap(anchor.box, box(region.bbox));
        if (metrics.anchor_coverage < 0.45 && metrics.iou < 0.12) continue;
        const match = metrics.iou >= 0.55 ? "aligned" : metrics.anchor_coverage >= 0.8 ? "contained_by" : "overlaps";
        sources.push(sourceRegion(pageNumber, item.resultId, region, match, metrics));
      }
    }
    sources.sort((left, right) => {
      if (left.match === "anchor") return -1;
      if (right.match === "anchor") return 1;
      return (right.iou || 0) - (left.iou || 0);
    });
    const right = closest(anchors, anchor, "right");
    const left = closest(anchors, anchor, "left");
    return {
      region_id: anchor.canonical_id,
      page_number: pageNumber,
      bbox: [round(anchor.box.x / width), round(anchor.box.y / height),
        round(anchor.box.width / width), round(anchor.box.height / height)],
      spatial: {
        x_rank_from_right: ranked.indexOf(anchor) + 1,
        relative_width: round(anchor.box.width / width),
        relative_height: round(anchor.box.height / height),
        font_size_ratio: round(anchor.box.width / medianWidth),
        is_near_top: anchor.box.y / height < 0.08,
        is_near_bottom: (anchor.box.y + anchor.box.height) / height > 0.92,
        nearest_right: right?.canonical_id || null,
        nearest_left: left?.canonical_id || null,
        vertical_overlap_right: right ? round(verticalOverlap(anchor, right)) : 0,
        vertical_overlap_left: left ? round(verticalOverlap(anchor, left)) : 0
      },
      sources
    };
  });
  return { page_number: pageNumber, context_only: contextOnly, width, height, anchor_result_id: fine.resultId, regions };
}

export function canonicalCatalog(pages) {
  const regions = new Map();
  for (const page of pages || []) for (const region of page.regions || []) regions.set(region.region_id, region);
  return regions;
}

function targetRegionIds(pages) {
  return (pages || []).filter(page => !page.context_only).flatMap(page => page.regions || []).map(region => region.region_id);
}

function compactCanonicalPages(pages) {
  const targetNumbers = (pages || []).filter(page => !page.context_only).map(page => page.page_number);
  const firstTarget = Math.min(...targetNumbers);
  const lastTarget = Math.max(...targetNumbers);
  return (pages || []).map(page => {
    const orderedRegions = [...(page.regions || [])]
      .sort((left, right) => left.spatial.x_rank_from_right - right.spatial.x_rank_from_right || left.bbox[1] - right.bbox[1]);
    const visibleRegions = !page.context_only ? orderedRegions
      : page.page_number < firstTarget ? orderedRegions.slice(-10)
        : page.page_number > lastTarget ? orderedRegions.slice(0, 10) : orderedRegions;
    const sourceCatalog = new Map();
    for (const region of visibleRegions) {
      for (const source of region.sources || []) {
        if (!sourceCatalog.has(source.source_id)) sourceCatalog.set(source.source_id, {
          source_id: source.source_id,
          result_id: source.result_id,
          text: source.text,
          char_count: [...source.text].length,
          confidence: source.confidence,
          bbox: source.bbox
        });
      }
    }
    return {
      page_number: page.page_number,
      context_only: page.context_only,
      anchor_result_id: page.anchor_result_id,
      source_catalog: [...sourceCatalog.values()],
      context_excerpt: page.context_only ? (page.page_number < firstTarget ? "previous_page_tail" : "next_page_head") : null,
      regions: visibleRegions.map(region => ({
        region_id: region.region_id,
        bbox: region.bbox,
        spatial: region.spatial,
        sources: region.sources.map(source => ({
          source_id: source.source_id,
          match: source.match,
          anchor_coverage: source.anchor_coverage,
          candidate_coverage: source.candidate_coverage,
          iou: source.iou
        }))
      }))
    };
  });
}

function referencedRegionIds(value, output = new Set()) {
  if (!value || typeof value !== "object") return output;
  if (typeof value.region_id === "string") output.add(value.region_id);
  for (const nested of Object.values(value)) referencedRegionIds(nested, output);
  return output;
}

function reviewEvidenceSubset(pages, classifications, draftPlan) {
  const relevant = referencedRegionIds(draftPlan);
  for (const item of classifications?.regions || []) {
    if (["annotation", "uncertain", "work_title", "volume_title", "section_heading"].includes(item.role)) {
      relevant.add(item.region_id);
    }
  }
  return (pages || []).map(page => ({
    ...page,
    regions: page.context_only ? page.regions : page.regions.filter(region => relevant.has(region.region_id))
  }));
}

export function normalizeClassifications(payload, pages) {
  const allowed = new Set(targetRegionIds(pages));
  const byId = new Map();
  const warnings = [];
  for (const item of Array.isArray(payload?.regions) ? payload.regions : []) {
    const regionId = asText(item?.region_id);
    if (!allowed.has(regionId)) {
      warnings.push({ code: "unknown_region", region_id: regionId });
      continue;
    }
    if (byId.has(regionId)) {
      warnings.push({ code: "duplicate_classification", region_id: regionId });
      continue;
    }
    const role = REGION_ROLES.has(item.role) ? item.role : "uncertain";
    byId.set(regionId, {
      region_id: regionId,
      role,
      confidence: Math.max(0, Math.min(1, finite(item.confidence))),
      candidates: (Array.isArray(item.candidates) ? item.candidates : []).filter(REGION_ROLES.has.bind(REGION_ROLES)),
      reason_code: asText(item.reason_code)
    });
  }
  for (const regionId of allowed) {
    if (!byId.has(regionId)) {
      warnings.push({ code: "missing_classification", region_id: regionId });
      byId.set(regionId, { region_id: regionId, role: "uncertain", confidence: 0, candidates: [], reason_code: "model_omitted" });
    }
  }
  return { regions: [...byId.values()], warnings };
}

function planParts(field) {
  return Array.isArray(field?.parts) ? field.parts : [];
}

function materializationError(code, message, extra = {}) {
  return Object.assign(new Error(message), { status: 422, diagnostics: [{ code, message, ...extra }] });
}

function sourceForPart(part, catalog) {
  const regionId = asText(part?.region_id);
  const region = catalog.get(regionId);
  if (!region) throw materializationError("unknown_region_ref", `不存在的 canonical region：${regionId}`, { region_id: regionId });
  const requested = asText(part?.source_id);
  const source = requested ? region.sources.find(item => item.source_id === requested) : region.sources[0];
  if (!source) throw materializationError("unknown_source_ref", `region ${regionId} 不包含来源 ${requested}`, {
    region_id: regionId, source_id: requested
  });
  return { region, source };
}

function materializeField(field, catalog, repairs = [], supportSources = []) {
  const chunks = [];
  const refs = [];
  const pages = [];
  for (const part of planParts(field)) {
    const { region, source } = sourceForPart(part, catalog);
    const characters = [...source.text];
    const start = part.start == null ? 0 : Number(part.start);
    let end = part.end == null ? characters.length : Number(part.end);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start === end) {
      repairs.push({ code: "empty_text_span_dropped", source_id: source.source_id,
        requested_start: start, requested_end: end, page_number: region.page_number });
      continue;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw materializationError("invalid_text_span", `字符区间格式无效：${source.source_id}`, {
        source_id: source.source_id, start, end, length: characters.length
      });
    }
    if (start >= characters.length) {
      repairs.push({ code: "empty_out_of_range_span_dropped", source_id: source.source_id,
        requested_start: start, requested_end: end, source_length: characters.length, page_number: region.page_number });
      continue;
    }
    if (end > characters.length) {
      repairs.push({ code: end === characters.length + 1 ? "full_span_off_by_one" : "span_clamped_to_source",
        source_id: source.source_id, requested_end: end, applied_end: characters.length, page_number: region.page_number });
      end = characters.length;
    }
    chunks.push(characters.slice(start, end).join(""));
    refs.push(source.source_id);
    pages.push(region.page_number);
  }
  const base = chunks.join("");
  const insertions = Array.isArray(field?.insertions) ? field.insertions : [];
  const normalizedInsertions = insertions.map((item, index) => ({
    offset: Number(item?.offset), text: typeof item?.text === "string" ? item.text : "", index
  }));
  let formattedReplacement = "";
  for (const insertion of normalizedInsertions) {
    const insertionSignature = textSignature(insertion.text);
    const baseSignature = textSignature(base);
    const projection = projectFormatting(base, insertion.text);
    if (baseSignature && (insertionSignature.includes(baseSignature) || projection.similarity >= 0.72)) {
      formattedReplacement = insertionSignature.length > baseSignature.length
        ? projection.text.replace(/^[，。！？；：、,.!?;\s]+/u, "")
        : projection.text;
      insertion.text = "";
      repairs.push({
        code: insertionSignature === baseSignature ? "full_text_insertion_projected_as_formatting"
          : insertionSignature.includes(baseSignature) ? "context_prefix_or_suffix_removed_by_format_projection"
            : "fuzzy_text_candidate_projected_as_formatting",
        similarity: projection.similarity,
        removed_character_count: insertionSignature.length - baseSignature.length
      });
    }
  }
  const characters = [...(formattedReplacement || base)];
  for (const insertion of normalizedInsertions) {
    if (!insertion.text) continue;
    if (insertion.offset > characters.length) {
      repairs.push({ code: insertion.offset === characters.length + 1 ? "terminal_insertion_off_by_one" : "terminal_insertion_clamped",
        requested_offset: insertion.offset, applied_offset: characters.length, text: insertion.text });
      insertion.offset = characters.length;
    }
    const unsupportedRuns = insertion.text.split(/[\p{P}\p{Z}\s]+/u).filter(Boolean).filter(run =>
      !supportSources.some(source => textSignature(source.text).includes(run)));
    if (unsupportedRuns.length) {
      throw materializationError("unsupported_text_insertion", "模型插入了 OCR 证据不支持的文字", {
        offset: insertion.offset, text: insertion.text, unsupported_runs: unsupportedRuns
      });
    }
    if ([...insertion.text].some(character => !INSERTION_CHARACTERS.has(character))) {
      const supporting = supportSources.filter(source => insertion.text.split(/[\p{P}\p{Z}\s]+/u)
        .filter(Boolean).some(run => textSignature(source.text).includes(run)));
      refs.push(...supporting.map(source => source.source_id));
      pages.push(...supporting.map(source => source.page_number));
      repairs.push({ code: "text_insertion_resolved_from_ocr", text: insertion.text,
        evidence_refs: supporting.map(source => source.source_id) });
    }
    if (!Number.isInteger(insertion.offset) || insertion.offset < 0 || insertion.offset > characters.length || !insertion.text) {
      throw materializationError("invalid_punctuation_insertion", "模型只能在 OCR 原文中插入标点", insertion);
    }
  }
  normalizedInsertions.sort((left, right) => right.offset - left.offset || right.index - left.index);
  for (const insertion of normalizedInsertions) characters.splice(insertion.offset, 0, insertion.text);
  return { text: characters.join(""), evidence_refs: refs, source_pages: pages };
}

function combineEvidence(fields) {
  return {
    evidence_refs: [...new Set(fields.flatMap(field => field.evidence_refs))],
    source_pages: [...new Set(fields.flatMap(field => field.source_pages))].sort((a, b) => a - b)
  };
}

export function materializeReferencePlan(plan, pages) {
  const catalog = canonicalCatalog(pages);
  const supportSources = (pages || []).filter(page => !page.context_only).flatMap(page =>
    page.regions.flatMap(region => region.sources.map(source => ({ ...source, page_number: page.page_number }))));
  const repairs = [];
  const entries = (Array.isArray(plan?.entries) ? plan.entries : []).map((raw, entryIndex) => {
    const title = materializeField(raw.title, catalog, repairs, supportSources);
    const subtitle = materializeField(raw.subtitle, catalog, repairs, supportSources);
    const author = materializeField(raw.author, catalog, repairs, supportSources);
    const lineFields = (Array.isArray(raw.lines) ? raw.lines : []).map(field => materializeField(field, catalog, repairs, supportSources));
    const proseFields = (Array.isArray(raw.prose) ? raw.prose : []).map(field => materializeField(field, catalog, repairs, supportSources));
    const seriesTitle = materializeField(raw.series?.title, catalog, repairs, supportSources);
    const notes = (Array.isArray(raw.notes) ? raw.notes : []).map(note => {
      const text = materializeField(note.text, catalog, repairs, supportSources);
      return { position: note.position, text: text.text, _evidence: text };
    });
    const evidence = combineEvidence([title, subtitle, author, seriesTitle, ...lineFields, ...proseFields,
      ...notes.map(note => note._evidence)]);
    if (!evidence.evidence_refs.length) {
      throw materializationError("empty_entry_evidence", `第 ${entryIndex + 1} 个条目没有 region 引用`, { entry_index: entryIndex });
    }
    return {
      action: asText(raw.action) || (asText(raw.continuation_of) ? "continue" : "create"),
      continuation_of: asText(raw.continuation_of),
      boundary_state: asText(raw.boundary_state) || "closed",
      kind: asText(raw.kind) || "other",
      title: title.text,
      subtitle: subtitle.text,
      author: author.text,
      form: asText(raw.form),
      heading_level: raw.heading_level ?? null,
      series: seriesTitle.text ? { title: seriesTitle.text, index: raw.series?.index, total: raw.series?.total } : null,
      lines: lineFields.map(field => field.text).filter(Boolean),
      prose: proseFields.map(field => field.text).filter(Boolean).join("\n\n"),
      notes: notes.map(({ position, text }) => ({ position, text })),
      source_pages: evidence.source_pages,
      evidence_refs: evidence.evidence_refs,
      confidence: Math.max(0, Math.min(1, finite(raw.confidence)))
    };
  });
  const statedIssues = (Array.isArray(plan?.issues) ? plan.issues : []).map(issue => ({
    source_pages: [...new Set((Array.isArray(issue?.source_pages) ? issue.source_pages : []).map(Number).filter(Number.isInteger))],
    description: asText(issue?.description),
    candidates: (Array.isArray(issue?.candidates) ? issue.candidates : []).map(asText).filter(Boolean)
  })).filter(issue => issue.description);
  const repairedPages = [...new Set(repairs.map(repair => repair.page_number).filter(Number.isInteger))];
  return {
    entries,
    issues: [...statedIssues, ...(repairs.length ? [{
      source_pages: repairedPages,
      description: `引用计划有 ${repairs.length} 处超出 OCR 实际字符边界，程序未生成越界文字，需人工复核。`,
      candidates: []
    }] : [])],
    materialization_repairs: repairs
  };
}

export function demoteInvalidRegulatedForms(candidate, diagnostics) {
  const allowed = new Set(["regulated_verse_line_count", "regulated_verse_line_width"]);
  const relevant = (Array.isArray(diagnostics) ? diagnostics : []).filter(item => allowed.has(item?.code));
  if (!relevant.length || relevant.length !== diagnostics.length) return { changed: false, candidate, repairs: [] };
  const repairs = [];
  for (const entryIndex of [...new Set(relevant.map(item => Number(item.entry_index)).filter(Number.isInteger))]) {
    const entry = candidate.entries?.[entryIndex];
    if (!entry?.form) continue;
    const claimedForm = entry.form;
    entry.form = "";
    const entryDiagnostics = relevant.filter(item => item.entry_index === entryIndex);
    candidate.issues = [...(candidate.issues || []), {
      source_pages: entry.source_pages || [],
      description: `模型标注体裁“${claimedForm}”未通过句数或句宽校验，已保留正文并将体裁降级为待复核。`,
      candidates: [claimedForm]
    }];
    repairs.push({ code: "unverified_regulated_form_demoted", entry_index: entryIndex,
      claimed_form: claimedForm, diagnostics: entryDiagnostics });
  }
  candidate.materialization_repairs = [...(candidate.materialization_repairs || []), ...repairs];
  return { changed: repairs.length > 0, candidate, repairs };
}

export function dedupeExactCandidateNotes(candidate) {
  const repairs = [];
  for (let entryIndex = 0; entryIndex < (candidate.entries || []).length; entryIndex += 1) {
    const entry = candidate.entries[entryIndex];
    const seen = new Set();
    const notes = [];
    for (const note of Array.isArray(entry.notes) ? entry.notes : []) {
      const key = `${JSON.stringify(note?.position || null)}:${asText(note?.text)}`;
      if (seen.has(key)) {
        repairs.push({ code: "exact_duplicate_note_removed", entry_index: entryIndex,
          position: note?.position || null, text: asText(note?.text) });
        continue;
      }
      seen.add(key);
      notes.push(note);
    }
    entry.notes = notes;
  }
  candidate.materialization_repairs = [...(candidate.materialization_repairs || []), ...repairs];
  return { changed: repairs.length > 0, candidate, repairs };
}

export function mergeExactCandidateEntries(candidate) {
  const owners = new Map();
  const entries = [];
  const repairs = [];
  const keyFor = entry => {
    const lines = (entry.lines || []).map(textSignature).filter(Boolean);
    if (lines.length >= 2) return `lines:${lines.join("|")}`;
    const prose = textSignature(entry.prose);
    return prose.length >= 12 ? `prose:${prose}` : "";
  };
  for (let inputIndex = 0; inputIndex < (candidate.entries || []).length; inputIndex += 1) {
    const entry = candidate.entries[inputIndex];
    const key = keyFor(entry);
    const owner = key ? owners.get(key) : null;
    const titleConflict = owner && asText(owner.title) && asText(entry.title) && asText(owner.title) !== asText(entry.title);
    if (!owner || titleConflict || owner.kind !== entry.kind) {
      entries.push(entry);
      if (key && !owners.has(key)) owners.set(key, entry);
      continue;
    }
    if (!owner.title) owner.title = entry.title;
    if (!owner.subtitle) owner.subtitle = entry.subtitle;
    if (!owner.author) owner.author = entry.author;
    if (!owner.form) owner.form = entry.form;
    if (!owner.series) owner.series = entry.series;
    owner.boundary_state = owner.boundary_state === "open" || entry.boundary_state === "open" ? "open" : "closed";
    owner.source_pages = [...new Set([...(owner.source_pages || []), ...(entry.source_pages || [])])].sort((a, b) => a - b);
    owner.evidence_refs = [...new Set([...(owner.evidence_refs || []), ...(entry.evidence_refs || [])])];
    owner.notes = [...(owner.notes || []), ...(entry.notes || [])];
    owner.confidence = Math.min(Number(owner.confidence) || 1, Number(entry.confidence) || 1);
    repairs.push({ code: "exact_duplicate_entry_merged", input_entry_index: inputIndex,
      retained_title: asText(owner.title), source_pages: owner.source_pages });
  }
  candidate.entries = entries;
  candidate.materialization_repairs = [...(candidate.materialization_repairs || []), ...repairs];
  return { changed: repairs.length > 0, candidate, repairs };
}

export function normalizeDeterministicCitationMarks(candidate) {
  const repairs = [];
  for (let entryIndex = 0; entryIndex < (candidate.entries || []).length; entryIndex += 1) {
    for (let noteIndex = 0; noteIndex < (candidate.entries[entryIndex].notes || []).length; noteIndex += 1) {
      const note = candidate.entries[entryIndex].notes[noteIndex];
      const before = asText(note.text);
      let after = before.replace(/(^|[。；！？：，,\s])([\p{Script=Han}]{1,8}(?:縣志|县志|錄|录|志|賦|赋))(?=[\p{Script=Han}，,：:])/gu,
        (_, boundary, title) => `${boundary}《${title}》`);
      after = after.replace(/([漢汉晉晋唐宋魏隋明清])(?:[，,])?書([\p{Script=Han}]{1,8}傳)/gu,
        (_, dynasty, biography) => `《${dynasty}書·${biography}》`);
      if (after === before) continue;
      if (textSignature(after) !== textSignature(before)) {
        throw materializationError("citation_mark_changed_text", "书名号规范化不得改变 OCR 字符", {
          entry_index: entryIndex, note_index: noteIndex, before, after
        });
      }
      note.text = after;
      repairs.push({ code: "deterministic_citation_marks_inserted", entry_index: entryIndex,
        note_index: noteIndex, before, after });
    }
  }
  candidate.materialization_repairs = [...(candidate.materialization_repairs || []), ...repairs];
  return { changed: repairs.length > 0, candidate, repairs };
}

function referenceSchema(includeNotes) {
  const field = { parts: [{ region_id: "p43:r001", source_id: "p43:pp-ocrv6:page-043-rp001", start: 0, end: 7 }],
    insertions: [{ offset: 7, text: "，" }] };
  return {
    entries: [{
      action: "create|continue", continuation_of: "", boundary_state: "closed|open",
      kind: "heading|book_text|biography|poem|preface|note|colophon|other",
      title: field, subtitle: { parts: [], insertions: [] }, author: { parts: [], insertions: [] },
      form: "", heading_level: null,
      series: { title: field, index: 1, total: 6 },
      lines: [field], prose: [field],
      ...(includeNotes ? { notes: [{ text: field, position: { field: "lines|title|series", line: 1, offset: 7 } }] }
        : { annotation_region_ids: ["p43:r009"] }),
      confidence: 0.9
    }],
    issues: [{ source_pages: [43], description: "仅描述不能可靠判断之处", candidates: [] }]
  };
}

function sharedReferenceRules(pages) {
  const targets = targetRegionIds(pages);
  return [
    `目标 canonical region 仅限：${JSON.stringify(targets)}。上下文页只用于判断跨页边界，不得引用到输出。`,
    "任何原文都不得由你重新抄写。文字字段只能使用 parts 引用 region_id、该 region.sources 中的 source_id，以及 Unicode 字符区间 [start,end)。",
    "source_catalog.char_count 是程序计算的权威 Unicode 字符数；每个 start/end 必须满足 0 <= start < end <= char_count。不得因猜测七言、五言而把 end 写到 char_count 之外，也不得假设一个 region 必然能均分为 7+7。",
    "insertions 只能插入现代标点、书名号或分段换行，不能插入汉字、数字或替换 OCR 原字。两套 OCR 有异文时选择对应 source_id，不得凭语义造字。",
    "竖排阅读顺序是从右到左、每栏从上到下。bbox 已归一化，spatial 给出从右栏序、相对尺寸、邻接和纵向重叠。",
    "跨页作品只引用目标页实际出现的部分；页末未完设 boundary_state=open，下一批通过 continuation_of 续接。"
    ,"只返回单行紧凑 JSON，不要 Markdown、解释或缩进；省略空的 subtitle、author、series、prose、notes、issues 和 insertions，以控制输出长度。"
  ];
}

export function buildClassificationPrompt(documentTitle, pages, openEntries = []) {
  const targetIds = targetRegionIds(pages);
  return [
    "你是古籍版面区域分类器。这是三阶段流程的第一阶段，只判断 region 的版面角色，不生成作品、不抄写文字。",
    `书名上下文：${JSON.stringify(asText(documentTitle))}。`,
    ...sharedReferenceRules(pages),
    "必须让每个目标 region 恰好出现一次。可用 role：header、footer、page_number、volume_title、section_heading、work_title、main_text、annotation、book_text、colophon、watermark、uncertain。证据不足时用 uncertain，并给 candidates 和稳定 reason_code。",
    `输出形状：${JSON.stringify({ regions: targetIds.slice(0, 1).map(region_id => ({ region_id, role: "main_text", confidence: 0.9, candidates: [], reason_code: "body_size_and_position" })) })}`,
    `open_entries：${JSON.stringify(openEntries)}`,
    `canonical_pages（含只读前后页；文字在每页 source_catalog 中去重存放）：${JSON.stringify(compactCanonicalPages(pages))}`
  ].join("\n");
}

export function buildGroupingPrompt(documentTitle, pages, classifications, openEntries = [], domainRules = []) {
  return [
    "你是古籍作品边界与正文分组器。这是第二阶段。第一阶段已经分类；你只负责卷/年标题、作品边界、跨页续接、组诗关系和正文分句，不负责注文挂接。",
    `书名上下文：${JSON.stringify(asText(documentTitle))}。`,
    ...sharedReferenceRules(pages),
    ...(domainRules.length ? ["本项目结构规则：", ...domainRules] : []),
    "每首作品单独一个 entry。组诗总题只放 series.title，各首 title 留空并递增 series.index。诗句可对同一 OCR source 用多个不重叠字符区间拆分；不要把注文字符放进 lines。annotation_region_ids 只列出暂待第三阶段挂接的注文 region。",
    "先看第一阶段角色，再用字号、栏位、五七言句数和上下文页校正；第一阶段不是权威。不要因为 context 页出现后文就把后文输出。",
    `输出形状：${JSON.stringify(referenceSchema(false))}`,
    `open_entries：${JSON.stringify(openEntries)}`,
    `第一阶段分类：${JSON.stringify(classifications)}`,
    `canonical_pages（文字在每页 source_catalog 中去重存放）：${JSON.stringify(compactCanonicalPages(pages))}`
  ].join("\n");
}

export function buildAnnotationReviewPrompt(documentTitle, pages, classifications, draftPlan, diagnostics = [], openEntries = [], domainRules = []) {
  const reviewPages = reviewEvidenceSubset(pages, classifications, draftPlan);
  const reviewIds = new Set(reviewPages.flatMap(page => page.regions.map(region => region.region_id)));
  const reviewClassifications = {
    ...(classifications || {}),
    regions: (classifications?.regions || []).filter(item => reviewIds.has(item.region_id))
  };
  return [
    "你是古籍注文挂接与结构终审器。这是第三阶段，也是唯一最终候选。请复核第二阶段边界，但主要负责把所有注文放回所属作品和精确锚点，并只用插入标点完成现代排版。",
    `书名上下文：${JSON.stringify(asText(documentTitle))}。`,
    ...sharedReferenceRules(reviewPages),
    ...(domainRules.length ? ["本项目结构与注文规则：", ...domainRules] : []),
    "返回完整 entries 引用计划，不是补丁。不得遗漏第二阶段已正确保存的正文。若第二阶段误分正文/注文、作品边界或组诗，可在完整计划中修正。",
    "每条 notes.text 仍只能引用 OCR region/source/字符区间。position.offset 是最终已加标点字段的 Unicode 字符位置。注文中明确的书名、篇名只通过 insertions 加《》；泛称“某人诗”不加书名号。",
    "不得把注文引诗放入 lines，不得为凑足绝句或律诗加入小字。无法确定的异文或归属写入 issues，不要猜补。",
    "体裁是受校验字段：只有四句且每句五/七字才能写五絕/七絕，只有八句且每句五/七字才能写五律/七律。机器诊断指出句数不足而你无法从目标 region 恢复完整正文时，必须将 form 留空并在 issues 记录边界待核；禁止保留错误体裁来强行结束作品。",
    `输出形状：${JSON.stringify(referenceSchema(true))}`,
    `open_entries：${JSON.stringify(openEntries)}`,
    "为控制上下文，本轮 canonical_pages 只保留第二阶段实际引用的 region，以及 annotation、uncertain 和标题 region；不得引用未提供的 region。",
    `第一阶段相关分类：${JSON.stringify(reviewClassifications)}`,
    `第二阶段计划：${JSON.stringify(draftPlan)}`,
    `第二阶段机器诊断：${JSON.stringify(diagnostics)}`,
    `canonical_pages（终审相关子集，文字在每页 source_catalog 中去重存放）：${JSON.stringify(compactCanonicalPages(reviewPages))}`
  ].join("\n");
}
