import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HistoryStore } from "../../server/change-history.mjs";
import { atomicJson, safeId } from "../../server/project-store.mjs";
import { migrateLegacyNotePositions, validateEbook } from "../../server/ebook-store.mjs";

const projectId = process.argv[2];
if (!projectId) throw new Error("Usage: node scripts/maintenance/migrate_note_positions.mjs <project-id> [--apply]");
safeId(projectId);
const projectsRoot = fileURLToPath(new URL("../../data/projects/", import.meta.url));
const filename = path.join(projectsRoot, projectId, "ebook", "structured.json");
const document = JSON.parse(await fs.readFile(filename, "utf8"));
const originalDocument = structuredClone(document);
const legacyCount = document.entries.reduce((count, entry) => count + (entry.notes || []).filter(note => note.marker != null).length, 0);

migrateLegacyNotePositions(document);
validateEbook(document, projectId);
if (!process.argv.includes("--apply")) {
  console.log(JSON.stringify({ projectId, legacy_notes: legacyCount, mode: "dry-run", document }, null, 2));
  process.exit(0);
}
await atomicJson(filename, document);
const history = new HistoryStore(projectsRoot);
await history.recordChange({ projectId, target: { kind: "ebook" }, before: originalDocument, after: document,
  actor: "system", source: "note-position-migration", operation: "schema_migration",
  note: "迁移旧注释 marker 为 position；启发式位置仍需人工复核" });

console.log(`Migrated ${legacyCount} notes in ${filename}`);
