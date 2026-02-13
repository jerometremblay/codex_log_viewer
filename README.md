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
- If loaded from `file://`, fetch may be blocked by browser security. Serve via HTTP.
- If the HTML contains embedded inline session data, the viewer can render even when source fetch fails.

## Session Exports in This Repo

Exported session artifacts are stored in:
- `codex_sessions/`

Naming scheme uses migration-style timestamps with meaningful suffixes, for example:
- `20260213134203_redacted_current_codex_session_jsonl_export.jsonl`
- `20260213134203_redacted_current_codex_session_jsonl_export.html`

## Example Files

- Sample log: [example.jsonl](example.jsonl)
- Generated HTML sample: [example.html](https://htmlpreview.github.io/?https://github.com/dschwen/codex_log_viewer/blob/main/example.html)

## License

LGPL 2.0
