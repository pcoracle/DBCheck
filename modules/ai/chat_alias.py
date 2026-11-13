# -*- coding: utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""``/api/chat/*`` 接口层：把这些路径接到本仓库已有的助手 view 函数上。

助手页（``assets/web/static/js/fusion/aias.js``）里的 fetch 路径统一按 ``/api/chat/*`` 写，
而后端助手接口的正式挂载点是蓝图 ``/api/ai/assistant``。这一层只做一件事：**同一个 view
函数、同一套鉴权、同一份响应结构，再多挂一条 URL 规则**。这样做的好处是接口只有一处实现，
不会出现「两条路径行为慢慢跑偏」的问题，前端也只需要认一套契约。

鉴权不放宽：别名指向的仍是原来的 ``_require_login`` 与过了数据源可见性过滤的 view，
不会因为换了路径就绕过登录或权限（助手只用只读执行器，写操作在后端就被拒）。
"""

# URL → routes.py 里的 view 函数名（同一个函数，不复制第二份逻辑）
# 单独列成表，是为了让「这条路径干什么」在本仓库一眼能查到。
ALIASES = (
    ('/stream', 'assistant_stream', ('POST',)),
    ('/chat', 'assistant_chat', ('POST',)),
    ('/stop', 'assistant_stop', ('POST',)),
    ('/model', 'assistant_model_info', ('GET',)),
    ('/execute-sql', 'assistant_execute_sql', ('POST',)),
    ('/check-sql', 'assistant_check_sql', ('POST',)),
    ('/split-sql', 'assistant_split_sql', ('POST',)),
    ('/dialect-check', 'assistant_dialect_check', ('POST',)),
    ('/dialect-rewrite', 'assistant_dialect_rewrite', ('POST',)),
    ('/dialect-status', 'assistant_dialect_status', ('POST',)),
    ('/datasource-versions', 'assistant_datasource_versions', ('GET',)),
    ('/fix-sql', 'assistant_fix_sql', ('POST',)),
    ('/followup_suggest', 'assistant_followup_suggest', ('POST',)),
    ('/followup_suggest', 'assistant_followup_poll', ('GET',)),
    ('/task/<task_id>', 'assistant_inspection_task', ('GET',)),
    ('/tasks', 'assistant_inspection_tasks', ('GET',)),
    ('/sql-slots', 'assistant_sql_slots', ('POST',)),
    ('/sql-token-slot', 'assistant_sql_token_slot', ('POST',)),
    ('/sql-slot-candidates', 'assistant_sql_slot_candidates', ('POST',)),
    ('/sql-slot-verify', 'assistant_sql_slot_verify', ('POST',)),
    ('/sql-vars', 'assistant_sql_vars', ('GET',)),
)


def register(app):
    """把上面这张表挂到 ``/api/chat`` 前缀下。

    函数名从 routes 模块里取，取不到就跳过并告警（宁可少一条别名，也不要注册一个
    指向不存在函数的规则，那会让启动看起来正常但请求 500）。
    """
    from modules.ai import routes

    registered = []
    missing = []
    for path, view_name, methods in ALIASES:
        view = getattr(routes, view_name, None)
        if view is None:
            missing.append(view_name)
            continue
        endpoint = 'ai_chat_alias_' + view_name
        try:
            app.add_url_rule('/api/chat' + path, endpoint=endpoint,
                             view_func=view, methods=list(methods))
            registered.append(('POST' if 'POST' in methods else methods[0],
                              '/api/chat' + path))
        except AssertionError:
            # 规则已存在（重复注册）时不报错：开发期热重载会重跑一次这里
            continue
    if missing:
        import warnings
        warnings.warn('[aias] /api/chat 别名未注册的 view：%s' % ', '.join(missing))
    return registered, missing
