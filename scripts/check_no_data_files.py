#!/usr/bin/env python
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
"""硬闸：禁止把数据库/运行态数据提交进版本库。

为什么只靠 .gitignore 不够：
  · `git add -f` 会绕过忽略规则（历史上 data/reports/oracle_awr.html 就是这样进了库）；
  · SQLite 的 -wal/-shm 会随写入不断新增文件名，逐条列举必然漏；
  · 仓库推到公开 GitHub 后，数据一旦入库就等于对外泄露，删掉提交记录也未必收回。

所以这里按「类别」判定已跟踪与暂存的文件，命中即失败，本地与 CI 都跑一次。
检查两个来源：HEAD 已提交树 + 当前暂存区，后者能在推送前挡住本次误加。

用法：
    python scripts/check_no_data_files.py            # 检查 HEAD 与暂存区
    python scripts/check_no_data_files.py --staged-only
"""

import argparse
import os
import re
import subprocess
import sys

# 确需入库的例外（例如随包分发的空模板库）。加条目必须写明理由，默认应为空。
ALLOWED_EXCEPTIONS = set()

# 按类别拦截：路径前缀
FORBIDDEN_DIRS = (
    'data/',            # 运行态总目录：库文件、报告、上传解析、缓存、备份、日志
    'awr_uploads/',
    'reports/',
    'backups/',
    'data_backups/',
    'logs/',
    'qa-temp/',
    'dist/',
    'copyright_registration/',
    # 注意：snapshot/ 不在拦截之列——README/文档用的 51 个产品图片正常入库。
    # 一次性调试截图请放 qa-temp/，不要丢进 snapshot/。
)

# 按类别拦截：文件名模式
FORBIDDEN_PATTERNS = (
    r'\.db$',
    r'\.db[-.](wal|shm|journal|bak)$',
    r'\.db\.bak-\d+.*$',
    r'\.sqlite3?$',
    r'\.sqlite[-.](wal|shm)$',
    r'^\.env$',
    r'(^|/)dbc_config\.json$',
    r'(^|/)ai_config\.json$',
    r'(^|/)notifier_config\.json$',
    r'(^|/)scheduler_jobs\.json$',
    r'(^|/)instances\.json$',
    r'(^|/)history\.json$',
    r'\.parsed\.json$',
    r'(^|/)\.web_secret$',
    r'(^|/)\.jwt_secret$',
    r'(^|/)\.db_key$',
    r'(^|/)license\.key(\.bak)?$',
    r'\.lic$',
    r'(^|/)um_rbac\.db$',
)
COMPILED = [re.compile(p) for p in FORBIDDEN_PATTERNS]


def _git(*args):
    """执行 git 并返回行列表；仓库外或命令失败时返回空。"""
    try:
        out = subprocess.run(
            ['git'] + list(args), capture_output=True, text=True, check=False)
        if out.returncode != 0:
            return []
        return [l.strip() for l in out.stdout.splitlines() if l.strip()]
    except Exception:
        return []


def _violations(paths):
    bad = []
    for p in paths:
        norm = p.replace(os.sep, '/')
        if norm in ALLOWED_EXCEPTIONS:
            continue
        if norm.startswith(FORBIDDEN_DIRS):
            bad.append((norm, '目录'))
            continue
        base = norm.rsplit('/', 1)[-1]
        for rx in COMPILED:
            if rx.search(norm) or rx.search(base):
                bad.append((norm, '文件类型'))
                break
    return bad


def main():
    ap = argparse.ArgumentParser(description='禁止数据库与运行态数据进入版本库')
    ap.add_argument('--staged-only', action='store_true', help='只检查暂存区')
    args = ap.parse_args()

    if _git('rev-parse', '--is-inside-work-tree') != ['true']:
        print('SKIP: 不在 git 工作区内')
        return 0

    problems = []

    if not args.staged_only:
        tracked = _git('ls-files')
        for path, kind in _violations(tracked):
            problems.append(('已跟踪', path, kind))

    # 暂存区只查「新增/修改/复制」，不查删除：
    # git rm --cached <数据文件> 正是本脚本要求的整改动作，不能把它也判成违规。
    staged = _git('diff', '--cached', '--name-only', '--diff-filter=ACMR')
    for path, kind in _violations(staged):
        problems.append(('本次暂存', path, kind))

    if problems:
        print('FAIL: 检测到 %d 个不得入库的数据/凭据文件' % len(problems))
        for src, path, kind in problems:
            print('  [%s] %s（%s）' % (src, path, kind))
        print()
        print('处理办法：')
        print('  暂存区误加 → git reset HEAD -- <路径>   （本地文件保留，只取消暂存）')
        print('  历史已入库 → git rm --cached <路径> 后提交，并评估是否需要清理历史/轮换凭据')
        print('  确需入库的例外 → 在本脚本 ALLOWED_EXCEPTIONS 里写明文件与理由')
        print('注意：不要用 git add -f 绕过，也不要用 git add . / git add -A。')
        return 1

    scope = '暂存区' if args.staged_only else '已跟踪文件与暂存区'
    print('OK: %s 未发现数据库/运行态数据/凭据文件' % scope)
    return 0


if __name__ == '__main__':
    sys.exit(main())
