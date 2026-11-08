# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · 内置工具清单与注册。

归属说明：20 个内置工具的语义设计归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) 所有：

    数据源管理 3 · 巡检 3 · SQL 执行 3 · 监控 2 · 报告 1 · 调度 1 · 仪表盘 1
    基线 1 · 巡检模板 3 · 方言与版本 2

另有 3 个 Zabbix 服务器监控工具（``list_zabbix_servers`` /
``get_zabbix_server_status`` / ``get_zabbix_server_history``）暂不注册：
项目里还没有 Zabbix 模块，没有数据源可查时注册它们只会让模型
每次调用都失败，等 Zabbix 模块落地再随模块一起注册。

注册名与参数一律用**数据源名称**（用户与模型说的都是名称），ID 由
``datasource_access.find_datasource`` 内部解析，歧义时交给助手发起确认。
"""
from modules.ai.tools import (catalog_tools, datasource_tools, inspection_tools,
                              monitor_tools, sql_tools, template_tools)

OBJECT_PARAMETER = {'type': 'object', 'properties': {}, 'required': []}

TOOL_DEFINITIONS = [
    # ── 数据源管理 ──
    dict(name='list_datasources', category='数据源管理',
         description='列出当前用户可见的数据库数据源（名称、类型、主机、目录 dir_path、'
                     '业务标签 labels），可按类型/目录/标签筛选',
         parameters={'type': 'object', 'properties': {
             'db_type': {'type': 'string', 'description': '数据库类型：mysql/pg/oracle/dm/sqlserver/tidb/all'},
             'dir_path': {'type': 'string', 'description': '目录筛选（如「深圳机房/宝德」，含下级目录）'},
             'label': {'type': 'string', 'description': '业务方向标签筛选（如「核心交易」）'},
         }, 'required': []},
         handler=datasource_tools.tool_list_datasources),
    dict(name='get_datasource_detail', category='数据源管理',
         description='获取指定数据源的详细信息（连接参数已脱敏、所属目录、业务标签、实际版本）',
         parameters={'type': 'object', 'properties': {
             'name': {'type': 'string', 'description': '数据源名称'},
         }, 'required': ['name']},
         handler=datasource_tools.tool_get_datasource_detail),
    dict(name='test_connection', category='数据源管理',
         description='测试数据库连通性。优先用 datasource_name 测已保存的数据源；'
                     '也支持临时 host/port/user/password/db_type 直连测试',
         parameters={'type': 'object', 'properties': {
             'datasource_name': {'type': 'string', 'description': '已保存的数据源名称（推荐）'},
             'host': {'type': 'string', 'description': '临时测试：主机地址'},
             'port': {'type': 'integer', 'description': '临时测试：端口'},
             'user': {'type': 'string', 'description': '临时测试：用户名'},
             'password': {'type': 'string', 'description': '临时测试：密码（仅本次调用使用，不回显）'},
             'db_type': {'type': 'string', 'description': '临时测试：数据库类型'},
             'service_name': {'type': 'string', 'description': 'Oracle service_name'},
             'sid': {'type': 'string', 'description': 'Oracle SID'},
             'database': {'type': 'string', 'description': '库名（MySQL/PG 等）'},
         }, 'required': []},
         handler=datasource_tools.tool_test_connection),

    # ── 巡检 ──
    dict(name='start_inspection', category='巡检',
         description='启动数据库巡检（后台执行巡检模板检查并生成报告）。用户说'
                     '「巡检/体检/全面检查某库」时使用；只想看单项指标时把 scope '
                     '设为 connection_count / lock_wait / slow_queries',
         parameters={'type': 'object', 'properties': {
             'datasource_name': {'type': 'string', 'description': '目标数据源名称'},
             'db_type': {'type': 'string', 'description': '数据库类型（用于同名时收窄候选）'},
             'scope': {'type': 'string', 'description': 'all=全库巡检，或 connection_count/lock_wait/slow_queries'},
             'template_id': {'type': 'integer', 'description': '指定巡检模板 ID（可选）'},
             'inspector_name': {'type': 'string', 'description': '巡检人（可选，默认「AI 巡检助手」）'},
         }, 'required': ['datasource_name']},
         handler=inspection_tools.tool_start_inspection),
    dict(name='get_task_status', category='巡检',
         description='查询巡检任务状态、进度与最近日志（重启后可从巡检历史库回读）',
         parameters={'type': 'object', 'properties': {
             'task_id': {'type': 'string', 'description': '巡检任务 ID'},
         }, 'required': ['task_id']},
         handler=inspection_tools.tool_get_task_status),
    dict(name='get_inspection_issues', category='巡检',
         description='获取某次巡检发现的问题（级别、类别、描述、建议 SQL）。'
                     '建议 SQL 仅供 DBA 确认，助手不会执行',
         parameters={'type': 'object', 'properties': {
             'task_id': {'type': 'string', 'description': '巡检任务 ID'},
             'limit': {'type': 'integer', 'description': '最多返回条数（默认 50）'},
         }, 'required': ['task_id']},
         handler=inspection_tools.tool_get_inspection_issues),

    # ── SQL 执行 ──
    dict(name='execute_sql', category='SQL执行',
         description='在指定数据源上执行只读 SQL（SELECT/SHOW/EXPLAIN/WITH 等）。'
                     '多条语句用分号分隔，系统逐条执行、第一条失败即停止；'
                     '写操作/DDL/管理命令一律拒绝',
         parameters={'type': 'object', 'properties': {
             'datasource_name': {'type': 'string', 'description': '数据源名称'},
             'sql': {'type': 'string', 'description': '只读 SQL'},
             'database': {'type': 'string', 'description': '库名 / owner（可选）'},
             'max_rows': {'type': 'integer', 'description': '每条语句最多返回行数（默认 100，上限 5000）'},
         }, 'required': ['datasource_name', 'sql']},
         handler=sql_tools.tool_execute_sql),
    dict(name='query_connection_count', category='SQL执行',
         description='直连指定数据源查询实时连接数/会话数（不依赖监控采集）。'
                     '用户提到「某库 + 连接数/会话数」时优先使用',
         parameters={'type': 'object', 'properties': {
             'datasource_name': {'type': 'string', 'description': '数据源名称'},
         }, 'required': ['datasource_name']},
         handler=sql_tools.tool_query_connection_count),
    dict(name='query_lock_waits', category='SQL执行',
         description='直连指定数据源查询当前锁等待/阻塞会话（谁阻塞了谁、等待时长）',
         parameters={'type': 'object', 'properties': {
             'datasource_name': {'type': 'string', 'description': '数据源名称'},
             'limit': {'type': 'integer', 'description': '最多返回条数（默认 50）'},
         }, 'required': ['datasource_name']},
         handler=sql_tools.tool_query_lock_waits),

    # ── 监控 ──
    dict(name='get_slow_queries', category='监控',
         description='读取实时监控采集到的慢查询（不是现场建连，现场查库请用 execute_sql）',
         parameters={'type': 'object', 'properties': {
             'datasource_name': {'type': 'string', 'description': '按数据源筛选（可选）'},
         }, 'required': []},
         handler=monitor_tools.tool_get_slow_queries),
    dict(name='get_connections', category='监控',
         description='读取实时监控采集到的连接池/会话指标',
         parameters={'type': 'object', 'properties': {
             'datasource_name': {'type': 'string', 'description': '按数据源筛选（可选）'},
         }, 'required': []},
         handler=monitor_tools.tool_get_connections),

    # ── 报告 / 调度 / 仪表盘 / 基线 ──
    dict(name='list_reports', category='报告',
         description='列出已生成的巡检报告（含健康分与高/中/低风险计数），可按数据源名筛选',
         parameters={'type': 'object', 'properties': {
             'datasource_name': {'type': 'string', 'description': '按数据源名称筛选（可选）'},
             'limit': {'type': 'integer', 'description': '返回条数，默认 10'},
         }, 'required': []},
         handler=catalog_tools.tool_list_reports),
    dict(name='list_scheduler_jobs', category='调度',
         description='列出定时巡检任务（只读，不会触发执行）',
         parameters=OBJECT_PARAMETER, handler=catalog_tools.tool_list_scheduler_jobs),
    dict(name='get_home_stats', category='仪表盘',
         description='获取系统概览：数据源数与类型分布、报告数、最近一次健康分、AI 任务量',
         parameters=OBJECT_PARAMETER, handler=catalog_tools.tool_get_home_stats),
    dict(name='list_baselines', category='基线管理',
         description='获取基线配置（阈值/期望值），可按数据源或数据库类型筛选',
         parameters={'type': 'object', 'properties': {
             'datasource_name': {'type': 'string', 'description': '按数据源筛选（可选）'},
             'db_type': {'type': 'string', 'description': '按数据库类型筛选（可选）'},
         }, 'required': []},
         handler=catalog_tools.tool_list_baselines),

    # ── 巡检模板 ──
    dict(name='list_inspection_templates', category='巡检模板',
         description='列出巡检模板（按数据库类型分类的检查技能点集合）。用户提到'
                     '「巡检模板/检查项/技能点」时使用',
         parameters={'type': 'object', 'properties': {
             'db_type': {'type': 'string', 'description': '按类型筛选：oracle/mysql/pg/dm/all（可选）'},
         }, 'required': []},
         handler=template_tools.tool_list_inspection_templates),
    dict(name='get_template_skills', category='巡检模板',
         description='获取指定巡检模板的检查技能点（章节 + SQL 原文）',
         parameters={'type': 'object', 'properties': {
             'template_id': {'type': 'integer', 'description': '巡检模板 ID（来自 list_inspection_templates）'},
         }, 'required': ['template_id']},
         handler=template_tools.tool_get_template_skills),
    dict(name='run_template_check', category='巡检模板',
         description='在指定数据源上执行巡检模板里的检查 SQL（均为预定义只读 SELECT，'
                     '最多 30 条）。用户要「按模板检查某库」时优先使用',
         parameters={'type': 'object', 'properties': {
             'datasource_name': {'type': 'string', 'description': '目标数据源名称'},
             'template_id': {'type': 'integer', 'description': '巡检模板 ID'},
             'chapter_id': {'type': 'integer', 'description': '指定章节（可选）'},
             'query_key': {'type': 'string', 'description': '指定查询 key（可选）'},
         }, 'required': ['datasource_name', 'template_id']},
         handler=template_tools.tool_run_template_check),

    # ── 方言与版本 ──
    dict(name='get_datasource_versions', category='方言与版本',
         description='数据源实际版本一览（全部实探，无需手工配置），可按类型/关键字筛选',
         parameters={'type': 'object', 'properties': {
             'db_type': {'type': 'string', 'description': '按数据库类型筛选（可选）'},
             'keyword': {'type': 'string', 'description': '按名称/主机筛选（可选）'},
         }, 'required': []},
         handler=catalog_tools.tool_get_datasource_versions),
    dict(name='check_sql_dialect', category='方言与版本',
         description='按数据源真实版本对一条 SQL 做方言预检，返回不兼容语法与替代写法',
         parameters={'type': 'object', 'properties': {
             'datasource_name': {'type': 'string', 'description': '数据源名称'},
             'sql': {'type': 'string', 'description': '待预检的 SQL'},
         }, 'required': ['datasource_name', 'sql']},
         handler=catalog_tools.tool_check_sql_dialect),
]


def register_builtin_tools(register):
    """把上面的清单注册进工具中心（由 ``modules.ai.registry.ensure_loaded`` 调用）。"""
    for definition in TOOL_DEFINITIONS:
        register(definition['name'], definition['description'], definition['parameters'],
                 definition['handler'], category=definition['category'])
