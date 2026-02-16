#!/usr/bin/env python3

import argparse
import html
import json
import re
import sys
import unicodedata
from collections import defaultdict
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

SELECTOR_PREFIXES = ("row", "event", "response", "role")
COMMIT_TITLE_PATTERN = re.compile(
    r"^(?:us-\d+|f-\d+|p-\d+|t-\d+|b-\d+|id:\d+)\b.+$",
    re.IGNORECASE,
)
AGENTS_DIRECTIVE_HEADER_PATTERN = re.compile(
    r"^\s*#\s*AGENTS\.md instructions for\b",
    re.IGNORECASE,
)
DEFAULT_EXCLUDED_SELECTORS = {
    "row:session_meta",
    "row:turn_context",
    "row:event_msg",
    "row:compacted",
    "response:reasoning",
    "response:function_call_output",
    "role:developer",
    "role:system",
}
SESSION_STEM_PATTERN = re.compile(r"^(?P<prefix>\d{14})_(?P<slug>.+)$")


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
        help="Output JSONL path. Defaults to <cwd>/codex_sessions/<timestamp>_<goal-slug>.jsonl",
    )
    parser.add_argument(
        "--anchor-text",
        help="Start from nearest prior task_started before first user message containing this text.",
    )
    parser.add_argument(
        "--include",
        action="append",
        default=[],
        metavar="SELECTOR[,SELECTOR...]",
        help=(
            "Re-include filtered rows matching selectors. Repeatable and comma-separated. "
            "Selector format: row:<type>, event:<type>, response:<type>, role:<role>."
        ),
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="SELECTOR[,SELECTOR...]",
        help=(
            "Exclude rows matching selectors. Repeatable and comma-separated. "
            "Selector format: row:<type>, event:<type>, response:<type>, role:<role>."
        ),
    )
    parser.add_argument(
        "--list-types",
        action="store_true",
        help="Print observed selector values and their default keep/drop status, then exit.",
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


def is_agents_directive_text(text: str) -> bool:
    if not text:
        return False
    stripped = text.strip()
    if not AGENTS_DIRECTIVE_HEADER_PATTERN.search(stripped):
        return False

    lowered = stripped.lower()
    return "<instructions>" in lowered and "</instructions>" in lowered


def is_agents_directive_row(row: dict) -> bool:
    if row.get("type") != "response_item":
        return False
    payload = row.get("payload", {})
    if payload.get("type") != "message" or payload.get("role") != "user":
        return False

    return is_agents_directive_text(user_message_text(row))


def assistant_message_text(row: dict) -> str:
    if row.get("type") != "response_item":
        return ""
    payload = row.get("payload", {})
    if payload.get("type") != "message" or payload.get("role") != "assistant":
        return ""

    parts = []
    for item in payload.get("content", []):
        if item.get("type") != "output_text":
            continue
        text = item.get("text", "").strip()
        if text:
            parts.append(text)
    return "\n".join(parts).strip()


def find_commit_titles_in_text(text: str) -> list[str]:
    titles: list[str] = []
    if not text:
        return titles

    code_blocks = re.findall(r"```(?:[^\n`]*)\n(.*?)```", text, flags=re.DOTALL)
    for block in code_blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if lines and COMMIT_TITLE_PATTERN.match(lines[0]):
            titles.append(lines[0])

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if lines and COMMIT_TITLE_PATTERN.match(lines[0]):
        titles.append(lines[0])

    return titles


def generated_commit_message_title(rows: list[dict], start_idx: int) -> str | None:
    ordered_unique_titles: list[str] = []
    seen_titles: set[str] = set()

    for row in rows[start_idx:]:
        text = assistant_message_text(row)
        if not text:
            continue
        for title in find_commit_titles_in_text(text):
            normalized = title.lower()
            if normalized in seen_titles:
                continue
            seen_titles.add(normalized)
            ordered_unique_titles.append(title)

    if len(ordered_unique_titles) == 1:
        return ordered_unique_titles[0]
    return None


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
    commit_title = generated_commit_message_title(rows, start_idx)
    if commit_title:
        return commit_title

    for row in rows[start_idx:]:
        text = user_message_text(row)
        if not text or is_agents_directive_text(text):
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
    basename = f"{goal_slug}.jsonl"
    if prefix:
        basename = f"{prefix}_{basename}"
    return Path.cwd() / "codex_sessions" / basename


def row_selectors(row: dict) -> set[str]:
    selectors: set[str] = set()
    row_type = row.get("type")
    if isinstance(row_type, str) and row_type:
        normalized_row_type = row_type.lower()
        selectors.add(f"row:{normalized_row_type}")
    else:
        return selectors

    if row_type == "event_msg":
        payload = row.get("payload", {})
        if isinstance(payload, dict):
            payload_type = payload.get("type")
            if isinstance(payload_type, str) and payload_type:
                selectors.add(f"event:{payload_type.lower()}")

    if row_type == "response_item":
        payload = row.get("payload", {})
        if isinstance(payload, dict):
            payload_type = payload.get("type")
            if isinstance(payload_type, str) and payload_type:
                normalized_payload_type = payload_type.lower()
                selectors.add(f"response:{normalized_payload_type}")
                if normalized_payload_type == "message":
                    role = payload.get("role")
                    if isinstance(role, str) and role:
                        selectors.add(f"role:{role.lower()}")

    return selectors


def keep_row_default(row: dict) -> bool:
    if is_agents_directive_row(row):
        return False

    selectors = row_selectors(row)
    return not any(selector in DEFAULT_EXCLUDED_SELECTORS for selector in selectors)


def should_keep_row(
    row: dict, include_selectors: set[str] | None = None, exclude_selectors: set[str] | None = None
) -> bool:
    include_selectors = include_selectors or set()
    exclude_selectors = exclude_selectors or set()
    selectors = row_selectors(row)
    keep = keep_row_default(row)

    if include_selectors and selectors.intersection(include_selectors):
        keep = True

    if selectors.intersection(exclude_selectors):
        keep = False

    return keep


def normalize_selector(raw: str) -> str:
    token = raw.strip()
    if not token:
        raise ValueError("Empty selector is not allowed.")

    if ":" not in token:
        raise ValueError(
            f"Invalid selector '{raw}'. Expected '<prefix>:<value>' where prefix is one of: "
            f"{', '.join(SELECTOR_PREFIXES)}."
        )

    prefix, value = token.split(":", 1)
    prefix = prefix.strip().lower()
    value = value.strip().lower()

    if prefix not in SELECTOR_PREFIXES:
        raise ValueError(
            f"Invalid selector prefix '{prefix}' in '{raw}'. Allowed prefixes: "
            f"{', '.join(SELECTOR_PREFIXES)}."
        )
    if not value:
        raise ValueError(
            f"Invalid selector '{raw}'. Missing value after ':'. Expected '<prefix>:<value>'."
        )

    return f"{prefix}:{value}"


def parse_selector_args(raw_values: list[str] | None) -> set[str]:
    selectors: set[str] = set()
    for raw_group in raw_values or []:
        for raw_selector in raw_group.split(","):
            raw_selector = raw_selector.strip()
            if not raw_selector:
                continue
            selectors.add(normalize_selector(raw_selector))
    return selectors


def collect_selector_values(rows: list[dict]) -> dict[str, set[str]]:
    values: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        for selector in row_selectors(row):
            prefix, value = selector.split(":", 1)
            values[prefix].add(value)

    for selector in DEFAULT_EXCLUDED_SELECTORS:
        prefix, value = selector.split(":", 1)
        values[prefix].add(value)

    for prefix in SELECTOR_PREFIXES:
        values.setdefault(prefix, set())

    return values


def selector_default_status(selector: str) -> str:
    if selector in DEFAULT_EXCLUDED_SELECTORS:
        return "dropped"
    prefix, _ = selector.split(":", 1)
    if prefix == "event" and "row:event_msg" in DEFAULT_EXCLUDED_SELECTORS:
        return "dropped"
    return "kept"


def print_selector_types(rows: list[dict]) -> None:
    values = collect_selector_values(rows)
    print("selector_types:")
    for prefix in SELECTOR_PREFIXES:
        print(f"{prefix}:")
        for value in sorted(values[prefix]):
            selector = f"{prefix}:{value}"
            default_status = selector_default_status(selector)
            print(f"  - {selector} (default: {default_status})")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def write_html(path: Path, jsonl_name: str, title: str) -> None:
    html_text = HTML_TEMPLATE.format(jsonl_name=jsonl_name, title=title)
    path.write_text(html_text, encoding="utf-8")


def index_directory_for_output(output: Path, cwd: Path | None = None) -> Path:
    base_dir = cwd or Path.cwd()
    if output.parent.name == "codex_sessions":
        return output.parent
    return base_dir / "codex_sessions"


def parse_session_stem(stem: str) -> tuple[str, str]:
    match = SESSION_STEM_PATTERN.match(stem)
    if not match:
        return "", stem
    return match.group("prefix"), match.group("slug")


def collect_session_entries(codex_sessions_dir: Path) -> list[dict]:
    entries: list[dict] = []
    for jsonl_path in codex_sessions_dir.glob("*.jsonl"):
        prefix, slug = parse_session_stem(jsonl_path.stem)
        html_path = jsonl_path.with_suffix(".html")
        entries.append(
            {
                "stem": jsonl_path.stem,
                "slug": slug,
                "prefix": prefix,
                "jsonl_name": jsonl_path.name,
                "html_name": html_path.name,
                "has_html": html_path.exists(),
                "mtime": jsonl_path.stat().st_mtime,
            }
        )

    entries.sort(
        key=lambda item: (
            bool(item["prefix"]),
            item["prefix"],
            item["mtime"],
            item["stem"],
        ),
        reverse=True,
    )
    return entries


def render_sessions_index(entries: list[dict]) -> str:
    row_blocks = []
    if not entries:
        row_blocks.append(
            """
          <tr>
            <td colspan="3"><span class="muted">No session exports yet.</span></td>
          </tr>
            """.rstrip()
        )

    for entry in entries:
        stem = html.escape(str(entry["stem"]))
        base = html.escape(str(entry["slug"]))
        prefix = str(entry["prefix"])
        prefix_cell = f"<code>{html.escape(prefix)}</code>" if prefix else '<span class="muted">-</span>'

        links = []
        if entry["has_html"]:
            links.append(
                f'<a href="./{html.escape(str(entry["html_name"]))}">Open HTML</a>'
            )
        links.append(f'<a href="./{html.escape(str(entry["jsonl_name"]))}">Open JSONL</a>')

        row_blocks.append(
            f"""
          <tr>
            <td>
              <div class="name">
                <span class="base">{base}</span>
                <span class="muted">{stem}</span>
              </div>
            </td>
            <td>{prefix_cell}</td>
            <td>
              <div class="links">
                {' '.join(links)}
              </div>
            </td>
          </tr>
            """.rstrip()
        )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex Session Exports</title>
  <style>
    :root {{
      --bg: #f6f8fa;
      --text: #1f2328;
      --muted: #59636e;
      --surface: #ffffff;
      --border: #d0d7de;
      --link: #0969da;
    }}

    * {{ box-sizing: border-box; }}

    body {{
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
    }}

    main {{
      max-width: 980px;
      margin: 0 auto;
      padding: 32px 20px 56px;
    }}

    h1 {{
      margin: 0 0 8px;
      font-size: 2rem;
    }}

    p {{
      margin: 0 0 24px;
      color: var(--muted);
    }}

    .table-wrap {{
      overflow-x: auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
    }}

    table {{
      width: 100%;
      border-collapse: collapse;
      min-width: 760px;
    }}

    th, td {{
      text-align: left;
      vertical-align: top;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      font-size: 0.95rem;
    }}

    th {{
      position: sticky;
      top: 0;
      background: #f3f4f6;
      font-weight: 600;
      color: #1f2328;
    }}

    tbody tr:last-child td {{
      border-bottom: none;
    }}

    .name {{
      display: flex;
      flex-direction: column;
      gap: 4px;
      word-break: break-word;
    }}

    .name .base {{
      font-weight: 600;
    }}

    .muted {{
      color: var(--muted);
      font-size: 0.88rem;
    }}

    .links {{
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }}

    a {{
      color: var(--link);
      text-decoration: none;
    }}

    a:hover {{
      text-decoration: underline;
    }}
  </style>
</head>
<body>
  <main>
    <h1>Codex Session Exports</h1>
    <p>Index of exported conversation sessions in this folder. Newest entries are listed first.</p>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Timestamp Prefix</th>
            <th>Open</th>
          </tr>
        </thead>
        <tbody>
{''.join(row_blocks)}
        </tbody>
      </table>
    </div>
  </main>
</body>
</html>
"""


def write_sessions_index(codex_sessions_dir: Path) -> Path:
    codex_sessions_dir.mkdir(parents=True, exist_ok=True)
    entries = collect_session_entries(codex_sessions_dir)
    index_html = render_sessions_index(entries)
    index_path = codex_sessions_dir / "index.html"
    index_path.write_text(index_html, encoding="utf-8")
    return index_path


def main() -> int:
    args = parse_args()

    source = Path(args.source).expanduser() if args.source else latest_rollout_path()
    if not source.exists():
        print(f"Source file not found: {source}", file=sys.stderr)
        return 1

    rows = load_rows(source)
    start_idx = resolve_start_index(rows, args.anchor_text)
    scoped_rows = rows[start_idx:]

    try:
        include_selectors = parse_selector_args(args.include)
        exclude_selectors = parse_selector_args(args.exclude)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if args.list_types:
        print(f"source: {source}")
        print(f"start_index: {start_idx}")
        print_selector_types(scoped_rows)
        return 0

    goal_text = conversation_goal_text(rows, start_idx)
    goal_slug = slugify_goal(goal_text)

    if args.output:
        output = Path(args.output).expanduser()
    else:
        output = default_output_path(rows, start_idx)

    filtered = [
        row for row in scoped_rows if should_keep_row(row, include_selectors, exclude_selectors)
    ]

    write_jsonl(output, filtered)

    html_path = None
    if args.with_html:
        html_path = output.with_suffix(".html")
        write_html(html_path, output.name, f"Codex Conversation Log - {goal_text}")

    index_dir = index_directory_for_output(output)
    index_path = write_sessions_index(index_dir)

    print(f"source: {source}")
    print(f"output: {output}")
    print(f"rows: {len(rows)} -> {len(filtered)}")
    print(f"start_index: {start_idx}")
    print(f"goal: {goal_text}")
    print(f"goal_slug: {goal_slug}")
    if html_path is not None:
        print(f"html: {html_path}")
    print(f"index: {index_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
