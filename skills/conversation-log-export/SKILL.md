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

3. Strip initialization/setup records.
- Drop `session_meta` and `turn_context`.
- Drop developer/system prompt messages (`response_item` message rows where role is `developer` or `system`).
- Drop mirrored chat `event_msg` rows (`user_message`, `agent_message`, `agent_reasoning`) to avoid duplicate conversational content while preserving other runtime events.

4. Write project-local output.
- Default output path: `<cwd>/codex_sessions/<timestamp>_<goal-slug>_conversation_only.jsonl`.
- Goal slug is derived from the first user request in the selected conversation window, so filenames are representative of conversation intent.
- Use `--with-html` to create a matching HTML viewer file beside the JSONL.

## Commands

```bash
python3 scripts/export_current_conversation.py
python3 scripts/export_current_conversation.py --source /absolute/path/to/rollout.jsonl
python3 scripts/export_current_conversation.py --anchor-text "i have the delete button in lab tests." --with-html
python3 scripts/export_current_conversation.py --output /absolute/path/to/out.jsonl --with-html
```
