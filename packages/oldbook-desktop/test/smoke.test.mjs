import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("the packaged desktop entry starts its API and opens a window", { timeout: 45_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oldbook-electron-smoke-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "ready.json");
  const electron = path.resolve("node_modules/electron/dist/electron.exe");
  const child = spawn(electron, [".", "--smoke"], {
    cwd: path.resolve("."),
    env: { ...process.env, OLDBOOK_SMOKE_FILE: marker, OLDBOOK_DESKTOP_DATA: directory },
    stdio: "ignore",
    windowsHide: true
  });
  t.after(() => { if (child.exitCode == null) child.kill(); });
  let ready = null;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { ready = JSON.parse(await fs.readFile(marker, "utf8")); break; }
    catch { if (child.exitCode != null) break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, `Electron exited ${child.exitCode ?? "without a readiness marker"}`);
  assert.equal(ready.api_ready, true);
  assert.equal(ready.window_ready, true);
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
});
