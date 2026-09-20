# oldbook-mcp

Thin MCP adapter for the oldbook candidate workflow. It calls `oldbook-server`; it never writes project JSON or duplicates approval logic.

Start the API first, then configure an MCP client to run:

```text
node E:/work/oldbook/packages/oldbook-mcp/src/server.mjs
```

Set `OLDBOOK_API_URL` when the API is not at `http://127.0.0.1:3100`.

Tools:

- `oldbook_list_candidates`: list candidate states and hashes.
- `oldbook_get_candidate`: inspect preview JSON, diff, warnings and exact hash.
- `oldbook_create_page_revision_candidate`: one-page model revision; accepted JSON is untouched.
- `oldbook_create_generation_candidate`: batch model workflow; accepted JSON is untouched.
- `oldbook_approve_candidate`: apply through the shared core transaction. Requires explicit user approval, note and matching hash.
- `oldbook_abandon_candidate`: preserve a rejected candidate and mark its decision.

An Agent should first create or select a candidate, call `oldbook_get_candidate`, summarize its scope and warnings to the user, and only call `oldbook_approve_candidate` after an explicit approval instruction. MCP approvals are audited as `actor=ai:codex`, `channel=agent`; `requested_by` records who authorized the action.
