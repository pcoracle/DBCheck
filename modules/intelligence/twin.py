# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""数据库拓扑孪生引擎（P2 DB Twin · 智能叠加的舰队拓扑视图）。

定位（与监控大屏拓扑的分工）：大屏拓扑已覆盖 Oracle RAC/ADG 关系与历史
回放展示；本引擎是**智能叠加层**——

1. 拓扑快照  ``topology_snapshot``
   节点 = 全部被监控实例（双源：优先大屏 ScreenCollector 富快照——含
   host/port/role/db_unique_name/ADG 明细；回退 history_store 最近样本，
   展示名从实例管理器解析），每个节点叠加：
   - 实时状态与关键指标（QPS/连接/锁等待/复制延迟/表空间余量…）
   - 舰队智能层结论：漂移（detect_drift）+ 容量预测（forecast_capacity）
   - 复合健康分 health_score（0-100，状态/漂移/容量三因子加权扣分）
   边 = 自动关系（Oracle ADG 主→备 redo 传输线 + RAC 同库集群姊妹线）
   + 用户手动声明的依赖连线（twin_links 表，覆盖 MySQL 复制/PG 流复制/
   应用依赖等任意库型任意语义）。
2. 手动连线  ``add_link`` / ``remove_link`` / ``list_links``
   持久化在 data/twin.db（运行时数据，不入版本库）。
3. 历史回放  ``replay``
   给定 hours_ago，从 history_store 取每实例离该时刻最近的样本重建
   节点状态（漂移/容量仅在「现在」有意义，不参与回放）。

设计约束：
* 纯 stdlib（sqlite3/time），零第三方依赖，PyInstaller 友好；
* 智能层结论按实例 60 秒 TTL 缓存（漂移/预测需扫监控历史，不能每次
  快照请求全量重算）；大屏快照/历史样本始终读最新；
* 绝不写入监控历史库；不缓存敏感明文（host/port 仅透传大屏快照已有值）。
"""

from __future__ import annotations

import os
import sqlite3
import time
from typing import Any, Dict, List, Optional

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_DB_PATH = os.path.join(_REPO_ROOT, "data", "twin.db")

# 智能层（漂移/容量/健康分）缓存 TTL（秒）
_SMART_TTL = 60.0

# 允许的连线语义（手动声明）
LINK_KINDS = {
    "replica": "主从复制",
    "cluster": "集群成员",
    "standby": "容灾 standby",
    "app": "应用依赖",
    "custom": "自定义",
}

_smart_cache: Dict[str, Any] = {"ts": 0.0, "by_iid": {}}


def _conn():
    c = sqlite3.connect(_DB_PATH)
    c.execute("PRAGMA journal_mode=WAL")
    return c


def _init_db() -> None:
    with _conn() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS twin_links (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                src_iid    TEXT NOT NULL,
                dst_iid    TEXT NOT NULL,
                kind       TEXT NOT NULL DEFAULT 'custom',
                label      TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_tl_src ON twin_links(src_iid, dst_iid)"
        )


_init_db()


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


# ── 节点双源 ────────────────────────────────────────────────────────────

def _screen_nodes() -> Optional[List[Dict[str, Any]]]:
    """优先从大屏采集器取富快照节点（含 host/role/db_unique_name/dests）。

    大屏未运行 / 快照为空时返回 None，由调用方回退历史库。"""
    try:
        from modules.monitor.screen_metrics import (
            _build_nodes,
            get_screen_collector,
        )

        snap = get_screen_collector().get_snapshot()
        if not snap:
            return None
        return _build_nodes(snap)
    except Exception:
        return None


def _history_nodes() -> List[Dict[str, Any]]:
    """回退源：history_store 每实例最近一条样本（无 host/port 敏感字段）。"""
    from modules.monitor.history_store import get_history_store

    store = get_history_store()
    iids: List[Dict[str, Any]] = []
    try:
        from .fleet import list_instances

        iids = list_instances()
    except Exception:
        iids = []
    out: List[Dict[str, Any]] = []
    now = time.time()
    for it in iids:
        iid = it["iid"]
        try:
            rows = store.query(iid=iid, from_ts=now - 86400.0, limit=5)
        except Exception:
            rows = []
        s = rows[-1] if rows else None
        try:
            name = _resolve_label(iid)
        except Exception:
            name = str(iid)[:12]
        out.append({
            "id": iid,
            "name": name,
            "db_type": s.get("db_type") if s else it.get("db_type"),
            "group": (s or {}).get("grp") or "默认",
            "host": None, "port": None, "label": None,
            "status": (s or {}).get("status") or "unknown",
            "err": None,
            "qps": (s or {}).get("qps"), "tps": (s or {}).get("tps"),
            "conn_total": (s or {}).get("conn_total"),
            "conn_usage_pct": (s or {}).get("conn_usage_pct"),
            "cache_hit_pct": (s or {}).get("cache_hit_pct"),
            "lock_waits": (s or {}).get("lock_waits"),
            "slowq": (s or {}).get("slowq"),
            "repl_lag_s": (s or {}).get("repl_lag_s"),
            "tbs_free_pct": (s or {}).get("tbs_free_pct"),
            "role": None, "db_unique_name": None, "db_name": None,
            "open_mode": None, "instance_name": None,
            "instance_number": None, "dests": None,
            "transport_lag_s": None, "apply_lag_s": None,
            "tbs": [], "spark": [], "stat_hint": None, "ssh": None,
        })
    return out


def _resolve_label(iid: str) -> str:
    try:
        from .fleet import _resolve_label as _f

        return _f(iid)
    except Exception:
        return str(iid)[:12]


# ── 智能层（漂移 + 容量 + 健康分，60s TTL 缓存）────────────────────────

def _smart_for(iid: str) -> Dict[str, Any]:
    """取单实例智能层结论（漂移计数/明细 + 容量风险 + 健康分）。"""
    now = time.time()
    if now - _smart_cache["ts"] > _SMART_TTL:
        _smart_cache["ts"] = now
        _smart_cache["by_iid"] = {}
    cached = _smart_cache["by_iid"].get(iid)
    if cached is not None:
        return cached

    out: Dict[str, Any] = {
        "drift_critical": 0, "drift_warning": 0, "drifts": [],
        "capacity_risks": [], "has_smart": False,
    }
    try:
        from . import fleet

        dr = fleet.detect_drift(iid)
        if dr.get("ok"):
            drifts = dr.get("drifts") or []
            out["drifts"] = drifts
            out["drift_critical"] = sum(
                1 for d in drifts if d["severity"] == "critical")
            out["drift_warning"] = sum(
                1 for d in drifts if d["severity"] == "warning")
            out["has_smart"] = True
        fc = fleet.forecast_capacity(iid)
        if fc.get("ok"):
            risks = [f for f in (fc.get("forecasts") or []) if f.get("eta")]
            out["capacity_risks"] = risks
            if risks:
                out["has_smart"] = True
    except Exception:
        pass
    out["score"], out["grade"] = _health_score(out)
    _smart_cache["by_iid"][iid] = out
    return out


def _health_score(smart: Dict[str, Any]) -> tuple:
    """复合健康分（0-100）：状态由调用方另行叠加，这里先按漂移/容量扣分。

    返回 (score, grade)；无任何智能数据时 grade='unknown'。"""
    if not smart.get("has_smart"):
        return None, "unknown"
    score = 100.0
    score -= min(30.0, smart.get("drift_critical", 0) * 12.0)
    score -= min(15.0, smart.get("drift_warning", 0) * 5.0)
    for f in smart.get("capacity_risks") or []:
        score -= 10.0 if f.get("severity") == "critical" else 5.0
    score = max(0.0, min(100.0, score))
    if score >= 85:
        grade = "healthy"
    elif score >= 65:
        grade = "degraded"
    elif score >= 40:
        grade = "at_risk"
    else:
        grade = "critical"
    return round(score), grade


_STATUS_PENALTY = {
    "ok": 0.0, "warn": -12.0, "crit": -30.0, "down": -60.0,
    "pending": -10.0, "unsupported": -5.0, "unknown": 0.0,
}


def _apply_status(score: Optional[float], status: str) -> Optional[float]:
    """把大屏实时状态惩罚叠加进健康分（down 直接压到最低档）。"""
    if score is None:
        return None
    s = score + _STATUS_PENALTY.get(status, -10.0)
    return round(max(0.0, min(100.0, s)))


# ── 自动关系（ADG / RAC）────────────────────────────────────────────────

def _auto_edges(rich_nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """从大屏富快照推导自动拓扑边。

    - ADG：oracle 族节点 role 含 PRIMARY 且声明了 dests（db_unique_name 列表）
      → 与同 db_unique_name 的 standby 节点连 redo 传输线（kind='adg'）。
    - RAC：同 db_name 且同为 PRIMARY 的不同实例互为集群姊妹（kind='rac'）。
    """
    edges: List[Dict[str, Any]] = []
    seen = set()

    def _add(src: str, dst: str, kind: str, label: str) -> None:
        key = (src, dst, kind)
        if src == dst or key in seen:
            return
        seen.add(key)
        edges.append({"src": src, "dst": dst, "kind": kind,
                      "label": label, "auto": True})

    by_uname: Dict[str, List[Dict[str, Any]]] = {}
    by_dbname: Dict[str, List[Dict[str, Any]]] = {}
    for n in rich_nodes:
        un = str(n.get("db_unique_name") or "").strip()
        dn = str(n.get("db_name") or "").strip()
        if un:
            by_uname.setdefault(un, []).append(n)
        if dn:
            by_dbname.setdefault(dn, []).append(n)

    for n in rich_nodes:
        if not str(n.get("db_type") or "").startswith("oracle"):
            continue
        role = str(n.get("role") or "").upper()
        # ADG 主→备
        if "PRIMARY" in role and n.get("dests"):
            for dn in n["dests"]:
                dn = str(dn or "").strip()
                for peer in by_uname.get(dn, []):
                    if peer["id"] == n["id"]:
                        continue
                    _add(n["id"], peer["id"], "adg", "Redo 传输")
        # RAC 姊妹
        dbname = str(n.get("db_name") or "").strip()
        if "PRIMARY" in role and dbname:
            for peer in by_dbname.get(dbname, []):
                if peer["id"] == n["id"]:
                    continue
                prole = str(peer.get("role") or "").upper()
                if "PRIMARY" in prole and str(peer.get("db_type") or "").startswith("oracle"):
                    _add(n["id"], peer["id"], "rac", "RAC 集群")
    return edges


# ── 手动连线 CRUD ───────────────────────────────────────────────────────

def add_link(src_iid: str, dst_iid: str, kind: str = "custom",
             label: str = "") -> Dict[str, Any]:
    """新增一条手动依赖连线。src/dst 必须不同且非空。"""
    src_iid = str(src_iid or "").strip()
    dst_iid = str(dst_iid or "").strip()
    kind = str(kind or "custom").strip()
    if not src_iid or not dst_iid:
        return {"ok": False, "error_code": "BAD_ARGS", "msg": "源/目标实例不能为空"}
    if src_iid == dst_iid:
        return {"ok": False, "error_code": "BAD_ARGS", "msg": "不能连到自身"}
    if kind not in LINK_KINDS:
        return {"ok": False, "error_code": "BAD_KIND",
                "msg": f"未知连线语义: {kind}（可选: {'/'.join(LINK_KINDS)}）"}
    with _conn() as c:
        dup = c.execute(
            "SELECT id FROM twin_links WHERE src_iid=? AND dst_iid=? AND kind=?",
            (src_iid, dst_iid, kind),
        ).fetchone()
        if dup:
            return {"ok": False, "error_code": "DUPLICATE",
                    "msg": "该连线已存在"}
        c.execute(
            "INSERT INTO twin_links (src_iid, dst_iid, kind, label, created_at) "
            "VALUES (?,?,?,?,?)",
            (src_iid, dst_iid, kind, str(label or "").strip() or None, _now()),
        )
        lid = c.execute("SELECT last_insert_rowid()").fetchone()[0]
    return {"ok": True, "id": lid}


def remove_link(link_id: int) -> Dict[str, Any]:
    with _conn() as c:
        cur = c.execute("DELETE FROM twin_links WHERE id=?", (int(link_id),))
        if cur.rowcount <= 0:
            return {"ok": False, "error_code": "NOT_FOUND", "msg": "连线不存在"}
    return {"ok": True}


def list_links() -> List[Dict[str, Any]]:
    with _conn() as c:
        c.row_factory = sqlite3.Row
        rows = c.execute(
            "SELECT id, src_iid, dst_iid, kind, label, created_at "
            "FROM twin_links ORDER BY id"
        ).fetchall()
    return [dict(r) for r in rows]


# ── 拓扑快照 ────────────────────────────────────────────────────────────

def topology_snapshot() -> Dict[str, Any]:
    """全舰队拓扑孪生快照：节点（实时状态+指标+智能叠加）+ 边 + 汇总。"""
    rich = _screen_nodes()
    if rich:
        source = "screen"
    else:
        rich = _history_nodes()
        source = "history"

    nodes: List[Dict[str, Any]] = []
    for n in rich:
        iid = n["id"]
        smart = _smart_for(iid)
        score = smart.get("score")
        score = _apply_status(score, n.get("status") or "unknown")
        grade = smart.get("grade") or "unknown"
        if score is not None:
            if score >= 85:
                grade = "healthy"
            elif score >= 65:
                grade = "degraded"
            elif score >= 40:
                grade = "at_risk"
            else:
                grade = "critical"
        conn = n.get("conn")
        conn_total = conn.get("total") if isinstance(conn, dict) else n.get("conn_total")
        if n.get("status") == "down":
            # 宕机一票否决：无论智能层有无数据，健康分归零、档位危急
            score = 0
            grade = "critical"
        nodes.append({
            "iid": iid,
            "name": n.get("name") or str(iid)[:12],
            "db_type": n.get("db_type"),
            "group": n.get("group") or "默认",
            "host": n.get("host"), "port": n.get("port"),
            "status": n.get("status") or "unknown",
            "err": n.get("err"),
            "score": score,
            "grade": grade,
            "metrics": {
                "qps": n.get("qps"), "tps": n.get("tps"),
                "conn_total": conn_total,
                "cache_hit_pct": n.get("cache_hit_pct"),
                "lock_waits": n.get("lock_waits"),
                "slowq": n.get("slowq"),
                "repl_lag_s": n.get("repl_lag_s"),
                "tbs_free_pct": n.get("tbs_free_pct"),
            },
            "role": n.get("role"),
            "db_unique_name": n.get("db_unique_name"),
            "open_mode": n.get("open_mode"),
            "instance_name": n.get("instance_name"),
            "drift_critical": smart.get("drift_critical", 0),
            "drift_warning": smart.get("drift_warning", 0),
            "drifts": smart.get("drifts", []),
            "capacity_risks": smart.get("capacity_risks", []),
            "has_smart": smart.get("has_smart", False),
        })

    edges: List[Dict[str, Any]] = []
    if source == "screen":
        edges.extend(_auto_edges(rich))
    for lk in list_links():
        edges.append({
            "id": lk["id"], "src": lk["src_iid"], "dst": lk["dst_iid"],
            "kind": lk["kind"], "label": lk["label"],
            "kind_label": LINK_KINDS.get(lk["kind"], lk["kind"]),
            "auto": False, "created_at": lk["created_at"],
        })
    # 过滤悬空边（两端节点都不在当前快照中的保留但标记，前端灰显）
    known = {n["iid"] for n in nodes}
    for e in edges:
        e["dangling"] = not (e["src"] in known and e["dst"] in known)

    summary = {
        "total": len(nodes),
        "healthy": sum(1 for n in nodes if n["grade"] == "healthy"),
        "degraded": sum(1 for n in nodes if n["grade"] == "degraded"),
        "at_risk": sum(1 for n in nodes if n["grade"] == "at_risk"),
        "critical": sum(1 for n in nodes if n["grade"] == "critical"),
        "unknown": sum(1 for n in nodes if n["grade"] == "unknown"),
        "down": sum(1 for n in nodes if n["status"] == "down"),
        "edges": len(edges),
        "auto_edges": sum(1 for e in edges if e.get("auto")),
        "manual_edges": sum(1 for e in edges if not e.get("auto")),
    }
    return {"ok": True, "ts": time.time(), "source": source,
            "nodes": nodes, "edges": edges, "summary": summary}


# ── 历史回放 ────────────────────────────────────────────────────────────

def replay(hours_ago: float = 1.0, window_s: int = 900) -> Dict[str, Any]:
    """按历史时刻重建孪生节点状态（每实例取离目标时刻最近的样本）。

    漂移/容量仅在「现在」有意义，不参与回放；边用当前静态关系
    （手动连线 + 大屏自动关系，如可得）。"""
    from modules.monitor.history_store import get_history_store

    hours_ago = max(0.0, min(float(hours_ago or 0.0), 168.0))
    at_ts = time.time() - hours_ago * 3600.0
    store = get_history_store()
    nodes: List[Dict[str, Any]] = []
    iids = []
    try:
        from .fleet import list_instances

        iids = list_instances()
    except Exception:
        iids = []
    for it in iids:
        iid = it["iid"]
        try:
            rows = store.query(iid=iid, from_ts=at_ts - window_s,
                               to_ts=at_ts + window_s, limit=50)
        except Exception:
            rows = []
        if not rows:
            continue
        s = min(rows, key=lambda r: abs(r["ts"] - at_ts))
        nodes.append({
            "iid": iid,
            "name": _resolve_label(iid),
            "db_type": s.get("db_type"),
            "group": s.get("grp") or "默认",
            "status": s.get("status") or "unknown",
            "ts": s["ts"],
            "metrics": {
                "qps": s.get("qps"), "tps": s.get("tps"),
                "conn_total": s.get("conn_total"),
                "cache_hit_pct": s.get("cache_hit_pct"),
                "lock_waits": s.get("lock_waits"),
                "slowq": s.get("slowq"),
                "repl_lag_s": s.get("repl_lag_s"),
                "tbs_free_pct": s.get("tbs_free_pct"),
            },
        })
    edges: List[Dict[str, Any]] = []
    rich = _screen_nodes()
    if rich:
        edges.extend(_auto_edges(rich))
    for lk in list_links():
        edges.append({"id": lk["id"], "src": lk["src_iid"],
                      "dst": lk["dst_iid"], "kind": lk["kind"],
                      "label": lk["label"],
                      "kind_label": LINK_KINDS.get(lk["kind"], lk["kind"]),
                      "auto": False})
    known = {n["iid"] for n in nodes}
    for e in edges:
        e["dangling"] = not (e["src"] in known and e["dst"] in known)
    return {"ok": True, "at_ts": at_ts, "hours_ago": hours_ago,
            "nodes": nodes, "edges": edges,
            "missing": [it["iid"] for it in iids
                        if it["iid"] not in known]}
