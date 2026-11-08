# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""建议 SQL 的「槽位」识别 · 自动填充 · 候选补全 · 执行前校验。

场景说明（与结果变量的区别）
-----------------------------------
``sql_vars.py`` 的会话级 ``@rN`` 是**结果变量**，带入的是前序查询已经拿到的值；
AI 自动取数的查询（写 ``${db.schema}`` 这类占位、系统静默代入后执行）由取数链路
自己处理，不归本模块。
本模块处理的是 **AI 给出的建议 SQL**：语句是给 DBA 手动执行的，里面常常残留
退化占位符，例如：

    SELECT owner, table_name, tablespace_name FROM dba_tables
    WHERE table_name = '<表名>';

    SELECT owner, index_name, tablespace_name FROM dba_indexes
    WHERE index_name = '<索引名>';

直接点「执行SQL」的结果是 0 行 —— 用户无法区分"填错了"还是"真没数据"。

设计目标同样是"快捷 + 精确 + 可靠"，但主体从"系统自动执行"变成"人机协同编辑"：

    快捷：能自动填的一律自动填（从上文/报错/元数据），不让人手打
    精确：槽位语义（表名/索引名/owner/表空间）被识别 → 候选来自对应数据字典
    可靠：填完执行前校验对象是否存在，不存在则给相似候选

四种占位写法统一识别（兼容 AI 的任意退化输出，也兼容 Navicat/DBeaver 习惯）：

    '<表名>'   '表名'   <table_name>   {{table}}   :table_name   #表名#   [表名]

归属与实现约束
--------------
归属说明：本模块的槽位识别、角色推断、上下文收割、自动填充、候选补全与执行前校验
算法归 MIT License, Copyright (c) 2025-2026 fiyo (Jack Ge)
<sdfiyon@gmail.com> 所有。只用标准库 ``difflib`` / ``re``，零第三方依赖。

* 方言家族由 ``modules.ai.sql_safety._family_of`` 提供（口径
  ``modules.ai.dialect.family_alias``）；
* 校验能力来自兄弟模块 ``sql_autoverify``，统一经 ``_load_av()`` 取用，
  调用点保持单一入口；
* 默认执行器是 ``modules.ai.tools.sql_tools.tool_execute_sql``；
* docstring 与注释里的对象名示例一律换成虚构名（不含企业名/真实主机/凭据）。
"""

import difflib
import re

# ─────────────────────────── 槽位模型 ───────────────────────────

# 角色 → 关键词（用于从占位符名推断语义）；顺序即优先级
_ROLE_KEYWORDS = [
    ('tablespace', ['表空间', 'tablespace', 'ts_name', 'tsname']),
    ('index', ['索引', 'index', 'idx']),
    ('table', ['表名', '表', 'table', 'tab_name', 'tablename', 'object_name', '对象名']),
    ('owner', ['owner', 'schema', '用户名', '用户', '模式', '属主']),
    ('column', ['列名', '字段名', '列', '字段', 'column', 'col_name']),
    ('time', ['时间', '日期', '起始', '结束', 'time', 'date', 'start', 'end', 'since']),
    ('number', ['数量', '条数', '阈值', 'top', 'limit', 'count', 'threshold', 'num']),
    # 必须放最后：`值`/`value` 这类词太泛，只有前面所有角色都没命中时才轮到它
    ('value', ['取值', '字段值', '值', 'value']),
]

_VALID_ROLES = ('table', 'index', 'owner', 'tablespace', 'column', 'time', 'number',
                'value', 'unknown')

# 从 SQL 列名反推角色（比占位符名更可靠）：WHERE table_name = '<x>'
_COL_ROLE = [
    ('table_name', 'table'), ('tablename', 'table'), ('table', 'table'),
    ('segment_name', 'table'), ('object_name', 'table'),
    ('index_name', 'index'), ('indexname', 'index'),
    ('owner', 'owner'), ('table_owner', 'owner'), ('schema_name', 'owner'),
    ('tablespace_name', 'tablespace'), ('tablespace', 'tablespace'),
    ('column_name', 'column'), ('col_name', 'column'),
]

# 单个标识符（列名/对象名），用于"字段值"槽位判断与拼接 SQL 前的防注入校验
_IDENT_SAFE = re.compile(r'^[A-Za-z_][A-Za-z0-9_$#]*$')

# 尖括号写法：内部不允许空白与运算符，避免把 `WHERE a < 5 AND b > 3` 误判成槽位
_ANGLE_RE = re.compile(r'([\'"]?)<([^<>\s]{1,40})>([\'"]?)')
_ANGLE_NAME_RE = re.compile(r'^[\u4e00-\u9fa5A-Za-z_#][\u4e00-\u9fa5\w.$#-]*$')
# 其它写法（只在"代码区"扫描，避免命中字符串里的时间格式与 URL）
_HASH_RE = re.compile(r'#([\u4e00-\u9fa5A-Za-z_][\u4e00-\u9fa5\w]{0,39})#')
_BRACE_RE = re.compile(r'\{\{\s*([\u4e00-\u9fa5A-Za-z_][\u4e00-\u9fa5\w.]*)\s*\}\}')
_BRACKET_RE = re.compile(r'\[([\u4e00-\u9fa5][\u4e00-\u9fa5\w]{0,19})\]')
_COLON_RE = re.compile(r'(?<![:\w$@]):([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]{0,39})')
_STR_LIT_RE = re.compile(r"'(?:[^']|'')*'")

# ── 命名式占位符：`'YOUR_TABLESPACE'` 这种"AI 没写尖括号、直接写成一个占位词"的写法 ──
# 为什么必须支持：AI 生成 SQL 时非常爱写 `WHERE tablespace_name = 'YOUR_TABLESPACE'`，
# 只认 `<表名>`/`${x}`/`{{x}}`/`#表名#`/`[表名]`/`:name` 这几种写法会识别出 0 个槽位，
# 用户右键只看到"未发现占位符"，完全没有替换入口；执行则静默返回 0 行。
#
# 只认**信号足够强**的命名，绝不搞"全大写就是占位符"这种猜测 ——
# 否则真实的 `'TABLE'` / `'ACTIVE'` / `'USERS'` 会被误认成占位符，反而更烦。
_NAMED_PLACEHOLDER_RE = re.compile(
    r'^(?:'
    r'(?:your|my|our)_[A-Za-z0-9_]{1,40}'                     # YOUR_TABLESPACE / MY_SCHEMA
    r'|x{2,}[A-Za-z0-9_]*'                                     # XXX / XXX_VALUE
    r'|(?:tbd|todo|placeholder|replace[_-]?me|change[_-]?me|fill[_-]?me|to[_-]?be[_-]?filled)'
    r'|待填|待替换|请填写|请替换|请补全'
    r')$', re.I)

# 冒号写法的常见误报（Oracle 格式串片段、时间、协议等）
_COLON_STOP = {'mi', 'ss', 'hh', 'hh24', 'dd', 'mm', 'yyyy', 'mon', 'day', 'am', 'pm',
               'ff', 'tzr', 'tz_abbr', 'www', 'j', 'q', 'iw', 'yy', 'rm'}


class Slot(object):
    """建议 SQL 中的一个待替换位置"""

    __slots__ = ('raw', 'name', 'role', 'span', 'quote', 'style', 'hint', 'col_ref')

    def __init__(self, raw, name, role, span, quote='', style='angle', hint='', col_ref=''):
        self.raw = raw
        self.name = name
        self.role = role
        self.span = span
        self.quote = quote          # 原文包裹的引号（决定回填时是否保留引号）
        self.style = style          # angle / hash / brace / bracket / colon
        self.hint = hint
        self.col_ref = col_ref      # 左邻列名（如 table_name）—— 决定值要不要带 owner

    def to_dict(self):
        return {'raw': self.raw, 'name': self.name, 'role': self.role,
                'quote': self.quote, 'style': self.style, 'hint': self.hint,
                'col_ref': self.col_ref, 'start': self.span[0], 'end': self.span[1]}


# 这些列存的是"纯对象名"，值里带 owner 前缀会查不到
_BARE_NAME_COLS = {'table_name', 'tablename', 'index_name', 'indexname',
                   'object_name', 'segment_name', 'column_name', 'col_name', '表名', '索引名'}


def _blank_literals(sql):
    """把字符串字面量替换成等长空白，便于只在"代码区"扫描占位符。

    `'HH24:MI:SS'` 里的 `:MI`、`'http://example.com'` 里的 `:x` 都不该被当成槽位；
    而 `'<表名>'` 由尖括号规则单独处理（它本来就常在引号内）。
    """
    return _STR_LIT_RE.sub(lambda m: ' ' * len(m.group(0)), sql or '')


def infer_role(name, sql='', span=None):
    """推断槽位语义角色：先用占位符名，再用 SQL 上下文（左邻列名）兜底。

    Returns: (role, col_ref)
    """
    low = (name or '').strip().lower()
    col_ref = ''
    if sql and span:
        left = sql[:span[0]].rstrip()
        # 必须覆盖 `>` / `>=` / `<` / `<=` —— 时间类占位符几乎都长这样
        # （`WHERE created_at > '<起始时间>'`），漏了它们就拿不到列名，
        # 于是"字段值/时间"槽位无法确定该去哪一列取候选。
        # 长的运算符要排在前面（`<=` 先于 `<`），否则会被短的那个先匹配掉。
        m = re.search(r'([A-Za-z_][A-Za-z0-9_]*|[表索引属主字段列]{1,3}[名]?)\s*'
                      r'(?:<=|>=|<>|!=|=|<|>|LIKE|IN)\s*\(?\s*[\'"]?$', left, re.I)
        if m:
            col_ref = m.group(1).lower()
    for role, kws in _ROLE_KEYWORDS:
        for kw in kws:
            if kw in low:
                return role, col_ref
    if col_ref:
        for cname, role in _COL_ROLE:
            if col_ref == cname:
                return role, col_ref
        if col_ref in ('表名', '索引名', '表', '索引'):
            return ('table' if '表' in col_ref else 'index'), col_ref
        # 落到这里说明左侧是一个**普通业务列**（status / deptno / owner_code …），
        # 占位符要的是这一列的**数据值**，而不是数据字典里的对象名 ——
        # 这是与 table/index/owner 最本质的差别，候选只能从真实数据里取。
        if _IDENT_SAFE.match(col_ref):
            return 'value', col_ref
    return 'unknown', col_ref


def extract_slots(sql):
    """识别建议 SQL 中的所有槽位（六种写法：angle / hash / brace / bracket / colon / named）。

    `named` 即 `'YOUR_TABLESPACE'` 这类"AI 直接写一个占位词"的写法 ——
    见 `_NAMED_PLACEHOLDER_RE` 的说明。返回 [Slot]，按出现顺序、已去重。
    """
    sql = sql or ''
    found = []

    for m in _ANGLE_RE.finditer(sql):
        inner = m.group(2)
        if not _ANGLE_NAME_RE.match(inner):
            continue
        q1, q2 = m.group(1), m.group(3)
        quote = q1 if (q1 and q1 == q2) else ''
        found.append((m.start(), m.end(), inner, quote, 'angle', m.group(0)))

    # 命名式占位符（必须在**原始** SQL 上扫 —— 它们本来就是字符串字面量，
    # 而下面 `_blank_literals` 会把字面量抹掉）
    for m in _STR_LIT_RE.finditer(sql):
        inner = m.group(0)[1:-1]
        if not inner or not _NAMED_PLACEHOLDER_RE.match(inner):
            continue
        # raw 含引号、quote="'"，替换时整体替换成 `'真实值'`（引号不会丢）
        found.append((m.start(), m.end(), inner, "'", 'named', m.group(0)))

    code = _blank_literals(sql)
    for rx, style in ((_HASH_RE, 'hash'), (_BRACE_RE, 'brace'),
                      (_BRACKET_RE, 'bracket'), (_COLON_RE, 'colon')):
        for m in rx.finditer(code):
            nm = m.group(1)
            if style == 'colon' and nm.lower() in _COLON_STOP:
                continue
            found.append((m.start(), m.end(), nm, '', style, m.group(0)))

    found.sort(key=lambda x: x[0])
    out, seen = [], set()
    for start, end, name, quote, style, raw in found:
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        role, col_ref = infer_role(name, sql, (start, end))
        out.append(Slot(raw, name, role, (start, end), quote, style, col_ref=col_ref))
    return out


# ─────────────────── 手工替代：把"用户选中的一段 SQL"当成槽位 ───────────────────
#
# 前两节解决的是"AI 留下的占位符"。但真实的运维场景里还有一类需求：
# **SQL 里根本没有占位符，或者占位符之外的地方写错了，用户想自己改。**
# 例如把 `FROM dba_tables` 改成 `FROM dba_segments`、把 `'TABLE'` 改成 `'INDEX'`。
# 这类只能靠"用户在 SQL 上选一段 → 替换"来支持。
#
# 与占位符识别的根本差别：选中的是**真实内容**（不是 `<表名>`），
# 所以角色的推断**只能看上下文**，绝不能拿选中文本本身去匹配角色关键词 ——
# 否则选中值 `'TABLE'` 会因为文本里含 "table" 被误判成"表名"。

_FROM_JOIN_RE = re.compile(r'\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+$', re.I)
# 逗号续接的多表（`FROM a, b`）里，第二个表名前面并不是 FROM/JOIN。
# 必须排除已经进入 WHERE/GROUP/ORDER 的情况，否则 `WHERE a=1, b` 会被误判成表列表。
_FROM_LIST_RE = re.compile(
    r'\bfrom\b(?:(?!\bwhere\b|\bgroup\b|\border\b|\bhaving\b|\bset\b|\bjoin\b)[^;])*,\s*$', re.I)


def extract_manual_slot(sql, start, end):
    """把用户手工选中的 `sql[start:end]` 变成一个可替换的槽位。

    Returns: Slot 或 None（选区为空/越界时）
    """
    sql = sql or ''
    try:
        start, end = int(start), int(end)
    except (TypeError, ValueError):
        return None
    start, end = max(0, start), min(len(sql), end)
    if end <= start:
        return None
    raw = sql[start:end]
    if not raw.strip():
        return None

    # 选中内容自带成对引号时，把引号当作"外层引号"（换值后仍然保留引号）
    quote, name = '', raw.strip()
    if len(name) >= 2 and name[0] == name[-1] and name[0] in ('"', "'", '`'):
        quote, name = name[0], name[1:-1].strip()

    # 关键：name 传空串 —— 只让 infer_role 走"左邻列名"这条线，
    # 不要用选中文本去匹配角色关键词。
    role, col_ref = infer_role('', sql, (start, end))

    # 单个 token（可带引号的短语也算）才谈得上"去字典/数据里找候选"；
    # 选了一整段子句（含空白、换行）就只能是纯手工输入，别硬给候选。
    is_token = (quote != '') or bool(re.match(r'^\S{1,80}$', name))
    if not is_token:
        return Slot(raw, name or raw, 'unknown', (start, end), quote, 'manual')

    if role == 'unknown':
        before = sql[:start]
        if _FROM_JOIN_RE.search(before) or _FROM_LIST_RE.search(before):
            role = 'table'          # FROM/JOIN 之后、或 FROM 列表里逗号之后 → 表名
        elif col_ref:
            role = 'value'          # `列 = xxx` → 该列的字段值
        # 其余情况保持 unknown：例如 SELECT 列表里的裸列名 —— 这时给"字段值"
        # 反而会误导（它既不是对象名也不是某列的取值），老实留空让人手输。
    return Slot(raw, name or raw, role, (start, end), quote, 'manual', col_ref=col_ref)


def apply_values(sql, slots, values):
    """把槽位值回填进 SQL（按位置从后往前替换，避免位移错乱）。

    values: {槽位名: 值}；值为 None/'' 的槽位保持原样（不破坏 SQL）。
    带引号的槽位保留引号并对值做转义；不带引号的直接替换。

    **幂等保护**：若 span 处的文本已不是槽位原文（说明调用方传入的是
    已经替换过的 SQL，或 SQL 被改过），跳过该槽位而不是硬替换 ——
    否则会按失效的位置切字符串，把语句改烂（如 `'EMP'LLEDLOG'` 这类）。
    """
    if not slots:
        return sql
    text = sql
    for slot in sorted(slots, key=lambda s: -s.span[0]):
        val = (values or {}).get(slot.name)
        if val is None or val == '':
            continue
        s, e = slot.span
        if text[s:e] != slot.raw:
            continue
        v = str(val)
        if slot.quote:
            v = slot.quote + v.replace(slot.quote, slot.quote * 2) + slot.quote
        text = text[:s] + v + text[e:]
    return text


# ─────────────────────────── 上下文自动填充 ───────────────────────────

# 从上文（对话 / 报错信息 / 工具结果）里抽取候选值的模式
_PATTERNS = {
    # 各数据库"对象不存在"的报错（带引号或明确分隔，名字可靠）
    'mysql_obj': re.compile(r"Table\s+'([\w$.]+)'\s+doesn't exist", re.I),
    'pg_obj': re.compile(r'relation\s+"([\w$.]+)"\s+does not exist', re.I),
    'mssql_obj': re.compile(r"Invalid object name\s+'([\w$.\[\]]+)'", re.I),
    # Oracle 的 ORA-00942 报错文本**不含对象名**（只有 "table or view does not exist"），
    # 绝不能拿它后面的词当对象名 —— 否则会把 'table' 抽成对象。
    # ORA-00904 倒是带列名（引号包裹），只取它，且归类为列。
    'ora_column': re.compile(r'ORA-00904\s*:\s*"([\w$#]+)"', re.I),
    # 正文里大写形式的 OWNER.TABLE（巡检结论常见写法）
    'ora_qual': re.compile(r'\b([A-Z][A-Z0-9_$#]{1,29})\.([A-Z][A-Z0-9_$#]{1,29})\b'),
    # 中文标签 + 对象名："表 DEMO01.CALL_LOG"、"索引 PK_X"、"表名：EMP"
    # 注意要用词组而非单字符类：`[表索引]` 匹配 "索引" 时会落在 "引" 上，
    # 于是 "索引 PK_XXX" 会被误判成表名，进而污染表名池导致自动填充失效。
    'cn_obj': re.compile(r'(表名|索引名|索引|表)\s*[:：]?\s*[「\'"]?([A-Za-z_][\w$#.]{1,40})'),
    # 列 = '值'：AI 的结论里常直接写出取值（STATUS='FAILED'、owner='DEMO_USER'）。
    # 但**前端把整条 AI 消息（含 SQL 代码块）都当作上下文**，所以 `WHERE x = '<表名>'`
    # 也会命中这里 —— 值形如占位符时必须在下面过滤掉，否则会把占位符当成真实取值。
    'col_val': re.compile(r"([A-Za-z_][A-Za-z0-9_$#]{1,30})\s*(?:=|<>|!=|LIKE)\s*'([^'\n]{1,80})'"),
    # 中文写法："状态为 FAILED"、"类型：TABLE"（拿不到列名，只能作为兜底信号）
    'cn_val': re.compile(r'(?:状态|类型|级别|模式|标签)\s*(?:为|是|：|:|=)\s*[\'"]?([A-Za-z0-9_\-.]{1,40})'),
}

# 形如占位符的值 —— 不是真实取值，必须排除
_PLACEHOLDER_LIKE_RE = re.compile(
    r'(^\s*<[^<>]*>\s*$)|(^\s*\$\{)|(^\s*\{\{)|(^\s*#.+#\s*$)|(^\s*\[.+\]\s*$)|(^\s*:[A-Za-z_])')

# 索引名的常见命名模式（用于把"表名池"和"索引池"分开，避免互相污染）
_INDEX_NAME_RE = re.compile(r'^(?:PK|IX|IDX|UK|UNQ|AK|SK)_|_(?:PK|IX|IDX|UK|UNQ)$', re.I)


def harvest_context(texts, current_schema=''):
    """从上文文本中抽取可用于填充的对象名，**并按角色分池**。

    这是"快捷"的关键：AI 在分析里其实已经知道是哪个表/索引出问题，
    却把值退化成 `<表名>`；这里把它捡回来自动填上。

    必须分池：把索引名混进表名池，池里就有 2 个值，系统便不敢自动填 ——
    "索引 PK_CALL_LOG" 会被误当成第二个表名。

    Returns: {'table': [...], 'index': [...], 'owner': [...], 'column': [...], 'raw': [...]}
    """
    tables, indexes, owners, columns, raw = [], [], [], [], []
    col_values = {}     # {列名(大写): [取值...]}；'*' 键存放拿不到列名的中文写法取值
    for t in texts or []:
        if not t:
            continue
        for key in ('mysql_obj', 'pg_obj', 'mssql_obj'):
            for m in _PATTERNS[key].finditer(t):
                v = m.group(1).strip('[]')
                nm = v.rsplit('.', 1)[-1]
                (indexes if _INDEX_NAME_RE.match(nm) else tables).append(nm)
                if '.' in v:
                    owners.append(v.rsplit('.', 1)[0])
                raw.append(v)
        for m in _PATTERNS['ora_column'].finditer(t):
            columns.append(m.group(1))
        for m in _PATTERNS['ora_qual'].finditer(t):
            o, n = m.group(1), m.group(2)
            if n.upper() in ('SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL',
                             'TABLE', 'VIEW', 'INDEX', 'DUAL'):
                continue
            (indexes if _INDEX_NAME_RE.match(n) else tables).append(n)
            owners.append(o)
            raw.append('%s.%s' % (o, n))
        for m in _PATTERNS['cn_obj'].finditer(t):
            label, v = m.group(1), m.group(2)
            if v.upper() in ('SPACE', 'NAME'):
                continue
            (indexes if '索引' in label else tables).append(v)
            raw.append(v)
        for m in _PATTERNS['col_val'].finditer(t):
            cname, v = m.group(1).upper(), m.group(2).strip()
            # 排除占位符本身与 LIKE 模式（'A%' 是模式不是取值）
            if not v or _PLACEHOLDER_LIKE_RE.match(v) or '%' in v or '_' == v:
                continue
            # 这些列存的是"对象名"，属于 table/index 槽位的领域，不算字段值
            if cname.lower() in _BARE_NAME_COLS:
                continue
            col_values.setdefault(cname, []).append(v)
        for m in _PATTERNS['cn_val'].finditer(t):
            v = m.group(1).strip()
            if v and not _PLACEHOLDER_LIKE_RE.match(v):
                col_values.setdefault('*', []).append(v)

    def _uniq(seq):
        out, seen = [], set()
        for x in seq:
            x = (x or '').strip().strip('.')
            if x and x.upper() not in seen:
                seen.add(x.upper())
                out.append(x)
        return out

    def _dedupe_qualified(items):
        """同一对象的裸名与全名算一个：'EMP' 与 'SCOTT.EMP' → 只留 'SCOTT.EMP'。

        不去重的话，"表 EMP"和"OUNDER.EMP"会被当成两个不同对象，
        池里变成 2 个值，自动填充因"信号不唯一"而放弃 —— 实际只有一个对象。
        """
        by_bare, out = {}, []
        for x in items:
            bare = x.rsplit('.', 1)[-1].upper()
            if bare in by_bare:
                i = by_bare[bare]
                if '.' in x and '.' not in out[i]:
                    out[i] = x
            else:
                by_bare[bare] = len(out)
                out.append(x)
        return out

    def _uniq_vals(seq):
        """取值去重：**保留原始大小写与内容**（不能像对象名那样 strip('.') 或大写化，
        否则 'O''Brien'、'1.0.0' 这类真实取值会被改坏）。"""
        out, seen = [], set()
        for x in seq:
            s = (x or '').strip()
            if s and s not in seen:
                seen.add(s)
                out.append(s)
        return out

    return {'table': _dedupe_qualified(_uniq(tables)),
            'index': _dedupe_qualified(_uniq(indexes)),
            'owner': _uniq(owners), 'column': _uniq(columns), 'raw': _uniq(raw),
            'col_values': {k: _uniq_vals(v) for k, v in col_values.items()}}


def autofill(slots, known=None, current_schema=''):
    """自动为槽位取值。

    优先级：上文抽取到的对象名 > 当前 schema（owner 类槽位）。
    只在"同角色信号唯一"时自动填 —— 多个候选时留空交候选补全，避免填错。

    **关键细节**：像 `WHERE table_name = '<表名>'` 这类，该列存的是纯对象名，
    值里带 `OWNER.` 前缀反而永远查不到；而 `FROM <表名>` 位置则需要带 owner。
    所以由槽位的左邻列名（col_ref）决定要不要带前缀。
    """
    known = known or {}
    pools = {'table': known.get('table') or [], 'index': known.get('index') or [],
             'owner': known.get('owner') or [], 'column': known.get('column') or []}
    col_values = known.get('col_values') or {}
    raws = known.get('raw') or []
    values = {}

    for s in slots:
        bare = s.col_ref in _BARE_NAME_COLS
        pool = pools.get(s.role) or []
        if s.role in ('table', 'index') and len(pool) == 1:
            simple = pool[0].rsplit('.', 1)[-1]
            full = next((r for r in raws if r.upper().endswith('.' + simple.upper())), '')
            values[s.name] = simple if bare else (full or simple)
        elif s.role == 'owner':
            if len(pool) == 1:
                values[s.name] = pool[0]
            elif current_schema:
                values[s.name] = current_schema
        elif s.role == 'column' and len(pool) == 1:
            values[s.name] = pool[0]
        elif s.role in ('value', 'time'):
            # 字段值：只有当"该列"在上文里被明确写过一个取值时才自动填。
            # 多个取值（如结论里同时提到 SUCCESS 与 FAILED）一律留空让人选 ——
            # 自动猜错的值比空着更糟：它会静默查出错误结果。
            cv = col_values.get((s.col_ref or '').upper()) or []
            if len(cv) == 1:
                values[s.name] = cv[0]

    # 兜底：中文写法（"状态为 FAILED"）拿不到列名，只在**唯一一个**值型槽位时使用
    any_v = col_values.get('*') or []
    pending = [s for s in slots if s.role in ('value', 'time') and not values.get(s.name)]
    if len(any_v) == 1 and len(pending) == 1:
        values[pending[0].name] = any_v[0]

    # 联动：table 带 owner 前缀时，自动派生 owner 槽位（仅非 bare 场景）
    for s in slots:
        if s.role == 'table' and s.col_ref not in _BARE_NAME_COLS:
            v = values.get(s.name, '')
            if '.' in v:
                o = v.split('.')[0]
                for o2 in slots:
                    if o2.role == 'owner' and not values.get(o2.name):
                        values[o2.name] = o
    return values


# ─────────────────────────── 候选补全（按语义路由数据字典） ───────────────────────────

_CAND_SQL = {
    'oracle': {
        # 用 all_objects 而不是 all_tables：DBA_TABLES / DBA_SEGMENTS 这类都是**视图**，
        # 只查 all_tables 会把它们判成"不存在"，直接造成误报。
        'table': ("SELECT owner||'.'||object_name FROM all_objects "
                  "WHERE object_type IN ('TABLE','VIEW','SYNONYM','MATERIALIZED VIEW') "
                  "AND {kw} ROWNUM <= 60"),
        'index': "SELECT owner||'.'||index_name FROM all_indexes WHERE {kw} ROWNUM <= 60",
        'owner': "SELECT username FROM all_users WHERE {kw} ROWNUM <= 60",
        'tablespace': "SELECT tablespace_name FROM dba_tablespaces WHERE {kw} ROWNUM <= 60",
        'column': "SELECT DISTINCT column_name FROM all_tab_columns WHERE {kw} ROWNUM <= 60",
    },
    'mysql': {
        'table': "SELECT CONCAT(table_schema,'.',table_name) FROM information_schema.tables WHERE {kw} LIMIT 60",
        'owner': "SELECT schema_name FROM information_schema.schemata WHERE {kw} LIMIT 60",
        'column': "SELECT DISTINCT column_name FROM information_schema.columns WHERE {kw} LIMIT 60",
    },
    'postgresql': {
        'table': ("SELECT table_schema||'.'||table_name FROM information_schema.tables "
                  "WHERE {kw} LIMIT 60"),
        'index': "SELECT schemaname||'.'||indexname FROM pg_indexes WHERE {kw} LIMIT 60",
        'owner': "SELECT nspname FROM pg_namespace WHERE {kw} LIMIT 60",
        'column': "SELECT DISTINCT column_name FROM information_schema.columns WHERE {kw} LIMIT 60",
    },
    'sqlserver': {
        'table': ("SELECT TOP 60 s.name+'.'+o.name FROM sys.objects o "
                  "JOIN sys.schemas s ON s.schema_id=o.schema_id "
                  "WHERE o.type IN ('U','V','SN') AND {kw}"),
        'owner': "SELECT TOP 60 name FROM sys.schemas WHERE {kw}",
        'column': "SELECT DISTINCT TOP 60 name FROM sys.columns WHERE {kw}",
    },
}

# 各角色的模糊检索列（用于拼 {kw}）
_KW_COL = {
    'oracle': {'table': 'UPPER(object_name)', 'index': 'UPPER(index_name)',
               'owner': 'UPPER(username)', 'tablespace': 'UPPER(tablespace_name)',
               'column': 'UPPER(column_name)'},
    'mysql': {'table': 'UPPER(table_name)', 'owner': 'UPPER(schema_name)',
              'column': 'UPPER(column_name)'},
    'postgresql': {'table': 'UPPER(table_name)', 'index': 'UPPER(indexname)',
                   'owner': 'UPPER(nspname)', 'column': 'UPPER(column_name)'},
    'sqlserver': {'table': 'UPPER(o.name)', 'owner': 'UPPER(name)',
                  'column': 'UPPER(name)'},
}


def _lit(v):
    return "'" + str(v).replace("'", "''") + "'"


def build_candidate_sql(datasource_name, db_info, role, keyword='', scope='',
                        mode='contains'):
    """按槽位角色生成候选查询。

    Args:
        keyword: 用户输入的关键词（UI 输入即搜索用 contains，校验用 prefix）
        mode: contains —— `LIKE '%kw%'`，适合交互式搜索
              prefix   —— `LIKE 'kw%'`，适合校验：避免 "EMP_PKK" 命中
                          "WWV_FLOW_PLUG_TEMP_PK" 这类无关的包含匹配
    """
    from modules.ai.sql_safety import _family_of as _db_family
    fam = _db_family((db_info or {}).get('db_type', ''))
    tmpl = (_CAND_SQL.get(fam) or {}).get(role)
    col = (_KW_COL.get(fam) or {}).get(role)
    if not tmpl or not col:
        return ''
    conds = []
    if keyword:
        pat = (keyword.upper() + '%') if mode == 'prefix' else ('%' + keyword.upper() + '%')
        conds.append('%s LIKE %s' % (col, _lit(pat)))
    if role == 'column' and scope:
        conds.append('%s = %s' % ('UPPER(table_name)' if fam != 'sqlserver' else 'UPPER(OBJECT_NAME)',
                                  _lit(scope.upper())))
    kw = (' AND '.join(conds) + ' AND ') if conds else ''
    return tmpl.format(kw=kw)


def suggest_candidates(datasource_name, db_info, role, keyword='', scope='', runner=None,
                       mode='contains'):
    """按角色查数据字典给候选（带模糊检索）。

    这是"精确"的来源：角色决定去查哪张字典表 —— 表名查 all_tables、
    索引名查 all_indexes、owner 查 all_users、表空间查 dba_tablespaces。
    """
    if role in ('unknown', 'time', 'number', 'value'):
        # value 走 suggest_value_candidates（真实数据），不在这里查字典
        return []
    sql = build_candidate_sql(datasource_name, db_info, role, keyword, scope, mode)
    if not sql:
        return []
    res = _run(runner, datasource_name, sql)
    if res.get('error') or not res.get('rows'):
        return []
    out = [str(r[0]) for r in res['rows'] if r and r[0] is not None]

    # 排序：前缀命中优先于"仅同 schema"，再按名字长度与字典序。
    # 不这样排，关键词 'EMP' 会被 TEMP/TEMPLATES 这类包含匹配和
    # 同 schema 的无关对象淹没。
    kw = (keyword or '').upper()
    sc = (scope or '').upper()
    if kw or sc:
        def _rank(x):
            parts = x.rsplit('.', 1)
            owner = parts[0].upper() if len(parts) > 1 else ''
            nm = parts[-1].upper()
            in_scope = bool(sc) and owner == sc
            pre = bool(kw) and nm.startswith(kw)
            if pre and in_scope:
                tier = 0
            elif pre:
                tier = 1
            elif in_scope:
                tier = 2
            else:
                tier = 3
            return (tier, len(nm), nm)
        out.sort(key=_rank)
    return out


# ─────────────────── 字段值（value）：候选来自真实数据，不来自数据字典 ───────────────────
#
# 与表名/索引名最本质的差别：**值在数据里，不在数据字典里**。
#   `WHERE table_name = '<表名>'`  → 查 all_objects 就知道该填什么
#   `WHERE status     = '<状态>'`  → 只能去看 status 这一列**实际有哪些取值**
# 所以本节的候选一律走"该表该列的真实数据"，这也顺带带来一个强保证：
# 候选列表里的每个值都真实存在，用户不可能选中一个不存在的值。
#
# 代价是要防两件事：
#   ① 千万级表的 DISTINCT 全表扫描会拖垮库 → 内层限制取样行数；
#   ② 表名/列名来自 SQL 文本，拼接前必须严格校验为标识符（防注入）。

_VALUE_SAMPLE_ROWS = 3000     # 取样行数上限（内层）
_VALUE_CAND_LIMIT = 40        # 返回候选上限

_DATE_TYPE_HINTS = ('DATE', 'TIMESTAMP', 'DATETIME', 'TIME', 'INTERVAL')
_NUM_TYPE_HINTS = ('NUMBER', 'INT', 'DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE',
                   'REAL', 'BIT', 'SERIAL')
# LOB / 二进制：既不能做等值比较（Oracle ORA-00932），DISTINCT 也没意义
_LOB_TYPE_HINTS = ('LOB', 'BLOB', 'CLOB', 'BFILE', 'RAW', 'BYTEA', 'IMAGE', 'XMLTYPE')

# 反查"哪张表持有这一列"（顺便拿列类型）
_COL_META_SQL = {
    'oracle': ("SELECT owner, table_name, data_type FROM all_tab_columns "
               "WHERE UPPER(column_name) = UPPER({col}) AND UPPER(table_name) IN ({tbls}) "
               "AND ROWNUM <= 30"),
    'mysql': ("SELECT table_schema, table_name, data_type FROM information_schema.columns "
              "WHERE UPPER(column_name) = UPPER({col}) AND UPPER(table_name) IN ({tbls}) "
              "LIMIT 30"),
    'postgresql': ("SELECT table_schema, table_name, data_type FROM information_schema.columns "
                   "WHERE UPPER(column_name) = UPPER({col}) AND UPPER(table_name) IN ({tbls}) "
                   "LIMIT 30"),
    'sqlserver': ("SELECT TOP 30 s.name, t.name, ty.name FROM sys.columns c "
                  "JOIN sys.objects t ON t.object_id = c.object_id "
                  "JOIN sys.schemas s ON s.schema_id = t.schema_id "
                  "JOIN sys.types ty ON ty.user_type_id = c.user_type_id "
                  "WHERE UPPER(c.name) = UPPER({col}) AND UPPER(t.name) IN ({tbls})"),
}

# 无 FROM 可用时的兜底：不猜表，直接说明
_NO_SRC_NOTE = '未能确定该字段属于哪张表（SQL 里没有可用的 FROM），请手动输入值'


def _load_av():
    """加载 sql_autoverify（复用它的表引用抽取与 0 行探针）。"""
    from modules.ai import sql_autoverify as av
    return av


def classify_col_type(data_type):
    """列类型 → 值型槽位的处理方式。

    date（给时间预设）/ num（阈值语义）/ lob（不给候选、不校验）/ text（给真实取值）。
    lob 必须单独识别：Oracle 里 `CLOB = 'x'` 直接 ORA-00932（数据类型不一致），
    而且在 LOB 上做 DISTINCT 既慢又无意义。
    """
    t = (data_type or '').upper()
    if any(h in t for h in _LOB_TYPE_HINTS):
        return 'lob'
    if any(h in t for h in _DATE_TYPE_HINTS):
        return 'date'
    if any(h in t for h in _NUM_TYPE_HINTS):
        return 'num'
    return 'text'


def _is_numeric_literal(v):
    """值是否是可安全拼进 SQL 的数字字面量（防 ORA-01722）。"""
    return bool(re.match(r'^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$', (v or '').strip()))


def resolve_value_source(datasource_name, db_info, sql, col_ref, runner=None):
    """确定"字段值"槽位该到**哪张表的哪一列**取候选，并给出列类型。

    SQL 里可能 JOIN 了多张表，但列名通常唯一 → 用 all_tab_columns 反查即可确定；
    多张表同时持有该列时，按 FROM 出现顺序取第一张（与阅读顺序一致）。

    Returns: {'qualified', 'table', 'owner', 'column', 'data_type', 'kind'} 或 {}
    """
    col = (col_ref or '').strip()
    if not col or not _IDENT_SAFE.match(col):
        return {}
    av = _load_av()
    try:
        refs = [r for r in av.extract_table_refs(sql or '')
                if r['name'].upper() not in ('DUAL',)]
    except Exception:
        refs = []
    if not refs:
        return {}
    from modules.ai.sql_safety import _family_of as _db_family
    fam = _db_family((db_info or {}).get('db_type', ''))
    tmpl = _COL_META_SQL.get(fam)
    if not tmpl:
        return {}
    tbls = ','.join(_lit(r['name'].upper()) for r in refs[:10])
    res = _run(runner, datasource_name,
               tmpl.format(col=_lit(col.upper()), tbls=tbls))
    if res.get('error'):
        return {}
    order = {r['name'].upper(): i for i, r in enumerate(refs)}
    rows = sorted((res.get('rows') or []), key=lambda r: order.get(str(r[1]).upper(), 99))
    for row in rows:
        owner, table = str(row[0] or '').strip(), str(row[1] or '').strip()
        if not table:
            continue
        # 只有当 SQL 里本来就写了 owner 前缀时，才在表名上带 owner ——
        # 否则 `FROM dba_tables` 会被渲染成 `FROM SYS.DBA_TABLES`，
        # 与用户原语句不一致（也容易被误当成"系统改了我的 SQL"）。
        want = next((r for r in refs if r['name'].upper() == table.upper()), None)
        with_owner = bool(want and want.get('schema'))
        return {'owner': owner, 'table': table,
                'qualified': (owner + '.' + table) if (owner and with_owner) else table,
                'column': col.upper(), 'data_type': str(row[2] or '').strip(),
                'kind': classify_col_type(str(row[2] or ''))}
    return {}


def _val_col_expr(fam, col):
    """把列渲染成可 LIKE 的字符串表达式（同时避免驱动返回 CLOB/大对象）。"""
    if fam == 'oracle':
        return 'TO_CHAR(%s)' % col
    if fam == 'sqlserver':
        return 'CONVERT(VARCHAR(200), %s)' % col
    return 'CAST(%s AS CHAR)' % col


def build_value_candidate_sql(db_info, src, keyword='', limit=_VALUE_CAND_LIMIT,
                              sample=_VALUE_SAMPLE_ROWS):
    """生成"该列在真实数据里的取值"候选查询。

    两条硬约束：
      ① **限制内层取样行数** —— 千万级日志表直接 `SELECT DISTINCT` 会全表扫描，
         右键菜单会卡死甚至拖垮生产库。代价是候选只代表前 N 行的样本，
         返回里会注明取样行数，不假装是全集。
      ② **表名/列名必须是纯标识符**（表名可带一个点）—— 它们来自 SQL 文本，
         拼接前不校验就是注入面。
    """
    from modules.ai.sql_safety import _family_of as _db_family
    fam = _db_family((db_info or {}).get('db_type', ''))
    tbl = (src.get('qualified') or src.get('table') or '').strip()
    col = (src.get('column') or '').strip()
    if not tbl or not col:
        return ''
    if not re.match(r'^[A-Za-z_][A-Za-z0-9_$#]*(\.[A-Za-z_][A-Za-z0-9_$#]*)?$', tbl):
        return ''
    if not _IDENT_SAFE.match(col):
        return ''
    if not fam:
        return ''
    expr = _val_col_expr(fam, col)
    kw = ''
    if keyword:
        # 过滤必须作用在内层输出的别名 V 上：外层是 `SELECT ... FROM (子查询) X`，
        # 原始列名在子查询之外不可见 —— 写成 TO_CHAR(col) 会直接 ORA-00904。
        kw = ' AND UPPER(V) LIKE %s' % _lit('%' + str(keyword).upper() + '%')
    if fam == 'oracle':
        return ("SELECT V FROM (SELECT DISTINCT %s AS V FROM %s "
                "WHERE %s IS NOT NULL AND ROWNUM <= %d) X WHERE 1=1%s AND ROWNUM <= %d"
                % (expr, tbl, col, sample, kw, limit))
    if fam == 'sqlserver':
        return ("SELECT TOP %d V FROM (SELECT DISTINCT TOP %d %s AS V FROM %s "
                "WHERE %s IS NOT NULL) X WHERE 1=1%s"
                % (limit, sample, expr, tbl, col, kw))
    return ("SELECT V FROM (SELECT DISTINCT %s AS V FROM %s "
            "WHERE %s IS NOT NULL LIMIT %d) X WHERE 1=1%s LIMIT %d"
            % (expr, tbl, col, sample, kw, limit))


def date_presets(now=None):
    """日期型字段的常用取值 —— 巡检 SQL 里这类过滤 90% 是"最近 N 小时/天"。

    返回 [{'value': '2026-09-13 18:07:00', 'label': '近 24 小时'}]，
    value 直接就是可粘进 SQL 的字面量文本（由调用方决定是否再加引号）。
    """
    import datetime as _dt
    now = now or _dt.datetime.now()
    day0 = now.replace(hour=0, minute=0, second=0, microsecond=0)
    items = [
        ('近 1 小时', now - _dt.timedelta(hours=1)),
        ('近 6 小时', now - _dt.timedelta(hours=6)),
        ('近 24 小时', now - _dt.timedelta(hours=24)),
        ('今天 00:00', day0),
        ('近 7 天', now - _dt.timedelta(days=7)),
        ('近 30 天', now - _dt.timedelta(days=30)),
    ]
    out = []
    for label, dt in items:
        out.append({'value': dt.strftime('%Y-%m-%d %H:%M:%S'), 'label': label})
    return out


def suggest_value_candidates(datasource_name, db_info, sql, col_ref, keyword='',
                             runner=None, limit=_VALUE_CAND_LIMIT):
    """字段值候选：日期列给时间预设，其它列给**该列的真实取值**。

    Returns: (candidates, note, src)
        candidates: [{'value', 'label'}]；label 为空时前端只显示 value
    """
    src = resolve_value_source(datasource_name, db_info, sql, col_ref, runner=runner)
    if not src:
        return [], _NO_SRC_NOTE, {}
    col = src.get('column') or ''
    qualified = src.get('qualified') or src.get('table') or ''
    if src.get('kind') == 'lob':
        # LOB 列不给候选：DISTINCT 大对象既非法又无意义，手输更不现实
        return [], ('%s.%s 是 LOB/大对象类型，不适合按取值筛选；'
                    '如需匹配请用 LIKE 或 DBMS_LOB 函数' % (qualified, col)), src
    if src.get('kind') == 'date':
        presets = date_presets()
        kw = (keyword or '').strip().upper()
        if kw:
            presets = [p for p in presets
                       if kw in p['value'].upper() or kw in p['label'].upper()]
        return presets, ('候选为常用时间点（%s.%s）；也可直接输入具体时间后回车' % (qualified, col)), src
    q = build_value_candidate_sql(db_info, src, keyword=keyword, limit=limit)
    if not q:
        return [], '无法为该字段生成候选查询，请手动输入值', src
    res = _run(runner, datasource_name, q)
    if res.get('error'):
        return [], '读取该列取值失败：%s' % str(res['error'])[:120], src
    out, seen = [], set()
    for r in (res.get('rows') or []):
        if not r:
            continue
        v = r[0]
        if v is None:
            continue
        s = str(v).strip()
        if s and s not in seen:
            seen.add(s)
            out.append({'value': s, 'label': ''})
    note = ('候选来自 %s.%s 的真实取值（取样前 %d 行，去重后 %d 个）'
            % (qualified, col, _VALUE_SAMPLE_ROWS, len(out)))
    return out, note, src


def build_value_exists_sql(db_info, src, value):
    """生成"这个值在该列里是否真实存在"的探针 SQL。

    Returns: (sql, skip_reason)
        sql 非空 → 可以执行探针；sql 为空时 skip_reason 说明为什么不能校验。

    比较方式按列类型分流（这是**手工录入**场景下的关键）：
        · text  → `列 = '值'`：**能用索引**。早先统一用 `TO_CHAR(列) = '值'`，
                  任何类型都不会炸，但代价是**用不上索引** —— 手打错一个字符就是全表扫描，
                  千万级表上右键一次就能把库拖住。文本列本来就不需要转换。
        · num   → 值必须是数字才拼 SQL，否则明确告诉用户"这是数值列"，
                  而不是让数据库抛 ORA-01722（那会被误读成 SQL 语法错误）。
        · date  → 用类型化字面量（Oracle `TO_DATE(...)`），同样保留索引可用性。
        · lob   → 不校验（Oracle `CLOB = 'x'` 直接 ORA-00932）。
    """
    from modules.ai.sql_safety import _family_of as _db_family
    fam = _db_family((db_info or {}).get('db_type', ''))
    tbl = (src.get('qualified') or src.get('table') or '').strip()
    col = (src.get('column') or '').strip()
    if not fam or not tbl or not col:
        return '', '未能确定该字段所属的表/列'
    if not re.match(r'^[A-Za-z_][A-Za-z0-9_$#]*(\.[A-Za-z_][A-Za-z0-9_$#]*)?$', tbl):
        return '', '表名不合法，跳过校验'
    if not _IDENT_SAFE.match(col):
        return '', '列名不合法，跳过校验'
    v = str(value or '').strip()

    kind = src.get('kind') or 'text'
    if kind == 'lob':
        return '', '该列是 LOB/大对象类型，不做取值校验'
    if kind == 'num':
        if not _is_numeric_literal(v):
            return '', '该列是数值类型（%s），请输入数字' % (src.get('data_type') or kind)
        cond = '%s = %s' % (col, v)
    elif kind == 'date':
        if not re.match(r'^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$', v):
            return '', '该列是时间类型，请输入 2026-01-31 或 2026-01-31 08:30:00 形式的时间'
        if fam == 'oracle':
            fmt = 'YYYY-MM-DD' if len(v) == 10 else 'YYYY-MM-DD HH24:MI:SS'
            cond = '%s = TO_DATE(%s, %s)' % (col, _lit(v), _lit(fmt))
        elif fam == 'sqlserver':
            cond = '%s = CONVERT(datetime, %s)' % (col, _lit(v))
        else:
            cond = '%s = %s' % (col, _lit(v))
    else:
        cond = '%s = %s' % (col, _lit(v))

    if fam == 'oracle':
        return 'SELECT 1 FROM %s WHERE %s AND ROWNUM <= 1' % (tbl, cond), ''
    if fam == 'sqlserver':
        return 'SELECT TOP 1 1 FROM %s WHERE %s' % (tbl, cond), ''
    return 'SELECT 1 FROM %s WHERE %s LIMIT 1' % (tbl, cond), ''


def column_time_range(datasource_name, db_info, src, runner=None):
    """取该时间列的数据范围 (min, max)。用于判断"阈值会不会查不到数据"。

    时间值是**筛选阈值**而不是等值匹配 —— 巡检里真正会踩的坑不是"这个时间点不存在"，
    而是"你选的时间晚于这张表里最新的数据"，于是理应返回 0 行却让人以为库没问题。
    """
    from modules.ai.sql_safety import _family_of as _db_family
    fam = _db_family((db_info or {}).get('db_type', ''))
    tbl = (src.get('qualified') or src.get('table') or '').strip()
    col = (src.get('column') or '').strip()
    if not fam or not tbl or not col:
        return None, None
    if not re.match(r'^[A-Za-z_][A-Za-z0-9_$#]*(\.[A-Za-z_][A-Za-z0-9_$#]*)?$', tbl):
        return None, None
    if not _IDENT_SAFE.match(col):
        return None, None
    if fam == 'oracle':
        # 必须显式指定格式：Oracle 默认的 TIMESTAMP 文本受 NLS 影响
        # （"14-9月 -26 06.12.56.123456 下午"），无法解析比较。
        q = ("SELECT TO_CHAR(MIN(%s),'YYYY-MM-DD HH24:MI:SS'), "
             "TO_CHAR(MAX(%s),'YYYY-MM-DD HH24:MI:SS') FROM %s WHERE %s IS NOT NULL"
             % (col, col, tbl, col))
    else:
        q = ('SELECT MIN(%s), MAX(%s) FROM %s WHERE %s IS NOT NULL' % (col, col, tbl, col))
    res = _run(runner, datasource_name, q)
    if res.get('error') or not res.get('rows'):
        return None, None
    row = res['rows'][0]
    if not row or len(row) < 2:
        return None, None
    return (str(row[0]) if row[0] is not None else None,
            str(row[1]) if row[1] is not None else None)


def _threshold_warning(value, mn, mx):
    """阈值超出列数据范围时给出提示。

    这才是时间过滤真正会踩的坑：**不是"这个时间点不存在"，而是"你选的时间
    晚于表里最新的数据"** —— 于是理应返回 0 行，却让人以为"库里没问题"。
    """
    import datetime as _dt

    def _parse(x):
        if not x:
            return None
        s = str(x).strip().replace('T', ' ')[:19]
        for n, fmt in ((19, '%Y-%m-%d %H:%M:%S'), (16, '%Y-%m-%d %H:%M'),
                       (10, '%Y-%m-%d')):
            if len(s) >= n:
                try:
                    return _dt.datetime.strptime(s[:n], fmt)
                except Exception:
                    pass
        return None

    v, a, b = _parse(value), _parse(mn), _parse(mx)
    if not v:
        return ''
    if b and v > b:
        return '所选时间（%s）晚于该列最新数据（%s）—— 该过滤条件查不到任何数据' % (value, mx)
    if a and v < a:
        return '所选时间（%s）早于该列最早数据（%s）—— 不会筛掉任何数据' % (value, mn)
    return ''


def verify_value_slots(datasource_name, db_info, slots, values, sql='', runner=None,
                       limit=8):
    """校验"字段值"是否真实存在于该列 —— 这是"可靠"的最后一环。

    没有这一层，`WHERE status = 'ACTIVEE'` 这种拼错会静默返回 0 行，
    用户依然分不清"填错"还是"真没数据"。
    """
    checks = []
    for s in slots:
        if s.role not in ('value', 'time'):
            continue
        v = (values or {}).get(s.name)
        if not v:
            continue
        src = resolve_value_source(datasource_name, db_info, sql, s.col_ref, runner=runner)
        if not src:
            checks.append({'slot': s.name, 'role': s.role, 'value': str(v),
                           'exists': None, 'col': s.col_ref,
                           'reason': _NO_SRC_NOTE})
            continue
        if src.get('kind') == 'date':
            # 时间值是**筛选阈值**，不是等值匹配：预设时间几乎不可能正好等于某条记录，
            # 拿它做"是否存在"校验必然误报"不存在"。改为判断阈值与数据范围的关系。
            mn, mx = column_time_range(datasource_name, db_info, src, runner=runner)
            chk = {'slot': s.name, 'role': s.role, 'value': str(v), 'exists': None,
                   'col': src.get('column') or s.col_ref,
                   'table': src.get('qualified') or src.get('table'),
                   'time_min': mn, 'time_max': mx}
            warn = _threshold_warning(str(v), mn, mx)
            if warn:
                chk['reason'] = warn
                chk['warning'] = True
            else:
                chk['reason'] = ('时间阈值不做存在性校验'
                                 + ('（该列数据范围 %s ~ %s）' % (mn, mx) if mn and mx else ''))
            checks.append(chk)
            continue
        probe, skip_reason = build_value_exists_sql(db_info, src, v)
        if not probe:
            checks.append({'slot': s.name, 'role': s.role, 'value': str(v),
                           'exists': None, 'col': src.get('column') or s.col_ref,
                           'reason': skip_reason or '该值无法生成校验探针'})
            continue
        res = _run(runner, datasource_name, probe)
        if res.get('error'):
            checks.append({'slot': s.name, 'role': s.role, 'value': str(v),
                           'exists': None, 'col': src.get('column') or s.col_ref,
                           'reason': '校验失败：%s' % str(res['error'])[:120]})
            continue
        if res.get('rows'):
            checks.append({'slot': s.name, 'role': s.role, 'value': str(v), 'exists': True,
                           'col': src.get('column') or s.col_ref,
                           'table': src.get('qualified') or src.get('table')})
            continue
        # 不存在 → 给相似取值，让用户知道"是不是想填 X"
        # 检索关键词必须**去掉尾部 1~2 个字符**：用户填错的位置往往在末尾
        # （TABLEE / ACTIVEE），拿全名去 LIKE 必然 0 命中、给不出任何候选；
        # 与对象名校验里的 _prefix_like 是同一个道理。
        sv = str(v)
        kw0 = sv[:max(3, len(sv) - 2)]
        cands, _note, _src2 = suggest_value_candidates(
            datasource_name, db_info, sql, s.col_ref, keyword=kw0,
            runner=runner, limit=limit)
        if not cands and len(sv) > 3:
            cands, _note, _src2 = suggest_value_candidates(
                datasource_name, db_info, sql, s.col_ref, keyword=sv[:3],
                runner=runner, limit=limit)
        picks = [c['value'] for c in cands][:limit]
        sim = difflib.get_close_matches(str(v).upper(),
                                        [p.upper() for p in picks], n=3, cutoff=0.6)
        similar = [p for p in picks if p.upper() in sim] or []
        checks.append({
            'slot': s.name, 'role': s.role, 'value': str(v), 'exists': False,
            'col': src.get('column') or s.col_ref,
            'table': src.get('qualified') or src.get('table'),
            'reason': '该列（%s.%s）中不存在取值「%s」'
                      % (src.get('qualified') or src.get('table'),
                         src.get('column') or s.col_ref, v),
            'similar': similar, 'candidates': picks,
        })
    return checks




# ─────────────────────────── 执行前校验（复用 sql_autoverify） ───────────────────────────

_ROLE_CN = {'table': '表', 'index': '索引', 'owner': '用户/schema',
            'tablespace': '表空间', 'column': '列', 'time': '时间',
            # 字段值：候选来自该列在真实数据里的取值（不是数据字典）
            'value': '字段值', 'number': '数值'}


def _prefix_like(name):
    """取用于前缀检索的关键词：容忍 2 个字符的偏差（去掉尾部 2 位）。

    容错不足会直接导致"拼错时给不出候选"，例如：
        DBA_TABLEZZ  → 需要 'DBA_TABLE' 才能召回 DBA_TABLES（多打了 2 个字符）
        EMP_PKK      → 需要 'EMP_P'   才能召回 EMP_PK
    取太短则靠 LIKE 前缀约束 + 相似度阈值兜住噪音。
    """
    n = (name or '').upper()
    return n[:max(3, len(n) - 2)]


def verify_slot_values(datasource_name, db_info, slots, values, scope='', runner=None,
                       sql=''):
    """按角色校验槽位值是否真实存在 —— 这是"可靠"的最后一环。

    两条完全不同的路径：
        · 对象类（table / index / owner / tablespace / column）→ 查**数据字典**
        · 字段值类（value / time）→ 查**真实数据**（该列实际有没有这个取值）
    time / number / unknown 且拿不到列名的不做存在性校验。
    """
    checks = []
    try:
        checks.extend(verify_value_slots(datasource_name, db_info, slots, values,
                                         sql=sql, runner=runner))
    except Exception:
        pass        # 值校验失败不应拖垮整份报告
    for s in slots:
        v = (values or {}).get(s.name)
        if not v or s.role in ('time', 'number', 'unknown', 'value'):
            continue
        raw_val = str(v).strip()
        owner_part, name = (raw_val.rsplit('.', 1) if '.' in raw_val else ('', raw_val))
        # 用**前缀**检索（容忍 2 个字符偏差）：全名检索在填错时必然 0 行、
        # 给不出任何候选；而包含检索会把 WWV_FLOW_PLUG_TEMP_PK 这类无关对象带进来。
        cands = suggest_candidates(datasource_name, db_info, s.role,
                                   keyword=_prefix_like(name),
                                   scope=scope or owner_part, runner=runner,
                                   mode='prefix')

        # 候选也要遵守"bare 列只给纯名"的规则，否则用户采纳 SYS.DBA_TABLES
        # 填进 table_name = '...' 依然查不到数据（多 owner 的同名对象也要去重）
        bare = s.col_ref in _BARE_NAME_COLS
        seen, uniq = set(), []
        for c in cands:
            v2 = c.rsplit('.', 1)[-1] if bare else c
            if v2.upper() not in seen:
                seen.add(v2.upper())
                uniq.append(v2)
        cands = uniq

        names = [c.rsplit('.', 1)[-1].upper() for c in cands]
        similar = ([] if name.upper() in names
                   else difflib.get_close_matches(name.upper(), names, n=3, cutoff=0.6))

        if name.upper() not in names and not similar:
            # 前缀检索没命中时回退到"包含检索 + 高相似度门槛"：
            # Oracle 表名普遍带业务前缀（T_DEMO_CALL_LOG），只靠前缀完全找不到候选。
            # 门槛提到 0.7 是为了挡掉 TEMP/TEMPLATES 这类包含匹配噪音。
            wide = suggest_candidates(datasource_name, db_info, s.role, keyword=name,
                                      scope=scope or owner_part, runner=runner,
                                      mode='contains')
            scored, seen2 = [], set()
            for c in wide:
                c2 = c.rsplit('.', 1)[-1] if bare else c
                r = difflib.SequenceMatcher(None, name.upper(),
                                            c2.rsplit('.', 1)[-1].upper()).ratio()
                if r >= 0.7 and c2.upper() not in seen2:
                    seen2.add(c2.upper())
                    scored.append((r, c2))
            if scored:
                scored.sort(key=lambda t: -t[0])
                cands = [c for _r, c in scored]
                names = [c.rsplit('.', 1)[-1].upper() for c in cands]
                similar = [c.rsplit('.', 1)[-1] for _r, c in scored][:3]

        if name.upper() in names:
            hit = [c for c in cands if c.rsplit('.', 1)[-1].upper() == name.upper()]
            checks.append({'slot': s.name, 'role': s.role, 'value': raw_val,
                           'exists': True, 'resolved': hit[0] if hit else raw_val})
            continue
        similar = difflib.get_close_matches(name.upper(), names, n=3, cutoff=0.6)
        picks = [c for c in cands if c.rsplit('.', 1)[-1].upper() in similar] or cands[:5]
        checks.append({
            'slot': s.name, 'role': s.role, 'value': raw_val, 'exists': False,
            'reason': '%s「%s」在数据字典中不存在' % (_ROLE_CN.get(s.role, s.role), name),
            'similar': similar, 'candidates': picks[:5],
        })
    return checks


def verify_slots(datasource_name, db_info, sql, slots=None, values=None, runner=None):
    """校验回填后的 SQL：槽位值是否存在 + SQL 是否可执行。

    两层校验缺一不可：
        · 槽位值层 —— 填的"表名/索引名"在库里真的存在吗（本模块）
        · SQL 层   —— 回填后的语句能否被数据库解析执行（复用 sql_autoverify 的 0 行探针）
    只做前者会漏掉列名/权限/版本问题；只做后者会发现不了
    `WHERE index_name = '填错的名字'` —— 这种写法语法完全合法，只是永远查不到数据。
    """
    av = _load_av()

    slots = slots if slots is not None else extract_slots(sql)
    values = values or {}
    final_sql = apply_values(sql, slots, values)
    report = av.verify_and_fix(datasource_name, final_sql, db_info=db_info, runner=runner)

    cur_schema = (report.get('env') or {}).get('cur_schema', '')
    slot_checks = verify_slot_values(datasource_name, db_info, slots, values,
                                     scope=cur_schema, runner=runner, sql=sql)
    unresolved = [s.to_dict() for s in slots if not values.get(s.name)]
    # exists 可能是 None（无法校验，如列所属表未能确定）—— 那种不算"填错"，不该拦执行
    bad = [c for c in slot_checks if c.get('exists') is False]

    report.update({
        'final_sql': report.get('sql') or final_sql,
        'unresolved_slots': unresolved,
        'slot_checks': slot_checks,
        'ready': ((not unresolved) and (not bad)
                  and report.get('status') in ('ok', 'fixed')),
    })
    return report


def _run(runner, datasource_name, sql):
    if runner is not None:
        return runner(sql) or {}
    try:
        from modules.ai.tools.sql_tools import tool_execute_sql
        return tool_execute_sql(datasource_name=datasource_name, sql=sql) or {}
    except Exception as e:
        return {'error': '执行器不可用: %s' % e}
