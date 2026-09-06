# oldbook-server

Runtime adapters for the oldbook workflow.

- `src/index.mjs` exposes the existing local Express API.
- `remote/` contains the optional native PaddleOCR-VL HTTP service.

The server owns transport and environment configuration; reusable workflow behavior remains in `oldbook-core`.
