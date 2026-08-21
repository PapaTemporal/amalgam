<!-- amalgam-begin -->
## Local offload (amalgam MCP)

A local MCP server "amalgam" provides long-term memory and context offload.
All services are on 127.0.0.1 — never substitute cloud services.

- Session start: call `memory_persona_read`, then `memory_recall` with task keywords.
- Prefer `graph_query` (explain/path/query) over reading files in repos with a built graph.
- Save durable facts with `memory_save_fact` (terse, dense wording; keep names/paths/commands exact).
- Update project context with `memory_context_write`; `caveman_compress`/`caveman_expand` translate between dense storage form and readable English.
- If tools error "unreachable", ask the user to run: `amalgam start`.
<!-- amalgam-end -->
