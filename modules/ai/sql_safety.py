# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · SQL 安全分层判定（MIT License, Copyright (c) 2025-2026 fiyo (Jack Ge)）。

零第三方依赖：判定不引入 sqlparse，也不为一个文本预检新增依赖，改用
「掩码 → 语句切分 → 首关键词 + 全文规则」，输出五档结果：

    read / write / dangerous / injection / unknown

与目标执行链的关系（重要）：

* **执行闸不变**：真正落库执行仍由 ``modules.web.app._assert_readonly_sql``
  的只读白名单把关（这一层最严），本模块负责的是「为什么被拒」的可读解释、
  界面上「非查询语句仅展示」的标记、以及 AI 上下文里的语句类型提示；
* 多语句按逐条判定，取最严格的那条作为整体结论；
* 灰区（0.2~0.6）交给 LLM 做语义复核，带 3 秒硬超时，模型不可用即放行 ——
  不能因为一次安全加分项把正常巡检查询拖成十几秒。
"""
import re
import threading
from collections import OrderedDict

READ_KEYWORDS = {'SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'WITH'}
WRITE_KEYWORDS = {'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'CREATE', 'DROP',
                  'ALTER', 'TRUNCATE', 'RENAME', 'OPTIMIZE', 'ANALYZE', 'COMMENT'}
DANGEROUS_KEYWORDS = {'SHUTDOWN', 'GRANT', 'REVOKE', 'KILL', 'LOCK', 'PURGE', 'FLASHBACK'}
# 「在任何位置都不该出现」的高危命令：只有这几个才做全文扫描。
# LOCK / PURGE / FLASHBACK **不在**这一档：它们是合法的查询对象名片段
# （v$lock、dba_blockers 里的 lock 列、flashback 版本查询…），全文扫必然误杀；
# 作为命令出现时由 ``_classify_one`` 的首关键词判定拦住（LOCK TABLE / PURGE TABLE / FLASHBACK TABLE）。
# 与 ``dbcheck/ai/sql_safety.py``（MIT License, Copyright (c) 2025-2026 fiyo (Jack Ge)）
# 的 DANGEROUS_KWS 同口径：SHUTDOWN / SUPER / ADMIN / GRANT / REVOKE / KILL 这一档不含 LOCK。
DANGEROUS_ANYWHERE_KEYWORDS = ('SHUTDOWN', 'GRANT', 'REVOKE', 'KILL')
HIGH_RISK_SET_TARGETS = ('PASSWORD', 'SQL_LOG_BIN', 'GLOBAL', 'SESSION')
# 标识符边界：Oracle 动态视图名里的 ``$`` 与限定符里的 ``.`` 属于标识符的一部分，
# 用 Python 的 \\w 做前后断言会把 ``v$lock`` 拆成「…$ + LOCK + 空格」，于是每条
# ``FROM v$lock`` 的锁等待查询都被判成高危（实测反馈的正是这条）。
_IDENT_BEFORE = r'(?<![\w$.#])'
_IDENT_AFTER = r'(?![\w$])'

# 灰区 LLM 复核的硬超时（秒）：规则层未命中高危模式时才走到这里，属加分项。
LLM_INJECTION_TIMEOUT_S = 3

_CLASSIFY_CACHE = OrderedDict()
_CLASSIFY_CACHE_MAX = 512

# 只读 PL/SQL 包里允许出现的（纯输出/纯读取）；其余 DBMS_*/UTL_* 一律从严拒绝
_READONLY_PLSQL_PACKAGES = {'DBMS_OUTPUT', 'DBMS_LOB', 'DBMS_ASSERT', 'DBMS_UTILITY'}
_WRITE_PLSQL_PACKAGES = {
    'DBMS_SQL', 'DBMS_MVIEW', 'DBMS_STATS', 'DBMS_WORKLOAD_REPOSITORY', 'DBMS_SCHEDULER',
    'DBMS_JOB', 'DBMS_SESSION', 'DBMS_SYSTEM', 'DBMS_APPLICATION_INFO', 'UTL_FILE',
    'UTL_HTTP', 'UTL_TCP', 'UTL_SMTP', 'UTL_INADDR', 'UTL_RDA',
}


# ══════════════════════════════════════════════════════════════
# 文本预处理：掩码 / 去注释 / 切语句
# ══════════════════════════════════════════════════════════════

def mask_literals(sql):
    """把字符串字面量与注释替换成等长空格。

    规则匹配一律在掩码后的文本上做，避免把 `'FETCH FIRST'`、`'-- 说明'` 这类普通
    文本当成语法特征；偏移量与原文一致，前端高亮/改写定位可以直接复用。
    """
    if not sql:
        return ''
    characters = list(sql)
    position = 0
    length = len(sql)
    while position < length:
        character = sql[position]
        if character == "'":
            scan = position + 1
            while scan < length:
                if sql[scan] == "'":
                    if scan + 1 < length and sql[scan + 1] == "'":
                        scan += 2
                        continue
                    scan += 1
                    break
                scan += 1
            for index in range(position, min(scan, length)):
                characters[index] = ' '
            position = scan
            continue
        if character == '"' and position + 1 < length:      # 双引号标识符同样屏蔽
            scan = position + 1
            while scan < length:
                if sql[scan] == '"':
                    if scan + 1 < length and sql[scan + 1] == '"':
                        scan += 2
                        continue
                    scan += 1
                    break
                scan += 1
            for index in range(position, min(scan, length)):
                characters[index] = ' '
            position = scan
            continue
        if character == '-' and position + 1 < length and sql[position + 1] == '-':
            end = sql.find('\n', position)
            end = length if end == -1 else end
            for index in range(position, end):
                characters[index] = ' '
            position = end
            continue
        if character == '/' and position + 1 < length and sql[position + 1] == '*':
            end = sql.find('*/', position + 2)
            end = length if end == -1 else end + 2
            for index in range(position, min(end, length)):
                characters[index] = ' '
            position = end
            continue
        if character == '#':                                # MySQL 行注释
            end = sql.find('\n', position)
            end = length if end == -1 else end
            for index in range(position, end):
                characters[index] = ' '
            position = end
            continue
        position += 1
    return ''.join(characters)


def strip_comments(sql):
    """彻底去掉注释（保留空白结构），用于语句切分前的清洗。"""
    if not sql:
        return ''
    pieces = []
    position = 0
    length = len(sql)
    while position < length:
        if sql[position:position + 2] == '--':
            end = sql.find('\n', position)
            end = length if end == -1 else end
            pieces.append(' ')
            position = end
            continue
        if sql[position:position + 2] == '/*':
            end = sql.find('*/', position + 2)
            end = length if end == -1 else end + 2
            pieces.append(' ')
            position = end
            continue
        if sql[position] == '#':
            end = sql.find('\n', position)
            end = length if end == -1 else end
            pieces.append(' ')
            position = end
            continue
        pieces.append(sql[position])
        position += 1
    return ''.join(pieces)


def split_statements(sql):
    """按分号安全切分多条语句（字符串/注释/美元引用内部的分号不切）。

    优先复用 SQL 编辑器那条链路的切分器（同一份语义，避免两处规则漂移）；
    不可用时退化为本地掩码切分。

    PL/SQL 匿名块（``BEGIN`` / ``DECLARE`` 起头）整块当作一条：块内的分号是
    语句分隔符而不是「两条 SQL」，切开会把 ``END;`` 变成一个无法识别的碎片，
    让整段被误判成 unknown。
    """
    text = sql or ''
    if not text.strip():
        return []
    if re.match(r'\s*(?:--[^\n]*\n|\s)*(BEGIN|DECLARE)\b', mask_literals(text), re.I):
        return [text.strip()]
    try:
        from modules.web.app import _split_sql_statements
        return list(_split_sql_statements(text, maxStatements=200))
    except Exception:
        pass
    cleaned = strip_comments(text)
    masked = mask_literals(cleaned)
    statements = []
    start = 0
    for index, character in enumerate(masked):
        if character == ';':
            piece = cleaned[start:index].strip()
            if piece:
                statements.append(piece)
            start = index + 1
    tail = cleaned[start:].strip()
    if tail:
        statements.append(tail)
    return statements


def leading_keyword(statement):
    """语句的首关键词（判定「这是不是只读查询」的第一依据）。

    先剥注释再取：模型生成的 SQL 几乎每条都带一行中文说明
    （``-- 查看各表空间中占用最大的表``），不剥的话首字符是 ``-`` 而不是 ``SELECT``，
    一条完全合法的只读查询会被判成 ``unknown`` 并拒绝执行。
    注释里的文字也不该参与判定：``-- 需要 DROP 旧表`` 不能把一句 SELECT 判成写操作。
    """
    text = strip_comments(statement or '')
    matched = re.match(r'\s*(\w[\w/]*)', text)
    return matched.group(1).upper() if matched else ''


def sanitize_sql(sql):
    """尾部清理：去掉模型常多带的结尾空白、重复分号与 markdown 残留。

    顺手剥掉 ```sql 代码块包装 —— 从 AI 回答里抠出来的 SQL 经常带着它。
    """
    text = str(sql or '').strip()
    if not text:
        return ''
    if text.startswith('```'):
        text = re.sub(r'^```[a-zA-Z]*\s*', '', text)
        text = re.sub(r'\s*```$', '', text)
    text = text.strip()
    while text.endswith(';'):
        text = text[:-1].rstrip()
    return re.sub(r'\s*;\s*;\s*', ';', text).strip()


def validate_datasource_name(name, max_length=100):
    """数据源名称注入防护：只允许字母/数字/中文/下划线/连字符/点/空格/括号。"""
    text = str(name or '').strip()
    if not text or len(text) > max_length:
        return False
    return bool(re.fullmatch(r"[\w\u4e00-\u9fff\-. ()\[\]/]+", text))


# ══════════════════════════════════════════════════════════════
# 注释截断判定（语义级，不用「出现 -- 就算注入」）
# ══════════════════════════════════════════════════════════════

def has_comment_truncation(sql):
    """只有「注释符落在未闭合的字符串字面量内部」才判注入。

    `' OR 1=1 --` 的本质是注释符被吃进未闭合的字符串；而 AI 生成的 DBA 查询
    几乎每条都带 `-- 中文说明`，那些都是字符串外的正常注释，一律不命中。
    """
    if not sql:
        return False
    inside_block = False
    for line in str(sql).split('\n'):
        inside_string = False
        normal_comment = False
        position = 0
        length = len(line)
        while position < length:
            if inside_block:
                if line.startswith('*/', position):
                    inside_block = False
                    position += 2
                    continue
                position += 1
                continue
            if not inside_string and line.startswith('/*', position):
                inside_block = True
                position += 2
                continue
            character = line[position]
            if character == "'":
                if inside_string and position + 1 < length and line[position + 1] == "'":
                    position += 2
                    continue
                inside_string = not inside_string
                position += 1
                continue
            if not inside_string:
                if line.startswith('--', position):
                    normal_comment = True
                    break
                if character == '#' and not (position and (line[position - 1].isalnum()
                                                           or line[position - 1] in '_$')):
                    normal_comment = True
                    break
            position += 1
        if inside_string and not normal_comment:
            return True
    return False


# ══════════════════════════════════════════════════════════════
# 注入检测：规则层 + 加权特征层（+ 灰区 LLM 层）
# ══════════════════════════════════════════════════════════════

_INJECTION_RULES = [
    (r'(?<![\w])SLEEP\s*\(', 1.0, '时间盲注 SLEEP()'),
    (r'(?<![\w])BENCHMARK\s*\(', 1.0, '压力注入 BENCHMARK()'),
    (r'(?<![\w])WAITFOR\s+DELAY', 1.0, 'SQL Server 延迟注入'),
    (r'(?<![\w])LOAD_FILE\s*\(', 1.0, '文件读取 LOAD_FILE()'),
    (r'(?<![\w])XP_\w+\s*\(', 1.0, 'SQL Server 扩展存储过程'),
    (r'\bINTO\s+OUTFILE\b', 1.0, '文件写入 INTO OUTFILE'),
    (r'\bINTO\s+DUMPFILE\b', 1.0, '文件写入 INTO DUMPFILE'),
    (r'\bPROCEDURE\s+ANALYSE\b', 1.0, '注入探测 PROCEDURE ANALYSE'),
    (r'\bUNION\s+(ALL\s+)?SELECT\b', 0.9, 'UNION 注入'),
    (r'\bCHAR\s*\(\d+\s*,\s*\d+\s*,\s*\d+', 0.9, 'CHAR 编码注入'),
    (r'\bCONCAT\s*\(\s*0x[0-9A-Fa-f]+', 0.9, 'CONCAT + 十六进制编码'),
    (r'0[xX][0-9A-Fa-f]{16,}', 0.2, '长十六进制字符串'),
    (r'\bGROUP_CONCAT\b', 0.2, '数据聚合（与其它特征叠加时才可疑）'),
    (r'\bSET\s+(?:GLOBAL\s+|SESSION\s+)?@@', 0.7, '系统变量赋值（SET @@ 写）'),
    (r'(?<![\w])EXEC\s*\(', 0.9, '命令执行 EXEC()'),
    (r'(?<![\w])EXECUTE\s+\w+\s', 0.9, '命令执行 EXECUTE'),
    (r';\s*(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b', 0.9, '多语句注入'),
    (r';\s*SHUTDOWN\b', 1.0, '多语句 + SHUTDOWN'),
]

# 合法 DBA 查询里高频出现的字符串/类型函数：单独出现不计分
_LEGITIMATE_FUNCTIONS = ('CAST(', 'CONVERT(', 'SUBSTRING(', 'REPLACE(', 'CONCAT(')

_SUSPICIOUS_FUNCTIONS = ('HEX(', 'UNHEX(', 'ASCII(', 'ORD(', 'MID(', 'CHAR(')


def injection_score(sql, db_type=''):
    """规则 + 特征加权评分。返回 (score 0~1, 命中明细 [(描述, 权重), ...])。"""
    if not sql or not sql.strip():
        return 0.0, []
    masked = mask_literals(sql)
    upper = masked.upper()
    hits = []
    rule_score = 0.0
    for pattern, weight, description in _INJECTION_RULES:
        if not re.search(pattern, upper):
            continue
        if description == 'CHAR 编码注入' and _family_of(db_type) == 'oracle':
            continue      # Oracle 的 CHAR() 只接受单参数，多参数写法本就是语法错误
        if description == '系统变量赋值（SET @@ 写）' and _family_of(db_type) == 'sqlserver':
            continue      # T-SQL 里 @@ 变量只读
        hits.append((description, weight))
        rule_score += weight
    if has_comment_truncation(sql):
        hits.append(('注释截断注入（字符串内注释）', 0.9))
        rule_score += 0.9

    feature_score = 0.0
    suspicious = [name for name in _SUSPICIOUS_FUNCTIONS if name in upper]
    if len(suspicious) >= 2:
        feature_score += 0.3
        hits.append(('多编码函数组合', 0.3))
    elif len(suspicious) == 1:
        feature_score += 0.1
    if upper.count('CONCAT(') + upper.count('||') >= 3:
        feature_score += 0.2
        hits.append(('多次字符串拼接', 0.2))
    if len(sql) > 1500 and len(hits) >= 2:
        feature_score += 0.15
        hits.append(('超长 SQL + 多特征', 0.15))
    if [item for item in re.findall(r'0[xX][0-9A-Fa-f]+', upper) if len(item) > 18]:
        feature_score += 0.2
        hits.append(('长十六进制字面量', 0.2))
    statements = [item.strip().upper() for item in split_statements(sql) if item.strip()]
    if len(statements) > 1 and all(item.startswith(('SELECT', 'UNION')) for item in statements):
        feature_score += 0.1
    if _family_of(db_type) == 'oracle' and re.search(r'\bV\$|GV\$', upper) and len(hits) <= 1:
        feature_score = max(0.0, feature_score - 0.1)   # v$ 视图是 Oracle 常规性能视图

    final_score = 0.7 * min(rule_score, 1.0) + 0.3 * min(feature_score, 1.0)
    return round(min(final_score, 1.0), 3), hits


def _gray_zone_llm_review(sql, db_type=''):
    """灰区（0.2~0.6）的 LLM 语义复核：可选层，超时/失败一律按放行处理。"""
    prompt = ('你是一名数据库安全专家。请判断以下 SQL 是否为 SQL 注入攻击。\n\n'
              '判断标准：\n'
              '- 合法 SQL：正常业务查询、DBA 监控查询、数据导出\n'
              '- 注入攻击：读取系统文件、延时响应、枚举元数据、堆叠执行、编码绕过\n'
              '- 注意：INFORMATION_SCHEMA / v$session 是合法 DBA 对象；'
              'CONCAT/CAST/SUBSTRING 在正常查询中非常常见\n\n'
              '数据库类型: %s\n\nSQL:\n%s\n\n'
              '请仅回复 JSON: {"is_injection": true/false, "confidence": 0.0-1.0, "reason": "简短理由"}'
              % (db_type or 'generic', (sql or '')[:4000]))
    outcome = {}

    def run_review():
        try:
            from modules.ai import llm
            outcome['response'] = llm.call(prompt, '')
        except Exception as failure:
            outcome['error'] = str(failure)

    worker = threading.Thread(target=run_review, daemon=True)
    worker.start()
    worker.join(timeout=LLM_INJECTION_TIMEOUT_S + 0.5)
    if worker.is_alive():
        return False, 'LLM 复核超时（>%ds），按规则层结果放行' % LLM_INJECTION_TIMEOUT_S
    response = str(outcome.get('response') or '')
    if outcome.get('error') or not response or response.lstrip().startswith('['):
        return False, 'LLM 不可用，默认放行'
    matched = re.search(r'\{[^{}]+\}', response, re.S)
    if not matched:
        return False, 'LLM 返回格式异常，默认放行'
    try:
        import json
        data = json.loads(matched.group(0))
    except Exception:
        return False, 'LLM 返回解析失败，默认放行'
    reason = str(data.get('reason') or 'LLM 判断')
    if data.get('is_injection') and float(data.get('confidence') or 0) >= 0.8:
        return True, reason
    return False, reason


def detect_injection(sql, db_type=''):
    """三层混合检测入口。返回 (is_injection, score, details, layer)。"""
    score, details = injection_score(sql, db_type)
    if score >= 0.6:
        return True, score, details, 'rule'
    if score < 0.2:
        return False, score, details, 'safe'
    is_injection, reason = _gray_zone_llm_review(sql, db_type)
    if is_injection:
        return True, max(score, 0.8), details + [('LLM: %s' % reason, 0.8)], 'llm'
    return False, score, details, 'llm_pass'


def _family_of(db_type):
    """方言家族（与 ``dialect.family_alias`` 同一口径，规则层的方言豁免只认这个）。

    归一化统一收敛在 ``dialect.family_alias``，安全判定与语法口径共用一份，
    避免「执行按 A 口径、安全判定按 B 口径」。
    """
    from modules.ai import dialect
    return dialect.family_alias(db_type) or str(db_type or '').strip().lower()


def _has_dangerous_keyword(masked_upper, db_type=''):
    """全文高危关键字与写操作特征（掩码后的文本，字符串内容不参与判定）。

    只扫 :data:`DANGEROUS_ANYWHERE_KEYWORDS` 那几个「哪儿都不该出现」的命令字，
    并按标识符边界（含 ``$`` / ``.``）匹配；``LOCK`` / ``PURGE`` / ``FLASHBACK``
    这类「同时也是对象名一部分」的词交给首关键词判定，否则 ``FROM v$lock`` 这种
    最常规的锁等待查询会被误判成 injection。
    """
    for keyword in DANGEROUS_ANYWHERE_KEYWORDS:
        if re.search(_IDENT_BEFORE + keyword + _IDENT_AFTER, masked_upper):
            return True
    if re.match(r'^\s*SET\b', masked_upper) and re.search(r'@\s*@\s*[\w.]+', masked_upper):
        return True
    if _family_of(db_type) != 'sqlserver':
        if re.search(r'INTO\s+@\s*\w+', masked_upper) or re.search(r'SET\s+@\s*\w+', masked_upper):
            return True
    return False


def classify_plsql_block(statement_text, db_type=''):
    """PL/SQL 匿名块（BEGIN..END / DECLARE..END）的只读判定。

    匿名块常用于「游标遍历 + DBMS_OUTPUT 打印」的只读分析，也可能内嵌写操作，
    所以按块内容判定：DML/DDL、EXECUTE IMMEDIATE、动态 SQL 包 → write；
    未列入只读白名单的 DBMS_*/UTL_* → unknown（从严拒绝）；纯 SELECT/游标 → read。
    """
    upper = mask_literals(statement_text or '').upper()
    if not upper.strip():
        return None
    for keyword in sorted(WRITE_KEYWORDS, key=len, reverse=True):
        if re.search(r'(?<!\w)' + keyword + r'\s', upper):
            return 'write'
    if re.search(r'\bEXECUTE\s+IMMEDIATE\b|\bDBMS_SQL\.EXECUTE\b', upper):
        return 'write'
    packages = set(re.findall(r'\b((?:DBMS|UTL)_[A-Z0-9_]+)\s*\.', upper))
    if packages - _READONLY_PLSQL_PACKAGES:
        unknown = sorted(packages - _READONLY_PLSQL_PACKAGES)
        if any(name in _WRITE_PLSQL_PACKAGES for name in unknown):
            return 'write'
        return 'unknown'
    return 'read'


def classify(sql, db_type=''):
    """SQL 类型判定入口：read / write / dangerous / injection / unknown。

    多语句逐条判定，取最严格的结果（写操作优先级最高）。
    """
    text = sql or ''
    if not text.strip():
        return 'unknown'
    cache_key = (text, db_type)
    cached = _CLASSIFY_CACHE.get(cache_key)
    if cached is not None:
        _CLASSIFY_CACHE.move_to_end(cache_key)
        return cached

    kind = _classify_uncached(text, db_type)
    if kind != 'unknown':
        _CLASSIFY_CACHE[cache_key] = kind
        if len(_CLASSIFY_CACHE) > _CLASSIFY_CACHE_MAX:
            _CLASSIFY_CACHE.popitem(last=False)
    return kind


_SEVERITY_ORDER = ['read', 'unknown', 'dangerous', 'write', 'injection']


def _classify_uncached(sql, db_type=''):
    is_injection, _score, _details, _layer = detect_injection(sql, db_type)
    if is_injection:
        return 'injection'
    masked_full = mask_literals(strip_comments(sql)).upper()
    if _has_dangerous_keyword(masked_full, db_type):
        return 'injection'

    statements = split_statements(sql)
    if not statements:
        return 'unknown'
    worst = 'read'
    for statement in statements:
        kind = _classify_one(statement, db_type)
        if _SEVERITY_ORDER.index(kind) > _SEVERITY_ORDER.index(worst):
            worst = kind
    return worst


def _classify_one(statement, db_type=''):
    # 注释一律先剥掉再判：注释里的文字不是语句的一部分
    # （`-- 需要先 DROP 旧表` 不该让整句变成写操作，开头一行说明也不该让首关键词取空）
    statement = strip_comments(statement or '')
    masked = mask_literals(statement)
    upper = masked.upper()
    keyword = leading_keyword(statement)

    if keyword in READ_KEYWORDS or keyword == 'WITH':
        if keyword == 'SET':
            return 'dangerous' if any(t in upper for t in HIGH_RISK_SET_TARGETS) else 'read'
        if re.search(r'\bINTO\s+(OUTFILE|DUMPFILE)\b', upper):
            return 'injection'
        return 'read'
    if keyword == 'SET':
        return 'dangerous' if any(t in upper for t in HIGH_RISK_SET_TARGETS) else 'write'
    if keyword in WRITE_KEYWORDS:
        return 'write'
    if keyword in DANGEROUS_KEYWORDS:
        return 'dangerous'
    if keyword.startswith('BEGIN') or keyword.startswith('DECLARE'):
        return classify_plsql_block(statement, db_type) or 'unknown'
    if re.match(r'^\s*(?:BEGIN|DECLARE)\b', upper):
        return classify_plsql_block(statement, db_type) or 'unknown'
    if any(re.search(r'(?<!\w)' + kw + r'\s', upper) for kw in WRITE_KEYWORDS):
        return 'write'
    return 'unknown'


def is_readonly(sql, db_type=''):
    """是否只读（read 才算；unknown 一律从严拒绝）。"""
    return classify(sql, db_type) == 'read'


# ── 「是不是 SQL 语句」判定（与「允不允许执行」刻意分层）──
# 前者只管「这条像不像一条查询」，界面据此决定给不给「▶ 执行SQL / ≡ 批量」按钮；
# 后者由 ``classify`` + ``_assert_readonly_sql`` 白名单把关，两层不能合并。
# 为什么必须宽口径：`DESC v$session`、`CALL pkg.proc`、`SET ...` 这类首关键词不在
# 严格只读表里的语句**确实是 SQL**，按严格口径判会把整个执行区从代码块上摘掉
# （前端 ``aiasValidateSqlBlocks`` 一见 is_sql=false 就删按钮），用户就遇到
# 「有 SQL 却没有任何执行入口」。分层之后这类语句照样有按钮，点下去由执行闸
# 给出可解释的拒绝理由。
READ_SQL_TOKENS = frozenset({
    'SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'USE', 'SET', 'CALL',
    'PREPARE', 'EXECUTE', 'TABLE', 'VALUES',
})


def looks_like_read_sql(sql, db_type=''):
    """判断代码块内容是不是一条（组）SQL 语句（宽口径，不判能否执行）。

    多语句逐条看：**只要存在一条**首关键词命中只读/查询类关键字就返回 True，
    避免「首句是 ALTER、后面才是查询」的整块被误摘执行按钮
    （拆分后每条由 :func:`split_read_flags` 单独判定，口径与本函数一致）。
    BEGIN/DECLARE 匿名块交给 :func:`classify_plsql_block`：纯只读分析算 SQL。

    返回 ``(is_sql, 首关键词)``；``is_sql=False`` 时第二个元素是「拦下来那条的关键字」。
    """
    cleaned = strip_comments(sql or '')
    if not cleaned.strip():
        return False, 'UNKNOWN'
    statements = split_statements(cleaned)
    if not statements:
        return False, 'UNKNOWN'
    hit = 'UNKNOWN'
    for statement in statements:
        text = statement.strip()
        if not text:
            continue
        keyword = leading_keyword(text)
        if keyword in READ_SQL_TOKENS:
            return True, keyword
        if keyword.startswith('BEGIN') or keyword.startswith('DECLARE'):
            block_kind = classify_plsql_block(text, db_type)
            if block_kind == 'read':
                return True, 'BEGIN-READ'
            if block_kind == 'write':
                return False, 'BEGIN-WRITE'
            hit = 'BEGIN'
            continue
        if hit == 'UNKNOWN' and keyword:
            hit = keyword
    return False, hit


def split_read_flags(sql, db_type=''):
    """把一段文本拆成逐条语句，并给出与语句一一对应的「是只读查询」布尔数组。

    ``executable`` 必须与 ``statements`` 等长且元素是布尔：前端按下标直接取值，
    「界面看到几条 == 后端会跑几条」也由这同一个拆分器保证。
    """
    cleaned = strip_comments(sql or '')
    statements = [item.strip() for item in split_statements(cleaned) if item.strip()]
    flags = []
    for statement in statements:
        try:
            is_sql, _keyword = looks_like_read_sql(statement, db_type)
        except Exception:
            is_sql = False
        flags.append(bool(is_sql))
    return statements, flags


_REJECTION_MESSAGES = {
    'write': '写操作语句（INSERT/UPDATE/DELETE/DDL 等）被拒绝：本助手只读，只执行查询语句',
    'dangerous': '高危管理语句（SHUTDOWN/GRANT/REVOKE/改密码等）被拒绝：本助手只读',
    'injection': '检测到 SQL 注入特征（堆叠语句、编码绕过、时间盲注等），已拒绝执行',
    'unknown': '无法识别为只读查询，已拒绝执行（只允许 '
               'SELECT/SHOW/EXPLAIN/WITH/DESCRIBE/DESC/VALUES）',
}


def rejection_reason(kind):
    """把判定结果翻成给 DBA 看得懂的一句话。"""
    return _REJECTION_MESSAGES.get(kind, _REJECTION_MESSAGES['unknown'])
