"""Regression tests for the global artifacts SSE endpoint, without a server."""
import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import artifacts_console as console


class Bus:
    def __init__(self):
        self.queue = asyncio.Queue()
        self.unsubscribed = False

    def subscribe(self, last_id):
        return self.queue

    def unsubscribe(self, queue):
        self.unsubscribed = queue is self.queue


class Response:
    def __init__(self, **kwargs):
        self.writes = []

    async def prepare(self, request):
        pass

    async def write(self, data):
        self.writes.append(data)
        if data.startswith(b'id:'):
            raise ConnectionResetError('test client disconnected')


class EventsTests(unittest.IsolatedAsyncioTestCase):
    async def test_global_stream_emits_artifact_event_and_releases_subscription(self):
        bus = Bus()
        bus.queue.put_nowait((7, 'artifact.created', {'id': 'fixture'}))
        store = type('Store', (), {'bus': bus})()
        request = type('Request', (), {'app': {'artifacts_store': store},
                                     'headers': {}, 'query': {}})()
        response = Response()
        with patch.object(console.web, 'StreamResponse', return_value=response):
            await asyncio.wait_for(console.api_events.__wrapped__(request), timeout=1)
        self.assertEqual(response.writes[1], b'id: 7\nevent: artifact.created\ndata: {"id": "fixture"}\n\n')
        self.assertTrue(bus.unsubscribed)

    async def test_room_stream_filters_other_rooms(self):
        bus = Bus()
        bus.queue.put_nowait((1, 'room.delivery', {'room_id': 'other'}))
        bus.queue.put_nowait((2, 'artifact.created', {'id': 'unrelated'}))
        bus.queue.put_nowait((3, 'room.message', {'room_id': 'target'}))
        store = type('Store', (), {'bus': bus, 'get_room': lambda self, rid: {'id': rid}})()
        request = type('Request', (), {'app': {'artifacts_store': store},
                                     'headers': {}, 'query': {},
                                     'match_info': {'rid': 'target'}})()
        response = Response()
        with patch.object(console.web, 'StreamResponse', return_value=response):
            await asyncio.wait_for(console.api_room_events.__wrapped__(request), timeout=1)
        self.assertEqual(len(response.writes), 2)
        self.assertIn(b'id: 3\nevent: room.message', response.writes[1])
        self.assertTrue(bus.unsubscribed)

    async def test_room_prepare_failure_releases_subscription(self):
        bus = Bus()
        store = type('Store', (), {'bus': bus, 'get_room': lambda self, rid: {'id': rid}})()
        request = type('Request', (), {'app': {'artifacts_store': store},
                                     'headers': {}, 'query': {},
                                     'match_info': {'rid': 'target'}})()
        response = Response()
        async def fail_prepare(request):
            raise ConnectionResetError('test disconnect during headers')
        response.prepare = fail_prepare
        with patch.object(console.web, 'StreamResponse', return_value=response):
            try:
                await console.api_room_events.__wrapped__(request)
            except ConnectionResetError:
                pass
        self.assertTrue(bus.unsubscribed)

    async def test_prepare_failure_releases_subscription(self):
        bus = Bus()
        store = type('Store', (), {'bus': bus})()
        request = type('Request', (), {'app': {'artifacts_store': store},
                                     'headers': {}, 'query': {}})()
        response = Response()
        async def fail_prepare(request):
            raise ConnectionResetError('test disconnect during headers')
        response.prepare = fail_prepare
        with patch.object(console.web, 'StreamResponse', return_value=response):
            try:
                await console.api_events.__wrapped__(request)
            except ConnectionResetError:
                pass
        self.assertTrue(bus.unsubscribed)


if __name__ == '__main__':
    unittest.main()
