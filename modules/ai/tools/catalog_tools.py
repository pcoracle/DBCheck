# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · 平台清单类工具（报告 / 定时任务 / 首页统计 / 基线 / 版本 / 方言预检）。

归属说明：报告 / 定时任务 / 首页统计 / 基线这几类工具的语义设计归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) 所有。数据来源约定：

* 报告清单直接复用 ``modules.web.app.get_reports()``（报告统计自带健康分与
  风险计数，比扫目录拿到的信息更全）；
* 定时任务走 ``SchedulerManager.list_jobs()``，不读裸 JSON；
* 首页统计的所有计数都按当前用户可见数据源重算，不输出全局口径。
"""
import os
import time


def tool_list_reports(datasource_name='', limit=10):
    """列出已生成的巡检报告（含健康分与风险计数）。"""
    from modules.web.app import get_reports
    payload = get_reports() or {}
    files = payload.get('files') or []
    if datasource_name:
        needle = str(datasource_name).lower()
        files = [item for item in files if needle in str(item.get('name') or '').lower()]
    try:
        cap = max(1, min(int(limit or 10), 100))
    except (TypeError, ValueError):
        cap = 10
    rows = []
    for item in files[:cap]:
        rows.append({
            'name': item.get('name'),
            'size': item.get('size'),
            'size_text': _human_size(item.get('size') or 0),
            'modified': time.strftime('%Y-%m-%d %H:%M:%S',
                                      time.localtime(item.get('mtime') or 0)),
            'db_type': item.get('db_type') or '',
            'health_score': item.get('health_score'),
            'risk_level': item.get('risk_level') or '',
            'risk_high': item.get('high', 0),
            'risk_mid': item.get('mid', 0),
            'risk_low': item.get('low', 0),
        })
    return {'count': len(rows), 'reports': rows,
            'download_hint': '报告可在「巡检报告」页下载，或用 /api/download_file?name= 直接取'}


def _human_size(total):
    try:
        value = float(total)
    except (TypeError, ValueError):
        return str(total)
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if value < 1024:
            return '%.1f%s' % (value, unit)
        value /= 1024
    return '%.1fPB' % value


def tool_list_scheduler_jobs():
    """列出定时巡检任务（只读，不含执行）。"""
    try:
        from modules.web.scheduler import get_scheduler
        jobs = get_scheduler().list_jobs() or []
    except Exception as failure:
        return {'error': '定时任务读取失败: %s' % failure}
    rows = []
    for job in jobs:
        if not isinstance(job, dict):
            continue
        rows.append({
            'id': job.get('id') or job.get('job_id') or '',
            'name': job.get('name') or job.get('instance_name') or job.get('host') or '',
            'db_type': job.get('db_type') or '',
            'host': job.get('host') or '',
            'enabled': job.get('enabled', True),
            'cron': job.get('cron') or job.get('cron_expression') or job.get('interval') or '',
            'last_run': job.get('last_run') or job.get('last_run_time') or '',
            'next_run': job.get('next_run') or job.get('next_run_time') or '',
            'notify': bool(job.get('notify_email') or job.get('notify_on_done')),
        })
    return {'count': len(rows), 'jobs': rows}


def tool_get_home_stats():
    """系统概览：数据源 / 报告 / 最近巡检健康分 / AI 任务量。"""
    from modules.ai import datasource_access as ds_access
    from modules.ai import task_store
    sources = ds_access.visible_datasources()
    by_type = {}
    for item in sources:
        key = item.get('db_type') or 'unknown'
        by_type[key] = by_type.get(key, 0) + 1
    report_count = 0
    latest = None
    try:
        from modules.web.app import get_reports
        files = (get_reports() or {}).get('files') or []
        report_count = len(files)
        if files:
            scored = [item for item in files if item.get('health_score') is not None]
            latest = scored[0] if scored else None
    except Exception:
        pass
    ai_stats = {}
    try:
        ai_stats = task_store.get_stats()
    except Exception:
        pass
    return {'stats': {
        'datasources': len(sources),
        'datasource_types': by_type,
        'reports': report_count,
        'latest_health_score': (latest or {}).get('health_score'),
        'latest_risk_level': (latest or {}).get('risk_level') or '',
        'ai_tasks_total': ai_stats.get('total', 0),
        'ai_tasks_today': ai_stats.get('today', 0),
        'ai_tasks_error': ai_stats.get('error', 0),
    }}


def tool_list_baselines(datasource_name='', db_type=''):
    """基线配置列表（阈值/期望值），可按数据源或类型过滤。"""
    from modules.inspection import dal
    wanted = str(db_type or '').strip()
    rows = []
    if wanted:
        rows = dal.get_baselines_by_db_type(wanted, enabled_only=False) or []
    else:
        getter = getattr(dal, 'get_all_baselines', None)
        if callable(getter):
            rows = getter() or []
        else:
            for candidate in ('oracle', 'mysql', 'postgresql', 'sqlserver', 'dm8'):
                rows.extend(dal.get_baselines_by_db_type(candidate, enabled_only=False) or [])
    if datasource_name:
        needle = str(datasource_name).lower()
        rows = [row for row in rows
                if needle in str(row.get('instance_name') or row.get('name') or '').lower()]
    cleaned = []
    for row in rows:
        item = dict(row or {})
        for key in ('password', 'passwd', 'user_password'):
            item.pop(key, None)
        cleaned.append(item)
    return {'count': len(cleaned), 'baselines': cleaned[:200]}


def tool_get_datasource_versions(db_type='', keyword=''):
    """数据源版本一览（全部实探，无需手工配置）。

    默认只读缓存/磁盘记忆并在后台补探，不阻塞对话；``datasource_name`` 由
    界面「重新探测」触发时走显式同步探测接口。
    """
    from modules.ai import datasource_access as ds_access
    from modules.ai import datasource_versions
    records = ds_access.visible_datasources()
    if db_type:
        records = [item for item in records
                   if ds_access._normalize_type_for_match(item['db_type']) ==
                   ds_access._normalize_type_for_match(db_type)]
    if keyword:
        needle = str(keyword).lower()
        records = [item for item in records
                   if needle in (item.get('name') or '').lower()
                   or needle in (item.get('host') or '').lower()]
    rows = datasource_versions.dialect_status(records)
    return {'count': len(rows),
            'summary': datasource_versions.summarize_status(rows),
            'datasources': rows}


def tool_check_sql_dialect(datasource_name='', sql=''):
    """按数据源真实版本对 SQL 做方言预检（返回违规项与可改写类型）。"""
    from modules.ai import datasource_access as ds_access
    from modules.ai import datasource_versions, dialect, sql_safety
    if not sql:
        return {'error': '缺少 sql'}
    record, status = ds_access.find_datasource(datasource_name)
    if status != 'exact' or not record:
        return {'error': '未找到数据源「%s」' % datasource_name}
    info = datasource_versions.get_version(record)
    version = info.get('version') or ''
    family, major, minor = dialect.parse_version(version, record.get('db_type') or '')
    violations = dialect.check_sql(sql, family, major, minor) if family else []
    kind = sql_safety.classify(sql, record.get('db_type'))
    return {
        'datasource': record['name'],
        'db_type': record.get('db_type') or '',
        'version': version,
        'version_source': info.get('source') or '',
        'family': family or '',
        'label': dialect.format_version_label(family, major, minor),
        'ambiguous': not bool(version),
        'sql_type': kind,
        'results': [{'violations': violations}],
    }
