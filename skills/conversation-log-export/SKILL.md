---
name: conversation-log-export
description: Export a Codex conversation log into a clean, conversation-only JSONL (and optional HTML viewer). Use when asked to dump only the current conversation, strip initialization/setup records, or generate project-local codex_sessions artifacts from ~/.codex/sessions rollout logs.
---

# Conversation Log Export

Use `scripts/export_current_conversation.py` to generate a filtered conversation log.

## Workflow

1. Resolve the source log.
- Use explicit `--source` when the user gives a path.
- Otherwise, auto-select the newest `rollout-*.jsonl` under `~/.codex/sessions`.

2. Resolve conversation start.
- Default: first `task_started` event in the source log.
- Use `--anchor-text` to start at the nearest prior `task_started` before the first matching user message.

3. Apply default filtering.
- Drop `session_meta`, `turn_context`, `event_msg`, and `compacted`.
- Drop `response_item` rows where `payload.type` is `reasoning` or `function_call_output`.
- Drop developer/system prompt messages (`response_item` message rows where role is `developer` or `system`).
- Drop bootstrap AGENTS directives injected as user messages (rows beginning with `# AGENTS.md instructions for ...` and containing `<INSTRUCTIONS>...</INSTRUCTIONS>`).
- You can override defaults with selectors:
  - `--include row:<type>,event:<type>,response:<type>,role:<role>`
  - `--exclude row:<type>,event:<type>,response:<type>,role:<role>`
  - Exclude always wins if both include/exclude match a row.
  - Use `--list-types` to print observed selectors and default keep/drop status.

4. Write project-local output.
- Default output path: `<cwd>/codex_sessions/<timestamp>_<goal-slug>.jsonl`.
- Goal slug is derived from the first user request in the selected conversation window.
- If exactly one commit message title is generated in assistant output (for example `us-123 ...`), its first line is used as the goal text for slug generation.
- Use `--with-html` to create a matching HTML viewer file beside the JSONL.
- Always regenerate `<cwd>/codex_sessions/index.html` (or the output folder if it is named `codex_sessions`) so the session index stays current.

## Commands

```bash
python3 scripts/export_current_conversation.py
python3 scripts/export_current_conversation.py --source /absolute/path/to/rollout.jsonl
python3 scripts/export_current_conversation.py --anchor-text "i have the delete button in lab tests." --with-html
python3 scripts/export_current_conversation.py --output /absolute/path/to/out.jsonl --with-html
python3 scripts/export_current_conversation.py --list-types
python3 scripts/export_current_conversation.py --include row:event_msg,row:compacted
python3 scripts/export_current_conversation.py --include response:reasoning,response:function_call_output
```
