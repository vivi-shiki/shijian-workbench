import readline from "node:readline";

const apiBase = (process.env.OLDBOOK_API_URL || "http://127.0.0.1:3100").replace(/\/$/, "");

const tools = [
  {
    name: "oldbook_list_candidates",
    description: "List ebook candidates and their approval state. This never changes project data.",
    inputSchema: { type: "object", additionalProperties: false, required: ["project_id"], properties: {
      project_id: { type: "string" }, state: { type: "string", enum: ["awaiting_approval", "approved", "abandoned"] },
      limit: { type: "integer", minimum: 1, maximum: 200 }
    } }
  },
  {
    name: "oldbook_get_candidate",
    description: "Read one candidate, its exact hash, warnings, diff, and preview document. This never changes project data.",
    inputSchema: { type: "object", additionalProperties: false, required: ["project_id", "run_id"], properties: {
      project_id: { type: "string" }, run_id: { type: "string" }
    } }
  },
  {
    name: "oldbook_create_page_revision_candidate",
    description: "Call the configured external model once to create a page revision candidate. It does not modify the accepted ebook.",
    inputSchema: { type: "object", additionalProperties: false, required: ["project_id", "page_number", "manual_prompt"], properties: {
      project_id: { type: "string" }, page_number: { type: "integer", minimum: 1 }, manual_prompt: { type: "string", minLength: 1 }
    } }
  },
  {
    name: "oldbook_create_generation_candidate",
    description: "Run the external-model structuring workflow and save only a candidate. This can incur model cost and never auto-approves.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["project_id", "result_ids", "start_page", "end_page"], properties: {
        project_id: { type: "string" }, result_ids: { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } },
        start_page: { type: "integer", minimum: 1 }, end_page: { type: "integer", minimum: 1 },
        model: { type: "string" }, pipeline: { type: "string" }, chunk_size: { type: "integer", minimum: 1, maximum: 20 },
        force: { type: "boolean" }
      } }
  },
  {
    name: "oldbook_approve_candidate",
    description: "Apply a reviewed candidate through the same transaction as the web UI. Call only after explicit user approval; copy candidate_hash from oldbook_get_candidate and provide the user's approval scope in note.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["project_id", "run_id", "candidate_hash", "note"], properties: {
        project_id: { type: "string" }, run_id: { type: "string" }, candidate_hash: { type: "string", minLength: 16 },
        note: { type: "string", minLength: 1 }, requested_by: { type: "string" }
      } }
  },
  {
    name: "oldbook_abandon_candidate",
    description: "Mark an unapproved candidate as abandoned while preserving all evidence and artifacts.",
    inputSchema: { type: "object", additionalProperties: false, required: ["project_id", "run_id", "note"], properties: {
      project_id: { type: "string" }, run_id: { type: "string" }, note: { type: "string", minLength: 1 },
      requested_by: { type: "string" }
    } }
  }
];

function candidateUrl(projectId, suffix = "") {
  return `${apiBase}/api/projects/${encodeURIComponent(projectId)}/ebook/candidates${suffix}`;
}

async function request(url, { method = "GET", body, requestedBy = "unspecified" } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Oldbook-Actor": "ai:codex",
      "X-Oldbook-Source": "oldbook-mcp",
      "X-Oldbook-Channel": "agent",
      "X-Oldbook-Requested-By": requestedBy
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(300_000)
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { payload = { error: raw || `HTTP ${response.status}` }; }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function callTool(name, args = {}) {
  const run = args.run_id ? `/${encodeURIComponent(args.run_id)}` : "";
  if (name === "oldbook_list_candidates") {
    const query = new URLSearchParams();
    if (args.state) query.set("state", args.state);
    if (args.limit) query.set("limit", String(args.limit));
    return request(`${candidateUrl(args.project_id)}${query.size ? `?${query}` : ""}`);
  }
  if (name === "oldbook_get_candidate") return request(candidateUrl(args.project_id, run));
  if (name === "oldbook_create_page_revision_candidate") {
    return request(`${apiBase}/api/projects/${encodeURIComponent(args.project_id)}/ebook/revise-page`, {
      method: "POST", body: { page_number: args.page_number, manual_prompt: args.manual_prompt }
    });
  }
  if (name === "oldbook_create_generation_candidate") {
    const { project_id: _projectId, ...body } = args;
    return request(`${apiBase}/api/projects/${encodeURIComponent(args.project_id)}/ebook/run`, { method: "POST", body });
  }
  if (name === "oldbook_approve_candidate") {
    return request(candidateUrl(args.project_id, `${run}/approve`), { method: "POST", requestedBy: args.requested_by,
      body: { candidate_hash: args.candidate_hash, note: args.note, channel: "agent", requested_by: args.requested_by || "unspecified" } });
  }
  if (name === "oldbook_abandon_candidate") {
    return request(candidateUrl(args.project_id, `${run}/abandon`), { method: "POST", requestedBy: args.requested_by,
      body: { note: args.note, channel: "agent", requested_by: args.requested_by || "unspecified" } });
  }
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0" || message.id === undefined) return;
  try {
    let result;
    if (message.method === "initialize") {
      result = { protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: "oldbook-mcp", version: "0.1.0" },
        instructions: "Generate and inspect candidates freely. Approve only after explicit user approval and always pass the reviewed candidate_hash." };
    } else if (message.method === "ping") result = {};
    else if (message.method === "tools/list") result = { tools };
    else if (message.method === "tools/call") {
      try {
        const payload = await callTool(message.params?.name, message.params?.arguments || {});
        result = { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
      } catch (error) {
        result = { isError: true, content: [{ type: "text", text: error.message }] };
      }
    } else throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: error.code || -32603, message: error.message } });
  }
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", line => {
  if (!line.trim()) return;
  try { void handle(JSON.parse(line)); }
  catch (error) { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } }); }
});
