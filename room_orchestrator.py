"""项目室编排器。

房间里有人/agent 发言之后，谁该动、怎么动，全部在这里决定：

  1. 订阅 store.bus 上的 "room.message" 事件（消息一落库就 publish）
  2. 解析 @成员 → 拿到该成员的 session_key
  3. 会话正忙 → steer_turn 插进当前 turn；空闲 → submit_turn 起新 turn
  4. 投递结果写 room_deliveries：重启后不重复投递

刻意不做的事：不把 agent 的产出自动搬回房间。回写由发言者自己调
post_room_message（MCP 工具）完成 —— 明文必须由发言者自己盖章，
编排器不替它编。

投递语义必须说清楚，别自欺：
  · steer_turn 返回 accepted=true 只表示「已入队」，不等于「已被应用」。
    本模块把它记成 state=accepted，等真跑完由 agent 自己回一条消息说明结果。
  · submit_turn 没有受理回执：服务端只在 turn 结束时推一个 final 事件帧。
    所以这里在发出前就记 state=submitted（宁可漏投也不要重复投）。
  · 任务切换（room.task_id 变了）后，旧任务的消息不再投。

连接语义也得说清楚，别自欺：
  · gateway 连不上**不能**拒绝启动 —— console 未必比 gateway 先起来，
    token 也可能还没写好。连接由后台任务维持：退避重试，掉线就重连。
  · gateway 不在线时来的消息，明确记成 failed，不排队、不重放。
    补发等于把历史重放一遍 —— 房间里的会话可能已经被人接手了，
    再叫醒一次就是重复驱动。
"""
from __future__ import annotations

import asyncio
import json
import os
import time

import aiohttp

PROTOCOL_VERSION = "1.1"
# gateway 只认 cli/tui/web/feishu/test 这几个 clientName
CLIENT_NAME = "cli"
CLIENT_VERSION = "pilotv-room/1"

# 18789 是 PilotV 自带的 gateway server 端口（upstream GatewayServer.ts:54
# 的默认值，只绑 127.0.0.1）。3001 是应用/UI 那个 server —— 它的 /ws 是聊天
# 通道，HTTP 升级就要鉴权，会直接 401。两边路径都叫 /ws，别混。
DEFAULT_WS_URL = "ws://127.0.0.1:18789/ws"

# 一个房间一生只允许这么多次自动投递。
#
# 为什么要有硬上限：房间是「A @ B，B @ A」的形状时，每一轮都会再产生一条
# 消息、每条消息又触发一次投递 —— 没有上限就是无限递归，把 token 和会话烧光。
# 20 次足够一个真实项目走完「派活 → 评审 → 返工 → 验收」几轮。
# 用完以后房间仍然照常记录明文，只是不再自动叫醒 agent；
# 要继续就在网页上明确新建房间。这是**有意的刹车**，不是故障。
ROOM_DELIVERY_BUDGET = int(os.environ.get("PILOTV_ROOM_DELIVERY_BUDGET", "20"))

# 连接节奏。gateway 未必比 console 先起来，所以「连一次就行」的做法不成立：
# 连不上要退避重试，掉线要重连。数字都做成可配的，测试里可以调快。
RECONNECT_INITIAL = float(os.environ.get("PILOTV_ROOM_RECONNECT_INITIAL", "1.0"))
RECONNECT_MAX = float(os.environ.get("PILOTV_ROOM_RECONNECT_MAX", "30.0"))
# 健康检查间隔：多久看一眼「连接还在不在」。socket 掉了是读循环发现的，
# 这里只决定多久之后去重连。
RECONNECT_HEALTH = float(os.environ.get("PILOTV_ROOM_RECONNECT_HEALTH", "1.0"))
# 单次连接尝试的上限。连不上就别把启动卡住 —— 剩下的交给后台重试。
CONNECT_GRACE = float(os.environ.get("PILOTV_ROOM_CONNECT_GRACE", "5.0"))


class GatewayError(RuntimeError):
    pass


class SnapshotError(GatewayError):
    """active_turn_snapshot 不可信。

    宁可拒绝投递，也不要在一个「可能正忙」的会话上硬起一个新 turn。
    """


def _consume(fut):
    """把 future 的异常读掉，免得 GC 时刷 "Future exception was never retrieved"。"""
    try:
        if not fut.cancelled():
            fut.exception()
    except Exception:
        pass


def resolve_token() -> str:
    """本地 gateway 的 token。读不到就报错，不要瞎猜。"""
    home = os.environ.get("PILOTDECK_HOME") or os.path.expanduser("~/.pilotdeck")
    path = os.path.join(home, "server-token")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            token = fh.read().strip()
    except OSError as exc:
        raise GatewayError(f"读不到 gateway token: {path}") from exc
    if not token:
        raise GatewayError(f"gateway token 是空的: {path}")
    return token


class GatewayClient:
    """最小可用的 gateway WS 客户端。

    只实现编排器要用的两类调用：
      request()      → steer_turn / active_turn_snapshot 这类一次性请求
      submit_turn()  → 只走 event 流，final 帧才代表 turn 结束

    协议要点（见 upstream src/gateway/server/GatewayWsConnection.ts）：
      · hello 帧必须带 protocolVersion="1.1"，否则服务端 4001 断开
      · submit_turn 服务端**不发** response 帧，只发 event 帧，最后一帧 final=true
      · 其余方法发 response 帧 {id, ok, result}
    """

    def __init__(self, url: str, token: str, timeout: float = 30.0):
        self.url = url
        self.token = token
        self.timeout = timeout
        self.hello = None
        self.connected = False
        self._session = None
        self._ws = None
        self._reader = None
        self._pending = {}   # req_id -> future（等 response 帧）
        self._streams = {}   # req_id -> future（等 final 事件帧）
        self._seq = 0

    async def connect(self):
        """连上 gateway。

        失败一律抛 GatewayError —— aiohttp 的原始异常（ClientConnectorError、
        ServerTimeoutError……）漏到上层只会被当成「连接莫名失败」，难查。
        """
        if self.connected and self._ws is not None and not self._ws.closed:
            return self.hello
        # 重连前先把上一条连接收干净：session 不关会在 GC 时刷
        # "Unclosed client session"，那条日志会被当成噪声忽略掉。
        await self._close_transport("gateway 连接已重建，等待中的请求作废")
        session = aiohttp.ClientSession()
        self._session = session
        try:
            ws = await session.ws_connect(self.url, heartbeat=30)
            self._ws = ws
            await ws.send_json({
                "type": "hello",
                "protocolVersion": PROTOCOL_VERSION,
                "clientName": CLIENT_NAME,
                "clientVersion": CLIENT_VERSION,
                "token": self.token,
            })
            deadline = time.monotonic() + 10
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise GatewayError("gateway hello 超时")
                try:
                    frame = await ws.receive_json(timeout=max(0.1, left))
                except asyncio.TimeoutError:
                    raise GatewayError("gateway hello 超时") from None
                ftype = frame.get("type") if isinstance(frame, dict) else None
                if ftype == "hello_ok":
                    self.hello = frame
                    self.connected = True
                    break
                if ftype in ("error", "response"):
                    raise GatewayError(f"gateway 拒绝握手: {frame}")
                # 别的帧（事件）先收着，握手还没完成
        except asyncio.CancelledError:
            await self._close_transport_quiet()
            raise
        except GatewayError:
            await self._close_transport_quiet()
            raise
        except Exception as exc:
            await self._close_transport_quiet()
            raise GatewayError(f"连不上 gateway {self.url}: {exc}") from exc
        self._reader = asyncio.create_task(self._read_loop())
        return self.hello

    async def close(self):
        await self._close_transport("gateway 连接已关闭")

    async def _close_transport_quiet(self):
        """收摊时别再抛 —— 调用方要看到的是原始异常，不是清理异常。"""
        try:
            await self._close_transport("gateway 连接已关闭")
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    async def _close_transport(self, reason="gateway 连接已关闭"):
        """关掉当前的 socket/session（在飞的请求一并了结）。"""
        self.connected = False
        self._fail_all(reason)
        reader, self._reader = self._reader, None
        if reader is not None:
            reader.cancel()
            try:
                await reader
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        ws, self._ws = self._ws, None
        if ws is not None and not ws.closed:
            try:
                await ws.close()
            except Exception:
                pass
        session, self._session = self._session, None
        if session is not None and not session.closed:
            try:
                await session.close()
            except Exception:
                pass

    async def _read_loop(self):
        """读 gateway 推来的帧。

        aiohttp 的 async for 迭代出来的是 WSMessage，不是 dict ——
        得自己取 .data 再 json.loads。否则一收到帧就 AttributeError，
        连接看着还活着、读循环其实已经死了，请求全靠超时收场。
        """
        try:
            async for msg in self._ws:
                if msg.type in (aiohttp.WSMsgType.TEXT, aiohttp.WSMsgType.BINARY):
                    try:
                        self._dispatch(json.loads(msg.data))
                    except (ValueError, TypeError):
                        continue
                elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED,
                                  aiohttp.WSMsgType.ERROR):
                    break
        except asyncio.CancelledError:
            raise
        except Exception:
            self._fail_all("gateway 连接断开")
            return
        # 正常结束（对端关闭）也得把在飞的请求了结掉，不能让人干等超时
        self._fail_all("gateway 连接断开")

    def _dispatch(self, frame):
        ftype = frame.get("type")
        if ftype == "response":
            fut = self._pending.pop(frame.get("id"), None)
            if fut is not None and not fut.done():
                if frame.get("ok"):
                    fut.set_result(frame.get("result"))
                else:
                    err = frame.get("error") or {}
                    fut.set_exception(
                        GatewayError(err.get("message") or "gateway 请求失败"))
        elif ftype == "event":
            if not frame.get("final"):
                return  # 中间事件：turn 进行中，当前用不上
            fut = self._streams.pop(frame.get("id"), None)
            if fut is not None and not fut.done():
                fut.set_result(frame.get("event") or {})

    def _fail_all(self, msg):
        self.connected = False
        for fut in list(self._pending.values()) + list(self._streams.values()):
            if not fut.done():
                fut.set_exception(GatewayError(msg))
                _consume(fut)
        self._pending.clear()
        self._streams.clear()

    def _next_id(self) -> str:
        self._seq += 1
        return f"room-{self._seq}-{int(time.time() * 1000)}"

    async def _send(self, frame):
        """发一帧出去。

        连接已经关了（或者从来就没连上）就抛 GatewayError：
        别把 aiohttp 的 ClientConnectionResetError、RuntimeError 之类漏给上层 ——
        上层要区分的只有「能不能用」，不是「用的哪个库报的错」。
        """
        ws = self._ws
        if not self.connected or ws is None or getattr(ws, "closed", False):
            self._fail_all("gateway 连接已关闭")
            raise GatewayError("gateway 连接已关闭")
        try:
            await ws.send_json(frame)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._fail_all(f"gateway 连接已断开: {exc}")
            raise GatewayError(f"gateway 连接已断开: {exc}") from exc

    async def request(self, method, params, timeout=None):
        rid = self._next_id()
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            await self._send({"type": "request", "id": rid,
                              "method": method, "params": params})
        except GatewayError:
            self._pending.pop(rid, None)
            raise
        try:
            return await asyncio.wait_for(fut, timeout or self.timeout)
        except asyncio.TimeoutError:
            self._pending.pop(rid, None)
            raise GatewayError(f"{method} 超时")

    async def submit_turn(self, params, timeout=1800):
        rid = self._next_id()
        fut = asyncio.get_running_loop().create_future()
        self._streams[rid] = fut
        try:
            await self._send({"type": "request", "id": rid,
                              "method": "submit_turn", "params": params})
        except GatewayError:
            self._streams.pop(rid, None)
            raise
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self._streams.pop(rid, None)
            raise GatewayError("submit_turn 超时")


def classify_active_snapshot(snap, session_key):
    """严格判读 active_turn_snapshot 的返回值。

    返回 (busy, run_id)：
      busy=False → 会话空闲，可以起新 turn
      busy=True  → 会话正忙，只能 steer（run_id 就是那个 turn）

    判读不出来就抛 SnapshotError。调用方绝不能在「不知道忙不忙」的时候 submit ——
    那等于在一个正跑着的会话上硬起第二个 turn。

    规则：
      · active 必须显式存在且是布尔值：只有 active=false 才算空闲
      · active=true 必须带非空 runId（否则 steer 都不知道往哪插）
      · 快照里带了 sessionKey 就必须和目标一致 —— 不一致说明拿错了会话
    """
    if not isinstance(snap, dict):
        raise SnapshotError("active_turn_snapshot 返回的不是对象")
    if "active" not in snap:
        raise SnapshotError("active_turn_snapshot 没有 active 字段：判不出会话忙不忙")
    active = snap.get("active")
    if not isinstance(active, bool):
        raise SnapshotError(f"active_turn_snapshot 的 active 不是布尔值: {active!r}")
    snap_key = snap.get("sessionKey")
    if "sessionKey" in snap and snap_key != session_key:
        raise SnapshotError(
            f"active_turn_snapshot 的 sessionKey 不匹配: {snap_key} != {session_key}")
    if not active:
        return False, None
    run_id = snap.get("runId")
    if not isinstance(run_id, str) or not run_id.strip():
        raise SnapshotError("active_turn_snapshot 说会话在忙，但没给 runId")
    return True, run_id


class RoomOrchestrator:
    """把房间里的 @ 指令变成对成员会话的真实动作。"""

    def __init__(self, store, gateway=None, channel_key="web", log=None,
                 reconnect_initial=None, reconnect_max=None,
                 health_interval=None, connect_grace=None):
        self.store = store
        self.gateway = gateway
        self._injected_gateway = gateway
        self.channel_key = channel_key
        self._log = log or (lambda msg: None)
        self._sub = None
        self._task = None
        self._conn_task = None
        self._connect_lock = asyncio.Lock()
        self._inflight = set()
        self.reconnect_initial = (RECONNECT_INITIAL if reconnect_initial is None
                                  else float(reconnect_initial))
        self.reconnect_max = (RECONNECT_MAX if reconnect_max is None
                              else float(reconnect_max))
        self.health_interval = (RECONNECT_HEALTH if health_interval is None
                                else float(health_interval))
        self.connect_grace = (CONNECT_GRACE if connect_grace is None
                              else float(connect_grace))

    # ------------------------------------------------------------ 生命周期

    async def start(self):
        """起编排器。

        刻意**不**因为 gateway 连不上就失败：console 可能比 gateway 先起来，
        token 也可能还没写好。要是这里抛异常，console 会把编排器永久放弃 ——
        那段时间里的房间消息就再也没人管了。
        """
        if self._task is not None:
            return
        # 只收新事件：last_id 取当前游标，不要把历史 ring 重放一遍
        self._sub = self.store.bus.subscribe(self.store.bus.last_id)
        self._task = asyncio.create_task(self._loop())
        # 首次连接尽力而为：成了就绪；没成也不阻塞启动，后面由后台退避重连。
        try:
            await self._ensure_connected()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._log(f"gateway 暂时用不了（后台会重试）: {exc}")
        self._conn_task = asyncio.create_task(self._connection_loop())

    async def stop(self):
        for name in ("_conn_task", "_task"):
            task = getattr(self, name)
            if task is None:
                continue
            setattr(self, name, None)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        if self._sub is not None:
            self.store.bus.unsubscribe(self._sub)
            self._sub = None
        if self.gateway is not None:
            try:
                await self.gateway.close()
            except Exception:
                pass
            self.gateway = None

    # ------------------------------------------------------------ 连接维护

    def _ensure_gateway(self):
        """拿到 gateway 客户端。token 读不到就抛 GatewayError（后台会重试）。"""
        if self.gateway is None:
            gw = self._injected_gateway
            if gw is None:
                url = os.environ.get("PILOTV_ROOM_GATEWAY_WS", DEFAULT_WS_URL)
                gw = GatewayClient(url, resolve_token())
            self.gateway = gw
        return self.gateway

    def _gateway_ready(self) -> bool:
        """现在能不能往 gateway 发请求。

        判据跟 GatewayClient 对齐：connected 为 False，或者底层 socket 已经关了，
        都算不在线。测试替身没有 connected 属性 —— 那就当它在线（它自己管）。
        """
        gw = self.gateway
        if gw is None:
            return False
        ws = getattr(gw, "_ws", None)
        if ws is not None and getattr(ws, "closed", False):
            return False
        connected = getattr(gw, "connected", None)
        if connected is None:
            return True
        return bool(connected)

    async def _ensure_connected(self):
        """确保 gateway 在线。连不上就返回 False（不抛给调用方）。"""
        async with self._connect_lock:
            gw = self._ensure_gateway()
            connect = getattr(gw, "connect", None)
            if connect is None or self._gateway_ready():
                return self._gateway_ready()
            try:
                await asyncio.wait_for(connect(), timeout=self.connect_grace)
            except asyncio.TimeoutError:
                self._log("gateway 连接超时（不阻塞启动，后台会重试）")
                return False
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._log(f"gateway 暂时连不上（后台会重试）: {exc}")
                return False
            self._log(f"房间编排器已连上 gateway: {getattr(gw, 'url', '')}")
            return True

    async def _connection_loop(self):
        """后台盯着 gateway：连不上就退避重试，掉线了就重连。

        为什么必须在后台：console 启动时 gateway 未必就绪。编排器要是因此
        拒绝启动，那段时间里的房间消息就永久丢了 —— 而且没法补发（补发就是重放）。
        """
        delay = self.reconnect_initial
        while True:
            try:
                ok = await self._ensure_connected()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                ok = False
                self._log(f"房间编排器连 gateway 失败: {exc}")
            if ok:
                delay = self.reconnect_initial
                await asyncio.sleep(self.health_interval)
            else:
                await asyncio.sleep(delay)
                delay = min(delay * 2.0, self.reconnect_max)

    async def _loop(self):
        while True:
            try:
                _, event, data = await self._sub.get()
            except asyncio.CancelledError:
                raise
            if event != "room.message":
                continue
            try:
                await self._handle(data or {})
            except Exception as exc:
                self._log(f"房间派发失败: {exc!r}")

    # ------------------------------------------------------------ 派发

    def _targets(self, room, msg):
        """按房间策略算出这条消息该投给谁。

        策略（room.respond_policy）：
          mentions  只有被 @ 的成员（默认）
          everyone  房间里所有非 human 成员
          member    发言者是房间里的人时才投（人发的必须显式 @）
          off       一个都不投 —— 人手里的急停，防止互相 @ 打成死循环
        """
        policy = room.get("respond_policy") or "mentions"
        members = room.get("members", [])
        if policy == "off":
            return []
        author = msg.get("author") or ""
        mentioned = msg.get("mentions") or []
        out = []
        for member in members:
            if member.get("role") == "human":
                continue
            name = member.get("display_name") or ""
            if not name or name == author:
                continue  # 别回灌给自己
            if policy == "everyone":
                pass
            elif policy == "member":
                # 只有「房间里成员发的消息」才触发。
                # 人（网页上的观众）发的消息必须显式 @ 才算数。
                if not any(m.get("display_name") == author for m in members) \
                        and name not in mentioned:
                    continue
            else:  # mentions
                if name not in mentioned:
                    continue
            out.append(member)
        return out

    async def _handle(self, data):
        msg = data.get("message") or {}
        room_id = data.get("room_id") or msg.get("room_id")
        room = self.store.get_room(room_id)
        if not room:
            return
        policy = room.get("respond_policy") or "mentions"
        targets = self._targets(room, msg)
        if policy == "off":
            # 急停也要留下痕迹：网页上要能看到「这条没投，因为房间被关了」。
            for member in room.get("members", []):
                if member.get("role") == "human":
                    continue
                if self.store.delivery_state(room_id, msg.get("seq"),
                                             member.get("member_id")) is not None:
                    continue
                self.store.record_delivery(
                    room_id, msg.get("seq"), member.get("member_id"), "skipped",
                    reason="房间策略为 off：不自动投递")
            return
        for member in targets:
            mid = member.get("member_id")
            prev = self.store.delivery_state(room_id, msg.get("seq"), mid)
            if prev is not None:
                continue  # 已经投过：宁可漏投也不要重复投
            room_task = room.get("task_id")
            msg_task = msg.get("task_id")
            if room_task and msg_task and room_task != msg_task:
                self.store.record_delivery(
                    room_id, msg.get("seq"), mid, "skipped",
                    reason=f"任务不匹配: {msg_task} != {room_task}")
                continue
            if not member.get("session_key"):
                self.store.record_delivery(
                    room_id, msg.get("seq"), mid, "skipped",
                    reason="成员没有 session_key")
                continue
            if self.store.room_delivery_count(room_id) >= ROOM_DELIVERY_BUDGET:
                self.store.record_delivery(
                    room_id, msg.get("seq"), mid, "skipped",
                    reason=f"房间自动投递预算（{ROOM_DELIVERY_BUDGET} 次）已用完："
                           "请明确新建房间，或把策略改成 off")
                continue
            await self._deliver(room, member, msg)

    async def _deliver(self, room, member, msg):
        room_id = room.get("id")
        seq = msg.get("seq")
        mid = member.get("member_id")
        key = member.get("session_key")
        item_id = f"room-{room_id}-{seq}-{mid}"
        text = self._instruction(room, member, msg)

        # gateway 不在线：这一条明确记成没投出去。
        # 绝不排队等重连后再补发 —— 补发就是历史重放，房间里的会话可能
        # 已经被人接手了，再叫醒一次就是重复驱动。
        if not self._gateway_ready():
            self.store.record_delivery(room_id, seq, mid, "failed",
                                       reason="gateway 未连接：这条没投出去（不重放）")
            return

        try:
            snap = await self.gateway.request(
                "active_turn_snapshot",
                {"sessionKey": key, "includeEvents": False})
        except GatewayError as exc:
            self.store.record_delivery(room_id, seq, mid, "failed",
                                       reason=f"Cannot safely determine active turn: {exc}")
            return

        # 快照必须能明确判读：active=false 才算空闲，active=true 必须带 runId。
        # 判读不出来就拒绝投递 —— 宁可漏投，也不要在「可能正忙」的会话上起新 turn。
        try:
            busy, run_id = classify_active_snapshot(snap, key)
        except SnapshotError as exc:
            self.store.record_delivery(room_id, seq, mid, "failed", reason=str(exc))
            return

        if busy:
            try:
                res = await self.gateway.request("steer_turn", {
                    "sessionKey": key,
                    "runId": run_id,
                    "itemId": item_id,
                    "message": text,
                })
            except GatewayError as exc:
                self.store.record_delivery(room_id, seq, mid, "failed",
                                           item_id=item_id, reason=str(exc))
                return
            res = res if isinstance(res, dict) else {}
            accepted = bool(res.get("accepted"))
            reason = res.get("reason")
            if accepted:
                # accepted 只代表入队，不代表已被应用
                self.store.record_delivery(room_id, seq, mid, "accepted",
                                           item_id=item_id, reason="steer 已入队")
                return
            # Only an explicitly idle turn permits fallback; cancellation is a stop.
            self._log(f"steer 被拒({reason}): {key}")
            self.store.record_delivery(room_id, seq, mid, "rejected",
                                       item_id=item_id,
                                       reason=reason or "steer 被拒（gateway 没给原因）")
            if reason != "no_active_turn":
                return

        params = {"sessionKey": key, "channelKey": self.channel_key, "message": text}
        # 发出前就记账：submit_turn 没有受理回执，只能事后才知道成没成
        self.store.record_delivery(room_id, seq, mid, "submitted", item_id=item_id)
        task = asyncio.create_task(self._run_turn(params, room_id, seq, mid, item_id))
        self._inflight.add(task)
        task.add_done_callback(self._inflight.discard)

    async def _run_turn(self, params, room_id, seq, mid, item_id):
        try:
            final = await self.gateway.submit_turn(params)
            self.store.record_delivery(room_id, seq, mid, "completed",
                                       item_id=item_id,
                                       reason=json.dumps(final, ensure_ascii=False)[:400])
        except Exception as exc:
            self.store.record_delivery(room_id, seq, mid, "failed",
                                       item_id=item_id, reason=str(exc))

    # ------------------------------------------------------------ 文案

    def _instruction(self, room, member, msg) -> str:
        """把房间消息变成给成员的指令：原文保留，来源标清。

        刻意不加工、不总结 agent 的发言 —— 房间是明文，
        这里只做「谁在什么房间里说了什么」的包装。
        """
        lines = []
        bulletin = (room.get("bulletin") or "").strip()
        if bulletin:
            lines.append("[房间公告]")
            lines.append(bulletin)
            lines.append("")
        lines.append(f"[房间「{room.get('name')}」· seq={msg.get('seq')}]")
        lines.append(f"发言人：{msg.get('author') or msg.get('role')}")
        if msg.get("reply_to"):
            lines.append(f"回复消息 seq={msg.get('reply_to')}")
        if room.get("task_id"):
            lines.append(f"当前任务：{room.get('task_id')}")
        lines.append("")
        lines.append(msg.get("text") or "")
        lines.append("")
        lines.append(
            "处理完后请调用 post_room_message 把结论回写到这个房间（明文，"
            "带 room_id=（见下行） 和你的名字）。没回写的话房间里的人看不到你的产出。")
        lines.append(f"room_id: {room.get('id')}; author: {member.get('display_name')}")
        return "\n".join(lines)
