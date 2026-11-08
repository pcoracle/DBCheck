# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · 数据源真实版本探测与记忆。

归属说明：数据源版本探测链路的语义设计归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) 所有。版本全部**实探**，不需要任何
手工配置；AI 生成/修复 SQL 前先按真实版本写方言，避免「给 Oracle 11g 写 12c 的
FETCH FIRST」这类反复试错。

两条硬约束（来自本仓库的运行环境）：

1. **建连只走 SQL 编辑器那条统一入口** ``_open_editor_conn``：本仓库覆盖的方言更多
   （OceanBase/MariaDB/TDSQL-C/瀚高/HaloDB/DB2/ClickHouse/Redis…），且 ``*_jdbc``
   数据源必须经插件建连；按驱动类型各写一段连接代码会漏类型。
2. **绝不在对话流里同步等一次建连**：Web 进程跑 gevent 单线程 hub
   （见 ``modules/web/app.py`` 顶部说明），JDBC 类建连发生在请求线程会钉住整个界面。
   所以：
   * 提示词构建只**读缓存**，缓存缺失就交给后台线程去探；
   * 显式的「重新探测」才同步等，且带线程超时；
   * 探测结果落盘记忆，进程重启后第一次提问不必再等实探。

缓存来源标记（前端徽标与提示词都要用）：
``live`` 本次实探 / ``cache`` 内存缓存 / ``stale`` 磁盘记忆或已过期缓存 / ``unknown`` 从没探到过。
"""
import json
import os
import re
import threading
import time

_CACHE_TTL_SECONDS = 10 * 60          # 10 分钟内视为新鲜（版本是极稳定的客观事实）
_PROBE_TIMEOUT_SECONDS = 8            # 单次同步探测上限：驱动层的 connect_timeout 管不到 DNS 黑洞
_VERSION_MAX_LENGTH = 120

_memory_lock = threading.Lock()
_memory_cache = {}                     # cache_key -> (探测时间戳, 版本串)
_memory_seeded = False
_probe_inflight = set()

# 各方言家族的版本查询：按顺序尝试，命中即止。
# 同一家族里不同产品（如达梦 vs Oracle）的视图名不一样，所以用「候选列表」而不是单条 SQL。
_VERSION_SQL_BY_FAMILY = {
    'oracle': ['SELECT banner FROM v$version WHERE ROWNUM = 1',
               'SELECT version FROM v$instance'],
    'dm': ['SELECT VERSION$ FROM V$VERSION',
           'SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1'],
    'mysql': ['SELECT VERSION()'],
    'postgresql': ['SHOW server_version', 'SELECT version()'],
    'sqlserver': ['SELECT @@VERSION'],
    'clickhouse': ['SELECT version()'],
    'db2': ['SELECT SERVICE_LEVEL FROM SYSIBMADM.ENV_INST_INFO'],
    'generic': ['SELECT version()', 'SELECT @@VERSION',
                'SELECT banner FROM v$version WHERE ROWNUM = 1'],
}

# 「取版本」用的家族口径，和 dialect.family_alias（语法规则口径）刻意不同：
# 达梦/崖山的语法接近 Oracle，但读版本的视图名各不一样（V$VERSION.VERSION$ vs banner），
# 所以这里按「怎么问出版本」分类，规则那里按「怎么写 SQL」分类。
_FAMILY_BY_DB_TYPE = {
    'oracle': 'oracle', 'oracle_full': 'oracle',
    'mysql': 'mysql', 'mariadb': 'mysql', 'tidb': 'mysql', 'oceanbase': 'mysql',
    'tdsql': 'mysql', 'tdsql-c': 'mysql',
    'postgresql': 'postgresql', 'pg': 'postgresql', 'ivorysql': 'postgresql',
    'kingbase': 'postgresql', 'hgdb': 'postgresql', 'uxdb': 'postgresql',
    'vastbase': 'postgresql', 'opengauss': 'postgresql', 'gbase': 'postgresql',
    'sqlserver': 'sqlserver',
    'dm': 'dm', 'dm8': 'dm',
    'yashandb': 'yashandb',
    'clickhouse': 'clickhouse',
    'db2': 'db2',
}


def _memory_path():
    from modules.core import paths
    return os.path.join(str(paths.DATA_DIR), 'ai_ds_versions.json')


def _load_memory():
    path = _memory_path()
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _seed_memory():
    global _memory_seeded
    if _memory_seeded:
        return
    with _memory_lock:
        if _memory_seeded:
            return
        for key, item in _load_memory().items():
            timestamp, version = _read_memory_entry(item)
            if version and key not in _memory_cache:
                _memory_cache[key] = (timestamp, version)
        _memory_seeded = True


def _read_memory_entry(item):
    """读盘上的版本记忆：兼容 dict 形态与历史的 [时间戳, 版本串] 元组形态。"""
    if isinstance(item, dict):
        try:
            return float(item.get('ts') or 0), str(item.get('version') or '')
        except (TypeError, ValueError):
            return 0.0, ''
    if isinstance(item, (list, tuple)) and len(item) >= 2:
        try:
            return float(item[0] or 0), str(item[1] or '')
        except (TypeError, ValueError):
            return 0.0, str(item[1] or '')
    return 0.0, ''


def _save_memory():
    try:
        path = _memory_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with _memory_lock:
            snapshot = {key: {'ts': value[0], 'version': value[1]}
                        for key, value in _memory_cache.items()}
        tmp_path = path + '.tmp'
        with open(tmp_path, 'w', encoding='utf-8') as handle:
            json.dump(snapshot, handle, ensure_ascii=False, indent=1)
        os.replace(tmp_path, path)
    except Exception:
        pass    # 记忆只是加速手段，写盘失败不影响功能


def normalize_family(db_type):
    text = str(db_type or '').strip().lower().replace('_jdbc', '')
    if text in _FAMILY_BY_DB_TYPE:
        return _FAMILY_BY_DB_TYPE[text]
    for prefix, family in _FAMILY_BY_DB_TYPE.items():
        if text.startswith(prefix):
            return family
    return 'generic'


def version_candidates(db_type):
    family = normalize_family(db_type)
    if family == 'yashandb':
        # 崖山兼容 Oracle 写法，但没有 v$version 的 banner 列；按候选顺序逐条试
        return ['SELECT VERSION FROM V$INSTANCE', 'SELECT banner FROM v$version WHERE ROWNUM = 1']
    return list(_VERSION_SQL_BY_FAMILY.get(family) or _VERSION_SQL_BY_FAMILY['generic'])


def _clean_version_text(raw):
    first_line = str(raw or '').strip().split('\n')[0].strip()
    if len(first_line) > _VERSION_MAX_LENGTH:
        first_line = first_line[:_VERSION_MAX_LENGTH]
    return first_line


def cache_key(datasource):
    """缓存键：名称 + 类型 + 地址端口（不含密码/库名，改库名不该重探）。"""
    return '%s|%s|%s:%s' % (
        str(datasource.get('name') or datasource.get('id') or '').strip(),
        normalize_family(datasource.get('db_type')),
        datasource.get('host') or '', datasource.get('port') or '',
    )


def _read_version_with_sql(datasource, database=''):
    """经统一建连入口跑版本查询（候选按方言顺序尝试）。"""
    from modules.ai import datasource_access
    instance = datasource_access.load_decrypted(datasource)
    for sql in version_candidates(datasource.get('db_type')):
        try:
            _columns, rows, _truncated = datasource_access.query_rows(
                instance, sql, database or instance.get('database') or '', max_rows=1)
        except Exception:
            continue
        if rows and rows[0]:
            version = _clean_version_text(rows[0][0])
            if version:
                return version
    return ''


def probe(datasource, timeout=_PROBE_TIMEOUT_SECONDS):
    """同步探测一次（带线程超时）。只在显式刷新时调用，别放进对话路径。"""
    outcome = {'version': ''}

    def run_probe():
        try:
            outcome['version'] = _read_version_with_sql(datasource)
        except Exception as failure:
            outcome['error'] = str(failure)

    worker = threading.Thread(target=run_probe, daemon=True)
    worker.start()
    worker.join(timeout=timeout)
    if worker.is_alive():
        return '', '版本探测超时（>%ds），已跳过' % timeout
    return outcome.get('version', ''), outcome.get('error', '')


def refresh(datasource):
    """探测并写入内存 + 磁盘记忆；失败返回错误信息，不影响已有记忆。"""
    key = cache_key(datasource)
    version, error = probe(datasource)
    if version:
        with _memory_lock:
            _memory_cache[key] = (time.time(), version)
        _save_memory()
    return version, error


def _refresh_in_background(datasource):
    key = cache_key(datasource)
    with _memory_lock:
        if key in _probe_inflight:
            return
        _probe_inflight.add(key)

    def run_refresh():
        try:
            refresh(datasource)
        finally:
            with _memory_lock:
                _probe_inflight.discard(key)

    threading.Thread(target=run_refresh, daemon=True).start()


def get_version(datasource, force=False):
    """取数据源实际版本。

    非 ``force`` 时**绝不建连**：命中新鲜缓存直接返回，命中过期缓存先给旧值并后台刷新，
    完全没缓存则后台探测、本次返回 unknown（提示词据此走「版本未知 → 保守写法」分支）。
    """
    _seed_memory()
    key = cache_key(datasource)
    result = {'version': '', 'db_type': datasource.get('db_type') or '',
              'family': normalize_family(datasource.get('db_type')),
              'source': 'unknown', 'probed_at': 0, 'age_s': None, 'error': ''}
    if force:
        version, error = refresh(datasource)
        cached = _memory_cache.get(key)
        if version:
            result.update(version=version, source='live', probed_at=time.time(), age_s=0)
        elif cached and cached[1]:
            result.update(version=cached[1], source='stale', probed_at=cached[0],
                          age_s=int(max(0.0, time.time() - cached[0])),
                          error=error or '本次探测失败，展示最近一次成功结果')
        else:
            result['error'] = error or '版本探测失败（连接不可用或权限不足）'
        return result

    cached = _memory_cache.get(key)
    if cached and cached[1]:
        age = max(0.0, time.time() - cached[0])
        result.update(version=cached[1], probed_at=cached[0], age_s=int(age),
                      source='cache' if age < _CACHE_TTL_SECONDS else 'stale')
        if age >= _CACHE_TTL_SECONDS:
            _refresh_in_background(datasource)
        return result
    _refresh_in_background(datasource)
    return result


def version_context(datasources):
    """构建「数据源实际版本 + 方言禁区」提示词片段。

    Args:
        datasources: 已解析的数据源记录列表（含 name/db_type）；为空时由调用方决定是否兜底。
    """
    if not datasources:
        return ''
    from modules.ai import dialect
    facts = []
    for datasource in datasources:
        info = get_version(datasource)
        version = info.get('version') or ''
        if version and info.get('source') == 'stale':
            version += '（最近一次成功探测，未复核）'
        facts.append({'name': datasource.get('name') or datasource.get('id') or '',
                      'db_type': info.get('db_type') or '', 'version': version})
    lines = ['- %s（类型: %s）实际版本: %s' % (
        fact['name'], fact['db_type'] or '未知', fact['version'] or '未知（获取失败）')
        for fact in facts]
    head = '## 数据源实际版本（生成 SQL 前必须核对）\n' + '\n'.join(lines) + '\n'
    dialect_prompt = ''
    try:
        dialect_prompt = dialect.build_dialect_prompt(facts)
    except Exception:
        pass
    if dialect_prompt:
        return head + dialect_prompt + '\n'
    return (head + '你生成的任何查询语句都必须与上述实际版本兼容'
                  '（语法、内置视图/函数以对应版本为准，不要假设版本）。\n\n')


def dialect_status(datasources):
    """结构化版本状态，供前端 SQL 块/工具栏的版本徽标使用。"""
    from modules.ai import dialect
    rows = []
    for datasource in datasources:
        info = get_version(datasource)
        version = info.get('version') or ''
        family, major, minor = dialect.parse_version(version, info.get('db_type') or '')
        rows.append({
            'id': str(datasource.get('id') or ''),
            'name': datasource.get('name') or '',
            'db_type': info.get('db_type') or '',
            'host': datasource.get('host') or '',
            'port': datasource.get('port'),
            'dir_path': datasource.get('dir_path') or '未分配',
            # 版本弹窗的「📁 目录 · host:port · 库」这一行要用，前端自己拼不如后端给全
            'database': datasource.get('database') or datasource.get('service_name') or '',
            'version': version,
            'family': family or '',
            'major': major,
            'minor': minor,
            'label': dialect.format_version_label(family, major, minor),
            'confirmed': bool(version),
            'stale': info.get('source') == 'stale',
            'source': info.get('source'),
            'probed_at': info.get('probed_at') or 0,
            'age_s': info.get('age_s'),
            'error': info.get('error') or '',
        })
    return rows


def summarize_status(rows):
    total = len(rows)
    confirmed = sum(1 for row in rows if row.get('confirmed'))
    failed = total - confirmed
    return {'total': total, 'confirmed': confirmed, 'failed': failed,
            'by_family': _count_families(rows)}


def _count_families(rows):
    counts = {}
    for row in rows:
        family = row.get('family') or 'unknown'
        counts[family] = counts.get(family, 0) + 1
    return counts


def invalidate(datasource_id):
    """数据源被改/删时清掉它的版本记忆，避免继续按旧方言生成 SQL。"""
    _seed_memory()
    identifier = str(datasource_id or '')
    with _memory_lock:
        for key in [k for k in _memory_cache if identifier and identifier in k]:
            _memory_cache.pop(key, None)


def extract_version_from_error(error_text):
    """从报错文本里回捞版本线索（模型对未知版本的兜底输入）。"""
    matched = re.search(r'(\d+\.\d+(?:\.\d+){0,3})', str(error_text or ''))
    return matched.group(1) if matched else ''
