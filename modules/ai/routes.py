# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · HTTP 接口层。

AI 巡检助手的 HTTP 接口（版权归属：MIT License, Copyright (c) 2025-2026 fiyo (Jack Ge)）。
正式挂载点是蓝图 ``/api/ai/assistant``，同一批 view 另经 ``modules/ai/chat_alias.py``
挂到助手页使用的 ``/api/chat/*`` 上。三组接口：

* ``/api/ai/assistant/*`` —— 对话流（SSE / 一次性）、SQL 交互、方言预检、AI 修复、
  追问推荐、版本一览、巡检任务进度；
* ``/api/ai/tasks*`` —— 对话任务历史（列表/详情/统计/重命名/删除）；
* ``/api/ai/sessions*`` —— 会话与消息。

三条硬性约束：

1. **鉴权**：全部接口都要求登录态，未登录直接 401；数据源一律再过
   ``assert_visible`` / ``filter_visible``，模型能看到的都是当前用户有权的；
2. **只读**：助手侧一切取数都走 SQL 编辑器的只读闸，写操作在意图层与执行层各拦一次；
3. **停止**：SSE 循环每帧检查会话级停止标志，前端「停止生成」既断流也置位，
   服务端不会把一次长分析跑完再丢掉。
"""
import json
import queue
import re
import threading
import time
import uuid

from flask import Blueprint, Response, jsonify, request, session

from modules.ai import conversation
from modules.ai import datasource_access as ds_access
from modules.ai import datasource_versions
from modules.ai import dialect as ai_dialect
from modules.ai import hub
from modules.ai import llm
from modules.ai import registry
from modules.ai import sql_safety
from modules.ai import sql_vars
from modules.ai import task_store as store

ai_task_bp = Blueprint('ai_task', __name__, url_prefix='/api/ai/tasks')
ai_session_bp = Blueprint('ai_session', __name__, url_prefix='/api/ai/sessions')
ai_assistant_bp = Blueprint('ai_assistant', __name__, url_prefix='/api/ai/assistant')

# 多语句一批的上限与整体超时：先全量预检、逐条执行、遇错即停。
MAX_MULTI_STATEMENTS = 20
MULTI_TOTAL_TIMEOUT_S = 120

# 追问推荐：最多等这么久就先用规则兜底，模型的版本在后台算完写进缓存（不占请求线程）
FOLLOWUP_WAIT_SECONDS = 12
FOLLOWUP_TOTAL_SECONDS = 45
_FOLLOWUP_CACHE = {}
_FOLLOWUP_LOCK = threading.Lock()

_STOP_FLAGS = {}
_STOP_LOCK = threading.Lock()

# SSE 收尾哨兵：用一个独一份的对象，别用 None —— 队列等待超时也返回「没有事件」，
# 两者混在同一个值上就没法区分「流跑完了」和「等太久了」。
_SSE_END = object()


# ══════════════════════════════════════════════════════════════
# 公共小工具
# ══════════════════════════════════════════════════════════════

def _require_login():
    """未登录一律 401。"""
    if not session.get('user_id'):
        return jsonify({'ok': False, 'error': '未登录', 'error_code': 'UNAUTHORIZED'}), 401
    return None


def _body():
    return request.get_json(silent=True) or {}


def _text(value, limit=4000):
    return str(value if value is not None else '').strip()[:limit]


def _json_error(message, status=500):
    return jsonify({'ok': False, 'error': str(message)}), status


def _chat_context_from(payload):
    """前端 ``getChatContext()`` 送来的页面上下文，字段与前端保持一致。"""
    return {
        'page': _text(payload.get('page'), 60),
        'page_title': _text(payload.get('page_title'), 120),
        'datasource_id': _text(payload.get('datasource_id'), 60),
        'datasource_name': _text(payload.get('datasource_name'), 200),
        'db_type': _text(payload.get('db_type'), 40),
        'sql_content': _text(payload.get('sql_content'), 4000),
        'template_id': payload.get('template_id'),
        'datasource_names': [name for name in
                             (_text(item, 200) for item in (payload.get('datasource_names') or []))
                             if name][:5],
    }


def _stop_event(session_key, create=False):
    with _STOP_LOCK:
        if create and session_key not in _STOP_FLAGS:
            _STOP_FLAGS[session_key] = threading.Event()
        return _STOP_FLAGS.get(session_key)


def _begin_run(session_key):
    """为新一轮对话换一把干净的停止标志并返回它。

    不能复用上一轮的 Event：那把可能已经被「停止生成」置位，
    复用会让新流在第一帧之前就退出（表现是 SSE 返回空 body）。
    """
    with _STOP_LOCK:
        event = threading.Event()
        _STOP_FLAGS[session_key] = event
        return event


def _persist_interrupted(session_id, user_message, partial, task_id=''):
    """停止生成时，把这一轮已产出的半截回答落库（正文 + 「已中断」标记）。"""
    if not session_id:
        return
    try:
        if not store.get_session(session_id):
            return
        text = ((partial or '').strip() + '\n\n*[已中断]*') if (partial or '').strip() else '*[已中断]*'
        store.append_message(session_id, 'user', user_message or '', task_id,
                             summary=(user_message or '')[:80])
        store.append_message(session_id, 'assistant', text, task_id, summary=text[:150])
        if task_id:
            store.finish_task(task_id, 'stopped', text, 0)
    except Exception:
        pass


def _request_stop(session_key):
    event = _stop_event(session_key, create=True)
    event.set()
    return event


# ══════════════════════════════════════════════════════════════
# 对话流
# ══════════════════════════════════════════════════════════════

@ai_assistant_bp.route('/stream', methods=['POST'])
def assistant_stream():
    """SSE 对话流：``start → thinking* → chunk* / tool_* → need_confirmation → done``。

    帧格式：不使用 SSE 的 ``event:`` 名，类型放在 JSON 的 ``type`` 字段里，
    前端沿用 ``getReader()`` 手动切帧，刷新/断网时不会漏半帧。
    """
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    message = _text(payload.get('message'), 8000)
    if not message:
        return jsonify({'ok': False, 'error': '消息不能为空'}), 400
    session_id = _text(payload.get('session_id'), 60)
    if session_id:
        # 会话 id 由调用方给定，服务端按这个 id 补记录；查不到就 404 会让
        # 「自己生成 id 的客户端」一问就失败，看起来像助手坏了。
        store.ensure_session(session_id)

    chat_context = _chat_context_from(payload)
    explicit_datasource = _text(payload.get('datasource_name'), 200)
    if explicit_datasource:
        chat_context['datasource_name'] = explicit_datasource
    ds_id = _text(payload.get('ds_id'), 60)
    if ds_id and not chat_context.get('datasource_name'):
        record, status = ds_access.find_datasource(ds_id)
        if status == 'exact' and record:
            chat_context['datasource_name'] = record['name']
    confirmed = payload.get('confirmed_tool_calls') or None
    selected_action = _text(payload.get('selected_action'), 40)
    understanding = _text(payload.get('understanding'), 2000)

    stop_key = session_id or 'default'
    stop_event = _begin_run(stop_key)
    events = queue.Queue()

    collected = []
    box = {'task_id': ''}

    def pump():
        try:
            for event in conversation.stream_conversation(
                    message, session_id=session_id, chat_context=chat_context,
                    confirmed_tool_calls=confirmed, selected_action=selected_action,
                    understanding=understanding):
                events.put(event)
                if event.get('type') == 'start':
                    box['task_id'] = event.get('task_id') or box['task_id']
                elif event.get('type') == 'chunk':
                    collected.append(event.get('content') or '')
                if stop_event.is_set():
                    # 中断也要把「已经说出口的那半截」落库：否则刷新后这条回答整段不见了，
                    # 用户只看到自己问了一句，AI 像什么都没说过。
                    _persist_interrupted(session_id, message, ''.join(collected), box['task_id'])
                    events.put({'type': 'done', 'stopped': True})
                    break
        except Exception as failure:
            events.put({'type': 'error', 'message': str(failure)})
        finally:
            events.put(_SSE_END)

    threading.Thread(target=pump, daemon=True).start()

    def generate():
        # 取事件必须让出 gevent hub：模型思考/取数期间两帧之间可以隔好几秒，
        # events.get() 是 OS 级阻塞等待，会把整个 hub 钉住 —— 表现就是
        # 「助手一回话，整站所有接口一起超时」，页面像坏了。
        idle_limit = llm.idle_timeout() + 30
        while True:
            item = hub.next_event(events, idle_limit)
            if item is None:
                yield 'data: ' + json.dumps(
                    {'type': 'error',
                     'message': 'AI 在 %ds 内没有任何输出，已断开本次流（可在 AI 设置里调小超时）'
                                % idle_limit},
                    ensure_ascii=False) + '\n\n'
                break
            if item is _SSE_END:
                break
            # 停止位一置就不再下发后续事件 —— 但 done(stopped) 这帧必须发出去：
            # 前端靠它收尾（关掉「生成中」状态、把「已中断」标在回答上），
            # 以前的写法是先到先丢，那条 stopped 分支是死代码，界面一直转圈。
            if stop_event.is_set() and item.get('type') != 'done':
                break
            yield 'data: ' + json.dumps(item, ensure_ascii=False, default=str) + '\n\n'
            if item.get('type') in ('done', 'error'):
                break

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@ai_assistant_bp.route('/chat', methods=['POST'])
def assistant_chat():
    """一次性对话（不走 SSE）：把整条流跑完再返回，方便脚本与接口测试。"""
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    message = _text(payload.get('message'), 8000)
    if not message:
        return jsonify({'ok': False, 'error': '消息不能为空'}), 400
    session_id = _text(payload.get('session_id'), 60)
    chat_context = _chat_context_from(payload)
    explicit_datasource = _text(payload.get('datasource_name'), 200)
    if explicit_datasource:
        chat_context['datasource_name'] = explicit_datasource
    ds_id = _text(payload.get('ds_id'), 60)
    if ds_id and not chat_context.get('datasource_name'):
        record, status = ds_access.find_datasource(ds_id)
        if status == 'exact' and record:
            chat_context['datasource_name'] = record['name']

    answer_parts = []
    steps = []
    task_id = ''
    confirmation = None
    try:
        for event in conversation.stream_conversation(
                message, session_id=session_id, chat_context=chat_context,
                confirmed_tool_calls=payload.get('confirmed_tool_calls'),
                selected_action=_text(payload.get('selected_action'), 40),
                understanding=_text(payload.get('understanding'), 2000)):
            kind = event.get('type')
            if kind == 'start':
                task_id = event.get('task_id') or ''
            elif kind == 'chunk':
                answer_parts.append(event.get('content') or '')
            elif kind == 'tool_result':
                steps.append({'tool': event.get('tool'), 'status': event.get('status'),
                              'elapsed_ms': event.get('duration_ms'),
                              'arguments': event.get('arguments'),
                              'round': event.get('round')})
            elif kind == 'need_confirmation':
                confirmation = event
            elif kind == 'error':
                return jsonify({'ok': False, 'error': event.get('message') or '对话流出错',
                                'task_id': task_id}), 500
    except Exception as failure:
        return _json_error(failure)
    answer = ''.join(answer_parts).strip()
    return jsonify({'ok': True, 'task_id': task_id, 'answer': answer,
                    'steps': steps, 'confirmation': confirmation})


@ai_assistant_bp.route('/stop', methods=['POST'])
def assistant_stop():
    """停止生成：置会话停止位，前端同时 AbortController 断流。"""
    denied = _require_login()
    if denied:
        return denied
    session_id = _text(_body().get('session_id'), 60) or 'default'
    _request_stop(session_id)
    return jsonify({'ok': True, 'stopped': True})


@ai_assistant_bp.route('/model', methods=['GET'])
def assistant_model_info():
    """顶栏/侧栏的「模型信息」：后端来源 + 模型名 + 是否启用。"""
    denied = _require_login()
    if denied:
        return denied
    config = llm.load_ai_config()
    info = llm.model_label(config)
    return jsonify({'ok': True, 'available': info['available'], 'backend': info['backend'],
                    'model': info['model'], 'label': info['label'],
                    'online_enabled': bool(config.get('online_enabled')),
                    'rag_enabled': (config.get('rag') or {}).get('enabled', True)
                    if isinstance(config.get('rag'), dict) else True})


# ══════════════════════════════════════════════════════════════
# 任务历史
# ══════════════════════════════════════════════════════════════

@ai_task_bp.route('', methods=['GET'])
def list_tasks():
    denied = _require_login()
    if denied:
        return denied
    try:
        limit = min(int(request.args.get('limit', 50) or 50), 200)
        offset = max(int(request.args.get('offset', 0) or 0), 0)
        data = store.list_tasks(
            limit=limit, offset=offset,
            datasource=_text(request.args.get('datasource'), 200),
            status=_text(request.args.get('status'), 20),
            keyword=_text(request.args.get('keyword'), 200))
        return jsonify({'ok': True, **data})
    except Exception as failure:
        return _json_error(failure)


@ai_task_bp.route('/stats', methods=['GET'])
def task_stats():
    denied = _require_login()
    if denied:
        return denied
    try:
        return jsonify({'ok': True, 'stats': store.get_stats()})
    except Exception as failure:
        return _json_error(failure)


@ai_task_bp.route('/<task_id>', methods=['GET'])
def get_task(task_id):
    denied = _require_login()
    if denied:
        return denied
    task = store.get_task(task_id)
    if not task:
        return jsonify({'ok': False, 'error': '任务不存在'}), 404
    return jsonify({'ok': True, 'task': task})


@ai_task_bp.route('/<task_id>/rename', methods=['POST'])
@ai_task_bp.route('/<task_id>', methods=['PATCH'])
def rename_task(task_id):
    denied = _require_login()
    if denied:
        return denied
    title = _text(_body().get('title'), 200)
    if not title:
        return jsonify({'ok': False, 'error': '标题不能为空'}), 400
    if not store.rename_task(task_id, title):
        return jsonify({'ok': False, 'error': '任务不存在'}), 404
    return jsonify({'ok': True})


@ai_task_bp.route('/<task_id>', methods=['DELETE'])
def delete_task(task_id):
    denied = _require_login()
    if denied:
        return denied
    if not store.delete_task(task_id):
        return jsonify({'ok': False, 'error': '任务不存在'}), 404
    return jsonify({'ok': True})


# ══════════════════════════════════════════════════════════════
# 会话
# ══════════════════════════════════════════════════════════════

@ai_session_bp.route('', methods=['GET'])
def list_sessions():
    """会话列表。``?full=1`` 顺带把每个会话的消息一起回来。

助手页启动时只有一次「读会话」的机会（拿到就要能直接渲染），
所以 ``?full=1`` 一次请求返回会话列表 **和每个会话的消息**，不用前端先列表再逐个拉。
    """
    denied = _require_login()
    if denied:
        return denied
    try:
        limit = min(int(request.args.get('limit', 50) or 50), 200)
        sessions = store.list_sessions(limit=limit)
        if (request.args.get('full') or '').lower() in ('1', 'true', 'yes'):
            for item in sessions:
                item['messages'] = store.list_messages(item.get('id'), limit=400)
        return jsonify({'ok': True, 'sessions': sessions})
    except Exception as failure:
        return _json_error(failure)


@ai_session_bp.route('/sync', methods=['POST'])
def sync_sessions():
    """整组会话快照落库（前端保存会话时调用，按会话整段替换）。

    为什么是「整组快照」而不是逐条 append：前端把 ``_aias.sessions`` 当唯一真相，
    编辑重发、清空、撤销、超过 20 条截断这些操作都会让消息变少或变样，
    append 语义会留下删不掉的旧行。这里按会话整段替换，幂等、可重放。

    鉴权与写范围：仍要求登录；只处理请求里出现的会话（不删服务端多出来的历史），
    避免「一个人清缓存把别人的会话删了」。
    """
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    sessions = payload.get('sessions')
    if not isinstance(sessions, list):
        return jsonify({'ok': False, 'error': 'sessions 必须是数组'}), 400
    saved = 0
    for item in sessions[:40]:
        if not isinstance(item, dict):
            continue
        session_id = _text(item.get('id'), 60)
        if not session_id:
            continue
        # 会话可以挂多个数据源（批量执行选中的那一组）：只落单个的话，
        # 重新登录后多源会话会退化成单源，批量执行的目标就丢了。
        listed = item.get('datasources')
        if not isinstance(listed, list):
            listed = []
        store.upsert_session(session_id, title=_text(item.get('title'), 100),
                             datasource=_text(item.get('datasource') or
                                              item.get('currentDatasource'), 200),
                             datasources=[_text(name, 200) for name in listed])
        messages = item.get('messages')
        if isinstance(messages, list):
            rows = []
            for message in messages[:400]:
                if not isinstance(message, dict):
                    continue
                # 'ai'（助手页写法）与 'assistant' 都归一成 'assistant'；
                # 认不出的取值原样保留，不再一律降级成 'user' 把 AI 回复变成用户发言
                rows.append(dict(message,
                                 role=store.canonical_role(message.get('role')),
                                 content=_text(message.get('content'), 60000),
                                 task_id=_text(message.get('task_id'), 40)))
            store.replace_messages(session_id, rows)
        saved += 1
    return jsonify({'ok': True, 'saved': saved,
                    'sessions': store.list_sessions(limit=60)})


@ai_session_bp.route('', methods=['POST'])
def create_session():
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    try:
        session_id = store.create_session(title=_text(payload.get('title'), 100),
                                          datasource=_text(payload.get('datasource'), 200))
        return jsonify({'ok': True, 'session': store.get_session(session_id)})
    except Exception as failure:
        return _json_error(failure)


@ai_session_bp.route('/<session_id>', methods=['DELETE'])
def delete_session(session_id):
    denied = _require_login()
    if denied:
        return denied
    if not store.delete_session(session_id):
        return jsonify({'ok': False, 'error': '会话不存在'}), 404
    sql_vars.clear(session_id)
    return jsonify({'ok': True})


@ai_session_bp.route('/<session_id>/rename', methods=['POST'])
def rename_session(session_id):
    denied = _require_login()
    if denied:
        return denied
    title = _text(_body().get('title'), 100)
    if not title:
        return jsonify({'ok': False, 'error': '标题不能为空'}), 400
    if not store.get_session(session_id):
        return jsonify({'ok': False, 'error': '会话不存在'}), 404
    store.touch_session(session_id, title=title)
    return jsonify({'ok': True, 'session': store.get_session(session_id)})


@ai_session_bp.route('/<session_id>/messages', methods=['GET'])
def list_messages(session_id):
    denied = _require_login()
    if denied:
        return denied
    if not store.get_session(session_id):
        return jsonify({'ok': False, 'error': '会话不存在'}), 404
    # 上限与 /sync 的写入条数一致（400）：这里默认 200 的话，长会话写进去读不回来，
    # 表现同样是「历史没了」。
    return jsonify({'ok': True, 'messages': store.list_messages(session_id, limit=400)})


@ai_session_bp.route('/<session_id>/messages', methods=['POST'])
def append_message(session_id):
    """前端把一轮问答补写进会话（AI 回复也走这里，带 task_id 便于回溯）。"""
    denied = _require_login()
    if denied:
        return denied
    if not store.get_session(session_id):
        return jsonify({'ok': False, 'error': '会话不存在'}), 404
    payload = _body()
    # 助手的回合允许 'ai' / 'assistant' 两种写法（助手页与任务流历史上各用一种），
    # 统一归一后落库；这里不再用白名单拒绝，否则前端补写 AI 回复会整条丢掉。
    role = store.canonical_role(payload.get('role'))
    if not role:
        return jsonify({'ok': False, 'error': '缺少 role'}), 400
    store.append_message(session_id, role, _text(payload.get('content'), 60000),
                         _text(payload.get('task_id'), 40))
    return jsonify({'ok': True, 'messages': store.list_messages(session_id)})


@ai_session_bp.route('/<session_id>/clear', methods=['POST'])
def clear_messages(session_id):
    """清空当前会话的全部消息。"""
    denied = _require_login()
    if denied:
        return denied
    if not store.get_session(session_id):
        return jsonify({'ok': False, 'error': '会话不存在'}), 404
    if not store.delete_session(session_id):
        return jsonify({'ok': False, 'error': '清空失败'}), 500
    sql_vars.clear(session_id)
    new_id = store.create_session(title='新对话')
    return jsonify({'ok': True, 'session': store.get_session(new_id)})


# ══════════════════════════════════════════════════════════════
# 工具配置
# ══════════════════════════════════════════════════════════════

@ai_assistant_bp.route('/tools', methods=['GET'])
@ai_task_bp.route('/tools', methods=['GET'])
def list_ai_tools():
    """工具清单（含分类、是否只读、有无后端实现）——工具配置页与 MCP 都用它。"""
    denied = _require_login()
    if denied:
        return denied
    registry.ensure_loaded()
    return jsonify({'ok': True, 'success': True, 'total': len(registry.list_tools()),
                    'categories': registry.categories(), 'tools': registry.list_tools()})


@ai_assistant_bp.route('/tools', methods=['POST'])
def create_or_toggle_ai_tool():
    """带 ``name`` + ``enabled`` → 启停；带 ``description`` 且工具不存在 → 新建自定义工具。"""
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    registry.ensure_loaded()
    name = _text(payload.get('name'), 70).lower()
    if not name:
        return jsonify({'ok': False, 'error': '缺少工具名'}), 400
    if 'enabled' in payload and name in registry.registered_names():
        return jsonify({'ok': True, 'name': name,
                        'enabled': registry.set_enabled(name, bool(payload.get('enabled')))})
    try:
        created = registry.add_custom_tool(
            name, _text(payload.get('description'), 500),
            payload.get('parameters') or {}, _text(payload.get('category'), 40) or '自定义',
            bool(payload.get('enabled', True)))
        return jsonify({'ok': True, 'name': created})
    except ValueError as failure:
        return jsonify({'ok': False, 'error': str(failure)}), 400


@ai_assistant_bp.route('/tools/<name>', methods=['PUT'])
def update_ai_tool(name):
    denied = _require_login()
    if denied:
        return denied
    registry.ensure_loaded()
    payload = _body()
    changes = {}
    if 'description' in payload:
        changes['description'] = _text(payload.get('description'), 500)
    if 'parameters' in payload:
        changes['parameters'] = payload.get('parameters') or {}
    if 'category' in payload:
        changes['category'] = _text(payload.get('category'), 40) or '自定义'
    if 'enabled' in payload:
        changes['enabled'] = bool(payload.get('enabled'))
    if not registry.update_tool(name, **changes):
        return jsonify({'ok': False, 'error': '工具不存在'}), 404
    return jsonify({'ok': True})


@ai_assistant_bp.route('/tools/<name>', methods=['DELETE'])
def delete_ai_tool(name):
    denied = _require_login()
    if denied:
        return denied
    registry.ensure_loaded()
    try:
        if not registry.delete_tool(name):
            return jsonify({'ok': False, 'error': '工具不存在'}), 404
    except ValueError as failure:
        return jsonify({'ok': False, 'error': str(failure)}), 400
    return jsonify({'ok': True})


# ══════════════════════════════════════════════════════════════
# SQL 交互（结果区里的执行 / 拆分 / 修复 / 追问）
# ══════════════════════════════════════════════════════════════

def _resolve_datasource(payload):
    """接口层的定位顺序：datasource_name > datasource_id/ds_id > instance_id。"""
    name = _text(payload.get('datasource_name'), 200)
    identifier = _text(payload.get('datasource_id') or payload.get('ds_id')
                       or payload.get('instance_id'), 60)
    if name:
        record, status = ds_access.find_datasource(name)
        if status == 'exact' and record:
            return record, None
        return None, jsonify({'ok': False, 'error': '未找到数据源「%s」%s' % (
            name, '（存在多个同名/相近数据源，请指定完整名称）' if status == 'ambiguous' else ''),
            'ambiguous': status == 'ambiguous'}, 404)
    if identifier:
        record, status = ds_access.find_datasource(identifier)
        if status == 'exact' and record:
            return record, None
    return None, jsonify({'ok': False, 'error': '缺少数据源'}), 400


@ai_assistant_bp.route('/execute-sql', methods=['POST'])
def assistant_execute_sql():
    """一键执行回答里的 SQL（单条 / 多条逐条独立结果，写操作一律拒绝）。

    成功结果登记成 ``@rN``，后续语句可以引用；每次执行都写回任务历史
    （``source='manual'``），历史回溯时能看出「这是用户手点的，不是模型跑的」。
    """
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    record, failure = _resolve_datasource(payload)
    if failure:
        return failure
    raw_sql = _text(payload.get('sql'), 20000)
    if not raw_sql.strip():
        return jsonify({'ok': False, 'error': 'SQL 不能为空'}), 400
    session_id = _text(payload.get('session_id'), 60)
    try:
        max_rows = max(1, min(int(payload.get('max_rows') or 20), sql_tools_max()))
    except (TypeError, ValueError):
        max_rows = 20
    try:
        instance = ds_access.load_decrypted(record)
    except Exception as failure:
        return _json_error(failure)

    statements = sql_safety.split_statements(sql_safety.sanitize_sql(raw_sql))
    if not statements:
        return jsonify({'ok': False, 'error': '未解析出可执行语句'}), 400
    database = _text(payload.get('database'), 200)

    if len(statements) == 1:
        entry = _execute_statement(instance, record, statements[0], session_id, max_rows, database)
        entry['index'] = 1
        if entry.get('ok'):
            return jsonify({'ok': True, 'result': entry['result'], 'var_name': entry.get('var_name'),
                            'datasource': record['name'], 'used_datasource': record['name'],
                            'duration_ms': entry.get('duration_ms')})
        return jsonify({'ok': False, 'error': entry.get('error'), 'db_error': entry.get('db_error', False),
                        'sql_type': entry.get('sql_type'), 'repair': entry.get('repair'),
                        'datasource': record['name'],
                        'duration_ms': entry.get('duration_ms')}), 400

    # ── 多语句：先全量预检，再逐条执行，遇错即停 ──
    # 边跑边判会出现「SELECT 已经跑了、下一条才被拒」的中间态，多语句场景下这是最危险的行为。
    rejected = None
    for index, statement in enumerate(statements, 1):
        kind = sql_safety.classify(statement, record['db_type'])
        if kind != 'read':
            rejected = {'index': index, 'sql': statement, 'ok': False, 'skipped': False,
                        'error': sql_safety.rejection_reason(kind), 'sql_type': kind}
            break
    if len(statements) > MAX_MULTI_STATEMENTS:
        return jsonify({'ok': False, 'error': '一次最多执行 %d 条语句（当前 %d 条），请拆分后分批执行'
                        % (MAX_MULTI_STATEMENTS, len(statements))}), 400
    if rejected:
        return jsonify({'ok': False, 'multi': True, 'count': len(statements), 'succeeded': 0,
                        'failed_index': rejected['index'], 'statements': [rejected],
                        'error': rejected['error'], 'db_error': False, 'preflight': True,
                        'datasource': record['name']}), 400

    started_batch = time.time()
    results = []
    succeeded = 0
    failed_index = None
    for index, statement in enumerate(statements, 1):
        if time.time() - started_batch > MULTI_TOTAL_TIMEOUT_S:
            results.append({'index': index, 'sql': statement, 'ok': False,
                            'error': '整批超时（> %ds），已停止后续语句' % MULTI_TOTAL_TIMEOUT_S,
                            'timeout': True})
            failed_index = index
            break
        entry = _execute_statement(instance, record, statement, session_id, max_rows, database)
        entry['index'] = index
        results.append(entry)
        if entry.get('ok'):
            succeeded += 1
        else:
            failed_index = index
            break
    for index in range(len(results) + 1, len(statements) + 1):
        results.append({'index': index, 'skipped': True, 'sql': statements[index - 1]})
    first_error = next((item for item in results
                        if not item.get('ok') and not item.get('skipped')), {})
    return jsonify({'ok': failed_index is None, 'multi': True, 'statements': results,
                    'count': len(statements), 'succeeded': succeeded,
                    'failed_index': failed_index,
                    'error': first_error.get('error') or '',
                    'db_error': bool(first_error.get('db_error')),
                    'repair': first_error.get('repair'),
                    'datasource': record['name'],
                    'vars': [item['name'] for item in sql_vars.list_variables(session_id)]})


def _execute_statement(instance, record, statement, session_id, max_rows, database):
    """执行一条只读语句，返回「多语句里的一条」的完整记录。

    单条与多条共用同一条链路：**都要先做 @rN 变量替换，再按目标库真实版本改写**。
    之前只有单条路径做这两步，于是同一份 SQL「不带分号能跑、加个分号就 ORA 报错」。
    """
    from modules.ai.tools import sql_tools
    kind = sql_safety.classify(statement, record['db_type'])
    if kind != 'read':
        return {'sql': statement, 'ok': False, 'error': sql_safety.rejection_reason(kind),
                'sql_type': kind, 'db_error': False, 'duration_ms': 0}
    try:
        substituted = sql_vars.substitute(session_id, statement)
    except ValueError as failure:
        return {'sql': statement, 'ok': False, 'error': str(failure),
                'db_error': False, 'duration_ms': 0}
    rewritten, changed, note = sql_tools.rewrite_for_dialect(instance, substituted)
    started_at = time.time()
    try:
        columns, rows, truncated = ds_access.query_rows(instance, rewritten, database,
                                                        max_rows=max_rows)
    except Exception as failure:
        error_text = str(failure)
        entry = {'sql': rewritten, 'ok': False, 'error': error_text, 'db_error': True,
                 'repair': sql_tools.build_column_repair(instance, rewritten, error_text),
                 'duration_ms': int((time.time() - started_at) * 1000)}
        _record_manual_execution(session_id, record, rewritten, entry)
        return entry
    variable = sql_vars.remember(session_id, columns, rows, rewritten, total=len(rows))
    result = {'columns': columns, 'rows': rows, 'total': len(rows), 'truncated': truncated,
              'var_name': variable, 'duration_ms': int((time.time() - started_at) * 1000)}
    if changed:
        result.update(rewritten=True, rewrite_note=note, original_sql=substituted)
    entry = {'sql': rewritten, 'ok': True, 'result': result, 'var_name': variable,
             'duration_ms': result['duration_ms']}
    _record_manual_execution(session_id, record, rewritten, entry)
    return entry


def sql_tools_max():
    from modules.ai.tools import sql_tools
    return sql_tools.MAX_MAX_ROWS


def _repair_for(instance, statement, error_text):
    try:
        from modules.ai.tools import sql_tools
        return sql_tools.build_column_repair(instance, statement, error_text)
    except Exception:
        return None


def _bounded_exec_result(result):
    """把执行结果压成有界摘要（含前 20 行预览）：回溯表不能被一次大结果撑爆。

    行数上限控件最大可以到 5000，整段 rows 原样进 JSON 列的话，
    任务库会在几轮问答后涨到几十 MB，历史页也拉不动。
    """
    if not isinstance(result, dict) or not result:
        return {}
    if result.get('error'):
        return {'ok': False, 'error': result.get('error')}
    columns = result.get('columns') or []
    rows = result.get('rows') or []
    return {'ok': True,
            'total': result.get('total', len(rows)),
            'columns_count': len(columns),
            'rows_count': len(rows),
            'columns': columns[:20],
            'preview_rows': rows[:20],
            'truncated': bool(result.get('truncated')),
            'rewrite_note': result.get('rewrite_note') or '',
            'var_name': result.get('var_name') or ''}


def _record_manual_execution(session_id, record, statement, entry):
    """把用户手点的执行写进当前会话最近一条任务，标记 ``source='manual'``。"""
    try:
        if not session_id:
            return
        task_id = store.find_task_id_by_session(session_id)
        if not task_id:
            return
        result = (_bounded_exec_result(entry.get('result'))
                  if entry.get('ok') else {'error': entry.get('error')})
        store.append_step(task_id, 'execute_sql', {'datasource_name': record['name'],
                                                   'sql': statement[:2000]}, result,
                          'done' if entry.get('ok') else 'error',
                          entry.get('duration_ms') or 0, round_count=1, source='manual')
    except Exception:
        pass


@ai_assistant_bp.route('/sql-vars', methods=['GET'])
def assistant_sql_vars():
    denied = _require_login()
    if denied:
        return denied
    session_id = _text(request.args.get('session_id'), 60)
    return jsonify({'ok': True, 'vars': sql_vars.list_variables(session_id)})


@ai_assistant_bp.route('/check-sql', methods=['POST'])
def assistant_check_sql():
    """判断代码块内容是不是 SQL（宽口径，只判「像不像一条查询」）。

    这里**只判「像不像一条查询」**，不判「允不允许执行」：前端拿 ``is_sql=false``
    会把整块执行区删掉，所以严格只读表（``DESC``/``CALL``/``SET`` 之外的那些写法）
    不能用来做这个判断，否则「有 SQL 但没有任何执行按钮」。
    真正的执行闸仍是 ``sql_safety.classify`` + ``_assert_readonly_sql``。
    """
    denied = _require_login()
    if denied:
        return denied
    sql = _text(_body().get('sql'), 20000)
    db_type = _text(_body().get('db_type'), 60)
    if not sql.strip():
        return jsonify({'ok': True, 'is_sql': False, 'type': 'UNKNOWN'})
    is_sql, statement_type = sql_safety.looks_like_read_sql(sql, db_type)
    return jsonify({'ok': True, 'is_sql': is_sql, 'type': statement_type})


@ai_assistant_bp.route('/split-sql', methods=['POST'])
def assistant_split_sql():
    """把一段 SQL 拆成逐条语句，并给出与 statements 一一对应的 executable 布尔数组。

    ``executable`` 必须是与 ``statements`` 等长的**布尔数组**：前端按 ``executable[i]``
    直接取布尔，写成下标数组会让第 0 条恒为假值，界面上就出现「有的语句有执行按钮、
    恒为假值，界面上就出现「有的语句有执行按钮、有的没有」。
    判定口径与 ``/check-sql`` 同一个函数，保证「界面看到的条数 == 后端会跑的条数」。
    """
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    blocks = payload.get('sqls') or ([payload.get('sql')] if payload.get('sql') else [])
    results = []
    for block in (blocks or [])[:60]:
        statements, flags = sql_safety.split_read_flags(_text(block, 20000))
        results.append({'count': len(statements), 'statements': statements,
                        'executable': flags})
    return jsonify({'ok': True, 'results': results})


@ai_assistant_bp.route('/dialect-check', methods=['POST'])
def assistant_dialect_check():
    """按数据源真实版本预检 SQL（不靠猜：违规给替代写法，能确定性改写的给按钮）。"""
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    record, failure = _resolve_datasource(payload)
    if failure:
        return failure
    sqls = payload.get('sqls') or ([payload.get('sql')] if payload.get('sql') else [])
    info = datasource_versions.get_version(record)
    family, major, minor = ai_dialect.parse_version(info.get('version') or '',
                                                   record.get('db_type') or '')
    results = []
    for item in (sqls or [])[:60]:
        violations = ai_dialect.check_sql(_text(item, 20000), family, major, minor) if family else []
        results.append({'violations': violations})
    return jsonify({'ok': True, 'datasource': record['name'], 'family': family or '',
                    'version': info.get('version') or '', 'label':
                    ai_dialect.format_version_label(family, major, minor),
                    'ambiguous': not bool(info.get('version')), 'results': results})


@ai_assistant_bp.route('/dialect-rewrite', methods=['POST'])
def assistant_dialect_rewrite():
    """确定性改写（目前只做语义保证等价的 ``FETCH FIRST`` → ``ROWNUM``），改不了就原样返回。"""
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    sql = _text(payload.get('sql'), 20000)
    kind = _text(payload.get('kind'), 40) or 'rownum_wrap'
    if kind == 'rownum_wrap':
        allowed, _rows = ai_dialect.can_rewrite_rownum_wrap(sql)
        if not allowed:
            return jsonify({'ok': True, 'sql': sql, 'changed': False,
                            'reason': '该语句不满足安全改写条件（多语句 / 非末尾 FETCH / 含 OFFSET / PL/SQL 块），'
                                      '请手工按替代写法调整'})
        rewritten = ai_dialect.rewrite_rownum_wrap(sql)
        return jsonify({'ok': True, 'sql': rewritten, 'changed': rewritten != sql,
                        'reason': '已按 ROWNUM 子查询改写（各 Oracle 版本都支持）'})
    return jsonify({'ok': True, 'sql': sql, 'changed': False, 'reason': '未知改写类型'})


@ai_assistant_bp.route('/dialect-status', methods=['POST'])
def assistant_dialect_status():
    """给前端 SQL 块挂版本徽标：确认/未知/陈旧。"""
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    names = payload.get('datasource_names') or payload.get('names') or []
    records = []
    for name in names[:20]:
        record, status = ds_access.find_datasource(_text(name, 200))
        if status == 'exact' and record:
            records.append(record)
    if not records:
        records = ds_access.visible_datasources()[:20]
    rows = datasource_versions.dialect_status(records)
    return jsonify({'ok': True, 'datasources': rows})


@ai_assistant_bp.route('/datasource-versions', methods=['GET'])
def assistant_datasource_versions():
    """版本一览（实探，无需手工配置）。``?refresh=1&name=xxx`` 同步重探单个数据源。"""
    denied = _require_login()
    if denied:
        return denied
    try:
        records = ds_access.visible_datasources()
        name = _text(request.args.get('name'), 200)
        if request.args.get('refresh') and name:
            record, status = ds_access.find_datasource(name)
            if status != 'exact' or not record:
                return jsonify({'ok': False, 'error': '未找到数据源'}), 404
            datasource_versions.refresh(record)
            records = [record]
        rows = datasource_versions.dialect_status(records)
        return jsonify({'ok': True, 'count': len(rows),
                        'summary': datasource_versions.summarize_status(rows),
                        'datasources': rows, 'refreshed': bool(request.args.get('refresh'))})
    except Exception as failure:
        return _json_error(failure)


@ai_assistant_bp.route('/fix-sql', methods=['POST'])
def assistant_fix_sql():
    """「AI 修复」：把报错 + 真实列 + 真实版本 + 方言禁区一起给模型，只改语法不改语义。"""
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    sql = _text(payload.get('sql'), 20000)
    error_text = _text(payload.get('error'), 4000)
    if not sql:
        return jsonify({'ok': False, 'error': '缺少 sql'}), 400
    record, failure = _resolve_datasource(payload) if (payload.get('datasource_name')
                                                       or payload.get('datasource_id')) \
        else (None, None)
    if failure:
        return failure
    db_type = (record or {}).get('db_type') or _text(payload.get('db_type'), 40)
    version_text = ''
    repair = payload.get('repair') or None
    if record:
        version_text = datasource_versions.get_version(record).get('version') or ''
        if not repair and error_text:
            try:
                repair = _repair_for(ds_access.load_decrypted(record), sql, error_text)
            except Exception:
                repair = None
    facts = [{'name': (record or {}).get('name') or '目标库', 'db_type': db_type,
              'version': version_text}]
    repair_lines = []
    if isinstance(repair, dict):
        for table in repair.get('tables') or []:
            if table.get('columns'):
                repair_lines.append('- %s 的实际列：%s' % (
                    table.get('table'), ', '.join(table['columns'][:120])))
        suggestion = repair.get('suggestion')
        if suggestion:
            repair_lines.append('- 报错列「%s」可改用：%s（表 %s）' % (
                repair.get('bad_column', ''), suggestion.get('suggested'), suggestion.get('table')))
    try:
        dialect_rules = ai_dialect.build_dialect_prompt(facts)
    except Exception:
        dialect_rules = ''
    prompt = ('下面这条 SQL 在数据库上执行报错，请修复它（只改语法/对象名，不改查询意图，'
              '保持只读 SELECT）。\n\n数据库类型：%s\n实际版本：%s\n\n%s'
              '%s\n原始 SQL：\n```sql\n%s\n```\n\n报错信息：\n%s\n\n'
              '只输出修复后的 SQL（纯文本，不要解释、不要 markdown 代码块）。'
              % (db_type or '未知', version_text or '未知（按最保守写法处理）',
                 dialect_rules or '',
                 ('### 真实列参考（只准使用下列真实存在的列）\n' + '\n'.join(repair_lines) + '\n\n')
                 if repair_lines else '',
                 sql, error_text or '（未提供报错信息）'))
    answer = llm.call(prompt, '你是资深 DBA，负责把报错的查询改成目标库版本支持的只读写法。')
    if llm.looks_like_error(answer):
        return jsonify({'ok': False, 'error': answer or '模型不可用，请在「AI 设置」中检查模型'}), 503
    fixed = sql_safety.sanitize_sql(_extract_sql_from_answer(answer))
    if not fixed:
        return jsonify({'ok': False, 'error': '模型没有给出可用的 SQL，请手工调整'}), 503
    changed = sql_safety.sanitize_sql(sql) != fixed
    return jsonify({'ok': True, 'fixed_sql': fixed, 'changed': changed,
                    'note': '已按目标库版本重写，执行前请确认查询意图未变' if changed
                            else '模型认为原语句无需修改'})


_SQL_BLOCK_PATTERN = re.compile(r'```(?:sql)?\s*(.+?)```', re.IGNORECASE | re.DOTALL)


def _extract_sql_from_answer(text):
    """从模型回复里抠出 SQL：优先代码块，其次剥掉说明性文字。"""
    raw = str(text or '').strip()
    if not raw:
        return ''
    matched = _SQL_BLOCK_PATTERN.search(raw)
    if matched:
        return matched.group(1).strip()
    lines = [line for line in raw.split('\n')
             if not re.match(r'^\s*(这是|以下|如下|说明|注意|建议|修复后)[：:]*\s*', line)]
    return '\n'.join(lines).strip()


@ai_assistant_bp.route('/followup_suggest', methods=['POST'])
def assistant_followup_suggest():
    """追问推荐：结合本轮结论给 3 个可继续问的问题（45 秒硬超时，失败给规则兜底）。"""
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    text = _text(payload.get('text'), 4000)
    datasource_name = _text(payload.get('datasource_name'), 200)
    prompt = ('用户在数据库巡检助手里有如下一轮问答/结论，请给出 3 个他接下来最可能想问的'
              '问题（数据库运维方向、可执行、简短）。\n只输出 JSON 数组，例如 '
              '["问题1","问题2","问题3"]。\n\n数据源：%s\n内容：\n%s'
              % (datasource_name or '未指定', text))
    holder = {'value': ''}

    def ask():
        holder['value'] = llm.call(prompt, '你是 DBA 助手，负责把结论转成下一步可查的问题。')

    thread = threading.Thread(target=ask, daemon=True)
    thread.start()
    thread.join(timeout=FOLLOWUP_WAIT_SECONDS)
    questions = []
    if not thread.is_alive() and not llm.looks_like_error(holder['value']):
        matched = re.search(r'\[.*\]', holder['value'], re.S)
        if matched:
            try:
                parsed = json.loads(matched.group(0))
                questions = [str(item)[:120] for item in parsed if item][:3]
            except Exception:
                questions = []
    if not questions:
        questions = _fallback_followup_questions(datasource_name)
    response = {'ok': True, 'questions': questions}
    if thread.is_alive():
        # 等不到模型就先给规则兜底，并告诉前端「模型版还在算」：前端可以稍后取一次。
        # 追问是每条回答后自动出候选，不能把请求线程按住等模型：等不到就先给规则兜底
        # 出 chips —— 那就更不能把请求线程按住 45 秒。
        token = _spawn_deferred_followup(thread, holder)
        response['pending'] = token
    return jsonify(response)


def _spawn_deferred_followup(thread, holder):
    """后台继续等模型，结果写进 _FOLLOWUP_CACHE，前端用 ?token= 取。"""
    token = uuid.uuid4().hex[:12]
    with _FOLLOWUP_LOCK:
        _FOLLOWUP_CACHE[token] = {'questions': [], 'ts': time.time()}

    def waiter():
        thread.join(timeout=FOLLOWUP_TOTAL_SECONDS)
        questions = []
        value = holder.get('value') or ''
        if not thread.is_alive() and not llm.looks_like_error(value):
            matched = re.search(r'\[.*\]', value, re.S)
            if matched:
                try:
                    questions = [str(item)[:120] for item in json.loads(matched.group(0)) if item][:3]
                except Exception:
                    questions = []
        with _FOLLOWUP_LOCK:
            _FOLLOWUP_CACHE[token] = {'questions': questions, 'ts': time.time()}

    threading.Thread(target=waiter, daemon=True).start()
    return token


@ai_assistant_bp.route('/followup_suggest', methods=['GET'])
def assistant_followup_poll():
    """取「稍后才算好」的追问推荐：拿不到就返回空，前端自己决定是否再试。"""
    denied = _require_login()
    if denied:
        return denied
    token = _text(request.args.get('token'), 40)
    with _FOLLOWUP_LOCK:
        entry = _FOLLOWUP_CACHE.get(token)
    return jsonify({'ok': True, 'questions': (entry or {}).get('questions') or [],
                    'ready': bool(entry and entry.get('questions'))})


def _fallback_followup_questions(datasource_name=''):
    target = datasource_name or '当前数据源'
    return ['看看 %s 当前有多少连接/会话' % target,
            '%s 最近有哪些慢 SQL' % target,
            '对 %s 做一次巡检' % target]


# ══════════════════════════════════════════════════════════════
# 巡检任务进度（助手「查看巡检进度」弹窗与历史）
# ══════════════════════════════════════════════════════════════

@ai_assistant_bp.route('/task/<task_id>', methods=['GET'])
def assistant_inspection_task(task_id):
    """巡检任务状态 + 增量日志：内存优先，重启后从巡检历史库回读。"""
    denied = _require_login()
    if denied:
        return denied
    from modules.web.app import tasks
    task = tasks.get(task_id)
    offset = int(request.args.get('offset') or 0)
    if task:
        log = list(task.get('log') or [])
        result = {'ok': True, 'task_id': task_id, 'status': task.get('status') or 'running',
                  'log': log[offset:], 'offset': len(log), 'source': 'memory',
                  'datasource': task.get('datasource_name')
                  or (task.get('db_info') or {}).get('name') or '',
                  'db_type': task.get('db_type') or '',
                  'started_at': task.get('started_at') or ''}
        if task.get('status') == 'done' and task.get('report_file'):
            result.update(report_file=task.get('report_file'),
                          report_name=task.get('report_name') or 'report.docx')
        if task.get('status') == 'error':
            result['error_msg'] = task.get('error_msg') or task.get('error') or ''
        return jsonify(result)
    restored = _restore_inspection_from_history(task_id)
    if restored:
        return jsonify(restored)
    return jsonify({'ok': False, 'error': '任务不存在或已过期'}), 404


def _restore_inspection_from_history(task_id):
    try:
        from modules.inspection import dal
    except Exception:
        return None
    getter = getattr(dal, 'get_inspection_by_task_id', None)
    if not callable(getter):
        return None
    try:
        row = getter(task_id)
    except Exception:
        return None
    if not row:
        return None
    return {'ok': True, 'task_id': task_id, 'status': row.get('status') or 'done',
            'log': [], 'offset': 0, 'source': 'database', 'restored_from_db': True,
            'datasource': row.get('instance_name') or row.get('db_name') or '',
            'db_type': row.get('db_type') or '',
            'started_at': row.get('created_at') or row.get('inspection_time') or '',
            'report_file': row.get('report_path') or '',
            'health_score': row.get('health_score'),
            'risk_count': row.get('risk_count'),
            'risk_level': row.get('risk_level') or '',
            'error_msg': row.get('error_msg') or ''}


@ai_assistant_bp.route('/tasks', methods=['GET'])
def assistant_inspection_tasks():
    """助手发起过的巡检任务：内存中的 + 历史库里 trigger_type=ai_assistant 的。"""
    denied = _require_login()
    if denied:
        return denied
    from modules.web.app import tasks
    rows = []
    for task_id, task in list(tasks.items()):
        if (task.get('trigger_type') or '') != 'ai_assistant':
            continue
        log = list(task.get('log') or [])
        rows.append({'task_id': task_id, 'status': task.get('status') or 'running',
                     'source': 'memory',
                     'datasource': task.get('datasource_name')
                     or (task.get('db_info') or {}).get('name') or '',
                     'db_type': task.get('db_type') or '',
                     'started_at': task.get('started_at') or '',
                     'report_file': task.get('report_file') or '',
                     'report_name': task.get('report_name') or '',
                     'error_msg': task.get('error_msg') or '',
                     'recent_logs': log[-3:]})
    rows.sort(key=lambda item: item.get('started_at') or '', reverse=True)
    return jsonify({'ok': True, 'tasks': rows[:100], 'total': len(rows)})


# ══════════════════════════════════════════════════════════════
# SQL 槽位（占位符替换）接口
# ══════════════════════════════════════════════════════════════

def _slot_datasource(payload):
    """槽位接口只关心「数据源叫什么」，取不到就返回 None（不报错）。

    「不选数据源」也能用上下文里的推荐值；只有检索真实候选才必须要数据源。
    """
    record, _failure = _resolve_datasource(payload)
    return record


def _slot_brief(slot, ds_name, db_info, sql, suggestions=None, src_cache=None):
    """Slot → 前端结构（角色中文名 / 是否纯名 / 推荐值 / 字段值元信息）。

    占位符识别与「手工选中」共用同一份装配逻辑：不共用的话，手工选中的槽位会缺
    ``role_cn`` / ``need_quote``，前端表现就会和占位符语义不一致。
    """
    from modules.ai import sql_slots as sl
    data = slot.to_dict()
    data['role_cn'] = sl._ROLE_CN.get(slot.role, '')
    data['bare'] = slot.col_ref in sl._BARE_NAME_COLS
    data['suggest'] = (suggestions or {}).get(slot.name) or ''
    data['suggest_from'] = 'context' if data['suggest'] else ''
    data['value_like'] = slot.role in ('value', 'time')
    data['need_quote'] = False
    data['value_kind'] = ''
    data['manual'] = (getattr(slot, 'style', '') == 'manual')
    if slot.role in ('value', 'time') and ds_name and slot.col_ref:
        cache = src_cache if src_cache is not None else {}
        if slot.col_ref not in cache:
            try:
                cache[slot.col_ref] = sl.resolve_value_source(ds_name, db_info, sql, slot.col_ref) or {}
            except Exception:
                cache[slot.col_ref] = {}
        source = cache.get(slot.col_ref) or {}
        if source:
            data['role_cn'] = '%s · 列 %s' % (sl._ROLE_CN.get(slot.role, '字段值'),
                                            source.get('column') or slot.col_ref)
            data['value_kind'] = source.get('kind') or ''
            data['value_table'] = source.get('qualified') or source.get('table') or ''
            # 日期型给的是裸时间文本；原 SQL 无引号时必须补引号
            data['need_quote'] = (source.get('kind') == 'date' and not slot.quote)
    return data


@ai_assistant_bp.route('/sql-slots', methods=['POST'])
def assistant_sql_slots():
    """识别 AI 建议 SQL 里的占位符（``<表名>`` / ``${x}`` / ``{{x}}`` / ``#表名#`` /
    ``[表名]`` / ``:name``），并结合上面的分析文本给出推荐值。

    上下文推荐**不依赖数据源**（AI 结论里通常已写明真实对象名），只有「当前 schema」
    需要连库；所以两者分开处理——没选数据源也要能给出推荐值，否则用户得先选源才能替换。
    """
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    sql = _text(payload.get('sql'), 20000)
    if not sql.strip():
        return jsonify({'ok': True, 'slots': [], 'count': 0})
    ds_name = _text(payload.get('datasource_name'), 200).strip()
    context_text = _text(payload.get('context_text'), 20000)
    from modules.ai import sql_slots as sl
    slots = sl.extract_slots(sql)
    if not slots:
        return jsonify({'ok': True, 'slots': [], 'count': 0,
                        'note': '未发现占位符（支持 <表名> / ${x} / {{x}} / #表名# / [表名] / :name）'})
    record = _slot_datasource(payload) if ds_name else None
    db_info = record or {}
    cur_schema = ''
    if ds_name:
        try:
            from modules.ai import sql_autoverify as av
            cur_schema = (av.probe_environment(ds_name, db_info=db_info) or {}).get('cur_schema', '') or ''
        except Exception:
            cur_schema = ''
    suggestions = {}
    if context_text:
        try:
            known = sl.harvest_context([context_text], current_schema=cur_schema) or {}
            suggestions = sl.autofill(slots, known, current_schema=cur_schema) or {}
        except Exception:
            suggestions = {}
    cache = {}
    rows = [_slot_brief(slot, ds_name, db_info, sql, suggestions, cache) for slot in slots]
    return jsonify({'ok': True, 'slots': rows, 'count': len(rows),
                    'auto_filled': sum(1 for item in rows if item['suggest']),
                    'cur_schema': cur_schema})


@ai_assistant_bp.route('/sql-token-slot', methods=['POST'])
def assistant_sql_token_slot():
    """把用户**真正选中的那段 SQL** 变成一个可替换槽位：SQL 里没占位符也能改。

    角色只按上下文推断（FROM/JOIN 之后 → 表名；``列 = xxx`` → 该列的字段值），
    绝不拿选中文本本身去匹配角色关键词——否则选中 ``'TABLE'`` 会因为是 table
    被当成表名，候选全错。
    """
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    sql = _text(payload.get('sql'), 20000)
    ds_name = _text(payload.get('datasource_name'), 200).strip()
    context_text = _text(payload.get('context_text'), 20000)
    from modules.ai import sql_slots as sl
    try:
        slot = sl.extract_manual_slot(sql, payload.get('start'), payload.get('end'))
    except Exception:
        slot = None
    if not slot:
        return jsonify({'ok': False, 'error': '没有选中可替换的内容'})
    db_info = (_slot_datasource(payload) or {}) if ds_name else {}
    suggestions = {}
    if context_text:
        try:
            known = sl.harvest_context([context_text]) or {}
            suggestions = sl.autofill([slot], known) or {}
        except Exception:
            suggestions = {}
    return jsonify({'ok': True, 'current': slot.raw,
                    'slot': _slot_brief(slot, ds_name, db_info, sql, suggestions, {})})


@ai_assistant_bp.route('/sql-slot-candidates', methods=['POST'])
def assistant_sql_slot_candidates():
    """按槽位的语义角色从数据字典 / 真实数据里检索候选值（右键菜单的搜索框）。

    字段值与时间是另一条路径：候选来自「该列在真实数据里的取值」而不是数据字典；
    对象类（表名/索引/schema/表空间）才查字典。语义不明时不猜，直接提示手填。
    """
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    ds_name = _text(payload.get('datasource_name'), 200).strip()
    role = _text(payload.get('role'), 40).strip()
    keyword = _text(payload.get('keyword'), 200).strip()
    scope = _text(payload.get('scope'), 200).strip()
    col_ref = _text(payload.get('col_ref'), 200).strip()
    sql_text = _text(payload.get('sql'), 20000)
    quote = _text(payload.get('quote'), 8)
    bare = bool(payload.get('bare'))
    from modules.ai import sql_slots as sl

    if role in ('value', 'time'):
        if not ds_name:
            return jsonify({'ok': False, 'error': '未选择数据源，无法读取该列的真实取值'})
        db_info = _slot_datasource(payload) or {}
        cands, note, value_source = sl.suggest_value_candidates(
            ds_name, db_info, sql_text, col_ref, keyword=keyword, limit=60)
        kind = (value_source or {}).get('kind') or ''
        return jsonify({'ok': True, 'candidates': cands, 'total': len(cands), 'note': note,
                        'kind': kind, 'value_source': True,
                        'table': (value_source or {}).get('qualified')
                        or (value_source or {}).get('table') or '',
                        'column': (value_source or {}).get('column') or col_ref,
                        'need_quote': bool(kind == 'date' and not quote and cands)})

    if not ds_name:
        return jsonify({'ok': False, 'error': '未选择数据源，无法从数据字典检索候选'})
    if not role or role in ('unknown', 'number'):
        return jsonify({'ok': True, 'candidates': [], 'scoped': False,
                        'note': '未识别出该占位符的语义，请直接手动输入值'})
    db_info = _slot_datasource(payload) or {}
    cands = sl.suggest_candidates(ds_name, db_info, role, keyword=keyword,
                                 scope=scope, mode='contains') or []
    if bare:
        # 该列存纯对象名（如 table_name='EMP'），带 owner 前缀会查不到 → 归一为纯名并去重
        seen, uniq = set(), []
        for item in cands:
            plain = item.rsplit('.', 1)[-1]
            if plain not in seen:
                seen.add(plain)
                uniq.append(plain)
        cands = uniq
    return jsonify({'ok': True, 'candidates': cands[:80], 'scoped': bool(scope),
                    'total': len(cands)})


@ai_assistant_bp.route('/sql-slot-verify', methods=['POST'])
def assistant_sql_slot_verify():
    """校验槽位取值是否真实存在（右键菜单「填完立即校验」）。

    与候选检索方向相反：候选 = 帮用户挑一个值（正向），校验 = 告诉用户填的这个值
    到底存不存在（反向）。两类角色都要校验：对象类查数据字典，字段值类查真实数据 ——
    只做其一就会漏，而漏掉的后果是 SQL 静默返回 0 行。
    """
    denied = _require_login()
    if denied:
        return denied
    payload = _body()
    ds_name = _text(payload.get('datasource_name'), 200).strip()
    sql_text = _text(payload.get('sql'), 20000)
    slot = payload.get('slot') or {}
    value = payload.get('value')
    if not ds_name:
        return jsonify({'ok': False, 'error': '未选择数据源'})
    if value is None or str(value).strip() == '':
        return jsonify({'ok': True, 'checks': []})
    from modules.ai import sql_slots as sl
    db_info = _slot_datasource(payload) or {}
    temp = sl.Slot('', _text(slot.get('name'), 200), _text(slot.get('role'), 40),
                   (0, 0), '', 'angle', '', _text(slot.get('col_ref'), 200))
    try:
        checks = sl.verify_slot_values(ds_name, db_info, [temp], {temp.name: value},
                                       sql=sql_text) or []
    except Exception as failure:
        return _json_error(failure)
    return jsonify({'ok': True, 'checks': checks})
