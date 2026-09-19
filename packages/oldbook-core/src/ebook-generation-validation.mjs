const PUNCTUATION = /[\s，。！？；：、,.!?;:“”‘’「」『』《》（）()【】\[\]—…·]/gu;

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedText(value) {
  return asText(value).replace(PUNCTUATION, "");
}

function textLines(entry) {
  const values = typeof entry?.lines === "string" ? entry.lines.split(/\r?\n/) : entry?.lines;
  return (Array.isArray(values) ? values : []).map(asText).filter(Boolean);
}

function normalizedLines(entry) {
  return textLines(entry).map(normalizedText).filter(Boolean);
}

function regulatedVerseSpec(form) {
  const value = asText(form).replace(/绝/gu, "絕").replace(/[言詩诗]/gu, "");
  if (/^七.*絕/u.test(value)) return { lines: 4, width: 7 };
  if (/^七(?!.*排).*律/u.test(value)) return { lines: 8, width: 7 };
  if (/^五.*絕/u.test(value)) return { lines: 4, width: 5 };
  if (/^五(?!.*排).*律/u.test(value)) return { lines: 8, width: 5 };
  if (value === "七排" || value === "七排律") return { lines: null, width: 7, paired: true };
  if (value === "五排" || value === "五排律") return { lines: null, width: 5, paired: true };
  return null;
}

function validateRegulatedVerse(entry, lines, entryIndex, diagnostics, extra = {}) {
  const spec = regulatedVerseSpec(entry?.form);
  if (!spec) return;
  const { skipLineCount = false, lineIndexOffset = 0, ...diagnosticExtra } = extra;
  const mayBeIncompleteAcrossBoundary = skipLineCount && spec.lines !== null && lines.length < spec.lines;
  if (!mayBeIncompleteAcrossBoundary && spec.lines !== null && lines.length !== spec.lines) {
    diagnostics.push(diagnostic("regulated_verse_line_count", entryIndex,
      `${asText(entry.form)} 必须是 ${spec.lines} 句，不能合并多首作品或用注文补足`, {
        expected: spec.lines, actual: lines.length, ...diagnosticExtra
      }));
  }
  if (!skipLineCount && spec.paired && lines.length % 2 !== 0) {
    diagnostics.push(diagnostic("regulated_verse_pairing", entryIndex,
      `${asText(entry.form)} 必须逐句保存，并保持可组成完整联的偶数句`, {
        actual: lines.length, ...diagnosticExtra
      }));
  }
  const invalid = lines.map((line, index) => ({
    index: index >= lineIndexOffset ? index - lineIndexOffset : index,
    scope: index >= lineIndexOffset ? "candidate" : "previous",
    width: [...line].length
  }))
    .filter(item => item.width !== spec.width);
  if (invalid.length) diagnostics.push(diagnostic("regulated_verse_line_width", entryIndex,
    `${asText(entry.form)} 每句应为 ${spec.width} 字，疑似混入注文或断句错误`, {
      expected: spec.width, invalid_lines: invalid, ...diagnosticExtra
    }));
}

function entrySegments(entry) {
  return [
    asText(entry?.title),
    ...normalizedLines(entry),
    ...asText(entry?.prose).split(/\n+/),
    ...(Array.isArray(entry?.notes) ? entry.notes.map(note => asText(note?.text)) : [])
  ].map(normalizedText).filter(text => text.length >= 4);
}

function evidenceText(bundles) {
  return bundles.flatMap(bundle => bundle.results || [])
    .flatMap(result => result.regions || [])
    .map(region => normalizedText(region.text))
    .filter(Boolean)
    .join("");
}

function ngrams(text, size = 3) {
  const characters = [...text];
  const output = new Set();
  for (let index = 0; index <= characters.length - size; index += 1) {
    output.add(characters.slice(index, index + size).join(""));
  }
  return output;
}

function evidenceScore(segment, evidence) {
  if (!segment || !evidence) return 0;
  if (evidence.includes(segment)) return 1;
  const wanted = ngrams(segment);
  if (!wanted.size) return 0;
  const available = ngrams(evidence);
  let matches = 0;
  for (const gram of wanted) if (available.has(gram)) matches += 1;
  return matches / wanted.size;
}

function countOccurrences(text, fragment) {
  if (!text || !fragment) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(fragment, offset)) >= 0) {
    count += 1;
    offset += fragment.length;
  }
  return count;
}

function repeatedLineRun(lines) {
  for (let size = Math.floor(lines.length / 2); size >= 2; size -= 1) {
    for (let left = 0; left <= lines.length - size * 2; left += 1) {
      for (let right = left + size; right <= lines.length - size; right += 1) {
        if (lines.slice(left, left + size).every((line, offset) => line === lines[right + offset])) {
          return { size, left, right };
        }
      }
    }
  }
  return null;
}

function repeatedSingleLine(lines) {
  const seen = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    if (seen.has(lines[index])) return { first: seen.get(lines[index]), second: index, text: lines[index] };
    seen.set(lines[index], index);
  }
  return null;
}

function commonBoundaryOverlap(previous, next) {
  const limit = Math.min(previous.length, next.length);
  for (let size = limit; size >= 2; size -= 1) {
    if (previous.slice(-size).every((line, index) => line === next[index])) return size;
  }
  return 0;
}

function bodyKey(entry) {
  const lines = normalizedLines(entry);
  if (lines.length >= 2) return `lines:${lines.join("|")}`;
  const prose = normalizedText(entry?.prose);
  return prose.length >= 12 ? `prose:${prose}` : "";
}

function diagnostic(code, entryIndex, message, extra = {}) {
  return { code, entry_index: entryIndex, message, ...extra };
}

function unmarkedCitationExcerpt(value) {
  const text = asText(value);
  for (const clause of text.split(/[。；！？]/u).map(part => part.trim()).filter(Boolean)) {
    const namedWork = clause.match(/^([^：有]{2,12})有(《[^》]+》|[^《：]{2,12})(篇|詩|诗|行|賦|赋)(?:$|：)/u);
    if (namedWork) {
      const source = namedWork[1];
      const work = namedWork[2];
      if (!source.includes("《") && /(?:書|书|史|志|傳|传|經|经|禮|礼|春秋|國策|国策|楚辭|楚辞|文選|文选|新論|新论|集|子)$/u.test(source)) return source;
      if (!work.startsWith("《")) return work;
    }

    const colon = clause.indexOf("：");
    if (colon < 0) continue;
    const attribution = clause.slice(0, colon).trim();
    if (!attribution || [...attribution].length === 1 || attribution.includes("《")) continue;
    if (/(?:詩|诗|詞|词|文|云|曰)$/u.test(attribution)) continue;
    if (/(?:書|书|史|志|傳|传|經|经|禮|礼|春秋|國策|国策|楚辭|楚辞|文選|文选|新論|新论|賦|赋|篇|行|銘|铭|記|记|錄|录|集|子)/u.test(attribution)) {
      return attribution;
    }
  }
  return "";
}

function validateCitationMarks(entry, entryIndex, diagnostics) {
  for (const note of Array.isArray(entry?.notes) ? entry.notes : []) {
    const excerpt = unmarkedCitationExcerpt(note?.text);
    if (excerpt) diagnostics.push(diagnostic(
      "unmarked_citation_title",
      entryIndex,
      "注文中的书名或篇名必须统一使用全角书名号《》",
      { excerpt }
    ));
  }
}

export class GeneratedChunkValidationError extends Error {
  constructor(diagnostics) {
    super(`模型候选未通过硬校验：${diagnostics.map(item => item.code).join(", ")}`);
    this.name = "GeneratedChunkValidationError";
    this.status = 422;
    this.diagnostics = diagnostics;
  }
}

export function validateGeneratedChunk(document, payload, options) {
  const { pageStart, pageEnd, pageBundles = [], openEntryIds = [] } = options;
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  const targetBundles = pageBundles.filter(bundle => !bundle.context_only);
  const contextBundles = pageBundles.filter(bundle => bundle.context_only);
  const targetEvidenceIds = new Set(targetBundles.flatMap(bundle => bundle.results || [])
    .flatMap(result => result.regions || []).map(region => region.evidence_id).filter(Boolean));
  const targetText = evidenceText(targetBundles);
  const contextText = evidenceText(contextBundles);
  const openIds = new Set(openEntryIds);
  const diagnostics = [];
  const bodyOwners = new Map();

  for (const entry of document.entries || []) {
    const key = bodyKey(entry);
    if (key) bodyOwners.set(key, entry.id);
  }

  entries.forEach((entry, entryIndex) => {
    if (!entry || typeof entry !== "object") {
      diagnostics.push(diagnostic("invalid_entry", entryIndex, "条目必须是对象"));
      return;
    }
    const pages = Array.isArray(entry.source_pages) ? entry.source_pages.map(Number) : [];
    if (!pages.length) diagnostics.push(diagnostic("empty_source", entryIndex, "条目缺少目标来源页"));
    if (pages.some(page => !Number.isInteger(page) || page < pageStart || page > pageEnd)) {
      diagnostics.push(diagnostic("context_leak", entryIndex, `source_pages 必须位于 ${pageStart}-${pageEnd}`));
    }

    const evidenceRefs = Array.isArray(entry.evidence_refs) ? [...new Set(entry.evidence_refs.map(asText).filter(Boolean))] : [];
    if (!evidenceRefs.length) diagnostics.push(diagnostic("invalid_evidence_ref", entryIndex, "条目缺少 evidence_refs"));
    const invalidRefs = evidenceRefs.filter(reference => !targetEvidenceIds.has(reference));
    if (invalidRefs.length) {
      diagnostics.push(diagnostic("context_leak", entryIndex, "条目引用了上下文页或不存在的 OCR 区域", { evidence_refs: invalidRefs }));
    }

    const continuation = asText(entry.continuation_of);
    const action = asText(entry.action) || (continuation ? "continue" : "create");
    if (action === "continue" && (!continuation || !openIds.has(continuation))) {
      diagnostics.push(diagnostic("invalid_continuation", entryIndex, "continue 必须指向本轮开放条目", { continuation_of: continuation }));
    }
    if (action === "create" && continuation) {
      diagnostics.push(diagnostic("invalid_continuation", entryIndex, "create 不得携带 continuation_of"));
    }
    if (!new Set(["create", "continue"]).has(action)) {
      diagnostics.push(diagnostic("invalid_action", entryIndex, "action 只能是 create 或 continue"));
    }

    for (const segment of entrySegments(entry)) {
      const targetScore = evidenceScore(segment, targetText);
      const contextScore = evidenceScore(segment, contextText);
      if (contextScore >= 0.72 && targetScore < 0.35 && contextScore - targetScore >= 0.35) {
        diagnostics.push(diagnostic("context_leak", entryIndex, "文本主要由上下文页支持而非目标页", {
          excerpt: [...segment].slice(0, 24).join(""), target_score: Number(targetScore.toFixed(2)), context_score: Number(contextScore.toFixed(2))
        }));
        break;
      }
    }

    const lines = normalizedLines(entry);
    const rawLines = textLines(entry);
    if (entry.kind === "poem" && normalizedText(entry.title) && normalizedText(entry.title) === lines[0]) {
      diagnostics.push(diagnostic("title_matches_first_line", entryIndex,
        "作品首句不得在无版面题名证据时复制为 title", { source_pages: pages }));
    }
    const unpunctuated = entry.kind === "poem" ? rawLines
      .map((line, index) => ({ index, line }))
      .filter(item => !/[，。！？；：][”’」』》）】]?$/u.test(item.line)) : [];
    if (unpunctuated.length) {
      diagnostics.push(diagnostic("missing_line_punctuation", entryIndex,
        "诗词必须逐句拆分，且每个 lines 元素都以现代中文标点结束", {
          lines: unpunctuated.map(item => item.index + 1), source_pages: pages
        }));
    }
    const repeated = repeatedLineRun(lines);
    if (repeated) diagnostics.push(diagnostic("duplicate_line_run", entryIndex, "同一条目出现连续两句以上重复正文", {
      ...repeated, source_pages: pages
    }));
    const repeatedLine = repeatedSingleLine(lines);
    if (!repeated && repeatedLine && /[絕绝律]/.test(asText(entry.form))) {
      diagnostics.push(diagnostic("duplicate_line", entryIndex, "绝句或律诗中出现完全相同的重复诗句", {
        ...repeatedLine, source_pages: pages
      }));
    }
    const continued = action === "continue" && continuation
      ? (document.entries || []).find(item => item.id === continuation)
      : null;
    const continuedLines = continued ? normalizedLines(continued) : [];
    const combinedLines = [...continuedLines, ...lines];
    validateRegulatedVerse({ ...entry, form: asText(entry.form) || continued?.form }, combinedLines,
      entryIndex, diagnostics, { source_pages: pages, skipLineCount: asText(entry.boundary_state) === "open",
        lineIndexOffset: continuedLines.length });

    if (continued) {
      const existing = new Set(continuedLines);
      const repeatedFromPrevious = lines
        .map((line, index) => ({ line, index }))
        .find(item => existing.has(item.line));
      if (repeatedFromPrevious) {
        diagnostics.push(diagnostic("continuation_overlap", entryIndex,
          "续接片段重复了开放条目中已经保存的诗句", {
            candidate_line: repeatedFromPrevious.index + 1, source_pages: pages
          }));
      }
    }

    const key = bodyKey(entry);
    if (key && bodyOwners.has(key)) {
      diagnostics.push(diagnostic("duplicate_entry", entryIndex, "正文与已有条目或本批另一条目完全重复", { duplicate_of: bodyOwners.get(key) }));
    } else if (key) {
      bodyOwners.set(key, `candidate:${entryIndex}`);
    }

    if (action === "continue" && continuation) {
      const target = (document.entries || []).find(item => item.id === continuation);
      const overlap = target ? commonBoundaryOverlap(normalizedLines(target), lines) : 0;
      if (overlap >= 1) diagnostics.push(diagnostic("continuation_overlap", entryIndex, "续接片段重复了已有条目结尾", { lines: overlap }));
    }

    const noteKeys = new Set();
    for (const note of Array.isArray(entry.notes) ? entry.notes : []) {
      const key = `${JSON.stringify(note?.position || null)}:${normalizedText(note?.text)}`;
      if (noteKeys.has(key)) diagnostics.push(diagnostic("duplicate_note", entryIndex, "同一锚点出现重复注文"));
      noteKeys.add(key);
    }
    validateCitationMarks(entry, entryIndex, diagnostics);
  });

  const titleOwners = new Map();
  entries.forEach((entry, entryIndex) => {
    const action = asText(entry?.action) || (asText(entry?.continuation_of) ? "continue" : "create");
    const title = normalizedText(entry?.title);
    if (action !== "create" || entry?.kind !== "poem" || !title) return;
    titleOwners.set(title, [...(titleOwners.get(title) || []), entryIndex]);
  });
  for (const [title, owners] of titleOwners) {
    const evidenceCount = countOccurrences(targetText, title);
    if (owners.length > 1 && owners.length > evidenceCount) {
      diagnostics.push(diagnostic("repeated_work_title", owners[1],
        "同一版面总题不得复制为多首诗的 title；请改用共享的 series.title",
        { title, candidate_count: owners.length, evidence_count: evidenceCount,
          source_pages: [...new Set(owners.flatMap(index => entries[index]?.source_pages || []))] }));
    }
  }

  const previousPoem = [...(document.entries || [])].reverse().find(entry => entry.kind === "poem");
  const firstPoem = entries.find(entry => entry?.kind === "poem" &&
    (asText(entry.action) || (asText(entry.continuation_of) ? "continue" : "create")) === "create");
  const boundaryTitle = normalizedText(firstPoem?.title);
  if (previousPoem && boundaryTitle && normalizedText(previousPoem.title) === boundaryTitle &&
      countOccurrences(targetText, boundaryTitle) === 0) {
    diagnostics.push(diagnostic("repeated_work_title", entries.indexOf(firstPoem),
      "跨批次延续组诗时不得重复上一批的总题，请使用相同 series.title",
      { title: boundaryTitle, evidence_count: 0 }));
  }

  if (diagnostics.length) throw new GeneratedChunkValidationError(diagnostics);
  return { ok: true, entries: entries.length, warnings: [] };
}

export function validateGeneratedDocument(document, { pageStart, pageEnd }) {
  const scoped = (document.entries || []).filter(entry => entry.source_pages?.some(page => page >= pageStart && page <= pageEnd));
  const diagnostics = [];
  const bodies = new Map();
  const openIds = new Set(document.generation?.open_entries || []);
  scoped.forEach((entry, index) => {
    if (!entry.source_pages?.length || entry.source_pages.some(page => page < pageStart || page > pageEnd)) {
      diagnostics.push(diagnostic("empty_source", index, "最终条目来源页为空或越界", { entry_id: entry.id }));
    }
    const lines = normalizedLines(entry);
    const rawLines = textLines(entry);
    if (entry.kind === "poem" && normalizedText(entry.title) && normalizedText(entry.title) === lines[0]) {
      diagnostics.push(diagnostic("title_matches_first_line", index,
        "作品首句不得在无版面题名证据时复制为 title", { entry_id: entry.id }));
    }
    const unpunctuated = entry.kind === "poem" ? rawLines
      .map((line, lineIndex) => ({ index: lineIndex, line }))
      .filter(item => !/[，。！？；：][”’」』》）】]?$/u.test(item.line)) : [];
    if (unpunctuated.length) {
      diagnostics.push(diagnostic("missing_line_punctuation", index,
        "诗词必须逐句拆分，且每个 lines 元素都以现代中文标点结束", {
          entry_id: entry.id, lines: unpunctuated.map(item => item.index + 1)
        }));
    }
    const repeated = repeatedLineRun(lines);
    if (repeated) diagnostics.push(diagnostic("duplicate_line_run", index, "最终条目含重复正文片段", { entry_id: entry.id, ...repeated }));
    const repeatedLine = repeatedSingleLine(lines);
    if (!repeated && repeatedLine && /[絕绝律]/.test(asText(entry.form))) {
      diagnostics.push(diagnostic("duplicate_line", index, "最终近体诗含完全相同的重复诗句", { entry_id: entry.id, ...repeatedLine }));
    }
    validateRegulatedVerse(entry, lines, index, diagnostics, {
      entry_id: entry.id, source_pages: entry.source_pages, skipLineCount: openIds.has(entry.id)
    });
    const key = bodyKey(entry);
    if (key && bodies.has(key)) diagnostics.push(diagnostic("duplicate_entry", index, "最终文档含重复条目", {
      entry_id: entry.id, duplicate_of: bodies.get(key)
    }));
    else if (key) bodies.set(key, entry.id);
    validateCitationMarks(entry, index, diagnostics);
    const previous = scoped[index - 1];
    if (previous?.kind === "poem" && entry.kind === "poem" && normalizedText(entry.title) &&
        normalizedText(previous.title) === normalizedText(entry.title) && !entry.series && !previous.series) {
      diagnostics.push(diagnostic("repeated_work_title", index,
        "最终文档中相邻诗作重复使用同一题名且未建立 series",
        { entry_id: entry.id, previous_entry_id: previous.id, title: entry.title }));
    }
  });
  if (diagnostics.length) throw new GeneratedChunkValidationError(diagnostics);
  return { ok: true, entries: scoped.length };
}
