# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""分析子进程池（生产级"连接池"类比，opt-in）。

为什么需要：``tools._run_analysis_subprocess`` 当前**每次调用都冷启动一个 Python
解释器 + bootstrap + 迁移 + 导入驱动/插件**，耗时数秒。本池预热并保持 N 个常驻
``analysis_cli.py --worker`` 进程，复用解释器与已导入的驱动/插件（数据库类型适配、
JDBC 插件等），单次调用只做"连接→分析→关闭"，省去冷启动。这与 MCP Toolbox 强调的
"连接池 / 生产级"思路一致，且**不引入任何外部依赖**。

安全性：
- 仅配置开启（``mcp_server_config.json`` 的 ``subproc_pool_enabled``、``dbc_config.json``
  的 ``mcp_server`` 节点，或环境变量 ``DBCHECK_MCP_SUBPROC_POOL=1``）时由 ``get_pool()``
  创建；默认不创建，保持原有一次性子进程行为（零回归）。
- 每个任务只占一个 worker（串行执行），不存在跨实例共享 DB 连接（每次仍按 instance
  重新 connect_instance/close_instance），不引入越权/连接串扰风险。
- worker 读超时即回收并回退到一次性子进程；spawn 失败也回退一次性路径。
- 池内 worker 的 stderr 指向 DEVNULL（避免输出管道缓冲死锁），日志由可观测层覆盖。

线程安全：所有状态变更在 ``self._lock`` 保护下。
"""

import json
import os
import subprocess
import sys
import threading
import time
from collections import deque

from modules.mcp_server.timeout import get_timeout

_STARTUP_TIMEOUT = 120.0   # worker 预热（bootstrap+导入）允许的最长握手时间
_IDLE_TTL = 300.0          # 空闲 worker 最长存活时间（超过则回收，保留 min_idle 预热）

_pool = None
_pool_lock = threading.Lock()


def _log(msg: str) -> None:
    sys.stderr.write(f"[mcp-pool] {msg}\n")
    sys.stderr.flush()


def _cli_path() -> str:
    return os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "analysis_cli.py")


def _readline_with_timeout(stream, timeout: float):
    """在后台线程读一行，超时被调用方回收 worker。返回行字符串或超时抛 TimeoutError。"""
    box = {}
    ev = threading.Event()

    def _reader():
        try:
            box["line"] = stream.readline()
        except Exception as e:  # noqa: BLE001
            box["err"] = e
        ev.set()

    th = threading.Thread(target=_reader, daemon=True)
    th.start()
    if ev.wait(timeout):
        if "err" in box:
            raise box["err"]
        return box.get("line")
    raise TimeoutError("readline timeout")


class AnalysisSubprocessPool:
    def __init__(self, min_idle: int = 1, max_workers: int = 4,
                 task_timeout: float = None, idle_ttl: float = _IDLE_TTL):
        self._lock = threading.Lock()
        self._idle: deque = deque()
        self._all: list = []
        self._min_idle = max(0, int(min_idle))
        self._max_workers = max(self._min_idle, int(max_workers))
        self._task_timeout = float(task_timeout) if task_timeout else get_timeout()
        self._idle_ttl = float(idle_ttl)
        self._seq = 0
        self._closed = False
        # 预热 min_idle 个 worker，并放入空闲队列供复用
        for _ in range(self._min_idle):
            with self._lock:
                if self._closed:
                    break
                w = self._spawn_locked()
                if w is not None:
                    self._idle.append(w)

    # ── worker 生命周期 ──────────────────────────────────────────────────────
    def _spawn_locked(self):
        """（调用方持锁）启动一个常驻 worker，成功加入池并返回其句柄，失败返回 None。"""
        if len(self._all) >= self._max_workers:
            return None
        py = sys.executable
        cli = _cli_path()
        env = dict(os.environ)
        env["DBCheck_MCP_ANALYSIS_SUBPROCESS"] = "1"
        try:
            proc = subprocess.Popen(
                [py, cli, "--worker"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, env=env,
                encoding="utf-8", bufsize=1,
            )
        except Exception as e:  # noqa: BLE001
            _log(f"spawn worker failed: {e}")
            return None
        # 读取握手行（READY），超时即视为启动失败
        try:
            line = _readline_with_timeout(proc.stdout, _STARTUP_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            _log(f"worker 握手超时/失败: {e}")
            self._kill(proc)
            return None
        line = (line or "").strip()
        if not line.startswith("{"):
            _log(f"worker 握手返回非 JSON: {line[:120]}")
            self._kill(proc)
            return None
        try:
            ready = json.loads(line)
        except Exception:
            self._kill(proc)
            return None
        if not ready.get("ready"):
            _log(f"worker 就绪握手失败: {line[:120]}")
            self._kill(proc)
            return None
        self._seq += 1
        worker = {
            "seq": self._seq, "proc": proc,
            "in_use": False, "last_used": time.time(),
        }
        self._all.append(worker)
        _log(f"worker #{worker['seq']} 就绪（池中 {len(self._all)}）")
        return worker

    def _kill(self, proc) -> None:
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
        try:
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            pass

    def _discard_locked(self, worker) -> None:
        """（调用方持锁）从池中移除并强杀一个 worker。"""
        try:
            self._all.remove(worker)
        except ValueError:
            pass
        try:
            self._idle.remove(worker)
        except ValueError:
            pass
        self._kill(worker.get("proc"))

    def _reap_locked(self) -> None:
        """（调用方持锁）回收过期空闲 worker，但至少保留 min_idle 个预热。"""
        now = time.time()
        keep = []
        while self._idle:
            w = self._idle.popleft()
            if w["proc"].poll() is not None:
                try:
                    self._all.remove(w)
                except ValueError:
                    pass
                self._kill(w["proc"])
                continue
            if (now - w["last_used"] > self._idle_ttl
                    and len(self._all) > self._min_idle):
                try:
                    self._all.remove(w)
                except ValueError:
                    pass
                self._kill(w["proc"])
                continue
            keep.append(w)
        self._idle.extend(keep)

    # ── 借还 ────────────────────────────────────────────────────────────────
    def _acquire(self):
        """获取一个可用 worker：复用空闲、否则在 max 内新建；失败返回 None。"""
        with self._lock:
            self._reap_locked()
            while self._idle:
                w = self._idle.popleft()
                if w["proc"].poll() is None:
                    w["in_use"] = True
                    w["last_used"] = time.time()
                    return w
                self._discard_locked(w)
            if len(self._all) < self._max_workers:
                w = self._spawn_locked()
                if w is not None:
                    w["in_use"] = True
                    return w
        return None

    def _release(self, worker) -> None:
        with self._lock:
            if self._closed or worker not in self._all:
                return
            worker["in_use"] = False
            worker["last_used"] = time.time()
            self._idle.append(worker)

    # ── 执行 ────────────────────────────────────────────────────────────────
    def run(self, task: dict, timeout: float = None) -> dict:
        """在池中执行一个分析任务，返回与 analysis_cli 一致的结构化 dict。

        任何池/worker 层面的故障都转为结构化失败（不抛异常），由上层工具决定是否
        回退一次性子进程。
        """
        timeout = float(timeout) if timeout else self._task_timeout
        worker = self._acquire()
        if worker is None:
            return {"ok": False, "error": "分析子进程池无可用 worker（已达上限或启动失败）"}
        try:
            return self._execute_on(worker, task, timeout)
        finally:
            self._release(worker)

    def _execute_on(self, worker, task: dict, timeout: float) -> dict:
        proc = worker["proc"]
        # 发任务
        try:
            proc.stdin.write(json.dumps(task, ensure_ascii=False) + "\n")
            proc.stdin.flush()
        except Exception as e:  # noqa: BLE001
            with self._lock:
                self._discard_locked(worker)
            return {"ok": False, "error": f"worker 写任务失败: {e}"}
        # 读结果（带墙钟上限）
        try:
            line = _readline_with_timeout(proc.stdout, timeout)
        except TimeoutError:
            with self._lock:
                self._discard_locked(worker)
            return {"ok": False, "error": f"分析超时（>{timeout:.0f}s），worker 已回收"}
        except Exception as e:  # noqa: BLE001
            with self._lock:
                self._discard_locked(worker)
            return {"ok": False, "error": f"worker 读结果失败: {e}"}
        if line is None:  # EOF：worker 已死
            with self._lock:
                self._discard_locked(worker)
            return {"ok": False, "error": "分析 worker 异常退出"}
        line = line.strip()
        if not line.startswith("{"):
            with self._lock:
                self._discard_locked(worker)
            return {"ok": False, "error": f"worker 返回非 JSON: {line[:200]}"}
        try:
            return json.loads(line)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"worker 返回无法解析: {e}"}

    # ── 关闭 ────────────────────────────────────────────────────────────────
    def shutdown(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            for w in list(self._all):
                proc = w["proc"]
                try:
                    proc.stdin.write(json.dumps({"__quit": 1}) + "\n")
                    proc.stdin.flush()
                except Exception:  # noqa: BLE001
                    pass
            # 给 worker 一点时间优雅退出
            for w in list(self._all):
                try:
                    w["proc"].wait(timeout=3)
                except Exception:  # noqa: BLE001
                    pass
            for w in list(self._all):
                self._kill(w["proc"])
            self._all.clear()
            self._idle.clear()
        _log("pool shutdown")


def get_pool() -> "AnalysisSubprocessPool | None":
    """单例：仅当配置开启时创建；否则返回 None（调用方回退一次性）。

    开启来源（任意其一）：``mcp_server_config.json`` 的 ``subproc_pool_enabled``、
    ``dbc_config.json`` 的 ``mcp_server.subproc_pool_enabled``、或环境变量
    ``DBCHECK_MCP_SUBPROC_POOL=1``（环境变量优先级最高，兼容旧部署）。
    """
    global _pool
    if _pool is not None:
        return _pool
    from modules.mcp_server.config import MCP_CONFIG
    if not MCP_CONFIG.get("subproc_pool_enabled"):
        return None
    with _pool_lock:
        if _pool is not None:
            return _pool
        min_idle = int(MCP_CONFIG.get("pool_min", 1))
        max_workers = int(MCP_CONFIG.get("pool_max", 4))
        _pool = AnalysisSubprocessPool(min_idle=min_idle, max_workers=max_workers)
        _log(f"pool created (min={min_idle}, max={max_workers})")
    return _pool


def shutdown_pool() -> None:
    """安全关闭单例池（未创建则为空操作）。供 server 退出 / atexit 调用。"""
    global _pool
    with _pool_lock:
        if _pool is not None:
            _pool.shutdown()
            _pool = None
