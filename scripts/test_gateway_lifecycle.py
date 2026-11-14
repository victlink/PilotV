"""Gateway connection lifecycle regression tests; no sockets or real state."""
import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from room_orchestrator import GatewayClient


class GatewayLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_connection_closes_session(self):
        session = AsyncMock()
        session.closed = False
        session.ws_connect.side_effect = asyncio.CancelledError
        client = GatewayClient('ws://example.invalid', 'synthetic-token')
        with patch('room_orchestrator.aiohttp.ClientSession', return_value=session):
            with self.assertRaises(asyncio.CancelledError):
                await client.connect()
        session.close.assert_awaited_once()
        self.assertIsNone(client._session)
        self.assertFalse(client.connected)


if __name__ == '__main__':
    unittest.main()
