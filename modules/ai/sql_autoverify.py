# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""SQL 自动校验与自动纠偏内核 —— 让"值被替代"这件事本身可被机器验证。

为什么需要这一层
----------------
只把"值从哪来"解决掉是不够的：靠弹一张卡让用户选 schema、选表空间，
只是把"AI 猜"换成"人填"，不确定性还在人身上，填错了照样要跑一次才知道。

真正的目标应当是三件事，都不需要人工参与：

    快捷   ——  值由系统自动定位，不产生额外交互
    精确   ——  值必须真实存在（对象存在性校验），不是看起来对
    可靠   ——  替代结果必须被执行前校验过（可执行性探针），而不是执行后才发现失败

本模块提供四道机器可执行的关卡：

    1. 环境探测     probe_environment()  当前 schema / 实例 / 版本，一次取齐
    2. 引用校验     check_objects()       SQL 里引用的每个对象是否真实存在；不存在则给出相似候选
    3. 可执行探针   probe_sql()           把 SQL 包成 0 行查询试跑 —— 只读、不改数据，
                                          但数据库会完整解析对象名/列名/权限/版本语法
    4. 闭环纠偏     verify_and_fix()      探针失败 → 从报错里提取对象名 → 相似匹配 → 替换重试

第 3 关是关键：`SELECT * FROM (<sql>) WHERE 1=0` 返回 0 行，但 Oracle / MySQL / PG /
SQL Server 都会在解析阶段完成对象与列的合法性检查。于是"ORA-00942 执行到一半才发现"
变成"执行前就已经知道"，这才是可靠的来源。

归属与实现约束
--------------
归属说明：本模块的自动校验与纠偏算法、常量表归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com> 所有。
只用标准库 ``difflib`` / ``re``，不引入任何第三方依赖；函数签名与常量表是
四道关卡的判定契约，改动会同时影响校验结果。

* 方言家族由 ``modules.ai.sql_safety._family_of`` 提供（口径为
  ``modules.ai.dialect.family_alias``），默认执行器是
  ``modules.ai.tools.sql_tools.tool_execute_sql``；
* ``_family_of`` 对未知 db_type 返回原样小写串，因此未知方言会走到
  "查不到模板即跳过"的分支，行为是**不校验**而不是按 Oracle 语法硬试；
* docstring 与注释里的对象名示例一律虚构。
"""

import difflib
import re

_OBJ_TYPE_KEEP = ('TABLE', 'VIEW', 'SYNONYM', 'SEQUENCE', 'PROCEDURE', 'FUNCTION',
                  'PACKAGE', 'MATERIALIZED VIEW', 'TYPE')

# 伪表 / 非真实对象，不参与存在性校验
_PSEUDO = {'dual', 'sysdate', 'systimestamp', 'rownum', 'rowid', 'level',
           'current_date', 'current_timestamp', 'sys_guid', 'seq', 't',
           'information_schema', 'pg_catalog', 'performance_schema', 'mysql', 'sys',
           'unnest', 'generate_series', 'json_table', 'lateral'}

# SQL 关键字：绝不能被当作对象名（否则会把 `FROM (SELECT ...)` 里的 SELECT 当成表）
_KEYWORDS = {
    'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'BY', 'HAVING', 'UNION', 'ALL',
    'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'USING',
    'AND', 'OR', 'NOT', 'NULL', 'AS', 'WITH', 'START', 'CONNECT', 'PRIOR',
    'LIMIT', 'OFFSET', 'FETCH', 'FIRST', 'ROWS', 'ONLY', 'PARTITION', 'VALUES',
    'SET', 'INTO', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'OVER', 'WINDOW',
    'LATERAL', 'TABLESAMPLE', 'PIVOT', 'UNPIVOT', 'MODEL', 'DUAL',
}

_OBJ_TOKEN_RE = re.compile(
    r'([A-Za-z_][A-Za-z0-9_$#]*)(?:\s*\.\s*([A-Za-z_][A-Za-z0-9_$#]*))?')

# CTE 定义：WITH x AS ( ... ) / , y AS ( ... ) —— 这些名字不是真实对象
_CTE_RE = re.compile(r'(?:\bWITH\b|,)\s*([A-Za-z_][A-Za-z0-9_$#]*)\s+AS\s*\(', re.IGNORECASE)


def _skip_ws(s, i):
    while i < len(s) and s[i] in ' \t\r\n':
        i += 1
    return i


def _skip_parens(s, i):
    """从 s[i]=='(' 开始配平括号，返回其后的下标（用于整体跳过子查询）。"""
    depth = 0
    while i < len(s):
        if s[i] == '(':
            depth += 1
        elif s[i] == ')':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return i


def _peek_ident(s, i):
    """在 s[i:] 处看一个标识符；返回 (token, 结束下标)；不是标识符则 (None, i)。"""
    m = _OBJ_TOKEN_RE.match(s, i)
    if not m:
        return None, i
    return m, m.end()


# ─────────────────────────── 1. 引用抽取 ───────────────────────────

def extract_table_refs(sql):
    """抽取 SQL 中 FROM / JOIN 引用的真实对象（支持 owner.table、逗号多表、派生表）。

    必须做到"宁可少抽，绝不误抽"：误把子查询关键字、别名或 CTE 名当成表名，会导致
    存在性校验误报 → 触发把正确 SQL 改错的"自动纠偏"，比不校验更危险。

    返回 [{'raw', 'schema', 'name'}]，已剔除伪表、子查询与 CTE。
    """
    sql = sql or ''
    out, seen = [], set()

    # CTE（WITH x AS (...)）定义的名字不是真实对象，必须排除
    cte_names = {m.group(1).upper() for m in _CTE_RE.finditer(sql)}

    def _add(schema, name, raw):
        if name.lower() in _PSEUDO or name.upper() in _KEYWORDS:
            return
        if not schema and name.upper() in cte_names:
            return
        key = (schema.upper(), name.upper())
        if key in seen:
            return
        seen.add(key)
        out.append({'raw': raw, 'schema': schema, 'name': name})

    for m in re.finditer(r'\b(?:FROM|JOIN)\b', sql, re.IGNORECASE):
        i = _skip_ws(sql, m.end())
        while i < len(sql):
            if sql[i] == '(':
                # 派生表 / 子查询：整体跳过，并吃掉紧跟的别名
                i = _skip_ws(sql, _skip_parens(sql, i))
            else:
                tok, i = _peek_ident(sql, i)
                if not tok:
                    break
                g1, g2 = tok.group(1), tok.group(2)
                # owner.table 时 group(1) 是 owner、group(2) 是表名
                schema, name = (g1, g2) if g2 else ('', g1)
                if name.upper() in _KEYWORDS:
                    break
                _add(schema, name, (schema + '.' + name) if schema else name)
                i = _skip_ws(sql, i)

            # 吃掉可选别名（含 AS 写法），避免别名挡住后面的逗号
            tok2, i2 = _peek_ident(sql, i)
            if tok2:
                w = tok2.group(1)
                if w.upper() == 'AS':
                    i = _skip_ws(sql, tok2.end())
                    _, i = _peek_ident(sql, i)
                    i = _skip_ws(sql, i)
                elif w.upper() not in _KEYWORDS and not tok2.group(2):
                    i = _skip_ws(sql, tok2.end())

            # 逗号续接的多表：FROM a, b, c
            if i < len(sql) and sql[i] == ',':
                i = _skip_ws(sql, i + 1)
                continue
            break

    return out


# ─────────────────────────── 2. 环境探测 ───────────────────────────

_ENV_SQL = {
    'oracle': ("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') cur_schema, "
               "SYS_CONTEXT('USERENV','DB_NAME') db_name, "
               "(SELECT instance_name FROM v$instance) inst, "
               "(SELECT version FROM v$instance) ver FROM dual"),
    'mysql': "SELECT DATABASE() cur_schema, @@hostname db_name, @@hostname inst, @@version ver",
    'postgresql': "SELECT current_schema() cur_schema, current_database() db_name, '' inst, version() ver",
    'sqlserver': "SELECT SCHEMA_NAME() cur_schema, DB_NAME() db_name, @@SERVERNAME inst, @@VERSION ver",
}


def probe_environment(datasource_name, db_info=None, runner=None):
    """自动探测数据源的环境事实（当前 schema / 实例 / 版本）。

    这些值 100% 确定，是"精确替代"的基石 —— 它们永远不该由模型猜、也不该问用户。
    """
    from modules.ai.sql_safety import _family_of as _db_family
    db_info = db_info or {}
    db_type = db_info.get('db_type', '')
    sql = _ENV_SQL.get(_db_family(db_type))
    if not sql:
        return {}
    res = _run(runner, datasource_name, sql)
    if res.get('error') or not res.get('rows'):
        return {}
    cols = [str(c).lower() for c in (res.get('columns') or [])]
    row = res['rows'][0]
    out = {}
    for i, c in enumerate(cols):
        if i < len(row) and row[i] is not None:
            out[c] = str(row[i])
    return out


# ─────────────────────────── 3. 对象存在性校验 ───────────────────────────

_OBJ_SQL = {
    'oracle': "SELECT owner, object_name, object_type FROM all_objects "
              "WHERE object_name IN ({ph}) AND ROWNUM <= 500",
    'mysql': "SELECT table_schema, table_name, table_type FROM information_schema.tables "
             "WHERE table_name IN ({ph}) LIMIT 500",
    'postgresql': "SELECT schemaname, tablename, 'TABLE' FROM pg_tables "
                  "WHERE tablename IN ({ph}) LIMIT 500",
    'sqlserver': "SELECT s.name, t.name, 'TABLE' FROM sys.tables t "
                 "JOIN sys.schemas s ON s.schema_id = t.schema_id "
                 "WHERE t.name IN ({ph})",
}

# 样本池：用于"对象不存在时找相似候选"。查询的是当前 schema 下的对象清单，
# 因为精确查询在"全部不存在"时返回 0 行，无法提供任何候选。
_SAMPLE_SQL = {
    'oracle': "SELECT owner, object_name, object_type FROM all_objects "
              "WHERE owner = {owner} AND ROWNUM <= 800",
    'mysql': "SELECT table_schema, table_name, table_type FROM information_schema.tables "
             "WHERE table_schema = {owner} LIMIT 800",
    'postgresql': "SELECT schemaname, tablename, 'TABLE' FROM pg_tables "
                  "WHERE schemaname = {owner} LIMIT 800",
    'sqlserver': "SELECT s.name, t.name, 'TABLE' FROM sys.tables t "
                 "JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = {owner}",
}


def _ph(names):
    return ','.join("'" + n.replace("'", "''") + "'" for n in names)


def _lit(v):
    return "'" + str(v).replace("'", "''") + "'"


def _rows_to_map(rows):
    cat = {}
    for row in rows:
        owner, obj = str(row[0] or ''), str(row[1] or '')
        otype = str(row[2] or '').upper()
        if not obj:
            continue
        if otype and not any(k in otype for k in _OBJ_TYPE_KEEP):
            continue
        cat.setdefault(obj.upper(), []).append({'owner': owner, 'type': otype})
    return cat


def _load_catalog(datasource_name, db_info, names, owner_hint=None, runner=None):
    """加载对象目录。

    Returns: (obj_map, known_names, readable)
        obj_map      {'EMP': [{'owner','type'}]}
        known_names  set  供相似匹配（含样本池）
        readable     False 表示数据字典不可读（权限/连接问题），此时不应下任何结论
    """
    from modules.ai.sql_safety import _family_of as _db_family
    fam = _db_family(db_info.get('db_type', ''))
    tmpl = _OBJ_SQL.get(fam)
    if not tmpl:
        return {}, set(), False

    cat = {}
    if names:
        res = _run(runner, datasource_name, tmpl.format(ph=_ph([n.upper() for n in names])))
        if res.get('error'):
            return {}, set(), False          # 查询失败才算"不可读"
        cat.update(_rows_to_map(res.get('rows') or []))
        # 注意：查询成功但 0 行是合法结果（说明这些对象确实都不存在），不能当成不可读

    known = set(cat.keys())

    # 有缺项时补一次样本池，用于相似匹配
    miss_hint = names and not cat
    if (miss_hint or not names) and owner_hint and fam in _SAMPLE_SQL:
        sres = _run(runner, datasource_name,
                    _SAMPLE_SQL[fam].format(owner=_lit(owner_hint)))
        if not sres.get('error'):
            sample = _rows_to_map(sres.get('rows') or [])
            for k, v in sample.items():
                cat.setdefault(k, v)
            known = set(cat.keys())

    return cat, known, True


# 相似检索：按前缀跨 schema 找候选。只查"当前 schema"是不够的 ——
# Oracle 里 DBA_USERS 属于 SYS，而登录用户是 DEMO_AGENT，样本池里根本没有它。
_SIMILAR_SQL = {
    'oracle': ("SELECT owner, object_name, object_type FROM all_objects "
               "WHERE {pats} AND ROWNUM <= 60"),
    'mysql': ("SELECT table_schema, table_name, table_type FROM information_schema.tables "
              "WHERE {pats} LIMIT 60"),
    'postgresql': ("SELECT schemaname, tablename, 'TABLE' FROM pg_tables "
                   "WHERE {pats} LIMIT 60"),
    'sqlserver': ("SELECT s.name, t.name, 'TABLE' FROM sys.tables t "
                  "JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE {pats}"),
}

_SIMILAR_COL = {
    'oracle': 'UPPER(object_name)',
    'mysql': 'UPPER(table_name)',
    'postgresql': 'UPPER(tablename)',
    'sqlserver': 'UPPER(t.name)',
}


def _prefix_for(name):
    """取用于 LIKE 检索的前缀。

    容忍 2 个字符的偏差（去掉尾部 2 位），短名字至少保留 3 位 ——
    前缀过长会检索不到候选（如 EMPP 用 'EMPP%' 找不到 EMP，
    DBA_TABLEZZ 用 'DBA_TABLEZ%' 找不到 DBA_TABLES），
    前缀过短则会扫出太多无关对象（靠 ROWNUM/LIMIT 与相似度排序兜住）。
    """
    n = (name or '').upper()
    return n[:max(3, len(n) - 2)] + '%'


def _load_similar(datasource_name, db_info, miss_names, runner=None):
    """对不存在/出错的对象名做前缀检索，构建跨 schema 的候选池。"""
    from modules.ai.sql_safety import _family_of as _db_family
    if not miss_names:
        return {}
    fam = _db_family(db_info.get('db_type', ''))
    tmpl, col = _SIMILAR_SQL.get(fam), _SIMILAR_COL.get(fam)
    if not tmpl or not col:
        return {}
    pats = ' OR '.join('%s LIKE %s' % (col, _lit(_prefix_for(n))) for n in miss_names)
    res = _run(runner, datasource_name, tmpl.format(pats=pats))
    if res.get('error'):
        return {}
    return _rows_to_map(res.get('rows') or [])


def check_objects(datasource_name, db_info, sql, runner=None, owner_hint=None):
    """校验 SQL 引用的对象是否真实存在；不存在时给出相似候选。

    Args:
        owner_hint: 当前 schema（由 probe_environment 得到），作为相似检索的兜底样本池。

    Returns:
        {'checked': [...], 'missing': [...], 'ambiguous': [...],
         'suggestions': {name: [候选...]}, 'catalog_size': n}
    """
    refs = extract_table_refs(sql)
    if not refs:
        return {'checked': [], 'missing': [], 'ambiguous': [], 'suggestions': {},
                'catalog_size': 0}

    names = sorted({r['name'] for r in refs} | {r['schema'] for r in refs if r['schema']})
    cat, known, readable = _load_catalog(datasource_name, db_info, names,
                                         owner_hint=owner_hint, runner=runner)
    if not readable:
        # 数据字典不可读（权限/连接问题）→ 不下结论，避免误报误改
        return {'checked': [], 'missing': [], 'ambiguous': [], 'suggestions': {},
                'catalog_size': 0, 'note': '数据字典不可读，跳过对象校验'}

    missing, ambiguous, checked, suggestions = [], [], [], {}
    for r in refs:
        key = r['name'].upper()
        hits = list(cat.get(key) or [])
        if r['schema']:
            hits = [h for h in hits if h['owner'].upper() == r['schema'].upper()]
        if hits:
            checked.append({'ref': r['raw'], 'owners': sorted({h['owner'] for h in hits})})
            if not r['schema'] and len({h['owner'] for h in hits}) > 1:
                ambiguous.append({'ref': r['raw'],
                                  'owners': sorted({h['owner'] for h in hits})})
            continue
        missing.append(r['raw'])

    # 对缺项做跨 schema 前缀检索，拿到候选池后再做相似度排序
    if missing:
        pool = dict(cat)
        pool.update(_load_similar(datasource_name, db_info, missing, runner=runner))
        keys = sorted(pool.keys())
        for raw in missing:
            key = raw.split('.')[-1].upper()
            cands = difflib.get_close_matches(key, keys, n=3, cutoff=0.6) if keys else []
            if not cands and keys:
                # 前缀兜底：LLM 常见的是多了/少了后缀
                pfx = _prefix_for(key)[:-1]
                cands = [k for k in keys if k.startswith(pfx)][:3]
            scored = []
            for c in cands:
                if c not in pool:
                    continue
                scored.append({
                    'name': (pool[c][0]['owner'] + '.' + c) if pool.get(c) else c,
                    'obj': c,
                    'type': pool[c][0]['type'],
                    'score': round(difflib.SequenceMatcher(None, key, c).ratio(), 3),
                })
            scored.sort(key=lambda x: -x['score'])
            suggestions[raw] = scored

    return {'checked': checked, 'missing': missing, 'ambiguous': ambiguous,
            'suggestions': suggestions, 'catalog_size': len(known)}


# ─────────────────────────── 4. 可执行性探针 ───────────────────────────

def build_probe_sql(sql, db_type):
    """把待执行 SQL 包成"0 行探针"：只读、不取数，但数据库会完整解析它。

    解析阶段就会暴露：对象不存在（ORA-00942 / relation does not exist）、
    列不存在（ORA-00904）、权限不足（ORA-01031）、版本语法不兼容（如 11g 遇到
    12c 的 FETCH FIRST）—— 全部在执行取数之前发现。
    """
    from modules.ai.sql_safety import _family_of as _db_family
    inner = (sql or '').strip().rstrip(';').rstrip('/').strip()
    if not inner:
        return ''
    fam = _db_family(db_type)
    if fam == 'oracle':
        return 'SELECT * FROM (%s) WHERE 1=0' % inner
    if fam == 'sqlserver':
        return 'SELECT TOP 0 * FROM (%s) t' % inner
    return 'SELECT * FROM (%s) t LIMIT 0' % inner


def split_statements(sql):
    """按分号把 SQL 拆成多条语句（跳过字符串字面量里的分号）。

    建议 SQL 经常是多条一起给出（如"查表所在表空间"+"查索引所在表空间"），
    整段包进 0 行探针会变成 `SELECT * FROM (SELECT ...; SELECT ...) WHERE 1=0`，
    直接语法报错 —— 必须逐条探针。字符串里的 `;`（如 'a;b'）不能被当分隔符。
    """
    out, buf, i, n = [], [], 0, len(sql or '')
    while i < n:
        c = sql[i]
        if c == "'":
            buf.append(c)
            if i + 1 < n and sql[i + 1] == "'":      # 转义的单引号 ''
                buf.append("'")
                i += 2
                continue
            # 配对到下一个单引号
            j = i + 1
            while j < n:
                buf.append(sql[j])
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        buf.append("'")
                        j += 2
                        continue
                    break
                j += 1
            i = j + 1
            continue
        if c == ';':
            seg = ''.join(buf).strip()
            if seg:
                out.append(seg)
            buf = []
        else:
            buf.append(c)
        i += 1
    seg = ''.join(buf).strip()
    if seg:
        out.append(seg)
    return out


def probe_sql(sql, datasource_name, db_info=None, runner=None):
    """执行 0 行探针，验证 SQL 能否被数据库成功解析与执行。

    多条语句逐条探针，任一条失败即返回失败（并指明是哪一条）。

    Returns: {'ok': bool, 'probe_sql': str, 'error': str, 'columns': [...],
              'statement_count': n}
    """
    db_info = db_info or {}
    stmts = split_statements(sql)
    if not stmts:
        return {'ok': False, 'error': '空 SQL', 'probe_sql': '', 'columns': []}

    probes, columns = [], []
    for st in stmts:
        probe = build_probe_sql(st, db_info.get('db_type', ''))
        if not probe:
            continue
        probes.append(probe)
        res = _run(runner, datasource_name, probe)
        if res.get('error'):
            return {'ok': False, 'probe_sql': probe, 'error': res['error'],
                    'columns': [], 'statement_count': len(stmts), 'statement': st}
        if not columns:
            columns = res.get('columns') or []
    return {'ok': True, 'probe_sql': probes[0] if probes else '', 'error': '',
            'columns': columns, 'rows': 0, 'statement_count': len(stmts)}


# ─────────────────────────── 5. 报错解析与自动纠偏 ───────────────────────────

_ERR_OBJ_RES = [
    r'ORA-00942',
    r"Table\s+'?([\w$.]+)'?\s+doesn't exist",          # MySQL
    r'relation\s+"([\w$.]+)"\s+does not exist',         # PG
    r'Invalid object name\s+\'?([\w$.\[\]]+)\'?',       # MSSQL
    r'ORA-00904:\s*"?([\w$#]+)"?',                      # Oracle 列
    r'Unknown column\s+\'([\w.]+)\'',                   # MySQL 列
    r'column\s+"([\w.]+)"\s+does not exist',            # PG 列
]


def parse_error_objects(err_text):
    """从数据库报错里提取出错的对象/列名（用于精准纠偏）。"""
    out = []
    for pat in _ERR_OBJ_RES:
        for m in re.finditer(pat, err_text or '', re.IGNORECASE):
            if m.groups():
                out.append(m.group(1))
    return out


def apply_corrections(sql, mapping):
    """按 {原写法: 新写法} 替换 SQL 中的对象引用（整词匹配，避免误伤）。"""
    fixed = sql
    for old, new in (mapping or {}).items():
        bare_old = old.split('.')[-1]
        # 先替换带 owner 的完整写法，再替换裸表名
        fixed = re.sub(r'\b%s\b' % re.escape(old), new, fixed, flags=re.IGNORECASE)
        if '.' not in old:
            fixed = re.sub(r'\b%s\b' % re.escape(bare_old), new.split('.')[-1],
                           fixed, flags=re.IGNORECASE)
    return fixed


def plan_corrections(check):
    """依据校验结果生成自动纠偏方案。

    自动采用候选的条件（必须同时满足，避免把正确的 SQL 改错）：
        1. 只有唯一候选；或
        2. 最佳候选相似度 ≥ 0.85，且与次佳拉开 ≥ 0.12 —— 即"显著优胜"。
           例：DBA_USER → DBA_USERS(0.94) vs DBA_USTATS(0.71)，差距 0.23，可自动采用。
    其余情况（多个候选相似度接近、无候选）一律交人工，绝不瞎猜。

    Returns: (mapping, need_human, warnings)
    """
    mapping, need_human, warnings = {}, [], []
    for ref, cands in (check.get('suggestions') or {}).items():
        items = [c for c in cands if c.get('name')]
        if not items:
            need_human.append({'ref': ref, 'candidates': [],
                               'reason': '对象不存在且字典中无相近候选'})
            continue
        best = items[0]
        bs = best.get('score', 1.0)
        if len(items) == 1:
            mapping[ref] = best['name']
            continue
        second = items[1]
        if bs >= 0.85 and (bs - second.get('score', 0)) >= 0.12:
            mapping[ref] = best['name']
        else:
            need_human.append({
                'ref': ref, 'candidates': [i['name'] for i in items],
                'reason': '对象不存在，%d 个候选相似度接近（%s），需人工确认'
                          % (len(items), '/'.join(str(i.get('score')) for i in items))})
    for amb in (check.get('ambiguous') or []):
        warnings.append({'ref': amb['ref'], 'owners': amb['owners'],
                         'reason': '同名对象存在于多个 schema；未显式指定 owner 时按当前 schema 解析'})
    return mapping, need_human, warnings


# ─────────────────────────── 6. 闭环入口 ───────────────────────────

def verify_and_fix(datasource_name, sql, db_info=None, runner=None,
                   max_rounds=2, probe=True):
    """自动校验 + 自动纠偏闭环。

    流程：
        引用校验（存在性 / 歧义）→ 能自动纠正的唯一候选直接改
        → 0 行探针验证可执行性 → 失败则解析报错、纠错、重试（最多 max_rounds 轮）

    Returns:
        {'status': 'ok' | 'fixed' | 'needs_human' | 'failed',
         'sql': 最终 SQL,
         'steps': [每一步做了什么、结果如何],
         'issues': [...],           # 仍需人工处理的歧义
         'check': {...}}            # 引用校验原始结果，供审计
    """
    steps, issues, warnings = [], [], []
    current = sql
    env = probe_environment(datasource_name, db_info=db_info, runner=runner)
    owner_hint = env.get('cur_schema') or ''
    if env:
        steps.append({'stage': 'probe_env', 'ok': True, 'detail': env})

    # ── 第 1 关：引用存在性 ──
    check = check_objects(datasource_name, db_info, current, runner=runner,
                          owner_hint=owner_hint)
    if check.get('note'):
        steps.append({'stage': 'check_objects', 'ok': None, 'detail': check['note']})
    else:
        mapping, need_human, warns = plan_corrections(check)
        warnings.extend(warns)
        if check['missing']:
            steps.append({'stage': 'check_objects', 'ok': False,
                          'detail': {'missing': check['missing'], 'auto_fix': mapping}})
            if mapping:
                current = apply_corrections(current, mapping)
                steps.append({'stage': 'auto_fix_objects', 'ok': True, 'detail': mapping})
            issues.extend(need_human)
        else:
            steps.append({'stage': 'check_objects', 'ok': True,
                          'detail': {'checked': [c['ref'] for c in check['checked']]}})

    # ── 第 2 关：可执行性探针 + 纠错重试 ──
    probe_result = None
    if probe:
        for round_no in range(1, max_rounds + 1):
            probe_result = probe_sql(current, datasource_name, db_info=db_info, runner=runner)
            if probe_result['ok']:
                steps.append({'stage': 'probe_sql', 'ok': True, 'round': round_no,
                              'detail': {'columns': probe_result.get('columns', [])[:20]}})
                break
            err = probe_result.get('error', '')
            steps.append({'stage': 'probe_sql', 'ok': False, 'round': round_no,
                          'detail': {'error': err[:400]}})
            err_objs = parse_error_objects(err)
            if not err_objs:
                issues.append({'ref': '', 'candidates': [],
                               'reason': '探针失败但无法从报错定位对象：%s' % err[:200]})
                break
            sub = check_objects(datasource_name, db_info,
                                'SELECT * FROM ' + ', '.join(err_objs),
                                runner=runner, owner_hint=owner_hint)
            mapping, need_human, warns = plan_corrections(sub)
            warnings.extend(warns)
            if not mapping:
                # 探针报错里提取到的可能是列名（ORA-00904）而非对象名，措辞上要说清
                for it in (need_human or []):
                    it['reason'] = (it.get('reason', '') + '（来自探针报错，可能是列名或对象名，'
                                                         '需人工核对）')
                issues.extend(need_human or [
                    {'ref': o, 'candidates': [],
                     'reason': '名称无法自动纠正（可能是列名或对象名，需人工核对）'}
                    for o in err_objs])
                break
            current = apply_corrections(current, mapping)
            steps.append({'stage': 'auto_fix_retry', 'ok': True, 'round': round_no,
                          'detail': mapping})

    # ── 状态判定：有未决问题 → 交人工；做过修正且通过 → fixed；否则 ok ──
    fixed = any(s.get('stage') in ('auto_fix_objects', 'auto_fix_retry') for s in steps)
    if probe_result is not None and not probe_result['ok']:
        status = 'needs_human' if issues else 'failed'
    elif issues:
        status = 'needs_human'
    elif fixed:
        status = 'fixed'
    else:
        status = 'ok'

    return {'status': status, 'sql': current, 'original_sql': sql,
            'steps': steps, 'issues': issues, 'warnings': warnings,
            'check': check, 'env': env, 'probe': probe_result}


# ─────────────────────────── 7. 空结果诊断（可靠性收尾） ───────────────────────────

def diagnose_empty_result(sql, db_info=None):
    """结果为空时给出"是否替代值太窄"的判断与放宽建议。

    空结果往往不是 SQL 写错，而是替代进去的值过窄（owner 不对、时间窗口太短、
    IN 列表太小）。这里给出可执行的放宽路径，而不是让人重新猜。
    """
    from modules.ai.sql_safety import _family_of as _db_family
    hints = []
    has_owner = re.search(r'\b(?:owner|table_owner|schema_name)\s*=\s*', sql or '', re.I)
    has_time = re.search(r"(SYSDATE\s*-|NOW\(\)\s*-|GETDATE\(\)|INTERVAL)", sql or '', re.I)
    has_in = re.search(r'\bIN\s*\(', sql or '', re.I)
    if has_owner:
        hints.append({'dimension': 'owner', 'suggest': '放宽 owner 条件或改为按对象名检索',
                      'why': '按 schema 过滤是最常见的空结果原因'})
    if has_time:
        hints.append({'dimension': 'time_window', 'suggest': '把时间窗口放大 2~4 倍后重试',
                      'why': '窗口内确实没有匹配记录'})
    if has_in:
        hints.append({'dimension': 'list', 'suggest': '扩大 IN 列表（先查有哪些取值可选）',
                      'why': 'IN 列表过窄或元素与库内实际取值不同'})
    if not hints:
        hints.append({'dimension': 'filter', 'suggest': '逐个去掉过滤条件定位是哪一条筛掉了全部行',
                      'why': '需要二分定位过滤条件'})
    return {'likely': 'value_too_narrow' if (has_owner or has_time or has_in) else 'unknown',
            'hints': hints, 'db_family': _db_family((db_info or {}).get('db_type', ''))}


# ─────────────────────────── 内部执行器封装 ───────────────────────────

def _run(runner, datasource_name, sql):
    """执行一条只读 SQL。runner 可注入以便离线测试。

    runner 默认走 DBCheck 既有的 execute_sql（含只读校验 + 超时 + 安全检测），
    因此本模块的探针与校验天然继承"只读"边界。
    """
    if runner is not None:
        return runner(sql) or {}
    try:
        from modules.ai.tools.sql_tools import tool_execute_sql
        return tool_execute_sql(datasource_name=datasource_name, sql=sql) or {}
    except Exception as e:
        return {'error': '执行器不可用: %s' % e}
