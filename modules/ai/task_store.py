# -*- coding:utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""AI 巡检助手 · 任务历史存储（SQLite）。

一次「AI 任务」= 用户一条消息触发的完整流程：理解意图 → 工具调用（可多轮）→ 最终分析。
这里把它结构化落库，供全屏助手左侧的「历史任务」回溯：

* 任务级：用户原话、状态、数据源、总耗时、最终分析
* 步骤级：每次工具调用的 name / arguments / result / status / duration_ms（JSON 数组）

归属说明：任务/会话/消息这套字段语义归 MIT License,
Copyright (c) 2025-2026 fiyo (Jack Ge) 所有。项目内没有共享的 sqlite 连接
工厂，所以在这里用一把进程级写锁 + 每次短连接（WAL、busy_timeout）自洽实现。
"""
import json
import os
import sqlite3
import threading
import time
import uuid
from datetime import datetime

from modules.core.paths import DATA_DIR

_DB_PATH = str(DATA_DIR / 'ai_tasks.db')
_write_lock = threading.RLock()
_init_done = False

_SCHEMA = """
CREATE TABLE IF NOT EXISTS ai_task_history (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    user_message TEXT,
    title TEXT,
    understanding TEXT,
    thinking_content TEXT,
    datasource TEXT,
    db_type TEXT,
    status TEXT,
    tool_steps TEXT,
    final_analysis TEXT,
    round_count INTEGER DEFAULT 0,
    elapsed_ms INTEGER DEFAULT 0,
    created_at TEXT,
    finished_at TEXT
);
CREATE TABLE IF NOT EXISTS ai_chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    datasource TEXT,
    created_at TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS ai_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    role TEXT,
    content TEXT,
    summary TEXT,
    task_id TEXT,
    created_at TEXT
);
"""

# 索引单独建：老库上「建索引」和「补列」在同一脚本里会先撞上还不存在的列。
_INDEXES = (
    'CREATE INDEX IF NOT EXISTS idx_ai_task_created ON ai_task_history(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_ai_task_session ON ai_task_history(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_ai_task_datasource ON ai_task_history(datasource)',
    'CREATE INDEX IF NOT EXISTS idx_ai_chat_msg_session ON ai_chat_messages(session_id, id)',
)

# 已上线的老库缺这几列：增量 ALTER（幂等），不靠「重新建表」，历史数据不丢。
_EXTRA_COLUMNS = {
    'ai_task_history': {
        'session_id': 'TEXT', 'title': 'TEXT', 'thinking_content': 'TEXT',
        'round_count': 'INTEGER DEFAULT 0',
    },
    'ai_chat_messages': {'summary': 'TEXT', 'meta': 'TEXT'},
    # 会话可以挂多个数据源（批量执行选中的那一组）。只存单个 datasource 的话，
    # 重新登录后多源会话会退化成单源，批量执行的目标就丢了。
    'ai_chat_sessions': {'datasources': 'TEXT'},
}


def _ensure_columns(conn):
    """老库增量补列（幂等）：老库缺列不能靠「重建表」，历史数据必须留下。"""
    for table, columns in _EXTRA_COLUMNS.items():
        present = {row[1] for row in conn.execute('PRAGMA table_info(%s)' % table)}
        for column, declaration in columns.items():
            if column not in present:
                conn.execute('ALTER TABLE %s ADD COLUMN %s %s' % (table, column, declaration))


# 任务终态：只有这些状态才算「跑完了」，可以盖 finished_at。
_TERMINAL_TASK_STATUS = ('done', 'error', 'stopped', 'failed', 'cancelled')


def _now():
    return datetime.now().isoformat(timespec='seconds')


# 角色取值空间：前端助手页用 'ai'，任务流/提示词用 'assistant'，两边都合法。
# 统一成 'assistant' 落库；识别不了的取值原样保留（截断到 20 字符），
# 绝不再「不在白名单里就当成 user」——那会把 AI 回复写成用户发言，
# 重启后从服务端读回来就变成「助手回复全不见了」。
_ROLE_ALIASES = {
    'user': 'user', 'human': 'user', 'me': 'user',
    'ai': 'assistant', 'assistant': 'assistant', 'bot': 'assistant',
    'model': 'assistant', 'dba': 'assistant',
    'system': 'system',
}


def canonical_role(value, default='user'):
    """把各种写法归一到 user / assistant / system；认不出的原样保留，不做降级。"""
    text = str(value or '').strip().lower()
    if not text:
        return default
    return _ROLE_ALIASES.get(text, text[:20])


# 一次性纠正：早期版本的角色白名单把 AI 回复写成了 'user'。
# 判据只用 AI 消息独有的东西：meta 里的富字段（思考过程 / 工具轨迹 / 理解文本 / 修复覆盖层），
# 或者助手侧模板才会写出的正文开头（conversation.py 的「**理解你的需求**」）；
# 真正的用户提问不会命中，所以不会误伤。语句幂等（改过的行不再命中）。
_ROLE_REPAIR_SQL = (
    "UPDATE ai_chat_messages SET role = 'assistant' "
    "WHERE role = 'user' AND ("
    "meta LIKE '%toolChainHtml%' OR meta LIKE '%thinkingContent%' "
    "OR meta LIKE '%understandingContent%' OR meta LIKE '%sqlOverrides%' "
    "OR content LIKE '**理解你的需求%' OR content LIKE '%理解你的需求**%' "
    ")"
)


def _repair_roles(conn):
    """把被误标成 user 的 AI 回复纠正回 assistant（幂等，只在命中时改）。"""
    try:
        cursor = conn.execute(_ROLE_REPAIR_SQL)
        if cursor.rowcount:
            print('[ai_store] 纠正被误标的 AI 回复 %d 条（role user → assistant）' % cursor.rowcount,
                  flush=True)
    except sqlite3.Error as failure:      # 纠正失败不能拖垮建库
        print('[ai_store] 角色纠正跳过: %s' % failure, flush=True)


def _reconcile_orphan_tasks(conn):
    """给上一个进程留下的「执行中」任务收尾（进程启动时跑一次）。

    服务重启会带走正在跑的那条流，库里的行却停在 running：任务历史页一直显示「执行中」，
    看着像助手出了活却没交付。启动这一刻的 running 行都属于已经退场的进程，统一标 stopped；
    本进程之后新建的任务不受影响（``init_db`` 每进程只跑一次）。
    """
    try:
        cursor = conn.execute("UPDATE ai_task_history SET status = 'stopped', finished_at = ? "
                              "WHERE status = 'running'", (_now(),))
        if cursor.rowcount:
            print('[ai_store] 收尾上个进程遗留的执行中任务 %d 条' % cursor.rowcount, flush=True)
    except sqlite3.Error as failure:      # 收尾失败不能拖垮建库
        print('[ai_store] 遗留任务收尾跳过: %s' % failure, flush=True)


def _connect():
    os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)
    conn = sqlite3.connect(_DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=5000')
    return conn


def init_db():
    """建表 → 增量补列 → 建索引。这个顺序不能调：老库缺列时「建索引」会先报错。"""
    global _init_done
    if _init_done:
        return
    with _write_lock:
        conn = _connect()
        try:
            conn.executescript(_SCHEMA)
            _ensure_columns(conn)
            for statement in _INDEXES:
                conn.execute(statement)
            _repair_roles(conn)
            _reconcile_orphan_tasks(conn)
            conn.commit()
        finally:
            conn.close()
    _init_done = True


def create_task(user_message, datasource='', db_type='', session_id=''):
    """新建一条任务，返回 task_id。"""
    init_db()
    task_id = 'ait_' + uuid.uuid4().hex[:16]
    with _write_lock:
        conn = _connect()
        try:
            conn.execute(
                'INSERT INTO ai_task_history (id, session_id, user_message, datasource, db_type, '
                'status, tool_steps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (task_id, session_id or '', user_message, datasource, db_type,
                 'running', '[]', _now()))
            conn.commit()
        finally:
            conn.close()
    return task_id


def append_step(task_id, tool_name, arguments=None, result=None, status='done',
                elapsed_ms=0, round_count=1, source=''):
    """追加一次工具调用（读-改-写，整段在写锁内完成）。

    ``round_count`` 区分「首轮工具计划」与「分析阶段 &lt;query&gt; 追加取数」，
    ``source='manual'`` 标出用户在结果区手工执行的那次，历史时间线能分清三种来源。
    """
    init_db()
    step = {
        'tool': tool_name,
        'arguments': arguments,
        'result': result,
        'status': status,
        'elapsed_ms': int(elapsed_ms or 0),
        'round': int(round_count or 1),
        'at': _now(),
    }
    if source:
        step['source'] = source
    with _write_lock:
        conn = _connect()
        try:
            row = conn.execute('SELECT tool_steps FROM ai_task_history WHERE id = ?',
                               (task_id,)).fetchone()
            if not row:
                return
            try:
                steps = json.loads(row['tool_steps'] or '[]')
            except Exception:
                steps = []
            steps.append(_json_safe(step))
            conn.execute('UPDATE ai_task_history SET tool_steps = ? WHERE id = ?',
                         (json.dumps(steps, ensure_ascii=False, default=str), task_id))
            conn.commit()
        finally:
            conn.close()


def _json_safe(value):
    """把不可 JSON 序列化的对象（datetime/Decimal/bytes/Java 包装类）转成可存形态。"""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (bytes, bytearray)):
        return value.decode('utf-8', errors='replace')
    return str(value)


def append_thinking(task_id, extra, separator='\n\n—— 分析与取数阶段 ——\n'):
    """追加一段思考内容（意图阶段与分析阶段分开产出，历史页要看到完整链路）。"""
    if not extra:
        return
    current = ''
    try:
        row = get_task(task_id)
        current = (row or {}).get('thinking_content') or ''
    except Exception:
        current = ''
    update_thinking(task_id, (current + separator + str(extra)) if current else str(extra))


def update_understanding(task_id, understanding):
    update_task(task_id, understanding=understanding)


def update_thinking(task_id, thinking_content):
    """保存深度思考内容（截断到 8000 字，避免整段推理把库撑大）。"""
    init_db()
    text = str(thinking_content or '')[:8000]
    with _write_lock:
        conn = _connect()
        try:
            conn.execute('UPDATE ai_task_history SET thinking_content = ? WHERE id = ?',
                         (text, task_id))
            conn.commit()
        finally:
            conn.close()


def update_datasource(task_id, datasource, db_type=''):
    fields = {'datasource': datasource}
    if db_type:
        fields['db_type'] = db_type
    update_task(task_id, **fields)


def update_task(task_id, **fields):
    """更新任务级字段（understanding / final_analysis / datasource / db_type…）。"""
    allowed = {'understanding', 'final_analysis', 'thinking_content', 'datasource',
               'db_type', 'status', 'elapsed_ms', 'round_count', 'title', 'session_id'}
    updates = {key: value for key, value in (fields or {}).items() if key in allowed}
    if not updates:
        return
    init_db()
    with _write_lock:
        conn = _connect()
        try:
            assignments = ', '.join('%s = ?' % key for key in updates)
            conn.execute('UPDATE ai_task_history SET %s WHERE id = ?' % assignments,
                         list(updates.values()) + [task_id])
            conn.commit()
        finally:
            conn.close()


def finish_task(task_id, status='done', final_analysis='', elapsed_ms=0, round_count=None):
    if not elapsed_ms:
        # 调用方一律传 0 的话，历史页的耗时列就全是「—」：这里用 finished-created 自己算，
        # 一次改对所有落库点生效（工具链的逐步耗时不受影响）。
        elapsed_ms = _elapsed_since_created(task_id)
    fields = {'status': status, 'final_analysis': final_analysis, 'elapsed_ms': elapsed_ms}
    if round_count is not None:
        fields['round_count'] = int(round_count or 0)
    update_task(task_id, **fields)
    if str(status or '').lower() not in _TERMINAL_TASK_STATUS:
        # 「等用户确认」这类中间态这一轮虽然停了，但任务没结束：
        # 盖上 finished_at 就会留下「有结束时间却还挂着 running」的行，
        # 历史页永远显示运行中，也没法判断它到底停在哪一步。
        return
    with _write_lock:
        conn = _connect()
        try:
            conn.execute('UPDATE ai_task_history SET finished_at = ? WHERE id = ?',
                         (_now(), task_id))
            conn.commit()
        finally:
            conn.close()


def _elapsed_since_created(task_id):
    """created_at → 现在的毫秒数；解析失败返回 0（不抛，落库路径不能被时间格式带崩）。"""
    try:
        conn = _connect()
        try:
            row = conn.execute('SELECT created_at FROM ai_task_history WHERE id = ?',
                               (task_id,)).fetchone()
        finally:
            conn.close()
        if not row or not row[0]:
            return 0
        started = datetime.fromisoformat(str(row[0]))
        return max(0, int((datetime.now() - started).total_seconds() * 1000))
    except Exception:
        return 0


def _row_to_dict(row):
    data = dict(row)
    try:
        data['tool_steps'] = json.loads(data.get('tool_steps') or '[]')
    except Exception:
        data['tool_steps'] = []
    return data


def get_task(task_id):
    init_db()
    conn = _connect()
    try:
        row = conn.execute('SELECT * FROM ai_task_history WHERE id = ?', (task_id,)).fetchone()
        return _row_to_dict(row) if row else None
    finally:
        conn.close()


def list_tasks(limit=50, offset=0, datasource='', status='', keyword=''):
    init_db()
    clauses, params = [], []
    if datasource:
        clauses.append('datasource = ?')
        params.append(datasource)
    if status:
        clauses.append('status = ?')
        params.append(status)
    if keyword:
        clauses.append('(user_message LIKE ? OR understanding LIKE ? '
                       'OR final_analysis LIKE ? OR title LIKE ?)')
        params.extend(['%' + keyword + '%'] * 4)
    where = (' WHERE ' + ' AND '.join(clauses)) if clauses else ''
    conn = _connect()
    try:
        total = conn.execute('SELECT COUNT(*) AS n FROM ai_task_history' + where,
                             params).fetchone()['n']
        rows = conn.execute('SELECT * FROM ai_task_history' + where +
                            ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
                            params + [int(limit), int(offset)]).fetchall()
        items = [_row_to_dict(row) for row in rows]
        for item in items:      # 列表页不需要整段步骤与思考，压掉体积
            item['step_count'] = len(item.get('tool_steps') or [])
            item['tool_steps'] = []
            item['thinking_content'] = (item.get('thinking_content') or '')[:200]
        return {'tasks': items, 'items': items, 'total': total}
    finally:
        conn.close()


def find_task_id_by_session(session_id):
    """给「刷新后继续这段对话」用：按会话找回最近一条任务。"""
    if not session_id:
        return None
    init_db()
    conn = _connect()
    try:
        row = conn.execute('SELECT id FROM ai_task_history WHERE session_id = ? '
                           'ORDER BY created_at DESC LIMIT 1', (session_id,)).fetchone()
        return row['id'] if row else None
    finally:
        conn.close()


def delete_task(task_id):
    init_db()
    with _write_lock:
        conn = _connect()
        try:
            cursor = conn.execute('DELETE FROM ai_task_history WHERE id = ?', (task_id,))
            conn.commit()
            return cursor.rowcount > 0
        finally:
            conn.close()


def rename_task(task_id, title):
    """历史列表支持自定义标题（``title`` 列）；没设过标题时列表用用户原话兜底。"""
    if not task_id or not title:
        return False
    init_db()
    with _write_lock:
        conn = _connect()
        try:
            cursor = conn.execute('UPDATE ai_task_history SET title = ? WHERE id = ?',
                                  (str(title)[:200], task_id))
            conn.commit()
            return cursor.rowcount > 0
        finally:
            conn.close()


def get_stats():
    """概览：总数 / 今日 / 成功失败运行中 / 按数据源 Top10 / 按工具 Top10。"""
    init_db()
    conn = _connect()
    try:
        total = conn.execute('SELECT COUNT(*) AS n FROM ai_task_history').fetchone()['n']
        today = conn.execute("SELECT COUNT(*) AS n FROM ai_task_history "
                             "WHERE created_at LIKE ?",
                             (datetime.now().strftime('%Y-%m-%d') + '%',)).fetchone()['n']
        status_rows = conn.execute(
            'SELECT status, COUNT(*) AS n FROM ai_task_history GROUP BY status').fetchall()
        datasource_rows = conn.execute(
            "SELECT datasource, COUNT(*) AS n FROM ai_task_history "
            "WHERE datasource <> '' GROUP BY datasource ORDER BY n DESC LIMIT 10").fetchall()
        step_rows = conn.execute('SELECT tool_steps FROM ai_task_history').fetchall()
    finally:
        conn.close()
    by_status = {(row['status'] or 'unknown'): row['n'] for row in status_rows}
    by_datasource = {row['datasource']: row['n'] for row in datasource_rows}
    by_tool = {}
    for row in step_rows:
        try:
            steps = json.loads(row['tool_steps'] or '[]')
        except Exception:
            continue
        for step in steps:
            name = (step or {}).get('tool') or 'unknown'
            by_tool[name] = by_tool.get(name, 0) + 1
    top_tools = dict(sorted(by_tool.items(), key=lambda item: item[1], reverse=True)[:10])
    return {'total': total, 'today': today,
            'success': by_status.get('done', 0), 'error': by_status.get('error', 0),
            'running': by_status.get('running', 0),
            # 用户点「停止」的任务也是结束态；不单独计的话大屏只说「还在跑」，
            # 看起来永远有一堆未完成任务。
            'stopped': by_status.get('stopped', 0),
            'by_status': by_status, 'by_datasource': by_datasource, 'by_tool': top_tools}


# ── 会话与消息（全屏助手的左栏 + 对话流）─────────────────────────
def _dump_datasources(datasource, datasources):
    """会话的数据源集合 → 落库 JSON；只给单个时也要写成数组形状，读回口径统一。"""
    listed = []
    for name in (datasources or []):
        text = str(name or '').strip()
        if text and text not in listed:
            listed.append(text)
    if not listed and str(datasource or '').strip():
        listed = [str(datasource).strip()]
    return json.dumps(listed, ensure_ascii=False)


def _session_view(row):
    """会话行 → 交给前端的形状：``datasources`` 解成数组，历史数据回落到单数据源。"""
    item = dict(row)
    raw = item.get('datasources') or ''
    listed = []
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                listed = [str(x) for x in parsed if str(x or '').strip()]
        except (TypeError, ValueError):
            listed = [part.strip() for part in str(raw).split(',') if part.strip()]
    if not listed and str(item.get('datasource') or '').strip():
        listed = [str(item['datasource']).strip()]
    item['datasources'] = listed
    return item


def create_session(title='', datasource='', datasources=None):
    init_db()
    session_id = uuid.uuid4().hex[:12]
    now = _now()
    with _write_lock:
        conn = _connect()
        try:
            conn.execute('INSERT INTO ai_chat_sessions (id, title, datasource, datasources, created_at, updated_at) '
                         'VALUES (?, ?, ?, ?, ?, ?)',
                         (session_id, title or '新对话', datasource or '',
                          _dump_datasources(datasource, datasources), now, now))
            conn.commit()
        finally:
            conn.close()
    return session_id


def ensure_session(session_id, title=''):
    """保证会话行存在（幂等）：调用方带着自己的 session_id 来问，服务端补记录。

    会话 id 由调用方给出，服务端只负责补记录。若查不到就报「会话不存在」，
    外部脚本、以及任何自己生成 id 的客户端会一问就失败，看起来像助手坏了。
    """
    if not session_id:
        return ''
    init_db()
    now = _now()
    with _write_lock:
        conn = _connect()
        try:
            conn.execute('INSERT OR IGNORE INTO ai_chat_sessions '
                         '(id, title, datasource, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
                         (session_id, title or '新对话', '', now, now))
            conn.commit()
        finally:
            conn.close()
    return session_id


def list_sessions(limit=50):
    init_db()
    conn = _connect()
    try:
        rows = conn.execute(
            'SELECT s.*, (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.session_id = s.id) AS message_count '
            'FROM ai_chat_sessions s ORDER BY s.updated_at DESC LIMIT ?',
            (int(limit),)).fetchall()
        return [_session_view(row) for row in rows]
    finally:
        conn.close()


def get_session(session_id):
    init_db()
    conn = _connect()
    try:
        row = conn.execute('SELECT * FROM ai_chat_sessions WHERE id = ?', (session_id,)).fetchone()
        return _session_view(row) if row else None
    finally:
        conn.close()


def touch_session(session_id, title=''):
    """更新会话时间；标题为空时不覆盖。"""
    with _write_lock:
        conn = _connect()
        try:
            if title:
                conn.execute('UPDATE ai_chat_sessions SET title = ?, updated_at = ? WHERE id = ?',
                             (title, _now(), session_id))
            else:
                conn.execute('UPDATE ai_chat_sessions SET updated_at = ? WHERE id = ?',
                             (_now(), session_id))
            conn.commit()
        finally:
            conn.close()


def delete_session(session_id):
    init_db()
    with _write_lock:
        conn = _connect()
        try:
            conn.execute('DELETE FROM ai_chat_messages WHERE session_id = ?', (session_id,))
            cursor = conn.execute('DELETE FROM ai_chat_sessions WHERE id = ?', (session_id,))
            conn.commit()
            return cursor.rowcount > 0
        finally:
            conn.close()


def upsert_session(session_id, title='', datasource='', datasources=None):
    """按调用方给的 id 建/改会话（标题、数据源集合），时间戳刷新。

    助手页把会话数组当作唯一真相，每次快照回写时
    需要「这个 id 存在就更新、不存在就建」，不能走「服务端生成 id」那条路，
    否则客户端手里的 id 和服务端对不上，刷新后历史就找不回来了。
    """
    if not session_id:
        return ''
    init_db()
    now = _now()
    packed = _dump_datasources(datasource, datasources)
    with _write_lock:
        conn = _connect()
        try:
            row = conn.execute('SELECT id, title FROM ai_chat_sessions WHERE id = ?',
                               (session_id,)).fetchone()
            if row is None:
                conn.execute('INSERT INTO ai_chat_sessions (id, title, datasource, datasources, '
                             'created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
                             (session_id, title or '新对话', datasource or '', packed, now, now))
            else:
                conn.execute('UPDATE ai_chat_sessions SET title = ?, datasource = ?, datasources = ?, '
                             'updated_at = ? WHERE id = ?',
                             (title or row['title'] or '新对话', datasource or '', packed, now, session_id))
            conn.commit()
        finally:
            conn.close()
    return session_id


def replace_messages(session_id, rows):
    """整组快照回写会话消息（幂等）。

    会话消息按整组快照落盘，不是增量 append；
    编辑重发、清空、撤销这类会让消息变少或内容变大的操作，用 append 会出现
    重复行或改不掉的旧行。所以这里按会话整段替换，字段与前端对象一一对应：
    ``meta`` 存 UI 需要但结构上没有列的东西（思考过程、工具轨迹 HTML、
    AI 修复的指纹覆盖层 sqlOverrides…），读回来时原样并进消息对象。
    """
    init_db()
    now = _now()
    with _write_lock:
        conn = _connect()
        try:
            conn.execute('DELETE FROM ai_chat_messages WHERE session_id = ?', (session_id,))
            for index, item in enumerate(rows or []):
                role = canonical_role(item.get('role'))
                content = item.get('content') or ''
                meta = {key: value for key, value in item.items()
                        if key not in ('role', 'content', 'task_id', 'summary', 'created_at')}
                conn.execute(
                    'INSERT INTO ai_chat_messages (session_id, role, content, summary, task_id, '
                    'created_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    (session_id, role, content, (item.get('summary') or '')[:500],
                     (item.get('task_id') or '')[:40], item.get('created_at') or now,
                     json.dumps(meta, ensure_ascii=False) if meta else ''))
            conn.execute('UPDATE ai_chat_sessions SET updated_at = ? WHERE id = ?', (now, session_id))
            conn.commit()
        finally:
            conn.close()
    return True


def append_message(session_id, role, content, task_id='', summary='', meta=''):
    init_db()
    role = canonical_role(role)
    with _write_lock:
        conn = _connect()
        try:
            conn.execute('INSERT INTO ai_chat_messages (session_id, role, content, summary, '
                         'task_id, created_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
                         (session_id, role, content, summary or '', task_id or '', _now(),
                          meta or ''))
            conn.execute('UPDATE ai_chat_sessions SET updated_at = ? WHERE id = ?',
                         (_now(), session_id))
            conn.commit()
        finally:
            conn.close()


def list_messages(session_id, limit=200):
    init_db()
    conn = _connect()
    try:
        rows = conn.execute('SELECT * FROM ai_chat_messages WHERE session_id = ? '
                            'ORDER BY id ASC LIMIT ?', (session_id, int(limit))).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            # meta 里的字段并回消息对象：前端拿到的是「和存进去时同一个形状」，
            # 不必为兼容层再写一套字段映射（映射层就是差异的来源）。
            raw = item.pop('meta', '') or ''
            if raw:
                try:
                    item.update(json.loads(raw))
                except Exception:
                    pass
            out.append(item)
        return out
    finally:
        conn.close()


def recent_messages(session_id, limit=20):
    """取最近 N 条对话（时间正序），用于提示词里的历史上下文。"""
    init_db()
    conn = _connect()
    try:
        rows = conn.execute('SELECT * FROM (SELECT * FROM ai_chat_messages '
                            'WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
                            (session_id, int(limit))).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def update_message_summary(message_id, summary):
    """历史摘要（后台 LLM 生成，只存 150 字，供长对话压上下文用）。"""
    if not message_id:
        return
    init_db()
    with _write_lock:
        conn = _connect()
        try:
            conn.execute('UPDATE ai_chat_messages SET summary = ? WHERE id = ?',
                         (str(summary or '')[:150], message_id))
            conn.commit()
        finally:
            conn.close()
