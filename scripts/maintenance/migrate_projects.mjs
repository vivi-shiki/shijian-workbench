import fs from "node:fs/promises";
import { ProjectStore } from "../../server/project-store.mjs";
const root = new URL("../../data/projects/", import.meta.url);
const { fileURLToPath } = await import("node:url");
const store = new ProjectStore(fileURLToPath(root));
for (const entry of await fs.readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try {
    const project = await store.migrate(entry.name, process.argv.includes("--archive-existing"));
    console.log(`${project.id}: archived=${project.archived}, results=${project.results.map(r => r.label).join(", ")}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
