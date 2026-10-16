"""Offline regressions: never touches the live artifact database."""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import artifacts_console as console
import pilotdeck_workspace as workspace


class AssociationTests(unittest.TestCase):
    def listing(self, run_id):
        project = {'name': '3d', 'fullPath': '/work/3d', 'sessions': [
            {'id': 'web:new', 'live': True}, {'id': 'web:logo', 'live': False}]}
        tree = {'pilot_home': '/fake', 'projects': [project]}
        store = SimpleNamespace(list=lambda **kw: [{'id': 'art_logo', 'run_id': run_id,
            'source': {'path': '/work/3d/logo.svg'}}])
        with patch.object(console, '_store_of', return_value=store), \
             patch.object(workspace, 'scan_projects', return_value=tree) as scan, \
             patch.object(workspace, 'find_project_for_path', return_value=project):
            response = asyncio.run(console.api_workspace(SimpleNamespace(query={}, remote="127.0.0.1", headers={})))
        return json.loads(response.body), scan

    def test_bare_run_id_matches_original_conversation_not_live_neighbor(self):
        data, _ = self.listing('logo')
        sessions = data['projects'][0]['sessions']
        self.assertEqual(next(s for s in sessions if s['id'] == 'web:logo')['artifacts'][0]['id'], 'art_logo')

    def test_unknown_explicit_run_id_is_not_reassigned_to_live_conversation(self):
        data, _ = self.listing('web:deleted')
        self.assertFalse(data['projects'][0]['sessions'][0]['artifacts'])

    def test_listing_does_not_hide_older_conversations(self):
        _, scan = self.listing('web:logo')
        self.assertEqual(scan.call_args.kwargs['session_limit'], 0)

    def test_import_preserves_batch_and_item_conversation(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, 'logo.svg')
            with open(source, 'w') as out:
                out.write('<svg/>')
            bodies = []
            def create(body):
                bodies.append(body)
                return {**body, 'version': 1}
            store = SimpleNamespace(create=create)
            payload = {'run_id': 'web:logo', 'project': '3d', 'items': [
                {'path': source, 'kind': 'image', 'title': 'batch'},
                {'path': source, 'kind': 'image', 'title': 'item', 'run_id': 'web:other', 'project': 'other'}]}
            async def read_json():
                return payload
            with patch.object(console, '_store_of', return_value=store), \
                 patch.object(console, '_same_title_index', return_value={}), \
                 patch.object(console, '_stage_file', return_value={'stored_path': '', 'file_name': 'logo.svg', 'mime': 'image/svg+xml', 'size': 6}), \
                 patch.object(console, '_stage_parts', return_value=(None, None)), \
                 patch.object(console, '_mat') as materializer, \
                 patch.object(console, '_review_url', return_value='/review'), \
                 patch.object(console, 'pilotdeck_workspace_invalidate'):
                response = asyncio.run(console.api_import(SimpleNamespace(json=read_json, remote="127.0.0.1", headers={})))
            self.assertEqual(response.status, 200)
            self.assertEqual([(b.get('run_id'), b.get('project')) for b in bodies], [('web:logo', '3d'), ('web:other', 'other')])

    def test_workspace_cache_respects_session_limit(self):
        workspace.invalidate()
        with patch.object(workspace.os, 'listdir', return_value=['3d']), \
             patch.object(workspace.os.path, 'isdir', return_value=True), \
             patch.object(workspace, '_project_entry', side_effect=lambda d, p, limit: {'last_activity_ts': 1, 'sessions': list(range(limit or 25))}):
            self.assertEqual(len(workspace.scan_projects(20)['projects'][0]['sessions']), 20)
            self.assertEqual(len(workspace.scan_projects(0)['projects'][0]['sessions']), 25)
        workspace.invalidate()


if __name__ == '__main__':
    unittest.main()
