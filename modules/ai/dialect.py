# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""数据库方言（版本相关语法）规则库 —— 确定性识别 + 执行前预检 + 一键改写。

归属说明：本模块的规则与算法设计归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com> 所有。
纯 ``re`` 实现、零第三方依赖；前端通过助手接口取同一份规则，不在 JS 里复制第二套。
版本家族表覆盖 ``*_jdbc``（连接方式不改变数据库种类）、达梦、崖山、
瀚高、ClickHouse、DB2 等条目，否则 ``oracle_jdbc`` 会被判成未知版本、方言禁区失效。

## 为什么需要这个模块

AI 生成 SQL 时若不知道目标库的真实版本，会按"通用/最新"语法写，最典型的三类事故：

| 目标库 | AI 爱写（但库不支持） | 后果 |
|---|---|---|
| Oracle 11g | `FETCH FIRST 20 ROWS ONLY`（12c+） | ORA-00933 |
| MySQL 5.7 | `WITH cte AS (...)` / 窗口函数（8.0+） | ERROR 1064 |
| SQL Server 2008 | `OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY`（2012+） | 关键字 'OFFSET' 附近有语法错误 |

用户只能反复点「AI 修复」试错 —— 体验很差，而且每次都要多花一次 LLM 往返。

## 这个模块提供三层保障（全部确定性，不依赖 LLM）

1. **提示词层** `build_dialect_prompt()`：把"版本 → 禁用语法 + 正确写法"的清单塞进提示词，
   让模型**一开始**就写对（比事后修复便宜得多）。
2. **预检层** `check_sql()`：给定 SQL 与目标库版本 → 返回违规项（含人类可读原因与替代写法）。
   前端在渲染 SQL 块时本地跑（规则由 `GET /api/chat/dialect-rules` 下发），执行前就能看见。
3. **改写层** `rewrite_sql()`：对**语义可安全等价改写**的少数情况做确定性重写
   （目前只有"语句末尾的 FETCH FIRST/NEXT n ROWS ONLY"→ 子查询 + `ROWNUM <= n`），
   其余情况只给指引、不自动改 —— 宁可不动，也不改错。

## 设计原则

- **按版本给具体事实**，不给"请注意兼容性"这种没用的提醒：要说清楚"11g 不支持 FETCH FIRST"。
- **宁可漏报不误报**：正则匹配前先屏蔽字符串字面量与注释，避免把 `'FETCH FIRST'` 这样的
  普通文本当成语法。
- 规则集中在本文件，前后端**共用同一份**（前端通过接口取，不复制一份 JS 规则）。
"""

import re

# ────────────────────────────────────────────────────────────────
# 版本解析
# ────────────────────────────────────────────────────────────────

_FAMILY_ALIASES = {
    'oracle': 'oracle',
    'oracle_full': 'oracle',
    'yashandb': 'oracle',
    'mysql': 'mysql',
    'mariadb': 'mysql',
    'tidb': 'mysql',
    'oceanbase': 'mysql',
    'tdsqlc_mysql': 'mysql',
    'postgresql': 'postgresql',
    'ivorysql': 'postgresql',
    'kingbase': 'postgresql',
    'openGauss': 'postgresql',
    'opengauss': 'postgresql',
    'hgdb': 'postgresql',
    'uxdb': 'postgresql',
    'vastbase': 'postgresql',
    'sqlserver': 'sqlserver',
    'gbase': 'gbase',
    # 本仓库独有口径：达梦按 Oracle 系语法族处理，另加 ClickHouse / DB2
    'dm': 'oracle', 'dm8': 'oracle',
    'clickhouse': 'clickhouse',
    'db2': 'db2',
}


def family_alias(db_type):
    """把本仓库的 db_type 映射到方言家族。

    本仓库的约定是「``_jdbc`` 只是连接实现方式，不改变数据库种类」
    （见 modules/driver_registry.normalize_db_type），所以这里先剥掉该后缀再查表，
    否则 ``oracle_jdbc`` 会被当成未知版本，方言禁区提示词直接失效。
    """
    text = str(db_type or '').strip().lower()
    if text.endswith('_jdbc'):
        text = text[:-len('_jdbc')]
    if text in ('postgres', 'pgsql'):
        text = 'postgresql'
    if text == 'mssql':
        text = 'sqlserver'
    if text in ('tdsql-c', 'tdsql'):
        text = 'tdsqlc_mysql'
    return _FAMILY_ALIASES.get(text, '')


# 从版本串里抠出 (major, minor) 的正则：
#   Oracle banner: Oracle Database 11g Enterprise Edition Release 11.2.0.4.0 - 64bit Production
#   MySQL: 5.7.44-log / 8.0.36
#   PG: PostgreSQL 12.4 on x86_64 / 14.2
#   SQL Server: Microsoft SQL Server 2016 (SP2) ... / 2019 ...
_VER_NUM_RE = re.compile(r'(\d+)\.(\d+)')
_SQLSERVER_YEAR_RE = re.compile(r'\b(19|20)\d{2}\b')
_ORACLE_G_RE = re.compile(r'\b(\d{1,2})g\b', re.I)


def parse_version(version_text, db_type=''):
    """从版本描述里解析出 (family, major, minor)。

    Args:
        version_text: 数据库返回的原始版本串（如 `Oracle Database 11g ... 11.2.0.4.0`）
        db_type: 数据源配置的类型（oracle / mysql / postgresql / sqlserver ...）
    Returns:
        (family, major, minor)；解析不出来时 major/minor 为 None。
    """
    family = family_alias(db_type)
    txt = (version_text or '').strip()
    low = txt.lower()
    if not family:
        if 'oracle' in low:
            family = 'oracle'
        elif 'mysql' in low or 'mariadb' in low:
            family = 'mysql'
        elif 'postgres' in low:
            family = 'postgresql'
        elif 'sql server' in low:
            family = 'sqlserver'
    if not family:
        return '', None, None

    if family == 'sqlserver':
        # SQL Server 版本串里年份是版本标签（2016/2019），优先用它
        m = _SQLSERVER_YEAR_RE.search(txt)
        if m:
            return family, int(m.group(0)), None

    if family == 'oracle':
        # 先取 banner 里的数字版本（11.2.0.4.0 / 19.0.0.0.0）—— 它才决定"支持哪些语法"；
        # 取不到再退回 `11g`/`19c` 这种标签里的数字。
        m = _VER_NUM_RE.search(txt)
        if m:
            return family, int(m.group(1)), int(m.group(2))
        m = _ORACLE_G_RE.search(txt)
        if m:
            return family, int(m.group(1)), None
        return family, None, None

    m = _VER_NUM_RE.search(txt)
    if m:
        return family, int(m.group(1)), int(m.group(2))
    return family, None, None


def _oracle_suffix(major):
    """Oracle 的版本字母：10g/11g 是 g，12c 及以后是 c（19c / 21c）。"""
    return 'g' if major < 12 else 'c'


def format_version_label(family, major, minor=None):
    """给人看的版本标签，如 `Oracle 11g (11.2)` / `MySQL 8.0` / `SQL Server 2008`。"""
    if not family or major is None:
        return '未知版本'
    if family == 'oracle':
        base = 'Oracle %d%s' % (major, _oracle_suffix(major))
        return '%s (%s)' % (base, ('%d.%d' % (major, minor)) if minor is not None else str(major))
    if family == 'sqlserver':
        return 'SQL Server %d' % major
    label = {'mysql': 'MySQL', 'postgresql': 'PostgreSQL', 'gbase': 'GBase'}.get(family, family)
    return '%s %d.%d' % (label, major, minor if minor is not None else 0)


# ────────────────────────────────────────────────────────────────
# 规则表
# ────────────────────────────────────────────────────────────────
# 每条规则：
#   id        稳定标识（前端/测试引用）
#   since     ("family", 起始 major) 或 ("family", major, minor)：从哪个版本起才支持
#   pattern   在"已屏蔽字符串与注释"的 SQL 上匹配的正则
#   flags     re.I 等
#   msg       人类可读的结论（写清"用了什么、目标库不支持、为什么"）
#   alt       正确的替代写法（提示词与预检都要用）
#   rewrite   可选，确定性改写类型；目前只支持 'rownum_wrap'
_RULES = [
    # ── Oracle 12c 起才有的语法（11g 是生产上最常见的版本）──
    dict(id='oracle.fetch_first', family='oracle', since=(12,),
         pattern=r'\bFETCH\s+(?:FIRST|NEXT)\s+\d+\s+ROWS?\s+ONLY\b',
         msg='`FETCH FIRST/NEXT n ROWS ONLY` 是 Oracle 12c 起才支持的语法，11g 会报 ORA-00933',
         alt='SELECT * FROM ( ... ORDER BY 排序列 ) WHERE ROWNUM <= n',
         rewrite='rownum_wrap'),
    dict(id='oracle.offset_fetch', family='oracle', since=(12,),
         pattern=r'\bOFFSET\s+\d+\s+ROWS?\b',
         msg='`OFFSET ... ROWS` 分页是 Oracle 12c 起才支持的语法，11g 会报 ORA-00933',
         alt='用 ROWNUM 双层子查询模拟（外层 rn > 起点，内层 rn <= 终点）；仅取前 n 行可直接用 ROWNUM <= n'),
    dict(id='oracle.identity', family='oracle', since=(12,),
         pattern=r'\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b|\bIDENTITY\s*\(\s*\d*\s*\)',
         msg='`IDENTITY` 列是 Oracle 12c 起才支持的语法（11g 用 SEQUENCE + TRIGGER 或 SYS_GUID）',
         alt='CREATE SEQUENCE seq_x; 列默认值用 seq_x.NEXTVAL'),
    dict(id='oracle.json_func', family='oracle', since=(12,),
         pattern=r'\bJSON_(?:VALUE|QUERY|TABLE|EXISTS|OBJECT|ARRAY|MERGE_PATCH|_TEXTCONTAINS)\s*\(',
         msg='`JSON_*` 系列函数是 Oracle 12c 起才支持的（11g 需自行解析 CLOB/VARCHAR2 文本）',
         alt='11g 下用 SUBSTR/INSTR/REGEXP_SUBSTR 手工解析，或改用 XMLTYPE + EXTRACTVALUE'),
    dict(id='oracle.match_recognize', family='oracle', since=(12,),
         pattern=r'\bMATCH_RECOGNIZE\s*\(',
         msg='`MATCH_RECOGNIZE` 是 Oracle 12c 起才支持的语法',
         alt='11g 下用分析函数（LAG/LEAD）+ 分组改写'),
    dict(id='oracle.lateral', family='oracle', since=(12,),
         pattern=r'\bLATERAL\s*\(|\bCROSS\s+APPLY\b|\bOUTER\s+APPLY\b',
         msg='`LATERAL` / `CROSS APPLY` 是 Oracle 12c 起才支持的语法',
         alt='11g 下用关联子查询或在应用层分两步查'),
    dict(id='oracle.approx_count', family='oracle', since=(12,),
         pattern=r'\bAPPROX_COUNT_DISTINCT\s*\(',
         msg='`APPROX_COUNT_DISTINCT` 是 Oracle 12c 起才支持的函数',
         alt='11g 下用 COUNT(DISTINCT 列)'),
    dict(id='oracle.order_null_12', family='oracle', since=(12,),
         pattern=r'\bNULLS\s+(?:FIRST|LAST)\b',
         msg='`NULLS FIRST/LAST` 的排序支持在 Oracle 11g 上不稳定（12c 起才完全可靠）—— 若报 ORA-00933/ORA-01785 请改写',
         alt='用 CASE WHEN 排序列 IS NULL THEN 1 ELSE 0 END 显式控制 NULL 位置'),

    # ── MySQL 8.0 起才有的语法 ──
    dict(id='mysql.cte', family='mysql', since=(8, 0),
         pattern=r'(?:^|[\s(])WITH\s+[\w`]+\s+AS\s*\(',
         msg='CTE（`WITH ... AS (...)`）是 MySQL 8.0 起才支持的语法，5.7 会报 ERROR 1064',
         alt='改写成派生表（FROM (SELECT ...) x）或多层子查询'),
    dict(id='mysql.window_func', family='mysql', since=(8, 0),
         pattern=r'\b(?:ROW_NUMBER|RANK|DENSE_RANK|PERCENT_RANK|CUME_DIST|NTILE|LAG|LEAD|FIRST_VALUE|LAST_VALUE|NTH_VALUE)\s*\([^)]*\)\s*OVER\s*\(',
         msg='窗口函数（`... OVER (...)`）是 MySQL 8.0 起才支持的语法，5.7 不支持',
         alt='用会话变量（@rn := @rn + 1）或应用层分组统计'),
    dict(id='mysql.json_table', family='mysql', since=(8, 0),
         pattern=r'\bJSON_TABLE\s*\(',
         msg='`JSON_TABLE` 是 MySQL 8.0 起才支持的函数',
         alt='5.7 下用 JSON_EXTRACT / JSON_EXTRACT 逐字段取'),

    # ── SQL Server 2012 起才有的分页语法 ──
    dict(id='mssql.offset_fetch', family='sqlserver', since=(2012,),
         pattern=r'\bOFFSET\s+\d+\s+ROWS?\b|\bFETCH\s+(?:FIRST|NEXT)\s+\d+\s+ROWS?\s+ONLY\b',
         msg='`OFFSET ... FETCH NEXT` 分页是 SQL Server 2012 起才支持的，2008/2008R2 会报"关键字 OFFSET 附近有语法错误"',
         alt='改用 ROW_NUMBER() OVER (ORDER BY ...) 子查询 + BETWEEN 过滤'),
]

_RULES_BY_ID = {r['id']: r for r in _RULES}

# 各家族"支持但容易记错"的写法，写进提示词避免模型过度保守
_SUPPORTED_NOTES = {
    'oracle': '11g 及以后**支持**：WITH 子查询、LISTAGG、PIVOT/UNPIVOT、REGEXP_*、分析函数（ROW_NUMBER/OVER）、'
              'PARTITION BY、DBMS_LOB 等',
    'mysql': 'MySQL 5.7 **支持**：JSON_EXTRACT、GROUP_CONCAT、派生表、UNION',
    'sqlserver': 'SQL Server 2008 **支持**：ROW_NUMBER()、CTE（WITH）、PIVOT/UNPIVOT',
}


def rules_for(family, major, minor=None):
    """返回该版本下**不被支持**的规则列表（即 since 高于当前版本的规则）。"""
    out = []
    if not family or major is None:
        return out
    for r in _RULES:
        if r['family'] != family:
            continue
        since = r['since']
        need_major = since[0]
        need_minor = since[1] if len(since) > 1 else 0
        if family == 'sqlserver':
            # 年份型版本：低于起始年份才违规
            if major < need_major:
                out.append(r)
            continue
        if major < need_major or (major == need_major and (minor or 0) < need_minor):
            out.append(r)
    return out


def _mask_literals(sql):
    """把字符串字面量与注释替换成等长空格，避免把 `'FETCH FIRST'` 这种普通文本当语法。

    只在被遮蔽后的文本上做正则匹配，偏移量与原文一致（方便前端高亮/改写定位）。
    """
    if not sql:
        return ''
    out = list(sql)
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        if c == "'":                       # 单引号字符串（'' 为转义）
            j = i + 1
            while j < n:
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            for k in range(i, min(j, n)):
                out[k] = ' '
            i = j
            continue
        if c == '-' and i + 1 < n and sql[i + 1] == '-':      # 行注释
            j = sql.find('\n', i)
            j = n if j == -1 else j
            for k in range(i, j):
                out[k] = ' '
            i = j
            continue
        if c == '/' and i + 1 < n and sql[i + 1] == '*':      # 块注释
            j = sql.find('*/', i + 2)
            j = n if j == -1 else j + 2
            for k in range(i, min(j, n)):
                out[k] = ' '
            i = j
            continue
        i += 1
    return ''.join(out)


def check_sql(sql, family, major, minor=None):
    """对 SQL 做方言预检。

    Returns:
        [{'id', 'msg', 'alt', 'match', 'snippet', 'rewrite'?}]，无违规时返回 []。
    """
    masked = _mask_literals(sql or '')
    if not masked:
        return []
    out = []
    for r in rules_for(family, major, minor):
        m = re.search(r['pattern'], masked, re.I)
        if not m:
            continue
        item = {
            'id': r['id'],
            'msg': r['msg'],
            'alt': r['alt'],
            'match': m.group(0),
            'snippet': sql[max(0, m.start() - 30):m.end() + 30],
        }
        if r.get('rewrite'):
            item['rewrite'] = r['rewrite']
        out.append(item)
    return out


# ────────────────────────────────────────────────────────────────
# 确定性改写：只做语义能保证等价的少数情况
# ────────────────────────────────────────────────────────────────

_STMT_TAIL_FETCH_RE = re.compile(
    r'\s*\bFETCH\s+(?:FIRST|NEXT)\s+(\d+)\s+ROWS?\s+ONLY\s*;?\s*$', re.I)


def can_rewrite_rownum_wrap(sql):
    """判断能否安全地把"语句末尾的 FETCH FIRST/NEXT n ROWS ONLY"改写成 ROWNUM 子查询。

    只在**同时**满足下列条件时允许（否则只给指引、不动手）：
      1. 目标语句是**单条** SELECT（不含分号分隔的多条）；
      2. `FETCH ... ONLY` 出现在**整条语句的最末尾**（不是嵌在 IN (...) 里）；
      3. 语句里没有 `OFFSET`（OFFSET 的等价改写涉及双层 ROWNUM，容易改错，不自动做）；
      4. 不是 PL/SQL 块。

    为什么必须包一层子查询：`SELECT ... ORDER BY c DESC` 后面直接加 `WHERE ROWNUM <= 20`
    是**错的** —— ROWNUM 在排序**之前**分配，会先取 20 行再排序，结果完全不同。
    正确写法是 `SELECT * FROM ( ... ORDER BY c DESC ) WHERE ROWNUM <= 20`。
    """
    masked = _mask_literals(sql or '')
    s = (sql or '').strip()
    if not s or not masked:
        return False, ''
    if ';' in masked.rstrip().rstrip(';'):        # 多语句（中间还有分号）→ 不自动改
        return False, ''
    if not re.match(r'^\s*(?:--[^\n]*\n|\s)*SELECT\b', masked, re.I):
        return False, ''
    if re.search(r'\bOFFSET\s+\d+\s+ROWS?\b', masked, re.I):
        return False, ''
    if re.search(r'\b(?:BEGIN|DECLARE)\b\s', masked, re.I):
        return False, ''
    m = _STMT_TAIL_FETCH_RE.search(masked)
    if not m:
        return False, ''
    return True, m.group(1)


def rewrite_rownum_wrap(sql):
    """把末尾的 FETCH FIRST/NEXT n ROWS ONLY 改写成 `SELECT * FROM ( ... ) WHERE ROWNUM <= n`。

    返回改写后的 SQL；无法安全改写时**原样返回**（调用方自行判断是否可用 can_rewrite_rownum_wrap）。
    """
    ok, n = can_rewrite_rownum_wrap(sql)
    if not ok:
        return sql
    # 注意：`;` 是在 FETCH 子句里被一起吃掉的，所以要看**原始 SQL** 的结尾，
    # 不能看去掉 FETCH 之后的 body。
    had_semi = (sql or '').rstrip().endswith(';')
    body = _STMT_TAIL_FETCH_RE.sub('', sql).strip().rstrip(';').rstrip()
    new_sql = 'SELECT * FROM (\n%s\n) WHERE ROWNUM <= %s' % (body, n)
    return new_sql + (';' if had_semi else '')


def rewrite_sql(sql, rewrite_kind):
    """按规则的 rewrite 类型做确定性改写；不认识的类型原样返回。"""
    if rewrite_kind == 'rownum_wrap':
        return rewrite_rownum_wrap(sql)
    return sql


# ────────────────────────────────────────────────────────────────
# 提示词片段
# ────────────────────────────────────────────────────────────────

def build_dialect_prompt(facts):
    """把"数据源 → 版本 → 禁用语法清单"拼成提示词片段。

    Args:
        facts: [{'name','db_type','version'}]
    Returns:
        提示词片段字符串；无可用信息时返回 ''。
    """
    if not facts:
        return ''
    blocks = []
    for f in facts:
        family, major, minor = parse_version(f.get('version') or '', f.get('db_type') or '')
        label = format_version_label(family, major, minor)
        raw = (f.get('version') or '').strip()
        head = '- **%s**：%s' % (f.get('name') or '(未命名)', label)
        if raw:
            head += '（原始版本串：%s）' % raw[:100]
        forbidden = rules_for(family, major, minor)
        if forbidden:
            lines = [head, '  ⚠ 该版本**不支持**下列语法，写 SQL 时必须避开（这是最常踩的坑）：']
            for r in forbidden:
                lines.append('   · %s' % r['msg'])
                lines.append('     → 正确写法：%s' % r['alt'])
            note = _SUPPORTED_NOTES.get(family)
            if note:
                lines.append('   · %s' % note)
            blocks.append('\n'.join(lines))
        else:
            if not family or major is None:
                # 版本未知：不列"支持写法"，而是强制保守降级 —— 对未知版本猜高版本语法
                # 比保守写法更容易报错（如 11g 遇 FETCH FIRST）。
                blocks.append(head
                              + '\n  ⚠ **版本未知**，无法确定该库支持哪些语法。'
                                '生成和改写任何 SQL 时必须只用**各版本都支持的最保守写法**：'
                              + '\n   · 分页：禁用 `FETCH/OFFSET`，用普通筛选或先取全量再在应用层截断；'
                              + '\n   · 不用窗口函数(`OVER`)、CTE(`WITH`)、`MATCH_RECOGNIZE`、`PIVOT`、`JSON_*`、`FETCH FIRST` 等较新语法；'
                              + '\n   · 拿不准的语法一律不用，宁可用更繁琐但确定的写法，绝不赌高版本特性。')
            else:
                note = _SUPPORTED_NOTES.get(family)
                blocks.append(head + (('\n   · %s' % note) if note else ''))
    if not blocks:
        return ''
    return ('## 目标库方言禁区（生成任何 SQL 前逐条核对，违规必然报错）\n'
            + '\n'.join(blocks)
            + '\n若某条语法不确定目标版本是否支持，就用**各版本都支持的最保守写法**，不要赌。\n')
