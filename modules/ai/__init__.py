# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手（对话 → 意图 → 工具 → 分析 → 可回溯）。

归属说明：AI 巡检助手的能力面设计归 MIT License, Copyright (c) 2025-2026
fiyo (Jack Ge) 所有，在本仓库按 RaccoonX 的权限模型、执行链路与配置体系实现：

=============================  =====================================================
模块                            职责
=============================  =====================================================
:mod:`modules.ai.llm`          模型调用适配（流式 + 深度思考透传、可用性判定、模型信息）
:mod:`modules.ai.intent`       意图识别（JSON 协议 + 关键词兜底 + 参数后校验 + 系统技能缓存）
:mod:`modules.ai.registry`     工具注册中心（20 个只读工具、启停、自定义、只读边界）
:mod:`modules.ai.tools`        各域工具实现（数据源/巡检/SQL/监控/报告/调度/基线/模板/方言）
:mod:`modules.ai.conversation` 统一对话流编排（SSE 事件契约、确认状态机、多轮 ``<query>``）
:mod:`modules.ai.sql_safety`   SQL 分层判定（read/write/dangerous/injection/unknown）
:mod:`modules.ai.dialect`      版本方言规则（预检 + 确定性改写 + 提示词禁区）
:mod:`modules.ai.datasource_versions` 数据源真实版本探测与记忆（提示词与徽标共用）
:mod:`modules.ai.sql_vars`     会话级 ``@rN`` 结果变量
:mod:`modules.ai.task_store`   任务历史 / 会话 / 消息（SQLite，WAL + 进程级写锁）
:mod:`modules.ai.routes`       ``/api/ai/assistant`` / ``/api/ai/tasks`` / ``/api/ai/sessions``
=============================  =====================================================

权限口径：所有数据源与执行都以当前登录身份过 ``filter_visible`` / ``assert_visible``，
助手能看到的模型上下文（系统技能缓存）同样按可见范围生成。
"""
