# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""MCP Server 生产级可观测性（指标 + 追踪）。

设计目标（对齐 MCP Toolbox 的"生产级可观测"卖点，但不引入强制依赖）：
- **零强制依赖**：OpenTelemetry 仅在 ``DBCHECK_MCP_OTEL=1`` 且对应包可导入时启用；
  否则自动回退到**进程内计数器**（线程安全），保证社区版 PyInstaller 构建不膨胀。
- **统一埋点接口** ``record_tool_call``：工具名 / 耗时(ms) / 状态(ok|error|timeout) /
  错误码 / 租户作用域(none|tenant|user)，供 OTel 导出或本地快照。
- 进程内快照 ``get_metrics_snapshot()`` 始终可用，未来可挂到监控大屏/HTTP 端点。
- 周期性 stderr 摘要：``DBCHECK_MCP_TELEMETRY_SUMMARY=1`` 时每 100 次调用打印一次，
  便于无 OTel 环境肉眼观察。

OTel 导出配置（启用后）：
- 指标/追踪默认走 OTLP gRPC；若 grpc 包缺失自动降级 http/protobuf，再降级 console。
- 标准环境变量 ``OTEL_EXPORTER_OTLP_ENDPOINT`` / ``OTEL_EXPORTER_OTLP_HEADERS`` 自动生效。
"""

import os
import sys
import threading
import time

# ── 进程内计数器（始终可用，OTel 缺失时的兜底） ──────────────────────────────
_lock = threading.Lock()
_calls = 0
_errors = 0
_timeouts = 0
_latency_ms_total = 0.0
_by_tool = {}          # tool -> {"calls":int,"errors":int,"timeout":int,"latency_ms":float}
_by_status = {}        # status -> count
_inflight = 0

# OTel 句柄（启用且可用时填充）
_otel_enabled = False
_meter = None
_tracer = None
_c_total = None        # Counter: mcp_server_tool_calls_total
_c_error = None        # Counter: mcp_server_tool_errors_total
_h_duration = None     # Histogram: mcp_server_tool_duration_ms
_u_inflight = None     # UpDownCounter: mcp_server_inflight


def _maybe_init_otel() -> bool:
    """尝试启用 OpenTelemetry；失败则保持进程内兜底（返回 False）。"""
    global _otel_enabled, _meter, _tracer, _c_total, _c_error, _h_duration, _u_inflight
    if _otel_enabled or _meter is not None:
        return _otel_enabled
    if os.environ.get("DBCHECK_MCP_OTEL") != "1":
        return False
    try:
        from opentelemetry import metrics as otel_metrics, trace as otel_trace
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except Exception as e:  # 包未安装 → 回退
        _log(f"OTel 不可用，使用进程内计数器兜底: {e}")
        return False

    resource = Resource.create({"service.name": "dbcheck-mcp",
                               "service.version": _server_version()})
    exporter = _build_metric_exporter()
    span_exporter = _build_span_exporter()
    if exporter is None and span_exporter is None:
        _log("OTel 导出器均不可用，使用进程内计数器兜底")
        return False

    readers = []
    if exporter is not None:
        readers.append(PeriodicExportingMetricReader(exporter))
    try:
        mp = MeterProvider(resource=resource, metric_readers=readers) if readers \
            else MeterProvider(resource=resource)
        otel_metrics.set_meter_provider(mp)
        _meter = otel_metrics.get_meter("dbcheck-mcp")
        _c_total = _meter.create_counter(
            "mcp_server_tool_calls_total",
            description="MCP 工具调用总次数")
        _c_error = _meter.create_counter(
            "mcp_server_tool_errors_total",
            description="MCP 工具调用失败次数（含 timeout）")
        _h_duration = _meter.create_histogram(
            "mcp_server_tool_duration_ms",
            description="MCP 工具调用耗时（毫秒）")
        _u_inflight = _meter.create_up_down_counter(
            "mcp_server_inflight",
            description="当前进行中的 MCP 工具调用数")
    except Exception as e:
        _log(f"OTel Meter 初始化失败，回退: {e}")
        _meter = None

    if span_exporter is not None:
        try:
            tp = TracerProvider(resource=resource)
            tp.add_span_processor(BatchSpanProcessor(span_exporter))
            otel_trace.set_tracer_provider(tp)
            _tracer = otel_trace.get_tracer("dbcheck-mcp")
        except Exception as e:
            _log(f"OTel Tracer 初始化失败: {e}")
            _tracer = None

    _otel_enabled = (_meter is not None) or (_tracer is not None)
    if _otel_enabled:
        _log(f"OTel 已启用（metric={'Y' if _meter else 'N'}, "
             f"trace={'Y' if _tracer else 'N'}）")
    return _otel_enabled


def _build_metric_exporter():
    try:
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import (
            OTLPMetricExporter)
        return OTLPMetricExporter()
    except Exception:
        pass
    try:
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
            OTLPMetricExporter as HttpMetricExporter)
        return HttpMetricExporter()
    except Exception:
        pass
    try:
        from opentelemetry.sdk.metrics.export import ConsoleMetricExporter
        return ConsoleMetricExporter()
    except Exception:
        pass
    return None


def _build_span_exporter():
    try:
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
            OTLPSpanExporter)
        return OTLPSpanExporter()
    except Exception:
        pass
    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter as HttpSpanExporter)
        return HttpSpanExporter()
    except Exception:
        pass
    try:
        from opentelemetry.sdk.trace.export import ConsoleSpanExporter
        return ConsoleSpanExporter()
    except Exception:
        pass
    return None


def _server_version() -> str:
    try:
        from modules.mcp_server.server import SERVER_VERSION
        return SERVER_VERSION
    except Exception:
        return "unknown"


def _log(msg: str) -> None:
    sys.stderr.write(f"[mcp-telemetry] {msg}\n")
    sys.stderr.flush()


def init() -> bool:
    """显式触发 OTel 初始化（在 server.main 启动早期调用一次）。

    无需 OTel 或环境变量未开时返回 False，保持进程内兜底。重复调用安全。
    """
    return _maybe_init_otel()


# ── 统一埋点接口 ───────────────────────────────────────────────────────────────
def record_tool_call(name: str, duration_ms: float, status: str,
                     error_code: str = "", scope: str = "none") -> None:
    """记录一次工具调用的指标（进程内 + 可选 OTel）。

    status: "ok" | "error" | "timeout"
    scope:  "none" | "tenant" | "user"（多租户鉴权作用域，便于按租户维度聚合）
    """
    global _calls, _errors, _timeouts, _latency_ms_total
    with _lock:
        _calls += 1
        _latency_ms_total += duration_ms
        if status == "error":
            _errors += 1
        elif status == "timeout":
            _timeouts += 1
        b = _by_tool.setdefault(name, {"calls": 0, "errors": 0,
                                       "timeout": 0, "latency_ms": 0.0})
        b["calls"] += 1
        b["latency_ms"] += duration_ms
        if status == "error":
            b["errors"] += 1
        elif status == "timeout":
            b["timeout"] += 1
        _by_status[status] = _by_status.get(status, 0) + 1
        if _calls % 100 == 0 and os.environ.get("DBCHECK_MCP_TELEMETRY_SUMMARY") == "1":
            _emit_summary_locked()

    if _otel_enabled or _meter is not None:
        try:
            attrs = {"tool": name, "status": status,
                     "scope": scope}
            if _c_total is not None:
                _c_total.add(1, attrs)
            if status != "ok" and _c_error is not None:
                _c_error.add(1, {"tool": name,
                                 "error_code": error_code or "unknown",
                                 "status": status})
            if _h_duration is not None:
                _h_duration.record(max(duration_ms, 0.0), attrs)
        except Exception:
            pass


def inc_inflight(delta: int) -> None:
    """进出调用时维护在途计数（OTel UpDownCounter + 进程内）。"""
    global _inflight
    with _lock:
        _inflight = max(0, _inflight + delta)
    if _u_inflight is not None:
        try:
            _u_inflight.add(delta, {"service": "dbcheck-mcp"})
        except Exception:
            pass


def get_metrics_snapshot() -> dict:
    """返回进程内指标快照（始终可用，未来可挂到监控大屏/HTTP 端点）。"""
    with _lock:
        return {
            "service": "dbcheck-mcp",
            "otel_enabled": _otel_enabled,
            "total_calls": _calls,
            "total_errors": _errors,
            "total_timeouts": _timeouts,
            "inflight": _inflight,
            "avg_latency_ms": round(_latency_ms_total / _calls, 3) if _calls else 0.0,
            "by_status": dict(_by_status),
            "by_tool": {k: dict(v) for k, v in _by_tool.items()},
        }


def _emit_summary_locked() -> None:
    s = get_metrics_snapshot()
    _log("metrics snapshot: " + ", ".join(
        f"{k}={v}" for k, v in [
            ("calls", s["total_calls"]), ("errors", s["total_errors"]),
            ("timeouts", s["total_timeouts"]),
            ("avg_ms", s["avg_latency_ms"]), ("inflight", s["inflight"]),
            ("otel", "Y" if s["otel_enabled"] else "N")]))


def shutdown() -> None:
    """优雅关闭 OTel provider（刷新导出）。进程内计数器无需处理。"""
    global _meter, _tracer, _otel_enabled
    try:
        from opentelemetry import metrics as otel_metrics, trace as otel_trace
        prov = otel_metrics.get_meter_provider()
        if hasattr(prov, "shutdown"):
            prov.shutdown()
        tprov = otel_trace.get_tracer_provider()
        if hasattr(tprov, "shutdown"):
            tprov.shutdown()
    except Exception:
        pass
    _meter = None
    _tracer = None
    _otel_enabled = False
