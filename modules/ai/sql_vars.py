# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · 会话级 SQL 结果变量（``@rN``）。

归属说明：``@rN`` 结果变量的语义归 MIT License, Copyright (c) 2025-2026
fiyo (Jack Ge) 所有。助手在会话里每执行成功一条查询，就把它登记成
``@r1``、``@r2`` …，后续 SQL 可以直接引用：

* 单行单列 → 替换成标量；
* 多行单列 → 替换成逗号分隔列表（配 ``IN (...)`` 用）；
* 多列 → 取第一列。

进程内存储，重启即空——变量内容只是**结果片段**，不落库、不外发。
"""
import re
import threading

_lock = threading.Lock()
_store = {}
_MAX_STATEMENTS_PER_SESSION = 200

_VARIABLE_PATTERN = re.compile(r'@(r\d+)')


def remember(session_id, columns, rows, sql='', total=None):
    """登记一次查询结果，返回变量名（``rN``，按会话内顺序递增）。"""
    key = str(session_id or 'default')
    with _lock:
        bucket = _store.setdefault(key, {})
        index = 1
        while ('r%d' % index) in bucket:
            index += 1
        name = 'r%d' % index
        bucket[name] = {'columns': list(columns or []),
                        'rows': [list(row) for row in (rows or [])],
                        'total': int(total if total is not None else len(rows or [])),
                        'sql': str(sql or '')[:2000]}
        overflow = len(bucket) - _MAX_STATEMENTS_PER_SESSION
        for oldest in sorted(bucket, key=lambda item: int(item[1:]))[:max(0, overflow)]:
            bucket.pop(oldest, None)
    return name


def substitute(session_id, sql):
    """把 SQL 里的 ``@rN`` 换成前序结果。未定义的变量直接报错，不静默留空。"""
    bucket = _store.get(str(session_id or 'default'), {})

    def replace(match):
        name = match.group(1)
        entry = bucket.get(name)
        if entry is None:
            raise ValueError('变量 @%s 不存在，请先执行对应的 SQL 查询' % name)
        rows = entry.get('rows') or []
        if not rows:
            return 'NULL'
        values = [str(row[0]) for row in rows if row]
        if len(values) == 1:
            return values[0]
        return ', '.join(values)

    return _VARIABLE_PATTERN.sub(replace, sql or '')


def references(sql):
    """列出 SQL 里引用到的变量名（前端提示「本条将带入 @r1」用）。"""
    return sorted({match.group(1) for match in _VARIABLE_PATTERN.finditer(sql or '')})


def list_variables(session_id):
    bucket = _store.get(str(session_id or 'default'), {})
    return [{'name': '@' + name, 'total': entry.get('total', 0),
             'columns': entry.get('columns') or [], 'sql': entry.get('sql') or ''}
            for name, entry in sorted(bucket.items(), key=lambda item: int(item[0][1:]))]


def clear(session_id):
    with _lock:
        _store.pop(str(session_id or 'default'), None)
