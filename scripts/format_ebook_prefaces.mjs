import fs from "node:fs/promises";
import path from "node:path";
import { buildClassicalProsePrompt } from "../server/classical-prose-prompt.mjs";
import { projectFormatting, textSignature } from "../server/text-formatting.mjs";

const projectId = process.argv[2] || "yiyuji-four-volumes";
const kindsArgument = process.argv.find(argument => argument.startsWith("--kinds="));
const selectedKinds = new Set(
  (kindsArgument?.slice("--kinds=".length) || "preface,biography")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
);
const root = path.resolve(".");
for (const envFile of [".env.local", ".env"]) {
  try { process.loadEnvFile(path.join(root, envFile)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

const apiKey = process.env.SILICONFLOW_API_KEY;
const baseUrl = (process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1").replace(/\/$/, "");
const model = process.env.SILICONFLOW_MODEL || "deepseek-ai/DeepSeek-V3.2";
const filename = path.join(root, "data", "projects", projectId, "ebook", "structured.json");

if (!apiKey) throw new Error("SILICONFLOW_API_KEY is not configured");

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

async function request(entry) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "你是古籍整理与文言句读专家。只做标点和分段，不改变原文文字。" },
        { role: "user", content: buildClassicalProsePrompt(entry) }
      ],
      temperature: 0,
      max_tokens: 8192,
      enable_thinking: false,
      response_format: { type: "json_object" }
    }),
    signal: AbortSignal.timeout(180_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || body.message || `HTTP ${response.status}`);
  return parseJson(body.choices?.[0]?.message?.content);
}

async function formatEntry(entry) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await request({ id: entry.id, kind: entry.kind, title: entry.title, prose: entry.prose });
    const paragraphs = Array.isArray(result.paragraphs)
      ? result.paragraphs.map(value => String(value || "").trim()).filter(Boolean)
      : [];
    const formatted = paragraphs.join("\n\n");
    if (result.id === entry.id && paragraphs.length && textSignature(formatted) === textSignature(entry.prose)) {
      return { formatted, paragraphCount: paragraphs.length };
    }
    if (result.id === entry.id && paragraphs.length) {
      const projected = projectFormatting(entry.prose, formatted);
      const projectedParagraphs = projected.text.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
      if (projected.similarity >= 0.94 && projectedParagraphs.length && textSignature(projected.text) === textSignature(entry.prose)) {
        console.warn(`Projected punctuation for ${entry.id} at ${(projected.similarity * 100).toFixed(1)}% character similarity`);
        return { formatted: projected.text, paragraphCount: projectedParagraphs.length };
      }
    }
    console.warn(`Rejected ${entry.id} attempt ${attempt}: source characters or response shape changed`);
  }
  throw new Error(`Unable to punctuate ${entry.id} without changing source characters`);
}

const document = JSON.parse(await fs.readFile(filename, "utf8"));
const entries = document.entries.filter(
  entry => selectedKinds.has(entry.kind) && String(entry.prose || "").trim()
);
if (!entries.length) {
  throw new Error(`No prose entries found for kinds: ${[...selectedKinds].join(", ")}`);
}
const source = new Map(entries.map(entry => [entry.id, entry.prose]));
const report = [];

for (const entry of entries) {
  const result = await formatEntry(entry);
  entry.prose = result.formatted;
  report.push({ id: entry.id, title: entry.title, paragraphs: result.paragraphCount });
  console.log(`Formatted ${entry.id} (${entry.title}): ${result.paragraphCount} paragraphs`);
}

const invalid = entries.filter(entry => textSignature(entry.prose) !== textSignature(source.get(entry.id)));
if (invalid.length) throw new Error(`${invalid.length} prose entries failed the source-character check`);

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(path.dirname(filename), `structured.before-prose-format.${timestamp}.json`);
await fs.writeFile(backup, `${JSON.stringify(JSON.parse(await fs.readFile(filename, "utf8")), null, 2)}\n`, "utf8");
await fs.writeFile(filename, `${JSON.stringify(document, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ projectId, kinds: [...selectedKinds], model, report, backup }, null, 2));
