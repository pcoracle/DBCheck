# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
"""Zabbix 主机与监控项的解析工具。

监控项 key 的命名在 Zabbix 版本与操作系统模板之间差异很大，这里集中处理兼容：
  - 磁盘：传统 ``vfs.fs.size`` 与 6.4+ 的 dependent 项 ``vfs.fs.dependent.size``
    （Linux 挂载点 /xxx、Windows 盘符 C:，都以 pused 结尾表示使用率）
  - 负载：Linux 有旧版 ``system.load`` 与 6.4+ 的 ``system.cpu.load``，Windows 无负载均值
  - CPU：总体项、空闲项 [,idle]、分量项 [,user]/[,system] 并存，取值时必须区分
"""

import json

# 监控项 key 分类前缀（用于归类与取数）
ITEM_CATEGORIES = {
    'cpu': ['system.cpu.util'],
    'load': ['system.load', 'system.cpu.load'],
    'memory': ['vm.memory.size', 'vm.memory.utilization', 'vm.memory.util'],
    'disk': ['vfs.fs.size', 'vfs.fs.dependent.size'],
    'net_in': ['net.if.in'],
    'net_out': ['net.if.out'],
}


def parse_float(v):
    """安全解析浮点数，解析不了返回 None（Zabbix 的数值都是字符串）。"""
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def host_ip(host):
    """从主机接口里取 IP：优先 SNMP(type=1) 之外的 Agent 接口，退回任一有 IP 的接口。"""
    interfaces = host.get('interfaces') or []
    for iface in interfaces:
        if iface.get('type') == '1' and iface.get('ip'):
            return iface['ip']
    for iface in interfaces:
        if iface.get('ip'):
            return iface['ip']
    return ''


def host_status(host):
    """主机状态：0=监控启用 1=监控停用"""
    return host.get('status', '0')


def host_available(host):
    """主机可用性：0=未知 1=可用 2=不可用。

    部分 Zabbix 版本不返回主机级 available（为 None），此时从接口推导：
    任一接口可用则主机可用；否则有不可用接口则不可用；否则未知。
    """
    avail = host.get('available')
    if avail is not None and str(avail) in ('0', '1', '2'):
        return str(avail)
    interfaces = host.get('interfaces') or []
    if not interfaces:
        return '0'
    vals = [str(i.get('available', '0')) for i in interfaces]
    if '1' in vals:
        return '1'
    if '2' in vals:
        return '2'
    return '0'


def categorize_items(items):
    """把监控项按 ITEM_CATEGORIES 归类，未命中的进 other。"""
    result = {k: [] for k in ITEM_CATEGORIES}
    result['other'] = []
    for item in items:
        key = item.get('key_', '')
        matched = False
        for cat, patterns in ITEM_CATEGORIES.items():
            for p in patterns:
                if key.startswith(p):
                    result[cat].append(item)
                    matched = True
                    break
            if matched:
                break
        if not matched:
            result['other'].append(item)
    return result


def detect_os(items):
    """按监控项 key 与名称特征判断 linux / windows，判不出来按 linux。"""
    for it in items:
        key = it.get('key_', '')
        name = it.get('name', '')
        if 'perf_counter' in key or 'wmi.get' in key or 'service.info' in key:
            return 'windows'
        if 'Windows' in name:
            return 'windows'
        if 'Linux' in name:
            return 'linux'
    return 'linux'


def parse_fs_get_disk(items):
    """从 ``vfs.fs.get`` 主项解析磁盘使用率（兼容旧版 agent / 无 dependent 项的主机）。

    返回伪监控项列表 [{name, key_, lastvalue}]，lastvalue 是 pused 百分比，
    交给调用方按普通 ``vfs.fs.size[mp,pused]`` 一样处理。
    """
    result = []
    for it in items:
        if it.get('key_', '') != 'vfs.fs.get':
            continue
        raw = it.get('lastvalue')
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            continue
        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list):
            continue
        for fs in data:
            if not isinstance(fs, dict):
                continue
            fsname = fs.get('fsname', '')
            pused = (fs.get('bytes') or {}).get('pused')
            if fsname and pused is not None:
                result.append({
                    'name': '%s: Space utilization' % fsname,
                    'key_': 'vfs.fs.size[%s,pused]' % fsname,
                    'lastvalue': pused,
                })
    return result


def pick_primary(items, prefer_keys=None):
    """同类监控项里挑主项：先按 key 偏好，再取最近有数据的一条。"""
    if not items:
        return None
    prefer_keys = prefer_keys or []
    for pk in prefer_keys:
        for it in items:
            if pk in it.get('key_', ''):
                return it
    items = [it for it in items if it.get('lastvalue') not in (None, '')]
    if not items:
        return None
    items.sort(key=lambda it: int(it.get('lastclock', 0) or 0), reverse=True)
    return items[0]


def pick_memory_percent(items):
    """从内存监控项里挑出「百分比」项，避免把原始字节值当成使用率。

    有些主机只有 vm.memory.size[used]/[total] 字节项，直接取值会得到 >100 的数。
    只接受合法百分比项：
      - pused / utilization / util：本身就是使用率
      - pavailable：可用率，使用率 = 100 - pavailable（由调用方换算）
    """
    if not items:
        return None

    def _valid(v):
        return v is not None and 0 <= v <= 100

    for it in items:
        key = it.get('key_', '')
        if 'pused' in key or 'utilization' in key or 'util' in key:
            if _valid(parse_float(it.get('lastvalue'))):
                return it
    for it in items:
        if 'pavailable' in (it.get('key_', '') or ''):
            if _valid(parse_float(it.get('lastvalue'))):
                return it
    return None
