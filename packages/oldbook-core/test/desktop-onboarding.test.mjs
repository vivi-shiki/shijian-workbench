import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { previewSources, createImportedProject, installSampleProject, checkModelConnection,
  createSourceAdapters, createSampleProject } from "../src/desktop-onboarding.mjs";

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oldbook-onboarding-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function sourceAdapters() {
  return {
    inspectPdf: async (filename) => ({ pages: filename.endsWith("first.pdf") ? 2 : 3, bytes: 100 }),
    inspectImage: async () => ({ width: 1200, height: 1800, bytes: 50 }),
    renderPdfPage: async (_filename, page) => ({ bytes: Buffer.from(`page ${page}`), width: 1200, height: 1800 }),
    readImage: async () => ({ bytes: Buffer.from("image"), width: 1200, height: 1800 })
  };
}

test("PDF volumes retain the chosen order and the preview gives honest estimates", async () => {
  const plan = await previewSources([
    { kind: "pdf", path: "C:/books/second.pdf" },
    { kind: "pdf", path: "C:/books/first.pdf" }
  ], { ...sourceAdapters(), secondsPerPage: 4 });
  assert.equal(plan.page_count, 5);
  assert.deepEqual(plan.volumes.map(item => [item.path, item.first_page, item.last_page]), [
    ["C:/books/second.pdf", 1, 3], ["C:/books/first.pdf", 4, 5]
  ]);
  assert.equal(plan.estimated_seconds, 20);
  assert.ok(plan.required_bytes >= plan.input_bytes);

  const unknown = await previewSources([{ kind: "image", path: "C:/books/page.png" }], sourceAdapters());
  assert.equal(unknown.estimated_seconds, null);
});

test("image import handles individual images and rejects broken files before creating a project", async (t) => {
  const root = await workspace(t);
  const adapters = sourceAdapters();
  const plan = await previewSources([
    { kind: "image", path: "C:/books/001.png" },
    { kind: "image", path: "C:/books/002.png" }
  ], adapters);
  assert.equal(plan.page_count, 2);
  const project = await createImportedProject({ root, id: "new-book", title: "新书", plan, adapters });
  assert.equal(project.source.pages.length, 2);
  assert.deepEqual(project.source.pages.map(page => page.page_number), [1, 2]);
  assert.equal((await fs.readdir(path.join(root, "new-book", "pages"))).length, 2);
  await assert.rejects(previewSources([{ kind: "image", path: "broken.png" }], {
    ...adapters, inspectImage: async () => { throw new Error("invalid image"); }
  }), /invalid image/);
  await assert.rejects(fs.stat(path.join(root, "broken-book")), { code: "ENOENT" });
});

test("failed or cancelled import cannot leave a usable partial project", async (t) => {
  const root = await workspace(t);
  const adapters = sourceAdapters();
  const plan = await previewSources([{ kind: "pdf", path: "C:/books/first.pdf" }], adapters);
  await assert.rejects(createImportedProject({ root, id: "failed-book", title: "失败", plan,
    adapters: { ...adapters, renderPdfPage: async (_name, page) => {
      if (page === 2) throw new Error("renderer failed");
      return adapters.renderPdfPage(_name, page);
    } }
  }), /renderer failed/);
  await assert.rejects(fs.stat(path.join(root, "failed-book", "project.json")), { code: "ENOENT" });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createImportedProject({ root, id: "cancelled-book", title: "取消", plan,
    adapters, signal: controller.signal }), /abort/i);
  await assert.rejects(fs.stat(path.join(root, "cancelled-book", "project.json")), { code: "ENOENT" });
});

test("sample project opens without a model setting and never overwrites an existing project", async (t) => {
  const root = await workspace(t);
  const sample = path.join(root, "sample-source");
  await fs.mkdir(sample);
  await fs.writeFile(path.join(sample, "project.json"), JSON.stringify({ schema_version: 2, id: "sample", title: "示例", archived: false, results: [] }));
  const installed = await installSampleProject({ root, sampleDirectory: sample, id: "sample" });
  assert.equal(installed.title, "示例");
  await assert.rejects(installSampleProject({ root, sampleDirectory: sample, id: "sample" }), /exist|已存在/i);
});

test("model connection check reports wrong credentials and outages without returning the secret", async () => {
  const key = "sk-private-demo-key";
  const good = await checkModelConnection({ baseUrl: "https://model.example/v1", apiKey: key,
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${key}`);
      return { ok: true, status: 200 };
    } });
  assert.equal(good.ok, true);
  assert.ok(!JSON.stringify(good).includes(key));
  const invalid = await checkModelConnection({ baseUrl: "https://model.example/v1", apiKey: key,
    fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid_credentials");
  const offline = await checkModelConnection({ baseUrl: "https://model.example/v1", apiKey: key,
    fetchImpl: async () => { throw new Error("network unavailable"); } });
  assert.equal(offline.reason, "unavailable");
  assert.ok(!JSON.stringify(offline).includes(key));
});

test("built-in PDF renderer imports a real one-page PDF without Python", async (t) => {
  const root = await workspace(t);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const filename = path.join(root, "one.pdf");
  await fs.writeFile(filename, pdf);
  const plan = await previewSources([{ kind: "pdf", path: filename }]);
  assert.equal(plan.page_count, 1);
  const project = await createImportedProject({ root, id: "one-page", title: "一页书", plan,
    adapters: createSourceAdapters() });
  const image = await fs.readFile(path.join(root, "one-page", "pages", "page-001.png"));
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(project.source.pages[0].width, 134);
});

test("generated sample contains an image, OCR evidence and a readable poem", async (t) => {
  const root = await workspace(t);
  const project = await createSampleProject(root);
  const ebook = JSON.parse(await fs.readFile(path.join(root, project.id, "ebook", "structured.json"), "utf8"));
  const result = JSON.parse(await fs.readFile(path.join(root, project.id, "results", "source.json"), "utf8"));
  assert.equal(ebook.entries[0].kind, "poem");
  assert.equal(ebook.entries[0].lines.length, 4);
  assert.equal(result.pages[0].regions.length, 5);
});
