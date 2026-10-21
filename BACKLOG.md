# Backlog

Ideas parked for later. Not committed work.

## Attribute / parameter audit HITL (MCP App)

**Status:** parked  
**When:** whenever there's appetite

### Intent

Use the Schedule MCP App (or a sibling App) as a human-in-the-loop surface for property checks: show gaps, suggest what to fill, let the user edit/Apply.

### Likely flow

1. **Source** — delivery rules from PDF or Excel (not a fixed YAML product).
2. **Agent** — extract/structure rules (YAML/JSON is just a convenient intermediate for chatting with the agent / running checks).
3. **Check** — run against the model (`query_model` / `get_element_data` or a dedicated audit tool).
4. **App** — present fail / missing / suggested values; user confirms and writes back.

### Notes

- Current Schedule App is editable instance params only; no rules engine, no pass/fail columns, no suggestions.
- Do not invent an official YAML schema first — treat structured rules as Agent I/O from PDF/Excel.
