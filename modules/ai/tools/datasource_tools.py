# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · 数据源类工具。

归属说明：数据源类工具的语义设计归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) 所有。清单与详情都过可见性过滤，
连通性测试复用编辑器那条建连链路（含 ``*_jdbc`` 插件路径），
不另写一套驱动分支。
"""
import time

from modules.ai import datasource_access as ds_access

_PROBE_SQL_BY_FAMILY = {
    'oracle': 'SELECT 1 AS ok FROM dual',
    'dm': 'SELECT 1 AS ok FROM dual',
    'yashandb': 'SELECT 1 AS ok FROM dual',
    'sqlserver': 'SELECT 1 AS ok',
    'mysql': 'SELECT 1 AS ok',
    'postgresql': 'SELECT 1 AS ok',
    'generic': 'SELECT 1',
}


def ds_family(db_type):
    """方言家族（与版本探测模块同一口径，决定用哪条探活 SQL）。"""
    from modules.ai import datasource_versions
    return datasource_versions.normalize_family(db_type)


def tool_list_datasources(db_type='', dir_path='', label=''):
    """列出当前用户可见的数据源，可按类型 / 目录（含下级）/ 业务标签过滤。"""
    sources = ds_access.visible_datasources()
    rows = []
    for item in sources:
        if db_type and str(db_type).lower() not in ('all', ''):
            if ds_access._normalize_type_for_match(item['db_type']) != \
                    ds_access._normalize_type_for_match(db_type):
                continue
        if dir_path:
            path = item['dir_path'] or '未分配'
            if dir_path.strip('/') not in path.strip('/'):
                continue
        if label and label not in (item.get('labels') or []):
            continue
        rows.append({
            'name': item['name'],
            'id': item['id'],
            'db_type': item['db_type'],
            'host': item['host'],
            'port': item['port'],
            'dir_path': item['dir_path'],
            'labels': item['labels'],
            'status': 'disabled' if item.get('enabled') is False else 'enabled',
        })
    return {'total': len(rows), 'datasources': rows}


def tool_get_datasource_detail(name=''):
    """取某个数据源的详细信息（密码永不出现在返回值里）。"""
    record, status = ds_access.find_datasource(name)
    if status != 'exact' or not record:
        return {'error': '未找到数据源「%s」%s' % (
            name, '（存在多个同名/相近数据源，请先指定完整名称）' if status == 'ambiguous' else '')}
    detail = dict(record)
    detail.pop('enabled', None)
    from modules.ai import datasource_versions
    version_info = datasource_versions.get_version(record)
    detail['version'] = version_info.get('version') or ''
    detail['version_source'] = version_info.get('source') or ''
    detail['nodes'] = []
    try:
        from modules.pro import get_instance_manager
        nodes = get_instance_manager().get_nodes(record['id']) if hasattr(
            get_instance_manager(), 'get_nodes') else []
        detail['nodes'] = [{'host': node.get('host'), 'port': node.get('port'),
                            'role': node.get('role') or ''} for node in (nodes or [])]
    except Exception:
        pass
    return {'name': record['name'], 'datasource': detail}


def tool_test_connection(datasource_name='', host='', port=0, user='', password='',
                         db_type='', service_name='', sid='', database=''):
    """连通性测试：优先按已保存的数据源测（推荐），也支持临时参数直连。"""
    started_at = time.time()
    if datasource_name:
        record, status = ds_access.find_datasource(datasource_name)
        if status != 'exact' or not record:
            return {'connected': False,
                    'message': '未找到数据源「%s」' % datasource_name}
        instance = ds_access.load_decrypted(record)
        probe_sql = _PROBE_SQL_BY_FAMILY.get(
            ds_family(instance.get('db_type')), _PROBE_SQL_BY_FAMILY['generic'])
        try:
            ds_access.query_rows(instance, probe_sql, instance.get('database') or '', max_rows=1)
            return {'connected': True, 'datasource': record['name'],
                    'db_type': instance.get('db_type') or '',
                    'elapsed_ms': int((time.time() - started_at) * 1000),
                    'message': '连接正常'}
        except Exception as failure:
            return {'connected': False, 'datasource': record['name'],
                    'error': str(failure),
                    'message': '连接失败：%s' % failure}
    if not host:
        return {'connected': False, 'message': '请提供 datasource_name，或提供 host/port/user/password/db_type'}
    # 临时参数直连：走同一条建连链路，但密码只在这次调用内使用，不落库、不回显
    probe_instance = {
        'db_type': db_type or 'mysql', 'host': host, 'port': port, 'user': user,
        'password': password, 'database': database or '',
        'service_name': service_name or sid or '', 'name': '%s@%s' % (user or '?', host),
    }
    probe_sql = _PROBE_SQL_BY_FAMILY.get(
        ds_family(probe_instance['db_type']), _PROBE_SQL_BY_FAMILY['generic'])
    try:
        ds_access.query_rows(probe_instance, probe_sql, database, max_rows=1)
        return {'connected': True, 'host': host, 'port': port, 'db_type': db_type,
                'elapsed_ms': int((time.time() - started_at) * 1000), 'message': '连接正常'}
    except Exception as failure:
        return {'connected': False, 'host': host, 'port': port, 'db_type': db_type,
                'error': str(failure), 'message': '连接失败：%s' % failure}
