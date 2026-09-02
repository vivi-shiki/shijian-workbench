import fs from "node:fs/promises";
import path from "node:path";
import { migrateLegacyNotePositions, validateEbook } from "../server/ebook-store.mjs";

const projectId = process.argv[2] || "yiyuji-four-volumes";
const filename = path.resolve("data", "projects", projectId, "ebook", "structured.json");
const document = JSON.parse(await fs.readFile(filename, "utf8"));
const legacyCount = document.entries.reduce((count, entry) => count + (entry.notes || []).filter(note => note.marker != null).length, 0);

migrateLegacyNotePositions(document);
validateEbook(document, projectId);
await fs.writeFile(filename, `${JSON.stringify(document, null, 2)}\n`, "utf8");

console.log(`Migrated ${legacyCount} notes in ${filename}`);
