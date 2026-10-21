# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""MCP 工具调用超时包络（生产级"超时控制"）。

背景：stdio 主循环是**串行**的——逐行读请求、整段处理完再读下一行。
若一个工具（如 ai_diagnose 调 LLM、run_inspection 跑重型巡检）挂起或极慢，
整个 Server 会被冻结，后续所有请求排队无响应。本模块提供墙钟超时：

- 在守护线程中执行 handler，主线程 join(timeout)；
- 超时即返回结构化 MCP_TOOL_TIMEOUT 错误，主循环继续处理后续请求；
- 超时后原线程继续后台运行（守护线程，不阻塞进程退出）；
  子进程类工具由 analysis_cli 自身的 subprocess 超时兜底回收。

默认上限由 ``DBCHECK_MCP_TOOL_TIMEOUT``（秒）控制，缺省 600。
"""

import os
import sys
import threading

DEFAULT_TIMEOUT = float(os.environ.get("DBCHECK_MCP_TOOL_TIMEOUT", "600"))


def _log(msg: str) -> None:
    sys.stderr.write(f"[mcp-timeout] {msg}\n")
    sys.stderr.flush()


class _Result:
    __slots__ = ("value", "exc")


def run_with_timeout(func, timeout=None, args=None, kwargs=None):
    """在线程中执行 ``func(*args, **kwargs)``，超时返回 ``(None, True)``。

    返回:
        (result, False)   成功，result 为函数返回值
        (None, True)      超时（函数仍在后台线程运行）
    若函数在超时前抛异常，异常会在本调用内重新抛出（由上层统一捕获）。
    """
    timeout = DEFAULT_TIMEOUT if timeout is None else float(timeout)
    args = args or ()
    kwargs = kwargs or {}
    res = _Result()
    res.value = None
    res.exc = None
    done = threading.Event()

    def _target():
        try:
            res.value = func(*args, **kwargs)
        except BaseException as e:  # 捕获一切，含 KeyboardInterrupt 之外
            res.exc = e
        finally:
            done.set()

    t = threading.Thread(target=_target, daemon=True)
    t.start()
    if done.wait(timeout):
        if res.exc is not None:
            raise res.exc
        return res.value, False
    # 超时：不 join（避免阻塞），返回哨兵。守护线程后台继续，进程退出时随主进程消亡。
    _log(f"tool call timed out after {timeout}s (background thread continues)")
    return None, True


def mcp_timeout_error(name: str, timeout: float) -> dict:
    """构造超时结构化响应（与 server.handle 的 error 结构对齐）。"""
    return {
        "ok": False,
        "error_code": "MCP_TOOL_TIMEOUT",
        "error": (f"工具 {name} 执行超过 {timeout}s 上限被中断；"
                  f"后台任务仍在运行，请稍后重试或检查目标数据源状态"),
    }


def get_timeout() -> float:
    """返回当前生效的超时上限（秒）。"""
    return DEFAULT_TIMEOUT
