import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { safeId } from "./project-store.mjs";

const MAGIC = Buffer.from("SHIJIAN1");
const COPY_BUFFER = Buffer.alloc(1024 * 1024);
const EXCLUDED = new Set(["cache", "node_modules", ".env", ".env.local", ".DS_Store"]);

function inside(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === ".." || part === ".")) {
    throw new Error("Invalid backup path");
  }
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Backup path escapes project");
  return resolved;
}

async function listFiles(root, current = "") {
  const files = [];
  for (const entry of await fs.readdir(path.join(root, current), { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name) || entry.name.startsWith(".tmp-")) continue;
    const relative = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink cannot be backed up: ${relative}`);
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile()) files.push(relative.replaceAll("\\", "/"));
  }
  return files.sort();
}

async function digest(filename) {
  const handle = await fs.open(filename, "r");
  const hash = crypto.createHash("sha256");
  let size = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(COPY_BUFFER, 0, COPY_BUFFER.length, null);
      if (!bytesRead) break;
      hash.update(COPY_BUFFER.subarray(0, bytesRead));
      size += bytesRead;
    }
  } finally { await handle.close(); }
  return { size, sha256: hash.digest("hex") };
}

async function copyRange(source, target, offset, size) {
  let copied = 0;
  while (copied < size) {
    const { bytesRead } = await source.read(COPY_BUFFER, 0, Math.min(COPY_BUFFER.length, size - copied), offset + copied);
    if (!bytesRead) throw new Error("Backup ended unexpectedly");
    await target.write(COPY_BUFFER, 0, bytesRead);
    copied += bytesRead;
  }
}

async function sourceExtras(projectDirectory, project) {
  const extras = [];
  const paths = new Set([
    ...(project.source?.volumes || []).map(volume => volume.path),
    ...(project.source?.pages || []).map(page => page.source_pdf)
  ].filter(value => typeof value === "string" && path.isAbsolute(value)));
  let index = 0;
  for (const original of paths) {
    if (!/\.(pdf|png|jpe?g|webp|bmp|tiff?)$/i.test(original)) continue;
    const stat = await fs.stat(original).catch(() => null);
    if (!stat?.isFile()) continue;
    const basename = path.basename(original).replace(/[^\p{L}\p{N}._-]/gu, "_");
    const relative = `sources/${String(++index).padStart(3, "0")}-${basename}`;
    extras.push({ original, relative });
  }
  return extras;
}

export async function createProjectBackup({ projectDirectory, outputFile }) {
  const root = path.resolve(projectDirectory);
  const project = JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8"));
  safeId(project.id);
  const filePaths = (await listFiles(root)).map(relative => ({ relative, original: inside(root, relative) }));
  const extras = await sourceExtras(root, project);
  filePaths.push(...extras);
  const files = [];
  for (const item of filePaths) files.push({ path: item.relative, ...await digest(item.original) });
  const manifest = { schema_version: 1, project_id: project.id, created_at: new Date().toISOString(),
    files, external_sources: extras.map(item => ({ original: item.original, archived: item.relative })) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(manifestBytes.length));
  const stage = `${outputFile}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  const output = await fs.open(stage, "wx");
  try {
    await output.write(MAGIC);
    await output.write(length);
    await output.write(manifestBytes);
    for (const item of filePaths) {
      const source = await fs.open(item.original, "r");
      try { await copyRange(source, output, 0, files.find(file => file.path === item.relative).size); }
      finally { await source.close(); }
    }
    await output.sync();
  } catch (error) {
    await output.close();
    await fs.rm(stage, { force: true });
    throw error;
  }
  await output.close();
  try {
    await fs.access(outputFile);
    throw new Error(`Backup already exists: ${outputFile}`);
  } catch (error) { if (error.code !== "ENOENT") { await fs.rm(stage, { force: true }); throw error; } }
  await fs.rename(stage, outputFile);
  return { project_id: project.id, files: files.length, bytes: (await fs.stat(outputFile)).size, output_file: outputFile };
}

async function openManifest(handle) {
  const header = Buffer.alloc(MAGIC.length + 8);
  const { bytesRead } = await handle.read(header, 0, header.length, 0);
  if (bytesRead !== header.length || !header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Invalid backup header");
  const length = Number(header.readBigUInt64BE(MAGIC.length));
  if (!Number.isSafeInteger(length) || length < 2 || length > 32 * 1024 * 1024) throw new Error("Invalid manifest length");
  const bytes = Buffer.alloc(length);
  if ((await handle.read(bytes, 0, length, header.length)).bytesRead !== length) throw new Error("Incomplete backup manifest");
  const manifest = JSON.parse(bytes.toString("utf8"));
  safeId(manifest.project_id);
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.files)) throw new Error("Unsupported backup format");
  const seen = new Set();
  for (const file of manifest.files) {
    inside("C:/backup-root", file.path);
    if (seen.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("Invalid backup manifest entry");
    }
    seen.add(file.path);
  }
  if (!seen.has("project.json")) throw new Error("Backup lacks project.json");
  return { manifest, offset: header.length + length };
}

async function inspectBackup(backupFile) {
  const handle = await fs.open(backupFile, "r");
  try {
    const { manifest, offset } = await openManifest(handle);
    let position = offset;
    for (const file of manifest.files) {
      const hash = crypto.createHash("sha256");
      let remaining = file.size;
      while (remaining > 0) {
        const { bytesRead } = await handle.read(COPY_BUFFER, 0, Math.min(remaining, COPY_BUFFER.length), position);
        if (!bytesRead) throw new Error(`Backup truncated at ${file.path}`);
        hash.update(COPY_BUFFER.subarray(0, bytesRead));
        remaining -= bytesRead;
        position += bytesRead;
      }
      if (hash.digest("hex") !== file.sha256) throw new Error(`Backup checksum mismatch: ${file.path}`);
    }
    if ((await handle.stat()).size !== position) throw new Error("Unexpected trailing backup data");
    return { manifest, offset };
  } finally { await handle.close(); }
}

export async function verifyProjectBackup({ backupFile }) {
  try {
    const { manifest } = await inspectBackup(backupFile);
    return { ok: true, project_id: manifest.project_id, files: manifest.files.length };
  } catch (error) { return { ok: false, error: error.message }; }
}

function relinkProject(value, projectId, extras) {
  const mapping = new Map(extras.map(item => [item.original, item.archived]));
  function visit(node, key = "") {
    if (Array.isArray(node)) return node.map(item => visit(item));
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, visit(v, k)]));
    if (typeof node !== "string") return node;
    if (mapping.has(node)) return mapping.get(node);
    if (node.startsWith(`data/projects/${projectId}/`)) return node.slice(`data/projects/${projectId}/`.length);
    if (key === "source_pdf" || (key === "path" && path.isAbsolute(node))) return null;
    if (node.startsWith(`/data/projects/${projectId}/`)) return node;
    return node;
  }
  return visit(value);
}

export async function restoreProjectBackup({ backupFile, projectsRoot }) {
  const { manifest, offset } = await inspectBackup(backupFile);
  const root = path.resolve(projectsRoot);
  const target = path.join(root, manifest.project_id);
  const stage = path.join(root, `.${manifest.project_id}.${crypto.randomUUID()}.tmp`);
  await fs.mkdir(root, { recursive: true });
  try { await fs.access(target); throw new Error(`Project already exists: ${manifest.project_id}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.mkdir(stage);
  const source = await fs.open(backupFile, "r");
  try {
    let position = offset;
    for (const file of manifest.files) {
      const filename = inside(stage, file.path);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      const output = await fs.open(filename, "wx");
      try { await copyRange(source, output, position, file.size); }
      finally { await output.close(); }
      position += file.size;
    }
    const projectFile = path.join(stage, "project.json");
    const project = JSON.parse(await fs.readFile(projectFile, "utf8"));
    if (project.id !== manifest.project_id) throw new Error("Backup project identity mismatch");
    await fs.writeFile(projectFile, `${JSON.stringify(relinkProject(project, project.id, manifest.external_sources || []), null, 2)}\n`);
    await fs.rename(stage, target);
    return { project_id: manifest.project_id, directory: target };
  } catch (error) { await fs.rm(stage, { recursive: true, force: true }); throw error; }
  finally { await source.close(); }
}

export async function pruneBackups({ directory, keep = 5 }) {
  if (!Number.isInteger(keep) || keep < 0) throw new Error("Invalid backup retention count");
  const files = await Promise.all((await fs.readdir(directory)).filter(name => name.endsWith(".shijian"))
    .map(async name => ({ name, mtime: (await fs.stat(path.join(directory, name))).mtimeMs })));
  files.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  for (const file of files.slice(keep)) await fs.rm(path.join(directory, file.name));
  return { retained: Math.min(keep, files.length), removed: Math.max(0, files.length - keep) };
}

export async function migrateProjectData({ projectDirectory, targetVersion, migrations = {} }) {
  const root = path.resolve(projectDirectory);
  const project = JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8"));
  const current = Number(project.schema_version);
  if (!Number.isInteger(targetVersion) || targetVersion < current) throw new Error("Invalid migration target");
  if (targetVersion === current) return { project_id: project.id, schema_version: current };
  const stage = `${root}.${crypto.randomUUID()}.migrating`;
  const previous = `${root}.${crypto.randomUUID()}.previous`;
  await fs.cp(root, stage, { recursive: true, errorOnExist: true, force: false });
  try {
    const frozenBefore = (await listFiles(path.join(root, "datasets")).catch(() => []));
    for (let version = current + 1; version <= targetVersion; version++) {
      if (typeof migrations[version] !== "function") throw new Error(`Migration ${version} is unavailable`);
      await migrations[version](stage);
      const updated = JSON.parse(await fs.readFile(path.join(stage, "project.json"), "utf8"));
      if (updated.id !== project.id) throw new Error("Migration changed project identity");
      updated.schema_version = version;
      await fs.writeFile(path.join(stage, "project.json"), `${JSON.stringify(updated, null, 2)}\n`);
    }
    const frozenAfter = (await listFiles(path.join(stage, "datasets")).catch(() => []));
    if (JSON.stringify(frozenBefore) !== JSON.stringify(frozenAfter)) throw new Error("Migration changed frozen dataset files");
    for (const relative of frozenBefore) {
      const before = await digest(path.join(root, "datasets", relative));
      const after = await digest(path.join(stage, "datasets", relative));
      if (before.sha256 !== after.sha256) throw new Error("Migration changed frozen dataset content");
    }
    await fs.rename(root, previous);
    try { await fs.rename(stage, root); }
    catch (error) { await fs.rename(previous, root); throw error; }
    await fs.rm(previous, { recursive: true, force: true });
    return { project_id: project.id, schema_version: targetVersion };
  } catch (error) { await fs.rm(stage, { recursive: true, force: true }); throw error; }
}
