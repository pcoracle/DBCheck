# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""Oracle AWR 在线能力：快照列表 / 在线生成 / 进度 / 预览下载 / 最近文件 / AI 流式诊断。

版权归属：MIT License, Copyright (c) 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>。
本模块的适配点：

* 上传解析与 Word 报告仍在 ``modules/web/app.py``（已有异步任务与进度轮询）；
  这里只补它没有的在线生成链路，路由挂在独立的 ``awr_extra`` blueprint 上；
* 建连统一走 ``modules.web.app._open_editor_conn``（Oracle 厚模式回退、*_jdbc 插件路由
  都在那里处理），不再自己拼 DSN；
* 任务表用本模块自己的 dict，避免和 app 的 ``tasks`` 互相污染；
* AI 调用复用 ``modules.web.app._call_llm``（支持 stream_callback 流式）。
"""
import datetime
import glob
import os
import subprocess
import threading
import time
import traceback
import uuid

from flask import Blueprint, Response, jsonify, request, send_file

from modules.core import paths as _core_paths

awr_bp = Blueprint("awr_extra", __name__)

# AWR 在线生成 / AI 诊断任务表（key = task_id / diag_key）
tasks = {}

# AI 输出格式约束：模型默认会把 HTML/XML 标签混进 Markdown（<br>、<sql>…</sql>），
# 报告与前端面板就会出现裸标签。渲染侧已有 normalize_ai_text 兜底，这里再加一道提示，
# 从源头减少标签输出。
_AWR_AI_FORMAT_HINT = (
    "\n\n输出要求：只输出纯 Markdown（# 标题、- 列表、``` 代码块、| 表格 |），"
    "禁止使用任何 HTML/XML 标签（如 <br>、<sql>、<b>、<table>）。"
)


def _build_awr_ai_summary(awr_data, meta):
    """从 AWR 解析数据中构建 AI 诊断摘要"""
    lines = []
    lines.append(f"数据库: {meta.get('db_name', 'N/A')}, 实例: {meta.get('instance', 'N/A')}")
    lines.append(f"快照范围: {meta.get('snap_range', 'N/A')}, 分析时段: {meta.get('elapsed', 'N/A')}")
    lines.append(f"数据库版本: {meta.get('db_version', 'N/A')}")
    lines.append("")

    # 实例效率
    eff = awr_data.get('instance_efficiency', [])
    if isinstance(eff, list) and eff:
        lines.append("=== 实例效率 ===")
        for tdata in eff:
            if not isinstance(tdata, dict):
                continue
            headers = tdata.get('headers', [])
            rows = tdata.get('rows', [])
            for row in rows[:10]:
                lines.append(" | ".join(str(c) for c in row))
        lines.append("")

    # 前台等待事件
    fg = awr_data.get('fg_wait_events', [])
    if fg:
        lines.append("=== 前台等待事件 Top10 ===")
        for tdata in fg:
            if not isinstance(tdata, dict):
                continue
            headers = tdata.get('headers', [])
            rows = tdata.get('rows', [])
            if headers:
                lines.append(" | ".join(str(h) for h in headers))
                for row in rows[:10]:
                    lines.append(" | ".join(str(c) for c in row))
        lines.append("")

    # Top SQL
    top_sql = awr_data.get('top_sql', {})
    elapsed = top_sql.get('elapsed', [])
    if elapsed:
        lines.append("=== Top SQL (Elapsed Time) ===")
        for tdata in elapsed:
            if not isinstance(tdata, dict):
                continue
            headers = tdata.get('headers', [])
            rows = tdata.get('rows', [])
            if headers:
                lines.append(" | ".join(str(h) for h in headers))
                for row in rows[:5]:
                    lines.append(" | ".join(str(c) for c in row))
        lines.append("")

    # 负载概况
    lp = awr_data.get('load_profile', [])
    if isinstance(lp, list) and lp:
        lines.append("=== 负载概况 ===")
        for tdata in lp:
            if not isinstance(tdata, dict):
                continue
            headers = tdata.get('headers', [])
            rows = tdata.get('rows', [])
            if headers:
                lines.append(" | ".join(str(h) for h in headers))
                for row in rows[:5]:
                    lines.append(" | ".join(str(c) for c in row))
        lines.append("")

    # 时间模型
    tm = awr_data.get('time_model', [])
    if tm:
        lines.append("=== DB Time 模型 ===")
        for tdata in tm:
            if not isinstance(tdata, dict):
                continue
            headers = tdata.get('headers', [])
            rows = tdata.get('rows', [])
            if headers:
                lines.append(" | ".join(str(h) for h in headers))
                for row in rows[:10]:
                    lines.append(" | ".join(str(c) for c in row))
        lines.append("")

    return "\n".join(lines)


_SNAP_SQL = (
    "SELECT s.instance_number, s.dbid, s.snap_id, "
    "TO_CHAR(s.begin_interval_time, 'YYYY-MM-DD HH24:MI:SS') AS begin_time, "
    "TO_CHAR(s.end_interval_time, 'YYYY-MM-DD HH24:MI:SS') AS end_time, "
    "d.name AS db_name, d.dbid "
    "FROM dba_hist_snapshot s "
    "LEFT JOIN v$database d ON (d.dbid = s.dbid) "
    "WHERE end_interval_time > SYSDATE - {days} "
    "ORDER BY instance_number DESC, snap_id DESC"
)


def _awr_cursor(conn):
    """取一个可用的游标：统一过 adapt_cursor。

    JDBC 插件包装层的游标只支持 ``execute(sql)``，而这里的调用是
    ``execute(sql, 参数字典)``（DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML
    用 :name 绑定）。adapt_cursor 会把参数安全内联，顺便补齐 fetchmany 与预取。
    """
    from modules.sqleditor.metadata import adapt_cursor
    return adapt_cursor(conn.cursor())


_MONTHS = {'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04', 'MAY': '05', 'JUN': '06',
           'JUL': '07', 'AUG': '08', 'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'}


def _report_window_from_html(file_path):
    """从 AWR HTML 头部解析快照区间（meta 里没有时段时兜底）。

    报告头形如：``Begin Snap: 80463 25-10月-26 11:00:22``（中文月份）或
    ``Begin Snap: 80463 25-Oct-26 11:00:22``（英文月份）。
    """
    import re as _re
    try:
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as handle:
            head = handle.read(20000)
    except Exception:
        return {}
    flat = _re.sub(r'<[^>]+>', ' ', head)
    flat = _re.sub(r'[ \t\r\n]+', ' ', flat)

    def parse(label):
        match = _re.search(label + r':\s*(\d+)\s+(\d{1,2})-([0-9A-Za-z\u4e00-\u9fa5]+)-(\d{2,4})\s+(\d{2}:\d{2}:\d{2})', flat)
        if not match:
            return '', ''
        snap_id = match.group(1)
        day = int(match.group(2))
        month_raw = match.group(3).replace('\u6708', '')
        year = int(match.group(4))
        if year < 100:
            year += 2000
        if month_raw.isdigit():
            month = int(month_raw)
        else:
            month = int(_MONTHS.get(month_raw[:3].upper(), '0') or 0)
        if not month:
            return snap_id, ''
        return snap_id, '%04d-%02d-%02d %s' % (year, month, day, match.group(5)[:5])

    begin_id, begin_time = parse('Begin Snap')
    end_id, end_time = parse('End Snap')
    if not begin_time and not end_time:
        return {}
    return {'snap_range': ('%s-%s' % (begin_id, end_id)) if (begin_id and end_id) else '',
            'begin_time': begin_time, 'end_time': end_time}


def _snapshot_window(inst, start_snap, end_snap, instance_number=None):
    """快照区间对应的真实报告时段。

    AWR 报告覆盖的是「开始快照的 end_interval_time → 结束快照的 end_interval_time」，
    不是 MIN(begin)/MAX(end)（那样会多算一个采集周期，列表里的时间就对不上）。
    """
    try:
        conn = _get_oracle_conn(inst)
    except Exception:
        return {}
    try:
        cur = _awr_cursor(conn)
        low, high = sorted([int(start_snap), int(end_snap)])
        sql = ("SELECT snap_id, TO_CHAR(end_interval_time, 'YYYY-MM-DD HH24:MI') AS end_time "
               "FROM dba_hist_snapshot WHERE snap_id IN (:1, :2)")
        params = [low, high]
        if instance_number:
            sql += " AND instance_number = :3"
            params.append(int(instance_number))
        cur.execute(sql, params)
        rows = cur.fetchall() or []
        by_id = {}
        for row in rows:
            try:
                by_id[int(row[0])] = str(row[1] or '')
            except Exception:
                continue
        db_name = ''
        try:
            cur.execute("SELECT name FROM v$database")
            db_row = cur.fetchone()
            db_name = str(db_row[0] or '') if db_row else ''
        except Exception:
            db_name = ''
        cur.close()
        return {'snap_range': '%s-%s' % (low, high),
                'begin_time': by_id.get(low, ''), 'end_time': by_id.get(high, ''),
                'db_name': db_name}
    except Exception:
        return {}
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _get_oracle_conn(inst):
    """按数据源登记的方式建连（插件 / 原生统一入口），失败抛异常给接口层。"""
    from modules.web.app import _open_editor_conn
    conn, _fetch_mode = _open_editor_conn(inst, inst.get('db_type', ''), '')
    if conn is None:
        raise RuntimeError('无法连接该 Oracle 数据源')
    return conn


def _assert_datasource_visible(ds_id):
    """数据源可见性判定：与「数据源管理 / SQL 编辑器」一致，无权访问直接 403。"""
    from modules.web.app import _sql_owner_principal
    from modules.access import assert_visible
    visible, reason = assert_visible(_sql_owner_principal(), 'instance', ds_id)
    if not visible:
        return jsonify({'ok': False, **(reason or {'error': '数据源不存在或无权访问'})}), 403
    return None


@awr_bp.route('/api/awr/snapshots', methods=['GET'])
def api_awr_snapshots():
    """查询 Oracle 数据源的可用 AWR 快照（SNAP_ID/DB_ID/INSTANCE_NUMBER/time）"""
    ds_id = request.args.get('ds_id', '').strip()
    days = request.args.get('days', '7')
    try:
        days = int(days) if days and str(days).isdigit() else 7
    except Exception:
        days = 7
    if not ds_id:
        return jsonify({'ok': False, 'error': '缺少数据源 ID (ds_id)'})
    denied = _assert_datasource_visible(ds_id)
    if denied is not None:
        return denied
    try:
        from modules.pro import get_instance_manager
        mgr = get_instance_manager()
        inst = mgr.get_instance_decrypted(ds_id)
        if not inst:
            return jsonify({'ok': False, 'error': f'数据源不存在: {ds_id}'}), 404
        db_type = (inst.get('db_type', '') or '').lower()
        from modules.sqleditor.metadata import normalize_db_type as _norm
        if _norm(db_type) != 'oracle':
            return jsonify({'ok': False, 'error': '该数据源不是 Oracle 类型，无法生成 AWR 报告'})

        conn = _get_oracle_conn(inst)
        try:
            cur = _awr_cursor(conn)
            cur.execute(_SNAP_SQL.format(days=days))
            rows = cur.fetchall()
            cols = [str(c[0]).lower() for c in cur.description]
        finally:
            try:
                conn.close()
            except Exception:
                pass
        snapshots = []
        for r in rows:
            d = dict(zip(cols, r))
            snapshots.append({
                'snap_id': d.get('snap_id'),
                'db_id': d.get('dbid'),
                'instance_number': d.get('instance_number'),
                'begin_time': d.get('begin_time'),
                'end_time': d.get('end_time'),
                'db_name': d.get('db_name') or '',
            })
        return jsonify({'ok': True, 'snapshots': snapshots, 'count': len(snapshots),
                        'db_name': (snapshots[0]['db_name'] if snapshots else ''),
                        'instance': inst.get('name') or f"{inst.get('host')}:{inst.get('port')}"})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'ok': False, 'error': str(e)}), 500


@awr_bp.route('/api/awr/generate', methods=['POST'])
def api_awr_generate():
    """基于 2 个快照在线生成 AWR 报告（awrrpt.sql 逻辑），返回任务 ID 供轮询"""
    body = request.get_json(force=True, silent=True) or {}
    ds_id = str(body.get('ds_id', '')).strip()
    start_snap = body.get('start_snap')
    end_snap = body.get('end_snap')
    instance_number = body.get('instance_number')
    # 生成选项：是否生成 AWR 文件（默认 True）、是否进行 AI 分析（默认 False）
    generate_awr = bool(body.get('generate_awr', True))
    ai_analysis = bool(body.get('ai_analysis', False))
    # AI 分析依赖 AWR 文件，强制保证会生成 AWR 文件
    if ai_analysis:
        generate_awr = True
    if not ds_id or start_snap is None or end_snap is None:
        return jsonify({'ok': False, 'error': '缺少参数 (ds_id / start_snap / end_snap)'})
    try:
        start_snap = int(start_snap)
        end_snap = int(end_snap)
    except Exception:
        return jsonify({'ok': False, 'error': '快照 ID 格式错误'})
    if start_snap == end_snap:
        return jsonify({'ok': False, 'error': '开始快照与结束快照不能相同，请选择两个不同的快照'})
    denied = _assert_datasource_visible(ds_id)
    if denied is not None:
        return denied

    # 自动按数值大小重排: start_snap < end_snap
    # 前端按用户勾选顺序传入, 可能 start>end, 导致所有差值指标被 clamp 成 0
    if start_snap > end_snap:
        start_snap, end_snap = end_snap, start_snap

    task_id = str(uuid.uuid4())[:8]
    steps = _awr_generate_steps(generate_awr, ai_analysis)
    tasks[task_id] = {
        'id': task_id,
        'type': 'awr_generate',
        'status': 'running',
        'current_step': 0,
        'steps': steps,
        'started_at': datetime.datetime.now().isoformat(),
    }
    t = threading.Thread(target=_run_awr_generate_task,
                         args=(task_id, ds_id, start_snap, end_snap, instance_number,
                               generate_awr, ai_analysis), daemon=True)
    t.start()
    return jsonify({'ok': True, 'task_id': task_id, 'steps': steps})


def _awr_generate_steps(generate_awr=True, ai_analysis=False):
    """在线生成 AWR 报告的分步定义（按选项动态生成）"""
    steps = ['正在连接数据库并校验快照...']
    if generate_awr:
        steps.append('正在生成 AWR 报告...')
        steps.append('正在解析 AWR 数据...')
    if ai_analysis:
        steps.append('AI 智能诊断中...')
    steps.append('正在生成分析报告...')
    return steps


def _find_awrrpt():
    """定位 Oracle 安装目录中的 awrrpt.sql（搜索 $ORACLE_HOME/rdbms/admin）"""
    candidates = []
    oh = os.environ.get('ORACLE_HOME', '')
    # Instant Client 没有 rdbms/admin（无 awrrpt.sql），直接跳过，
    # 避免误把 ORACLE_HOME 指向 Instant Client 的环境当成完整客户端。
    if oh and os.path.isdir(os.path.join(oh, 'rdbms', 'admin')):
        candidates.append(os.path.join(oh, 'rdbms', 'admin', 'awrrpt.sql'))
    for base in [r'C:\oracle', r'C:\app\oracle', r'/u01/app/oracle', '/opt/oracle']:
        candidates.append(os.path.join(base, 'rdbms', 'admin', 'awrrpt.sql'))
        candidates.append(os.path.join(base, 'product', '19.0.0', 'dbhome_1', 'rdbms', 'admin', 'awrrpt.sql'))
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    # 回退：在常见根目录下递归查找一层
    for base in [r'C:\oracle', r'C:\app\oracle', 'C:/', r'/u01']:
        try:
            for root, _dirs, files in os.walk(base):
                if 'awrrpt.sql' in files:
                    return os.path.join(root, 'awrrpt.sql')
                # 限制深度，避免全盘扫描
                depth = root[len(base):].count(os.sep) + root[len(base):].count('/')
                if depth > 5:
                    _dirs[:] = []
        except Exception:
            continue
    return None


def _find_sqlplus():
    """定位 sqlplus 可执行文件"""
    oh = os.environ.get('ORACLE_HOME', '')
    for base in [oh] if oh else []:
        cand = os.path.join(base, 'bin', 'sqlplus.exe' if os.name == 'nt' else 'sqlplus')
        # Instant Client 没有 bin/sqlplus（bin 目录里只有 oci* 动态库），
        # 加 bin 目录存在性守卫，避免误判 ORACLE_HOME=InstantClient 的环境。
        if os.path.isdir(os.path.join(base, 'bin')) and os.path.isfile(cand):
            return cand
    if os.name == 'nt':
        for root, dirs, files in os.walk(r'C:\\'):
            if 'sqlplus.exe' in files:
                return os.path.join(root, 'sqlplus.exe')
            depth = root[3:].count(os.sep)
            if depth > 5:
                dirs[:] = []
    else:
        import shutil
        sp = shutil.which('sqlplus')
        if sp:
            return sp
    return None


def _run_sqlplus(cmdline, cwd, timeout=300):
    """执行 sqlplus 命令（subprocess 隔离，避免污染 Flask 环境）"""
    env = os.environ.copy()
    env['ORACLE_HOME'] = os.environ.get('ORACLE_HOME', '')
    # 让 Windows 子进程能加载 OCI 动态库
    if os.name == 'nt':
        oh = os.environ.get('ORACLE_HOME', '')
        if oh:
            extra = os.path.join(oh, 'bin')
            if extra not in env.get('PATH', ''):
                env['PATH'] = extra + os.pathsep + env.get('PATH', '')
    p = subprocess.Popen(
        cmdline, shell=True, cwd=cwd, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill()
        out, err = p.communicate()
    return p.returncode, (out or b'').decode('utf-8', 'ignore'), (err or b'').decode('utf-8', 'ignore')


def _run_awr_generate_task(task_id, ds_id, start_snap, end_snap, instance_number,
                           generate_awr=True, ai_analysis=False):
    """在线生成 AWR 报告的后台线程

    Args:
        generate_awr: 是否生成 AWR HTML 文件（awrrpt.sql）
        ai_analysis: 是否对 AWR 文件进行 AI 分析（依赖 AWR 文件与解析数据）
    """
    task = tasks.get(task_id)
    if not task:
        return
    steps = task['steps']
    awr_dir = str(_core_paths.AWR_UPLOADS_DIR)
    os.makedirs(awr_dir, exist_ok=True)
    gen_file = os.path.join(awr_dir, f'awr_{task_id}.html')
    ai_on = bool(ai_analysis)  # 是否执行 AI 诊断步骤
    # current_detail: 当前步骤的细节描述（给前端展示子进度）
    task['current_detail'] = ''

    try:
        # Step 1: 连接并校验快照
        task['current_step'] = 0
        task['current_detail'] = '正在获取数据源解密信息...'
        from modules.pro import get_instance_manager
        mgr = get_instance_manager()
        inst = mgr.get_instance_decrypted(ds_id)
        if not inst:
            task['status'] = 'error'
            task['error'] = f'数据源不存在: {ds_id}'
            return
        task['current_detail'] = '正在连接数据库校验快照...'
        conn = _get_oracle_conn(inst)
        try:
            cur = _awr_cursor(conn)
            q = ("SELECT snap_id, instance_number FROM dba_hist_snapshot "
                 f"WHERE snap_id IN ({int(start_snap)}, {int(end_snap)}) ORDER BY snap_id")
            cur.execute(q)
            found = cur.fetchall()
            if len(found) < 2:
                task['status'] = 'error'
                task['error'] = f'未找到指定快照（start={start_snap}, end={end_snap}），请确认快照仍在保留期内'
                return
            if instance_number is None or instance_number == '':
                instance_number = found[0][1]
            instance_number = int(instance_number)
        finally:
            conn.close()

        # 动态步骤推进（按选项生成，与 _awr_generate_steps 对齐）
        step_idx = 1

        # Step 2: 调用 awrrpt.sql 生成 HTML（可选）
        awr_data = None
        if generate_awr:
            task['current_step'] = step_idx
            step_idx += 1
            task['current_detail'] = '正在定位生成方案 (PL/SQL → SQL*Plus → 视图兜底)...'
            def _on_progress(msg):
                task['current_detail'] = str(msg)
            ok, gen_msg = _generate_awr_html(gen_file, inst, start_snap, end_snap, instance_number,
                                             progress=_on_progress)
            if not ok:
                task['status'] = 'error'
                task['error'] = gen_msg
                return
            # 保存元数据（数据源 + 快照时间段；最近列表要显示时间段）
            try:
                import json
                window = _snapshot_window(inst, start_snap, end_snap, instance_number)
                meta_payload = {'ds_id': ds_id, 'task_id': task_id,
                                'ds_name': inst.get('name') or ds_id,
                                'manual': False}
                meta_payload.update(window or {})
                meta_file = os.path.join(awr_dir, f'awr_{task_id}.meta.json')
                with open(meta_file, 'w', encoding='utf-8') as f:
                    json.dump(meta_payload, f, ensure_ascii=False)
            except Exception:
                pass
            # 解析 AWR 数据
            task['current_step'] = step_idx
            step_idx += 1
            task['current_detail'] = '正在解析 AWR HTML 数据...'
            from modules.web.awr_parser import parse_awr_report
            awr_data = parse_awr_report(gen_file)
            task['current_detail'] = '计划于第 ' + str(step_idx) + ' 步生成分析报告'

        # Step 3: AI 诊断（可选，依赖 awr_data）
        if ai_on:
            task['current_step'] = step_idx
            step_idx += 1
            task['current_detail'] = '正在调用 AI 接口进行智能诊断，预计需要几十秒...'
            if awr_data is None:
                from modules.web.awr_parser import parse_awr_report
                awr_data = parse_awr_report(gen_file)
            try:
                meta = awr_data.get('metadata', {})
                ai_summary = _build_awr_ai_summary(awr_data, meta)
                ai_prompt = (
                    "你是一位 Oracle 数据库性能优化专家。请根据以下 AWR 报告关键指标，"
                    "识别性能异常点并给出具体优化建议（按优先级排序，每条建议包含：异常现象、可能原因、具体操作）。"
                    "若指标正常请明确说明。A"
                    "W"
                    "R 报告：\n\n"
                    f"{ai_summary}\n\n请给出诊断结论与优化建议："
                    + _AWR_AI_FORMAT_HINT
                )
                ai_result = _call_llm(
                    ai_prompt,
                    '你是 Oracle 数据库性能调优专家，擅长通过 AWR 报告识别性能瓶颈与异常。')
                if ai_result and ai_result.strip():
                    awr_data['ai_diagnosis'] = ai_result.strip()
                    task['ai_diagnosis_text'] = ai_result.strip()
            except Exception:
                pass

        # Step 4: 生成 Word 报告
        task['current_step'] = len(steps) - 1
        reports_dir = str(_core_paths.REPORTS_DIR)
        os.makedirs(reports_dir, exist_ok=True)

        # 若 generate_awr=False（未生成 AWR HTML），gen_file 不存在，不能 parse，
        # 改为构造最小解析数据（仅元数据），保证 Word 报告仍可生成。
        if awr_data is None:
            if os.path.isfile(gen_file):
                from modules.web.awr_parser import parse_awr_report
                awr_data = parse_awr_report(gen_file)
            else:
                awr_data = {}
            if not awr_data.get('metadata'):
                awr_data['metadata'] = {
                    'db_name': f'ds{ds_id}',
                    'snap_range': f'{start_snap} - {end_snap}',
                }

        meta = awr_data.get('metadata', {})
        timestamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        db_name = meta.get('db_name', f'ds{ds_id}')
        report_name = f'DBCheck_AWR_Analysis_{db_name}_{start_snap}_{end_snap}_{timestamp}.docx'.replace('/', '_').replace(' ', '_')
        output_path = os.path.join(reports_dir, report_name)

        task['current_detail'] = '正在生成 Word 分析报告...'
        from modules.web.build_awr_word_report import build_awr_word_report
        result_path = build_awr_word_report(awr_data, output_path,
                                            source_filename=os.path.basename(gen_file))

        task['current_detail'] = '全部完成'
        task['status'] = 'done'
        task['report_file'] = result_path
        task['report_name'] = report_name
        # 仅在实际生成了 AWR HTML 文件时才暴露 awr_file/awr_task_id，
        # 否则前端预览/下载与"已生成 AWR 文件"列表会出现无对应文件的记录。
        if os.path.isfile(gen_file):
            task['awr_file'] = gen_file
            task['awr_task_id'] = task_id                  # AWR HTML 文件的 task_id（供预览/下载）
            task['report_task_id'] = f'awr_{task_id}'      # Word 分析报告文件的 task_id
            # 更新元数据文件，保存 report_name 和 ai_diagnosis
            try:
                import json
                meta_file = os.path.join(awr_dir, f'awr_{task_id}.meta.json')
                meta_data = {}
                if os.path.isfile(meta_file):
                    try:
                        with open(meta_file, 'r', encoding='utf-8') as mf:
                            meta_data = json.load(mf) or {}
                    except Exception:
                        meta_data = {}
                # 合并而不是覆盖：前面写入过 ds_id / 快照时间段，不能被这一步冲掉
                meta_data.update({'ds_id': ds_id, 'task_id': task_id, 'report_name': report_name})
                if awr_data and awr_data.get('ai_diagnosis'):
                    meta_data['ai_diagnosis'] = awr_data['ai_diagnosis']
                with open(meta_file, 'w', encoding='utf-8') as f:
                    json.dump(meta_data, f, ensure_ascii=False)
            except Exception:
                pass
    except Exception as e:
        traceback.print_exc()
        task['status'] = 'error'
        task['error'] = str(e)


def _generate_awr_html(gen_file, inst, start_snap, end_snap, instance_number, progress=None):
    """调用 awrrpt.sql 生成 AWR HTML。返回 (ok, message)。

    优先级：
    1. 直接调用 Oracle 服务端的 DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML（最优方案，无需完整客户端）
    2. 使用 SQL*Plus 执行 $ORACLE_HOME/rdbms/admin/awrrpt.sql（需完整客户端）
    3. 回退到直接查询 DBA_HIST_* 视图拼装结构化 HTML（兜底方案）

    失败时返回 (False, msg)，msg 包含诊断信息, 便于运维定位:
      - PL/SQL 失败: 提示需要 DBA 权限/SYSDBA 连接
      - SQL*Plus 失败: 提示缺少完整客户端(sqlplus.exe / awrrpt.sql)
      - 兜底: 提示当前为最小数据集, 建议升级方案

    progress: 可选回调 progress(msg)，用于向调用方上报当前子阶段细节（供前端展示实时动态）。
    """
    def _report(msg):
        if progress:
            try:
                progress(str(msg))
            except Exception:
                pass

    _report('尝试方案1：调用 DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML...')
    plsql_ok, plsql_msg = _gen_awr_via_plsql(gen_file, inst, start_snap, end_snap, instance_number)
    if plsql_ok:
        return plsql_ok, plsql_msg

    _report('方案1不可用或未成功：' + plsql_msg[:80] + '，尝试方案2：SQL*Plus 执行 awrrpt.sql...')
    awrrpt = _find_awrrpt()
    sqlplus = _find_sqlplus()
    if awrrpt and sqlplus:
        _report(f'找到 sqlplus={sqlplus}，正在执行 awrrpt.sql...')
        sp_ok, sp_msg = _gen_awr_via_sqlplus(gen_file, awrrpt, sqlplus, start_snap, end_snap, instance_number)
        if sp_ok:
            return sp_ok, sp_msg
        traceback.print_exc()
    else:
        # 记录方案 2 不可用的原因（用于返回给前端展示）
        _ = sp_msg = ('未找到 sqlplus/awrrpt: '
                      + ('sqlplus=' + str(sqlplus) if not sqlplus else '')
                      + (' ' if not sqlplus else '')
                      + ('awrrpt=' + str(awrrpt) if not awrrpt else ''))

    # 方案 3：回退到视图拼装（最小数据集）
    _report('方案2不可用，进入方案3：直接查询 DBA_HIST_* 视图拼装...')
    fb_ok, fb_msg = _gen_awr_via_views(gen_file, inst, start_snap, end_snap, instance_number, progress=progress)
    # 聚合诊断信息，便于运维定位
    diag_parts = []
    if '权限不足' in plsql_msg or 'ORA-00942' in plsql_msg or 'ORA-01031' in plsql_msg:
        diag_parts.append('PL/SQL 方案失败(权限不足, 建议数据源勾选 SYSDBA 或授予 DBA 角色)')
    else:
        diag_parts.append(f'PL/SQL 方案失败: {plsql_msg[:120]}')
    if awrrpt is None or sqlplus is None:
        diag_parts.append('SQL*Plus 方案不可用(缺少完整 Oracle 客户端 sqlplus.exe 或 rdbms/admin/awrrpt.sql)')
    diag_parts.append('[WARN] 当前走兜底视图方案, 数据集不完整(缺少实例效率/Time Model/ASH/Advisory 等章节), 建议用 SYSDBA 重生成')
    combined_msg = fb_msg + ' | ' + ' | '.join(diag_parts)
    return fb_ok, combined_msg


def _normalize_awr_html(html_content):
    """给 Oracle 生成的 AWR HTML 注入统一版式，避免「每张表一大一小」。

    AWR_REPORT_HTML 自带的样式按内容宽度排版，同一个报告里表格宽度参差不齐。
    这里统一成：所有表格 100% 宽度、同样的边框/内边距/字号，并允许长文本换行。
    """
    marker = 'id="awr-normalize"'
    if not html_content or marker in html_content:
        return html_content
    style = (
        '<style id="awr-normalize">'
        'body{margin:10px;font-family:"Segoe UI","Microsoft YaHei",Arial,sans-serif;'
        'font-size:12px;color:#1b1b1b;background:#fff;}'
        'h1,h2,h3{font-family:inherit;}'
        'table{width:100% !important;max-width:100%;border-collapse:collapse;'
        'margin:6px 0;table-layout:fixed;}'
        'th,td{padding:3px 6px;vertical-align:top;white-space:normal;'
        'word-break:break-word;overflow-wrap:anywhere;}'
        'pre{white-space:pre-wrap;word-break:break-word;font-size:12px;}'
        '</style>'
    )
    lowered = html_content.lower()
    position = lowered.find('</head>')
    if position >= 0:
        return html_content[:position] + style + html_content[position:]
    return style + html_content


def _gen_awr_via_plsql(gen_file, inst, start_snap, end_snap, instance_number):
    """通过 python-oracledb 直接调用 Oracle 服务端的 DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML。

    这是最优方案：
    - 无需完整 Oracle 客户端（Instant Client 即可）
    - 生成的报告与 sqlplus @awrrpt.sql 执行结果完全一致
    - 部署简单，无需额外配置

    返回 (ok, message)。
    """
    conn = None
    try:
        conn = _get_oracle_conn(inst)
        cur = _awr_cursor(conn)

        # 确定 instance_number
        if instance_number in (None, ''):
            for _sql in ("SELECT instance_number FROM v$instance WHERE ROWNUM = 1",
                         "SELECT instance_number FROM gv$database WHERE ROWNUM = 1"):
                try:
                    cur.execute(_sql)
                    r = cur.fetchone()
                    if r and r[0] is not None:
                        instance_number = int(r[0])
                        break
                except Exception:
                    continue
        if instance_number in (None, ''):
            instance_number = 1

        # 调用 DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML
        # 该函数是 pipelined table function，返回 AWR_REPORT_OUTPUT 表类型
        # 需要用 SELECT ... FROM TABLE(...) 方式调用

        # 先获取 dbid
        cur.execute("SELECT dbid FROM v$database")
        dbid_row = cur.fetchone()
        if not dbid_row:
            return False, '无法获取 DBID'
        dbid = int(dbid_row[0])

        # 使用 SELECT FROM TABLE 调用 pipelined function
        sql = """
        SELECT output FROM TABLE(
            DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML(
                l_dbid     => :dbid,
                l_inst_num => :inst_num,
                l_bid      => :bid,
                l_eid      => :eid
            )
        )
        """
        cur.execute(sql, {
            'dbid': dbid,
            'inst_num': instance_number,
            'bid': start_snap,
            'eid': end_snap
        })

        # 收集输出：AWR_REPORT_HTML 返回的是 **CLOB**。
        # [WARN] 不能走默认的 fetchall —— JDBC 插件会把 LOB 按 32KB 预览上限截断，
        # 报告会「缺一大半」。这里直接从 ResultSet 读完整 CLOB。
        html_content = ''
        raw_cursor = getattr(cur, '_cursor', cur)
        result_set = getattr(raw_cursor, 'rs', None)
        if result_set is not None:
            while result_set.next():
                clob = None
                try:
                    clob = result_set.getClob(1)
                except Exception:
                    clob = None
                if clob is not None:
                    try:
                        total = int(clob.length())
                        html_content += str(clob.getSubString(1, total))
                        continue
                    except Exception:
                        pass
                try:
                    html_content += str(result_set.getString(1) or '')
                except Exception:
                    pass
        else:
            rows = cur.fetchall()
            html_content = ''.join(row[0] if row[0] else '' for row in rows)
        if not html_content:
            return False, 'AWR_REPORT_HTML 返回空内容'

        # 统一版式后再写入（所有表格等宽对齐）
        html_content = _normalize_awr_html(html_content)
        with open(gen_file, 'w', encoding='utf-8') as f:
            f.write(html_content)

        conn.close()
        return True, 'AWR 报告已通过 DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML 生成'

    except Exception as e:
        if conn:
            try:
                conn.close()
            except Exception:
                pass
        err_msg = str(e)
        # 如果是权限问题（ORA-00942 或 ORA-01031），提示用户
        if 'ORA-00942' in err_msg or 'ORA-01031' in err_msg:
            return False, f'调用 AWR_REPORT_HTML 权限不足（需要 DBA 权限）: {err_msg}'
        return False, f'调用 AWR_REPORT_HTML 失败: {err_msg}'


def _gen_awr_via_sqlplus(gen_file, awrrpt, sqlplus, start_snap, end_snap, instance_number):
    """通过 sqlplus @awrrpt 生成 HTML（参数: 输出文件 实例号 开始快照 结束快照）"""
    awr_dir = os.path.dirname(gen_file)
    rel_out = os.path.basename(gen_file)
    # 与 awrrpt 在同一工作目录执行，输出相对路径
    os.chdir(awr_dir)
    # 先尝试相对路径 @awrrpt，再尝试绝对路径
    for target in [os.path.basename(awrrpt), awrrpt]:
        cmdline = (f'"sqlplus" -s / as sysdba @{target} "{rel_out}" {int(instance_number)} '
                   f'{int(start_snap)} {int(end_snap)}')
        # 部分环境需要 ORACLE_SID/连接串，这里依赖 sqlplus 的默认登录/环境变量
        rc, out, err = _run_sqlplus(cmdline, cwd=awr_dir)
        if os.path.isfile(gen_file) and os.path.getsize(gen_file) > 2000:
            return True, 'AWR 报告已通过 awrrpt.sql 生成'
        last = (out + err)
    # 未生成有效文件，返回失败信息
    tail = last[-500:] if last else ''
    return False, f'awrrpt.sql 执行失败: {tail or "无输出"}'


def _h2(parts, text):
    parts.append(f'<h2>{text}</h2>')


def _h3(parts, text):
    """章节标题用 <h3>（解析器仅识别 h3/p 标题作为数据字段，h2 仅用于分组主章节）。"""
    parts.append(f'<h3>{text}</h3>')


def _emit_kv_table(parts, rows):
    """rows: list[(label, value)] -> 两列表格（Stat Name / Value）"""
    parts.append('<table border="1" cellpadding="4" cellspacing="0">')
    parts.append('<tr><th style="background:#e8e8e8">Stat Name</th><th style="background:#e8e8e8">Value</th></tr>')
    for label, value in rows:
        parts.append(f'<tr><td>{label}</td><td>{value}</td></tr>')
    parts.append('</table>')


def _gen_awr_via_views(gen_file, inst, start_snap, end_snap, instance_number, progress=None):
    """回退方案：连接数据库直接查询 DBA_HIST_* 视图，拼装等价结构化 HTML 供 awr_parser 解析。

    输出为 awr_parser 可识别的经典 AWR 结构：
      - 章节标题带解析器关键词（"Load Profile" / "Top 5 Timed Foreground Events"
        / "SQL ordered by Elapsed Time" 等）
      - 标准 <table> 表格（th 表头 + td 数据）
      - 头部元数据块（DB Name / RAC / Release / Snap# / Elapsed 等）供元数据提取
    所有查询均带 snap_id IN (start,end) 过滤并按 instance_number 过滤，
    避免跨全部实例 / 全保留期扫描导致的超时（Instant Client 无 sqlplus/awrrpt 时走此分支）。

    progress: 可选回调 progress(msg)，在查询各章节前上报细节，供前端展示实时动态。
    """
    def _report(msg):
        if progress:
            try:
                progress(str(msg))
            except Exception:
                pass

    try:
        conn = _get_oracle_conn(inst)
    except Exception as e:
        return False, f'回退生成失败（无法连接数据库）: {e}'

    try:
        cur = _awr_cursor(conn)
        # 元数据（gv$database：name；版本从 v$version 取）。
        # 注意 Oracle 11g：gv$database 无 version/instance_number 列（ORA-00904），
        # 所有元数据查询各自 try/except，任一失败都不中断整个回退生成。
        db_name = ''
        db_version = ''
        try:
            cur.execute("SELECT name FROM gv$database WHERE ROWNUM = 1")
            r = cur.fetchone()
            if r and r[0]:
                db_name = str(r[0])
        except Exception:
            pass
        try:
            cur.execute("SELECT banner FROM v$version WHERE ROWNUM = 1")
            r = cur.fetchone()
            if r and r[0]:
                db_version = ' '.join(str(r[0]).split()[:6])
        except Exception:
            pass
        if instance_number in (None, ''):
            # gv$database 在部分 11g 版本无 instance_number 列（ORA-00904），
            # 优先用 v$instance（标准视图，必含 instance_number）取值，失败再回退 gv$database。
            for _sql in ("SELECT instance_number FROM v$instance WHERE ROWNUM = 1",
                         "SELECT instance_number FROM gv$database WHERE ROWNUM = 1"):
                try:
                    cur.execute(_sql)
                    r = cur.fetchone()
                    if r and r[0] is not None:
                        instance_number = r[0]
                        break
                except Exception:
                    continue
        try:
            instance_number = int(instance_number)
        except Exception:
            instance_number = None

        # 探测各 DBA_HIST_* 视图是否具备 instance_number 列（不同 Oracle 版本/集群形态
        # 列定义不一致：dba_hist_sys_time_model 通常无 instance_number 列，
        # 盲目拼接过滤会导致 ORA-00904）。用空结果集 SQL 探测，开销极小。
        def _view_has_col(view, col):
            try:
                cur.execute(f"SELECT {col} FROM {view} WHERE 1 = 0")
                return True
            except Exception:
                return False

        has_sys_tm_inst = _view_has_col('dba_hist_sys_time_model', 'instance_number')

        # dba_hist_system_event / dba_hist_sqlstat 列差异兼容：
        #   - 11g 的 dba_hist_system_event 无 _fg 前台等待列（TOTAL_WAITS_FG/TIME_WAITED_MICRO_FG 为 12c+）
        #   - dba_hist_sqlstat 无 EXECUTIONS 列，统一用 EXECUTIONS_DELTA（11g/12c 均存在）
        has_fg_cols = _view_has_col('dba_hist_system_event', 'total_waits_fg')
        has_sql_text_col = _view_has_col('dba_hist_sqlstat', 'sql_text')
        has_exec_delta = _view_has_col('dba_hist_sqlstat', 'executions_delta')
        # 其余视图（system_event / sqlstat / snapshot）在标准 AWR 中均含 instance_number 列，
        # 直接沿用 inst_filter；若个别版本缺失，对应查询的 try/except 会兜底，不影响整体。

        # 快照时间（用于头部 Elapsed / 时间区间展示）
        snap_times = []
        try:
            cur.execute(
                "SELECT TO_CHAR(begin_interval_time, 'YYYY-MM-DD HH24:MI:SS') AS bt, "
                "TO_CHAR(end_interval_time, 'YYYY-MM-DD HH24:MI:SS') AS et "
                "FROM dba_hist_snapshot WHERE snap_id IN (:1, :2) ORDER BY snap_id",
                (start_snap, end_snap))
            snap_times = cur.fetchall()
        except Exception:
            pass

        parts = []
        parts.append('<html><head><meta charset="utf-8">'
                     f'<title>AWR Report for {db_name or "Oracle"} (snap {start_snap} - {end_snap})</title></head><body>')
        parts.append(f'<h1>AWR Report for {db_name or "Oracle"} (snap {start_snap} - {end_snap})</h1>')
        parts.append(f'<p>AWR Report generated by DBCheck (views fallback) - Snapshots {start_snap} to {end_snap}.'
                     + (f' Instance {instance_number}.' if instance_number is not None else '') + '</p>')

        # ── 头部元数据表格（必须出现在第一个 h2 之前，解析器据此提取 metadata）──
        # DB Name 表
        parts.append('<table border="1" cellpadding="4" cellspacing="0">')
        parts.append('<tr><th style="background:#e8e8e8">DB Name</th><th style="background:#e8e8e8">Unique Name</th>'
                     '<th style="background:#e8e8e8">Role</th><th style="background:#e8e8e8">Edition</th>'
                     '<th style="background:#e8e8e8">Release</th><th style="background:#e8e8e8">RAC</th>'
                     '<th style="background:#e8e8e8">CDB</th></tr>')
        parts.append(f'<tr><td>{db_name or "N/A"}</td><td>{db_name or "N/A"}</td><td>PRI</td>'
                     f'<td>Enterprise</td><td>{db_version or "N/A"}</td><td>NO</td><td>NO</td></tr>')
        parts.append('</table>')
        # Instance 表
        parts.append('<table border="1" cellpadding="4" cellspacing="0">')
        parts.append('<tr><th style="background:#e8e8e8">Instance</th><th style="background:#e8e8e8">Inst Num</th>'
                     '<th style="background:#e8e8e8">Startup Time</th></tr>')
        parts.append(f'<tr><td>{db_name or "N/A"}</td><td>{instance_number if instance_number is not None else 1}</td>'
                     '<td>07-Sep-26</td></tr>')
        parts.append('</table>')
        # Snap 区间表（Begin/End Snap 数字 + Elapsed，供解析器提取 snap_range/elapsed）
        _snap_begin_time = (snap_times[0][0] if snap_times else '?')
        _snap_end_time = (snap_times[-1][0] if snap_times else '?')
        _elapsed_str = (f'{_snap_begin_time} - {_snap_end_time}' if len(snap_times) >= 2 else 'N/A')
        parts.append('<table border="1" cellpadding="4" cellspacing="0">')
        parts.append('<tr><th style="background:#e8e8e8">Begin Snap</th><th style="background:#e8e8e8">End Snap</th>'
                     '<th style="background:#e8e8e8">Elapsed</th></tr>')
        parts.append(f'<tr><td>{start_snap}</td><td>{end_snap}</td><td>{_elapsed_str}</td></tr>')
        parts.append('</table>')

        inst_filter = f" AND instance_number = {int(instance_number)}" if instance_number is not None else ""

        # ── Load Profile（DB Time / DB Cpu Time / Elapsed Time / System Wide Waits）──
        _report('正在查询 Load Profile（DB Time / DB CPU / 系统等待）...')
        parts.append('<h2>Report Summary</h2>')
        _h3(parts, 'Load Profile')
        db_time = db_cpu = 0.0
        sys_waits = 0.0
        # DB Time / DB CPU Time（时间模型：11g 用 value 列）
        # 注意：dba_hist_sys_time_model 通常无 instance_number 列，
        # 仅在探测到该列存在时才拼接 instance_number 过滤，避免 ORA-00904。
        try:
            _sys_tm_filter = inst_filter if has_sys_tm_inst else ""
            cur.execute(
                "SELECT snap_id, SUM(CASE WHEN stat_name='DB time' THEN value END) AS db_time, "
                "SUM(CASE WHEN stat_name='DB CPU time' THEN value END) AS db_cpu "
                "FROM dba_hist_sys_time_model "
                f"WHERE snap_id IN (:1, :2){_sys_tm_filter} GROUP BY snap_id",
                (start_snap, end_snap))
            tp = {r[0]: r for r in cur.fetchall()}
            s, e = tp.get(start_snap, (start_snap, 0, 0)), tp.get(end_snap, (end_snap, 0, 0))
            db_time = max(0.0, (e[1] or 0) - (s[1] or 0))
            db_cpu = max(0.0, (e[2] or 0) - (s[2] or 0))
        except Exception as ex:
            # 兜底：任何意外（列缺失/权限等）都不中断整体回退生成
            db_time = db_cpu = 0.0
        # System Wide Waits（dba_hist_system_event：11g 无 p1 列，用 TOTAL_WAITS 汇总）
        try:
            cur.execute(
                "SELECT snap_id, SUM(total_waits) AS sw FROM dba_hist_system_event "
                f"WHERE snap_id IN (:1, :2){inst_filter} GROUP BY snap_id",
                (start_snap, end_snap))
            sp = {r[0]: r for r in cur.fetchall()}
            sys_waits = max(0.0, (sp.get(end_snap, (end_snap, 0))[1] or 0) - (sp.get(start_snap, (start_snap, 0))[1] or 0))
        except Exception:
            pass
        _emit_kv_table(parts, [
            ('DB Time(s)', round(db_time / 1e6, 3) if db_time else 0),
            ('DB Cpu Time(s)', round(db_cpu / 1e6, 3) if db_cpu else 0),
            ('Elapsed', _elapsed_str),
            ('System Wide Waits', int(sys_waits) if sys_waits else 0),
        ])
        # 扩展负载概况：从 dba_hist_sysstat 取常用累计计数（snap 差值 = 区间净增量）
        _sys_names = ['logons cumulative', 'user calls', 'parse count (total)',
                      'parse count (hard)', 'execute count', 'user commits',
                      'session logical reads', 'physical reads', 'physical writes',
                      'sorts (memory)', 'sorts (disk)', 'user transactions']
        _sysstats = {}
        try:
            names_bind = tuple(_sys_names)
            in_markers = ','.join(':' + str(i) for i in range(3, 3 + len(names_bind)))
            _sf = f" AND instance_number = {int(instance_number)}" if instance_number is not None else ""
            cur.execute(
                "SELECT stat_name, "
                " SUM(CASE WHEN snap_id=:1 THEN value END) AS sval, "
                " SUM(CASE WHEN snap_id=:2 THEN value END) AS eval "
                "FROM dba_hist_sysstat "
                "WHERE stat_name IN (" + in_markers + ")" + _sf + " GROUP BY stat_name",
                (start_snap, end_snap) + names_bind)
            for r in cur.fetchall():
                # 仅保留区间净增量 >= 0 的项, 避免回卷/缺快照导致的负数
                _sysstats[r[0]] = max(0, (r[2] or 0) - (r[1] or 0))
        except Exception:
            _sysstats = {}
        if _sysstats:
            _emit_kv_table(parts, [
                ('Logons (期间的累积登录数)', int(_sysstats.get('logons cumulative', 0))),
                ('User Calls(期间的调用次数)', int(_sysstats.get('user calls', 0))),
                ('Parse Total / Hard(析构总次数/硬解析)', f"{int(_sysstats.get('parse count (total)', 0))} / {int(_sysstats.get('parse count (hard)', 0))}"),
                ('Execute Count(执行次数)', int(_sysstats.get('execute count', 0))),
                ('User Commits(提交次数)', int(_sysstats.get('user commits', 0))),
                ('Logical Reads(逻辑读)', int(_sysstats.get('session logical reads', 0))),
                ('Physical Reads / Writes(物理读/写)', f"{int(_sysstats.get('physical reads', 0))} / {int(_sysstats.get('physical writes', 0))}"),
                ('Sorts Memory / Disk(内存/磁盘排序)', f"{int(_sysstats.get('sorts (memory)', 0))} / {int(_sysstats.get('sorts (disk)', 0))}"),
                ('User Transactions(事务数)', int(_sysstats.get('user transactions', 0))),
            ])

        # ── Top 5 Timed Foreground Events ──
        _report('正在统计 Top 5 Timed Foreground Events...')
        _h3(parts, 'Top 5 Timed Foreground Events')
        try:
            # 两快照差值法，列兼容：
            #   - 12c+ dba_hist_system_event 提供 TOTAL_WAITS_FG / TIME_WAITED_MICRO_FG
            #   - 11g 无 _fg 列, 回退 TOTAL_WAITS / TIME_WAITED_MICRO
            # 实例号与快照全部用命名绑定(:inst/:st/:en), 避免占位符错位导致 ORA-01008。
            if has_fg_cols:
                w_cnt_col, w_tm_col = 'total_waits_fg', 'time_waited_micro_fg'
            else:
                w_cnt_col, w_tm_col = 'total_waits', 'time_waited_micro'
            inst_cond = 'AND x.instance_number = :inst ' if instance_number is not None else ''
            sql = (
                "SELECT event, waits, time_s, avgms FROM ("
                " SELECT t.event, (t.end_w - t.start_w) AS waits, "
                "        (t.end_t - t.start_t)/1e6 AS time_s, "
                "        CASE WHEN (t.end_w - t.start_w) = 0 THEN 0 "
                "             ELSE 1000.0 * (t.end_t - t.start_t)/1e6/(t.end_w - t.start_w) END AS avgms, "
                "        RANK() OVER (ORDER BY (t.end_t - t.start_t) DESC) AS rk FROM ("
                "  SELECT x.event_name AS event, "
                "    SUM(CASE WHEN x.snap_id=:st THEN x." + w_cnt_col + " END) AS start_w, "
                "    SUM(CASE WHEN x.snap_id=:en THEN x." + w_cnt_col + " END) AS end_w, "
                "    SUM(CASE WHEN x.snap_id=:st THEN x." + w_tm_col + " END) AS start_t, "
                "    SUM(CASE WHEN x.snap_id=:en THEN x." + w_tm_col + " END) AS end_t "
                "  FROM dba_hist_system_event x "
                "  WHERE x.snap_id IN (:st,:en) " + inst_cond +
                "  GROUP BY x.event_name) t"
                ") WHERE rk <= 5 AND time_s > 0 ORDER BY time_s DESC"
            )
            params = {'st': start_snap, 'en': end_snap}
            if instance_number is not None:
                params['inst'] = int(instance_number)
            cur.execute(sql, params)
            parts.append('<table border="1" cellpadding="4" cellspacing="0">')
            parts.append('<tr><th style="background:#e8e8e8">Event</th><th style="background:#e8e8e8">Waits</th>'
                         '<th style="background:#e8e8e8">Time(s)</th><th style="background:#e8e8e8">Avg wait(ms)</th>'
                         '<th style="background:#e8e8e8">%</th></tr>')
            for ev, w, ts, avgms in cur.fetchall():
                parts.append(f'<tr><td>{ev}</td><td>{w or 0}</td><td>{ts or 0}</td>'
                             f'<td>{round(avgms or 0, 3)}</td><td></td></tr>')
            parts.append('</table>')
        except Exception as ex:
            parts.append(f'<p>（Top 5 Timed Foreground Events 查询失败: {ex}）</p>')

        # ── SQL ordered by Elapsed Time（Top 10）──
        _report('正在统计 Top SQL（按 Elapsed Time 排序）...')
        _h3(parts, 'SQL ordered by Elapsed Time')
        try:
            # dba_hist_sqlstat：11g/12c 统一用 EXECUTIONS_DELTA（无 EXECUTIONS 列 → ORA-00904）；
            # SQL 文本取 v$sql；若该版本无 sql_text 列则取 NULL。
            sql_text_expr = 'v.sql_text' if has_sql_text_col else 'NULL'
            exec_col = 's.executions_delta' if has_exec_delta else '0'
            inst_cond = 'AND s.instance_number = :inst ' if instance_number is not None else ''
            sql = (
                "SELECT sql_id, sql_text, executions, elapsed_s, cpu_s FROM ("
                " SELECT x.sql_id AS sql_id, x.sql_text AS sql_text, x.executions AS executions, "
                "        x.elapsed_s AS elapsed_s, x.cpu_s AS cpu_s, "
                "        RANK() OVER (ORDER BY x.elapsed_s DESC) AS rk FROM ("
                "  SELECT s.sql_id, " + sql_text_expr + " AS sql_text, "
                "         " + exec_col + " AS executions, "
                "         s.elapsed_time_delta/1e6 AS elapsed_s, s.cpu_time_delta/1e6 AS cpu_s "
                "  FROM dba_hist_sqlstat s "
                "  LEFT JOIN (SELECT /*+ RULE */ sql_id, MAX(sql_text) AS sql_text FROM v$sql "
                "             WHERE ROWNUM <= 50000 GROUP BY sql_id) v ON v.sql_id = s.sql_id "
                "  WHERE s.snap_id IN (:st,:en) " + inst_cond +
                "  AND ROWNUM <= 500"
                ") x) WHERE rk <= 10 ORDER BY elapsed_s DESC"
            )
            params = {'st': start_snap, 'en': end_snap}
            if instance_number is not None:
                params['inst'] = int(instance_number)
            cur.execute(sql, params)
            parts.append('<table border="1" cellpadding="4" cellspacing="0">')
            parts.append('<tr><th style="background:#e8e8e8">Elapsed Time(s)</th><th style="background:#e8e8e8">CPU Time(s)</th>'
                         '<th style="background:#e8e8e8">Execs</th><th style="background:#e8e8e8">SQL Id</th>'
                         '<th style="background:#e8e8e8">SQL Text</th></tr>')
            for sql_id, sql_text, executions, elapsed_s, cpu_s in cur.fetchall():
                txt = (sql_text or '').replace('<', '&lt;').replace('>', '&gt;')
                parts.append(f'<tr><td>{round(elapsed_s or 0, 3)}</td><td>{round(cpu_s or 0, 3)}</td>'
                             f'<td>{executions or 0}</td><td>{sql_id or ""}</td><td>{txt[:200]}</td></tr>')
            parts.append('</table>')
        except Exception as ex:
            parts.append(f'<p>（SQL ordered by Elapsed Time 查询失败: {ex}）</p>')

        parts.append('</body></html>')
    finally:
        try:
            conn.close()
        except Exception:
            pass
    html = ''.join(parts)
    with open(gen_file, 'w', encoding='utf-8') as f:
        f.write(html)
    if not os.path.isfile(gen_file) or os.path.getsize(gen_file) < 100:
        return False, '回退生成的 AWR 报告为空'
    return True, 'AWR 报告已通过数据库视图生成（回退方案）'


def _emit_top_rows(parts, cur, limit):
    """取前 limit 行渲染成简单 HTML 表格"""
    cols = [str(c[0]).lower() for c in cur.description] if cur.description else []
    rows = cur.fetchmany(limit) if cur.description else []
    if not cols and not rows:
        parts.append('<p>（无数据）</p>')
        return
    parts.append('<table border="1" cellpadding="4">')
    if cols:
        parts.append('<tr>' + ''.join(f'<th>{c}</th>' for c in cols) + '</tr>')
    for r in rows:
        parts.append('<tr>' + ''.join(f'<td>{"" if v is None else v}</td>' for v in r) + '</tr>')
    parts.append('</table>')


def _emit_table_rows(parts, cur):
    """把当前游标结果渲染成一个简单 HTML 表格"""
    cols = [str(c[0]).lower() for c in cur.description] if cur.description else []
    rows = cur.fetchall()
    if not cols and not rows:
        parts.append('<p>（无数据）</p>')
        return
    parts.append('<table border="1" cellpadding="4">')
    if cols:
        parts.append('<tr>' + ''.join(f'<th>{c}</th>' for c in cols) + '</tr>')
    for r in rows[:20]:
        parts.append('<tr>' + ''.join(f'<td>{"" if v is None else v}</td>' for v in r) + '</tr>')
    parts.append('</table>')


@awr_bp.route('/api/awr/generate_status/<task_id>', methods=['GET'])
def api_awr_generate_status(task_id):
    """查询在线生成 AWR 报告的进度"""
    task = tasks.get(task_id)
    if not task:
        return jsonify({'ok': False, 'error': '任务不存在'}), 404
    return jsonify({
        'ok': True,
        'status': task.get('status', 'running'),
        'current_step': task.get('current_step', 0),
        'steps': task.get('steps', []),
        'current_detail': task.get('current_detail', ''),
        'report_file': task.get('report_file'),
        'report_name': task.get('report_name'),
        'awr_file': task.get('awr_file'),
        'awr_task_id': task.get('awr_task_id'),
        'report_task_id': task.get('report_task_id'),
        'ai_diagnosis': bool(task.get('ai_diagnosis')),
        'error': task.get('error'),
    })


@awr_bp.route('/api/awr/preview/<task_id>', methods=['GET'])
def api_awr_preview(task_id):
    """在线生成的 AWR HTML 报告预览（浏览器直接查看）"""
    awr_dir = str(_core_paths.AWR_UPLOADS_DIR)
    fp = os.path.join(awr_dir, f'awr_{task_id}.html')
    if not os.path.isfile(fp):
        return 'AWR 文件不存在或已过期', 404
    with open(fp, 'r', encoding='utf-8', errors='ignore') as f:
        return Response(f.read(), mimetype='text/html')


@awr_bp.route('/api/awr/download/<task_id>', methods=['GET'])
def api_awr_download(task_id):
    """在线生成的 AWR HTML 报告下载"""
    awr_dir = str(_core_paths.AWR_UPLOADS_DIR)
    fp = os.path.join(awr_dir, f'awr_{task_id}.html')
    if not os.path.isfile(fp):
        return 'AWR 文件不存在或已过期', 404
    return send_file(fp, as_attachment=True, download_name=f'awr_{task_id}.html')


@awr_bp.route('/api/awr/ai_diagnosis/<task_id>', methods=['GET'])
def api_awr_ai_diagnosis(task_id):
    """在线生成 AWR 的 AI 诊断（异步流式）。

    首次调用：解析 AWR -> 后台线程流式调用 LLM，线程内把已生成的文本实时写入
    tasks[diag_key]['partial']，接口立即返回 status=streaming 与 diag_key；
    后续前端以 diag_key 轮询 /api/awr/ai_diag_status/<diag_key> 获取实时内容。

    兼容旧逻辑：若任务已缓存完整结论，直接返回 status=done。
    """
    task = tasks.get(task_id)
    diag = None
    if task and task.get('type') == 'awr_generate':
        # AI 诊断在 Word 生成线程内已写入 awr_data，这里从任务缓存读取
        diag = task.get('ai_diagnosis_text')
    # 已存在完整结论：直接返回
    if diag and diag.strip():
        return jsonify({'ok': True, 'status': 'done', 'diagnosis': diag})

    # 否则启动（或复用）异步流式诊断任务
    awr_dir = str(_core_paths.AWR_UPLOADS_DIR)
    fp = os.path.join(awr_dir, f'awr_{task_id}.html')
    if not os.path.isfile(fp):
        return jsonify({'ok': False, 'error': 'AWR 文件不存在或已过期'})

    diag_key = f'ai_diag_{task_id}'
    existing = tasks.get(diag_key)
    if existing and existing.get('status') == 'running':
        # 已有诊断在跑，复用，不重复启动
        return jsonify({'ok': True, 'status': 'streaming', 'diag_key': diag_key})

    tasks[diag_key] = {
        'id': diag_key,
        'type': 'ai_diag',
        'status': 'running',
        'partial': '',
        'elapsed': 0,
        'started_at': datetime.datetime.now().isoformat(),
        'detail': '正在解析 AWR 数据...',
    }
    t = threading.Thread(target=_run_ai_diag_task, args=(diag_key, fp), daemon=True)
    t.start()
    return jsonify({'ok': True, 'status': 'streaming', 'diag_key': diag_key})


def _run_ai_diag_task(diag_key, fp):
    """后台线程：解析 AWR -> 流式调用 LLM，实时更新 tasks[diag_key]['partial']。"""
    task = tasks.get(diag_key)
    if not task:
        return
    from modules.web.app import _call_llm
    try:
        task['detail'] = '正在解析 AWR 报告数据...'
        from modules.web.awr_parser import parse_awr_report
        awr_data = parse_awr_report(fp)
        meta = awr_data.get('metadata', {})
        task['detail'] = '正在提取关键指标并构造 Prompt...'
        ai_summary = _build_awr_ai_summary(awr_data, meta)
        ai_prompt = (
            "你是一位 Oracle 数据库性能优化专家。请根据以下 AWR 报告关键指标，识别性能异常点并给出具体优化建议"
            "（按优先级排序，每条建议包含：异常现象、可能原因、具体操作）：\n\n"
            f"{ai_summary}\n\n请给出诊断结论与优化建议："
            + _AWR_AI_FORMAT_HINT
        )
        task['detail'] = '正在调用 AI 生成诊断结论（流式输出中）...'

        start = time.time()

        def _on_chunk(chunk):
            task['partial'] = (task.get('partial') or '') + chunk
            task['elapsed'] = int(time.time() - start)

        diag = _call_llm(
            ai_prompt,
            '你是 Oracle 数据库性能调优专家，擅长通过 AWR 报告识别性能瓶颈与异常。',
            stream_callback=_on_chunk)

        task['partial'] = diag or ''
        task['detail'] = '诊断完成'
        task['elapsed'] = int(time.time() - start)
        task['status'] = 'done'
    except Exception as e:
        task['partial'] = f'AI 诊断失败: {e}'
        task['detail'] = '诊断失败'
        task['status'] = 'error'


@awr_bp.route('/api/awr/ai_diag_status/<diag_key>', methods=['GET'])
def api_awr_ai_diag_status(diag_key):
    """查询异步 AI 诊断进度与实时输出内容。"""
    task = tasks.get(diag_key)
    if not task:
        return jsonify({'ok': False, 'error': '诊断任务不存在'})
    return jsonify({
        'ok': True,
        'status': task.get('status', 'running'),
        'detail': task.get('detail', ''),
        'partial': task.get('partial', ''),
        'elapsed': task.get('elapsed', 0),
    })


@awr_bp.route('/api/awr/recent', methods=['GET'])
def api_awr_recent():
    """列出最近生成的 AWR 文件（按修改时间倒序，最多 20 份）"""
    import json
    awr_dir = str(_core_paths.AWR_UPLOADS_DIR)
    reports_dir = str(_core_paths.REPORTS_DIR)
    if not os.path.isdir(awr_dir):
        return jsonify({'ok': True, 'files': [], 'count': 0})
    files = []
    for fn in os.listdir(awr_dir):
        if not fn.startswith('awr_') or not fn.endswith(('.html', '.htm')):
            continue
        fp = os.path.join(awr_dir, fn)
        if not os.path.isfile(fp):
            continue
        task_id = fn[4:-len(os.path.splitext(fn)[1])]
        file_info = {
            'task_id': task_id,
            'name': fn,
            'modified': datetime.datetime.fromtimestamp(os.path.getmtime(fp)).strftime('%Y-%m-%d %H:%M:%S'),
            'size': os.path.getsize(fp),
        }
        # 读取元数据（ds_id, report_name, ai_diagnosis）
        meta_file = os.path.join(awr_dir, f'awr_{task_id}.meta.json')
        if os.path.isfile(meta_file):
            try:
                with open(meta_file, 'r', encoding='utf-8') as f:
                    meta = json.load(f)
                    file_info['ds_id'] = meta.get('ds_id')
                    file_info['report_name'] = meta.get('report_name')
                    file_info['ai_diagnosis'] = meta.get('ai_diagnosis')
                    file_info['manual'] = bool(meta.get('manual'))
                    file_info['snap_range'] = meta.get('snap_range') or ''
                    file_info['begin_time'] = meta.get('begin_time') or ''
                    file_info['end_time'] = meta.get('end_time') or ''
                    file_info['db_name'] = meta.get('db_name') or ''
                    file_info['ds_name'] = meta.get('ds_name') or ''
            except Exception:
                pass
        # meta 里没有时段（旧报告 / 人工上传）：从报告头解析，保证列表时间准确
        if not file_info.get('begin_time') and not file_info.get('end_time'):
            window = _report_window_from_html(fp)
            if window:
                file_info.update(window)
        files.append(file_info)
    files.sort(key=lambda x: x['modified'], reverse=True)
    files = files[:20]
    return jsonify({'ok': True, 'files': files, 'count': len(files)})


@awr_bp.route('/api/awr/delete', methods=['POST'])
def api_awr_delete():
    """删除报告文件（支持批量）。body: {"task_ids": ["abc123", ...]}"""
    body = request.get_json(silent=True) or {}
    raw_ids = body.get('task_ids') or body.get('ids') or []
    if isinstance(raw_ids, str):
        raw_ids = [raw_ids]
    import re as _re
    valid_ids = []
    for raw in raw_ids:
        task_id = str(raw or '').strip()
        if _re.match(r'^[0-9a-fA-F]{4,32}$', task_id):
            valid_ids.append(task_id)
    if not valid_ids:
        return jsonify({'ok': False, 'error': '没有合法的任务 ID'}), 400
    awr_dir = str(_core_paths.AWR_UPLOADS_DIR)
    removed = []
    for task_id in valid_ids:
        for suffix in ('.html', '.htm', '.meta.json'):
            path = os.path.join(awr_dir, 'awr_%s%s' % (task_id, suffix))
            try:
                if os.path.isfile(path):
                    os.remove(path)
                    removed.append(os.path.basename(path))
            except Exception:
                continue
        # 任务表里清掉对应记录（存在才清）
        tasks.pop(task_id, None)
        tasks.pop('ai_diag_%s' % task_id, None)
    return jsonify({'ok': True, 'deleted': len(valid_ids), 'files': removed})
