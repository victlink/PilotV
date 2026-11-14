"""Synthetic checks for bounded artifact text reads; no user data access."""
from pathlib import Path
import sys
import unittest
from unittest.mock import mock_open, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import artifacts_console as console


class TextReadTests(unittest.TestCase):
    def read_fixture(self, content):
        opened = mock_open(read_data=content)
        with patch.object(console, '_stored_path', return_value='fixture.txt'), \
                patch.object(console.os.path, 'isfile', return_value=True), \
                patch.object(console.os.path, 'getsize', return_value=1), \
                patch('builtins.open', opened):
            result = console._text_of({'id': 'fixture', 'mime': 'text/plain'})
        return result, opened

    def test_text_handle_closed(self):
        result, opened = self.read_fixture('fixture')
        self.assertEqual(result, 'fixture')
        opened.return_value.__exit__.assert_called_once()

    def test_growth_after_size_check_does_not_read_unbounded_text(self):
        result, opened = self.read_fixture('x' * 400_001)
        self.assertEqual(result, '')
        opened.return_value.read.assert_called_once_with(400_001)


if __name__ == '__main__':
    unittest.main()
