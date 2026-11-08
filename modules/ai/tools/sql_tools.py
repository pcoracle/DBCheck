# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · SQL 类工具（只读执行 / 连接数 / 锁等待）。

归属说明：SQL 类工具的语义设计归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) 所有。执行链路的约定：

* 建连与取数走 SQL 编辑器同一入口（``datasource_access.query_rows``），
  只读闸、``*_jdbc`` 插件、LOB/Java 单元格归一化都只有一份实现；
* **先按真实版本做方言改写再执行**（不猜、不赌）：版本已确认时按规则命中
  做确定性改写；版本未知时只做「各版本都安全」的保守改写（``FETCH FIRST`` → ``ROWNUM``）；
* 多语句：全部预检通过才开始执行，逐条独立结果，第一条失败即停止，
  避免半套结果被模型当成完整数据；
* 「字段不存在」类报错会附带该表**真实存在的列**（repair 载荷），既给下一轮
  ``<query>`` 取数纠偏，也给前端「AI 修复」按钮当上下文。
"""
import difflib
import re

from modules.ai import datasource_access as ds_access
from modules.ai import datasource_versions
from modules.ai import dialect
from modules.ai import sql_safety

DEFAULT_MAX_ROWS = 100      # 多轮取数等模型侧调用的默认行数
MAX_MAX_ROWS = 5000         # 前端「行数上限」控件硬上限
MAX_STATEMENTS = 20         # 一次最多执行的语句数
_WRITE_ERROR_PATTERNS = [
    r'ORA-00904', r'ORA-00942', r'unknown column', r'no such column',
    r'列.*不存在', r'字段.*不存在', r'无效.*列', r'invalid column',
    r'invalid identifier', r'关系.*不存在', r'relation .* does not exist',
    r'does not exist', r'未找到.*表', r'object name is invalid',
]

CONNECTION_COUNT_SQL = {
    'oracle': ['SELECT COUNT(*) AS session_count FROM v$session',
               'SELECT COUNT(*) AS session_count FROM gv$session'],
    'dm': ['SELECT COUNT(*) AS session_count FROM v$sessions'],
    'yashandb': ['SELECT COUNT(*) AS session_count FROM v$session'],
    'mysql': ['SELECT COUNT(*) AS session_count FROM information_schema.PROCESSLIST'],
    'postgresql': ["SELECT COUNT(*) AS session_count FROM pg_stat_activity "
                   "WHERE datname IS NOT NULL"],
    'sqlserver': ['SELECT COUNT(*) AS session_count FROM sys.dm_exec_sessions '
                  'WHERE is_user_process = 1'],
    'clickhouse': ['SELECT COUNT(*) AS session_count FROM system.processes'],
}

LOCK_WAIT_SQL = {
    'oracle': ['SELECT sid, serial#, username, blocking_session, final_blocking_session, '
               'event, seconds_in_wait FROM v$session WHERE blocking_session IS NOT NULL '
               'ORDER BY seconds_in_wait DESC'],
    'mysql': ['SELECT r.trx_id AS waiting_trx, r.trx_mysql_thread_id AS waiting_thread, '
              'r.trx_query AS waiting_query, b.trx_mysql_thread_id AS blocking_thread, '
              'b.trx_query AS blocking_query FROM performance_schema.data_lock_waits w '
              'JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_engine_transaction_id '
              'JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_engine_transaction_id',
              'SELECT r.trx_id AS waiting_trx, r.trx_mysql_thread_id AS waiting_thread, '
              'r.trx_query AS waiting_query, b.trx_mysql_thread_id AS blocking_thread, '
              'b.trx_query AS blocking_query FROM information_schema.innodb_lock_waits w '
              'JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_trx_id '
              'JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_trx_id'],
    'postgresql': ['SELECT blocked.pid AS blocked_pid, blocked.usename AS blocked_user, '
                   'blocking.pid AS blocking_pid, blocking.usename AS blocking_user, '
                   'blocked.query AS blocked_query FROM pg_stat_activity blocked '
                   'JOIN pg_locks bl ON bl.pid = blocked.pid AND NOT bl.granted '
                   'JOIN pg_locks gl ON gl.locktype = bl.locktype AND gl.database IS NOT DISTINCT '
                   'FROM bl.database AND gl.relation IS NOT DISTINCT FROM bl.relation '
                   'AND gl.pid <> bl.pid AND gl.granted '
                   'JOIN pg_stat_activity blocking ON blocking.pid = gl.pid'],
    'sqlserver': ['SELECT r.session_id, r.blocking_session, r.wait_type, r.wait_time, '
                  'CAST(st.text AS VARCHAR(4000)) AS sql_text FROM sys.dm_exec_requests r '
                  'CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) st '
                  'WHERE r.blocking_session <> 0'],
}


def rewrite_for_dialect(instance, sql):
    """按数据源真实版本做方言兼容改写。返回 (sql, changed, note)。"""
    if not sql or not sql.strip():
        return sql, False, None
    db_type = instance.get('db_type') or ''
    family = datasource_versions.normalize_family(db_type)
    if family in ('generic',):
        return sql, False, None
    info = datasource_versions.get_version({'name': instance.get('name', ''),
                                            'db_type': db_type,
                                            'id': instance.get('id', ''),
                                            'host': instance.get('host', ''),
                                            'port': instance.get('port', '')})
    version = info.get('version') or ''
    family, major, minor = dialect.parse_version(version, db_type)
    rewritten = sql
    note = None
    if family and major is not None:
        for violation in dialect.check_sql(rewritten, family, major, minor):
            kind = violation.get('rewrite')
            if not kind:
                continue
            candidate = dialect.rewrite_sql(rewritten, kind)
            if candidate != rewritten:
                rewritten = candidate
                note = '已按 %s 自动改写：%s' % (
                    dialect.format_version_label(family, major, minor), violation.get('msg'))
    elif family == 'oracle' and re.search(
            r'\bFETCH\s+(?:FIRST|NEXT)\s+\d+\s+ROWS?\s+ONLY\b',
            dialect._mask_literals(rewritten), re.I):
        # 版本未知：只做「各版本都合法」的保守降级 —— ROWNUM 在 Oracle 全系可用
        can_rewrite, _rows = dialect.can_rewrite_rownum_wrap(rewritten)
        if can_rewrite:
            candidate = dialect.rewrite_rownum_wrap(rewritten)
            if candidate != rewritten:
                rewritten = candidate
                note = '版本未知，已将 `FETCH FIRST` 保守改写为 `ROWNUM` 子查询'
    return rewritten, rewritten != sql, note


def referenced_tables(sql, limit=8):
    """从语句里粗粒度提取被引用的表名（用于「字段不存在」时拉真实列）。"""
    masked = dialect._mask_literals(sql or '')
    names = re.findall(
        r'\b(?:FROM|JOIN|UPDATE|INTO)\s+([A-Za-z_][\w$#.]{1,120})', masked, re.I)
    cleaned = []
    for name in names:
        token = name.strip().split(',')[0].strip('()').strip()
        if token and token.upper() not in ('SELECT', 'DUAL', 'VALUES') and token not in cleaned:
            cleaned.append(token)
    return cleaned[:limit]


def build_column_repair(instance, sql, error_text):
    """「列/表不存在」报错 → 拉真实列 + 模糊建议，返回 repair 载荷或 None。

    execute_sql 与 fix-sql 两条链路复用同一份载荷：模型拿到真实列名后
    不会再重复编造同一个字段，前端「AI 修复」按钮也直接带上它做提示词上下文。
    """
    if not error_text:
        return None
    lowered = str(error_text).lower()
    if not any(re.search(pattern, lowered, re.I) for pattern in _WRITE_ERROR_PATTERNS):
        return None
    bad_column = None
    matched = re.search(r'(?:invalid identifier|unknown column|no such column)'
                        r'[:"\s]+([A-Za-z_][\w$]{0,60})', str(error_text), re.I)
    if not matched:
        matched = re.search(r'[「\'"]([A-Za-z_][\w$]{0,60})[\'"」].*(不存在|invalid)',
                            str(error_text), re.I)
    if matched:
        bad_column = matched.group(1)
    tables = referenced_tables(sql)
    if not tables:
        return None
    from modules.sqleditor.metadata import load_metadata
    from modules.web.app import _open_editor_conn

    def opener(db_info, db_type, database):
        return _open_editor_conn(db_info, db_type, database, pooled=True)

    payload = {'tables': [], 'bad_column': bad_column or ''}
    for table in tables:
        bare_name = table.split('.')[-1]
        schema = table.split('.')[0] if '.' in table else ''
        try:
            metadata = load_metadata(instance, instance.get('db_type'),
                                     schema or instance.get('database') or '',
                                     tables=[bare_name], conn_opener=opener)
        except Exception:
            continue
        columns = []
        for obj in (metadata or {}).get('objects') or []:
            columns.extend(obj.get('columns') or [])
        if not columns:
            continue
        entry = {'table': table, 'columns': columns[:300]}
        if bad_column:
            suggestions = difflib.get_close_matches(bad_column, columns, n=3, cutoff=0.5)
            if suggestions:
                entry['suggestion'] = {'table': table, 'suggested': suggestions[0],
                                       'candidates': suggestions}
                payload.setdefault('suggestions', []).append(entry['suggestion'])
        payload['tables'].append(entry)
    if not payload['tables']:
        return None
    payload['note'] = ('报错涉及的对象已取到真实列清单，'
                       '请只使用下列确实存在的列重写查询，不要编造字段名。')
    return payload


def _error_result(failure):
    return {'error': str(failure)}


def execute_statements(instance, statements, database='', max_rows=DEFAULT_MAX_ROWS):
    """逐条执行只读语句；第一条失败即停止，后续标 skipped。"""
    results = []
    for index, statement in enumerate(statements, 1):
        if not statement.strip():
            continue
        entry = {'index': index, 'sql': statement.strip()}
        try:
            columns, rows, truncated = ds_access.query_rows(instance, statement, database,
                                                             max_rows=max_rows)
            entry.update(ok=True, columns=columns, rows=rows, row_count=len(rows),
                         truncated=truncated)
        except Exception as failure:
            entry.update(ok=False, error=str(failure))
            results.append(entry)
            for follow_index in range(index + 1, len(statements) + 1):
                results.append({'index': follow_index, 'skipped': True,
                                'sql': statements[follow_index - 1].strip()})
            return results
        results.append(entry)
    return results


def tool_execute_sql(datasource_name='', sql='', max_rows=DEFAULT_MAX_ROWS, database=''):
    """在指定数据源上执行只读 SQL（多语句按顺序逐条执行，失败即止）。"""
    if not sql or not str(sql).strip():
        return {'error': '缺少 sql'}
    record, status = ds_access.find_datasource(datasource_name)
    if status != 'exact' or not record:
        return {'error': '未找到数据源「%s」%s' % (
            datasource_name, '（存在多个同名/相近数据源）' if status == 'ambiguous' else '')}
    instance = ds_access.load_decrypted(record)
    cleaned = sql_safety.sanitize_sql(sql)
    statements = sql_safety.split_statements(cleaned)
    if not statements:
        return {'error': '未解析出可执行语句'}
    if len(statements) > MAX_STATEMENTS:
        return {'error': '一次最多执行 %d 条语句（当前 %d 条）' % (MAX_STATEMENTS, len(statements))}
    # 全部预检：任何一条不是只读，整批拒绝（绝不「先跑一半」）
    for statement in statements:
        kind = sql_safety.classify(statement, instance.get('db_type'))
        if kind != 'read':
            return {'error': sql_safety.rejection_reason(kind), 'sql_type': kind,
                    'rejected_sql': statement[:400]}
    try:
        row_limit = max(1, min(int(max_rows or DEFAULT_MAX_ROWS), MAX_MAX_ROWS))
    except (TypeError, ValueError):
        row_limit = DEFAULT_MAX_ROWS

    rewritten_list = []
    rewrite_note = None
    for statement in statements:
        rewritten, changed, note = rewrite_for_dialect(instance, statement)
        rewritten_list.append(rewritten)
        if changed:
            rewrite_note = note
    results = execute_statements(instance, rewritten_list,
                                 database or instance.get('database') or '', row_limit)
    failed = [item for item in results if item.get('ok') is False]
    repair = None
    if failed:
        repair = build_column_repair(instance, failed[0].get('sql', ''),
                                     failed[0].get('error', ''))
    single = results[0] if len(results) == 1 else None
    payload = {
        'datasource': record['name'],
        'db_type': record['db_type'],
        'statement_count': len(results),
        'results': results,
    }
    if single and single.get('ok'):
        payload.update(columns=single.get('columns'), rows=single.get('rows'),
                       total=single.get('row_count'), truncated=single.get('truncated'))
        if rewrite_note:
            payload.update(rewritten=True, rewrite_note=rewrite_note, original_sql=statements[0])
    if rewrite_note and len(results) > 1:
        payload.update(rewritten=True, rewrite_note=rewrite_note, original_sql=statements[0])
    if failed:
        payload.update(error=failed[0].get('error'), db_error=True)
        if repair:
            payload['repair'] = repair
    return payload


def _run_first_available_sql(instance, candidates, max_rows=200):
    """按候选顺序执行，取第一条成功的结果（各方言/版本视图名不同，不预先猜）。"""
    last_error = ''
    for statement in candidates:
        try:
            columns, rows, _truncated = ds_access.query_rows(instance, statement, '',
                                                             max_rows=max_rows)
            return columns, rows, statement, ''
        except Exception as failure:
            last_error = str(failure)
    return None, None, None, last_error


def tool_query_connection_count(datasource_name=''):
    """直连数据源查当前会话/连接数（不依赖监控采集）。"""
    record, status = ds_access.find_datasource(datasource_name)
    if status != 'exact' or not record:
        return {'error': '未找到数据源「%s」' % datasource_name}
    instance = ds_access.load_decrypted(record)
    family = datasource_versions.normalize_family(record['db_type'])
    candidates = CONNECTION_COUNT_SQL.get(family)
    if not candidates:
        return {'error': '该数据库类型暂不支持直接查询连接数（%s）' % record['db_type']}
    _columns, rows, used_sql, last_error = _run_first_available_sql(instance, candidates, max_rows=1)
    if rows is None:
        return {'error': '查询连接数失败：%s' % last_error, 'datasource': record['name']}
    count = rows[0][0] if rows and rows[0] else None
    return {'datasource': record['name'], 'db_type': record['db_type'],
            'session_count': count, 'query': used_sql}


def tool_query_lock_waits(datasource_name='', limit=50):
    """直连数据源查当前锁等待 / 阻塞会话。"""
    record, status = ds_access.find_datasource(datasource_name)
    if status != 'exact' or not record:
        return {'error': '未找到数据源「%s」' % datasource_name}
    instance = ds_access.load_decrypted(record)
    family = datasource_versions.normalize_family(record['db_type'])
    candidates = LOCK_WAIT_SQL.get(family)
    if not candidates:
        return {'error': '该数据库类型暂不支持直接查询锁等待（%s）' % record['db_type']}
    try:
        row_limit = max(1, min(int(limit or 50), 500))
    except (TypeError, ValueError):
        row_limit = 50
    columns, rows, used_sql, last_error = _run_first_available_sql(instance, candidates,
                                                                   max_rows=row_limit)
    if rows is None:
        return {'error': '查询锁等待失败：%s' % last_error, 'datasource': record['name']}
    return {'datasource': record['name'], 'db_type': record['db_type'],
            'count': len(rows), 'columns': columns, 'rows': rows, 'query': used_sql}
