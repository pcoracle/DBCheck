# -*- coding: utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""
AI 文本规范化（单一真源）
=========================

版权归属：MIT License, Copyright (c) 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>。

**问题**：LLM 返回的「AI 诊断建议」习惯把 Markdown 和 HTML 混着写，例如

    【修复方案】<sql>ALTER DATABASE FORCE LOGGING;</sql><br><br>验证：<sql>SELECT ...</sql>
    | 参数 | 当前值 | 基线要求 |
    |------|--------|----------|

而报告渲染器（Word / HTML）只认 Markdown —— HTML 标签会被当成普通文字写进
段落或单元格，最终在报告里原样显示 `<br>` / `<sql>`；Markdown 表格也退化成
一行行带竖线的纯文本。

**做法**：渲染前统一过一遍 `normalize_ai_text()`，把 HTML 标签翻译成等价的
Markdown（`<br>` → 换行、`<sql>/<code>` → 行内代码、`<b>` → `**`、`<li>` → `- `、
`<h3>` → `###` …）并解码 HTML 实体；再由 `parse_md_table()` 取出 Markdown 表格，
交给各渲染器画成真正的 Word / HTML 表格。

**安全边界**：只翻译「白名单标签」且多数标签要求成对出现，SQL 里的比较符
（`WHERE a < b`、`a <> b`）绝不能被误当成标签吃掉；带属性的形式额外要求标签
内含 `=`，避免把 `a<b AND c>d` 整段当成标签抹掉。
"""

import re
from html import unescape

__all__ = ['normalize_ai_text', 'parse_md_table', 'split_table_row', 'md_to_simple_html',
           'SOFT_BREAK']

# `<br>` 的落点：软换行（同一段落内的换行）。
# 用 \x0b（垂直制表）而不是 '\n' —— '\n' 是「段落分隔」，会把同一段建议拆成两段；
# 软换行则保持「标签 + 内容」同段（与模型的排版意图一致）。
# 各渲染器都必须把它转成真换行（Word: w:br；HTML: <br>），不能漏到正文里。
SOFT_BREAK = '\x0b'

# ── 白名单标签正则 ───────────────────────────────────────────────────────────
_BR_RE = re.compile(r'<br\s*/?\s*>', re.I)
_HR_RE = re.compile(r'<hr\s*/?\s*>', re.I)
_P_RE = re.compile(r'</?p\s*/?>', re.I)
_LI_RE = re.compile(r'<li\s*/?>', re.I)
_LI_END_RE = re.compile(r'</li\s*>', re.I)
_LIST_RE = re.compile(r'</?(?:ul|ol)\s*/?>', re.I)
_HEAD_OPEN_RE = re.compile(r'<h([1-6])\s*/?>', re.I)
_HEAD_CLOSE_RE = re.compile(r'</h[1-6]\s*>', re.I)
_TABLE_TAG_RE = re.compile(r'</?(?:table|thead|tbody|tfoot)\s*/?>', re.I)
_TABLE_ROW_RE = re.compile(r'</?tr\s*/?>', re.I)
_TABLE_CELL_RE = re.compile(r'</?(?:td|th)\s*/?>', re.I)
# 成对代码标签：<sql>…</sql> / <code>…</code> / <pre>…</pre>
_CODE_PAIR_RE = re.compile(
    r'<(?:sql|code|pre|kbd|samp)>(.*?)</(?:sql|code|pre|kbd|samp)\s*>', re.I | re.S)
# 落单的代码标签（只去标签、保留内容）
_CODE_OPEN_RE = re.compile(r'</?(?:sql|code|pre|kbd|samp)\s*/?>', re.I)
# 强调标签：要求成对；带属性的形式必须含 '='（见模块 docstring 的 SQL 比较符说明）
_BOLD_PAIR_RE = re.compile(
    r'<(?:strong|b)(?:>|\s[^<>]*=[^<>]*>)(.*?)</(?:strong|b)\s*>', re.I | re.S)
_ITALIC_PAIR_RE = re.compile(
    r'<(?:em|i)(?:>|\s[^<>]*=[^<>]*>)(.*?)</(?:em|i)\s*>', re.I | re.S)
_STRONG_CLOSE_RE = re.compile(r'</(?:strong|b)\s*>', re.I)
_ITALIC_CLOSE_RE = re.compile(r'</(?:em|i)\s*>', re.I)
# 无语义的容器标签：直接丢弃
_DROP_TAG_RE = re.compile(
    r'</?(?:span|div|font|small|u|center|section|article|figure|blockquote|sup|sub|mark|del|ins)'
    r'(?:\s[^<>]*=[^<>]*)?\s*/?>', re.I)

_BLANK_LINE_MAX = 2


def normalize_ai_text(text):
    """把 AI 输出的 Markdown/HTML 混排文本规范成纯 Markdown。

    :param text: 原始文本（AI 建议、补充说明等）
    :return: 规范化后的 Markdown 文本；入参为空时返回空串
    """
    if not text:
        return ''
    if not isinstance(text, str):
        text = str(text)

    s = text.replace('\r\n', '\n').replace('\r', '\n')

    # 1) HTML 实体先解码：模型有时把标签本身转义成 &lt;br&gt;
    s = unescape(s).replace('\xa0', ' ')

    # 2) 换行类先行：<br> → 软换行（放在代码标签之前，代码里的 <br> 才不会残留成字面文本）
    s = _BR_RE.sub(SOFT_BREAK, s)

    # 3) 成对代码标签 → 行内代码（内容里的反引号先去掉，避免破坏 Markdown 配对）
    s = _CODE_PAIR_RE.sub(
        lambda m: '`%s`' % m.group(1).replace('`', '').strip(), s)

    # 4) 表格类
    s = _HR_RE.sub('\n---\n', s)
    s = _TABLE_TAG_RE.sub('\n', s)
    s = _TABLE_ROW_RE.sub('\n', s)
    s = _TABLE_CELL_RE.sub(' | ', s)

    # 5) 结构类
    s = _HEAD_OPEN_RE.sub(lambda m: '\n%s ' % ('#' * int(m.group(1))), s)
    s = _HEAD_CLOSE_RE.sub('\n', s)
    s = _LI_RE.sub('\n- ', s)
    s = _LI_END_RE.sub('', s)
    s = _LIST_RE.sub('\n', s)
    s = _P_RE.sub('\n', s)

    # 6) 强调类（成对翻译，再清理落单的闭合标签）
    s = _BOLD_PAIR_RE.sub(lambda m: '**%s**' % m.group(1), s)
    s = _ITALIC_PAIR_RE.sub(lambda m: '*%s*' % m.group(1), s)
    s = _CODE_OPEN_RE.sub('', s)
    s = _STRONG_CLOSE_RE.sub('', s)
    s = _ITALIC_CLOSE_RE.sub('', s)
    s = _DROP_TAG_RE.sub('', s)

    # 7) 收尾：行尾空白、连续空行（最多保留一个空行）
    out = []
    blank = 0
    for line in s.split('\n'):
        line = line.rstrip()
        if line:
            blank = 0
        else:
            blank += 1
            if blank > _BLANK_LINE_MAX:
                continue
        out.append(line)
    return '\n'.join(out).strip('\n')


def split_table_row(line):
    """拆分 Markdown 表格行 → 单元格文本列表（保留 ``\\|`` 转义）。"""
    s = (line or '').strip()
    if s.startswith('|'):
        s = s[1:]
    if s.endswith('|') and not s.endswith('\\|'):
        s = s[:-1]
    return [c.replace('\\|', '|').strip() for c in re.split(r'(?<!\\)\|', s)]


def _is_table_row(line):
    s = (line or '').strip()
    return len(s) >= 2 and s.startswith('|') and '|' in s[1:]


def _is_table_sep(line):
    """分隔行判定：``|---|:--:|`` —— 逐单元格判断，整体不能含管道符。"""
    s = (line or '').strip()
    if not _is_table_row(s):
        return False
    cells = s.strip('|').split('|')
    if len(cells) < 2:
        return False
    for cell in cells:
        if re.fullmatch(r':?-+:?', cell.replace(' ', '')) is None:
            return False
    return True


def parse_md_table(lines, start):
    """从 ``lines[start]`` 起解析一个 Markdown 表格。

    表格 = 表头行 + ``|---|---|`` 分隔行 + 若干数据行（允许 0 行数据，此时只画表头）。
    不满足结构条件返回 ``None``，由调用方按普通文本渲染 —— 免得把普通文本里的
    竖线误当成表格。
    """
    if start + 1 >= len(lines):
        return None
    if not _is_table_row(lines[start]) or not _is_table_sep(lines[start + 1]):
        return None
    headers = split_table_row(lines[start])
    if len(headers) < 2:
        return None

    rows = []
    i = start + 2
    while i < len(lines) and _is_table_row(lines[i]) and not _is_table_sep(lines[i]):
        rows.append(split_table_row(lines[i]))
        i += 1

    ncol = len(headers)
    rows = [(r + [''] * ncol)[:ncol] for r in rows]
    return headers, rows, i


def _escape_soft(text):
    """HTML 转义 + 把软换行还原成 ``<br>``（转义在前，保证不会带出裸标签）。"""
    from html import escape
    return escape(text or '').replace(SOFT_BREAK, '<br>')


def _inline_html(text):
    """行内 Markdown → HTML（先转义再翻译，保证不会带出裸标签）。"""
    s = _escape_soft(text)
    s = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', s)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    s = re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)', r'<em>\1</em>', s)
    return s


def md_to_simple_html(text):
    """把（已 normalize 的）Markdown 文本转成一段自包含 HTML。

    支持：标题 / 段落 / 有序与无序列表 / 代码块 / Markdown 表格。
    用于 HTML 报告路径，与 Word 路径共用同一套解析（避免两条路径再次跑偏）。
    """
    lines = normalize_ai_text(text).split('\n')
    out = []
    list_open = None
    i = 0

    def close_list():
        nonlocal list_open
        if list_open:
            out.append('</%s>' % list_open)
            list_open = None

    while i < len(lines):
        raw = lines[i]
        s = raw.strip()
        if not s:
            close_list()
            i += 1
            continue

        # 代码块
        if s.startswith('```'):
            code = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith('```'):
                code.append(lines[i])
                i += 1
            i += 1
            close_list()
            out.append('<pre class="ai-code">%s</pre>'
                       % _escape_soft('\n'.join(code).strip()))
            continue

        # Markdown 表格
        table = parse_md_table(lines, i)
        if table:
            headers, rows, i = table
            close_list()
            head = ''.join('<th>%s</th>' % _inline_html(h) for h in headers)
            body = ''.join(
                '<tr>%s</tr>' % ''.join('<td>%s</td>' % _inline_html(c) for c in row)
                for row in rows)
            out.append('<table class="ai-table"><thead><tr>%s</tr></thead><tbody>%s</tbody></table>'
                       % (head, body))
            continue

        # 标题
        m = re.match(r'^(#{1,6})\s+(.*)$', s)
        if m:
            close_list()
            level = min(len(m.group(1)) + 2, 6)
            out.append('<h%d>%s</h%d>' % (level, _inline_html(m.group(2)), level))
            i += 1
            continue

        # 列表
        m = re.match(r'^[-*]\s+(.*)$', s)
        if m:
            if list_open != 'ul':
                close_list()
                out.append('<ul>')
                list_open = 'ul'
            out.append('<li>%s</li>' % _inline_html(m.group(1)))
            i += 1
            continue
        m = re.match(r'^\d+\.\s+(.*)$', s)
        if m:
            if list_open != 'ol':
                close_list()
                out.append('<ol>')
                list_open = 'ol'
            out.append('<li>%s</li>' % _inline_html(m.group(1)))
            i += 1
            continue

        # 普通段落
        close_list()
        out.append('<p>%s</p>' % _inline_html(s))
        i += 1

    close_list()
    return '\n'.join(out)