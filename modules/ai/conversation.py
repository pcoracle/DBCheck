# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · 统一对话流（理解 → 取数 → 分析）。

归属说明：统一对话流的编排语义与 SSE 事件契约归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) 所有，本模块是 AI 巡检助手的编排核心。
事件契约同时是前后端的渲染约定（前端 ``fusion/ai_assistant.js`` 按同一套事件渲染），
增删事件名要两端同步：

    start / thinking_start / thinking / thinking_end / chunk /
    need_confirmation / tool_start / tool_executing / tool_progress /
    tool_result / tool_analyzing / error / done

四条主路径：

1. **纯问答**：注入页面上下文 + 数据源真实版本 + 方言禁区 + 对话历史 + RAG，流式 ``chunk``；
2. **工具路径**：模型给出 tool_calls → 逐个执行（进度实时下发）→ 分析阶段可再发
   ``<query datasource="…">SELECT …</query>`` 追加取数（最多 3 轮），把结论讲清楚；
3. **确认路径**：数据源缺失/歧义、以及「AI 自主巡检 / 按模板巡检」两选一，
   用户点选后带 ``confirmed_tool_calls`` 重发，走同一条流继续执行；
4. **降级路径**：模型不可用时用确定性关键词兜底，保证「问得出、有回应」，
   巡检类意图仍然真起任务。

三条硬约束（实现时必须守住，否则会出现假结论或假超时）：

* ``[OK] 执行成功`` / ``[FAIL] 执行失败`` 显式标注：模型只准拿成功数据做分析，
  避免拿一条报错文本编出结论；
* 工具执行与分析都在**子线程**里，队列空闲窗口 = max(300, 模型超时 + 30)，
  长思考期事件会不断重置窗口，不会被误判成「AI 分析超时」；等待这些队列一律用
  让出 hub 的短轮询（``modules/ai/hub.py``），不能用 ``Queue.get(timeout=…)``；
* 模型「迟迟不吐第一个字」另有 90s 上限（``llm.call`` 的 ``first_event_limit``），
  一旦判为无响应，本轮后续阶段直接收手，不让用户逐段各等一次超时；
* 每一次工具调用与最终结论都落 ``ai_task_history``，刷新页面/事后回溯都能查到。
"""
import json
import queue
import re
import threading
import time

from modules.ai import datasource_access as ds_access
from modules.ai import datasource_versions
from modules.ai import intent as ai_intent
from modules.ai import llm
from modules.ai import registry
from modules.ai import task_store as store
from modules.ai.hub import next_event as _next_event, pause as _pause, wait_thread as _wait_thread

MAX_ANALYSIS_ROUNDS = 3
_TOOL_TIMEOUT_SECONDS = 300
_INSPECTION_POLL_ROUNDS = 30
_INSPECTION_POLL_INTERVAL = 3

_QUERY_TAG_PATTERN = re.compile(r'<query\s+datasource=["\']([^"\']+)["\']\s*>(.*?)</query>',
                                re.IGNORECASE | re.DOTALL)

_ANALYSIS_SYSTEM = (
    '你是 DBCheck 数据库巡检助手，拥有 20 年 DBA 经验。\n'
    '你正在分析工具执行结果并给用户提供建议。请基于真实数据给出专业、可落地的建议。\n\n'
    '## 只读定位（必须遵守）\n'
    '本助手是只读巡检助手：只能执行查询语句（SELECT 等只读操作），不能执行任何写操作或'
    '管理操作（如 DDL/DML/启动巡检任务/触发定时任务等）。\n'
    '发现问题时，只提供分析结论和建议 SQL，明确标注需 DBA 确认后手动执行。\n\n'
    '## 数据有效性识别（必须遵守）\n'
    '上下文中的执行记录均显式标注了 [OK] 执行成功（有效数据）或 [FAIL] 执行失败（无效数据）：\n'
    '1. 只能以 [OK] 成功记录中的数据作为分析依据，严禁引用或使用 [FAIL] 失败记录的数据；\n'
    '2. 若同一条 SQL 先执行失败、后来修复重新执行成功，一律以成功记录的数据为准；\n'
    '3. 若所有执行记录均为 [FAIL] 失败，直接说明失败原因，不要强行给出数据性分析结论，'
    '更不要编造或引用上下文之外的数据；\n'
    '4. 引用数据时必须与标注的来源记录一一对应，不要混用不同数据源/不同轮次的数据；\n'
    '5. 生成任何 SQL（包括 <query> 追加取数与建议 SQL）时，必须以「数据源实际版本」一节'
    '给出的真实版本为准，内置视图/函数/语法差异按对应版本编写，不要假设版本。\n\n'
    '## 多轮取数能力\n'
    '如果当前数据不足以得出结论，你可以发起追加查询。在回答中插入如下标签即可：\n'
    '<query datasource="数据源名称">SELECT ...</query>\n'
    '系统会自动执行该 SQL 并把结果回传给你继续分析。标签可写多个。\n'
    '规则：\n'
    '1. 只在确实需要更多数据时才发追加查询，最多 2 轮\n'
    '2. 追加查询仅限 SELECT（其它语句会被拒绝）\n'
    '3. 最终回答必须是完整的 Markdown 分析，不要包含 <query> 标签\n'
    '4. 用中文回答，引用具体数据，按「问题分析 → 建议方案（含 SQL）→ 风险说明」结构输出\n'
    '5. 建议 SQL 仅供参考，需由 DBA 审阅确认后手动执行\n'
    '6. 如果进行了多轮查询，对比各轮结果，在回答末尾输出「## 关键问题点」小结，'
    '用列表列出最关键的 1-3 个问题（含具体数据和对比）\n'
    '7. 如有系统基线/阈值参考，对比当前值与基线，标注是否超限\n'
    '8. 给出多条 SQL 时，每条语句必须以分号 ; 结尾（前端按分号拆成逐条独立执行）'
)

_AUTONOMOUS_INSPECTION_STEPS = [
    '连接与会话检查（当前连接数、会话状态）',
    '慢查询检查（慢 SQL 统计）',
    '锁等待检查（锁冲突、阻塞会话）',
    '表空间与容量检查（表空间使用率）',
    '性能指标检查（CPU/内存/IO）',
    '错误日志检查（近期错误日志）',
    '配置参数检查（关键参数对比基线）',
]


# ══════════════════════════════════════════════════════════════
# 事件与流式辅助
# ══════════════════════════════════════════════════════════════

def _event(kind, **payload):
    data = {'type': kind}
    data.update(payload)
    return data


# 「本轮对话已经放弃等模型」标记：按线程隔离，一次对话跑在一个线程里，
# 下一次对话进来时会被 stream_conversation 复位。
_run_flags = threading.local()

_SILENT_NOTE = ('模型没有响应，本轮后续阶段已停止等待（不再让你对着转圈）。'
                '请检查模型服务是否可用，或在「AI 设置」里调整超时后重试。')


def _model_silent():
    return getattr(_run_flags, 'silent', False)


def _mark_model_silent():
    _run_flags.silent = True


def _reset_model_silence():
    _run_flags.silent = False


def _stream_llm_in_thread(prompt, system, idle_timeout):
    """把阻塞式 ``llm.call`` 搬到子线程，按事件产出（生成器）。

    yield 的 kind：``reasoning_start`` / ``reasoning_chunk`` / ``content_start``
    / ``chunk`` / ``done`` / ``error``。空闲超过 ``idle_timeout`` 秒没有事件即报超时
    ——上游真卡死时套接字层会先给出真实错误，这里不抢跑误导用户。

    一次对话只放弃等待**一轮**：这一段一旦给出「模型无响应」，本轮后面所有阶段直接收手
    （见 ``_model_silent``）。否则会变成「意图等 90s + 回答再等 90s + 分析再等 90s」，
    用户对着转圈等四分半，还是看不出模型其实没在干活。
    """
    if _model_silent():
        yield ('error', _SILENT_NOTE)
        return
    events = queue.Queue()
    collected = []

    def on_content(chunk):
        collected.append(chunk)
        events.put(('chunk', chunk))

    def on_reasoning(chunk):
        events.put(('reasoning_chunk', chunk))

    def worker():
        try:
            text = llm.call(prompt, system, on_content=on_content, on_reasoning=on_reasoning)
            events.put(('done', text))
        except Exception as failure:
            events.put(('error', str(failure)))

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    saw_reasoning = False
    saw_content = False
    full_text = ''
    while True:
        item = _next_event(events, idle_timeout)
        if item is None:
            _mark_model_silent()
            yield ('timeout', full_text)
            break
        kind, data = item
        if kind == 'reasoning_chunk':
            if not saw_reasoning:
                saw_reasoning = True
                yield ('reasoning_start', None)
            yield ('reasoning', data)
        elif kind == 'chunk':
            if saw_reasoning and not saw_content:
                saw_content = True
                yield ('thinking_end', 'complete')
            yield ('chunk', data)
        elif kind == 'done':
            full_text = data or ''.join(collected)
            if llm.looks_like_error(full_text) and not collected:
                if llm.is_no_response(full_text):
                    _mark_model_silent()
                yield ('error', full_text)
            else:
                if saw_reasoning and not saw_content:
                    yield ('thinking_end', 'complete')
                yield ('done', full_text)
            break
        elif kind == 'error':
            yield ('error', data)
            break
    # 收尾只等一下下：worker 是守护线程，真正的兜底是它自己的套接字超时。
    # 等太久没意义 —— 上游不回话时，这条流已经判过超时，界面要继续响应。
    _wait_thread(thread, 0.5)


# ══════════════════════════════════════════════════════════════
# 工具结果上下文（[OK]/[FAIL] 显式标注 + 分级截断）
# ══════════════════════════════════════════════════════════════

def _format_tool_entry(entry, success_limit=3000, error_limit=500):
    status = entry.get('status') or 'success'
    tool = entry.get('tool') or ''
    arguments = entry.get('arguments') or {}
    data = entry.get('result')
    label = entry.get('label') or ''
    try:
        arguments_text = json.dumps(arguments, ensure_ascii=False, default=str)
    except Exception:
        arguments_text = str(arguments)
    if len(arguments_text) > 300:
        arguments_text = arguments_text[:300] + '...'
    prefix = '[%s] ' % label if label else ''
    if status == 'error':
        error_text = data.get('error') if isinstance(data, dict) else str(data)
        error_text = str(error_text or '未知错误')
        if len(error_text) > error_limit:
            error_text = error_text[:error_limit] + '...'
        return ('%s[FAIL] 执行失败（不是有效数据，禁止用于分析）| 工具=%s | 参数=%s | 错误=%s'
                % (prefix, tool, arguments_text, error_text))
    try:
        data_text = json.dumps(data, ensure_ascii=False, default=str)
    except Exception:
        data_text = str(data)
    if len(data_text) > success_limit:
        data_text = data_text[:success_limit] + '...（截断）'
    return ('%s[OK] 执行成功（有效数据，以此为准进行分析）| 工具=%s | 参数=%s | 结果=%s'
            % (prefix, tool, arguments_text, data_text))


def _build_tool_results_context(entries, max_total=10000):
    """分析上下文：一条记录都不能丢，长度不够就把成功数据的配额逐级压低。"""
    if not entries:
        return '（无工具执行记录）'
    text = ''
    for success_limit in (3000, 1500, 600):
        text = '\n\n'.join(_format_tool_entry(entry, success_limit) for entry in entries)
        if len(text) <= max_total:
            return text
    return text[:max_total] + '\n...（上下文过长，部分数据已截断）'


# ══════════════════════════════════════════════════════════════
# 上下文构建
# ══════════════════════════════════════════════════════════════

def _page_context_text(chat_context):
    if not chat_context:
        return ''
    parts = []
    if chat_context.get('page_title'):
        parts.append('当前页面：%s' % chat_context['page_title'])
    elif chat_context.get('page'):
        parts.append('当前页面：%s' % chat_context['page'])
    if chat_context.get('datasource_name'):
        parts.append('当前数据源：%s' % chat_context['datasource_name'])
    if chat_context.get('db_type'):
        parts.append('数据库类型：%s' % chat_context['db_type'])
    sql_content = (chat_context.get('sql_content') or '').strip()
    if sql_content:
        preview = sql_content[:500] + ('...' if len(sql_content) > 500 else '')
        parts.append('当前 SQL 编辑器内容：\n```sql\n%s\n```' % preview)
    if chat_context.get('template_id'):
        parts.append('当前巡检模板 ID：%s' % chat_context['template_id'])
    if not parts:
        return ''
    return ('\n## 当前上下文（用户正在操作的界面）\n' + '\n'.join(parts) +
            '\n请结合上下文给出更贴合当前场景的回答。\n')


def _version_context_for(chat_context, datasource_names=None):
    """数据源版本 + 方言禁区片段（只读缓存，不在请求路径上同步建连探测）。"""
    names = [item for item in (datasource_names or []) if item]
    explicit = (chat_context or {}).get('datasource_name')
    if explicit:
        names.append(explicit)
    records = []
    seen = set()
    for name in names:
        if name in seen:
            continue
        seen.add(name)
        record, status = ds_access.find_datasource(name)
        if status == 'exact' and record:
            records.append(record)
    if not records:
        # 拿不到明确数据源时，退到「可见数据源里的前若干个」，宁多列几个版本也不让版本缺席
        records = ds_access.visible_datasources()[:5]
    if not records:
        return ''
    try:
        return datasource_versions.version_context(records)
    except Exception:
        return ''


def _retrieve_rag_context(message, chat_context, top_k=3):
    """RAG 检索（失败/未启用时静默降级，绝不阻断对话）。"""
    try:
        config = llm.load_ai_config()
        rag_config = config.get('rag') or {}
        if isinstance(rag_config, dict) and rag_config.get('enabled') is False:
            return ''
        from modules.rag import (OllamaEmbedding, OpenAIEmbedding, RAGRetriever, VectorStore)
        store_instance = VectorStore()
        if (store_instance.get_collection_stats() or {}).get('total_chunks', 0) <= 0:
            return ''
        backend = config.get('backend', 'ollama')
        if backend == 'openai':
            embedder = OpenAIEmbedding(api_url=config.get('online_api_url', ''),
                                       model=config.get('online_model', ''),
                                       api_key=config.get('api_key', ''))
        else:
            embedder = OllamaEmbedding()
        retriever = RAGRetriever(store_instance, embedder)
        return retriever.retrieve_for_chat(message, db_type=(chat_context or {}).get('db_type'),
                                           top_k=top_k) or ''
    except Exception:
        return ''


def _session_history(session_id):
    if not session_id:
        return []
    try:
        return store.recent_messages(session_id, limit=20)
    except Exception:
        return []


# ══════════════════════════════════════════════════════════════
# 工具执行（含进度与巡检轮询）
# ══════════════════════════════════════════════════════════════

def _execute_tool_call(name, arguments, holder):
    """执行一次工具调用：**逐条 yield 进度事件**，结果写进 ``holder['envelope']``。

    ``run_template_check`` 支持逐条进度，必须放子线程；其余工具直接执行。
    必须是生成器并把进度就地 yield 出去：进度先塞进列表、等工具整体跑完再返回的话，
    模板巡检界面上就一直是「执行中」，跑完才突然蹦出一串步骤 —— 看不出在动。
    """
    if name != 'run_template_check':
        holder['envelope'] = registry.execute_tool(name, **(arguments or {}))
        return
    events = queue.Queue()

    def on_progress(info):
        events.put(('progress', info))

    def worker():
        try:
            events.put(('result', registry.execute_tool(name, progress_callback=on_progress,
                                                        **(arguments or {}))))
        except Exception as failure:
            events.put(('result', {'success': False, 'tool': name, 'error': str(failure)}))

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    while True:
        item = _next_event(events, _TOOL_TIMEOUT_SECONDS)
        if item is None:
            _wait_thread(thread, 1)
            holder['envelope'] = {'success': False, 'tool': name, 'error': '工具执行超时'}
            return
        kind, data = item
        if kind == 'progress':
            yield _event('tool_progress', tool=name, step=data.get('step'),
                         total=data.get('total'), chapter=data.get('chapter', ''),
                         query_key=data.get('query_key', ''),
                         description=data.get('description', ''),
                         status=data.get('status', 'running'))
            continue
        _wait_thread(thread, 5)
        holder['envelope'] = data
        return


def _poll_inspection_progress(task_id):
    """巡检任务启动后，把日志增量推给前端（最多约 90 秒，之后交给「巡检进度」弹窗）。"""
    from modules.web.app import tasks
    last_count = 0
    for _round in range(_INSPECTION_POLL_ROUNDS):
        _pause(_INSPECTION_POLL_INTERVAL)
        task = tasks.get(task_id)
        if not task:
            break
        log = list(task.get('log') or [])
        new_entries = log[last_count:]
        last_count = len(log)
        if new_entries:
            yield _event('tool_progress', tool='start_inspection', step=last_count, total=0,
                         chapter='', query_key='',
                         description='\n'.join(new_entries[-6:]), status='running')
        if task.get('status') in ('done', 'error'):
            break


def run_tool_call(name, arguments, step_index, total_steps, round_count=1):
    """执行一个工具调用并产出它的全部事件。

    yield 事件 dict；调用结束后 ``yield {'type': '_record', 'value': entry}`` 收尾，
    由上层取出（生成器不便 return 值，用这条显式事件传记录）。
    """
    started_at = time.time()
    yield _event('tool_executing', tool=name, arguments=arguments, step=step_index,
                 total_steps=total_steps, round=round_count, timestamp=int(started_at * 1000))
    holder = {}
    for event in _execute_tool_call(name, arguments, holder):
        yield event
    envelope = holder.get('envelope') or {'success': False, 'tool': name, 'error': '工具无返回'}
    result_data = envelope.get('result', envelope)
    status = 'success' if envelope.get('success') else 'error'
    if isinstance(result_data, dict) and result_data.get('error'):
        status = 'error'
    if name == 'start_inspection' and status == 'success':
        task_id = (result_data or {}).get('task_id') if isinstance(result_data, dict) else ''
        if task_id:
            for progress_event in _poll_inspection_progress(task_id):
                yield progress_event
    elapsed_ms = int((time.time() - started_at) * 1000)
    yield _event('tool_result', tool=name, result=result_data, status=status,
                 duration_ms=elapsed_ms, step=step_index, round=round_count)
    entry = {'tool': name, 'arguments': arguments, 'result': result_data, 'status': status,
             'label': '执行%s' % step_index, 'duration_ms': elapsed_ms, 'round': round_count}
    yield {'type': '_record', 'value': entry}


# ══════════════════════════════════════════════════════════════
# 会话落库
# ══════════════════════════════════════════════════════════════

def _summarize(text, limit=150):
    """历史摘要：压成一行，供长对话的提示词上下文使用（不额外花一次模型调用）。"""
    flat = re.sub(r'\s+', ' ', str(text or '')).strip()
    return flat[:limit]


def _persist_exchange(session_id, user_message, ai_text, task_id):
    if not session_id:
        return
    try:
        if not store.get_session(session_id):
            return
        store.append_message(session_id, 'user', user_message, task_id,
                             summary=_summarize(user_message, 80))
        store.append_message(session_id, 'assistant', ai_text or '', task_id,
                             summary=_summarize(ai_text, 150))
        current = store.get_session(session_id) or {}
        if current.get('title') in (None, '', '新对话'):
            store.touch_session(session_id, title=_summarize(user_message, 40))
    except Exception:
        pass


def _normalize_template_db_type(db_type):
    return {'pg': 'postgresql', 'dm': 'dm8'}.get(str(db_type or '').lower(), db_type)


def _default_template_for(db_type):
    try:
        from modules.inspection import dal
        return dal.get_default_template(_normalize_template_db_type(db_type))
    except Exception:
        return None


def _templates_for_confirmation(db_type=''):
    try:
        from modules.inspection import dal
        rows = (dal.get_templates_by_db_type(_normalize_template_db_type(db_type)) if db_type
                else dal.get_all_templates()) or []
        return [{'id': item.get('id'), 'name': item.get('template_name') or '',
                 'db_type': item.get('db_type') or ''} for item in rows]
    except Exception:
        return []


def _datasource_names_in_calls(tool_calls):
    names = []
    for call in tool_calls:
        name = (call.get('arguments') or {}).get('datasource_name')
        if name and name not in names:
            names.append(name)
    return names


def _build_detection_user_prompt(message, chat_context, history):
    parts = []
    if chat_context.get('datasource_name'):
        parts.append('当前数据源：%s' % chat_context['datasource_name'])
    if chat_context.get('db_type'):
        parts.append('数据库类型：%s' % chat_context['db_type'])
    if chat_context.get('db_version'):
        parts.append('数据库实际版本：%s（生成的 SQL 必须与该版本兼容，不要假设其他版本）'
                     % chat_context['db_version'])
    user_prompt = message
    if parts:
        user_prompt = '上下文：%s\n用户消息：%s' % ('，'.join(parts), message)
    history_text = ai_intent.build_conversation_history(history)
    if history_text:
        user_prompt = '## 历史对话\n%s\n\n%s' % (history_text, user_prompt)
    return user_prompt


def _parse_decision(text):
    """把模型输出的意图 JSON 收口成决策；非法/全无效工具名时返回 None 让上层走兜底。"""
    if llm.looks_like_error(text):
        return None
    parsed = ai_intent._parse_intent_json(text)
    if not isinstance(parsed, dict):
        return None
    valid_calls = [
        {'name': call['name'], 'arguments': call.get('arguments') or {}}
        for call in (parsed.get('tool_calls') or [])
        if isinstance(call, dict) and call.get('name') in registry.registered_names()
        and registry.is_enabled(call['name'])
    ]
    need_tool = bool(parsed.get('need_tool')) and bool(valid_calls)
    result = {'understanding': str(parsed.get('understanding') or ''),
              'need_tool': need_tool,
              'need_confirmation': bool(parsed.get('need_confirmation')),
              'confirm_question': str(parsed.get('confirm_question') or ''),
              'confirm_options': parsed.get('confirm_options') or None,
              'tool_calls': valid_calls}
    if not need_tool:
        return result
    validation = ai_intent.validate_tool_calls(valid_calls, {}, '')
    if validation:
        result.update(validation)
    elif any(call.get('name') == 'start_inspection' for call in valid_calls):
        result['need_confirmation'] = True
        result['confirm_question'] = '请选择巡检方式：'
        result['confirm_options'] = list(ai_intent.INSPECTION_MODE_OPTIONS)
    return result


def _stream_detection(prompt, system, idle_timeout, outcome):
    """意图检测阶段：**逐事件产出**，结果写进 ``outcome``。

    思考模型给 reasoning_content 时用它当「深度思考」内容；否则退回把模型原始
    输出（意图 JSON）当思考文本流展示，完成后再用 understanding 覆盖。

    这里必须是生成器：以前把事件攒成列表、整段推理跑完才一次性返回，
    用户要等好几秒才看到「深度思考」开始动，看起来像整个助手卡住了。
    outcome 里回填 ``decision`` / ``thinking``，因为生成器不便 return 值。
    """
    reasoning_parts = []
    raw_parts = []
    saw_reasoning = False
    final_text = ''
    for kind, data in _stream_llm_in_thread(prompt, system, idle_timeout):
        if kind == 'reasoning_start':
            saw_reasoning = True
            yield _event('thinking_start')
        elif kind == 'reasoning':
            reasoning_parts.append(data or '')
            yield _event('thinking', content=data)
        elif kind == 'chunk':
            raw_parts.append(data or '')
            if not saw_reasoning:
                yield _event('thinking', content=data)
        elif kind == 'thinking_end':
            yield _event('thinking_end', reason='complete')
        elif kind == 'done':
            final_text = data or ''.join(raw_parts)
        elif kind == 'timeout':
            yield _event('thinking_end', reason='timeout',
                         message='模型长时间未响应，已改用规则兜底')
        elif kind == 'error':
            yield _event('thinking_end', reason='error', message=str(data))
    outcome['decision'] = _parse_decision(final_text)
    outcome['thinking'] = ''.join(reasoning_parts) or ''.join(raw_parts)


# ══════════════════════════════════════════════════════════════
# 主流程
# ══════════════════════════════════════════════════════════════

def stream_conversation(message, session_id='', chat_context=None, confirmed_tool_calls=None,
                        selected_action='', understanding=''):
    """一次提问的完整对话流；逐事件 yield dict，由路由层转成 SSE 帧。"""
    _reset_model_silence()          # 每次提问重新开始，不沿用上一轮「模型没响应」的判断
    chat_context = dict(chat_context or {})
    message = str(message or '').strip()
    config = llm.load_ai_config()
    idle_timeout = llm.idle_timeout(config)
    ai_available = llm.is_available(config)

    datasource_hint = (chat_context.get('datasource_name') or '').strip()
    resolved = None
    if datasource_hint:
        resolved, _status = ds_access.find_datasource(datasource_hint)
        if resolved:
            chat_context['datasource_name'] = resolved['name']

    task_id = ''
    try:
        task_id = store.create_task(message, datasource=chat_context.get('datasource_name') or '',
                                    db_type=chat_context.get('db_type') or '',
                                    session_id=session_id)
    except Exception:
        pass
    yield _event('start', task_id=task_id)

    # 预取数据源真实版本：只读缓存/记忆，缺失时后台补探，本次按「版本未知」保守写 SQL
    if resolved:
        try:
            info = datasource_versions.get_version(resolved)
            if info.get('version'):
                chat_context['db_version'] = info['version']
            if not chat_context.get('db_type'):
                chat_context['db_type'] = info.get('db_type') or chat_context.get('db_type')
        except Exception:
            pass

    history = _session_history(session_id)

    if confirmed_tool_calls:
        for event in _continue_after_confirmation(message, session_id, task_id, chat_context,
                                                 confirmed_tool_calls, selected_action,
                                                 understanding, history, idle_timeout):
            yield event
        return

    # ── Phase 1：意图检测 ──
    if not ai_available:
        decision = ai_intent.detect_intent_by_keywords(message, chat_context)
        yield _event('thinking_start')
        yield _event('thinking', content=decision.get('understanding') or '', replace=True)
        yield _event('thinking_end', reason='error',
                     message='AI 后端未启用，本次按关键词规则处理（可在「AI 设置」中启用模型）')
    else:
        yield _event('thinking_start')
        outcome = {}
        for event in _stream_detection(
                _build_detection_user_prompt(message, chat_context, history),
                ai_intent.get_intent_detection_prompt(), idle_timeout, outcome):
            yield event
        decision, thinking_text = outcome.get('decision'), outcome.get('thinking', '')
        if decision is None:
            decision = ai_intent.detect_intent_by_keywords(message, chat_context)
        if thinking_text:
            try:
                store.update_thinking(task_id, thinking_text)
            except Exception:
                pass

    try:
        store.update_understanding(task_id, decision.get('understanding') or '')
    except Exception:
        pass
    if decision.get('understanding'):
        yield _event('thinking', content=decision['understanding'], replace=True)
        yield _event('thinking_end', reason='complete')

    datasource_names = _datasource_names_in_calls(decision.get('tool_calls') or [])
    version_context = _version_context_for(chat_context, datasource_names)
    _remember_datasource(task_id, chat_context, datasource_names)

    if not decision.get('need_tool'):
        for event in _stream_plain_answer(message, session_id, task_id, chat_context, history,
                                          version_context, idle_timeout, ai_available):
            yield event
        return

    if decision.get('need_confirmation'):
        yield _event('need_confirmation',
                     question=decision.get('confirm_question') or '请确认后继续',
                     options=decision.get('confirm_options') or [],
                     pending_tool_calls=decision.get('tool_calls') or [],
                     understanding=decision.get('understanding') or '')
        yield _event('done')
        return

    for event in _run_tool_calls_and_analyze(
            message, session_id, task_id, chat_context, decision.get('tool_calls') or [],
            decision.get('understanding') or '', history, version_context, idle_timeout):
        yield event


def _remember_datasource(task_id, chat_context, datasource_names):
    if not task_id or not datasource_names:
        return
    try:
        store.update_datasource(task_id, datasource_names[0], chat_context.get('db_type') or '')
    except Exception:
        pass


# ══════════════════════════════════════════════════════════════
# 纯问答（不取数）
# ══════════════════════════════════════════════════════════════

def _stream_plain_answer(message, session_id, task_id, chat_context, history, version_context,
                         idle_timeout, ai_available):
    """知识问答 / 自由对话：页面上下文 + 真实版本 + 历史 + RAG 一起给模型。"""
    if not ai_available:
        text = ('当前未启用 AI 模型，无法进行自由问答。\n\n请在「AI 设置」中选择模型并启用；'
                '启用后可以直接问我：表空间满怎么办、慢 SQL 如何优化、Oracle 巡检看哪些指标等。')
        yield _event('chunk', content=text)
        _persist_exchange(session_id, message, text, task_id)
        try:
            store.finish_task(task_id, 'error', text, 0)
        except Exception:
            pass
        yield _event('done')
        return

    system = ai_intent.get_unified_system_prompt() + _page_context_text(chat_context)
    prompt = message
    history_text = ai_intent.build_conversation_history(history)
    if history_text:
        prompt = '## 历史对话\n%s\n\n## 当前问题\n%s' % (history_text, message)
    if version_context:
        prompt = '%s\n%s' % (version_context, prompt)
    rag_context = _retrieve_rag_context(message, chat_context, top_k=5)
    if rag_context:
        prompt += '\n\n%s\n\n请结合上述知识库内容回答用户的问题。' % rag_context
    else:
        prompt += '\n\n（本次未检索到相关知识库文档，请基于自身知识回答）'

    collected = []
    for kind, data in _stream_llm_in_thread(prompt, system, idle_timeout):
        if kind == 'reasoning_start':
            yield _event('thinking_start')
        elif kind == 'reasoning':
            yield _event('thinking', content=data)
        elif kind == 'thinking_end':
            yield _event('thinking_end', reason='complete')
        elif kind == 'chunk':
            collected.append(data or '')
            yield _event('chunk', content=data)
        elif kind == 'timeout':
            yield _event('thinking_end', reason='timeout',
                         message='模型长时间未响应，请重试或在「AI 设置」中检查模型服务')
        elif kind == 'error':
            failure_text = '\n\n**回答生成失败**：%s' % data
            # 这句要算进答案里：否则正文为空，下面还会再补一句「模型没有返回内容」，
            # 用户看到两条重复的失败说明，以为出了更严重的问题。
            collected.append(failure_text)
            yield _event('chunk', content=failure_text)
    answer = ''.join(collected).strip()
    if not answer:
        answer = '（模型没有返回内容，请检查「AI 设置」里的模型与连接是否可用）'
        yield _event('chunk', content=answer)
    _persist_exchange(session_id, message, answer, task_id)
    try:
        store.finish_task(task_id, 'done', answer, 0)
    except Exception:
        pass
    yield _event('done')


# ══════════════════════════════════════════════════════════════
# 工具执行 + 结果分析（含 <query> 多轮取数）
# ══════════════════════════════════════════════════════════════

def _run_tool_calls_and_analyze(message, session_id, task_id, chat_context, tool_calls,
                                understanding, history, version_context, idle_timeout):
    """先按 tool_calls 取数，再让模型基于 [OK] 数据分析；数据不足时模型可追加 <query>。"""
    tools = [call.get('name') or '' for call in tool_calls]
    yield _event('chunk', content='**理解你的需求**\n\n%s\n\n' % (understanding or '（无）'))
    yield _event('tool_start', reasoning=understanding or '', tools=tools,
                 total_tools=len(tools))
    records = []
    for step_index, call in enumerate(tool_calls, 1):
        name = call.get('name') or ''
        arguments = dict(call.get('arguments') or {})
        if not name:
            continue
        if chat_context.get('datasource_name') and not arguments.get('datasource_name'):
            arguments['datasource_name'] = chat_context['datasource_name']
        stream = run_tool_call(name, arguments, step_index, len(tool_calls), round_count=1)
        for event in stream:
            if event.get('type') == '_record':
                record = event['value']
                records.append(record)
                try:
                    store.append_step(task_id, record['tool'], record['arguments'],
                                      record['result'], record['status'],
                                      record.get('duration_ms') or 0, round_count=1)
                except Exception:
                    pass
                if record.get('tool') == 'start_inspection':
                    _track_inspection_task(task_id, record)
                continue
            yield event

    yield _event('tool_analyzing')
    analysis_text = ''
    for event, analysis_text, final in _analyze_results(
            message, understanding, records, version_context, chat_context, task_id, idle_timeout):
        if final:
            break
        yield event
    full_answer = ('**理解你的需求**\n\n%s\n\n' % understanding if understanding else '') + \
        (analysis_text or '')
    _persist_exchange(session_id, message, full_answer, task_id)
    try:
        store.finish_task(task_id, 'done', full_answer,
                          round_count=_rounds_of(records))
    except Exception:
        pass
    yield _event('done')


def _rounds_of(records):
    rounds = {int((record or {}).get('round') or 1) for record in records}
    return max(rounds) if rounds else 1


def _track_inspection_task(task_id, record):
    """把 AI 起的巡检任务号写回任务历史，历史页/回溯页能跳到巡检进度与报告。"""
    result = record.get('result') or {}
    if not isinstance(result, dict) or not result.get('task_id'):
        return
    try:
        store.update_task(task_id, datasource=result.get('datasource') or '',
                          db_type=result.get('db_type') or '')
    except Exception:
        pass


def _analysis_prompt(message, understanding, context_text, version_context, round_index,
                     rag_context):
    prompt = ('用户请求：%s\n\n系统理解：%s\n\n%s已执行以下工具并获取结果：\n%s\n\n'
              % (message, understanding or '', version_context or '', context_text))
    if rag_context:
        prompt += '## 参考知识\n%s\n\n' % rag_context
    if round_index > 1:
        prompt += '## 当前是第 %d 轮分析（已追加过 %d 轮查询）\n' % (round_index, round_index - 1)
    if round_index >= MAX_ANALYSIS_ROUNDS:
        prompt += '**已达最大轮次，本轮请直接给出最终结论，不要再发 <query> 标签。**\n\n'
    prompt += '请基于以上结果给出专业分析和建议。'
    return prompt


def _analyze_results(message, understanding, records, version_context, chat_context,
                     task_id, idle_timeout):
    """分析阶段（含 <query> 追加取数循环）。

    yield ``(event, analysis_text, final)``：``final=True`` 时上层结束并落库。
    """
    base_entries = list(records)
    accumulated = _build_tool_results_context(base_entries)
    rag_context = _retrieve_rag_context(message, chat_context, top_k=3)
    results_text = accumulated
    analysis_text = ''
    base_step = len(base_entries)
    # 分析阶段的 reasoning 也要落库：只存意图阶段的话，历史页看不到
    # 「模型是怎么从工具结果推到结论的」，回溯时等于缺了半条链路。
    reasoning_parts = []

    for round_index in range(1, MAX_ANALYSIS_ROUNDS + 1):
        prompt = _analysis_prompt(message, understanding, accumulated, version_context,
                                  round_index, rag_context)
        collected = []
        timed_out = False
        failed = ''
        for kind, data in _stream_llm_in_thread(prompt, _ANALYSIS_SYSTEM, idle_timeout):
            if kind == 'reasoning_start':
                yield (_event('thinking_start'), analysis_text, False)
            elif kind == 'reasoning':
                reasoning_parts.append(data or '')
                yield (_event('thinking', content=data), analysis_text, False)
            elif kind == 'thinking_end':
                yield (_event('thinking_end', reason='complete'), analysis_text, False)
            elif kind == 'chunk':
                collected.append(data or '')
                yield (_event('chunk', content=data), analysis_text, False)
            elif kind == 'timeout':
                timed_out = True
            elif kind == 'error':
                failed = str(data)
        if reasoning_parts and task_id:
            try:
                store.append_thinking(task_id, ''.join(reasoning_parts))
            except Exception:
                pass
        raw_analysis = ''.join(collected)
        if timed_out or failed:
            fallback = ('\n\n**分析生成%s**：%s\n\n原始工具结果：\n```json\n%s\n```'
                        % ('超时（长时间未收到模型数据）' if timed_out else '失败',
                           failed or '请重试，或在「AI 设置」中检查模型服务状态',
                           results_text[:2000]))
            yield (_event('chunk', content=fallback), fallback, True)
            analysis_text = fallback
            break

        queries = _QUERY_TAG_PATTERN.findall(raw_analysis)
        cleaned = _QUERY_TAG_PATTERN.sub('', raw_analysis).strip()
        if not queries or round_index >= MAX_ANALYSIS_ROUNDS:
            analysis_text = cleaned
            break

        for query_index, (query_datasource, query_sql) in enumerate(queries, 1):
            query_sql = (query_sql or '').strip()
            if not query_sql:
                continue
            step_index = base_step + query_index
            started_at = time.time()
            yield (_event('tool_executing', tool='execute_sql',
                          arguments={'datasource_name': query_datasource, 'sql': query_sql},
                          step=step_index, total_steps=step_index, round=round_index,
                          timestamp=int(started_at * 1000)), analysis_text, False)
            envelope = registry.execute_tool('execute_sql', datasource_name=query_datasource,
                                             sql=query_sql)
            elapsed_ms = int((time.time() - started_at) * 1000)
            result_data = envelope.get('result', envelope)
            status = 'success' if envelope.get('success') else 'error'
            if isinstance(result_data, dict) and result_data.get('error'):
                status = 'error'
            yield (_event('tool_result', tool='execute_sql', result=result_data, status=status,
                          duration_ms=elapsed_ms, step=step_index, round=round_index),
                   analysis_text, False)
            try:
                store.append_step(task_id, 'execute_sql',
                                  {'datasource_name': query_datasource, 'sql': query_sql},
                                  result_data, status, elapsed_ms, round_count=round_index)
            except Exception:
                pass
            entry = {'label': '追加查询(第%d轮)' % round_index, 'tool': 'execute_sql',
                     'arguments': {'datasource_name': query_datasource, 'sql': query_sql},
                     'result': result_data, 'status': status}
            accumulated += '\n\n' + _format_tool_entry(entry, success_limit=3000)
            if status == 'error':
                repair_context = _column_repair_context(query_datasource, query_sql, result_data)
                if repair_context:
                    accumulated += repair_context

    yield (None, analysis_text, True)


def _column_repair_context(datasource_name, sql, result_data):
    """追加查询报「列不存在」时，把该表真实列清单喂回下一轮，模型不再重复瞎猜列名。"""
    error_text = (result_data or {}).get('error') if isinstance(result_data, dict) else ''
    if not error_text:
        return ''
    try:
        from modules.ai.tools import sql_tools
        record, status = ds_access.find_datasource(datasource_name)
        if status != 'exact' or not record:
            return ''
        instance = ds_access.load_decrypted(record)
        repair = sql_tools.build_column_repair(instance, sql, error_text)
    except Exception:
        return ''
    if not repair:
        return ''
    lines = []
    for table in repair.get('tables') or []:
        columns = table.get('columns') or []
        if columns:
            lines.append('- %s 的实际列：%s' % (table.get('table'), ', '.join(columns)))
    suggestion = repair.get('suggestion')
    if suggestion:
        lines.append('- 报错列「%s」可改用：%s（表 %s）' % (
            repair.get('bad_column', ''), suggestion.get('suggested'), suggestion.get('table')))
    if not lines:
        return ''
    return ('\n### 上述追加查询失败的真实列参考（只准使用下列真实存在的列，'
            '禁止再使用报错中缺失的列）\n' + '\n'.join(lines))


# ══════════════════════════════════════════════════════════════
# 确认后的续跑
# ══════════════════════════════════════════════════════════════

def _continue_after_confirmation(message, session_id, task_id, chat_context, tool_calls,
                                 selected_action, understanding, history, idle_timeout):
    """用户点选后的续跑：巡检方式两选一 → 最终确认 → 执行。"""
    tool_calls = [call for call in (tool_calls or []) if isinstance(call, dict)]
    understanding = understanding or '用户已确认执行'
    datasource_name = ''
    for call in tool_calls:
        supplied = (call.get('arguments') or {}).get('datasource_name')
        if supplied:
            datasource_name = supplied
            break
    if not datasource_name and chat_context.get('datasource_name'):
        datasource_name = chat_context['datasource_name']
        for call in tool_calls:
            (call.setdefault('arguments') or {}).setdefault('datasource_name', datasource_name)

    if selected_action == 'ai_autonomous':
        steps_text = '\n'.join('%d. %s' % (index, step) for index, step
                               in enumerate(_AUTONOMOUS_INSPECTION_STEPS, 1))
        intro = ('**AI 自主巡检**\n\n将对数据源 **%s** 执行以下巡检步骤：\n\n%s\n\n'
                 '请确认是否执行巡检：\n' % (datasource_name or '待选择', steps_text))
        yield _event('chunk', content=intro)
        yield _event('need_confirmation', question='确认执行以上 AI 自主巡检步骤？',
                     options=[{'label': '✅ 确认执行巡检', 'value': 'confirm_execute',
                               'action': 'confirm_execute'},
                              {'label': '❌ 取消', 'value': 'cancel', 'action': 'cancel'}],
                     pending_tool_calls=tool_calls,
                     understanding='用户确认执行 AI 自主巡检（数据源：%s）' % datasource_name)
        _persist_exchange(session_id, message, intro + '\n\n*等待用户确认巡检执行*', task_id)
        try:
            store.finish_task(task_id, 'running', intro, 0)
        except Exception:
            pass
        yield _event('done')
        return

    if selected_action == 'template_inspection':
        record, status = ds_access.find_datasource(datasource_name) if datasource_name \
            else (None, 'none')
        db_type = (record or {}).get('db_type') or chat_context.get('db_type') or ''
        default_template = _default_template_for(db_type) if db_type else None
        if default_template:
            template_id = default_template.get('id')
            template_name = default_template.get('template_name') or ''
            intro = ('**按巡检模板执行**\n\n将对数据源 **%s**（%s）使用默认巡检模板 '
                     '**「%s」** 执行巡检，请确认：\n'
                     % (datasource_name, db_type, template_name))
            yield _event('chunk', content=intro)
            yield _event('need_confirmation',
                         question='确认使用模板「%s」执行巡检？' % template_name,
                         options=[{'label': '✅ 确认执行', 'value': 'confirm_execute',
                                   'action': 'confirm_execute'},
                                  {'label': '❌ 取消', 'value': 'cancel', 'action': 'cancel'}],
                         pending_tool_calls=[{'name': 'run_template_check',
                                              'arguments': {'datasource_name': datasource_name,
                                                            'template_id': template_id}}],
                         understanding='用户确认使用模板「%s」对数据源 %s 执行巡检'
                                       % (template_name, datasource_name))
            _persist_exchange(session_id, message, intro + '\n\n*等待用户确认*', task_id)
            try:
                store.finish_task(task_id, 'running', intro, 0)
            except Exception:
                pass
            yield _event('done')
            return

        templates = _templates_for_confirmation(db_type) or _templates_for_confirmation()
        if not templates:
            warning = '**暂无可用巡检模板**\n\n请先在「巡检配置管理」中创建巡检模板。'
            yield _event('chunk', content=warning)
            _persist_exchange(session_id, message, warning, task_id)
            try:
                store.finish_task(task_id, 'done', warning, 0)
            except Exception:
                pass
            yield _event('done')
            return
        intro = ('**按巡检模板执行**\n\n将对数据源 **%s**（%s）执行巡检，请选择巡检模板：\n'
                 % (datasource_name or '待选择', db_type or '未知类型'))
        yield _event('chunk', content=intro)
        yield _event('need_confirmation', question='请选择要执行的巡检模板：',
                     options=[{'label': '%s（%s）' % (item['name'], item.get('db_type') or ''),
                               'value': str(item['id']), 'action': 'select_template',
                               'template_id': item['id']} for item in templates],
                     pending_tool_calls=[{'name': 'run_template_check',
                                          'arguments': {'datasource_name': datasource_name,
                                                        'template_id': 0}}],
                     understanding='用户选择巡检模板执行（数据源：%s）' % datasource_name)
        _persist_exchange(session_id, message, intro + '\n\n*等待用户选择巡检模板*', task_id)
        try:
            store.finish_task(task_id, 'running', intro, 0)
        except Exception:
            pass
        yield _event('done')
        return

    if selected_action == 'cancel':
        text = '**已取消操作**\n\n好的，本次巡检已取消。如需执行巡检，请重新发起。'
        yield _event('chunk', content=text)
        _persist_exchange(session_id, message, text, task_id)
        try:
            store.finish_task(task_id, 'done', text, 0)
        except Exception:
            pass
        yield _event('done')
        return

    if selected_action == 'set_datasource' and any(
            call.get('name') == 'start_inspection' for call in tool_calls):
        intro = ('**已选择数据源**\n\n将对数据源 **%s** 执行巡检，请选择巡检方式：\n'
                 % (datasource_name or '待选择'))
        yield _event('chunk', content=intro)
        yield _event('need_confirmation', question='请选择巡检方式：',
                     options=list(ai_intent.INSPECTION_MODE_OPTIONS),
                     pending_tool_calls=tool_calls,
                     understanding='用户选择数据源 %s 执行巡检，请选择巡检方式' % datasource_name)
        _persist_exchange(session_id, message, intro + '\n\n*等待用户选择巡检方式*', task_id)
        try:
            store.finish_task(task_id, 'running', intro, 0)
        except Exception:
            pass
        yield _event('done')
        return

    version_context = _version_context_for(chat_context,
                                           _datasource_names_in_calls(tool_calls))
    _remember_datasource(task_id, chat_context, _datasource_names_in_calls(tool_calls))
    for event in _run_tool_calls_and_analyze(message, session_id, task_id, chat_context,
                                             tool_calls, understanding, history,
                                             version_context, idle_timeout):
        yield event
