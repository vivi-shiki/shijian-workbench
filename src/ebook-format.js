const CHINESE_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const TWO_LINE_VERSE = /(绝|絕|律|排|古詩|古诗|樂府|乐府|歌行)/;
const CIRCLED_NUMBERS = [..."①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿"];

export function chineseNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return "";
  if (number < 10) return CHINESE_DIGITS[number];
  if (number < 20) return `十${number % 10 ? CHINESE_DIGITS[number % 10] : ""}`;
  if (number < 100) {
    const ones = number % 10;
    return `${CHINESE_DIGITS[Math.floor(number / 10)]}十${ones ? CHINESE_DIGITS[ones] : ""}`;
  }
  return String(number);
}

export function seriesOrdinal(index) {
  const number = chineseNumber(index);
  return number ? `其${number}` : "";
}

export function displayedSeriesTitle(title) {
  return String(title || "").replace(/[零〇一二三四五六七八九十百千两兩\d]+首$/, "");
}

export function circledNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return "";
  return CIRCLED_NUMBERS[number - 1] || `${number}\u20dd`;
}

export function displayedNoteText(text) {
  const value = String(text || "").trim();
  return value && !/[。！？!?…][”’」』》）】]?$/.test(value) ? `${value}。` : value;
}

export function proseParagraphs(prose) {
  return String(prose || "").split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
}

export function poemParagraphs(lines, form) {
  const normalized = (Array.isArray(lines) ? lines : []).map((text, index) => ({ text, line: index + 1 }));
  if (!TWO_LINE_VERSE.test(form || "")) return normalized.map(line => [line]);
  const paragraphs = [];
  for (let index = 0; index < normalized.length; index += 2) {
    paragraphs.push(normalized.slice(index, index + 2));
  }
  return paragraphs;
}

export function annotatedTextSegments(text, notes, field, line = null) {
  const characters = [...String(text || "")];
  const callouts = (Array.isArray(notes) ? notes : []).flatMap((note, index) => {
    const position = note?.position;
    if (position?.field !== field || (field === "lines" && position.line !== line)) return [];
    const offset = Number(position.offset);
    return Number.isInteger(offset) && offset >= 0 && offset <= characters.length
      ? [{ offset, number: index + 1 }]
      : [];
  }).sort((a, b) => a.offset - b.offset || a.number - b.number);

  const segments = [];
  let cursor = 0;
  for (const callout of callouts) {
    if (callout.offset > cursor) segments.push({ text: characters.slice(cursor, callout.offset).join("") });
    segments.push({ noteNumber: callout.number });
    cursor = callout.offset;
  }
  if (cursor < characters.length) segments.push({ text: characters.slice(cursor).join("") });
  return segments;
}
