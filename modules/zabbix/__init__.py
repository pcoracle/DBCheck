# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
"""Zabbix 监控接入包。

对外提供三件事：
  - config：全局 Zabbix 连接配置（dbc_config.json 的 zabbix_monitor 节点）
  - client：Zabbix JSON-RPC API 客户端
  - sysinfo：按主机 IP/主机名读取最新监控项，整理成与 SSH 采集同构的 system_info

巡检向导第 3 步「系统资源采集」的 Zabbix 分支、Zabbix 监控设置页都只依赖本包。
"""

from modules.zabbix.client import ZabbixClient, ZabbixError
from modules.zabbix.config import (
    DEFAULT_ZABBIX_CONFIG,
    get_client_from_config,
    get_masked_config,
    load_zabbix_config,
    save_zabbix_config,
)
from modules.zabbix.sysinfo import ZabbixSysInfoError, collect_zabbix_system_info

__all__ = [
    'ZabbixClient',
    'ZabbixError',
    'ZabbixSysInfoError',
    'DEFAULT_ZABBIX_CONFIG',
    'collect_zabbix_system_info',
    'get_client_from_config',
    'get_masked_config',
    'load_zabbix_config',
    'save_zabbix_config',
]
