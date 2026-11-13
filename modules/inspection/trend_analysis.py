# -*- coding: utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""历史趋势分析（无状态服务）。

目标：让人**快速识别异常项**并能**看出变化**。为此在 `snapshots` 之上做三件事：

1. **指标序列**：优先解析 `context_json` 的原始结构，扁平列兜底。
   历史快照里 Oracle 类实例的扁平指标列（cpu/mem/disk/tablespace）实测全为 0/NULL，
   但真正有数据的是 `_oracle_config_baseline`、`_oracle_index_health.summary`、
   `_oracle_chapter_results` 里的表格 —— 解析它们即可让历史数据立刻可用，无需改表。

2. **异常项生命周期**：用 `rules.dedupe.issue_topic(col1)` 归一化成稳定主题键，
   跨快照求集合差，判定每项是「新增 / 持续 / 已消除」，并记录命中快照序号，
   供前端画出「迷你出现条」。

3. **变化语义**：每个指标算环比、窗口均值、斜率、极值与状态（恶化/改善/稳定/突破），
   并给出整体结论（恶化/改善/稳定）。

纯函数实现（`_analyze_snapshots` 只吃普通 dict 列表），便于单测。
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
from typing import Any, Dict, List, Optional


# ═══════════════════════════════════════════════════════════
#  异常主题归一化（自包含实现）
# ═══════════════════════════════════════════════════════════
# 旧系统通过 dbcheck.analysis.rules.dedupe.issue_topic 把风险项标题归一化成
# 稳定主题键，供「新增 / 持续 / 已消除」生命周期判定。目标项目没有该模块，
# 这里内联一份等价实现，避免为单个函数引入整包规则依赖。
_TS_NAME_RE = re.compile(r'表空间\s+([A-Za-z0-9_$#.]+)', re.I)
_ASM_NAME_RE = re.compile(r'磁盘组\s+([A-Za-z0-9_$#.]+)', re.I)
_OWNER_RE = re.compile(r'用户\s+([A-Za-z0-9_$#]+)\s+有')
_PAREN_ENTITY_RE = re.compile(r'[（(]\s*(/[^\s）)]+)\s*[）)]')
_TOPIC_KEYWORDS = (
    ('临时表空间', 'temp_tablespace'), ('TEMP', 'temp_tablespace'),
    ('ASM', 'asm'), ('闪回恢复区', 'flashback'), ('闪回', 'flashback'),
    ('FRA', 'flashback'), ('回收站', 'recyclebin'), ('UNDO', 'undo'),
    ('撤销', 'undo'), ('重做日志', 'redo'), ('日志组可能过少', 'redo_few'),
    ('日志组异常', 'redo_status'), ('Redo', 'redo'), ('redo', 'redo'),
    ('控制文件', 'controlfile'), ('失效或孤儿', 'datafile_error'),
    ('数据文件', 'datafile'), ('临时文件', 'datafile'),
    ('未开启归档', 'archive_mode'), ('归档模式', 'archive_mode'),
    ('归档', 'archive'), ('表空间', 'tablespace'),
    ('死锁', 'deadlock'), ('锁等待链', 'innodb_lock'), ('锁等待', 'lock_wait'),
    ('锁阻塞', 'lock_wait'), ('阻塞链', 'lock_wait'), ('阻塞', 'lock_wait'),
    ('长事务', 'long_trx'), ('长 SQL', 'long_query'), ('长SQL', 'long_query'),
    ('长时间运行', 'long_query'), ('慢查询', 'slow_query'),
    ('无效对象', 'invalid_objects'), ('无效索引', 'invalid_indexes'),
    ('open_cursors', 'open_cursors'), ('密码策略', 'password_policy'),
    ('Profile', 'password_policy'), ('审计', 'audit'),
    ('统计信息', 'statistics'), ('索引', 'index'), ('分区', 'partition'),
    ('字符集', 'charset'), ('参数', 'params'), ('库缓存', 'library_cache'),
    ('命中率', 'cache_hit'), ('物理内存比例', 'sga_mem_ratio'),
    ('系统内存', 'system.memory'), ('内存', 'system.memory'),
    ('CPU', 'system.cpu'), ('cpu', 'system.cpu'), ('磁盘', 'system.disk'),
    ('会话', 'sessions'), ('进程', 'processes'), ('连接数', 'connections'),
    ('连接', 'connections'), ('SGA', 'sga'), ('PGA', 'pga'),
    ('备份', 'backup'), ('未找到最近', 'backup'), ('RMAN', 'backup'),
    ('主从', 'replication'), ('复制', 'replication'), ('MRP', 'dg_mrp'),
    ('保护模式', 'dg_protection'), ('Data Guard', 'dataguard'),
    ('备库', 'dataguard'), ('用户被锁定', 'locked_users'),
    ('数据文件脱机', 'datafile_offline'),
)


def issue_topic(col1: str) -> str:
    """把风险项标题归一化成主题键（与旧系统 dedupe.issue_topic 等价）。"""
    text = str(col1 or '').strip()
    if not text:
        return ''
    match = _TS_NAME_RE.search(text)
    if match:
        return 'tablespace:' + match.group(1).upper()
    match = _ASM_NAME_RE.search(text)
    if match:
        kind = 'offline' if '离线' in text else ('space' if ('空间' in text or '使用率' in text) else 'other')
        return 'asm:%s:%s' % (match.group(1).upper(), kind)
    match = _OWNER_RE.search(text)
    if match:
        return 'invalid_objects:' + match.group(1).upper()
    mount = _PAREN_ENTITY_RE.search(text)
    for keyword, topic in _TOPIC_KEYWORDS:
        if keyword in text:
            return f'{topic}:{mount.group(1)}' if mount else topic
    normalized = re.sub(r'\s+', '', text)
    return normalized if len(normalized) >= 4 else ''


def calculate_unified_health_score(issues=None, ai_dba_report=None, health_status=''):
    """统一健康评分（与旧系统 dbcheck.core.scoring 同口径的自包含实现）。"""
    if ai_dba_report and isinstance(ai_dba_report, dict) and ai_dba_report.get('total_score') is not None:
        health_score = ai_dba_report['total_score']
        _rl = ai_dba_report.get('risk_level', 'medium')
        risk_level = {'critical': 'critical', 'high': 'high', 'medium': 'medium',
                      'low': 'low', 'info': 'healthy'}.get(_rl, 'medium')
        risk_count = ai_dba_report.get('critical_count', 0) + ai_dba_report.get('high_count', 0)
        return (health_score, risk_level, risk_count,
                ai_dba_report.get('risk_level_label', health_status or '已评估'))
    risk_count = 0
    if issues and isinstance(issues, list):
        for item in issues:
            if isinstance(item, dict):
                level = str(item.get('col2', ''))
                if '高' in level or '中' in level:
                    risk_count += 1
    if '优秀' in health_status or 'Excellent' in health_status:
        health_score = 100
    elif '良好' in health_status or 'Good' in health_status:
        health_score = 80
    elif '一般' in health_status or 'Fair' in health_status:
        health_score = 60
    elif '需关注' in health_status or 'Attention' in health_status:
        health_score = 40
    elif '差' in health_status:
        health_score = 40
    else:
        health_score = max(0, 100 - min(risk_count * 5, 50))
    if health_score >= 85:
        risk_level = 'healthy'
    elif health_score >= 70:
        risk_level = 'low'
    elif health_score >= 50:
        risk_level = 'medium'
    elif health_score >= 30:
        risk_level = 'high'
    else:
        risk_level = 'critical'
    health_status_text = health_status or ('良好' if health_score >= 70 else '一般' if health_score >= 50 else '需关注')
    return health_score, risk_level, risk_count, health_status_text


# ═══════════════════════════════════════════════════════════
#  指标注册表
# ═══════════════════════════════════════════════════════════
# direction: 'up_bad'（越高越差）/ 'up_good'（越高越好）/ 'neutral'（中性，只看涨跌）
# warn/crit: 警戒线与严重线，None 表示该指标不设阈值
# primary:  前端默认展示的指标（其余按需勾选）
METRIC_REGISTRY: tuple = (
    {'key': 'risk_count', 'label': '风险项数量', 'unit': '', 'direction': 'up_bad',
     'warn': 1, 'crit': 3, 'group': 'health', 'primary': True},
    {'key': 'health_score', 'label': '健康评分', 'unit': '', 'direction': 'up_good',
     'warn': 70, 'crit': 50, 'group': 'health', 'primary': True},
    {'key': 'cpu_usage', 'label': 'CPU 使用率', 'unit': '%', 'direction': 'up_bad',
     'warn': 80, 'crit': 90, 'group': 'os', 'primary': True},
    {'key': 'mem_usage', 'label': '内存使用率', 'unit': '%', 'direction': 'up_bad',
     'warn': 80, 'crit': 90, 'group': 'os', 'primary': True},
    {'key': 'disk_usage_max', 'label': '磁盘使用率', 'unit': '%', 'direction': 'up_bad',
     'warn': 80, 'crit': 90, 'group': 'os', 'primary': True},
    {'key': 'max_tablespace_pct', 'label': '表空间最大使用率', 'unit': '%', 'direction': 'up_bad',
     'warn': 80, 'crit': 90, 'group': 'space', 'primary': True},
    {'key': 'db_size_gb', 'label': '数据库容量', 'unit': 'GB', 'direction': 'neutral',
     'warn': None, 'crit': None, 'group': 'space', 'primary': True},
    {'key': 'sga_total_mb', 'label': 'SGA 大小', 'unit': 'MB', 'direction': 'neutral',
     'warn': None, 'crit': None, 'group': 'memory', 'primary': False},
    {'key': 'total_memory_gb', 'label': '服务器内存', 'unit': 'GB', 'direction': 'neutral',
     'warn': None, 'crit': None, 'group': 'memory', 'primary': False},
    {'key': 'connections', 'label': '当前连接数', 'unit': '', 'direction': 'neutral',
     'warn': None, 'crit': None, 'group': 'conn', 'primary': True},
    {'key': 'connection_usage_pct', 'label': '连接使用率', 'unit': '%', 'direction': 'up_bad',
     'warn': 80, 'crit': 90, 'group': 'conn', 'primary': False},
    {'key': 'cache_hit_ratio', 'label': '缓存命中率', 'unit': '%', 'direction': 'up_good',
     'warn': 95, 'crit': 90, 'group': 'perf', 'primary': True},
    {'key': 'qps', 'label': 'QPS', 'unit': '', 'direction': 'neutral',
     'warn': None, 'crit': None, 'group': 'perf', 'primary': False},
    {'key': 'top_sql_elapsed_sec', 'label': 'TOP SQL 耗时', 'unit': 's', 'direction': 'up_bad',
     'warn': None, 'crit': None, 'group': 'perf', 'primary': False},
    {'key': 'config_critical_count', 'label': '配置严重项', 'unit': '', 'direction': 'up_bad',
     'warn': 1, 'crit': 3, 'group': 'config', 'primary': True},
    {'key': 'config_max_gap_pct', 'label': '配置最大偏差', 'unit': '%', 'direction': 'up_bad',
     'warn': 50, 'crit': 80, 'group': 'config', 'primary': False},
    {'key': 'index_missing', 'label': '缺失索引', 'unit': '', 'direction': 'up_bad',
     'warn': 1, 'crit': 5, 'group': 'index', 'primary': True},
    {'key': 'index_redundant', 'label': '冗余索引', 'unit': '', 'direction': 'up_bad',
     'warn': None, 'crit': None, 'group': 'index', 'primary': False},
    {'key': 'index_unused', 'label': '未使用索引', 'unit': '', 'direction': 'up_bad',
     'warn': None, 'crit': None, 'group': 'index', 'primary': False},
)

METRIC_BY_KEY: Dict[str, dict] = {m['key']: m for m in METRIC_REGISTRY}

# ═══════════════════════════════════════════════════════════
#  自动发现：把 context_json 里「结构规整的单值数值」也纳入趋势
# ═══════════════════════════════════════════════════════════
#  巡检器把大量指标塞在 context_json 里（MySQL 的 SHOW STATUS、SQL Server 的
#  ss_* 汇总、Oracle 的顶层标量），形态高度规律，且都是「一个快照一个数」：
#    · 顶层标量          max_tablespace_usage_percent = 86.79
#    · 嵌套标量          system_info.memory.usage_percent = 83.4
#    · 单行表 + Value    threads_connected[0].Value = 12
#    · 单行表 + 数值字段 ss_page_life[0].page_life_expectancy = 3200
#  多行明细表（wait_stats、top_queries、undo_info…）不做单值趋势，直接跳过，
#  避免把明细噪声灌进趋势图。
#
#  稳定性靠「跨快照路径交集」保证：只有每个快照都出现、且都是数值的路径才纳入，
#  偶发字段自动被排除；注册表已覆盖同义的路径列入 _SKIP_PATHS 防止重复展示。

#: 末段字段名黑名单（标识符 / 枚举，不是指标）
_SKIP_FIELD = frozenset({
    'session_id', 'blocking_session_id', 'database_id', 'dbid', 'file_id',
    'group#', 'thread#', 'sequence#', 'dest_id', 'pool_id', 'trace_id',
    'id', 'status', 'run_date', 'run_time', 'run_status', 'errortlevel',
    'enabled', 'has_password', 'cntr_type', 'chapter_number', 'port',
    'kernel', 'classifier_function_id', 'members', 'version', 'server_uuid',
    'min_cpu_percent', 'max_cpu_percent',
})

#: 前缀级排除（Windows 盘符路径不稳定，且 disk_usage_max 已覆盖）
#: `ora_deadlock[0]`：死锁增量行集（仅 1 行时会被 emit 成 xxx.STAT_VALUE），
#: 已有专门的 `ora_deadlock_cum` / `ora_deadlock_delta_total` 两个标量指标，
#: 不拦掉会多出一条「Ora Deadlock Stat Value」噪声线。
_SKIP_PREFIXES = ('system_info.disk.', 'ora_deadlock[0]')

#: 注册表已覆盖同义指标的路径（避免重复展示）
_SKIP_PATHS = frozenset({
    'max_tablespace_usage_percent', 'system_info.cpu.usage_percent',
    'system_info.memory.usage_percent', 'system_info.memory.total_mb',
    'system_info.memory.used_mb', 'threads_connected[0].Value',
    'max_used_connections[0].Value', 'max_connections[0].Value',
    'qps[0].Value', 'cache_hit_ratio_pct', 'health_analysis.score',
    'problem_count', 'sga_total',
    '_oracle_config_baseline.qps', '_oracle_config_baseline.total_memory_gb',
    '_oracle_config_baseline.db_size_gb',
    '_oracle_config_baseline.summary.critical_count',
    '_oracle_index_health.summary.missing_count',
    '_oracle_index_health.summary.redundant_count',
    '_oracle_index_health.summary.unused_count',
    '_oracle_index_health.summary.db_size_gb',
    'connection_count[0].total_connections',
})

#: 分组显示名与展示顺序（前端按此分组折叠）
GROUP_LABELS = {
    'health': {'zh': '健康评分', 'en': 'Health'},
    'os': {'zh': '操作系统', 'en': 'Operating System'},
    'space': {'zh': '空间容量', 'en': 'Space'},
    'memory': {'zh': '内存', 'en': 'Memory'},
    'conn': {'zh': '连接会话', 'en': 'Connections'},
    'perf': {'zh': '性能', 'en': 'Performance'},
    'config': {'zh': '配置基线', 'en': 'Config'},
    'index': {'zh': '索引', 'en': 'Indexes'},
    'other': {'zh': '其他指标', 'en': 'Other'},
}
GROUP_ORDER = ('health', 'os', 'space', 'memory', 'conn', 'perf', 'config', 'index', 'other')

#: 自动发现指标的元数据（按完整路径匹配）。
#: 只登记「有明确中文名 / 单位 / 阈值」的高价值项；未登记的走自动推断（中性、无阈值）。
_DISCOVERED_META: Dict[str, dict] = {
    # ── Oracle ──
    'sysaux_usage_percent': {'label': 'SYSAUX 表空间使用率', 'en': 'SYSAUX Usage',
                             'unit': '%', 'direction': 'up_bad', 'warn': 80, 'crit': 90, 'group': 'space'},
    'invalid_objects_count': {'label': '无效对象数', 'en': 'Invalid Objects',
                              'unit': '', 'direction': 'up_bad', 'warn': 1, 'crit': 10, 'group': 'config'},
    'pga_total': {'label': 'PGA 大小', 'en': 'PGA Size',
                  'unit': 'MB', 'direction': 'neutral', 'group': 'memory'},
    'pga_aggregate_target_mb': {'label': 'PGA 目标大小', 'en': 'PGA Aggregate Target',
                                'unit': 'MB', 'direction': 'neutral', 'group': 'memory'},
    'undo_retention': {'label': 'UNDO 保留时间', 'en': 'Undo Retention',
                       'unit': 's', 'direction': 'neutral', 'group': 'config'},
    'archive_errors': {'label': '归档错误数', 'en': 'Archive Errors',
                       'unit': '', 'direction': 'up_bad', 'warn': 1, 'crit': 1, 'group': 'config'},
    'library_cache_hit_ratio': {'label': '库缓存命中率', 'en': 'Library Cache Hit Ratio',
                                'unit': '%', 'direction': 'up_good', 'warn': 95, 'crit': 90, 'group': 'perf'},
    'ora_long_queries_count': {'label': '长查询数量', 'en': 'Long Queries',
                               'unit': '', 'direction': 'up_bad', 'warn': 1, 'crit': 5, 'group': 'perf'},
    # 死锁：累计值只作趋势参考（自实例启动单调不减，做阈值会恒超）；
    # 真正有判定意义的是「本次巡检新增」，见 core/stat_baseline.py
    'ora_deadlock_cum': {'label': '死锁累计次数', 'en': 'Deadlocks (cumulative)',
                         'unit': '', 'direction': 'neutral', 'group': 'perf'},
    'ora_deadlock_delta_total': {'label': '死锁新增次数', 'en': 'New Deadlocks',
                                 'unit': '', 'direction': 'up_bad', 'warn': 1, 'crit': 10,
                                 'group': 'perf'},
    '_oracle_config_baseline.summary.warning_count': {'label': '配置警告项', 'en': 'Config Warnings',
                                                      'unit': '', 'direction': 'up_bad', 'group': 'config'},
    '_oracle_config_baseline.summary.info_count': {'label': '配置提示项', 'en': 'Config Infos',
                                                   'unit': '', 'direction': 'up_bad', 'group': 'config'},
    '_oracle_index_health.summary.total_indexes': {'label': '索引总数', 'en': 'Total Indexes',
                                                   'unit': '', 'direction': 'neutral', 'group': 'index'},
    # ── MySQL ──
    'threads_running[0].Value': {'label': '活跃线程数', 'en': 'Threads Running',
                                 'unit': '', 'direction': 'neutral', 'group': 'conn'},
    'aborted_connects[0].Value': {'label': '中断连接数', 'en': 'Aborted Connects',
                                  'unit': '', 'direction': 'up_bad', 'group': 'conn'},
    'slow_query_count[0].Value': {'label': '慢查询数', 'en': 'Slow Queries',
                                  'unit': '', 'direction': 'up_bad', 'warn': 1, 'crit': 10, 'group': 'perf'},
    'table_open_cache[0].Value': {'label': '表缓存大小', 'en': 'Table Open Cache',
                                  'unit': '', 'direction': 'neutral', 'group': 'perf'},
    'key_buffer_size[0].Value': {'label': 'Key Buffer 大小', 'en': 'Key Buffer Size',
                                 'unit': 'B', 'direction': 'neutral', 'group': 'memory'},
    'innodb_buffer_pool_size[0].Value': {'label': 'InnoDB Buffer Pool', 'en': 'InnoDB Buffer Pool',
                                         'unit': 'B', 'direction': 'neutral', 'group': 'memory'},
    'com_commit[0].Value': {'label': '提交次数', 'en': 'Commits',
                            'unit': '', 'direction': 'neutral', 'group': 'perf'},
    'com_rollback[0].Value': {'label': '回滚次数', 'en': 'Rollbacks',
                              'unit': '', 'direction': 'up_bad', 'group': 'perf'},
    'cache_hit_requests[0].Value': {'label': '缓存命中请求', 'en': 'Cache Hit Requests',
                                    'unit': '', 'direction': 'neutral', 'group': 'perf'},
    'uptime[0].Value': {'label': '运行时长', 'en': 'Uptime',
                        'unit': 's', 'direction': 'neutral', 'group': 'other'},
    'health_analysis.critical_count': {'label': '健康关键问题', 'en': 'Critical Problems',
                                       'unit': '', 'direction': 'up_bad', 'warn': 1, 'crit': 3, 'group': 'health'},
    'health_analysis.warning_count': {'label': '健康警告问题', 'en': 'Warning Problems',
                                      'unit': '', 'direction': 'up_bad', 'group': 'health'},
    'slow_query_result.summary.total_sampled_queries': {'label': '慢查询采样数', 'en': 'Sampled Queries',
                                                        'unit': '', 'direction': 'neutral', 'group': 'perf'},
    # ── SQL Server ──
    'ss_page_life[0].page_life_expectancy': {'label': '页生命周期', 'en': 'Page Life Expectancy',
                                             'unit': 's', 'direction': 'up_good', 'warn': 300, 'crit': 150, 'group': 'memory'},
    'ss_batch_requests[0].batch_requests_per_sec': {'label': '批请求/秒', 'en': 'Batch Requests/sec',
                                                    'unit': '', 'direction': 'neutral', 'group': 'perf'},
    'ss_compilations[0].compilations_per_sec': {'label': '编译/秒', 'en': 'Compilations/sec',
                                                'unit': '', 'direction': 'neutral', 'group': 'perf'},
    'ss_recompilations[0].recompilations_per_sec': {'label': '重编译/秒', 'en': 'Recompilations/sec',
                                                    'unit': '', 'direction': 'up_bad', 'group': 'perf'},
    'ss_buffer_hit_ratio[0].buffer_cache_hit_ratio_pct': {'label': '缓冲命中率', 'en': 'Buffer Cache Hit Ratio',
                                                          'unit': '%', 'direction': 'up_good', 'warn': 95, 'crit': 90, 'group': 'perf'},
    'ss_user_connections_rate[0].user_connections': {'label': '用户连接数', 'en': 'User Connections',
                                                     'unit': '', 'direction': 'neutral', 'group': 'conn'},
    'ss_active_connections[0].active_connections': {'label': '活动连接数', 'en': 'Active Connections',
                                                    'unit': '', 'direction': 'up_bad', 'group': 'conn'},
    'ss_signal_wait[0].signal_wait_pct': {'label': '信号等待占比', 'en': 'Signal Wait %',
                                          'unit': '%', 'direction': 'up_bad', 'warn': 25, 'crit': 50, 'group': 'perf'},
    'ss_signal_wait[0].total_wait_ms': {'label': '总等待时间', 'en': 'Total Wait',
                                        'unit': 'ms', 'direction': 'up_bad', 'group': 'perf'},
    'ss_tempdb_space[0].tempdb_total_mb': {'label': 'tempdb 总大小', 'en': 'TempDB Size',
                                           'unit': 'MB', 'direction': 'neutral', 'group': 'space'},
    'ss_tempdb_space_used[0].total_mb': {'label': 'tempdb 已用', 'en': 'TempDB Used',
                                         'unit': 'MB', 'direction': 'up_bad', 'group': 'space'},
    'ss_max_worker_threads[0].max_worker_threads': {'label': '最大工作线程', 'en': 'Max Worker Threads',
                                                    'unit': '', 'direction': 'neutral', 'group': 'config'},
    'ss_lock_timeout[0].lock_timeouts_per_sec': {'label': '锁超时/秒', 'en': 'Lock Timeouts/sec',
                                                 'unit': '', 'direction': 'up_bad', 'warn': 1, 'crit': 5, 'group': 'perf'},
    'ss_failed_jobs[0].fail_count': {'label': '失败作业数', 'en': 'Failed Jobs',
                                     'unit': '', 'direction': 'up_bad', 'warn': 1, 'crit': 3, 'group': 'config'},
    'ss_cpu_mem[0].committed_mb': {'label': '已提交内存', 'en': 'Committed Memory',
                                   'unit': 'MB', 'direction': 'neutral', 'group': 'memory'},
    'ss_cpu_mem[0].committed_target_mb': {'label': '目标提交内存', 'en': 'Committed Target',
                                          'unit': 'MB', 'direction': 'neutral', 'group': 'memory'},
    'ss_cpu_mem[0].cpu_count': {'label': 'CPU 核数', 'en': 'CPU Count',
                                'unit': '', 'direction': 'neutral', 'group': 'os'},
    'ss_largest_tables[0].total_mb': {'label': '最大表容量', 'en': 'Largest Table Size',
                                      'unit': 'MB', 'direction': 'neutral', 'group': 'space'},
    'ss_largest_tables[0].row_count': {'label': '最大表行数', 'en': 'Largest Table Rows',
                                       'unit': '', 'direction': 'neutral', 'group': 'space'},
    'ss_heaps[0].reads': {'label': '堆表读取', 'en': 'Heap Reads',
                          'unit': '', 'direction': 'neutral', 'group': 'perf'},
    'ss_heaps[0].user_updates': {'label': '堆表更新', 'en': 'Heap Updates',
                                 'unit': '', 'direction': 'up_bad', 'group': 'perf'},
    'ss_top_writes[0].logical_writes': {'label': 'TOP 逻辑写', 'en': 'Top Logical Writes',
                                        'unit': '', 'direction': 'neutral', 'group': 'perf'},
    'ss_top_duration[0].total_duration_sec': {'label': 'TOP SQL 总耗时', 'en': 'Top SQL Duration',
                                              'unit': 's', 'direction': 'up_bad', 'group': 'perf'},
    'ss_top_duration[0].total_cpu_sec': {'label': 'TOP SQL 总 CPU', 'en': 'Top SQL CPU',
                                         'unit': 's', 'direction': 'up_bad', 'group': 'perf'},
    'ss_datafile_free_pct[0].data_free_mb': {'label': '数据文件剩余', 'en': 'Datafile Free',
                                             'unit': 'MB', 'direction': 'up_good', 'group': 'space'},
    'server_uptime[0].uptime_sec': {'label': '实例运行时长', 'en': 'Instance Uptime',
                                    'unit': 's', 'direction': 'neutral', 'group': 'other'},
    'buffer_pool_status[0].size_mb': {'label': '缓冲池大小', 'en': 'Buffer Pool Size',
                                      'unit': 'MB', 'direction': 'neutral', 'group': 'memory'},
    'memory_grant[0].cntr_value': {'label': '内存授予数', 'en': 'Memory Grants',
                                   'unit': '', 'direction': 'up_bad', 'group': 'memory'},
}

#: 单位自动推断（未登记路径用）
_UNIT_HINTS = (
    ('_pct', '%'), ('percent', '%'), ('ratio', '%'),
    ('_mb', 'MB'), ('_gb', 'GB'), ('_kb', 'KB'),
    ('_ms', 'ms'), ('_sec', 's'), ('_hour', 'h'),
)


def _is_skipped_path(path: str) -> bool:
    if path in _SKIP_PATHS:
        return True
    return any(path.startswith(p) for p in _SKIP_PREFIXES)


def _discover_paths(ctx: dict) -> Dict[str, float]:
    """扫描 context_json，产出「单值数值」路径 → 数值（不含多行明细）。"""
    out: Dict[str, float] = {}

    def emit(path: str, value: Any) -> None:
        if _is_skipped_path(path):
            return
        num = _num(value)
        if num is not None:
            out[path] = num

    def visit(node: Any, path: str, depth: int) -> None:
        if depth > 4:
            return
        if isinstance(node, dict):
            for k, v in node.items():
                p = (path + '.' + k) if path else str(k)
                if isinstance(v, (dict, list)):
                    visit(v, p, depth + 1)
                elif str(k).lower() not in _SKIP_FIELD:
                    emit(p, v)
        elif isinstance(node, list):
            if len(node) == 1 and isinstance(node[0], dict):
                for k, v in node[0].items():
                    if isinstance(v, (dict, list)) or str(k).lower() in _SKIP_FIELD:
                        continue
                    emit(path + '[0].' + str(k), v)
            elif len(node) == 1:
                emit(path + '[0]', node[0])

    visit(ctx, '', 0)
    return out


#: 末段字段名过于通用时，显示名需要带上父段（如 buffer_pool_status.pages → Buffer Pool Status Pages）
_GENERIC_TAIL = frozenset({
    'value', 'size', 'size_mb', 'size_kb', 'size_gb', 'count', 'cnt', 'num', 'total',
    'pages', 'rows', 'row_count', 'mb', 'gb', 'kb', 'pct', 'percent', 'ratio',
    'sec', 'secs', 'seconds', 'ms', 'rate', 'max', 'min', 'avg', 'used', 'free', 'time',
})

#: 路径 → 分组推断（未登记指标靠关键词归组，避免全塞进「其他」）
_GROUP_HINTS = (
    ('index', 'index'), ('idx', 'index'),
    ('tablespace', 'space'), ('datafile', 'space'), ('tempdb', 'space'),
    ('db_size', 'space'), ('disk', 'space'), ('space', 'space'), ('capacity', 'space'),
    ('sga', 'memory'), ('pga', 'memory'), ('buffer', 'memory'), ('mem', 'memory'),
    ('swap', 'memory'), ('page_life', 'memory'), ('grant', 'memory'),
    ('connect', 'conn'), ('session', 'conn'), ('thread', 'conn'), ('user', 'conn'),
    ('lock', 'perf'), ('wait', 'perf'), ('cache', 'perf'), ('hit', 'perf'),
    ('qps', 'perf'), ('sql', 'perf'), ('query', 'perf'), ('slow', 'perf'),
    ('batch', 'perf'), ('compil', 'perf'), ('read', 'perf'), ('write', 'perf'),
    ('cpu', 'os'), ('load', 'os'), ('uptime', 'other'),
    ('config', 'config'), ('param', 'config'), ('baseline', 'config'),
    ('invalid', 'config'), ('error', 'config'), ('fail', 'config'),
    ('health', 'health'), ('risk', 'health'), ('score', 'health'),
)


def _auto_label(path: str, lang: str) -> str:
    """未登记路径的显示名：末段字段名；末段为 Value/[0] 时退到父段。"""
    parts = [p for p in path.split('.') if p]
    last = parts[-1] if parts else path
    if last == 'Value' or last.endswith('[0]'):
        base = last.split('[0]')[0]
        if not base and len(parts) >= 2:
            base = parts[-2].split('[0]')[0]
        last = base or last
    name = last.split('[0]')[0].replace('_', ' ').strip()
    if not name:
        return path
    # 末段过于通用（pages/size_mb/count…）时拼上父段，避免一堆同名指标
    if name.lower().replace(' ', '_') in _GENERIC_TAIL and len(parts) >= 2:
        parent = parts[-2].split('[0]')[0].lstrip('_').replace('_', ' ').strip()
        if parent:
            name = parent + ' ' + name
    return name.title()


def _auto_unit(path: str) -> str:
    low = path.lower()
    for hint, unit in _UNIT_HINTS:
        if hint in low:
            return unit
    return ''


def _infer_group(path: str) -> str:
    """按路径关键词推断分组（登记表未给出时用）。"""
    low = path.lower()
    for hint, group in _GROUP_HINTS:
        if hint in low:
            return group
    return 'other'


def _meta_for_path(path: str, lang: str) -> dict:
    """发现指标的元数据：登记表优先，未登记则自动推断（中性、无阈值）。"""
    meta = _DISCOVERED_META.get(path)
    if meta:
        return {
            'label': meta['en'] if lang == 'en' else meta['label'],
            'unit': meta.get('unit', ''),
            'direction': meta.get('direction', 'neutral'),
            'warn': meta.get('warn'), 'crit': meta.get('crit'),
            'group': meta.get('group', 'other'), 'primary': False,
        }
    return {
        'label': _auto_label(path, lang), 'unit': _auto_unit(path),
        'direction': 'neutral', 'warn': None, 'crit': None,
        'group': _infer_group(path), 'primary': False,
    }


def group_label(group: str, lang: str) -> str:
    spec = GROUP_LABELS.get(group) or GROUP_LABELS['other']
    return spec['en'] if lang == 'en' else spec['zh']


#: 指标英文名（注册表只维护中文，英文在此补充，避免 19 条重复维护）
_LABELS_EN: Dict[str, str] = {
    'risk_count': 'Risk Items',
    'health_score': 'Health Score',
    'cpu_usage': 'CPU Usage',
    'mem_usage': 'Memory Usage',
    'disk_usage_max': 'Max Disk Usage',
    'max_tablespace_pct': 'Max Tablespace Usage',
    'db_size_gb': 'Database Size',
    'sga_total_mb': 'SGA Size',
    'total_memory_gb': 'Server Memory',
    'connections': 'Current Connections',
    'connection_usage_pct': 'Connection Usage',
    'cache_hit_ratio': 'Cache Hit Ratio',
    'qps': 'QPS',
    'top_sql_elapsed_sec': 'Top SQL Elapsed',
    'config_critical_count': 'Critical Config Gaps',
    'config_max_gap_pct': 'Max Config Deviation',
    'index_missing': 'Missing Indexes',
    'index_redundant': 'Redundant Indexes',
    'index_unused': 'Unused Indexes',
}

#: 结论文案模板（按语言）
_REASON_TEMPLATES = {
    'zh': {
        'no_data': '暂无历史数据',
        'new': '新增 {n} 项异常',
        'breach': '{names} 突破警戒线',
        'worsening': '{n} 项指标恶化',
        'attention_persistent': '{n} 项异常持续存在',
        'attention_breach': '{n} 项指标超标（{names}）',
        'resolved': '已消除 {n} 项异常',
        'improving': '{n} 项指标改善',
        'stable': '窗口内无新增异常，指标平稳',
        'sep': '，',
    },
    'en': {
        'no_data': 'No historical data',
        'new': '{n} new issue(s) detected',
        'breach': '{names} breached the warning line',
        'worsening': '{n} metric(s) worsening',
        'attention_persistent': '{n} issue(s) persisting',
        'attention_breach': '{n} metric(s) over threshold ({names})',
        'resolved': '{n} issue(s) resolved',
        'improving': '{n} metric(s) improving',
        'stable': 'No new issues; metrics steady',
        'sep': '; ',
    },
}


def _norm_lang(lang: Optional[str]) -> str:
    return 'en' if str(lang or '').lower().startswith('en') else 'zh'


def _label_of(key: str, lang: str) -> str:
    spec = METRIC_BY_KEY.get(key)
    if not spec:
        return key
    return _LABELS_EN.get(key, spec['label']) if lang == 'en' else spec['label']

#: 扁平列 → 指标键（与 snapshots 表列名一致）
_FLAT_METRIC_KEYS = (
    'cpu_usage', 'mem_usage', 'disk_usage_max',
    'connections', 'connection_usage_pct', 'cache_hit_ratio',
    'sga_total_mb', 'max_tablespace_pct', 'risk_count',
)

#: 不做趋势展示的挂载点（与 dal.db_history 保持一致）
_IGNORE_MOUNTS = {'/mnt/iso', '/media', '/run/media', '/iso', '/cdrom'}

#: 全窗口为 0 时仍然有意义的指标（0 表示「无此类问题」，而非「未采集到」）
_ZERO_MEANINGFUL = frozenset({
    'risk_count', 'index_missing', 'index_redundant', 'index_unused', 'config_critical_count',
})

_SEV_HIGH = 3
_SEV_MID = 2
_SEV_LOW = 1
_SEV_NONE = 0


# ═══════════════════════════════════════════════════════════
#  基础工具
# ═══════════════════════════════════════════════════════════

def _num(v: Any) -> Optional[float]:
    """宽松数值化：'86.79'、'86.79%'、'1,024' 均可用；无法解析返回 None。"""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    if isinstance(v, str):
        s = v.strip().replace(',', '')
        if not s:
            return None
        if s.endswith('%'):
            s = s[:-1]
        try:
            f = float(s)
        except ValueError:
            return None
        return None if (math.isnan(f) or math.isinf(f)) else f
    return None


def _first_num(rows: Any, field: str) -> Optional[float]:
    """从 [ {field: x} ] 里取第一个可解析的数值。"""
    if not isinstance(rows, list) or not rows:
        return None
    head = rows[0]
    if not isinstance(head, dict):
        return None
    return _num(head.get(field))


def _pick(rows: Any, field: str, default: Any = None) -> Any:
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return rows[0].get(field, default)
    return default


def _query_rows(ctx: dict, chapter_no: int, query_key: str) -> Optional[dict]:
    """按章节号 + query_key 取 `_oracle_chapter_results` 里的查询结果。"""
    chapters = ctx.get('_oracle_chapter_results')
    if not isinstance(chapters, list):
        return None
    for ch in chapters:
        if not isinstance(ch, dict) or ch.get('chapter_number') != chapter_no:
            continue
        for q in (ch.get('queries_results') or []):
            if isinstance(q, dict) and q.get('query_key') == query_key:
                return q
    return None


def _column_index(q: dict, col_name: str) -> int:
    cols = q.get('columns') or []
    for i, c in enumerate(cols):
        if str(c).strip().upper() == col_name.upper():
            return i
    return -1


def _sev_rank(level: Any, priority: Any = '') -> int:
    blob = (str(level or '') + ' ' + str(priority or '')).lower()
    if '严重' in blob or '高' in blob or 'critical' in blob:
        return _SEV_HIGH
    if '中' in blob or 'medium' in blob:
        return _SEV_MID
    if '低' in blob or '建议' in blob or 'info' in blob or 'low' in blob:
        return _SEV_LOW
    return _SEV_NONE


# ═══════════════════════════════════════════════════════════
#  血缘采集（provenance）
# ═══════════════════════════════════════════════════════════
#  设计约束：**只记录「实际命中」的来源，不做声明式映射**。
#  指标抽取天然是多路合成（表空间既可能来自章节表格、也可能退到 ora_tablespace、
#  最后才退到扁平列），声明式写死来源会让用户按血缘去核对时对不上，整块功能的
#  可信度就崩了。因此每个 source 函数在**真正赋值的那一行**调用 `_hit()`，
#  在**尝试过但没命中的分支**调用 `_miss()`，最终由 `_build_provenance` 取
#  最后一次命中作为主来源，其余按序排成兜底链。
#
#  采集器用线程局部变量承载（source 函数签名保持 (ctx) / (db_type, ctx) 不变，
#  不破坏既有单测）；未开启采集时 `_hit/_miss` 是空操作，零开销。

KIND_CHAPTER_TABLE = 'chapter_table'   # 模板章节查询结果表格
KIND_CTX_LIST = 'ctx_list'             # context 里的列表（含单行表 / 明细表）
KIND_CTX_SCALAR = 'ctx_scalar'         # context 里的标量路径
KIND_FLAT_COLUMN = 'flat_column'       # snapshots 扁平列（历史兜底）
KIND_DERIVED = 'derived'               # 由其他指标推导
KIND_ISSUE_LIST = 'issue_list'         # 规则引擎异常项列表

#: 能直接取到「原始数据」的种类（前端据此决定是否显示「查看原数据」）
RAW_KINDS = frozenset({KIND_CHAPTER_TABLE, KIND_CTX_LIST, KIND_CTX_SCALAR, KIND_ISSUE_LIST})

_AGG_CN = {'max': '最大值', 'min': '最小值', 'first': '首行值', 'last': '末行值',
           'sum': '合计', 'avg': '平均值', 'count': '计数', 'none': '原值'}
_AGG_EN = {'max': 'max', 'min': 'min', 'first': 'first row', 'last': 'last row',
           'sum': 'sum', 'avg': 'average', 'count': 'count', 'none': 'raw'}

_PROV = threading.local()


def _prov_begin() -> dict:
    """开启一次血缘采集（未开启时 _hit/_miss 为空操作）。"""
    data: Dict[str, dict] = {'hits': {}, 'misses': {}}
    _PROV.data = data
    return data


def _prov_end() -> dict:
    data = getattr(_PROV, 'data', None) or {'hits': {}, 'misses': {}}
    _PROV.data = None
    return data


def _prov_on() -> bool:
    return getattr(_PROV, 'data', None) is not None


def _hit(key: str, kind: str, **kw) -> None:
    """记录一次**实际取值命中**：调用点必须是真正把值写进 out[key] 的那一行。"""
    data = getattr(_PROV, 'data', None)
    if data is None:
        return
    desc = {'kind': kind}
    desc.update({k: v for k, v in kw.items() if v is not None})
    data['hits'].setdefault(key, []).append(desc)


def _miss(key: str, kind: str, ref: str, why: str = '') -> None:
    """记录一次「尝试过但未命中」的候选来源，用于拼出真实的兜底链。"""
    data = getattr(_PROV, 'data', None)
    if data is None:
        return
    desc = {'kind': kind, 'ref': ref}
    if why:
        desc['why'] = why
    data['misses'].setdefault(key, []).append(desc)


def _ref_of(desc: dict) -> str:
    """血缘描述 → 一行可读的定位串（前端「来源」标签与兜底链共用）。"""
    kind = desc.get('kind')
    if kind == KIND_CHAPTER_TABLE:
        s = '章节 %s · %s' % (desc.get('chapter'), desc.get('query_key'))
        if desc.get('value_column'):
            s += ' · %s(%s)' % (desc['value_column'], desc.get('agg') or 'none')
        return s
    if kind == KIND_CTX_LIST:
        s = str(desc.get('path') or '')
        if desc.get('filter_field'):
            s += ' [%s=%s]' % (desc['filter_field'], desc.get('filter_value'))
        if desc.get('field'):
            s += ' · %s(%s)' % (desc['field'], desc.get('agg') or 'none')
        elif desc.get('agg') == 'count':
            s += ' · 计数'
        return s
    if kind == KIND_CTX_SCALAR:
        return str(desc.get('path') or '')
    if kind == KIND_FLAT_COLUMN:
        return 'snapshots.%s' % desc.get('column', '')
    if kind == KIND_ISSUE_LIST:
        return str(desc.get('path') or 'auto_analyze')
    if kind == KIND_DERIVED:
        return str(desc.get('formula') or '派生')
    return kind or ''


def _explain(desc: dict, lang: str = 'zh') -> str:
    """把血缘描述翻成一句人话，直接展示给用户（说清数字怎么来的）。"""
    kind = desc.get('kind')
    zh = _norm_lang(lang) == 'zh'

    def _rows_txt(total, idx):
        if total is None:
            return ''
        if idx is None:
            return ('（共 %s 行）' % total) if zh else (' (%s rows)' % total)
        return ('（共 %s 行，命中第 %s 行）' % (total, idx + 1)) if zh else \
               (' (%s rows, hit row %s)' % (total, idx + 1))

    if kind == KIND_CHAPTER_TABLE:
        agg = (_AGG_CN if zh else _AGG_EN).get(desc.get('agg') or 'none', '')
        tail = _rows_txt(desc.get('rows'), desc.get('row_index'))
        if zh:
            s = '取章节 %s 的 %s 查询结果，按 %s 取%s%s' % (
                desc.get('chapter'), desc.get('query_key'),
                desc.get('value_column'), agg, tail)
            if desc.get('row_label'):
                s += '，命中行「%s」' % desc['row_label']
            return s
        s = 'From chapter %s query %s, %s of %s%s' % (
            desc.get('chapter'), desc.get('query_key'), agg,
            desc.get('value_column'), tail)
        if desc.get('row_label'):
            s += ', hit row "%s"' % desc['row_label']
        return s

    if kind == KIND_CTX_LIST:
        if (desc.get('agg') or '') == 'count':
            if zh:
                s = '统计 %s 的记录条数' % desc.get('path')
                if desc.get('filter_field'):
                    s += '（筛选 %s = %s）' % (desc['filter_field'], desc.get('filter_value'))
                return s + _rows_txt(desc.get('rows'), None)
            s = 'Count of %s' % desc.get('path')
            if desc.get('filter_field'):
                s += ' where %s = %s' % (desc['filter_field'], desc.get('filter_value'))
            return s + _rows_txt(desc.get('rows'), None)
        agg = (_AGG_CN if zh else _AGG_EN).get(desc.get('agg') or 'none', '')
        if zh:
            return '取 %s 的 %s 字段%s%s' % (
                desc.get('path'), desc.get('field'), agg,
                _rows_txt(desc.get('rows'), desc.get('row_index')))
        return '%s of %s.%s%s' % (
            agg, desc.get('path'), desc.get('field'),
            _rows_txt(desc.get('rows'), desc.get('row_index')))

    if kind == KIND_CTX_SCALAR:
        return ('直接读取 %s' % desc.get('path')) if zh else ('Read from %s' % desc.get('path'))

    if kind == KIND_FLAT_COLUMN:
        if zh:
            return ('来自快照扁平列 %s —— 未匹配到原始采集结构，可能是历史兜底值，建议核对'
                    % desc.get('column'))
        return ('From flat column %s — no raw collector structure matched; treat as fallback'
                % desc.get('column'))

    if kind == KIND_ISSUE_LIST:
        if zh:
            return '由本次快照的规则引擎异常项（auto_analyze）汇总得出'
        return 'Aggregated from the rule-engine issues (auto_analyze) of this snapshot'

    if kind == KIND_DERIVED:
        return str(desc.get('formula') or ('派生指标' if zh else 'Derived metric'))

    return ''


# ── 原始数据定位 ─────────────────────────────────────────────

def _walk_path(ctx: Any, path: str) -> Any:
    """按 'a.b[0].c' 形式的路径取值；任一段缺失返回 None。"""
    node = ctx
    for seg in str(path or '').split('.'):
        if not seg:
            continue
        idx = None
        if seg.endswith(']') and '[' in seg:
            base, _, rest = seg.partition('[')
            try:
                idx = int(rest[:-1])
            except ValueError:
                idx = None
            seg = base
        if seg:
            if not isinstance(node, dict):
                return None
            node = node.get(seg)
        if idx is not None:
            if not isinstance(node, list) or len(node) <= idx:
                return None
            node = node[idx]
    return node


def _parent_path(path: str) -> str:
    segs = [s for s in str(path or '').split('.') if s]
    return '.'.join(segs[:-1])


def _dict_rows(rows: List[Any]) -> tuple:
    """把「行是 dict」的列表摊平成 (columns, data)。行不是 dict 时返回 ([], [])。"""
    if not rows or not isinstance(rows[0], dict):
        return [], []
    cols: List[str] = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        for k in r.keys():
            if k not in cols:
                cols.append(k)
    data = [[r.get(c) for c in cols] if isinstance(r, dict) else [] for r in rows]
    return cols, data


def resolve_raw(ctx: dict, origin: dict, offset: int = 0, limit: int = 100) -> dict:
    """按血缘描述从 context_json 里取出**原始数据**（分页 + 命中行定位）。

    只回裁剪后的表/标量，绝不把整份 context_json（实测 460~560 KB）下发。
    """
    kind = (origin or {}).get('kind')
    out: Dict[str, Any] = {
        'view': 'scalar', 'columns': [], 'rows': [], 'total': 0, 'returned': 0,
        'truncated': False, 'col_offset': 0, 'highlight_row': None, 'highlight_col': None,
        'collect_error': None, 'note': '', 'siblings': None,
    }
    limit = max(1, min(int(limit or 100), 500))
    offset = max(0, int(offset or 0))

    if kind == KIND_CHAPTER_TABLE:
        q = _query_rows(ctx, origin.get('chapter'), origin.get('query_key'))
        if not q:
            out['note'] = 'collect_missing'
            return out
        if q.get('error'):
            out['collect_error'] = str(q['error'])
        cols = list(q.get('columns') or [])
        data = list(q.get('data') or [])
        out.update({'view': 'table', 'columns': cols, 'total': len(data)})
        out['rows'] = [list(r) if isinstance(r, (list, tuple)) else [r]
                       for r in data[offset:offset + limit]]
        out['returned'] = len(out['rows'])
        out['truncated'] = (offset + out['returned']) < out['total']
        out['highlight_row'] = origin.get('row_index')
        out['highlight_col'] = _column_index(q, origin.get('value_column') or '')
        return out

    if kind == KIND_CTX_LIST:
        node = _walk_path(ctx, origin.get('path'))
        # 路径可能停在 dict 上（如 ora_sessions[0] 是单行表）→ 当成单行列表处理
        if isinstance(node, dict):
            node = [node]
        if not isinstance(node, list):
            out['note'] = 'collect_missing'
            return out
        rows = list(node)
        ff, fv = origin.get('filter_field'), origin.get('filter_value')
        filtered = False
        if ff:
            before = len(rows)
            rows = [r for r in rows if isinstance(r, dict)
                    and str(r.get(ff) or '').lower() == str(fv or '').lower()]
            filtered = True
            out['filter'] = {'field': ff, 'value': fv, 'before': before, 'after': len(rows)}
        cols, data = _dict_rows(rows)
        if not cols:
            # 行不是 dict（如纯量列表）：退回单列展示
            cols = [origin.get('field') or 'value']
            data = [[r] for r in rows]
        out.update({'view': 'table', 'columns': cols, 'total': len(data)})
        out['rows'] = data[offset:offset + limit]
        out['returned'] = len(out['rows'])
        out['truncated'] = (offset + out['returned']) < out['total']
        # 筛选会打乱下标，此时不再给出行高亮（列高亮仍然有效）
        out['highlight_row'] = None if filtered else origin.get('row_index')
        hc = origin.get('field')
        if hc and hc in cols:
            out['highlight_col'] = cols.index(hc)
        return out

    if kind == KIND_ISSUE_LIST:
        issues = extract_issues(ctx)
        cols = ['col1', 'col2', 'col3', 'col4', 'fix_sql']
        data = [[i.get('name'), i.get('level'), i.get('description'),
                 '', i.get('fix_sql')] for i in issues]
        out.update({'view': 'issues', 'columns': cols, 'total': len(data)})
        out['rows'] = data[offset:offset + limit]
        out['returned'] = len(out['rows'])
        out['truncated'] = (offset + out['returned']) < out['total']
        return out

    if kind == KIND_CTX_SCALAR:
        path = origin.get('path') or ''
        val = _walk_path(ctx, path)
        if isinstance(val, str) and ('\n' in val or len(val) > 120):
            out.update({'view': 'text', 'columns': [path], 'rows': [[val]], 'total': 1,
                        'returned': 1})
            return out
        out.update({'view': 'scalar', 'columns': ['path', 'value'],
                    'rows': [[path, val]], 'total': 1, 'returned': 1})
        if isinstance(ctx, dict) and origin.get('parent') is not False:
            parent = _walk_path(ctx, _parent_path(path))
            if isinstance(parent, dict):
                pcols, pdata = _dict_rows([parent])
                keys = [c for c in pcols if c != path.split('.')[-1]]
                sib = {'columns': keys[:24],
                       'rows': [[parent.get(c) for c in keys[:24]]], 'total': len(keys)}
                out['siblings'] = sib
        return out

    if kind == KIND_FLAT_COLUMN:
        out.update({'view': 'scalar', 'columns': ['column', 'value'],
                    'rows': [[origin.get('column'), origin.get('picked')]], 'total': 1,
                    'returned': 1, 'note': 'flat_fallback'})
        return out

    if kind == KIND_DERIVED:
        # 派生指标没有物理采样点：把「口径」当成一行原数据展示，避免空白卡片
        out.update({'view': 'scalar', 'columns': ['formula', 'value'],
                    'rows': [[origin.get('formula') or '', origin.get('picked')]],
                    'total': 1, 'returned': 1, 'note': 'derived_only'})
        return out

    # 未知种类：只有口径说明，没有物理原数据
    out['note'] = 'derived_only'
    return out


def _build_provenance(key: str, prov: dict, lang: str = 'zh') -> Optional[dict]:
    """把采集到的命中/未命中整理成前端可用的血缘对象（含兜底链）。"""
    hits = (prov.get('hits') or {}).get(key) or []
    if not hits:
        return None
    misses = (prov.get('misses') or {}).get(key) or []

    chain: List[dict] = []
    # 主来源放首位（用户先看"这个数从哪来"），其余按「实际尝试过的备选 → 未命中项」排后
    for i, h in enumerate(hits):
        item = dict(h)
        item['matched'] = (i == len(hits) - 1)   # 最后一次命中即最终生效来源
        item['probe_order'] = i
        item['ref'] = _ref_of(item)
        chain.append(item)
    chain.sort(key=lambda x: (0 if x['matched'] else 1, x.get('probe_order', 0)))
    for m in misses:
        item = dict(m)
        item['matched'] = False
        item['ref'] = m.get('ref') or _ref_of(item)
        chain.append(item)

    winner = dict(hits[-1])
    return {
        'key': key,
        'kind': winner.get('kind'),
        'origin': winner,
        'chain': chain,
        'explain': _explain(winner, lang),
        'raw_kind': winner.get('kind') if winner.get('kind') in RAW_KINDS else None,
        'has_raw': winner.get('kind') in RAW_KINDS,
        'available': (winner.get('kind') != KIND_FLAT_COLUMN),
    }


# ═══════════════════════════════════════════════════════════
#  指标抽取
# ═══════════════════════════════════════════════════════════

def _os_metrics(ctx: dict) -> dict:
    """操作系统层指标（CPU / 内存 / 磁盘最大使用率 / 服务器内存）。

    数据源优先级：`system_info`（各方言通用）→ `_oracle_os_data`（Oracle 专用镜像）。
    两者字段名不同，且空字符串代表「未采集」，`_num('')` 会自然过滤掉。
    """
    out: Dict[str, Optional[float]] = {
        'cpu_usage': None, 'mem_usage': None, 'disk_usage_max': None, 'total_memory_gb': None,
    }
    si = ctx.get('system_info')
    if not isinstance(si, dict):
        si = {}
    # 兼容两种写法：cpu 为 dict{'usage_percent'} 或直接是数值
    cpu = si.get('cpu')
    if isinstance(cpu, dict):
        out['cpu_usage'] = _num(cpu.get('usage_percent'))
        if out['cpu_usage'] is not None:
            _hit('cpu_usage', KIND_CTX_SCALAR, path='system_info.cpu.usage_percent',
                 picked=out['cpu_usage'])
        else:
            _miss('cpu_usage', KIND_CTX_SCALAR, 'system_info.cpu.usage_percent', '值为空')
    else:
        out['cpu_usage'] = _num(cpu)
        if out['cpu_usage'] is not None:
            _hit('cpu_usage', KIND_CTX_SCALAR, path='system_info.cpu', picked=out['cpu_usage'])

    mem = si.get('memory')
    if isinstance(mem, dict):
        out['mem_usage'] = _num(mem.get('usage_percent'))
        if out['mem_usage'] is not None:
            _hit('mem_usage', KIND_CTX_SCALAR, path='system_info.memory.usage_percent',
                 picked=out['mem_usage'])
        else:
            _miss('mem_usage', KIND_CTX_SCALAR, 'system_info.memory.usage_percent', '值为空')
        total_mb = _num(mem.get('total_mb'))
        if total_mb:
            out['total_memory_gb'] = round(total_mb / 1024.0, 2)
            _hit('total_memory_gb', KIND_CTX_SCALAR, path='system_info.memory.total_mb',
                 picked=out['total_memory_gb'], raw_value=total_mb, unit_note='MB → GB')
    else:
        out['mem_usage'] = _num(mem)
        if out['mem_usage'] is not None:
            _hit('mem_usage', KIND_CTX_SCALAR, path='system_info.memory', picked=out['mem_usage'])

    # Oracle 采集器把 OS 数据另存一份（_oracle_os_data），作为 system_info 的兜底
    oos = ctx.get('_oracle_os_data')
    if isinstance(oos, dict):
        if out['cpu_usage'] is None:
            out['cpu_usage'] = _num(oos.get('cpu_usage_pct'))
            if out['cpu_usage'] is not None:
                _hit('cpu_usage', KIND_CTX_SCALAR, path='_oracle_os_data.cpu_usage_pct',
                     picked=out['cpu_usage'])
            else:
                _miss('cpu_usage', KIND_CTX_SCALAR, '_oracle_os_data.cpu_usage_pct', '值为空')
        if out['mem_usage'] is None:
            out['mem_usage'] = _num(oos.get('mem_usage_pct'))
            if out['mem_usage'] is not None:
                _hit('mem_usage', KIND_CTX_SCALAR, path='_oracle_os_data.mem_usage_pct',
                     picked=out['mem_usage'])
            else:
                _miss('mem_usage', KIND_CTX_SCALAR, '_oracle_os_data.mem_usage_pct', '值为空')
        if out['total_memory_gb'] is None:
            total_mb = _num(oos.get('mem_total_mb'))
            if total_mb:
                out['total_memory_gb'] = round(total_mb / 1024.0, 2)
                _hit('total_memory_gb', KIND_CTX_SCALAR, path='_oracle_os_data.mem_total_mb',
                     picked=out['total_memory_gb'], raw_value=total_mb, unit_note='MB → GB')
            else:
                _miss('total_memory_gb', KIND_CTX_SCALAR, '_oracle_os_data.mem_total_mb',
                      '值为空')
    else:
        for _k, _p in (('cpu_usage', 'system_info.cpu.usage_percent'),
                       ('mem_usage', 'system_info.memory.usage_percent')):
            if out[_k] is None:
                _miss(_k, KIND_CTX_SCALAR, _p, 'context 无 _oracle_os_data 兜底')

    pct_max = None
    max_row = None
    disks = si.get('disk_list')
    if isinstance(disks, list):
        for i, d in enumerate(disks):
            if not isinstance(d, dict):
                continue
            mp = d.get('mountpoint', '/')
            if mp in _IGNORE_MOUNTS:
                continue
            pct = _num(d.get('usage_percent'))
            if pct is not None and (pct_max is None or pct > pct_max):
                pct_max, max_row = pct, i
    if pct_max is not None:
        _hit('disk_usage_max', KIND_CTX_LIST, path='system_info.disk_list',
             field='usage_percent', agg='max', row_index=max_row,
             rows=len(disks) if isinstance(disks, list) else None, picked=pct_max)
    # SSH 采集器格式：disk_usage 为 df 输出文本
    if pct_max is None:
        raw = si.get('disk_usage')
        if isinstance(raw, str) and raw:
            for line in raw.splitlines():
                parts = line.strip().split()
                if len(parts) >= 5:
                    pct = _num(parts[4])
                    if pct is not None and parts[-1] not in _IGNORE_MOUNTS:
                        if pct_max is None or pct > pct_max:
                            pct_max = pct
            if pct_max is not None:
                _hit('disk_usage_max', KIND_CTX_SCALAR, path='system_info.disk_usage',
                     picked=pct_max, unit_note='df 文本解析（取最大挂载点使用率）')
            else:
                _miss('disk_usage_max', KIND_CTX_SCALAR, 'system_info.disk_usage', '文本无有效行')
    if pct_max is None:
        _miss('disk_usage_max', KIND_CTX_LIST, 'system_info.disk_list[].usage_percent', '无有效挂载点')
    out['disk_usage_max'] = pct_max
    return out


def _baseline_metrics(ctx: dict) -> dict:
    """配置基线偏差（MySQL / PostgreSQL / SQL Server / TiDB 的 `baseline_results`）。

    Oracle 走 `_oracle_config_baseline`，结构不同，由 `_config_metrics` 处理。
    `baseline_results` 每条含 status(OK/ERROR/FAIL) 与 risk_level(LOW/MEDIUM/HIGH/CRITICAL)，
    以 risk_level 为准统计严重项，避免把「低风险但未达标」算成严重。
    """
    out: Dict[str, Optional[float]] = {'config_critical_count': None}
    rows = ctx.get('baseline_results')
    if not isinstance(rows, list) or not rows:
        _miss('config_critical_count', KIND_CTX_LIST, 'baseline_results', '无基线结果列表')
        return out
    crit = 0
    for it in rows:
        if not isinstance(it, dict):
            continue
        if str(it.get('risk_level') or '').strip().upper() in ('CRITICAL', 'HIGH'):
            crit += 1
    out['config_critical_count'] = float(crit)
    _hit('config_critical_count', KIND_CTX_LIST, path='baseline_results', agg='count',
         rows=len(rows), picked=float(crit),
         filter_field='risk_level', filter_value='CRITICAL/HIGH')
    return out


def _capacity_metrics(ctx: dict) -> dict:
    """容量与索引规模（MySQL / TiDB / PostgreSQL 通用结构）。"""
    out: Dict[str, Optional[float]] = {'db_size_gb': None, 'index_unused': None}

    rows = ctx.get('db_size')
    if isinstance(rows, list) and rows:
        total_mb = 0.0
        hit = False
        for it in rows:
            if not isinstance(it, dict):
                continue
            mb = _num(it.get('total_mb'))
            if mb is not None:
                total_mb += mb
                hit = True
        if hit:
            out['db_size_gb'] = round(total_mb / 1024.0, 3)
            _hit('db_size_gb', KIND_CTX_LIST, path='db_size', field='total_mb', agg='sum',
                 rows=len(rows), picked=out['db_size_gb'], raw_value=total_mb, unit_note='MB → GB')

    unused = ctx.get('unused_indexes')
    if isinstance(unused, list) and unused:
        out['index_unused'] = float(len(unused))
        _hit('index_unused', KIND_CTX_LIST, path='unused_indexes', agg='count',
             rows=len(unused), picked=out['index_unused'])
    return out


def _space_metrics(ctx: dict) -> dict:
    """表空间最大使用率 + 数据库容量。

    优先取 `_oracle_chapter_results` 的 tablespace_usage 表格（实测最可靠），
    退化到 `ora_tablespace` / `_oracle_config_baseline`。
    """
    out: Dict[str, Optional[float]] = {'max_tablespace_pct': None, 'db_size_gb': None}

    q = _query_rows(ctx, 2, 'tablespace_usage')
    if q:
        idx = _column_index(q, 'USED_PERCENT')
        if idx >= 0:
            best = None
            best_row = None
            rows = q.get('data') or []
            for i, row in enumerate(rows):
                if not isinstance(row, (list, tuple)) or len(row) <= idx:
                    continue
                pct = _num(row[idx])
                if pct is not None and (best is None or pct > best):
                    best, best_row = pct, i
            out['max_tablespace_pct'] = best
            if best is not None:
                # 命中行的首列就是"是谁贡献的最大值"（如表空间名），直接带回前端高亮
                _row = rows[best_row] if isinstance(rows[best_row], (list, tuple)) else None
                _hit('max_tablespace_pct', KIND_CHAPTER_TABLE, chapter=2,
                     query_key='tablespace_usage', value_column='USED_PERCENT', agg='max',
                     row_index=best_row, rows=len(rows), picked=best,
                     row_label=(str(_row[0]) if _row else None))
            else:
                _miss('max_tablespace_pct', KIND_CHAPTER_TABLE, '章节 2 · tablespace_usage',
                      'USED_PERCENT 列无有效值')
        else:
            _miss('max_tablespace_pct', KIND_CHAPTER_TABLE, '章节 2 · tablespace_usage',
                  '结果中无 USED_PERCENT 列')
    else:
        _miss('max_tablespace_pct', KIND_CHAPTER_TABLE, '章节 2 · tablespace_usage',
              '本次巡检未执行该章节查询')

    if out['max_tablespace_pct'] is None:
        ts_list = ctx.get('ora_tablespace')
        if isinstance(ts_list, list) and ts_list:
            best = None
            best_row = None
            used_field = None
            for i, ts in enumerate(ts_list):
                if not isinstance(ts, dict):
                    continue
                v = _num(ts.get('USED_PCT_WITH_MAXEXT'))
                if v is not None:
                    used_field = 'USED_PCT_WITH_MAXEXT'
                else:
                    v = _num(ts.get('USED_PCT'))
                    if v is not None and used_field is None:
                        used_field = 'USED_PCT'
                if v is not None and (best is None or v > best):
                    best, best_row = v, i
            if best is not None:
                out['max_tablespace_pct'] = best
                _hit('max_tablespace_pct', KIND_CTX_LIST, path='ora_tablespace',
                     field=used_field or 'USED_PCT_WITH_MAXEXT', agg='max',
                     row_index=best_row, rows=len(ts_list), picked=best)
            else:
                _miss('max_tablespace_pct', KIND_CTX_LIST, 'ora_tablespace', '无有效使用率字段')

    cb = ctx.get('_oracle_config_baseline')
    if isinstance(cb, dict):
        out['db_size_gb'] = _num(cb.get('db_size_gb'))
        if out['db_size_gb'] is not None:
            _hit('db_size_gb', KIND_CTX_SCALAR, path='_oracle_config_baseline.db_size_gb',
                 picked=out['db_size_gb'])
        else:
            _miss('db_size_gb', KIND_CTX_SCALAR, '_oracle_config_baseline.db_size_gb', '值为空')
    return out


def _config_metrics(ctx: dict) -> dict:
    """配置基线偏差（Oracle `_oracle_config_baseline.items`）。"""
    out: Dict[str, Optional[float]] = {
        'config_critical_count': None, 'config_max_gap_pct': None, 'total_memory_gb': None,
    }
    cb = ctx.get('_oracle_config_baseline')
    if not isinstance(cb, dict):
        return out
    out['total_memory_gb'] = _num(cb.get('total_memory_gb'))
    if out['total_memory_gb'] is not None:
        _hit('total_memory_gb', KIND_CTX_SCALAR,
             path='_oracle_config_baseline.total_memory_gb', picked=out['total_memory_gb'])
    items = cb.get('items')
    if isinstance(items, list) and items:
        crit = 0
        crit_rows = []
        gap_max = None
        gap_row = None
        for i, it in enumerate(items):
            if not isinstance(it, dict):
                continue
            sev = str(it.get('severity') or '').lower()
            if sev in ('critical', '严重'):
                crit += 1
                crit_rows.append(i)
            gap = _num(it.get('gap_pct'))
            if gap is not None and (gap_max is None or gap > gap_max):
                gap_max, gap_row = gap, i
        out['config_critical_count'] = float(crit)
        _hit('config_critical_count', KIND_CTX_LIST, path='_oracle_config_baseline.items',
             agg='count', rows=len(items), picked=float(crit),
             filter_field='severity', filter_value='critical')
        out['config_max_gap_pct'] = gap_max
        if gap_max is not None:
            _hit('config_max_gap_pct', KIND_CTX_LIST, path='_oracle_config_baseline.items',
                 field='gap_pct', agg='max', row_index=gap_row, rows=len(items), picked=gap_max)
        else:
            _miss('config_max_gap_pct', KIND_CTX_LIST, '_oracle_config_baseline.items.gap_pct',
                  '无有效偏差值')
    else:
        _miss('config_critical_count', KIND_CTX_LIST, '_oracle_config_baseline.items', '无配置项列表')
    return out


def _index_metrics(ctx: dict) -> dict:
    """索引健康（Oracle `_oracle_index_health.summary`）。"""
    out: Dict[str, Optional[float]] = {
        'index_missing': None, 'index_redundant': None, 'index_unused': None,
    }
    ih = ctx.get('_oracle_index_health')
    if not isinstance(ih, dict):
        _miss('index_missing', KIND_CTX_SCALAR, '_oracle_index_health', '本次巡检无索引健康数据')
        return out
    summary = ih.get('summary')
    if isinstance(summary, dict):
        for key, fld in (('index_missing', 'missing_count'),
                         ('index_redundant', 'redundant_count'),
                         ('index_unused', 'unused_count')):
            out[key] = _num(summary.get(fld))
            if out[key] is not None:
                _hit(key, KIND_CTX_SCALAR, path='_oracle_index_health.summary.' + fld,
                     picked=out[key])
    # 退化：直接从明细列表取长度
    for key, src in (('index_missing', 'missing_indexes'), ('index_redundant', 'redundant_indexes'),
                     ('index_unused', 'unused_indexes')):
        if out[key] is None and isinstance(ih.get(src), list):
            out[key] = float(len(ih[src]))
            _hit(key, KIND_CTX_LIST, path='_oracle_index_health.' + src, agg='count',
                 rows=len(ih[src]), picked=out[key])
    return out


def _perf_metrics(ctx: dict) -> dict:
    """性能类：QPS 与 TOP SQL 耗时。"""
    out: Dict[str, Optional[float]] = {'qps': None, 'top_sql_elapsed_sec': None}
    cb = ctx.get('_oracle_config_baseline')
    if isinstance(cb, dict):
        out['qps'] = _num(cb.get('qps'))
        if out['qps'] is not None:
            _hit('qps', KIND_CTX_SCALAR, path='_oracle_config_baseline.qps', picked=out['qps'])
    q = _query_rows(ctx, 13, 'top_sql_elapsed')
    if q:
        idx = _column_index(q, 'ELAPSED_SEC')
        if idx >= 0:
            best = None
            best_row = None
            rows = q.get('data') or []
            for i, row in enumerate(rows):
                if isinstance(row, (list, tuple)) and len(row) > idx:
                    v = _num(row[idx])
                    if v is not None and (best is None or v > best):
                        best, best_row = v, i
            out['top_sql_elapsed_sec'] = best
            if best is not None:
                row_label = None
                if isinstance(rows[best_row], (list, tuple)) and rows[best_row]:
                    row_label = str(rows[best_row][0])[:80]
                _hit('top_sql_elapsed_sec', KIND_CHAPTER_TABLE, chapter=13,
                     query_key='top_sql_elapsed', value_column='ELAPSED_SEC', agg='max',
                     row_index=best_row, rows=len(rows), picked=best, row_label=row_label)
            else:
                _miss('top_sql_elapsed_sec', KIND_CHAPTER_TABLE, '章节 13 · top_sql_elapsed',
                      'ELAPSED_SEC 列无有效值')
        else:
            _miss('top_sql_elapsed_sec', KIND_CHAPTER_TABLE, '章节 13 · top_sql_elapsed',
                  '结果中无 ELAPSED_SEC 列')
    else:
        _miss('top_sql_elapsed_sec', KIND_CHAPTER_TABLE, '章节 13 · top_sql_elapsed',
              '本次巡检未执行该章节查询')
    return out


#: db_type 方言别名 → 趋势引擎内部键
_DB_ALIASES = {
    'pg': 'postgresql', 'postgres': 'postgresql', 'postgresql': 'postgresql',
    'oracle': 'oracle', 'oracle_full': 'oracle', 'oracle_jdbc': 'oracle',
    'sqlserver': 'sqlserver', 'sqlserver_jdbc': 'sqlserver',
    'dm': 'dm', 'dm8': 'dm',
}


def _norm_db(db_type: str) -> str:
    """把各处的 db_type 别名收敛成趋势引擎的方言键。

    目标项目里同一个数据库会有多种写法：历史快照存 'oracle_full'（脚本入口）、
    新巡检存 'oracle'/'pg'/'dm'（Web 入口），报告文件名前缀解析出 'postgresql'。
    不收敛就会导致方言指标取不到、报告反查失败。
    """
    from modules.driver_registry import normalize_db_type
    dt = (normalize_db_type(db_type) or '').strip().lower()
    return _DB_ALIASES.get(dt, dt)


def _dialect_metrics(db_type: str, ctx: dict) -> dict:
    """各数据库方言的专属指标。"""
    dt = _norm_db(db_type)
    out: Dict[str, Optional[float]] = {}

    if dt in ('mysql', 'tidb'):
        out['connections'] = _first_num(ctx.get('threads_connected'), 'Value')
        if out['connections'] is not None:
            _hit('connections', KIND_CTX_LIST, path='threads_connected[0]', field='Value',
                 agg='first', row_index=0, rows=1, picked=out['connections'])
        out['connection_usage_pct'] = None
        max_conn = _first_num(ctx.get('max_connections'), 'Value')
        used = _first_num(ctx.get('max_used_connections'), 'Value')
        if max_conn and used is not None:
            out['connection_usage_pct'] = round(used / max_conn * 100, 2)
            _hit('connection_usage_pct', KIND_DERIVED,
                 formula='max_used_connections.Value / max_connections.Value × 100',
                 picked=out['connection_usage_pct'],
                 inputs=['max_used_connections[0].Value', 'max_connections[0].Value'])
        out['cache_hit_ratio'] = _num(ctx.get('cache_hit_ratio_pct'))
        if out['cache_hit_ratio'] is not None:
            _hit('cache_hit_ratio', KIND_CTX_SCALAR, path='cache_hit_ratio_pct',
                 picked=out['cache_hit_ratio'])
    elif dt == 'postgresql':
        out['connections'] = _first_num(ctx.get('pg_connections'), 'used_connections')
        if out['connections'] is not None:
            _hit('connections', KIND_CTX_LIST, path='pg_connections[0]',
                 field='used_connections', agg='first', row_index=0, rows=1,
                 picked=out['connections'])
        out['cache_hit_ratio'] = _first_num(ctx.get('pg_cache_hit'), 'cache_hit_ratio')
        if out['cache_hit_ratio'] is not None:
            _hit('cache_hit_ratio', KIND_CTX_LIST, path='pg_cache_hit[0]',
                 field='cache_hit_ratio', agg='first', row_index=0, rows=1,
                 picked=out['cache_hit_ratio'])
        max_conn = _first_num(ctx.get('pg_connections'), 'max_connections')
        if max_conn and out.get('connections') is not None:
            out['connection_usage_pct'] = round(out['connections'] / max_conn * 100, 2)
            _hit('connection_usage_pct', KIND_DERIVED,
                 formula='pg_connections.used_connections / pg_connections.max_connections × 100',
                 picked=out['connection_usage_pct'],
                 inputs=['pg_connections[0].used_connections', 'pg_connections[0].max_connections'])
    elif dt in ('oracle', 'oracle_full'):
        out['connections'] = _first_num(ctx.get('ora_sessions'), 'TOTAL_SESSIONS')
        if out['connections'] is not None:
            _hit('connections', KIND_CTX_LIST, path='ora_sessions[0]',
                 field='TOTAL_SESSIONS', agg='first', row_index=0, rows=1,
                 picked=out['connections'])
        out['sga_total_mb'] = _first_num(ctx.get('ora_sga_total'), 'SGA_TOTAL_MB')
        if out['sga_total_mb'] is not None:
            _hit('sga_total_mb', KIND_CTX_LIST, path='ora_sga_total[0]', field='SGA_TOTAL_MB',
                 agg='first', row_index=0, rows=1, picked=out['sga_total_mb'])
        sess = _pick(ctx.get('ora_sessions'), 'TOTAL_SESSIONS')
        limit = _pick(ctx.get('ora_session_limit'), 'SESSIONS_LIMIT')
        sess_n, limit_n = _num(sess), _num(limit)
        if limit_n and sess_n is not None:
            out['connection_usage_pct'] = round(sess_n / limit_n * 100, 2)
            _hit('connection_usage_pct', KIND_DERIVED,
                 formula='ora_sessions.TOTAL_SESSIONS / ora_session_limit.SESSIONS_LIMIT × 100',
                 picked=out['connection_usage_pct'],
                 inputs=['ora_sessions[0].TOTAL_SESSIONS', 'ora_session_limit[0].SESSIONS_LIMIT'])
    elif dt == 'dm':
        out['connections'] = _first_num(ctx.get('dm_sessions'), 'TOTAL_SESSIONS')
        if out['connections'] is not None:
            _hit('connections', KIND_CTX_LIST, path='dm_sessions[0]', field='TOTAL_SESSIONS',
                 agg='first', row_index=0, rows=1, picked=out['connections'])
        out['sga_total_mb'] = _first_num(ctx.get('dm_sga_total'), 'SGA_TOTAL_MB')
        if out['sga_total_mb'] is not None:
            _hit('sga_total_mb', KIND_CTX_LIST, path='dm_sga_total[0]', field='SGA_TOTAL_MB',
                 agg='first', row_index=0, rows=1, picked=out['sga_total_mb'])
        ts_list = ctx.get('dm_tablespace')
        if isinstance(ts_list, list) and ts_list:
            best = None
            best_row = None
            for i, t in enumerate(ts_list):
                if not isinstance(t, dict):
                    continue
                v = _num(t.get('USED_PCT'))
                if v is not None and (best is None or v > best):
                    best, best_row = v, i
            if best is not None:
                out['max_tablespace_pct'] = best
                _hit('max_tablespace_pct', KIND_CTX_LIST, path='dm_tablespace',
                     field='USED_PCT', agg='max', row_index=best_row, rows=len(ts_list),
                     picked=best)
    elif dt == 'sqlserver':
        conn_rows = ctx.get('connections')
        if isinstance(conn_rows, list) and conn_rows and isinstance(conn_rows[0], dict):
            head = conn_rows[0]
            out['connections'] = _num(head.get('connection_count'))
            if out['connections'] is not None:
                _hit('connections', KIND_CTX_LIST, path='connections[0]',
                     field='connection_count', agg='first', row_index=0, rows=1,
                     picked=out['connections'])
            out['connection_usage_pct'] = _num(head.get('connection_usage_pct'))
            if out['connection_usage_pct'] is not None:
                _hit('connection_usage_pct', KIND_CTX_LIST, path='connections[0]',
                     field='connection_usage_pct', agg='first', row_index=0, rows=1,
                     picked=out['connection_usage_pct'])
        host = ctx.get('host')
        if isinstance(host, dict):
            out['mem_usage'] = _num(host.get('memory_percent'))
            if out['mem_usage'] is not None:
                _hit('mem_usage', KIND_CTX_SCALAR, path='host.memory_percent',
                     picked=out['mem_usage'])

    return {k: v for k, v in out.items() if v is not None}


def _merge_metrics(db_type: str, flat: dict, ctx: dict) -> Dict[str, Optional[float]]:
    """合成一次快照的指标集合（含血缘采集：每个赋值点都会 _hit）。"""
    merged: Dict[str, Optional[float]] = {k: None for k in METRIC_BY_KEY}

    for k in _FLAT_METRIC_KEYS:
        merged[k] = _num(flat.get(k))
        if merged[k] is not None:
            # 扁平列是最底层兜底：后面的 context 解析若命中会覆盖它
            _hit(k, KIND_FLAT_COLUMN, column=k, picked=merged[k])

    sources = (_os_metrics(ctx), _space_metrics(ctx), _config_metrics(ctx),
               _index_metrics(ctx), _perf_metrics(ctx),
               _baseline_metrics(ctx), _capacity_metrics(ctx),
               _dialect_metrics(db_type, ctx))
    for src in sources:
        for k, v in (src or {}).items():
            if v is not None and k in merged:
                merged[k] = v

    # 连接使用率：从当前连接数与上限推导（当方言分支没给出时）
    if merged.get('connection_usage_pct') is None:
        cur = _num(flat.get('connections'))
        cap = _num(flat.get('max_used_connections')) or _num(flat.get('max_connections'))
        if cur is not None and cap:
            merged['connection_usage_pct'] = round(cur / cap * 100, 2)
            _hit('connection_usage_pct', KIND_DERIVED,
                 formula='当前连接数 / (max_used_connections 或 max_connections) × 100',
                 picked=merged['connection_usage_pct'],
                 inputs=['connections', 'max_used_connections', 'max_connections'])

    return merged


def _extract_metrics_inner(db_type: str, flat: dict, ctx: dict, collect: bool = False):
    """返回 (merged, prov)。collect=True 时开启血缘采集。"""
    begun = False
    prev = getattr(_PROV, 'data', None)
    if collect:
        _prov_begin()
        begun = True
    try:
        merged = _merge_metrics(db_type, flat, ctx)
    finally:
        if begun:
            prov = _prov_end()
            _PROV.data = prev          # 还原外层采集（防嵌套调用互相覆盖）
        else:
            prov = {'hits': {}, 'misses': {}}
    return merged, prov


def extract_metrics(db_type: str, flat: dict, ctx: dict) -> Dict[str, Optional[float]]:
    """合成一次快照的指标集合。

    优先级：context 解析值 > 扁平列。context 是原始数据、更完整；
    扁平列在 Oracle 类实例上实测恒为 0/NULL，只作兜底。
    """
    merged, _prov = _extract_metrics_inner(db_type, flat, ctx, collect=False)
    return merged


def extract_metrics_with_provenance(db_type: str, flat: dict, ctx: dict,
                                    only_key: Optional[str] = None,
                                    lang: str = 'zh') -> tuple:
    """在合成指标的同时记录血缘，返回 (merged, {指标 key: 血缘对象})。

    `only_key` 只保留目标指标，避免为 19 个注册表指标都建链。
    """
    merged, prov = _extract_metrics_inner(db_type, flat, ctx, collect=True)
    keys = [only_key] if only_key else list(merged.keys())
    out: Dict[str, dict] = {}
    for k in keys:
        p = _build_provenance(k, prov, lang)
        if p:
            out[k] = p
    return merged, out


def extract_issues(ctx: dict) -> List[dict]:
    """从 context 取规则引擎风险项，归一化为统一结构。"""
    raw = ctx.get('auto_analyze')
    if not isinstance(raw, list):
        return []
    out: List[dict] = []
    for it in raw:
        if not isinstance(it, dict):
            continue
        name = str(it.get('col1') or it.get('description') or it.get('name') or '').strip()
        if not name:
            continue
        level = str(it.get('col2') or it.get('level') or '').strip()
        priority = str(it.get('col4') or '').strip()
        out.append({
            'topic': issue_topic(name) or name,
            'name': name,
            'level': level,
            'severity': _sev_rank(level, priority),
            'description': str(it.get('col3') or it.get('suggestion') or '').strip(),
            'fix_sql': str(it.get('fix_sql') or '').strip(),
        })
    return out


# ═══════════════════════════════════════════════════════════
#  数据装载
# ═══════════════════════════════════════════════════════════

def _snapshot_rows(db_path: str, instance_key: str, days: int) -> List[dict]:
    from modules.inspection.db_history import _get_conn

    sql = ("SELECT id, ts, report_time, risk_count, health_status, "
           "cpu_usage, mem_usage, disk_usage_max, connections, connection_usage_pct, "
           "cache_hit_ratio, sga_total_mb, max_tablespace_pct, context_json "
           "FROM snapshots WHERE instance_key=?")
    params: List[Any] = [instance_key]
    if days and days > 0:
        from datetime import datetime, timedelta
        cutoff = (datetime.now() - timedelta(days=int(days))).strftime('%Y-%m-%d %H:%M:%S')
        sql += " AND ts >= ?"
        params.append(cutoff)
    sql += " ORDER BY ts ASC"

    with _get_conn(db_path) as conn:
        rows = conn.execute(sql, tuple(params)).fetchall()
    return [dict(r) for r in rows]


def load_snapshots(db_path: str, db_type: str, host: str, port, days: int = 0) -> List[dict]:
    """读取指定实例的快照，并把 context_json 就地解析成指标 + 异常项。"""
    # 健康评分与异常主题归一化均为本模块自包含实现（见文件头部）
    from modules.inspection.db_history import _db_key

    key = _db_key(db_type, host, port)
    out: List[dict] = []
    for row in _snapshot_rows(db_path, key, days):
        try:
            ctx = json.loads(row.get('context_json') or '{}')
        except (ValueError, TypeError):
            ctx = {}
        if not isinstance(ctx, dict):
            ctx = {}

        metrics = extract_metrics(db_type, row, ctx)
        issues = extract_issues(ctx)

        health_status = str(row.get('health_status') or ctx.get('health_status') or '')
        # 统一评分口径复用 core.scoring，但它按原始 col1/col2 读取，故在此还原形状
        scoring_issues = [{'col1': i['name'], 'col2': i['level']} for i in issues]
        score, _level, risk_count, status_text = calculate_unified_health_score(
            issues=scoring_issues, ai_dba_report=None, health_status=health_status)
        metrics['health_score'] = float(score)
        metrics['risk_count'] = float(risk_count)

        out.append({
            'snapshot_id': row.get('id'),
            'ts': row.get('ts') or '',
            'metrics': metrics,
            'issues': issues,
            'health_status': status_text,
            # 全量指标发现：把 context_json 里所有「结构规整的单值数值」都带上，
            # 跨快照求交集后即为稳定可比较的完整指标集（见 _build_discovered_series）
            'discovered': _discover_paths(ctx),
        })
    return out


# ═══════════════════════════════════════════════════════════
#  分析：异常项生命周期
# ═══════════════════════════════════════════════════════════

def _build_issue_lifecycle(snapshots: List[dict]) -> List[dict]:
    """跨快照求主题集合差，判定 新增 / 持续 / 已消除。"""
    if not snapshots:
        return []

    last_idx = len(snapshots) - 1
    seen: Dict[str, dict] = {}

    for i, snap in enumerate(snapshots):
        ts = snap.get('ts') or ''
        for issue in snap.get('issues') or []:
            topic = issue['topic']
            entry = seen.get(topic)
            if entry is None:
                entry = {
                    'topic': topic,
                    'name': issue['name'],
                    'level': issue['level'],
                    'severity': issue['severity'],
                    'description': issue['description'],
                    'fix_sql': issue['fix_sql'],
                    'hit_indices': [],
                    'first_ts': ts,
                    'last_ts': ts,
                }
                seen[topic] = entry
            if not entry['hit_indices'] or entry['hit_indices'][-1] != i:
                entry['hit_indices'].append(i)
            entry['last_ts'] = ts
            # 以最近一次出现的等级/文案为准
            entry['name'] = issue['name']
            entry['level'] = issue['level']
            entry['severity'] = issue['severity']
            if issue['description']:
                entry['description'] = issue['description']
            if issue['fix_sql']:
                entry['fix_sql'] = issue['fix_sql']

    result: List[dict] = []
    for entry in seen.values():
        hits = entry['hit_indices']
        present_in_last = hits and hits[-1] == last_idx
        if not present_in_last:
            status = 'resolved'
        elif hits[0] > 0:
            status = 'new'
        else:
            status = 'persistent'

        streak = 0
        for i in range(last_idx, -1, -1):
            if i in hits:
                streak += 1
            else:
                break

        result.append({
            **entry,
            'status': status,
            'total_hits': len(hits),
            'streak': streak,
            'first_index': hits[0],
        })

    order = {'new': 0, 'persistent': 1, 'resolved': 2}
    result.sort(key=lambda e: (order[e['status']], -e['severity'], -e['total_hits'], e['name']))
    return result


# ═══════════════════════════════════════════════════════════
#  分析：指标变化语义
# ═══════════════════════════════════════════════════════════

def _slope(values: List[float]) -> float:
    """最小二乘斜率（对索引回归）。"""
    n = len(values)
    if n < 2:
        return 0.0
    mean_x = (n - 1) / 2.0
    mean_y = sum(values) / n
    num = sum((i - mean_x) * (v - mean_y) for i, v in enumerate(values))
    den = sum((i - mean_x) ** 2 for i in range(n))
    return num / den if den else 0.0


def _breaches(values: List[float], spec: dict) -> List[int]:
    """返回越过警戒线的快照序号。"""
    warn, crit = spec.get('warn'), spec.get('crit')
    direction = spec.get('direction')
    if warn is None:
        return []
    hits = []
    for i, v in enumerate(values):
        if v is None:
            continue
        if direction == 'up_good':
            if crit is not None and v <= crit:
                hits.append(i)
            elif v <= warn:
                hits.append(i)
        else:
            if crit is not None and v >= crit:
                hits.append(i)
            elif v >= warn:
                hits.append(i)
    return hits


def _metric_status(values: List[float], spec: dict) -> str:
    """指标在窗口内的变化状态。"""
    if len(values) < 2:
        return 'unknown'
    first, latest = values[0], values[-1]
    span = max(values) - min(values)
    # 容差取「窗口振幅的 5%」与「量级的 1%」中的较大者：
    # 只有 2 个点时 span 恒等于 diff，仅靠振幅会让任何微小抖动都被判为恶化；
    # 补上量级 1% 的下限，可把 50.0 → 50.4 (%) 这类噪声正确归为平稳。
    tol = max(span * 0.05, abs(sum(values) / len(values)) * 0.01, 1e-9)
    diff = latest - first
    if abs(diff) <= tol:
        return 'stable'
    direction = spec.get('direction')
    if direction == 'up_bad':
        return 'worsening' if diff > 0 else 'improving'
    if direction == 'up_good':
        return 'worsening' if diff < 0 else 'improving'
    return 'rising' if diff > 0 else 'falling'


def _series_entry(key: str, spec: dict, label: str, raw: List[Optional[float]],
                  n_snap: int, lang: str, is_discovered: bool = False) -> Optional[dict]:
    """把一个指标的原始序列规整成前端可用的序列对象（含变化语义）。"""
    # 缺测点用前值填充，保证折线连续；窗口首端缺失则用首个有效值回填
    values: List[Optional[float]] = list(raw)
    first_valid = next((v for v in values if v is not None), None)
    prev = first_valid
    for i, v in enumerate(values):
        if v is None:
            values[i] = prev
        else:
            prev = v
    nums = [float(v) for v in values if v is not None]
    if not nums:
        return None

    has_variance = (max(nums) - min(nums)) > 1e-9
    latest = nums[-1]
    first = nums[0]
    mean = sum(nums) / len(nums)
    prev_val = nums[-2] if len(nums) >= 2 else None
    status = _metric_status(nums, spec)
    # 状态为「平稳」时把环比归零，避免出现「▲ 0.0 且标记平稳」的自相矛盾展示
    delta = None
    if prev_val is not None:
        delta = 0.0 if status == 'stable' else round(latest - prev_val, 4)
    # 全窗口恒为 0 且不属于「0 有意义」的注册表指标 → 视为未采集到，前端不展示。
    # 自动发现指标靠「跨快照路径交集」保证稳定采集，恒 0 也照常展示（如归档错误=0）。
    if is_discovered:
        no_data = False
    else:
        no_data = (not has_variance) and latest == 0 and key not in _ZERO_MEANINGFUL

    breaches = _breaches(values, spec)
    breaching_now = bool(breaches) and breaches[-1] == n_snap - 1
    change_pct = round((latest - first) / abs(first) * 100, 2) if abs(first) > 1e-9 else None
    # 相对变化幅度：用于「有变化」排序与变化幅度条宽度
    significance = round(abs(latest - first) / max(abs(mean), 1e-9), 4)
    missing = sum(1 for v in raw if v is None)

    return {
        'key': key, 'label': label, 'unit': spec['unit'],
        'direction': spec['direction'], 'warn': spec['warn'], 'crit': spec['crit'],
        'group': spec['group'], 'group_label': group_label(spec['group'], lang),
        'primary': spec['primary'],
        'values': [round(v, 4) if v is not None else None for v in values],
        'latest': round(latest, 4),
        'prev': round(prev_val, 4) if prev_val is not None else None,
        'delta': delta,
        'change_pct': change_pct,
        'significance': significance,
        'mean': round(mean, 4),
        'min': round(min(nums), 4),
        'max': round(max(nums), 4),
        'slope': round(_slope(nums), 6),
        'status': status,
        'breaches': breaches,
        'breaching_now': breaching_now,
        'anomaly': breaching_now or status == 'worsening',
        'has_variance': has_variance,
        'no_data': no_data,
        'discovered': is_discovered,
        'missing_points': missing,
        # 覆盖度：该指标在窗口内实际采集到的快照数（< 总数即为「偶发缺采」）
        'coverage': n_snap - missing,
        'partial': missing > 0,
    }


def _build_metric_series(snapshots: List[dict], lang: str = 'zh') -> Dict[str, dict]:
    out: Dict[str, dict] = {}
    n_snap = len(snapshots)
    for spec in METRIC_REGISTRY:
        key = spec['key']
        raw = [s['metrics'].get(key) for s in snapshots]
        if all(v is None for v in raw):
            continue
        entry = _series_entry(key, spec, _label_of(key, lang), raw, n_snap, lang)
        if entry:
            out[key] = entry
    return out


def _dedupable(entry: dict) -> bool:
    """该序列是否可参与「同物理量重影」判定。

    只对真实变化过、且采到 >= 2 次的序列去重。恒定序列（如全 0 的风险计数、
    恒为 1 的两个不同 MySQL 参数）在数值上天然相等，参与去重会误删不同指标。
    """
    return bool(entry.get('has_variance')) and entry.get('coverage', 0) >= 2


def _series_sig(entry: dict) -> tuple:
    """序列指纹：值 + 单位 + 分组。用于识别「同一物理量的两条路径」。

    注册表指标是从 context_json 抽出来的派生值（如 `ora_sga_total[0].SGA_TOTAL_MB`
    → `sga_total_mb`），自动发现会把原始路径也收进来，形成同值同单位的重影。
    只比较值会在「多项常量恰好相等」时误删，故叠加单位与分组约束，
    并由 `_dedupable` 把恒定序列挡在去重之外。
    """
    return (entry.get('unit'), entry.get('group'),
            tuple(entry.get('values') or ()))


def _build_discovered_series(snapshots: List[dict], lang: str = 'zh',
                             existing: Optional[Dict[str, dict]] = None) -> Dict[str, dict]:
    """自动发现指标：把 context_json 里所有可比较的单值数值指标都纳入趋势。

    覆盖率口径（而非严格求交集）：只要窗口内出现过就纳入，并回传 coverage/partial，
    让前端能标注「覆盖 N/M」。严格求交集会丢掉「采集偶发失败」的指标——SQL Server
    实测有 19 项高价值指标（含 ss_signal_wait 等已登记阈值项）只在部分快照出现。
    只采到 1 次的指标打 single_sample 标记，前端默认排在末尾并单独标注。

    `existing` 为已构建的注册表指标序列：值+单位+分组完全一致的路径会被跳过，
    避免同物理量出现两条重影行（判定范围见 `_dedupable`）。
    """
    if not snapshots:
        return {}
    per = [s.get('discovered') or {} for s in snapshots]
    n_snap = len(snapshots)

    hits: Dict[str, int] = {}
    for d in per:
        for path in d:
            hits[path] = hits.get(path, 0) + 1

    seen_sigs = {_series_sig(m) for m in (existing or {}).values() if _dedupable(m)}

    out: Dict[str, dict] = {}
    for path in sorted(hits):
        if path in METRIC_BY_KEY:
            continue
        meta = _meta_for_path(path, lang)
        raw = [d.get(path) for d in per]
        entry = _series_entry(path, meta, meta['label'], raw, n_snap, lang, is_discovered=True)
        if not entry:
            continue
        entry['single_sample'] = entry['coverage'] <= 1
        if _dedupable(entry):
            sig = _series_sig(entry)
            if sig in seen_sigs:
                continue
            seen_sigs.add(sig)
        out[path] = entry

    # 稳定顺序：覆盖完整优先，其次变化幅度大的靠前，最后按路径
    return dict(sorted(out.items(),
                       key=lambda kv: (-kv[1]['coverage'], -kv[1]['significance'], kv[0])))


# ═══════════════════════════════════════════════════════════
#  分析：整体结论
# ═══════════════════════════════════════════════════════════

def _summarize(issues: List[dict], metrics: Dict[str, dict], snapshots: List[dict],
               lang: str = 'zh') -> dict:
    _lang = _norm_lang(lang)
    T = _REASON_TEMPLATES[_lang]
    new_items = [e for e in issues if e['status'] == 'new']
    persistent_items = [e for e in issues if e['status'] == 'persistent']
    resolved_items = [e for e in issues if e['status'] == 'resolved']

    worsening = [k for k, m in metrics.items() if m['status'] == 'worsening']
    improving = [k for k, m in metrics.items() if m['status'] == 'improving']

    if not snapshots:
        return {
            'verdict': 'stable', 'verdict_reason': T['no_data'],
            'new_count': 0, 'persistent_count': 0, 'resolved_count': 0,
            'worsening_metrics': [], 'improving_metrics': [], 'breached_metrics': [],
            'last_health_score': None, 'last_health_status': '',
        }

    # 最新一条仍处于超标状态的指标
    breached = [k for k, m in metrics.items()
                if m['breaches'] and m['breaches'][-1] == len(snapshots) - 1]

    def _names(keys, limit=3):
        # 自动发现指标不在注册表里，必须从 metrics 取 label，否则会显示原始路径
        shown = ('、' if _lang == 'zh' else ', ').join(
            (metrics.get(k) or {}).get('label') or _label_of(k, _lang) for k in keys[:limit])
        return shown if len(keys) <= limit else f'{shown} +{len(keys) - limit}'

    breached_worsening = [k for k in worsening if k in breached]

    if new_items:
        verdict = 'worsening'
        reason = T['new'].format(n=len(new_items))
    elif breached_worsening:
        verdict = 'worsening'
        reason = T['breach'].format(names=_names(breached_worsening))
    elif len(worsening) > len(improving):
        verdict = 'worsening'
        reason = T['worsening'].format(n=len(worsening))
    elif persistent_items or breached:
        verdict = 'attention'
        parts = []
        if persistent_items:
            parts.append(T['attention_persistent'].format(n=len(persistent_items)))
        if breached:
            parts.append(T['attention_breach'].format(n=len(breached), names=_names(breached)))
        reason = T['sep'].join(parts)
    elif resolved_items:
        verdict = 'improving'
        reason = T['resolved'].format(n=len(resolved_items))
    elif len(improving) > len(worsening):
        verdict = 'improving'
        reason = T['improving'].format(n=len(improving))
    else:
        verdict = 'stable'
        reason = T['stable']

    last = snapshots[-1] if snapshots else {}
    return {
        'verdict': verdict,
        'verdict_reason': reason,
        'new_count': len(new_items),
        'persistent_count': len(persistent_items),
        'resolved_count': len(resolved_items),
        'worsening_metrics': worsening,
        'improving_metrics': improving,
        'breached_metrics': breached,
        'last_health_score': last.get('metrics', {}).get('health_score'),
        'last_health_status': last.get('health_status', ''),
    }


# ═══════════════════════════════════════════════════════════
#  溯源：指标 → 原数据
# ═══════════════════════════════════════════════════════════

def _ctx_of(row: dict) -> dict:
    try:
        ctx = json.loads(row.get('context_json') or '{}')
    except (ValueError, TypeError):
        return {}
    return ctx if isinstance(ctx, dict) else {}


def _discovered_provenance(key: str, ctx: dict, value: Optional[float],
                           lang: str = 'zh') -> Optional[dict]:
    """自动发现指标的血缘：key 本身就是 context 路径，直接定位即可。"""
    if value is None:
        return None
    # 路径末段落在列表的第 0 行时，原数据应该是「那张单行表」而不是标量
    parent = _walk_path(ctx, _parent_path(key))
    if isinstance(parent, list):
        desc = {'kind': KIND_CTX_LIST, 'path': _parent_path(key), 'agg': 'first',
                'row_index': 0, 'rows': len(parent), 'picked': value}
    else:
        desc = {'kind': KIND_CTX_SCALAR, 'path': key, 'picked': value}
    return {
        'key': key, 'kind': desc['kind'], 'origin': desc,
        'chain': [dict(desc, matched=True, ref=_ref_of(desc))],
        'explain': _explain(desc, lang),
        'raw_kind': desc['kind'] if desc['kind'] in RAW_KINDS else None,
        'has_raw': desc['kind'] in RAW_KINDS,
        'available': True,
        'discovered': True,
    }


#: 不走 extract_metrics、而由趋势页另行计算的指标（口径必须与 load_snapshots 完全一致）
_SCORING_KEYS = ('risk_count', 'health_score')


def _special_value(key: str, row: dict, ctx: dict) -> Optional[float]:
    """risk_count / health_score 的取值：与 load_snapshots 同源（本模块评分函数）。

    这两个指标不在 extract_metrics 里产出，若直接读扁平列会与趋势页展示值不一致，
    溯源就失去意义 —— 必须复用同一套评分调用。
    """
    if key not in _SCORING_KEYS:
        return None
    issues = extract_issues(ctx)
    scoring = [{'col1': i['name'], 'col2': i['level']} for i in issues]
    hs = str(row.get('health_status') or ctx.get('health_status') or '')
    score, _lvl, risk_count, _st = calculate_unified_health_score(
        issues=scoring, ai_dba_report=None, health_status=hs)
    return float(score) if key == 'health_score' else float(risk_count)


def _special_provenance(key: str, ctx: dict, merged: dict,
                        lang: str = 'zh') -> Optional[dict]:
    """给 health_score / risk_count 这类「派生指标」补血缘（无物理采样点）。"""
    if key == 'risk_count':
        n = len(ctx.get('auto_analyze') or [])
        desc = {'kind': KIND_ISSUE_LIST, 'path': 'auto_analyze', 'rows': n,
                'picked': merged.get('risk_count')}
    elif key == 'health_score':
        desc = {'kind': KIND_DERIVED,
                'formula': '按 auto_analyze 的等级分布，复用 core.scoring 统一评分口径计算',
                'picked': merged.get('health_score'), 'inputs': ['auto_analyze']}
    else:
        return None
    return {
        'key': key, 'kind': desc['kind'], 'origin': desc,
        'chain': [dict(desc, matched=True, ref=_ref_of(desc))],
        'explain': _explain(desc, lang),
        'raw_kind': desc['kind'] if desc['kind'] in RAW_KINDS else None,
        'has_raw': desc['kind'] in RAW_KINDS,
        'available': desc['kind'] in RAW_KINDS,
    }


def snapshot_provenance(db_type: str, flat: dict, ctx: dict, key: str,
                        merged: Optional[dict] = None,
                        lang: str = 'zh') -> Optional[dict]:
    """单个快照上某指标的血缘（注册表指标 + 派生指标 + 自动发现指标三路）。"""
    if key in METRIC_BY_KEY:
        m, provs = extract_metrics_with_provenance(db_type, flat, ctx,
                                                   only_key=key, lang=lang)
        p = provs.get(key)
        if p:
            return p
        sp = _special_provenance(key, ctx, m, lang)
        if sp:
            return sp
        return None
    if merged is not None:
        return _special_provenance(key, ctx, merged, lang)
    value = _num(_walk_path(ctx, key))
    return _discovered_provenance(key, ctx, value, lang)


def _hit_summary(p: Optional[dict]) -> Optional[dict]:
    """把一个血缘对象压成「每点一行」的轻量摘要（detail 接口用，不含数据本体）。"""
    if not p:
        return None
    o = p.get('origin') or {}
    return {
        'kind': p.get('kind'),
        'ref': _ref_of(o),
        'raw_kind': p.get('raw_kind'),
        'has_raw': bool(p.get('has_raw')),
        'available': bool(p.get('available')),
        'row_index': o.get('row_index'),
        'rows': o.get('rows'),
        'column': o.get('value_column') or o.get('field'),
        'agg': o.get('agg'),
        'picked': o.get('picked'),
        'row_label': o.get('row_label'),
    }


#: 报告文件名里的时间戳：兼容 `_<YYYYMMDDHHMMSS>.docx` 与 `_<YYYYMMDD>_<HHMMSS>.docx` 两种
_RE_TS_14 = re.compile(r'_(\d{14})\.docx$', re.I)
_RE_TS_SPLIT = re.compile(r'_(\d{8})_(\d{6})\.docx$', re.I)

#: 报告文件名前缀 → db_type（与 modules/web/app.py 的同名解析保持一致）
_REPORT_PREFIXES = (
    ('MySQL巡检报告_', 'mysql'),
    ('TDSQL-C MySQL巡检报告_', 'tdsqlc_mysql'),
    ('PostgreSQL巡检报告_', 'postgresql'),
    ('Oracle巡检报告_', 'oracle'),
    ('DM8巡检报告_', 'dm'),
    ('达梦巡检报告_', 'dm'),
    ('SQLServer巡检报告_', 'sqlserver'),
    ('TiDB巡检报告_', 'tidb'),
    ('IvorySQL巡检报告_', 'ivorysql'),
    ('HaloDB巡检报告_', 'halodb'),
    ('YashanDB巡检报告_', 'yashandb'),
    ('GBase 8s巡检报告_', 'gbase'),
)


def _parse_report_filename(name: str):
    """从报告文件名提取 (db_type, host, label)；无法识别时返回空串三元组。"""
    name_no_ext = (name or '').replace('.docx', '')
    for prefix, db_type in _REPORT_PREFIXES:
        if name_no_ext.startswith(prefix):
            rest = name_no_ext[len(prefix):]
            parts = rest.rsplit('_', 1)
            if len(parts) == 2 and len(parts[1]) == 14 and parts[1].isdigit():
                sub = parts[0].split('_', 1)
                return db_type, sub[0], (sub[1] if len(sub) > 1 else '')
            idx = rest.find('_')
            if idx > 0:
                return db_type, rest[:idx], ''
            return db_type, '', ''
    return '', '', ''


def report_timestamp(name: str) -> Optional[str]:
    """从报告文件名提取 'YYYY-MM-DD HH:MM:SS'。"""
    m = _RE_TS_14.search(name or '')
    if m:
        s = m.group(1)
        return '%s-%s-%s %s:%s:%s' % (s[0:4], s[4:6], s[6:8], s[8:10], s[10:12], s[12:14])
    m = _RE_TS_SPLIT.search(name or '')
    if m:
        d, t = m.group(1), m.group(2)
        return '%s-%s-%s %s:%s:%s' % (d[0:4], d[4:6], d[6:8],
                                      t[0:2], t[2:4], t[4:6])
    return None


def _secs(s: str, fmt: str = '%Y-%m-%d %H:%M:%S') -> Optional[float]:
    from datetime import datetime
    try:
        return datetime.strptime(str(s)[:19], fmt).timestamp()
    except (ValueError, TypeError):
        return None


def find_report_file(base_dir: str, db_type: str, host: str, ts: str,
                     max_delta_sec: int = 1800) -> dict:
    """在 reports/ 下按 (db_type, host, 时间邻近) 反查报告文件。

    仅用于旧快照（`report_file` 列为空）的降级路径：报告名里的时间戳与快照
    时间存在固有偏差（实测 5 秒，报告名在生成报告之前就定好了），所以这里取
    「最近的一个」并在返回值里标注为推测，不做精确匹配断言。
    """
    from modules.driver_registry import normalize_db_type as _norm
    try:
        from modules.core.paths import REPORTS_DIR
        reports_dir = str(REPORTS_DIR)
    except Exception:
        reports_dir = os.path.join(base_dir, 'reports')
    try:
        names = os.listdir(reports_dir)
    except OSError:
        return {}
    t0 = _secs(ts)
    best = None
    want = _norm_db(db_type)
    for n in names:
        if not n.lower().endswith('.docx') or n.startswith('~$'):
            continue
        dt, h, _lb = _parse_report_filename(n)
        if not dt or not h:
            continue
        if h != host:
            continue
        if want and _norm_db(dt) != want:
            continue
        rts = report_timestamp(n)
        if not rts:
            continue
        t1 = _secs(rts)
        if t0 is None or t1 is None:
            continue
        d = abs(t1 - t0)
        if best is None or d < best['delta_sec']:
            best = {'file': n, 'report_ts': rts, 'delta_sec': round(d, 1),
                    'matched_by': 'time_window'}
    if best and best['delta_sec'] <= max_delta_sec:
        return best
    return {}


def provenance_series(db_path: str, db_type: str, host: str, port,
                      days: int = 0, key: str = '', lang: str = 'zh') -> dict:
    """某指标在全窗口的「血缘映射」：每个快照点 → 主来源，轻量、不含数据本体。

    前端据此画折线图的来源标记；用户点某一点时再调 snapshot_raw 取该点原数据。
    """
    from modules.inspection.db_history import _db_key

    ikey = _db_key(db_type, host, port)
    rows = _snapshot_rows(db_path, ikey, days)
    is_reg = key in METRIC_BY_KEY

    points: List[dict] = []
    matched = fallback = no_src = 0
    origin_template: Optional[dict] = None
    label = _label_of(key, lang) if is_reg else key
    unit = (METRIC_BY_KEY.get(key) or {}).get('unit', '')

    for row in rows:
        ctx = _ctx_of(row)
        merged = None
        if key in _SCORING_KEYS:
            # 与趋势页同源：评分指标不走 extract_metrics
            val = _special_value(key, row, ctx)
            p = _special_provenance(key, ctx, {key: val}, lang)
        elif is_reg:
            merged, provs = extract_metrics_with_provenance(db_type, row, ctx,
                                                            only_key=key, lang=lang)
            p = provs.get(key) or _special_provenance(key, ctx, merged, lang)
            val = merged.get(key)
        else:
            val = _num(_walk_path(ctx, key))
            p = _discovered_provenance(key, ctx, val, lang)

        hs = _hit_summary(p)
        if hs is None:
            no_src += 1
        elif hs['kind'] == KIND_FLAT_COLUMN:
            fallback += 1
        else:
            matched += 1
        if origin_template is None and hs and hs['kind'] != KIND_FLAT_COLUMN:
            o = dict((p or {}).get('origin') or {})
            for drop in ('picked', 'row_index', 'row_label', 'rows'):
                o.pop(drop, None)
            origin_template = {'kind': hs['kind'], 'origin': o,
                               'ref': hs['ref'], 'explain': (p or {}).get('explain', ''),
                               'raw_kind': hs['raw_kind'], 'has_raw': hs['has_raw']}

        points.append({
            'snapshot_id': row.get('id'),
            'ts': row.get('ts') or '',
            'value': val if val is None else round(float(val), 4),
            'missing': val is None,
            'hit': hs,
        })

    return {
        'key': key,
        'label': label,
        'unit': unit,
        'group': (METRIC_BY_KEY.get(key) or {}).get('group', 'other'),
        'is_discovered': not is_reg,
        'labels': [p['ts'] for p in points],
        'points': points,
        'origin_template': origin_template,
        'stats': {
            'total_points': len(points),
            'matched_points': matched,
            'fallback_points': fallback,
            'no_source_points': no_src,
        },
    }


def snapshot_raw(base_dir: str, db_type: str, host: str, port, snapshot_id: int,
                 key: str, offset: int = 0, limit: int = 100,
                 lang: str = 'zh') -> dict:
    """取某个快照点上某指标的**原始数据**（分页 + 命中行定位 + 独立复算校验）。"""
    from modules.inspection.db_history import _db_key, SQLiteHistoryManager

    db_path = os.path.join(base_dir, 'data', 'history.db')
    ikey = _db_key(db_type, host, port)
    hm = SQLiteHistoryManager(base_dir)
    snap = hm.get_snapshot(ikey, int(snapshot_id))
    if not snap:
        return {'ok': False, 'error': 'snapshot_not_found'}

    ctx = _ctx_of(snap)
    merged = None
    if key in _SCORING_KEYS:
        merged = {key: _special_value(key, snap, ctx)}
        p = _special_provenance(key, ctx, merged, lang)
    elif key in METRIC_BY_KEY:
        merged, provs = extract_metrics_with_provenance(db_type, snap, ctx,
                                                       only_key=key, lang=lang)
        p = provs.get(key) or _special_provenance(key, ctx, merged, lang)
    else:
        p = _discovered_provenance(key, ctx, _num(_walk_path(ctx, key)), lang)
    if not p:
        return {'ok': False, 'error': 'no_provenance', 'snapshot_id': snap.get('id'),
                'ts': snap.get('ts'), 'key': key}

    origin = p.get('origin') or {}
    raw = resolve_raw(ctx, origin, offset=offset, limit=limit)

    # 独立复算：拿原数据按血缘口径重算一遍，与展示值比对（说得出就要验得了）
    showed = merged.get(key) if merged is not None else _num(_walk_path(ctx, key))
    verify = {'value': showed, 'recomputed': origin.get('picked'),
              'ok': (showed is None or origin.get('picked') is None
                     or abs(float(showed) - float(origin.get('picked'))) < 1e-6)}

    # 报告文件：优先用落库值，旧快照降级为按时间邻近反查（标注为推测）
    report: Optional[dict] = None
    rf = str(snap.get('report_file') or '')
    if rf:
        report = {'file': rf, 'matched_by': 'recorded'}
    elif base_dir:
        report = find_report_file(base_dir, db_type, host, snap.get('ts') or '') or None
    if report:
        # 报告可能已被删除 → 交给前端置灰，避免点了跳出 404（不出死链）
        try:
            from modules.core.paths import REPORTS_DIR
            _reports_dir = str(REPORTS_DIR)
        except Exception:
            _reports_dir = os.path.join(base_dir, 'reports')
        report['exists'] = os.path.isfile(os.path.join(_reports_dir, report['file']))

    return {
        'ok': True,
        'snapshot_id': snap.get('id'),
        'ts': snap.get('ts') or '',
        'key': key,
        'label': _label_of(key, lang) if key in METRIC_BY_KEY else key,
        'unit': (METRIC_BY_KEY.get(key) or {}).get('unit', ''),
        'value': showed,
        'provenance': p,
        'raw': raw,
        'verify': verify,
        'report': report,
        'template_id': snap.get('template_id'),
        'engine': snap.get('engine') or '',
        'health_status': snap.get('health_status') or '',
        'risk_count': snap.get('risk_count'),
    }


# ═══════════════════════════════════════════════════════════
#  入口
# ═══════════════════════════════════════════════════════════

def analyze_snapshots(db_type: str, snapshots: List[dict], lang: str = 'zh') -> dict:
    """纯函数入口：吃快照列表，出分析结果（便于单测）。"""
    labels = [s.get('ts') or '' for s in snapshots]
    issues = _build_issue_lifecycle(snapshots)
    metrics = _build_metric_series(snapshots, lang)
    # 注册表指标优先，自动发现指标补充（同名路径已在发现层排除，
    # 同值同单位同分组的派生路径由 _series_sig 去重）
    for key, entry in _build_discovered_series(snapshots, lang, existing=metrics).items():
        metrics.setdefault(key, entry)
    summary = _summarize(issues, metrics, snapshots, lang)

    return {
        'labels': labels,
        # 与 labels 一一对应：溯源接口用它精确定位某个点（同一秒可能有多条快照，ts 不足唯一定位）
        'snapshot_ids': [s.get('snapshot_id') for s in snapshots],
        'snapshots_count': len(snapshots),
        'issues': issues,
        'metrics': metrics,
        'risk_counts': [s['metrics'].get('risk_count') for s in snapshots],
        'health_scores': [s['metrics'].get('health_score') for s in snapshots],
        'health_statuses': [s.get('health_status') or '' for s in snapshots],
        'summary': summary,
    }


def analyze(base_dir: str, db_type: str, host: str, port, days: int = 0,
            lang: str = 'zh') -> dict:
    """读取 history.db 并产出趋势分析结果。"""
    from modules.inspection.db_history import _db_key

    db_path = os.path.join(base_dir, 'data', 'history.db')
    snapshots = load_snapshots(db_path, db_type, host, port, days) if os.path.isfile(db_path) else []

    result = analyze_snapshots(db_type, snapshots, lang)
    result['instance_key'] = _db_key(db_type, host, port)
    result['days'] = int(days or 0)
    if snapshots:
        result['range'] = {'from': snapshots[0].get('ts', ''), 'to': snapshots[-1].get('ts', '')}
    return result