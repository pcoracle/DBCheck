# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""Zabbix 监控接入包。

对外提供四件事：
  - config：全局 Zabbix 连接配置与手工主机清单（dbc_config.json 的 zabbix_monitor 节点）
  - client：Zabbix JSON-RPC API 客户端
  - sysinfo：按主机 IP/主机名读取最新监控项，整理成与 SSH 采集同构的 system_info
  - binding：解析「巡检该用哪个 Zabbix 主机」（显式传入 > 数据源绑定 > IP 自动匹配 > 候选）

巡检向导第 3 步「系统资源采集」的 Zabbix 分支、Zabbix 监控设置页与监控页都只依赖本包。
"""

from modules.zabbix.binding import find_candidates, resolve_zabbix_target, zabbix_available
from modules.zabbix.client import ZabbixClient, ZabbixError
from modules.zabbix.config import (
    DEFAULT_ZABBIX_CONFIG,
    add_servers,
    delete_server,
    get_client_from_config,
    get_masked_config,
    get_server_list,
    load_zabbix_config,
    save_zabbix_config,
    update_server,
)
from modules.zabbix.sysinfo import ZabbixSysInfoError, collect_zabbix_system_info

__all__ = [
    'ZabbixClient',
    'ZabbixError',
    'ZabbixSysInfoError',
    'DEFAULT_ZABBIX_CONFIG',
    'add_servers',
    'collect_zabbix_system_info',
    'delete_server',
    'find_candidates',
    'get_client_from_config',
    'get_masked_config',
    'get_server_list',
    'load_zabbix_config',
    'resolve_zabbix_target',
    'save_zabbix_config',
    'update_server',
    'zabbix_available',
]
