# Modules

The repository is organized into six logical modules. They remain in one package and share the root dependency installation so this reorganization does not change runtime behavior.

- `oldbook-core`: reusable project, ebook, candidate, validation, and history logic.
- `oldbook-cli`: command-line orchestration, OCR utilities, maintenance commands, and samples.
- `oldbook-server`: the local HTTP API and the optional remote OCR service.
- `oldbook-mcp`: reserved boundary for a future MCP adapter; no MCP runtime is implemented yet.
- `oldbook-skills`: repository copies of agent instructions.
- `oldbook-review`: the React/Vite review workbench.

Dependencies point inward: review, CLI, server, and future MCP adapters may use core; core does not import those adapters.
