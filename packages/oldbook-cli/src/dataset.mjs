import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatasetStore } from "../../oldbook-core/src/dataset-store.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const store = new DatasetStore(path.join(rootDir, "data", "projects"), rootDir);

function parseArgs(values) {
  const [command, ...rest] = values;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) continue;
    options[key.slice(2)] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function required(options, name) {
  if (!options[name]) throw new Error(`Missing --${name}`);
  return options[name];
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "freeze") {
    const manifest = await store.freeze({
      projectId: required(options, "project"),
      datasetId: required(options, "id"),
      pageStart: required(options, "from"),
      pageEnd: required(options, "to"),
      resultIds: required(options, "results").split(",").map((value) => value.trim()).filter(Boolean),
      approvalStatement: required(options, "approval"),
      actor: options.actor || "human"
    });
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  if (command === "verify") {
    const result = await store.verify(required(options, "project"), required(options, "id"));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "list") {
    console.log(JSON.stringify(await store.list(required(options, "project")), null, 2));
    return;
  }
  throw new Error("Usage: dataset.mjs freeze|verify|list --project <id> [options]");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
