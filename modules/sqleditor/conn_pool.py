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

* 只服务**只读字典查询**。执行 SQL 的那条路（``/api/execute_sql``）不进池 ——
  它要把游标留在进程里做翻页，连接生命周期由游标管，混在一起只会互相踩。
* 键是「数据源 + 目标库」，TTL 到期或连接报错就丢弃重建，不做后台保活。
* 用 ``PooledDictConnection`` 把「归还」伪装成 ``close()``：
  上层 metadata / table_info 一行都不用改。
"""
import threading
import time

POOL_TTL_SECONDS = 300      # 空闲超过这个时间就真正关闭（和元数据缓存 300s 同档）
POOL_REUSE_MAX_IDLE = 60    # 借出前只按空闲时长判断是否还「热」，不做网络探活
POOL_MAX_ENTRIES = 8        # 最多同时留几条（每条都是一个数据库会话，不能无限攒）

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
