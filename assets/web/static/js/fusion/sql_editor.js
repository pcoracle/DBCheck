/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * Fusion page logic: SQL editor (object tree + multi-window editor + result tabs).
 * Behaviour and interaction habits ported from DBCheck v2.6 (MIT License,
 * Copyright (c) 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>) — 多执行窗口页签、
 * 对象感知智能提示（表/视图/列/函数/关键字）、执行范围三档（选区/当前语句/全文）、
 * 逐条结果页签 + 游标无限滚动、树节点右键（插入名称 / Top-N / 表属性）、按方言的
 * 执行目标（库 / 用户 / 模式）与示例 SQL。
 * Rewritten for the RaccoonX module layout and /api/execute_sql_multi、
 * /api/sql_metadata、/api/pro/datasources/<id>/{databases,schemas,objects,table-info}.
 */
(function () {
  'use strict';

  // 状态栏元素必须保留 sql-statusbar-item 基类（单行省略号靠它），改 className 时统一拼这个前缀
  var STATUS_BAR_ITEM_CLASS = 'sql-statusbar-item ';

  var HINT_MAX_ITEMS = 300;          // 一次提示最多候选（实测 8000+ 对象会把编辑器卡死）
  var SCRIPT_ID_PREFIX = 'sqx';      // 惰性注入的 <script> id 前缀
  var REQUEST_TIMEOUT_MS = 25000;    // 普通接口超时；执行 / 元数据另给更长预算
  var METADATA_TIMEOUT_MS = 90000;   // 数据字典首次拉取（11g 上万个列要十几秒）
  var EXECUTE_TIMEOUT_MS = 300000;   // 执行不设太短：慢查询被前端掐掉比等下去更糟
  var CONTEXT_STORAGE_KEY = 'dbcheck.sqlEditor.ctx';
  var LAYOUT_STORAGE_KEY = 'dbcheck.sqlEditor.cols';

  var TREE_ICON = '🗄';
  var FOLDER_ICON = '📁';
  var DATABASE_ICON = '🗃';
  var TABLE_ICON = '📋';
  var VIEW_ICON = '👁';

  var SVG_CLOSE = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" ' +
                  'stroke-linecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
  var SVG_INSERT = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" ' +
                   'stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M4 9l4 4 4-4"/></svg>';
  var SVG_QUERY = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" ' +
                  'stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/>' +
                  '<path d="M10.2 10.2 14 14"/></svg>';
  var SVG_PROPERTIES = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" ' +
                       'stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.6"/>' +
                       '<path d="M2.5 6h11M6 6v7.5"/></svg>';
  var SVG_REFRESH = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" ' +
                    'stroke-linecap="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7"/>' +
                    '<path d="M13 2.5V5.2h-2.7"/></svg>';

  var editorState = {
    entered: false,
    codeMirrorReady: false,
    tabs: [],
    activeTabId: 0,
    tabSeq: 0,
    tabNameSeq: 0,
    datasourceTypes: {},     // 数据源ID -> 规范后的 db_type
    metadataCache: {},       // '数据源ID::库名' -> {objects, loading, error, ...}
    hintTablesCache: {},     // '数据源ID::库名' -> {表名: {columns:[...]}}
    hintViewsCache: {},      // '数据源ID::库名' -> {大写表名: true}
    columnRequestFlags: {},  // '数据源ID::库名::表名' -> loading|done|fail
    metadataUpgradeKeys: {}, // '数据源ID::库名' -> 后台补列升级是否已在跑（防重复发请求）
    columnUpgradeTried: {},  // '数据源ID::库名' -> 后台补列已试过（失败也不逐键重试）
    autoHintEnabled: true,
    targetDatabasesCache: {},   // 数据源ID -> [库 / 用户]
    targetSchemasCache: {},     // '数据源ID||库名' -> [模式]
    datasourceId: null,
    databaseName: '',
    schemaName: '',
    treeNodeType: null,
    datasources: [],
    treeKeyword: '',
    resultPaneMaximized: false,
    layoutSizes: {},
    running: false,
    keywordCache: null
  };

  // ══════════════════════════════════════════════════════════════
  //  基础工具
  // ══════════════════════════════════════════════════════════════
  function elementById(id) {
    return document.getElementById(id);
  }

  function i18nText(key, fallback) {
    try {
      if (typeof window.i18n === 'function') {
        var value = window.i18n(key);
        if (value && value !== key) return value;
      }
    } catch (ignore) { /* 取不到文案就用中文兜底 */ }
    return fallback || key;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function escapeAttr(value) { return escapeHtml(value); }

  function notifyUser(message, level) {
    if (typeof window.toast === 'function') { window.toast(message, level || 'info'); return; }
    if (level === 'error') console.error(message); else console.log(message);
  }

  // 后端卡住时（会话过期后登录接口挂住、老进程没有这条路由等），
  // 没有超时的 fetch 会让界面永远停在「加载中...」—— 用户看到的就是「查半天不出来」。
  function fetchWithTimeout(url, init, timeoutMs) {
    var limit = timeoutMs || REQUEST_TIMEOUT_MS;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, limit);
    var options = Object.assign({}, init || {}, { credentials: 'same-origin' });
    if (controller) options.signal = controller.signal;
    return fetch(url, options).then(function (response) {
      clearTimeout(timer);
      return response;
    }, function (failure) {
      clearTimeout(timer);
      if (failure && failure.name === 'AbortError') {
        throw new Error(i18nText('sql_editor.request_timeout', '请求超时（后端未响应，可能需要重启服务）'));
      }
      throw failure;
    });
  }

  function httpGet(url, timeoutMs) {
    return fetchWithTimeout(url, { method: 'GET' }, timeoutMs).then(function (response) {
      return response.json();
    });
  }

  function httpPost(url, payload, timeoutMs) {
    return fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    }, timeoutMs).then(function (response) {
      return response.json().then(function (json) { return { status: response.status, body: json }; });
    }).then(function (result) {
      var body = result.body || {};
      // 执行接口即便业务失败也带 error / results，交给调用方按内容判定，不要在这里抛异常
      if (result.status >= 400 && !body.error && !body.results) {
        var failure = new Error(body.error || body.message || ('HTTP ' + result.status));
        failure.status = result.status;
        throw failure;
      }
      return body;
    });
  }

  // 方言名规范化：与后端 modules/sqleditor/metadata.norm_db_type 保持同一套写法
  function normalizeDbType(rawType) {
    var value = String(rawType || '').toLowerCase().replace('oracle_full', 'oracle').replace('_jdbc', '');
    if (value === 'pg' || value === 'postgres') value = 'postgresql';
    if (value === 'dm8') value = 'dm';
    return value;
  }

  function datasourceTypeOf(datasourceId) {
    if (!datasourceId) return '';
    return editorState.datasourceTypes[String(datasourceId)] || '';
  }

  // 后端路由没上线（老进程没重启）时返回的是 HTML，r.json() 抛的是解析异常；
  // 直接铺在界面上既难看又没用，压成一句人话即可。
  function briefError(rawError) {
    var message = String(rawError || '').replace(/\s+/g, ' ').trim();
    if (/Unexpected token|is not valid JSON|<!doctype/i.test(message)) {
      // 命中这条的基本都是「后端路由还没上线」（老进程没重启，返回的是 404 HTML）
      return i18nText('sql_editor.route_missing', '接口不可用（服务需重启）');
    }
    return message.length > 90 ? message.slice(0, 90) + '…' : message;
  }

  // ══════════════════════════════════════════════════════════════
  //  惰性加载 CodeMirror（仓库已 vendored，index.html 只引了 CSS）
  // ══════════════════════════════════════════════════════════════
  function loadScript(scriptSrc) {
    return new Promise(function (resolve, reject) {
      var scriptId = SCRIPT_ID_PREFIX + '-js-' + scriptSrc.replace(/[^\w]/g, '_');
      if (elementById(scriptId)) { resolve(); return; }
      var tag = document.createElement('script');
      tag.src = scriptSrc;
      tag.id = scriptId;
      tag.onload = function () { resolve(); };
      tag.onerror = function () { reject(new Error('load failed: ' + scriptSrc)); };
      document.head.appendChild(tag);
    });
  }

  function ensureCodeMirrorLoaded() {
    if (editorState.codeMirrorReady || window.CodeMirror) {
      editorState.codeMirrorReady = !!window.CodeMirror;
      return Promise.resolve(editorState.codeMirrorReady);
    }
    return loadScript('/static/codemirror/lib/codemirror.js')
      .then(function () {
        // 核心之后的 mode 与三个 addon 之间没有依赖，串行加载会把「首屏能用了」
        // 拖到 5 个请求之后（实测本机静态目录一个文件就要 1~2s）
        return Promise.all([
          loadScript('/static/codemirror/mode/sql/sql.js'),
          loadScript('/static/codemirror/addon/edit/matchbrackets.js'),
          loadScript('/static/codemirror/addon/display/placeholder.js'),
          loadScript('/static/codemirror/addon/hint/show-hint.js')
        ]);
      })
      .then(function () {
        editorState.codeMirrorReady = !!window.CodeMirror;
        return editorState.codeMirrorReady;
      })
      .catch(function (failure) {
        console.warn('[SQL 编辑器] CodeMirror 加载失败，退化为纯文本编辑器:', failure && failure.message);
        editorState.codeMirrorReady = false;
        return false;
      });
  }

  // ══════════════════════════════════════════════════════════════
  //  方言：执行目标形态 / 常用函数 / 示例 SQL
  // ══════════════════════════════════════════════════════════════
  function targetShapeOf(dbType) {
    var normalized = normalizeDbType(dbType);
    if (normalized === 'oracle' || normalized === 'dm' || normalized === 'yashandb') {
      return { label: i18nText('sql_editor.target_user', '用户'), showSchema: false,
               tip: '以该用户（owner）身份执行：未限定的对象名按这个用户解析（ALTER SESSION SET CURRENT_SCHEMA）' };
    }
    if (['postgresql', 'ivorysql', 'kingbase', 'hgdb', 'halodb'].indexOf(normalized) >= 0) {
      return { label: i18nText('sql_editor.target_db', '数据库'), showSchema: true,
               tip: '连接的目标库；模式通过 SET search_path 生效（未选则用服务端默认）' };
    }
    if (normalized === 'sqlserver') {
      return { label: i18nText('sql_editor.target_db', '数据库'), showSchema: false,
               tip: '连接的目标库（T-SQL 没有会话级默认模式，跨模式请用「schema.表名」限定）' };
    }
    if (['mysql', 'tidb', 'mariadb', 'oceanbase', 'tdsqlc_mysql', 'gbase'].indexOf(normalized) >= 0) {
      return { label: i18nText('sql_editor.target_db', '数据库'), showSchema: false,
               tip: '连接的目标库（库即模式）' };
    }
    return { label: i18nText('sql_editor.target_db_user', '库 / 用户'), showSchema: false,
             tip: '选择当前语句的目标库' };
  }

  // [WARN] 多行拼接的词表必须整体加括号再 split：
  // 'a b ' + 'c d'.split(' ') 会先算 split，结果是「字符串 + 数组」的拼接，
  // 表现是提示引擎报 forEach is not a function（实测踩过）。
  var BUILTIN_FUNCTIONS_BY_TYPE = {
    oracle: ('COUNT SUM AVG MIN MAX NVL NVL2 DECODE TO_CHAR TO_DATE TO_NUMBER SYSDATE SYSTIMESTAMP ' +
             'LISTAGG REGEXP_SUBSTR REGEXP_REPLACE SUBSTR INSTR LENGTH TRIM UPPER LOWER ROUND TRUNC ' +
             'ROW_NUMBER RANK DENSE_RANK LAG LEAD NULLS COALESCE CASE').split(' '),
    mysql: ('COUNT SUM AVG MIN MAX IF IFNULL COALESCE CONCAT GROUP_CONCAT DATE_FORMAT NOW CURDATE ' +
            'SUBSTRING INSTR LENGTH TRIM UPPER LOWER ROUND CAST JSON_EXTRACT ROW_NUMBER RANK').split(' '),
    postgresql: ('COUNT SUM AVG MIN MAX COALESCE NULLIF STRING_AGG TO_CHAR TO_DATE SUBSTRING POSITION ' +
                 'LENGTH TRIM UPPER LOWER ROUND CAST DATE_TRUNC EXTRACT NOW ROW_NUMBER RANK').split(' '),
    sqlserver: ('COUNT SUM AVG MIN MAX ISNULL COALESCE GETDATE CONVERT CAST SUBSTRING LEN STUFF ' +
                'STRING_AGG ROW_NUMBER RANK DATEPART DATEDIFF').split(' '),
    dm: ('COUNT SUM AVG MIN MAX NVL DECODE TO_CHAR TO_DATE SUBSTR INSTR LENGTH TRIM UPPER LOWER ' +
         'LISTAGG ROW_NUMBER RANK').split(' '),
    yashandb: ('COUNT SUM AVG MIN MAX NVL COALESCE TO_CHAR TO_DATE SUBSTR INSTR LENGTH TRIM ' +
               'LISTAGG ROW_NUMBER RANK').split(' '),
    clickhouse: ('count sum avg min max any toDate toDateTime formatDateTime arrayJoin uniq ' +
                 'toString toInt64 if multiIf').split(' ')
  };
  ['ivorysql', 'kingbase', 'hgdb', 'halodb'].forEach(function (alias) {
    BUILTIN_FUNCTIONS_BY_TYPE[alias] = BUILTIN_FUNCTIONS_BY_TYPE.postgresql;
  });
  ['tidb', 'mariadb', 'oceanbase', 'tdsqlc_mysql', 'db2', 'gbase'].forEach(function (alias) {
    BUILTIN_FUNCTIONS_BY_TYPE[alias] = BUILTIN_FUNCTIONS_BY_TYPE.mysql;
  });

  function builtinFunctionsOf(datasourceId) {
    return BUILTIN_FUNCTIONS_BY_TYPE[datasourceTypeOf(datasourceId)] || BUILTIN_FUNCTIONS_BY_TYPE.oracle;
  }

  var SAMPLE_SQL_BY_TYPE = {
    oracle: {
      hint: 'SELECT * FROM V$SESSION WHERE USERNAME IS NOT NULL',
      sample: '-- 当前活动会话\n' +
              'SELECT s.inst_id, s.sid, s.serial#, s.username, s.status, s.machine, s.program,\n' +
              '       s.sql_id, s.last_call_et\n' +
              '  FROM gv$session s\n' +
              ' WHERE s.username IS NOT NULL\n' +
              ' ORDER BY s.last_call_et DESC'
    },
    mysql: {
      hint: 'SHOW PROCESSLIST',
      sample: '-- 当前连接与库\n' +
              'SELECT id, user, host, db, command, time, state, info\n' +
              '  FROM information_schema.processlist\n' +
              ' ORDER BY time DESC\n' +
              ' LIMIT 50'
    },
    postgresql: {
      hint: 'SELECT pid, state, query FROM pg_stat_activity',
      sample: '-- 后端活动与等待事件\n' +
              'SELECT pid, usename, application_name, state, wait_event_type, wait_event,\n' +
              '       EXTRACT(EPOCH FROM (now() - query_start))::int AS running_sec, query\n' +
              '  FROM pg_stat_activity\n' +
              " WHERE state <> 'idle'\n" +
              ' ORDER BY running_sec DESC'
    },
    sqlserver: {
      hint: 'SELECT TOP 10 * FROM sys.dm_exec_requests',
      sample: '-- 正在执行的请求\n' +
              'SELECT TOP 50 r.session_id, r.status, r.command, r.wait_type, r.wait_time,\n' +
              '       r.cpu_time, r.total_elapsed_time, t.text AS sql_text\n' +
              '  FROM sys.dm_exec_requests r\n' +
              '  CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t\n' +
              ' ORDER BY r.total_elapsed_time DESC'
    },
    clickhouse: {
      hint: 'SELECT * FROM system.processes',
      sample: '-- 正在运行的查询\n' +
              'SELECT query_id, user, elapsed, memory_usage, substring(query, 1, 200) AS sql_text\n' +
              '  FROM system.processes\n' +
              ' ORDER BY elapsed DESC\n' +
              ' LIMIT 50'
    }
  };
  ['dm', 'yashandb'].forEach(function (alias) { SAMPLE_SQL_BY_TYPE[alias] = SAMPLE_SQL_BY_TYPE.oracle; });
  ['ivorysql', 'kingbase', 'hgdb', 'halodb'].forEach(function (alias) {
    SAMPLE_SQL_BY_TYPE[alias] = SAMPLE_SQL_BY_TYPE.postgresql;
  });
  ['tidb', 'mariadb', 'oceanbase', 'tdsqlc_mysql'].forEach(function (alias) {
    SAMPLE_SQL_BY_TYPE[alias] = SAMPLE_SQL_BY_TYPE.mysql;
  });

  var SAMPLE_SQL_FALLBACK = {
    hint: 'SELECT * FROM <表名> LIMIT 10',
    sample: 'SELECT *\n  FROM <表名>\n WHERE 1 = 1\n LIMIT 10'
  };

  function sampleSqlOf() {
    var typeKey = datasourceTypeOf(editorState.datasourceId);
    return (typeKey && SAMPLE_SQL_BY_TYPE[typeKey]) || SAMPLE_SQL_FALLBACK;
  }

  // ══════════════════════════════════════════════════════════════
  //  执行窗口（页签）：一个窗口 = 一套编辑器 + 结果 + 数据源上下文
  // ══════════════════════════════════════════════════════════════
  function createTab(options) {
    var config = options || {};
    editorState.tabSeq += 1;
    editorState.tabNameSeq += 1;
    var tab = {
      id: editorState.tabSeq,
      name: config.name || (i18nText('sql_editor.tab_query', '查询') + ' ' + editorState.tabNameSeq),
      // 新窗口默认继承当前上下文（丢掉用户已选的数据源是最反直觉的行为）
      datasourceId: config.datasourceId !== undefined ? config.datasourceId : editorState.datasourceId,
      databaseName: config.databaseName !== undefined ? config.databaseName : (editorState.databaseName || ''),
      schemaName: config.schemaName !== undefined ? config.schemaName : (editorState.schemaName || ''),
      treeNodeType: config.treeNodeType !== undefined ? config.treeNodeType : editorState.treeNodeType,
      datasourceHint: '',
      results: [],
      activeResultIndex: -1,
      pageState: { cursorId: null, hasMore: false, loadedRows: 0, loading: false },
      statusText: '',
      statusClass: '',
      resultCountText: '',
      resultScrollTop: 0,
      containerEl: null,
      textareaEl: null,
      codeMirror: null
    };
    var host = elementById('sql-editors-host');
    var container = document.createElement('div');
    container.className = 'sql-tab-editor';
    container.setAttribute('data-tab-id', String(tab.id));
    var textarea = document.createElement('textarea');
    textarea.id = 'sql-input-area-' + tab.id;
    textarea.className = 'sql-raw-textarea';
    textarea.spellcheck = false;
    textarea.placeholder = sampleSqlOf().hint;
    if (config.sql) textarea.value = config.sql;
    container.appendChild(textarea);
    if (host) host.appendChild(container);
    tab.containerEl = container;
    tab.textareaEl = textarea;
    if (editorState.codeMirrorReady && window.CodeMirror) tab.codeMirror = createCodeMirrorEditor(textarea);
    editorState.tabs.push(tab);
    return tab;
  }

  function createCodeMirrorEditor(textarea) {
    if (!window.CodeMirror) return null;
    var instance = CodeMirror.fromTextArea(textarea, {
      // mode 必须是 MIME 'text/x-sql'：{name:'sql'} 走的是不带词表的 mode spec，
      // keywords 会是空对象 → 提示里连 SELECT 都出不来（实测踩过）。
      mode: 'text/x-sql',
      theme: 'dracula',
      lineNumbers: true,
      lineWrapping: true,
      matchBrackets: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      smartIndent: true,
      viewportMargin: Infinity,
      placeholder: sampleSqlOf().hint,
      extraKeys: {
        // ⚠️ CodeMirror 会把编辑器实例作为首个实参传给 extraKeys 的处理函数，
        // 所以这里必须包一层 —— 直接写 execSql 会让第一个参数变成实例（恒为真值）。
        'Ctrl-Enter': function () { executeActiveSql(); },
        'Cmd-Enter': function () { executeActiveSql(); },
        'Ctrl-Shift-F': function () { formatActiveSql(); },
        'Ctrl-Space': function (instanceArg) { showSqlHint(instanceArg, true); },
        'Alt-/': function (instanceArg) { showSqlHint(instanceArg, true); },
        'Esc': function (instanceArg) {
          // 提示框开着时先关提示（show-hint 自己也会处理，这里兜底避免选了代码关不掉框）
          if (isHintBoxOpen(instanceArg)) {
            try { instanceArg.closeHint(); } catch (ignore) { closeSqlHint(); }
          }
          return CodeMirror.Pass;
        }
      },
      hintOptions: buildHintOptions()
    });
    instance.on('cursorActivity', function () { refreshScopeHint(); });
    scheduleAutoHint(instance);      // 创建时就绑「输入即提示」，绑在 change 上会漏掉第一次按键
    return instance;
  }

  function findTabById(tabId) {
    for (var i = 0; i < editorState.tabs.length; i++) {
      if (editorState.tabs[i].id === tabId) return editorState.tabs[i];
    }
    return null;
  }

  function activeTab() {
    return findTabById(editorState.activeTabId) || editorState.tabs[0] || null;
  }

  function tabSqlText(tab) {
    if (!tab) return '';
    if (tab.codeMirror) return tab.codeMirror.getValue();
    return tab.textareaEl ? String(tab.textareaEl.value || '') : '';
  }

  function setTabSqlText(tab, text) {
    if (!tab) return;
    var value = text == null ? '' : String(text);
    if (tab.codeMirror) { tab.codeMirror.setValue(value); return; }
    if (tab.textareaEl) tab.textareaEl.value = value;
  }

  function showTabEditor(tab) {
    editorState.tabs.forEach(function (other) {
      if (other.containerEl) other.containerEl.classList.toggle('active', other === tab);
    });
    if (tab && tab.codeMirror) {
      try { tab.codeMirror.refresh(); } catch (ignore) { /* 隐藏容器里 refresh 无害 */ }
    }
    // 兼容历史引用：index.html 里的旧代码用 window.sqlEditor 取当前编辑器
    window.sqlEditor = (tab && tab.codeMirror) ? tab.codeMirror : null;
  }

  function saveTabViewState(tab) {
    if (!tab) return;
    var statusEl = elementById('sql-status');
    tab.statusText = statusEl ? statusEl.textContent : '';
    tab.statusClass = statusEl ? statusEl.className : '';
    var countEl = elementById('sql-result-count');
    tab.resultCountText = countEl ? countEl.textContent : '';
    var resultWrapEl = elementById('sql-result-wrap');
    tab.resultScrollTop = resultWrapEl ? resultWrapEl.scrollTop : 0;
  }

  function restoreTabViewState(tab) {
    var statusEl = elementById('sql-status');
    if (statusEl) {
      statusEl.textContent = tab.statusText || '';
      statusEl.className = tab.statusClass || (STATUS_BAR_ITEM_CLASS + 'sql-status');
    }
    var countEl = elementById('sql-result-count');
    if (countEl) countEl.textContent = tab.resultCountText || '';
    renderResultTabs();
    renderResultBody(false);
    var resultWrapEl = elementById('sql-result-wrap');
    if (resultWrapEl) resultWrapEl.scrollTop = tab.resultScrollTop || 0;
  }

  // 把页签上记录的「数据源 / 库 / 模式」恢复到全局与工具栏
  function applyTabContext(tab) {
    if (!tab) return;
    editorState.datasourceId = tab.datasourceId || null;
    editorState.databaseName = tab.databaseName || '';
    editorState.schemaName = tab.schemaName || '';
    editorState.treeNodeType = tab.treeNodeType ||
      (editorState.datasourceId ? (editorState.databaseName ? 'db' : 'ds') : null);
    var hintEl = elementById('sql-curr-ds');
    if (hintEl) {
      var text = tab.datasourceHint || '';
      if (!text && editorState.datasourceId) {
        text = TREE_ICON + ' ' + (datasourceNameOf(editorState.datasourceId) || ('DS#' + editorState.datasourceId));
        if (editorState.databaseName) text += ' › ' + editorState.databaseName;
      }
      hintEl.textContent = text || i18nText('sql_editor.no_datasource', '未选择数据源');
    }
    refreshTargetSelectors();
    refreshScopeHint();
  }

  // 把当前上下文写回指定页签（不传 = 当前激活页签）
  // ⚠️ 必须支持显式传页签：activateTab 是「先切 activeTabId、再保存旧页签」，
  //    此时 activeTab() 已经指向新页签，靠它取会把目标写错窗口。
  function syncContextToTab(tab) {
    var target = tab || activeTab();
    if (!target) return;
    target.datasourceId = editorState.datasourceId;
    target.databaseName = editorState.databaseName || '';
    target.schemaName = editorState.schemaName || '';
    target.treeNodeType = editorState.treeNodeType;
    var hintEl = elementById('sql-curr-ds');
    if (hintEl) target.datasourceHint = hintEl.textContent || '';
  }

  function datasourceNameOf(datasourceId) {
    var node = document.querySelector('#sql-tree-body .sql-tree-node[data-type="ds"][data-ds-id="'
               + String(datasourceId).replace(/"/g, '\\"') + '"] .tree-label');
    return node ? node.textContent.split('(')[0].trim() : '';
  }

  function activateTab(tab) {
    var previous = activeTab();
    if (previous && previous !== tab) saveTabViewState(previous);
    editorState.activeTabId = tab.id;
    showTabEditor(tab);
    applyTabContext(tab);
    renderTabBar();
    restoreTabResults(tab);           // 下方结果区跟着当前窗口走（每个窗口各自保留结果）
    refreshMetadataStatus();          // 切页签只更新状态，不加载字典
  }

  // 切换执行窗口 → 把该窗口自己的结果（含选中的结果页签、翻页游标）搬回结果区。
  // 旧实现只切了编辑器，结果区仍停在上一个窗口的内容上，看着就像「结果不跟着换」。
  function restoreTabResults(tab) {
    if (!tab) return;
    if (tab.activeResultIndex >= tab.results.length) tab.activeResultIndex = tab.results.length - 1;
    var result = tab.activeResultIndex >= 0 ? tab.results[tab.activeResultIndex] : null;
    tab.pageState = {
      cursorId: result ? result.cursor_id : null,
      hasMore: result ? !!result.has_more : false,
      loadedRows: result ? (result.rows || []).length : 0,
      loading: false
    };
    unbindResultScroll();
    renderResultTabs();
    renderResultBody(false);
    bindResultScroll();
  }

  function addEditorTab(options) {
    var tab = createTab(options || {});
    activateTab(tab);
    if (editorState.codeMirrorReady && !tab.codeMirror && tab.textareaEl) {
      tab.codeMirror = createCodeMirrorEditor(tab.textareaEl);
    }
    renderTabBar();
    try {
      if (tab.codeMirror) tab.codeMirror.focus();
      else if (tab.textareaEl) tab.textareaEl.focus();
    } catch (ignore) { /* 聚焦失败不影响功能 */ }
    return tab;
  }

  function closeEditorTab(tabId) {
    if (editorState.tabs.length <= 1) {          // 至少留一个窗口，否则没地方写 SQL
      var only = editorState.tabs[0];
      setTabSqlText(only, '');
      only.results = [];
      only.activeResultIndex = -1;
      renderResultTabs();
      renderResultBody(false);
      return;
    }
    var index = -1;
    editorState.tabs.forEach(function (item, i) { if (item.id === tabId) index = i; });
    if (index < 0) return;
    var closing = editorState.tabs[index];
    if (closing.codeMirror) { try { closing.codeMirror.toTextArea(); } catch (ignore) { /* 已销毁 */ } }
    if (closing.containerEl && closing.containerEl.parentNode) {
      closing.containerEl.parentNode.removeChild(closing.containerEl);
    }
    editorState.tabs.splice(index, 1);
    if (editorState.activeTabId === tabId) {
      var next = editorState.tabs[Math.min(index, editorState.tabs.length - 1)];
      editorState.activeTabId = next.id;
      showTabEditor(next);
      applyTabContext(next);
      restoreTabResults(next);       // 关掉当前窗口后，结果区要换成接任窗口自己的结果
    }
    renderTabBar();
  }

  function renderTabBar() {
    var host = elementById('sql-tabs-list');
    if (!host) return;
    var html = '';
    editorState.tabs.forEach(function (tab) {
      html += '<div class="sql-tab' + (tab.id === editorState.activeTabId ? ' active' : '') + '" ' +
              'data-tab-id="' + tab.id + '">' +
              '  <span class="sql-tab-name">' + escapeHtml(tab.name) + '</span>' +
              '  <span class="sql-tab-close" data-close="' + tab.id + '" title="' +
              escapeAttr(i18nText('sql_editor.tab_close', '关闭该执行窗口')) + '">' + SVG_CLOSE + '</span>' +
              '</div>';
    });
    host.innerHTML = html;
  }

  // ══════════════════════════════════════════════════════════════
  //  对象元数据（智能提示的数据来源）
  // ══════════════════════════════════════════════════════════════
  function metadataCacheKey(datasourceId, databaseName) {
    return String(datasourceId || '') + '::' + (databaseName || '');
  }

  function setObjectMetadataStatus(text) {
    var element = elementById('sql-meta-status');
    if (!element) return;
    element.textContent = text || '';
    element.title = text || '';
    element.className = STATUS_BAR_ITEM_CLASS + 'sql-meta-status';
  }

  function objectMetadataStatusText(metadata) {
    if (!metadata) return '';
    if (metadata.loading) return i18nText('sql_editor.meta_loading', '正在加载对象…');
    if (metadata.error) {
      return i18nText('sql_editor.meta_failed', '对象元数据不可用，仅提示关键字') + '：' +
             briefError(metadata.error);
    }
    var columnTotal = metadata.column_count || 0;
    var text = columnTotal
      ? i18nText('sql_editor.meta_loaded', '已加载 {n} 个对象 / {c} 个字段（Ctrl+Space 触发提示）')
          .replace('{n}', metadata.object_count || 0).replace('{c}', columnTotal)
      : i18nText('sql_editor.meta_loaded_objects', '已加载 {n} 个对象（敲 表名. 时自动补字段）')
          .replace('{n}', metadata.object_count || 0);
    if (metadata.truncated) text += '（' + i18nText('sql_editor.meta_truncated', '已截断') + '）';
    if (metadata.cached) text += ' · ' + i18nText('sql_editor.meta_cached', '来自缓存');
    return text;
  }

  // ── 「分而治之」的加载边界 ─────────────────────────────────────
  // 只选了数据源、还没指定库/Owner 时，**一个对象字典请求都不发**：
  // 整实例清单动辄几千个对象（实测某 owner 就有 8691 个），而用户此时还没说要查哪套表。
  function metadataScopeReady() {
    return !!(editorState.datasourceId && editorState.databaseName);
  }

  function showDeferredMetadataStatus() {
    setObjectMetadataStatus(i18nText(
      'sql_editor.meta_pick_scope',
      '已启用关键字提示；选择库 / Owner 后按需加载（Ctrl+Space 加载全部对象）'));
  }

  // 状态栏只反映「已经拿到的」和「还差什么」，不负责触发加载
  function refreshMetadataStatus() {
    var cacheKey = metadataCacheKey(editorState.datasourceId, editorState.databaseName);
    var metadataEntry = editorState.metadataCache[cacheKey];
    if (metadataEntry) {
      setObjectMetadataStatus(objectMetadataStatusText(metadataEntry));
    } else if (!metadataScopeReady()) {
      showDeferredMetadataStatus();
    } else {
      setObjectMetadataStatus(i18nText(
        'sql_editor.meta_lazy_scope', '开始输入时加载表名与字段（Ctrl+Space 立即加载）'));
    }
  }

  // ── 元数据分两段取，保证「秒出」───────────────────────────────
  // 一次「对象 + 全部列」在真实库上是十万行级别（实测 ZYWEAS01：164673 列 / 10 秒），
  // 首屏等它等于什么都没得看。所以先只要对象名单（同一批数据实测 0.4 秒），
  // 列名靠两条路补：① 敲到 `表名.` 时按需补（毫秒级）；② 对象不多时后台静默升级成带列版本。
  var METADATA_COLUMN_UPGRADE_LIMIT = 500;

  function requestObjectMetadata(forceRefresh, objectsOnly, datasourceId, databaseName) {
    var targetDataSource = datasourceId || editorState.datasourceId;
    var targetDatabase = (databaseName === undefined ? editorState.databaseName : databaseName) || '';
    var url = '/api/sql_metadata?instance_id=' + encodeURIComponent(targetDataSource) +
              '&database=' + encodeURIComponent(targetDatabase);
    if (objectsOnly) url += '&objects_only=1';
    else url += '&full=1';                       // 显式要「带列」，绕开后端的名单降级
    if (forceRefresh) url += '&refresh=1';
    return httpGet(url, METADATA_TIMEOUT_MS);
  }

  // 后台把「只有名单」升级成「名单 + 列」：只在对象数不多时做，失败也不告诉用户
  // （没升级成功就继续按名单模式提示，敲到 `表名.` 仍然能按需补列）。
  // datasourceId / databaseName 用发起时的快照：用户中途切库，回包也只写回它自己那个缓存键。
  function upgradeMetadataWithColumns(cacheKey, datasourceId, databaseName) {
    if (editorState.metadataUpgradeKeys[cacheKey]) return;
    editorState.metadataUpgradeKeys[cacheKey] = true;
    requestObjectMetadata(false, false, datasourceId, databaseName).then(function (payload) {
      if (!payload || !payload.ok || !payload.objects) return;
      var current = editorState.metadataCache[cacheKey];
      if (!current || current.loading) return;  // 期间被重新请求过就别覆盖
      var upgraded = {
        objects: payload.objects, loading: false, error: null,
        object_count: payload.object_count, column_count: payload.column_count,
        truncated: payload.truncated, cached: payload.cached,
        scope: payload.scope, mode: payload.mode
      };
      editorState.metadataCache[cacheKey] = upgraded;
      delete editorState.hintTablesCache[cacheKey];      // 字典要按新列重建
      delete editorState.hintViewsCache[cacheKey];
      if (metadataCacheKey(editorState.datasourceId, editorState.databaseName) === cacheKey) {
        setObjectMetadataStatus(objectMetadataStatusText(upgraded));
      }
    }).catch(function () {
      /* 升级失败：保持名单模式即可，不打扰用户 */
    }).then(function () {
      delete editorState.metadataUpgradeKeys[cacheKey];
      editorState.columnUpgradeTried[cacheKey] = true;   // 试过就不再逐键重试
    });
  }

  function ensureObjectMetadata(forceRefresh, allowUnscoped) {
    if (!editorState.datasourceId) {
      setObjectMetadataStatus(i18nText('sql_editor.meta_no_ds',
                                       '未选择数据源：请点击左侧数据源以启用智能提示'));
      return Promise.resolve(null);
    }
    if (!metadataScopeReady() && !allowUnscoped) {
      // 没指定库/Owner 就不查整实例清单 —— 提示只用关键字，等用户把范围缩小
      showDeferredMetadataStatus();
      return Promise.resolve(null);
    }
    var cacheKey = metadataCacheKey(editorState.datasourceId, editorState.databaseName);
    var cached = editorState.metadataCache[cacheKey];
    if (cached && !forceRefresh) {
      setObjectMetadataStatus(objectMetadataStatusText(cached));
      return Promise.resolve(cached);
    }
    if (forceRefresh) delete editorState.columnUpgradeTried[cacheKey];   // 用户主动刷新：允许重试补列
    editorState.metadataCache[cacheKey] = { objects: null, loading: true, error: null };
    setObjectMetadataStatus(i18nText('sql_editor.meta_loading', '正在加载对象…'));
    var requestDataSource = editorState.datasourceId;
    var requestDatabase = editorState.databaseName || '';
    return requestObjectMetadata(forceRefresh, true, requestDataSource, requestDatabase)
      .then(function (payload) {
      var metadata;
      if (payload && payload.ok) {
        metadata = {
          objects: payload.objects || [], loading: false, error: null,
          object_count: payload.object_count, column_count: payload.column_count,
          truncated: payload.truncated, cached: payload.cached,
          scope: payload.scope, mode: payload.mode
        };
        delete editorState.hintTablesCache[cacheKey];   // 列变了，提示字典要重建
        delete editorState.hintViewsCache[cacheKey];
      } else {
        metadata = {
          objects: [], loading: false,
          error: (payload && (payload.error || payload.message)) || '未知错误',
          object_count: 0, column_count: 0
        };
      }
      // 只认当前上下文的回包：用户已经切到别的库就别把旧结果写回缓存
      if (metadataCacheKey(editorState.datasourceId, editorState.databaseName) !== cacheKey) {
        return metadata;
      }
      editorState.metadataCache[cacheKey] = metadata;
      setObjectMetadataStatus(objectMetadataStatusText(metadata));
      return metadata;
    }).catch(function (failure) {
      editorState.metadataCache[cacheKey] = {
        objects: [], loading: false, error: String(failure && failure.message || failure),
        object_count: 0, column_count: 0
      };
      setObjectMetadataStatus(objectMetadataStatusText(editorState.metadataCache[cacheKey]));
      return editorState.metadataCache[cacheKey];
    });
  }

  // 提示真的要用了才拉数据：先名单（已选定库/Owner 时只拉这一套），
  // 需要列时再补 —— 对象不多（≤上限）才后台补全，否则只按 `表名.` 单表补。
  function ensureMetadataForHints(editor) {
    if (!metadataScopeReady()) return;
    var cacheKey = metadataCacheKey(editorState.datasourceId, editorState.databaseName);
    var metadataEntry = editorState.metadataCache[cacheKey];
    if (!metadataEntry) {
      ensureObjectMetadata(false).then(function (loaded) {
        // 用户还在同一个编辑器里输入：名单到了就把这次提示补上
        if (loaded && editor && editor.hasFocus && editor.hasFocus()) showSqlHint(editor, true);
      });
      return;
    }
    if (metadataEntry.loading || metadataEntry.error) return;
    if (editorState.columnUpgradeTried[cacheKey]) return;
    if (!metadataEntry.column_count &&
        (metadataEntry.object_count || 0) <= METADATA_COLUMN_UPGRADE_LIMIT) {
      upgradeMetadataWithColumns(cacheKey, editorState.datasourceId, editorState.databaseName);
    }
  }

  // 提示用的表字典：裸名与限定名各用独立对象（CodeMirror sql-hint 会往条目里写字段）
  function hintTablesFor(datasourceId, databaseName) {
    var cacheKey = metadataCacheKey(datasourceId, databaseName);
    if (editorState.hintTablesCache[cacheKey]) return editorState.hintTablesCache[cacheKey];
    var metadata = editorState.metadataCache[cacheKey];
    if (!metadata || metadata.loading || metadata.error) return {};
    var tables = {}, views = {};
    (metadata.objects || []).forEach(function (objectEntry) {
      var columns = (objectEntry.columns || []).slice();
      tables[objectEntry.name] = { columns: columns.slice() };
      var isView = String(objectEntry.type || '').toUpperCase() === 'VIEW';
      if (isView) views[String(objectEntry.name).toUpperCase()] = true;
      if (objectEntry.schema) {
        var qualifiedName = objectEntry.schema + '.' + objectEntry.name;
        tables[qualifiedName] = { columns: columns.slice() };
        if (isView) views[qualifiedName.toUpperCase()] = true;
      }
    });
    editorState.hintTablesCache[cacheKey] = tables;
    editorState.hintViewsCache[cacheKey] = views;
    return tables;
  }

  // 敲到 `表名.` 但还没有列 → 后台按需补一次（兜底模式只有对象名单）
  function loadColumnsForTables(tableNames) {
    if (!editorState.datasourceId || !tableNames || !tableNames.length) return;
    var cacheKey = metadataCacheKey(editorState.datasourceId, editorState.databaseName);
    var pending = [];
    tableNames.forEach(function (tableName) {
      var requestKey = cacheKey + '::' + String(tableName).toUpperCase();
      if (editorState.columnRequestFlags[requestKey]) return;   // 已在请求中 / 已试过
      editorState.columnRequestFlags[requestKey] = 'loading';
      pending.push(tableName);
    });
    if (!pending.length) return;
    var url = '/api/sql_metadata?instance_id=' + encodeURIComponent(editorState.datasourceId) +
              '&database=' + encodeURIComponent(editorState.databaseName || '') +
              '&tables=' + encodeURIComponent(pending.join(','));
    httpGet(url, METADATA_TIMEOUT_MS).then(function (payload) {
      // 字典还没落地（例如直接把表名敲进来）就先建一条空条目再合并，
      // 否则这里拿到的是个临时对象，补到的列下次提示就丢了
      if (!editorState.metadataCache[cacheKey]) {
        editorState.metadataCache[cacheKey] = {
          objects: [], loading: false, error: null, object_count: 0, column_count: 0
        };
      }
      var metadata = editorState.metadataCache[cacheKey];
      if (!metadata.objects) metadata.objects = [];
      var columnsByName = {};
      ((payload && payload.objects) || []).forEach(function (objectEntry) {
        columnsByName[String(objectEntry.name).toUpperCase()] = objectEntry.columns || [];
      });
      pending.forEach(function (tableName) {
        var upperName = String(tableName).toUpperCase();
        var columns = columnsByName[upperName];
        editorState.columnRequestFlags[cacheKey + '::' + upperName] = columns ? 'done' : 'fail';
        if (!columns) return;
        var bareName = String(tableName).split('.').pop();
        [tableName, bareName].forEach(function (dictKey) {
          var entry = (editorState.hintTablesCache[cacheKey] || {})[dictKey];
          if (entry) entry.columns = columns.slice();
        });
        (metadata.objects || []).forEach(function (objectEntry) {
          var qualified = String(objectEntry.schema + '.' + objectEntry.name).toUpperCase();
          if (String(objectEntry.name).toUpperCase() === upperName || qualified === upperName) {
            objectEntry.columns = columns.slice();
          }
        });
      });
      delete editorState.hintTablesCache[cacheKey];      // 让字典按新列重建
      metadata.column_count = (metadata.objects || []).reduce(function (total, objectEntry) {
        return total + ((objectEntry.columns || []).length);
      }, 0);
      setObjectMetadataStatus(objectMetadataStatusText(metadata));
      // 用户还停在同一个补列上下文 → 重新弹一次提示
      var tab = activeTab();
      if (tab && tab.codeMirror) showSqlHint(tab.codeMirror, true);
    }).catch(function () {
      pending.forEach(function (tableName) {
        editorState.columnRequestFlags[cacheKey + '::' + String(tableName).toUpperCase()] = 'fail';
      });
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  补全引擎
  // ══════════════════════════════════════════════════════════════
  // 不用 CodeMirror 自带的 sql-hint：它用 getTokenAt() 取前缀，而 sql mode 会把
  // `V$SE` 切成以 `$` 开头的 token，原生正则不认 `$` 开头 → 前缀变空、把整张词表
  // 倒出来（实测 8000+ 对象直接卡死编辑器）。Oracle 场景 V$/GV$ 遍地都是，
  // 所以这里自己算前缀、自己匹配，排序 / 截断 / 分类着色收在一处。
  var IDENTIFIER_CHAR_CLASS = 'a-zA-Z0-9_$#\\u4e00-\\u9fa5';

  // 光标前的标识符片段：`a.b.`（列上下文）/ `a.b` / `ab` 三种形态
  function identifierPrefix(editor) {
    var cursor = editor.getCursor();
    var lineBeforeCursor = (editor.getLine(cursor.line) || '').slice(0, cursor.ch);
    var qualified = new RegExp('([' + IDENTIFIER_CHAR_CLASS + ']+(?:\\.[' + IDENTIFIER_CHAR_CLASS +
                              ']+)*)\\.([' + IDENTIFIER_CHAR_CLASS + ']*)$');
    var matched = lineBeforeCursor.match(qualified);
    if (matched) {
      return { owner: matched[1], fragment: matched[2],
               fromColumn: cursor.ch - matched[2].length, columnContext: true };
    }
    var plain = new RegExp('([' + IDENTIFIER_CHAR_CLASS + ']+)$');
    var matchedPlain = lineBeforeCursor.match(plain);
    if (matchedPlain) {
      return { owner: '', fragment: matchedPlain[1],
               fromColumn: cursor.ch - matchedPlain[1].length, columnContext: false };
    }
    return { owner: '', fragment: '', fromColumn: cursor.ch, columnContext: false };
  }

  // sql mode 只带了 34 个基础关键字（SELECT/FROM/WHERE…），常用词一个都不在里面 —— 补上
  var EXTRA_SQL_KEYWORDS = ('WITH OVER PARTITION ROWS RANGE UNBOUNDED PRECEDING FOLLOWING ' +
    'ROWNUM ROWID LEVEL CONNECT PRIOR NOCYCLE SIBLINGS DUAL ' +
    'FETCH NEXT ONLY OFFSET TOP LIMIT RETURNING ' +
    'CASE WHEN THEN ELSE END EXISTS ANY ALL SOME INOUT ' +
    'GRANT REVOKE COMMIT ROLLBACK SAVEPOINT TRUNCATE MERGE USING MATCHED ' +
    'SEQUENCE TRIGGER PROCEDURE FUNCTION PACKAGE CURSOR LOOP DECLARE BEGIN EXCEPTION ' +
    'PRIMARY FOREIGN REFERENCES CONSTRAINT INDEX UNIQUE DEFAULT CHECK ' +
    'EXPLAIN ANALYZE VACUUM PRAGMA CHARSET COLLATE ENGINE').split(' ');

  function sqlKeywordsOf(editor) {
    if (editorState.keywordCache) return editorState.keywordCache;
    var base = [];
    try {
      // ⚠️ keywords 挂在 mode 的 config 上（mode.config.keywords），不在 mode 对象本身；
      // 原生 sql-hint 也是这么取的。取不到再退到 resolveMode。
      var mode = editor.getModeAt(editor.getCursor());
      var keywordSet = (mode && mode.config && mode.config.keywords) ||
                       (window.CodeMirror && CodeMirror.resolveMode('text/x-sql').keywords);
      base = keywordSet ? Object.keys(keywordSet) : [];
    } catch (ignore) { base = []; }
    var seen = {};
    editorState.keywordCache = base.concat(EXTRA_SQL_KEYWORDS).filter(function (keyword) {
      var upper = String(keyword).toUpperCase();
      if (!upper || seen[upper]) return false;
      seen[upper] = true;
      return true;
    });
    return editorState.keywordCache;
  }

  // 光标所在的整条语句（按分号切）
  // 光标所在语句的「区间」：定位结果时要用它当起点，不能只有文本
  function currentStatementRange(editor) {
    var fullText = editor.getValue();
    var caretIndex;
    try { caretIndex = editor.indexFromPos(editor.getCursor()); }
    catch (ignore) { return { start: 0, end: fullText.length, text: fullText }; }
    var start = fullText.lastIndexOf(';', Math.max(0, caretIndex - 1)) + 1;
    var end = fullText.indexOf(';', caretIndex);
    if (end === -1) end = fullText.length;
    return { start: start, end: end, text: fullText.slice(start, end) };
  }

  function currentStatementOf(editor) {
    return currentStatementRange(editor).text;
  }

  // `EMP` / 别名 `e` → 真实表名（识别 FROM/JOIN ... [AS] 别名）
  function resolveTableReference(editor, reference, tables) {
    var upperReference = String(reference || '').toUpperCase();
    if (tables[reference] || tables[upperReference]) return reference;
    var reserved = {};
    sqlKeywordsOf(editor).forEach(function (keyword) { reserved[keyword.toUpperCase()] = true; });
    var statement = currentStatementOf(editor);
    var pattern = new RegExp('\\b(?:FROM|JOIN)\\s+([' + IDENTIFIER_CHAR_CLASS + ']+(?:\\.[' +
                             IDENTIFIER_CHAR_CLASS + ']+)?)(?:\\s+(?:AS\\s+)?([A-Za-z_\\u4e00-\\u9fa5][' +
                             IDENTIFIER_CHAR_CLASS + ']*))?', 'gi');
    var matched;
    while ((matched = pattern.exec(statement)) !== null) {
      var alias = matched[2];
      // 别把 `FROM emp WHERE` 里的 WHERE 当成别名
      if (alias && !reserved[alias.toUpperCase()] && alias.toUpperCase() === upperReference) return matched[1];
    }
    var dot = String(reference || '').lastIndexOf('.');
    if (dot > 0) {
      var bareName = reference.slice(dot + 1);
      if (tables[bareName] || tables[bareName.toUpperCase()]) return bareName;
    }
    return reference;
  }

  // 当前语句里第一个「已知表」，用于在 WHERE 里直接提示它的列
  function guessDefaultTable(editor, tables) {
    var statement = currentStatementOf(editor);
    var pattern = new RegExp('\\b(?:FROM|JOIN)\\s+([' + IDENTIFIER_CHAR_CLASS +
                             ']+(?:\\.[' + IDENTIFIER_CHAR_CLASS + ']+)?)', 'gi');
    var matched;
    while ((matched = pattern.exec(statement)) !== null) {
      var candidate = matched[1];
      if (tables[candidate] || tables[candidate.toUpperCase()]) return candidate;
      var bareName = candidate.split('.').pop();
      if (tables[bareName] || tables[bareName.toUpperCase()]) return bareName;
    }
    return '';
  }

  function hintClassNameForTable(views, tableName) {
    return views[String(tableName).toUpperCase()] ? 'CodeMirror-hint-view' : 'CodeMirror-hint-table';
  }

  function buildHintCandidates(editor, options) {
    var cursor = editor.getCursor();
    var prefixInfo = identifierPrefix(editor);
    var tables = (options && options.tables) || {};
    var views = editorState.hintViewsCache[
      metadataCacheKey(editorState.datasourceId, editorState.databaseName)] || {};
    var upperPrefix = prefixInfo.fragment.toUpperCase();
    var matchesPrefix = function (name) {
      return !upperPrefix || String(name).toUpperCase().indexOf(upperPrefix) === 0;
    };
    var candidates = [];

    if (prefixInfo.columnContext) {
      // ① `SCOTT.` → 该 schema 下的表（限定名走这里）
      var qualifier = prefixInfo.owner + '.';
      Object.keys(tables).forEach(function (dictKey) {
        if (dictKey.indexOf(qualifier) !== 0) return;
        var bareName = dictKey.slice(qualifier.length);
        if (bareName.indexOf('.') >= 0 || !matchesPrefix(bareName)) return;
        candidates.push({ text: qualifier + bareName,
                          className: hintClassNameForTable(views, dictKey) });
      });
      // ② `EMP.` / `e.` → 该表（或别名所指表）的列
      var reference = resolveTableReference(editor, prefixInfo.owner, tables);
      var entry = tables[reference] || tables[String(reference).toUpperCase()] ||
                  tables[prefixInfo.owner] || tables[prefixInfo.owner.toUpperCase()];
      ((entry && entry.columns) || []).forEach(function (columnName) {
        if (!matchesPrefix(columnName)) return;
        candidates.push({ text: prefixInfo.owner + '.' + columnName,
                          className: 'CodeMirror-hint-column' });
      });
      // 列还没拉到 → 给一条不可插入的占位提示，别让用户以为「点了没反应」
      var requestKey = metadataCacheKey(editorState.datasourceId, editorState.databaseName) +
                       '::' + String(reference).toUpperCase();
      var columnsLoading = !candidates.length && entry && (!entry.columns || !entry.columns.length) &&
                           editorState.columnRequestFlags[requestKey] === 'loading';
      if (columnsLoading) {
        candidates.push({
          text: '', displayText: i18nText('sql_editor.cols_loading', '正在读取字段…'),
          className: 'CodeMirror-hint-loading'
        });
      }
    } else {
      Object.keys(tables).forEach(function (dictKey) {
        if (dictKey.indexOf('.') >= 0) return;    // 限定名只在 `schema.` 上下文提示，避免重复
        if (!matchesPrefix(dictKey)) return;
        candidates.push({ text: dictKey, className: hintClassNameForTable(views, dictKey) });
      });
      var defaultTable = guessDefaultTable(editor, tables);
      if (defaultTable) {
        var defaultEntry = tables[defaultTable] || tables[String(defaultTable).toUpperCase()];
        ((defaultEntry && defaultEntry.columns) || []).forEach(function (columnName) {
          if (!matchesPrefix(columnName)) return;
          candidates.push({ text: columnName, className: 'CodeMirror-hint-column' });
        });
      }
      // 函数先于关键字：NVL / CAST / DECODE 既在关键字表里又在函数表里，
      // 先入为主按「函数」着色更贴合直觉
      builtinFunctionsOf(editorState.datasourceId).forEach(function (functionName) {
        if (!matchesPrefix(functionName)) return;
        candidates.push({ text: functionName, className: 'CodeMirror-hint-function' });
      });
      sqlKeywordsOf(editor).forEach(function (keyword) {
        if (!matchesPrefix(keyword)) return;
        candidates.push({ text: String(keyword).toUpperCase(), className: 'CodeMirror-hint-keyword' });
      });
    }

    var seen = {}, ordered = [];
    candidates.forEach(function (candidate) {
      var key = candidate.text.toUpperCase();
      if (!candidate.text || seen[key]) return;
      seen[key] = true;
      ordered.push(candidate);
    });
    // 排序：前缀命中优先 → 短名优先 → 字典序；再按上限截断
    ordered.sort(function (left, right) {
      var upperLeft = left.text.toUpperCase(), upperRight = right.text.toUpperCase();
      var leftMisses = (upperPrefix && upperLeft.indexOf(upperPrefix) !== 0) ? 1 : 0;
      var rightMisses = (upperPrefix && upperRight.indexOf(upperPrefix) !== 0) ? 1 : 0;
      if (leftMisses !== rightMisses) return leftMisses - rightMisses;
      if (upperLeft.length !== upperRight.length) return upperLeft.length - upperRight.length;
      return upperLeft < upperRight ? -1 : (upperLeft > upperRight ? 1 : 0);
    });
    if (ordered.length > HINT_MAX_ITEMS) ordered = ordered.slice(0, HINT_MAX_ITEMS);

    return {
      list: ordered,
      from: { line: cursor.line, ch: prefixInfo.fromColumn },
      to: { line: cursor.line, ch: cursor.ch }
    };
  }

  function objectAwareSqlHint(editor, options) {
    var result;
    try {
      result = buildHintCandidates(editor, options);
    } catch (failure) {
      console.warn('[SQL 编辑器] 提示引擎异常:', failure);
      result = { list: [], from: editor.getCursor(), to: editor.getCursor() };
    }
    // 语句里用到、但还没有列的表 → 后台补列（下一次提示就带上了）
    try {
      var tables = (options && options.tables) || {};
      var statementUpper = currentStatementOf(editor).toUpperCase();
      var missing = Object.keys(tables).filter(function (tableName) {
        if (tableName.indexOf('.') >= 0) return false;
        var entry = tables[tableName];
        if (entry && entry.columns && entry.columns.length) return false;
        return statementUpper.indexOf(tableName.toUpperCase()) >= 0;
      });
      if (missing.length) loadColumnsForTables(missing);
    } catch (ignore) { /* 补列失败不影响本次提示 */ }
    return result;
  }

  function buildHintOptions() {
    return {
      completeSingle: false,
      hint: objectAwareSqlHint,
      tables: {},
      // 必须开：否则提示框弹出后不会随输入重算候选（show-hint 只在构造时决定是否监听光标移动）
      align: true,
      closeCharacters: /[\s,;()\[\]{}'"`=<>\/]/
    };
  }

  function isHintBoxOpen(editor) {
    try { return !!(editor.state && editor.state.completionActive); } catch (ignore) { return false; }
  }

  function closeSqlHint() {
    var tab = activeTab();
    if (tab && tab.codeMirror && tab.codeMirror.state && tab.codeMirror.state.completionActive) {
      try { tab.codeMirror.state.completionActive.close(); } catch (ignore) { /* 已关闭 */ }
    }
  }

  function showSqlHint(editor, silent) {
    if (!editor) return;
    if (!editorState.datasourceId) {
      if (!silent) {
        notifyUser(i18nText('sql_editor.meta_no_ds', '未选择数据源：请点击左侧数据源以启用智能提示'), 'info');
      }
      return;
    }
    if (!metadataScopeReady()) {
      // 自动提示不拉「整实例」清单；只有用户主动按 Ctrl+Space 才按意图加载
      if (silent) {
        showDeferredMetadataStatus();
      } else {
        ensureObjectMetadata(false, true).then(function (loaded) {
          if (loaded && editor.hasFocus && editor.hasFocus()) showSqlHint(editor, true);
        });
      }
    }
    ensureMetadataForHints(editor);          // 只有真要用提示时才按需加载
    var options = buildHintOptions();
    options.tables = hintTablesFor(editorState.datasourceId, editorState.databaseName);
    try {
      editor.showHint(options);
    } catch (failure) {
      if (!silent) {
        notifyUser(i18nText('sql_editor.hint_fail', '智能提示不可用') + ': ' + briefError(failure && failure.message), 'error');
      }
    }
  }

  var autoHintTimer = null;

  function scheduleAutoHint(editor) {
    if (!editor || editor.autoHintBound) return;
    editor.autoHintBound = true;
    editor.on('inputRead', function (instanceArg) {
      if (!editorState.autoHintEnabled) return;
      if (isHintBoxOpen(instanceArg)) return;
      var cursor = instanceArg.getCursor();
      var lineBeforeCursor = (instanceArg.getLine(cursor.line) || '').slice(0, cursor.ch);
      if (!/[a-zA-Z_$#\u4e00-\u9fa5.]$/.test(lineBeforeCursor)) return;
      if (autoHintTimer) clearTimeout(autoHintTimer);
      autoHintTimer = setTimeout(function () {
        autoHintTimer = null;
        if (!editorState.autoHintEnabled || isHintBoxOpen(instanceArg)) return;
        showSqlHint(instanceArg, true);
      }, 260);
    });
  }

  function toggleAutoHint() {
    editorState.autoHintEnabled = !editorState.autoHintEnabled;
    var button = elementById('sql-btn-autohint');
    if (button) {
      button.classList.toggle('is-on', editorState.autoHintEnabled);
      button.title = editorState.autoHintEnabled
        ? i18nText('sql_editor.autohint_on', '自动提示：开（点击关闭）')
        : i18nText('sql_editor.autohint_off', '自动提示：关（点击开启）');
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  执行目标（库 / 用户 / 模式）
  // ══════════════════════════════════════════════════════════════
  function fillTargetSelect(select, values, currentValue, placeholder) {
    if (!select) return;
    var list = values || [];
    var html = '<option value="">' + escapeHtml(placeholder) + '</option>';
    list.forEach(function (value) {
      html += '<option value="' + escapeAttr(value) + '">' + escapeHtml(value) + '</option>';
    });
    select.innerHTML = html;
    select.value = (currentValue && list.indexOf(currentValue) >= 0) ? currentValue : '';
  }

  function refreshTargetSelectors() {
    var wrapper = elementById('sql-target');
    var databaseSelect = elementById('sql-target-db');
    var schemaSelect = elementById('sql-target-schema');
    var databaseLabel = elementById('sql-target-db-label');
    var schemaLabel = elementById('sql-target-schema-label');
    if (!wrapper) return;
    if (!editorState.datasourceId) { wrapper.style.display = 'none'; return; }
    wrapper.style.display = 'inline-flex';

    var shape = targetShapeOf(datasourceTypeOf(editorState.datasourceId));
    if (databaseLabel) databaseLabel.textContent = shape.label;
    wrapper.title = shape.tip || '';
    if (schemaLabel) schemaLabel.style.display = shape.showSchema ? '' : 'none';
    if (schemaSelect) schemaSelect.style.display = shape.showSchema ? '' : 'none';

    var datasourceKey = String(editorState.datasourceId);
    if (editorState.targetDatabasesCache[datasourceKey]) {
      fillTargetSelect(databaseSelect, editorState.targetDatabasesCache[datasourceKey],
                       editorState.databaseName, i18nText('sql_editor.target_unset', '（未指定）'));
    } else if (databaseSelect) {
      databaseSelect.innerHTML = '<option value="">' +
        escapeHtml(i18nText('sql_editor.loading', '加载中...')) + '</option>';
      httpGet('/api/pro/datasources/' + encodeURIComponent(editorState.datasourceId) + '/databases')
        .then(function (payload) {
          editorState.targetDatabasesCache[datasourceKey] = payload.databases || [];
          if (String(editorState.datasourceId) === datasourceKey) refreshTargetSelectors();
        })
        .catch(function (failure) {
          editorState.targetDatabasesCache[datasourceKey] = [];
          fillTargetSelect(databaseSelect, [], '',
                           i18nText('sql_editor.target_fetch_fail', '（获取失败）') + ': ' +
                           briefError(failure && failure.message));
        });
    }

    if (!shape.showSchema) { editorState.schemaName = ''; return; }
    var schemaKey = datasourceKey + '||' + (editorState.databaseName || '');
    if (editorState.targetSchemasCache[schemaKey]) {
      fillTargetSelect(schemaSelect, editorState.targetSchemasCache[schemaKey], editorState.schemaName,
                       i18nText('sql_editor.target_default', '（默认）'));
    } else if (schemaSelect) {
      schemaSelect.innerHTML = '<option value="">' +
        escapeHtml(i18nText('sql_editor.loading', '加载中...')) + '</option>';
      httpGet('/api/pro/datasources/' + encodeURIComponent(editorState.datasourceId) +
              '/schemas?database=' + encodeURIComponent(editorState.databaseName || ''))
        .then(function (payload) {
          editorState.targetSchemasCache[schemaKey] = payload.schemas || [];
          if (String(editorState.datasourceId) === datasourceKey) refreshTargetSelectors();
        })
        .catch(function () {
          editorState.targetSchemasCache[schemaKey] = [];
          if (schemaSelect) {
            schemaSelect.innerHTML = '<option value="">' +
              escapeHtml(i18nText('sql_editor.target_fetch_fail', '（获取失败）')) + '</option>';
          }
        });
    }
  }

  function onTargetChange(changedField) {
    if (changedField === 'schema') {
      editorState.schemaName = (elementById('sql-target-schema') || {}).value || '';
    } else {
      editorState.databaseName = (elementById('sql-target-db') || {}).value || '';
      editorState.schemaName = '';
      editorState.treeNodeType = editorState.databaseName ? 'db' : 'ds';
      refreshTargetSelectors();
      ensureObjectMetadata(false);
    }
    syncContextToTab();
    saveEditorContext();
    var hintEl = elementById('sql-curr-ds');
    if (hintEl && editorState.datasourceId) {
      var text = TREE_ICON + ' ' + (datasourceNameOf(editorState.datasourceId) || ('DS#' + editorState.datasourceId));
      if (editorState.databaseName) text += ' › ' + editorState.databaseName;
      if (editorState.schemaName) text += ' › ' + editorState.schemaName;
      hintEl.textContent = text;
    }
  }

  function saveEditorContext() {
    try {
      if (!editorState.datasourceId) { localStorage.removeItem(CONTEXT_STORAGE_KEY); return; }
      localStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify({
        datasourceId: String(editorState.datasourceId),
        databaseName: editorState.databaseName || '',
        schemaName: editorState.schemaName || '',
        treeNodeType: editorState.treeNodeType || 'ds'
      }));
    } catch (ignore) { /* 隐私模式 / 存储不可用：丢了就丢了 */ }
  }

  function restoreEditorContext() {
    try {
      var raw = localStorage.getItem(CONTEXT_STORAGE_KEY);
      if (!raw) return false;
      var stored = JSON.parse(raw);
      if (!stored || !stored.datasourceId) return false;
      // 数据源已被删掉 / 不再可见时不要恢复（列表里没有它的类型记录）
      if (!editorState.datasourceTypes[String(stored.datasourceId)]) return false;
      if (editorState.datasourceId) return true;               // 用户已手动选过 → 不覆盖
      editorState.datasourceId = String(stored.datasourceId);
      editorState.databaseName = stored.databaseName || '';
      editorState.schemaName = stored.schemaName || '';
      editorState.treeNodeType = stored.treeNodeType || 'ds';
      return true;
    } catch (ignore) { return false; }
  }

  // ══════════════════════════════════════════════════════════════
  //  对象树
  // ══════════════════════════════════════════════════════════════
  function loadDatasourceTree() {
    var body = elementById('sql-tree-body');
    if (!body) return;
    body.innerHTML = '<div class="sql-tree-loading">' +
                     escapeHtml(i18nText('sql_editor.loading', '加载中...')) + '</div>';
    httpGet('/api/pro/datasources').then(function (payload) {
      var list = (payload && (payload.datasources || payload.data || payload.instances)) || [];
      editorState.datasources = list;
      list.forEach(function (datasource) {
        if (datasource && datasource.id != null) {
          editorState.datasourceTypes[String(datasource.id)] = normalizeDbType(datasource.db_type);
        }
      });
      if (!list.length) {
        body.innerHTML = '<div class="sql-tree-loading">' +
          escapeHtml(i18nText('sql_editor.tree_empty', '暂无数据源，请先在「数据源管理」中添加')) + '</div>';
        return;
      }
      renderDatasourceTree();
      if (restoreEditorContext()) {
        syncContextToTab();              // 恢复出来的目标要带到当前执行窗口
        applyTabContext(activeTab());
        refreshMetadataStatus();         // 只恢复「目标」，字典等真正要用提示时再拉
      }
    }).catch(function (failure) {
      showTreeRetry(body, failure);
    });
  }

  // 树加载失败/超时：给一个明确的重试入口，而不是停在「加载中...」或一行红字
  function showTreeRetry(body, failure) {
    var reason = briefError(failure && failure.message || failure);
    body.innerHTML = '<div class="sql-tree-error">' +
      '<div class="sql-tree-error-msg">' +
      escapeHtml(i18nText('sql_editor.tree_fail', '加载失败') + ': ' + reason) + '</div>' +
      '<button type="button" class="btn btn-ghost btn-xs" onclick="FusionSqlEditor.reloadTree()">' +
      escapeHtml(i18nText('sql_editor.retry', '重试')) + '</button></div>';
  }

  function datasourceMatchesKeyword(datasource, keyword) {
    if (!keyword) return true;
    var haystack = [datasource.name, datasource.host, datasource.port, datasource.db_type,
                    datasource.labels, datasource.dir_name, datasource.dir_path]
                     .filter(Boolean).join(' ').toLowerCase();
    return haystack.indexOf(keyword) >= 0;
  }

  // ── 目录层次（数据源管理里绑定到哪个目录，这里就挂在哪个目录下）────────
  // dir_path 形如「上海机房/浦东」，按 '/' 拆成层级；没有目录的归到「未分配」。
  var UNASSIGNED_DIRECTORY_NAME = '未分配';

  function datasourceDirectoryPath(datasource) {
    return String((datasource && datasource.dir_path) || '').trim();
  }

  function buildDatasourceDirectoryTree(datasources, keyword) {
    var root = { name: '', path: '', children: {}, datasources: [] };
    (datasources || []).forEach(function (datasource) {
      var directoryPath = datasourceDirectoryPath(datasource);
      var nameMatched = datasourceMatchesKeyword(datasource, keyword);
      // 搜的是目录名时，整个目录下的数据源都要留下
      var directoryMatched = !!(keyword && directoryPath.toLowerCase().indexOf(keyword) >= 0);
      if (!nameMatched && !directoryMatched) return;
      var directoryNode = root;
      directoryPath.split('/').forEach(function (segment) {
        var segmentName = segment.trim();
        if (!segmentName) return;
        if (!directoryNode.children[segmentName]) {
          directoryNode.children[segmentName] = {
            name: segmentName,
            path: directoryNode.path ? directoryNode.path + '/' + segmentName : segmentName,
            children: {},
            datasources: []
          };
        }
        directoryNode = directoryNode.children[segmentName];
      });
      directoryNode.datasources.push(datasource);
    });
    return root;
  }

  function datasourceNodeHtml(datasource) {
    var label = datasource.name || (datasource.host + ':' + datasource.port);
    var typeLabel = normalizeDbType(datasource.db_type);
    return '<div class="sql-tree-node" data-type="ds" data-ds-id="' + escapeAttr(datasource.id) + '">' +
           '  <span class="tree-toggle">▶</span>' +
           '  <span class="tree-icon">' + TREE_ICON + '</span>' +
           '  <span class="tree-label">' + escapeHtml(label) +
           '     <small style="color:var(--text-muted)">(' + escapeHtml(typeLabel) + ')</small></span>' +
           '</div>' +
           '<div class="sql-tree-children"></div>';
  }

  // 目录节点 + 它的子层容器（子目录在前、数据源在后；默认展开，一眼能看到层次）
  function directoryBlockHtml(directoryNode) {
    return '<div class="sql-tree-node sql-tree-dir" data-type="dir" data-dir-path="' +
           escapeAttr(directoryNode.path) + '">' +
           '  <span class="tree-toggle expanded">▶</span>' +
           '  <span class="tree-icon">' + FOLDER_ICON + '</span>' +
           '  <span class="tree-label">' + escapeHtml(directoryNode.name) + '</span>' +
           '</div>' +
           '<div class="sql-tree-children expanded">' + directoryContentsHtml(directoryNode) + '</div>';
  }

  function directoryContentsHtml(directoryNode) {
    var html = '';
    Object.keys(directoryNode.children).sort(function (leftName, rightName) {
      return leftName.localeCompare(rightName);
    }).forEach(function (name) {
      html += directoryBlockHtml(directoryNode.children[name]);
    });
    directoryNode.datasources.slice()
      .sort(function (left, right) {
        return String(left.name || '').localeCompare(String(right.name || ''));
      })
      .forEach(function (datasource) {
        html += datasourceNodeHtml(datasource);
      });
    return html;
  }

  function renderDatasourceTree() {
    var body = elementById('sql-tree-body');
    if (!body) return;
    var keyword = (editorState.treeKeyword || '').trim().toLowerCase();
    var directoryTree = buildDatasourceDirectoryTree(editorState.datasources, keyword);
    var html = '';
    Object.keys(directoryTree.children).sort(function (leftName, rightName) {
      return leftName.localeCompare(rightName);
    }).forEach(function (name) {
      html += directoryBlockHtml(directoryTree.children[name]);
    });
    if (directoryTree.datasources.length) {
      // 没有绑定目录的数据源单独收在一组，避免和真实目录混排
      html += directoryBlockHtml({
        name: UNASSIGNED_DIRECTORY_NAME, path: '', children: {},
        datasources: directoryTree.datasources
      });
    }
    body.innerHTML = html || ('<div class="sql-tree-loading">' +
      escapeHtml(i18nText('sql_editor.tree_no_match', '没有匹配的数据源')) + '</div>');
  }

  function toggleDirectoryNode(node) {
    var container = childrenContainerOf(node);
    if (container) toggleContainer(container, node.querySelector('.tree-toggle'));
  }

  // 子层容器就是节点的下一个兄弟元素：名字里带引号 / 特殊字符也不会选错
  function childrenContainerOf(node) {
    var sibling = node && node.nextElementSibling;
    return (sibling && sibling.classList.contains('sql-tree-children')) ? sibling : null;
  }

  // 展开 / 收起一个数据源或库节点，第一次展开时才去拉子层（懒加载）
  function expandOrCollapseNode(node, toggle) {
    var container = childrenContainerOf(node);
    var nodeType = node.getAttribute('data-type');
    if (!container || !toggle || (nodeType !== 'ds' && nodeType !== 'db')) return;
    if (container.childNodes.length) { toggleContainer(container, toggle); return; }
    toggleContainer(container, toggle);
    showContainerLoading(container);
    if (nodeType === 'ds') {
      loadDatabasesOfDatasource(container, node.getAttribute('data-ds-id'));
    } else {
      loadObjectsOfDatabase(container, node.getAttribute('data-ds-id'),
                            node.getAttribute('data-db') || '');
    }
  }

  function toggleContainer(container, toggleElement) {
    var expanded = container.classList.toggle('expanded');
    if (toggleElement) toggleElement.classList.toggle('expanded', expanded);
    return expanded;
  }

  function showContainerLoading(container) {
    container.innerHTML = '<div class="sql-tree-loading">' +
                          escapeHtml(i18nText('sql_editor.loading', '加载中...')) + '</div>';
  }

  function showContainerMessage(container, text, isError) {
    container.innerHTML = '<div class="sql-tree-loading"' +
      (isError ? ' style="color:var(--danger)"' : '') + '>' + escapeHtml(text) + '</div>';
  }

  // 后端把库/对象名单缓存 120s，正常展开都走缓存；只有用户主动点「刷新」才带 refresh=1 穿透
  function treeUrl(datasourceId, suffix, query, forceRefresh) {
    var url = '/api/pro/datasources/' + encodeURIComponent(datasourceId) + '/' + suffix +
              (query || '');
    return forceRefresh ? url + (url.indexOf('?') >= 0 ? '&' : '?') + 'refresh=1' : url;
  }

  function loadDatabasesOfDatasource(container, datasourceId, forceRefresh) {
    httpGet(treeUrl(datasourceId, 'databases', '', forceRefresh))
      .then(function (payload) {
        if (payload.error) { showContainerMessage(container, payload.error, true); return; }
        var list = payload.databases || [];
        editorState.targetDatabasesCache[String(datasourceId)] = list;   // 顺带喂给执行目标下拉
        if (!list.length) {
          showContainerMessage(container, i18nText('sql_editor.tree_no_db', '无数据库'), false);
          return;
        }
        var html = '';
        list.forEach(function (databaseName) {
          html += '<div class="sql-tree-node" data-type="db" data-ds-id="' + escapeAttr(datasourceId) +
                  '" data-db="' + escapeAttr(databaseName) + '">' +
                  '  <span class="tree-toggle">▶</span><span class="tree-icon">' + DATABASE_ICON + '</span>' +
                  '  <span class="tree-label">' + escapeHtml(databaseName) + '</span></div>' +
                  '<div class="sql-tree-children"></div>';
        });
        container.innerHTML = html;
      })
      .catch(function (failure) {
        showContainerMessage(container,
          i18nText('sql_editor.tree_fail', '加载失败') + ': ' + briefError(failure && failure.message), true);
      });
  }

  function loadObjectsOfDatabase(container, datasourceId, databaseName, forceRefresh) {
    httpGet(treeUrl(datasourceId, 'objects',
                    '?database=' + encodeURIComponent(databaseName), forceRefresh))
      .then(function (payload) {
        if (payload.error) { showContainerMessage(container, payload.error, true); return; }
        var html = '';
        (payload.tables || []).forEach(function (tableName) {
          html += objectNodeHtml('table', TABLE_ICON, datasourceId, databaseName, tableName);
        });
        (payload.views || []).forEach(function (viewName) {
          html += objectNodeHtml('view', VIEW_ICON, datasourceId, databaseName, viewName);
        });
        if (html) container.innerHTML = html;
        else showContainerMessage(container, i18nText('sql_editor.tree_no_obj', '无对象'), false);
      })
      .catch(function (failure) {
        showContainerMessage(container,
          i18nText('sql_editor.tree_fail', '加载失败') + ': ' + briefError(failure && failure.message), true);
      });
  }

  function objectNodeHtml(nodeType, icon, datasourceId, databaseName, objectName) {
    return '<div class="sql-tree-node leaf" data-type="' + nodeType + '" data-ds-id="' +
           escapeAttr(datasourceId) + '" data-db="' + escapeAttr(databaseName) +
           '" data-name="' + escapeAttr(objectName) + '">' +
           '  <span class="tree-toggle leaf">•</span><span class="tree-icon">' + icon + '</span>' +
           '  <span class="tree-label">' + escapeHtml(objectName) + '</span></div>';
  }

  function selectTreeNode(node) {
    document.querySelectorAll('#sql-tree-body .sql-tree-node.selected')
      .forEach(function (other) { other.classList.remove('selected'); });
    node.classList.add('selected');
    var nodeType = node.getAttribute('data-type');
    var datasourceId = node.getAttribute('data-ds-id');
    var databaseName = node.getAttribute('data-db') || '';
    var objectName = node.getAttribute('data-name') ||
                     ((node.querySelector('.tree-label') || {}).textContent || '').trim();
    editorState.datasourceId = String(datasourceId);
    editorState.treeNodeType = nodeType;
    editorState.databaseName = nodeType === 'ds' ? '' : databaseName;
    editorState.schemaName = '';

    var hintEl = elementById('sql-curr-ds');
    if (hintEl) {
      var text = TREE_ICON + ' ' + (datasourceNameOf(datasourceId) || ('DS#' + datasourceId));
      if (nodeType !== 'ds' && databaseName) text += ' › ' + databaseName;
      if (nodeType === 'table' || nodeType === 'view') text += ' › ' + objectName;
      hintEl.textContent = text;
    }
    syncContextToTab();
    saveEditorContext();
    refreshTargetSelectors();
    // 选中节点只改范围，不预拉字典：选中数据源=还没定库，选中库=等输入/按 Ctrl+Space 再拉
    refreshMetadataStatus();
  }

  function bindTreeEvents() {
    var body = elementById('sql-tree-body');
    if (!body || body.eventsBound) return;
    body.eventsBound = true;

    body.addEventListener('click', function (event) {
      var node = event.target.closest ? event.target.closest('.sql-tree-node') : null;
      if (!node) return;
      // 目录节点只负责展开/收起：它代表的是「数据源分组」，不是执行目标
      if (node.getAttribute('data-type') === 'dir') {
        toggleDirectoryNode(node);
        event.preventDefault();
        return;
      }
      selectTreeNode(node);
      // 旧版习惯：点数据源 / 库这一行（文字或 ▶ 都一样）就展开或收起它的子层；
      // 表、视图是叶子节点，只选中不展开。
      var toggle = node.querySelector('.tree-toggle');
      if (toggle && !toggle.classList.contains('leaf')) {
        expandOrCollapseNode(node, toggle);
        event.preventDefault();
      }
    });

    body.addEventListener('dblclick', function (event) {
      var node = event.target.closest ? event.target.closest('.sql-tree-node') : null;
      if (!node) return;
      var nodeType = node.getAttribute('data-type');
      if (nodeType === 'table' || nodeType === 'view') insertNodeNameIntoEditor(node);
    });

    body.addEventListener('contextmenu', function (event) {
      var node = event.target.closest ? event.target.closest('.sql-tree-node') : null;
      if (!node) return;
      event.preventDefault();
      openTreeContextMenu(event, node);
    });
  }

  function filterDatasourceTree(keyword) {
    editorState.treeKeyword = keyword || '';
    renderDatasourceTree();
  }

  // ── 限定名 / Top-N / 表属性 ──────────────────────────────────
  // 生成什么写法完全由方言决定（单一真源，双击插入与 Top-N 都复用它）：
  //   Oracle / 达梦 / 崖山 → OWNER.TABLE（大写，树里的「数据库」维度就是 owner）
  //   MySQL / TiDB / OceanBase / GBase → `库`.`表`（库即模式）
  //   PG 系 → schema.table（树里的裸名默认属于 public）
  //   SQL Server → [schema].[表]（dbo 的表在树里就是裸名，故不加前缀）
  function qualifiedObjectName(dbType, databaseName, rawObjectName) {
    var objectName = String(rawObjectName || '');
    if (!objectName) return '';
    var plainIdentifier = /^[A-Za-z_][A-Za-z0-9_$#]*$/;
    var normalized = normalizeDbType(dbType);
    var dialectGroup = 'pg';
    if (['mysql', 'tidb', 'mariadb', 'oceanbase', 'tdsqlc_mysql', 'gbase'].indexOf(normalized) >= 0) {
      dialectGroup = 'mysql_like';
    } else if (normalized === 'sqlserver') {
      dialectGroup = 'sqlserver';
    } else if (normalized === 'oracle' || normalized === 'dm' || normalized === 'yashandb') {
      dialectGroup = 'oracle_like';
    } else if (normalized === 'clickhouse') {
      dialectGroup = 'clickhouse';
    }

    function quoteIdentifier(part) {
      if (plainIdentifier.test(part)) {
        // Oracle 系不区分大小写的裸标识符统一大写（树中 owner/表名均为大写）
        return dialectGroup === 'oracle_like' ? part.toUpperCase() : part;
      }
      if (dialectGroup === 'mysql_like' || dialectGroup === 'clickhouse') {
        return '`' + part.replace(/`/g, '``') + '`';
      }
      if (dialectGroup === 'sqlserver') return '[' + part.replace(/\]/g, ']]') + ']';
      return '"' + part.replace(/"/g, '""') + '"';
    }

    var parts = objectName.split('.');
    if (dialectGroup === 'oracle_like' || dialectGroup === 'mysql_like' || dialectGroup === 'clickhouse') {
      if (databaseName && parts.length < 2) parts = [databaseName, objectName];
    } else if (dialectGroup === 'pg') {
      if (parts.length < 2) parts = ['public', objectName];
    }
    return parts.map(quoteIdentifier).join('.');
  }

  function buildTopNQuery(dbType, databaseName, objectName, limit) {
    var qualified = qualifiedObjectName(dbType, databaseName, objectName);
    if (!qualified) return '';
    var normalized = normalizeDbType(dbType);
    if (normalized === 'oracle' || normalized === 'dm' || normalized === 'yashandb') {
      return 'SELECT * FROM ' + qualified + ' WHERE ROWNUM <= ' + limit;
    }
    if (normalized === 'sqlserver') return 'SELECT TOP ' + limit + ' * FROM ' + qualified;
    return 'SELECT * FROM ' + qualified + ' LIMIT ' + limit;
  }

  function insertTextAtCursor(text) {
    var tab = activeTab();
    if (!tab || !text) return false;
    if (tab.codeMirror) {
      var cursor = tab.codeMirror.getCursor();
      tab.codeMirror.replaceRange(text, cursor);
      tab.codeMirror.setCursor({ line: cursor.line, ch: cursor.ch + text.length });
      tab.codeMirror.focus();
      return true;
    }
    var textarea = tab.textareaEl;
    if (!textarea) return false;
    var from = textarea.selectionStart || 0, to = textarea.selectionEnd || 0;
    var value = String(textarea.value || '');
    textarea.value = value.slice(0, from) + text + value.slice(to);
    textarea.selectionStart = textarea.selectionEnd = from + text.length;
    textarea.focus();
    return true;
  }

  function nodeObjectName(node) {
    return node.getAttribute('data-name') ||
           ((node.querySelector('.tree-label') || {}).textContent || '').trim();
  }

  function insertNodeNameIntoEditor(node) {
    var objectName = nodeObjectName(node);
    if (!objectName) return;
    var qualified = qualifiedObjectName(datasourceTypeOf(node.getAttribute('data-ds-id')),
                                        node.getAttribute('data-db') || '', objectName);
    insertTextAtCursor(qualified || objectName);
  }

  // 右键「查询前 N 行」：每开一个表即新建一个执行窗口（以表名命名），填入 SQL 并自动执行
  function runTopNQuery(node, limit) {
    var datasourceId = node.getAttribute('data-ds-id');
    var databaseName = node.getAttribute('data-db') || '';
    var nodeType = node.getAttribute('data-type') || 'table';
    var objectName = nodeObjectName(node);
    if (!datasourceId || !objectName) return;
    var query = buildTopNQuery(datasourceTypeOf(datasourceId), databaseName, objectName, limit);
    if (!query) {
      notifyUser(i18nText('sql_editor.topn_fail', '无法生成查询语句'), 'error');
      return;
    }
    var tab = addEditorTab({ name: objectName, sql: query });
    if (!tab) return;
    editorState.datasourceId = String(datasourceId);
    editorState.databaseName = databaseName;
    editorState.schemaName = '';
    editorState.treeNodeType = nodeType;
    var hintEl = elementById('sql-curr-ds');
    if (hintEl) {
      hintEl.textContent = TREE_ICON + ' ' + (datasourceNameOf(datasourceId) || ('DS#' + datasourceId)) +
                           ' › ' + (databaseName ? databaseName + '.' : '') + objectName;
    }
    syncContextToTab(tab);
    refreshTargetSelectors();
    saveEditorContext();
    // 程序自动执行（非用户点击）→ 强制跑整条语句，避免多行 SQL 只跑了第一行
    executeActiveSql({ wholeContentOnly: true });
  }

  // ── 右键菜单（不透明 / 可拖动 / 可缩放，沿用旧版习惯）──
  var contextMenuElement = null;

  function hideTreeContextMenu() {
    if (contextMenuElement && contextMenuElement.parentNode) {
      contextMenuElement.parentNode.removeChild(contextMenuElement);
    }
    contextMenuElement = null;
    document.removeEventListener('mousedown', closeMenuOnOutsideMouseDown, true);
    document.removeEventListener('keydown', closeMenuOnEscape, true);
  }

  function closeMenuOnOutsideMouseDown(event) {
    if (contextMenuElement && !contextMenuElement.contains(event.target)) hideTreeContextMenu();
  }

  function closeMenuOnEscape(event) { if (event.key === 'Escape') hideTreeContextMenu(); }

  function openTreeContextMenu(event, node) {
    hideTreeContextMenu();
    var nodeType = node.getAttribute('data-type');
    var actions = [];
    if (nodeType === 'dir') {
      // 目录节点只有一个动作：展开 / 收起（它不连库，没有可刷新的东西）
      actions.push({ icon: SVG_REFRESH, label: i18nText('sql_editor.ctx_toggle_dir', '展开 / 收起'),
                     run: function () { toggleDirectoryNode(node); } });
    } else {
      if (nodeType === 'table' || nodeType === 'view') {
        actions.push({ icon: SVG_INSERT, label: i18nText('sql_editor.ctx_insert', '插入到光标处'),
                       run: function () { insertNodeNameIntoEditor(node); } });
        actions.push({ separator: true });
        [100, 200].forEach(function (limit) {
          actions.push({ icon: SVG_QUERY,
                         label: i18nText('sql_editor.ctx_topn', '查询前 N 行').replace('N', limit),
                         run: function () { runTopNQuery(node, limit); } });
        });
        actions.push({ separator: true });
        actions.push({ icon: SVG_PROPERTIES, label: i18nText('sql_editor.ctx_table_info', '查看表属性'),
                       run: function () { showTableProperties(node); } });
      }
      actions.push({ icon: SVG_REFRESH, label: i18nText('sql_editor.ctx_refresh', '刷新该节点'),
                     run: function () { refreshTreeNode(node); } });
    }

    var menu = document.createElement('div');
    menu.className = 'sql-ctx-menu';
    var html = '<div class="sql-ctx-grip" title="' +
               escapeAttr(i18nText('sql_editor.ctx_drag', '拖动移动')) + '">⠿</div><div class="sql-ctx-list">';
    actions.forEach(function (action, index) {
      if (action.separator) { html += '<div class="sql-ctx-sep"></div>'; return; }
      html += '<div class="sql-ctx-item" data-action-index="' + index + '">' +
              '  <span class="sql-ctx-ico">' + (action.icon || '') + '</span>' +
              '  <span>' + escapeHtml(action.label) + '</span></div>';
    });
    html += '</div><div class="sql-ctx-resize" title="' +
            escapeAttr(i18nText('sql_editor.ctx_resize', '拖动缩放')) + '">◢</div>';
    menu.innerHTML = html;
    document.body.appendChild(menu);
    contextMenuElement = menu;

    var viewportWidth = window.innerWidth - menu.offsetWidth - 8;
    var viewportHeight = window.innerHeight - menu.offsetHeight - 8;
    menu.style.left = Math.max(4, Math.min(event.clientX, viewportWidth)) + 'px';
    menu.style.top = Math.max(4, Math.min(event.clientY, viewportHeight)) + 'px';

    menu.addEventListener('click', function (event2) {
      var item = event2.target.closest ? event2.target.closest('.sql-ctx-item') : null;
      if (!item) return;
      var action = actions[Number(item.getAttribute('data-action-index'))];
      hideTreeContextMenu();
      if (action && action.run) action.run();
    });
    bindContextMenuDrag(menu);
    document.addEventListener('mousedown', closeMenuOnOutsideMouseDown, true);
    document.addEventListener('keydown', closeMenuOnEscape, true);
  }

  function bindContextMenuDrag(menu) {
    var grip = menu.querySelector('.sql-ctx-grip');
    var resizeHandle = menu.querySelector('.sql-ctx-resize');
    if (grip) {
      grip.addEventListener('mousedown', function (event) {
        event.preventDefault();
        var startX = event.clientX, startY = event.clientY;
        var originLeft = menu.offsetLeft, originTop = menu.offsetTop;
        dragUntilMouseUp(function (moveEvent) {
          menu.style.left = (originLeft + moveEvent.clientX - startX) + 'px';
          menu.style.top = (originTop + moveEvent.clientY - startY) + 'px';
        });
      });
    }
    if (resizeHandle) {
      resizeHandle.addEventListener('mousedown', function (event) {
        event.preventDefault();
        var startX = event.clientX, startY = event.clientY;
        var originWidth = menu.offsetWidth, originHeight = menu.offsetHeight;
        dragUntilMouseUp(function (moveEvent) {
          // 尺寸用「算出来的值」自己夹紧，不要回读 offsetHeight：菜单里还嵌着列表，
          // 回读会形成 高度→maxHeight→高度 的自我放大（实测一次拖动就窜到 4000+ px）。
          var width = Math.min(window.innerWidth - 16,
                               Math.max(160, originWidth + moveEvent.clientX - startX));
          var height = Math.min(window.innerHeight - 16,
                                Math.max(80, originHeight + moveEvent.clientY - startY));
          menu.style.width = width + 'px';
          menu.style.height = height + 'px';
          var list = menu.querySelector('.sql-ctx-list');
          if (list) list.style.maxHeight = Math.max(40, height - 26) + 'px';
        });
      });
    }
  }

  // 通用「拖动到鼠标松开为止」：右键菜单的移动与缩放都用它。
  // 起点坐标由调用方自己记（移动和缩放的口径不同），这里只负责挂/摘监听。
  function dragUntilMouseUp(onMove) {
    var moveHandler = function (moveEvent) { onMove(moveEvent); };
    var upHandler = function () {
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
    };
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
  }

  function refreshTreeNode(node) {
    var nodeType = node.getAttribute('data-type');
    var datasourceId = node.getAttribute('data-ds-id');
    var cacheKey = metadataCacheKey(datasourceId, editorState.databaseName);
    if (nodeType === 'dir') {                       // 目录只是分组：只切换展开状态
      toggleDirectoryNode(node);
      return;
    }
    if (nodeType === 'ds') {
      delete editorState.targetDatabasesCache[String(datasourceId)];
      delete editorState.metadataCache[metadataCacheKey(datasourceId, '')];
      delete editorState.hintTablesCache[metadataCacheKey(datasourceId, '')];
      delete editorState.hintViewsCache[metadataCacheKey(datasourceId, '')];
      // 只重刷这个数据源下面的库列表（带 refresh=1 穿透后端 120s 缓存）。
      // 不要 loadDatasourceTree() —— 那会把整棵树连用户展开的其它节点一起清掉，
      // 而且数据源列表本身是 5ms 的本地数据，跟「刷新库清单」不是一回事。
      var dsContainer = childrenContainerOf(node);
      if (dsContainer) {
        // 保持展开状态，只换内容：走 expandOrCollapseNode 会把「已展开」再翻成收起
        dsContainer.classList.add('expanded');
        var dsToggle = node.querySelector('.tree-toggle');
        if (dsToggle) dsToggle.classList.add('expanded');
        showContainerLoading(dsContainer);
        loadDatabasesOfDatasource(dsContainer, datasourceId, true);
      }
      if (String(editorState.datasourceId) === String(datasourceId) &&
          !editorState.databaseName) ensureObjectMetadata(true);
      return;
    }
    if (nodeType === 'db') {
      var databaseName = node.getAttribute('data-db') || '';
      var container = childrenContainerOf(node);
      if (container) {
        showContainerLoading(container);
        loadObjectsOfDatabase(container, datasourceId, databaseName, true);
      }
      var dbCacheKey = metadataCacheKey(datasourceId, databaseName);
      delete editorState.metadataCache[dbCacheKey];
      delete editorState.hintTablesCache[dbCacheKey];
      delete editorState.hintViewsCache[dbCacheKey];
      delete editorState.columnUpgradeTried[dbCacheKey];
      if (String(editorState.datasourceId) === String(datasourceId) &&
          (editorState.databaseName || '') === databaseName) ensureObjectMetadata(true);
      return;
    }
    // 表/视图：清掉该对象的按需补列标记，重新拉一次列
    var objectName = node.getAttribute('data-name') || '';
    delete editorState.columnRequestFlags[cacheKey + '::' + String(objectName).toUpperCase()];
    delete editorState.metadataCache[cacheKey];
    delete editorState.hintTablesCache[cacheKey];
    delete editorState.hintViewsCache[cacheKey];
    if (String(editorState.datasourceId) === String(datasourceId)) ensureObjectMetadata(true);
  }

  // ── 表属性弹窗 ───────────────────────────────────────────────
  function formatByteSize(bytes) {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return '—';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var unitIndex = 0, value = Number(bytes);
    while (value >= 1024 && unitIndex < units.length - 1) { value /= 1024; unitIndex += 1; }
    return (unitIndex === 0 ? value : value.toFixed(2)) + ' ' + units[unitIndex];
  }

  function showTableProperties(node) {
    var datasourceId = node.getAttribute('data-ds-id');
    var databaseName = node.getAttribute('data-db') || '';
    var objectName = nodeObjectName(node);
    var modal = elementById('sql-ti-modal');
    var body = elementById('sql-ti-body');
    var title = elementById('sql-ti-title');
    if (!modal || !body || !datasourceId || !objectName) return;
    title.textContent = '📄 ' + i18nText('sql_editor.props_title', '表属性') + ' · ' + objectName;
    body.innerHTML = '<div class="sql-tree-loading" style="padding:8px;">' +
                     escapeHtml(i18nText('sql_editor.props_loading', '正在读取表属性…')) + '</div>';
    modal.style.display = 'flex';
    httpGet('/api/pro/datasources/' + encodeURIComponent(datasourceId) + '/table-info?database=' +
            encodeURIComponent(databaseName) + '&table=' + encodeURIComponent(objectName))
      .then(function (payload) {
        if (payload.error) {
          body.innerHTML = '<div class="ti-err">' + escapeHtml(
            i18nText('sql_editor.props_failed', '读取表属性失败：{e}')
              .replace('{e}', payload.error)) + '</div>';
          return;
        }
        if (payload.supported === false) {
          body.innerHTML = '<div class="ti-err">' + escapeHtml(
            payload.error || i18nText('sql_editor.props_unsupported', '该数据库类型暂不支持查看表属性')) + '</div>';
          return;
        }
        renderTableInfo(payload, objectName);
      })
      .catch(function (failure) {
        body.innerHTML = '<div class="ti-err">' + escapeHtml(
          i18nText('sql_editor.props_failed', '读取表属性失败：{e}')
            .replace('{e}', briefError(failure && failure.message))) + '</div>';
      });
  }

  function closeTableInfoModal() {
    var modal = elementById('sql-ti-modal');
    if (modal) modal.style.display = 'none';
  }

  // ── CLOB / BLOB 内容查看（双击结果格里带标记的单元格，PL/SQL Developer 习惯）──
  function openLobViewer(lobType, content) {
    var modal = elementById('sql-lob-modal');
    var title = elementById('sql-lob-title');
    var body = elementById('sql-lob-content');
    var meta = elementById('sql-lob-meta');
    if (!modal || !body) return;
    // 挂到 <body> 下：本页有 container-type: inline-size（会建立 stacking context
    // + 当 fixed 后代的包含块），留在页内时 z-index 再高也压不住「结果区整屏」那层，
    // 表现出来就是「双击了但看不到窗口」。
    if (modal.parentNode !== document.body) document.body.appendChild(modal);
    var text = content === null || content === undefined ? '' : String(content);
    if (title) {
      title.textContent = (lobType || 'LOB') + ' · ' + i18nText('sql_editor.lob_title', '内容');
    }
    body.textContent = text;
    body.scrollTop = 0;
    if (meta) {
      meta.textContent = text
        ? i18nText('sql_editor.lob_meta', '{n} 个字符').replace('{n}', text.length)
        : i18nText('sql_editor.lob_empty', '（空）');
    }
    modal.style.display = 'flex';
  }

  function closeLobViewer() {
    var modal = elementById('sql-lob-modal');
    if (modal) modal.style.display = 'none';
  }

  function copyLobContent() {
    var body = elementById('sql-lob-content');
    var text = body ? body.textContent : '';
    var onCopied = function () {
      notifyUser(i18nText('sql_editor.lob_copied', '已复制到剪贴板'), 'success');
    };
    var fallbackCopy = function () {
      try {
        var helper = document.createElement('textarea');
        helper.value = text;
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        document.body.removeChild(helper);
        onCopied();
      } catch (ignore) {
        notifyUser(i18nText('sql_editor.lob_copy_failed', '复制失败，请手动选择文本'), 'error');
      }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onCopied).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
  }

  function bindLobViewer() {
    var wrap = elementById('sql-result-wrap');
    if (!wrap || wrap.lobBound) return;
    wrap.lobBound = true;
    wrap.addEventListener('dblclick', function (event) {
      var cell = event.target.closest ? event.target.closest('.sql-lob-cell') : null;
      if (!cell) return;
      var rawText = cell.querySelector('.sql-lob-raw');
      openLobViewer(cell.getAttribute('data-lob-type') || 'CLOB',
                    rawText ? rawText.textContent : '');
    });
  }

  function renderTableInfo(info, fallbackObjectName) {
    var body = elementById('sql-ti-body');
    if (!body) return;
    var basics = [
      { label: i18nText('sql_editor.props_target', '数据库 / 用户'), value: info.database || '—' },
      { label: i18nText('sql_editor.datasource', '数据源类型'), value: info.db_type || '—' },
      { label: i18nText('sql_editor.props_object', '对象名'), value: info.table || fallbackObjectName || '—' },
      { label: i18nText('sql_editor.props_rows', '行数（估算）'),
        value: (info.row_count === null || info.row_count === undefined)
               ? '—' : Number(info.row_count).toLocaleString() },
      { label: i18nText('sql_editor.props_size', '占用大小'), value: formatByteSize(info.table_size) },
      { label: i18nText('sql_editor.props_engine', '存储引擎'), value: info.engine || '—' },
      { label: i18nText('sql_editor.props_tablespace', '表空间'), value: info.tablespace || '—' },
      { label: i18nText('sql_editor.props_comment', '注释'), value: info.comment || '—' }
    ];
    var html = '<div class="ti-grid">';
    basics.forEach(function (item) {
      html += '<div class="ti-item"><div class="ti-label">' + escapeHtml(item.label) + '</div>' +
              '  <div class="ti-value">' + escapeHtml(String(item.value)) + '</div></div>';
    });
    html += '</div>';

    var columns = info.columns || [];
    html += '<div class="ti-section-title">' +
            escapeHtml(i18nText('sql_editor.props_columns', '字段列表')) +
            ' <span class="ti-badge">' + columns.length + '</span></div>';
    if (columns.length) {
      html += '<div style="max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:8px;">' +
              '<table class="ti-table"><thead><tr>' +
              '<th>#</th>' +
              '<th>' + escapeHtml(i18nText('sql_editor.th_name', '字段名')) + '</th>' +
              '<th>' + escapeHtml(i18nText('sql_editor.th_type', '类型')) + '</th>' +
              '<th>' + escapeHtml(i18nText('sql_editor.th_nullable', '可空')) + '</th>' +
              '<th>' + escapeHtml(i18nText('sql_editor.th_key', '键')) + '</th>' +
              '<th>' + escapeHtml(i18nText('sql_editor.th_default', '默认值')) + '</th>' +
              '<th>' + escapeHtml(i18nText('sql_editor.th_comment', '注释')) + '</th></tr></thead><tbody>';
      columns.forEach(function (column) {
        html += '<tr><td class="ti-plain">' + escapeHtml(column.position == null ? '' : column.position) + '</td>' +
                '<td>' + escapeHtml(column.name) + '</td>' +
                '<td>' + escapeHtml(column.type) + '</td>' +
                '<td class="ti-plain">' + escapeHtml(column.nullable
                  ? i18nText('sql_editor.yes', '是') : i18nText('sql_editor.no', '否')) + '</td>' +
                '<td class="ti-plain">' + (column.key
                  ? '<span class="ti-badge pri">' + escapeHtml(column.key) + '</span>' : '—') + '</td>' +
                '<td class="ti-plain">' + escapeHtml(column.default == null ? '—' : column.default) + '</td>' +
                '<td class="ti-plain">' + escapeHtml(column.comment || '') + '</td></tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="sql-tree-loading" style="padding:6px;">' +
              escapeHtml(i18nText('sql_editor.props_no_cols', '无字段信息')) + '</div>';
    }

    var indexes = info.indexes || [];
    html += '<div class="ti-section-title">' +
            escapeHtml(i18nText('sql_editor.props_indexes', '索引列表')) +
            ' <span class="ti-badge">' + indexes.length + '</span></div>';
    if (indexes.length) {
      html += '<div style="max-height:180px;overflow:auto;border:1px solid var(--border);border-radius:8px;">' +
              '<table class="ti-table"><thead><tr>' +
              '<th>' + escapeHtml(i18nText('sql_editor.th_index', '索引名')) + '</th>' +
              '<th>' + escapeHtml(i18nText('sql_editor.th_kind', '类型')) + '</th>' +
              '<th>' + escapeHtml(i18nText('sql_editor.th_columns', '列')) + '</th></tr></thead><tbody>';
      indexes.forEach(function (indexInfo) {
        var badges = [];
        if (indexInfo.primary) {
          badges.push('<span class="ti-badge pri">' +
                      escapeHtml(i18nText('sql_editor.badge_primary', '主键')) + '</span>');
        }
        if (indexInfo.unique && !indexInfo.primary) {
          badges.push('<span class="ti-badge">' +
                      escapeHtml(i18nText('sql_editor.badge_unique', '唯一')) + '</span>');
        }
        if (indexInfo.detail) badges.push('<span class="ti-badge">' + escapeHtml(indexInfo.detail) + '</span>');
        html += '<tr><td>' + escapeHtml(indexInfo.name) + '</td>' +
                '<td class="ti-plain">' + (badges.join(' ') || '—') + '</td>' +
                '<td>' + escapeHtml(indexInfo.columns || '') + '</td></tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="sql-tree-loading" style="padding:6px;">' +
              escapeHtml(i18nText('sql_editor.props_no_idx', '无索引信息')) + '</div>';
    }

    if (info.errors && info.errors.length) {
      html += '<div class="ti-err">' + escapeHtml(
        i18nText('sql_editor.props_partial', '部分信息不可用：{e}')
          .replace('{e}', info.errors.join('；'))) + '</div>';
    }
    body.innerHTML = html;
  }

  // ══════════════════════════════════════════════════════════════
  //  执行：范围 → 后端拆分 → 逐条结果页签 → 游标无限滚动
  // ══════════════════════════════════════════════════════════════
  // 执行范围三档：auto（有选区执行选区，否则光标所在语句）/ 仅选区 / 当前语句 / 全文多语句
  function pickSqlByScope(forceWholeContent) {
    var tab = activeTab();
    if (!tab) return { sqlText: '', scopeLabel: '' };
    var scopeSelect = elementById('sql-scope');
    var mode = forceWholeContent ? 'all' : ((scopeSelect && scopeSelect.value) || 'auto');
    var editor = tab.codeMirror;

    if (!editor) {
      // 纯文本回退：没有行号概念，「当前语句」等价于按分号切出来的一段
      var textarea = tab.textareaEl || {};
      var fullText = String(textarea.value || '');
      var selectionFrom = textarea.selectionStart || 0;
      var selectionTo = textarea.selectionEnd || 0;
      if (mode === 'selection') {
        return selectionTo > selectionFrom
          ? { sqlText: fullText.slice(selectionFrom, selectionTo), originIndex: selectionFrom,
              scopeLabel: i18nText('sql_editor.scope_selection', '选中内容') }
          : { sqlText: '', scopeLabel: '', selectionEmpty: true };
      }
      if (mode === 'all') {
        return { sqlText: fullText, originIndex: 0,
                 scopeLabel: i18nText('sql_editor.scope_all', '全部内容') };
      }
      var statementStart = fullText.lastIndexOf(';', Math.max(0, selectionFrom - 1)) + 1;
      var statementEnd = fullText.indexOf(';', selectionFrom);
      if (statementEnd === -1) statementEnd = fullText.length;
      return {
        sqlText: (mode === 'auto' ? fullText : fullText.slice(statementStart, statementEnd)),
        originIndex: (mode === 'auto' ? 0 : statementStart),
        scopeLabel: mode === 'auto' ? i18nText('sql_editor.scope_all', '全部内容')
                                    : i18nText('sql_editor.scope_statement_label', '当前语句')
      };
    }

    var selectionRange = null;
    try { selectionRange = editor.getSelectionRange(); } catch (ignore) { selectionRange = null; }
    var selection = editor.getSelection();
    if ((mode === 'selection' || mode === 'auto') && String(selection).trim()) {
      var selectionOrigin = 0;
      if (selectionRange) {
        try { selectionOrigin = editor.indexFromPos(selectionRange.from); } catch (ignore) { selectionOrigin = 0; }
      }
      return { sqlText: selection, originIndex: selectionOrigin,
               scopeLabel: i18nText('sql_editor.scope_selection', '选中内容') };
    }
    if (mode === 'selection') return { sqlText: '', scopeLabel: '', selectionEmpty: true };
    if (mode === 'all') {
      return { sqlText: editor.getValue(), originIndex: 0,
               scopeLabel: i18nText('sql_editor.scope_all', '全部内容') };
    }
    var statementRange = currentStatementRange(editor);
    var statement = statementRange.text;
    if (mode === 'statement') {
      return { sqlText: statement, originIndex: statementRange.start,
               scopeLabel: i18nText('sql_editor.scope_statement_label', '当前语句') };
    }
    // auto 且没有选区：执行光标所在语句；语句切出来是空（空行）时退回当前行
    var lineNumber = editor.getCursor().line;
    if (statement && statement.trim()) {
      return { sqlText: statement, originIndex: statementRange.start,
               scopeLabel: i18nText('sql_editor.scope_statement_label', '当前语句') };
    }
    var lineStart = 0;
    try { lineStart = editor.indexFromPos({ line: lineNumber, ch: 0 }); } catch (ignore) { lineStart = 0; }
    return {
      sqlText: String(editor.getLine(lineNumber) || ''), originIndex: lineStart,
      scopeLabel: i18nText('sql_editor.scope_line', '第 {n} 行').replace('{n}', lineNumber + 1)
    };
  }

  function refreshScopeHint() {
    var element = elementById('sql-scope-hint');
    if (!element) return;
    var picked = pickSqlByScope(false);
    // 工具栏上已经有「范围」标签，这里只补一句「这次会跑什么」，不要重复前缀
    element.textContent = picked.scopeLabel ? picked.scopeLabel : '';
  }

  function setStatusText(text, isError) {
    var status = elementById('sql-status');
    if (status) {
      status.textContent = text || '';
      status.className = STATUS_BAR_ITEM_CLASS + 'sql-status' + (isError ? ' error' : '');
    }
    var tab = activeTab();
    if (tab) {
      tab.statusText = text || '';
      tab.statusClass = status ? status.className : '';
    }
  }

  function normalizeExecutionResult(item) {
    return {
      index: item.index, sql: item.sql || '', kind: item.kind || 'query',
      columns: item.columns || [], rows: item.rows || [],
      // 列类型（后端归一成 CLOB/BLOB 这类标签）：决定格子按 LOB 方式展示
      column_types: item.column_types || [],
      row_count: item.row_count || 0, cursor_id: item.cursor_id || null,
      has_more: !!item.has_more, message: item.message || '', error: item.error || '',
      elapsed_ms: item.elapsed_ms || 0,
      // 这条结果在编辑器里的绝对区间（-1 表示没定位到），切结果页签时直接用它，
      // 不要每次重新 indexOf —— 同一条 SQL 出现多次时会永远落到第一处。
      editorFrom: -1, editorTo: -1
    };
  }

  // 把每条结果按「提交顺序」映射回编辑器里的真实区间：
  // 从本次提交文本的起点开始顺序查找，找到一条就把搜索位置往后推，
  // 这样重复出现的同一条 SQL 也能各归各位。
  function locateStatementRanges(tab, submittedText, originIndex) {
    if (!tab || !submittedText) return;
    var searchFrom = 0;
    (tab.results || []).forEach(function (result) {
      result.editorFrom = -1;
      result.editorTo = -1;
      var statementText = String(result.sql || '').trim();
      if (!statementText) return;
      var foundAt = submittedText.indexOf(statementText, searchFrom);
      if (foundAt < 0) {
        // 后端可能裁掉末尾分号/空白 → 用去掉尾部 ';' 的形式再试一次
        var withoutSemicolon = statementText.replace(/;+\s*$/, '').trim();
        foundAt = withoutSemicolon ? submittedText.indexOf(withoutSemicolon, searchFrom) : -1;
        if (foundAt >= 0) statementText = withoutSemicolon;
      }
      if (foundAt < 0) return;
      result.editorFrom = originIndex + foundAt;
      result.editorTo = originIndex + foundAt + statementText.length;
      searchFrom = foundAt + statementText.length;
    });
  }

  function executeActiveSql(options) {
    if (editorState.running) return;
    var tab = activeTab();
    if (!tab) return;
    if (!editorState.datasourceId) {
      notifyUser(i18nText('sql_editor.pick_ds', '请在左侧树中选择数据源'), 'error');
      return;
    }
    var config = options || {};
    var picked = pickSqlByScope(!!config.wholeContentOnly);
    var rawSqlText = String(picked.sqlText || '');
    var sqlText = rawSqlText.trim();
    // 提交前统一 trim 了首尾空白：定位起点要跟着前移，否则「当前语句」会从上一行末尾算起
    var sqlOriginIndex = (picked.originIndex || 0) +
                         (rawSqlText.length - rawSqlText.replace(/^\s+/, '').length);
    if (!sqlText) {
      notifyUser(picked.selectionEmpty
        ? i18nText('sql_editor.empty_selection', '选中的内容为空，请选择要执行的 SQL')
        : i18nText('sql_editor.sql_empty', '请输入 SQL'), 'error');
      return;
    }
    editorState.running = true;
    setStatusText(i18nText('sql_editor.executing', '执行中...'), false);
    var resultWrap = elementById('sql-result-wrap');
    if (resultWrap) {
      resultWrap.innerHTML = '<div class="sql-no-result">' +
                             escapeHtml(i18nText('sql_editor.executing', '执行中...')) + '</div>';
    }
    showScrollState(true, false);

    var payload = { instance_id: editorState.datasourceId, sql: sqlText };
    if (editorState.databaseName) payload.database = editorState.databaseName;
    if (editorState.schemaName) payload.schema = editorState.schemaName;

    httpPost('/api/execute_sql_multi', payload, EXECUTE_TIMEOUT_MS).then(function (response) {
      editorState.running = false;
      var items = (response && response.results) || [];
      tab.results = items.map(normalizeExecutionResult);
      tab.activeResultIndex = tab.results.length ? tab.results.length - 1 : -1;
      tab.pageState = { cursorId: null, hasMore: false, loadedRows: 0, loading: false };
      if (response && response.error && !items.length) {         // 整批被拒（无权访问 / 语句过多）
        tab.results = [normalizeExecutionResult({ index: 1, sql: sqlText, error: response.error })];
        tab.activeResultIndex = 0;
        setStatusText('❌ ' + response.error, true);
      } else {
        var failedCount = (response && response.failed_count) ||
                          tab.results.filter(function (item) { return !!item.error; }).length;
        var totalRows = tab.results.reduce(function (sum, item) { return sum + (item.row_count || 0); }, 0);
        var elapsedMs = (response && response.elapsed_ms) || 0;
        if (!failedCount) {
          setStatusText('✅ ' +
            i18nText('sql_editor.stmt_count', '共 {n} 条语句').replace('{n}', tab.results.length) + ' · ' +
            i18nText('sql_editor.rows_returned', '返回 {n} 行').replace('{n}', totalRows) + ' · ' +
            elapsedMs + ' ms', false);
        } else {
          var firstFailure = null;
          for (var i = 0; i < tab.results.length; i++) {
            if (tab.results[i].error) { firstFailure = tab.results[i]; break; }
          }
          setStatusText('❌ ' +
            i18nText('sql_editor.stmt_failed', '第 {i} 条失败')
              .replace('{i}', firstFailure ? firstFailure.index : '?') + '：' +
            (firstFailure ? briefError(firstFailure.error) : '') + ' · ' +
            ((response && response.statement_count) || tab.results.length) + ' / ' + elapsedMs + ' ms', true);
        }
      }
      locateStatementRanges(tab, sqlText, sqlOriginIndex);   // 每条结果记住编辑器里的区间
      renderResultTabs();
      renderResultBody(false);
      syncContextToTab(tab);
    }).catch(function (failure) {
      editorState.running = false;
      var reason = briefError(failure && failure.message || failure);
      tab.results = [normalizeExecutionResult({ index: 1, sql: sqlText, error: reason })];
      tab.activeResultIndex = 0;
      setStatusText('❌ ' + i18nText('sql_editor.request_fail', '请求失败') + ': ' + reason, true);
      locateStatementRanges(tab, sqlText, sqlOriginIndex);
      renderResultTabs();
      renderResultBody(false);
    });
  }

  function activeResult() {
    var tab = activeTab();
    if (!tab || tab.activeResultIndex < 0) return null;
    return tab.results[tab.activeResultIndex] || null;
  }

  function renderResultTabs() {
    var host = elementById('sql-result-tabs');
    var tab = activeTab();
    if (!host) return;
    if (!tab || tab.results.length < 2) {         // 只有一条结果时不需要页签
      host.style.display = 'none';
      host.innerHTML = '';
      host.onclick = null;
      return;
    }
    host.style.display = 'flex';
    var html = '';
    tab.results.forEach(function (item, resultIndex) {
      html += '<div class="sql-result-tab' + (resultIndex === tab.activeResultIndex ? ' active' : '') +
              (item.error ? ' is-error' : '') + '" data-result-index="' + resultIndex + '">' +
              '  <span class="sql-result-tab-kind">' +
              (item.error ? '!' : (item.kind === 'exec' ? '⚙' : '✓')) + '</span>' +
              '  <span>' + escapeHtml(i18nText('sql_editor.result_n', '结果 {n}')
                                        .replace('{n}', item.index)) + '</span>' +
              '  <span class="sql-result-tab-close" data-close-result="' + resultIndex + '" title="' +
              escapeAttr(i18nText('sql_editor.close_result', '关闭该结果')) + '">' + SVG_CLOSE + '</span>' +
              '</div>';
    });
    host.innerHTML = html;
    host.onclick = function (event) {
      var closer = event.target.closest ? event.target.closest('[data-close-result]') : null;
      if (closer) { closeResultTab(Number(closer.getAttribute('data-close-result'))); return; }
      var clickedTab = event.target.closest ? event.target.closest('.sql-result-tab') : null;
      if (clickedTab) switchResultTab(Number(clickedTab.getAttribute('data-result-index')));
    };
  }

  function switchResultTab(resultIndex) {
    var tab = activeTab();
    if (!tab || !tab.results[resultIndex]) return;
    tab.activeResultIndex = resultIndex;
    var result = tab.results[resultIndex];
    tab.pageState = {
      cursorId: result.cursor_id, hasMore: result.has_more,
      loadedRows: (result.rows || []).length, loading: false
    };
    unbindResultScroll();
    renderResultTabs();
    renderResultBody(false);
    bindResultScroll();
    revealResultSql(result);        // 切结果 → 编辑器自动定位到产生它的那条 SQL
  }

  // 把编辑窗口滚动到产生该结果的 SQL，并短暂高亮一下（多语句执行时最有用）
  //
  // [WARN] 不能每次都用 indexOf 从头找：同一段 SQL 在一个窗口里出现两次时，
  // 第一处永远命中，第二条结果就定位到第一条语句上（用户反馈的「定位不准确」）。
  // 优先用执行时按顺序算好的绝对区间；文档被改过、区间对不上时才退化搜索，
  // 搜索起点取「前一条结果的区间末尾」，尽量往后找。
  function revealResultSql(result) {
    var tab = activeTab();
    var editor = tab && tab.codeMirror;
    if (!editor || !result) return;
    var statementText = String(result.sql || '').trim();
    if (!statementText) return;
    var fullText = editor.getValue();
    var startIndex = -1;
    var endIndex = -1;

    if (typeof result.editorFrom === 'number' && result.editorFrom >= 0 &&
        typeof result.editorTo === 'number' && result.editorTo > result.editorFrom &&
        fullText.slice(result.editorFrom, result.editorTo).trim() === statementText) {
      startIndex = result.editorFrom;
      endIndex = result.editorTo;
    }

    if (startIndex < 0) {
      var previousResult = null;
      (tab.results || []).forEach(function (item) {
        if (item === result) return;
        if (item.index < result.index &&
            typeof item.editorTo === 'number' && item.editorTo > 0) {
          previousResult = item;
        }
      });
      var searchFrom = (previousResult && previousResult.editorTo < fullText.length)
        ? previousResult.editorTo : 0;
      startIndex = fullText.indexOf(statementText, searchFrom);
      if (startIndex < 0) {
        // 语句在提交前被拆分/裁剪过 → 退化成按第一行定位
        var firstLine = statementText.split('\n')[0].trim();
        startIndex = firstLine ? fullText.indexOf(firstLine, searchFrom) : -1;
        if (startIndex < 0) startIndex = firstLine ? fullText.indexOf(firstLine) : -1;
      }
      if (startIndex >= 0) endIndex = startIndex + statementText.length;
    }
    if (startIndex < 0) return;

    result.editorFrom = startIndex;                 // 下次切回来直接用，不再猜
    result.editorTo = endIndex;

    clearResultLocateMark(tab);
    var fromPosition = editor.posFromIndex(startIndex);
    var toPosition = editor.posFromIndex(endIndex);
    try {
      tab.locateMark = editor.markText(fromPosition, toPosition, { className: 'sql-locate-flash' });
    } catch (ignore) { /* markText 失败不影响定位 */ }
    try { editor.scrollIntoView({ from: fromPosition, to: toPosition }, 80); } catch (ignore) {}
    tab.locateTimer = setTimeout(function () { clearResultLocateMark(tab); }, 1600);
  }

  function clearResultLocateMark(tab) {
    if (!tab) return;
    if (tab.locateTimer) { clearTimeout(tab.locateTimer); tab.locateTimer = null; }
    if (tab.locateMark) {
      try { tab.locateMark.clear(); } catch (ignore) { /* 已随文档清空 */ }
      tab.locateMark = null;
    }
  }

  function closeResultTab(resultIndex) {
    var tab = activeTab();
    if (!tab) return;
    tab.results.splice(resultIndex, 1);
    if (tab.activeResultIndex >= tab.results.length) tab.activeResultIndex = tab.results.length - 1;
    unbindResultScroll();
    renderResultTabs();
    renderResultBody(false);
  }

  function closeAllResultTabs() {
    var tab = activeTab();
    if (!tab) return;
    tab.results = [];
    tab.activeResultIndex = -1;
    unbindResultScroll();
    renderResultTabs();
    renderResultBody(false);
    var countEl = elementById('sql-result-count');
    if (countEl) countEl.textContent = '';
  }

  function renderResultBody(appendRows) {
    var wrap = elementById('sql-result-wrap');
    if (!wrap) return;
    var result = activeResult();
    if (!result) {
      wrap.innerHTML = '<div class="sql-no-result">' +
        escapeHtml(i18nText('sql_editor.no_result', '执行查询后显示结果')) + '</div>';
      showResultRowCount(0);
      showScrollState(false, false);
      return;
    }
    if (result.error) {
      wrap.innerHTML = '<div class="sql-no-result" style="color:var(--danger)">' +
                       escapeHtml(briefError(result.error)) + '</div>';
      showResultRowCount(0);
      showScrollState(false, false);
      return;
    }
    if (!result.columns.length) {                 // 没有结果集：只回执行成功 / 消息
      wrap.innerHTML = '<div class="sql-no-result">' +
        escapeHtml(result.message || i18nText('sql_editor.success', '执行成功')) + '</div>';
      showResultRowCount(0);
      showScrollState(false, false);
      return;
    }
    if (appendRows) appendResultRows(wrap, result.rows, result.column_types);
    else buildResultTable(wrap, result.columns, result.rows, result.column_types);
    showResultRowCount(result.rows.length);
    showScrollState(false, !result.has_more);
    if (result.has_more) bindResultScroll(); else unbindResultScroll();
  }

  // CLOB / BLOB 列：网格里只放「标记 + 单行预览」，双击开独立窗口看全文
  // （PL/SQL Developer 的习惯；整篇 CLOB 铺进格子会把表格撑爆，也读不了）
  var LOB_TYPE_PATTERN = /^(N?CLOB|BLOB|LONG|LONG RAW|BYTEA|IMAGE)$/i;

  function lobTypeAt(columnTypes, columnIndex) {
    if (!columnTypes || !columnTypes.length) return '';
    var label = String(columnTypes[columnIndex] || '').trim();
    return LOB_TYPE_PATTERN.test(label) ? label.toUpperCase() : '';
  }

  // PL/SQL Developer 的做法：格子里只显示 <CLOB> / <BLOB> 标记，
  // 正文不铺出来（隐藏节点里存着，双击时交给查看窗口）。
  function lobCellHtml(cellValue, lobType) {
    if (cellValue === null || cellValue === undefined) return '<td>NULL</td>';
    var text = String(cellValue);
    return '<td class="sql-lob-cell" data-lob-type="' + escapeAttr(lobType) + '" ' +
           'title="' + escapeAttr(i18nText('sql_editor.lob_open_hint', '双击查看完整内容')) + '">' +
           '<span class="sql-lob-marker">&lt;' + escapeHtml(lobType) + '&gt;</span>' +
           '<span class="sql-lob-raw" hidden>' + escapeHtml(text) + '</span></td>';
  }

  function buildResultTable(wrap, columns, rows, columnTypes) {
    var html = '<table><thead><tr><th class="sql-rn-col">#</th>';
    columns.forEach(function (column) {
      html += '<th>' + escapeHtml(column) + '</th>';
    });
    html += '</tr></thead><tbody>';
    rows.forEach(function (row, rowIndex) {
      html += '<tr><td class="sql-rn">' + (rowIndex + 1) + '</td>';
      row.forEach(function (cellValue, columnIndex) {
        var lobType = lobTypeAt(columnTypes, columnIndex);
        if (lobType) { html += lobCellHtml(cellValue, lobType); return; }
        html += '<td>' + escapeHtml(cellValue === null || cellValue === undefined
                                      ? 'NULL' : cellValue) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }

  function appendResultRows(wrap, rows, columnTypes) {
    var tableBody = wrap.querySelector('table tbody');
    if (!tableBody) return;
    var existingCount = tableBody.querySelectorAll('tr').length;
    rows.forEach(function (row, offset) {
      var tr = document.createElement('tr');
      var rowNumberCell = document.createElement('td');
      rowNumberCell.className = 'sql-rn';
      rowNumberCell.textContent = String(existingCount + offset + 1);
      tr.appendChild(rowNumberCell);
      row.forEach(function (cellValue, columnIndex) {
        var lobType = lobTypeAt(columnTypes, columnIndex);
        var td = document.createElement('td');
        var text = (cellValue === null || cellValue === undefined) ? 'NULL' : String(cellValue);
        if (lobType && text !== 'NULL') {
          // 翻页追加的行与首页一致：只显示 <CLOB> 标记，正文藏在隐藏节点里
          td.className = 'sql-lob-cell';
          td.setAttribute('data-lob-type', lobType);
          td.title = i18nText('sql_editor.lob_open_hint', '双击查看完整内容');
          var marker = document.createElement('span');
          marker.className = 'sql-lob-marker';
          marker.textContent = '<' + lobType + '>';
          var raw = document.createElement('span');
          raw.className = 'sql-lob-raw';
          raw.hidden = true;
          raw.textContent = text;
          td.appendChild(marker);
          td.appendChild(raw);
        } else {
          td.textContent = text;
        }
        tr.appendChild(td);
      });
      tableBody.appendChild(tr);
    });
  }

  function showResultRowCount(rowCount) {
    var element = elementById('sql-result-count');
    if (!element) return;
    element.textContent = rowCount
      ? '(' + i18nText('sql_editor.rows_returned', '返回 {n} 行').replace('{n}', rowCount) + ')' : '';
  }

  function showScrollState(loading, finished) {
    var loadingEl = elementById('sql-scroll-loading');
    var doneEl = elementById('sql-scroll-done');
    if (loadingEl) loadingEl.style.display = loading ? 'flex' : 'none';
    if (doneEl) doneEl.style.display = (!loading && finished && !editorState.running) ? 'block' : 'none';
  }

  // ── 游标翻页（滚动到底自动加载）──
  var resultScrollHandler = null;
  var resultScrollTarget = null;

  function unbindResultScroll() {
    if (resultScrollHandler && resultScrollTarget) {
      resultScrollTarget.removeEventListener('scroll', resultScrollHandler);
    }
    resultScrollHandler = null;
    resultScrollTarget = null;
  }

  function bindResultScroll() {
    var wrap = elementById('sql-result-wrap');
    if (!wrap || wrap === resultScrollTarget) return;
    unbindResultScroll();
    resultScrollTarget = wrap;
    var debounceTimer = null;
    resultScrollHandler = function () {
      if (wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 80) return;
      if (debounceTimer) return;                 // 防抖：120ms 内只触发一次
      debounceTimer = setTimeout(function () { debounceTimer = null; loadNextResultPage(); }, 120);
    };
    wrap.addEventListener('scroll', resultScrollHandler);
  }

  function loadNextResultPage() {
    var tab = activeTab();
    var result = activeResult();
    if (!tab || !result || !result.has_more || !result.cursor_id || tab.pageState.loading) return;
    tab.pageState.loading = true;
    showScrollState(true, false);
    httpPost('/api/execute_sql', { cursor_id: result.cursor_id }).then(function (payload) {
      tab.pageState.loading = false;
      if (payload.error) {
        result.cursor_id = null;
        result.has_more = false;
        showScrollState(false, false);
        notifyUser(i18nText('sql_editor.cursor_expired', '游标已失效，请重新执行'), 'info');
        return;
      }
      var rows = payload.rows || [];
      if (rows.length) {
        result.rows = result.rows.concat(rows);
        result.row_count = result.rows.length;
        result.cursor_id = payload.cursor_id || null;
        result.has_more = !!payload.has_more;
        renderResultBody(true);
      }
      showScrollState(false, !result.has_more);
    }).catch(function () {
      tab.pageState.loading = false;
      showScrollState(false, true);              // 网络错误不阻断后续重试
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  清空 / 格式化 / 示例 / 结果区最大化
  // ══════════════════════════════════════════════════════════════
  function clearActiveTab() {
    var tab = activeTab();
    setTabSqlText(tab, '');
    if (tab) {
      tab.results = [];
      tab.activeResultIndex = -1;
      tab.datasourceHint = '';
    }
    unbindResultScroll();
    renderResultTabs();
    renderResultBody(false);
    var status = elementById('sql-status');
    if (status) { status.textContent = ''; status.className = STATUS_BAR_ITEM_CLASS + 'sql-status'; }
    var countEl = elementById('sql-result-count');
    if (countEl) countEl.textContent = '';
    showScrollState(false, false);
  }

  function formatActiveSql() {
    var tab = activeTab();
    if (!tab) return;
    var current = tabSqlText(tab);
    if (!String(current).trim()) {
      notifyUser(i18nText('sql_editor.fmt_empty', 'SQL 为空，无需格式化'), 'info');
      return;
    }
    var formatted;
    try {
      formatted = formatSqlText(current);
    } catch (failure) {
      notifyUser(i18nText('sql_editor.fmt_fail', '格式化失败') + ': ' + briefError(failure && failure.message), 'error');
      return;
    }
    if (formatted === current) {
      notifyUser(i18nText('sql_editor.fmt_same', '格式已是最新'), 'info');
      return;
    }
    setTabSqlText(tab, formatted);
    if (tab.codeMirror) { try { tab.codeMirror.setCursor({ line: 0, ch: 0 }); } catch (ignore) { /* 光标复位失败无所谓 */ } }
  }

  function insertSampleSql() {
    var tab = activeTab();
    if (!tab) return;
    var sample = sampleSqlOf().sample;
    var current = tabSqlText(tab);
    if (String(current).trim() && String(current).trim() !== sample.trim()) {
      if (!window.confirm('当前执行窗口已有 SQL，插入示例会覆盖现有内容，是否继续？')) return;
    }
    setTabSqlText(tab, sample);
    if (tab.codeMirror) { tab.codeMirror.setCursor({ line: 0, ch: 0 }); tab.codeMirror.focus(); }
    else if (tab.textareaEl) tab.textareaEl.focus();
  }

  // ── 结果区整屏查看 ───────────────────────────────────────────
  // 旧实现只用 position:fixed 想铺满窗口，但本页有 `container-type: inline-size`
  // （容器查询的判定基准），它同时是 fixed 后代的**包含块**：结果区只会铺满
  // 「内容区」，顶栏和侧栏照旧占着，看起来就像没全屏。
  // 现在最大化时把结果区挂到 <body> 下（还原时放回原位），彻底脱离包含块和裁剪；
  // 表格分页、页签、关闭按钮都按 id 取元素，挂到哪都不受影响。
  var maximizedResultHome = null;          // { parent, nextSibling } 还原位置

  function toggleResultPaneMaximized(forceValue) {
    var pane = elementById('sql-pane-result');
    if (!pane) return;
    var nextState = (typeof forceValue === 'boolean') ? forceValue : !editorState.resultPaneMaximized;
    if (nextState === editorState.resultPaneMaximized) return;
    editorState.resultPaneMaximized = nextState;
    if (nextState) {
      maximizedResultHome = {
        parent: pane.parentNode, nextSibling: pane.nextSibling,
        // 上下分隔条拖动过之后结果区带内联 height/flex（inline 样式优先级高于类样式），
        // 不清掉的话 position:fixed + inset:0 也只会显示成顶部那条 —— 表现为「没全屏、像被盖住」。
        inlineHeight: pane.style.height || '',
        inlineFlex: pane.style.flex || ''
      };
      pane.style.height = '';
      pane.style.flex = '';
      document.body.appendChild(pane);
      document.body.classList.add('sql-result-fullscreen');
    } else {
      if (maximizedResultHome && maximizedResultHome.parent) {
        maximizedResultHome.parent.insertBefore(pane, maximizedResultHome.nextSibling || null);
        // 还原拖动过的高度，别让用户的布局白调
        if (maximizedResultHome.inlineHeight) pane.style.height = maximizedResultHome.inlineHeight;
        if (maximizedResultHome.inlineFlex) pane.style.flex = maximizedResultHome.inlineFlex;
      }
      maximizedResultHome = null;
      document.body.classList.remove('sql-result-fullscreen');
    }
    pane.classList.toggle('is-maximized', nextState);
    var button = elementById('sql-result-max');
    if (button) {
      button.classList.toggle('is-on', nextState);
      button.title = nextState
        ? i18nText('sql_editor.result_restore', '还原结果区（Esc）')
        : i18nText('sql_editor.result_max', '最大化结果区');
    }
    var tab = activeTab();
    if (tab && tab.codeMirror) {
      setTimeout(function () { try { tab.codeMirror.refresh(); } catch (ignore) { /* 刷新失败无所谓 */ } }, 60);
    }
  }

  // 离开本页时把整屏结果收回去：否则挂在 <body> 下的浮层会盖在别的页面上
  function leaveSqlEditorPage() {
    if (editorState.resultPaneMaximized) toggleResultPaneMaximized(false);
    closeLobViewer();                 // 查看窗口挂在 body 下，切页要收掉
  }

  // ── 安全格式化（词元级，不改字面量与注释内容）──
  var FORMAT_KEYWORD_BREAK = {}, FORMAT_KEYWORD_SUB = {}, FORMAT_KEYWORD_ALL = {};
  ['SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'UNION', 'INTERSECT', 'MINUS', 'INSERT',
   'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'MERGE', 'WITH', 'INTO', 'VALUES',
   'SET', 'RETURNING', 'LIMIT', 'OFFSET', 'FETCH', 'EXPLAIN', 'ANALYZE', 'PIVOT', 'UNPIVOT',
   'START', 'FOR', 'CONNECT', 'CYCLE'].forEach(function (keyword) { FORMAT_KEYWORD_BREAK[keyword] = 1; });
  ['AND', 'OR', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'OUTER', 'CROSS', 'NATURAL', 'JOIN', 'ON', 'USING',
   'WHEN', 'THEN', 'ELSE', 'CASE', 'END', 'PRIOR'].forEach(function (keyword) { FORMAT_KEYWORD_SUB[keyword] = 1; });
  Object.keys(FORMAT_KEYWORD_BREAK).forEach(function (keyword) { FORMAT_KEYWORD_ALL[keyword] = true; });
  Object.keys(FORMAT_KEYWORD_SUB).forEach(function (keyword) { FORMAT_KEYWORD_ALL[keyword] = true; });
  ['AS', 'BY', 'IN', 'LIKE', 'BETWEEN', 'EXISTS', 'ANY', 'ALL', 'SOME', 'NULL', 'IS', 'NOT', 'TRUE',
   'FALSE', 'DISTINCT', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'DEFAULT', 'PRIMARY', 'FOREIGN', 'REFERENCES',
   'KEY', 'INDEX', 'TABLE', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'GRANT', 'REVOKE', 'ROWNUM', 'ROWID',
   'LEVEL', 'DUAL', 'ASC', 'DESC', 'SYSDATE', 'SYSTIMESTAMP', 'CURRENT_DATE'].forEach(function (keyword) {
    FORMAT_KEYWORD_ALL[keyword] = true;
  });

  function formatSqlText(source) {
    var text = source == null ? '' : String(source);
    if (!text.trim()) return text;

    var tokens = [], cursor = 0, buffer = '';
    function flushBuffer() { if (buffer) { tokens.push({ kind: 'sql', value: buffer }); buffer = ''; } }
    while (cursor < text.length) {
      var char = text[cursor];
      if (char === "'") {                                   // 字符串字面量：原样保留
        flushBuffer();
        var scan = cursor + 1, literal = "'";
        while (scan < text.length) {
          literal += text[scan];
          if (text[scan] === "'") {
            if (text[scan + 1] === "'") { literal += "'"; scan += 2; continue; }   // '' 转义
            scan += 1; break;
          }
          scan += 1;
        }
        tokens.push({ kind: 'string', value: literal });
        cursor = scan;
      } else if (char === '-' && text[cursor + 1] === '-') {   // 行注释
        flushBuffer();
        var lineEnd = text.indexOf('\n', cursor);
        tokens.push({ kind: 'line-comment', value: (lineEnd === -1) ? text.slice(cursor) : text.slice(cursor, lineEnd) });
        cursor = (lineEnd === -1) ? text.length : (lineEnd + 1);
      } else if (char === '/' && text[cursor + 1] === '*') {    // 块注释
        flushBuffer();
        var blockEnd = text.indexOf('*/', cursor + 2);
        tokens.push({ kind: 'block-comment',
                      value: (blockEnd === -1) ? text.slice(cursor) : text.slice(cursor, blockEnd + 2) });
        cursor = (blockEnd === -1) ? text.length : (blockEnd + 2);
      } else { buffer += char; cursor += 1; }
    }
    flushBuffer();

    var indentLevel = 0, renderedIndent = 0, lines = [], currentLine = '', skipLeadingSpace = false;
    function finishLine() {
      if (currentLine) { lines.push('  '.repeat(renderedIndent) + currentLine); currentLine = ''; }
      skipLeadingSpace = false;
    }
    function appendWord(word) {
      if (!currentLine) { currentLine = word; renderedIndent = indentLevel; skipLeadingSpace = false; }
      else if (skipLeadingSpace) { currentLine += word; skipLeadingSpace = false; }
      else { currentLine += ' ' + word; }
    }
    tokens.forEach(function (token) {
      if (token.kind === 'line-comment') { finishLine(); lines.push('  '.repeat(indentLevel) + token.value); return; }
      if (token.kind === 'block-comment') {
        if (token.value.indexOf('\n') >= 0) { finishLine(); lines.push('  '.repeat(indentLevel) + token.value); }
        else appendWord(token.value);
        return;
      }
      if (token.kind === 'string') { appendWord(token.value); return; }
      token.value.split(/(\s+|\(|\)|<>|!=|<=|>=|=|<|>)/).forEach(function (word) {
        if (!word || /^\s+$/.test(word)) return;
        if (word === '(') { indentLevel += 1; currentLine = currentLine ? currentLine + '(' : '('; skipLeadingSpace = true; return; }
        if (word === ')') { if (indentLevel > 0) indentLevel -= 1; currentLine = currentLine ? currentLine + ')' : ')'; return; }
        var upper = word.toUpperCase();
        if (FORMAT_KEYWORD_BREAK[upper] || FORMAT_KEYWORD_SUB[upper]) finishLine();
        var isKeyword = FORMAT_KEYWORD_ALL[upper] && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word);
        appendWord(isKeyword ? upper : word);
      });
    });
    finishLine();
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '');
  }

  // ══════════════════════════════════════════════════════════════
  //  分割条（编辑器/结果区、左树宽度）与布局持久化
  // ══════════════════════════════════════════════════════════════
  function loadLayoutSizes() {
    try {
      var raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (raw) editorState.layoutSizes = JSON.parse(raw) || {};
    } catch (ignore) { editorState.layoutSizes = {}; }
  }

  function saveLayoutSizes() {
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(editorState.layoutSizes));
    } catch (ignore) { /* 存不下就算了 */ }
  }

  function applyLayoutSizes() {
    var treePanel = elementById('sql-tree-panel');
    var savedTreeWidth = parseInt((editorState.layoutSizes || {}).treeWidth, 10) || 0;
    if (treePanel && savedTreeWidth) {
      // 兜底夹紧：历史值/手改 localStorage 也不能把树撑出可拖范围
      treePanel.style.width = Math.max(180, Math.min(600, savedTreeWidth)) + 'px';
    }
    var editorPane = elementById('sql-pane-editor');
    if (editorPane && editorState.layoutSizes.editorHeight) {
      editorPane.style.flex = 'none';
      editorPane.style.height = editorState.layoutSizes.editorHeight + 'px';
    }
  }

  function bindHorizontalSplitter() {
    var splitter = elementById('sql-splitter');
    var editorPane = elementById('sql-pane-editor');
    var resultPane = elementById('sql-pane-result');
    if (!splitter || !editorPane || !resultPane || splitter.eventsBound) return;
    splitter.eventsBound = true;
    splitter.addEventListener('mousedown', function (event) {
      event.preventDefault();
      splitter.classList.add('active');
      var startY = event.clientY;
      var startEditorHeight = editorPane.getBoundingClientRect().height;
      var startResultHeight = resultPane.getBoundingClientRect().height;
      editorPane.style.flex = 'none'; editorPane.style.height = startEditorHeight + 'px';
      resultPane.style.flex = 'none'; resultPane.style.height = startResultHeight + 'px';
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      var moveHandler = function (moveEvent) {
        var deltaY = moveEvent.clientY - startY;
        editorPane.style.height = Math.max(60, startEditorHeight + deltaY) + 'px';
        resultPane.style.height = Math.max(60, startResultHeight - deltaY) + 'px';
      };
      var upHandler = function () {
        splitter.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        editorState.layoutSizes.editorHeight = parseInt(editorPane.style.height, 10) || startEditorHeight;
        saveLayoutSizes();
        var tab = activeTab();
        if (tab && tab.codeMirror) {
          setTimeout(function () { try { tab.codeMirror.refresh(); } catch (ignore) { /* 刷新失败无所谓 */ } }, 50);
        }
        document.removeEventListener('mousemove', moveHandler);
        document.removeEventListener('mouseup', upHandler);
      };
      document.addEventListener('mousemove', moveHandler);
      document.addEventListener('mouseup', upHandler);
    });
    splitter.addEventListener('dblclick', function () {   // 双击复位（旧版习惯）
      editorPane.style.height = ''; editorPane.style.flex = '';
      resultPane.style.height = ''; resultPane.style.flex = '';
      delete editorState.layoutSizes.editorHeight;
      saveLayoutSizes();
      var tab = activeTab();
      if (tab && tab.codeMirror) {
        setTimeout(function () { try { tab.codeMirror.refresh(); } catch (ignore) { /* 刷新失败无所谓 */ } }, 50);
      }
    });
  }

  function bindVerticalSplitter() {
    var splitter = elementById('sql-splitter-v');
    var treePanel = elementById('sql-tree-panel');
    if (!splitter || !treePanel || splitter.eventsBound) return;
    splitter.eventsBound = true;
    splitter.addEventListener('mousedown', function (event) {
      event.preventDefault();
      splitter.classList.add('active');
      var startX = event.clientX;
      var startWidth = treePanel.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      var moveHandler = function (moveEvent) {
        treePanel.style.width = Math.max(180, Math.min(600, startWidth + moveEvent.clientX - startX)) + 'px';
      };
      var upHandler = function () {
        splitter.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        editorState.layoutSizes.treeWidth = parseInt(treePanel.style.width, 10) || startWidth;
        saveLayoutSizes();
        document.removeEventListener('mousemove', moveHandler);
        document.removeEventListener('mouseup', upHandler);
      };
      document.addEventListener('mousemove', moveHandler);
      document.addEventListener('mouseup', upHandler);
    });
    splitter.addEventListener('dblclick', function () {
      treePanel.style.width = '';
      delete editorState.layoutSizes.treeWidth;
      saveLayoutSizes();
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  快捷键（无 CodeMirror 时也生效）与生命周期
  // ══════════════════════════════════════════════════════════════
  function bindGlobalKeys() {
    if (bindGlobalKeys.alreadyBound) return;
    bindGlobalKeys.alreadyBound = true;
    document.addEventListener('keydown', function (event) {
      var page = elementById('page-sql-editor');
      if (!page || !page.classList.contains('active')) return;
      if (event.key === 'Escape') {
        var lobModal = elementById('sql-lob-modal');
        if (lobModal && lobModal.style.display && lobModal.style.display !== 'none') {
          closeLobViewer();
          return;
        }
      }
      if (event.key === 'Escape' && editorState.resultPaneMaximized) { toggleResultPaneMaximized(false); return; }
      if (event.ctrlKey && event.shiftKey && (event.key === 'F' || event.key === 'f')) {
        var tab = activeTab();
        if (tab && tab.codeMirror) return;      // CodeMirror 的 extraKeys 已处理，避免格式化两次
        event.preventDefault();
        formatActiveSql();
      }
    });
    var scopeSelect = elementById('sql-scope');
    if (scopeSelect) scopeSelect.addEventListener('change', refreshScopeHint);
  }

  // CodeMirror 是惰性加载的：组件就绪后给之前用 textarea 起动的页签补建编辑器
  function upgradeTextareaTabsToCodeMirror() {
    editorState.tabs.forEach(function (tab) {
      if (tab.codeMirror || !tab.textareaEl || !window.CodeMirror) return;
      tab.codeMirror = createCodeMirrorEditor(tab.textareaEl);
    });
    applySamplePlaceholder();
  }

  function applySamplePlaceholder() {
    var placeholder = i18nText('sql_editor.sample_placeholder', '输入 SQL，如：{s}')
                        .replace(/\{s\}/g, sampleSqlOf().hint);
    editorState.tabs.forEach(function (tab) {
      if (tab.codeMirror) { try { tab.codeMirror.setOption('placeholder', placeholder); } catch (ignore) { /* 旧版本没有该选项 */ } }
      if (tab.textareaEl) tab.textareaEl.placeholder = placeholder;
    });
  }

  function bindStaticControls() {
    bindTreeEvents();
    bindLobViewer();
    var tabsList = elementById('sql-tabs-list');
    if (tabsList && !tabsList.eventsBound) {
      tabsList.eventsBound = true;
      tabsList.addEventListener('click', function (event) {
        var closer = event.target.closest ? event.target.closest('.sql-tab-close') : null;
        if (closer) { closeEditorTab(Number(closer.getAttribute('data-close'))); return; }
        var clicked = event.target.closest ? event.target.closest('.sql-tab') : null;
        if (clicked) {
          var tab = findTabById(Number(clicked.getAttribute('data-tab-id')));
          if (tab) activateTab(tab);
        }
      });
    }
  }

  function enterSqlEditorPage() {
    loadLayoutSizes();
    bindGlobalKeys();
    if (editorState.entered) {
      var tab = activeTab();
      if (tab && tab.codeMirror) {
        setTimeout(function () { try { tab.codeMirror.refresh(); } catch (ignore) { /* 刷新失败无所谓 */ } }, 120);
      }
      return;
    }
    editorState.entered = true;
    if (!editorState.tabs.length) {
      var firstTab = createTab({});
      editorState.activeTabId = firstTab.id;
      showTabEditor(firstTab);
      renderTabBar();
    }
    bindStaticControls();
    bindHorizontalSplitter();
    bindVerticalSplitter();
    applyLayoutSizes();
    // 对象树不依赖 CodeMirror：先加载，否则编辑器脚本一慢，用户看到的就是
    // 「数据源半天不出来」
    loadDatasourceTree();
    ensureCodeMirrorLoaded().then(function (loaded) {
      if (loaded) upgradeTextareaTabsToCodeMirror();
      else setObjectMetadataStatus(i18nText('sql_editor.cm_off', '纯文本模式：智能提示需要 CodeMirror'));
      renderTabBar();
      showTabEditor(activeTab());
      refreshScopeHint();
    });
  }

  // ══════════════════════════════════════════════════════════════
  //  对外接口 + 对旧内联脚本的兼容导出（index.html 其它位置仍按全局函数名调用）
  // ══════════════════════════════════════════════════════════════
  window.FusionSqlEditor = {
    load: enterSqlEditorPage,
    enter: enterSqlEditorPage,
    leave: leaveSqlEditorPage,          // 切走本页时收回整屏结果浮层
    exec: executeActiveSql,
    clear: clearActiveTab,
    format: formatActiveSql,
    insertSample: insertSampleSql,
    toggleAutoHint: toggleAutoHint,
    toggleResultMax: toggleResultPaneMaximized,
    closeAllResults: closeAllResultTabs,
    reloadTree: loadDatasourceTree,
    filterTree: filterDatasourceTree,
    onTargetChange: onTargetChange,
    addTab: function () { addEditorTab({}); },
    closeTableInfo: closeTableInfoModal,
    openLobViewer: openLobViewer,
    closeLobViewer: closeLobViewer,
    copyLobContent: copyLobContent,
    showHintNow: function () { var tab = activeTab(); if (tab && tab.codeMirror) showSqlHint(tab.codeMirror, false); },
    // 全站 AI 上下文采集（index.html）用它取当前数据源 / 库 / SQL，不再依赖具体 DOM id
    currentContext: function () {
      var tab = activeTab();
      return {
        dsId: editorState.datasourceId || '',
        dsName: editorState.datasourceId ? (datasourceNameOf(editorState.datasourceId) || '') : '',
        db: editorState.databaseName || '',
        schema: editorState.schemaName || '',
        db_type: datasourceTypeOf(editorState.datasourceId),
        sql: tabSqlText(tab),
        tabName: tab ? tab.name : '',
        tabCount: editorState.tabs.length,
        scope: (elementById('sql-scope') || {}).value || 'auto'
      };
    },
    state: editorState
  };

  window.initSqlEditor = function () { enterSqlEditorPage(); };
  window.loadSqlTree = function () { loadDatasourceTree(); };
  window.execSql = function () { executeActiveSql({}); };
  window.clearSql = clearActiveTab;
  window.formatSql = formatActiveSql;
  window.getSqlEditorText = function () { return tabSqlText(activeTab()); };
  window.setSqlEditorText = function (text) { setTabSqlText(activeTab(), text); };
  window.renderSqlResult = function (columns, rows) {
    var tab = activeTab();
    if (!tab) return;
    tab.results = [normalizeExecutionResult({
      index: 1, sql: '', columns: columns || [], rows: rows || [], row_count: (rows || []).length })];
    tab.activeResultIndex = 0;
    renderResultTabs();
    renderResultBody(false);
  };
})();
