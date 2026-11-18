# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""巡检该用哪个 Zabbix 主机采系统资源 —— 多级解析（单一入口）。

系统资源有三条采集路：本地 / SSH / Zabbix。Zabbix 这条如果只认「巡检向导当次
传参」，定时巡检就永远拿不到 CPU/内存/磁盘：任务里没有地方保存目标主机，
数据源里也没有对应字段。本模块把目标解析收敛成一个入口，按优先级取：

| 级别 | 来源 | 说明 |
|---|---|---|
| ``explicit`` | ``db_info['zabbix_host']`` / ``zabbix_hostname`` | 向导第 3 步当次传入 |
| ``bound`` | ``db_info['zabbix_host_ip']`` / ``zabbix_host_name`` | 数据源里持久化的绑定（定时巡检靠它） |
| ``auto_ip`` | 拿 DB 实例的 ``host`` 直接问 Zabbix | 按 IP 取，命中即用 |
| ``candidate`` | 按 service_name / 实例名模糊匹配主机名 | **只给候选，不自动采用** |

[WARN] 最后一级故意不自动绑定：同一个关键词（如 ``weasdb``）可能同时前缀命中
``db-01-192.0.2.21``（真正那台）与 ``ZB-NODE-192.0.2.35``（另一台）。自动选错会把
别的机器的内存/磁盘当成这台库的，风险远大于收益。所以返回候选让用户在数据源里
点一次确认，之后定时巡检直接用绑定，不再需要人工介入。

[WARN] DB 连接地址与 Zabbix 侧地址可能不在同一网段：实例连 ``192.0.2.10``，
而 Zabbix 里这台机器登记为 ``192.0.2.21`` —— ``auto_ip`` 必然落空，只能靠
``bound`` 绑定或候选匹配解决。
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Tuple

__all__ = [
    'zabbix_available', 'resolve_zabbix_target', 'resolve_inspection_target',
    'find_candidates', 'host_display', 'host_ips',
]

#: 实例名里的噪声词（拆词后若整段命中就丢弃，避免拿「测试/环境」当关键词）
_NOISE = re.compile(
    r'^(测试|生产|开发|环境|正式|外帐|内帐|主|备|库|数据库|服务器|实例|'
    r'test|prod|dev|env|db|database|server|instance)+$', re.I)

#: **无区分度**的词：数据库类型 / 操作系统之类，命中它们会匹配一大堆不相干主机
_GENERIC = frozenset({
    'oracle', 'mysql', 'postgres', 'postgresql', 'pg', 'sqlserver', 'mssql', 'sql',
    'tidb', 'dm', 'dm8', 'gbase', 'kingbase', 'kingbasees', 'ivorysql', 'yashandb',
    'oceanbase', 'db2', 'redis', 'mongo', 'mongodb',
    'linux', 'windows', 'unix', 'centos', 'redhat', 'ubuntu', 'suse', 'oraclelinux',
    'host', 'server', 'node', 'vm', 'virtual', 'x86', 'x64',
})


def zabbix_available() -> Tuple[bool, str]:
    """Zabbix 是否已配置可用。返回 ``(可用, 不可用原因)``。"""
    try:
        from modules.zabbix.config import load_zabbix_config
        cfg = load_zabbix_config() or {}
    except Exception as exc:
        return False, '读取 Zabbix 配置失败: %s' % exc
    if not str(cfg.get('url') or '').strip():
        return False, '未配置 Zabbix 服务器地址（在「Zabbix 监控设置」页面配置）'
    if not (cfg.get('api_token') or cfg.get('username')):
        return False, '未配置 Zabbix 认证信息（API Token 或用户名密码）'
    return True, ''


def _client():
    from modules.zabbix.config import get_client_from_config
    return get_client_from_config()


def host_ips(host: Dict[str, Any]) -> List[str]:
    """取主机所有接口 IP（一个主机可能有多张网卡/多个接口）。"""
    ips: List[str] = []
    for itf in ((host or {}).get('interfaces') or []):
        if not isinstance(itf, dict):
            continue
        ip = str(itf.get('ip') or '').strip()
        if ip and ip not in ips:
            ips.append(ip)
    return ips


def host_display(host: Dict[str, Any]) -> str:
    """主机展示名：``name（host）``，并标出是否禁用/不可达。"""
    if not isinstance(host, dict):
        return ''
    name = str(host.get('name') or '').strip()
    tech = str(host.get('host') or '').strip()
    label = name or tech
    if name and tech and name != tech:
        label = '%s（%s）' % (name, tech)
    flags = []
    if str(host.get('status')) == '1':
        flags.append('已禁用')
    if str(host.get('available')) == '2':
        flags.append('不可达')
    return label + ('　[%s]' % '/'.join(flags) if flags else '')


def _keywords(db_info: Dict[str, Any]) -> List[str]:
    """从实例信息里提取可用于匹配 Zabbix 主机名的关键词。

    来源：``service_name``（Oracle 服务名，最可靠）、``database``、实例 ``name``。
    按非字母数字切分，丢掉短片段、纯数字与噪声词。
    """
    out: List[str] = []
    seen = set()
    for raw in (db_info.get('service_name'), db_info.get('database'), db_info.get('name')):
        text = str(raw or '').strip()
        if not text:
            continue
        for token in re.split(r'[^0-9A-Za-z_]+', text):
            token = token.strip('-_ ')
            if len(token) < 3 or token.isdigit():
                continue
            if _NOISE.match(token) or token.lower() in _GENERIC:
                continue
            key = token.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(token)
    return out


def _score(host: Dict[str, Any], keywords: List[str],
           host_ip: str) -> Tuple[int, str]:
    """给候选主机打分。返回 ``(分数, 理由)``，0 分为不匹配。

    分值刻意拉开档次：IP 一致(100) > 主机名/显示名完全一致(90) >
    前缀命中(80) > 连字符分段命中(70) > 任意位置包含(50)。
    """
    ips = host_ips(host)
    if host_ip and host_ip in ips:
        return 100, 'IP 完全一致'

    name = str(host.get('host') or '')
    disp = str(host.get('name') or '')
    best, why = 0, ''
    for kw in keywords:
        k = kw.lower()
        for field, label in ((name, '主机名'), (disp, '显示名')):
            f = field.lower()
            if not f:
                continue
            if f == k:
                cand, text = 90, '%s 完全一致' % label
            elif f.startswith(k):
                cand, text = 80, '%s 以「%s」开头' % (label, kw)
            elif ('-' + k) in f or ('_' + k) in f:
                cand, text = 70, '%s 含分段「%s」' % (label, kw)
            elif k in f:
                cand, text = 50, '%s 含「%s」' % (label, kw)
            else:
                continue
            if cand > best:
                best, why = cand, text
    return best, why


def find_candidates(db_info: Dict[str, Any], limit: int = 8) -> List[Dict[str, Any]]:
    """按实例信息找出 Zabbix 候选主机（供界面点选确认）。

    返回按分数降序的列表，每项含 ``host_ip`` / ``host_name`` / ``label`` /
    ``reason`` / ``score`` / ``available``，可直接作为绑定值写回数据源。
    """
    ok, _why = zabbix_available()
    if not ok:
        return []

    client = _client()
    kw = _keywords(db_info)
    target_ip = str(db_info.get('host') or '').strip()

    # [WARN] 必须**按关键词查询**，不能拉全量再本地过滤：get_hosts 有 limit 且按
    #    host 排序，主机一多目标就被截断。
    found: Dict[str, Dict[str, Any]] = {}

    def _merge(items):
        for item in (items or []):
            hid = str(item.get('hostid') or '')
            if hid and hid not in found:
                found[hid] = item

    for keyword in kw[:4]:
        try:
            _merge(client.get_hosts(search=keyword, limit=200))
        except Exception:
            continue
    if target_ip:
        try:
            _merge(client.find_host(ip=target_ip))
        except Exception:
            pass
    if not found:
        # 关键词一个都没命中 → 退化为拉一批，至少给用户可选项
        try:
            _merge(client.get_hosts(limit=200))
        except Exception:
            return []

    scored: List[Dict[str, Any]] = []
    for h in found.values():
        score, reason = _score(h, kw, target_ip)
        if score <= 0:
            continue
        ips = host_ips(h)
        scored.append({
            'score': score,
            'reason': reason,
            'label': host_display(h),
            'host_name': str(h.get('host') or ''),
            'display_name': str(h.get('name') or ''),
            'host_ip': (ips[0] if ips else ''),
            'all_ips': ips,
            'enabled': str(h.get('status')) != '1',
            'available': str(h.get('available')) != '2',
        })
    scored.sort(key=lambda x: (-x['score'], x['host_name']))
    return scored[:limit]


def resolve_zabbix_target(db_info: Dict[str, Any],
                          probe: bool = True,
                          allow_candidates: bool = True) -> Dict[str, Any]:
    """解析「该用哪个 Zabbix 主机」—— 巡检采集路径的统一入口。

    :param db_info: 巡检用的连接信息（数据源 dict 或前端向导拼的 dict）
    :param probe: 是否允许联网探测（``auto_ip`` / ``candidate`` 级需要）。False 时
                  只用显式传入或已持久化的绑定，适合离线/单测场景。
    :param allow_candidates: 未命中时是否做模糊匹配候选。候选匹配要按关键词多次
                  查询主机清单（数百台时数秒），只对**要展示给用户点选**的界面路径
                  有意义；后台周期采集应传 False，否则白等。
    :return: dict
        - ``ok``          是否解析到可直接使用的目标
        - ``zabbix_info`` ``{'host_ip':…, 'hostname':…}``（ok 时非空）
        - ``source``      ``explicit`` / ``bound`` / ``auto_ip`` / ``candidate`` /
                          ``none`` / ``unavailable``
        - ``target``      命中的主机展示名（用于日志）
        - ``candidates``  未解析到时给出的候选，供界面点选
        - ``error``       没解析到的原因（可直接展示给用户）
    """
    result: Dict[str, Any] = {
        'ok': False, 'zabbix_info': None, 'source': 'unavailable',
        'target': '', 'candidates': [], 'error': '',
    }

    ok, why = zabbix_available()
    if not ok:
        result['error'] = why
        return result

    # ① 显式传入（向导第 3 步选「Zabbix 采集」时填的）
    ex_ip = str(db_info.get('zabbix_host') or '').strip()
    ex_name = str(db_info.get('zabbix_hostname') or '').strip()
    if ex_ip or ex_name:
        result.update(ok=True, source='explicit', target=(ex_name or ex_ip),
                      zabbix_info={'host_ip': ex_ip, 'hostname': ex_name})
        return result

    # ② 数据源里持久化的绑定（定时巡检主要靠这一级）
    b_ip = str(db_info.get('zabbix_host_ip') or '').strip()
    b_name = str(db_info.get('zabbix_host_name') or '').strip()
    if b_ip or b_name:
        result.update(ok=True, source='bound', target=(b_name or b_ip),
                      zabbix_info={'host_ip': b_ip, 'hostname': b_name})
        return result

    if not probe:
        result['source'] = 'none'
        result['error'] = ('该数据源未绑定 Zabbix 主机。此实例不在 Zabbix 已纳管范围内，'
                           '或需要先在数据源里指定 Zabbix 主机')
        return result

    # ③ 按 DB 实例的 host IP 直接问 Zabbix（用户期望的「按 IP 取」）
    target_ip = str(db_info.get('host') or '').strip()
    if target_ip:
        try:
            hosts = _client().find_host(ip=target_ip) or []
        except Exception as exc:
            result['error'] = '查询 Zabbix 主机失败: %s' % exc
            hosts = []
        if hosts:
            h = hosts[0]
            result.update(
                ok=True, source='auto_ip', target=host_display(h),
                zabbix_info={'host_ip': target_ip,
                             'hostname': str(h.get('host') or '')})
            return result

    # ④ 模糊匹配给候选（不自动采用）
    if not allow_candidates:
        result['source'] = 'unavailable'
        result['error'] = ('Zabbix 里没有 IP 为 %s 的主机；请确认该机器已被 Zabbix 纳管，'
                           '或在数据源里指定 Zabbix 主机' % (target_ip or '?'))
        return result
    try:
        cands = find_candidates(db_info)
    except Exception:
        cands = []
    result['source'] = 'candidate'
    result['candidates'] = cands
    if cands:
        result['error'] = (
            'Zabbix 里没有 IP 为 %s 的主机。找到 %d 个名称相近的候选，'
            '请在数据源里点选确认（避免绑错到别的机器）' % (target_ip or '?', len(cands)))
    else:
        result['error'] = ('Zabbix 里没有 IP 为 %s 的主机，也没有名称相近的主机；'
                           '请确认该机器已被 Zabbix 纳管' % (target_ip or '?'))
    return result


def resolve_inspection_target(db_info: Dict[str, Any]) -> Tuple[Any, str]:
    """巡检采集路径专用：确定本轮的 Zabbix 目标，返回 ``(zabbix_info | None, source)``。

    顺序：显式传入（向导第 3 步）→ 数据源持久化绑定。

    [WARN] 未绑定的数据源**直接跳过，不联网探测**：拿数据源 IP 去 Zabbix 主机里
    猜，每次巡检白等数秒，还会在日志里刷一条「未使用 Zabbix 采集」。要按名称找
    候选请走界面（``find_candidates``），由用户点选确认后落成绑定。

    采集只认精确匹配，``allow_candidates=False``：模糊候选可能指向另一台机器，
    把别人的内存/磁盘当成这台库的。
    """
    db_info = db_info or {}
    ex_ip = str(db_info.get('zabbix_host') or '').strip()
    ex_name = str(db_info.get('zabbix_hostname') or '').strip()
    if ex_ip or ex_name:
        return {'host_ip': ex_ip, 'hostname': ex_name}, 'explicit'
    if not str(db_info.get('zabbix_host_ip') or '').strip() \
            and not str(db_info.get('zabbix_host_name') or '').strip():
        return None, 'unbound'
    try:
        result = resolve_zabbix_target(db_info, allow_candidates=False)
    except Exception as exc:
        print('  [INFO] 未使用 Zabbix 采集系统资源（解析失败: %s）' % exc)
        return None, 'error'
    if result.get('ok'):
        return result.get('zabbix_info'), result.get('source', 'auto')
    if result.get('error'):
        # 只留一行原因；候选清单是给界面点选用的，打进巡检日志没有价值
        print('  [INFO] 未使用 Zabbix 采集系统资源：%s' % result['error'])
    return None, result.get('source', 'none')