# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · 意图识别与系统提示词。

归属说明：意图识别与系统提示词的语义设计归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) 所有，三处按 RaccoonX 的权限口径落地：

1. **系统技能缓存**（数据源 / 模板 / 基线）注入提示词，让模型填**真实存在的**
   数据源名称 —— 缓存按当前用户可见范围生成，而非全局数据源，
   模型因此不可能「看到」并引用越权的数据源；
2. **意图 JSON 协议**保持不变：``{understanding, need_tool, need_confirmation,
   confirm_question, confirm_options, tool_calls}``，输出非法/工具名不存在时
   退到确定性关键词兜底，绝不让一次提问没有下文；
3. **参数后校验**：需要数据源的工具，名称为空/模糊/不存在时补候选项发起确认
   （候选按用户话里推断出的数据库类型收窄），巡检意图固定注入
   「AI 自主巡检 / 按模板巡检」两选一。
"""
import json
import re
import time

from modules.ai import datasource_access as ds_access
from modules.ai import llm
from modules.ai import registry

_SKILLS_CACHE_TTL_SECONDS = 300
_system_skills_cache = {'data': None, 'ts': 0.0}

# 用户消息/上下文里的类型线索 → 本仓库方言口径
_DB_TYPE_HINTS = [
    ('postgres', 'postgresql'), ('postgresql', 'postgresql'), ('pgsql', 'postgresql'),
    ('pg ', 'postgresql'), ('ivorysql', 'ivorysql'), ('kingbase', 'kingbase'),
    ('瀚高', 'hgdb'), ('崖山', 'yashandb'), ('yashandb', 'yashandb'),
    ('oracle', 'oracle'), ('ora ', 'oracle'), ('oci', 'oracle'),
    ('mysql', 'mysql'), ('mariadb', 'mysql'), ('tidb', 'tidb'), ('oceanbase', 'oceanbase'),
    ('sqlserver', 'sqlserver'), ('sql server', 'sqlserver'), ('mssql', 'sqlserver'),
    ('达梦', 'dm'), ('dm8', 'dm'), (' 达梦', 'dm'),
]

# 需要「目标数据源」的工具：名称缺失/歧义时必须走确认
_DS_REQUIRED_TOOLS = ('query_connection_count', 'query_lock_waits', 'execute_sql',
                      'get_datasource_detail', 'start_inspection', 'run_template_check',
                      'test_connection', 'check_sql_dialect')

INTENT_DETECTION_PROMPT = """你是数据库巡检助手的意图分析器。分析用户的自然语言请求，判断需要调用哪些系统工具。

## 重要定位（必须遵守）
- 本助手是**只读巡检助手**：只能执行查询语句（SELECT 等只读操作），**不能执行任何写操作或管理操作**（如 DDL/DML/触发定时任务等）。
- 用户要求"巡检/全库巡检/启动巡检/按模板巡检"等巡检类操作时，**先让用户选择巡检方式**：设 need_confirmation=true，confirm_question="请选择巡检方式："，confirm_options 提供「🤖 AI 自主巡检」和「📋 按巡检模板执行」两个选项（action 分别为 ai_autonomous / template_inspection），tool_calls 填入 start_inspection（含数据源）。用户选择 AI 自主巡检后列出预期步骤并请求最终确认；选择按模板巡检后列出模板供用户选择。
- 发现问题时，只提供分析结论和建议 SQL，明确标注需 DBA 确认后手动执行。

## 数据库类型识别（重要）
- 用户消息中明确提到数据库类型时（如"oracle表空间""mysql的慢查询"），在需要目标数据源的工具（execute_sql / query_connection_count / get_datasource_detail / start_inspection 等）的 arguments 中同步写入对应 `db_type`（如 execute_sql 参数填 `"db_type":"oracle"`），便于系统只展示该类型的数据源候选。
- 若用户既未指明类型、也非从某类型页面发起，则不带 db_type。

## 数据源名称（重要）
- arguments 里的 datasource_name 必须使用下方「系统已注册数据源」中的**真实名称**，不要臆造、不要用主机地址代替名称。
- 用户说的是简称/别名时，先在真实名称里找唯一对应；找不到唯一匹配就留空并设 need_confirmation=true。

可用工具：
{tools}

请用纯JSON格式回复（不要包含```json标记，不要有任何其他文字）：
{"understanding":"先一句话说明你理解用户想做什么，再简述执行计划（打算调用什么工具/为什么/预期得到什么结果）","need_tool":true,"need_confirmation":false,"confirm_question":"","tool_calls":[{"name":"工具名","arguments":{"参数名":"参数值"}}]}

## 何时需要确认（need_confirmation=true）
1. 用户要执行只读查询但未指定目标数据源，且系统有多个数据源
2. 用户提到的数据源名称不完整或模糊（如只说了"oracle"，但有多个oracle数据源）
3. 用户意图不明确，可能匹配多种操作

## 不需要确认的情况
- 用户明确指定了数据源全名
- 工具不需要 datasource_name（如 list_datasources、list_inspection_templates、get_home_stats）
- 知识问答（need_tool=false）

示例：
用户: 有哪些数据源
回复: {"understanding":"用户想查看当前用户可见的所有数据库数据源","need_tool":true,"need_confirmation":false,"confirm_question":"","tool_calls":[{"name":"list_datasources","arguments":{}}]}

用户: Oracle表空间满了怎么办
回复: {"understanding":"用户询问Oracle表空间满的处理方法，属于知识问答","need_tool":false,"need_confirmation":false,"confirm_question":"","tool_calls":[]}

用户: 生产库-Oracle 的连接数
回复: {"understanding":"用户想查看指定数据源的实时连接数","need_tool":true,"need_confirmation":false,"confirm_question":"","tool_calls":[{"name":"query_connection_count","arguments":{"datasource_name":"生产库-Oracle"}}]}

用户: 巡检 生产库-Oracle
回复: {"understanding":"用户想对指定数据源执行巡检，请选择巡检方式","need_tool":true,"need_confirmation":true,"confirm_question":"请选择巡检方式：","confirm_options":[{"label":"🤖 AI 自主巡检","value":"ai_autonomous","action":"ai_autonomous"},{"label":"📋 按巡检模板执行","value":"template_inspection","action":"template_inspection"}],"tool_calls":[{"name":"start_inspection","arguments":{"datasource_name":"生产库-Oracle","scope":"all"}}]}

用户: 看看oracle的连接数
回复: {"understanding":"用户想查看Oracle数据源的连接数，但未指定具体是哪个","need_tool":true,"need_confirmation":true,"confirm_question":"系统中有多个Oracle数据源，请问要查看哪个的连接数？","tool_calls":[{"name":"query_connection_count","arguments":{"datasource_name":"","db_type":"oracle"}}]}

规则：
- 用户提到具体数据源名称时，在arguments中填入该名称
- 知识问答（xxx怎么办、xxx怎么配置、什么是xxx）设need_tool=false
- **只返回JSON对象（以 { 开头、} 结尾），严禁输出任何其他内容**
- 严禁输出 <tool_code>、tool_call()、print()、代码块、解释性文字、markdown标记
- 严禁编造工具名，只能使用上方"可用工具"列表中列出的工具名
- 你的输出会被程序直接解析，任何非JSON字符都会导致解析失败
"""


def invalidate_system_skills_cache():
    """数据源/模板变更后立即失效，避免提示词最多滞后 5 分钟。"""
    _system_skills_cache['data'] = None
    _system_skills_cache['ts'] = 0.0


def get_system_skills(force_refresh=False):
    """系统技能缓存：可见数据源 / 巡检模板 / 基线（TTL 5 分钟）。"""
    now = time.time()
    cached = _system_skills_cache
    if not force_refresh and cached['data'] and (now - cached['ts']) < _SKILLS_CACHE_TTL_SECONDS:
        return cached['data']
    skills = {'datasources': [], 'templates': [], 'baselines': [],
              'fetched_at': time.strftime('%Y-%m-%dT%H:%M:%S')}
    try:
        skills['datasources'] = ds_access.visible_datasources()
    except Exception as failure:
        skills['datasources_error'] = str(failure)
    try:
        from modules.inspection import dal
        skills['templates'] = [
            {'id': item.get('id'), 'name': item.get('template_name') or '',
             'db_type': item.get('db_type') or '',
             'is_default': bool(item.get('is_default') or 0)}
            for item in (dal.get_all_templates() or [])]
    except Exception as failure:
        skills['templates_error'] = str(failure)
    try:
        from modules.inspection import dal
        rows = []
        for candidate in ('oracle', 'mysql', 'postgresql', 'sqlserver', 'dm8'):
            for row in (dal.get_baselines_by_db_type(candidate, enabled_only=False) or []):
                rows.append({'instance_name': row.get('instance_name') or row.get('name') or '',
                             'db_type': row.get('db_type') or '',
                             'baseline_name': row.get('baseline_name') or row.get('name') or ''})
        skills['baselines'] = rows[:60]
    except Exception as failure:
        skills['baselines_error'] = str(failure)
    _system_skills_cache['data'] = skills
    _system_skills_cache['ts'] = now
    return skills


def get_system_skills_for_prompt():
    """把系统技能压成提示词片段（数据源给真实名称，模型才能填对参数）。"""
    skills = get_system_skills()
    lines = []
    datasources = skills.get('datasources') or []
    if datasources:
        lines.append('### 系统已注册数据源（用户提到的数据源名请对应到下列真实名称）')
        lines.append('数据源按「目录」组织（区域/机房归属），「标签」表示业务方向。')
        for item in datasources:
            extras = ['目录: %s' % (item.get('dir_path') or '未分配')]
            if item.get('labels'):
                extras.append('标签: %s' % '/'.join(str(x) for x in item['labels']))
            extras.append('状态: %s' % ('disabled' if item.get('enabled') is False else 'enabled'))
            lines.append('- %s (%s, %s; %s)' % (
                item.get('name') or item.get('id'), item.get('db_type'), item.get('host'),
                '; '.join(extras)))
    templates = skills.get('templates') or []
    if templates:
        lines.append('### 巡检模板')
        for item in templates:
            flag = '（默认）' if item.get('is_default') else ''
            lines.append('- [id=%s] %s (%s)%s' % (item.get('id'), item.get('name'),
                                                  item.get('db_type'), flag))
    baselines = skills.get('baselines') or []
    if baselines:
        lines.append('### 基线配置')
        for item in baselines[:30]:
            lines.append('- %s (%s): %s' % (item.get('instance_name'), item.get('db_type'),
                                            item.get('baseline_name')))
    return '\n'.join(lines) if lines else '(无系统技能信息)'


def get_intent_detection_prompt():
    tools_text = registry.schemas_for_prompt()
    prompt = INTENT_DETECTION_PROMPT.replace('{tools}', tools_text)
    skills_text = get_system_skills_for_prompt()
    if skills_text and skills_text != '(无系统技能信息)':
        prompt += ('\n\n## 系统上下文（已注册技能缓存）\n' + skills_text +
                   '\n\n注意：用户提到的数据源简称/别名请先对应到上方真实数据源名称后再填入 '
                   'arguments.datasource_name。')
    return prompt


def build_conversation_history(messages, max_rounds=10):
    """把历史消息压成提示词片段（优先用 summary，长文按 500/300 字截断）。"""
    if not messages:
        return ''
    lines = []
    for entry in list(messages)[-max_rounds * 2:]:
        role = entry.get('role') or ''
        content = entry.get('summary') or entry.get('content') or ''
        if not content:
            continue
        limit = 500 if role == 'user' else 300
        text = str(content).replace('\n', ' ').strip()
        if len(text) > limit:
            text = text[:limit] + '...'
        label = '用户' if role in ('user', 'human') else '助手'
        lines.append('%s: %s' % (label, text))
    return '\n'.join(lines)


def infer_db_type_from_message(user_message, chat_context=None):
    """从消息/页面上下文推断数据库类型（用于把候选数据源收窄）。"""
    if chat_context:
        context_type = (chat_context.get('db_type') or '').strip()
        if context_type:
            return ds_access._normalize_type_for_match(context_type)
    if user_message:
        text = ' ' + str(user_message).lower() + ' '
        for keyword, canonical in _DB_TYPE_HINTS:
            if keyword in text:
                return ds_access._normalize_type_for_match(canonical)
    return ''


def _datasource_option_label(item):
    tail = ['%s @ %s:%s' % (item.get('db_type') or '?', item.get('host') or '',
                            item.get('port') or '')]
    tail.append('目录: %s' % (item.get('dir_path') or '未分配'))
    if item.get('labels'):
        tail.append('标签: %s' % '/'.join(str(x) for x in item['labels']))
    return '%s (%s)' % (item.get('name') or item.get('id'), '; '.join(tail))


def _candidate_options(candidates):
    return [{'label': _datasource_option_label(item), 'value': item.get('name') or item.get('id'),
             'action': 'set_datasource', 'datasource_name': item.get('name') or item.get('id')}
            for item in candidates]


def validate_tool_calls(tool_calls, chat_context=None, user_message=''):
    """检查工具参数完整性；缺失/模糊/不存在时返回确认请求，完整时返回 None。"""
    inferred_type = infer_db_type_from_message(user_message, chat_context)
    for call in tool_calls:
        name = call.get('name', '')
        arguments = call.get('arguments') or {}
        if name not in _DS_REQUIRED_TOOLS:
            continue
        preferred_type = str(arguments.get('db_type') or '').strip()
        target_type = inferred_type or ds_access._normalize_type_for_match(preferred_type)
        supplied = str(arguments.get('datasource_name') or '').strip()
        candidates = ds_access.candidates_for(target_type)
        if not supplied:
            if not candidates:
                return None
            question = '请问要对哪个数据源执行 %s 操作？' % name
            if target_type:
                question = '请问要对哪个 **%s** 数据源执行 %s 操作？' % (target_type.upper(), name)
            return {'need_confirmation': True, 'confirm_question': question,
                    'confirm_options': _candidate_options(candidates)}
        record, status = ds_access.find_datasource(supplied, db_type=target_type)
        if status == 'exact' and record:
            arguments['datasource_name'] = record['name'] or record['id']
            continue
        if status == 'ambiguous':
            matches = [item for item in candidates
                       if supplied.lower() in (item.get('name') or '').lower()
                       or (item.get('name') or '').lower() in supplied.lower()]
            return {'need_confirmation': True,
                    'confirm_question': '未找到名为「%s」的数据源，是否指以下数据源？' % supplied,
                    'confirm_options': _candidate_options(matches or candidates)}
        return {'need_confirmation': True,
                'confirm_question': '未找到名为「%s」的数据源，请从以下数据源中选择：' % supplied,
                'confirm_options': _candidate_options(candidates)}
    return None


INSPECTION_MODE_OPTIONS = [
    {'label': '🤖 AI 自主巡检', 'value': 'ai_autonomous', 'action': 'ai_autonomous'},
    {'label': '📋 按巡检模板执行', 'value': 'template_inspection', 'action': 'template_inspection'},
]


def detect_intent_with_llm(user_message, chat_context=None, on_content=None,
                           on_reasoning=None, conversation_history=None):
    """用模型识别意图，返回工具调用决策；模型不可用/输出不合法时走关键词兜底。"""
    prompt = get_intent_detection_prompt()
    user_prompt = user_message
    if chat_context:
        parts = []
        if chat_context.get('datasource_name'):
            parts.append('当前数据源：%s' % chat_context['datasource_name'])
        if chat_context.get('db_type'):
            parts.append('数据库类型：%s' % chat_context['db_type'])
        if chat_context.get('db_version'):
            parts.append('数据库实际版本：%s（生成的 SQL 必须与该版本兼容，不要假设其他版本）'
                         % chat_context['db_version'])
        if parts:
            user_prompt = '上下文：%s\n用户消息：%s' % ('，'.join(parts), user_message)
    history_text = build_conversation_history(conversation_history)
    if history_text:
        user_prompt = '## 历史对话\n%s\n\n%s' % (history_text, user_prompt)

    response = llm.call(user_prompt, prompt, on_content=on_content, on_reasoning=on_reasoning)
    if llm.looks_like_error(response):
        return detect_intent_by_keywords(user_message, chat_context)
    parsed = _parse_intent_json(response)
    if parsed is None:
        return detect_intent_by_keywords(user_message, chat_context)

    understanding = str(parsed.get('understanding') or '')
    need_tool = bool(parsed.get('need_tool'))
    valid_calls = [
        {'name': call['name'], 'arguments': call.get('arguments') or {}}
        for call in (parsed.get('tool_calls') or [])
        if isinstance(call, dict) and call.get('name') in registry.registered_names()
        and registry.is_enabled(call['name'])
    ]
    if need_tool and not valid_calls:
        return detect_intent_by_keywords(user_message, chat_context)

    result = {
        'understanding': understanding,
        'need_tool': need_tool and bool(valid_calls),
        'need_confirmation': bool(parsed.get('need_confirmation')),
        'confirm_question': str(parsed.get('confirm_question') or ''),
        'confirm_options': parsed.get('confirm_options') or None,
        'tool_calls': valid_calls,
    }
    if not result['need_tool']:
        return result

    validation = validate_tool_calls(valid_calls, chat_context, user_message)
    if validation:
        result.update(validation)
        return result
    if any(call.get('name') == 'start_inspection' for call in valid_calls):
        has_target = any((call.get('arguments') or {}).get('datasource_name')
                         for call in valid_calls if call.get('name') == 'start_inspection')
        if has_target:
            result['need_confirmation'] = True
            result['confirm_question'] = '请选择巡检方式：'
            result['confirm_options'] = list(INSPECTION_MODE_OPTIONS)
    return result


def _parse_intent_json(response):
    text = str(response or '').strip()
    if not text:
        return None
    if text.startswith('```'):
        text = re.sub(r'^```[a-zA-Z]*\s*', '', text)
        text = re.sub(r'\s*```$', '', text).strip()
    first, last = text.find('{'), text.rfind('}')
    if first < 0 or last <= first:
        return None
    try:
        data = json.loads(text[first:last + 1])
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _extract_datasource_name(message_lower, chat_context=None):
    """关键词兜底里的数据源名提取：真实名称命中 > 常见命名模式 > 页面上下文。"""
    for item in ds_access.visible_datasources():
        name = (item.get('name') or '').strip()
        if name and name.lower() in message_lower:
            return name
    patterns = [r'([\w\-]*(?:oracle|mysql|pg|postgres|dm|sqlserver|tidb|kingbase|ivorysql|yashandb)[\w\-]*)',
                r'([\w\-]+_(?:prod|test|core|dg|standby))']
    for pattern in patterns:
        matched = re.search(pattern, message_lower, re.IGNORECASE)
        if matched:
            candidate = matched.group(1)
            for item in ds_access.visible_datasources():
                if (item.get('name') or '').lower() == candidate.lower():
                    return item['name']
            return candidate
    if chat_context:
        return chat_context.get('datasource_name') or ''
    return ''


def _keyword_call(name, arguments=None, understanding=''):
    return {'understanding': understanding, 'need_tool': True, 'need_confirmation': False,
            'confirm_question': '', 'confirm_options': None,
            'tool_calls': [{'name': name, 'arguments': arguments or {}}]}


def detect_intent_by_keywords(user_message, chat_context=None):
    """LLM 不可用时的确定性兜底：按关键词选工具，保证「问得出、有回应」。"""
    text = str(user_message or '').lower()
    datasource_name = _extract_datasource_name(text, chat_context)
    inferred_type = infer_db_type_from_message(user_message, chat_context)

    if re.match(r'^\s*(select|with|show|describe|explain|values)\b', text.strip()):
        return _keyword_call('execute_sql',
                             {'datasource_name': datasource_name, 'sql': user_message},
                             '用户粘贴了一条 SQL，需要在数据源上以只读方式执行')
    if any(keyword in text for keyword in ['巡检模板', '检查项', '技能点', '模板列表', '检查模板']):
        return _keyword_call('list_inspection_templates', {'db_type': inferred_type},
                             '用户想查看巡检模板（技能点）列表')
    if any(keyword in text for keyword in ['连接数', '会话数', 'session']) and datasource_name:
        return _keyword_call('query_connection_count', {'datasource_name': datasource_name},
                             '用户想查看数据源 %s 的实时连接数' % datasource_name)
    if any(keyword in text for keyword in ['锁等待', '阻塞', 'blocking', 'lock']):
        return _keyword_call('query_lock_waits', {'datasource_name': datasource_name},
                             '用户想查看当前锁等待/阻塞情况')
    if any(keyword in text for keyword in ['慢查询', '慢sql', 'slow query', 'slow sql']):
        return _keyword_call('get_slow_queries', {'datasource_name': datasource_name},
                             '用户想查看慢查询数据')
    if any(keyword in text for keyword in ['数据源', '有哪些库', '数据库列表', '实例列表']):
        return _keyword_call('list_datasources', {'db_type': inferred_type},
                             '用户想查看已配置的数据源列表')
    if any(keyword in text for keyword in ['版本', 'patch', '补丁']):
        return _keyword_call('get_datasource_versions', {}, '用户想查看各数据源的实际版本')
    if any(keyword in text for keyword in ['巡检', '体检', '健康检查', '检查一下']):
        if datasource_name:
            return {'understanding': '用户想对数据源 %s 执行巡检，请选择巡检方式' % datasource_name,
                    'need_tool': True, 'need_confirmation': True,
                    'confirm_question': '请选择巡检方式：',
                    'confirm_options': list(INSPECTION_MODE_OPTIONS),
                    'tool_calls': [{'name': 'start_inspection',
                                    'arguments': {'datasource_name': datasource_name,
                                                  'scope': 'all'}}]}
        return _keyword_call('list_datasources', {},
                             '用户想执行巡检但未指定数据源，先列出数据源供选择')
    if any(keyword in text for keyword in ['巡检报告', '报告列表', '历史报告', '查看报告']):
        return _keyword_call('list_reports', {'datasource_name': datasource_name},
                             '用户想查看巡检报告列表')
    if any(keyword in text for keyword in ['定时任务', '调度', '计划任务', 'cron']):
        return _keyword_call('list_scheduler_jobs', {}, '用户想查看定时巡检任务')
    if any(keyword in text for keyword in ['基线', 'baseline']):
        return _keyword_call('list_baselines', {'db_type': inferred_type}, '用户想查看基线配置')
    if any(keyword in text for keyword in ['统计', '仪表盘', '首页', '概览', '总览']):
        return _keyword_call('get_home_stats', {}, '用户想查看系统统计信息')
    if any(keyword in text for keyword in ['任务状态', '巡检进度', 'task']) :
        matched = re.search(r'([0-9a-f]{8,32})', text)
        return _keyword_call('get_task_status', {'task_id': matched.group(1) if matched else ''},
                             '用户想查询巡检任务状态')
    return {'understanding': '用户的问题属于知识问答或自由对话', 'need_tool': False,
            'need_confirmation': False, 'confirm_question': '', 'confirm_options': None,
            'tool_calls': []}


UNIFIED_SYSTEM_PROMPT_TEMPLATE = """你是 DBCheck 数据库巡检助手，拥有 20 年 DBA 经验。你通过自然语言与用户对话，帮助用户对数据库进行只读巡检和问题分析。

## 可用技能（工具）
{tools}

## 重要规则（必须遵守）
- 本助手是**只读巡检助手**：只能执行查询语句（SELECT 等只读操作），不能执行任何写操作或管理操作（如 DDL/DML/启动巡检任务/触发定时任务等）。
- 用户要求"巡检/全库巡检/启动巡检/按模板巡检"时，先让用户选择巡检方式（AI 自主巡检 / 按模板执行）。
- 发现问题时，按「问题分析 → 建议方案（含 SQL）→ 风险说明」的结构输出，并明确标注：**建议 SQL 仅供参考，需由 DBA 审阅确认后手动执行**。
- 回答使用中文，使用 Markdown 格式，专业、简洁、突出重点。
- 给出多条 SQL 时，每条语句必须以分号 ; 结尾（前端按分号拆成逐条独立执行）。
"""


def get_unified_system_prompt():
    """对话/分析阶段共用的 system prompt（含当前启用工具清单）。"""
    return UNIFIED_SYSTEM_PROMPT_TEMPLATE.replace('{tools}', registry.schemas_for_prompt())
