# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · 数据源访问与只读查询底座。

所有工具共用同一套底座，工具层不再各写一份：

1. **可见性**：一律先过 ``modules.access`` 的 ``filter_visible`` / ``assert_visible``，
   模型能看到的、能查询的都是当前用户有权的数据源；
2. **建连**：复用 SQL 编辑器的统一入口 ``_open_editor_conn``（覆盖 16+ 方言、
   ``*_jdbc`` 走插件、Oracle 厚模式回退），并沿用其只读闸与游标归一化；
3. **名称解析**：模型与用户说的是「名称」，本仓库的主键是「ID」，两种都收 ——
   先精确名称 → 再 ID → 再唯一子串命中，命中歧义时返回候选让助手走确认流程。
"""
import time


def visible_datasources():
    """当前用户可见的数据源清单（工具层与提示词技能缓存共用这一份口径）。"""
    from modules.access import filter_visible
    from modules.pro import get_instance_manager
    from modules.web.app import _sql_owner_principal
    rows = get_instance_manager().get_all_instances(mask_password=True)
    rows = filter_visible(_sql_owner_principal(), rows, 'instance')
    result = []
    for row in rows:
        labels = row.get('labels') if isinstance(row.get('labels'), list) else []
        if not labels:
            tags = row.get('tags')
            if isinstance(tags, list):
                labels = tags
            elif isinstance(tags, str) and tags:
                labels = [item.strip() for item in tags.split(',') if item.strip()]
        result.append({
            'id': str(row.get('id') or ''),
            'name': row.get('name') or '',
            'db_type': row.get('db_type') or '',
            'host': row.get('host') or '',
            'port': row.get('port'),
            'user': row.get('user') or '',
            'database': row.get('database') or '',
            'service_name': row.get('service_name') or row.get('sid') or '',
            'dir_path': row.get('dir_path') or '未分配',
            'labels': list(labels or []),
            'group': row.get('group') or '',
            'enabled': row.get('enabled', True),
        })
    return result


def _normalize_type_for_match(db_type):
    """把 db_type 归一到方言口径，供名称/类型匹配复用。"""
    text = str(db_type or '').strip().lower()
    for suffix in ('_jdbc',):
        text = text.replace(suffix, '')
    if text in ('postgres', 'pgsql'):
        return 'postgresql'
    if text in ('dm8',):
        return 'dm'
    if text == 'mssql':
        return 'sqlserver'
    if text == 'oracle_full':
        return 'oracle'
    return text


def find_datasource(name_or_id='', db_type=''):
    """按名称或 ID 定位一个可见数据源。

    返回 ``(记录 or None, 状态)``，状态是 ``exact`` / ``none`` / ``ambiguous``：
    歧义时第二个元素为 None，调用方（意图校验）拿候选列表去发起确认。
    """
    needle = str(name_or_id or '').strip()
    sources = visible_datasources()
    if db_type:
        wanted = _normalize_type_for_match(db_type)
        typed = [item for item in sources if _normalize_type_for_match(item['db_type']) == wanted]
        if typed:
            sources = typed
    if not needle:
        return None, 'none'
    lowered = needle.lower()
    exact = [item for item in sources
             if item['name'].lower() == lowered or item['id'] == needle]
    if len(exact) == 1:
        return exact[0], 'exact'
    if len(exact) > 1:
        return exact[0], 'exact'
    partial = [item for item in sources
               if lowered and (lowered in item['name'].lower() or item['name'].lower() in lowered)]
    if len(partial) == 1:
        return partial[0], 'exact'
    if len(partial) > 1:
        return None, 'ambiguous'
    return None, 'none'


def candidates_for(db_type=''):
    """确认卡里给用户的候选数据源（按类型过滤，类型不明时给全部可见的）。"""
    sources = visible_datasources()
    if not db_type:
        return sources
    wanted = _normalize_type_for_match(db_type)
    typed = [item for item in sources if _normalize_type_for_match(item['db_type']) == wanted]
    return typed or sources


def load_decrypted(datasource):
    """取解密后的连接参数（只在服务端内部使用，绝不返回给模型或前端）。"""
    from modules.pro import get_instance_manager
    identifier = str((datasource or {}).get('id') or '').strip()
    if not identifier:
        raise ValueError('缺少数据源标识')
    from modules.access import assert_visible
    from modules.web.app import _sql_owner_principal
    visible, _reason = assert_visible(_sql_owner_principal(), 'instance', identifier)
    if not visible:
        raise ValueError('数据源不存在或无权访问')
    instance = get_instance_manager().get_instance_decrypted(identifier)
    if not instance:
        raise ValueError('数据源不存在: %s' % identifier)
    return instance


def load_decrypted_by_name(name_or_id):
    """按名称/ID 取解密连接参数；找不到时抛可读错误。"""
    datasource, status = find_datasource(name_or_id)
    if status != 'exact' or not datasource:
        raise ValueError('未找到数据源「%s」%s' % (
            name_or_id, '（存在多个同名/相近数据源，请先选择）' if status == 'ambiguous' else ''))
    return load_decrypted(datasource)


def query_rows(instance, sql, database='', max_rows=200):
    """按 SQL 编辑器的只读链路执行一条查询，返回 (columns, rows, truncated)。

    与编辑器同源：只读闸 ``_assert_readonly_sql``、统一建连 ``_open_editor_conn``
    （含 ``*_jdbc`` 插件路径）、游标形态与 LOB/Java 对象归一化都在那里处理，
    助手不另造一套执行器。连接走**池化复用**，原因见 :func:`_pooled_connection`。
    """
    from modules.sqleditor.conn_pool import is_conn_error
    _assert_readonly_sql_lazy(sql)
    attempts = (1, 2)
    last_failure = None
    for attempt in attempts:
        connection, fetch_mode = _pooled_connection(instance, database)
        if connection is None:
            raise RuntimeError('无法连接该数据源')
        try:
            cells = _fetch_cells(connection, fetch_mode, sql, max_rows)
        except Exception as failure:
            broken = is_conn_error(str(failure))
            _retire_connection(connection, broken)
            if broken and attempt == attempts[0]:
                # 池里的连接大概率已被防火墙/NAT 掐断：换一条新建的再来一次（只读查询重试安全）
                last_failure = failure
                continue
            raise
        # ★ 成功也要交还连接，而且必须在 return 之前 —— 直接 `return _fetch_cells(...)`
        # 会让语句跑赢了但连接永远留在外面：池子恒空，下一次又新建，
        # 「接了池」和「没接池」实测同为 170~210ms（等于没接），还把目标库会话越积越多。
        _retire_connection(connection, False)
        return cells
    raise last_failure        # 重试后仍是连接类错误，原样抛给调用方


def _assert_readonly_sql_lazy(sql):
    """只读闸：与 SQL 编辑器同一个白名单，助手不放宽。"""
    from modules.web.app import _assert_readonly_sql
    _assert_readonly_sql(sql)


def _pooled_connection(instance, database=''):
    """经编辑器统一入口取一条**池化**连接（拿不到返回 ``(None, None)``）。

    为什么必须进池：助手一次点击常是 2~20 条语句，旧写法每条都 ``connect() → close()``，
    实测单条端到端 263ms 而语句本身只跑 14~22ms —— 九成时间花在建连上
    （oracle_jdbc 建连 260~1300ms，首次含 JVM 启动 3.5s），界面表现就是「点执行卡一下」。

    为什么这里能进池而 ``/api/execute_sql`` 不进：助手这条链路取完数就把游标和连接
    一起交还，不留服务端游标做翻页，不存在「翻页时连接被别的请求借走」的互相踩。
    """
    from modules.web.app import _open_editor_conn
    return _open_editor_conn(instance, instance.get('db_type', ''), database or '', pooled=True)


def _retire_connection(connection, broken):
    """交还连接；已坏的（连接级报错）不回池，直接关掉，避免下一个请求再踩一次。"""
    try:
        if broken and hasattr(connection, 'discard'):
            connection.discard()
        else:
            connection.close()
    except Exception:
        pass


def _fetch_cells(connection, fetch_mode, sql, max_rows):
    """执行并取数，返回 ``(columns, rows, truncated)``；游标在这里就关掉。"""
    from modules.sqleditor.metadata import json_safe_value
    from modules.web.app import _editor_cursor
    cursor = None
    try:
        cursor = _editor_cursor(connection, fetch_mode)
        cursor.execute(sql)
        columns = [json_safe_value(description[0]) for description in (cursor.description or [])]
        rows = cursor.fetchmany(max_rows + 1)
        truncated = len(rows) > max_rows
        rows = rows[:max_rows]
        data = []
        for row in rows:
            cells = [row.get(column) for column in columns] if isinstance(row, dict) else list(row)
            data.append([json_safe_value(cell) for cell in cells])
        return columns, data, truncated
    finally:
        try:
            if cursor is not None:
                cursor.close()
        except Exception:
            pass


def timed(handler):
    """给工具结果补耗时（毫秒），供前端步骤卡展示与任务历史回溯。"""
    def wrapper(arguments):
        started_at = time.time()
        result = handler(arguments or {})
        if isinstance(result, dict):
            result.setdefault('elapsed_ms', int((time.time() - started_at) * 1000))
        return result
    return wrapper
