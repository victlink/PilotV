"""Bounded JSONL reader regressions using synthetic session data only."""
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pilotdeck_workspace as workspace


class LiteReaderTests(unittest.TestCase):
    def read_session(self, content):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'session.jsonl'
            path.write_text(content, encoding='utf-8')
            return workspace._read_session(str(path), 'fallback-id', directory)

    def test_large_session_reads_are_bounded_by_head_and_tail_budgets(self):
        class CountingFile(io.BytesIO):
            def __init__(self, content):
                super().__init__(content)
                self.read_sizes = []
                self.total_read = 0

            def read(self, size=-1):
                self.read_sizes.append(size)
                chunk = super().read(size)
                self.total_read += len(chunk)
                return chunk

        content = b'x' * (8 * 1024 * 1024)
        handle = CountingFile(content)
        with patch.object(workspace.os.path, 'getsize', return_value=len(content)), \
                patch('builtins.open', return_value=handle):
            workspace._read_lite('synthetic-session.jsonl')
        self.assertEqual(handle.read_sizes, [workspace.HEAD_READ_BYTES, workspace.TAIL_READ_BYTES])
        self.assertEqual(handle.total_read, workspace.HEAD_READ_BYTES + workspace.TAIL_READ_BYTES)

    def test_malformed_record_shapes_do_not_hide_later_metadata(self):
        records = [
            ['session_metadata'],
            {'type': 'session_metadata', 'metadata': 'bad shape'},
            {'type': 'session_metadata', 'metadata': ['bad shape']},
            {'type': 'session_metadata', 'metadata': {'title': 'valid title'}},
        ]
        content = ''.join(json.dumps(record) + '\n' for record in records)
        self.assertEqual(self.read_session(content)['title'], 'valid title')

    def test_malformed_prompt_shapes_do_not_hide_later_prompt(self):
        records = [
            ['accepted_input'],
            {'type': 'accepted_input', 'messages': 'bad shape'},
            {'type': 'accepted_input', 'messages': [None, 'bad shape']},
            {'type': 'accepted_input', 'messages': [{'role': 'user', 'content': [
                {'type': 'text', 'text': 123}]}]},
            {'type': 'accepted_input', 'messages': [{'role': 'user', 'content': [
                {'type': 'text', 'text': 'valid prompt'}]}]},
        ]
        content = ''.join(json.dumps(record) + '\n' for record in records)
        self.assertEqual(self.read_session(content)['title'], 'valid prompt')

    def test_single_metadata_line_is_preserved(self):
        line = json.dumps({'type': 'session_metadata', 'metadata': {'title': 'first line'}})
        self.assertEqual(self.read_session(line + '\n')['title'], 'first line')

    def test_single_initial_prompt_is_preserved(self):
        line = json.dumps({'type': 'accepted_input', 'messages': [
            {'role': 'user', 'content': [{'type': 'text', 'text': 'initial prompt'}]}]})
        self.assertEqual(self.read_session(line + '\n')['title'], 'initial prompt')

    def test_metadata_between_head_and_tail_threshold_is_read(self):
        # With head=32 and tail=128, this file fits in the tail budget but not
        # the head budget. The metadata must not disappear in that gap.
        line = json.dumps({'type': 'session_metadata', 'metadata': {'title': 'later'}})
        with patch.object(workspace, 'HEAD_READ_BYTES', 32), patch.object(workspace, 'TAIL_READ_BYTES', 128):
            self.assertEqual(self.read_session('{}\n' * 12 + line + '\n')['title'], 'later')

    def test_tail_skips_partial_record_but_keeps_complete_metadata(self):
        line = json.dumps({'type': 'session_metadata', 'metadata': {'title': 'tail'}})
        with patch.object(workspace, 'HEAD_READ_BYTES', 16), patch.object(workspace, 'TAIL_READ_BYTES', 100):
            self.assertEqual(self.read_session('x' * 150 + '\n' + line + '\n')['title'], 'tail')


if __name__ == '__main__':
    unittest.main()
