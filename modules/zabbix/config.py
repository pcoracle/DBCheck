# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""Zabbix 全局连接配置。

存放在 ``dbc_config.json`` 的 ``zabbix_monitor.zabbix`` 节点，属于整机级配置：
巡检向导第 3 步与「Zabbix 监控设置」页共用它，向导本身不保存 URL/Token。

读写直接复用 modules.notify 的配置文件助手与加解密工具：那套实现已处理
并发写半截文件的重试、原子替换、以及「配置持续不可读时拒绝整体覆盖」，
避免本模块另起一份密钥或把其它配置节点写丢。
"""

from modules.notify import (
    CONFIG_FILE,
    _atomic_write_json,
    _decrypt_password,
    _encrypt_password,
    _read_config_file,
)

CONFIG_NODE = 'zabbix_monitor'

# 默认值全部留空：真实地址与凭据只能由用户在设置页填写
DEFAULT_ZABBIX_CONFIG = {
    'url': '',
    'api_token': '',
    'username': '',
    'password': '',
    'verify_ssl': True,
    'refresh_interval': 60,    # 监控页自动刷新间隔（秒），0 表示不自动刷新
    'data_retention_days': 7,  # 监控数据本地保存天数
}


def _load_raw_node():
    """读取 dbc_config.json 的 zabbix_monitor.zabbix 原始节点。"""
    config = _read_config_file() or {}
    node = config.get(CONFIG_NODE) or {}
    zabbix = node.get('zabbix')
    return zabbix if isinstance(zabbix, dict) else {}


def load_zabbix_config():
    """加载 Zabbix 配置（凭据已解密），缺失字段按默认值补齐。"""
    stored = _load_raw_node()
    result = dict(DEFAULT_ZABBIX_CONFIG)
    for key in result:
        if key in stored:
            result[key] = stored[key]
    if result.get('password'):
        result['password'] = _decrypt_password(result['password'])
    if result.get('api_token'):
        result['api_token'] = _decrypt_password(result['api_token'])
    return result


def get_masked_config():
    """页面回显用：凭据换成占位符，另给「有没有配过」的布尔标记。"""
    cfg = load_zabbix_config()
    masked = dict(cfg)
    masked['has_api_token'] = bool(cfg.get('api_token'))
    masked['has_password'] = bool(cfg.get('password'))
    for field in ('api_token', 'password'):
        if masked.get(field):
            masked[field] = '***'
    return {'zabbix': masked}


def save_zabbix_config(zabbix_cfg):
    """保存 Zabbix 配置（凭据加密落盘），只更新 zabbix 节点。

    页面回显的是 ``***``，原样提交回来时必须沿用库里已有的真实凭据，
    否则一次保存就会把 Token 覆盖成星号。
    """
    if not isinstance(zabbix_cfg, dict):
        return False
    config = _read_config_file()
    if config is None:
        # 配置持续不可读：放弃写入，避免以空字典为基底清空其它节点
        print('dbc_config.json 读取失败，已放弃保存 Zabbix 配置以避免破坏其他配置节点')
        return False

    node = config.get(CONFIG_NODE)
    if not isinstance(node, dict):
        node = {}
    old_z = node.get('zabbix') if isinstance(node.get('zabbix'), dict) else {}

    new_z = dict(DEFAULT_ZABBIX_CONFIG)
    for key in new_z:
        if key in zabbix_cfg:
            new_z[key] = zabbix_cfg[key]

    for field in ('api_token', 'password'):
        value = str(new_z.get(field) or '')
        if '***' in value:
            # 未改动：保留原值（先撤掉本轮可能加上的前缀，避免二次加密）
            new_z[field] = old_z.get(field, '')
        elif value:
            new_z[field] = _encrypt_password(value)
        else:
            new_z[field] = ''

    node['zabbix'] = new_z
    # _encrypt_password 可能刚刚把新建的加密密钥写进了同一个文件；以最新内容
    # 为基底合并本轮节点，否则整体写回会把密钥覆盖掉，已存密文永久解不开。
    latest = _read_config_file()
    if not isinstance(latest, dict):
        latest = config
    latest[CONFIG_NODE] = node
    try:
        _atomic_write_json(CONFIG_FILE, latest)
        return True
    except Exception as e:
        print('保存 Zabbix 配置失败: %s' % e)
        return False


# ─── 手工主机清单（IP + 主机名 + 备注）─────────────────────────────────
# 监控页左栏列的是这份本地清单，不是 Zabbix 侧的全量主机：用户先登记要盯的
# 机器，选中后再按 IP/主机名匹配到 Zabbix 主机取数。清单与连接配置同节点存放，
# 重启不丢；folder_id 只做透传保存，MVP 不提供文件夹树。

def get_server_list():
    """获取手工主机清单（[{id, ip, hostname, remark, folder_id}]）。"""
    config = _read_config_file() or {}
    node = config.get(CONFIG_NODE)
    if not isinstance(node, dict):
        return []
    servers = node.get('servers', [])
    return servers if isinstance(servers, list) else []


def _save_servers(servers):
    """把清单写回 zabbix_monitor 节点，只动 servers 键。"""
    config = _read_config_file()
    if config is None:
        # 与 save_zabbix_config 同一道护栏：读不出来就不写，避免清空其它节点
        print('dbc_config.json 读取失败，已放弃保存 Zabbix 主机清单以避免破坏其他配置节点')
        return False
    node = config.get(CONFIG_NODE)
    if not isinstance(node, dict):
        node = {}
    node['servers'] = servers
    config[CONFIG_NODE] = node
    try:
        _atomic_write_json(CONFIG_FILE, config)
        return True
    except Exception as e:
        print('保存服务器列表失败: %s' % e)
        return False


def add_servers(items):
    """批量登记主机，items: [{ip, hostname, remark, folder_id}]，返回新增列表。

    按 IP 去重：同一台机器重复登记会在左栏出现两条指向同一主机的记录。
    id 取现有最大值 +1，删除后不复用旧号，避免前端缓存的选中项串到别的机器。
    """
    servers = get_server_list()
    existing_ips = {s.get('ip') for s in servers}
    added = []
    max_id = 0
    for s in servers:
        try:
            max_id = max(max_id, int(s.get('id', 0)))
        except (TypeError, ValueError):
            pass
    for item in items:
        ip = (item.get('ip') or '').strip()
        if not ip:
            continue
        if ip in existing_ips:
            continue
        max_id += 1
        new = {
            'id': max_id,
            'ip': ip,
            'hostname': (item.get('hostname') or '').strip(),
            'remark': (item.get('remark') or '').strip(),
            'folder_id': item.get('folder_id') or None,
        }
        servers.append(new)
        existing_ips.add(ip)
        added.append(new)
    if added:
        _save_servers(servers)
    return added


def update_server(sid, ip=None, hostname=None, remark=None, folder_id=None):
    """修改清单条目（IP / 主机名 / 备注 / 所属文件夹），返回更新后的记录或 None。"""
    servers = get_server_list()
    for s in servers:
        if str(s.get('id')) == str(sid):
            if ip is not None:
                s['ip'] = (ip or '').strip()
            if hostname is not None:
                s['hostname'] = (hostname or '').strip()
            if remark is not None:
                s['remark'] = (remark or '').strip()
            if folder_id is not None:
                s['folder_id'] = folder_id or None
            _save_servers(servers)
            return s
    return None


def delete_server(sid):
    """从清单移除一台主机，返回是否删除成功。"""
    servers = get_server_list()
    new_servers = [s for s in servers if str(s.get('id')) != str(sid)]
    if len(new_servers) != len(servers):
        _save_servers(new_servers)
        return True
    return False


def is_configured(cfg=None):
    """是否具备发起 API 调用的最小条件（有地址 + 有任一凭据）。"""
    cfg = cfg if cfg is not None else load_zabbix_config()
    return bool((cfg.get('url') or '').strip())


def get_client_from_config(timeout=30):
    """按全局配置构造客户端；未配置地址时抛 ZabbixError 给调用方兜现文案。"""
    from modules.zabbix.client import ZabbixClient, ZabbixError

    cfg = load_zabbix_config()
    if not is_configured(cfg):
        raise ZabbixError(
            'Zabbix 连接未配置，请先在「Zabbix 监控设置」页面配置 Zabbix 服务器地址与认证信息')
    return ZabbixClient(
        url=cfg.get('url'),
        api_token=cfg.get('api_token'),
        username=cfg.get('username'),
        password=cfg.get('password'),
        verify_ssl=bool(cfg.get('verify_ssl', True)),
        timeout=timeout,
    )
