import fs from "node:fs/promises";
import path from "node:path";
import { HistoryStore } from "../server/change-history.mjs";
import { migrateLegacyNotePositions, validateEbook } from "../server/ebook-store.mjs";

const projectId = process.argv[2];
if (!projectId) throw new Error("Usage: node scripts/migrate_note_positions.mjs <project-id>");
const filename = path.resolve("data", "projects", projectId, "ebook", "structured.json");
const document = JSON.parse(await fs.readFile(filename, "utf8"));
const originalDocument = structuredClone(document);
const legacyCount = document.entries.reduce((count, entry) => count + (entry.notes || []).filter(note => note.marker != null).length, 0);

migrateLegacyNotePositions(document);
validateEbook(document, projectId);
await fs.writeFile(filename, `${JSON.stringify(document, null, 2)}\n`, "utf8");
const history = new HistoryStore(path.resolve("data", "projects"));
await history.recordChange({ projectId, target: { kind: "ebook" }, before: originalDocument, after: document,
  actor: "system", source: "note-position-migration", operation: "schema_migration",
  note: "迁移旧注释 marker 为精确 position" });

console.log(`Migrated ${legacyCount} notes in ${filename}`);
