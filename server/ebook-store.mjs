import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson, safeId } from "./project-store.mjs";

const ENTRY_KINDS = new Set(["heading", "book_text", "biography", "poem", "preface", "note", "colophon", "other"]);
const LEGACY_HEADING_LEVELS = new Map([["volume", 1], ["year", 2], ["section", 3]]);
const MIN_HEADING_LEVEL = 1;
const MAX_HEADING_LEVEL = 6;
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3.2";
const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_CHUNK_SIZE = 5;
const DEFAULT_CONTEXT_OVERLAP = 1;

function now() {
  return new Date().toISOString();
}

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
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
  const field = value.field === "title" ? "title" : value.field === "lines" ? "lines" : null;
  const line = Number(value.line);
  const offset = Number(value.offset);
  if (!field || !Number.isInteger(offset) || offset < 0) return null;
  if (field === "lines" && (!Number.isInteger(line) || line < 1)) return null;
  return field === "title" ? { field, offset } : { field, line, offset };
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
  if (entry.lines?.length) return { field: "lines", line: 1, offset: 0 };
  return null;
}

function locateMarker(entry, marker) {
  const anchor = asText(marker);
  if (anchor && anchor !== "題注") {
    const titleOffset = codePointEnd(asText(entry.title), anchor);
    if (titleOffset != null) return { field: "title", offset: titleOffset };
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

export function mergeGenerated(document, payload, pageStart, pageEnd) {
  const outputEntries = Array.isArray(payload?.entries) ? payload.entries : [];
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
      confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
      review_status: "needs_review"
    };
    normalized.notes = normalizeGeneratedNotes(raw.notes, normalized);

    const target = continuation && document.entries.find(entry => entry.id === continuation);
    if (target) {
      const lineOffset = target.lines.length;
      const continuationNotes = normalized.notes.map(note => note.position.field === "lines"
        ? { ...note, position: { ...note.position, line: note.position.line + lineOffset } }
        : note);
      target.lines = [...target.lines, ...normalized.lines];
      target.prose = [target.prose, normalized.prose].filter(Boolean).join("\n");
      target.notes = [...target.notes, ...continuationNotes];
      target.source_pages = uniqueNumbers([...target.source_pages, ...normalized.source_pages]);
      target.confidence = Math.min(target.confidence || 1, normalized.confidence || 1);
      if (!target.title) target.title = normalized.title;
      if (!target.subtitle) target.subtitle = normalized.subtitle;
      if (!target.author) target.author = normalized.author;
      if (!target.form) target.form = normalized.form;
      if (!target.heading_level && normalized.heading_level) target.heading_level = normalized.heading_level;
      if (!target.series && normalized.series) target.series = normalized.series;
    } else if (normalized.title || normalized.lines.length || normalized.prose || normalized.notes.length) {
      document.entries.push(normalized);
    }
  }

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

function regionText(region) {
  return asText(region?.edited_text ?? region?.raw_text ?? "");
}

function pageEvidence(page) {
  return {
    page_number: page.page_number,
    volume: page.volume || null,
    source_page: page.source_page || page.page_number,
    regions: [...(page.regions || [])]
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .flatMap(region => {
        const text = regionText(region);
        return text ? [{ order: region.order, kind: region.kind || "other", text }] : [];
      })
  };
}

export function buildEbookPrompt(documentTitle, pageBundles, previousEntries, learningContext = "") {
  const expected = {
    entries: [{
      continuation_of: "若续接上一批条目，填写上一批 entry id，否则为空字符串",
      kind: "heading|book_text|biography|poem|preface|note|colophon|other",
      title: "",
      subtitle: "",
      author: "",
      form: "",
      heading_level: "目录层级 1-6；1 最高，非目录标题时为 null",
      series: { title: "组诗总题；非组诗时为 null", index: 1, total: 6 },
      lines: ["诗歌正文逐行；非诗歌为空数组"],
      prose: "序跋、传记等散文，按文意添加现代标点，并用两个换行符分隔自然段；诗歌为空字符串",
      notes: [{ position: { field: "lines", line: 1, offset: 7 }, text: "注文正文" }],
      source_pages: [1],
      confidence: 0.9
    }],
    issues: [{ source_pages: [1], description: "无法可靠判定之处", candidates: ["候选一", "候选二"] }]
  };

  return [
    "你正在整理一部以诗歌为主要内容的中国古籍 OCR 校对稿，目标是生成忠实、可校订的现代电子排版数据。此类文献可能是诗集、词集、曲集、诗文合集或带笺注、评点的选本。",
    `当前项目书名：${JSON.stringify(asText(documentTitle) || "书名待定")}。只把它作为识别上下文，不得凭书名补写正文。`,
    "同一页可能提供两套 OCR。它们不是两篇文本：请逐项比对，以人工校正后的文字为最高优先级，并利用另一套结果补足明显漏字或版面类别。",
    "严格要求：",
    "1. 不翻译、不改写、不补写原书没有的句子；保留繁体字、异体字、人名和原注。",
    "2. 删除扫描机构、数位化、典藏等后加水印，不把版心、页码、书口和刻印信息混入正文。",
    "3. 恢复竖排从右到左、每栏从上到下的阅读顺序。大字正文旁的双行小字通常是逐句注文，不得混入诗句。",
    "4. 卷名、年次（如乙卯年、丙辰年）和其他目录标题不能遗漏。所有目录标题都使用 kind=heading，并用数字 heading_level=1..6 表示抽象层级（1 最高）；通常卷名为 1、卷内年次为 2，但应按原书实际目录关系判断，不把年份写进某首诗的 title/subtitle。作品组题使用 series，不属于目录层级。扉页题字、卷端撰注者、出版题记等使用 book_text。作者传使用 biography 和 prose。",
    "5. 诗歌放入 lines，依原书的诗行、分阕或曲牌层次分行；散文放入 prose；夹注放入 notes。每条注必须用 position 记录圈号插入位置，不得用所注的几个字或整句作为 marker：诗句位置为 {field:'lines',line:从1开始的行号,offset:该行第几个Unicode字符后}，题下注为 {field:'title',offset:标题第几个Unicode字符后}。notes[].text 必须按完整句意添加现代中文标点，正确断开书名、人名、篇名、引诗和按语，不得只在末尾机械加句号，也不得改变任何原文字词。序题附近出现的署名只有版面明确表明作者关系时才写入 author，不能从文末落款臆造标题作者。",
    "6. 组诗必须拆成一首一个 poem 条目，并用相同 series.title、递增 series.index 和可确认的 series.total 关联。近体诗按每句字数、句数、偶数句押韵及版面题名共同判体：七绝为四个七言句，七律为八个七言句，五律为八个五言句。古体诗、乐府、词、曲、联句等须按原书题名、体式、分阕和版面边界处理，不得强行套用绝句或律诗句数。每首的 notes 必须紧随该首保存，不得汇总到组末。",
    "7. 序跋、传记等 prose 必须按文意添加现代中文标点，并按论旨转换、叙事阶段、评议、作序缘起和落款划分自然段，以两个换行符分段；不要按固定字数机械断句或分段。只能增加标点和空白，不得改变字词。无法确认的字或边界不要擅断，在 issues 中记录候选；不要使用 Markdown。",
    "8. pageBundles 中 context_only=true 的前后页仅用于判断跨页续接和边界，不得输出这些页的正文，也不得把它们写入 source_pages。只输出 context_only=false 的5个核心页对应的 JSON。若核心页开头明显承接上一批条目，用 continuation_of 指向给出的 entry id；若核心页末尾尚未完结，只输出本批实际出现的文字，留待下一批续接。",
    learningContext ? `以下是本项目由修改历史自动提炼的经验。它只用于提示可能的惯例和易错点；当前原图、人工校正文和本批 OCR 证据优先，不得机械套用：\n${learningContext}` : "",
    `输出形状：${JSON.stringify(expected)}`,
    `上一批末尾条目：${JSON.stringify(previousEntries)}`,
    `本批双 OCR 证据：${JSON.stringify(pageBundles)}`
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

export class EbookStore {
  constructor(projectsRoot, projectStore, history = null) {
    this.projectsRoot = projectsRoot;
    this.projectStore = projectStore;
    this.history = history;
    this.running = new Set();
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
      context_overlap: DEFAULT_CONTEXT_OVERLAP
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
    await this.projectStore.index(id);
    const before = await fs.readFile(this.filename(id), "utf8").then(JSON.parse).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    migrateLegacyNotePositions(normalizeDocumentHeadings(document));
    validateEbook(document, id);
    document.generation = { ...document.generation, updated_at: now() };
    await atomicJson(this.filename(id), document);
    await this.history?.recordChange({ projectId: id, target: { kind: "ebook" }, before, after: document,
      actor: audit.actor || "human", source: audit.source || "ebook-json-editor", operation: "edit_ebook",
      note: audit.note || "", metadata: audit.metadata || {} });
    return { document, config: this.config() };
  }

  async run(projectId, options = {}) {
    const id = safeId(projectId);
    if (this.running.has(id)) throw Object.assign(new Error("该项目的诗歌类古籍结构化任务正在运行"), { status: 409 });
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
      const model = asText(options.model) || config.model;
      const force = Boolean(options.force);
      document = (await this.read(id)).document;
      const learningContext = await this.history?.aiContext(id) || "";
      const documentBeforeRun = structuredClone(document);

      if (force) {
        document.entries = document.entries.filter(entry => !entry.source_pages.some(page => page >= start && page <= end));
        document.issues = document.issues.filter(issue => !issue.source_pages.some(page => page >= start && page <= end));
      } else if (document.generation?.status === "complete" &&
                 document.source?.page_range?.start === start && document.source?.page_range?.end === end &&
                 resultIds.join(",") === (document.source?.result_ids || []).join(",")) {
        return { document, config };
      }

      const resumeAt = !force && ["failed", "running"].includes(document.generation?.status) &&
        document.source?.page_range?.start === start && document.source?.page_range?.end === end &&
        resultIds.join(",") === (document.source?.result_ids || []).join(",")
          ? Math.max(start, (document.generation.completed_through || start - 1) + 1)
          : start;

      runRecord = await this.history?.startRun(id, {
        actor: "ai:siliconflow", source: "deepseek-structure", provider: "siliconflow", model,
        note: force ? "覆盖指定页范围重新结构化" : "分批结构化",
        options: { result_ids: resultIds, start_page: start, end_page: end, force,
          chunk_size: DEFAULT_CHUNK_SIZE, context_overlap: DEFAULT_CONTEXT_OVERLAP },
        input: { document: documentBeforeRun, learning_context: learningContext }
      });

      const beforeStart = documentBeforeRun;
      document.source = { result_ids: resultIds, page_range: { start, end } };
      document.generation = {
        provider: "siliconflow",
        model,
        status: "running",
        chunk_size: DEFAULT_CHUNK_SIZE,
        context_overlap: DEFAULT_CONTEXT_OVERLAP,
        completed_through: resumeAt - 1,
        chunks: resumeAt === start ? [] : (document.generation.chunks || []),
        started_at: now(),
        updated_at: now(),
        error: ""
      };
      await atomicJson(this.filename(id), document);
      await this.history?.recordChange({ projectId: id, target: { kind: "ebook" }, before: beforeStart, after: document,
        actor: "ai:siliconflow", source: "deepseek-structure", operation: "run_started",
        note: force ? "DeepSeek 覆盖重跑开始" : "DeepSeek 整理开始", runId: runRecord?.id,
        metadata: { start_page: start, end_page: end, force } });

      const resultMaps = loaded.map(result => new Map(result.pages.map(page => [page.page_number, page])));
      for (let pageStart = resumeAt; pageStart <= end; pageStart += DEFAULT_CHUNK_SIZE) {
        const pageEnd = Math.min(end, pageStart + DEFAULT_CHUNK_SIZE - 1);
        const contextStart = Math.max(1, pageStart - DEFAULT_CONTEXT_OVERLAP);
        const contextEnd = Math.min(pageCount, pageEnd + DEFAULT_CONTEXT_OVERLAP);
        const bundles = [];
        for (let pageNumber = contextStart; pageNumber <= contextEnd; pageNumber += 1) {
          bundles.push({
            page_number: pageNumber,
            context_only: pageNumber < pageStart || pageNumber > pageEnd,
            results: resultIds.map((resultId, index) => ({
              result_id: resultId,
              ...pageEvidence(resultMaps[index].get(pageNumber) || { page_number: pageNumber, regions: [] })
            }))
          });
        }
        const previousEntries = document.entries.slice(-2).map(entry => ({
          id: entry.id, kind: entry.kind, title: entry.title, lines: entry.lines.slice(-4),
          prose_tail: entry.prose.slice(-180), source_pages: entry.source_pages
        }));
        const messages = [
          { role: "system", content: "你是中国诗歌类古籍整理专家，只返回符合要求的 JSON 对象。" },
          { role: "user", content: buildEbookPrompt(project.title, bundles, previousEntries, learningContext) }
        ];
        const response = await siliconFlowRequest({
          apiKey: process.env.SILICONFLOW_API_KEY,
          baseUrl: config.base_url,
          model,
          maxTokens: Math.max(1024, Number(process.env.SILICONFLOW_MAX_TOKENS) || 8192),
          messages
        });
        const parsed = parseModelJson(response.content);
        if (runRecord) {
          await this.history.recordRunStep(id, runRecord.id, {
            kind: "structure-chunk", start_page: pageStart, end_page: pageEnd,
            request: { model, messages }, response: { content: response.content, parsed, usage: response.usage }
          });
        }
        const beforeChunk = structuredClone(document);
        mergeGenerated(document, parsed, pageStart, pageEnd);
        document.generation.completed_through = pageEnd;
        document.generation.updated_at = now();
        document.generation.chunks.push({
          start_page: pageStart,
          end_page: pageEnd,
          context_start_page: contextStart,
          context_end_page: contextEnd,
          status: "complete",
          entries_returned: Array.isArray(parsed.entries) ? parsed.entries.length : 0,
          usage: response.usage,
          completed_at: now()
        });
        await atomicJson(this.filename(id), document);
        await this.history?.recordChange({ projectId: id, target: { kind: "ebook" }, before: beforeChunk, after: document,
          actor: "ai:siliconflow", source: "deepseek-structure", operation: "ai_chunk",
          note: `DeepSeek 整理第 ${pageStart}-${pageEnd} 页`, runId: runRecord?.id,
          metadata: { start_page: pageStart, end_page: pageEnd, model, result_ids: resultIds } });
      }

      const beforeComplete = structuredClone(document);
      document.generation.status = "complete";
      document.generation.updated_at = now();
      await atomicJson(this.filename(id), document);
      await this.history?.recordChange({ projectId: id, target: { kind: "ebook" }, before: beforeComplete, after: document,
        actor: "ai:siliconflow", source: "deepseek-structure", operation: "run_completed",
        note: "DeepSeek 整理完成", runId: runRecord?.id });
      if (runRecord) await this.history.finishRun(id, runRecord.id, { status: "complete", output: document });
      return { document, config };
    } catch (error) {
      if (document) {
        const beforeFailure = structuredClone(document);
        document.generation = { ...document.generation, status: "failed", error: error.message, updated_at: now() };
        await atomicJson(this.filename(id), document).catch(() => {});
        await this.history?.recordChange({ projectId: id, target: { kind: "ebook" }, before: beforeFailure, after: document,
          actor: "ai:siliconflow", source: "deepseek-structure", operation: "run_failed",
          note: error.message, runId: runRecord?.id }).catch(() => {});
      }
      if (runRecord) await this.history?.finishRun(id, runRecord.id, { status: "failed", error: error.message, output: document }).catch(() => {});
      throw error;
    } finally {
      this.running.delete(id);
    }
  }
}
