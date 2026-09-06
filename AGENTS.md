# Project JSON change protocol

This repository treats OCR corrections and ebook structuring edits as training evidence for later AI work.

Before directly editing any managed file under `data/projects/<project-id>/`:

- `project.json`
- `results/*.json`
- `ebook/structured.json`

run:

```powershell
node packages/oldbook-cli/src/history.mjs begin --project <project-id> --actor ai:codex --source codex-direct-edit --note "concise purpose"
```

After all related files are valid JSON and the edit is complete, run:

```powershell
node packages/oldbook-cli/src/history.mjs commit --project <project-id>
```

Always read `data/projects/<project-id>/ai-memory/AI_CONTEXT.md` before correcting OCR or ebook structure when it exists. Treat it as project-specific hints, not authority: page images and explicit human corrections remain the highest evidence. Do not edit `history/` or `ai-memory/` by hand; both are maintained from the append-only event stream.

If a change was already made without `begin`, attribute it immediately with:

```powershell
node packages/oldbook-cli/src/history.mjs reconcile --project <project-id> --actor ai:codex --source codex-direct-edit --note "concise purpose"
```

## Frozen datasets

Treat every directory under `data/projects/<project-id>/datasets/<dataset-id>/` as immutable evidence. Never edit, regenerate, or delete files inside an existing dataset directory. Check integrity with:

```powershell
npm run dataset:verify -- --project <project-id> --id <dataset-id>
```

When the accepted scope or source data changes, create a new dataset ID with `npm run dataset:freeze`; do not overwrite the previous version. Automatic links in `links.json` are navigation and review aids, not human-confirmed transcription labels.
