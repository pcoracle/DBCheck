# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""Zabbix 监控页数据组装（MVP：主机概览 + 指标摘要 + 活动问题）。

只读 Zabbix 的「最新值」（item.lastvalue）与活动触发器，不落本地指标库、
不拉历史曲线——那些属于完整版。指标挑选规则与巡检 sysinfo 采集保持一致：
  - CPU：Linux 优先 system.cpu.util[,idle] 取反；Windows 直接取使用率
  - 内存：只认百分比项（pused/utilization/util/pavailable），拒绝原始字节值
  - 磁盘：优先根分区（/ 或 C:）的 pused；只有 vfs.fs.get 主项时解析 JSON 兜底
  - 负载：优先 system.load1（Windows 无负载均值，返回 None）
"""

from modules.zabbix.client import ZabbixError
from modules.zabbix.items import (
    categorize_items, detect_os, host_available, host_ip, host_status,
    parse_float, parse_fs_get_disk, pick_memory_percent, pick_primary,
)

# 严重级别名称与配色（与 Zabbix 前端默认一致，自低到高）
SEVERITY_NAMES = {
    0: '未分类',
    1: '信息',
    2: '警告',
    3: '一般严重',
    4: '严重',
    5: '灾难',
}

SEVERITY_COLORS = {
    0: '#97aab3', 1: '#7499ff', 2: '#ffc859',
    3: '#ffa059', 4: '#e97659', 5: '#e45959',
}


def severity_name(sev):
    try:
        return SEVERITY_NAMES.get(int(sev), '未知')
    except (TypeError, ValueError):
        return '未知'


def severity_color(sev):
    try:
        return SEVERITY_COLORS.get(int(sev), '#97aab3')
    except (TypeError, ValueError):
        return '#97aab3'


def _trigger_row(tr, with_host=False):
    """触发器 → 活动问题行（严重级别名称/颜色由后端统一给出）。"""
    row = {
        'triggerid': tr.get('triggerid'),
        'description': tr.get('description'),
        'priority': tr.get('priority'),
        'severity_name': severity_name(tr.get('priority')),
        'severity_color': severity_color(tr.get('priority')),
        'lastchange': tr.get('lastchange'),
    }
    if with_host:
        hosts_info = tr.get('hosts') or []
        row['host'] = hosts_info[0].get('name') if hosts_info else ''
    return row


def build_host_summary(client, hostid):
    """单主机监控摘要：6 项指标 + 磁盘明细 + 活动问题（MVP 不含历史序列）。"""
    host = client.get_host(hostid)
    if not host:
        raise ZabbixError('未找到主机（hostid=%s）' % hostid)

    items = client.get_items(hostid=hostid)
    categorized = categorize_items(items)
    os_type = detect_os(items)

    summary = {}

    # CPU：Linux 优先 idle 项取反；Windows 的 system.cpu.util 直接是使用率
    cpu_primary = pick_primary(categorized['cpu'], prefer_keys=['system.cpu.util[,idle]'])
    if cpu_primary:
        cpu_val = parse_float(cpu_primary.get('lastvalue'))
        if 'idle' in cpu_primary.get('key_', '') and os_type != 'windows':
            cpu_val = 100.0 - cpu_val if cpu_val is not None else None
        summary['cpu'] = cpu_val

    # 内存：只认百分比项，pavailable 需换算成使用率
    mem_primary = pick_memory_percent(categorized['memory'])
    if mem_primary:
        mem_val = parse_float(mem_primary.get('lastvalue'))
        if 'pavailable' in mem_primary.get('key_', ''):
            mem_val = 100.0 - mem_val if mem_val is not None else None
        summary['memory'] = mem_val

    # 磁盘：优先根分区（Linux / 或 Windows C:），否则取最近有数据的一条
    disk_pused = [it for it in categorized['disk'] if 'pused' in it.get('key_', '')]
    if not disk_pused:
        # 兼容只有 vfs.fs.get 主项的主机（如旧版 Windows agent）
        disk_pused = parse_fs_get_disk(items)
    disk_primary = None
    for it in disk_pused:
        key = it.get('key_', '')
        if '/,pused' in key or 'C:,pused' in key:
            disk_primary = it
            break
    if not disk_primary:
        disk_primary = pick_primary(disk_pused)
    if disk_primary:
        summary['disk'] = parse_float(disk_primary.get('lastvalue'))
    # 磁盘明细按使用率降序
    disk_detail = [
        {'name': it.get('name', ''), 'key_': it.get('key_', ''),
         'lastvalue': parse_float(it.get('lastvalue'))}
        for it in disk_pused
    ]
    disk_detail.sort(key=lambda d: d['lastvalue'] if d['lastvalue'] is not None else -1,
                     reverse=True)
    summary['disk_items'] = disk_detail

    # 负载（Windows 无负载均值，自然为 None）
    load_primary = pick_primary(categorized['load'], prefer_keys=['system.load1'])
    if load_primary:
        summary['load'] = parse_float(load_primary.get('lastvalue'))

    # 网络：入/出
    net_in_primary = pick_primary(categorized['net_in'])
    net_out_primary = pick_primary(categorized['net_out'])
    if net_in_primary:
        summary['net_in'] = parse_float(net_in_primary.get('lastvalue'))
    if net_out_primary:
        summary['net_out'] = parse_float(net_out_primary.get('lastvalue'))

    # 活动问题：取数失败不拖累指标展示（触发器接口偶发超时很常见）
    problems = []
    try:
        triggers = client.get_triggers(hostids=[hostid], active_only=True)
        problems = [_trigger_row(tr) for tr in (triggers or [])]
    except ZabbixError:
        pass

    return {
        'host': {
            'hostid': host.get('hostid'),
            'host': host.get('host'),
            'name': host.get('name'),
            'status': host_status(host),
            'available': host_available(host),
            'ip': host_ip(host),
            'os': os_type,
        },
        'summary': summary,
        'problems': problems,
        'source': 'zabbix',
    }


def build_host_list(client, search=None, limit=500):
    """主机列表：基础信息 + 活动问题数 / 最高严重级别（左栏列表用）。"""
    hosts = client.get_hosts(search=search, limit=limit) or []
    result = []
    for host in hosts:
        triggers = host.get('triggers') or []
        active = [t for t in triggers if t.get('value') == '1']
        max_sev = 0
        for t in active:
            try:
                max_sev = max(max_sev, int(t.get('priority', 0)))
            except (TypeError, ValueError):
                pass
        result.append({
            'hostid': host.get('hostid'),
            'host': host.get('host'),
            'name': host.get('name'),
            'status': host_status(host),
            'available': host_available(host),
            'ip': host_ip(host),
            'problem_count': len(active),
            'max_severity': max_sev,
        })
    return result


def list_problems(client, limit=100):
    """全局活动问题（按严重级别降序），附带所属主机名。"""
    triggers = client.get_triggers(active_only=True, limit=limit) or []
    return [_trigger_row(tr, with_host=True) for tr in triggers]