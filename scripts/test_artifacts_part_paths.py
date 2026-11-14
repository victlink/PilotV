"""Synthetic regression coverage for stored artifact part containment."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from artifacts_deliver import part_file, _resolve_part


class PartPathTests(unittest.TestCase):
    def test_manifest_path_on_another_drive_is_reported_as_unsafe(self):
        # Windows commonpath raises for different drives; reject, don't crash.
        with patch('artifacts_deliver.os.path.commonpath', side_effect=ValueError('different drives')):
            source, warning = _resolve_part('model.txt', '.')
        self.assertEqual(source, '')
        self.assertTrue(warning)

    def test_normal_part(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            part = root / 'files/parts/art_fixture/model.txt'
            part.parent.mkdir(parents=True)
            part.write_text('fixture')
            self.assertEqual(Path(part_file('art_fixture', 'model.txt', str(root / 'files'))), part)

    def test_artifact_id_cannot_escape_parts_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'files/parts').mkdir(parents=True)
            (root / 'outside').mkdir()
            (root / 'outside/model.txt').write_text('synthetic private content')
            self.assertIsNone(part_file('../../outside', 'model.txt', str(root / 'files')))
            self.assertIsNone(part_file(str(root / 'outside'), 'model.txt', str(root / 'files')))

    def test_artifact_directory_symlink_cannot_read_another_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            parts = root / 'files/parts'
            other = parts / 'art_other'
            other.mkdir(parents=True)
            (other / 'model.txt').write_text('other artifact')
            (parts / 'art_fixture').symlink_to(other, target_is_directory=True)
            self.assertIsNone(part_file('art_fixture', 'model.txt', str(root / 'files')))

    def test_windows_components_are_rejected_on_all_platforms(self):
        with tempfile.TemporaryDirectory() as tmp:
            for component in ('..', '../other', r'..\\other', 'C:other', '/other', '\x00'):
                with self.subTest(component=repr(component)):
                    self.assertIsNone(part_file(component, 'model.txt', tmp))
                    self.assertIsNone(part_file('art_fixture', component, tmp))

    def test_symlink_cannot_escape_artifact_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            part_dir = root / 'files/parts/art_fixture'
            part_dir.mkdir(parents=True)
            outside = root / 'outside.txt'
            outside.write_text('fixture')
            (part_dir / 'model.txt').symlink_to(outside)
            self.assertIsNone(part_file('art_fixture', 'model.txt', str(root / 'files')))


if __name__ == '__main__':
    unittest.main()
