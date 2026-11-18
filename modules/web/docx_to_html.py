# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""
DOCX 转 HTML 转换模块
====================
将 python-docx 生成的 .docx 巡检报告转换为美观的 HTML 格式。
- 巡检目录导航：自动生成章节目录，支持跳转和返回
- 表格单元格单行显示（white-space: nowrap），支持横向滚动
- 宽表最大化：列数过多的表格支持全屏查看
- 保留表头底色、字体大小等样式
- 自动识别标题层级、段落、表格
"""
import os
import re
import html
from docx import Document
from docx.oxml.ns import qn


# ── 宽表阈值：列数超过此值时显示「最大化」按钮 ──
WIDE_TABLE_THRESHOLD = 7

# ── 表格行折叠阈值：数据行超过此值时自动折叠多余行 ──
TABLE_ROW_COLLAPSE_THRESHOLD = 15

# ── 最大化入口图标（四角外扩括号，等同 Material Symbols 的 open_in_full）──
# 用内联 SVG 而非字体符号：不依赖系统字体，跨平台渲染一致
MAXIMIZE_ICON_SVG = (
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">'
    '<path d="M4 9V4h5v2H6v3H4zM15 4h5v5h-2V6h-3V4zM4 15v5h5v-2H6v-3H4zM20 15v5h-5v-2h3v-3h2z"/>'
    '</svg>'
)

# ── 目录按钮图标（同样内联 SVG）──
# 展开/收起全部章节：双箭头背离 = 展开，相向 = 收起（Material unfold_more / unfold_less）
_ICON_UNFOLD_MORE = (
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">'
    '<path d="M12 5.83L15.17 9l1.41-1.41L12 3 7.41 7.59 8.83 9 12 5.83z'
    'm0 12.34L8.83 15l-1.41 1.41L12 21l4.59-4.59L15.17 15 12 18.17z"/></svg>'
)
_ICON_UNFOLD_LESS = (
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">'
    '<path d="M7.41 18.59L8.83 20 12 16.83 15.17 20l1.41-1.41L12 14l-4.59 4.59z'
    'm9.18-13.18L15.17 4 12 7.17 8.83 4 7.41 5.41 12 10l4.59-4.59z"/></svg>'
)
# 侧栏收起/展开：双尖括号指向面板将要移动的方向
_ICON_CHEVRONS_LEFT = (
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">'
    '<path d="M12.41 7.41L11 6 5 12l6 6 1.41-1.41L7.83 12z'
    'M18.91 7.41L17.5 6 11.5 12l6 6 1.41-1.41L14.33 12z"/></svg>'
)
_ICON_CHEVRONS_RIGHT = (
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">'
    '<path d="M11.59 7.41L13 6l6 6-6 6-1.41-1.41L16.17 12z'
    'M5.09 7.41L6.5 6 12.5 12l-6 6-1.41-1.41L9.67 12z"/></svg>'
)
# 上一个 / 下一个异常章节（单尖括号，方向对应当前所在位置）
_ICON_CHEVRON_UP = (
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">'
    '<path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/></svg>'
)
_ICON_CHEVRON_DOWN = (
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">'
    '<path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>'
)

# ── 异常检测关键词 ──
# 短英文词使用正则词边界匹配，避免误匹配子串（如 fail→failover, down→download）
_CRITICAL_KEYWORDS = ['error', '错误', '失败', 'critical', '严重', 'crash', 'offline']
_CRITICAL_REGEX_KEYWORDS = [r'\bfail\b', r'\bfails\b', r'\bfailed\b', r'\bfailure\b', r'\bdown\b']
_WARNING_KEYWORDS = ['警告', 'abnormal', 'timeout', '超时']
_WARNING_REGEX_KEYWORDS = [r'\bwarn\b', r'\bwarning\b', r'\bwarns\b', r'\balert\b']
_HIGH_RISK_KEYWORDS = ['高风险', 'high risk', 'critical']
_MID_RISK_KEYWORDS = ['中风险', 'medium risk']
_LOW_RISK_KEYWORDS = ['低风险', 'low risk']

# ── 排除匹配的上下文关键词（这些场景下的关键词属于正常描述，非异常）──
_FALSE_POSITIVE_CONTEXTS = [
    '告警日志', 'alert log', 'alert_log', 'alert.', 'alert日志',  # 章节标题
    '异常处理', '异常检测', '异常项', '异常规则',                  # 描述性文字
    'risk_item', '风险项', '风险等级', '风险与建议',               # 风险表表头
    'severity', 'status', 'level',                                # 列名
    'no error', 'no errors', '无错误', '无异常',                  # "无异常"描述
    '0 error', '0 errors', 'error=0', 'error: 0', '错误: 0',      # 零计数
    'no fail', 'no failed', '无失败',                              # "无失败"描述
    'no warning', 'no warn', '无警告',                             # "无警告"描述
    'no abnormal', '无异常',                                       # "无异常"描述
]


def _escape(text):
    """HTML 转义"""
    if text is None:
        return ''
    return html.escape(str(text), quote=False)


def _get_cell_bg_color(cell):
    """获取单元格背景色"""
    try:
        tc_pr = cell._tc.tcPr
        if tc_pr is not None:
            shd = tc_pr.find(qn('w:shd'))
            if shd is not None:
                fill = shd.get(qn('w:fill'))
                if fill:
                    return '#' + fill
    except Exception:
        pass
    return None


def _get_cell_text(cell):
    """获取单元格纯文本内容"""
    parts = []
    for p in cell.paragraphs:
        parts.append(p.text)
    return '\n'.join(parts)


def _get_cell_html(cell):
    """获取单元格 HTML 内容，保留 run 级字体颜色"""
    parts = []
    for p in cell.paragraphs:
        run_parts = []
        for run in p.runs:
            text = _escape(run.text)
            if not text:
                continue
            # 检测字体颜色
            color = None
            try:
                if run.font.color and run.font.color.rgb:
                    color = str(run.font.color.rgb)
            except Exception:
                pass
            # 检测粗体
            bold = run.bold if run.bold else False
            # 构建 span
            styles = []
            if color and color != '000000':
                styles.append(f'color:#{color}')
            if bold:
                styles.append('font-weight:bold')
            if styles:
                run_parts.append(f'<span style="{";".join(styles)}">{text}</span>')
            else:
                run_parts.append(text)
        if run_parts:
            parts.append(''.join(run_parts))
        else:
            parts.append(_escape(p.text))
    return '<br>'.join(parts)


def _detect_anomaly(text, is_header=False):
    """检测文本中的异常内容，返回 (severity, label, matched_keyword)

    severity: 'critical' / 'warning' / 'high_risk' / 'mid_risk' / 'low_risk' / None
    matched_keyword: 实际匹配到的关键词（用于 tooltip 展示）

    优化策略：
    - 跳过表头行（is_header=True 时直接返回 None）
    - 英文短词使用正则词边界匹配，避免子串误匹配
    - 排除"无异常""0 errors"等否定语境
    - ORA- 错误仍然精确匹配（这是真实错误码）
    """
    if not text or is_header:
        return None, None, None
    lower = str(text).lower().strip()

    # 排除否定语境（"无异常""0 errors"等不是异常）
    for ctx in _FALSE_POSITIVE_CONTEXTS:
        if ctx in lower:
            return None, None, None

    # 检测 ORA- 错误（最高优先级，这是精确的错误码匹配）
    if 'ora-' in lower:
        return 'critical', 'ORA错误', 'ORA-'

    # 检测高风险
    for kw in _HIGH_RISK_KEYWORDS:
        if kw in lower:
            return 'high_risk', '高风险', kw

    # 检测严重错误 — 普通子串匹配
    for kw in _CRITICAL_KEYWORDS:
        if kw in lower:
            return 'critical', '严重', kw

    # 检测严重错误 — 正则词边界匹配（避免 fail→failover, down→download）
    for pattern in _CRITICAL_REGEX_KEYWORDS:
        if re.search(pattern, lower):
            return 'critical', '严重', pattern.replace('\\b', '')

    # 检测中风险
    for kw in _MID_RISK_KEYWORDS:
        if kw in lower:
            return 'mid_risk', '中风险', kw

    # 检测警告 — 普通子串匹配
    for kw in _WARNING_KEYWORDS:
        if kw in lower:
            return 'warning', '警告', kw

    # 检测警告 — 正则词边界匹配
    for pattern in _WARNING_REGEX_KEYWORDS:
        if re.search(pattern, lower):
            return 'warning', '警告', pattern.replace('\\b', '')

    # 检测低风险
    for kw in _LOW_RISK_KEYWORDS:
        if kw in lower:
            return 'low_risk', '低风险', kw

    return None, None, None


# ── 基线表语义化判定 ──
# 基线表（合规基线 / 配置优化基线）自带「风险等级」列，列值是**分类标签**而非结论：
#   · 合规基线（参数|当前值|期望|状态|风险等级|说明）——结论在「状态」列，
#     「风险等级」是该基线配置的等级，PASS 行也可能标着 HIGH。
#   · 配置优化基线（参数|当前值|建议值|差距|风险等级）——无状态列，
#     「风险等级」即结论，且「低风险」对应 info（配置合理），不是异常。
# 若对这些列跑通用关键词扫描，会让每一行都命中「高风险/中风险/低风险」，
# 表现为"基线检查全部显示异常"。故基线表只按结论列判定。
_BASELINE_STATUS_HEADERS = ('状态', 'status', '结果', 'result', '结论')
_BASELINE_LEVEL_HEADERS = ('风险等级', '级别', 'severity', 'risk level', 'level')
_BASELINE_CURRENT_HEADERS = ('当前值', 'current value', 'current')

_SEVERITY_LABELS = {
    'critical': '严重',
    'high_risk': '高风险',
    'warning': '警告',
    'mid_risk': '中风险',
    'low_risk': '低风险',
}


def _find_col(headers, keys):
    """返回首个表头命中 keys 之一的列下标（大小写不敏感），未命中返回 None"""
    for idx, h in enumerate(headers):
        low = str(h).lower()
        if any(k in low for k in keys):
            return idx
    return None


def _is_baseline_table(headers):
    """基线表识别：同时含「当前值」与「风险等级/级别」列"""
    return (_find_col(headers, _BASELINE_CURRENT_HEADERS) is not None
            and _find_col(headers, _BASELINE_LEVEL_HEADERS) is not None)


_BL_LEVEL_HIGH = {'高', '高风险', '严重', 'high', 'high risk', 'critical', 'severe'}
_BL_LEVEL_MID = {'中', '中风险', '警告', 'medium', 'mid', 'medium risk', 'warning', 'warn'}


def _baseline_level_severity(text):
    """基线『风险等级』列作为结论依据（表内无状态列时使用）。

    低风险 / 低 / Low / info / 正常 = 配置合理，不算异常。
    该列只有在表内没有状态列时才参与判定，因此裸 'High'/'Medium' 这类
    英文等级可安全按结论处理。
    """
    s = str(text or '').strip()
    if not s:
        return None
    if s in _BL_LEVEL_HIGH or s.lower() in _BL_LEVEL_HIGH:
        return 'high_risk'
    if s in _BL_LEVEL_MID or s.lower() in _BL_LEVEL_MID:
        return 'mid_risk'
    return None


def _baseline_status_severity(text, level_text):
    """基线『状态』列 → 严重度。

    PASS 视为正常；UNKNOWN/SKIP 表示未取到数据或当前版本不适用，不算异常；
    FAIL 按基线配置的风险等级定级；ERROR 表示判定无法完成（多为基线 SQL 取错值），
    单独标为警告以便暴露配置问题。
    """
    s = str(text or '').strip().upper()
    if s in ('', 'PASS', 'OK', 'YES', '正常', '合格', '通过', 'SKIP', 'UNKNOWN'):
        return None
    if s in ('ERROR', '错误', '无法判定', 'N/A'):
        return 'warning'
    lv = str(level_text or '').strip().upper()
    if 'HIGH' in lv or 'CRITICAL' in lv or '高' in lv or '严重' in lv:
        return 'high_risk'
    if 'LOW' in lv or '低' in lv:
        return 'low_risk'
    if 'MEDIUM' in lv or 'MID' in lv or '中' in lv or 'WARN' in lv:
        return 'mid_risk'
    return 'mid_risk'


# ── 巡检项章节标题 → 引擎层判断规则映射 ──
_SECTION_RULE_MAP = [
    # (标题关键词列表, 巡检项名称, 判断规则描述)
    (['表空间', 'tablespace'], '表空间使用率',
     '使用率 = (已用空间 / max(当前大小, 最大可扩展大小)) × 100%'),
    (['无效对象', 'invalid'], '无效对象',
     '统计 STATUS=INVALID 的对象数量'),
    (['alert', '告警日志'], 'Alert 告警日志',
     '扫描 alert.log 中的 ORA- 错误'),
    (['锁定', 'locked', '用户安全'], '锁定用户',
     '检查 ACCOUNT_STATUS=LOCKED 的用户'),
    (['基线', 'baseline', '配置'], '配置基线检查',
     'gap_pct = |当前值 - 推荐值| / 推荐值 × 100%（推荐值根据主机内存/CPU/DB大小动态计算）'),
    (['statistics_level'], 'statistics_level',
     'Oracle 统计级别模式检查'),
    (['阻塞', 'blocking'], '阻塞会话',
     '检测锁等待中 request > 0 的会话'),
    (['死锁', 'deadlock'], '死锁检测',
     '非 Idle 等待且存在锁请求'),
    (['长事务', 'long_trx', 'long trx'], '长事务',
     '事务持续时间 > 60 秒'),
    (['作业', 'job', '调度'], '作业调度',
     '检查 failures > 0 或 broken=Y 的作业'),
    (['长sql', 'long_sql', 'longops', '长时间'], '长时间运行 SQL',
     'v$session_longops 中 elapsed_seconds > 30 且未完成的操作'),
    (['索引', 'index'], '索引健康分析',
     '分析缺失索引、冗余索引、未使用索引（90天阈值）'),
    (['redo', '日志组'], 'Redo 日志组',
     '每组 thread 的 redo log group 数量检查'),
    (['控制文件', 'controlfile', 'control file'], '控制文件',
     '检查控制文件是否多路复用（存于不同磁盘）'),
    (['备份', 'backup', 'rman'], '备份状态',
     '检查最近 30 天内 RMAN 备份记录'),
    (['dataguard', 'data guard', 'dg'], 'DataGuard',
     '检查备库归档日志应用延迟（gap）'),
    (['rac', '集群'], 'RAC 集群',
     '检查 gv$instance 中各节点 STATUS'),
    (['闪回', 'flashback'], '闪回配置',
     '检查 v$database.flashback_on'),
    (['asm', '磁盘组'], 'ASM 磁盘组',
     'v$asm_diskgroup 中 free_mb/total_mb 使用率'),
    (['undo'], 'Undo 表空间',
     '检查 undo 表空间使用率及 undo_retention 是否满足'),
    (['sga', 'pga', '内存'], 'SGA/PGA 内存',
     '检查内存组件分配及使用率'),
    (['参数', 'param'], '数据库参数',
     '检查关键初始化参数配置'),
    (['会话', 'session', '连接'], '会话与连接',
     '检查当前会话数、进程数及连接限制'),
    (['性能', 'performance', 'awr'], '性能与 AWR',
     '分析 AWR 报告中的性能指标'),
]


def _get_section_rule(section_title):
    """根据章节标题匹配引擎层判断规则，返回 (巡检项名称, 规则描述) 或 (None, None)"""
    if not section_title:
        return None, None
    lower_title = section_title.lower()
    for keywords, item_name, rule_desc in _SECTION_RULE_MAP:
        for kw in keywords:
            if kw.lower() in lower_title:
                return item_name, rule_desc
    return None, None


# ── 渲染层规则描述映射 ──
_RENDER_RULE_DESC = {
    'critical': '文本包含严重错误关键词（ORA-/error/错误/失败/fail/critical/严重/crash/down/offline）',
    'high_risk': '文本包含高风险关键词（高风险/high risk）',
    'mid_risk': '文本包含中风险关键词（中风险/medium risk/warning/warn）',
    'warning': '文本包含警告关键词（warning/警告/warn/异常/abnormal/alert/timeout/超时）',
    'low_risk': '文本包含低风险关键词（低风险/low risk/info）',
}


def _build_row_tooltip(severity, label, matched_kw, section_title, row_data_preview):
    """为异常行构建 tooltip 文本

    组合引擎层规则（基于章节标题）和渲染层规则（基于关键词匹配）
    """
    parts = []

    # 引擎层规则
    item_name, rule_desc = _get_section_rule(section_title)
    if item_name:
        parts.append(f'【巡检项】{item_name}')
        parts.append(f'【判断规则】{rule_desc}')
    else:
        parts.append('【巡检项】通用异常检测')

    # 渲染层规则
    render_desc = _RENDER_RULE_DESC.get(severity, '')
    if render_desc:
        parts.append(f'【匹配规则】{render_desc}')

    if matched_kw:
        parts.append(f'【匹配关键词】"{matched_kw}"')

    if label:
        parts.append(f'【风险等级】{label}')

    if row_data_preview:
        preview = row_data_preview[:80] + '...' if len(row_data_preview) > 80 else row_data_preview
        parts.append(f'【行数据】{preview}')

    return '\n'.join(parts)


def _get_anomaly_style(severity):
    """根据异常严重程度返回 CSS 样式字符串"""
    styles = {
        'critical': 'background-color:#fef2f2;border-left:3px solid #ef4444;',
        'high_risk': 'background-color:#fff7ed;border-left:3px solid #f97316;',
        'warning': 'background-color:#fffbeb;border-left:3px solid #f59e0b;',
        'mid_risk': 'background-color:#fffbeb;border-left:3px solid #f59e0b;',
        'low_risk': 'background-color:#f0fdf4;border-left:3px solid #22c55e;',
    }
    return styles.get(severity, '')


# ── 行级警告级别标签配置 ──
_ROW_SEVERITY_CONFIG = {
    'critical':   {'label': '严重',   'bg': '#dc2626', 'fg': '#fff', 'row_bg': '#fee2e2'},
    'high_risk':  {'label': '高风险', 'bg': '#ea580c', 'fg': '#fff', 'row_bg': '#fed7aa'},
    'warning':    {'label': '警告',   'bg': '#d97706', 'fg': '#fff', 'row_bg': '#fef3c7'},
    'mid_risk':   {'label': '中风险', 'bg': '#d97706', 'fg': '#fff', 'row_bg': '#fef3c7'},
    'low_risk':   {'label': '低风险', 'bg': '#16a34a', 'fg': '#fff', 'row_bg': '#d1fae5'},
}


def _get_row_severity_tag(severity):
    """生成行首警告级别标签 HTML（彩色色块 + 文字）"""
    cfg = _ROW_SEVERITY_CONFIG.get(severity)
    if not cfg:
        return ''
    return (
        f'<span class="row-severity-tag" style="'
        f'background:{cfg["bg"]};color:{cfg["fg"]};'
        f'display:inline-block;padding:2px 8px;border-radius:3px;'
        f'font-size:11px;font-weight:700;margin-right:8px;'
        f'white-space:nowrap;flex-shrink:0;letter-spacing:1px;'
        f'box-shadow:0 1px 3px rgba(0,0,0,0.2);">'
        f'{cfg["label"]}</span>'
    )


def _get_anomaly_badge(severity, label):
    """生成异常标识小标签 HTML"""
    if not severity:
        return ''
    colors = {
        'critical': ('#ef4444', '#fef2f2'),
        'high_risk': ('#f97316', '#fff7ed'),
        'warning': ('#f59e0b', '#fffbeb'),
        'mid_risk': ('#f59e0b', '#fffbeb'),
        'low_risk': ('#22c55e', '#f0fdf4'),
    }
    fg, bg = colors.get(severity, ('#6b7280', '#f3f4f6'))
    return f'<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;background:{bg};color:{fg};border:1px solid {fg}40">{label}</span>'


def _is_heading(paragraph):
    """判断是否是标题，返回级别 (1-9) 或 0"""
    style_name = paragraph.style.name if paragraph.style else ''
    if style_name.startswith('Heading'):
        try:
            level = int(style_name.replace('Heading', '').replace(' ', '').strip())
            return min(level, 6)  # HTML 最大 h6
        except ValueError:
            return 0
    return 0


# ── 子项折叠阈值：超过此数量时自动折叠（4列布局下3项为宜）──
TOC_COLLAPSE_THRESHOLD = 3

# ── 规则引擎风险项(col1) → 目录章节标题的关键词映射 ──
# 顺序敏感：更具体的关键词组在前，避免被通用词抢先匹配（如"无效对象"优先于"用户"）
_RISK_SECTION_MAP = [
    (['无效对象', 'invalid'],            ['无效', 'invalid', '对象']),
    (['表空间', 'tablespace'],           ['表空间', 'tablespace']),
    (['temp'],                           ['表空间', 'temp']),
    (['锁阻塞', '死锁', '阻塞', 'lock', 'deadlock'], ['锁', 'lock', '阻塞', '死锁']),
    (['长事务', 'undo'],                 ['事务', 'transaction', 'undo']),
    (['sga', 'pga', '内存'],             ['内存', 'memory', 'sga', 'pga']),
    (['redo'],                           ['redo']),
    (['归档', 'archive'],                ['归档', 'archive']),
    (['备份', 'backup', 'rman'],         ['备份', 'backup', 'rman']),
    (['data guard', 'dataguard', '备库', 'standby'], ['data guard', 'dataguard', 'dg', '备库', 'standby']),
    (['asm', '磁盘组'],                  ['asm', '磁盘']),
    (['闪回', 'fra', 'flashback'],       ['闪回', 'fra', 'flashback']),
    (['密码', 'profile', '安全策略'],     ['安全', '密码', 'profile']),
    (['会话', 'session'],                ['会话', 'session']),
    (['进程', 'process'],                ['会话', 'session', '进程', 'process']),
    (['用户', '账户', 'account', '锁定', '过期'], ['用户', 'user', '账户']),
    (['参数', 'parameter'],              ['参数', 'parameter']),
    (['控制文件', 'control file'],       ['控制文件', 'control']),
    (['数据文件', 'datafile'],           ['数据文件', 'datafile']),
    (['告警日志', 'alert log', 'alert'], ['告警', 'alert']),
    (['性能', 'performance', '等待', 'wait'], ['性能', 'performance', '等待']),
    (['监听', 'listener'],               ['监听', 'listener']),
    (['网络', 'network'],                ['网络', 'network']),
    (['作业', 'job', '调度'],            ['作业', 'job', '调度']),
]


class _HeadingCollector:
    """收集标题信息用于生成目录，并追踪每个章节的异常"""

    def __init__(self):
        self.headings = []  # [(level, text, heading_id), ...]
        self._counter = 0
        # 当前一级章节序号 / 该章节内子节序号（按报告内出现顺序编号，消除源文档重复编号）
        self._ch_counter = 0
        self._sub_counter = 0
        # 当前章节 ID（最近添加的标题），用于归属异常
        self._current_section_id = None
        # 当前章节标题文本（用于 tooltip 规则匹配）
        self._current_section_title = None
        # 每个章节的异常统计: {heading_id: {'critical': N, 'warning': N, ...}}
        self.section_anomalies = {}
        # 逐条风险项 → 匹配到的章节: [{'issue': dict, 'heading_id': str|None, 'severity': str}]
        # 由 apply_analysis_issues 填充，供「按目录汇总」等下游复用
        self.issue_matches = []

    def add(self, level, text):
        """注册一个标题，返回分配的 heading_id"""
        self._counter += 1
        heading_id = f'heading-{self._counter}'
        if level < 2:
            # 新的一级章节：章节号递增，子节号清零
            self._ch_counter += 1
            self._sub_counter = 0
            text = _normalize_heading_text(level, self._ch_counter, 0, text)
        else:
            # 子节：当前章节内序号递增（无章节时兜底为第 1 章）
            ch = self._ch_counter if self._ch_counter > 0 else 1
            self._sub_counter += 1
            text = _normalize_heading_text(level, ch, self._sub_counter, text)
        self.headings.append((level, text, heading_id))
        self._current_section_id = heading_id
        self._current_section_title = text
        self.section_anomalies[heading_id] = {}
        return heading_id

    @property
    def current_section_title(self):
        """获取当前章节标题（用于 tooltip 规则匹配）"""
        return self._current_section_title

    def record_section_anomaly(self, severity):
        """将一条异常记录归属到当前章节"""
        if not severity or not self._current_section_id:
            return
        sa = self.section_anomalies.setdefault(self._current_section_id, {})
        sa[severity] = sa.get(severity, 0) + 1

    def apply_analysis_issues(self, analysis_issues):
        """用规则引擎分析结果覆盖关键词扫描的异常统计

        清除由关键词扫描产生的 section_anomalies，替换为规则引擎
        判定的风险项。只有规则引擎判定为风险的项才会在目录中标红。

        参数:
            analysis_issues: list[dict] | None — smart_analyze 输出的风险项列表
                             None 表示完全无规则引擎数据，保留关键词扫描结果作为回退
                             空列表表示规则引擎已运行但无风险，清除关键词扫描结果
        """
        # None 表示完全无规则引擎数据，保留关键词扫描作为回退
        if analysis_issues is None:
            return
        if not isinstance(analysis_issues, list):
            return

        # 清除关键词扫描结果（空列表也表示规则引擎已运行，需清除）
        for hid in self.section_anomalies:
            self.section_anomalies[hid] = {}

        # 清空上一次的逐项归属（同一 collector 可能被多次调用）
        self.issue_matches = []

        # 空列表：规则引擎已运行但未发现风险，无需匹配章节
        if not analysis_issues:
            return

        # 建立标题文本 → heading_id 的映射，按级别分层
        # 子章节优先匹配（level >= 2），一级标题作为回退
        sub_headings = [(hid, text.lower()) for level, text, hid in self.headings if level >= 2]
        top_headings = [(hid, text.lower()) for level, text, hid in self.headings if level < 2]

        for item in analysis_issues:
            if not isinstance(item, dict):
                continue
            col1 = str(item.get('col1', '')).lower()
            col2 = str(item.get('col2', '')).lower()
            if not col1:
                # 无风险项名称无法归属章节，仍记录以便下游完整展示
                self.issue_matches.append(
                    {'issue': item, 'heading_id': None, 'severity': ''})
                continue

            # 确定严重程度
            if '严重' in col2 or 'critical' in col2:
                severity = 'critical'
            elif '高' in col2:
                severity = 'high_risk'
            elif '中' in col2 or 'medium' in col2:
                severity = 'mid_risk'
            elif '低' in col2 or '建议' in col2 or '信息' in col2 or 'info' in col2:
                severity = 'low_risk'
            else:
                severity = 'warning'

            # 匹配到对应的章节（按 _RISK_SECTION_MAP 优先级顺序）
            # 先在子章节中查找，找不到再回退到一级标题
            matched_hid = None
            for risk_kws, section_kws in _RISK_SECTION_MAP:
                if any(rkw in col1 for rkw in risk_kws):
                    # 优先匹配子章节
                    for hid, htext in sub_headings:
                        if any(skw in htext for skw in section_kws):
                            matched_hid = hid
                            break
                    # 子章节未命中，回退到一级标题
                    if not matched_hid:
                        for hid, htext in top_headings:
                            if any(skw in htext for skw in section_kws):
                                matched_hid = hid
                                break
                    if matched_hid:
                        break

            # 记录到匹配的章节
            if matched_hid:
                sa = self.section_anomalies.setdefault(matched_hid, {})
                sa[severity] = sa.get(severity, 0) + 1

            # 记录逐项归属（matched_hid 为 None 表示未匹配到任何章节）
            self.issue_matches.append(
                {'issue': item, 'heading_id': matched_hid, 'severity': severity})

    def _get_severity_badge_html(self, anomalies):
        """根据异常统计生成目录小徽章 HTML"""
        if not anomalies:
            return ''
        critical = anomalies.get('critical', 0) + anomalies.get('high_risk', 0)
        warning = anomalies.get('warning', 0) + anomalies.get('mid_risk', 0)
        low = anomalies.get('low_risk', 0)

        badges = []
        if critical:
            badges.append(
                f'<span class="toc-badge toc-badge-critical" title="严重异常 {critical} 项">{critical}</span>'
            )
        if warning:
            badges.append(
                f'<span class="toc-badge toc-badge-warning" title="警告 {warning} 项">{warning}</span>'
            )
        if low:
            badges.append(
                f'<span class="toc-badge toc-badge-low" title="低风险 {low} 项">{low}</span>'
            )
        return ''.join(badges)

    def build_toc_html(self):
        """构建目录 HTML — 左侧栏树状列表 + 数字编号 + 逐章折叠 + 异常徽章 + 点击跳转"""
        if not self.headings:
            return ''

        # 按一级标题分组：cards = [(chapter_text, chapter_id, [(sub_text, sub_id), ...])]
        cards = []
        current_chapter = None
        current_subs = []
        for level, text, hid in self.headings:
            if level <= 1:
                if current_chapter is not None:
                    cards.append((current_chapter[0], current_chapter[1], current_subs))
                current_chapter = (text, hid)
                current_subs = []
            else:
                current_subs.append((text, hid))
        if current_chapter is not None:
            cards.append((current_chapter[0], current_chapter[1], current_subs))

        tree_items = []
        total_subs = 0
        for ch_text, ch_id, subs in cards:
            # 章节级异常：自身 + 所有子项汇总
            ch_anomalies = {}
            for k, v in self.section_anomalies.get(ch_id, {}).items():
                ch_anomalies[k] = ch_anomalies.get(k, 0) + v
            for _, sub_id in subs:
                for k, v in self.section_anomalies.get(sub_id, {}).items():
                    ch_anomalies[k] = ch_anomalies.get(k, 0) + v
            ch_badge = self._get_severity_badge_html(ch_anomalies)

            # 子项（编号已包含在章节标题文本中，不再额外生成）
            sub_items = []
            for sub_text, sub_id in subs:
                sub_badge = self._get_severity_badge_html(self.section_anomalies.get(sub_id, {}))
                sub_items.append(
                    f'<li class="toc-row toc-row-sub">'
                    f'<a href="#{sub_id}" class="toc-link toc-link-sub">'
                    f'<span class="toc-text">{_escape(sub_text)}</span></a>'
                    f'{sub_badge}</li>'
                )
            total_subs += len(subs)

            has_children = bool(subs)
            caret = (
                f'<button class="toc-caret" onclick="toggleTocNode(this)" '
                f'aria-label="展开/收起">▼</button>'
            ) if has_children else ''
            children = f'<ul class="toc-children">{"".join(sub_items)}</ul>' if has_children else ''
            node_class = 'toc-node' + (' toc-node-anomaly' if ch_badge else '')

            tree_items.append(
                f'<li class="{node_class}">'
                f'<div class="toc-row toc-row-ch">'
                f'{caret}'
                f'<a href="#{ch_id}" class="toc-link toc-link-ch">'
                f'<span class="toc-text">{_escape(ch_text)}</span></a>'
                f'{ch_badge}'
                f'</div>'
                f'{children}'
                f'</li>'
            )

        tree_html = '\n'.join(tree_items)
        total_chapters = len(cards)

        return f'''<nav class="report-toc" id="report-toc">
  <div class="toc-header">
    <span class="toc-icon">📋</span>
    <span class="toc-title">巡检目录</span>
    <span class="toc-count">{total_chapters} 章 · {total_subs} 节</span>
    <button type="button" class="toc-act" id="tocToggleAll" onclick="toggleAllToc()"
            title="收起全部章节（Ctrl+Shift+C）" aria-label="收起全部章节">{_ICON_UNFOLD_LESS}</button>
    <button type="button" class="sidebar-toggle" onclick="toggleSidebar(this)"
            title="收起目录" aria-label="收起目录">{_ICON_CHEVRONS_LEFT}</button>
  </div>
  <ul class="toc-tree">
{tree_html}
  </ul>
</nav>'''


def _normalize_heading_text(level, ch_num, sub_num, text):
    """重写标题开头的编号为报告内的真实顺序编号，消除源文档重复编号。

    源 docx 的章节编号可能重复（如附录章节沿用 24.1/24.2，或章节号本身重复），
    这里统一按报告内出现顺序重写：一级标题「N 标题」，二级及以上标题「N.M 标题」。
    仅处理标题文本开头的数字编号；编号与锚点 id 独立，不影响目录跳转。
    """
    if not text:
        return text
    new_num = str(ch_num) if level < 2 else f'{ch_num}.{sub_num}'
    pattern = r'^\s*\d+(?:\.\d+)*[\s.\u3001)]+'
    m = re.match(pattern, text)
    if m:
        return new_num + '\u3000' + text[m.end():]
    return new_num + '\u3000' + text


def _paragraph_to_html(paragraph, collector, anomaly_counter=None):
    """将段落转换为 HTML，标题自动注册到目录并添加锚点

    增强：保留 run 级字体颜色（红色错误），检测异常段落并添加醒目标识
    """
    text = paragraph.text.strip()
    if not text:
        return ''

    level = _is_heading(paragraph)
    if level > 0:
        heading_id = collector.add(level, text)
        # 一级标题添加「返回目录」链接
        back_link = ''
        if level <= 2:
            back_link = '<a href="#report-toc" class="back-to-toc" title="返回目录">↑</a>'
        return f'<h{level} id="{heading_id}">{_escape(text)}{back_link}</h{level}>'

    # 构建 run 级 HTML（保留字体颜色和粗体）
    run_parts = []
    has_red_font = False
    for run in paragraph.runs:
        run_text = _escape(run.text)
        if not run_text:
            continue
        color = None
        try:
            if run.font.color and run.font.color.rgb:
                color = str(run.font.color.rgb)
        except Exception:
            pass
        bold = run.bold if run.bold else False
        styles = []
        if color and color != '000000':
            styles.append(f'color:#{color}')
            if color in ('CC0000', 'cc0000', 'FF0000', 'ff0000', 'C00000', 'c00000'):
                has_red_font = True
        if bold:
            styles.append('font-weight:bold')
        if styles:
            run_parts.append(f'<span style="{";".join(styles)}">{run_text}</span>')
        else:
            run_parts.append(run_text)
    paragraph_html = ''.join(run_parts) if run_parts else _escape(text)

    # 检测是否是粗体段落（如小节标题）
    is_bold = all(run.bold for run in paragraph.runs if run.text.strip()) if paragraph.runs else False

    # 检测异常内容（粗体短段落视为小节标题，跳过关键词扫描避免误报）
    severity, label, _matched_kw = _detect_anomaly(text, is_header=(is_bold and len(text) < 60))

    # 红色字体 = 查询错误，添加醒目的错误框样式
    if has_red_font or (severity == 'critical' and '⚠' in text):
        if anomaly_counter is not None:
            anomaly_counter['critical'] = anomaly_counter.get('critical', 0) + 1
        if collector is not None:
            collector.record_section_anomaly('critical')
        return f'<div class="alert-box alert-critical">{paragraph_html}</div>'

    # 包含 ⚠ / ⚡ / ℹ emoji 的摘要段落
    if '⚠' in text or '⚡' in text:
        if anomaly_counter is not None:
            anomaly_counter['warning'] = anomaly_counter.get('warning', 0) + 1
        if collector is not None:
            collector.record_section_anomaly('warning')
        return f'<div class="alert-box alert-warning">{paragraph_html}</div>'

    # 检测 "无数据" 灰色提示
    if '无数据' in text or '暂无' in text or 'No data' in text.lower():
        return f'<p class="no-data-para">{paragraph_html}</p>'

    # 粗体短段落（小节标题）
    if is_bold and len(text) < 100:
        return f'<p class="bold-para">{paragraph_html}</p>'

    # 关键词检测到的异常（无 emoji 和红色字体，但文本包含异常关键词）
    # 仅对非标题的普通段落应用，避免误报
    if severity == 'critical':
        if anomaly_counter is not None:
            anomaly_counter['critical'] = anomaly_counter.get('critical', 0) + 1
        if collector is not None:
            collector.record_section_anomaly('critical')
        return f'<div class="alert-box alert-critical">{paragraph_html}</div>'

    if severity == 'high_risk':
        if anomaly_counter is not None:
            anomaly_counter['high_risk'] = anomaly_counter.get('high_risk', 0) + 1
        if collector is not None:
            collector.record_section_anomaly('high_risk')
        return f'<div class="alert-box alert-critical">{paragraph_html}</div>'

    if severity in ('warning', 'mid_risk'):
        if anomaly_counter is not None:
            anomaly_counter[severity] = anomaly_counter.get(severity, 0) + 1
        if collector is not None:
            collector.record_section_anomaly(severity)
        return f'<div class="alert-box alert-warning">{paragraph_html}</div>'

    # 普通段落
    return f'<p>{paragraph_html}</p>'


def _table_to_html(table, anomaly_counter=None, collector=None):
    """将表格转换为 HTML，宽表（列数>阈值）添加最大化按钮

    增强：
    - 自动检测异常单元格并高亮（ORA-/错误/警告/风险等级）
    - 异常行始终可见（不参与折叠），并添加行级标识
    - 数据行过多时自动折叠普通行，支持展开/收起
    """
    rows_data = []  # [(row_html, has_anomaly, max_severity), ...]
    col_count = 0
    header_texts = []
    # 严重程度优先级排序
    _severity_order = {'critical': 5, 'high_risk': 4, 'warning': 3, 'mid_risk': 2, 'low_risk': 1}

    # 预读表头，判定是否为基线表并定位结论列
    try:
        header_texts = [_get_cell_text(c).strip() for c in table.rows[0].cells]
    except Exception:
        header_texts = []
    _is_bl = _is_baseline_table(header_texts)
    _bl_status_idx = _find_col(header_texts, _BASELINE_STATUS_HEADERS) if _is_bl else None
    _bl_level_idx = _find_col(header_texts, _BASELINE_LEVEL_HEADERS) if _is_bl else None

    for row_idx, row in enumerate(table.rows):
        cells_html = []
        row_has_anomaly = False
        row_max_severity = None
        row_matched_keywords = []  # 收集本行所有匹配到的关键词
        row_labels = []            # 收集本行所有异常标签
        row_data_texts = []        # 收集本行所有单元格文本（用于 tooltip 预览）
        row_level_text = ''
        if row_idx == 0:
            col_count = len(row.cells)
            header_texts = []
        elif _is_bl and _bl_level_idx is not None:
            _cells = row.cells
            if _bl_level_idx < len(_cells):
                row_level_text = _get_cell_text(_cells[_bl_level_idx]).strip()
        for col_idx, cell in enumerate(row.cells):
            text = _get_cell_text(cell).strip()
            bg_color = _get_cell_bg_color(cell)

            if row_idx == 0:
                # 表头行 — 记录列名用于后续判断风险等级列
                header_texts.append(text)
                escaped_text = _escape(text)
                style = 'class="th-cell"'
                if bg_color:
                    style += f' style="background-color:{bg_color};"'
                cells_html.append(f'<th {style}>{escaped_text}</th>')
            else:
                # 数据行 — 收集文本用于 tooltip
                if text:
                    row_data_texts.append(text)
                # 数据行 — 使用 _get_cell_html 保留字体颜色
                cell_html = _get_cell_html(cell)

                # 检测单元格异常内容（表头行跳过关键词扫描）
                badge_allowed = False
                if _is_bl:
                    # 基线表：只按结论列判定，描述性列（参数/当前值/期望/差距/说明）
                    # 不参与关键词扫描，避免「失败」「风险等级」等描述词误判合规行。
                    if _bl_status_idx is not None:
                        if col_idx == _bl_status_idx:
                            severity = _baseline_status_severity(text, row_level_text)
                            badge_allowed = severity is not None
                        else:
                            severity = None
                        label = _SEVERITY_LABELS.get(severity) if severity else None
                        matched_kw = None
                    elif col_idx == _bl_level_idx:
                        severity = _baseline_level_severity(text)
                        badge_allowed = severity is not None
                        label = _SEVERITY_LABELS.get(severity) if severity else None
                        matched_kw = None
                    else:
                        severity, label, matched_kw = None, None, None
                else:
                    severity, label, matched_kw = _detect_anomaly(text, is_header=False)
                # 收集匹配信息用于 tooltip
                if severity and matched_kw and matched_kw not in row_matched_keywords:
                    row_matched_keywords.append(matched_kw)
                if label and label not in row_labels:
                    row_labels.append(label)
                # 如果该列是风险等级列，增强着色
                col_header = header_texts[col_idx] if col_idx < len(header_texts) else ''
                is_risk_col = any(kw in col_header.lower() for kw in ['风险', '等级', 'severity', 'level', '状态', 'status'])

                style = 'class="td-cell"'
                extra_style = ''

                # 优先使用 DOCX 已有的背景色（如基线检查 PASS/FAIL）
                if bg_color:
                    extra_style = f'background-color:{bg_color};'
                    # 即使有 DOCX 背景色，也检测并计数异常
                    if severity:
                        row_has_anomaly = True
                        if anomaly_counter is not None:
                            anomaly_counter[severity] = anomaly_counter.get(severity, 0) + 1
                        if collector is not None:
                            collector.record_section_anomaly(severity)
                        # 更新行最高严重级别
                        if row_max_severity is None or _severity_order.get(severity, 0) > _severity_order.get(row_max_severity, 0):
                            row_max_severity = severity
                elif severity and (is_risk_col or _is_bl):
                    # 风险等级列 / 基线表结论列：根据严重程度着色
                    extra_style = _get_anomaly_style(severity)
                    row_has_anomaly = True
                    if anomaly_counter is not None:
                        anomaly_counter[severity] = anomaly_counter.get(severity, 0) + 1
                    if collector is not None:
                        collector.record_section_anomaly(severity)
                    if row_max_severity is None or _severity_order.get(severity, 0) > _severity_order.get(row_max_severity, 0):
                        row_max_severity = severity
                elif severity in ('critical', 'high_risk'):
                    # 非 risk 列但包含严重异常：浅红背景
                    extra_style = 'background-color:#fef2f2;'
                    row_has_anomaly = True
                    if anomaly_counter is not None:
                        anomaly_counter[severity] = anomaly_counter.get(severity, 0) + 1
                    if collector is not None:
                        collector.record_section_anomaly(severity)
                    if row_max_severity is None or _severity_order.get(severity, 0) > _severity_order.get(row_max_severity, 0):
                        row_max_severity = severity
                elif severity == 'warning':
                    # 警告级别：浅黄背景
                    extra_style = 'background-color:#fffbeb;'
                    row_has_anomaly = True
                    if anomaly_counter is not None:
                        anomaly_counter[severity] = anomaly_counter.get(severity, 0) + 1
                    if collector is not None:
                        collector.record_section_anomaly(severity)
                    if row_max_severity is None or _severity_order.get(severity, 0) > _severity_order.get(row_max_severity, 0):
                        row_max_severity = severity
                elif severity == 'mid_risk':
                    # 中风险：浅黄背景
                    extra_style = 'background-color:#fffbeb;'
                    row_has_anomaly = True
                    if anomaly_counter is not None:
                        anomaly_counter[severity] = anomaly_counter.get(severity, 0) + 1
                    if collector is not None:
                        collector.record_section_anomaly(severity)
                    if row_max_severity is None or _severity_order.get(severity, 0) > _severity_order.get(row_max_severity, 0):
                        row_max_severity = severity
                elif severity == 'low_risk':
                    # 低风险：浅绿背景
                    extra_style = 'background-color:#f0fdf4;'
                    row_has_anomaly = True
                    if anomaly_counter is not None:
                        anomaly_counter[severity] = anomaly_counter.get(severity, 0) + 1
                    if collector is not None:
                        collector.record_section_anomaly(severity)
                    if row_max_severity is None or _severity_order.get(severity, 0) > _severity_order.get(row_max_severity, 0):
                        row_max_severity = severity

                if extra_style:
                    style = f'class="td-cell" style="{extra_style}"'

                # 为风险等级列 / 基线结论列添加标签
                badge = ''
                if severity and (badge_allowed if _is_bl else is_risk_col):
                    badge = _get_anomaly_badge(severity, label)

                cells_html.append(f'<td {style}>{cell_html}{badge}</td>')

        # 构建行 HTML，异常行添加标识类和行首级别标签
        row_class = ''
        severity_tag = ''
        tooltip_attr = ''
        if row_idx > 0 and row_has_anomaly:
            row_class = f' class="row-anomaly row-anomaly-{row_max_severity} anomaly-tooltip-row"'
            severity_tag = _get_row_severity_tag(row_max_severity)
            # 构建 tooltip
            section_title = collector.current_section_title if collector else None
            row_preview = ' | '.join(row_data_texts[:3]) if row_data_texts else ''
            matched_kw_str = ', '.join(row_matched_keywords) if row_matched_keywords else ''
            label_str = ', '.join(row_labels) if row_labels else ''
            tooltip_text = _build_row_tooltip(
                row_max_severity, label_str, matched_kw_str, section_title, row_preview
            )
            tooltip_attr = f' data-tooltip="{_escape(tooltip_text)}"'

        if row_idx == 0:
            row_html = f'<tr>{"".join(cells_html)}</tr>'
        else:
            # 异常行：在第一个单元格内容前插入级别标签
            if severity_tag and cells_html:
                # 在第一个 td 内部前面插入标签
                first_cell = cells_html[0]
                # 找到 <td ...> 后面的位置
                td_end = first_cell.find('>')
                if td_end > 0:
                    cells_html[0] = first_cell[:td_end + 1] + severity_tag + first_cell[td_end + 1:]
            row_html = f'<tr{row_class}{tooltip_attr}>{"".join(cells_html)}</tr>'

        rows_data.append((row_html, row_has_anomaly, row_max_severity))

    is_wide = col_count > WIDE_TABLE_THRESHOLD

    # ── 行数过多时折叠（异常行始终可见）──
    total_rows = len(rows_data)
    data_rows = total_rows - 1  # 去掉表头
    need_collapse = data_rows > TABLE_ROW_COLLAPSE_THRESHOLD

    if need_collapse:
        header_row = rows_data[0][0] if rows_data else ''
        data_rows_list = rows_data[1:]  # 去掉表头

        # 分离异常行和普通行
        anomaly_rows = [(h, a, s) for h, a, s in data_rows_list if a]
        normal_rows = [(h, a, s) for h, a, s in data_rows_list if not a]

        # 普通行折叠：前 THRESHOLD 个可见，其余折叠
        # 异常行全部放在可见区，且置顶（排在普通行前面）
        visible_normal = normal_rows[:TABLE_ROW_COLLAPSE_THRESHOLD]
        collapsed_normal = normal_rows[TABLE_ROW_COLLAPSE_THRESHOLD:]
        collapsed_count = len(collapsed_normal)

        # 合并可见行：异常行优先置顶 + 普通行
        visible_rows_html = [h for h, _, _ in anomaly_rows] + [h for h, _, _ in visible_normal]
        collapsed_rows_html = [h for h, _, _ in collapsed_normal]

        anomaly_count = len(anomaly_rows)
        collapse_label = f'展开剩余 {collapsed_count} 行'
        if anomaly_count:
            collapse_label += f'（含 {anomaly_count} 行异常已置顶）'

        table_inner = (
            f'<tbody>{header_row}{"".join(visible_rows_html)}</tbody>'
            f'<tbody class="table-collapse-body" style="display:none;">'
            f'{"".join(collapsed_rows_html)}'
            f'</tbody>'
            f'<tbody class="table-collapse-toggle-row">'
            f'<tr><td colspan="{col_count}" class="table-collapse-cell">'
            f'<button class="btn-collapse-rows" onclick="toggleTableRows(this)">'
            f'<span class="collapse-arrow">▶</span> {collapse_label}'
            f'</button></td></tr>'
            f'</tbody>'
        )
    else:
        table_inner = f'<tbody>{"".join(r[0] for r in rows_data)}</tbody>'

    # 表格工具栏：行数/列数信息 + 最大化（所有表格均可最大化，不再只限宽表）
    wide_class = ' wide-table' if is_wide else ''
    row_info = ''
    if need_collapse:
        anomaly_count = sum(1 for _, a, _ in rows_data[1:] if a)
        if anomaly_count:
            row_info = f'<span class="table-info">{data_rows} 行 · {anomaly_count} 行异常已标红</span>'
        else:
            row_info = f'<span class="table-info">{data_rows} 行</span>'
    elif data_rows > 0:
        row_info = f'<span class="table-info">{data_rows} 行</span>'
    else:
        row_info = f'<span class="table-info">{col_count} 列</span>'

    info_bar = (
        '<div class="table-toolbar">'
        f'{row_info}'
        '<button class="btn-maximize" onclick="maximizeContent(this)" '
        'title="最大化查看（Esc 关闭）" aria-label="最大化查看">'
        f'{MAXIMIZE_ICON_SVG}'
        '</button>'
        '</div>'
    )

    return (
        f'<div class="table-wrap{wide_class}">'
        f'{info_bar}'
        f'<table>{table_inner}</table>'
        f'</div>'
    )


def _extract_risk_issues_from_docx(doc):
    """从 DOCX 中提取结构化风险表数据

    扫描所有表格，识别"风险与建议"章节下的风险表（表头包含"风险项"/"Risk Item"），
    将每行数据提取为 {col1, col2, col3, col4, col5} 格式，
    与 smart_analyze 输出格式一致，确保 HTML 报告与 Word 报告使用同一数据源。

    返回:
        list[dict] | None: 风险项列表，未找到时返回 None
    """
    risk_keywords = {'风险项', 'risk item', 'risk_item'}
    issues = []
    found_risk_table = False

    for table in doc.tables:
        if not table.rows:
            continue
        # 检查表头行
        header_cells = table.rows[0].cells
        header_texts = [_get_cell_text(c).strip().lower() for c in header_cells]

        # 判断是否为风险表：表头中包含"风险项"或"Risk Item"
        is_risk_table = any(
            any(kw in ht for kw in risk_keywords)
            for ht in header_texts
        )
        if not is_risk_table:
            continue

        found_risk_table = True
        # 确定各列索引（跳过序号列）
        col_map = {}  # field_name -> col_idx
        for idx, ht in enumerate(header_texts):
            if '序号' in ht or ht in ('no.', 'no', '#', '序'):
                continue  # 跳过序号列
            if '风险项' in ht or 'risk item' in ht:
                col_map['col1'] = idx
            elif '等级' in ht or 'level' in ht:
                col_map['col2'] = idx
            elif '描述' in ht or 'description' in ht or 'desc' in ht:
                col_map['col3'] = idx
            elif '严重' in ht or 'severity' in ht:
                col_map['col4'] = idx
            elif '负责' in ht or 'owner' in ht:
                col_map['col5'] = idx

        # 提取数据行
        for row in table.rows[1:]:
            cells = row.cells
            issue = {}
            for field, col_idx in col_map.items():
                if col_idx < len(cells):
                    issue[field] = _get_cell_text(cells[col_idx]).strip()
                else:
                    issue[field] = ''
            # 确保必要字段存在
            issue.setdefault('col1', '')
            issue.setdefault('col2', '')
            issue.setdefault('col3', '')
            issue.setdefault('col4', '')
            issue.setdefault('col5', '')
            # 跳过空行
            if any(v for v in issue.values()):
                issues.append(issue)

    return issues if found_risk_table else None


def _empty_section_summary():
    """空的目录汇总结构（解析失败/无异常时的统一返回）"""
    return {'sections': [], 'issues': [], 'has_data': False,
            'total': {'critical': 0, 'warning': 0, 'low': 0, 'total': 0}}


def get_section_anomaly_summary(docx_path, analysis_issues=None):
    """汇总报告「巡检目录」中带异常的章节及对应异常数量。

    判定逻辑与报告 HTML 的目录徽章完全一致（复用 _HeadingCollector +
    _RISK_SECTION_MAP），保证通知邮件里的汇总与报告目录标红一致。
    供定时巡检告警邮件等下游复用，不修改报告本身。

    参数:
        docx_path: 巡检报告 .docx 路径
        analysis_issues: 规则引擎风险项列表（smart_analyze 输出）。传 None 时
            回退为从 DOCX 风险表提取（与「分析报告」HTML 附件同源）

    返回:
        dict:
          sections: [{title, depth, level, parent, critical, warning, low, total}]
                    仅含有异常的章节；depth=0 一级章节、1 子章节
          issues:   [{title, level, severity, severity_label, section, suggestion}]
          total:    {critical, warning, low, total}
          has_data: bool — 是否解析到风险项
    """
    if not docx_path or not os.path.isfile(docx_path):
        return _empty_section_summary()

    doc = Document(docx_path)

    # 与 convert_docx_to_html 相同的数据来源优先级：
    # 外部传入规则引擎结果 > DOCX 风险表提取
    if analysis_issues is None:
        analysis_issues = _extract_risk_issues_from_docx(doc)

    collector = _HeadingCollector()
    for para in doc.paragraphs:
        level = _is_heading(para)
        if level:
            text = para.text.strip()
            if text:
                collector.add(level, text)

    collector.apply_analysis_issues(analysis_issues)

    def _bucket(anomalies):
        """severity 统计 → (严重/高风险, 警告/中风险, 低风险/建议)"""
        crit = anomalies.get('critical', 0) + anomalies.get('high_risk', 0)
        warn = anomalies.get('warning', 0) + anomalies.get('mid_risk', 0)
        low = anomalies.get('low_risk', 0)
        return crit, warn, low

    # ── 按报告顺序聚合：一级章节 + 其下子章节 ──
    chapters = []
    for level, text, hid in collector.headings:
        if level <= 1:
            chapters.append({'title': text, 'hid': hid, 'own': {}, 'subs': []})
        else:
            if not chapters:
                # 报告首个标题即为子级：兜底挂到一个匿名章节下，避免异常丢失
                chapters.append({'title': '', 'hid': None, 'own': {}, 'subs': []})
            chapters[-1]['subs'].append(
                {'title': text, 'hid': hid,
                 'own': collector.section_anomalies.get(hid, {})})

    sections = []
    total = {'critical': 0, 'warning': 0, 'low': 0, 'total': 0}
    for ch in chapters:
        # 章节级 = 自身统计 + 所有子节汇总
        agg = dict(collector.section_anomalies.get(ch['hid'], {})) if ch['hid'] else {}
        for sub in ch['subs']:
            for sev, cnt in sub['own'].items():
                agg[sev] = agg.get(sev, 0) + cnt
        crit, warn, low = _bucket(agg)
        if crit or warn or low:
            row = {'title': ch['title'], 'depth': 0, 'level': 1, 'parent': '',
                   'critical': crit, 'warning': warn, 'low': low,
                   'total': crit + warn + low}
            sections.append(row)
            total['critical'] += crit
            total['warning'] += warn
            total['low'] += low
            total['total'] += row['total']
        # 子章节：仅列出自身含异常的（已归入章节级合计，故不重复计入 total）
        for sub in ch['subs']:
            s_crit, s_warn, s_low = _bucket(sub['own'])
            if s_crit or s_warn or s_low:
                sections.append({
                    'title': sub['title'], 'depth': 1, 'level': 2,
                    'parent': ch['title'],
                    'critical': s_crit, 'warning': s_warn, 'low': s_low,
                    'total': s_crit + s_warn + s_low})

    # ── 逐条风险项（含所属章节）──
    title_by_hid = {hid: text for _lv, text, hid in collector.headings}
    issues = []
    for match in collector.issue_matches:
        item = match['issue']
        hid = match['heading_id']
        severity = match.get('severity') or ''
        issues.append({
            'title': str(item.get('col1', '') or ''),
            'level': str(item.get('col2', '') or ''),
            'severity': severity,
            'severity_label': _ROW_SEVERITY_CONFIG.get(severity, {}).get('label', ''),
            'section': title_by_hid.get(hid, '') if hid else '',
            'suggestion': str(item.get('col3', '') or ''),
        })

    return {
        'sections': sections,
        'issues': issues,
        'total': total,
        'has_data': analysis_issues is not None and len(issues) > 0,
    }


def _build_anomaly_banner(counter, analysis_issues=None):
    """构建异常汇总横幅 HTML

    优先使用 analysis_issues（来自 smart_analyze 的结构化分析结果），
    如果没有则回退到 counter（基于关键词扫描的计数）。
    """
    # ── 优先使用结构化分析结果 ──
    if analysis_issues is not None and isinstance(analysis_issues, list):
        critical = 0
        high_risk = 0
        warning = 0
        mid_risk = 0
        low_risk = 0

        for item in analysis_issues:
            if not isinstance(item, dict):
                continue
            level = str(item.get('col2', '')).lower()
            severity = str(item.get('col4', '')).lower()
            if '高' in level or 'critical' in level or '严重' in severity:
                if 'critical' in level or '严重' in severity:
                    critical += 1
                else:
                    high_risk += 1
            elif '中' in level or 'medium' in level:
                mid_risk += 1
            elif '低' in level or 'low' in level:
                low_risk += 1
            elif '建议' in level or 'info' in level:
                low_risk += 1
            else:
                warning += 1

        total = critical + high_risk + warning + mid_risk + low_risk

        if total == 0:
            return '''<div class="anomaly-banner anomaly-ok">
  <span class="anomaly-icon">✅</span>
  <span class="anomaly-text">本次巡检未发现风险项，数据库运行正常</span>
</div>'''

        items = []
        if critical:
            items.append(f'<span class="anomaly-item anomaly-item-critical">🔴 严重: {critical}</span>')
        if high_risk:
            items.append(f'<span class="anomaly-item anomaly-item-high">🟠 高风险: {high_risk}</span>')
        if warning or mid_risk:
            items.append(f'<span class="anomaly-item anomaly-item-warn">🟡 警告: {warning + mid_risk}</span>')
        if low_risk:
            items.append(f'<span class="anomaly-item anomaly-item-low">🟢 低风险: {low_risk}</span>')

        severity = 'critical' if critical or high_risk else 'warning'
        return f'''<div class="anomaly-banner anomaly-{severity}">
  <span class="anomaly-icon">{"🚨" if severity == "critical" else "⚠️"}</span>
  <span class="anomaly-text">双引擎分析发现 <b>{total}</b> 个风险项，请重点关注：</span>
  {"".join(items)}
</div>'''

    # ── 回退：关键词扫描计数 ──
    critical = counter.get('critical', 0)
    high_risk = counter.get('high_risk', 0)
    warning = counter.get('warning', 0)
    mid_risk = counter.get('mid_risk', 0)
    low_risk = counter.get('low_risk', 0)
    total = critical + high_risk + warning + mid_risk + low_risk

    if total == 0:
        return '''<div class="anomaly-banner anomaly-ok">
  <span class="anomaly-icon">✅</span>
  <span class="anomaly-text">本次巡检未发现异常项，数据库运行正常</span>
</div>'''

    items = []
    if critical:
        items.append(f'<span class="anomaly-item anomaly-item-critical">🔴 严重: {critical}</span>')
    if high_risk:
        items.append(f'<span class="anomaly-item anomaly-item-high">🟠 高风险: {high_risk}</span>')
    if warning or mid_risk:
        items.append(f'<span class="anomaly-item anomaly-item-warn">🟡 警告: {warning + mid_risk}</span>')
    if low_risk:
        items.append(f'<span class="anomaly-item anomaly-item-low">🟢 低风险: {low_risk}</span>')

    severity = 'critical' if critical or high_risk else 'warning'
    return f'''<div class="anomaly-banner anomaly-{severity}">
  <span class="anomaly-icon">{"🚨" if severity == "critical" else "⚠️"}</span>
  <span class="anomaly-text">发现 <b>{total}</b> 个异常项，请重点关注：</span>
  {"".join(items)}
</div>'''


def _build_anomaly_rules_panel():
    """构建异常检测规则说明面板 HTML（精简版 — 默认折叠）

    规则详情通过异常行鼠标悬停 tooltip 展示，此处仅保留折叠的规则总览。
    """
    return '''<details class="rules-panel">
  <summary class="rules-panel-header">
    <span class="rules-icon">📐</span>
    <span class="rules-title">异常检测规则说明</span>
    <span class="rules-hint">点击展开/收起</span>
  </summary>
  <div class="rules-panel-body">
    <p class="rules-tip-text">将鼠标悬停在异常行上可查看该行匹配的具体判断规则。</p>

    <div class="rules-section">
      <h4 class="rules-section-title">一、巡检引擎层 — 基于阈值的硬判定（共 24 项巡检）</h4>
      <p class="rules-section-desc">以下巡检项在数据采集阶段即根据预设阈值判定风险等级，结果直接写入报告数据。涵盖表空间、对象状态、告警日志、配置基线、锁/事务、索引、备份、集群等全量巡检维度。</p>
      <table class="rules-table">
        <thead>
          <tr>
            <th>巡检项</th>
            <th>判断规则</th>
            <th>阈值条件</th>
            <th>风险等级</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td rowspan="2">表空间使用率</td>
            <td rowspan="2">使用率 = (当前大小 - 空闲空间) / max(当前大小, 最大可扩展大小) × 100%</td>
            <td>使用率 &gt; 90%</td>
            <td><span class="rule-tag rule-tag-high">高风险</span></td>
          </tr>
          <tr>
            <td>使用率 &gt; 80% 且 ≤ 90%</td>
            <td><span class="rule-tag rule-tag-mid">中风险</span></td>
          </tr>
          <tr>
            <td>无效对象</td>
            <td>统计 STATUS=INVALID 的对象数量</td>
            <td>数量 &gt; 0</td>
            <td><span class="rule-tag rule-tag-mid">中风险</span></td>
          </tr>
          <tr>
            <td>Alert 告警日志</td>
            <td>扫描 alert.log 中的 ORA- 错误</td>
            <td>错误数 &gt; 0</td>
            <td><span class="rule-tag rule-tag-high">高风险</span></td>
          </tr>
          <tr>
            <td>锁定用户</td>
            <td>检查 ACCOUNT_STATUS=LOCKED 的用户</td>
            <td>存在锁定用户</td>
            <td><span class="rule-tag rule-tag-mid">中风险</span></td>
          </tr>
          <tr>
            <td rowspan="3">配置基线检查</td>
            <td rowspan="3">gap_pct = |当前值 - 推荐值| / 推荐值 × 100%（推荐值根据主机内存/CPU/DB大小动态计算）</td>
            <td>gap_pct &gt; 50%</td>
            <td><span class="rule-tag rule-tag-critical">严重</span></td>
          </tr>
          <tr>
            <td>gap_pct &gt; 20% 且 ≤ 50%</td>
            <td><span class="rule-tag rule-tag-mid">中风险</span></td>
          </tr>
          <tr>
            <td>gap_pct ≤ 20%</td>
            <td><span class="rule-tag rule-tag-low">低风险</span></td>
          </tr>
          <tr>
            <td>statistics_level</td>
            <td>Oracle 统计级别模式检查</td>
            <td>BASIC（关闭）</td>
            <td><span class="rule-tag rule-tag-critical">严重</span></td>
          </tr>
          <tr>
            <td>阻塞会话</td>
            <td>检测锁等待中 request &gt; 0 的会话</td>
            <td>存在阻塞会话</td>
            <td><span class="rule-tag rule-tag-high">高风险</span></td>
          </tr>
          <tr>
            <td>死锁检测</td>
            <td>非 Idle 等待且存在锁请求</td>
            <td>存在死锁</td>
            <td><span class="rule-tag rule-tag-critical">严重</span></td>
          </tr>
          <tr>
            <td>长事务</td>
            <td>事务持续时间 &gt; 60 秒</td>
            <td>存在长事务</td>
            <td><span class="rule-tag rule-tag-mid">中风险</span></td>
          </tr>
          <tr>
            <td>作业调度</td>
            <td>检查 failures &gt; 0 或 broken=Y 的作业</td>
            <td>存在失败作业</td>
            <td><span class="rule-tag rule-tag-mid">中风险</span></td>
          </tr>
          <tr>
            <td>长时间运行 SQL</td>
            <td>v$session_longops 中 elapsed_seconds &gt; 30 且未完成的操作</td>
            <td>存在长 SQL</td>
            <td><span class="rule-tag rule-tag-mid">中风险</span></td>
          </tr>
          <tr>
            <td rowspan="3">索引健康分析</td>
            <td rowspan="3">分析缺失索引（高频查询无索引覆盖）、冗余索引（与已有索引前缀重叠）、未使用索引（days_threshold=90 天内无访问）</td>
            <td>缺失索引数 &gt; 0</td>
            <td><span class="rule-tag rule-tag-mid">中风险</span></td>
          </tr>
          <tr>
            <td>冗余索引数 &gt; 0</td>
            <td><span class="rule-tag rule-tag-warn">警告</span></td>
          </tr>
          <tr>
            <td>未使用索引数 &gt; 0</td>
            <td><span class="rule-tag rule-tag-low">低风险</span></td>
          </tr>
          <tr>
            <td rowspan="2">Redo 日志组</td>
            <td rowspan="2">每组 thread 的 redo log group 数量检查</td>
            <td>每组 &lt; 2 组</td>
            <td><span class="rule-tag rule-tag-high">高风险</span></td>
          </tr>
          <tr>
            <td>每组 &lt; 3 组</td>
            <td><span class="rule-tag rule-tag-warn">警告</span></td>
          </tr>
          <tr>
            <td>控制文件</td>
            <td>检查控制文件是否多路复用（存于不同磁盘）</td>
            <td>仅 1 个副本</td>
            <td><span class="rule-tag rule-tag-high">高风险</span></td>
          </tr>
          <tr>
            <td>备份状态</td>
            <td>检查最近 30 天内 RMAN 备份记录</td>
            <td>无备份记录</td>
            <td><span class="rule-tag rule-tag-high">高风险</span></td>
          </tr>
          <tr>
            <td>DataGuard</td>
            <td>检查备库归档日志应用延迟（gap）</td>
            <td>存在 gap 或备库未应用</td>
            <td><span class="rule-tag rule-tag-high">高风险</span></td>
          </tr>
          <tr>
            <td>RAC 集群</td>
            <td>检查 gv$instance 中各节点 STATUS</td>
            <td>存在非 OPEN 状态实例</td>
            <td><span class="rule-tag rule-tag-high">高风险</span></td>
          </tr>
          <tr>
            <td>闪回配置</td>
            <td>检查 v$database.flashback_on</td>
            <td>FLASHBACK_ON=NO</td>
            <td><span class="rule-tag rule-tag-warn">警告</span></td>
          </tr>
          <tr>
            <td rowspan="2">ASM 磁盘组</td>
            <td rowspan="2">v$asm_diskgroup 中 free_mb/total_mb 使用率</td>
            <td>使用率 &gt; 90%</td>
            <td><span class="rule-tag rule-tag-high">高风险</span></td>
          </tr>
          <tr>
            <td>使用率 &gt; 80%</td>
            <td><span class="rule-tag rule-tag-mid">中风险</span></td>
          </tr>
          <tr>
            <td>Undo 表空间</td>
            <td>检查 undo 表空间使用率及 undo_retention 是否满足</td>
            <td>使用率 &gt; 90% 或存在 EXP_UNEXP 块</td>
            <td><span class="rule-tag rule-tag-mid">中风险</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="rules-section">
      <h4 class="rules-section-title">二、报告渲染层 — 基于关键词和样式的辅助识别</h4>
      <p class="rules-section-desc">以下规则在 HTML 报告生成阶段对单元格文本进行二次扫描，补充识别巡检引擎未显式标记的异常内容。</p>
      <table class="rules-table">
        <thead>
          <tr>
            <th>检测类型</th>
            <th>匹配规则</th>
            <th>风险等级</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>ORA 错误</td>
            <td>文本包含 "ORA-" 或 "ORA "（不区分大小写）</td>
            <td><span class="rule-tag rule-tag-critical">严重</span></td>
          </tr>
          <tr>
            <td>严重错误关键词</td>
            <td>文本包含：error / 错误 / 失败 / fail / critical / 严重 / crash / down / offline</td>
            <td><span class="rule-tag rule-tag-critical">严重</span></td>
          </tr>
          <tr>
            <td>高风险关键词</td>
            <td>文本包含：高风险 / high risk</td>
            <td><span class="rule-tag rule-tag-high">高风险</span></td>
          </tr>
          <tr>
            <td>中风险关键词</td>
            <td>文本包含：中风险 / medium risk</td>
            <td><span class="rule-tag rule-tag-mid">中风险</span></td>
          </tr>
          <tr>
            <td>警告关键词</td>
            <td>文本包含：warning / 警告 / warn / 异常 / abnormal / alert / timeout / 超时</td>
            <td><span class="rule-tag rule-tag-warn">警告</span></td>
          </tr>
          <tr>
            <td>低风险关键词</td>
            <td>文本包含：低风险 / low risk / info</td>
            <td><span class="rule-tag rule-tag-low">低风险</span></td>
          </tr>
          <tr>
            <td>红色字体</td>
            <td>DOCX 中 run 字体颜色为红色（CC0000 / FF0000 / C00000）— 通常为查询错误信息</td>
            <td><span class="rule-tag rule-tag-critical">严重</span></td>
          </tr>
          <tr>
            <td>Emoji 摘要段落</td>
            <td>段落包含 ⚠ 或 ⚡ 符号 — 通常为风险摘要行</td>
            <td><span class="rule-tag rule-tag-warn">警告</span></td>
          </tr>
          <tr>
            <td>DOCX 单元格底色</td>
            <td>保留 DOCX 中已有的单元格背景色（如基线检查 PASS/FAIL 着色）</td>
            <td>按底色语义</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="rules-section">
      <h4 class="rules-section-title">三、风险等级与展示样式对照</h4>
      <div class="rules-legend">
        <div class="rules-legend-item">
          <span class="rule-tag rule-tag-critical">严重</span>
          <span class="rules-legend-desc">深红背景 + 红色左边框，需立即处理</span>
        </div>
        <div class="rules-legend-item">
          <span class="rule-tag rule-tag-high">高风险</span>
          <span class="rules-legend-desc">深橙背景 + 橙色左边框，建议尽快处理</span>
        </div>
        <div class="rules-legend-item">
          <span class="rule-tag rule-tag-mid">中风险</span>
          <span class="rules-legend-desc">深黄背景 + 黄色左边框，建议关注</span>
        </div>
        <div class="rules-legend-item">
          <span class="rule-tag rule-tag-warn">警告</span>
          <span class="rules-legend-desc">深黄背景 + 黄色左边框，建议排查</span>
        </div>
        <div class="rules-legend-item">
          <span class="rule-tag rule-tag-low">低风险</span>
          <span class="rules-legend-desc">浅绿背景 + 绿色左边框，信息性提示</span>
        </div>
      </div>
    </div>

  </div>
</details>'''


def _build_analysis_panel(analysis_issues):
    """构建规则引擎分析结果面板 HTML

    将 smart_analyze 产出的结构化风险项以卡片形式展示，按严重程度分组，
    每张卡片包含：序号、风险项名称、风险等级标签、详细描述、负责人、可展开的修复SQL。
    无风险时显示"未发现异常"绿色提示面板。

    参数:
        analysis_issues: list[dict] | None — smart_analyze 输出的风险项列表

    返回:
        str: HTML 字符串
    """
    # ── 无数据时显示"未发现异常"提示 ──
    if not analysis_issues or not isinstance(analysis_issues, list) or not analysis_issues:
        return '''<div class="analysis-panel">
  <div class="analysis-panel-header" style="background:linear-gradient(135deg,#15803d,#22c55e)">
    <span class="analysis-panel-icon">✅</span>
    <span class="analysis-panel-title">规则引擎分析结果</span>
    <span class="analysis-panel-count">0 项异常</span>
  </div>
  <div class="analysis-panel-body" style="padding:24px;text-align:center">
    <div style="font-size:48px;margin-bottom:8px">🟢</div>
    <div style="font-size:15px;color:#15803d;font-weight:600">规则引擎未发现异常风险项</div>
    <div style="font-size:12px;color:#666;margin-top:4px">所有巡检指标均在正常范围内</div>
  </div>
</div>'''

    # ── 按严重程度分组 ──
    groups = {'critical': [], 'high': [], 'medium': [], 'low': [], 'info': []}
    for item in analysis_issues:
        if not isinstance(item, dict):
            continue
        level = str(item.get('col2', '')).lower()
        severity = str(item.get('col4', '')).lower()
        if '高' in level and ('严重' in severity or 'critical' in severity):
            groups['critical'].append(item)
        elif '高' in level:
            groups['high'].append(item)
        elif '中' in level:
            groups['medium'].append(item)
        elif '低' in level:
            groups['low'].append(item)
        elif '建议' in level or '信息' in level or 'info' in level:
            groups['info'].append(item)
        else:
            groups['medium'].append(item)

    total = sum(len(g) for g in groups.values())
    if total == 0:
        return '''<div class="analysis-panel">
  <div class="analysis-panel-header" style="background:linear-gradient(135deg,#15803d,#22c55e)">
    <span class="analysis-panel-icon">✅</span>
    <span class="analysis-panel-title">规则引擎分析结果</span>
    <span class="analysis-panel-count">0 项异常</span>
  </div>
  <div class="analysis-panel-body" style="padding:24px;text-align:center">
    <div style="font-size:48px;margin-bottom:8px">🟢</div>
    <div style="font-size:15px;color:#15803d;font-weight:600">规则引擎未发现异常风险项</div>
    <div style="font-size:12px;color:#666;margin-top:4px">所有巡检指标均在正常范围内</div>
  </div>
</div>'''

    # ── 构建分组HTML ──
    group_configs = [
        ('critical', '严重风险', '#ef4444', '#fef2f2', '🔴'),
        ('high', '高风险', '#f97316', '#fff7ed', '🟠'),
        ('medium', '中风险', '#f59e0b', '#fffbeb', '🟡'),
        ('low', '低风险', '#22c55e', '#f0fdf4', '🟢'),
        ('info', '信息提示', '#3b82f6', '#eff6ff', '🔵'),
    ]

    risk_idx = 0  # 全局序号
    group_html_parts = []
    for key, label, color, bg, icon in group_configs:
        items = groups[key]
        if not items:
            continue

        cards_html = []
        for item in items:
            risk_idx += 1
            name = _escape(str(item.get('col1', '')))
            desc = _escape(str(item.get('col3', '')))
            owner = _escape(str(item.get('col5', '')))
            level_text = _escape(str(item.get('col2', '')))
            fix_sql = str(item.get('fix_sql', '')).strip()

            # 构建修复SQL区域（可折叠 + 复制按钮）
            fix_sql_html = ''
            if fix_sql:
                escaped_sql = _escape(fix_sql)
                # 使用 data 属性存储原始 SQL 供 JS 复制
                fix_sql_html = f'''<div class="analysis-card-fix">
  <details class="fix-sql-details">
    <summary class="fix-sql-summary">📝 修复建议SQL（点击展开）</summary>
    <div class="fix-sql-wrapper">
      <pre class="fix-sql-code">{escaped_sql}</pre>
      <button class="fix-sql-copy-btn" onclick="fixCopySql(this)" title="复制 SQL" aria-label="复制 SQL"><svg class="ic-copy" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg><svg class="ic-check" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></button>
    </div>
  </details>
</div>'''

            cards_html.append(f'''<div class="analysis-card" style="border-left-color:{color};background:{bg}">
  <div class="analysis-card-header">
    <span class="analysis-card-idx" style="background:{color}">#{risk_idx}</span>
    <span class="analysis-card-name">{name}</span>
    <span class="analysis-card-level-tag" style="background:{color}">{level_text}</span>
    <span class="analysis-card-owner">👤 {owner}</span>
  </div>
  <div class="analysis-card-desc">{desc}</div>
  {fix_sql_html}
</div>''')

        group_html_parts.append(f'''<div class="analysis-group">
  <div class="analysis-group-title" style="color:{color};border-bottom-color:{color}40">
    <span class="analysis-group-badge" style="background:{color}">{len(items)}</span>
    {icon} {label}
  </div>
  {''.join(cards_html)}
</div>''')

    groups_html = '\n'.join(group_html_parts)

    # 统计摘要 + 健康评估
    summary_parts = []
    for key, label, color, _, icon in group_configs:
        cnt = len(groups[key])
        if cnt:
            summary_parts.append(f'<span class="analysis-summary-tag" style="background:{color}">{icon} {label} {cnt}</span>')
    summary_html = ' '.join(summary_parts)

    # 健康评估文字
    critical_cnt = len(groups['critical'])
    high_cnt = len(groups['high'])
    if critical_cnt > 0:
        health_text = f'⚠️ 存在 {critical_cnt} 项严重风险，建议立即处理'
        health_color = '#ef4444'
    elif high_cnt > 0:
        health_text = f'⚠️ 存在 {high_cnt} 项高风险，建议尽快处理'
        health_color = '#f97316'
    elif len(groups['medium']) > 0:
        health_text = f'ℹ️ 存在 {len(groups["medium"])} 项中风险，建议关注'
        health_color = '#f59e0b'
    else:
        health_text = '✅ 仅存在低风险/信息提示项'
        health_color = '#22c55e'

    return f'''<div class="analysis-panel">
  <div class="analysis-panel-header">
    <span class="analysis-panel-icon">🔍</span>
    <span class="analysis-panel-title">规则引擎分析结果</span>
    <span class="analysis-panel-count">共 {total} 项</span>
    <button class="analysis-panel-toggle" onclick="var b=this.closest('.analysis-panel').querySelector('.analysis-panel-body');var c=this.closest('.analysis-panel').querySelector('.analysis-panel-summary');if(b.style.display==='none'){{b.style.display='block';c.style.display='flex';this.textContent='▼ 收起'}}else{{b.style.display='none';c.style.display='none';this.textContent='▶ 展开'}}">▼ 收起</button>
  </div>
  <div class="analysis-panel-summary">
    {summary_html}
    <span class="analysis-health-text" style="color:{health_color}">{health_text}</span>
  </div>
  <div class="analysis-panel-body">
{groups_html}
  </div>
</div>'''


# ── 章节内异常项提示块 ──
# 严重程度 → (标签底色, 回退标签文字)
_SECTION_SEVERITY_STYLE = {
    'critical': ('#ef4444', '严重'),
    'high_risk': ('#f97316', '高风险'),
    'warning': ('#f59e0b', '警告'),
    'mid_risk': ('#f59e0b', '中风险'),
    'low_risk': ('#22c55e', '低风险'),
}


def _build_section_anomaly_callout(items, label='本节异常项'):
    """构建章节内异常项提示块，明确列出该章节下哪些项异常。

    items: [(issue_dict, severity), ...] — 归属到该章节的规则引擎风险项
    """
    if not items:
        return ''
    rows = []
    for issue, severity in items:
        name = _escape(str(issue.get('col1', '') or ''))
        level_text = _escape(str(issue.get('col2', '') or ''))
        desc = _escape(str(issue.get('col3', '') or ''))
        color, fallback_label = _SECTION_SEVERITY_STYLE.get(severity, ('#f59e0b', '风险'))
        tag_text = level_text or fallback_label
        rows.append(
            f'<div class="section-anomaly-item">'
            f'<span class="section-anomaly-level" style="background:{color}">{tag_text}</span>'
            f'<span class="section-anomaly-name">{name}</span>'
            f'<span class="section-anomaly-desc">{desc}</span>'
            f'</div>'
        )
    return (
        f'<div class="section-anomaly-callout">'
        f'<div class="section-anomaly-callout-title">'
        f'<span>⚠️ {_escape(label)}</span>'
        f'<span class="section-anomaly-callout-count">{len(items)}</span>'
        f'</div>'
        f'{"".join(rows)}'
        f'</div>'
    )


def _inject_section_anomaly_callouts(body_html, collector):
    """在各章节标题后注入异常项提示块，使正文内容与左侧目录徽章保持一致。

    目录徽章来自规则引擎风险项（apply_analysis_issues），而正文原有的行级标红
    来自关键词扫描，两者数据源不同，会出现"目录标红但正文无标记"。
    这里把规则引擎风险项按章节归属回写到正文标题下，保证点开任意带徽章的目录项
    都能在右侧明确看到是哪些项异常。

    - 子章节标题：展示直接归属到该节的异常项
    - 一级章节标题：展示自身 + 所有子章节的异常项（与目录章节级徽章的聚合口径一致）
    """
    matches = getattr(collector, 'issue_matches', None) or []
    if not matches:
        return body_html

    # 建立子章节 → 一级章节 的归属关系
    parent_of = {}
    chapter_hids = set()
    current_parent = None
    for level, _text, hid in collector.headings:
        if level < 2:
            current_parent = hid
            chapter_hids.add(hid)
        else:
            parent_of[hid] = current_parent

    # 直接归属：heading_id → [(issue, severity)]
    direct = {}
    for m in matches:
        hid = m.get('heading_id')
        if not hid:
            continue
        direct.setdefault(hid, []).append((m.get('issue', {}) or {}, m.get('severity', '')))

    if not direct:
        return body_html

    # 章节级聚合：一级章节汇总其所有子章节的直接异常（与目录章节徽章口径一致）
    agg = {}
    for hid, items in direct.items():
        parent = parent_of.get(hid)
        if parent:
            agg.setdefault(parent, []).extend(items)

    for hid, items in agg.items():
        direct.setdefault(hid, []).extend(items)

    for hid, items in direct.items():
        label = '本章异常项' if hid in chapter_hids else '本节异常项'
        callout = _build_section_anomaly_callout(items, label=label)
        if not callout:
            continue
        pattern = re.compile(r'(<h[1-6] id="' + re.escape(hid) + r'">.*?</h[1-6]>)', re.S)
        body_html = pattern.sub(lambda mo: mo.group(1) + callout, body_html, count=1)

    return body_html


def _extract_report_title(doc, docx_path=''):
    """提取报告封面主标题，体现有效信息。

    优先级：
    1) 封面主标题段落（居中 + 加粗 + 字号>=16pt，如「Oracle 数据库健康巡检报告」）；
    2) 含「巡检报告 / 健康巡检」关键词的靠前段落；
    3) 第一个 Heading 标题；
    4) 文件名（去掉扩展名）。
    """
    # 1) 封面主标题
    for p in doc.paragraphs[:20]:
        text = p.text.strip()
        if not text:
            continue
        try:
            centered = (p.alignment == 1)  # WD_ALIGN_PARAGRAPH.CENTER == 1
        except Exception:
            centered = False
        big_bold = any(r.bold and (r.font.size is not None and r.font.size.pt >= 16)
                       for r in p.runs)
        if centered and big_bold:
            return text
    # 2) 关键词兜底
    for p in doc.paragraphs[:20]:
        text = p.text.strip()
        if text and ('巡检报告' in text or '健康巡检' in text or 'Inspection Report' in text):
            return text
    # 3) 第一个 Heading
    for p in doc.paragraphs:
        if _is_heading(p) and p.text.strip():
            return p.text.strip()
    # 4) 文件名
    if docx_path:
        return os.path.splitext(os.path.basename(docx_path))[0]
    return '巡检报告'


def _extract_cover_meta(doc):
    """尽力从封面信息表提取关键字段，返回 dict（键: server/instance/result/inspector/
    gen_time/db_type/db_name）。取不到时为空，不影响主流程。"""
    labels = {
        '服务器地址': 'server', '实例启动时间': 'instance_start', '巡检结果': 'result',
        '巡检人员': 'inspector', '报告生成时间': 'gen_time', '数据库类型': 'db_type',
        '数据库名称': 'db_name', '实例名': 'instance',
    }
    meta = {}
    for table in doc.tables[:3]:
        for row in table.rows:
            if len(row.cells) < 2:
                continue
            k = row.cells[0].text.strip()
            v = row.cells[1].text.strip()
            if k in labels and v:
                meta.setdefault(labels[k], v)
        if meta:
            break
    return meta


def convert_docx_to_html(docx_path, analysis_issues=None):
    """
    将 DOCX 文件转换为 HTML 字符串

    参数:
        docx_path: .docx 文件路径
        analysis_issues: list[dict] | None — 外部传入的规则引擎分析结果
            （来自 smart_analyze，含 fix_sql），优先于 DOCX 风险表提取

    返回:
        str: 完整的 HTML 文档字符串
    """
    if not os.path.isfile(docx_path):
        raise FileNotFoundError(f'文件不存在: {docx_path}')

    doc = Document(docx_path)

    # 提取报告标题：优先封面主标题（体现有效信息），回退 Heading / 文件名
    report_title = _extract_report_title(doc, docx_path)
    # 封面信息（服务器/实例/巡检结果/生成时间等，尽力而为）
    cover_meta = _extract_cover_meta(doc)
    from datetime import datetime as _dt
    gen_time = cover_meta.get('gen_time') or _dt.now().strftime('%Y-%m-%d %H:%M:%S')
    server_info = cover_meta.get('server', '') or cover_meta.get('db_name', '')
    result_info = cover_meta.get('result', '')

    # 标题收集器
    collector = _HeadingCollector()

    # 异常计数器
    anomaly_counter = {}

    # 按文档顺序遍历段落和表格
    body_parts = []

    # 使用 body 的 XML 子元素来保持顺序
    body = doc.element.body
    para_idx = 0
    table_idx = 0
    paragraphs = doc.paragraphs
    tables = doc.tables

    for child in body:
        tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
        if tag == 'p':
            if para_idx < len(paragraphs):
                html_part = _paragraph_to_html(paragraphs[para_idx], collector, anomaly_counter)
                if html_part:
                    body_parts.append(html_part)
                para_idx += 1
        elif tag == 'tbl':
            if table_idx < len(tables):
                html_part = _table_to_html(tables[table_idx], anomaly_counter, collector)
                if html_part:
                    body_parts.append(html_part)
                table_idx += 1

    body_html = '\n'.join(body_parts)

    # 解析规则引擎分析结果：只有外部未传入(None)时才从 DOCX 风险表提取
    # 空列表表示规则引擎已运行但未发现风险，不应回退到 DOCX 提取
    if analysis_issues is None:
        analysis_issues = _extract_risk_issues_from_docx(doc)

    # 用规则引擎结果覆盖关键词扫描的目录异常徽章
    # 只有规则引擎判定为风险的项才在目录中标红
    collector.apply_analysis_issues(analysis_issues)

    # 把规则引擎风险项按章节归属注入正文标题下，使右侧内容与目录徽章一致
    # （修复：目录有异常徽章、点开后正文却看不到是哪些项异常）
    body_html = _inject_section_anomaly_callouts(body_html, collector)

    # 构建目录（此时 section_anomalies 已对齐规则引擎结果）
    toc_html = collector.build_toc_html()

    # 构建异常汇总横幅（优先使用规则引擎结果）
    anomaly_banner = _build_anomaly_banner(anomaly_counter, analysis_issues=analysis_issues)

    # 构建规则引擎分析结果面板（展示每个风险项的详情）
    analysis_panel = _build_analysis_panel(analysis_issues)

    # 构建异常检测规则说明面板
    anomaly_rules = _build_anomaly_rules_panel()

    # 统计信息
    heading_count = len(collector.headings)
    table_count = table_idx

    # 头部元信息（体现有效信息：服务器 / 巡检结果 / 生成时间 / 规模）
    meta_bits = []
    if server_info:
        meta_bits.append(f'服务器：{_escape(server_info)}')
    if result_info:
        meta_bits.append(f'巡检结果：{_escape(result_info)}')
    meta_bits.append(f'生成时间：{_escape(gen_time)}')
    meta_bits.append(f'{heading_count} 章节 · {table_count} 表格')
    report_meta_line = '&nbsp;·&nbsp;'.join(meta_bits)

    # 构建完整 HTML 文档
    html_doc = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{_escape(report_title)} · {_escape(gen_time)}</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
    font-family: "Microsoft YaHei", "微软雅黑", "Segoe UI", Roboto, sans-serif;
    background: #f5f7fa;
    color: #333;
    line-height: 1.6;
    padding: 20px;
  }}
  .report-container {{
    max-width: 1400px;
    margin: 0 auto;
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    padding: 32px 40px;
  }}
  .report-header {{
    text-align: center;
    padding: 20px 0 30px;
    border-bottom: 2px solid #336699;
    margin-bottom: 24px;
  }}
  .report-header h1 {{
    color: #336699;
    font-size: 26px;
    font-weight: 700;
  }}
  .report-meta {{
    color: #888;
    font-size: 13px;
    margin-top: 8px;
  }}

  /* ── 目录导航 ── */
  .report-toc {{
    background: linear-gradient(135deg, #f0f6ff, #e8f0fe);
    border: 1px solid #c8d8f0;
    border-radius: 10px;
    padding: 18px 24px;
    margin-bottom: 28px;
    scroll-margin-top: 20px;
  }}
  .toc-header {{
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1px dashed #b0c8e8;
  }}
  .toc-icon {{ font-size: 18px; }}
  .toc-title {{
    font-size: 16px;
    font-weight: 700;
    color: #003366;
  }}
  .toc-count {{
    font-size: 12px;
    color: #6699cc;
    flex: 1;
  }}
  /* ── 目录异常徽章 ── */
  .toc-badge {{
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    margin-left: 4px;
    vertical-align: middle;
    flex-shrink: 0;
  }}
  .toc-badge-critical {{
    background: #ef4444;
    color: #fff;
    box-shadow: 0 1px 3px rgba(239,68,68,0.4);
  }}
  .toc-badge-warning {{
    background: #f59e0b;
    color: #fff;
    box-shadow: 0 1px 3px rgba(245,158,11,0.4);
  }}
  .toc-badge-low {{
    background: #22c55e;
    color: #fff;
    box-shadow: 0 1px 3px rgba(34,197,94,0.4);
  }}

  /* ── 返回目录链接 ── */
  .back-to-toc {{
    display: inline-block;
    margin-left: 10px;
    font-size: 12px;
    color: #888;
    text-decoration: none;
    vertical-align: middle;
    opacity: 0.5;
    transition: opacity 0.2s;
  }}
  .back-to-toc:hover {{ opacity: 1; color: #336699; }}

  /* ── 浮动返回顶部按钮 ── */
  .float-top {{
    position: fixed;
    bottom: 30px;
    right: 30px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: #336699;
    color: #fff;
    border: none;
    font-size: 20px;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.25);
    opacity: 0;
    visibility: hidden;
    transition: all 0.3s;
    z-index: 100;
  }}
  .float-top.visible {{ opacity: 1; visibility: visible; }}
  .float-top:hover {{ background: #004080; transform: translateY(-2px); }}

  /* ── 异常项导航浮球（位于巡检目录栏底部，sticky 固定，支持上一个/下一个异常项）── */
  .anomaly-nav-float {{
    position: sticky;
    bottom: 0;
    flex-shrink: 0;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 10px 14px;
    margin-top: auto;
    background: #fff;
    border-top: 1px solid #d0d8e8;
    border-radius: 0 0 10px 10px;
    box-shadow: 0 -2px 8px rgba(51,102,153,0.08);
    z-index: 50;
  }}
  /* 侧栏收起时隐藏浮球 */
  .report-layout.sidebar-collapsed .anomaly-nav-float {{
    display: none;
  }}
  /* ── 异常章节导航（目录栏底部）：纯图标幽灵片，白底 + 异常红图标，悬停填充 ── */
  .anomaly-nav-btn {{
    width: 30px;
    height: 30px;
    padding: 0;
    border-radius: 8px;
    background: #fff;
    color: #dc2626;
    border: 1px solid #f3c9c9;
    box-shadow: 0 1px 4px rgba(15,23,42,0.10);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background .15s, color .15s, border-color .15s;
  }}
  .anomaly-nav-btn svg {{ width: 16px; height: 16px; display: block; }}
  .anomaly-nav-btn:hover {{ background: #dc2626; border-color: #dc2626; color: #fff; }}
  .anomaly-nav-btn:active {{ transform: translateY(1px); }}
  .anomaly-nav-btn:disabled {{
    background: #f1f5f9;
    border-color: #e2e8f0;
    color: #94a3b8;
    cursor: not-allowed;
    box-shadow: none;
    transform: none;
  }}
  .anomaly-nav-count {{
    background: #fef2f2;
    color: #b91c1c;
    font-size: 12px;
    font-weight: 700;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid #f3c9c9;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }}
  /* 异常导航当前定位到的章节：目录里持续标记（左侧红色标记条） */
  .toc-node-active > .toc-row-ch {{
    background: #fef2f2;
    box-shadow: inset 3px 0 0 #dc2626;
  }}
  .toc-node-active > .toc-row-ch .toc-link-ch {{ color: #b91c1c; }}

  /* ── 段落样式 ── */
  p {{
    font-size: 14px;
    margin-bottom: 10px;
    word-break: break-all;
  }}
  p.bold-para {{
    font-weight: 700;
    color: #003366;
    font-size: 14px;
    margin-top: 16px;
  }}

  /* ── 标题样式 ── */
  h1 {{ font-size: 22px; color: #336699; margin: 24px 0 14px; font-weight: 700; scroll-margin-top: 20px; }}
  h2 {{ font-size: 18px; color: #336699; margin: 22px 0 12px; font-weight: 700; border-left: 4px solid #336699; padding-left: 10px; scroll-margin-top: 20px; }}
  h3 {{ font-size: 16px; color: #004080; margin: 18px 0 10px; font-weight: 700; scroll-margin-top: 20px; }}
  h4 {{ font-size: 15px; color: #004080; margin: 16px 0 8px; font-weight: 700; scroll-margin-top: 20px; }}
  h5 {{ font-size: 14px; color: #333; margin: 14px 0 8px; font-weight: 700; }}
  h6 {{ font-size: 13px; color: #333; margin: 12px 0 6px; font-weight: 700; }}

  /* ── 表格样式（核心：单元格不换行） ── */
  .table-wrap {{
    overflow-x: auto;
    margin: 12px 0 20px;
    border-radius: 6px;
    border: 1px solid #e0e0e0;
    position: relative;
  }}
  .table-wrap.wide-table {{
    border-color: #a0c0e8;
    box-shadow: 0 1px 6px rgba(51,102,153,0.1);
  }}
  table {{
    border-collapse: collapse;
    width: 100%;
    font-size: 13px;
  }}
  th, td {{
    border: 1px solid #d0d0d0;
    padding: 8px 14px;
    text-align: left;
    /* 关键：单元格内容单行显示，不换行 */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 600px;
  }}
  /* 表头样式 */
  th.th-cell {{
    color: #fff;
    font-weight: 700;
    text-align: center;
    background-color: #336699 !important;
    position: sticky;
    top: 0;
    z-index: 1;
  }}
  /* 数据单元格 */
  td.td-cell {{
    color: #333;
  }}
  /* 隔行变色 */
  tbody tr:nth-child(even) {{
    background-color: #f8fafd;
  }}
  tbody tr:hover {{
    background-color: #e8f0fe;
  }}

  /* ── 行级异常标识（整行高亮 + 加粗左边框 + 行首级别标签）── */
  tr.row-anomaly {{
    position: relative;
  }}
  tr.row-anomaly > td {{
    border-left: none;
  }}
  tr.row-anomaly > td:first-child {{
    border-left: 6px solid transparent;
    position: relative;
  }}
  /* 行首级别标签 */
  .row-severity-tag {{
    vertical-align: middle;
  }}
  /* 严重异常行 — 深红 */
  tr.row-anomaly-critical {{
    background-color: #fee2e2 !important;
  }}
  tr.row-anomaly-critical > td:first-child {{
    border-left-color: #dc2626;
  }}
  /* 高风险行 — 深橙 */
  tr.row-anomaly-high_risk {{
    background-color: #fed7aa !important;
  }}
  tr.row-anomaly-high_risk > td:first-child {{
    border-left-color: #ea580c;
  }}
  /* 警告行 — 深黄 */
  tr.row-anomaly-warning {{
    background-color: #fef3c7 !important;
  }}
  tr.row-anomaly-warning > td:first-child {{
    border-left-color: #d97706;
  }}
  /* 中风险行 — 深黄 */
  tr.row-anomaly-mid_risk {{
    background-color: #fef3c7 !important;
  }}
  tr.row-anomaly-mid_risk > td:first-child {{
    border-left-color: #d97706;
  }}
  /* 低风险行 — 深绿 */
  tr.row-anomaly-low_risk {{
    background-color: #d1fae5 !important;
  }}
  tr.row-anomaly-low_risk > td:first-child {{
    border-left-color: #16a34a;
  }}
  /* 异常行 hover 效果增强 */
  tr.row-anomaly:hover {{
    filter: brightness(0.95);
  }}
  /* 定位闪烁：从目录异常导航跳转时，给目标章节标题一次高亮（异常行同样复用） */
  .anomaly-flash {{
    animation: anomalyFlash 0.6s ease-in-out 3;
    border-radius: 4px;
  }}
  @keyframes anomalyFlash {{
    0% {{ background-color: inherit; }}
    50% {{ background-color: #fef08a; box-shadow: 0 0 12px rgba(250, 204, 21, 0.6); }}
    100% {{ background-color: inherit; }}
  }}

  /* ── 章节内异常项提示块（正文明确列出"本节哪些项异常"，与目录徽章同源）── */
  .section-anomaly-callout {{
    margin: 10px 0 16px;
    border: 1px solid #fecaca;
    border-left: 4px solid #ef4444;
    background: #fff5f5;
    border-radius: 8px;
    padding: 10px 14px;
  }}
  .section-anomaly-callout-title {{
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 700;
    color: #b91c1c;
    margin-bottom: 6px;
  }}
  .section-anomaly-callout-count {{
    background: #ef4444;
    color: #fff;
    border-radius: 9px;
    padding: 0 7px;
    font-size: 11px;
    line-height: 18px;
    font-weight: 700;
  }}
  .section-anomaly-item {{
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 0;
    border-top: 1px dashed #f3d0d0;
    font-size: 12.5px;
    line-height: 1.6;
  }}
  .section-anomaly-item:first-of-type {{ border-top: none; }}
  .section-anomaly-level {{
    flex-shrink: 0;
    color: #fff;
    border-radius: 4px;
    padding: 1px 7px;
    font-size: 11px;
    font-weight: 700;
    white-space: nowrap;
  }}
  .section-anomaly-name {{
    font-weight: 700;
    color: #7f1d1d;
    flex-shrink: 0;
  }}
  .section-anomaly-desc {{ color: #555; }}

  /* ── 宽表工具栏 ── */
  .table-toolbar {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: #f0f6ff;
    border-bottom: 1px solid #d0e0f0;
    border-radius: 6px 6px 0 0;
  }}
  .table-info {{
    font-size: 12px;
    color: #6699cc;
    font-weight: 600;
  }}
  /* ── 最大化入口（纯图标 · 右上角 · 幽灵态，文字信息由 tooltip 承载）──
     图标统一用内联 SVG 四角外扩括号；白色底片保证在任何背景（含深色横幅）上都可读 */
  .btn-maximize {{
    flex-shrink: 0;
    width: 26px;
    height: 26px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #fff;
    border: 1px solid #c8d8f0;
    border-radius: 6px;
    color: #336699;
    cursor: pointer;
    transition: background .15s, border-color .15s, color .15s;
  }}
  .btn-maximize:hover {{ background: #336699; border-color: #336699; color: #fff; }}
  .btn-maximize:active {{ transform: translateY(1px); }}
  .btn-maximize svg, .maximize-fab svg {{ width: 15px; height: 15px; display: block; }}

  /* ── 内容块悬浮最大化按钮（表格以外的块：面板 / 提示框 / SQL / 长文本）── */
  .has-maximize {{ position: relative; }}
  .maximize-fab {{
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 6;
    width: 26px;
    height: 26px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255,255,255,0.94);
    border: 1px solid #cfdaea;
    border-radius: 6px;
    color: #336699;
    cursor: pointer;
    box-shadow: 0 1px 4px rgba(15,23,42,0.12);
    opacity: 0;
    pointer-events: none;
    transition: opacity .15s, background .15s, border-color .15s, color .15s;
  }}
  .has-maximize:hover > .maximize-fab,
  .has-maximize:focus-within > .maximize-fab {{ opacity: 1; pointer-events: auto; }}
  .maximize-fab:hover {{ background: #336699; border-color: #336699; color: #fff; }}
  .maximize-fab:active {{ transform: translateY(1px); }}
  /* <details> 块内的按钮：注入到 summary 中，常驻可见并靠右 */
  .maximize-fab-inline {{
    position: static;
    margin-left: auto;
    width: 24px;
    height: 24px;
    opacity: 0.9;
    pointer-events: auto;
  }}
  .maximize-fab-inline:hover {{ opacity: 1; }}
  /* 修复建议 SQL 的 summary 原为纯文本，改为 flex 以便按钮靠右 */
  .fix-sql-summary {{
    display: flex;
    align-items: center;
    gap: 8px;
  }}

  /* ── 弹窗内的通用内容容器（非表格内容）── */
  .modal-content-wrap {{
    flex: 1;
    overflow: auto;
    padding: 20px 24px;
    font-size: 14px;
    line-height: 1.75;
    color: #2b3d4f;
  }}
  .modal-content-wrap .maximize-fab {{ display: none !important; }}
  .modal-content-wrap pre {{
    white-space: pre-wrap;
    word-break: break-word;
    max-width: 100%;
  }}
  /* 弹窗内若含表格，保持可读（表头仍 sticky，与表格模式一致） */
  .modal-content-wrap table {{ font-size: 13px; min-width: 100%; }}
  .modal-content-wrap th, .modal-content-wrap td {{
    white-space: nowrap;
    padding: 8px 18px;
  }}
  .modal-content-wrap thead th {{
    position: sticky;
    top: 0;
    z-index: 2;
    background-color: #336699 !important;
  }}

  /* ── 表格行折叠 ── */
  .table-collapse-body {{
    /* 折叠的行默认隐藏 */
  }}
  .table-collapse-toggle-row {{
    border-top: 2px dashed #d0d8e8;
  }}
  .table-collapse-cell {{
    text-align: center !important;
    padding: 8px 14px !important;
    background: #f8fafd;
    white-space: normal !important;
  }}
  .btn-collapse-rows {{
    background: #e8f0fe;
    color: #336699;
    border: 1px solid #c0d0e8;
    border-radius: 6px;
    padding: 5px 18px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    transition: all 0.2s;
  }}
  .btn-collapse-rows:hover {{
    background: #336699;
    color: #fff;
    border-color: #336699;
  }}
  .btn-collapse-rows .collapse-arrow {{
    display: inline-block;
    font-size: 10px;
    transition: transform 0.2s;
  }}
  .btn-collapse-rows.expanded .collapse-arrow {{
    transform: rotate(90deg);
  }}

  /* ── 最大化弹窗 ── */
  .table-modal {{
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6);
    z-index: 1000;
    justify-content: center;
    align-items: center;
    backdrop-filter: blur(2px);
  }}
  .table-modal.active {{
    display: flex;
  }}
  .modal-content {{
    background: #fff;
    border-radius: 12px;
    width: 95vw;
    max-width: 1800px;
    height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  }}
  .modal-header {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 24px;
    border-bottom: 1px solid #e0e0e0;
    flex-shrink: 0;
  }}
  .modal-title {{
    font-size: 16px;
    font-weight: 700;
    color: #003366;
  }}
  .modal-close {{
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #fff;
    color: #b91c1c;
    border: 1px solid #f0c4c4;
    border-radius: 6px;
    padding: 6px 16px;
    font-size: 13px;
    font-family: inherit;
    font-weight: 600;
    cursor: pointer;
    transition: background .15s, border-color .15s, color .15s;
  }}
  .modal-close:hover {{ background: #dc2626; border-color: #dc2626; color: #fff; }}
  .modal-table-wrap {{
    flex: 1;
    overflow: auto;
    padding: 16px 24px;
  }}
  .modal-table-wrap table {{
    font-size: 13px;
    min-width: 100%;
  }}
  .modal-table-wrap th,
  .modal-table-wrap td {{
    white-space: nowrap;
    padding: 8px 18px;
    max-width: 500px;
    overflow: hidden;
    text-overflow: ellipsis;
  }}
  /* 弹窗内表头固定 */
  .modal-table-wrap thead th {{
    position: sticky;
    top: 0;
    z-index: 2;
    background-color: #336699 !important;
  }}

  /* ── 异常汇总横幅 ── */
  .anomaly-banner {{
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 20px;
    border-radius: 10px;
    margin-bottom: 24px;
    font-size: 14px;
    animation: anomalyPulse 2s ease-in-out infinite;
  }}
  .anomaly-banner.anomaly-critical {{
    background: linear-gradient(135deg, #fef2f2, #fee2e2);
    border: 2px solid #ef4444;
    box-shadow: 0 2px 12px rgba(239,68,68,0.2);
  }}
  .anomaly-banner.anomaly-warning {{
    background: linear-gradient(135deg, #fffbeb, #fef3c7);
    border: 2px solid #f59e0b;
    box-shadow: 0 2px 12px rgba(245,158,11,0.2);
  }}
  .anomaly-banner.anomaly-ok {{
    background: linear-gradient(135deg, #f0fdf4, #dcfce7);
    border: 2px solid #22c55e;
    box-shadow: 0 2px 12px rgba(34,197,94,0.15);
    animation: none;
  }}
  @keyframes anomalyPulse {{
    0%, 100% {{ box-shadow: 0 2px 12px rgba(239,68,68,0.2); }}
    50% {{ box-shadow: 0 4px 20px rgba(239,68,68,0.4); }}
  }}
  .anomaly-icon {{ font-size: 20px; flex-shrink: 0; }}
  .anomaly-text {{ color: #333; flex-shrink: 0; }}
  .anomaly-item {{
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 700;
    white-space: nowrap;
  }}
  .anomaly-item-critical {{ background: #ef4444; color: #fff; }}
  .anomaly-item-high {{ background: #f97316; color: #fff; }}
  .anomaly-item-warn {{ background: #f59e0b; color: #fff; }}
  .anomaly-item-low {{ background: #22c55e; color: #fff; }}

  /* ── 规则引擎分析结果面板 ── */
  .analysis-panel {{
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 12px;
    margin-bottom: 24px;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
  }}
  .analysis-panel-header {{
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 20px;
    background: linear-gradient(135deg, #1e3a5f, #2d5688);
    color: #fff;
  }}
  .analysis-panel-icon {{ font-size: 20px; }}
  .analysis-panel-title {{
    font-size: 16px;
    font-weight: 700;
    flex: 1;
  }}
  .analysis-panel-count {{
    font-size: 13px;
    background: rgba(255,255,255,0.2);
    padding: 3px 12px;
    border-radius: 6px;
    font-weight: 600;
  }}
  .analysis-panel-toggle {{
    background: rgba(255,255,255,0.15);
    border: 1px solid rgba(255,255,255,0.3);
    color: #fff;
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.2s;
    white-space: nowrap;
  }}
  .analysis-panel-toggle:hover {{
    background: rgba(255,255,255,0.25);
  }}
  .analysis-panel-summary {{
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 12px 20px;
    background: #f8fafd;
    border-bottom: 1px solid #e8eef5;
  }}
  .analysis-summary-tag {{
    display: inline-flex;
    align-items: center;
    padding: 4px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 700;
    color: #fff;
    white-space: nowrap;
  }}
  .analysis-health-text {{
    font-size: 13px;
    font-weight: 600;
    margin-left: auto;
    white-space: nowrap;
  }}
  .analysis-panel-body {{
    padding: 16px 20px;
    max-height: 600px;
    overflow-y: auto;
  }}
  .analysis-group {{
    margin-bottom: 18px;
  }}
  .analysis-group:last-child {{
    margin-bottom: 0;
  }}
  .analysis-group-title {{
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 700;
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 2px solid #e8eef5;
  }}
  .analysis-group-badge {{
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    height: 24px;
    border-radius: 6px;
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    padding: 0 6px;
  }}
  .analysis-card {{
    border-left: 4px solid;
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 8px;
    transition: box-shadow 0.2s, transform 0.2s;
  }}
  .analysis-card:hover {{
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    transform: translateX(2px);
  }}
  .analysis-card:last-child {{
    margin-bottom: 0;
  }}
  .analysis-card-header {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }}
  .analysis-card-idx {{
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    height: 22px;
    border-radius: 4px;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    padding: 0 6px;
    flex-shrink: 0;
  }}
  .analysis-card-name {{
    font-size: 14px;
    font-weight: 700;
    color: #1a1a2e;
    white-space: normal;
    word-break: break-all;
    flex: 1;
    min-width: 0;
  }}
  .analysis-card-level-tag {{
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 4px;
    color: #fff;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    flex-shrink: 0;
  }}
  .analysis-card-owner {{
    font-size: 12px;
    color: #666;
    white-space: nowrap;
    flex-shrink: 0;
  }}
  .analysis-card-desc {{
    font-size: 13px;
    color: #444;
    line-height: 1.6;
    word-break: break-all;
  }}
  .analysis-card-fix {{
    margin-top: 8px;
  }}
  .fix-sql-details {{
    border-radius: 6px;
    overflow: hidden;
  }}
  .fix-sql-summary {{
    cursor: pointer;
    font-size: 12px;
    color: #336699;
    padding: 6px 10px;
    background: rgba(51,102,153,0.06);
    border-radius: 4px;
    user-select: none;
    transition: background 0.2s;
    list-style: none;
  }}
  .fix-sql-summary:hover {{
    background: rgba(51,102,153,0.12);
  }}
  .fix-sql-summary::-webkit-details-marker {{
    display: none;
  }}
  .fix-sql-wrapper {{
    position: relative;
    margin-top: 8px;
  }}
  .fix-sql-code {{
    margin: 0;
    padding: 12px 16px;
    padding-right: 70px;
    background: #1e293b;
    color: #e2e8f0;
    font-family: "Consolas", "Monaco", "Courier New", monospace;
    font-size: 12px;
    line-height: 1.6;
    border-radius: 6px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }}
  .fix-sql-copy-btn {{
    position: absolute;
    top: 8px;
    right: 8px;
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255,255,255,0.1);
    border: 1px solid rgba(255,255,255,0.2);
    color: #cbd5e1;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
  }}
  .fix-sql-copy-btn:hover {{
    background: rgba(255,255,255,0.2);
    color: #fff;
  }}
  .fix-sql-copy-btn .ic-check {{ display: none; }}
  .fix-sql-copy-btn.copied {{
    color: #a6e3a1;
    border-color: rgba(166,227,161,0.5);
  }}
  .fix-sql-copy-btn.copied .ic-copy {{ display: none; }}
  .fix-sql-copy-btn.copied .ic-check {{ display: block; }}

  /* ── 异常段落提示框 ── */
  .alert-box {{
    padding: 10px 16px;
    border-radius: 8px;
    margin: 10px 0;
    font-size: 13px;
    line-height: 1.6;
    border-left: 4px solid;
  }}
  .alert-critical {{
    background: #fef2f2;
    border-color: #ef4444;
    color: #991b1b;
    box-shadow: 0 1px 4px rgba(239,68,68,0.15);
  }}
  .alert-warning {{
    background: #fffbeb;
    border-color: #f59e0b;
    color: #92400e;
    box-shadow: 0 1px 4px rgba(245,158,11,0.15);
  }}
  .no-data-para {{
    color: #9ca3af;
    font-size: 13px;
    font-style: italic;
    padding: 6px 12px;
    background: #f9fafb;
    border-radius: 4px;
    margin: 8px 0;
  }}

  /* ── 异常检测规则说明面板 ── */
  .rules-panel {{
    background: linear-gradient(135deg, #f8fafd, #f0f6ff);
    border: 1px solid #c8d8f0;
    border-radius: 10px;
    margin-bottom: 24px;
    overflow: hidden;
  }}
  .rules-panel-header {{
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px;
    cursor: pointer;
    user-select: none;
    background: linear-gradient(135deg, #e8f0fe, #d8e8fa);
    border-bottom: 1px solid #c8d8f0;
    transition: background 0.2s;
  }}
  .rules-panel-header:hover {{
    background: linear-gradient(135deg, #d8e8fa, #c8d8f0);
  }}
  .rules-icon {{ font-size: 18px; }}
  .rules-title {{
    font-size: 15px;
    font-weight: 700;
    color: #003366;
    flex: 1;
  }}
  .rules-hint {{
    font-size: 11px;
    color: #6699cc;
  }}
  .rules-panel-body {{
    padding: 16px 20px;
  }}
  .rules-panel[open] .rules-hint::before {{ content: "收起"; }}
  .rules-panel:not([open]) .rules-hint::before {{ content: "展开"; }}
  .rules-panel:not([open]) .rules-panel-body {{ display: none; }}
  .rules-tip-text {{
    font-size: 12px;
    color: #6699cc;
    background: #f0f6ff;
    border: 1px dashed #99cce5;
    border-radius: 4px;
    padding: 6px 12px;
    margin-bottom: 12px;
  }}

  /* ── 异常行 Tooltip（全局固定定位 + JS 动态跟随鼠标）── */
  .anomaly-tooltip-row {{
    cursor: help;
  }}
  #globalAnomalyTooltip {{
    position: fixed;
    z-index: 100000;
    background: rgba(15, 23, 42, 0.98);
    color: #e2e8f0;
    padding: 10px 14px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    max-width: 520px;
    min-width: 280px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    border: 1px solid rgba(255,255,255,0.15);
    pointer-events: none;
    display: none;
  }}
  #globalAnomalyTooltip::before {{
    content: '';
    position: absolute;
    left: 12px;
    top: -6px;
    border: 6px solid transparent;
    border-bottom-color: rgba(15, 23, 42, 0.98);
    pointer-events: none;
  }}

  .rules-section {{
    margin-bottom: 20px;
  }}
  .rules-section:last-child {{
    margin-bottom: 0;
  }}
  .rules-section-title {{
    font-size: 14px;
    font-weight: 700;
    color: #003366;
    margin-bottom: 8px;
    padding-left: 10px;
    border-left: 3px solid #336699;
  }}
  .rules-section-desc {{
    font-size: 12px;
    color: #666;
    margin-bottom: 10px;
    line-height: 1.5;
  }}

  /* 规则表格 */
  .rules-table {{
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    margin-bottom: 4px;
    table-layout: fixed;
  }}
  .rules-table th {{
    background: #336699;
    color: #fff;
    padding: 6px 10px;
    text-align: left;
    font-weight: 700;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
  }}
  .rules-table td {{
    border: 1px solid #d8e0e8;
    padding: 6px 10px;
    vertical-align: middle;
    line-height: 1.5;
    white-space: normal !important;
    overflow: visible !important;
    text-overflow: clip !important;
    max-width: none !important;
    word-break: keep-all;
    overflow-wrap: break-word;
  }}
  .rules-table tbody tr:nth-child(even) {{
    background: #f8fafd;
  }}
  .rules-table tbody tr:hover {{
    background: #e8f0fe;
  }}

  /* 规则标签 */
  .rule-tag {{
    display: inline-block;
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 700;
    white-space: nowrap;
  }}
  .rule-tag-critical {{
    background: #dc2626;
    color: #fff;
  }}
  .rule-tag-high {{
    background: #ea580c;
    color: #fff;
  }}
  .rule-tag-mid {{
    background: #d97706;
    color: #fff;
  }}
  .rule-tag-warn {{
    background: #d97706;
    color: #fff;
  }}
  .rule-tag-low {{
    background: #16a34a;
    color: #fff;
  }}

  /* 图例 */
  .rules-legend {{
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    padding: 8px 0;
  }}
  .rules-legend-item {{
    display: flex;
    align-items: center;
    gap: 6px;
  }}
  .rules-legend-desc {{
    font-size: 12px;
    color: #555;
  }}

  /* ── 报告双栏布局：左侧目录 + 右侧正文 ── */
  .report-layout {{
    display: flex;
    align-items: flex-start;
    gap: 0;
  }}
  .report-sidebar {{
    flex: 0 0 280px;
    width: 280px;
    position: sticky;
    top: 20px;
    max-height: calc(100vh - 40px);
    overflow: hidden;
    margin-right: 20px;
    display: flex;
    flex-direction: column;
    transition: flex-basis .25s ease, width .25s ease, margin-right .25s ease;
  }}
  .report-layout.sidebar-collapsed .report-sidebar {{
    flex-basis: 0;
    width: 0;
    margin-right: 0;
    overflow: hidden;
  }}
  /* ── 目录标题行内的图标按钮（展开/收起全部章节、收起侧栏）──
     深色标题行上的幽灵态图标片：半透明白底 + 白图标，悬停加亮；
     语义全部由 tooltip 承载，按钮内只有图标 */
  .toc-act,
  .sidebar-toggle {{
    flex-shrink: 0;
    width: 26px;
    height: 26px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255,255,255,0.15);
    border: 1px solid rgba(255,255,255,0.34);
    border-radius: 6px;
    color: #fff;
    cursor: pointer;
    transition: background .15s, border-color .15s;
  }}
  .toc-act:hover,
  .sidebar-toggle:hover {{ background: rgba(255,255,255,0.34); border-color: rgba(255,255,255,0.72); }}
  .toc-act:active,
  .sidebar-toggle:active {{ transform: translateY(1px); }}
  .toc-act svg,
  .sidebar-toggle svg {{ width: 15px; height: 15px; display: block; }}

  /* 侧栏收起后，按钮脱离标题行浮到左上角：改用实色主色片，保证在白色正文上可见 */
  .report-layout.sidebar-collapsed .sidebar-toggle {{
    position: fixed;
    left: 12px;
    top: 12px;
    z-index: 200;
    width: 28px;
    height: 28px;
    margin: 0;
    background: #336699;
    border-color: #336699;
    box-shadow: 0 2px 8px rgba(15,23,42,0.22);
  }}
  .report-layout.sidebar-collapsed .sidebar-toggle:hover {{
    background: #004080;
    border-color: #004080;
  }}
  .report-main {{
    flex: 1 1 auto;
    min-width: 0;
  }}

  /* ── 左侧目录（覆盖原顶部卡片样式）── */
  .report-toc {{
    background: #fff;
    border: 1px solid #d0d8e8;
    border-radius: 10px;
    padding: 0;
    margin-bottom: 0;
    box-shadow: 0 1px 6px rgba(0,0,0,0.06);
    scroll-margin-top: 20px;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }}
  /* 目录标题行固定：始终位于「收起目录」按钮下方，不随目录条目滚动 */
  .toc-header {{
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 12px 14px;
    margin: 0;
    background: linear-gradient(135deg, #336699, #24507a);
    color: #fff;
    border-bottom: none;
  }}
  .toc-icon {{ font-size: 15px; }}
  .toc-title {{ color: #fff; font-size: 14px; font-weight: 700; }}
  .toc-count {{
    color: #cfe0f5;
    font-size: 11px;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }}

  /* ── 目录整体展开/收起按钮（位于标题行末尾，单个按钮双向切换）── */
  .toc-act {{
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 3px 8px;
    background: rgba(255,255,255,0.14);
    border: 1px solid rgba(255,255,255,0.38);
    border-radius: 5px;
    color: #fff;
    font-size: 11px;
    font-weight: 600;
    font-family: inherit;
    line-height: 1.4;
    white-space: nowrap;
    cursor: pointer;
    transition: background .15s, border-color .15s;
  }}
  .toc-act:hover {{ background: rgba(255,255,255,0.3); border-color: rgba(255,255,255,0.7); }}
  .toc-act:active {{ transform: translateY(1px); }}

  /* ── 目录树 ──
     目录条目独立滚动：「收起目录」按钮与「巡检目录」标题行固定在侧栏顶部，
     仅 .toc-tree 区域随滚动条上下移动 */
  .toc-tree, .toc-children {{ list-style: none; margin: 0; padding: 0; }}
  .toc-tree {{
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding-right: 2px;
  }}
  /* 侧栏目录滚动条：加宽加深，确保在窄侧栏内清晰可见、易于抓握滚动 */
  .toc-tree::-webkit-scrollbar {{
    width: 8px;
    background: #eef3fa;
  }}
  .toc-tree::-webkit-scrollbar-track {{
    background: #eef3fa;
    border-radius: 4px;
  }}
  .toc-tree::-webkit-scrollbar-thumb {{
    background: #a0b8d8;
    border-radius: 4px;
    min-height: 30px;
  }}
  .toc-tree::-webkit-scrollbar-thumb:hover {{
    background: #6699cc;
  }}
  /* Firefox 滚动条 */
  .toc-tree {{
    scrollbar-width: thin;
    scrollbar-color: #a0b8d8 #eef3fa;
  }}
  .toc-node {{ border-bottom: 1px solid #eef2f8; }}
  .toc-row {{
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 7px 10px;
    transition: background .15s;
  }}
  .toc-row-ch {{ font-weight: 700; }}
  .toc-row-sub {{ padding-left: 24px; }}
  .toc-caret {{
    background: none;
    border: none;
    cursor: pointer;
    color: #6699cc;
    font-size: 10px;
    padding: 2px 5px;
    transition: transform .15s ease;
    flex-shrink: 0;
  }}
  .toc-caret:hover {{ color: #004080; }}
  .toc-node.collapsed > .toc-row-ch .toc-caret {{ transform: rotate(-90deg); }}
  .toc-node.collapsed > .toc-children {{ display: none; }}
  .toc-link {{
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    text-decoration: none;
    color: #33475b;
    font-size: 13px;
    border-radius: 4px;
    padding: 2px 4px;
    transition: color .15s, background .15s;
  }}
  .toc-link:hover {{ color: #004080; background: #f0f6ff; }}
  .toc-row-sub .toc-link {{ font-size: 12px; color: #55708c; font-weight: 500; }}
  .toc-num {{
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 18px;
    padding: 0 5px;
    border-radius: 4px;
    background: #e8f0fe;
    color: #336699;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
  }}
  .toc-row-sub .toc-num {{ background: #f0f4fa; color: #6699cc; min-width: 34px; font-weight: 600; }}
  .toc-text {{
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }}
  .toc-node-anomaly > .toc-row-ch {{ background: #fff8f8; }}
  .toc-row .toc-badge {{ flex-shrink: 0; }}

  /* ── 响应式：窄屏侧栏自适应 / 超窄转纵向 ── */
  @media (max-width: 900px) {{
    .report-sidebar {{ flex-basis: 220px; width: 220px; }}
  }}
  @media (max-width: 640px) {{
    .report-layout {{ flex-direction: column; }}
    .report-sidebar {{
      position: static;
      width: 100%;
      flex-basis: auto;
      max-height: 340px;
      margin-right: 0;
      margin-bottom: 16px;
    }}
    .report-layout.sidebar-collapsed .report-sidebar {{
      flex-basis: auto; width: 100%; margin: 0; overflow: hidden; max-height: 0;
    }}
    /* 窄屏收起时侧栏被裁成 0 高度（overflow:hidden），按钮必须保持 fixed 才不会被一起裁掉，
       否则用户无法再次展开目录 */
    .report-layout.sidebar-collapsed .sidebar-toggle {{
      position: fixed;
      left: 8px;
      top: 8px;
      width: 28px;
      height: 28px;
      margin: 0;
      z-index: 200;
    }}
  }}

  /* ── 打印样式 ── */
  @media print {{
    body {{ background: #fff; padding: 0; }}
    .report-container {{ box-shadow: none; border-radius: 0; padding: 0; }}
    .table-wrap {{ overflow: visible; }}
    th, td {{ white-space: normal; word-break: break-all; }}
    .report-sidebar, .sidebar-toggle, .float-top, .table-toolbar,
    .maximize-fab, .toc-act,
    .back-to-toc, .table-modal, .table-collapse-toggle-row {{
      display: none !important;
    }}
    .report-main {{ width: 100% !important; }}
    .table-collapse-body {{ display: table-row-group !important; }}
  }}
</style>
</head>
<body>
<div class="report-container">
  <div class="report-layout">
      <aside class="report-sidebar" id="reportSidebar">
{toc_html}
<!-- 异常章节导航（位于巡检目录栏底部：在「目录中带异常数字」的章节之间跳转） -->
<div class="anomaly-nav-float" id="anomalyNavFloat">
  <button class="anomaly-nav-btn" id="prevAnomalyBtn" onclick="prevAnomaly()"
          title="上一个异常章节" aria-label="上一个异常章节">{_ICON_CHEVRON_UP}</button>
  <button class="anomaly-nav-btn" id="nextAnomalyBtn" onclick="nextAnomaly()"
          title="下一个异常章节" aria-label="下一个异常章节">{_ICON_CHEVRON_DOWN}</button>
</div>
    </aside>
    <main class="report-main">
      <div class="report-header">
        <h1>{_escape(report_title)}</h1>
        <div class="report-meta">{report_meta_line}</div>
      </div>
{anomaly_banner}
{analysis_panel}
{anomaly_rules}
      <div class="report-body">
{body_html}
      </div>
    </main>
  </div>
</div>

<!-- 异常行全局 Tooltip（固定定位，z-index 最高，确保覆盖所有元素） -->
<div id="globalAnomalyTooltip"></div>

<!-- 浮动返回顶部按钮 -->
<button class="float-top" id="floatTop" onclick="scrollToTop()" title="返回顶部">↑</button>

<!-- 内容最大化弹窗（表格 / 面板 / 提示框 / SQL / 长文本通用；Esc 或点遮罩关闭） -->
<div class="table-modal" id="contentModal">
  <div class="modal-content">
    <div class="modal-header">
      <span class="modal-title" id="contentModalTitle">内容详情</span>
      <button class="modal-close" onclick="closeContentModal()">✕ 关闭 (Esc)</button>
    </div>
    <div class="modal-table-wrap" id="contentModalBody"></div>
  </div>
</div>

<script>
  // ── 内联 SVG 图标（与 Python 侧同名常量一致，避免字体依赖）──
  var ICON_UNFOLD_MORE = '{_ICON_UNFOLD_MORE}';
  var ICON_UNFOLD_LESS = '{_ICON_UNFOLD_LESS}';
  var ICON_CHEVRONS_LEFT = '{_ICON_CHEVRONS_LEFT}';
  var ICON_CHEVRONS_RIGHT = '{_ICON_CHEVRONS_RIGHT}';

  // ── 修复建议 SQL 复制（右上角图标按钮；含 http 环境降级）──
  // pre 内是 _escape 后的文本（无 <br> 转换），textContent 即所见，逐字符保真
  function fixCopySql(btn) {{
    var wrap = btn.closest('.fix-sql-wrapper');
    var pre = wrap ? wrap.querySelector('pre.fix-sql-code') : null;
    if (!pre) return;
    var text = pre.textContent || '';
    function ok() {{
      btn.classList.add('copied');
      btn.setAttribute('aria-label', '已复制');
      setTimeout(function() {{ btn.classList.remove('copied'); btn.setAttribute('aria-label', '复制 SQL'); }}, 1500);
    }}
    function fb() {{
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try {{ document.execCommand('copy'); ok(); }} catch (e) {{}}
      document.body.removeChild(ta);
    }}
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fb); else fb();
  }}

  // ── 目录章节展开/收起（树节点）──
  function toggleTocNode(btn) {{
    var node = btn.closest('.toc-node');
    if (!node) return;
    node.classList.toggle('collapsed');
    syncTocAllState();
  }}

  // ── 目录整体展开 / 收起（单按钮双向切换）──
  // force: true 强制全展开 / false 强制全收起 / 省略则按当前状态取反
  function toggleAllToc(force) {{
    var tree = document.querySelector('#report-toc .toc-tree');
    if (!tree) return;
    var nodes = getTocChapterNodes(tree);
    if (!nodes.length) return;

    var collapsed = 0;
    for (var i = 0; i < nodes.length; i++) {{
      if (nodes[i].classList.contains('collapsed')) collapsed++;
    }}
    // 默认取反：只要还有展开的章节就整体收起，仅当已全部收起时才整体展开
    var expand = (typeof force === 'boolean') ? force : (collapsed === nodes.length);

    for (var j = 0; j < nodes.length; j++) {{
      if (expand) nodes[j].classList.remove('collapsed');
      else nodes[j].classList.add('collapsed');
    }}
    syncTocAllState();
  }}

  // ── 取目录中「含子项」的章节节点（叶子节点无展开语义，不参与）──
  function getTocChapterNodes(tree) {{
    var all = tree.querySelectorAll('.toc-node');
    var out = [];
    for (var i = 0; i < all.length; i++) {{
      if (all[i].querySelector('.toc-children')) out.push(all[i]);
    }}
    return out;
  }}

  // ── 按各章节实际折叠状态，刷新切换按钮的图标与提示（纯图标，语义走 tooltip）──
  function syncTocAllState() {{
    var tree = document.querySelector('#report-toc .toc-tree');
    var btn = document.getElementById('tocToggleAll');
    if (!tree || !btn) return;
    var nodes = getTocChapterNodes(tree);
    if (!nodes.length) return;
    var collapsed = 0;
    for (var i = 0; i < nodes.length; i++) {{
      if (nodes[i].classList.contains('collapsed')) collapsed++;
    }}
    // 图标显示「点击后的动作」：全部已收起 → 双箭头外扩（可展开），否则相向（可收起）
    var allCollapsed = collapsed === nodes.length;
    btn.innerHTML = allCollapsed ? ICON_UNFOLD_MORE : ICON_UNFOLD_LESS;
    btn.title = allCollapsed ? '展开全部章节（Ctrl+Shift+E）' : '收起全部章节（Ctrl+Shift+C）';
    btn.setAttribute('aria-label', allCollapsed ? '展开全部章节' : '收起全部章节');
  }}

  // ── 目录批量操作快捷键：Ctrl+Shift+E 全展开 / Ctrl+Shift+C 全收起 ──
  document.addEventListener('keydown', function(e) {{
    if (!e.ctrlKey || !e.shiftKey || e.altKey) return;
    var key = (e.key || '').toLowerCase();
    if (key === 'e') {{ toggleAllToc(true); e.preventDefault(); }}
    else if (key === 'c') {{ toggleAllToc(false); e.preventDefault(); }}
  }});

  // ── 整个左侧目录栏收起/展开（纯图标按钮，尖括号指向面板将要移动的方向）──
  function toggleSidebar(btn) {{
    var layout = document.querySelector('.report-layout');
    if (!layout) return;
    var collapsed = layout.classList.toggle('sidebar-collapsed');
    if (btn) {{
      btn.innerHTML = collapsed ? ICON_CHEVRONS_RIGHT : ICON_CHEVRONS_LEFT;
      btn.title = collapsed ? '展开目录' : '收起目录';
      btn.setAttribute('aria-label', collapsed ? '展开目录' : '收起目录');
    }}
  }}

  // ── 表格行折叠/展开 ──
  function toggleTableRows(btn) {{
    var wrap = btn.closest('.table-wrap');
    if (!wrap) return;
    var collapseBody = wrap.querySelector('.table-collapse-body');
    if (!collapseBody) return;
    if (collapseBody.style.display === 'none') {{
      collapseBody.style.display = '';
      btn.classList.add('expanded');
      btn.innerHTML = '<span class="collapse-arrow">▼</span> 收起剩余行';
    }} else {{
      collapseBody.style.display = 'none';
      btn.classList.remove('expanded');
      var match = btn.textContent.match(/\\d+/);
      var count = match ? match[0] : '';
      btn.innerHTML = '<span class="collapse-arrow">▶</span> 展开剩余 ' + count + ' 行';
    }}
  }}

  // ── 平滑滚动到顶部 ──
  function scrollToTop() {{
    window.scrollTo({{ top: 0, behavior: 'smooth' }});
  }}

  // ══ 异常章节导航（上一个 / 下一个）══
  // 导航单位 = 目录中有异常数字徽章的章节。点击后：
  //   ① 目录：展开该章节、标记激活态、并把该行滚入目录可视区（只动目录树自身滚动）
  //   ② 正文：平滑滚动定位到该章节标题，并给一次高亮闪烁
  var anomalyChapters = [];       // 每项：{{node, link, target, count}}
  var currentAnomalyIndex = -1;   // 当前定位到的章节序号，-1 = 尚未开始
  var anomalyNavFloat = document.getElementById('anomalyNavFloat');
  var prevAnomalyBtn = document.getElementById('prevAnomalyBtn');
  var nextAnomalyBtn = document.getElementById('nextAnomalyBtn');

  // 收集目录里带异常徽章的章节（徽章数字来自规则引擎 / DOCX 风险表统计）
  function collectAnomalyChapters() {{
    var tree = document.querySelector('#report-toc .toc-tree');
    if (!tree) return [];
    var out = [];
    tree.querySelectorAll('.toc-node').forEach(function(node) {{
      var row = node.querySelector('.toc-row-ch');
      var link = node.querySelector('.toc-link-ch');
      if (!row || !link) return;
      var badges = row.querySelectorAll('.toc-badge');
      if (!badges.length) return;
      var href = link.getAttribute('href') || '';
      var target = href.charAt(0) === '#' ? document.getElementById(href.slice(1)) : null;
      if (!target) return;
      var total = 0;
      badges.forEach(function(b) {{ total += parseInt(b.textContent, 10) || 0; }});
      out.push({{ node: node, link: link, target: target, count: total }});
    }});
    return out;
  }}

  function initAnomalyNav() {{
    anomalyChapters = collectAnomalyChapters();
    // 没有异常章节就隐藏这组导航
    if (!anomalyChapters.length) {{
      if (anomalyNavFloat) anomalyNavFloat.style.display = 'none';
      return;
    }}
    updateAnomalyCount();
  }}

  function updateAnomalyCount() {{
    if (!anomalyNavFloat) return;
    var oldCount = anomalyNavFloat.querySelector('.anomaly-nav-count');
    if (oldCount) oldCount.remove();
    var countEl = document.createElement('span');
    countEl.className = 'anomaly-nav-count';
    countEl.title = '已定位 / 异常章节总数';
    countEl.textContent = (currentAnomalyIndex + 1) + '/' + anomalyChapters.length;
    countEl.setAttribute('aria-live', 'polite');
    anomalyNavFloat.appendChild(countEl);
  }}

  // 让目录里某一行进入目录树的可视区域（只改 .toc-tree 的 scrollTop，不牵动页面滚动）
  function scrollTocRowIntoView(node) {{
    var tree = document.querySelector('#report-toc .toc-tree');
    if (!tree || !node) return;
    var r = node.getBoundingClientRect(), t = tree.getBoundingClientRect();
    if (r.top < t.top) tree.scrollTop -= (t.top - r.top) + 8;
    else if (r.bottom > t.bottom) tree.scrollTop += (r.bottom - t.bottom) + 8;
  }}

  // 定位到第 index 个异常章节（自动按总数取模，首尾循环）
  function gotoAnomalyChapter(index) {{
    var n = anomalyChapters.length;
    if (!n) return;
    index = ((index % n) + n) % n;

    // 清除上一个激活态
    if (currentAnomalyIndex >= 0 && anomalyChapters[currentAnomalyIndex]) {{
      anomalyChapters[currentAnomalyIndex].node.classList.remove('toc-node-active');
    }}
    currentAnomalyIndex = index;
    var item = anomalyChapters[index];

    // ① 目录：展开 + 激活 + 滚入可视区
    item.node.classList.remove('collapsed');
    item.node.classList.add('toc-node-active');
    scrollTocRowIntoView(item.node);
    // 展开动作会改变「展开/收起全部」按钮的图标状态，这里同步一下
    if (typeof syncTocAllState === 'function') syncTocAllState();

    // ② 正文：定位到该章节标题并闪烁提示
    item.target.scrollIntoView({{ behavior: 'smooth', block: 'start' }});
    item.target.classList.add('anomaly-flash');
    setTimeout(function() {{ item.target.classList.remove('anomaly-flash'); }}, 2000);

    updateAnomalyCount();
  }}

  function prevAnomaly() {{
    if (!anomalyChapters.length) return;
    gotoAnomalyChapter(currentAnomalyIndex < 0 ? -1 : currentAnomalyIndex - 1);
  }}

  function nextAnomaly() {{
    if (!anomalyChapters.length) return;
    gotoAnomalyChapter(currentAnomalyIndex < 0 ? 0 : currentAnomalyIndex + 1);
  }}

  // 页面加载完成后初始化
  document.addEventListener('DOMContentLoaded', initAnomalyNav);

  // ── 目录初始为全展开状态，同步「全展开」按钮高亮 ──
  document.addEventListener('DOMContentLoaded', syncTocAllState);

  // ── 异常行 Tooltip 跟随鼠标（固定定位，避免表格行 position:relative 导致的错位）──
  var anomalyTooltip = document.getElementById('globalAnomalyTooltip');
  var anomalyTooltipVisible = false;
  
  document.addEventListener('mouseover', function(e) {{
    var row = e.target.closest('.anomaly-tooltip-row');
    if (row && row.hasAttribute('data-tooltip')) {{
      anomalyTooltip.textContent = row.getAttribute('data-tooltip');
      anomalyTooltip.style.display = 'block';
      anomalyTooltipVisible = true;
      // 初始位置：鼠标右下方 10px
      updateAnomalyTooltipPosition(e);
    }}
  }});
  
  document.addEventListener('mouseout', function(e) {{
    var row = e.target.closest('.anomaly-tooltip-row');
    if (row && !row.contains(e.relatedTarget)) {{
      anomalyTooltip.style.display = 'none';
      anomalyTooltipVisible = false;
    }}
  }});
  
  document.addEventListener('mousemove', function(e) {{
    if (anomalyTooltipVisible) {{
      updateAnomalyTooltipPosition(e);
    }}
  }});
  
  function updateAnomalyTooltipPosition(e) {{
    var x = e.clientX;
    var y = e.clientY;
    var tooltipWidth = anomalyTooltip.offsetWidth;
    var tooltipHeight = anomalyTooltip.offsetHeight;
    var viewportWidth = window.innerWidth;
    var viewportHeight = window.innerHeight;
    
    // 默认位置：鼠标右下方
    var left = x + 10;
    var top = y + 10;
    
    // 边界检测：如果超出右边界，移到鼠标左侧
    if (left + tooltipWidth > viewportWidth - 10) {{
      left = x - tooltipWidth - 10;
    }}
    // 如果超出下边界，移到鼠标上方
    if (top + tooltipHeight > viewportHeight - 10) {{
      top = y - tooltipHeight - 10;
    }}
    // 确保不超出左/上边界
    left = Math.max(10, Math.min(left, viewportWidth - tooltipWidth - 10));
    top = Math.max(10, Math.min(top, viewportHeight - tooltipHeight - 10));
    
    anomalyTooltip.style.left = left + 'px';
    anomalyTooltip.style.top = top + 'px';
  }}

  // ── 浮动返回按钮显隐 ──
  var floatBtn = document.getElementById('floatTop');
  window.addEventListener('scroll', function() {{
    if (window.pageYOffset > 300) {{
      floatBtn.classList.add('visible');
    }} else {{
      floatBtn.classList.remove('visible');
    }}
  }});

  // ══ 内容最大化弹窗（表格 / 面板 / 提示框 / SQL / 长文本通用）══
  // 表格走工具栏里的常驻「最大化查看」按钮，其余内容块走悬停出现的悬浮按钮

  // 需要注入最大化入口的内容块
  // 注意：<details> 类块折叠时非 summary 子元素会被浏览器隐藏，故其按钮注入到 summary 内
  var MAXIMIZE_BLOCK_SELECTORS = [
    '.alert-box',
    '.analysis-panel',
    '.rules-panel',
    '.anomaly-rules',
    '.anomaly-banner',
    '.fix-sql-details'
  ];
  // 长文本块（段落 / 列表）：超过此字符数才注入，避免满屏小按钮
  var MAXIMIZE_TEXT_MIN_LEN = 80;

  // 最大化图标：四角外扩括号（与表格工具栏按钮一致，内联 SVG 免字体依赖）
  var MAXIMIZE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">' +
    '<path d="M4 9V4h5v2H6v3H4zM15 4h5v5h-2V6h-3V4zM4 15v5h5v-2H6v-3H4zM20 15v5h-5v-2h3v-3h2z"/></svg>';

  function makeMaximizeFab(block) {{
    var isDetails = block.tagName === 'DETAILS';
    var host = isDetails ? (block.querySelector('summary') || block) : block;
    if (host.querySelector(':scope > .maximize-fab')) return;
    if (!isDetails) block.classList.add('has-maximize');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = isDetails ? 'maximize-fab maximize-fab-inline' : 'maximize-fab';
    // 纯图标，靠 tooltip + aria-label 承载语义
    btn.title = '最大化查看（Esc 关闭）';
    btn.setAttribute('aria-label', '最大化查看');
    btn.innerHTML = MAXIMIZE_ICON_SVG;
    btn.addEventListener('click', function(e) {{
      // 阻止冒泡到 summary，避免顺带把 <details> 展开/收起
      e.preventDefault();
      e.stopPropagation();
      openMaximize(block);
    }});
    host.appendChild(btn);
  }}

  // 为报告内容块注入最大化入口（脚本在 body 末尾，DOM 已就绪）
  function initMaximizeButtons() {{
    MAXIMIZE_BLOCK_SELECTORS.forEach(function(sel) {{
      document.querySelectorAll(sel).forEach(function(el) {{ makeMaximizeFab(el); }});
    }});
    // 较长的正文段落 / 列表也支持最大化
    document.querySelectorAll('.report-body > p, .report-body > ul, .report-body > ol').forEach(function(el) {{
      if (el.textContent.trim().length < MAXIMIZE_TEXT_MIN_LEN) return;
      makeMaximizeFab(el);
    }});
  }}

  // 表格工具栏按钮 → 最大化整张表格
  function maximizeContent(btn) {{
    var block = btn.closest('.table-wrap') || btn.closest('.has-maximize') || btn.parentElement;
    openMaximize(block);
  }}

  // 折叠的行在弹窗内全部展开（最大化就是为了看全）
  function revealCollapsedRows(root) {{
    root.querySelectorAll('.table-collapse-body').forEach(function(tb) {{ tb.style.display = ''; }});
    root.querySelectorAll('.table-collapse-toggle-row').forEach(function(tr) {{ tr.remove(); }});
  }}

  // 内容块类型标签（用于弹窗标题）
  function maximizeBlockLabel(el) {{
    if (!el) return '内容';
    if (el.classList.contains('analysis-panel')) return '规则引擎分析';
    if (el.classList.contains('anomaly-banner')) return '巡检结论';
    if (el.classList.contains('rules-panel') || el.classList.contains('anomaly-rules')) return '异常检测规则说明';
    if (el.classList.contains('alert-box')) return '异常提示';
    if (el.classList.contains('fix-sql-details') || el.classList.contains('fix-sql-wrapper') || el.tagName === 'PRE') return '修复建议 SQL';
    if (el.tagName === 'UL' || el.tagName === 'OL') return '列表';
    if (el.tagName === 'P') return '正文';
    return '内容';
  }}

  // 向上寻找最近的上文标题，拼进弹窗标题，便于确认内容归属
  function nearestHeadingText(el) {{
    var node = el;
    while (node && node !== document.body) {{
      var sib = node.previousElementSibling;
      while (sib) {{
        if (/^H[1-6]$/.test(sib.tagName)) {{
          return sib.textContent.replace(/↑/g, '').trim().slice(0, 60);
        }}
        var inner = sib.querySelector ? sib.querySelector('h1,h2,h3,h4,h5,h6') : null;
        if (inner) return inner.textContent.replace(/↑/g, '').trim().slice(0, 60);
        sib = sib.previousElementSibling;
      }}
      node = node.parentElement;
    }}
    return '';
  }}

  function buildMaximizeTitle(el, base) {{
    var h = nearestHeadingText(el);
    return h ? (h + ' · ' + base) : base;
  }}

  // 打开最大化弹窗；el 可以是 .table-wrap 或任意内容块
  function openMaximize(el) {{
    if (!el) return;
    var modal = document.getElementById('contentModal');
    var body = document.getElementById('contentModalBody');
    var titleEl = document.getElementById('contentModalTitle');
    if (!modal || !body || !titleEl) return;

    var isTableWrap = el.classList.contains('table-wrap');
    body.innerHTML = '';
    body.className = isTableWrap ? 'modal-table-wrap' : 'modal-content-wrap';

    if (isTableWrap) {{
      var table = el.querySelector('table');
      if (!table) return;
      var clone = table.cloneNode(true);
      revealCollapsedRows(clone);
      // 首行提为 thead，弹窗内表头 sticky
      var tbody = clone.querySelector('tbody');
      if (tbody) {{
        var firstRow = tbody.querySelector('tr');
        if (firstRow) {{
          var thead = document.createElement('thead');
          thead.appendChild(firstRow.cloneNode(true));
          tbody.removeChild(firstRow);
          clone.insertBefore(thead, tbody);
        }}
      }}
      body.appendChild(clone);
      var cols = table.querySelector('tr') ? table.querySelector('tr').cells.length : 0;
      var rows = table.querySelectorAll('tbody tr').length;
      titleEl.textContent = buildMaximizeTitle(el, '表格详情（' + cols + ' 列 × ' + rows + ' 行）');
    }} else {{
      var content = el.cloneNode(true);
      content.classList.remove('has-maximize');
      content.querySelectorAll('.maximize-fab').forEach(function(b) {{ b.remove(); }});
      revealCollapsedRows(content);
      // 弹窗内 <details>（规则说明 / 修复 SQL）直接展开，最大化就是为了看全
      if (content.tagName === 'DETAILS') content.open = true;
      content.querySelectorAll('details').forEach(function(d) {{ d.open = true; }});
      body.appendChild(content);
      titleEl.textContent = buildMaximizeTitle(el, maximizeBlockLabel(el));
    }}

    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }}

  function closeContentModal() {{
    var modal = document.getElementById('contentModal');
    if (!modal) return;
    modal.classList.remove('active');
    document.body.style.overflow = '';
  }}

  // 点击遮罩关闭弹窗
  document.getElementById('contentModal').addEventListener('click', function(e) {{
    if (e.target === this) closeContentModal();
  }});

  // ESC 关闭弹窗
  document.addEventListener('keydown', function(e) {{
    if (e.key === 'Escape') closeContentModal();
  }});

  initMaximizeButtons();

  // ── 目录点击平滑滚动（章节 + 子项链接）──
  document.querySelectorAll('.toc-link').forEach(function(link) {{
    link.addEventListener('click', function(e) {{
      e.preventDefault();
      var target = document.querySelector(this.getAttribute('href'));
      if (target) {{
        target.scrollIntoView({{ behavior: 'smooth', block: 'start' }});
      }}
    }});
  }});

  // ── 返回目录链接平滑滚动 ──
  document.querySelectorAll('.back-to-toc').forEach(function(link) {{
    link.addEventListener('click', function(e) {{
      e.preventDefault();
      var target = document.querySelector(this.getAttribute('href'));
      if (target) {{
        target.scrollIntoView({{ behavior: 'smooth', block: 'start' }});
      }}
    }});
  }});
</script>
</body>
</html>'''

    return html_doc


def save_docx_as_html(docx_path, output_html_path=None):
    """
    将 DOCX 转换为 HTML 并保存到文件

    参数:
        docx_path: .docx 文件路径
        output_html_path: 输出 HTML 路径，如果为 None 则自动生成

    返回:
        str: HTML 文件路径
    """
    html_content = convert_docx_to_html(docx_path)

    if output_html_path is None:
        base = os.path.splitext(docx_path)[0]
        output_html_path = base + '.html'

    with open(output_html_path, 'w', encoding='utf-8') as f:
        f.write(html_content)

    return output_html_path
