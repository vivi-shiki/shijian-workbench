import crypto from "node:crypto";

const year = /^[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]年$/u;
const punctuation = /[，。！？；]/gu;

export function normalizeVerse(value) {
  return String(value || "").normalize("NFKC").replace(/[^\p{Script=Han}]/gu, "");
}

function isVerse(line) {
  const marks = [...line.matchAll(punctuation)].length;
  return marks >= 2 && normalizeVerse(line).length >= 18;
}

export function parsePoetryReference(source, sourceName = "") {
  const lines = source.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const works = [];
  const headings = [];
  let title = "";
  let yearName = "";
  let group = 0;
  let current = null;
  const flush = () => {
    if (!current) return;
    current.text = current.parts.join("");
    delete current.parts;
    works.push(current);
    current = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index].trim();
    if (!value) continue;
    if (year.test(value)) {
      flush();
      yearName = value;
      headings.push({ kind: "year", text: value, source_line: index + 1 });
      continue;
    }
    if (isVerse(value) || (current && /^[（(]/u.test(value))) {
      const continuation = current && (/[，、；：正长]$/u.test(current.parts.at(-1)) || /^[（(]/u.test(value));
      if (continuation) {
        current.parts.push(value);
        current.source_lines[1] = index + 1;
      } else {
        flush();
        current = { id: `work-${String(works.length + 1).padStart(4, "0")}`, title,
          group_id: group,
          year: yearName, source_lines: [index + 1, index + 1], parts: [value] };
      }
      continue;
    }
    if (current && /[，、；：正长]$/u.test(current.parts.at(-1))) {
      current.parts.push(value);
      current.source_lines[1] = index + 1;
      continue;
    }
    flush();
    title = value;
    group++;
    headings.push({ kind: "title", text: value, source_line: index + 1 });
  }
  flush();
  const totals = new Map();
  for (const work of works) totals.set(work.group_id, (totals.get(work.group_id) || 0) + 1);
  const indexes = new Map();
  for (const work of works) {
    const key = work.group_id;
    work.series_index = (indexes.get(key) || 0) + 1;
    work.series_total = totals.get(key);
    indexes.set(key, work.series_index);
  }
  return { schema_version: 1, source_name: sourceName,
    source_sha256: crypto.createHash("sha256").update(source).digest("hex"),
    work_count: works.length, works, headings };
}

function dice(a, b) {
  const first = new Set();
  for (let i = 0; i < a.length - 1; i++) first.add(a.slice(i, i + 2));
  if (!first.size) return 0;
  const second = new Set();
  for (let i = 0; i < b.length - 1; i++) second.add(b.slice(i, i + 2));
  let common = 0;
  for (const pair of first) if (second.has(pair)) common++;
  return 2 * common / (first.size + second.size || 1);
}

export function findReferenceVerses(entry, reference, { limit = 3, minWork = 1, maxWork = Number.MAX_SAFE_INTEGER } = {}) {
  const verse = normalizeVerse((entry.lines || []).join(""));
  if (!verse) return [];
  const title = normalizeVerse(entry.series?.title || entry.title);
  return reference.works.filter(work => {
    const ordinal = Number(work.id.slice(5));
    return ordinal >= minWork && ordinal <= maxWork;
  }).map(work => {
    const text = normalizeVerse(work.text);
    const score = dice(verse, text) + (title && title === normalizeVerse(work.title) ? 0.05 : 0);
    return { work_id: work.id, title: work.title, series_index: work.series_index,
      source_lines: work.source_lines, text: work.text, score: Math.round(score * 1000) / 1000 };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}
