# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""SQL 编辑器自动补全用的对象元数据（表 / 视图 + 列名）。

归属说明：各方言字典 SQL 与采集流程的设计归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com> 所有。五条实现约定：

1. **方言 SQL 集中在本模块**（单一真源），不要散落到 api 层或前端；
2. 连接一律复用 ``modules.web.app._open_editor_conn``（SQL 编辑器统一建连入口），
   不另造连接逻辑 —— Oracle 厚模式回退、各库驱动差异都已在其中处理；
3. 跨请求的连接池并不存在（一次建连 160~1600ms），所以结果按
   (数据源, 库/schema, 模式) 做**进程内 TTL 缓存**，避免每切一次数据源就打一次数据字典；
4. 取数是**流式累计 + 上限保护**：对象/列数超阈值即停止并标记 truncated，
   防止大库把内存和响应体撑爆（补全只需要"够用"的元数据）；
5. 覆盖本仓库已支持的方言；未覆盖的一律**降级**（返回 error/reason，不抛异常），
   前端只会退化成"没有表名提示"，不影响正常写 SQL。

对上层只暴露 :func:`load_metadata`、:func:`list_schemas` 与 :func:`search_objects`。
"""
import inspect
import re
import time

# 缓存与上限
META_CACHE_TTL = 300          # 秒
META_MAX_TABLES = 3000        # 参与补全的对象数上限
META_MAX_COLUMNS = 60000      # 参与补全的列数上限
META_MAX_OBJECTS_ONLY = 20000  # 「只取名单」模式的对象上限（一份名单本身很轻）
META_FETCH_BATCH = 2000       # 单次 fetchmany 行数 / JDBC Statement 预取行数
META_QUERY_TIMEOUT_SECONDS = 30  # 字典查询的语句超时（防止一条慢查询把 Web 主线程挂住）

# 对象快速搜索的一页条数：一次最多 500 条，默认 200（web 层按它夹住用户传的 limit）。
# 搜索只过滤内存里的名单，条数上限是为了让前端渲染始终可控。
OBJECT_SEARCH_LIMIT_DEFAULT = 200
OBJECT_SEARCH_LIMIT_MAX = 500
# 内部一次最多「取」多少条：跨数据源聚合翻页时，每个源都得先取出 offset+页大小
# 条才能拼出全局序（见 web 层 _object_search_across_datasources），
# 所以取数上限要比页大小宽；名单本身在内存里，多切几千条只是几毫秒。
OBJECT_SEARCH_FETCH_CEILING = 5000

# SQL Server「全部」范围一次最多展开几个库：跨库名单是把每段的
# sys.objects 拼成一条 UNION ALL，库数不设上限时 SQL 文本和元数据行
# 数都会失控（一个 200 库的实例光拼串就几万字符）。
# 当前库永远排在最前，所以被截掉的是字母序靠后的库，前端会提示「请先选库再搜」。
SQLSERVER_MAX_SEARCH_CATALOGS = 24

# 同类型数据源聚合搜索（scope=ds）的一次上限：每个数据源都要单独建连 + 拉名单，
# 不设上限时「搜一次 = 把整个登记的同类库都连一遍」，界面会等到天荒地老。
OBJECT_SEARCH_DATASOURCE_MAX = 12
# 聚合搜索的墙钟预算（秒）：插件型数据源在 Web 主进程里起 JVM，并发跑会把
# gevent hub 钉死（见 modules.web.app._object_search_across_datasources），
# 只能串行；超预算就停下并把「没搜到几个源」说清楚，别让用户误以为搜全了。
# 前端对象搜索的超时是 90s（sql_editor.js METADATA_TIMEOUT_MS），这里留足余量。
OBJECT_SEARCH_DATASOURCE_BUDGET_SECONDS = 45

_meta_cache = {}

# ── 方言族（本仓库的规范名 → 查询家族）────────────────────────
MYSQL_FAMILY = ('mysql', 'tidb', 'mariadb', 'oceanbase', 'tdsqlc_mysql')
PG_FAMILY = ('postgresql', 'ivorysql', 'kingbase', 'hgdb', 'halodb')
OWNER_FAMILY = ('oracle', 'dm', 'yashandb')      # 「数据库」维度就是 owner/schema
SUPPORTED_META = MYSQL_FAMILY + PG_FAMILY + OWNER_FAMILY + ('sqlserver', 'clickhouse', 'db2')


def normalize_db_type(db_type):
    """把数据源里登记的 db_type 规范成本模块使用的族名（与 web 层保持同一套写法）。"""
    normalized = str(db_type or '').strip().lower()
    normalized = normalized.replace('oracle_full', 'oracle').replace('_jdbc', '')
    if normalized in ('pg', 'postgres'):
        normalized = 'postgresql'
    if normalized == 'dm8':
        normalized = 'dm'
    if normalized in ('mssql', 'sybase'):
        normalized = 'sqlserver'
    return normalized


def _lit(rawValue, quote="'"):
    """把标识符安全地引用成字面量（用于只支持拼串的驱动：ClickHouse / DB2）。

    含引号、控制字符或超长一律拒绝（返回 None），调用方跳过该查询即可 ——
    宁可不给提示，也不能拼出坏 SQL。
    """
    value = str(rawValue or '').strip()
    if not value or len(value) > 128 or re.search(r'[\x00-\x1f]', value) or quote in value:
        return None
    return quote + value + quote


# ══════════════════════════════════════════════════════════════
#  各库的元数据 SQL
# ══════════════════════════════════════════════════════════════
# 统一输出三/四列（小写别名，兼容 pymysql 的 DictCursor 与普通 tuple cursor）：
#   table_name / column_name / object_type  [+ schema_name]
# 每个方言给「主查询 + 退化查询」两条，主查询失败（字典视图字段差异）时自动降级。
#
# [WARN] 占位符按驱动写，不要图省事统一成一个：
#   oracledb → :1（编号绑定）；dmPython / yasdb / pyodbc → ?；
#   pymysql / psycopg2 → %s；ClickHouse / DB2 走 JDBC 包装，只能拼字面量（用 _lit 把关）。
# 标识符（owner/schema）优先走绑定参数而不是拼串，含空格/引号的名字也能正确处理。

def _metadata_queries(dialect, database):
    """返回 [(sql, params)]，按优先级排列。database 为空时用当前 schema（见 _resolve_scope）。"""
    if dialect == 'oracle':
        # dba_* 在前：静态视图直连基表，比 all_*（UNION ALL 视图）快数倍；
        # 无 DBA 权限会报 ORA-00942，由 _execute_first 自动降级到 all_*。
        return [
            ("SELECT c.table_name AS table_name, c.column_name AS column_name, "
             "       o.object_type AS object_type "
             "  FROM dba_tab_columns c "
             "  JOIN dba_objects o ON o.owner = c.owner AND o.object_name = c.table_name "
             " WHERE c.owner = :1 AND o.object_type IN ('TABLE', 'VIEW') "
             " ORDER BY c.table_name, c.column_id", [database]),
            ("SELECT c.table_name AS table_name, c.column_name AS column_name, "
             "       o.object_type AS object_type "
             "  FROM all_tab_columns c "
             "  JOIN all_objects o ON o.owner = c.owner AND o.object_name = c.table_name "
             " WHERE c.owner = :1 AND o.object_type IN ('TABLE', 'VIEW') "
             " ORDER BY c.table_name, c.column_id", [database]),
            # 退化：all_tab_columns 其实已覆盖表与视图，JOIN 失败时退到单表查询
            ("SELECT c.table_name AS table_name, c.column_name AS column_name, "
             "       'TABLE' AS object_type "
             "  FROM all_tab_columns c WHERE c.owner = :1 "
             " ORDER BY c.table_name", [database]),
        ]

    if dialect == 'yashandb':
        return [
            ("SELECT c.table_name AS table_name, c.column_name AS column_name, "
             "       o.object_type AS object_type "
             "  FROM sys.all_tab_columns c "
             "  JOIN sys.all_objects o ON o.owner = c.owner AND o.object_name = c.table_name "
             " WHERE c.owner = ? AND o.object_type IN ('TABLE', 'VIEW') "
             " ORDER BY c.table_name, c.column_id", [database]),
            ("SELECT c.table_name AS table_name, c.column_name AS column_name, "
             "       'TABLE' AS object_type "
             "  FROM sys.all_tab_columns c WHERE c.owner = ?", [database]),
        ]

    if dialect == 'dm':
        return [
            ("SELECT c.table_name AS table_name, c.column_name AS column_name, "
             "       o.object_type AS object_type "
             "  FROM all_tab_columns c "
             "  JOIN all_objects o ON o.owner = c.owner AND o.object_name = c.table_name "
             " WHERE c.owner = ? AND o.object_type IN ('TABLE', 'VIEW')", [database]),
            ("SELECT c.table_name AS table_name, c.column_name AS column_name, "
             "       'TABLE' AS object_type "
             "  FROM all_tab_columns c WHERE c.owner = ?", [database]),
        ]

    if dialect in MYSQL_FAMILY:
        return [
            ("SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, "
             "       t.TABLE_TYPE AS object_type "
             "  FROM information_schema.COLUMNS c "
             "  JOIN information_schema.TABLES t "
             "    ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME "
             " WHERE c.TABLE_SCHEMA = %s "
             " ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION", [database]),
            ("SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, "
             "       'BASE TABLE' AS object_type "
             "  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = %s "
             " ORDER BY TABLE_NAME, ORDINAL_POSITION", [database]),
        ]

    if dialect in PG_FAMILY:
        # 连接串里已经选定了库，information_schema 天然只含该库 → 不再按 schema 过滤
        return [
            ("SELECT c.table_schema AS schema_name, c.table_name AS table_name, "
             "       c.column_name AS column_name, t.table_type AS object_type "
             "  FROM information_schema.columns c "
             "  JOIN information_schema.tables t "
             "    ON t.table_schema = c.table_schema AND t.table_name = c.table_name "
             " WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') "
             " ORDER BY c.table_schema, c.table_name, c.ordinal_position", []),
        ]

    if dialect == 'sqlserver':
        return [
            ("SELECT c.TABLE_SCHEMA AS schema_name, c.TABLE_NAME AS table_name, "
             "       c.COLUMN_NAME AS column_name, t.TABLE_TYPE AS object_type "
             "  FROM INFORMATION_SCHEMA.COLUMNS c "
             "  JOIN INFORMATION_SCHEMA.TABLES t "
             "    ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME "
             " WHERE c.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA') "
             " ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION", []),
        ]

    if dialect == 'clickhouse':
        # 未指定库时连接落在 default，跨库扫描也只要非系统库；上限保护在 _collect 里
        q = _lit(database, "'")
        if database and not q:
            return []
        cond = ("database = %s" % q) if q else \
               "database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')"
        return [
            ("SELECT database AS schema_name, table AS table_name, name AS column_name, "
             "       'TABLE' AS object_type "
             "  FROM system.columns WHERE %s ORDER BY database, table, position" % cond, []),
        ]

    if dialect == 'db2':
        q = _lit(database.upper(), "'")
        if database and not q:
            return []
        cond = ("TABSCHEMA = %s" % q) if q else "TABSCHEMA NOT LIKE 'SYS%'"
        return [
            ("SELECT c.TABSCHEMA AS schema_name, c.TABNAME AS table_name, "
             "       c.COLNAME AS column_name, t.TYPE AS object_type "
             "  FROM SYSCAT.COLUMNS c "
             "  JOIN SYSCAT.TABLES t ON t.TABSCHEMA = c.TABSCHEMA AND t.TABNAME = c.TABNAME "
             " WHERE c.%s AND t.TYPE IN ('T', 'V') "
             " ORDER BY c.TABSCHEMA, c.TABNAME, c.COLNO" % cond, []),
            ("SELECT c.TABSCHEMA AS schema_name, c.TABNAME AS table_name, "
             "       c.COLNAME AS column_name, 'TABLE' AS object_type "
             "  FROM SYSCAT.COLUMNS c WHERE c.%s" % cond, []),
        ]

    return []


# Oracle 系的「当前 schema」兜底：用户只选了数据源、没点具体 owner 时用
_CURRENT_SCHEMA_SQL = {
    'oracle':    "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS cur_schema FROM dual",
    'yashandb':  "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS cur_schema FROM dual",
    'dm':        "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS cur_schema FROM dual",
    'sqlserver': "SELECT SCHEMA_NAME() AS cur_schema",
}
_CURRENT_SCHEMA_SQL.update(dict.fromkeys(MYSQL_FAMILY, "SELECT DATABASE() AS cur_schema"))
_CURRENT_SCHEMA_SQL.update(dict.fromkeys(PG_FAMILY, "SELECT current_schema() AS cur_schema"))


# 单格最多带多少字符的 LOB 预览。参考 PL/SQL Developer：网格里只给标记/预览，
# 全文要看就双击，所以这里不追求「一次全带回来」——太大会把一整页结果撑爆。
LOB_INLINE_LIMIT = 32768

# 需要按 LOB 处理的列类型标签（来自游标 description 的类型名）
LOB_TYPE_TOKENS = ('NCLOB', 'CLOB', 'BLOB', 'LONG RAW', 'LONG', 'BYTEA', 'IMAGE')


def _format_size(total):
    try:
        return format(int(total), ',')
    except Exception:
        return str(total)


def _lob_text(value, limit=LOB_INLINE_LIMIT):
    """把数据库 LOB 读成可展示的文本；不是 LOB 返回 None。

    * **JDBC 插件**（`oracle.sql.CLOB` / `java.sql.Blob`）：统一交给
      :func:`modules.jdbc_connector.convert_jdbc_lob` —— 插件的
      ``_convert_java_obj`` 也调它，两边口径一致；
    * **原生驱动**（oracledb 的 ``LOB`` 对象）：用 ``read(offset, amount)``。

    超过 ``limit`` 的内容不往回带，末尾附一句「已截断」（与双击看全文配套）。
    """
    if value is None:
        return None
    try:
        from modules.jdbc_connector import convert_jdbc_lob
        java_lob_text = convert_jdbc_lob(value, limit)
        if java_lob_text is not None:
            return java_lob_text
    except Exception:
        pass
    if type(value).__name__ == 'LOB' and callable(getattr(value, 'read', None)):
        try:
            data = value.read(1, limit)
            if isinstance(data, (bytes, bytearray)):
                try:
                    return bytes(data).decode('utf-8')
                except UnicodeDecodeError:
                    return '<BLOB %s 字节>' % _format_size(len(data))
            text = '' if data is None else str(data)
            if callable(getattr(value, 'size', None)) and value.size() > len(text):
                text += '\n…[CLOB 已截断：共 %s 字符]' % _format_size(value.size())
            return text
        except Exception:
            return None
    return None


def json_safe_value(value):
    """把驱动返回的单元格转成可 JSON 序列化的值。

    JDBC 包装层拿到的是 Java 对象（java.lang.String / BigDecimal / Timestamp / CLOB …），
    部分 JPype 版本里 ``str()`` 仍返回 Java 字符串实例，直接 jsonify 会抛
    「Object of type java.lang.String is not JSON serializable」；
    原生驱动也会返回 Decimal / datetime / bytes 之类 jsonify 不认的类型。
    统一在这里收口：基本类型原样，LOB 读成文本/标记，其余按类型转字符串/数字。
    """
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).decode('utf-8', 'replace')
    if isinstance(value, memoryview):
        return value.tobytes().decode('utf-8', 'replace')
    lob_text = _lob_text(value)
    if lob_text is not None:
        return lob_text
    try:
        import decimal
        if isinstance(value, decimal.Decimal):
            return float(value) if value.is_finite() else str(value)
    except Exception:
        pass
    try:
        import datetime
        if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
            return value.isoformat(sep=' ') if isinstance(value, datetime.datetime) else value.isoformat()
    except Exception:
        pass
    try:
        return str(value)          # Java 对象 / LOB / 其它：按文本展示
    except Exception:
        return repr(value)


def column_type_label(descriptionEntry):
    """游标 description 单项 → 归一化的类型标签（认不出来返回空串）。

    JDBC 包装层的 description 是 ``(列名, 类型名, …)``，类型名本身就是
    'CLOB' / 'BLOB'；pymysql 给数字类型码、psycopg2 给 OID、oracledb 给带
    ``.name`` 的类型对象 —— 统一转大写文本再匹配，认不出来就当普通列处理。
    """
    try:
        raw = descriptionEntry[1]
    except Exception:
        return ''
    declared_name = getattr(raw, 'name', None)
    text = str(declared_name if declared_name else raw).upper()
    for token in LOB_TYPE_TOKENS:
        if token in text:
            return token
    return ''


def _cell(row, idx, key):
    """兼容 DictCursor（dict）与普通 tuple 两种取数方式。"""
    if isinstance(row, dict):
        if key in row:
            return row[key]
        for cacheEntryKey in row:
            if cacheEntryKey.lower() == key:
                return row[cacheEntryKey]
        return None
    try:
        return row[idx]
    except Exception:
        return None


def streamRows(cursor, rowBudget):
    """流式取数（避免 fetchall 一次性吃掉大结果集）。"""
    while True:
        try:
            batch = cursor.fetchmany(META_FETCH_BATCH)
        except Exception:
            return
        if not batch:
            return
        for row in batch:
            yield row
            rowBudget[0] -= 1
            if rowBudget[0] <= 0:
                return


def _literal_for_param(value):
    """把绑定参数写成 SQL 字面量；不安全的一律拒绝（返回 None）。

    只用于「驱动不支持参数绑定」的场景（JDBC 包装层 execute(sql) 只有一个形参）。
    拒绝条件：控制字符、超长、非基本类型 —— 宁可不给提示，也不能拼出坏 SQL。
    """
    if value is None:
        return 'NULL'
    if isinstance(value, bool):
        return '1' if value else '0'
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    if not text or len(text) > 200 or re.search(r'[\x00-\x1f]', text):
        return None
    return "'" + text.replace("'", "''") + "'"


def _inline_sql_params(sql, params):
    """按出现顺序把 ``?`` / ``%s`` / ``:1`` / ``:name`` 替换成字面量。

    任一参数被 _literal_for_param 拒绝就抛 ValueError，调用方按「这一项查不到」处理。
    """
    values = params if isinstance(params, (list, tuple)) else [params]
    result = sql
    if isinstance(params, dict):
        for name, value in params.items():
            literal = _literal_for_param(value)
            if literal is None:
                raise ValueError('参数 %s 不适合内联为字面量' % name)
            result = result.replace(':%s' % name, literal)
        return result

    index = 0

    def _next(_match):
        nonlocal index
        if index >= len(values):
            raise ValueError('占位符多于参数个数')
        literal = _literal_for_param(values[index])
        index += 1
        if literal is None:
            raise ValueError('第 %d 个参数不适合内联为字面量' % index)
        return literal

    result = re.sub(r'\?\s*(?![A-Za-z_])', lambda m: _next(m), result)      # 位置参数 ?
    result = re.sub(r'%s(?![A-Za-z])', lambda m: _next(m), result)          # 位置参数 %s
    result = re.sub(r':(\d+)', lambda m: _next(m), result)                  # 编号绑定 :1
    if index != len(values):
        raise ValueError('参数个数与占位符不匹配')
    return result


def _cursor_accepts_params(cursor):
    """游标的 execute 是否能收第二个参数（绑定参数）。"""
    try:
        signature = inspect.signature(cursor.execute)
    except (TypeError, ValueError):
        return True
    kinds = [p.kind for p in signature.parameters.values()]
    if inspect.Parameter.VAR_POSITIONAL in kinds:
        return True
    positional = [k for k in kinds if k in (inspect.Parameter.POSITIONAL_ONLY,
                                            inspect.Parameter.POSITIONAL_OR_KEYWORD)]
    return len(positional) >= 2


def _tune_jdbc_statement(cursor, fetchSize=META_FETCH_BATCH,
                         queryTimeoutSeconds=META_QUERY_TIMEOUT_SECONDS):
    """把 JDBC 包装游标底层 Statement 的预取行数 / 语句超时调好（原生驱动跳过）。

    插件里的 ``JdbcCursorWrapper`` 是 ``self.stmt = connection.createStatement()``，
    Oracle/MSSQL JDBC 默认一次只预取 10 行，取几千行就要打几百次网络往返：
    实测 9361 行数据字典名单要 **13.7 秒，其中查询只花 0.2 秒，全在取数**。
    预取调到 2000 行后同一查询降到几十毫秒。

    语句超时同样是护栏：Web 主进程跑在 gevent 上，一条卡住的字典查询会把
    所有页面一起挂死；30 秒拿不到结果就让它报错，前端有「重试」。

    原生驱动没有 ``stmt`` 属性，直接跳过；个别驱动不认某个设置也不能因此
    把整条链路弄坏，所以一律吞掉异常。
    """
    statement = getattr(cursor, 'stmt', None)
    if statement is None:
        return
    fetchSizeSetter = getattr(statement, 'setFetchSize', None)
    if callable(fetchSizeSetter):
        try:
            fetchSizeSetter(int(fetchSize))
        except Exception:
            pass
    if queryTimeoutSeconds:
        timeoutSetter = getattr(statement, 'setQueryTimeout', None)
        if callable(timeoutSetter):
            try:
                timeoutSetter(int(queryTimeoutSeconds))
            except Exception:
                pass


class JdbcCursorAdapter(object):
    """给 JDBC 插件包装层的游标补齐 DB-API 缺的两块能力。

    这些插件（oracle_jdbc / sqlserver_jdbc / db2_jdbc / clickhouse_jdbc /
    hgdb_jdbc / uxdb_jdbc / vastbase_jdbc 的 JdbcConnectionWrapper）的游标是
    按 Java ResultSet 手写的，只实现了 ``execute(sql)`` + ``fetchall/fetchone``：

    1. 不收绑定参数 —— 直接 ``execute(sql, params)`` 会 TypeError，
       表现是「数据源页能连、SQL 编辑器里拿不到对象/表属性」；这里把参数内联成字面量；
    2. 没有 ``fetchmany`` —— 上层（执行翻页、元数据流式采集）都按 DB-API 用它，
       缺了会被 except 静默吃掉，表现是「元数据 0 个对象」「执行报 no attribute fetchmany」；
       这里一次性 fetchall 后按批切片。

    其余属性（description / close / rowcount …）原样透传给底层游标。
    """

    def __init__(self, cursor, acceptParams):
        self._cursor = cursor
        self._acceptParams = acceptParams
        self._pending = None

    def execute(self, statement, parameters=None):
        empty = parameters is None or (isinstance(parameters, (list, tuple, dict)) and not parameters)
        if empty:
            self._pending = None
            self._cursor.execute(statement)
            return
        if not self._acceptParams:
            self._pending = None
            self._cursor.execute(_inline_sql_params(statement, parameters))
            return
        self._cursor.execute(statement, parameters)

    def fetchmany(self, size=None):
        underlyingFetchmany = getattr(self._cursor, 'fetchmany', None)
        if callable(underlyingFetchmany):
            return underlyingFetchmany(size) if size is not None else underlyingFetchmany()
        if self._pending is None:
            self._pending = list(self._cursor.fetchall() or [])
        count = size if size and size > 0 else 200
        batch, self._pending = self._pending[:count], self._pending[count:]
        return batch

    def fetchall(self):
        if self._pending is not None:
            remaining, self._pending = self._pending, []
            return remaining
        return self._cursor.fetchall()

    def __getattr__(self, name):
        return getattr(self._cursor, name)


def adapt_cursor(cursor, queryTimeoutSeconds=META_QUERY_TIMEOUT_SECONDS):
    """游标缺 DB-API 能力时套一层补齐包装（JDBC 插件包装层），齐全则原样返回。

    不管走没走包装层，都顺手把 JDBC Statement 的预取行数与语句超时调好
    （见 :func:`_tune_jdbc_statement`）—— 数据字典这类几千行的查询，
    慢的不是数据库，是驱动一次 10 行的往返；而卡住的查询会拖死整个 Web 主线程。

    ``queryTimeoutSeconds=None`` 表示不设语句超时（用户自己执行的 SQL 用它，
    慢查询该由用户决定要不要等）。
    """
    if cursor is None:
        return cursor
    _tune_jdbc_statement(cursor, queryTimeoutSeconds=queryTimeoutSeconds)
    acceptsParams = _cursor_accepts_params(cursor)
    hasFetchmany = callable(getattr(cursor, 'fetchmany', None))
    if acceptsParams and hasFetchmany:
        return cursor
    return JdbcCursorAdapter(cursor, acceptsParams)


def _execute_first(conn, queries, with_error=False):
    """依次尝试候选 SQL，返回 (cursor, None) 或 (None, 最后一个异常)。

    ``with_error=True`` 时第二位改为「跑成功的那条 SQL」（调用方需要知道
    最终用的是主查询还是降级查询，例如 SQL Server 的跨库名单 → 单库名单）。
    """
    last_err = None
    for sql, params in queries:
        cursor = None
        try:
            cursor = adapt_cursor(conn.cursor())
            if params:
                cursor.execute(sql, params)
            else:
                cursor.execute(sql)
            return cursor, sql if with_error else None
        except Exception as e:
            last_err = e
            if cursor is not None:
                try:
                    cursor.close()
                except Exception:
                    pass
    return None, last_err


# ── 对象类型口径：编辑器只列表和视图 ──────────────────────────
# 数据字典里的类型写法各家不一样，这里统一成 'TABLE' / 'VIEW' / ''（空 = 不要显示）。
# [WARN] 为什么要在 Python 侧再挡一道：各方言的字典 SQL 已经过滤，但插件型数据源、
# 历史退化查询、以及未来新增的方言都可能带回来别的类型；而旧的归一逻辑是
# 「不含 VIEW 就当 TABLE」，同义词/别名/物化视图会被伪装成一张表出现在列表里
# （点开还查不到列），比不显示更误导。
OBJECT_TYPE_TABLE_TOKENS = ('TABLE', 'BASE TABLE', 'T', 'W')   # T=表，W=层次表（DB2）
OBJECT_TYPE_VIEW_TOKENS = ('VIEW', 'V')
# 明确不是「表/视图」的东西：同义词、别名、物化视图、临时表、系统视图、序列、过程、函数…
# 用户要的是「其它的对象不显示」，所以这些一律从名单和补全字典里剔除。
# 口径与对象树一致，两条特别说明：
#   * DB2 的 M（物化查询表）按物化视图处理，和 PG 一样不进名单（PG 的 relkind='m' 本来
#     就不在 pg_tables / information_schema.tables 里）；H / S 是临时表，同理剔除。
#   * MySQL 的 SYSTEM VIEW（information_schema / performance_schema 里的字典对象）剔除，
#     否则搜索会列出几十条对象树里根本没有的「视图」。
# [WARN] 单字母代码必须**全等**比较，不能当子串：'A' 是子串就会把 'BASE TABLE' 也判掉。
OBJECT_TYPE_EXCLUDED_TEXTS = (
    'SYSTEM VIEW', 'MATERIALIZED VIEW', 'SNAPSHOT', 'LOCAL TEMPORARY',
    'TEMPORARY TABLE', 'GLOBAL TEMPORARY', 'TEMP TABLE', 'TEMPORARY SEQUENCE',
    'SYNONYM', 'ALIAS', 'SEQUENCE', 'PROCEDURE', 'FUNCTION', 'PACKAGE',
    'PACKAGE BODY', 'TRIGGER', 'INDEX', 'INDEXTYPE', 'TYPE', 'DIMENSION',
    'CLUSTER', 'DB JOB', 'JAVA', 'QUEUE', 'COLLECTION', 'STREAM',
)
OBJECT_TYPE_EXCLUDED_EXACT = ('H', 'S', 'M', 'N', 'A')     # DB2：临时表 / MQT / 同义词 / 别名


def _object_kind(rawValue):
    """把数据字典的类型文本归一成 'TABLE' / 'VIEW'；不属于这两类返回 ''。

    空文本按 ``TABLE`` 处理：有些字典 SQL 本来就不带类型列（只有表名），
    不能因为缺类型信息就把对象全丢掉。
    """
    text = str(rawValue or '').strip().upper()
    if not text:
        return 'TABLE'
    if text in OBJECT_TYPE_EXCLUDED_EXACT:
        return ''
    for excluded in OBJECT_TYPE_EXCLUDED_TEXTS:
        if excluded in text:
            return ''
    if text in OBJECT_TYPE_VIEW_TOKENS or 'VIEW' in text:
        return 'VIEW'
    if text in OBJECT_TYPE_TABLE_TOKENS or 'TABLE' in text:
        return 'TABLE'
    # 认不出来的类型一律不当成表显示
    return ''


def _collect(cursor, collected, has_column=True, max_objects=None, with_catalog=False):
    """把游标里的行归并进 collected['objects']（同对象累积列名）。

    has_column=True  —— 行是 (schema?, table, column, type)
    has_column=False —— 行是 (schema, table, type)，只建对象不收列（对象名单模式）
                       with_catalog=True 时行首多一列 catalog（SQL Server 跨库名单）
    max_objects      —— 对象数上限；对象名单模式下放宽（一份名单本身很轻）
    """
    seen = {}                                  # (catalog?, schema, name) -> collected['objects'] 下标
    # 从已有结果起步：本函数会被调用多次（主名单 + 兜底名单 + 动态视图补充源），
    # 跨调用必须继续去重，否则同一对象会被重复登记。
    def _seen_key(catalog, schema, name):
        if with_catalog:
            return ((catalog or '').upper(), (schema or '').upper(), (name or '').upper())
        return ((schema or '').upper(), (name or '').upper())

    for existingEntry in collected['objects']:
        seen[_seen_key(existingEntry.get('catalog', ''),
                       existingEntry.get('schema', ''),
                       existingEntry.get('name', ''))] = len(seen)
    budget = [META_MAX_COLUMNS]                # 剩余可取行数
    max_obj = max_objects or META_MAX_TABLES
    truncated = False

    def _ensure(schema, tname, otype, catalog=''):
        """建/取对象条目，返回下标；超出对象上限返回 None。"""
        nonlocal truncated
        cacheEntryKey = _seen_key(catalog, schema, tname)
        idx = seen.get(cacheEntryKey)
        if idx is None:
            if len(collected['objects']) >= max_obj:
                truncated = True
                return None
            idx = len(collected['objects'])
            seen[cacheEntryKey] = idx
            entry = {
                'schema': schema, 'name': tname, 'type': otype, 'columns': [],
            }
            if with_catalog:
                entry['catalog'] = catalog
            collected['objects'].append(entry)
        return idx

    try:
        for row in streamRows(cursor, budget):
            catalog = ''
            if has_column:
                if isinstance(row, dict):
                    schema = _cell(row, 0, 'schema_name') or ''
                    if schema:
                        tname = _cell(row, 1, 'table_name')
                        cname = _cell(row, 2, 'column_name')
                        otype = _cell(row, 3, 'object_type')
                    else:
                        tname = _cell(row, 0, 'table_name')
                        cname = _cell(row, 1, 'column_name')
                        otype = _cell(row, 2, 'object_type')
                elif len(row) >= 4:
                    schema, tname, cname, otype = row[0], row[1], row[2], row[3]
                else:
                    schema, tname, cname, otype = '', row[0], row[1], row[2]
                cname = (str(cname) if cname is not None else '').strip()
            else:
                if with_catalog:
                    if isinstance(row, dict):
                        catalog = _cell(row, 0, 'catalog_name') or ''
                        schema = _cell(row, 1, 'schema_name') or ''
                        tname = _cell(row, 2, 'table_name')
                        otype = _cell(row, 3, 'object_type')
                    else:
                        catalog = str(row[0] or '') if len(row) >= 4 else ''
                        schema, tname, otype = (row[1] if len(row) >= 4 else ''), row[-2], row[-1]
                elif isinstance(row, dict):
                    schema = _cell(row, 0, 'schema_name') or ''
                    tname = _cell(row, 1, 'table_name')
                    otype = _cell(row, 2, 'object_type')
                else:
                    schema, tname, otype = (row[0] if len(row) >= 3 else ''), row[-2], row[-1]
                catalog = (str(catalog) if catalog is not None else '').strip()
                cname = ''

            schema = (str(schema) if schema is not None else '').strip()
            tname = (str(tname) if tname is not None else '').strip()
            if not tname:
                continue
            otype = _object_kind(otype)
            if not otype:
                # 非表/视图对象（同义词、别名、物化视图、临时表、系统视图…）不进名单
                continue
            idx = _ensure(schema, tname, otype, catalog)
            if idx is None:
                break
            if cname:
                collected['objects'][idx]['columns'].append(cname)
    finally:
        try:
            cursor.close()
        except Exception:
            pass
    if budget[0] <= 0:
        truncated = True
    collected['truncated'] = bool(collected.get('truncated')) or truncated


# ── 兜底查询：不限 owner/schema（DBA 账号自身没有对象时用）──
# [WARN] 全库扫描在 11g 上很慢（all_* 是 UNION ALL 视图），所以：
#   ① 优先 dba_objects（基表级视图，快得多；无权限会自动降级到 all_*）；
#   ② 排除 Oracle 自带 schema —— 否则 APEX_* 之类的几千个系统视图会把对象上限占满，
#      用户真正关心的业务 schema 反而进不来；
#   ③ ROWNUM 兜住上限，避免大库把内存/响应体撑爆。
_ORACLE_SYSTEM_SCHEMAS = (
    'SYS', 'SYSTEM', 'SYSMAN', 'OUTLN', 'DBSNMP', 'WMSYS', 'XDB', 'MDSYS', 'CTXSYS',
    'ORDSYS', 'ORDDATA', 'ORDPLUGINS', 'OLAPSYS', 'EXFSYS', 'ANONYMOUS', 'APEX_PUBLIC_USER',
    'FLOWS_FILES', 'LBACSYS', 'DVSYS', 'AUDSYS', 'GSMADMIN_INTERNAL', 'OJVMSYS', 'ORACLE_OCM',
    'PUBLIC', 'MDDATA', 'TSMSYS', 'DIP', 'XDBPM', 'XS$NULL', 'APPQOSSYS',
    'SI_INFORMTN_SCHEMA', 'SPATIAL_CSW_ADMIN_USR', 'SPATIAL_WFS_ADMIN_USR',
    'REMOTE_SCHEDULER_AGENT', 'MGMT_VIEW', 'PERFSTAT',
)
_SYS_IN = ', '.join("'%s'" % s for s in _ORACLE_SYSTEM_SCHEMAS)
_ORACLE_SCOPE_FILTER = (
    " AND c.owner NOT IN (%s) AND c.owner NOT LIKE 'APEX%%' AND c.owner NOT LIKE 'FLOWS%%'" % _SYS_IN
)

_MYSQL_SYS_SCHEMAS = "('mysql', 'information_schema', 'performance_schema', 'sys', 'oceanbase')"

# ══════════════════════════════════════════════════════════════
#  仅取「对象名单」（不带列）—— 兜底场景用
# ══════════════════════════════════════════════════════════════
# 实测（11g / 16 万列的环境）：耗时几乎只和「取回多少行」成正比（≈0.18ms/行），
# 取 6 万列要 7~10 秒，取 16.8 万列要 30 秒以上；而只取对象名单只要 2~4 秒。
# 所以「全部可访问对象」的兜底只拿名单，列等用户真正敲到 `表名.` 时再按需补。
#
# [WARN] 必须 ORDER BY：否则取回的物理顺序可能被某个大 schema 独占，
# 用户真正关心的 schema 一个都进不来。
_OBJECT_LIST_SQL = {
    'oracle': (
        "SELECT * FROM ("
        "  SELECT c.owner AS schema_name, c.object_name AS table_name, c.object_type AS object_type "
        "    FROM %s c WHERE c.object_type IN ('TABLE', 'VIEW')%s"
        "   ORDER BY c.owner, c.object_name"
        ") WHERE ROWNUM <= %d"),
    'dm': (
        "SELECT * FROM ("
        "  SELECT c.owner AS schema_name, c.object_name AS table_name, c.object_type AS object_type "
        "    FROM %s c WHERE c.object_type IN ('TABLE', 'VIEW')%s"
        "   ORDER BY c.owner, c.object_name"
        ") WHERE ROWNUM <= %d"),
    'yashandb': (
        "SELECT * FROM ("
        "  SELECT c.owner AS schema_name, c.object_name AS table_name, c.object_type AS object_type "
        "    FROM sys.%s c WHERE c.object_type IN ('TABLE', 'VIEW')%s"
        "   ORDER BY c.owner, c.object_name"
        ") WHERE ROWNUM <= %d"),
    'mysql': (
        "SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, TABLE_TYPE AS object_type "
        "  FROM information_schema.TABLES "
        " WHERE TABLE_SCHEMA NOT IN %s "
        " ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT %%d" % _MYSQL_SYS_SCHEMAS),
    'postgresql': (
        "SELECT table_schema AS schema_name, table_name AS table_name, table_type AS object_type "
        "  FROM information_schema.tables "
        " WHERE table_schema NOT IN ('pg_catalog', 'information_schema') "
        " ORDER BY table_schema, table_name LIMIT %d"),
    'sqlserver': (
        "SELECT TOP %d TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, TABLE_TYPE AS object_type "
        "  FROM INFORMATION_SCHEMA.TABLES "
        " WHERE TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')%s "
        " ORDER BY TABLE_SCHEMA, TABLE_NAME"),
    'clickhouse': (
        "SELECT database AS schema_name, name AS table_name, "
        "       CASE WHEN engine LIKE '%%View' THEN 'VIEW' ELSE 'TABLE' END AS object_type "
        "  FROM system.tables WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') "
        " ORDER BY database, name LIMIT %d"),
    'db2': (
        "SELECT TABSCHEMA AS schema_name, TABNAME AS table_name, TYPE AS object_type "
        "  FROM SYSCAT.TABLES WHERE TABSCHEMA NOT LIKE 'SYS%' ORDER BY TABSCHEMA, TABNAME"),
}
_OBJECT_LIST_SQL.update(dict.fromkeys(MYSQL_FAMILY, _OBJECT_LIST_SQL['mysql']))
_OBJECT_LIST_SQL.update(dict.fromkeys(PG_FAMILY, _OBJECT_LIST_SQL['postgresql']))
_OWNER_SYSTEM_SCHEMAS = {
    'oracle': _ORACLE_SCOPE_FILTER,
    # 达梦/崖山的系统用户名：放开范围时同样要排除，否则名单被系统对象占满
    'dm': " AND c.owner NOT IN ('SYS', 'SYSDBA', 'SYSAUDITOR', 'SYSSSO', 'SYSSEC', 'SYSCONSTRAINT')",
    'yashandb': " AND c.owner NOT IN ('SYS', 'SYSDBA')",
}


def _sqlserver_catalog_filter(database):
    """把库名（catalog）安全地写成 TABLE_CATALOG / name 过滤条件；不合格返回 None。"""
    return _lit(database, "'")


def _sqlserver_first_text(conn, sql, params=None):
    """跑一条只返回单格文本的查询（SCHEMA_NAME() / DB_NAME() 这类）。失败返回 ''。"""
    cursor = None
    try:
        cursor = adapt_cursor(conn.cursor())
        if params:
            cursor.execute(sql, params)
        else:
            cursor.execute(sql)
        row = cursor.fetchone()
        value = _cell(row, 0, 'cur_schema') if row else None
        if value is None and row is not None:
            try:
                value = row[0]
            except (TypeError, IndexError):
                value = None
        return str(value or '').strip()
    except Exception:
        return ''
    finally:
        if cursor is not None:
            try:
                cursor.close()
            except Exception:
                pass


def _sqlserver_current_catalog(conn):
    """连接当前落在哪个库；跨库名单要先把它排到最前面。"""
    return _sqlserver_first_text(conn, "SELECT DB_NAME() AS cur_schema")


def _sqlserver_object_catalogs(conn, limit=None):
    """实例上可查的库名单（在线、已附加），当前库排第一；最多 limit 个。

    没权限的库 / 脱机的库在 sys.databases 里查得到但读不到它的元数据，
    跨库 UNION 会整条失败，所以按 name 过滤成当前用户可访问的那批。
    返回 ``(catalogs, capped)``，capped 表示实例上的库比 limit 多（名单不完整）。
    """
    limit = limit or SQLSERVER_MAX_SEARCH_CATALOGS
    sql = ("SELECT DB_NAME() AS current_catalog, name AS catalog_name "
           "  FROM sys.databases WHERE database_id <= %d AND state = 0 "
           "   AND name NOT IN ('model', 'tempdb') "
           "   AND (HAS_DBACCESS(name) = 1 OR name = DB_NAME()) "
           " ORDER BY CASE WHEN name = DB_NAME() THEN 0 ELSE 1 END, name" % limit)
    cursor = None
    catalogs = []
    current = ''
    try:
        cursor = adapt_cursor(conn.cursor())
        cursor.execute(sql)
        for row in cursor.fetchall():
            if isinstance(row, dict):
                current = current or str(_cell(row, 1, 'current_catalog') or '')
                name = _cell(row, 2, 'catalog_name')
            else:
                current = current or str(row[0] or '')
                name = row[1] if len(row) > 1 else None
            name = str(name or '').strip()
            if name and name not in catalogs:
                catalogs.append(name)
    except Exception:
        # HAS_DBACCESS 不可用（老版本 / 权限不足）时退一步：只给当前库，
        # 至少「全部」不会像之前那样一条对象都搜不到。
        current = current or _sqlserver_current_catalog(conn)
        catalogs = [current] if current else []
    finally:
        if cursor is not None:
            try:
                cursor.close()
            except Exception:
                pass
    keep = [c for c in catalogs if _sqlserver_catalog_filter(c)][:limit]
    return keep, len(catalogs) > len(keep)


def _sqlserver_catalog_branch_sql(catalog):
    """某个库的对象名单片段（带 catalog 列，用于跨库 UNION ALL）。"""
    quoted = _sqlserver_catalog_filter(catalog)
    if not quoted:
        return ''
    bracket = '[%s]' % catalog.replace(']', ']]')
    return ("SELECT %s AS catalog_name, s.name AS schema_name, o.name AS table_name, "
            "       CASE o.type WHEN 'V' THEN 'VIEW' ELSE 'BASE TABLE' END AS object_type "
            "  FROM %s.sys.objects o JOIN %s.sys.schemas s ON s.schema_id = o.schema_id "
            " WHERE o.type IN ('U', 'V') AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA')"
            % (quoted, bracket, bracket))


def _sqlserver_union_sql(branches):
    """把若干片段拼成一条带 catalog 列的名单查询。"""
    return ("SELECT TOP %d * FROM (%s) AS objs ORDER BY catalog_name, schema_name, table_name"
            % (META_MAX_OBJECTS_ONLY, ' UNION ALL '.join(branches)))


# 只查「当前 catalog」但带 catalog 列的名单：与跨库那份同构（4 列），
# 跨库 SQL 跑不了（老版本 / 没权限）时用它降级，对象仍知道自己挂在哪个库节点下，
# 前端不会因为「没选库」而丢掉执行目标。
_SQLSERVER_CURRENT_CATALOG_LIST_SQL = (
    "SELECT TOP %d DB_NAME() AS catalog_name, TABLE_SCHEMA AS schema_name, "
    "       TABLE_NAME AS table_name, TABLE_TYPE AS object_type "
    "  FROM INFORMATION_SCHEMA.TABLES "
    " WHERE TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA') "
    "   AND TABLE_CATALOG = DB_NAME() "
    " ORDER BY TABLE_SCHEMA, TABLE_NAME")


def _sqlserver_current_catalog_list_queries():
    return [(_SQLSERVER_CURRENT_CATALOG_LIST_SQL % META_MAX_OBJECTS_ONLY, [])]


def _sqlserver_cross_catalog_list_queries(conn, database, out=None):
    """跨库对象名单：当前连接会话看不到别的库的 INFORMATION_SCHEMA，
    所以按库名单在 SQL 里展开成 UNION ALL（每段各查各的元数据）。

    输出比单库名单多一列 catalog，前端据此把对象挂回它自己的库节点。
    返回 ``(主查询, 降级查询)``：降级查询是「当前 catalog 的名单」（同构、带 catalog 列），
    跨库 SQL 在老版本 / 权限不够时整条失败就用它。
    ``out`` 是可选的字典，回填 ``catalogs`` / ``capped`` 给调用方写范围说明。
    """
    catalogs, capped = _sqlserver_object_catalogs(conn)
    catalogs = [c for c in catalogs if _sqlserver_catalog_filter(c)]
    if database:
        catalogs = [database] + [c for c in catalogs if c.lower() != database.lower()]
    if out is not None:
        out['catalogs'] = catalogs
        out['capped'] = capped
    branches = [b for b in (_sqlserver_catalog_branch_sql(c) for c in catalogs) if b]
    if not branches:
        return [], _sqlserver_current_catalog_list_queries()
    if len(branches) == 1:
        # 只有一个可见库（只有 master / 其余库无权限）：查当前 catalog 的名单即可，
        # 而且不必拼三段式名字，DB_NAME() 版本更稳。
        return _sqlserver_current_catalog_list_queries(), []
    # 段与段之间用 UNION ALL；整体按 catalog / schema / name 排序后截断
    return [(_sqlserver_union_sql(branches), [])], _sqlserver_current_catalog_list_queries()


def _object_list_queries(dialect, database):
    """只取对象名单（表/视图名 + 类型），不带列。快得多，用于「放开范围」的兜底。"""
    sqlTemplate = _OBJECT_LIST_SQL.get(dialect)
    if not sqlTemplate:
        return []

    if dialect in OWNER_FAMILY:
        if database:
            scope = " AND c.owner = :1" if dialect == 'oracle' else " AND c.owner = ?"
            params = [database]
        else:
            scope = _OWNER_SYSTEM_SCHEMAS.get(dialect, '')
            params = []
        # 崖山字典视图带 SYS. 前缀且 dba_objects 不一定授权，先试 all_objects
        views = ('all_objects', 'dba_objects') if dialect == 'yashandb' \
            else ('dba_objects', 'all_objects')
        return [(sqlTemplate % (view, scope, META_MAX_OBJECTS_ONLY), params) for view in views]

    if dialect == 'sqlserver':
        # SQL Server 的 INFORMATION_SCHEMA 只有「当前库」视角：
        #   * 指定了库 → 按该 catalog 收口（与对象树 /objects 同一口径）；
        #   * 没指定库 → 不能停在登录默认库（一般是 master，业务表一条都没有），
        #     由调用方给出跨库名单（见 _sqlserver_cross_catalog_list_queries）。
        # 库名走 _lit 内联而不是绑定参数：JDBC 包装层的游标不支持参数绑定，
        # 占位符已经在模板里代入过一次，再带参数会被判「参数个数与占位符不匹配」。
        scope = ''
        if database:
            catalog = _sqlserver_catalog_filter(database)
            if catalog:
                scope = ' AND TABLE_CATALOG = %s' % catalog
        return [(sqlTemplate % (META_MAX_OBJECTS_ONLY, scope), [])]

    if dialect == 'db2':
        # DB2 的「库」维度是 catalog（连接串里的 database），不是 schema。
        # 连接已经落到目标库，名单模式不要再按 TABSCHEMA = database 过滤，
        # 否则把库名当 schema 查，一条都查不到；列全部非 SYS schema 即可。
        return [(sqlTemplate, [])]

    if dialect == 'clickhouse':
        q = _lit(database, "'")
        if q:
            return [("SELECT database AS schema_name, name AS table_name, "
                     "       CASE WHEN engine LIKE '%%View' THEN 'VIEW' ELSE 'TABLE' END AS object_type "
                     "  FROM system.tables WHERE database = %s ORDER BY name" % q, [])]

    if dialect in MYSQL_FAMILY and database:
        # MySQL 的名单模板默认扫全实例；指定了库就按库收口，
        # 否则大实例的 20k 上限可能先把当前库截掉，对象搜索就查不到本库的表。
        return [(
            "SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, "
            "       TABLE_TYPE AS object_type "
            "  FROM information_schema.TABLES "
            " WHERE TABLE_SCHEMA = %s "
            " ORDER BY TABLE_NAME LIMIT " + str(META_MAX_OBJECTS_ONLY),
            [database])]

    return [(sqlTemplate % META_MAX_OBJECTS_ONLY, [])]


# ── 对象名单的「补充源」──
# Oracle 的动态性能视图（V$SESSION / GV$SQL / ...）在数据字典里是 **PUBLIC SYNONYM**，
# 类型既不是 TABLE 也不是 VIEW，而且 V_$ 底表属于 SYS（会被系统 schema 过滤掉），
# 所以只查 dba_objects 永远提示不到它们 —— 必须单独从 v$fixed_table 取名单。
_DYN_VIEW_SQL_ORACLE = (
    "SELECT 'SYS' AS schema_name, f.name AS table_name, 'VIEW' AS object_type "
    "  FROM v$fixed_table f WHERE f.name LIKE 'V$%' OR f.name LIKE 'GV$%'")
_DYN_VIEW_SQL_DM = (
    "SELECT 'SYS' AS schema_name, f.name AS table_name, 'VIEW' AS object_type "
    "  FROM v$dynamic_tables f WHERE f.name LIKE 'V$%'")


def _extra_object_queries(dialect):
    """除主名单外还要补充的对象来源（Oracle 系为动态性能视图）。"""
    if dialect == 'oracle':
        return [(_DYN_VIEW_SQL_ORACLE, [])]
    if dialect in ('yashandb', 'dm'):
        return [(_DYN_VIEW_SQL_DM, []), (_DYN_VIEW_SQL_ORACLE, [])]
    return []


# ══════════════════════════════════════════════════════════════
#  只取指定表的列（前端敲到 `表名.` 时按需补）
# ══════════════════════════════════════════════════════════════

def _expand_dyn_names(names):
    """`V$SESSION` / `GV$SQL` 是 PUBLIC SYNONYM，列要去底表 `V_$SESSION` / `GV_$SQL` 里查。

    返回 (查询用名字列表, {大写查询名: 原始请求名})，后者用于把结果名还原成用户看到的写法
    —— 包括带模式前缀的 `public.emp`：查询里只用裸表名，但还原后前端才能和树里的限定名对上。
    """
    queryNames, nameBackmap = [], {}
    for rawName in (names or []):
        requestedName = (rawName or '').strip()
        if not requestedName:
            continue
        if requestedName.upper() not in nameBackmap:
            queryNames.append(requestedName)
            nameBackmap[requestedName.upper()] = requestedName
        bareName = requestedName.rsplit('.', 1)[-1].upper()
        if bareName and bareName != requestedName.upper():
            nameBackmap.setdefault(bareName, requestedName)               # 裸名 → 原始限定名
        dynViewMatch = re.match(r'^([Gg]?[Vv])\$(.+)$', requestedName)
        if dynViewMatch:
            underlyingName = '%s_$%s' % (dynViewMatch.group(1), dynViewMatch.group(2))
            if underlyingName.upper() not in nameBackmap:
                queryNames.append(underlyingName)
                nameBackmap[underlyingName.upper()] = requestedName
    return queryNames, nameBackmap


def _table_column_queries(dialect, database, tables):
    """tables: 表名列表（可带 schema 前缀）；返回只查这些表列的候选 SQL。

    [WARN] database 为空时**不加 owner/schema 条件**：兜底模式下前端只知道表名（甚至可能
    来自不同 owner），锁死 owner 会一条都查不到。
    """
    # 表名可能带 schema 前缀（SCOTT.EMP / public.emp），这里只取裸表名，
    # 前缀交给 database 参数表达 —— 避免各库拼 (owner, table) 元组的占位符地狱。
    names = []
    for t in (tables or []):
        t = (t or '').strip()
        if not t:
            continue
        bare = t.rsplit('.', 1)[-1]
        if bare and bare not in names:
            names.append(bare)
    if not names:
        return []

    if dialect == 'oracle':
        base = 1
        params = []
        where = ''
        if database:
            where = 'owner = :1 AND '
            params.append(database)
            base = 2
        placeholders = ', '.join(':%d' % (base + i) for i in range(len(names)))
        params.extend(names)
        return [
            ("SELECT table_name AS table_name, column_name AS column_name, "
             "       'TABLE' AS object_type "
             "  FROM %s WHERE %stable_name IN (%s) "
             " ORDER BY table_name, column_id" % (view, where, placeholders), list(params))
            for view in ('dba_tab_columns', 'all_tab_columns')
        ]

    if dialect in ('dm', 'yashandb'):
        prefix = 'sys.' if dialect == 'yashandb' else ''
        params = []
        where = ''
        if database:
            where = 'owner = ? AND '
            params.append(database)
        placeholders = ', '.join(['?'] * len(names))
        params.extend(names)
        return [
            ("SELECT table_name AS table_name, column_name AS column_name, "
             "       'TABLE' AS object_type "
             "  FROM %s%s WHERE %stable_name IN (%s) "
             " ORDER BY table_name, column_id" % (prefix, view, where, placeholders), list(params))
            for view in ('ALL_TAB_COLUMNS', 'DBA_TAB_COLUMNS')
        ]

    if dialect in MYSQL_FAMILY:
        placeholders = ', '.join(['%s'] * len(names))
        if database:
            return [(
                "SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, 'TABLE' AS object_type "
                "  FROM information_schema.COLUMNS "
                " WHERE TABLE_SCHEMA = %%s AND TABLE_NAME IN (%s) "
                " ORDER BY TABLE_NAME, ORDINAL_POSITION" % placeholders,
                [database] + names)]
        return [(
            "SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, 'TABLE' AS object_type "
            "  FROM information_schema.COLUMNS "
            " WHERE TABLE_SCHEMA NOT IN %s "
            "   AND TABLE_NAME IN (%s) ORDER BY TABLE_NAME, ORDINAL_POSITION"
            % (_MYSQL_SYS_SCHEMAS, placeholders),
            list(names))]

    if dialect in PG_FAMILY:
        # 连接串已经选定了库，information_schema 天然只含该库；
        # 这里的 database 是**库名**而不是模式名，拿来当 table_schema 过滤会一条都查不到，
        # 所以只按表名过滤（限定名由调用方在表名里带 schema.xxx，结果名再还原回去）。
        placeholders = ', '.join(['%s'] * len(names))
        return [(
            "SELECT table_name AS table_name, column_name AS column_name, 'TABLE' AS object_type "
            "  FROM information_schema.columns "
            " WHERE table_schema NOT IN ('pg_catalog', 'information_schema') "
            "   AND table_name IN (%s) ORDER BY table_name, ordinal_position" % placeholders,
            list(names))]

    if dialect == 'sqlserver':
        placeholders = ', '.join(['?'] * len(names))
        return [(
            "SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, 'TABLE' AS object_type "
            "  FROM INFORMATION_SCHEMA.COLUMNS "
            " WHERE TABLE_NAME IN (%s) ORDER BY TABLE_NAME, ORDINAL_POSITION" % placeholders, list(names))]

    if dialect == 'clickhouse':
        # JDBC 包装只能拼字面量：表名先过 _lit，不过就放弃这次补列（前端退化成无列提示）
        collected = []
        for requestedName in names:
            qt, qd = _lit(requestedName, "'"), _lit(database, "'") if database else None
            if not qt:
                continue
            cond = "database = %s AND " % qd if qd else "database NOT IN ('system') AND "
            collected.append((
                "SELECT table AS table_name, name AS column_name, 'TABLE' AS object_type "
                "  FROM system.columns WHERE %stable = %s ORDER BY position" % (cond, qt), []))
        return collected

    if dialect == 'db2':
        collected = []
        for requestedName in names:
            qt = _lit(requestedName.upper(), "'")
            qd = _lit((database or '').upper(), "'")
            if not qt:
                continue
            cond = "TABSCHEMA = %s AND " % qd if qd else "TABSCHEMA NOT LIKE 'SYS%' AND "
            collected.append((
                "SELECT TABNAME AS table_name, COLNAME AS column_name, 'TABLE' AS object_type "
                "  FROM SYSCAT.COLUMNS WHERE %sTABNAME = %s ORDER BY COLNO" % (cond, qt), []))
        return collected

    return []


def _resolve_scope(conn, dialect, database):
    """database 为空 → 查当前 schema 作为 owner/schema。"""
    if database:
        return database, None
    sql = _CURRENT_SCHEMA_SQL.get(dialect)
    if not sql:
        return '', None
    try:
        cursor = conn.cursor()
        try:
            cursor.execute(sql)
            row = cursor.fetchone()
            val = _cell(row, 0, 'cur_schema') if row else None
            return (val or ''), None
        finally:
            try:
                cursor.close()
            except Exception:
                pass
    except Exception as e:
        return '', str(e)


def datasource_identity(db_info):
    """元数据缓存与字典连接池共用的数据源标识：优先实例 ID，退到主机地址。

    缓存失效（改了数据源配置）按这个值匹配，所以两边必须用同一个口径，
    不要一个用 id、另一个用 host。
    """
    db_info = db_info or {}
    return str(db_info.get('instance_id') or db_info.get('id') or db_info.get('host', '') or '')


def cache_key(db_info, database, mode, tables):
    """缓存键：数据源 + 目标库 + 模式；OceanBase 还要区分租户。"""
    return '|'.join([
        datasource_identity(db_info),
        normalize_db_type(db_info.get('db_type', '')),
        str(db_info.get('host', '')), str(db_info.get('port', '')),
        str(db_info.get('user', '')), str(db_info.get('tenant', '') or ''),
        (database or ''), mode,
        ','.join(sorted(t for t in (tables or []) if t)),
    ])


def invalidate_cache(instance_id=None):
    """丢掉元数据缓存：指定数据源就只清它自己，不指定就全清（测试/排障）。

    对象树、执行目标下拉、补全字典都带着 TTL 缓存，数据源被改名、改密码、
    换主机之后不能让用户等 TTL 到点才看到新结果。
    """
    target = str(instance_id or '')
    for cacheEntryKey in [key for key in list(_meta_cache)
                          if not target or key.partition('|')[0] == target]:
        _meta_cache.pop(cacheEntryKey, None)


def load_metadata(db_info, db_type, database, force=False, objects_only=False,
                  tables=None, conn_opener=None):
    """拉取某数据源的对象元数据（表/视图 + 列名），带 TTL 缓存。

    三种模式（按代价从低到高）：
      * ``tables=[...]``  只取这几张表的列（前端敲到 ``表名.`` 时按需补，毫秒级）；
      * ``objects_only``  只取对象名单、不带列（大范围兜底用，秒级）；
      * 默认              对象 + 全部列（指定了 owner/schema 时用，范围小所以快）。

    ``conn_opener(db_info, db_type, database) -> (conn, fetch_mode)`` 由调用方注入；
    web 层传 ``modules.web.app._open_editor_conn``（延迟取，避免与 app 形成 import 环）。

    返回::

        {
          'ok': bool, 'db_type': str, 'database': str, 'scope': str, 'mode': str,
          'objects': [{'schema': str, 'name': str, 'type': 'TABLE'|'VIEW',
                       'columns': [str, ...]}, ...],
          'object_count': int, 'column_count': int,
          'truncated': bool, 'elapsed_ms': int, 'cached': bool,
          'fallback_all': bool, 'error': str|None,
        }
    """
    dialect = normalize_db_type(db_type or db_info.get('db_type', ''))
    database = (database or '').strip()
    tables = [t.strip() for t in (tables or []) if t and t.strip()]
    mode = 'columns' if tables else ('objects' if objects_only else 'full')

    now = time.time()
    key = cache_key(db_info, database, mode, tables)
    if not force:
        hit = _meta_cache.get(key)
        if hit and now - hit[0] < META_CACHE_TTL:
            payload = dict(hit[1])
            payload['cached'] = True
            return payload

    startedAt = now
    collected = {
        'ok': False, 'db_type': dialect, 'database': database, 'scope': '',
        'objects': [], 'object_count': 0, 'column_count': 0,
        'truncated': False, 'elapsed_ms': 0, 'cached': False,
        'error': None, 'scope_error': None, 'fallback_all': False, 'mode': mode,
        'scope_capped': False,
    }

    # 跨 catalog 的名单（SQL Server「全部」）多一列库名，去重要按 (库, schema, 名)
    withCatalog = False
    crossFallback = None
    queries = []
    has_column = True
    if mode == 'columns':
        # V$/GV$ 同义词要展开成底表名去查列，查完再把名字还原回用户看到的写法
        tables_q, back_map = _expand_dyn_names(tables)
        queries = _table_column_queries(dialect, database, tables_q)
    elif mode == 'full':
        queries = _metadata_queries(dialect, database)
    else:
        has_column = False

    opener = conn_opener or _default_conn_opener()
    if opener is None:
        collected['error'] = 'SQL 编辑器连接入口不可用'
        collected['elapsed_ms'] = int((time.time() - startedAt) * 1000)
        return collected

    conn = None
    try:
        conn, _fetch_mode = opener(db_info, db_type, database)
        if conn is None:
            collected['error'] = '无法建立连接（%s）' % (db_type or '未知')
            collected['elapsed_ms'] = int((time.time() - startedAt) * 1000)
            return collected

        scope, scope_err = _resolve_scope(conn, dialect, database)
        collected['scope'] = scope
        if scope_err:
            # 解析不出「当前 schema」不算致命：继续用原 database 查，
            # 查不到就是"只有关键字提示"，不影响用户正常写 SQL。
            collected['scope_error'] = scope_err

        if mode == 'full' and not database:
            # 用解析出的 scope 重算参数（database 为空时）
            queries = _metadata_queries(dialect, scope)
        elif mode == 'objects' and not queries:
            if dialect == 'sqlserver' and not database:
                # 「全部」范围不能只扫当前 catalog：不指定库时连接落在登录默认库
                # （通常是 master），业务表/视图一条都进不了名单，搜索自然查不到。
                crossInfo = {}
                crossQueries, crossFallback = _sqlserver_cross_catalog_list_queries(
                    conn, database, crossInfo)
                if crossQueries:
                    # 主查询与降级查询同构（都带 catalog 列），取数方式一致
                    withCatalog = True
                    # 降级查询排在主查询之后：跨库 SQL 在老版本 / 权限不够时整条失败，
                    # 退到「当前 catalog 名单」，至少本库的表视图还能搜到。
                    queries = list(crossQueries) + list(crossFallback or [])
                    if len(crossInfo.get('catalogs') or []) > 1:
                        collected['scope'] = '实例内 %d 个库' % len(crossInfo['catalogs'])
                        collected['scope_capped'] = bool(crossInfo.get('capped'))
            else:
                queries = _object_list_queries(dialect, database)

        if not queries:
            collected['error'] = '当前数据库类型暂不支持对象提示（%s）' % (db_type or '未知')
            collected['elapsed_ms'] = int((time.time() - startedAt) * 1000)
            return collected

        if mode == 'full':
            cursor, last_err = _execute_first(conn, queries)
            if cursor is None:
                collected['error'] = '查询数据字典失败: %s' % last_err
                collected['elapsed_ms'] = int((time.time() - startedAt) * 1000)
                return collected
            _collect(cursor, collected, has_column=True)

            # ── 兜底：未指定 owner/schema 且当前范围内一个对象都没有 → 放开范围 ──
            # 只取「对象名单」不带列 —— 带列会让 16 万列的环境卡 30 秒以上；
            # 列由前端敲到 `表名.` 时按需补。
            if not database and not collected['objects'] and not collected['truncated']:
                if dialect == 'sqlserver':
                    # SQL Server 放开范围 = 查当前 catalog（带 catalog 列，和补全的
                    # 跨库名单同一取数方式）；模板里的 %s 未指定库时不能直接代入。
                    fallbackQueries = _sqlserver_current_catalog_list_queries()
                else:
                    fallbackQueries = _object_list_queries(dialect, '')
                if fallbackQueries:
                    fallbackCursor, _err2 = _execute_first(conn, fallbackQueries)
                    if fallbackCursor is not None:
                        _collect(fallbackCursor, collected, has_column=False,
                                 max_objects=META_MAX_OBJECTS_ONLY,
                                 with_catalog=dialect == 'sqlserver')
                        collected['fallback_all'] = True
                        collected['scope'] = (scope + ' → 全部可访问对象') if scope else '全部可访问对象'

            # ── 补充源：动态性能视图（未指定 owner 时才补）──
            # V$/GV$ 是 PUBLIC SYNONYM、底表属于 SYS，主名单里永远不会有它们。
            if not database:
                for extraSql, extraParams in _extra_object_queries(dialect):
                    extraCursor = None
                    try:
                        extraCursor = conn.cursor()
                        if extraParams:
                            extraCursor.execute(extraSql, extraParams)
                        else:
                            extraCursor.execute(extraSql)
                    except Exception:
                        if extraCursor is not None:
                            try:
                                extraCursor.close()
                            except Exception:
                                pass
                        continue
                    _collect(extraCursor, collected, has_column=False, max_objects=META_MAX_OBJECTS_ONLY)
        else:
            cursor, usedSql = _execute_first(conn, queries, with_error=True)
            if cursor is None:
                collected['error'] = '查询数据字典失败: %s' % usedSql
                collected['elapsed_ms'] = int((time.time() - startedAt) * 1000)
                return collected
            if mode == 'objects':
                # 名单模式的上限必须和 SQL 里的 LIMIT 一致（20k），
                # 否则 _collect 会按补全的 3000 上限提前截断，对象搜索就少了一大截。
                _collect(cursor, collected, has_column=False,
                         max_objects=META_MAX_OBJECTS_ONLY, with_catalog=withCatalog)
                if crossFallback and usedSql == crossFallback[0][0]:
                    # 跨库名单没跑成、用的是「当前 catalog 名单」：范围要说清楚
                    collected['scope'] = _sqlserver_current_catalog(conn)
            else:
                _collect(cursor, collected, has_column=has_column)
            if mode == 'columns':
                for o in collected['objects']:
                    cacheEntryKey = (o.get('name') or '').upper()
                    if back_map.get(cacheEntryKey):
                        o['name'] = back_map[cacheEntryKey]

        collected['object_count'] = len(collected['objects'])
        collected['column_count'] = sum(len(o['columns']) for o in collected['objects'])
        collected['ok'] = True
    except Exception as e:
        collected['error'] = '%s: %s' % (type(e).__name__, e)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    collected['elapsed_ms'] = int((time.time() - startedAt) * 1000)
    if collected['ok']:
        _meta_cache[key] = (time.time(), dict(collected))
        # 顺带清掉过期项，避免长期运行堆积
        if len(_meta_cache) > 64:
            expiredKeys = [cacheEntryKey for cacheEntryKey, cacheEntry in _meta_cache.items()
                           if time.time() - cacheEntry[0] > META_CACHE_TTL]
            for cacheEntryKey in expiredKeys:
                _meta_cache.pop(cacheEntryKey, None)
    return collected


# ══════════════════════════════════════════════════════════════
#  schema（模式）名单：三层模型数据源的「库 → 模式 → 对象」中间层
# ══════════════════════════════════════════════════════════════
# 只有连接串就能定位到库、且库里还有模式概念的方言才有意义：
#   PG 系   → pg_namespace
#   SQL Server → INFORMATION_SCHEMA.SCHEMATA
#   Oracle / DM / 崖山 → 「数据库」维度本身就是 owner，模式与用户同名，直接给 all_users
#   其余（MySQL 库即模式、Redis/Mongo 无模式）→ 返回空 + reason，前端隐藏模式选择器
_SCHEMA_SQL = {
    'postgresql': ("SELECT nspname AS schema_name FROM pg_namespace "
                   "WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' "
                   "ORDER BY nspname", []),
    'sqlserver': ("SELECT SCHEMA_NAME AS schema_name FROM INFORMATION_SCHEMA.SCHEMATA "
                  "ORDER BY SCHEMA_NAME", []),
    'oracle': ("SELECT username AS schema_name FROM all_users ORDER BY username", []),
    'dm': ("SELECT username AS schema_name FROM all_users ORDER BY username", []),
    'yashandb': ("SELECT username AS schema_name FROM sys.all_users ORDER BY username", []),
}
_SCHEMA_SQL.update(dict.fromkeys(PG_FAMILY, _SCHEMA_SQL['postgresql']))

_SCHEMA_UNSUPPORTED_REASON = {
    'mysql': 'MySQL 系「库即模式」，不需要单独选模式',
    'tidb': 'TiDB 系「库即模式」，不需要单独选模式',
    'mariadb': 'MariaDB 系「库即模式」，不需要单独选模式',
    'oceanbase': 'OceanBase MySQL 租户「库即模式」，不需要单独选模式',
    'tdsqlc_mysql': 'TDSQL-C MySQL「库即模式」，不需要单独选模式',
    'clickhouse': 'ClickHouse 以库分层，无独立模式概念',
    'redis': 'Redis 无模式概念',
    'mongodb': 'MongoDB 为「库 → 集合」两层',
    'gbase': 'GBase 8s 未在编辑器树中展开模式层',
}


def list_schemas(db_info, db_type, database, conn_opener=None):
    """返回 (schemas, reason)。失败不抛异常：拿不到模式名单只影响工具栏的模式选择器。"""
    dialect = normalize_db_type(db_type or db_info.get('db_type', ''))
    if dialect in _SCHEMA_UNSUPPORTED_REASON:
        return [], _SCHEMA_UNSUPPORTED_REASON[dialect]
    entry = _SCHEMA_SQL.get(dialect)
    if not entry:
        return [], '当前数据库类型暂不支持模式列表（%s）' % (dialect or '未知')

    opener = conn_opener or _default_conn_opener()
    if opener is None:
        return [], 'SQL 编辑器连接入口不可用'
    conn = None
    try:
        conn, _fetch_mode = opener(db_info, db_type, database)
        if conn is None:
            return [], '无法建立连接（%s）' % (dialect or db_type)
        sql, params = entry
        cursor = adapt_cursor(conn.cursor())
        try:
            if params:
                cursor.execute(sql, params)
            else:
                cursor.execute(sql)
            rows = cursor.fetchall()
        finally:
            try:
                cursor.close()
            except Exception:
                pass
        schemaNames = []
        for row in rows:
            cellValue = _cell(row, 0, 'schema_name')
            if cellValue and str(cellValue) not in schemaNames:
                schemaNames.append(str(cellValue))
        return sorted(schemaNames), None
    except Exception as failure:
        return [], '%s: %s' % (type(failure).__name__, failure)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


# ══════════════════════════════════════════════════════════════
#  对象快速搜索（SQL 编辑器 Ctrl+K）
# ══════════════════════════════════════════════════════════════
# 搜索只过滤 load_metadata 已经缓存好的「对象名单」，每敲一个字都不再连库：
#   * 第一次搜索可能等 2~4 秒（大库的数据字典），之后走 300s TTL 缓存；
#   * 不带通配符时按「包含」匹配，_ 按字面处理（表名里的下划线很常见）；
#   * 带 % / * 时进入通配符模式，% 和 * = 任意串，_ 和 ? = 单个字符；
#   * 排序：精确名 > 前缀 > 包含 > 限定名命中，同档按 schema / name 排序。
# PG / DB2 的「全部」仍然只能覆盖当前连接库：跨库必须重新建连，
# 这里不能静默扫，返回 scope_limited 让前端把范围说清楚。
# SQL Server 走的是另一条路：不指定库时用 sys.objects 拼一份跨 catalog 名单
# （见 _sqlserver_cross_catalog_list_queries），所以它的 scope_limited 是
# 「最多扫前 SQLSERVER_MAX_SEARCH_CATALOGS 个库」，而不是只能看当前库。

# SQL Server 不在这里：它的「全部」走跨 catalog UNION 名单（见
# _sqlserver_cross_catalog_list_queries），不再只能看当前连接库。
_CROSS_DATABASE_UNSUPPORTED = set(PG_FAMILY) | {'db2'}
_SCHEMA_IS_DATABASE = set(MYSQL_FAMILY) | {'clickhouse'}


def _search_regex(query):
    """返回 (正则, 是否通配符模式)；空查询返回 (None, False)。

    正则统一加首尾锚点：
      * 无通配符 → ``^.*关键字.*$``（包含匹配）；
      * ``EMP%``  → ``^EMP.*$``（前缀）；
      * ``%EMP%`` → ``^.*EMP.*$``（包含）。
    """
    raw = str(query or '').strip()
    if not raw:
        return None, False
    wildcard = ('%' in raw) or ('*' in raw)
    parts = []
    for char in raw:
        if wildcard and char in ('%', '*'):
            parts.append('.*')
        elif wildcard and char in ('_', '?'):
            parts.append('.')
        else:
            parts.append(re.escape(char))
    pattern = ''.join(parts)
    if not wildcard:
        pattern = '.*' + pattern + '.*'
    return re.compile('^' + pattern + '$', re.IGNORECASE), wildcard


def _search_rank(name, schema, query, wildcard, regex):
    """匹配档位：0 精确名 / 1 前缀 / 2 包含 / 3 精确限定名 / 4 限定名前缀 / 5 限定名包含。"""
    qualified = ('%s.%s' % (schema, name)) if schema else name
    needle = str(query or '').strip().lower()
    lower_name = name.lower()
    lower_qualified = qualified.lower()
    if not wildcard:
        if lower_name == needle:
            return 0
        if lower_name.startswith(needle):
            return 1
        if needle in lower_name:
            return 2
        if lower_qualified == needle:
            return 3
        if lower_qualified.startswith(needle):
            return 4
        if needle in lower_qualified:
            return 5
        return 99
    if lower_name == needle:
        return 0
    if regex.match(name):
        return 1
    if lower_qualified == needle:
        return 3
    if regex.match(qualified):
        return 5
    return 99


def _search_types(types):
    """把 table,view 之类的参数收敛成 {'TABLE','VIEW'}；返回 None 表示不过滤。"""
    if types is None:
        return None
    tokens = re.split(r'[,\s]+', types) if isinstance(types, str) else list(types)
    selected = set()
    for token in tokens:
        normalized = str(token or '').strip().upper()
        if normalized in ('TABLE', 'TABLES', 'BASE TABLE'):
            selected.add('TABLE')
        elif normalized in ('VIEW', 'VIEWS'):
            selected.add('VIEW')
    return selected or None


def _tree_database(dialect, requested_database, schema, catalog=''):
    """对象在左侧树里挂在哪个「库」节点下。

    Oracle / DM / 崖山：数据库维度是 owner；MySQL / ClickHouse：库即模式；
    PG / SQL Server / DB2：请求的库名才是树里的库节点。
    SQL Server 的「全部」范围是跨 catalog 名单，对象自己的库名优先，
    否则前端会把别的库的对象挂到空库节点上（执行目标就丢了）。
    """
    if dialect in OWNER_FAMILY or dialect in _SCHEMA_IS_DATABASE:
        return schema or requested_database or ''
    if dialect == 'sqlserver':
        # 跨库名单给的是对象自己的库；单库名单没有 catalog 列就退回请求的库。
        # 绝不能退到 schema —— 前端会把 dbo / sales 当成执行目标（树里的库节点）。
        return catalog or requested_database or ''
    # PG / DB2：schema 不是树里的「库」，请求没给库就留空
    return requested_database or ''


def _tree_object_name(dialect, schema, name):
    """对象在树节点 data-name 里的写法（与 /objects 的命名习惯一致）。

    PG 的 public、SQL Server 的 dbo 在树里是裸名；其余 schema 带前缀。
    Oracle / MySQL 系的树节点本身就是裸名，owner/库名由父节点表达。
    """
    if not schema:
        return name
    if dialect in OWNER_FAMILY or dialect in _SCHEMA_IS_DATABASE:
        return name
    if dialect in PG_FAMILY and schema.lower() == 'public':
        return name
    if dialect == 'sqlserver' and schema.lower() == 'dbo':
        return name
    return '%s.%s' % (schema, name)


def search_objects(db_info, db_type, database, query, scope='db', types=None, limit=None,
                   offset=0, force=False, conn_opener=None,
                   datasource_id='', datasource_name=''):
    """在「对象名单」里搜索表 / 视图，供 SQL 编辑器 Ctrl+K 使用。

    参数:
        database —— 当前库；Oracle 系为 owner。scope='db' 时必填。
        scope    —— ``db`` / ``all``；all 表示当前连接可访问的对象。
        types    —— 逗号分隔的 table,view；空表示不过滤。
        limit    —— 本页返回条数上限（默认 200，最大 500）。
        offset   —— 跳过前多少条（「加载更多」用）。名单是内存里的有序列表，
                    翻页只是切片，不会再打一次数据字典。
        force    —— 跳过 metadata 的 TTL 缓存，重新读数据字典。
        datasource_id / datasource_name —— 结果属于哪个数据源；只在「同类数据源
                    聚合搜索」（web 层 scope=ds）时才传，用来让前端点选时切对数据源。

    返回结构与 ``load_metadata`` 保持同样的「降级不抛异常」风格；
    额外给出 total / returned / offset / has_more / truncated / scope_limited /
    metadata_truncated。
    """
    started_at = time.time()
    dialect = normalize_db_type(db_type or db_info.get('db_type', ''))
    database = (database or '').strip()
    scope = 'all' if str(scope or '').strip().lower() == 'all' else 'db'
    try:
        limit_value = int(limit or OBJECT_SEARCH_LIMIT_DEFAULT)
    except (TypeError, ValueError):
        limit_value = OBJECT_SEARCH_LIMIT_DEFAULT
    # 页大小的上限由 web 层按 OBJECT_SEARCH_LIMIT_MAX 夹；这里只兜住「一次取多少」，
    # 跨数据源聚合翻页需要取到 offset+页大小 条才能还原全局序。
    limit_value = max(1, min(OBJECT_SEARCH_FETCH_CEILING, limit_value))
    try:
        offset_value = max(0, int(offset or 0))
    except (TypeError, ValueError):
        offset_value = 0

    result = {
        'ok': True, 'db_type': dialect, 'database': database, 'scope': scope,
        'query': str(query or '').strip(), 'total': 0, 'returned': 0,
        'limit': limit_value, 'offset': offset_value, 'has_more': False,
        'truncated': False, 'scope_limited': False,
        'metadata_truncated': False, 'cached': False, 'elapsed_ms': 0,
        'objects': [], 'scope_note': '',
        'datasource_id': str(datasource_id or ''),
        'datasource_name': str(datasource_name or ''),
    }
    regex, wildcard = _search_regex(query)
    if regex is None:
        result['elapsed_ms'] = int((time.time() - started_at) * 1000)
        return result
    if scope == 'db' and not database:
        result.update({'ok': False, 'error': '未指定数据库，无法按当前库搜索'})
        result['elapsed_ms'] = int((time.time() - started_at) * 1000)
        return result

    # PG / DB2 的「全部」只覆盖当前连接库（跨库要重新建连，不能悄悄扫）；
    # SQL Server 的「全部」走跨 catalog 名单，最多扫前 SQLSERVER_MAX_SEARCH_CATALOGS 个库。
    scope_limited = scope == 'all' and dialect in _CROSS_DATABASE_UNSUPPORTED
    query_database = database if (scope == 'db' or scope_limited) else ''

    payload = load_metadata(db_info, db_type, query_database, force=force,
                            objects_only=True, conn_opener=conn_opener)
    result['cached'] = bool(payload.get('cached'))
    result['metadata_truncated'] = bool(payload.get('truncated'))
    if not payload.get('ok'):
        result.update({'ok': False, 'error': payload.get('error') or '对象名单加载失败'})
        result['elapsed_ms'] = int((time.time() - started_at) * 1000)
        return result

    selected_types = _search_types(types)
    raw_query = str(query or '').strip()
    matches = []
    for entry in payload.get('objects') or []:
        name = str(entry.get('name') or '')
        schema = str(entry.get('schema') or '')
        catalog = str(entry.get('catalog') or '')
        entry_type = str(entry.get('type') or 'TABLE').upper()
        if not name:
            continue
        if selected_types and entry_type not in selected_types:
            continue
        # 兜底层：按当前库搜索时，即使插件/方言把全实例名单带回来了，
        # 也不要把别的库混进结果（MySQL / SQL Server 的 SQL 已按库过滤，这里防实现差异）。
        if scope == 'db' and dialect in MYSQL_FAMILY:
            if schema.lower() != database.lower():
                continue
        if scope == 'db' and dialect == 'sqlserver' and catalog:
            if catalog.lower() != database.lower():
                continue
        rank = _search_rank(name, schema, raw_query, wildcard, regex)
        if rank >= 99:
            continue
        # 展示名 / 归属库在匹配阶段就算好：排序键要和 web 层聚合排序**完全一致**
        # （档位 → 库 → 标签），这样「本源的第 K 条」在全局序里也必然排在前面，
        # 聚合分页时每个源只取前 offset+limit 条才是精确的。
        # SQL Server 的跨库名单把库名并进标签（dbo.* 在不同库里会重名，只标 schema
        # 认不出是谁家的）；MySQL / PG 维持 schema.name 的老写法。
        resolvedDatabase = _tree_database(dialect, database, schema, catalog)
        labelParts = ([resolvedDatabase, schema] if dialect == 'sqlserver' else [schema])
        labelParts = [p for p in labelParts if p]
        labelParts.append(name)
        matches.append({
            'rank': rank,
            'schema': schema,
            'name': name,
            'type': entry_type,
            'database': resolvedDatabase,
            'label': '.'.join(labelParts),
            'tree_name': _tree_object_name(dialect, schema, name),
            'qualified': ('%s.%s' % (schema, name)) if schema else name,
            'datasource_id': result['datasource_id'],
            'datasource_name': result['datasource_name'],
        })

    matches.sort(key=lambda row: (row['rank'], row['database'].lower(), row['label'].lower(),
                                  row['schema'].lower(), row['name'].lower()))
    total = len(matches)
    objects = matches[offset_value:offset_value + limit_value]
    hasMore = total > offset_value + len(objects)

    result.update({
        'total': total,
        'returned': len(objects),
        'objects': objects,
        'offset': offset_value,
        'has_more': hasMore,
        # truncated 保留老语义（名单到上限 / 还有没显示出来的页），前端那行提示不改
        'truncated': bool(payload.get('truncated')) or hasMore or offset_value > 0,
        'scope_limited': scope_limited,
    })
    if scope_limited:
        result['scope_note'] = '“全部”仅覆盖当前连接库的所有模式，跨库请切换数据库'
    elif scope == 'all' and dialect == 'sqlserver':
        covered = str(payload.get('scope') or '').replace('实例内 ', '') or '可访问的库'
        result['scope_note'] = '“全部”覆盖实例内 %s%s，请指定库后再搜' % (
            covered, '（库数已达上限，名单不完整）' if payload.get('scope_capped') else '')
    result['elapsed_ms'] = int((time.time() - started_at) * 1000)
    return result


def _default_conn_opener():
    """延迟取 web 层的统一建连入口（顶层 import 会与 modules.web.app 成环）。"""
    try:
        from modules.web.app import _open_editor_conn
        return _open_editor_conn
    except Exception:
        return None


def clear_cache():
    """清空元数据缓存（测试/排障用）。"""
    _meta_cache.clear()
