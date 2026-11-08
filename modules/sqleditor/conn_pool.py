# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""SQL 编辑器字典查询的连接复用池。

为什么需要它：对象树 / 元数据 / 表属性这类字典查询，**建连本身比查询还贵**
（实测 oracle_jdbc 一次建连 260~1300ms，首次含 JVM 启动 3.5s；而 all_tables 这类
查询只要几十到几百毫秒）。用户展开一个库、点开一张表就是三四次建连，
界面表现就是「点一下卡一下」。

设计取舍（刻意做小）：

* 只服务**跑完就交还**的只读查询：字典查询（对象树 / 元数据 / 表属性 / schema 名单）
  与 AI 巡检助手的 ``query_rows``。编辑器里用户自己执行 SQL 的那条路
  （``/api/execute_sql``）仍**不进池** —— 它要把游标留在进程里做翻页，
  连接生命周期由游标管，混在一起只会互相踩。
* 键是「数据源 + 目标库」，TTL 到期或连接报错就丢弃重建，不做后台保活。
* 用 ``PooledDictConnection`` 把「归还」伪装成 ``close()``：
  上层 metadata / table_info 一行都不用改。
"""
import os
import threading
import time

def _knob(name, default, minimum, maximum):
    """读环境变量里的池参数；缺失、非数字或越界都退回默认值。

    宁可保守用默认，也不要因为一个写错的环境变量把池调成 0 条或几小时不过期。
    """
    raw = str(os.environ.get(name) or '').strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        print('[conn_pool] %s=%r 不是整数，用默认值 %s' % (name, raw, default), flush=True)
        return default
    if not minimum <= value <= maximum:
        print('[conn_pool] %s=%s 超出 [%s, %s]，用默认值 %s'
              % (name, value, minimum, maximum, default), flush=True)
        return default
    return value


# 池里一条连接最多能 idle 多久（超过就真正关闭）。也是「数据源改动后最多多久
# 一定换血」的上界，所以别调太大；discard_datasource 会立即清，这里是兜底。
POOL_TTL_SECONDS = _knob('DBCHECK_POOL_TTL_S', 600, 30, 3600)
# 借出前只按「多久没用过」判断这条还热不热，不做网络探活。
# 从 60s 放宽到 150s：一次建连 Oracle 实测 ~180ms、进程内首次 2.2s，而语句本身十几毫秒；
# 用户在助手页读结果、改一句 SQL 再点执行，很容易超过 60s，于是每次都被判「凉了、重连」。
# 真正会掐空闲会话的是防火墙/NAT（阈值一般在 5 分钟以上）和 profile 空闲杀（普遍 ≥15 分钟），
# 150s 仍远在它们之内；万一取到半开连接，助手执行链路会按连接类报错换新连接重试一次。
POOL_REUSE_MAX_IDLE = _knob('DBCHECK_POOL_REUSE_S', 150, 10, 600)
# 最多同时留几条（每条都是一个数据库会话，不能无限攒）。
# 8 → 16：一次批量执行会串行经过多个数据源，池太小会在跑第 9 个时把第 1 个的连接挤掉，
# 下次再点「批量」又得重连。上限仍然很小，不会把目标库的会话占满。
POOL_MAX_ENTRIES = _knob('DBCHECK_POOL_MAX', 16, 1, 64)

_lock = threading.Lock()
_pool = {}                  # key -> {'conn':…, 'until':…, 'idle_since':…}


def _evict(key):
    entry = _pool.pop(key, None)
    if entry:
        _close_quietly(entry['conn'])


def _close_quietly(conn):
    try:
        if conn is not None:
            conn.close()
    except Exception:
        pass


def _sweepExpired():
    """顺手清掉过期条目（在持锁时调用，池子很小，线性扫一遍就够）。"""
    now = time.time()
    for key in [k for k, v in _pool.items() if v['until'] < now]:
        _close_quietly(_pool.pop(key)['conn'])


def acquire(key, factory):
    """取一条可用连接；没有（或已太旧）就按 factory() 新建。返回 (conn, fromPool)。

    [WARN] 刻意**不做网络探活**（不建游标、不发 ping）：Web 主进程跑在 gevent 上，
    一次探活就是一次可能被死连接挂住的调用，会把所有页面一起拖死；而半开连接
    又不一定在探活时抛错。改为只认「空闲时长」：太久没用的直接关掉重建，
    真出错由调用方 discard 兜底。
    """
    now = time.time()
    with _lock:
        _sweepExpired()
        entry = _pool.pop(key, None)          # 借出期间不在池里，避免并发共用同一条
    conn = entry['conn'] if entry else None
    if conn is not None:
        if now - entry.get('idle_since', 0) <= POOL_REUSE_MAX_IDLE:
            return conn, True
        _close_quietly(conn)                  # 放太久了：换新的，别赌它还活着
    return factory(), False


def release(key, conn):
    """归还连接（带上过期时间）；池子满了就先淘汰最早的一条。"""
    if conn is None:
        return
    now = time.time()
    with _lock:
        _sweepExpired()
        while len(_pool) >= POOL_MAX_ENTRIES:
            oldest = min(_pool, key=lambda k: _pool[k]['until'])
            _close_quietly(_pool.pop(oldest)['conn'])
        _pool[key] = {'conn': conn, 'until': now + POOL_TTL_SECONDS, 'idle_since': now}


def discard(key):
    """连接已经出错/不确定时直接丢弃，下次调用会新建。"""
    with _lock:
        _evict(key)


def discard_datasource(instance_id):
    """数据源被改动/删除：把属于它的连接全部真正关掉，下次调用重新建连。"""
    prefix = '%s|' % str(instance_id or '')
    with _lock:
        for key in [k for k in list(_pool) if k.startswith(prefix)]:
            _evict(key)


def clear():
    """清空整个池（测试 / 数据源改动后）。"""
    with _lock:
        for key in list(_pool):
            _evict(key)


class PooledDictConnection(object):
    """把「归还到池里」伪装成 ``close()`` 的连接代理。

    上层（metadata.load_metadata / list_schemas / load_table_info / 对象树）都是
    ``try: … finally: conn.close()`` 的写法，套上这个代理就不用改一行代码：
    ``close()`` 只是把连接放回池子，真正关闭由 TTL 淘汰或 :func:`discard` 负责。
    """

    __slots__ = ('_conn', '_key')

    def __init__(self, conn, key):
        object.__setattr__(self, '_conn', conn)
        object.__setattr__(self, '_key', key)

    def close(self):
        release(self._key, object.__getattribute__(self, '_conn'))

    def discard(self):
        """出过错的连接：别还回池子，直接关掉。"""
        discard(object.__getattribute__(self, '_key'))
        _close_quietly(object.__getattribute__(self, '_conn'))

    def __getattr__(self, name):
        return getattr(object.__getattribute__(self, '_conn'), name)

    def __setattr__(self, name, value):
        setattr(object.__getattribute__(self, '_conn'), name, value)


def open_pooled(db_info, db_type, database, connector):
    """按「数据源 + 库」复用连接地拿一条字典查询连接。

    connector: 无参可调用，真正建连（返回裸连接）。失败返回 None 时按原样返回
    ``(None, None)``，由调用方给出「不支持的数据库类型」之类提示。
    """
    from modules.sqleditor.metadata import datasource_identity
    key = '%s|%s|%s' % (datasource_identity(db_info),
                        str(db_type or '').lower(), (database or '').strip().lower())
    conn, fromPool = acquire(key, connector)
    if conn is None:
        return None, None
    return PooledDictConnection(conn, key), fromPool


# ─────────────────────────────────────────────────────────────────────────────
# 连接级错误判定：「连接已坏」还是「SQL 写错」
# ─────────────────────────────────────────────────────────────────────────────
# 池子刻意不做网络探活（见 acquire 的 [WARN]），代价就是「被防火墙/NAT 悄悄掐断、
# 或被 DBA kill 掉的连接」只会在真正用它跑 SQL 时才暴露。因此调用方报错后要能分清
# 两类：连接类 → 这条别回池 + 可以换一条新连接重试一次；SQL 类 → 原样把报错给用户。
# 归属说明：错误特征表归 MIT License, Copyright (c) 2025-2026 fiyo (Jack Ge)
# 所有，并按本项目 JDBC 插件层的报错措辞补齐了条目。

_CONN_ERROR_MARKS = (
    # python-oracledb：DPY-1010 连接已不可用 / DPY-6005 建连失败 / DPI-* 客户端层异常
    'dpy-1010', 'dpy-6005', 'dpi-1080', 'dpi-1001',
    # Oracle 网络与服务端断连
    'ora-03113', 'ora-03114', 'ora-03135', 'ora-12170', 'ora-12537', 'ora-12571',
    'ora-01033', 'not connected', 'not logged on',
    # MySQL / MariaDB（不匹配裸数字 2006：会误伤诸如 ORA-02006 这类无关报错）
    'server has gone away', 'lost connection',
    # PostgreSQL
    'terminating connection', 'server closed the connection', 'ssl connection has been closed',
    # SQL Server / JDBC 插件层
    'communication link failure', 'the connection is closed', 'connection.close()',
    # 通用 socket / TCP 层
    'connection reset', 'connection aborted', 'connection refused', 'connection closed',
    'connection is closed', 'connection already closed', 'connection does not exist',
    'broken pipe', 'eof detected',
    'could not connect', 'operation timed out', 'network is unreachable', '10054', '10053',
)


def is_conn_error(error_text):
    """报错文本是否属于「连接已坏」类（而不是 SQL 本身写错）。"""
    text = str(error_text or '').lower()
    if not text:
        return False
    return any(mark in text for mark in _CONN_ERROR_MARKS)
