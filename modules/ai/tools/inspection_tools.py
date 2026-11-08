# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · 巡检任务类工具。

归属说明：三条工具（启动巡检 / 查任务状态 / 查问题）的语义设计归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) 所有。链路上的三个约定：

* 启动巡检复用聊天巡检的统一分发 ``_start_chat_inspection_task``：它会写
  ``db_info['_db_type']`` 并把 JVM 类数据库隔离到子进程，直接调
  ``run_inspection_task`` 会让 HGDB/Oracle-JDBC 一类钉死主进程（历史事故）；
* 任务落库带 ``trigger_type='ai_assistant'``，巡检历史页可以按来源筛选，
  重启后仍能从历史库回读；
* ``scope`` 细分检查：非 ``all`` 时不启整轮巡检，直接跑一条
  对应的只读查询（连接数 / 锁等待 / 慢查询），秒级返回。
"""
import datetime
import threading
import uuid

from modules.ai import datasource_access as ds_access

_SCOPED_TOOLS = {
    'connection_count': 'query_connection_count',
    'lock_wait': 'query_lock_waits',
}


def _db_info_from_instance(instance, record):
    """把实例记录整形成巡检引擎要的 db_info（与聊天巡检完全同构）。"""
    db_type = str(record.get('db_type') or '').lower()
    info = {
        'host': instance.get('host', ''),
        'port': int(instance.get('port') or 0),
        'user': instance.get('user', ''),
        'password': instance.get('password') or '',
        'database': instance.get('database') or '',
        'service_name': instance.get('service_name') or instance.get('sid') or '',
        'sid': instance.get('sid') or '',
        'name': instance.get('name') or record.get('name') or '',
        '_db_type': db_type,
    }
    if db_type.endswith('_jdbc'):
        info.update({
            'jdbc_url': instance.get('jdbc_url') or '',
            'connection_mode': instance.get('connection_mode') or 'jdbc',
            'encrypt': bool(instance.get('encrypt')),
            'trust_server_certificate': bool(instance.get('trust_server_certificate', True)),
        })
    for key in ('db_name', 'instance_name', 'tenant', 'role', 'schema'):
        if instance.get(key):
            info[key] = instance[key]
    return info


def tool_start_inspection(datasource_name='', scope='all', template_id=None,
                          chapter_ids=None, inspector_name='', db_type=''):
    """启动一次巡检（后台执行，返回 task_id）。scope=all 走完整巡检，否则跑单点检查。"""
    record, status = ds_access.find_datasource(datasource_name, db_type=db_type)
    if status != 'exact' or not record:
        return {'error': '未找到数据源「%s」%s' % (
            datasource_name, '（存在多个同名/相近数据源，请指定完整名称）'
            if status == 'ambiguous' else '')}
    scope = str(scope or 'all').strip().lower()

    if scope in _SCOPED_TOOLS:
        from modules.ai import registry
        return registry.run_tool(_SCOPED_TOOLS[scope], {'datasource_name': record['name']})
    if scope == 'slow_queries':
        from modules.ai import registry
        return registry.run_tool('get_slow_queries', {'datasource_name': record['name']})

    instance = ds_access.load_decrypted(record)
    from modules.web.app import _start_chat_inspection_task, tasks

    task_id = uuid.uuid4().hex[:12]
    db_info = _db_info_from_instance(instance, record)
    tasks[task_id] = {
        'id': task_id,
        'db_type': db_info['_db_type'],
        'db_info': db_info,
        'inspector': inspector_name or 'AI 巡检助手',
        'status': 'running',
        'started_at': datetime.datetime.now().isoformat(),
        'trigger_type': 'ai_assistant',
        'datasource_id': record['id'],
        'datasource_name': record['name'],
        'log': [],
    }
    threading.Thread(
        target=_start_chat_inspection_task,
        args=(task_id, db_info['_db_type'], db_info, inspector_name or 'AI 巡检助手'),
        kwargs={'template_id': template_id or None,
                'chapter_ids': chapter_ids or None},
        daemon=True,
    ).start()
    return {
        'type': 'inspection_started',
        'task_id': task_id,
        'datasource': record['name'],
        'db_type': db_info['_db_type'],
        'host': record.get('host') or '',
        'port': record.get('port'),
        'template_id': template_id,
        'message': '已启动 %s 的巡检任务' % (record['name'] or db_info['_db_type']),
    }


def _task_snapshot(task_id, task):
    log = list(task.get('log') or [])
    context = task.get('context') or {}
    return {
        'id': task_id,
        'status': task.get('status') or 'unknown',
        'datasource': task.get('datasource_name') or (task.get('db_info') or {}).get('name') or '',
        'db_type': task.get('db_type') or (task.get('db_info') or {}).get('_db_type') or '',
        'current_step': task.get('current_step') or context.get('current_step') or '',
        'progress': task.get('progress') or context.get('progress'),
        'step_count': len(log),
        'log_tail': log[-8:],
        'started_at': task.get('started_at') or '',
        'finished_at': task.get('finished_at') or '',
        'error': task.get('error_msg') or task.get('error') or '',
        'report_file': task.get('report_file') or '',
        'report_name': task.get('report_name') or '',
        'health_score': task.get('health_score') or context.get('health_score'),
        'risk_count': task.get('risk_count') or context.get('risk_count'),
        'risk_level': task.get('risk_level') or context.get('risk_level'),
        'trigger_type': task.get('trigger_type') or '',
    }


def tool_get_task_status(task_id=''):
    """查巡检任务状态与最近日志（内存优先，历史库兜底）。"""
    if not task_id:
        return {'error': '缺少 task_id'}
    from modules.web.app import tasks
    task = tasks.get(task_id)
    if task:
        return {'task': _task_snapshot(task_id, task), 'source': 'memory'}
    restored = _restore_task_from_history(task_id)
    if restored:
        return {'task': restored, 'source': 'database', 'restored_from_db': True}
    return {'error': '任务不存在或已过期: %s' % task_id}


def _restore_task_from_history(task_id):
    """进程重启后按历史库回读一次巡检结果（内存任务态丢失时的兜底）。"""
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
    return {
        'id': task_id,
        'status': row.get('status') or 'done',
        'datasource': row.get('instance_name') or row.get('db_name') or '',
        'db_type': row.get('db_type') or '',
        'health_score': row.get('health_score'),
        'risk_count': row.get('risk_count'),
        'risk_level': row.get('risk_level'),
        'report_file': row.get('report_path') or '',
        'started_at': row.get('created_at') or row.get('inspection_time') or '',
        'trigger_type': row.get('trigger_type') or 'ai_assistant',
        'error': row.get('error_msg') or '',
        'log_tail': [],
    }


def _extract_issue_rows(payload):
    """把巡检结果里的「问题项」归一成 {level, category, description, fix_sql, recommendation}。"""
    items = []
    if isinstance(payload, dict):
        payload = payload.get('auto_analyze') or payload.get('issues') or \
            payload.get('findings') or payload.get('problems') or []
    if not isinstance(payload, list):
        return items
    for entry in payload:
        if not isinstance(entry, dict):
            items.append({'description': str(entry)})
            continue
        items.append({
            'level': entry.get('level') or entry.get('severity') or '',
            'category': entry.get('category') or entry.get('chapter') or '',
            'description': entry.get('description') or entry.get('title') or entry.get('msg') or '',
            'fix_sql': entry.get('fix_sql') or entry.get('sql') or '',
            'recommendation': entry.get('recommendation') or entry.get('advice') or '',
        })
    return items


def tool_get_inspection_issues(task_id='', limit=50):
    """取某次巡检发现的问题（含级别与修复建议 SQL，供 DBA 确认后再执行）。"""
    if not task_id:
        return {'error': '缺少 task_id'}
    from modules.web.app import tasks
    task = tasks.get(task_id)
    raw = None
    if task:
        raw = task.get('auto_analyze') or task.get('issues') or \
            (task.get('context') or {}).get('auto_analyze')
    if raw is None:
        restored = _restore_task_from_history(task_id)
        if restored:
            raw = restored.get('auto_analyze') or restored.get('issues')
    if raw is None and not task:
        return {'error': '任务不存在或已过期: %s' % task_id}
    issues = _extract_issue_rows(raw or [])
    try:
        cap = max(1, min(int(limit or 50), 200))
    except (TypeError, ValueError):
        cap = 50
    return {'task_id': task_id, 'count': len(issues), 'issues': issues[:cap]}
