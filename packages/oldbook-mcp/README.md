# oldbook-mcp

Reserved adapter boundary for exposing the oldbook workflow as MCP resources and tools. No MCP server is implemented in the current product, so this module intentionally contains documentation only.

Future MCP code should delegate to `oldbook-core` or `oldbook-server` and must not duplicate domain rules or bypass approval checks.
