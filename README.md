# Codex Log Viewer

This repository is first and foremost an automatic rewrite of the original Codex log viewer implementation into a browser-native frontend.
Original project: [timvw/codex-transcripts](https://github.com/timvw/codex-transcripts).

The primary deliverable is the JS/HTML/CSS viewer:
- `codex_log_viewer.js`
- `codex_log_viewer.html`
- `codex_log_viewer.css`

## What This Rewrite Does

- Reads Codex session JSONL logs directly in the browser.
- Supports both legacy and wrapped event lines (`{ "timestamp": ..., "payload": ... }`).
- Renders user/assistant/reasoning/function-call/function-output/token-usage blocks.
- Includes collapse/expand controls, filters, markdown rendering, and lightweight code highlighting.
- Falls back to embedded inline session data when fetch is blocked/unavailable.

## Primary Usage (Browser-Native)

1) Set the source file in `codex_log_viewer.html`:

```html
<meta name="codex-log-source" content="example.jsonl" />
```

2) Serve the repo over HTTP:

```bash
python3 -m http.server 8000
```

3) Open:

```text
http://localhost:8000/codex_log_viewer.html
```

Optional URL overrides:

```text
http://localhost:8000/codex_log_viewer.html?source=example.jsonl
http://localhost:8000/codex_log_viewer.html?source=example.jsonl&title=Codex%20Session%20Log
http://localhost:8000/codex_log_viewer.html?source=example.jsonl&showTokenUsage=true
http://localhost:8000/codex_log_viewer.html?source=example.jsonl&collapseOutputCharThreshold=15000&collapseOutputLineThreshold=300
```

Notes:
- `source` is resolved relative to `codex_log_viewer.html`.
- Token usage blocks are hidden by default on initial page load; use the `Token Usage` filter checkbox (or `showTokenUsage=true`) to show them.
- If loaded from `file://`, fetch may be blocked by browser security. Serve via HTTP.
- If the HTML contains embedded inline session data, the viewer can render even when source fetch fails.

## Session Exports in This Repo

Exported session artifacts are stored in:
- `codex_sessions/`
- [`codex_sessions/index.html`](codex_sessions/index.html) (session export index page)

Naming scheme uses migration-style timestamps with meaningful suffixes, for example:
- [`20260213134203_redacted_current_codex_session_jsonl_export.jsonl`](codex_sessions/20260213134203_redacted_current_codex_session_jsonl_export.jsonl)
- [`20260213134203_redacted_current_codex_session_jsonl_export.html`](codex_sessions/20260213134203_redacted_current_codex_session_jsonl_export.html)

## Skill Docs (`SKILL.md`)

This repository includes a vendored Codex skill for conversation exports:
- `skills/conversation-log-export/SKILL.md`

What this file is:
- The skill entrypoint documentation used by Codex to understand when and how to run the export workflow.
- The source of truth for workflow steps, filtering rules, and command examples for the export script.

Related files in the same skill:
- `skills/conversation-log-export/scripts/export_current_conversation.py` (implementation)
- `skills/conversation-log-export/agents/openai.yaml` (skill metadata for agent UI/default prompt)

Current filtering behavior documented in `SKILL.md`:
- Drops `session_meta`, `turn_context`, `event_msg`, and `compacted`.
- Keeps `event_msg` rows where `payload.type` is `token_count`.
- Drops `response_item` rows where `payload.type` is `reasoning` or `function_call_output`.
- Drops developer/system prompt `response_item` messages.
- Drops bootstrap AGENTS directives injected as user messages (`# AGENTS.md instructions for ...` with `<INSTRUCTIONS>...</INSTRUCTIONS>`).
- Default export filename is `<timestamp>_<goal-slug>.jsonl` (no `_conversation_only` suffix).
- If exactly one commit message title is generated, its first line is used to derive `<goal-slug>`.
- Supports selector overrides:
  - `--include row:<type>,event:<type>,response:<type>,role:<role>`
  - `--exclude row:<type>,event:<type>,response:<type>,role:<role>`
  - `--list-types` to print observed selector values and default keep/drop status.
- Each export run refreshes `codex_sessions/index.html` so new sessions appear automatically.

Run from this repository:

```bash
python3 skills/conversation-log-export/scripts/export_current_conversation.py --with-html
python3 skills/conversation-log-export/scripts/export_current_conversation.py --list-types
python3 skills/conversation-log-export/scripts/export_current_conversation.py --include row:event_msg,row:compacted
python3 skills/conversation-log-export/scripts/export_current_conversation.py --include response:reasoning,response:function_call_output
```

## Live examples via GitHub Pages:

 - https://jerometremblay.github.io/codex_log_viewer/
 - https://jerometremblay.github.io/codex_log_viewer/codex_sessions/20260213134203_redacted_current_codex_session_jsonl_export.html


## License

LGPL 2.0
