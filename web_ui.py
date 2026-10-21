# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

# ── 单实例守卫（必须在 import modules.web.app 之前）──
# 避免双击 / 重复启动 / 旧进程残留时多个 dbcheck.exe 同时运行，
# 互相抢占端口、并重复打印整段启动 banner（表现为『反复重启』）。
import os
import sys

# ── OpenBLAS/NumPy 线程池护栏（必须在任何 numpy/openpyxl 导入之前）─────────
# numpy 1.26（内置 OpenBLAS 0.3.2x）在 import 时按宿主机 CPU 数预建 BLAS 线程池，
# 每建一个线程都要 clone() 系统调用。受限容器（企业安全容器 / 定制 seccomp / LXC
# 嵌套虚拟化）里 clone() 被内核拒绝，导入即崩："OpenBLAS blas_thread_init:
# pthread_create failed ... Operation not permitted"（ulimit nproc 放开也没用）。
# =1 时 OpenBLAS 完全不建线程池，从根上绕开被拦的 clone()；本项目数值计算很轻，
# 单线程几乎无损失。Dockerfile 已设同名 ENV，这里 setdefault 兜底非 Docker 环境；
# 需要多线程 BLAS 的高级用户仍可在启动前自行 export 覆盖。
for _blas_var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS",
                  "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_blas_var, "1")
del _blas_var

# ── JDBC 连接测试隔离子进程入口（必须在单实例守卫之前）────────────────
# HGDB / DB2 / SQL Server(JDBC) 依赖 JPype 在进程内启动 JVM。Web 主进程跑在
# gevent 协作式服务器上，JVM 的原生线程会长时间霸占执行权，导致整个 Web UI
# 冻结（点「测试连接」后界面卡死）。因此这类测试改由主进程 fork 出本 CLI 子
# 进程执行：JVM 只活在子进程里，超时可直接杀进程树，主进程始终可响应。
#
# 该分支必须跑在单实例守卫**之前**：子进程与主进程是同一个 exe，若先走守卫，
# 会因为「已有实例在运行」而直接 os._exit(0)，测试永远拿不到结果。
if '--jdbc-test-cli' in sys.argv[1:]:
    from modules.jdbc_test_cli import main as _jdbc_test_main

    sys.exit(_jdbc_test_main())


# ── JDBC 巡检任务隔离子进程入口（必须在单实例守卫之前）────────────────
# HGDB / DB2 / SQL Server(JDBC) / oracle_jdbc 等 JVM 插件的完整巡检任务
# 在子进程内执行，避免主进程 gevent hub 被 JVM 原生线程钉死。
if '--jdbc-inspection-cli' in sys.argv[1:]:
    from modules.jdbc_inspection_cli import main as _jdbc_insp_main

    sys.exit(_jdbc_insp_main())


# ── 智能诊断中心 · 深度巡检隔离子进程入口（必须在单实例守卫之前）────────
# HGDB / DB2 / SQL Server(JDBC) / oracle_jdbc 依赖 JPype 在进程内启动 JVM。
# 智能诊断中心的「深度巡检分析专员」会实时跑巡检引擎，同样会把 gevent hub 钉死，
# 导致整个 Web UI 冻结（前端一直卡在「深度巡检分析专员 工作中」）。因此这类巡检
# 改由主进程 fork 出本 CLI 子进程执行：JVM 只活在子进程里，主进程始终可响应。
if '--intelligence-inspection-cli' in sys.argv[1:]:
    from modules.intelligence.intel_inspection_cli import main as _intel_insp_main

    sys.exit(_intel_insp_main())


# ── JDBC 实时指标采集隔离子进程入口（必须在单实例守卫之前）────────────────
# oracle_jdbc / uxdb_jdbc 实时采集（metrics_collector 每 30s tick）依赖 JPype 在
# 进程内启动 JVM；同样会把 gevent hub 钉死冻结整个界面。该 CLI 在干净子进程里
# 完成连接 + 深采，结果以 JSON 返回 stdout，主进程只 spawn + 解析，绝不起 JVM。
# frozen 模式下 metrics_collector._collect_jvm_subprocess 的 cmd 分支走此 flag。
if '--jdbc-metrics-cli' in sys.argv[1:]:
    from modules.jdbc_metrics_cli import main as _jdbc_metrics_main

    sys.exit(_jdbc_metrics_main())


# ── 监控大屏 JDBC 批量采集隔离子进程入口（必须在单实例守卫之前）──────────
# gbase / db2 / clickhouse 无 python 原生驱动，监控引擎每轮的批量采集依赖
# JPype 在进程内启动 JVM；同样会把 gevent hub 钉死冻结整个界面。主进程只
# spawn + 解析 JSON（MonitorEngine._jdbc_run_batch），绝不起 JVM。
if '--jdbc-collect-cli' in sys.argv[1:]:
    from modules.monitor.jdbc_collect_cli import main as _jdbc_collect_main

    sys.exit(_jdbc_collect_main())


def _acquire_single_instance():
    # 仅对 PyInstaller 冻结后的 exe 生效；开发态 `python web_ui.py` 不限制，便于多开调试。
    if not getattr(sys, 'frozen', False):
        return
    _lock = os.path.join(os.path.dirname(sys.executable), '.dbcheck.lock')
    try:
        import psutil  # 冻结构建已内置（hiddenimports）
        _fd = os.open(_lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(_fd, str(os.getpid()).encode())
        os.close(_fd)

        # 正常退出时清理锁文件（os._exit 不会触发 atexit，故旧实例异常退出可能留残留锁，
        # 下面 FileExistsError 分支会用 psutil.pid_exists 判定并接管）。
        def _cleanup():
            try:
                if os.path.exists(_lock):
                    os.remove(_lock)
            except Exception:
                pass

        import atexit
        atexit.register(_cleanup)
    except FileExistsError:
        # 锁已存在：检查持有者是否还活着
        try:
            _pid = int(open(_lock, 'r', encoding='utf-8').read().strip() or '0')
            if psutil.pid_exists(_pid):
                print(
                    f"[RaccoonX] 已有实例在运行（PID {_pid}），本进程退出以避免端口冲突。",
                    flush=True,
                )
                os._exit(0)
        except Exception:
            pass
        # 旧锁残留（持有进程已死），接管：删除后重试一次
        try:
            os.remove(_lock)
        except Exception:
            pass
        return _acquire_single_instance()
    except Exception:
        # psutil 缺失等异常情况下降级：不阻塞启动
        pass


_acquire_single_instance()

# 启动入口 shim：转发到 modules.web.app.main()，保持 `python web_ui.py` 可启动调试
from modules.web.app import *  # noqa: F401,F403

if __name__ == "__main__":
    main()
