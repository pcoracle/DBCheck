# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""安全自治 DBA 闭环编排器（P0-b：闭环编排器）。

把「感知 → 诊断 → 提案 → 审批闸门 → 执行 → 复检」串成闭环，是横跨
数据库巡检与智能诊断中心的唯一横向胶水层（设计文档
docs/design/autonomous-dba-loop.md）。

复用既有能力，不造新基类：
* 感知：``modules.inspection.findings.emit_findings``（只读、零新采集）。
* 决策：``modules.intelligence.hub.run_autonomous``（迭代重规划 + Reviewer 把关）。
* 闸门：``modules.intelligence.skills.WriteGate``（SQL 审计 pending_approval）。
* 复检：复用 ``emit_findings`` 重新读取最新巡检结论，校验原发现是否已清除；
        真实「重巡检」作为可显式调用的扩展点（避免误触发重型全量巡检）。
* 状态：落 ``modules.intelligence.workflow_store`` 同库新表 ``autonomy_runs``。

P0 默认 human-in-the-loop：所有写类动作一律经 WriteGate 落 ``pending_approval``，
必须人工审批才执行——这是与盲自动 Agentic DBA 竞品的核心差异（卖点，也是安全底线）。
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any, Dict, List, Optional

from . import workflow_store

# SQL 代码块抽取（处置方案文本中的 ```sql ... ``` 是最明确、可直接落库的执行意图）
_SQL_FENCE = re.compile(r"```sql\s*(.*?)```", re.DOTALL | re.IGNORECASE)

# 写类语句识别：只有真正会改动数据库的语句才进 WriteGate 审批
# （SELECT/WITH 等只读诊断 SQL 不进审批，避免空转任务淹没审核页）
_WRITE_SQL_RE = re.compile(
    r"\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|RECONFIGURE|GRANT|REVOKE|"
    r"VACUUM|ANALYZE|REINDEX|CLUSTER|EXEC|EXECUTE|CALL|KILL|SHUTDOWN|RESTART|REFRESH)\b"
    r"|sp_configure|dbcc\s|set\s+global|flush\s|optimize\s+(table|local|no_write)",
    re.IGNORECASE,
)

_SEMI_SPLIT = re.compile(r";+")


def _split_write_statements(sql_text: str) -> List[str]:
    """把一段 fenced SQL 按分号拆语句，去掉前导注释行，只保留写类语句。"""
    out: List[str] = []
    for raw in _SEMI_SPLIT.split(sql_text or ""):
        # 去掉纯注释行（-- 开头），保留语句体
        body = "\n".join(
            ln for ln in raw.splitlines() if not ln.strip().startswith("--")
        ).strip()
        if not body:
            continue
        if not _WRITE_SQL_RE.search(body):
            continue
        # 整段注释（如 "-- 归档现状"）后紧跟语句的形态已被上面的过滤处理
        out.append(body if body.endswith(";") else body + ";")
    return out


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _extract_sql_blocks(text: str) -> List[str]:
    return [m.group(1).strip() for m in _SQL_FENCE.finditer(text or "") if m.group(1).strip()]


def _normalize_steps(plan) -> List[Dict[str, Any]]:
    """把 hub.run_autonomous 返回的 plan 规整为步骤 dict 列表（兼容多种返回形态）。"""
    if plan is None:
        return []
    steps = getattr(plan, "steps", None)
    if steps is None:
        steps = plan if isinstance(plan, (list, tuple)) else []
    out = []
    for s in steps:
        out.append(s if isinstance(s, dict) else {"raw": s})
    return out


def _resolve_db_type(instance_id: str) -> Optional[str]:
    """复用 skills 的实例解析（测试可 monkeypatch）。"""
    from modules.intelligence.skills import _resolve_db_type as _r

    return _r(instance_id)


def _safe_json(obj: Any) -> Any:
    """把不可序列化对象（如 Plan/Finding 残留）转成可落库结构。"""
    try:
        json.dumps(obj, ensure_ascii=False)
        return obj
    except (TypeError, ValueError):
        if isinstance(obj, dict):
            return {k: _safe_json(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [_safe_json(v) for v in obj]
        return str(obj)


class AutonomyLoop:
    """自治闭环编排器：检测 → 诊断 → 提案 → 闸门 → 执行 → 复检。"""

    def __init__(self, hub=None):
        self._hub = hub

    def _get_hub(self):
        if self._hub is None:
            from .hub import get_hub

            self._hub = get_hub()
        return self._hub

    # ── 阶段一：检测 → 诊断 → 提案 → 待审批 ──────────────────────────────
    def run_for_instance(
        self,
        instance_id: str,
        severity_threshold: str = "warning",
        max_iter: Optional[int] = None,
        submitter: str = "autonomy-bot",
    ) -> Dict[str, Any]:
        """对一台实例触发一次自治闭环：感知发现 → 协同诊断 → 抽取写类提案 → 落 pending_approval。

        写类提案默认停在 ``pending_approval``（human-in-the-loop），不自动执行。
        返回 {ok, run_id, state, proposals, diagnosis}。
        """
        from modules.inspection.findings import emit_findings
        from modules.intelligence.fleet import emit_drift_findings
        from modules.intelligence.skills import WriteGate

        # 双种子源：巡检发现 + 舰队智能漂移/容量事件（P1 Fleet Intelligence）
        findings = emit_findings(instance_id, severity_threshold)
        findings.extend(emit_drift_findings(instance_id))
        if not findings:
            return {
                "ok": False,
                "error_code": "NO_FINDINGS",
                "detail": f"实例 {instance_id} 无不低于 {severity_threshold} 的巡检发现，跳过自治。",
            }

        run = workflow_store.create_autonomy_run(instance_id, findings)
        run_id = run["id"]

        # 诊断（机器对机器，复用迭代重规划 + Reviewer 把关）
        try:
            diag = self._get_hub().run_autonomous(findings, instance_id, max_iter)
        except Exception as e:  # 诊断失败不阻塞感知，标记 failed 留痕
            workflow_store.update_autonomy_run(
                run_id, state="failed", diagnosis={"error": str(e)}
            )
            return {
                "ok": False,
                "error_code": "DIAGNOSE_FAILED",
                "run_id": run_id,
                "detail": str(e),
            }

        workflow_store.update_autonomy_run(
            run_id, state="diagnosing", diagnosis=_safe_json(diag)
        )

        # 抽取写类提案并过 WriteGate（强制 pending_approval）
        db_type = _resolve_db_type(instance_id) or "unknown"
        proposals = self._extract_proposals(diag, instance_id, db_type)
        audit_task_ids: List[int] = []
        proposed: List[Dict[str, Any]] = []
        for p in proposals:
            try:
                task = WriteGate.propose(
                    p["skill"],
                    p["args"],
                    submitter,
                    instance_id,
                    p.get("db_type") or db_type,
                    remark=p.get("remark", "自治闭环提案"),
                )
                audit_task_ids.append(task["id"])
                proposed.append({
                    "skill": p["skill"],
                    "task_id": task["id"],
                    "task_no": task.get("task_no"),
                    "status": task.get("status"),
                    "sql_text": task.get("sql_text"),
                    "remark": p.get("remark", ""),
                })
            except Exception as e:
                proposed.append({"skill": p["skill"], "error": str(e)})

        # 零提案：诊断没给出任何可落库的写类 SQL，闭环没有可审批对象，
        # 置 no_proposals 终态（而不是空挂在 pending_approval 让用户干等）
        if not proposed:
            workflow_store.update_autonomy_run(run_id, state="no_proposals")
            return {
                "ok": True,
                "run_id": run_id,
                "state": "no_proposals",
                "proposals": [],
                "diagnosis": _trim_diag(diag),
                "detail": "诊断结论中未发现可执行的写类 SQL（SELECT 等只读语句不进入审批），闭环仅保留诊断结论。",
            }

        workflow_store.update_autonomy_run(
            run_id,
            state="pending_approval",
            proposals=proposed,
            audit_task_ids=audit_task_ids,
        )
        return {
            "ok": True,
            "run_id": run_id,
            "state": "pending_approval",
            "proposals": proposed,
            "diagnosis": _trim_diag(diag),
        }

    def _extract_proposals(
        self, diag: Dict[str, Any], instance_id: str, db_type: Optional[str]
    ) -> List[Dict[str, Any]]:
        """从诊断结论抽取待执行的写类修复提案。

        主路径：**递归遍历整个诊断 JSON 的所有字符串字段**（plan.steps、
        findings[*].detail、review.summary、notes……）抽取 ```sql``` 围栏块，
        按分号拆语句后只保留**写类语句**（SELECT 等只读诊断 SQL 不进审批）。
        实测专家结论的 SQL 大多出现在 findings 的 detail 里而非 plan 步骤中，
        只扫 plan 会漏掉全部提案（曾导致闭环停在 pending_approval 却无东西可审）。

        兜底：Reviewer 标注的写意图（kill/apply_index 等无结构化 SQL）→ 标注待人工补全参数。
        """
        proposals: List[Dict[str, Any]] = []
        seen_sqls = set()

        def _walk(obj: Any) -> None:
            if isinstance(obj, dict):
                for v in obj.values():
                    _walk(v)
            elif isinstance(obj, (list, tuple)):
                for v in obj:
                    _walk(v)
            elif isinstance(obj, str):
                for m in _SQL_FENCE.finditer(obj):
                    stmts = _split_write_statements(m.group(1))
                    if not stmts:
                        continue
                    key = "\n".join(stmts)
                    if key in seen_sqls:
                        continue
                    seen_sqls.add(key)
                    proposals.append({
                        "skill": "dbcheck.execute_sql",
                        "args": {"sql_text": key, "instance_id": instance_id, "env": "prod"},
                        "db_type": db_type,
                        "remark": "自治闭环·执行SQL（来自诊断结论）",
                    })

        _walk(diag or {})

        # Reviewer 把关结论中的写意图兜底（不重复已抽到的 execute_sql 文本）
        review = (diag or {}).get("review") or {}
        for gd in (review.get("gate_decisions") or []):
            skill = gd.get("skill")
            if not skill or skill == "dbcheck.execute_sql":
                continue
            gtext = gd.get("text", "")
            if any(p["skill"] == skill and p.get("remark", "").endswith(gtext[:30])
                   for p in proposals):
                continue
            proposals.append({
                "skill": skill,
                "args": {"instance_id": instance_id, "env": "prod", "reason": gtext},
                "db_type": db_type,
                "remark": f"自治闭环·{skill}（自由文本意图，需人工补全参数）",
            })
        return proposals

    # ── 阶段二：审批后执行 → 复检 → 解决/重开 ────────────────────────────
    def execute_run(
        self,
        run_id: int,
        approver: str,
        reinspect: bool = False,
        sql_overrides: Dict[int, str] = None,
    ) -> Dict[str, Any]:
        """续跑一条已审批（或待审批）的闭环：执行写类任务 → 复检 → 置 resolved/reopened。

        * ``sql_overrides``：可选 ``{audit_task_id: 新 SQL}``，执行前先编辑任务 SQL
          （重拆语句 + 重算风险 + 替换 items，执行器按 items 跑）。
        * 若审计任务仍 ``pending_approval``，先以 approver 自动 approve（已人工确认）再执行；
          若已 ``approved`` 直接执行；其余状态（blocked/rejected）跳过。
        * 复检默认基于最新巡检结论校验原发现是否清除；``reinspect=True`` 时先触发一次
          真实重巡检（重型，默认关闭，避免误触发全量报告）。
        """
        from modules.intelligence.skills import WriteGate

        run = workflow_store.get_autonomy_run(run_id)
        if not run:
            return {"ok": False, "error_code": "RUN_NOT_FOUND", "run_id": run_id}
        if run["state"] not in ("pending_approval", "approved", "verifying"):
            return {
                "ok": False,
                "error_code": "BAD_STATE",
                "state": run["state"],
                "detail": "仅 pending_approval/approved/verifying 状态可续跑执行。",
            }

        instance_id = run["instance_id"]
        audit_task_ids = run.get("audit_task_ids") or []

        # 执行前应用 SQL 编辑（仅对仍可被编辑的任务生效）
        if sql_overrides:
            from modules.sqlaudit import service as svc
            for tid_str, new_sql in (sql_overrides or {}).items():
                try:
                    tid = int(tid_str)
                    svc.update_task_sql(tid, new_sql)
                except Exception as e:
                    return {"ok": False, "error_code": "SQL_EDIT_FAILED",
                            "detail": "编辑任务 #%s SQL 失败：%s" % (tid_str, e)}

        executed: List[Dict[str, Any]] = []
        for tid in audit_task_ids:
            try:
                from modules.sqlaudit import service as svc

                task = svc.get_task(tid)
                if task and task.get("status") == "pending_approval":
                    WriteGate.resolve(
                        tid, approver, "approve",
                        comment="自治闭环自动审批（已人工确认）",
                    )
                if task and task.get("status") in ("pending_approval", "approved"):
                    res = WriteGate.execute(tid, approver, mode="real")
                    executed.append({
                        "task_id": tid,
                        "status": (res.get("task") or {}).get("status"),
                        "ok": True,
                    })
                else:
                    executed.append({
                        "task_id": tid,
                        "ok": False,
                        "skipped": True,
                        "status": task.get("status") if task else "missing",
                    })
            except Exception as e:
                executed.append({"task_id": tid, "error": str(e), "ok": False})

        workflow_store.update_autonomy_run(run_id, state="executing", executed=executed)

        # 复检
        verify = self._verify(instance_id, run, reinspect=reinspect)
        final_state = "resolved" if verify.get("resolved") else "reopened"
        workflow_store.update_autonomy_run(
            run_id,
            state=final_state,
            verify_report=verify,
            closed_at=_now() if final_state == "resolved" else None,
        )
        return {
            "ok": True,
            "run_id": run_id,
            "state": final_state,
            "executed": executed,
            "verify": verify,
        }

    def reject_run(
        self,
        run_id: int,
        approver: str,
        comment: str = "",
    ) -> Dict[str, Any]:
        """驳回一条待审批 / 已批准（未执行）的闭环。

        对每条仍可被驳回的审计任务调用 ``WriteGate.resolve(tid, approver, 'reject', comment)``，
        并把闭环状态置为终态 ``rejected``（留痕 comment）。已执行 / 已驳回的任务跳过。
        """
        from modules.intelligence.skills import WriteGate

        run = workflow_store.get_autonomy_run(run_id)
        if not run:
            return {"ok": False, "error_code": "RUN_NOT_FOUND", "run_id": run_id}
        if run["state"] not in ("pending_approval", "approved", "verifying"):
            return {
                "ok": False,
                "error_code": "BAD_STATE",
                "state": run["state"],
                "detail": "仅 pending_approval/approved/verifying 状态可驳回。",
            }

        audit_task_ids = run.get("audit_task_ids") or []
        rejected: List[Dict[str, Any]] = []
        for tid in audit_task_ids:
            try:
                from modules.sqlaudit import service as svc
                task = svc.get_task(tid)
                if task and task.get("status") in ("pending_approval", "approved"):
                    WriteGate.resolve(tid, approver, "reject", comment=comment or "自治闭环驳回")
                    rejected.append({"task_id": tid, "ok": True})
                else:
                    rejected.append({
                        "task_id": tid, "ok": False, "skipped": True,
                        "status": task.get("status") if task else "missing",
                    })
            except Exception as e:
                rejected.append({"task_id": tid, "error": str(e), "ok": False})

        workflow_store.update_autonomy_run(
            run_id, state="rejected", executed=rejected,
            closed_at=_now(),
            reject_comment=comment, rejected_by=approver, rejected_at=_now(),
        )
        return {
            "ok": True, "run_id": run_id, "state": "rejected", "rejected": rejected,
            "reject_comment": comment, "rejected_by": approver,
        }

    def reopen_run(
        self,
        run_id: int,
        approver: str,
        sql_overrides: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """把一条已驳回（rejected）的闭环重新打开为 pending_approval。

        允许管理员修订 SQL 后再次提交审批（human-in-the-loop 闭环可迭代）：
        重置每条审计任务到 analyzed → 应用 ``sql_overrides``（有变更则 update_task_sql
        重算风险）→ 重新闸门为 pending_approval；并清空闭环的驳回留痕、置回 pending_approval。
        仅 ``rejected`` 状态可重开。
        """
        run = workflow_store.get_autonomy_run(run_id)
        if not run:
            return {"ok": False, "error_code": "RUN_NOT_FOUND", "run_id": run_id}
        if run["state"] != "rejected":
            return {
                "ok": False, "error_code": "BAD_STATE", "state": run["state"],
                "detail": "仅 rejected 状态可重新打开。",
            }
        if not (run.get("proposals") or []):
            return {
                "ok": False, "error_code": "NO_PROPOSALS", "run_id": run_id,
                "detail": "该闭环没有写类提案（历史数据为空），无可重开对象；请对实例重新触发自治闭环。",
            }

        # 懒加载 sql_audit（其包 __init__ 依赖 flask，避免 guard 路径也触发导入）
        from modules.sqlaudit import service as svc
        from modules.sqlaudit import models as sqlaudit_models

        sql_overrides = sql_overrides or {}
        new_proposals: List[Dict[str, Any]] = []
        new_task_ids: List[int] = []
        for p in (run.get("proposals") or []):
            tid = p.get("task_id")
            if tid:
                try:
                    # 先退回 analyzed（update_task_sql 仅允许 analyzed/pending_approval）
                    sqlaudit_models.update_task_status(tid, "analyzed")
                    new_sql = (sql_overrides.get(str(tid)) or sql_overrides.get(tid)
                               or p.get("sql_text") or "")
                    if new_sql and new_sql.strip() and new_sql != (p.get("sql_text") or ""):
                        svc.update_task_sql(tid, new_sql)
                    # 重新闸门为 pending_approval（写类 Skill 强制待审批）
                    sqlaudit_models.update_task_status(tid, "pending_approval")
                    task = svc.get_task(tid)
                    new_proposals.append({
                        "skill": p.get("skill", "write_skill"),
                        "task_id": tid,
                        "task_no": task.get("task_no"),
                        "status": task.get("status"),
                        "sql_text": task.get("sql_text") or new_sql or p.get("sql_text"),
                        "remark": p.get("remark", ""),
                    })
                    new_task_ids.append(tid)
                except Exception as e:  # noqa: BLE001
                    new_proposals.append({**p, "error": str(e)})
            else:
                new_proposals.append(p)

        workflow_store.update_autonomy_run(
            run_id, state="pending_approval", proposals=new_proposals,
            audit_task_ids=new_task_ids, closed_at=None, clear_reject=True,
        )
        return {"ok": True, "run_id": run_id, "state": "pending_approval", "proposals": new_proposals}

    def _verify(
        self, instance_id: str, run: Dict[str, Any], reinspect: bool = False
    ) -> Dict[str, Any]:
        """复检：校验原始发现是否已清除。

        默认复用 ``emit_findings`` 重新读取最新巡检结论；``reinspect=True`` 时先触发一次
        真实重巡检（重型，默认关闭）。若最新巡检结论中已不再出现种子发现标题（warning+），
        判定为已清除（resolved）；否则 reopened（回到诊断）。
        """
        seed = run.get("finding_ref") or []
        seed_titles = [f.get("title") for f in seed if isinstance(f, dict) and f.get("title")]
        if not seed_titles:
            return {"resolved": True, "reason": "no_seed", "still_present": []}

        if reinspect:
            try:
                self._trigger_reinspection(instance_id)
            except Exception:
                # 重巡检失败绝不影响复检判定（降级到现有结论）
                pass

        from modules.inspection.findings import emit_findings

        current = emit_findings(instance_id, "info")  # 不过滤，看全量
        current_titles = {f.get("title") for f in current}
        still = [t for t in seed_titles if t in current_titles]
        if not still:
            return {"resolved": True, "reason": "cleared", "still_present": []}
        return {"resolved": False, "reason": "still_present", "still_present": still}

    def _trigger_reinspection(self, instance_id: str) -> Dict[str, Any]:
        """显式触发一次真实重巡检（重型：全量采集 + 报告 + 历史写入）。

        设计上默认不自动调用；仅在确认需要真实复检时由调用方显式开启，避免误触发。
        """
        from modules.mcp_server.tools import run_inspection_tool

        return run_inspection_tool(instance_id, principal=None)


def _trim_diag(diag: Dict[str, Any]) -> Dict[str, Any]:
    """给前端/看板用的精简诊断结论（剔除非序列化/过长字段）。"""
    if not isinstance(diag, dict):
        return diag
    out = dict(diag)
    out.pop("ctx", None)
    # plan/findings 可能很大，保留但截断长度
    for k in ("findings", "plan", "side_findings"):
        v = out.get(k)
        if isinstance(v, (list, tuple)) and len(v) > 50:
            out[k] = v[:50]
    return out
