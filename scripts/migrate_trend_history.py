#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""把旧系统（dbcheck）的 history.db 迁入目标 data/history.db。

背景：任务书 B3「历史趋势分析」要求旧历史数据迁入后，实例/指标/异常生命周期/
溯源均可查。旧库结构与目标基本一致（旧库是超集，多出 rag_* / stat_* 表，不用迁），
真正需要处理的是四件事：

1. **库结构差异**：目标 snapshots 少 `report_file/template_id/engine` 三列
   —— 由 `SQLiteHistoryManager` 建表时幂等补齐。
2. **db_type 方言不一致**：旧库存 `oracle_full`，目标 Web 入口存 `oracle`；
   同一物理库（如 10.1.245.12:1521）会同时存在 `oracle` 与 `oracle_full`
   两个实例。脚本按「数据库家族」归并 family，再重算 `_db_key`，避免同一库
   出现两条断开的曲线。
3. **报告文件**：旧库 `report_file` 记录的是旧 reports/ 下的裸文件名，需要
   复制到目标报告目录并保留该字段（目标报告名规则不同，不能靠文件名猜）。
4. **留存条数**：目标每实例保留最近 90 条，脚本插入后按 90 裁剪。

脚本幂等：重复执行时按 (instance_key, ts) 跳过已存在的快照；先备份目标库。

用法::

    python scripts/migrate_trend_history.py \
        --src D:\\codes\\DBCheck-main\\dbcheck\\data\\history.db \
        --src-reports D:\\codes\\DBCheck-main\\dbcheck\\reports

    # 只统计不落库
    python scripts/migrate_trend_history.py --src ... --dry-run
"""

from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from modules.inspection.db_history import _db_key, SQLiteHistoryManager  # noqa: E402

#: 数据库家族：同一物理库的不同采集引擎归并成一个 key，避免曲线断点
_FAMILY = {
    'oracle': 'oracle', 'oracle_full': 'oracle', 'oracle_jdbc': 'oracle',
    'sqlserver': 'sqlserver', 'sqlserver_jdbc': 'sqlserver',
    'postgres': 'postgresql', 'postgresql': 'postgresql', 'pg': 'postgresql',
    'dm': 'dm', 'dm8': 'dm',
}

#: 每实例保留的快照条数（与 SQLiteHistoryManager.save_snapshot 一致）
KEEP_PER_INSTANCE = 90


def family(db_type: str) -> str:
    dt = (db_type or '').strip().lower()
    if dt.endswith('_jdbc'):
        dt = dt[:-len('_jdbc')]
    return _FAMILY.get(dt, dt)


def report_dst_dir() -> Path:
    try:
        from modules.core.paths import REPORTS_DIR
        return Path(REPORTS_DIR)
    except Exception:
        return ROOT / 'data' / 'reports'


def read_legacy(src: Path):
    """读旧库：返回 (instances, snapshots)，均为 dict 列表。"""
    conn = sqlite3.connect('file:%s?mode=ro' % src.as_posix(), uri=True)
    conn.row_factory = sqlite3.Row
    try:
        insts = [dict(r) for r in conn.execute('SELECT * FROM history_instances')]
        snaps = [dict(r) for r in conn.execute('SELECT * FROM snapshots ORDER BY ts')]
    finally:
        conn.close()
    return insts, snaps


def plan(insts, snaps):
    """把旧实例按家族键归并，返回 {new_key: {meta, snapshots}}（按 ts 排序）。"""
    by_key = {}
    old_to_new = {}
    for inst in insts:
        fam = family(inst.get('db_type'))
        new_key = _db_key(fam, inst.get('host') or '', inst.get('port') or '')
        old_to_new[inst.get('key')] = new_key
        slot = by_key.setdefault(new_key, {
            'key': new_key, 'db_type': fam,
            'host': inst.get('host') or '', 'port': str(inst.get('port') or ''),
            'label': '', 'created_at': inst.get('created_at') or '',
            'updated_at': inst.get('updated_at') or '', 'snapshots': [],
        })
        # 标签取「最晚更新」的实例名，空标签不覆盖已有标签
        if inst.get('label') and (not slot['label'] or (inst.get('updated_at') or '') >= slot['updated_at']):
            slot['label'] = inst['label']
            slot['updated_at'] = inst.get('updated_at') or slot['updated_at']
        if inst.get('created_at') and (not slot['created_at'] or inst['created_at'] < slot['created_at']):
            slot['created_at'] = inst['created_at']

    seen = set()
    for snap in snaps:
        new_key = old_to_new.get(snap.get('instance_key'))
        if not new_key:
            continue
        dedupe = (new_key, snap.get('ts'))
        if dedupe in seen:
            continue
        seen.add(dedupe)
        by_key[new_key]['snapshots'].append(snap)
    for slot in by_key.values():
        slot['snapshots'].sort(key=lambda s: s.get('ts') or '')
    return by_key


def apply(by_key, src_reports: Path, dst_reports: Path, dry_run=False):
    """写入目标库与报告目录，返回统计结果。"""
    dst_db = ROOT / 'data' / 'history.db'
    stats = {'instances': 0, 'snapshots': 0, 'skipped': 0, 'reports': 0,
             'reports_missing': 0, 'trimmed': 0}
    if not dry_run:
        if dst_db.exists():
            bak = dst_db.with_name('history.db.bak-%s' % datetime.now().strftime('%Y%m%d-%H%M%S'))
            shutil.copy2(dst_db, bak)
            print('[备份] %s' % bak)
        SQLiteHistoryManager(str(ROOT))  # 建表 / 补 3 列
        dst_reports.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(dst_db))
        conn.row_factory = sqlite3.Row
        cols = [r[1] for r in conn.execute('PRAGMA table_info(snapshots)')]
    else:
        conn = None
        cols = []

    try:
        for slot in by_key.values():
            stats['instances'] += 1
            snaps = slot['snapshots']
            if not dry_run:
                conn.execute(
                    'INSERT OR IGNORE INTO history_instances '
                    '(key,db_type,host,port,label,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
                    (slot['key'], slot['db_type'], slot['host'], slot['port'], slot['label'],
                     slot['created_at'] or slot['updated_at'], slot['updated_at'])
                )
                if slot['label']:
                    conn.execute(
                        "UPDATE history_instances SET label=? "
                        "WHERE key=? AND (label='' OR label IS NULL)",
                        (slot['label'], slot['key'])
                    )
                have = {r[0] for r in conn.execute(
                    'SELECT ts FROM snapshots WHERE instance_key=?', (slot['key'],))}
            else:
                have = set()

            for snap in snaps:
                if snap.get('ts') in have:
                    stats['skipped'] += 1
                    continue
                report_file = snap.get('report_file') or ''
                # 报告：只在文件真实存在时记录字段并复制，避免留下死链
                if report_file:
                    src_file = src_reports / report_file
                    if src_file.is_file():
                        stats['reports'] += 1
                        if not dry_run:
                            dst_file = dst_reports / report_file
                            if not dst_file.exists():
                                shutil.copy2(src_file, dst_file)
                    else:
                        report_file = ''
                        stats['reports_missing'] += 1
                if not dry_run:
                    payload = dict(snap, instance_key=slot['key'], report_file=report_file)
                    use = [c for c in cols if c != 'id' and c in payload]
                    conn.execute(
                        'INSERT INTO snapshots (%s) VALUES (%s)'
                        % (','.join(use), ','.join('?' * len(use))),
                        [payload[c] for c in use]
                    )
                stats['snapshots'] += 1

            if not dry_run:
                # 同实例内 ts 去重（保留最小 id），再按留存上限裁剪最旧的
                conn.execute(
                    'DELETE FROM snapshots WHERE instance_key=? AND id NOT IN '
                    '(SELECT MIN(id) FROM snapshots WHERE instance_key=? GROUP BY ts)',
                    (slot['key'], slot['key'])
                )
                keep = conn.execute(
                    'SELECT id FROM snapshots WHERE instance_key=? ORDER BY ts DESC LIMIT ?',
                    (slot['key'], KEEP_PER_INSTANCE)
                ).fetchall()
                keep_ids = [r[0] for r in keep]
                if keep_ids:
                    before = conn.execute('SELECT COUNT(*) FROM snapshots WHERE instance_key=?',
                                          (slot['key'],)).fetchone()[0]
                    conn.execute(
                        'DELETE FROM snapshots WHERE instance_key=? AND id NOT IN (%s)'
                        % ','.join('?' * len(keep_ids)),
                        [slot['key']] + keep_ids
                    )
                    stats['trimmed'] += max(0, before - len(keep_ids))
        if not dry_run:
            conn.commit()
    finally:
        if conn is not None:
            conn.close()
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='迁移旧系统 history.db 到目标（幂等）')
    ap.add_argument('--src', required=True, help='旧 history.db 路径')
    ap.add_argument('--src-reports', default='', help='旧 reports 目录（含 docx）')
    ap.add_argument('--dry-run', action='store_true', help='只统计，不写库/不复制文件')
    args = ap.parse_args(argv)

    src = Path(args.src)
    if not src.is_file():
        print('源库不存在: %s' % src)
        return 1
    src_reports = Path(args.src_reports) if args.src_reports else src.parent.parent / 'reports'

    insts, snaps = read_legacy(src)
    by_key = plan(insts, snaps)
    print('旧库：实例 %d 个 / 快照 %d 条 → 归并后实例 %d 个'
          % (len(insts), len(snaps), len(by_key)))

    stats = apply(by_key, src_reports, report_dst_dir(), dry_run=args.dry_run)
    print('实例 %d · 快照 %d 条 · 跳过已存在 %d · 复制报告 %d · 报告缺失 %d · 裁掉超限 %d'
          % (stats['instances'], stats['snapshots'], stats['skipped'],
             stats['reports'], stats['reports_missing'], stats['trimmed']))
    if args.dry_run:
        print('（dry-run：未写入）')
        return 0

    # 结果校验：按实例打印入库条数与时间范围
    conn = sqlite3.connect(str(ROOT / 'data' / 'history.db'))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            'SELECT i.key, i.db_type, i.host, i.port, i.label, COUNT(s.id) n, '
            '       MIN(s.ts) t0, MAX(s.ts) t1 '
            'FROM history_instances i LEFT JOIN snapshots s ON s.instance_key=i.key '
            'GROUP BY i.key ORDER BY n DESC'
        ).fetchall()
    finally:
        conn.close()
    print('\n目标库现状：')
    for r in rows:
        print('  %-14s %-22s %-16s %-26s %3d 条  %s → %s'
              % (r['db_type'], r['host'] + ':' + str(r['port']), r['label'] or '-',
                 r['key'], r['n'], r['t0'] or '-', r['t1'] or '-'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
