# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 助手 · 等待时让出 gevent hub 的小工具。

Web 层跑在 ``async_mode='gevent'`` 上，但进程没有做 monkey-patch
（见 ``modules/web/app.py`` 顶部）：``queue.Queue.get(timeout=…)``、``Thread.join``、
``time.sleep`` 都是操作系统级阻塞，会把当前 greenlet 占着的 hub 整段钉住。
助手一次回复要等模型几秒到几十秒，这期间**所有接口**都排不上队，
表现就是「助手一发消息，整个页面像坏了」。

规则只有一条：请求线程里凡是要「等别的线程」的地方，都改成短轮询，
每 ``POLL_SECONDS`` 让出一次 hub；真正的长活儿（模型调用、工具执行）本来就在线程里跑。
"""

import queue
import time

# 让出粒度：20ms 足够让别的请求插进来，人眼与前端也都感觉不到额外延迟
POLL_SECONDS = 0.02


def pause(seconds):
    """等待 ``seconds`` 秒，并让出 gevent hub；gevent 不在场时退化为普通 sleep。"""
    if seconds <= 0:
        return
    try:
        import gevent
        gevent.sleep(seconds)
    except Exception:                       # 脚本、测试里没有 gevent
        time.sleep(seconds)


def next_event(events, timeout):
    """取一条队列事件，最长等 ``timeout`` 秒；超时返回 ``None``。

    每取到一条事件即重新计时，所以 ``timeout`` 是「空闲上限」而不是「总时长上限」——
    深度思考期间只要还在吐字，就不会被误判成超时。
    """
    deadline = time.monotonic() + timeout
    while True:
        try:
            return events.get_nowait()
        except queue.Empty:
            pass
        left = deadline - time.monotonic()
        if left <= 0:
            return None
        pause(min(POLL_SECONDS, left))


def wait_thread(thread, timeout):
    """等子线程收尾（``Thread.join`` 会阻塞 hub，这里用轮询代替）。"""
    deadline = time.monotonic() + timeout
    while thread.is_alive():
        left = deadline - time.monotonic()
        if left <= 0:
            return
        pause(min(POLL_SECONDS, left))
