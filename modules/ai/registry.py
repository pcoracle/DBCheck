# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · 工具注册中心与执行边界。

归属说明：工具注册与执行边界的语义设计归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) 所有，并按 RaccoonX 的权限模型加强：

* **只读边界**：``READONLY_TOOLS`` 白名单外的工具一律拒绝执行，返回
  ``readonly_blocked``，供助手明确告诉用户「需 DBA 手动执行」；
* **参数裁剪**：只把 handler 声明过的参数传进去。模型经常多带一个 ``db_type``
  之类的提示字段，直接透传会变成 TypeError，因此按签名裁剪；
* **进度回调**：只有声明了 ``progress_callback`` 的工具（模板巡检）才接收，
  用于把逐条检查的进度推到 SSE ``tool_progress``；
* **启停与自定义**：配置落在 ``data/ai_tools.json``（运行态数据，不入库），
  默认全开；自定义工具只有定义、没有 Python 实现，执行时返回明确提示而不是假成功。
"""
import inspect
import json
import os
import threading

from modules.core.paths import DATA_DIR

_CONFIG_PATH = str(DATA_DIR / 'ai_tools.json')
_CONFIG_LOCK = threading.Lock()

# name -> {name, description, parameters, handler, category, is_custom}
_TOOLS = {}
_loaded = False

READONLY_TOOLS = {
    # 数据源元数据（只读）
    'list_datasources', 'get_datasource_detail', 'test_connection',
    # 巡检：启动后台巡检（内部只跑只读模板 SQL）与结果查询
    'start_inspection', 'get_task_status', 'get_inspection_issues',
    # SQL：只读查询
    'execute_sql', 'query_connection_count', 'query_lock_waits',
    # 监控与仪表盘（只读采集数据）
    'get_slow_queries', 'get_connections', 'get_home_stats',
    # 报告 / 调度 / 基线（只读元数据）
    'list_reports', 'list_scheduler_jobs', 'list_baselines',
    # 巡检模板（元数据 + 模板检查 SQL 执行，均为只读）
    'list_inspection_templates', 'get_template_skills', 'run_template_check',
    # 版本与方言（只读探测）
    'get_datasource_versions', 'check_sql_dialect',
}

CATEGORIES = (
    '数据源管理', '巡检', 'SQL执行', '监控', '报告', '调度', '仪表盘',
    '基线管理', '巡检模板', '方言与版本', '自定义',
)


def register_tool(name, description, parameters, handler, category='自定义'):
    _TOOLS[name] = {
        'name': name,
        'description': description,
        'parameters': parameters or {'type': 'object', 'properties': {}},
        'handler': handler,
        'category': category,
        'is_custom': False,
    }


def registered_names():
    ensure_loaded()
    return set(_TOOLS)


# ══════════════════════════════════════════════════════════════
# 配置：启停 + 自定义工具定义
# ══════════════════════════════════════════════════════════════

def _load_config():
    if not os.path.isfile(_CONFIG_PATH):
        return {'tools': []}
    try:
        with _CONFIG_LOCK:
            with open(_CONFIG_PATH, 'r', encoding='utf-8') as handle:
                data = json.load(handle)
        return data if isinstance(data, dict) else {'tools': []}
    except Exception:
        return {'tools': []}


def save_config():
    """把当前注册表状态写盘（启停 + 自定义定义）。"""
    payload = {'_comment': 'AI 巡检助手工具配置：启停与自定义工具定义（运行态数据，不入库）',
               '_version': '1.0', 'tools': []}
    for name in sorted(_TOOLS):
        tool = _TOOLS[name]
        payload['tools'].append({
            'name': tool['name'],
            'description': tool.get('description', ''),
            'category': tool.get('category', '自定义'),
            'enabled': tool.get('enabled', True),
            'parameters': tool.get('parameters', {}),
            'is_custom': bool(tool.get('is_custom')),
        })
    try:
        os.makedirs(os.path.dirname(_CONFIG_PATH), exist_ok=True)
        with _CONFIG_LOCK:
            tmp_path = _CONFIG_PATH + '.tmp'
            with open(tmp_path, 'w', encoding='utf-8') as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
            os.replace(tmp_path, _CONFIG_PATH)
        return True
    except Exception:
        return False


def _stub_handler(name):
    """纯配置工具的占位实现：明确说明没有后端实现，不返回假数据。"""
    def stub(**kwargs):
        return {
            'config_only': True,
            'error': ('工具「%s」只有定义、没有对应的后端实现。'
                      '需要它取数的话，请在 modules/ai/tools/ 下注册 handler。' % name),
        }
    return stub


def apply_config():
    """把盘上的启停/自定义定义叠加到注册表（硬编码工具兜底）。"""
    for entry in _load_config().get('tools', []) or []:
        name = str((entry or {}).get('name') or '').strip()
        if not name:
            continue
        enabled = bool(entry.get('enabled', True))
        if name in _TOOLS:
            tool = _TOOLS[name]
            tool['enabled'] = enabled
            if entry.get('description') and not tool.get('is_custom'):
                tool['description'] = entry['description']
            if entry.get('parameters') and not tool.get('is_custom'):
                tool['parameters'] = entry['parameters']
            if entry.get('category'):
                tool['category'] = entry['category']
            continue
        _TOOLS[name] = {
            'name': name,
            'description': entry.get('description') or '',
            'parameters': entry.get('parameters') or {'type': 'object', 'properties': {}},
            'handler': _stub_handler(name),
            'category': entry.get('category') or '自定义',
            'enabled': enabled,
            'is_custom': True,
        }


# ══════════════════════════════════════════════════════════════
# 查询与执行
# ══════════════════════════════════════════════════════════════

def is_enabled(name):
    ensure_loaded()
    tool = _TOOLS.get(name)
    if tool is None:
        return False
    return tool.get('enabled', True) is not False


def set_enabled(name, enabled):
    ensure_loaded()
    if name not in _TOOLS:
        return None
    _TOOLS[name]['enabled'] = bool(enabled)
    save_config()
    return _TOOLS[name]['enabled']


def tool_names(include_disabled=False):
    ensure_loaded()
    if include_disabled:
        return sorted(_TOOLS)
    return sorted(name for name in _TOOLS if is_enabled(name))


def list_tools():
    """工具配置页要展示的完整结构。"""
    ensure_loaded()
    items = []
    for name in sorted(_TOOLS, key=lambda item: (_TOOLS[item].get('category', ''), item)):
        tool = _TOOLS[name]
        items.append({
            'name': name,
            'description': tool.get('description', ''),
            'parameters': tool.get('parameters', {}),
            'category': tool.get('category', '自定义'),
            'enabled': tool.get('enabled', True) is not False,
            'is_custom': bool(tool.get('is_custom')),
            'readonly': name in READONLY_TOOLS,
            'has_handler': bool(tool.get('handler')) and not tool.get('is_custom'),
        })
    return items


def categories():
    ensure_loaded()
    present = {tool.get('category', '自定义') for tool in _TOOLS.values()}
    ordered = [item for item in CATEGORIES if item in present]
    return ordered + sorted(present - set(ordered))


def schemas_for_prompt():
    """给 LLM 的工具清单文本（按分类分组，参数带必填标记与说明）。

    只列启用中的工具，禁用即从模型的视野里消失。
    """
    ensure_loaded()
    lines = []
    current_category = ''
    for name in sorted(_TOOLS, key=lambda item: (_TOOLS[item].get('category', ''), item)):
        tool = _TOOLS[name]
        if not is_enabled(name):
            continue
        category = tool.get('category', '自定义')
        if category != current_category:
            current_category = category
            lines.append('\n## %s' % category)
        lines.append('- %s: %s' % (name, tool.get('description', '')))
        parameters = tool.get('parameters') or {}
        properties = parameters.get('properties') or {}
        if properties:
            required = parameters.get('required') or []
            for parameter, info in properties.items():
                mark = '必填' if parameter in required else '可选'
                lines.append('  - %s (%s, %s): %s' % (
                    parameter, info.get('type', 'string'), mark, info.get('description', '')))
    return '\n'.join(lines).strip()


def tool_catalog():
    """结构化目录（前端工具配置、MCP/审计都用它）。"""
    ensure_loaded()
    return [{'name': name, 'description': _TOOLS[name].get('description', ''),
             'category': _TOOLS[name].get('category', '自定义')} for name in tool_names()]


def execute_tool(tool_name, progress_callback=None, **arguments):
    """执行一个工具，返回 ``{success, tool, result}`` 或 ``{success:False, ...}``。

    第一个形参刻意叫 ``tool_name`` 而不是 ``name``：工具自身的参数里就有 ``name``
    （``get_datasource_detail(name=…)``），同名会在 ``**arguments`` 展开时撞车。

    返回值形状是助手与前端渲染步骤卡的契约，保持稳定；两点内部约定：
    数据源可见性在各工具内部按当前登录身份过滤；未注册工具不抛异常而是返回错误。
    """
    ensure_loaded()
    tool = _TOOLS.get(tool_name)
    if not tool:
        return {'success': False, 'tool': tool_name, 'error': '工具「%s」不存在' % tool_name}
    if not is_enabled(tool_name):
        return {'success': False, 'tool': tool_name, 'disabled': True,
                'error': '工具「%s」当前被禁用，可在「工具配置」里开启' % tool_name}
    if tool_name not in READONLY_TOOLS:
        return {'success': False, 'tool': tool_name, 'readonly_blocked': True,
                'error': ('工具「%s」属于操作类工具：AI 巡检助手只允许执行只读查询，'
                          '该操作请由 DBA 在系统中手动确认后执行。' % tool_name)}
    handler = tool['handler']
    try:
        signature_parameters = inspect.signature(handler).parameters
    except (TypeError, ValueError):
        signature_parameters = None
    if (signature_parameters is not None
            and not any(item.kind == inspect.Parameter.VAR_KEYWORD
                        for item in signature_parameters.values())):
        arguments = {key: value for key, value in arguments.items() if key in signature_parameters}
    try:
        if progress_callback is not None and signature_parameters is not None \
                and 'progress_callback' in signature_parameters:
            result = handler(progress_callback=progress_callback, **arguments)
        else:
            result = handler(**arguments)
    except Exception as failure:
        import traceback
        return {'success': False, 'tool': tool_name, 'error': str(failure),
                'traceback': traceback.format_exc()[-500:]}
    if isinstance(result, dict) and result.get('error'):
        return {'success': False, 'tool': tool_name, 'result': result, 'error': result['error']}
    return {'success': True, 'tool': tool_name, 'result': result}


def run_tool(name, arguments=None):
    """助手内部使用的简化入口：直接返回结果 dict（不带 success 包装）。"""
    envelope = execute_tool(name, **(arguments or {}))
    if envelope.get('success'):
        result = envelope.get('result')
        return result if isinstance(result, dict) else {'value': result}
    return {'ok': False, 'error': envelope.get('error') or '工具执行失败',
            'readonly_blocked': bool(envelope.get('readonly_blocked'))}


# ══════════════════════════════════════════════════════════════
# 自定义工具 CRUD（与 /api/tools 的请求形状对应）
# ══════════════════════════════════════════════════════════════

_NAME_PATTERN = __import__('re').compile(r'^[a-z][a-z0-9_]{1,62}$')


def add_custom_tool(name, description, parameters=None, category='自定义', enabled=True):
    ensure_loaded()
    identifier = str(name or '').strip().lower()
    if not _NAME_PATTERN.match(identifier):
        raise ValueError('工具名需为小写字母开头的标识符（字母/数字/下划线，2-63 位）')
    if identifier in _TOOLS:
        raise ValueError('工具「%s」已存在' % identifier)
    _TOOLS[identifier] = {
        'name': identifier,
        'description': str(description or '').strip(),
        'parameters': parameters or {'type': 'object', 'properties': {}},
        'handler': _stub_handler(identifier),
        'category': category or '自定义',
        'enabled': bool(enabled),
        'is_custom': True,
    }
    save_config()
    return identifier


def update_tool(name, **changes):
    ensure_loaded()
    tool = _TOOLS.get(name)
    if not tool:
        return False
    for field in ('description', 'parameters', 'category'):
        if field in changes and changes[field] is not None:
            tool[field] = changes[field]
    if 'enabled' in changes:
        tool['enabled'] = bool(changes['enabled'])
    save_config()
    return True


def delete_tool(name):
    ensure_loaded()
    tool = _TOOLS.get(name)
    if not tool:
        return False
    if not tool.get('is_custom'):
        raise ValueError('内置工具不支持删除，可将其停用')
    _TOOLS.pop(name, None)
    save_config()
    return True


def ensure_loaded():
    """幂等加载：注册内置工具 + 叠加盘上配置（启停与自定义定义）。"""
    global _loaded
    if _loaded:
        return _TOOLS
    _loaded = True
    from modules.ai.tools import register_builtin_tools
    register_builtin_tools(register_tool)
    apply_config()
    return _TOOLS
