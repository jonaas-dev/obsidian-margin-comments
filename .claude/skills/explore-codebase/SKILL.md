---
name: explore-codebase
description: Navigate and understand codebase structure using the knowledge graph. Use BEFORE Grep/Glob/Read when exploring code in a repo that has a .code-review-graph/ directory.
---

## Explore Codebase

Use the code-review-graph MCP tools to explore and understand the codebase.

### When to use the graph first

Only repos with a `.code-review-graph/` directory at the git toplevel have a graph (the hooks in
`.claude/settings.json` keep it updated there and stay silent elsewhere). In those repos the graph is cheaper than scanning files and
gives callers, dependents and test coverage that Grep cannot:

- Exploring code: `semantic_search_nodes` or `query_graph` instead of Grep.
- Impact of a change: `get_impact_radius` and `get_affected_flows` instead of tracing imports by hand.
- Code review: `detect_changes` + `get_review_context` instead of reading whole files.
- Coverage: `query_graph` with `tests_for`.

Fall back to Grep/Glob/Read only when the graph does not cover what you need.

### Steps

1. Run `list_graph_stats` to see overall codebase metrics.
2. Run `get_architecture_overview` for high-level community structure.
3. Use `list_communities` to find major modules, then `get_community` for details.
4. Use `semantic_search_nodes` to find specific functions or classes.
5. Use `query_graph` with patterns like `callers_of`, `callees_of`, `imports_of` to trace relationships.
6. Use `list_flows` and `get_flow` to understand execution paths.

### Tips

- Start broad (stats, architecture) then narrow down to specific areas.
- Use `children_of` on a file to see all its functions and classes.
- Use `find_large_functions` to identify complex code.

## Token Efficiency Rules
- ALWAYS start with `get_minimal_context(task="<your task>")` before any other graph tool.
- Use `detail_level="minimal"` on all calls. Only escalate to "standard" when minimal is insufficient.
- Target: complete any review/debug/refactor task in ≤5 tool calls and ≤800 total output tokens.
