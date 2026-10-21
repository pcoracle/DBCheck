# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""舰队智能引擎（P1 Fleet Intelligence · 无监督基线 + 漂移 + 容量预测）。

借鉴 Netdata/digna 的思路：不依赖规则/章节式巡检阈值，而是对每台实例的
监控时序（modules.monitor.history_store，30 天留存）做**无监督统计学习**：

1. 基线学习  ``learn_baseline``
   按「小时」24 桶对每个指标分桶（跨星期聚合），计算 P50 / P95 与样本数，
   刻画该实例一天内不同时段的正常波动区间。
   （不放细分到 星期×小时 168 桶：30 天留存下每桶仅 ~4 样本，P95 无统计
   意义；小时桶 30 天约 30 样本、14 天约 14 样本，稳健得多。）
2. 漂移检测  ``detect_drift``
   最近样本 vs 对应时段基线，鲁棒 z = (x - p50) / (p95 - p50)
   （分母趋零时退化为绝对偏离比），z≥3 critical、z≥2 warning。
3. 容量预测  ``forecast_capacity``
   对趋势型指标（conn_usage_pct 上升 / tbs_free_pct 下降等）做
   最小二乘线性回归外推，给出预计触及阈值的日期。
4. 舰队总览  ``fleet_overview``
   跨实例聚合漂移计数与容量风险排行（「舰队视图」）。
5. 闭环种子  ``emit_drift_findings``
   把漂移/容量事件映射为 Finding 形状 dict（与 inspection.findings
   同约定），供 AutonomyLoop 作为第二种子源消费。

设计约束：
* 纯 stdlib（statistics/math/sqlite3），零第三方依赖，PyInstaller 友好；
* 基线持久化在独立库 data/fleet_baseline.db（运行时数据，不入版本库）；
* 只读监控历史库，绝不写入 samples；
* iid 与实时监控/大屏的实例 id 同源，展示名尽力从实例管理器解析，
  解析失败回退 iid 短形式（不缓存敏感明文）。
"""

from __future__ import annotations

import json
import math
import os
import sqlite3
import statistics
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

# ── 指标白名单（与 history_store._COLS 对齐的连续型指标）──────────────
# direction: up=越大越危险（触顶阈值 threshold）; down=越小越危险
METRICS = {
    "qps":            {"label": "QPS",        "direction": "up",   "threshold": None},
    "tps":            {"label": "TPS",        "direction": "up",   "threshold": None},
    "cache_hit_pct":  {"label": "缓存命中率", "direction": "down", "threshold": 90.0},
    "lock_waits":     {"label": "锁等待",     "direction": "up",   "threshold": None},
    "conn_total":     {"label": "连接数",     "direction": "up",   "threshold": None},
    "conn_usage_pct": {"label": "连接使用率", "direction": "up",   "threshold": 85.0},
    "conn_active":    {"label": "活跃连接",   "direction": "up",   "threshold": None},
    "slowq":          {"label": "慢查询数",   "direction": "up",   "threshold": None},
    "repl_lag_s":     {"label": "复制延迟(s)","direction": "up",   "threshold": 60.0},
    "tbs_free_pct":   {"label": "表空间余量", "direction": "down", "threshold": 15.0},
}

# 漂移判定阈值（鲁棒 z 分数）
Z_CRITICAL = 3.0
Z_WARNING = 2.0

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_DB_PATH = os.path.join(_REPO_ROOT, "data", "fleet_baseline.db")

# 参与容量预测的默认指标（有明确触顶语义的）
FORECAST_METRICS = ("conn_usage_pct", "tbs_free_pct", "cache_hit_pct", "repl_lag_s")


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _conn():
    c = sqlite3.connect(_DB_PATH)
    c.execute("PRAGMA journal_mode=WAL")
    return c


def _init_db() -> None:
    with _conn() as c:
        # 旧版 schema（星期×小时 168 桶）带 dow 列：探测到即整体重建。
        # 基线数据随时可由「学习」重算，删除无损。
        cols = [r[1] for r in c.execute("PRAGMA table_info(fleet_baselines)")]
        if cols and "dow" in cols:
            c.execute("DROP TABLE fleet_baselines")
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS fleet_baselines (
                iid        TEXT NOT NULL,
                metric     TEXT NOT NULL,
                hour       INTEGER NOT NULL,   -- 0..23（跨星期聚合的小时桶）
                p50        REAL,
                p95        REAL,
                mean       REAL,
                n          INTEGER,
                learned_at TEXT NOT NULL,
                PRIMARY KEY (iid, metric, hour)
            )
            """
        )
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_fb_iid ON fleet_baselines(iid, metric)"
        )


_init_db()


# ── 数据读取 ────────────────────────────────────────────────────────────

def _load_samples(iid: str, days: int) -> List[Dict[str, Any]]:
    """只读拉取目标实例最近 N 天的历史样本。"""
    from modules.monitor.history_store import get_history_store

    store = get_history_store()
    return store.query(
        iid=iid, from_ts=time.time() - days * 86400.0, limit=200000
    )


def _load_recent(iid: str, minutes: int = 30) -> List[Dict[str, Any]]:
    """拉取目标实例最近一段时间的样本（漂移判定用）。"""
    from modules.monitor.history_store import get_history_store

    store = get_history_store()
    return store.query(iid=iid, from_ts=time.time() - minutes * 60.0, limit=500)


def list_instances() -> List[Dict[str, Any]]:
    """列出历史库中有数据的实例（iid + db_type + 样本数 + 时间范围）。"""
    from modules.monitor.history_store import _COLS

    cols = "iid, db_type, COUNT(*) AS n, MIN(ts) AS mn, MAX(ts) AS mx"
    from modules.monitor import history_store as hs

    with hs.get_history_store()._conn() as c:
        c.row_factory = sqlite3.Row
        rows = c.execute(
            f"SELECT {cols} FROM samples GROUP BY iid, db_type ORDER BY n DESC"
        ).fetchall()
    return [dict(r) for r in rows]


# ── F1-1 基线学习 ───────────────────────────────────────────────────────

def _pct(sorted_vals: List[float], p: float) -> float:
    """线性插值分位数（与 numpy 默认 percentile 一致的策略）。"""
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * p
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def _bucket_stats(vals: List[float]) -> Optional[Dict[str, float]]:
    if len(vals) < 3:
        return None  # 样本不足的桶不建基线
    sv = sorted(vals)
    return {
        "p50": round(_pct(sv, 0.50), 4),
        "p95": round(_pct(sv, 0.95), 4),
        "mean": round(statistics.fmean(sv), 4),
    }


def learn_baseline(
    iid: str, metrics: Optional[List[str]] = None, days: int = 14
) -> Dict[str, Any]:
    """学习目标实例的时段基线并持久化。

    按「星期 × 小时」分桶；学习成功后覆盖该实例旧基线（幂等 upsert）。
    返回 {ok, iid, days, metrics: {metric: buckets}, skipped}。
    """
    metrics = [m for m in (metrics or list(METRICS)) if m in METRICS]
    samples = _load_samples(iid, days)
    if len(samples) < 50:
        return {"ok": False, "error_code": "INSUFFICIENT_DATA",
                "detail": f"样本不足（{len(samples)} < 50），需先积累监控历史。",
                "iid": iid, "n_samples": len(samples)}

    buckets: Dict[str, int] = {m: 0 for m in metrics}
    learned_at = _now()
    rows = []
    for metric in metrics:
        by_slot: Dict[int, List[float]] = {}
        for s in samples:
            v = s.get(metric)
            if v is None:
                continue
            try:
                v = float(v)
            except (TypeError, ValueError):
                continue
            if math.isnan(v) or math.isinf(v):
                continue
            by_slot.setdefault(datetime.fromtimestamp(s["ts"]).hour, []).append(v)
        for hour, vals in by_slot.items():
            st = _bucket_stats(vals)
            if st:
                rows.append((iid, metric, hour, st["p50"], st["p95"],
                             st["mean"], len(vals), learned_at))
                buckets[metric] += 1

    with _conn() as c:
        c.execute("DELETE FROM fleet_baselines WHERE iid=?", (iid,))
        c.executemany(
            "INSERT OR REPLACE INTO fleet_baselines "
            "(iid, metric, hour, p50, p95, mean, n, learned_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            rows,
        )

    return {
        "ok": True,
        "iid": iid,
        "days": days,
        "n_samples": len(samples),
        "buckets": buckets,
        "learned_at": learned_at,
    }


def get_baseline(iid: str, metric: str) -> List[Dict[str, Any]]:
    """读取目标实例某指标的基线桶（按小时升序）。"""
    with _conn() as c:
        c.row_factory = sqlite3.Row
        rows = c.execute(
            "SELECT hour, p50, p95, mean, n, learned_at FROM fleet_baselines "
            "WHERE iid=? AND metric=? ORDER BY hour",
            (iid, metric),
        ).fetchall()
    return [dict(r) for r in rows]


def baseline_status() -> List[Dict[str, Any]]:
    """各实例基线学习状态（桶数 / 最近学习时间）。"""
    with _conn() as c:
        c.row_factory = sqlite3.Row
        rows = c.execute(
            "SELECT iid, COUNT(DISTINCT metric) AS metrics, COUNT(*) AS buckets, "
            "MAX(learned_at) AS learned_at FROM fleet_baselines GROUP BY iid"
        ).fetchall()
    return [dict(r) for r in rows]


# ── F1-2 漂移检测 ───────────────────────────────────────────────────────

def _robust_z(x: float, p50: float, p95: float) -> float:
    """鲁棒 z 分数：分母为 0 时退化为相对偏离（避免除零）。"""
    spread = p95 - p50
    if spread <= 1e-9:
        base = max(abs(p50), 1.0)
        return abs(x - p50) / base * 5.0  # 退化标度
    return (x - p50) / spread


def detect_drift(iid: str, minutes: int = 30) -> Dict[str, Any]:
    """对目标实例执行漂移检测：最近样本 vs 对应时段基线。

    返回 {ok, iid, checked, drifts: [{metric, value, p50, p95, z, severity, at}]}。
    """
    recent = _load_recent(iid, minutes)
    if not recent:
        return {"ok": True, "iid": iid, "checked": 0, "drifts": [],
                "detail": "最近无监控样本，跳过漂移检测。"}
    # 每指标取最近窗口的 P95（窗口峰值视角，避免瞬时抖动误报）
    cur: Dict[str, float] = {}
    for metric in METRICS:
        vals = sorted(float(s[metric]) for s in recent
                      if s.get(metric) is not None)
        if vals:
            cur[metric] = _pct(vals, 0.95)

    with _conn() as c:
        c.row_factory = sqlite3.Row
        bl = c.execute(
            "SELECT metric, hour, p50, p95 FROM fleet_baselines WHERE iid=?",
            (iid,),
        ).fetchall()
    if not bl:
        return {"ok": False, "error_code": "NO_BASELINE",
                "detail": "尚未学习基线，请先执行基线学习。", "iid": iid}

    lookup: Dict[str, Dict[int, tuple]] = {}
    for r in bl:
        lookup.setdefault(r["metric"], {})[r["hour"]] = (r["p50"], r["p95"])

    drifts: List[Dict[str, Any]] = []
    latest = recent[-1]
    dt = datetime.fromtimestamp(latest["ts"])
    slot = dt.hour
    for metric, value in cur.items():
        base = lookup.get(metric, {}).get(slot)
        if not base or base[0] is None:
            continue
        p50, p95 = base
        # 方向敏感：只对「变差方向」报漂移
        direction = METRICS[metric]["direction"]
        z = _robust_z(value, p50, p95)
        if direction == "up":
            z = z if value > p50 else 0.0
        else:
            z = z if value < p50 else 0.0
        if z >= Z_WARNING:
            drifts.append({
                "metric": metric,
                "label": METRICS[metric]["label"],
                "value": round(value, 3),
                "p50": p50,
                "p95": p95,
                "z": round(z, 2),
                "severity": "critical" if z >= Z_CRITICAL else "warning",
                "at": latest["ts"],
            })
    drifts.sort(key=lambda d: -d["z"])
    return {"ok": True, "iid": iid, "checked": len(cur), "drifts": drifts}


# ── F1-3 容量预测 ───────────────────────────────────────────────────────

def _linreg_slope(xs: List[float], ys: List[float]) -> tuple:
    """最小二乘：返回 (slope, intercept)。x 单位=天。"""
    n = len(xs)
    if n < 2:
        return 0.0, ys[0] if ys else 0.0
    mx = statistics.fmean(xs)
    my = statistics.fmean(ys)
    denom = sum((x - mx) ** 2 for x in xs)
    if denom <= 1e-12:
        return 0.0, my
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom
    return slope, my - slope * mx


def forecast_capacity(iid: str, horizon_days: int = 30) -> Dict[str, Any]:
    """对趋势型指标做线性外推，预测触及阈值的日期。

    返回 {ok, iid, forecasts: [{metric, label, current, slope_per_day,
            threshold, days_to_threshold, eta, severity}]}。
    eta 为空表示预测窗口内不触顶。
    """
    samples = _load_samples(iid, days=14)
    if len(samples) < 20:
        return {"ok": False, "error_code": "INSUFFICIENT_DATA",
                "detail": "历史样本不足 20 条，无法容量预测。", "iid": iid}

    t0 = samples[0]["ts"]
    forecasts: List[Dict[str, Any]] = []
    now = datetime.now()
    for metric in FORECAST_METRICS:
        pts = [(s["ts"], float(s[metric])) for s in samples
               if s.get(metric) is not None]
        if len(pts) < 10:
            continue
        xs = [(t - t0) / 86400.0 for t, _ in pts]
        ys = [v for _, v in pts]
        slope, intercept = _linreg_slope(xs, ys)
        current = ys[-1]
        threshold = METRICS[metric]["threshold"]
        if threshold is None:
            continue
        direction = METRICS[metric]["direction"]
        days_to = None
        if direction == "up":
            if current >= threshold:
                days_to = 0.0  # 已越过阈值：立即报告
            elif slope > 1e-9:
                days_to = (threshold - current) / slope
        else:  # down
            if current <= threshold:
                days_to = 0.0
            elif slope < -1e-9:
                days_to = (current - threshold) / (-slope)
        eta = None
        severity = None
        if days_to is not None and days_to <= horizon_days:
            eta = (now + timedelta(days=days_to)).strftime("%Y-%m-%d")
            severity = "critical" if days_to <= 7 else (
                "warning" if days_to <= 30 else None)
        forecasts.append({
            "metric": metric,
            "label": METRICS[metric]["label"],
            "current": round(current, 2),
            "slope_per_day": round(slope, 4),
            "threshold": threshold,
            "days_to_threshold": round(days_to, 1) if days_to is not None else None,
            "eta": eta,
            "severity": severity,
        })
    return {"ok": True, "iid": iid, "horizon_days": horizon_days,
            "forecasts": forecasts}


# ── F1-4 舰队总览 ───────────────────────────────────────────────────────

def _resolve_label(iid: str) -> str:
    """尽力解析实例展示名（不缓存敏感明文）。"""
    try:
        from modules.pro.instance_manager import get_instance_manager

        inst = get_instance_manager().get_instance_decrypted(iid)
        if inst and inst.get("name"):
            return str(inst["name"])
    except Exception:
        pass
    return str(iid)[:12]


def fleet_overview() -> Dict[str, Any]:
    """舰队视图：每实例 基线状态 + 漂移摘要 + 容量风险 排行。"""
    insts = list_instances()
    statuses = {s["iid"]: s for s in baseline_status()}
    out: List[Dict[str, Any]] = []
    for it in insts:
        iid = it["iid"]
        st = statuses.get(iid)
        row: Dict[str, Any] = {
            "iid": iid,
            "name": _resolve_label(iid),
            "db_type": it.get("db_type"),
            "n_samples": it.get("n"),
            "has_baseline": bool(st),
            "baseline_buckets": st["buckets"] if st else 0,
            "learned_at": st["learned_at"] if st else None,
            "drifts": [],
            "drift_critical": 0,
            "drift_warning": 0,
            "capacity_risks": [],
        }
        if st:  # 有基线才做漂移/预测（无基线提示学习）
            try:
                dr = detect_drift(iid)
                if dr.get("ok"):
                    row["drifts"] = dr["drifts"]
                    row["drift_critical"] = sum(
                        1 for d in dr["drifts"] if d["severity"] == "critical")
                    row["drift_warning"] = sum(
                        1 for d in dr["drifts"] if d["severity"] == "warning")
            except Exception:
                pass
            try:
                fc = forecast_capacity(iid)
                if fc.get("ok"):
                    row["capacity_risks"] = [f for f in fc["forecasts"]
                                             if f.get("eta")]
            except Exception:
                pass
        out.append(row)

    # 排行：容量风险 > critical 漂移 > warning 漂移
    def rank(r: Dict[str, Any]) -> tuple:
        cap = max((7 - min(f["days_to_threshold"], 7))
                  for f in r["capacity_risks"]) if r["capacity_risks"] else 0
        return (len(r["capacity_risks"]), r["drift_critical"],
                r["drift_warning"], cap)

    out.sort(key=rank, reverse=True)
    return {"ok": True, "ts": time.time(), "instances": out,
            "total": len(out), "with_baseline": sum(1 for r in out if r["has_baseline"])}


# ── F3 闭环种子 ─────────────────────────────────────────────────────────

def emit_drift_findings(iid: str) -> List[Dict[str, Any]]:
    """把漂移/容量事件映射为 Finding 形状 dict（自治闭环第二种子源）。

    字段与 modules.inspection.findings.emit_findings 的输出约定一致，
    不引入对 intelligence 模块的运行时依赖。
    """
    out: List[Dict[str, Any]] = []
    label = _resolve_label(iid)
    try:
        dr = detect_drift(iid)
    except Exception:
        dr = {"ok": False}
    if dr.get("ok"):
        for d in dr.get("drifts") or []:
            sev = d["severity"]
            out.append({
                "source": "fleet",
                "category": "risk",
                "severity": sev,
                "title": f"[舰队漂移] {d['label']} 偏离时段基线",
                "detail": (f"实例 {label} 指标 {d['label']} 当前 {d['value']}，"
                           f"该时段基线 P50={d['p50']} / P95={d['p95']}，"
                           f"鲁棒 z={d['z']}（≥{Z_WARNING} 判漂移）。"),
                "suggestion": "结合业务确认是否预期（活动/批量任务）；"
                              "非预期漂移需排查连接泄漏/慢查询/资源瓶颈。",
                "tags": ["fleet", "drift", d["metric"]],
            })
    try:
        fc = forecast_capacity(iid)
    except Exception:
        fc = {"ok": False}
    if fc.get("ok"):
        for f in fc.get("forecasts") or []:
            if not f.get("eta"):
                continue
            out.append({
                "source": "fleet",
                "category": "risk",
                "severity": f["severity"] or "warning",
                "title": f"[容量预测] {f['label']} 预计 {f['eta']} 触及阈值",
                "detail": (f"实例 {label} 指标 {f['label']} 当前 {f['current']}，"
                           f"近 14 天日增速率 {f['slope_per_day']}，"
                           f"预计 {f['days_to_threshold']} 天后触及阈值 "
                           f"{f['threshold']}。"),
                "suggestion": "提前规划扩容/清理/归档；连接类风险可考虑调大上限"
                              "或引入连接池治理。",
                "tags": ["fleet", "capacity", f["metric"]],
            })
    return out
