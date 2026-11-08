# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · 监控类工具（慢查询 / 连接池）。

归属说明：监控类工具的语义设计归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) 所有。数据来自实时监控引擎的采集结果，
不是现场建连（现场建连走 ``query_connection_count``）。
"""


def _monitor_engine():
    from modules.monitor.engine import get_monitor_engine
    return get_monitor_engine()


def _rows_to_list(payload, limit=20):
    """监控引擎返回的是 {数据源标识: [...] 或 {...}} 的字典，统一压成可分析的列表。"""
    rows = []
    if isinstance(payload, dict):
        for key, value in payload.items():
            if isinstance(value, dict):
                rows.append({'datasource': key, **value})
            elif isinstance(value, (list, tuple)):
                for item in value[:limit]:
                    if isinstance(item, dict):
                        rows.append({'datasource': key, **item})
                    else:
                        rows.append({'datasource': key, 'value': str(item)})
            else:
                rows.append({'datasource': key, 'value': str(value)})
    elif isinstance(payload, (list, tuple)):
        rows = list(payload)
    return rows


def tool_get_slow_queries(datasource_name=''):
    """读实时监控采集到的慢查询；可按时别的数据源名过滤。"""
    engine = _monitor_engine()
    if not engine:
        return {'error': '监控引擎未启动，无法读取慢查询。可在「实时监控」页开启后重试。'}
    payload = engine.get_slow_queries() or {}
    rows = _rows_to_list(payload)
    if datasource_name:
        needle = str(datasource_name).lower()
        rows = [row for row in rows
                if needle in str(row.get('datasource') or '').lower()
                or needle in str(row.get('name') or '').lower()]
    status = {}
    try:
        status = engine.get_status() or {}
    except Exception:
        pass
    return {'count': len(rows), 'slow_queries': rows[:40], 'monitor_status': status}


def tool_get_connections(datasource_name=''):
    """读实时监控采集到的连接数/会话指标。"""
    engine = _monitor_engine()
    if not engine:
        return {'error': '监控引擎未启动，无法读取连接数据。可在「实时监控」页开启后重试，'
                         '或直接使用 query_connection_count 实时建连查询。'}
    payload = engine.get_connections() or {}
    rows = _rows_to_list(payload)
    if datasource_name:
        needle = str(datasource_name).lower()
        rows = [row for row in rows
                if needle in str(row.get('datasource') or '').lower()
                or needle in str(row.get('name') or '').lower()]
    status = {}
    try:
        status = engine.get_status() or {}
    except Exception:
        pass
    return {'count': len(rows), 'connections': rows[:40], 'monitor_status': status}
