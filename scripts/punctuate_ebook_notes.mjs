import fs from "node:fs/promises";
import path from "node:path";
import { HistoryStore } from "../server/change-history.mjs";

const projectId = process.argv[2];
if (!projectId) throw new Error("Usage: node scripts/punctuate_ebook_notes.mjs <project-id>");
const root = path.resolve(".");
for (const envFile of [".env.local", ".env"]) {
  try { process.loadEnvFile(path.join(root, envFile)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

const apiKey = process.env.SILICONFLOW_API_KEY;
const baseUrl = (process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1").replace(/\/$/, "");
const model = process.env.SILICONFLOW_MODEL || "deepseek-ai/DeepSeek-V3.2";
const filename = path.join(root, "data", "projects", projectId, "ebook", "structured.json");
const batchSize = Math.max(1, Number(process.env.NOTE_PUNCTUATION_BATCH_SIZE) || 16);
const history = new HistoryStore(path.join(root, "data", "projects"));
const learningContext = await history.aiContext(projectId);
let runRecord;

if (!apiKey) throw new Error("SILICONFLOW_API_KEY is not configured");

function signature(value) {
  return String(value || "").normalize("NFC").replace(/[\p{P}\p{Z}\s]/gu, "");
}

function parseJson(content) {
  let source = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(source); }
  catch {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
    throw new Error("Model did not return a JSON object");
  }
}

async function request(items) {
  const prompt = [
    "为下列中国古籍注文添加现代中文标点并按句意断句。",
    "只允许添加、删除或调整标点与空白；不得增加、删除、替换、繁简转换任何文字，不得改异体字，不得解释或润色。",
    "正确识别书名、人名、篇名、引诗和按语；引用关系明确时使用冒号，引文内按句意使用逗号、句号或分号。每条注文结尾使用合适的句末标点。",
    "只返回 JSON：{\"items\":[{\"id\":\"原id\",\"text\":\"加标点后的全文\"}]}，顺序和 id 必须与输入一致。",
    learningContext ? `项目既有校订经验如下，只作一致性提示，不得改变本批原文字词：\n${learningContext}` : "",
    JSON.stringify({ items })
  ].join("\n");
  const messages = [
    { role: "system", content: "你是古籍标点校勘助手，只添加标点，不改变原文文字。" },
    { role: "user", content: prompt }
  ];
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      max_tokens: 8192,
      enable_thinking: false,
      response_format: { type: "json_object" }
    }),
    signal: AbortSignal.timeout(180_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || body.message || `HTTP ${response.status}`);
  const parsed = parseJson(body.choices?.[0]?.message?.content);
  if (runRecord) await history.recordRunStep(projectId, runRecord.id, {
    kind: "note-batch", request: { model, messages },
    response: { content: body.choices?.[0]?.message?.content, parsed, usage: body.usage || null }
  });
  return parsed.items || [];
}

async function punctuateBatch(items) {
  const output = await request(items);
  const byId = new Map(output.map(item => [item?.id, item?.text]));
  const accepted = new Map();
  const rejected = [];
  for (const item of items) {
    const candidate = byId.get(item.id);
    if (typeof candidate === "string" && signature(candidate) === signature(item.text)) accepted.set(item.id, candidate.trim());
    else rejected.push(item);
  }
  for (const item of rejected) {
    const retry = await request([item]);
    const candidate = retry.find(result => result?.id === item.id)?.text;
    if (typeof candidate !== "string" || signature(candidate) !== signature(item.text)) {
      throw new Error(`Model changed source characters for ${item.id}`);
    }
    accepted.set(item.id, candidate.trim());
  }
  return accepted;
}

const document = JSON.parse(await fs.readFile(filename, "utf8"));
const originalDocument = structuredClone(document);
runRecord = await history.startRun(projectId, {
  actor: "ai:siliconflow", source: "deepseek-note-punctuation", provider: "siliconflow", model,
  options: { batch_size: batchSize }, input: { document: originalDocument, learning_context: learningContext }
});
const references = document.entries.flatMap(entry => (entry.notes || []).map((note, index) => ({
  id: `${entry.id}:note-${index + 1}`,
  text: note.text,
  note
})));
const before = references.map(item => item.text);

for (let start = 0; start < references.length; start += batchSize) {
  const batch = references.slice(start, start + batchSize);
  const punctuated = await punctuateBatch(batch.map(({ id, text }) => ({ id, text })));
  for (const reference of batch) reference.note.text = punctuated.get(reference.id);
  console.log(`Punctuated ${Math.min(start + batch.length, references.length)} / ${references.length}`);
}

const invalid = references.filter((item, index) => signature(item.note.text) !== signature(before[index]));
if (invalid.length) throw new Error(`${invalid.length} notes failed the source-character check`);

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(path.dirname(filename), `structured.before-note-punctuation.${timestamp}.json`);
await fs.writeFile(backup, `${JSON.stringify(JSON.parse(await fs.readFile(filename, "utf8")), null, 2)}\n`, "utf8");
await fs.writeFile(filename, `${JSON.stringify(document, null, 2)}\n`, "utf8");
await history.recordChange({ projectId, target: { kind: "ebook" }, before: originalDocument, after: document,
  actor: "ai:siliconflow", source: "deepseek-note-punctuation", operation: "ai_note_punctuation",
  note: "DeepSeek 注文标点", runId: runRecord.id, metadata: { model, notes: references.length } });
await history.finishRun(projectId, runRecord.id, { status: "complete", output: document });

console.log(JSON.stringify({ projectId, model, notes: references.length, backup }, null, 2));
