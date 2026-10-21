import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeDesktopPaths, createApiAccessPolicy, sanitizeDiagnostics } from "../src/desktop-shell-policy.mjs";

test("project files live outside the installed application and survive a version change", () => {
  const first = makeDesktopPaths({ appData: "C:/Users/Test/AppData/Roaming/Shijian",
    documents: "D:/Books", version: "1.0.0" });
  const updated = makeDesktopPaths({ appData: "C:/Users/Test/AppData/Roaming/Shijian",
    documents: "D:/Books", version: "1.1.0" });
  assert.equal(first.projects, updated.projects);
  assert.ok(first.projects.startsWith("D:/Books"));
  assert.ok(!first.projects.includes("Program Files"));
});

test("local API refuses other browsers and limits readable data to book images", () => {
  const policy = createApiAccessPolicy({ token: "session-secret", origin: "http://127.0.0.1:40001" });
  const allowed = { origin: "http://127.0.0.1:40001", headers: { "x-oldbook-session": "session-secret" } };
  assert.equal(policy.authorize({ ...allowed, pathname: "/api/projects", method: "GET" }), true);
  assert.equal(policy.authorize({ ...allowed, pathname: "/api/projects/book/ebook", method: "PUT" }), true);
  assert.equal(policy.authorize({ ...allowed, pathname: "/data/projects/book/pages/page-001.png", method: "GET" }), true);
  assert.equal(policy.authorize({ ...allowed, pathname: "/data/projects/book/history/events.jsonl", method: "GET" }), false);
  assert.equal(policy.authorize({ ...allowed, pathname: "/data/projects/book/.env.local", method: "GET" }), false);
  assert.equal(policy.authorize({ ...allowed, pathname: "/data/projects/book/pages/../history/events.jsonl", method: "GET" }), false);
  assert.equal(policy.authorize({ ...allowed, pathname: "/api/projects/book/ebook", method: "PUT",
    headers: {} }), false);
  assert.equal(policy.authorize({ ...allowed, pathname: "/api/projects/book/ebook", method: "PUT",
    origin: "http://127.0.0.1:9999" }), false);
});

test("diagnostic export omits credentials and book content while retaining useful failures", () => {
  const report = sanitizeDiagnostics({
    app_version: "1.0.0", error: "OCR timeout", api_key: "sk-private-key",
    log: "Authorization: Bearer sk-private-key; failed at page 12",
    page_text: "这是一首私人诗歌", source_path: "C:/Users/Test/Downloads/book.pdf"
  });
  const output = JSON.stringify(report);
  assert.match(output, /OCR timeout/);
  assert.match(output, /page 12/);
  assert.ok(!output.includes("sk-private-key"));
  assert.ok(!output.includes("这是一首私人诗歌"));
  assert.ok(!output.includes("C:/Users/Test/Downloads"));
});

test("desktop package declares a production build, smoke test and installer entry point", async () => {
  const packageFile = path.resolve("package.json");
  const manifest = JSON.parse(await fs.readFile(packageFile, "utf8"));
  assert.ok(manifest.scripts["desktop:package"]);
  assert.ok(manifest.scripts["test:desktop"]);
  assert.ok(manifest.devDependencies?.electron);
  assert.ok(manifest.devDependencies?.["@electron-forge/cli"]);
  assert.ok(manifest.main?.includes("oldbook-desktop"));
});
