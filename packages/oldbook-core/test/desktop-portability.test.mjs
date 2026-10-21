import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectBackup, verifyProjectBackup, restoreProjectBackup,
  pruneBackups, migrateProjectData } from "../src/desktop-portability.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oldbook-portable-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "old", "book");
  for (const subdir of ["pages", "results", "ebook", "history", "datasets/frozen", "cache"]) {
    await fs.mkdir(path.join(project, subdir), { recursive: true });
  }
  await fs.writeFile(path.join(project, "project.json"), JSON.stringify({
    schema_version: 2, id: "book", title: "书", source: { pages: [{ page_number: 1,
      source_pdf: "C:/original/卷一.pdf", image_path: "data/projects/book/pages/page-001.png" }] }
  }));
  await fs.writeFile(path.join(project, "pages/page-001.png"), Buffer.from("image bytes"));
  await fs.writeFile(path.join(project, "results/ocr.json"), "{\"pages\":[]}");
  await fs.writeFile(path.join(project, "ebook/structured.json"), "{\"entries\":[]}");
  await fs.writeFile(path.join(project, "history/events.jsonl"), "{\"operation\":\"test\"}\n");
  await fs.writeFile(path.join(project, "datasets/frozen/manifest.json"), "{\"id\":\"frozen\"}");
  await fs.writeFile(path.join(project, "cache/temp.bin"), "throw away");
  await fs.writeFile(path.join(project, ".env.local"), "SILICONFLOW_API_KEY=sk-never-export");
  return { root, project };
}

test("backup includes evidence and history but excludes credentials and disposable cache", async (t) => {
  const { root, project } = await fixture(t);
  const backupFile = path.join(root, "book.shijian");
  const frozenBefore = await fs.readFile(path.join(project, "datasets/frozen/manifest.json"));
  const created = await createProjectBackup({ projectDirectory: project, outputFile: backupFile });
  assert.equal(created.project_id, "book");
  assert.equal((await verifyProjectBackup({ backupFile })).ok, true);
  const restoredRoot = path.join(root, "new");
  await restoreProjectBackup({ backupFile, projectsRoot: restoredRoot });
  const restored = path.join(restoredRoot, "book");
  for (const required of ["project.json", "pages/page-001.png", "results/ocr.json",
    "ebook/structured.json", "history/events.jsonl", "datasets/frozen/manifest.json"]) {
    assert.ok((await fs.stat(path.join(restored, required))).isFile(), required);
  }
  await assert.rejects(fs.stat(path.join(restored, ".env.local")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(restored, "cache/temp.bin")), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(path.join(project, "datasets/frozen/manifest.json")), frozenBefore);
});

test("restoring to another root removes stale absolute paths and never overwrites a project", async (t) => {
  const { root, project } = await fixture(t);
  const backupFile = path.join(root, "book.shijian");
  await createProjectBackup({ projectDirectory: project, outputFile: backupFile });
  const projectsRoot = path.join(root, "another-computer", "projects");
  await restoreProjectBackup({ backupFile, projectsRoot });
  const content = await fs.readFile(path.join(projectsRoot, "book", "project.json"), "utf8");
  assert.ok(!content.includes("C:/original/"));
  assert.ok(!content.includes("data/projects/book/"));
  assert.match(content, /pages\/page-001\.png/);
  await assert.rejects(restoreProjectBackup({ backupFile, projectsRoot }), /exist|已存在/i);
});

test("corrupt or interrupted restore leaves no visible partial project", async (t) => {
  const { root, project } = await fixture(t);
  const backupFile = path.join(root, "book.shijian");
  await createProjectBackup({ projectDirectory: project, outputFile: backupFile });
  const bytes = await fs.readFile(backupFile);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  const corruptFile = path.join(root, "corrupt.shijian");
  await fs.writeFile(corruptFile, bytes);
  assert.equal((await verifyProjectBackup({ backupFile: corruptFile })).ok, false);
  const projectsRoot = path.join(root, "restore-root");
  await assert.rejects(restoreProjectBackup({ backupFile: corruptFile, projectsRoot }));
  await assert.rejects(fs.stat(path.join(projectsRoot, "book", "project.json")), { code: "ENOENT" });
});

test("automatic backup retention keeps the newest files and a failed migration rolls back", async (t) => {
  const { root, project } = await fixture(t);
  const backups = path.join(root, "backups");
  await fs.mkdir(backups);
  for (const name of ["1.shijian", "2.shijian", "3.shijian"]) {
    await fs.writeFile(path.join(backups, name), name);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await pruneBackups({ directory: backups, keep: 2 });
  assert.deepEqual((await fs.readdir(backups)).sort(), ["2.shijian", "3.shijian"]);

  const before = await fs.readFile(path.join(project, "project.json"));
  await assert.rejects(migrateProjectData({ projectDirectory: project, targetVersion: 3,
    migrations: { 3: async (directory) => {
      await fs.writeFile(path.join(directory, "project.json"), "broken");
      throw new Error("migration failed");
    } }
  }), /migration failed/);
  assert.deepEqual(await fs.readFile(path.join(project, "project.json")), before);
});
