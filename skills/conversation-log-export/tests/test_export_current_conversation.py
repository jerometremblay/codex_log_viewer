import importlib.util
from pathlib import Path
import unittest


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "export_current_conversation.py"
)
SPEC = importlib.util.spec_from_file_location("export_current_conversation", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class ExportCurrentConversationFilterTests(unittest.TestCase):
    def test_default_excludes_event_msg(self):
        row = {"type": "event_msg", "payload": {"type": "task_started"}}
        self.assertFalse(MODULE.keep_row_default(row))

    def test_default_excludes_compacted(self):
        row = {"type": "compacted"}
        self.assertFalse(MODULE.keep_row_default(row))

    def test_default_excludes_reasoning(self):
        row = {"type": "response_item", "payload": {"type": "reasoning"}}
        self.assertFalse(MODULE.keep_row_default(row))

    def test_default_excludes_function_call_output(self):
        row = {"type": "response_item", "payload": {"type": "function_call_output"}}
        self.assertFalse(MODULE.keep_row_default(row))

    def test_default_excludes_developer_message_role(self):
        row = {
            "type": "response_item",
            "payload": {"type": "message", "role": "developer"},
        }
        self.assertFalse(MODULE.keep_row_default(row))

    def test_default_keeps_primary_response_items(self):
        row = {"type": "response_item", "payload": {"type": "function_call"}}
        self.assertTrue(MODULE.keep_row_default(row))

    def test_default_excludes_agents_directive_user_message(self):
        row = {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": (
                            "# AGENTS.md instructions for /Users/jerome/codex_log_viewer\n\n"
                            "<INSTRUCTIONS>\nHello\n</INSTRUCTIONS>"
                        ),
                    }
                ],
            },
        }
        self.assertFalse(MODULE.keep_row_default(row))

    def test_non_directive_agents_reference_is_not_excluded(self):
        row = {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "Can you review AGENTS.md instructions for this repo?",
                    }
                ],
            },
        }
        self.assertTrue(MODULE.keep_row_default(row))

    def test_include_readds_excluded_types(self):
        event_row = {"type": "event_msg", "payload": {"type": "task_started"}}
        compacted_row = {"type": "compacted"}
        reasoning_row = {"type": "response_item", "payload": {"type": "reasoning"}}
        output_row = {
            "type": "response_item",
            "payload": {"type": "function_call_output"},
        }

        self.assertTrue(MODULE.should_keep_row(event_row, {"row:event_msg"}, set()))
        self.assertTrue(MODULE.should_keep_row(compacted_row, {"row:compacted"}, set()))
        self.assertTrue(MODULE.should_keep_row(reasoning_row, {"response:reasoning"}, set()))
        self.assertTrue(
            MODULE.should_keep_row(output_row, {"response:function_call_output"}, set())
        )

    def test_exclude_overrides_include(self):
        row = {"type": "response_item", "payload": {"type": "reasoning"}}
        self.assertFalse(
            MODULE.should_keep_row(
                row,
                {"response:reasoning"},
                {"response:reasoning"},
            )
        )

    def test_selector_parse_supports_repeatable_and_comma_separated(self):
        parsed = MODULE.parse_selector_args([
            "row:event_msg,response:reasoning",
            "row:compacted",
        ])
        self.assertEqual(
            parsed,
            {"row:event_msg", "response:reasoning", "row:compacted"},
        )

    def test_selector_parse_rejects_invalid_prefix(self):
        with self.assertRaises(ValueError) as exc:
            MODULE.parse_selector_args(["badprefix:value"])
        self.assertIn("Allowed prefixes", str(exc.exception))

    def test_resolve_start_index_anchor_behavior_unchanged(self):
        rows = [
            {"type": "event_msg", "payload": {"type": "task_started"}},
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "first"}],
                },
            },
            {"type": "event_msg", "payload": {"type": "task_started"}},
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "needle text"}],
                },
            },
        ]
        self.assertEqual(MODULE.resolve_start_index(rows, "needle text"), 2)

    def test_collect_selector_values_includes_default_only_selectors(self):
        rows = [
            {"type": "response_item", "payload": {"type": "message", "role": "assistant"}},
        ]
        values = MODULE.collect_selector_values(rows)
        self.assertIn("system", values["role"])
        self.assertIn("event_msg", values["row"])

    def test_event_selector_default_status_is_effectively_dropped(self):
        self.assertEqual(MODULE.selector_default_status("event:task_started"), "dropped")

    def test_default_output_path_omits_conversation_only_suffix(self):
        rows = [
            {"type": "event_msg", "payload": {"type": "task_started"}, "timestamp": "2026-02-15T14:20:00Z"},
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Short goal line"}],
                },
            },
        ]
        output = MODULE.default_output_path(rows, 0)
        self.assertEqual(output.name, "20260215142000_short-goal-line.jsonl")

    def test_conversation_goal_prefers_single_generated_commit_message_title(self):
        rows = [
            {"type": "event_msg", "payload": {"type": "task_started"}},
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "us-123 add export naming behavior\n\n- include tests",
                        }
                    ],
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Some other request"}],
                },
            },
        ]
        self.assertEqual(
            MODULE.conversation_goal_text(rows, 0),
            "us-123 add export naming behavior",
        )

    def test_conversation_goal_falls_back_when_multiple_commit_titles_found(self):
        rows = [
            {"type": "event_msg", "payload": {"type": "task_started"}},
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "us-123 first title"}],
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "us-456 second title"}],
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Fallback user goal"}],
                },
            },
        ]
        self.assertEqual(MODULE.conversation_goal_text(rows, 0), "Fallback user goal")

    def test_conversation_goal_skips_agents_directive_message(self):
        rows = [
            {"type": "event_msg", "payload": {"type": "task_started"}},
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": (
                                "# AGENTS.md instructions for /Users/jerome/codex_log_viewer\n\n"
                                "<INSTRUCTIONS>\nHello\n</INSTRUCTIONS>"
                            ),
                        }
                    ],
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Actual user request"}],
                },
            },
        ]
        self.assertEqual(MODULE.conversation_goal_text(rows, 0), "Actual user request")


if __name__ == "__main__":
    unittest.main()
