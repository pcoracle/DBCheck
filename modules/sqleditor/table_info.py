# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""SQL 编辑器右键「查看表属性」用的表/视图元信息（字段、索引、行数、大小、注释）。

查询分支移植自 DBCheck v2.6 的 ``api/pro.py`` 表属性接口（MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>），改动点：

1. 不再自己建连：连接由上层用 ``_open_editor_conn`` 取到后传入，
   本模块只负责「怎么查」，与 :mod:`modules.sqleditor.metadata` 共用同一套方言族名；
2. 每个子查询各自 try/except：字典视图在各版本之间的字段差异很大，
   某一项查不到只记进 ``errors``，其余信息照常返回（页面上显示「—」）；
3. 未覆盖的方言返回 ``supported=False``，前端提示"该类型暂不支持查看表属性"。
"""
from modules.sqleditor.metadata import (MYSQL_FAMILY, PG_FAMILY, adapt_cursor,
                                     json_safe_value, normalize_db_type)

OWNER_FAMILY = ('oracle', 'dm', 'yashandb')


def _split_qualified(table, default_schema):
    """`schema.table` → (schema, table)；没带前缀时用方言默认（PG=public，SQL Server=dbo）。"""
    t = (table or '').strip()
    if '.' in t:
        a, bodyText = t.split('.', 1)
        if a.strip() and bodyText.strip():
            return a.strip(), bodyText.strip()
    return default_schema, t


def _add_err(result, step, failure):
    result['errors'].append('%s: %s' % (step, failure))


def _close(cursor):
    try:
        if cursor is not None:
            cursor.close()
    except Exception:
        pass


def _columns_from(rows):
    """统一把 (position, name, type, nullable, key, default, comment) 七元组转成 dict 列表。"""
    out = []
    for c in rows:
        out.append({
            'position': c[0], 'name': c[1], 'type': c[2],
            'nullable': bool(c[3]), 'key': c[4] or '',
            'default': c[5], 'comment': c[6] or '',
        })
    return out


# ══════════════════════════════════════════════════════════════
#  MySQL / TiDB / OceanBase / MariaDB / TDSQL-C
# ══════════════════════════════════════════════════════════════

def _mysql_like(cursor, result, database, table):
    try:
        cursor.execute(
            "SELECT TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, TABLE_COMMENT, ENGINE "
            "FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s",
            (database, table)
        )
        row = cursor.fetchone()
        if row:
            result['row_count'] = row[0]
            result['table_size'] = int(row[1] or 0) + int(row[2] or 0)
            result['comment'] = row[3] or None
            result['engine'] = row[4] or None
    except Exception as failure:
        _add_err(result, '表基本信息', failure)
    try:
        cursor.execute(
            "SELECT ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, "
            "       COLUMN_KEY, COLUMN_DEFAULT, COLUMN_COMMENT "
            "FROM INFORMATION_SCHEMA.COLUMNS "
            "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s ORDER BY ORDINAL_POSITION",
            (database, table)
        )
        rows = cursor.fetchall()
        # SELECT 顺序：ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
        #               COLUMN_KEY, COLUMN_DEFAULT, COLUMN_COMMENT
        result['columns'] = _columns_from(
            (row[0], row[1], row[2], str(row[3] or '').upper() == 'YES', row[4], row[5], row[6])
            for row in rows)
    except Exception as failure:
        _add_err(result, '字段信息', failure)
    try:
        cursor.execute(
            "SELECT INDEX_NAME, NON_UNIQUE, "
            "GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ') "
            "FROM INFORMATION_SCHEMA.STATISTICS "
            "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s "
            "GROUP BY INDEX_NAME, NON_UNIQUE",
            (database, table)
        )
        for row in cursor.fetchall():
            result['indexes'].append({
                'name': row[0], 'unique': row[1] == 0,
                'primary': (row[0] or '').upper() == 'PRIMARY',
                'columns': row[2],
            })
    except Exception as failure:
        _add_err(result, '索引信息', failure)


# ══════════════════════════════════════════════════════════════
#  PostgreSQL / IvorySQL / Kingbase / HGDB / HaloDB
# ══════════════════════════════════════════════════════════════

def _pg_like(cursor, result, database, table):
    t_schema, t_name = _split_qualified(table, 'public')
    full_name = '%s.%s' % (t_schema, t_name)
    try:
        cursor.execute(
            "SELECT COALESCE(s.n_live_tup, -1) FROM pg_stat_user_tables s "
            "JOIN pg_class c ON c.oid = s.relid "
            "WHERE c.relname = %s AND c.relnamespace = "
            "(SELECT oid FROM pg_namespace WHERE nspname = %s)",
            (t_name, t_schema)
        )
        row = cursor.fetchone()
        if row and row[0] is not None and row[0] >= 0:
            result['row_count'] = row[0]
    except Exception as failure:
        _add_err(result, '行数', failure)
    try:
        # to_regclass 而不是 format('%I.%I')：后者要把 %I 写进 SQL 字符串字面量，
        # 驱动的参数替换与字面量混在一起容易踩坑，名字带引号/空格时更不稳。
        cursor.execute(
            "SELECT pg_total_relation_size(to_regclass(%s)), "
            "       obj_description(to_regclass(%s), 'relation')",
            (full_name, full_name)
        )
        row = cursor.fetchone()
        if row:
            result['table_size'] = row[0] if row[0] is not None else None
            result['comment'] = row[1]
    except Exception as failure:
        _add_err(result, '表大小/注释', failure)
    try:
        cursor.execute(
            "SELECT c.ordinal_position, c.column_name, c.data_type, c.is_nullable, "
            "       c.column_default, "
            "       COALESCE(col_description(to_regclass(%s)::oid, c.ordinal_position), '') "
            "FROM information_schema.columns c "
            "WHERE c.table_schema = %s AND c.table_name = %s "
            "ORDER BY c.ordinal_position",
            (full_name, t_schema, t_name)
        )
        columnRows = cursor.fetchall()
        pk_cols = set()
        try:
            cursor.execute(
                "SELECT a.attname FROM pg_index i "
                "JOIN pg_attribute a ON a.attrelid = i.indrelid "
                "     AND a.attnum = ANY(i.indkey::int2[]) "
                "JOIN pg_class c ON c.oid = i.indrelid "
                "JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE i.indisprimary AND n.nspname = %s AND c.relname = %s",
                (t_schema, t_name)
            )
            pk_cols = {row[0] for row in cursor.fetchall()}
        except Exception:
            pass
        result['columns'] = _columns_from([
            (c[0], c[1], c[2], (str(c[3] or '').upper() == 'YES'),
             'PRI' if c[1] in pk_cols else '', c[4], c[5])
            for c in columnRows])
    except Exception as failure:
        _add_err(result, '字段信息', failure)
    try:
        cursor.execute(
            "SELECT indexname, indexdef FROM pg_indexes "
            "WHERE schemaname = %s AND tablename = %s ORDER BY indexname",
            (t_schema, t_name)
        )
        for row in cursor.fetchall():
            result['indexes'].append({
                'name': row[0],
                'unique': str(row[1] or '').upper().startswith('CREATE UNIQUE INDEX'),
                'primary': str(row[0] or '').endswith('_pkey'),
                'columns': row[1],
            })
    except Exception as failure:
        _add_err(result, '索引信息', failure)


# ══════════════════════════════════════════════════════════════
#  Oracle / DM / YashanDB（owner 语义，字典视图基本兼容）
# ══════════════════════════════════════════════════════════════
# 三家都用 Oracle 风格的数据字典，差别只在：
#   · 绑定占位符：oracledb 用 :name，dmPython / yasdb 用 ?
#   · 崖山字典视图在 SYS. 下
#   · 达梦/崖山不一定有 data_precision/data_scale，长度直接取 data_length

def _owner_like(cursor, result, database, table, dialect):
    owner = (database or '').upper()
    tname = (table or '').upper()
    prefix = 'sys.' if dialect == 'yashandb' else ''
    _exec = cursor.execute      # 三家的占位符差异只在 :name / ?，语句里已各自写好

    if dialect == 'oracle':
        ph = {'owner': owner, 'tname': tname}
        col_sql = ("SELECT column_id, column_name, data_type, data_length, "
                   "       data_precision, data_scale, nullable, data_default "
                   "  FROM all_tab_columns WHERE owner = :owner AND table_name = :tname "
                   " ORDER BY column_id")
    else:
        ph = [owner, tname]
        col_sql = ("SELECT column_id, column_name, data_type, data_length, "
                   "       NULL, NULL, is_nullable, NULL "
                   "  FROM %sALL_TAB_COLUMNS WHERE owner = ? AND table_name = ? "
                   " ORDER BY column_id" % prefix)
    try:
        _exec(col_sql, ph)
        rows = cursor.fetchall()
        columnRows = []
        for c in rows:
            dtype = c[2] or ''
            if dialect == 'oracle':
                if c[4] is not None and c[5] is not None:
                    dtype = '%s(%s,%s)' % (dtype, c[4], c[5])
                elif c[4] is not None:
                    dtype = '%s(%s)' % (dtype, c[4])
                elif c[3] and 'CHAR' in str(dtype).upper():
                    dtype = '%s(%s)' % (dtype, c[3])
            elif c[3]:
                dtype = '%s(%s)' % (dtype, c[3])
            nullable = str(c[6] or '').upper() in ('Y', 'YES', 'TRUE', '1')
            columnRows.append((c[0], c[1], dtype, nullable, '',
                         str(c[7]) if c[7] is not None else None, ''))
        result['columns'] = _columns_from(columnRows)
    except Exception as failure:
        _add_err(result, '字段信息', failure)

    try:
        if dialect == 'oracle':
            _exec("SELECT comments FROM all_tab_comments WHERE owner = :owner AND table_name = :tname",
                  {'owner': owner, 'tname': tname})
        else:
            _exec("SELECT comments FROM %sALL_TAB_COMMENTS WHERE owner = ? AND table_name = ?" % prefix,
                  [owner, tname])
        row = cursor.fetchone()
        if row:
            result['comment'] = row[0]
    except Exception as failure:
        _add_err(result, '表注释', failure)

    try:
        if dialect == 'oracle':
            _exec("SELECT column_name, comments FROM all_col_comments "
                  "WHERE owner = :owner AND table_name = :tname", {'owner': owner, 'tname': tname})
        else:
            _exec("SELECT column_name, comments FROM %sALL_COL_COMMENTS "
                  "WHERE owner = ? AND table_name = ?" % prefix, [owner, tname])
        col_comments = {row[0]: row[1] for row in cursor.fetchall()}
        for col in result['columns']:
            col['comment'] = col_comments.get(col['name'], '') or ''
    except Exception:
        pass

    try:
        if dialect == 'oracle':
            _exec("SELECT num_rows FROM all_tables WHERE owner = :owner AND table_name = :tname",
                  {'owner': owner, 'tname': tname})
        else:
            _exec("SELECT num_rows FROM %sALL_TABLES WHERE owner = ? AND table_name = ?" % prefix,
                  [owner, tname])
        row = cursor.fetchone()
        if row and row[0] is not None:
            result['row_count'] = row[0]
    except Exception as failure:
        _add_err(result, '行数', failure)

    try:
        if dialect == 'oracle':
            _exec("SELECT tablespace_name FROM all_tables WHERE owner = :owner AND table_name = :tname",
                  {'owner': owner, 'tname': tname})
        else:
            _exec("SELECT tablespace_name FROM %sALL_TABLES WHERE owner = ? AND table_name = ?" % prefix,
                  [owner, tname])
        row = cursor.fetchone()
        if row and row[0]:
            result['tablespace'] = row[0]
    except Exception:
        pass

    try:
        if dialect == 'oracle':
            _exec("SELECT index_name, uniqueness FROM all_indexes "
                  "WHERE owner = :owner AND table_name = :tname ORDER BY index_name",
                  {'owner': owner, 'tname': tname})
        else:
            _exec("SELECT index_name, uniqueness FROM %sALL_INDEXES "
                  "WHERE owner = ? AND table_name = ? ORDER BY index_name" % prefix,
                  [owner, tname])
        idx_map = {}
        for row in cursor.fetchall():
            idx_map[row[0]] = {'name': row[0], 'unique': str(row[1] or '').upper() == 'UNIQUE',
                             'primary': False, 'columns': []}
        if dialect == 'oracle':
            _exec("SELECT index_name, column_name FROM all_ind_columns "
                  "WHERE index_owner = :owner AND table_name = :tname "
                  "ORDER BY index_name, column_position", {'owner': owner, 'tname': tname})
        else:
            _exec("SELECT index_name, column_name FROM %sALL_IND_COLUMNS "
                  "WHERE table_owner = ? AND table_name = ? "
                  "ORDER BY index_name, column_position" % prefix, [owner, tname])
        for row in cursor.fetchall():
            if row[0] in idx_map:
                idx_map[row[0]]['columns'].append(row[1])
        for name, info in idx_map.items():
            info['columns'] = ', '.join(info['columns'])
            info['primary'] = str(name).lower().startswith('sys_c')
            result['indexes'].append(info)
    except Exception as failure:
        _add_err(result, '索引信息', failure)


# ══════════════════════════════════════════════════════════════
#  SQL Server
# ══════════════════════════════════════════════════════════════
# 对象定位统一走 sys.objects + sys.schemas 显式匹配，不用 OBJECT_ID(QUOTENAME(?))：
#   ① QUOTENAME('schema.table') → [schema.table]（整串被当成一个标识符）→ 恒 NULL；
#   ② 树里的对象名不带 schema，遇到非默认 schema 的对象时 OBJECT_ID 按调用者
#      默认 schema 解析 → 也恒 NULL；
#   两者都是**静默返回空**（页面上只看到「行数 — / 字段空」），极难排查。
# 未给 schema 时按 SQL Server 惯例优先 dbo，保证同名对象的解析结果确定。

def _sqlserver(cursor, result, database, table):
    t_schema, t_name = None, (table or '').strip()
    if '.' in t_name:
        a, bodyText = t_name.split('.', 1)
        if a.strip() and bodyText.strip():
            t_schema, t_name = a.strip(), bodyText.strip()
    o_params = (t_name, t_schema) if t_schema else (t_name,)
    o_cte = ("WITH o AS (SELECT TOP 1 ob.object_id FROM sys.objects ob "
             "JOIN sys.schemas sc ON sc.schema_id = ob.schema_id "
             "WHERE ob.name = ? AND ob.type IN ('U','V') "
             + ("AND sc.name = ? " if t_schema else "")
             + "ORDER BY CASE WHEN sc.name = 'dbo' THEN 0 ELSE 1 END, sc.name) ")

    try:
        cursor.execute(
            o_cte + "SELECT SUM(p.rows) FROM sys.partitions p "
            "JOIN o ON o.object_id = p.object_id WHERE p.index_id IN (0, 1)",
            o_params
        )
        row = cursor.fetchone()
        if row and row[0] is not None:
            result['row_count'] = int(row[0])
    except Exception as failure:
        _add_err(result, '行数', failure)

    try:
        # [WARN] 两处 T-SQL 专属坑（ODBC Driver 18 实测）：
        #   ① 不能在 SELECT 列表里写 `c.is_nullable = 1` —— T-SQL 会把「名字 = 表达式」
        #      解析成旧式别名语法，c.is_nullable 是多段名，直接报 102 语法错误；
        #      直接取原始 bit 列，Python 侧 bool() 即可。
        #   ② sys.columns **没有** column_default 列（那是 MySQL/Oracle 的叫法），
        #      要取默认值必须 JOIN sys.default_constraints。
        cursor.execute(
            o_cte + "SELECT c.name, TYPE_NAME(c.user_type_id), c.is_nullable, "
            "dc.definition, CAST(ep.value AS NVARCHAR(4000)), c.column_id "
            "FROM o "
            "JOIN sys.columns c ON c.object_id = o.object_id "
            "LEFT JOIN sys.default_constraints dc "
            "  ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id "
            "LEFT JOIN sys.extended_properties ep "
            "  ON ep.class = 1 AND ep.major_id = c.object_id "
            " AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' "
            "ORDER BY c.column_id",
            o_params
        )
        rows = cursor.fetchall()
        result['columns'] = _columns_from([
            (row[5], row[0], row[1], bool(row[2]), '', row[3], row[4]) for row in rows])
        pk_cols = set()
        try:
            cursor.execute(
                o_cte + "SELECT c.name FROM o "
                "JOIN sys.indexes i ON i.object_id = o.object_id AND i.is_primary_key = 1 "
                "JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id "
                "JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id",
                o_params
            )
            pk_cols = {row[0] for row in cursor.fetchall()}
        except Exception:
            pass
        for col in result['columns']:
            if col['name'] in pk_cols:
                col['key'] = 'PRI'
    except Exception as failure:
        _add_err(result, '字段信息', failure)

    try:
        cursor.execute(
            o_cte + "SELECT i.name, i.is_unique, i.is_primary_key, "
            "STUFF((SELECT ', ' + c2.name FROM sys.index_columns ic2 "
            "       INNER JOIN sys.columns c2 "
            "         ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id "
            "       WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id "
            "       ORDER BY ic2.key_ordinal FOR XML PATH('')), 1, 2, '') "
            "FROM sys.indexes i JOIN o ON o.object_id = i.object_id "
            "WHERE i.name IS NOT NULL ORDER BY i.name",
            o_params
        )
        for row in cursor.fetchall():
            result['indexes'].append({
                'name': row[0], 'unique': bool(row[1]), 'primary': bool(row[2]), 'columns': row[3],
            })
    except Exception as failure:
        _add_err(result, '索引信息', failure)


# ══════════════════════════════════════════════════════════════
#  ClickHouse / DB2（本仓库额外覆盖；查不到就整体降级）
# ══════════════════════════════════════════════════════════════

def _clickhouse(cursor, result, database, table):
    from modules.sqleditor.metadata import _lit
    quotedTable, quotedDatabase = _lit(table, "'"), _lit(database, "'")
    if not quotedTable:
        result['errors'].append('字段信息: 表名不合法，已跳过')
        return
    databaseFilter = "database = %s" % quotedDatabase if quotedDatabase else "database NOT IN ('system')"
    try:
        cursor.execute(
            "SELECT name, engine, comment, total_rows, bytes_on_disk "
            "  FROM system.tables WHERE %s AND name = %s" % (databaseFilter, quotedTable)
        )
        row = cursor.fetchone()
        if row:
            result['engine'] = row[1]
            result['comment'] = row[2] or None
            if row[3] is not None:
                result['row_count'] = int(row[3])
            if row[4] is not None:
                result['table_size'] = int(row[4])
    except Exception as failure:
        _add_err(result, '表基本信息', failure)
    try:
        cursor.execute(
            "SELECT position, name, type, if(is_nullable, 1, 0), '', default_kind, comment "
            "  FROM system.columns WHERE %s AND table = %s ORDER BY position" % (databaseFilter, quotedTable)
        )
        result['columns'] = _columns_from([
            (row[0], row[1], row[2], bool(row[3]), row[4], row[5], row[6]) for row in cursor.fetchall()])
    except Exception as failure:
        _add_err(result, '字段信息', failure)
    try:
        # ClickHouse 的二级索引在 system.tables.indices 里（ARRAY JOIN 展开）；
        # [WARN] 别名不要写 index —— 它是 ClickHouse 的保留字，写了直接语法错误。
        cursor.execute(
            "SELECT idx.name, idx.type, arrayJoin(idx.expression_columns) "
            "  FROM system.tables AS t "
            "  ARRAY JOIN t.indices AS idx "
            " WHERE %s AND t.name = %s" % (databaseFilter, quotedTable)
        )
        idx_map = {}
        for row in cursor.fetchall():
            info = idx_map.setdefault(row[0], {'name': row[0], 'unique': False,
                                             'primary': False, 'columns': []})
            info['detail'] = row[1]
            info['columns'].append(str(row[2]))
        for info in idx_map.values():
            info['columns'] = ', '.join(info['columns'])
            result['indexes'].append(info)
    except Exception as failure:
        _add_err(result, '索引信息', failure)


def _db2(cursor, result, database, table):
    from modules.sqleditor.metadata import _lit
    quotedTable, quotedDatabase = _lit((table or '').upper(), "'"), _lit((database or '').upper(), "'")
    if not quotedTable:
        result['errors'].append('字段信息: 表名不合法，已跳过')
        return
    where = "TABSCHEMA = %s" % quotedDatabase if quotedDatabase else "TABSCHEMA NOT LIKE 'SYS%'"
    try:
        cursor.execute(
            "SELECT TABSCHEMA, TABNAME, TYPE, CARD, REMARKS, TBSPACE "
            "  FROM SYSCAT.TABLES WHERE %s AND TABNAME = %s" % (where, quotedTable)
        )
        row = cursor.fetchone()
        if row:
            result['comment'] = row[4] or None
            result['tablespace'] = row[5] or None
            if row[3]:
                result['row_count'] = int(row[3])       # CARD = ANALYZE 后的统计行数
    except Exception as failure:
        _add_err(result, '表基本信息', failure)
    try:
        cursor.execute(
            "SELECT COLNO, COLNAME, TYPENAME || CASE WHEN LENGTH IS NOT NULL "
            "         THEN '(' || LENGTH || ')' ELSE '' END, "
            "       NULLS_ALLOWED, KEYSEQ, DEFAULT, REMARKS "
            "  FROM SYSCAT.COLUMNS WHERE %s AND TABNAME = %s ORDER BY COLNO" % (where, quotedTable)
        )
        result['columns'] = _columns_from([
            (row[0], row[1], row[2], str(row[3] or '').upper() == 'Y',
             'PRI' if row[4] else '', row[5], row[6]) for row in cursor.fetchall()])
    except Exception as failure:
        _add_err(result, '字段信息', failure)
    try:
        cursor.execute(
            "SELECT i.INDNAME, CASE WHEN i.UNIQUERULE IN ('U','P') THEN 1 ELSE 0 END, "
            "       CASE WHEN i.UNIQUERULE = 'P' THEN 1 ELSE 0 END, c.COLNAME "
            "  FROM SYSCAT.INDEXES i "
            "  JOIN SYSCAT.INDEXCOLUSED c ON c.INDNAME = i.INDNAME AND c.TABNAME = i.TABNAME "
            "       AND c.TABSCHEMA = i.TABSCHEMA "
            " WHERE %s AND i.TABNAME = %s ORDER BY i.INDNAME, c.COLSEQ" % (where, quotedTable)
        )
        idx_map = {}
        for row in cursor.fetchall():
            info = idx_map.setdefault(row[0], {'name': row[0], 'unique': bool(row[1]),
                                             'primary': bool(row[2]), 'columns': []})
            info['columns'].append(str(row[3]))
        for info in idx_map.values():
            info['columns'] = ', '.join(info['columns'])
            result['indexes'].append(info)
    except Exception as failure:
        _add_err(result, '索引信息', failure)


SUPPORTED = MYSQL_FAMILY + PG_FAMILY + OWNER_FAMILY + ('sqlserver', 'clickhouse', 'db2')


def load_table_info(connection, db_type, database, table):
    """在已建立的连接上查询表属性。返回 dict（见下方结构），不支持的方言返回 supported=False。

    结构::

        {'supported': bool, 'db_type': str, 'database': str, 'table': str,
         'columns': [{position,name,type,nullable,key,default,comment}],
         'indexes': [{name,unique,primary,columns}],
         'row_count': int|None, 'table_size': int|None,
         'comment': str|None, 'engine': str|None, 'tablespace': str|None,
         'errors': [str, ...]}
    """
    dialect = normalize_db_type(db_type)
    result = {
        'supported': dialect in SUPPORTED,
        'db_type': dialect, 'database': database or '', 'table': table or '',
        'columns': [], 'indexes': [],
        'row_count': None, 'table_size': None,
        'comment': None, 'engine': None, 'tablespace': None,
        'errors': [],
    }
    if not result['supported']:
        result['errors'].append('该数据库类型暂不支持查看表属性（%s）' % (dialect or '未知'))
        return result

    # JDBC 插件包装层的游标只收 execute(sql)，套一层把绑定参数内联成字面量
    cursor = adapt_cursor(connection.cursor())
    try:
        if dialect in MYSQL_FAMILY:
            _mysql_like(cursor, result, database, table)
        elif dialect in PG_FAMILY:
            _pg_like(cursor, result, database, table)
        elif dialect in OWNER_FAMILY:
            _owner_like(cursor, result, database, table, dialect)
        elif dialect == 'sqlserver':
            _sqlserver(cursor, result, database, table)
        elif dialect == 'clickhouse':
            _clickhouse(cursor, result, database, table)
        elif dialect == 'db2':
            _db2(cursor, result, database, table)
    finally:
        _close(cursor)
    return _json_safe(result)


def _json_safe(result):
    """出参统一过一遍 JSON 安全转换：JDBC 包装层给的是 Java 对象，jsonify 不认。"""
    for field in ('row_count', 'table_size', 'comment', 'engine', 'tablespace'):
        result[field] = json_safe_value(result.get(field))
    for column in result.get('columns') or []:
        for field in ('position', 'name', 'type', 'default', 'comment'):
            if field in column:
                column[field] = json_safe_value(column[field])
    for indexInfo in result.get('indexes') or []:
        for field in ('name', 'columns', 'detail'):
            if field in indexInfo:
                indexInfo[field] = json_safe_value(indexInfo[field])
    return result
