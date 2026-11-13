# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
"""从 Zabbix 采集目标主机的系统资源信息，供巡检报告复用。

巡检向导第 3 步「系统资源采集」的三条路径：
  1) SSH 采集（RemoteSystemInfoCollector）
  2) Zabbix 采集（本模块）——适合没有 SSH 的 Windows 主机，或已被 Zabbix 纳管的主机
  3) 跳过（只出数据库指标）

本模块产出与 SSH 采集同构的 system_info，因此通用引擎与 Oracle 报告的渲染代码
不需要为 Zabbix 单独分支；数据来源用 ``_source='zabbix'`` 标记，便于报告与排障区分。
"""

import re
import time
from datetime import datetime

from modules.zabbix.client import ZabbixError
from modules.zabbix.config import load_zabbix_config
from modules.zabbix.items import (
    categorize_items,
    detect_os,
    parse_fs_get_disk,
    parse_float,
    pick_memory_percent,
)
from modules.zabbix.items import host_ip as _interface_ip


class ZabbixSysInfoError(Exception):
    """Zabbix 系统信息采集异常（配置缺失 / 主机未找到 / 数据不可用）"""
    pass


# 与巡检引擎保持一致的忽略挂载点
IGNORE_MOUNTS = {'/mnt/iso', '/media', '/run/media', '/iso', '/cdrom'}


def _to_mb(value, units=''):
    """把 Zabbix 原始数值按单位换算成 MB。

    无单位时按量级猜测：内存/交换类指标大多直接报字节。
    """
    v = parse_float(value)
    if v is None:
        return 0.0
    u = (units or '').upper()
    if u.startswith('B'):
        return v / 1024.0 / 1024.0
    if u.startswith('K'):
        return v / 1024.0
    if u.startswith('M'):
        return v
    if u.startswith('G'):
        return v * 1024.0
    if abs(v) >= 1024 * 1024:
        return v / 1024.0 / 1024.0
    return v


def _human_size(gb):
    """GB 数值转 df 风格可读大小"""
    try:
        gb = float(gb)
    except (TypeError, ValueError):
        return '0'
    if gb >= 1024:
        return '%.0fT' % (gb / 1024.0)
    if gb >= 1:
        return '%.0fG' % gb
    return '%.0fM' % (gb * 1024.0)


def _parse_fs_key(key):
    """解析文件系统监控项 key。

    vfs.fs.size[/,pused]          → ('/',   'pused')
    vfs.fs.dependent.size[C:,total] → ('C:', 'total')
    """
    m = re.match(r'^vfs\.fs(?:\.dependent)?\.size\[(.+),\s*(total|used|free|pused)\]$', key or '')
    if not m:
        return None
    return m.group(1), m.group(2)


def _item_last(items, key_startswith):
    """按 key 前缀找最新一次有值的监控项"""
    best = None
    for it in items:
        if not (it.get('key_') or '').startswith(key_startswith):
            continue
        if it.get('lastvalue') in (None, ''):
            continue
        clock = int(it.get('lastclock') or 0)
        if best is None or clock >= int(best.get('lastclock') or 0):
            best = it
    return best


def collect_zabbix_system_info(host_ip=None, hostname=None, client=None):
    """读取 Zabbix 最新监控项，整理成巡检报告用的 system_info。

    :param host_ip:  主机 IP（与 hostname 至少给一个）
    :param hostname: Zabbix 主机名（给了就参与精确匹配）
    :param client:   可选注入的客户端。高频轮询场景（监控大屏宿主资源）由调用方传
                     短超时客户端，避免 Zabbix 不可达时拖住整轮采集；不传则按全局
                     配置新建（30s 超时）。
    :return: dict，同时带两套兼容结构：
             - 通用引擎：platform / platform_text / boot_time / cpu / memory /
               disk / disk_list
             - Oracle 原始结构：hostname / os_version / kernel / uptime / cpu_model /
               cpu_count / cpu_usage_pct / mem_*_mb / swap_*_mb / load_average /
               disk_usage / network ...
    :raises ZabbixSysInfoError: 配置缺失、主机未找到或采集失败
    """
    host_ip = (host_ip or '').strip()
    hostname = (hostname or '').strip()
    if not host_ip and not hostname:
        raise ZabbixSysInfoError('未指定 Zabbix 目标主机（IP 或主机名）')

    cfg = load_zabbix_config()
    if not (cfg.get('url') or '').strip():
        raise ZabbixSysInfoError(
            'Zabbix 连接未配置，请先在「Zabbix 监控设置」页面配置 Zabbix 服务器地址与认证信息')

    if client is None:
        from modules.zabbix.config import get_client_from_config
        client = get_client_from_config()

    try:
        hosts = client.find_host(ip=host_ip, hostname=hostname)
    except ZabbixError as e:
        raise ZabbixSysInfoError('查询 Zabbix 主机失败: %s' % e)
    if not hosts:
        raise ZabbixSysInfoError(
            '在 Zabbix 中未找到主机（IP=%s / 主机名=%s），请确认该主机已被 Zabbix 纳管'
            % (host_ip or '?', hostname or '?'))
    host = hosts[0]
    hostid = host.get('hostid')

    try:
        items = client.get_items(hostid=hostid)
    except ZabbixError as e:
        raise ZabbixSysInfoError('获取 Zabbix 监控项失败: %s' % e)
    if not items:
        raise ZabbixSysInfoError('Zabbix 主机 %s 下没有可用监控项' % (host.get('name') or hostid))

    categorized = categorize_items(items)
    os_type = detect_os(items)

    # ── CPU 使用率 ──
    # Zabbix 6.4+ Linux 模板里总体项 system.cpu.util、空闲项 system.cpu.util[,idle]
    # 与分量项 [,user]/[,system]/[,guest_nice] 并存。必须优先总体项/空闲项，
    # 误取分量项（常常是 0）会把整机 CPU 报成 0%。
    cpu_usage = None
    cpu_items = categorized.get('cpu', [])
    for exact in ('system.cpu.util', 'system.cpu.util[,idle]'):
        for it in cpu_items:
            if it.get('key_') != exact:
                continue
            v = parse_float(it.get('lastvalue'))
            if v is None:
                break
            usage = (100.0 - v) if exact.endswith('idle]') else v
            if 0 <= usage <= 100:
                cpu_usage = round(usage, 1)
                break
        if cpu_usage is not None:
            break
    if cpu_usage is None:
        # 兜底：排除分量 key，只接受无参项或 idle 项
        for it in cpu_items:
            key = it.get('key_', '')
            if not key.startswith('system.cpu.util'):
                continue
            if key.count('[') > 1 or (',' in key and 'idle' not in key):
                continue
            v = parse_float(it.get('lastvalue'))
            if v is None:
                continue
            usage = (100.0 - v) if 'idle' in key else v
            if 0 <= usage <= 100:
                cpu_usage = round(usage, 1)
                break
    if cpu_usage is None:
        primary = pick_memory_percent(cpu_items)  # 兼容 pused 风格的少数模板
        if primary:
            v = parse_float(primary.get('lastvalue'))
            if v is not None and 0 <= v <= 100:
                cpu_usage = round(v, 1)

    cpu_model = ''
    m = _item_last(items, 'cpu.model') or _item_last(items, 'agent.cpu.model')
    if m and m.get('lastvalue'):
        cpu_model = str(m.get('lastvalue'))
    cpu_count = ''
    for cand in ('system.cpu.num[core]', 'system.cpu.num', 'cpu.num'):
        for it in items:
            if it.get('key_') == cand and it.get('lastvalue') not in (None, ''):
                cpu_count = str(it.get('lastvalue'))
                break
        if cpu_count:
            break

    # ── 内存 ──
    mem_usage = None
    mem_primary = pick_memory_percent(categorized.get('memory', []))
    if mem_primary:
        v = parse_float(mem_primary.get('lastvalue'))
        if v is not None and 0 <= v <= 100:
            mem_usage = round(100.0 - v, 1) if 'pavailable' in mem_primary.get('key_', '') else round(v, 1)
    mem_total_mb = 0.0
    mem_used_mb = 0.0
    mem_available_mb = 0.0
    swap_total_mb = 0.0
    swap_used_mb = 0.0
    for it in items:
        key = it.get('key_', '')
        v = parse_float(it.get('lastvalue'))
        if v is None:
            continue
        units = it.get('units', '')
        mm = re.match(r'^vm\.memory\.size\[(total|used|available)\]', key)
        if mm:
            val = round(_to_mb(v, units), 2)
            if mm.group(1) == 'total':
                mem_total_mb = val
            elif mm.group(1) == 'used':
                mem_used_mb = val
            else:
                mem_available_mb = val
        sm = re.match(r'^vm\.swap\.size\[(total|used)\]', key)
        if sm:
            val = _to_mb(v, units)
            if sm.group(1) == 'total':
                swap_total_mb = round(val, 2)
            else:
                swap_used_mb = round(val, 2)
    # 有些模板只给 total/available，或只给百分比，已用量靠推算补齐
    if mem_used_mb <= 0 and mem_total_mb > 0:
        if mem_available_mb > 0:
            mem_used_mb = round(mem_total_mb - mem_available_mb, 2)
        elif mem_usage is not None:
            mem_used_mb = round(mem_total_mb * mem_usage / 100.0, 2)

    # ── 磁盘：按挂载点归集 total / used / free / pused ──
    fs_map = {}
    for it in items:
        parsed = _parse_fs_key(it.get('key_', ''))
        if not parsed:
            continue
        mp, field = parsed
        if mp in IGNORE_MOUNTS:
            continue
        entry = fs_map.setdefault(mp, {'units': it.get('units', '')})
        entry[field] = parse_float(it.get('lastvalue'))
        if field == 'pused':
            entry['pused_clock'] = int(it.get('lastclock') or 0)
    if not fs_map:
        # 兼容只有 vfs.fs.get 主项的旧 agent
        for pseudo in parse_fs_get_disk(items):
            parsed = _parse_fs_key(pseudo.get('key_', ''))
            if not parsed:
                continue
            mp, field = parsed
            # 忽略挂载点在主路径里已生效，兜底路径同样要过滤，
            # 否则 /mnt/iso 这类光驱会被当成一块高使用率磁盘写进报告
            if mp in IGNORE_MOUNTS:
                continue
            fs_map.setdefault(mp, {})[field] = parse_float(pseudo.get('lastvalue'))

    disk = {}
    disk_list = []
    for mp, entry in fs_map.items():
        pused = entry.get('pused')
        if pused is None:
            continue
        # clock=0 且 pused=0 说明该监控项从未上报过数据（常见于 Windows agent 失效），
        # 渲染成 0% 会误导，直接丢弃这条
        if entry.get('pused_clock', 0) == 0 and pused == 0:
            continue
        total = entry.get('total')
        used = entry.get('used')
        free = entry.get('free')
        if free is None and total is not None and used is not None:
            free = total - used
        total_gb = round(_to_mb(total, entry.get('units', '')) / 1024.0, 2) if total is not None else 0.0
        used_gb = round(_to_mb(used, entry.get('units', '')) / 1024.0, 2) if used is not None else 0.0
        free_gb = round(_to_mb(free, entry.get('units', '')) / 1024.0, 2) if free is not None else 0.0
        if total_gb <= 0 and used_gb > 0 and free_gb > 0:
            total_gb = round(used_gb + free_gb, 2)
        d = {
            'device': 'zabbix',
            'mountpoint': mp,
            'fstype': 'unknown',
            'total_gb': total_gb,
            'used_gb': used_gb,
            'free_gb': free_gb,
            'usage_percent': round(max(0.0, min(100.0, pused)), 1),
        }
        disk[mp] = d
        disk_list.append(d)
    disk_list.sort(key=lambda x: x['usage_percent'], reverse=True)

    # df 风格文本（Oracle 报告直接用）
    disk_usage_lines = ['Filesystem      Size  Used Avail Use% Mounted on']
    for d in disk_list:
        disk_usage_lines.append(
            '%-15s %4s  %4s %4s %3d%% %s' % (
                d['mountpoint'] or '/', _human_size(d['total_gb']),
                _human_size(d['used_gb']), _human_size(d['free_gb']),
                int(d['usage_percent']), d['mountpoint'] or '/'
            )
        )
    disk_usage_text = '\n'.join(disk_usage_lines) if len(disk_usage_lines) > 1 else ''

    # ── 负载均值（Linux 有，Windows 无）──
    load_vals = {}
    for it in items:
        key = it.get('key_', '')
        lm = (re.match(r'^system\.cpu\.load\[(?:percpu|all),(avg\d+)\]$', key)
              or re.match(r'^system\.load(1|5|15)$', key))
        if not lm:
            continue
        v = parse_float(it.get('lastvalue'))
        if v is None:
            continue
        load_vals[lm.group(1)] = v
    load_average = ''
    if load_vals:
        parts = []
        for k in ('avg1', 'avg5', 'avg15', '1', '5', '15'):
            if k in load_vals:
                parts.append('%.2f' % load_vals.pop(k))
        load_average = '  '.join(parts)

    # ── 系统版本与启动时间 ──
    uname_it = _item_last(items, 'system.uname')
    uname_text = str(uname_it.get('lastvalue')).strip() if uname_it and uname_it.get('lastvalue') else ''
    if os_type == 'windows':
        platform_text = uname_text or 'Windows'
        kernel = ''
    else:
        # Linux uname 形如：Linux hostname 5.10.0-xx ...
        m = re.match(r'^(Linux\s+\S+\s+[\d.]+\S*)', uname_text)
        kernel = m.group(1).split()[2] if m and len(uname_text.split()) > 2 else ''
        platform_text = uname_text or 'Linux'

    up_it = _item_last(items, 'system.uptime')
    boot_time = ''
    uptime_text = ''
    if up_it:
        up = parse_float(up_it.get('lastvalue'))
        if up is not None and up >= 0:
            # Zabbix 只报运行秒数，启动时刻由 当前时间 - uptime 反推
            boot_time = datetime.fromtimestamp(time.time() - up).strftime('%Y-%m-%d %H:%M:%S')
            days = int(up) // 86400
            hours = (int(up) % 86400) // 3600
            minutes = (int(up) % 3600) // 60
            uptime_text = 'up %d days, %d:%02d' % (days, hours, minutes) if days else 'up %d:%02d' % (hours, minutes)

    # ── 网络地址（部分模板提供 ip.address 项）──
    ip_lines = []
    for it in items:
        if (it.get('key_') or '').startswith('ip.address') and it.get('lastvalue'):
            ip_lines.append(str(it.get('lastvalue')))
    network = '\n'.join(ip_lines)

    hostname_text = host.get('name') or host.get('host') or host_ip or hostname

    cpu_usage_val = 0.0 if cpu_usage is None else cpu_usage
    mem_usage_val = 0.0 if mem_usage is None else mem_usage
    return {
        # 通用巡检引擎使用
        'platform': ('Windows' if os_type == 'windows' else 'Linux'),
        'platform_text': platform_text,
        'boot_time': boot_time or '未知',
        'cpu': {'Model name': cpu_model, 'usage_percent': cpu_usage_val},
        'memory': {'total_mb': mem_total_mb, 'used_mb': mem_used_mb, 'usage_percent': mem_usage_val},
        'disk': disk,
        'disk_list': disk_list,

        # Oracle 报告的结构化字段
        'hostname': hostname_text,
        'os_version': platform_text,
        'kernel': kernel,
        'uptime': uptime_text,
        'cpu_model': cpu_model,
        'cpu_count': cpu_count,
        'cpu_usage_pct': str(cpu_usage_val),
        'mem_total_mb': str(mem_total_mb),
        'mem_used_mb': str(mem_used_mb),
        'mem_usage_pct': str(mem_usage_val),
        'swap_total_mb': str(swap_total_mb),
        'swap_used_mb': str(swap_used_mb),
        'load_average': load_average,
        'disk_usage': disk_usage_text,
        'hosts': '',
        'sysctl': '',
        'limits': '',
        'hugepages': '',
        'thp': '',
        'crontab': '',
        'network': network,

        # 数据来源标记，报告与排障时区分 SSH / Zabbix
        '_source': 'zabbix',
        '_zabbix': {
            'hostid': hostid,
            'host': host.get('host', ''),
            'name': host.get('name', ''),
            'ip': _interface_ip(host),
            'os': os_type,
            'zabbix_url': cfg.get('url', ''),
            'fetched_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        },
    }
