# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · 巡检模板类工具（模板列表 / 技能点 / 按模板执行检查）。

归属说明：巡检模板类工具的语义设计归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) 所有。执行一律走只读链路：

* 模板检查 SQL 先过 ``sql_safety`` 分类，非只读一律跳过（模板被人改成写操作时
  助手不会替人执行）；
* 单次最多执行 30 条检查、每条最多 50 行，避免一次对话拖回整库数据；
* ``progress_callback`` 逐条回调，由对话流转成 SSE ``tool_progress`` 给前端进度条。
"""
import time

from modules.ai import datasource_access as ds_access
from modules.ai import sql_safety

MAX_CHECKS = 30
MAX_ROWS_PER_CHECK = 50
_SKIP_KEYWORDS = ('DROP', 'TRUNCATE', 'DELETE FROM', 'SHUTDOWN', 'ALTER SYSTEM', 'GRANT',
                  'REVOKE')

_DB_TYPE_ALIASES = {'pg': 'postgresql', 'dm': 'dm8'}


def _map_db_type(db_type):
    text = str(db_type or '').strip().lower()
    return _DB_TYPE_ALIASES.get(text, text)


def tool_list_inspection_templates(db_type=''):
    """列出巡检模板（可按数据库类型过滤）。"""
    from modules.inspection import dal
    if db_type:
        templates = dal.get_templates_by_db_type(_map_db_type(db_type)) or []
    else:
        templates = dal.get_all_templates() or []
    rows = []
    for item in templates:
        rows.append({
            'id': item.get('id'),
            'name': item.get('template_name') or item.get('name') or '',
            'db_type': item.get('db_type') or '',
            'version': item.get('version') or 'v1',
            'is_default': bool(item.get('is_default') or 0),
            'is_preset': bool(item.get('is_preset') or 0),
            'chapter_count': item.get('chapter_count'),
            'query_count': item.get('query_count'),
            'description': item.get('description') or '',
        })
    return {'total': len(rows), 'templates': rows}


def tool_get_template_skills(template_id=None):
    """取指定模板的检查技能点（章节 + SQL）。"""
    if not template_id:
        return {'error': '缺少 template_id'}
    from modules.inspection import dal
    template = dal.get_template(int(template_id))
    if not template:
        return {'error': '模板 %s 不存在' % template_id}
    skills = []
    total_queries = 0
    for chapter in (dal.get_chapters_by_template(int(template_id)) or []):
        if not chapter.get('enabled', 1):
            continue
        queries = []
        for query in (dal.get_queries_by_chapter(chapter['id']) or []):
            if not query.get('enabled', 1):
                continue
            queries.append({
                'id': query.get('id'),
                'key': query.get('query_key') or '',
                'sql': query.get('query_sql') or '',
                'description': query.get('query_description_zh') or '',
            })
        skills.append({
            'chapter_id': chapter.get('id'),
            'chapter_number': chapter.get('chapter_number'),
            'chapter_title': chapter.get('chapter_title_zh') or '',
            'description': chapter.get('description') or '',
            'query_count': len(queries),
            'queries': queries,
        })
        total_queries += len(queries)
    return {
        'template_id': template_id,
        'template_name': template.get('template_name') or '',
        'db_type': template.get('db_type') or '',
        'total_chapters': len(skills),
        'total_queries': total_queries,
        'skills': skills,
    }


def _collect_checks(dal, template_id, chapter_id=None, query_key=None):
    checks = []
    chapters = dal.get_chapters_by_template(int(template_id)) or []
    if chapter_id:
        target_chapters = [item for item in chapters if item.get('id') == int(chapter_id)]
    else:
        target_chapters = [item for item in chapters if item.get('enabled', 1)]
    for chapter in target_chapters:
        for query in (dal.get_queries_by_chapter(chapter['id']) or []):
            if not query.get('enabled', 1):
                continue
            if query_key and query.get('query_key') != query_key:
                continue
            checks.append({
                'chapter': chapter.get('chapter_title_zh') or '',
                'query_key': query.get('query_key') or '',
                'sql': query.get('query_sql') or '',
                'description': query.get('query_description_zh') or '',
            })
    return checks


def tool_run_template_check(datasource_name='', template_id=None, chapter_id=None,
                            query_key=None, progress_callback=None):
    """在数据源上执行模板预定义的检查 SQL（只读），逐条回调进度。"""
    if not template_id:
        return {'error': '缺少 template_id'}
    record, status = ds_access.find_datasource(datasource_name)
    if status != 'exact' or not record:
        return {'error': '未找到数据源「%s」' % datasource_name}
    from modules.inspection import dal
    template = dal.get_template(int(template_id))
    if not template:
        return {'error': '模板 %s 不存在' % template_id}
    checks = _collect_checks(dal, template_id, chapter_id=chapter_id, query_key=query_key)
    if not checks:
        return {'error': '未找到匹配的检查项（可能已被禁用）'}

    instance = ds_access.load_decrypted(record)
    results = []
    total = min(len(checks), MAX_CHECKS)
    for index, check in enumerate(checks[:MAX_CHECKS], 1):
        sql = sql_safety.sanitize_sql(check['sql'])
        upper = sql.upper()
        if any(keyword in upper for keyword in _SKIP_KEYWORDS) or \
                sql_safety.classify(sql, record['db_type']) != 'read':
            entry = {**check, 'status': 'skipped', 'reason': '非只读语句，助手不执行'}
            results.append(entry)
            _notify(progress_callback, index, total, check, 'skipped')
            continue
        started_at = time.time()
        try:
            columns, rows, truncated = ds_access.query_rows(instance, sql, '',
                                                            max_rows=MAX_ROWS_PER_CHECK)
            entry = {**check, 'status': 'success', 'columns': columns, 'rows': rows,
                     'row_count': len(rows), 'truncated': truncated,
                     'elapsed_ms': int((time.time() - started_at) * 1000)}
        except Exception as failure:
            entry = {**check, 'status': 'error', 'error': str(failure)}
        results.append(entry)
        _notify(progress_callback, index, total, check, entry['status'])
    succeeded = sum(1 for item in results if item.get('status') == 'success')
    failed = sum(1 for item in results if item.get('status') == 'error')
    return {
        'datasource': record['name'],
        'template_id': template_id,
        'template_name': template.get('template_name') or '',
        'total_checks': len(results),
        'executed': total,
        'succeeded': succeeded,
        'failed': failed,
        'truncated_by_limit': len(checks) > MAX_CHECKS,
        'results': results,
    }


def _notify(progress_callback, step, total, check, status):
    if progress_callback is None:
        return
    try:
        progress_callback({'step': step, 'total': total,
                           'chapter': check.get('chapter') or '',
                           'query_key': check.get('query_key') or '',
                           'description': check.get('description') or '',
                           'status': status})
    except Exception:
        pass
