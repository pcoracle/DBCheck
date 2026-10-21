# -*- coding: utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""工作流市场 · 内置 runbook 模板（P1 生态打法）。

模板即「运维 runbook as code」：只编排除结构（steps/edges），不携带实例
信息，可随版本分发、也可由社区/伙伴自定义扩展。

引用约定：
- 巡检组件用**声明式标题匹配**（``args.match_title``），运行期按目标实例
  库型动态解析章节 id —— 模板与具体 inspection.db 数据解耦；
- 专家节点仅使用「诊断 hub」等通用节点，不硬编码专家清单。
"""

from __future__ import annotations

from typing import Any, Dict, List

# schema 标记与 workflow_store.MARKET_SCHEMA_VERSION 一致
_SCHEMA = "dbcheck.workflow"


def _tpl(name: str, description: str, steps: List[Dict[str, Any]],
         edges: List[List[str]]) -> Dict[str, Any]:
    return {
        "schema": _SCHEMA,
        "schema_version": 1,
        "name": name,
        "description": description,
        "steps": steps,
        "edges": edges,
    }


def builtin_templates() -> List[Dict[str, Any]]:
    """内置 runbook 模板清单（导入时按目标实例动态解析组件）。"""
    return [
        _tpl(
            "性能三查（慢查询 → 诊断 → 报告）",
            "只跑「慢查询 + 锁/阻塞」两个巡检组件做性能 triage，"
            "有 warning 以上发现才触发智能诊断 hub，最后落一份报告。"
            "条件分支演示：无异常时直接输出，不空跑诊断。",
            [
                {"id": "n1", "kind": "start", "ref": "", "label": "开始",
                 "args": {}, "x": 40, "y": 60},
                {"id": "n2", "kind": "inspect", "ref": "",
                 "label": "巡检组件：慢查询",
                 "args": {"match_title": "慢查询"}, "x": 260, "y": 40},
                {"id": "n3", "kind": "inspect", "ref": "",
                 "label": "巡检组件：锁与阻塞",
                 "args": {"match_title": "锁"}, "x": 260, "y": 180},
                {"id": "n4", "kind": "hub", "ref": "hub",
                 "label": "智能诊断（仅异常时）",
                 "args": {"when": {"min_severity": "warning"}}, "x": 480, "y": 110},
                {"id": "n5", "kind": "output", "ref": "",
                 "label": "输出报告",
                 "args": {"action": "report"}, "x": 700, "y": 110},
                {"id": "n6", "kind": "end", "ref": "", "label": "结束",
                 "args": {}, "x": 900, "y": 110},
            ],
            [["n1", "n2"], ["n1", "n3"], ["n2", "n4"], ["n3", "n4"],
             ["n4", "n5"], ["n5", "n6"]],
        ),
        _tpl(
            "容量体检（空间 → 报告 + 邮件）",
            "对「表空间/容量」章节做只读采集并直接产出报告邮件，"
            "适合每日定时巡检调度器挂载。",
            [
                {"id": "m1", "kind": "start", "ref": "", "label": "开始",
                 "args": {}, "x": 40, "y": 80},
                {"id": "m2", "kind": "inspect", "ref": "",
                 "label": "巡检组件：容量",
                 "args": {"match_title": "表空间"}, "x": 260, "y": 80},
                {"id": "m3", "kind": "inspect", "ref": "",
                 "label": "巡检组件：磁盘/系统",
                 "args": {"match_title": "磁盘"}, "x": 260, "y": 220},
                {"id": "m4", "kind": "output", "ref": "",
                 "label": "邮件通知",
                 "args": {"action": "email", "to": ""}, "x": 500, "y": 150},
                {"id": "m5", "kind": "end", "ref": "", "label": "结束",
                 "args": {}, "x": 700, "y": 150},
            ],
            [["m1", "m2"], ["m1", "m3"], ["m2", "m4"], ["m3", "m4"],
             ["m4", "m5"]],
        ),
        _tpl(
            "会话健康速查",
            "只跑「会话/连接」组件：三秒看清连接水位与会话明细，"
            "发现数 ≥ 1 即输出报告（组件数据类发现恒存在，必然触发输出）。",
            [
                {"id": "s1", "kind": "start", "ref": "", "label": "开始",
                 "args": {}, "x": 40, "y": 80},
                {"id": "s2", "kind": "inspect", "ref": "",
                 "label": "巡检组件：会话",
                 "args": {"match_title": "会话"}, "x": 260, "y": 80},
                {"id": "s3", "kind": "output", "ref": "",
                 "label": "输出",
                 "args": {"when": {"min_findings": 1}, "action": "report"},
                 "x": 480, "y": 80},
                {"id": "s4", "kind": "end", "ref": "", "label": "结束",
                 "args": {}, "x": 680, "y": 80},
            ],
            [["s1", "s2"], ["s2", "s3"], ["s3", "s4"]],
        ),
    ]
