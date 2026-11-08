# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · 模型调用统一入口。

归属说明：本模块的错误占位与深度思考透传约定归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) 所有。

* 配置单一来源：``dbc_config.json`` 的 ``ai`` 段与
  ``modules/web/app.py`` 的 ``_call_llm``（AI 设置页、诊断中心、巡检 AI 分析
  共用一套配置与调用链），不再新增第二套模型配置；
* 错误即返回：模型不可用时返回以 ``[`` 开头的占位串
  （如 ``[Ollama 调用失败: …]``），调用方据此判定降级，不把错误当答案落库；
* 深度思考透传：``on_reasoning`` 接 ``reasoning`` /
  ``reasoning_content``，供前端「深度思考」块实时展示，同时让上层事件队列在
  长思考期间持续收到数据、不误判超时。

模型名与后端来源都从这里读，助手页脚的「模型信息」与巡检 AI 分析用同一份口径。
"""

_ERROR_PREFIX = '['

# 模型调用放线程里跑、事件用队列送回（见 call() 的说明）
from queue import Queue as _Queue           # noqa: E402
from threading import Thread as _Thread     # noqa: E402

from modules.ai import hub as _hub


def _app():
    """延迟取 modules.web.app：避免包 import 期与 web 层形成循环依赖。"""
    from modules.web import app as web_app
    return web_app


def load_ai_config():
    """读取 AI 配置（与本仓库其它 AI 功能同源，缺配置时返回空 dict 由上层降级）。"""
    try:
        return _app()._load_ai_config() or {}
    except Exception:
        return {}


def is_available(config=None):
    """模型是否可用（与 ``/api/chat/stream`` 的判定一致：openai 必须显式启用）。"""
    cfg = config if config is not None else load_ai_config()
    backend = str(cfg.get('backend') or 'ollama')
    if backend == 'openai':
        return bool(cfg.get('online_enabled'))
    if backend in ('disabled', 'none', ''):
        return False
    return backend in ('ollama', 'openai')


def model_label(config=None):
    """人类可读的模型标识，用于助手顶栏/侧栏的「模型信息」。"""
    cfg = config if config is not None else load_ai_config()
    if not is_available(cfg):
        return {'available': False, 'backend': 'disabled', 'model': '', 'label': 'AI 未启用'}
    backend = str(cfg.get('backend') or 'ollama')
    if backend == 'openai':
        model = str(cfg.get('online_model') or cfg.get('model') or '')
    else:
        model = str(cfg.get('model') or '')
    return {
        'available': True,
        'backend': backend,
        'model': model,
        'label': '%s / %s' % (backend, model) if model else backend,
    }


def idle_timeout(config=None):
    """事件队列的空闲等待窗口：略大于套接字超时，让上游真实错误先报出来。

    队列抢先超时会给出误导性的「AI 分析超时」；思考模型在推理阶段持续产生事件，
    每次事件都会重置这个窗口，长思考不会被误杀。
    """
    cfg = config if config is not None else load_ai_config()
    try:
        configured = int(cfg.get('timeout') or 600)
    except (TypeError, ValueError):
        configured = 600
    return max(300, configured + 30)


def looks_like_error(text):
    """判定是否错误占位串：调用失败时返回以 ``[`` 开头的文本，而不是答案。"""
    return not text or str(text).lstrip().startswith(_ERROR_PREFIX)


# 「等不到模型输出」占位串的识别标记：编排层据此把整轮对话收手，
# 不再逐个阶段各等一次超时（三段各等 90s 就是用户面对转圈的四分半钟）。
_NO_RESPONSE_MARK = '没有任何响应'


def is_no_response(text):
    """这段文本是不是「模型无响应」占位串（而不是模型给出的答案）。"""
    text = str(text or '')
    return text.lstrip().startswith('[模型') and _NO_RESPONSE_MARK in text


def call(prompt, system='', on_content=None, on_reasoning=None, no_event_limit=None,
         first_event_limit=None):
    """调用模型并返回完整文本。

    ``on_content`` / ``on_reasoning`` 为流式回调；两者都不传时走非流式。
    调用异常统一收敛成 ``[错误]`` 文本，交给上层判定降级，异常不外抛
    （对话流不能因为模型问题整条断掉）。

    为什么要放到独立线程里跑、事件再经队列送回：Web 层跑在 gevent 上，
    但没有做 monkey-patch（见 ``modules/web/app.py`` 顶部），``requests`` 走的是阻塞 socket。
    直接在当前执行流里调模型，只要上游不回话，整个 hub 就被钉死 —— 所有接口一起超时，
    表现就是「助手发一条消息，整个页面坏了」。放到线程里后，这里每取一条事件就让出一次
    hub，其它请求照常响应；再加两道等待上限：
    ``first_event_limit``（默认 90s）管「连上了但迟迟不吐第一个字」，
    ``no_event_limit``（默认 180s）管「吐到一半断流」，思考型模型持续有事件不会被误杀。
    超过上限就返回 ``[错误]`` 占位串，让上层走确定性降级路径 —— 界面给出一句能看懂的话，
    比一直转圈十分钟有用得多。
    """
    try:
        call_llm = _app()._call_llm
    except Exception as failure:
        return '[模型调用链不可用: %s]' % failure

    events = _Queue()
    kwargs = {}
    if on_content is not None:
        kwargs['stream_callback'] = lambda chunk: events.put(('c', chunk))
    if on_reasoning is not None:
        # 老版本 web 层没有 reasoning 透传参数时降级为只接正文，不能因此报错
        try:
            import inspect
            if 'reasoning_callback' in inspect.signature(call_llm).parameters:
                kwargs['reasoning_callback'] = lambda chunk: events.put(('r', chunk))
            else:
                on_reasoning = None
        except (TypeError, ValueError):
            on_reasoning = None

    def worker():
        try:
            events.put(('done', call_llm(prompt, system, **kwargs) or ''))
        except Exception as failure:
            events.put(('done', '[模型调用失败: %s]' % failure))

    thread = _Thread(target=worker, daemon=True)
    thread.start()

    if no_event_limit is None:
        no_event_limit = min(idle_timeout(), 180)
    limit = max(1, int(no_event_limit))
    if first_event_limit is None:
        first_event_limit = min(idle_timeout(), 90)
    # 非流式调用只在结束时给一个事件，没法区分「首字」与「后续」，沿用同一上限
    first_limit = limit if (on_content is None and on_reasoning is None) \
        else max(1, int(first_event_limit))

    collected = []
    saw_event = False
    while True:
        cap = limit if saw_event else first_limit
        item = _hub.next_event(events, cap)
        if item is None:
            # 用真实时钟算的上限（不是「轮询次数 × 步长」累加），
            # 否则每轮循环的固定开销会叠加，90s 会变成实际上的两分钟。
            return '[模型 %ds 内没有任何响应，已停止等待（检查上游模型服务或调小 AI 设置里的超时）]' % cap
        saw_event = True
        kind, payload = item
        if kind == 'done':
            text = str(payload or '')
            # 流式回调已经把内容递出去了；返回文本优先取模型给的完整结果，
            # 完整结果为空时退回累计的 chunk，避免上层拿到空串。
            return text or ''.join(collected)
        if kind == 'c':
            collected.append(payload)
            if on_content is not None:
                on_content(payload)
        elif kind == 'r':
            if on_reasoning is not None:
                on_reasoning(payload)
