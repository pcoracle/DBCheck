# -*- coding: utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""SQL 审核编排层（service）。

串联 parser → plan_analyzer → rules → models，完成一次审核任务的：
  1. 切分并解析 SQL 为多条语句（方言感知）
  2. 可选：连接目标实例运行 EXPLAIN，做执行计划分析（MVP2，只读不执行）
  3. 对每条语句运行启用规则，收集命中与单句风险（含执行计划触发的 full_scan_risk）
  4. 聚合任务级风险
  5. 落库（sql_audit_tasks / sql_audit_items）并返回完整报告

MVP2：支持多库方言（MySQL/PostgreSQL/Oracle 兼容）+ 可选执行计划分析。
执行计划分析失败仅降级标记，绝不阻断审核本身。
"""
import json
import re
from datetime import datetime, timezone

from . import models
from .parser import split_statements, analyze_statement
from .rules import SEVERITY_RANK, score_hits
from . import plan_analyzer


def submit_audit(
    submitter: str,
    instance_id,
    db_type: str,
    env: str,
    sql_text: str,
    plan_enabled: bool = False,
    exec_enabled: bool = False,
    remark: str = "",
) -> dict:
    """提交并立即完成一次 SQL 审核，返回任务详情（含 items）。"""
    models.init_db()
    stmts = split_statements(sql_text)
    if not stmts:
        raise ValueError("未解析到有效 SQL 语句")

    rules = models.get_enabled_rules(db_type)

    # 1) 切分并解析为结构化条目（含方言信息）；plan_json 暂置 None
    items = []
    for seq, stmt in enumerate(stmts, 1):
        parsed = analyze_statement(stmt, db_type)
        items.append({**parsed, "seq": seq, "plan_json": None})

    # 2) 可选：执行计划分析（在规则匹配之前，使 full_scan_risk 规则可触发）
    _run_plan_analysis(items, db_type, instance_id, plan_enabled)

    # 3) 规则匹配 + 单句风险聚合
    task_score = 0
    task_level = "low"
    for it in items:
        hits = []
        for r in rules:
            if _applies(r, it, db_type):
                hits.append({
                    "rule_id": r["rule_id"],
                    "name": r["name"],
                    "category": r["category"],
                    "severity": r["severity"],
                    "message": r.get("description", ""),
                    "suggestion": r.get("suggestion", ""),
                })
        score, level = score_hits(hits)
        if SEVERITY_RANK.get(level, 0) > SEVERITY_RANK.get(task_level, 0):
            task_level = level
        if score > task_score:
            task_score = score
        it["risk_score"] = score
        it["risk_level"] = level
        it["rule_hits"] = hits

    # 4) 落库（状态机：阻断级直接 blocked；高风险进入审批流 pending_approval；低/中风险可直接受控执行）
    task_status = "analyzed"
    if task_level == "block":
        task_status = "blocked"
    elif task_level == "high":
        task_status = "pending_approval"
    conn = models.get_conn()
    cur = conn.cursor()
    now = models._now()
    task_no = models.gen_task_no()
    cur.execute(
        "INSERT INTO sql_audit_tasks "
        "(task_no, submitter, instance_id, env, db_type, sql_text, sql_count, status, "
        " risk_level, risk_score, plan_enabled, exec_enabled, created_at, updated_at, remark) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            task_no, submitter, instance_id, env, db_type, sql_text, len(stmts),
            task_status, task_level, task_score,
            1 if plan_enabled else 0, 1 if exec_enabled else 0,
            now, now, remark,
        ),
    )
    task_id = cur.lastrowid
    for it in items:
        cur.execute(
            "INSERT INTO sql_audit_items "
            "(task_id, seq, sql_text, sql_type, op_type, tables_json, risk_level, risk_score, rule_hits, plan_json, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                task_id, it["seq"], it["sql_text"], it["sql_type"], it["op_type"],
                json.dumps(it["tables"], ensure_ascii=False),
                it["risk_level"], it["risk_score"],
                json.dumps(it["rule_hits"], ensure_ascii=False),
                json.dumps(it.get("plan_json"), ensure_ascii=False),
                now,
            ),
        )
    conn.commit()
    conn.close()
    return get_task(task_id)


def _applies(rule: dict, parsed: dict, db_type: str) -> bool:
    # 复用 rules.py 的匹配逻辑；此处转发，便于后续扩展（如缓存/调试）。
    from .rules import _rule_applies
    return _rule_applies(rule, parsed, db_type)


def _run_plan_analysis(items, db_type, instance_id, plan_enabled):
    """逐条对「适用」语句做执行计划分析，填充 plan_json。

    - plan_enabled 关闭：不处理（plan_json 保持 None，规则层 full_scan_risk 不会误触发）。
    - 未提供实例 / 库型不支持 / 连接失败：逐条降级标记，绝不阻断审核。
    - DDL/DCL 等非适用语句：标记 note，不连接。
    EXPLAIN 为只读操作，不会执行原 SQL（符合「默认只读 / 不执行」原则）。
    """
    if not plan_enabled:
        return

    norm_db = plan_analyzer.normalize_db_type(db_type)
    ddl_note = {
        "engine": norm_db,
        "applicable": False,
        "note": "DDL/DCL 语句无需执行计划分析",
    }

    # 未提供实例：无法连接目标库，仅对适用语句给出提示；非适用语句标注 DDL/DCL
    if not instance_id:
        for it in items:
            if it.get("plan_applicable"):
                it["plan_json"] = {
                    "engine": norm_db,
                    "applicable": False,
                    "note": "未提供目标实例，无法执行执行计划分析（请在表单选择实例并开启执行计划）",
                }
            else:
                it["plan_json"] = dict(ddl_note)
        return

    analyzer = plan_analyzer.get_analyzer(db_type)
    if analyzer is None:
        for it in items:
            if it.get("plan_applicable"):
                it["plan_json"] = {
                    "engine": norm_db,
                    "applicable": False,
                    "unsupported": True,
                    "note": f"暂不支持 {db_type} 的执行计划分析"
                           f"（当前支持 MySQL / PostgreSQL / Oracle / SQL Server / 达梦(DM)）",
                }
            else:
                it["plan_json"] = dict(ddl_note)
        return

    ddl_note["engine"] = analyzer.engine

    # 获取实例解密信息并建立连接
    try:
        from modules.pro.instance_manager import get_instance_manager
        inst = get_instance_manager().get_instance_decrypted(instance_id)
        if not inst:
            raise ValueError("实例不存在或无权访问")
        conn = plan_analyzer.connect_instance(inst)
    except Exception as e:  # noqa: BLE001
        for it in items:
            if it.get("plan_applicable"):
                it["plan_json"] = {
                    "engine": analyzer.engine,
                    "applicable": False,
                    "error": f"连接实例失败: {e}",
                }
            else:
                it["plan_json"] = dict(ddl_note)
        return

    try:
        for it in items:
            if not it.get("plan_applicable"):
                it["plan_json"] = dict(ddl_note)
                continue
            try:
                it["plan_json"] = analyzer.analyze(conn, it["sql_text"], it)
            except Exception as e:  # noqa: BLE001
                it["plan_json"] = {
                    "engine": analyzer.engine,
                    "applicable": False,
                    "error": f"执行计划分析失败: {e}",
                }
    finally:
        try:
            conn.close()
        except Exception:
            pass


def get_task(task_id: int) -> dict:
    models.init_db()
    conn = models.get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM sql_audit_tasks WHERE id=?", (task_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        return None
    task = dict(row)
    cur.execute("SELECT * FROM sql_audit_items WHERE task_id=? ORDER BY seq", (task_id,))
    items = []
    for r in cur.fetchall():
        it = dict(r)
        # TEXT 列反序列化为结构化对象，方便前端直接使用
        if isinstance(it.get("rule_hits"), str) and it["rule_hits"]:
            try:
                it["rule_hits"] = json.loads(it["rule_hits"])
            except Exception:
                it["rule_hits"] = []
        elif not it.get("rule_hits"):
            it["rule_hits"] = []
        if isinstance(it.get("tables_json"), str) and it["tables_json"]:
            try:
                it["tables"] = json.loads(it["tables_json"])
            except Exception:
                it["tables"] = []
        elif not it.get("tables_json"):
            it["tables"] = []
        # MVP2: 执行计划分析结果（可能为空或 unsupported/error 标记）
        if isinstance(it.get("plan_json"), str) and it["plan_json"]:
            try:
                it["plan_json"] = json.loads(it["plan_json"])
            except Exception:
                it["plan_json"] = None
        else:
            it["plan_json"] = None
        items.append(it)
    task["items"] = items
    task["executions"] = _enrich_executions(task, models.get_executions(task_id))
    task["rollbacks"] = models.get_rollbacks(task_id)
    task["approvals"] = models.get_approvals(task_id)
    conn.close()
    return task


def _enrich_executions(task: dict, executions: list) -> list:
    """执行记录表只存 item_id，不含 seq / op_type；按 item_id 关联 items 补回这两字段，
    供前端渲染序号与操作类型（如 #1 UPDATE）。"""
    by_id = {i["id"]: i for i in (task.get("items") or [])}
    out = []
    for ex in executions:
        ex = dict(ex)
        it = by_id.get(ex.get("item_id"))
        if it:
            ex["seq"] = it.get("seq")
            ex["op_type"] = it.get("op_type")
        else:
            ex.setdefault("seq", ex.get("item_id"))
            ex.setdefault("op_type", "")
        out.append(ex)
    return out


def execute_task(task_id: int, mode: str = "dry_run", operator: str = "anonymous",
                  max_affected_rows=None, timeout=None) -> dict:
    """受控执行 SQL 审核任务（MVP3 执行器 + 回滚）。

    mode: 'dry_run'（默认，只读重跑执行计划，不改数据）
          'real'   （真实执行，需任务 exec_enabled=1 且连接目标实例）
    返回 {ok, mode, task, executions, rollbacks, summary}
    """
    models.init_db()
    task = get_task(task_id)
    if not task:
        raise ValueError("任务不存在")
    mode = (mode or "dry_run").lower()
    if mode not in ("dry_run", "real"):
        raise ValueError("mode 必须为 dry_run 或 real")
    from . import executor
    max_affected_rows = max_affected_rows or executor.MAX_AFFECTED_ROWS_DEFAULT
    timeout = timeout or executor.EXEC_TIMEOUT_DEFAULT
    instance = None
    if task.get("instance_id"):
        from modules.pro.instance_manager import get_instance_manager
        instance = get_instance_manager().get_instance_decrypted(task["instance_id"])
        if not instance:
            raise ValueError("目标实例不存在或无权访问")
    if mode == "dry_run":
        summary = executor.dry_run(task, instance)
    else:
        summary = executor.real_execute(task, instance, max_affected_rows, timeout)
    # 重新读取任务（状态/留痕可能已更新）并附带执行/回滚记录
    task = get_task(task_id)
    executions = _enrich_executions(task, models.get_executions(task_id))
    rollbacks = models.get_rollbacks(task_id)
    return {"ok": True, "mode": mode, "task": task,
            "executions": executions, "rollbacks": rollbacks, "summary": summary}


def update_task_sql(task_id: int, sql_text: str, plan_enabled: bool = None) -> dict:
    """编辑已提交（未执行 / 未审批定稿）任务的 SQL。

    重拆语句 → 重新解析 + 规则匹配 + 可选执行计划分析 → 替换 ``sql_audit_items``，
    并以新的聚合风险刷新任务级 ``risk_level`` / ``risk_score``。执行器按 items 逐条跑，
    因此必须替换 items 才能使编辑后的 SQL 真正生效。

    仅 ``analyzed`` / ``pending_approval`` 状态可编辑；``approved`` / ``rejected`` /
    ``executed`` / ``blocked`` 等已定稿状态拒绝修改（需重新提交）。
    """
    models.init_db()
    task = get_task(task_id)
    if not task:
        raise ValueError("任务不存在")
    if task.get("status") in ("approved", "rejected", "executed", "blocked"):
        raise ValueError("该任务状态(%s)已不可修改 SQL，请重新提交" % task.get("status"))

    stmts = split_statements(sql_text)
    if not stmts:
        raise ValueError("未解析到有效 SQL 语句")

    db_type = task["db_type"]
    rules = models.get_enabled_rules(db_type)
    items = []
    for seq, stmt in enumerate(stmts, 1):
        parsed = analyze_statement(stmt, db_type)
        items.append({**parsed, "seq": seq, "plan_json": None})

    _run_plan_analysis(
        items, db_type, task.get("instance_id"),
        plan_enabled if plan_enabled is not None else bool(task.get("plan_enabled")),
    )

    task_score = 0
    task_level = "low"
    for it in items:
        hits = []
        for r in rules:
            if _applies(r, it, db_type):
                hits.append({
                    "rule_id": r["rule_id"],
                    "name": r["name"],
                    "category": r["category"],
                    "severity": r["severity"],
                    "message": r.get("description", ""),
                    "suggestion": r.get("suggestion", ""),
                })
        score, level = score_hits(hits)
        if SEVERITY_RANK.get(level, 0) > SEVERITY_RANK.get(task_level, 0):
            task_level = level
        if score > task_score:
            task_score = score
        it["risk_score"] = score
        it["risk_level"] = level
        it["rule_hits"] = hits

    conn = models.get_conn()
    cur = conn.cursor()
    now = models._now()
    cur.execute("DELETE FROM sql_audit_items WHERE task_id=?", (task_id,))
    for it in items:
        cur.execute(
            "INSERT INTO sql_audit_items "
            "(task_id, seq, sql_text, sql_type, op_type, tables_json, risk_level, "
            " risk_score, rule_hits, plan_json, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                task_id, it["seq"], it["sql_text"], it["sql_type"], it["op_type"],
                json.dumps(it["tables"], ensure_ascii=False),
                it["risk_level"], it["risk_score"],
                json.dumps(it["rule_hits"], ensure_ascii=False),
                json.dumps(it.get("plan_json"), ensure_ascii=False),
                now,
            ),
        )
    cur.execute(
        "UPDATE sql_audit_tasks SET sql_text=?, sql_count=?, risk_level=?, "
        "risk_score=?, updated_at=? WHERE id=?",
        (sql_text, len(stmts), task_level, task_score, now, task_id),
    )
    conn.commit()
    conn.close()
    return get_task(task_id)


def bind_task_instance(task_id: int, instance_id: str) -> dict:
    """为已提交任务绑定/更正目标实例（执行前发现未指定时补充）。"""
    models.init_db()
    if not instance_id:
        raise ValueError("instance_id 不能为空")
    task = get_task(task_id)
    if not task:
        raise ValueError("任务不存在")
    if task.get("status") == "executed":
        raise ValueError("已执行的任务不允许再绑定实例")
    from modules.pro.instance_manager import get_instance_manager
    instance = get_instance_manager().get_instance_decrypted(instance_id)
    if not instance:
        raise ValueError("目标实例不存在或无权访问")
    models.update_task_instance(task_id, instance_id)
    return get_task(task_id)


def execute_rollback(task_id: int, operator: str) -> dict:
    """一键回滚（P1 ⑤）：执行任务已生成的自动回滚方案。

    高危险操作，调用方需先校验审批角色并弹确认。仅执行 auto_rollback=True 项。
    """
    models.init_db()
    task = get_task(task_id)
    if not task:
        raise ValueError("任务不存在")
    if task.get("status") != "executed":
        raise ValueError("仅已执行的任务可回滚")
    if not task.get("instance_id"):
        raise ValueError("该任务未关联实例，无法回滚")
    from modules.pro.instance_manager import get_instance_manager
    instance = get_instance_manager().get_instance_decrypted(task["instance_id"])
    if not instance:
        raise ValueError("目标实例不存在或无权访问")
    from . import executor
    return executor.execute_rollback(task, instance, operator)


def approve_task(task_id: int, approver: str, action: str, comment: str = "") -> dict:
    """审批 SQL 审核任务（MVP3 审批流）。

    action: 'approve' | 'reject'。写 sql_audit_approvals，更新任务状态与审批留痕：
      approve → status='approved'，置 approved_by / approved_at
      reject  → status='rejected'
    返回更新后的任务详情。
    """
    models.init_db()
    action = (action or "").lower()
    if action not in ("approve", "reject"):
        raise ValueError("action 必须为 approve 或 reject")
    task = get_task(task_id)
    if not task:
        raise ValueError("任务不存在")
    if task.get("status") == "blocked":
        raise ValueError("阻断级任务不可审批，已禁止执行")
    if task.get("status") in ("approved", "rejected", "executed"):
        raise ValueError(f"任务当前状态为 {task.get('status')}，无法重复审批")
    models.insert_approval(task_id, approver, action, comment)
    if action == "approve":
        models.update_task_status(
            task_id, "approved", approved_by=approver, approved_at=models._now(),
        )
    else:
        models.update_task_status(task_id, "rejected")
    return get_task(task_id)


def list_tasks(submitter: str = None, status: str = None, limit: int = 100) -> list:
    models.init_db()
    conn = models.get_conn()
    cur = conn.cursor()
    sql = ("SELECT id, task_no, submitter, instance_id, env, db_type, sql_count, status, "
           "risk_level, risk_score, created_at, approved_by, approved_at, "
           "exec_enabled FROM sql_audit_tasks")
    where, params = [], []
    if submitter:
        where.append("submitter=?")
        params.append(submitter)
    if status:
        where.append("status=?")
        params.append(status)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    cur.execute(sql, params)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


def delete_task(task_id: int) -> int:
    """删除审核任务（含明细，明细由数据库级联删除）。返回被删除行数。"""
    models.init_db()
    return models.delete_task(task_id)


def list_rules() -> list:
    """返回全部审核规则（含 logic 解析）。"""
    return models.list_rules()


# ─────────────────────────────────────────────────────────────────────────────
# MVP3.5：规则在线 CRUD（运维自调规则）
# 枚举白名单与前端表单 / 种子规则对齐；logic 结构须能被 rules._rule_applies 识别。
# ─────────────────────────────────────────────────────────────────────────────

DB_TYPE_WHITELIST = {"all", "mysql", "postgresql", "oracle", "sqlserver", "dm"}
CATEGORY_WHITELIST = {"forbidden", "performance", "security", "naming"}
SEVERITY_WHITELIST = {"low", "mid", "high", "block"}
LOGIC_KIND_WHITELIST = {
    "op_in", "op_in_without_where", "op_in_without_limit",
    "select_star", "full_scan", "regex", "naming_table", "naming_index",
}
# 需要 ops 列表的 kind
_OPS_KINDS = {"op_in", "op_in_without_where", "op_in_without_limit"}


def _validate_rule_payload(payload: dict):
    """校验规则 CRUD 入参，返回 (cleaned_dict, error)。error 非空表示校验失败。

    cleaned_dict 含 name/db_type/category/severity/logic/enabled/description/suggestion。
    """
    if not isinstance(payload, dict):
        return None, "请求体必须为 JSON 对象"
    name = (payload.get("name") or "").strip()
    if not name:
        return None, "规则名称 name 不能为空"
    db_type = (payload.get("db_type") or "all").lower()
    if db_type not in DB_TYPE_WHITELIST:
        return None, f"db_type 非法：{db_type}（可选 {sorted(DB_TYPE_WHITELIST)}）"
    category = (payload.get("category") or "").lower()
    if category not in CATEGORY_WHITELIST:
        return None, f"category 非法：{category}（可选 {sorted(CATEGORY_WHITELIST)}）"
    severity = (payload.get("severity") or "low").lower()
    if severity not in SEVERITY_WHITELIST:
        return None, f"severity 非法：{severity}（可选 {sorted(SEVERITY_WHITELIST)}）"
    # logic：允许字符串形式的 JSON（前端直接传 JSON 对象或文本）
    logic = payload.get("logic")
    if isinstance(logic, str):
        try:
            logic = json.loads(logic)
        except Exception:
            return None, "logic 不是合法 JSON"
    if not isinstance(logic, dict):
        return None, "logic 必须为对象（dict）"
    kind = logic.get("kind")
    if kind not in LOGIC_KIND_WHITELIST:
        return None, f"logic.kind 非法：{kind}（可选 {sorted(LOGIC_KIND_WHITELIST)}）"
    if kind in _OPS_KINDS:
        ops = logic.get("ops")
        if not isinstance(ops, list) or not ops:
            return None, f"logic.kind={kind} 必须提供非空的 ops 列表"
    if kind == "regex":
        pattern = logic.get("pattern")
        if not (isinstance(pattern, str) and pattern.strip()):
            return None, "logic.kind=regex 必须提供非空的 pattern 字符串"
    enabled = bool(payload.get("enabled", True))
    return {
        "name": name,
        "db_type": db_type,
        "category": category,
        "severity": severity,
        "logic": logic,
        "enabled": enabled,
        "description": (payload.get("description") or "").strip(),
        "suggestion": (payload.get("suggestion") or "").strip(),
    }, None


def create_rule(payload: dict) -> dict:
    """新增规则。rule_id 由调用方指定（校验唯一+合法），缺省自动生成 custom_ 前缀。"""
    models.init_db()
    cleaned, err = _validate_rule_payload(payload)
    if err:
        raise ValueError(err)
    rid = (payload.get("rule_id") or "").strip()
    if rid:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", rid):
            raise ValueError("rule_id 只能包含字母/数字/下划线，且以字母开头")
    else:
        rid = "custom_" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
    if models.get_rule(rid):
        raise ValueError(f"rule_id={rid} 已存在")
    models.insert_rule(
        rule_id=rid, name=cleaned["name"], db_type=cleaned["db_type"],
        category=cleaned["category"], severity=cleaned["severity"],
        logic=cleaned["logic"], enabled=cleaned["enabled"],
        description=cleaned["description"], suggestion=cleaned["suggestion"],
    )
    return models.get_rule(rid)


def update_rule(rule_id: str, payload: dict) -> dict:
    """更新规则（全字段覆盖，等同保存）。"""
    models.init_db()
    if not models.get_rule(rule_id):
        raise ValueError(f"规则不存在：{rule_id}")
    cleaned, err = _validate_rule_payload(payload)
    if err:
        raise ValueError(err)
    models.update_rule(
        rule_id, name=cleaned["name"], db_type=cleaned["db_type"],
        category=cleaned["category"], severity=cleaned["severity"],
        logic=cleaned["logic"], enabled=cleaned["enabled"],
        description=cleaned["description"], suggestion=cleaned["suggestion"],
    )
    return models.get_rule(rule_id)


def delete_rule(rule_id: str) -> int:
    """删除规则，返回被删除行数。"""
    models.init_db()
    if not models.get_rule(rule_id):
        raise ValueError(f"规则不存在：{rule_id}")
    return models.delete_rule(rule_id)


def toggle_rule(rule_id: str, enabled: bool) -> dict:
    """启停规则，返回更新后的规则。"""
    models.init_db()
    if not models.get_rule(rule_id):
        raise ValueError(f"规则不存在：{rule_id}")
    models.update_rule(rule_id, enabled=enabled)
    return models.get_rule(rule_id)
