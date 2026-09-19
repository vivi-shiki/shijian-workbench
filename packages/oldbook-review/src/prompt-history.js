const STORAGE_PREFIX = "oldbook.revision-prompt-history.v1";
const MAX_STORED_PROMPTS = 50;

function storageKey(projectId) {
  return `${STORAGE_PREFIX}:${projectId || "default"}`;
}

function normalizedRecords(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((record) => {
    const prompt = typeof record === "string" ? record.trim() : String(record?.prompt || "").trim();
    if (!prompt) return [];
    return [{ prompt, used_at: typeof record === "object" ? record.used_at || null : null }];
  });
}

export function readPromptHistory(projectId, storage = globalThis.localStorage) {
  if (!storage) return [];
  try {
    return normalizedRecords(JSON.parse(storage.getItem(storageKey(projectId)) || "[]"));
  } catch {
    return [];
  }
}

export function rememberPrompt(projectId, value, storage = globalThis.localStorage) {
  const prompt = String(value || "").trim();
  if (!prompt || !storage) return readPromptHistory(projectId, storage);
  const records = readPromptHistory(projectId, storage).filter((record) => record.prompt !== prompt);
  const next = [{ prompt, used_at: new Date().toISOString() }, ...records].slice(0, MAX_STORED_PROMPTS);
  try { storage.setItem(storageKey(projectId), JSON.stringify(next)); }
  catch { return records; }
  return next;
}

export function recentPrompts(projectId, limit = 10, storage = globalThis.localStorage) {
  return readPromptHistory(projectId, storage).slice(0, Math.max(0, limit));
}
