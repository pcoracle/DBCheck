# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""MCP 分析工具隔离子进程（与 intel_inspection_cli 同构）。

被 MCP 工具（slow_queries / index_health / baseline_check / lock_tree）调用，
避免在主进程内直接跑驱动/分析器（JDBC/插件类型可能拉起 JVM 钉死 hub）。

两种运行模式：
1. **一次性（默认）**：``python analysis_cli.py <type> <instance_id> [db_type]``
   处理单个任务后退出，stdout 仅打印一行 JSON（成功/失败统一结构）。
2. **常驻 worker（--worker）**：供子进程池 ``subproc_pool.py`` 复用——启动预热
   一次（bootstrap + 导入驱动），之后逐行读取任务 JSON、执行、回写结果行，
   复用解释器与已导入的驱动/插件，显著省去每次调用的冷启动开销（连接池同款思路）。
   启动成功先打印 ``{"ok": true, "ready": true}`` 握手行；收到 ``{"__quit": 1}`` 退出。

输出契约:  stdout 仅打印**一行** JSON（成功或失败统一结构），其余日志走 stderr。
            {"ok": True,  "analysis_type": "...", "result": {...}}
            {"ok": False, "error": "..."}
"""

import json
import os
import sys

# 防递归标记（语义占位，当前无子进程再派生子进程的链路）
os.environ.setdefault("DBCheck_MCP_ANALYSIS_SUBPROCESS", "1")

# 协议流保护：bootstrap / 驱动 / 插件加载等散落 print 会直接污染 JSON-RPC 协议流
# （尤其常驻 worker 的 READY 握手首行）。统一把 sys.stdout 指向 stderr，结构化结果
# 仅经 _emit 写原始 stdout 的二进制缓冲（utf-8）——与 server.py 同款做法。
_RAW_STDOUT = sys.__stdout__
try:
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass
sys.stdout = sys.stderr


def _emit(payload: dict) -> None:
    data = (json.dumps(payload, ensure_ascii=False, default=str) + "\n").encode("utf-8")
    try:
        _RAW_STDOUT.buffer.write(data)
        _RAW_STDOUT.buffer.flush()
    except Exception:
        pass


def _run_analysis(analysis_type: str, db_type: str, conn, inst=None,
                  lang: str = "zh", days_threshold: int = 90) -> dict:
    if analysis_type == "slow_query":
        from modules.inspection.slow_query import get_slow_query_analyzer
        analyzer = get_slow_query_analyzer(db_type)
        if analyzer is None:
            return {"ok": False, "error": f"慢查询分析暂不支持该数据库类型: {db_type}"}
        result = analyzer.analyze(conn, ai_advisor=None, lang=lang)
        return {"ok": True, "result": result.to_dict()}

    if analysis_type == "index_health":
        from modules.inspection.index_health import (
            get_index_health, format_index_health_report,
        )
        report = get_index_health(db_type, conn, days_threshold=days_threshold)
        if report is None:
            return {"ok": False, "error": f"索引健康分析暂不支持该数据库类型: {db_type}"}
        text = format_index_health_report(report, db_type)
        return {"ok": True, "result": {"report": report, "text": text}}

    if analysis_type == "baseline":
        from modules.inspection.config_baseline import (
            get_config_baseline, format_config_baseline_report,
        )
        report = get_config_baseline(db_type, conn)
        if report is None:
            return {"ok": False, "error": f"配置基线检查暂不支持该数据库类型: {db_type}"}
        text = format_config_baseline_report(report, db_type)
        return {"ok": True, "result": {"report": report, "text": text}}

    if analysis_type == "lock":
        # inst 由调用方透传（此前在 main 局部作用域引用，属隐患；现显式传参）
        from modules.inspection.lock_health import get_lock_tree
        result = get_lock_tree(db_type, inst)
        return {"ok": result.get("ok", False),
                **({"result": result} if result.get("ok") else {"error": result.get("error")})}

    return {"ok": False, "error": f"未知分析类型: {analysis_type}"}


def _serve_task(task: dict) -> dict:
    """执行单个分析任务（不含 bootstrap，假定调用方已预热 sys.path）。

    返回与 emit 一致的结构化 dict；任何异常都被捕获为结构化失败，
    绝不向 stdout 抛栈（保护协议流）。
    """
    analysis_type = task.get("analysis_type")
    instance_id = task.get("instance_id")
    db_type_override = task.get("db_type") or None
    lang = task.get("lang") or "zh"
    try:
        days_threshold = int(task.get("days_threshold") or 90)
    except Exception:
        days_threshold = 90
    try:
        from modules.pro import get_instance_manager
        from modules.intelligence.db_executor import connect_instance, close_instance

        im = get_instance_manager()
        inst = im.get_instance_decrypted(instance_id)
        if not inst:
            return {"ok": False, "error": f"instance not found: {instance_id}"}

        db_type = db_type_override or inst.get("db_type")
        conn = connect_instance(inst)
        try:
            out = _run_analysis(analysis_type, db_type, conn, inst=inst,
                                lang=lang, days_threshold=days_threshold)
        finally:
            close_instance(conn)
        return {
            "ok": out.get("ok", False),
            "analysis_type": analysis_type,
            **({"result": out["result"]} if "result" in out else {}),
            **({"error": out["error"]} if "error" in out else {}),
        }
    except Exception as e:  # 任何异常都转为结构化失败，绝不污染 stdout 协议流
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def _worker_main() -> int:
    """常驻 worker 模式：预热一次，循环处理任务（供子进程池复用）。"""
    from modules.mcp_server.bootstrap import bootstrap
    try:
        root = bootstrap()
        sys.path.insert(0, root)
    except Exception as e:
        _emit({"ok": False, "ready": False, "error": f"bootstrap failed: {e}"})
        return 2
    # 握手行：父进程据此判定 worker 已就绪（已预热完毕）
    _emit({"ok": True, "ready": True})

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            task = json.loads(raw)
        except Exception:
            _emit({"ok": False, "error": "bad task json"})
            continue
        if task.get("__quit"):
            break
        try:
            out = _serve_task(task)
        except Exception as e:  # 兜底（_serve_task 自身已捕获，此处防意外）
            out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        _emit(out)
    return 0


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] == "--worker":
        return _worker_main()

    if len(sys.argv) < 3:
        _emit({"ok": False, "error": "usage: analysis_cli.py <type> <instance_id> [db_type]"})
        return 2
    analysis_type = sys.argv[1]
    instance_id = sys.argv[2]
    db_type_override = sys.argv[3] if len(sys.argv) > 3 else None

    from modules.mcp_server.bootstrap import bootstrap
    root = bootstrap()
    sys.path.insert(0, root)

    out = _serve_task({
        "analysis_type": analysis_type,
        "instance_id": instance_id,
        "db_type": db_type_override,
    })
    _emit(out)
    return 0


if __name__ == "__main__":
    main()
