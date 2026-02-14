#!/usr/bin/env python3

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <meta name=\"codex-log-source\" content=\"{jsonl_name}\" />
  <title>{title}</title>
  <link rel=\"stylesheet\" href=\"https://jerometremblay.github.io/codex_log_viewer/codex_log_viewer.css\" />
  <script defer src=\"https://cdn.jsdelivr.net/npm/markdown-it@14/dist/markdown-it.min.js\"></script>
  <script defer src=\"https://jerometremblay.github.io/codex_log_viewer/codex_log_viewer.js\"></script>
</head>
<body>
  <div class=\"container\">
    <div id=\"app\">
      <div class=\"session\">
        <div class=\"title\">{title}</div>
        <div class=\"subtitle\">Loading JSONL log...</div>
      </div>
    </div>
  </div>
</body>
</html>
"""

MIRRORED_CHAT_EVENT_TYPES = {"user_message", "agent_message", "agent_reasoning"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export a conversation-only Codex JSONL from a rollout log."
    )
    parser.add_argument(
        "--source",
        help="Path to source rollout JSONL. Defaults to newest ~/.codex/sessions/**/rollout-*.jsonl",
    )
    parser.add_argument(
        "--output",
        help="Output JSONL path. Defaults to <cwd>/codex_sessions/<timestamp>_<goal-slug>_conversation_only.jsonl",
    )
    parser.add_argument(
        "--anchor-text",
        help="Start from nearest prior task_started before first user message containing this text.",
    )
    parser.add_argument(
        "--with-html",
        action="store_true",
        help="Also generate a matching HTML viewer file beside the output JSONL.",
    )
    return parser.parse_args()


def latest_rollout_path() -> Path:
    sessions_root = Path.home() / ".codex" / "sessions"
    candidates = list(sessions_root.rglob("rollout-*.jsonl"))
    if not candidates:
        raise FileNotFoundError(f"No rollout JSONL found under {sessions_root}")
    return max(candidates, key=lambda p: p.stat().st_mtime)


def load_rows(path: Path) -> list[dict]:
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, raw in enumerate(handle, start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON on line {line_no}: {exc}") from exc
    return rows


def is_task_started(row: dict) -> bool:
    return row.get("type") == "event_msg" and row.get("payload", {}).get("type") == "task_started"


def row_has_user_text(row: dict, needle: str) -> bool:
    if row.get("type") != "response_item":
        return False
    payload = row.get("payload", {})
    if payload.get("type") != "message" or payload.get("role") != "user":
        return False

    needle_lower = needle.lower()
    for item in payload.get("content", []):
        if item.get("type") != "input_text":
            continue
        text = item.get("text", "")
        if needle_lower in text.lower():
            return True
    return False


def user_message_text(row: dict) -> str:
    if row.get("type") != "response_item":
        return ""
    payload = row.get("payload", {})
    if payload.get("type") != "message" or payload.get("role") != "user":
        return ""

    parts = []
    for item in payload.get("content", []):
        if item.get("type") != "input_text":
            continue
        text = item.get("text", "").strip()
        if text:
            parts.append(text)
    return "\n".join(parts).strip()


def resolve_start_index(rows: list[dict], anchor_text: str | None) -> int:
    if anchor_text:
        anchor_idx = next(
            (idx for idx, row in enumerate(rows) if row_has_user_text(row, anchor_text)),
            None,
        )
        if anchor_idx is None:
            raise ValueError("Anchor text was not found in any user message.")

        task_indices = [i for i in range(anchor_idx + 1) if is_task_started(rows[i])]
        return task_indices[-1] if task_indices else anchor_idx

    first_task_idx = next((idx for idx, row in enumerate(rows) if is_task_started(row)), None)
    return 0 if first_task_idx is None else first_task_idx


def conversation_goal_text(rows: list[dict], start_idx: int) -> str:
    for row in rows[start_idx:]:
        text = user_message_text(row)
        if not text:
            continue
        non_empty_lines = [line.strip() for line in text.splitlines() if line.strip()]
        if not non_empty_lines:
            continue
        return non_empty_lines[0]
    return "conversation"


def slugify_goal(goal_text: str, max_words: int = 10, max_len: int = 64) -> str:
    normalized = unicodedata.normalize("NFKD", goal_text)
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii").lower()
    tokens = re.findall(r"[a-z0-9]+", ascii_text)
    if not tokens:
        return "conversation"

    slug = "-".join(tokens[:max_words]).strip("-")
    slug = slug[:max_len].strip("-")
    return slug or "conversation"


def timestamp_prefix(rows: list[dict], start_idx: int) -> str:
    timestamp = rows[start_idx].get("timestamp", "") if rows else ""
    digits = re.sub(r"[^0-9]", "", timestamp)
    return digits[:14] if len(digits) >= 14 else ""


def default_output_path(rows: list[dict], start_idx: int) -> Path:
    goal_text = conversation_goal_text(rows, start_idx)
    goal_slug = slugify_goal(goal_text)
    prefix = timestamp_prefix(rows, start_idx)
    basename = f"{goal_slug}_conversation_only.jsonl"
    if prefix:
        basename = f"{prefix}_{basename}"
    return Path.cwd() / "codex_sessions" / basename


def keep_row(row: dict) -> bool:
    row_type = row.get("type")
    if row_type in {"session_meta", "turn_context"}:
        return False

    if row_type == "event_msg":
        payload_type = row.get("payload", {}).get("type")
        if payload_type in MIRRORED_CHAT_EVENT_TYPES:
            return False

    if row_type == "response_item":
        payload = row.get("payload", {})
        if payload.get("type") == "message" and payload.get("role") in {"developer", "system"}:
            return False

    return True


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def write_html(path: Path, jsonl_name: str, title: str) -> None:
    html_text = HTML_TEMPLATE.format(jsonl_name=jsonl_name, title=title)
    path.write_text(html_text, encoding="utf-8")


def main() -> int:
    args = parse_args()

    source = Path(args.source).expanduser() if args.source else latest_rollout_path()
    if not source.exists():
        print(f"Source file not found: {source}", file=sys.stderr)
        return 1

    rows = load_rows(source)
    start_idx = resolve_start_index(rows, args.anchor_text)
    goal_text = conversation_goal_text(rows, start_idx)
    goal_slug = slugify_goal(goal_text)

    if args.output:
        output = Path(args.output).expanduser()
    else:
        output = default_output_path(rows, start_idx)

    filtered = [row for row in rows[start_idx:] if keep_row(row)]

    write_jsonl(output, filtered)

    print(f"source: {source}")
    print(f"output: {output}")
    print(f"rows: {len(rows)} -> {len(filtered)}")
    print(f"start_index: {start_idx}")
    print(f"goal: {goal_text}")
    print(f"goal_slug: {goal_slug}")

    if args.with_html:
        html_path = output.with_suffix(".html")
        write_html(html_path, output.name, f"Codex Conversation Log - {goal_text}")
        print(f"html: {html_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
