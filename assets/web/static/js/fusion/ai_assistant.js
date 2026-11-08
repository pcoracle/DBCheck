/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * Fusion page logic: AI 巡检助手（全屏对话）。
 * 负责这一页的会话列表、消息流式渲染与 SQL 执行闭环：右侧可折叠会话列表 + 停靠页签、
 * 顶栏（标题 / 模型信息 / 历史任务 / 数据源版本 / 工具配置 / 清空）、深度思考块、
 * 工具轨迹卡（进度条 / 参数 / 结果 / 耗时）、确认卡、Markdown 代码块一键执行与 AI 修复、
 * 停止生成、重新生成、编辑重发、追问 chips、巡检进度弹窗、数据源版本弹窗。
 *
 * 归属：本页交互与实现思路属 fiyo (Jack Ge) <sdfiyon@gmail.com>（MIT License,
 * Copyright (c) 2025-2026 fiyo (Jack Ge)），品牌与标识归 DBCheck / RaccoonX 作者所有。
 *
 * 本仓库的既有约定：
 * 1. 会话与消息由后端 SQLite 持久化，刷新/换设备都能续上；
 * 2. 每个请求都带登录会话，数据源可见性由后端过滤，前端不拼全量清单；
 * 3. 对话流走 /api/ai/assistant/stream，逐事件（SSE）驱动界面；
 * 4. 取数只走助手自己的只读接口（/api/ai/assistant/execute-sql），不复用可写的
 *    /api/execute_sql，避免「助手页也能改库」这种越权面。
 */
(function () {
  'use strict';

  var INPUT_MAX_HEIGHT = 200;        // 输入框自动增高上限：再高就内部滚动，不吃掉对话区
  var RENDER_MIN_INTERVAL = 120;     // 流式渲染节流 ~8fps：连贯且不抢主线程
  var BOTTOM_TOLERANCE = 30;         // 距底小于这个像素算「贴底」，继续自动滚动
  var SIDEBAR_ANIM_MS = 320;         // 侧栏宽度动画时长：走完再把侧栏移出布局，收起过程不跳帧
  var ROW_LIMIT_DEFAULT = 20;
  var ROW_LIMIT_MIN = 1;
  var ROW_LIMIT_MAX = 5000;          // 行数上限钳制区间 1~5000，超出会在结果里误导人
  var SESSION_TITLE_MAX = 30;        // 首条提问当标题时的截断长度：30 字 + 省略号
  var ROW_LIMIT_KEY = 'aias_global_max_rows';
  var SIDEBAR_KEY = 'aias_sidebar_collapsed';
  var TASK_POLL_MS = 3000;
  // 单选/多选数据源弹窗的共享状态：候选列表、待回调、是否允许「不指定数据源」、目标块
  var dsState = { list: [], callback: null, allowClear: false, blockId: '' };
  var dsMultiState = { list: [], callback: null, selected: [], lockType: '' };
  var dialectScanTimer = 0;         // 方言预检的防抖句柄
  var multiScanTimer = 0;           // 多语句拆分的防抖句柄
  var multiObserver = null;         // 拆分扫描的 DOM 兜底观察器
  var batchAbort = false;           // 批量执行的「■ 停止」标志位
  var maxOverlay = null;            // 结果全屏遮罩节点
  var maxHome = null;               // 最大化前表格所在 wrap（退出时移回）
  var maxOnKey = null;              // Esc 关闭遮罩的 keydown 句柄

  var state = {
    entered: false,
    sessions: [],
    sessionId: '',
    messages: [],
    datasources: [],
    defaultDatasource: '',
    maxRows: 20,
    generating: false,
    abortController: null,
    userScrolledUp: false,
    scrollPrompt: false,
    // 渲染节流队列三个字段：待渲染帧、等待中的 rAF id、上一帧时间戳
    renderPending: null,
    renderRafId: 0,
    renderLastTime: 0,
    modelLabel: '',
    sidebarCollapsed: false,
    renamingSessionId: '',   // 正在行内重命名的会话（列表重绘会把它冲掉）
    editingIndex: -1,        // 正在行内编辑的用户消息下标（-1 = 没有）
    // ── SQL 台账 ──
    // 「这块要执行哪句」存在这个台账里（存的是 **HTML 转义后**的文本，
    // 取用时 unescHtml），而不是挂在 DOM 属性上：data-raw-sql 只是渲染兜底。
    // 子语句的 key 规则：sqlId + '-s' + n（1 基）。
    sqlStore: {},
    sqlSeq: 0,                   // 自增号（本仓库的块身份用「消息-块」稳定 uid，见 codeBlockHtml 注释）
    sqlErrors: {},               // sqlId -> 执行报错文本（供「AI 修复」）
    sqlDs: {},                   // sqlId -> 执行时用的数据源名（供 AI 修复识别方言）
    sqlRepair: {},               // sqlId -> 「字段不存在」确定性修复载荷（真实列清单）
    dialectStatusCache: {},      // 数据源名 join('|') -> 版本状态数组（同一集合不重复问后端）
    blockExtras: {},          // 代码块 uid -> {fp, result, dialect, split, splitResults}
    usedDatasources: [],      // 本次会话碰过的数据源
    dialectCache: {},         // 数据源|语句指纹 -> dialect-check 结果（避免每帧重复预检）
    batchAbort: null,         // 批量执行的停止句柄
    currentStream: null
  };

  // ── 内联 SVG 图标（复制 / 撤销替换 / 全部执行）──
  // 用 SVG 而不是字体图标：免字体依赖、跨平台渲染一致；按钮都是 icon-only + tooltip + aria-label。
  var COPY_BTN_HTML =
    '<svg class="ic-copy" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">'
    + '<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>'
    + '<svg class="ic-check" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">'
    + '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
  var RESTORE_BTN_HTML =
    '<svg class="ic-restore" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">'
    + '<path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>'
    + '<svg class="ic-check" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">'
    + '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
  var IC_PLAY_ALL =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">'
    + '<path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4zm12 0v6l5-3z"/></svg>';

  // ── 只读判定常量（口径与后端 _classify_plsql_block 一致）──
  var PLSQL_FENCE = "['\\\"](?:\\\\.|[^'\\\"\\\\])*?['\\\"]";
  var PLSQL_WRITE_KWS = ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'CREATE',
    'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE', 'COMMIT', 'ROLLBACK', 'SAVEPOINT',
    'PURGE', 'FLASHBACK', 'STARTUP', 'SHUTDOWN', 'PASSWORD', 'PROFILE', 'ANALYZE'];
  var PLSQL_DANGEROUS_PKGS = ['DBMS_JOB', 'DBMS_SCHEDULER', 'DBMS_DDL', 'DBMS_REDEFINITION',
    'DBMS_AQ', 'DBMS_REFRESH', 'DBMS_TRANSACTION', 'DBMS_FLASHBACK', 'DBMS_STREAMS', 'DBMS_REPAIR',
    'DBMS_STATS', 'DBMS_ADMIN', 'DBMS_ALERT', 'DBMS_PIPE', 'DBMS_DEBUG', 'DBMS_SQL'];

  // 「这段 SQL 里还有未替换的占位符吗」：
  // 除尖括号/花括号等标准写法外，还要认 AI 最常用的**命名式占位符**
  // （`WHERE tablespace_name = 'YOUR_TABLESPACE'`），只列信号强的命名，
  // 别把 'TABLE'/'ACTIVE' 这种真实取值也算进来。带 i 标志：YOUR_/your_ 都可能出现。
  var SLOT_HINT_RE = new RegExp(
    "(['\"]?)<[^<>\\s]{1,40}>" +
    "|#[\\u4e00-\\u9fa5A-Za-z_][\\u4e00-\\u9fa5\\w]{0,39}#" +
    "|\\{\\{\\s*[\\u4e00-\\u9fa5A-Za-z_][\\u4e00-\\u9fa5\\w.]*\\s*\\}\\}" +
    "|\\$\\{[^}]+\\}" +
    "|\\[[\\u4e00-\\u9fa5][\\u4e00-\\u9fa5\\w]{0,19}\\]" +
    "|(?:your|my|our)_[a-z0-9_]{1,40}" +
    "|(?:tbd|todo|placeholder|replace[_-]?me|change[_-]?me|fill[_-]?me)" +
    // 中文「待填 / 待替换 / 请填写 / 请替换 / 请补全」这几个提示词也是占位符信号。
    // 这里用 \\uXXXX 转义写法：它是**识别模式**而不是给用户看的文案，没有对应 i18n key，
    // 直接写中文会被「硬编码中文」扫描当成漏网文案（真值仍走 t() 的那套）。
    "|\\u5f85\\u586b|\\u5f85\\u66ff\\u6362|\\u8bf7\\u586b\\u5199|\\u8bf7\\u66ff\\u6362|\\u8bf7\\u8865\\u5168", 'i');

  // 只匹配「带引号的命名式占位符」（0 行归因时要把它原样显示给用户）
  // 中文提示词同样用 \\uXXXX 写法（理由见上）。
  var NAMED_PH_RE = new RegExp(
    "'(?:your|my|our)_[a-z0-9_]{1,40}'" +
    "|'(?:tbd|todo|placeholder|replace[_-]?me|change[_-]?me|fill[_-]?me)'" +
    "|'\\u5f85\\u586b'|'\\u5f85\\u66ff\\u6362'|'\\u8bf7\\u586b\\u5199'|'\\u8bf7\\u66ff\\u6362'|'\\u8bf7\\u8865\\u5168'" +
    "|'x{2,}[a-z0-9_]*'", 'gi');

  // 方言预检的粗关键字预筛：命中才值得问后端，
  // 宁可多问几个，也不要漏掉真正的违规。
  var DIALECT_HINT_RE = new RegExp(
    '\\bFETCH\\s+(FIRST|NEXT)\\b|\\bOFFSET\\s+\\d+\\s+ROWS?\\b|\\bIDENTITY\\b'
    + '|\\bJSON_(VALUE|QUERY|TABLE|EXISTS|OBJECT|ARRAY)\\s*\\(|\\bMATCH_RECOGNIZE\\s*\\('
    + '|\\bLATERAL\\s*\\(|\\bCROSS\\s+APPLY\\b|\\bAPPROX_COUNT_DISTINCT\\s*\\('
    + '|\\b(ROW_NUMBER|RANK|DENSE_RANK|LAG|LEAD|NTILE|FIRST_VALUE|LAST_VALUE)\\s*\\([^)]*\\)\\s*OVER\\s*\\('
    + '|\\bNULLS\\s+(FIRST|LAST)\\b'
    + '|(^|[\\s(])WITH\\s+[\\w`]+\\s+AS\\s*\\(', 'i');

  // ══════════════════════════════════════════════════════════
  // 基础工具
  // ══════════════════════════════════════════════════════════

  function byId(id) { return document.getElementById(id); }

  function t(key, fallback) {
    try {
      if (typeof window.i18n === 'function') {
        var value = window.i18n(key);
        if (value && value !== key) return value;
      }
    } catch (ignore) { /* 词典未就绪时用兜底文案 */ }
    return fallback || key;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function requestJson(url, options) {
    var settings = Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    }, options || {});
    return fetch(url, settings).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        // 带上状态码：模型信息要区分 401（登录过期）/ 404（服务没重启）/ 200 但 available=false
        if (body && typeof body === 'object') body.httpStatus = response.status;
        if (!response.ok && !body.error) body.error = 'HTTP ' + response.status;
        return body;
      });
    });
  }

  function notify(message, kind) {
    if (typeof window.toast === 'function') { window.toast(message, kind || 'info'); return; }
    if (kind === 'error') { console.error('[ai-assistant] ' + message); }
  }

  function formatDuration(milliseconds) {
    var value = Number(milliseconds || 0);
    if (value < 1000) return value + 'ms';
    return (value / 1000).toFixed(value < 10000 ? 2 : 1) + 's';
  }

  function truncate(text, limit) {
    // 注意：这里必须用形参 text。写成 `String(text == null ? '' : value)` 会读到
    // 尚未赋值的 value（var 提升 = undefined），全站截断文案都会变成「undefined」。
    var value = String(text == null ? '' : text);
    return value.length > limit ? value.slice(0, limit) + '…' : value;
  }

  function prettyJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (ignore) {
      return String(value);
    }
  }

  // ══════════════════════════════════════════════════════════
  // Markdown 渲染（正则实现：不引第三方库，够用且可控）
  // ══════════════════════════════════════════════════════════

  function inlineMarkdown(text) {
    var html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, function (match, code) {
      return '<code class="aias-inline-code">' + code + '</code>';
    });
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return html;
  }

  function renderMarkdownTable(rows) {
    var cells = rows.map(function (row) {
      return row.trim().replace(/^\|/, '').replace(/\|$/, '')
        .split('|').map(function (cell) { return cell.trim(); });
    });
    if (cells.length < 2) return '';
    var header = cells[0];
    var body = cells.slice(2);              // cells[1] 是 |---|---| 分隔行
    var html = '<table class="aias-md-table"><thead><tr>';
    header.forEach(function (cell) { html += '<th>' + inlineMarkdown(cell) + '</th>'; });
    html += '</tr></thead><tbody>';
    body.forEach(function (row) {
      html += '<tr>';
      row.forEach(function (cell) { html += '<td>' + inlineMarkdown(cell) + '</td>'; });
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  function markdownToHtml(source, scope) {
    var text = String(source == null ? '' : source);
    var codeBlocks = [];
    // 先把围栏代码块摘出来：里面的 -- / # / * 不是 markdown 语法
    text = text.replace(/```([a-zA-Z0-9_+.-]*)\r?\n?([\s\S]*?)```/g, function (match, language, code) {
      codeBlocks.push({ language: language, code: String(code).replace(/\s+$/, '') });
      return '\u0000CODE' + (codeBlocks.length - 1) + '\u0000';
    });

    var lines = text.split('\n');
    var output = [];
    var listItems = null;                    // 'ul' / 'ol' / null
    var tableRows = [];

    function closeList() {
      if (!listItems) return;
      output.push('<' + listItems.type + ' class="aias-md-list">' +
                  listItems.items.map(function (item) { return '<li>' + item + '</li>'; }).join('') +
                  '</' + listItems.type + '>');
      listItems = null;
    }

    function flushTable() {
      if (tableRows.length >= 2) output.push(renderMarkdownTable(tableRows));
      else if (tableRows.length) output.push('<p>' + inlineMarkdown(tableRows.join(' ')) + '</p>');
      tableRows = [];
    }

    lines.forEach(function (rawLine) {
      var line = rawLine;
      if (/^\s*\|.*\|\s*$/.test(line)) { tableRows.push(line); closeList(); return; }
      if (tableRows.length) flushTable();
      var placeholder = line.match(/^\s*\u0000CODE(\d+)\u0000\s*$/);
      if (placeholder) {
        closeList();
        var blockIndex = Number(placeholder[1]);
        output.push(codeBlockHtml(codeBlocks[blockIndex], scope, blockIndex));
        return;
      }
      var heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        closeList();
        var level = Math.min(heading[1].length + 2, 6);
        output.push('<h' + level + ' class="aias-md-h">' + inlineMarkdown(heading[2]) + '</h' + level + '>');
        return;
      }
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) { closeList(); output.push('<hr class="aias-md-hr">'); return; }
      var unordered = line.match(/^\s*[-*+]\s+(.*)$/);
      var ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (unordered || ordered) {
        var wantType = unordered ? 'ul' : 'ol';
        if (!listItems || listItems.type !== wantType) { closeList(); listItems = { type: wantType, items: [] }; }
        listItems.items.push(inlineMarkdown((unordered || ordered)[1]));
        return;
      }
      if (!line.trim()) { closeList(); return; }
      closeList();
      output.push('<p class="aias-md-p">' + inlineMarkdown(line) + '</p>');
    });
    closeList();
    if (tableRows.length) flushTable();
    return output.join('\n').replace(/\u0000CODE(\d+)\u0000/g, function (match, index) {
      return codeBlockHtml(codeBlocks[Number(index)], scope, Number(index));
    });
  }

  function codeBlockHtml(block, scope, index) {
    var language = String((block && block.language) || '').toLowerCase();
    var code = String((block && block.code) || '');
    var sqlLike = /sql|oracle|mysql|postgres|plsql|tsql/.test(language) || isLikelySql(code);
    // 三件事**分开判断**（绑在一起判会连 DDL/脚本块的复制按钮都吞掉）：
    //   · 复制按钮 → 所有围栏代码块都有（纯前端动作，零风险）
    //   · 撤销替换按钮 → 该块含占位符时才给（没占位符就无从替换，给了只是噪音）
    //   · 执行按钮 → 只有「看起来是只读查询」的块才有（写语句绝不出现执行入口）
    var exec = isLikelyReadSql(code);
    var hasSlots = SLOT_HINT_RE.test(code);
    // 身份用「第几条消息的第几个代码块」而不是自增号 aias-sql-N：
    // 流式渲染每帧都在重建整条气泡，而 blockExtras
    // 这层「重绘后把结果贴回来」的缓存，必须按**稳定 uid** 才找得回同一块；
    // 自增号每帧都换号 → 缓存永远命中不了。结果区 id 规则：<块 uid>-result。
    var uid = (scope || 'aias-x') + '-b' + index;
    // ★ AI 修复持久化的指纹覆盖：这个块若已被修复过（修复后 SQL 存在会话覆盖层里），
    // 渲染时就显示修复后的版本，而不是 content 里的旧 SQL（content 的逐字回写可能因
    // 多语句/占位符转义而未命中，必须有这一层兜底才不丢修复）。code 此刻尚未转义。
    try {
      var override = sqlOverrideFind(code);
      if (override && override.fixedSql) code = override.fixedSql;
    } catch (ignore) { /* 覆盖层读不到就按原文渲染 */ }
    var escaped = escapeHtml(code);
    state.sqlStore[uid] = escaped;            // 与渲染同格式（已转义），执行/复制时 unescapeHtml
    // data-raw-sql / data-sql-fp 不是主路径（真相在台账 state.sqlStore），这里保留是给
    // 槽位模块和测试夹具的兼容读数。
    var html = '<pre class="aias-code-pre' + (sqlLike ? ' aias-sql-pre' : '') + '"'
      + ' data-sql-id="' + uid + '"'
      + ' data-sql-fp="' + sqlFingerprint(code) + '"'
      + ' data-raw-sql="' + escaped + '"'
      + (language ? ' data-lang="' + escapeHtml(language) + '"' : '') + '><code>'
      + escaped + '</code>';
    if (exec || hasSlots) {
      // 撤销按钮放在复制按钮**前面**（视觉上在它左侧）：同一套幽灵态样式。
      // 语义是「撤销我做的占位符替换」，**不碰语句本身** —— 语句可能已被 AI 修复过。
      var restoreTitle = t('webui.slot_restore_idle', '撤销占位符替换（当前没有替换记录）');
      html += '<button type="button" class="aias-pre-restore-btn is-idle" data-sql-id="' + uid
        + '" title="' + escapeHtml(restoreTitle) + '" aria-label="'
        + escapeHtml(t('webui.aias_restore_action', '撤销占位符替换')) + '">'
        + RESTORE_BTN_HTML + '</button>';
    }
    var copyTitle = exec ? t('webui.aias_copy_sql', '复制 SQL')
      : t('webui.aias_copy_code', '复制代码');
    html += '<button type="button" class="aias-pre-copy-btn" title="' + escapeHtml(copyTitle)
      + '" aria-label="' + escapeHtml(copyTitle) + '">' + COPY_BTN_HTML + '</button></pre>';
    if (exec) {
      // 执行栏三个动作排在一行：批量在左、执行在中、结果锚点在同一个 exec-wrap 里（id = sqlId + '-result'）。
      html += '<div class="aias-sql-exec-wrap">'
        + '<button type="button" class="aias-sql-batch-btn" data-sql-id="' + uid + '" title="'
        + escapeHtml(t('webui.aias_batch_title', '把这条 SQL 批量执行到多个同类库'))
        + '" aria-label="' + escapeHtml(t('webui.aias_batch_aria', '批量执行')) + '">≣ '
        + escapeHtml(t('webui.aias_batch_short', '批量')) + '</button>'
        + '<button type="button" class="aias-sql-exec-btn" data-sql-id="' + uid + '" aria-label="'
        + escapeHtml(t('webui.aias_exec_sql_aria', '执行 SQL')) + '"><span class="aias-exec-label">'
        + escapeHtml(t('webui.aias_exec_sql', '▶ 执行SQL')) + '</span></button>'
        + '<div class="aias-sql-result" id="' + uid + '-result"></div>'
        + '</div>';
    }
    return html;
  }

  /** HTML 实体还原：台账与 DOM 里存的都是转义后的文本，取用时先还原。 */
  function unescapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }

  /**
   * 代码块身份优先挂在 pre 自己身上（渲染层已给 data-sql-id），
   * 取不到才回落到「同层执行按钮上的 data-sql-id」——兼容被拆掉执行按钮的块。
   */
  function sqlIdOf(node) {
    if (!node) return '';
    var holder = node.getAttribute && node.getAttribute('data-sql-id')
      ? node : (node.closest ? node.closest('[data-sql-id]') : null);
    if (holder) return holder.getAttribute('data-sql-id') || '';
    var wrap = node.parentElement;
    var button = wrap ? wrap.querySelector('.aias-sql-exec-btn') : null;
    return button ? (button.getAttribute('data-sql-id') || '') : '';
  }

  /**
   * SQL 文本指纹：流式渲染每帧都会重建气泡 DOM，结果区/方言提示必须按「同一条 SQL」
   * 找得回来，否则一次重渲染就把用户刚跑出来的结果抹掉了。
   */
  function sqlFingerprint(sql) {
    var normalized = String(sql || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 400);
    var hash = 5381;
    for (var index = 0; index < normalized.length; index += 1) {
      hash = ((hash << 5) + hash + normalized.charCodeAt(index)) >>> 0;
    }
    return hash.toString(16);
  }

  /**
   * isLikelySql（宽口径）：只要以常见 SQL 关键字（含写/事务）开头就算「SQL 块」。
   * 用途仅是把 pre 挂上 `.aias-sql-pre`，使其能被多语句拆分扫描到；
   * 拆分后每条由后端 executable 判定，**写语句永远不会拿到执行按钮**。
   */
  var SQL_HEAD_KWS = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'USE', 'SET',
    'CALL', 'PREPARE', 'EXECUTE', 'ALTER', 'CREATE', 'DROP', 'TRUNCATE', 'RENAME', 'INSERT',
    'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'BEGIN', 'DECLARE', 'GRANT', 'REVOKE', 'COMMENT',
    'LOCK', 'UNLOCK', 'START', 'COMMIT', 'ROLLBACK', 'DO', 'TABLE', 'VALUES'];

  function stripLeadingComments(text) {
    return String(text || '').replace(/^--.*$/gm, '')
      .replace(/^\/\*[\s\S]*?\*\//, '').trim();
  }

  function startsWithAnyKeyword(upper, keywords) {
    for (var index = 0; index < keywords.length; index += 1) {
      var keyword = keywords[index];
      if (upper === keyword || upper.indexOf(keyword + ' ') === 0
          || upper.indexOf(keyword + '\n') === 0 || upper.indexOf(keyword + '\t') === 0) return true;
    }
    return false;
  }

  function isLikelySql(text) {
    var value = stripLeadingComments(String(text || '').trim());
    if (!value) return false;
    return startsWithAnyKeyword(value.toUpperCase(), SQL_HEAD_KWS);
  }

  /**
   * isLikelyReadSql（严格口径）：**只读查询 / 只读分析** 才允许出现「执行SQL/批量」按钮。
   * 写/事务语句（ALTER/CREATE/DROP/INSERT/UPDATE/DELETE…）一律不返回 true。
   * BEGIN / DECLARE 开头的匿名 PL/SQL 块不当一刀切处理，交给 plsqlBlockIsReadOnly 深扫块体。
   */
  var READ_HEAD_KWS = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'USE', 'SET',
    'CALL', 'PREPARE', 'EXECUTE', 'TABLE', 'VALUES'];

  function isLikelyReadSql(text) {
    var value = String(text || '').trim();
    if (!value) return false;
    value = stripLeadingComments(value);
    if (!value) return false;
    var upper = value.toUpperCase();
    if (upper.indexOf('BEGIN ') === 0 || upper.indexOf('BEGIN\n') === 0 || upper === 'BEGIN'
        || upper.indexOf('DECLARE ') === 0 || upper.indexOf('DECLARE\n') === 0
        || upper === 'DECLARE') {
      return plsqlBlockIsReadOnly(value);
    }
    return startsWithAnyKeyword(upper, READ_HEAD_KWS);
  }

  /**
   * 判断匿名 PL/SQL 块是否纯只读（口径与后端
   * _classify_plsql_block 一致）。四步顺序不能调：
   *   1) 先剥离字符串字面量，否则 'no update here' / 'commit test' 会把只读块误杀；
   *   2) 动态 SQL / 未知管理包**先于**普通写关键字判定（EXECUTE IMMEDIATE 走单词边界
   *      会被 EXECUTE 特例放过）；
   *   3) 显式写/DDL/事务关键字按单词边界判非只读；
   *   4) 剩下的纯只读分析块（DBMS_OUTPUT 打印视图统计之类）放行。
   */
  function plsqlBlockIsReadOnly(sql) {
    var text = String(sql || '');
    if (!text) return false;
    try {
      text = text.replace(new RegExp(PLSQL_FENCE, 'g'), ' ');
    } catch (ignore) { /* 字面量剥离失败就按原文继续判定 */ }
    var upper = text.toUpperCase();
    if (upper.indexOf('EXECUTE IMMEDIATE') !== -1) return false;
    for (var pkg = 0; pkg < PLSQL_DANGEROUS_PKGS.length; pkg += 1) {
      if (upper.indexOf(PLSQL_DANGEROUS_PKGS[pkg]) !== -1) return false;
    }
    for (var index = 0; index < PLSQL_WRITE_KWS.length; index += 1) {
      if (new RegExp('\\b' + PLSQL_WRITE_KWS[index] + '\\b').test(upper)) return false;
    }
    return true;
  }

  // ── 复制 ────────────────────────────────────────────────
  function copyText(value) {
    var text = String(value == null ? '' : value);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; },
        function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch (ignore) {
      return false;
    }
  }

  /**
   * 把代码元素里的 <br> 还原成换行再取纯文本。
   * 实体还原走字符串映射而不是 createElement('div') 解实体 ——
   * 结果一致，且能在无 DOM 的回归环境里跑（否则用例只能测个空串，等于没测）。
   */
  function preText(el) {
    var html = String((el && el.innerHTML) || '').replace(/<br\s*\/?>/gi, '\n');
    return html.replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }

  /**
   * 复制的成功反馈是「按钮变勾 + 标题换成已复制，1.5s 后还原」，
   * 且 http 环境/旧浏览器没有 async clipboard → 隐藏 textarea + execCommand 兜底。
   * （部署多为 http://IP:端口 访问，navigator.clipboard 在非安全上下文里根本不存在，
   *   没这条兜底就是「点了复制什么反应都没有」。）
   */
  function doCopy(text, btn) {
    if (!text) return;
    var done = function () {
      if (!btn || !btn.classList) return;
      var oldTitle = btn.getAttribute('data-title') || btn.getAttribute('title') ||
        t('webui.aias_copy_sql', '复制 SQL');
      if (!btn.getAttribute('data-title')) btn.setAttribute('data-title', oldTitle);
      btn.setAttribute('title', t('webui.aias_copied', '已复制'));
      btn.setAttribute('aria-label', t('webui.aias_copied', '已复制'));
      btn.classList.add('copied');
      setTimeout(function () {
        btn.classList.remove('copied');
        btn.setAttribute('title', oldTitle);
        btn.setAttribute('aria-label', oldTitle);
      }, 1500);
    };
    var fallback = function () {
      var area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); done(); } catch (ignore) { /* 复制失败不打断操作 */ }
      document.body.removeChild(area);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  /** 复制按钮所在的 SQL 块。 */
  function copySqlEl(btn) {
    var box = btn.parentElement;
    if (!box) return;
    doCopy(preText(box).replace(/\s*📋\s*$/, ''), btn);
  }

  /** 复制 .aias-pre-host 盒里的 pre。 */
  function copyPreBox(btn) {
    var host = btn.closest('.aias-pre-host');
    if (!host) return;
    var pre = host.querySelector('pre') || host;
    doCopy(preText(pre), btn);
  }

  /** 对所有代码块生效（可执行 SQL 块与不可执行的 DDL/脚本块都挂同一个按钮）。 */
  function copySqlPre(btn) {
    var pre = btn.closest('pre.aias-code-pre, pre.aias-sql-pre');
    if (!pre) return;
    var code = pre.querySelector('code') || pre;
    doCopy(preText(code), btn);
  }

  /**
   * 复制**台账里那份完整语句**（不是 DOM 可见文本）。
   * 用在拆分面板头部的「复制全部语句」按钮上 —— 台账里是原始整块 SQL，
   * 拆出来的子块 DOM 只有那一条，拿 DOM 会漏掉其余几条。
   */
  function copySqlRaw(btn) {
    var id = btn ? (btn.getAttribute('data-sql-id') || '') : '';
    if (!id) return;
    doCopy(unescapeHtml(state.sqlStore[id] || ''), btn);
  }

  /**
   * 流式进行中**不扫**（此刻 SQL 块是半截的，
   * 扫了只会闪一下又变），空闲时防抖 320ms 再发一次批量预检。
   */
  function scheduleDialectScan() {
    if (document.querySelector('.aias-cursor, .aias-drilldown-cursor, .aias-typing')) return;
    if (dialectScanTimer) clearTimeout(dialectScanTimer);
    dialectScanTimer = setTimeout(scanDialectSql, 320);
  }

  /** 同样让开流式帧，防抖 260ms 后拆句。 */
  function scheduleMultiSqlScan() {
    if (document.querySelector('.aias-cursor, .aias-drilldown-cursor, .aias-typing')) return;
    if (multiScanTimer) clearTimeout(multiScanTimer);
    multiScanTimer = setTimeout(scanMultiSql, 260);
  }

  /**
   * MutationObserver 兜底。
   * 渲染族里有些路径是「原地贴节点」（结果操作条、拆分面板重建、槽位面板写回），
   * 只靠 renderMessages 尾部那一次扫描会漏掉这些后出现的块；有观察器就补得上。
   */
  function initMultiSqlObserver() {
    if (multiObserver || typeof MutationObserver !== 'function') return;
    try {
      multiObserver = new MutationObserver(function (records) {
        var hit = false;
        for (var r = 0; r < records.length && !hit; r += 1) {
          var nodes = records[r].addedNodes || [];
          for (var i = 0; i < nodes.length; i += 1) {
            var node = nodes[i];
            if (!node || node.nodeType !== 1) continue;
            if (node.matches && node.matches('pre.aias-sql-pre')) { hit = true; break; }
            if (node.querySelector && node.querySelector('pre.aias-sql-pre')) { hit = true; break; }
          }
        }
        if (hit) scheduleMultiSqlScan();
      });
      multiObserver.observe(document.body, { childList: true, subtree: true });
    } catch (ignore) { /* 没有观察器只是少了兜底，主链路仍走渲染尾部扫描 */ }
  }

  /** 与槽位模块的接缝：把「还有未替换占位符」的提示交给槽位模块。 */
  function slotUpdateHint(pre) {
    if (window.FusionAiSqlSlots && window.FusionAiSqlSlots.updateHint) {
      window.FusionAiSqlSlots.updateHint(pre);
    }
  }

  /**
   * 与槽位模块的四个接缝：close / dropLedger / rebaseLedger / refreshRestoreBtn。
   * 槽位台账（右键替换、撤销替换）由槽位模块实现，
   * 这里只把助手页的调用点接好：模块没提供的方法走可选调用，不抛错。
   *   · close —— 拆分/重绘前关掉正开在这个块上的占位符菜单；
   *   · dropLedger —— 整块被换成子块，旧台账（连值一起）必须作废；
   *   · rebaseLedger —— 语句本身被改写（AI 修复 / 方言改写）时按新语句**重建基线**，
   *     否则「撤销替换」会把刚改好的语法又吃回去；
   *   · refreshRestoreBtn —— 台账变了，右上角撤销按钮的可用态与 tooltip 要跟着变。
   */
  function slotClose() {
    var slots = window.FusionAiSqlSlots;
    if (slots && slots.close) slots.close();
  }

  function slotDropLedger(pre) {
    var slots = window.FusionAiSqlSlots;
    if (slots && slots.dropLedger) slots.dropLedger(pre);
  }

  function slotRebaseLedger(pre, newSql) {
    var slots = window.FusionAiSqlSlots;
    if (slots && slots.rebaseLedger) slots.rebaseLedger(pre, newSql);
  }

  function slotRefreshRestoreBtn(pre) {
    var slots = window.FusionAiSqlSlots;
    if (slots && slots.refreshRestoreBtn) slots.refreshRestoreBtn(pre);
  }

  /**
   * 块右上角「撤销占位符替换」按钮。
   * 语义是「只撤值、不动语句本身」，替换记录由槽位模块维护；
   * 这里只做 DOM 侧的寻址与反馈动画，模块没提供入口时按指纹回落到 restoreOriginal。
   */
  function slotRestoreFromBlock(btn) {
    var pre = btn && btn.closest ? btn.closest('pre.aias-code-pre, pre.aias-sql-pre') : null;
    if (!pre) return;
    var slots = window.FusionAiSqlSlots;
    if (!slots) return;
    if (slots.restoreFromBlock) { slots.restoreFromBlock(pre); return; }
    var fp = sqlFingerprint(blockRawSql(pre));
    if (slots.restoreOriginal) slots.restoreOriginal(fp);
    btn.classList.add('done');
    setTimeout(function () { btn.classList.remove('done'); }, 1400);
    slotRefreshRestoreBtn(pre);
  }


  // ══════════════════════════════════════════════════════════
  // 会话 / 数据源 / 模型信息
  // ══════════════════════════════════════════════════════════

  function loadSessions() {
    return requestJson('/api/ai/sessions?limit=60').then(function (body) {
      state.sessions = (body && body.sessions) || [];
      renderSessionList();
      if (!state.sessionId && state.sessions.length) {
        return openSession(state.sessions[0].id);
      }
      return null;
    }).catch(function () {
      state.sessions = [];
      renderSessionList();
    });
  }

  function createSession() {
    return requestJson('/api/ai/sessions', { method: 'POST', body: JSON.stringify({ title: '' }) })
      .then(function (body) {
        var created = body && body.session;
        if (!created) { notify(body && body.error || t('webui.aias_create_failed', '新建会话失败'), 'error'); return null; }
        return loadSessions().then(function () { return openSession(created.id); })
          // 新建对话后光标直接落在输入框，省一次点击
          .then(function () { focusInput(100); });
      });
  }

  /** 聚焦输入框：进页面 200ms、新建会话 100ms 后各聚焦一次，等布局稳定再抢焦点。 */
  function focusInput(delay) {
    setTimeout(function () {
      var input = byId('aias-input');
      if (input && !input.disabled && typeof input.focus === 'function') input.focus();
    }, delay || 0);
  }

  function deleteSession(sessionId) {
    if (!window.confirm(t('webui.aias_confirm_delete_session', '确定删除此对话？删除后消息记录不可恢复。'))) {
      return Promise.resolve();
    }
    return requestJson('/api/ai/sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' })
      .then(function () {
        if (state.sessionId === sessionId) {
          // 删的是当前会话：先把消息区清空并立刻重渲染（侧栏只剩「新对话」时
          // 面板不能还挂着上一个会话的对话），随后由 loadSessions 落到剩下的第一条
          state.sessionId = '';
          state.messages = [];
          resetSqlLedgers();
          renderMessages();
        }
        return loadSessions();
      })
      .catch(function (failure) { notify(failure.message || t('webui.aias_delete_failed', '删除失败'), 'error'); });
  }

  function renameSession(sessionId, title) {
    // 空标题回落成「新对话」，否则后端 400、侧栏出现空白行
    var cleaned = String(title || '').trim() || t('webui.aias_new_title', '新对话');
    return requestJson('/api/ai/sessions/' + encodeURIComponent(sessionId) + '/rename',
      { method: 'POST', body: JSON.stringify({ title: cleaned.slice(0, 100) }) })
      .then(function (body) {
        if (body && body.ok === false) { notify(body.error || t('webui.aias_rename_failed', '重命名失败'), 'error'); return false; }
        return loadSessions().then(function () { return true; });
      });
  }

  function clearChat() {
    if (!state.sessionId) { state.messages = []; renderMessages(); return Promise.resolve(); }
    // 只有「真有内容」才问一次，空对话点清空不该弹确认框
    if (state.messages.length &&
        !window.confirm(t('webui.aias_confirm_clear', '确定清空当前对话？'))) return Promise.resolve();
    return requestJson('/api/ai/sessions/' + encodeURIComponent(state.sessionId) + '/clear',
      { method: 'POST' }).then(function (body) {
      var session = body && body.session;
      state.messages = [];
      resetSqlLedgers();
      state.sessionId = session ? session.id : '';
      return loadSessions().then(function () { renderMessages(); });
    });
  }

  function openSession(sessionId) {
    state.sessionId = sessionId || '';
    resetSqlLedgers();          // 结果区属于上一个会话的上下文，切会话时不带过去
    renderSessionList();
    updateTopbarTitle();
    refreshDatasourceCapsule();  // 每条会话的执行源不同，切会话要跟着刷胶囊
    if (!sessionId) { state.messages = []; return renderMessages(); }
    return requestJson('/api/ai/sessions/' + encodeURIComponent(sessionId) + '/messages')
      .then(function (body) {
        state.messages = pairMessages((body && body.messages) || []);
        renderMessages();
        return hydrateMessagesFromTasks();
      })
      .catch(function () { state.messages = []; renderMessages(); });
  }

  /**
   * 历史会话回填「深度思考 + 理解 + 工具轨迹」。
   * 消息表只存正文，思考与工具步骤存在任务表里（一问 = 一个 task），
   * 不回填的话刷新后回答只剩一段文字，看不到模型当时是怎么查的。
   */
  function hydrateMessagesFromTasks() {
    var wanted = {};
    state.messages.forEach(function (message, index) {
      if (message.role !== 'ai' || !message.taskId) return;
      if (message.toolChainHtml || message.thinkingContent) return;
      (wanted[message.taskId] = wanted[message.taskId] || []).push(index);
    });
    var ids = Object.keys(wanted).slice(0, 12);   // 长会话只回填最近 12 问，够用了
    if (!ids.length) return Promise.resolve();
    return Promise.all(ids.map(function (taskId) {
      return requestJson('/api/ai/tasks/' + encodeURIComponent(taskId))
        .then(function (body) { return { taskId: taskId, task: (body && body.task) || null }; })
        .catch(function () { return { taskId: taskId, task: null }; });
    })).then(function (rows) {
      var changed = false;
      rows.forEach(function (row) {
        var task = row.task;
        if (!task) return;
        (wanted[row.taskId] || []).forEach(function (index) {
          var message = state.messages[index];
          if (!message || message.taskId !== row.taskId) return;
          message.understandingContent = message.understandingContent || task.understanding || '';
          message.thinkingContent = message.thinkingContent || task.thinking_content || '';
          if (!message.toolChainHtml) {
            message.toolChainHtml = buildToolChainHtml(task.reasoning || '',
              stepsFromTask(task.tool_steps), false);
          }
          restoreManualResults(index, task);
          changed = true;
        });
      });
      if (changed) renderMessages();
    });
  }

  /**
   * 历史里的「用户手点执行」结果也要还原：执行记录存在任务的 tool_steps 里
   * （source=manual，带列名与前 20 行预览），按 SQL 文本找回对应的代码块。
   * 不还原的话，刷新后代码块还在、结果表没了，用户只能重跑一遍。
   */
  function restoreManualResults(messageIndex, task) {
    var steps = (task.tool_steps || []).filter(function (step) {
      return step.source === 'manual' && step.arguments && step.arguments.sql;
    });
    steps.forEach(function (step) {
      var sql = String(step.arguments.sql || '');
      var uid = uidForSqlInMessage(messageIndex, sql);
      if (!uid) return;
      var summary = step.result || {};
      var body = summary.ok === false
        ? { ok: false, error: summary.error || t('webui.aias_exec_failed', '执行失败'), db_error: true }
        : { ok: true, result: { columns: summary.columns || [],
                                rows: summary.preview_rows || summary.rows || [],
                                total: summary.total, truncated: summary.truncated,
                                var_name: summary.var_name, rewrite_note: summary.rewrite_note,
                                duration_ms: step.elapsed_ms } };
      var stored = state.blockExtras[uid] || {};
      stored.fp = sqlFingerprint(sql);
      stored.result = resultHtml(body, step.arguments.datasource_name || '', sql);
      state.blockExtras[uid] = stored;
    });
  }

  /** 在某条消息的代码块里按 SQL 文本找块身份（执行记录只存了语句，没存 uid）。 */
  /** 属性读数兜底（台账没有这一句时，用渲染时留在 pre 上的 data-raw-sql）。 */
  function blockAttr(node, name) {
    return node && node.getAttribute ? (node.getAttribute(name) || '') : '';
  }

  function uidForSqlInMessage(messageIndex, sql) {
    var norm = String(sql || '').toLowerCase().replace(/\s+/g, ' ').trim();
    var host = byId('aias-messages');
    if (!host || !host.querySelector) return '';
    // SQL 块的身份挂在 pre 自己身上（data-sql-id），没有额外的容器层。
    var blocks = host.querySelectorAll('.aias-msg[data-idx="' + messageIndex +
                                       '"] pre.aias-sql-pre');
    var found = '';
    Array.prototype.forEach.call(blocks, function (pre) {
      if (found) return;
      // 比对走台账（blockRawSql），data-raw-sql 只是台账缺失时的兜底读数
      var raw = String(blockRawSql(pre) || blockAttr(pre, 'data-raw-sql') || '')
        .toLowerCase().replace(/\s+/g, ' ').trim();
      if (raw === norm) found = pre.getAttribute('data-sql-id') || '';
    });
    return found;
  }

  /**
   * 任务表里的 tool_steps → 轨迹卡的步骤形状（字段名与流式期间构造的那一份一致：
   * tool / arguments / status / duration_ms / result / progress）。
   * 历史回填与流式期间构造的是同一种结构，轨迹卡渲染才能完全复用。
   */
  function stepsFromTask(steps) {
    return (steps || []).map(function (step) {
      return {
        tool: step.tool || '',
        arguments: step.arguments || {},
        status: step.status === 'error' ? 'error' : 'success',
        result: step.result === undefined ? null : step.result,
        duration_ms: step.elapsed_ms || 0,
        round: step.round || 1,
        source: step.source || ''
      };
    });
  }

  /**
   * 后端消息是逐条存的用户/助手记录，渲染时两两配对成气泡。
   * 顺带把助手消息重新渲染成 HTML（含 SQL 代码块，可再次执行）。
   */
  function pairMessages(rows) {
    var paired = [];
    rows.forEach(function (row) {
      if (row.role === 'user') {
        paired.push({ role: 'user', content: row.content || '', taskId: row.task_id || '' });
      } else {
        paired.push({ role: 'ai', content: row.content || '', taskId: row.task_id || '',
                      thinkingContent: '', toolChainHtml: '' });
      }
    });
    return paired;
  }

  function currentSession() {
    return state.sessions.filter(function (item) { return item.id === state.sessionId; })[0] || null;
  }

  // 顶栏只显示「当前会话标题」；页面名归应用顶栏，这里不再重复一遍，
  // 否则出现「🤖 AI 巡检助手 / AI 巡检助手」两层同款标题。
  function updateTopbarTitle() {
    var host = byId('aias-topbar-title');
    if (!host) return;
    var fallback = t('webui.aias_new_title', '新对话');
    var session = currentSession();
    host.textContent = (session && session.title) || fallback;
  }

  function renderSessionList() {
    var host = byId('aias-session-list');
    if (!host) return;
    if (!state.sessions.length) {
      host.innerHTML = '<div class="aias-session-empty">' +
        escapeHtml(t('webui.aias_no_session', '还没有对话，点「新建对话」开始')) + '</div>';
      return;
    }
    host.innerHTML = state.sessions.map(function (session) {
      var active = session.id === state.sessionId ? ' active' : '';
      var count = Number(session.message_count || 0);
      return '<div class="aias-session-item' + active + '" data-session-id="' +
        escapeHtml(session.id) + '" title="' +
        escapeHtml(session.title || t('webui.aias_new_title', '新对话')) + '">' +
        '<span class="aias-session-ico">💬</span>' +
        '<span class="aias-session-title">' +
        escapeHtml(session.title || t('webui.aias_new_title', '新对话')) + '</span>' +
        '<span class="aias-session-meta">' +
        escapeHtml(fmtCount(t('webui.aias_msg_count', '{n} 条'), count)) + '</span>' +
        // ✎ / ✕ 包在 actions 里：CSS 让它们默认隐身、悬停这一行才出现
        '<span class="aias-session-actions">' +
        '<button type="button" class="aias-session-rename" title="' +
        escapeHtml(t('webui.aias_rename', '重命名')) + '">✎</button>' +
        '<button type="button" class="aias-session-del" title="' +
        escapeHtml(t('webui.aias_delete', '删除')) + '">✕</button>' +
        '</span></div>';
    }).join('');
    updateTopbarTitle();
  }

  function fmtCount(template, value) {
    return String(template || '{n} 条').replace('{n}', String(value));  // i18n-fallback 兜底文案，真值走 i18n key
  }

  /** i18n 文案里的占位符填充：{n} / {total} / {ds} … 由调用方给字典。 */
  function tpl(key, fallback, values) {
    var text = t(key, fallback);
    Object.keys(values || {}).forEach(function (name) {
      text = text.split('{' + name + '}').join(String(values[name]));
    });
    return text;
  }

  function sessionById(sessionId) {
    return state.sessions.filter(function (item) { return item.id === sessionId; })[0] || null;
  }

  /** 列表里找到某一行的 DOM（重命名要在原地换内容，不能整表重绘）。 */
  function sessionRow(sessionId) {
    var host = byId('aias-session-list');
    if (!host || !host.querySelectorAll) return null;
    var rows = host.querySelectorAll('[data-session-id]');
    for (var index = 0; index < rows.length; index += 1) {
      if (rows[index].getAttribute('data-session-id') === sessionId) return rows[index];
    }
    return null;
  }

  /**
   * 行内重命名：点 ✎ 直接把这一行换成输入框，
   * Enter 保存 / Esc 取消，不再是浏览器 prompt() 弹窗——prompt 没法选中文本、
   * 也不受 maxlength 约束，改一两条会话标题时很别扭。
   */
  function startRename(sessionId) {
    var row = sessionRow(sessionId);
    var session = sessionById(sessionId);
    if (!row || !session) return;
    state.renamingSessionId = sessionId;
    row.classList.add('editing');
    row.innerHTML = '<input class="aias-session-rename-input" id="aias-rename-input-' +
      escapeHtml(sessionId) + '" maxlength="100" value="' +
      escapeHtml(session.title || t('webui.aias_new_title', '新对话')) + '">' +
      '<div class="aias-session-rename-actions">' +
      '<button type="button" class="aias-rename-save">' +
      escapeHtml(t('webui.save', '保存')) + '</button>' +
      '<button type="button" class="aias-rename-cancel">' +
      escapeHtml(t('webui.cancel', '取消')) + '</button></div>';
    var input = byId('aias-rename-input-' + sessionId);
    if (input) {
      input.focus();
      if (typeof input.select === 'function') input.select();   // 全选旧标题，直接敲新名字就能覆盖
    }
  }

  function saveRename(sessionId) {
    var input = byId('aias-rename-input-' + sessionId);
    state.renamingSessionId = '';
    if (!input) { renderSessionList(); return; }
    // 空标题不算改，落回「新对话」再保存，成功后给一句「已重命名」
    var title = String(input.value || '').trim() || t('webui.aias_new_title', '新对话');
    renderSessionList();   // 先退出编辑态：请求失败也不会把输入框卡在列表里
    renameSession(sessionId, title).then(function (done) {
      if (done) notify(t('webui.aias_renamed', '已重命名'), 'success');
    });
  }

  function cancelRename(sessionId) {
    state.renamingSessionId = '';
    renderSessionList();   // 取消即整表重绘，恢复原始列表
  }

  /** 输入框里的回车/取消（列表上委托，重绘后不用重新绑定）。 */
  function onRenameKeydown(event) {
    var target = event && event.target;
    if (!hasClass(target, 'aias-session-rename-input')) return;
    var row = typeof target.closest === 'function' ? target.closest('.aias-session-item') : null;
    var sessionId = (row && row.getAttribute('data-session-id')) || state.renamingSessionId;
    if (!sessionId) return;
    if (event.key === 'Enter') { event.preventDefault(); saveRename(sessionId); }
    else if (event.key === 'Escape') { event.preventDefault(); cancelRename(sessionId); }
  }

  /** 兼容真假 DOM：两边的 class 都能用 getAttribute('class') 取到。 */
  function hasClass(el, name) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    return String(el.getAttribute('class') || '').indexOf(name) >= 0;
  }

  function loadDatasources() {
    return requestJson('/api/pro/datasources').then(function (body) {
      state.datasources = (body && (body.datasources || body.instances)) || [];
      renderDatasourceOptions();
      refreshDatasourceCapsule();
    }).catch(function () { /* 数据源拉不到不影响对话本身 */ });
  }

  function datasourceByName(name) {
    var needle = String(name || '').toLowerCase();
    return state.datasources.filter(function (item) {
      return String(item.name || '').toLowerCase() === needle;
    })[0] || null;
  }

  function renderDatasourceOptions() {
    var select = byId('aias-ds-select');
    if (!select) return;
    var html = '<option value="">' +
      escapeHtml(t('webui.aias_ds_auto', '（数据源：自动识别）')) + '</option>';
    state.datasources.forEach(function (item) {
      html += '<option value="' + escapeHtml(item.name || item.id) + '">' +
        escapeHtml(item.name || item.id) + ' · ' + escapeHtml(item.db_type || '') + '</option>';
    });
    select.innerHTML = html;
    select.value = state.defaultDatasource || '';
  }


  // 侧栏底部的模型状态：tone = ok | off | warn
  function setModelInfo(text, tone) {
    var host = byId('aias-model-info');
    if (!host) return;
    host.textContent = text;
    host.classList.toggle('is-off', tone === 'off');
    host.classList.toggle('is-warn', tone === 'warn');
  }

  // 模型信息：四种状态各说各话。
  // 早期版本把「一切非 ok」都写成「AI 未启用」，结果登录过期（401）或后端没重启
  // （404）时也这么显示，DBA 白折腾一遍 AI 设置。现在按状态码分派。
  function loadModelInfo() {
    if (!byId('aias-model-info')) return;
    requestJson('/api/ai/assistant/model').then(function (body) {
      var status = Number(body && body.httpStatus) || 0;
      if (status === 401 || status === 403) {
        state.modelLabel = '';
        setModelInfo(t('webui.aias_model_login_expired', '登录已过期，请重新登录'), 'warn');
        return;
      }
      if (status === 404 || status === 405) {
        state.modelLabel = '';
        setModelInfo(t('webui.aias_model_stale', '助手接口未就绪，请重启服务'), 'warn');
        return;
      }
      if (!body || body.ok !== true) {
        state.modelLabel = '';
        setModelInfo(t('webui.aias_model_failed', '模型配置读取失败'), 'warn');
        return;
      }
      if (!body.available) {
        state.modelLabel = '';
        setModelInfo(t('webui.aias_ai_off', 'AI 未启用（请到「AI 设置」启用后端）'), 'off');
        return;
      }
      state.modelLabel = body.model || body.label || '';
      setModelInfo(state.modelLabel, 'ok');
    }).catch(function () {
      state.modelLabel = '';
      setModelInfo(t('webui.aias_model_failed', '模型配置读取失败'), 'warn');
    });
  }

  // ══════════════════════════════════════════════════════════
  // 消息区渲染
  // ══════════════════════════════════════════════════════════

  function welcomeHtml() {
    // 空会话的欢迎页：图标 + 标题 + 副标题 + 四张建议卡
    //（卡片是「点一下直接发问」，不是填进输入框）。文案走 i18n，兜底为中文原文。
    // 卡面文字与点出去问的话是两回事（卡面「查看巡检模板」，实际问「有哪些巡检模板」）
    var suggestions = [
      { icon: '📊', label: t('webui.aias_q_datasources', '查看所有数据源'),
        ask: t('webui.aias_q_datasources_ask', '查看所有数据源') },
      { icon: '📋', label: t('webui.aias_q_templates', '查看巡检模板'),
        ask: t('webui.aias_q_templates_ask', '有哪些巡检模板') },
      { icon: '🏠', label: t('webui.aias_q_overview', '系统状态概览'),
        ask: t('webui.aias_q_overview_ask', '系统状态概览') },
      { icon: '⚡', label: t('webui.aias_q_slow', '查看慢查询监控'),
        ask: t('webui.aias_q_slow_ask', '查看慢查询监控') }
    ];
    return '<div class="aias-welcome">' +
      '<div class="aias-welcome-icon">🤖</div>' +
      '<h2>' + escapeHtml(t('webui.ai_assistant_title', 'AI 巡检助手')) + '</h2>' +
      '<p>' + escapeHtml(t('webui.aias_welcome_sub', '自然语言驱动 · 工具智能调用 · 上下文感知')) + '</p>' +
      '<div class="aias-suggestion-grid">' + suggestions.map(function (item) {
        return '<div class="aias-suggestion-card" data-quick-question="' + escapeHtml(item.ask) + '">' +
          '<span class="aias-suggestion-icon">' + item.icon + '</span>' +
          '<span>' + escapeHtml(item.label) + '</span></div>';
      }).join('') + '</div></div>';
  }

  /**
   * 正文里如果自带「**理解你的需求** + 理解内容」那一段（落库时就是这么存的），
   * 拆成 (理解文本, 剩下的正文)：理解单独成块，正文里那份必须剥掉，
   * 否则刷新后同一句话在界面上出现两遍。
   */
  function splitUnderstanding(content) {
    var text = String(content || '');
    var matched = text.match(/^[\s]*\*\*[\s]*(?:\[[A-Z]+\][\s]*)?理解你的需求[\s]*\*\*[\s]+([\s\S]*?)[\s]{2,}/);
    if (!matched) return { understanding: '', content: text };
    return { understanding: (matched[1] || '').trim(), content: text.slice(matched[0].length) };
  }

  /**
   * 单条消息 DOM 的层次结构：
   * .aias-msg[data-idx] > .aias-msg-avatar + .aias-msg-content > (.aias-msg-role
   * + .aias-msg-text#aias-msg-text-{idx} + 编辑区(仅用户) + .aias-msg-actions)。
   * 注意正文宿主就是 .aias-msg-text，思考块/理解/工具链/确认卡/结果操作条全在它内部：
   * 流式的四个更新函数、结果操作条兜底观察器都按这个前提工作，改宿主名字会全线失联。
   * 交互一律走 data-* + 事件委托，模块内不外露全局函数（内联 onclick 需要全局名，会污染 window）。
   */
  function messageHtml(message, index) {
    var isUser = message.role === 'user';
    var body = isUser ? escapeHtml(message.content || '') : messageInnerHtml(message, index);
    var actions = '<div class="aias-msg-actions">' +
      (isUser
        ? '<button type="button" class="aias-action-btn" data-action="edit">✏️ ' +
          escapeHtml(t('webui.aias_edit_resend', '编辑重发')) + '</button>'
        : '<button type="button" class="aias-action-btn" data-action="copy">📋 ' +
          escapeHtml(t('webui.aias_copy', '复制')) + '</button>' +
          '<button type="button" class="aias-action-btn" data-action="regenerate">🔄 ' +
          escapeHtml(t('webui.aias_regenerate', '重新生成')) + '</button>') +
      '</div>';
    return '<div class="aias-msg ' + (isUser ? 'user' : 'ai') + '" data-idx="' + index + '">' +
      '<div class="aias-msg-avatar">' + (isUser ? '🧑' : '🤖') + '</div>' +
      '<div class="aias-msg-content">' +
      '<div class="aias-msg-role">' +
      (isUser ? escapeHtml(t('webui.aias_role_me', '你'))
              : escapeHtml(t('webui.aias_role_ai', 'AI 巡检助手'))) + '</div>' +
      '<div class="aias-msg-text" id="aias-msg-text-' + index + '">' + body + '</div>' +
      (isUser ? editAreaHtml(message, index) : '') + actions + '</div></div>';
  }

  /** 行内编辑区（仅用户气泡）：取消 / 保存并重发，样式靠 .aias-edit-area.active 控制显隐。 */
  function editAreaHtml(message, index) {
    return '<div class="aias-edit-area" id="aias-edit-area-' + index + '">' +
      '<textarea class="aias-edit-textarea" id="aias-edit-input-' + index + '">' +
      escapeHtml(message.content || '') + '</textarea>' +
      '<div class="aias-edit-actions">' +
      '<button type="button" class="aias-edit-btn cancel" data-edit-action="cancel">' +
      escapeHtml(t('webui.cancel', '取消')) + '</button>' +
      '<button type="button" class="aias-edit-btn save" data-edit-action="save">' +
      escapeHtml(t('webui.aias_edit_save', '保存并重发')) + '</button>' +
      '</div></div>';
  }

  /**
   * 展开某条提问的行内编辑器：
   * 正文先藏起来、编辑框按内容撑开高度并聚焦；生成中不开编辑器。
   */
  function startEdit(index) {
    if (state.generating) return;
    var message = state.messages[index];
    if (!message || message.role !== 'user') return;
    var area = byId('aias-edit-area-' + index);
    if (!area) return;
    var text = byId('aias-msg-text-' + index);
    if (text) text.style.display = 'none';
    area.classList.add('active');
    var input = byId('aias-edit-input-' + index);
    if (input) {
      input.value = message.content || '';
      if (typeof input.focus === 'function') input.focus();
      input.style.height = 'auto';
      input.style.height = (input.scrollHeight || 0) + 'px';   // 按内容展开，别一上来就滚动条
    }
    state.editingIndex = index;
  }

  /** 取消编辑：正文原样回来，编辑区收起（是「恢复」而非重发）。 */
  function cancelEdit(index) {
    var area = byId('aias-edit-area-' + index);
    if (area) area.classList.remove('active');
    var text = byId('aias-msg-text-' + index);
    if (text) text.style.display = '';
    state.editingIndex = -1;
  }

  /**
   * 保存并重发：改掉这条提问、丢掉它之后的所有回答，再从这条重问。
   * 不能写成「留下改过的那条 + 再 push 一条同样的提问」，那样界面上会出现两个一样的气泡，
   * 本仓库按同一意图实现：只保留一条改后的提问，后面接一条新的回答。
   */
  function saveEdit(index) {
    if (state.generating) return;
    var message = state.messages[index];
    var input = byId('aias-edit-input-' + index);
    if (!message || !input) return;
    var text = String(input.value || '').trim();
    if (!text) return;
    cancelEdit(index);
    message.content = text;
    state.messages = state.messages.slice(0, index + 1);
    state.messages.push(newAiMessage());
    state.userScrolledUp = false;
    renderMessages();
    streamRequest(text, state.messages.length - 1, {});
  }

  /**
   * 单条 AI 消息的正文 HTML —— 渲染顺序：
   * 思考过程 → 理解文本（后补 <hr>）→ 工具链路 → 分析文本（Markdown）→ 确认卡。
   * 工具链直接取消息上已建好的 HTML 字符串（构建结果存在
   * msg.toolChainHtml 上，重建气泡时不再二次拼步骤）。
   */
  function messageInnerHtml(message, index) {
    var parts = [];
    var scope = 'm' + index;
    if (message.thinkingContent) parts.push(buildThinkingHtml(message.thinkingContent, false, true));
    var stored = splitUnderstanding(message.content || '');
    var understanding = message.understandingContent || stored.understanding;
    var analysis = message.content || '';
    if (message.understandingContent && analysis.indexOf(message.understandingContent) === 0) {
      analysis = analysis.substring(message.understandingContent.length).replace(/^[\s]+/, '');
    } else if (stored.understanding) {
      analysis = stored.content;
    }
    if (understanding) {
      parts.push(markdownToHtml(understanding, scope + '-u') + '<hr style="margin:12px 0;">');
    }
    if (message.toolChainHtml) parts.push(message.toolChainHtml);
    if (analysis) parts.push(markdownToHtml(analysis, scope));
    if (message.needConfirmation && message.confirmOptions) parts.push(confirmationHtml(message));
    return parts.join('');
  }

  /**
   * 整屏重绘：欢迎页或全部消息，随后对每条 AI 正文
   * 补挂结果操作条 + 多语句拆分。漏这一步的表现就是
   * 漏掉这一步就会「刷新页面后历史回答全都没有复制按钮，只有本次新生成的才有」。
   */
  function renderMessages() {
    var host = byId('aias-messages');
    if (!host) return;
    bindMessageDom();          // 委托监听要先挂上：空会话只渲染欢迎页，早退的话建议卡点了没反应
    initResultBarObserver();   // 兜底观察器装在提前 return 之前，空会话时也要在
    if (!state.messages.length) {
      host.innerHTML = welcomeHtml();
      return;
    }
    host.innerHTML = state.messages.map(messageHtml).join('');
    Array.prototype.forEach.call(host.querySelectorAll('.aias-msg.ai .aias-msg-text'), function (text) {
      enhanceResults(text);
    });
    // 这一层是**文档级**扫描（拆分与方言预检都 querySelectorAll(document)），
    // 所以只在整块重绘后跑一次，不逐条气泡跑一遍（防抖句柄会互相踩）。
    refreshSqlBlockLayer(host);
    syncSlotBlocks(host);
    scrollToBottom(true);
  }


  function syncSlotBlocks(host) {
    if (window.FusionAiSqlSlots) window.FusionAiSqlSlots.afterRender(host || byId('aias-messages'));
  }

  /**
   * 流式渲染：rAF + 最小间隔节流，滚动位置快照恢复。
   * 用户往上翻看时不抢滚动，否则长回答没法读。
   */
  /** 把节流队列里没落的最后一帧立刻补上：停止时界面得定格在最终状态。 */
  /**
   * 滚动只认「真实滚动」。
   * 监听里用 e.isTrusted 把关：脚本 dispatchEvent 出来的假 scroll 事件
   * （自动化脚本、以及代码里主动 dispatch 出来的滚动帧）不参与判定，免得把「用户在翻看上文」
   * 这个状态误置成 true —— 一旦置上，流式自动滚动就此停住，看着像页面卡住不跟了。
   */
  /**
   * 滚到底。
   * instant=true 直接跳（流式跟随、切会话）；false 平滑滚（用户点「有新内容」提示条，
   * 用 smooth —— 突然跳底会把正在读的位置整个丢掉）。
   */
  function scrollToBottom(instant) {
    var host = byId('aias-messages');
    if (!host) return;
    state.userScrolledUp = false;
    if (!instant && typeof host.scrollTo === 'function') {
      host.scrollTo({ top: host.scrollHeight, behavior: 'smooth' });
    } else {
      host.scrollTop = host.scrollHeight;
    }
    hideScrollPrompt();
  }

  function showScrollPrompt() {
    if (state.scrollPrompt) return;            // 提示条已经挂着：别每帧都写一次样式
    var prompt = byId('aias-scroll-prompt');
    if (!prompt) return;
    prompt.style.display = 'flex';
    state.scrollPrompt = true;
  }

  function hideScrollPrompt() {
    state.scrollPrompt = false;
    var prompt = byId('aias-scroll-prompt');
    if (prompt) prompt.style.display = 'none';
  }

  // ══════════════════════════════════════════════════════════
  // 渲染与流式
  // （scheduleRender / renderFrame / flushRender / smartRender /
  //   updateMessage 四件套 / finalizeMessage / renderThinking 族 /
  //   buildToolChainHtml / buildConfirmationHtml / enhanceResults 族）
  // ══════════════════════════════════════════════════════════

  /** 只留最后一帧待渲染，rAF 合并。 */
  function scheduleRender(fn) {
    state.renderPending = fn;
    if (state.renderRafId) return;          // 已有一帧在等，合并即可
    state.renderRafId = requestAnimationFrame(renderFrame);
  }

  /** 帧回调：间隔不足要排到下一帧（不是丢弃这一帧，丢了界面就停在旧内容上）。 */
  function renderFrame(timestamp) {
    state.renderRafId = 0;
    if (!state.renderPending) return;
    var elapsed = timestamp - state.renderLastTime;
    if (elapsed < RENDER_MIN_INTERVAL) {
      state.renderRafId = requestAnimationFrame(renderFrame);
      return;
    }
    var pending = state.renderPending;
    state.renderPending = null;
    state.renderLastTime = timestamp;
    pending();
  }

  /** 取消等待帧并立刻把攒着的那一帧落盘（最终渲染不能被节流拖住）。 */
  function flushRender() {
    if (state.renderRafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(state.renderRafId);
      state.renderRafId = 0;
    }
    if (state.renderPending) {
      var pending = state.renderPending;
      state.renderPending = null;
      pending();
    }
  }

  /**
   * 重建 DOM 前后保住视图。
   * 关键点一是「以几何判定是否在底部」而不是只看标记位（标记位会被误置，
   * 一旦误置流式就不再跟随，看着像卡住）；二是贴底时只在内容确实长高才滚，
   * 单调向下 —— 整块 innerHTML 重建瞬间 scrollHeight 会回落，机械赋值就一帧一抖。
   */
  function smartRender(msgArea, renderFn) {
    if (!msgArea) { renderFn(); return; }
    var savedScrollTop = msgArea.scrollTop;
    var savedScrollHeight = msgArea.scrollHeight;
    var wasAtBottom = (savedScrollHeight - savedScrollTop - msgArea.clientHeight) < BOTTOM_TOLERANCE;
    renderFn();
    if (state.userScrolledUp && !wasAtBottom) {
      msgArea.scrollTop = savedScrollTop;
      if (msgArea.scrollHeight > savedScrollHeight + 4) showScrollPrompt();
    } else {
      if (msgArea.scrollHeight > savedScrollHeight + 2) msgArea.scrollTop = msgArea.scrollHeight;
      state.userScrolledUp = false;
    }
  }

  /** 四个流式渲染点共用的前置守卫：用户在上翻看前文时，这一帧不重建 DOM。 */
  function streamingSkip(streaming, active) {
    if (active === undefined) active = streaming;
    return active && state.userScrolledUp;
  }

  /** 无工具链的流式正文。 */
  function updateMessage(idx, content, streaming) {
    scheduleRender(function () {
      var msgText = byId('aias-msg-text-' + idx);
      if (!msgText || streamingSkip(streaming)) return;
      smartRender(byId('aias-messages'), function () {
        var html = markdownToHtml(content, 'm' + idx);
        if (streaming) html += '<span class="aias-cursor"></span>';
        msgText.innerHTML = html;
        if (!streaming) {
          refreshSqlBlockLayer(msgText);
          enhanceResults(msgText);
        }
      });
    });
  }

  /** 流式更新：思考块 + 正文。 */
  function updateMessageWithThinking(idx, thinkingHtml, content, streaming) {
    scheduleRender(function () {
      var msgText = byId('aias-msg-text-' + idx);
      if (!msgText || streamingSkip(streaming)) return;
      smartRender(byId('aias-messages'), function () {
        var html = (thinkingHtml || '') + markdownToHtml(content, 'm' + idx);
        if (streaming) html += '<span class="aias-cursor"></span>';
        var snap = snapshotThinkingView(msgText);
        msgText.innerHTML = html;
        applyThinkingView(msgText, snap);
        if (!streaming) {
          refreshSqlBlockLayer(msgText);
          enhanceResults(msgText);
        }
      });
    });
  }

  /** 流式更新：工具链路 + 分析文本。 */
  function updateMessageWithTools(idx, toolChainHtml, analysisMd, streaming) {
    scheduleRender(function () {
      var msgText = byId('aias-msg-text-' + idx);
      if (!msgText || streamingSkip(streaming)) return;
      smartRender(byId('aias-messages'), function () {
        var html = (toolChainHtml || '') + markdownToHtml(analysisMd || '', 'm' + idx);
        if (streaming) html += '<span class="aias-cursor"></span>';
        msgText.innerHTML = html;
        if (!streaming) {
          refreshSqlBlockLayer(msgText);
          enhanceResults(msgText);
        }
      });
    });
  }

  /** 流式更新：思考 + 工具链 + 分析（主路径就用这个）。 */
  function updateMessageWithToolsAndThinking(idx, combinedHtml, analysisMd, streaming) {
    scheduleRender(function () {
      var msgText = byId('aias-msg-text-' + idx);
      if (!msgText || streamingSkip(streaming)) return;
      smartRender(byId('aias-messages'), function () {
        var html = (combinedHtml || '') + markdownToHtml(analysisMd || '', 'm' + idx);
        if (streaming) html += '<span class="aias-cursor"></span>';
        var snap = snapshotThinkingView(msgText);
        msgText.innerHTML = html;
        applyThinkingView(msgText, snap);
        if (!streaming) {
          refreshSqlBlockLayer(msgText);
          enhanceResults(msgText);
        }
      });
    });
  }

  /**
   * 流结束时的最终定格。
   * 先 flushRender 把节流队列里的帧逼出来，再按「思考 → 理解(+hr) → 工具链 → 分析 → 确认卡」
   * 整块重建；重建会抹掉流式里已拆好的多语句子块，所以要再跑一次 SQL 校验/拆分。
   */
  function finalizeMessage(idx) {
    flushRender();
    var msgText = byId('aias-msg-text-' + idx);
    var message = state.messages[idx];
    if (!msgText || !message) {
      handleScroll();
      if (!state.generating) hideScrollPrompt();
      return;
    }
    var thinkingHtml = message.thinkingContent
      ? buildThinkingHtml(message.thinkingContent, false, true) : '';
    var understanding = message.understandingContent || '';
    var analysis = message.content || '';
    if (understanding && analysis.indexOf(understanding) === 0) {
      analysis = analysis.substring(understanding.length).replace(/^[\s]+/, '');
    }
    var understandingHtml = understanding
      ? markdownToHtml(understanding, 'm' + idx + '-u') + '<hr style="margin:12px 0;">' : '';
    var confirmHtml = (message.needConfirmation && message.confirmOptions)
      ? buildConfirmationHtml(message.confirmQuestion, message.confirmOptions) : '';
    smartRender(byId('aias-messages'), function () {
      msgText.innerHTML = thinkingHtml + understandingHtml + (message.toolChainHtml || '')
        + markdownToHtml(analysis, 'm' + idx) + confirmHtml;
      enhanceResults(msgText);
      refreshSqlBlockLayer(msgText);
      syncSlotBlocks(byId('aias-messages'));
    });
    if (!state.generating) hideScrollPrompt();
  }

  // ── 深度思考块：构建 / 渲染 / 原地更新 ──

  /**
   * 思考完成后**默认展开**（要让人看到模型怎么想的），
   * 只有同时显式给出 collapsed 才折叠；done 未传时按 collapsed 反推。
   */
  function buildThinkingHtml(content, collapsed, done) {
    var isDone = done !== undefined ? !!done : !!collapsed;
    var isCollapsed = (done !== undefined && collapsed) ? ' collapsed' : '';
    var headerIcon = isDone
      ? '<span class="aias-thinking-done-icon">✅</span>' : '🧠';
    var headerText = isDone
      ? t('webui.aias_thinking_done', '深度思考（已完成）')
      : t('webui.aias_thinking_running', '深度思考中...');
    return '<div class="aias-thinking' + isCollapsed + '">' +
      '<div class="aias-thinking-header" data-thinking-toggle>' +
      '<span class="aias-thinking-icon">' + headerIcon + '</span>' +
      '<span class="aias-thinking-text">' + escapeHtml(headerText) + '</span>' +
      '<span class="aias-thinking-toggle">▼</span></div>' +
      '<div class="aias-thinking-body">' + escapeHtml(content || '') + '</div></div>';
  }

  /** 点头部就地折叠。 */
  function toggleThinking(el) {
    var thinking = el ? el.closest('.aias-thinking') : null;
    if (thinking) thinking.classList.toggle('collapsed');
  }

  /** 整块重建前抓走思考块的内部滚动位置（折叠状态不抓）。 */
  function snapshotThinkingView(msgText) {
    var think = msgText ? msgText.querySelector('.aias-thinking') : null;
    if (!think || think.classList.contains('collapsed')) return null;
    var body = think.querySelector('.aias-thinking-body');
    return { scrollTop: body ? body.scrollTop : 0 };
  }

  /** 重建后把滚动位置贴回去。 */
  function applyThinkingView(msgText, snap) {
    if (!snap) return;
    var think = msgText.querySelector('.aias-thinking');
    if (!think) return;
    think.classList.remove('collapsed');
    var body = think.querySelector('.aias-thinking-body');
    if (body) body.scrollTop = snap.scrollTop;
  }

  /**
   * 思考流式**不能整块重建** ——
   * 重建会让正文滚动条复位到顶部，用户正在半路看思考内容就会被弹回去，滚不动也定位不了。
   * 所以只换 textContent，并只在用户原本贴底时跟着贴底。
   */
  function updateThinkingInPlace(thinkEl, content, done, collapseOnDone) {
    var body = thinkEl.querySelector('.aias-thinking-body');
    if (!body) return;
    var wasAtBottom = (body.scrollHeight - body.scrollTop - body.clientHeight) < 20;
    body.textContent = content || '';
    if (done && collapseOnDone) thinkEl.classList.add('collapsed');
    if (wasAtBottom && !thinkEl.classList.contains('collapsed')) {
      body.scrollTop = body.scrollHeight;
    }
    if (done) {
      var iconEl = thinkEl.querySelector('.aias-thinking-icon');
      var textEl = thinkEl.querySelector('.aias-thinking-text');
      if (iconEl && !iconEl.querySelector('.aias-thinking-done-icon')) {
        iconEl.innerHTML = '<span class="aias-thinking-done-icon">✅</span>';
      }
      var doneText = t('webui.aias_thinking_done', '深度思考（已完成）');
      if (textEl && textEl.textContent !== doneText) textEl.textContent = doneText;
    }
  }

  /** 有思考块就原地更新，没有才插到最前面（保住 cursor 与已渲染内容）。 */
  function renderThinking(idx, content, active, autoCollapse) {
    scheduleRender(function () {
      var msgText = byId('aias-msg-text-' + idx);
      if (!msgText || streamingSkip(false, active)) return;
      smartRender(byId('aias-messages'), function () {
        var collapsed = !active && (autoCollapse !== false);
        var done = !active;
        var existing = msgText.querySelector('.aias-thinking');
        if (existing) {
          updateThinkingInPlace(existing, content, done, collapsed);
          return;
        }
        msgText.insertAdjacentHTML('afterbegin', buildThinkingHtml(content, collapsed, done));
      });
    });
  }

  // ── 工具链路可视化 ──

  var COPY_BTN_HTML =
    '<svg class="ic-copy" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
    '<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>' +
    '<svg class="ic-check" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
    '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

  function buildToolChainHtml(reasoning, steps, analyzing) {
    steps = steps || [];
    var html = '<div class="aias-tool-chain">';
    html += '<div class="aias-tc-header">';
    var stageIcon = analyzing ? '📊' : (steps.length ? '🔧' : '🧠');
    var stageText = analyzing ? t('webui.aias_phase_analyze', '分析结果中')
      : (steps.length ? t('webui.aias_phase_running', '查询执行')
                     : t('webui.aias_phase_prepare', '准备查询'));
    html += '<span class="aias-tc-icon">' + stageIcon + '</span>';
    html += '<span>' + escapeHtml(stageText) + '</span>';
    if (steps.length) {
      html += '<span class="aias-tc-count">' + steps.length + ' ' +
        escapeHtml(t('webui.aias_tc_steps', '步')) + '</span>';
    }
    html += '</div>';
    if (reasoning) {
      html += '<div class="aias-tc-reasoning">' + escapeHtml(reasoning) + '</div>';
    }
    if (steps.length) {
      html += '<div class="aias-tc-steps">';
      steps.forEach(function (s, i) {
        var statusClass = s.status || 'pending';
        var badgeText = statusClass === 'running' ? t('webui.aias_step_running', '执行中')
          : statusClass === 'success' ? t('webui.aias_step_success', '✓ 完成')
          : statusClass === 'error' ? t('webui.aias_step_error', '✗ 错误')
          : statusClass === 'skipped' ? t('webui.aias_step_skipped', '已跳过')
          : t('webui.aias_step_pending', '等待中');
        html += '<div class="aias-tc-step ' + statusClass + '">';
        html += '<div class="aias-tc-step-num">' + (i + 1) + '</div>';
        html += '<div class="aias-tc-step-body">';
        html += '<div class="aias-tc-step-head">';
        html += '<span class="aias-tc-step-name">' + escapeHtml(s.tool || '') + '</span>';
        html += '<span class="aias-tc-step-badge ' + statusClass + '">' + escapeHtml(badgeText) + '</span>';
        if (s.duration_ms !== undefined && s.duration_ms !== null) {
          html += '<span class="aias-tc-step-duration">⏱ ' + escapeHtml(formatDuration(s.duration_ms)) + '</span>';
        }
        html += '</div>';
        if (s.progress) {
          var p = s.progress;
          var pIcon = p.status === 'success' ? '✅' : p.status === 'error' ? '❌'
            : p.status === 'skipped' ? '⏭️' : '⏳';
          var pPct = p.total ? Math.max(0, Math.min(100, Math.round((p.step / p.total) * 100))) : 0;
          html += '<div class="aias-tc-progress">';
          if (p.total) {
            html += '<div class="aias-tc-progress-bar"><div class="aias-tc-progress-fill" style="width:' +
              pPct + '%"></div></div>';
          }
          html += '<div class="aias-tc-progress-text">' + pIcon;
          if (p.total) html += ' ' + escapeHtml(tpl('webui.aias_progress_step', '第 {n} / {total} 步',
            { n: p.step, total: p.total }));
          if (p.chapter) html += ' · <span class="aias-tc-progress-chapter">' + escapeHtml(p.chapter) + '</span>';
          if (p.description) {
            // 多行日志逐行显示（巡检任务进度就是这样一段段刷出来的）
            var descLines = String(p.description).split('\n');
            html += '<div class="aias-tc-progress-desc">';
            descLines.forEach(function (one) { html += '<div>' + escapeHtml(one) + '</div>'; });
            html += '</div>';
          }
          html += '</div>';
          html += '</div>';
        }
        if (s.arguments && Object.keys(s.arguments).length > 0) {
          if (s.arguments.sql) {
            // SQL 完整显示不截断：轨迹里这句常是给人复制回库里跑的
            html += '<div class="aias-tc-sql">' + escapeHtml(s.arguments.sql) +
              '<button type="button" class="aias-tc-copy-btn" data-copy="sql" title="' +
              escapeHtml(t('webui.aias_copy_sql', '复制 SQL')) + '" aria-label="' +
              escapeHtml(t('webui.aias_copy_sql', '复制 SQL')) + '">' + COPY_BTN_HTML + '</button></div>';
            var otherArgs = {};
            Object.keys(s.arguments).forEach(function (k) { if (k !== 'sql') otherArgs[k] = s.arguments[k]; });
            if (Object.keys(otherArgs).length > 0) {
              html += '<details class="aias-tc-step-args"><summary>📋 ' +
                escapeHtml(t('webui.aias_step_other_args', '其他参数')) + '</summary>' +
                '<div class="aias-pre-host"><pre><code>' + escapeHtml(prettyJson(otherArgs)) + '</code></pre>' +
                '<button type="button" class="aias-tc-copy-btn" data-copy="args" title="' +
                escapeHtml(t('webui.aias_copy_args', '复制参数')) + '">' + COPY_BTN_HTML + '</button></div></details>';
            }
          } else {
            html += '<details class="aias-tc-step-args"><summary>📋 ' +
              escapeHtml(t('webui.aias_step_args', '参数')) + '</summary>' +
              '<div class="aias-pre-host"><pre><code>' + escapeHtml(prettyJson(s.arguments)) + '</code></pre>' +
              '<button type="button" class="aias-tc-copy-btn" data-copy="args" title="' +
              escapeHtml(t('webui.aias_copy_args', '复制参数')) + '">' + COPY_BTN_HTML + '</button></div></details>';
          }
        }
        if (s.result !== undefined && s.result !== null) {
          var resultStr = '';
          try { resultStr = JSON.stringify(s.result, null, 2); } catch (ignore) { resultStr = String(s.result || ''); }
          if (resultStr.length > 2000) {
            resultStr = resultStr.substring(0, 2000) + t('webui.aias_truncated', '\n... (截断)');
          }
          html += '<details class="aias-tc-step-result"><summary>' +
            (s.status === 'error' ? '✗' : '✓') + ' ' +
            escapeHtml(t('webui.aias_step_result', '执行结果')) + '</summary>' +
            '<div class="aias-pre-host"><pre><code>' + escapeHtml(resultStr) + '</code></pre>' +
            '<button type="button" class="aias-tc-copy-btn" data-copy="result" title="' +
            escapeHtml(t('webui.aias_copy_result', '复制执行结果')) + '">' + COPY_BTN_HTML + '</button></div></details>';
        }
        if (s.result && typeof s.result === 'object' && s.result.type === 'inspection_started' && s.result.task_id) {
          html += '<div class="aias-tc-task-link"><button type="button" class="aias-task-track-btn" data-task-id="' +
            escapeHtml(s.result.task_id) + '">📊 ' +
            escapeHtml(t('webui.aias_track_inspection', '查看巡检进度')) + '</button></div>';
        }
        html += '</div>';   // body
        html += '</div>';   // step
      });
      html += '</div>';     // steps
    }
    if (analyzing) {
      html += '<div class="aias-tc-analyzing"><span class="aias-tc-spin"></span>' +
        '<span>' + escapeHtml(t('webui.aias_tc_analyzing', '🤖 AI 正在分析结果...')) + '</span></div>';
    }
    html += '</div>';       // tool-chain
    return html;
  }

  // ── 确认卡 ──

  function buildConfirmationHtml(question, options) {
    var html = '<div class="aias-confirm-card">';
    html += '<div class="aias-confirm-header"><span class="aias-confirm-icon">❓</span>' +
      '<span class="aias-confirm-title">' +
      escapeHtml(question || t('webui.aias_confirm_title', '请确认')) + '</span></div>';
    html += '<div class="aias-confirm-options">';
    (options || []).forEach(function (opt, i) {
      html += '<button type="button" class="aias-confirm-btn" data-option-index="' + i + '">' +
        '<span class="aias-confirm-btn-icon">🔘</span>' +
        '<span class="aias-confirm-btn-text">' + escapeHtml(opt.label || opt.value || '') + '</span></button>';
    });
    html += '</div>';
    html += '<div class="aias-confirm-hint">' +
      escapeHtml(t('webui.aias_confirm_hint', '点击选项确认后继续执行')) + '</div>';
    html += '</div>';
    return html;
  }

  /** 消息上的确认字段 → 卡片 HTML（读 msg.needConfirmation / confirmOptions）。 */
  function confirmationHtml(message) {
    if (!message || !message.needConfirmation || !message.confirmOptions) return '';
    return buildConfirmationHtml(message.confirmQuestion, message.confirmOptions);
  }

  // ── 结果操作条与追问：正文宿主 / 取文 / 增强 / 按需请求 / 观察器 ──

  /**
   * AI 正文宿主。当前只有助手页一处，
   * 但保留多宿主兜底顺序，便于历史抽屉/协同诊断复用同一套逻辑。
   */
  function resultBox(el) {
    if (!el) return null;
    return el.closest('.aias-msg-text') || el.closest('.aias-drilldown-msg-content')
      || el.closest('.diag-ai-msg-content') || el.closest('.chat-msg') || el.parentElement;
  }

  /**
   * 取「结果正文」用于复制/追问。
   * 先把操作条与思考过程摘掉（否则复制进去的是按钮文字和模型的碎碎念），
   * 再把块级标签映射成换行 —— 不做这一步，标题/列表/表格会被 textContent 黏成一大行。
   */
  function resultText(box) {
    if (!box) return '';
    var html = String(box.innerHTML || '')
      .replace(/<div class="aias-result-actions[\s\S]*?<\/div>/g, '')
      .replace(/<div class="aias-thinking[\s\S]*?<\/div>\s*<\/div>/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|blockquote|pre|tr)>/gi, '\n');
    var text = html.replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    return text.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
  }

  /**
   * 给一条 AI 回答挂「复制该结果 / 基于此结果继续追问」。
   * 判定：① 有结构（标题/列表/表格/代码块）就一定挂；
   * ② 纯文本要 ≥24 字，过滤「好的 / 已收到」这类没信息量的寒暄。
   */
  function enhanceResults(msgText, opts) {
    if (!msgText || !msgText.querySelector) return;
    if (msgText.querySelector('.aias-result-actions')) return;
    var plain = String(msgText.textContent || '').trim();
    var structured = !!msgText.querySelector('h1,h2,h3,h4,ul,ol,li,table,pre,blockquote,details')
      || /aias-md-h|aias-md-list|aias-md-table|aias-code-pre/.test(msgText.innerHTML || '');
    if (!structured && plain.length < 24) return;
    var copyOnly = !!(opts && opts.copyOnly);
    var bar = document.createElement('div');
    bar.className = 'aias-result-actions';
    bar.innerHTML =
      '<button type="button" class="aias-result-btn" data-result-action="copy" title="' +
      escapeHtml(t('webui.aias_copy_result_bar', '复制该结果')) + '" aria-label="' +
      escapeHtml(t('webui.aias_copy_result_bar', '复制该结果')) + '">' + COPY_BTN_HTML + '</button>' +
      (copyOnly ? '' :
        '<button type="button" class="aias-result-btn" data-result-action="followup" title="' +
        escapeHtml(t('webui.aias_followup_this_result', '基于此结果继续追问')) + '" aria-label="' +
        escapeHtml(t('webui.aias_followup_this_result', '基于此结果继续追问')) + '">' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
        '<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg></button>');
    msgText.appendChild(bar);
  }

  /** 复制「该结果」：取结果正文写进剪贴板。 */
  function copyResult(btn) {
    copyText(resultText(resultBox(btn))).then(function (ok) {
      if (!btn || !btn.classList) return;
      btn.classList.toggle('copied', !!ok);
      setTimeout(function () { btn.classList.remove('copied'); }, 1200);
    });
  }

  /**
   * 点「基于此结果追问」才请求，
   * 拿到后缓存在这一条操作条里（dataset.loaded），再点只做展开/收起 —— 不重复打模型。
   */
  function askFollowup(btn) {
    var box = resultBox(btn);
    var bar = btn.closest('.aias-result-actions');
    if (!box || !bar) return;
    var text = resultText(box);
    if (!text) return;
    var wrap = bar.querySelector('.aias-followup-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'aias-followup-wrap';
      bar.appendChild(wrap);
    } else if (wrap.dataset.loaded === '1') {
      wrap.style.display = (wrap.style.display === 'none') ? 'flex' : 'none';
      return;
    }
    wrap.style.display = 'flex';
    wrap.innerHTML = '<span class="aias-followup-loading">⏳ ' +
      escapeHtml(t('webui.aias_followup_loading', '正在生成追问建议…')) + '</span>';
    requestJson('/api/ai/assistant/followup_suggest', {
      method: 'POST',
      body: JSON.stringify({ text: text.slice(0, 4000), datasource_name: state.defaultDatasource })
    }).then(function (body) {
      if (!body || !body.ok || !body.questions || !body.questions.length) {
        wrap.innerHTML = '<span class="aias-followup-loading">⚠️ ' + escapeHtml(
          (body && body.error) || t('webui.aias_followup_failed', '未能生成追问建议')) + '</span>';
        return;
      }
      wrap.dataset.loaded = '1';
      wrap.innerHTML = '';
      body.questions.forEach(function (question) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'aias-followup-chip';
        chip.title = question;
        chip.textContent = question;
        chip.dataset.quickQuestion = question;
        wrap.appendChild(chip);
      });
      // 规则兜底先出，模型版在后台算完（后端不占线程）：稍后取一次换掉
      if (body.pending) setTimeout(function () {
        requestJson('/api/ai/assistant/followup_suggest?token=' + encodeURIComponent(body.pending))
          .then(function (late) {
            if (late && late.ready && late.questions && late.questions.length) {
              wrap.innerHTML = '';
              wrap.dataset.loaded = '1';
              late.questions.forEach(function (question) {
                var chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'aias-followup-chip';
                chip.title = question;
                chip.textContent = question;
                chip.dataset.quickQuestion = question;
                wrap.appendChild(chip);
              });
            }
          }).catch(function () { /* 二次取不到就留着规则版 */ });
      }, 6000);
    }).catch(function (failure) {
      wrap.innerHTML = '<span class="aias-followup-loading">⚠️ ' + escapeHtml(
        t('webui.aias_followup_failed', '生成失败') + '：' + (failure && failure.message || '')) + '</span>';
    });
  }

  /**
   * 操作条的兜底观察器。
   * 曾有 4 条渲染路径漏挂操作条（会话恢复/切会话整体重渲染/两个更新函数/中断分支），
   * 表现为「刷新后历史回答全都没有复制按钮」。这里只要消息区变了就补挂一次，
   * 流式进行中（有光标/typing）不动，等正式渲染点处理。
   */
  function initResultBarObserver() {
    var host = byId('aias-messages');
    if (!host || host.dataset.enhanceObserved === '1') return;
    if (typeof MutationObserver !== 'function') return;
    host.dataset.enhanceObserved = '1';
    var timer = 0;
    var observer = new MutationObserver(function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = 0;
        var list = host.querySelectorAll('.aias-msg.ai .aias-msg-text');
        Array.prototype.forEach.call(list, function (el) {
          if (el.querySelector('.aias-result-actions')) return;
          if (el.querySelector('.aias-cursor, .aias-typing')) return;
          enhanceResults(el);
        });
        Array.prototype.forEach.call(host.querySelectorAll('pre.aias-code-pre, pre.aias-sql-pre'), function (pre) {
          try { slotUpdateHint(pre); } catch (ignore) { /* 提示失败不影响主流程 */ }
        });
        scheduleDialectScan();
      }, 150);
    });
    observer.observe(host, { childList: true, subtree: true });
  }

  /** 由滚动事件回写「是否在翻上文」。 */
  function handleScroll(event) {
    var host = byId('aias-messages');
    if (!host) return;
    if (event && event.isTrusted === false) return;
    var distance = host.scrollHeight - host.scrollTop - host.clientHeight;
    state.userScrolledUp = distance > BOTTOM_TOLERANCE;
    if (!state.userScrolledUp) {
      hideScrollPrompt();
      if (state.generating) flushRender();
    }
  }


  function bindMessageDom() {
    var host = byId('aias-messages');
    if (!host || host.dataset.bound === '1') return;
    host.dataset.bound = '1';
    host.addEventListener('scroll', handleScroll);
    host.addEventListener('click', function (event) {
      // 思考块头部：就地 toggle .collapsed（不重绘，滚动位置自然保住）
      var toggle = event.target.closest('.aias-thinking-header');
      if (toggle) { toggleThinking(toggle); return; }
      var quick = event.target.closest('[data-quick-question]');
      if (quick) { sendText(quick.getAttribute('data-quick-question')); return; }
      var chip = event.target.closest('.aias-followup-chip');
      if (chip) { sendText(chip.getAttribute('data-quick-question') || chip.textContent); return; }
      // 行内编辑区的「取消 / 保存并重发」：只认这一条气泡的下标
      var editButton = event.target.closest('.aias-edit-btn');
      if (editButton) {
        var editOwner = editButton.closest('.aias-msg');
        if (!editOwner) return;
        var editIndex = Number(editOwner.getAttribute('data-idx'));
        if ((editButton.getAttribute('data-edit-action') ||
             (hasClass(editButton, 'save') ? 'save' : 'cancel')) === 'save') saveEdit(editIndex);
        else cancelEdit(editIndex);
        return;
      }
      var copyButton = event.target.closest('.aias-pre-copy-btn, .aias-ibtn[data-copy-raw]');
      if (copyButton) {
        // 拆分面板头的「复制全部语句」带 data-copy-raw：它要的是台账里那份整块 SQL，
        // 不是面板里逐条 pre 的可见文本（「复制整块原文」与「复制当前代码块」是两个入口，
        // 且那个按钮的类是 aias-ibtn 不是 aias-pre-copy-btn —— 选择器漏了它就点了没反应）。
        if (copyButton.getAttribute('data-copy-raw') === '1') copySqlRaw(copyButton);
        else copySqlPre(copyButton);
        return;
      }
      // 执行入口靠 data-sql-id + 事件委托驱动，不依赖内联 onclick 的全局函数名。
      var execButton = event.target.closest('.aias-sql-exec-btn');
      if (execButton) { executeSql(sqlIdOf(execButton)); return; }
      var batchButton = event.target.closest('.aias-sql-batch-btn');
      if (batchButton) { executeSqlBatch(sqlIdOf(batchButton)); return; }
      var fixButton = event.target.closest('.aias-sql-fix-btn');
      if (fixButton) { fixSql(fixButton.getAttribute('data-sql-id') || sqlIdOf(fixButton)); return; }
      // 「全部执行」（拆分面板头的 ▶ 图标按钮）：还是按整块 sqlId 执行，
      // 后端会把整块再拆一次逐条跑，结果由 fillSplitResults 分发回各子块。
      var runAll = event.target.closest('.aias-sql-split-head .aias-ibtn.ok');
      if (runAll) { executeSql(runAll.getAttribute('data-sql-id') || ''); return; }
      var restore = event.target.closest('.aias-pre-restore-btn');
      if (restore) { slotRestoreFromBlock(restore); return; }
      var maximize = event.target.closest('.aias-sql-result-maxbtn');
      if (maximize) {
        // 只最大化这一张表：把原表格节点移进遮罩，多语句结果里其它语句的结果不受影响
        maximizeResultTable(maximize);
        return;
      }
      var batchDetail = event.target.closest('.aias-batch-detail');
      if (batchDetail) {
        batchToggleDetail(batchDetail, batchDetail.getAttribute('data-batch-name') || '');
        return;
      }
      var batchStopButton = event.target.closest('.aias-batch-stop');
      if (batchStopButton) { batchStop(); return; }
      var action = event.target.closest('.aias-msg-actions [data-action]');
      if (action) {
        var wrapper = action.closest('.aias-msg');
        var index = Number(wrapper.getAttribute('data-idx'));
        handleAction(action.getAttribute('data-action'), index);
        return;
      }
      // 工具轨迹卡里的复制按钮：分「复制 SQL 元素」和「复制 pre 盒」两种
      var tcCopy = event.target.closest('.aias-tc-copy-btn');
      if (tcCopy) {
        if (tcCopy.getAttribute('data-copy') === 'sql') copySqlEl(tcCopy);
        else copyPreBox(tcCopy);
        return;
      }
      var trackButton = event.target.closest('.aias-task-track-btn');
      if (trackButton) {
        trackInspection(trackButton.getAttribute('data-task-id'));
        return;
      }
      // 回答落定后的操作条：复制该结果 / 基于此结果继续追问（按需请求，就在这一处）
      var resultButton = event.target.closest('.aias-result-btn');
      if (resultButton) {
        if (resultButton.getAttribute('data-result-action') === 'followup') askFollowup(resultButton);
        else copyResult(resultButton);
        return;
      }
      var confirmButton = event.target.closest('.aias-confirm-btn');
      if (confirmButton) {
        // 消息下标只在 .aias-msg 上（确认卡本身没带）：从卡片上取会拿到 null→0，
        // 于是第 2 轮以后的确认点击都落在「用户消息」上被忽略 —— 点选项没反应就是这个原因。
        var owner = confirmButton.closest('.aias-msg');
        if (!owner) return;
        chooseConfirmation(Number(owner.getAttribute('data-idx')),
                           Number(confirmButton.getAttribute('data-option-index')));
      }
    });
  }

  function handleAction(action, index) {
    var message = state.messages[index];
    if (!message) return;
    if (action === 'copy') {
      // 复制的是「理解 + 分析正文」这段 Markdown（思考过程与工具轨迹不进剪贴板，
      // 那是给人看过程的，贴到工单里只会干扰阅读）
      copyText(prepareTextForCopy(message)).then(function (ok) {
        notify(ok ? t('webui.aias_message_copied', '已复制到剪贴板')
                  : t('webui.aias_copy_failed', '复制失败'), ok ? 'success' : 'error');
      });
      return;
    }
    if (action === 'regenerate') {
      var previous = index > 0 ? state.messages[index - 1] : null;
      if (!previous || previous.role !== 'user' || state.generating) return;
      // 只删「这一条 AI 回答」并补一个新占位，不能连用户消息一起 splice(index-1)：
      // streamRequest 取数组最后一条当目标，那样新回答会直接盖掉上一轮的助手气泡，
      // 首轮重生成时数组被清空，target=undefined，整帧事件在 catch 里静默报错（点着没反应）。
      state.messages.splice(index, 1);
      state.messages.push(newAiMessage());
      state.userScrolledUp = false;
      renderMessages();
      streamRequest(previous.content, state.messages.length - 1, {});
      return;
    }
    if (action === 'edit') {
      // 就地展开这条提问的编辑框，取消就恢复原文；
      // 不是把文本甩进底部输入框（那样一改就丢掉整段上下文，也没法回退）
      startEdit(index);
    }
  }

  /** 复制整条回答的口径：理解 + 正文（思考过程与工具名不进剪贴板）。 */
  function prepareTextForCopy(message) {
    var text = message.content || '';
    if (message.understandingContent) text = message.understandingContent + '\n\n' + text;
    return text;
  }

  // ══════════════════════════════════════════════════════════
  // 思考块 / 工具轨迹 / 确认卡 / 追问
  // ══════════════════════════════════════════════════════════
  /** 点「基于此结果追问」：按需请求，取到就缓存，再点只做展开/收起。 */
  // ══════════════════════════════════════════════════════════
  // SQL 代码块：拆句 / 方言预检 / 执行 / 结果 / AI 修复 / 批量
  // ══════════════════════════════════════════════════════════

  /**
   * 这块**要执行的那句**从台账取。
   * SQL 文本的唯一真相是台账（state.sqlStore），存的是与渲染
   * 同格式的 **HTML 转义文本**，取用时还原。`data-raw-sql` 只是台账命中不了时的兜底
   * （旧节点 / 夹具手工搭的块），不能作为主路径 —— 槽位替换与 AI 修复都只写台账，
   * 拿属性读会读到「渲染那一刻的原句」，于是「界面上已经替换好、点执行跑的还是占位符」。
   */
  /**
   * 切会话 / 清空 / 删除会话时把 SQL 这一层的状态整体作废：
   * 台账（sqlStore/sqlErrors/sqlDs/sqlRepair）、重绘缓存（blockExtras）、
   * 版本徽标与方言预检缓存都属于上一个会话的上下文，留着会把上一个会话的
   * 报错和结果贴到新会话的块上。
   */
  function resetSqlLedgers() {
    state.sqlStore = {};
    state.sqlErrors = {};
    state.sqlDs = {};
    state.sqlRepair = {};
    state.blockExtras = {};
    state.dialectCache = {};
    state.dialectStatusCache = {};
  }

  function blockRawSql(target) {
    var id = typeof target === 'string' ? target : sqlIdOf(target);
    if (id && state.sqlStore[id] !== undefined) return unescapeHtml(state.sqlStore[id]).trim();
    var node = typeof target === 'string' ? blockBySqlId(id) : target;
    return String(node && node.getAttribute ? (node.getAttribute('data-raw-sql') || '') : '').trim();
  }

  /** 台账写入点：渲染 / 拆分 / 修复 / 改写都必须同步这里。 */
  function setStoredSql(sqlId, plainSql) {
    if (!sqlId) return;
    state.sqlStore[sqlId] = escapeHtml(plainSql);
  }

  function blockBySqlId(sqlId) {
    if (!sqlId) return null;
    return document.querySelector('#aias-messages pre[data-sql-id="' + sqlId + '"]');
  }

  /**
   * 异步结果回来时消息可能已经重绘过好几次：一律按 sqlId 找回**当前**这个结果区，
   * 不要握着渲染时那个节点写（旧节点早已摘出 DOM，表现为结果闪一下就没）。
   */
  function resultBoxFor(sqlId) {
    return byId(sqlId + '-result');
  }

  function currentBlockFor(sqlId) {
    return blockBySqlId(sqlId);
  }

  /**
   * 行数上限的优先级是
   *   全局输入（#aias-global-max-rows）→ 拆分块头输入 → 本块执行栏输入 → 默认 20，
   * 且**只要全局输入有值就用全局**（不是「本块有值优先」），再钳到 1..5000。
   * 块内输入目前没有 markup（拆分头 / 执行栏都没塞 .aias-row-limit），
   * 这里的两级查找是预留的防御路径，将来加块内输入就自动生效。
   */
  function rowLimitValue(resultDiv) {
    var value = ROW_LIMIT_DEFAULT;
    try {
      var input = null;
      var global = byId('aias-global-max-rows');
      if (global && global.value) {
        input = global;
      } else if (resultDiv) {
        var splitBox = resultDiv.closest('.aias-sql-split');
        if (splitBox) input = splitBox.querySelector('.aias-sql-split-head .aias-row-limit input');
        else {
          var wrap = resultDiv.closest('.aias-sql-exec-wrap');
          if (wrap) input = wrap.querySelector('.aias-row-limit input');
        }
      }
      if (input) {
        var parsed = parseInt(input.value, 10);
        if (!isNaN(parsed) && parsed >= ROW_LIMIT_MIN) value = parsed;
      }
    } catch (ignore) { /* 取不到就用默认，不能因为钳制逻辑报错而不执行 */ }
    if (value > ROW_LIMIT_MAX) value = ROW_LIMIT_MAX;
    return value;
  }

  /**
   * 点「▶ 执行SQL」的入口，**智能选择数据源**。
   * 三条分支一条都不能少（漏掉「已固化默认源」这条，选好默认源后还是要多弹一次窗）：
   *   1) 会话已固化默认源（输入框上方胶囊维护）→ 直接执行；
   *   2) 诊断详情上下文（报告自带对应数据源）→ 借用，免去弹窗多选；
   *   3) 还没有默认源 → 首次弹一次选择，并把选中的**固化为会话默认**（此后不再弹）。
   */
  function executeSql(sqlId) {
    var sql = state.sqlStore[sqlId] || '';
    var resultDiv = resultBoxFor(sqlId);
    if (!resultDiv) return;
    if (!sql.trim()) {
      resultDiv.innerHTML = '<div class="aias-sql-result-error">'
        + escapeHtml(t('webui.aias_sql_empty', 'SQL 为空')) + '</div>';
      return;
    }
    // 会话默认数据源（胶囊维护）→ 优先生效；无则回退页面当前数据源
    var currentDs = getSqlDatasource();
    if (currentDs) {
      runSql(sqlId, currentDs);
    } else if (window._diagDataSourceName && document.querySelector('.diag-detail-overlay')) {
      // 诊断详情分支：本页还没有诊断详情浮层，
      // 分支先留着，等那一页上线后自动生效，不在这里改判据。
      runSql(sqlId, window._diagDataSourceName);
    } else {
      resultDiv.innerHTML = '<div class="aias-sql-result-loading">'
        + escapeHtml(t('webui.aias_loading_ds', '⏳ 加载数据源列表...')) + '</div>';
      requestJson('/api/pro/datasources').then(function (data) {
        if (data && data.ok && data.datasources && data.datasources.length) {
          state.datasources = data.datasources;
          showDatasourceModal(data.datasources,
            t('webui.aias_pick_for_sql', '请选择执行 SQL 的数据源（同时设为会话默认）：'),
            function (ds) {
              trackDatasource({ datasource_name: ds });   // 固化 + 刷新胶囊
              runSql(sqlId, ds);
            });
        } else {
          resultDiv.innerHTML = '<div class="aias-sql-result-error">' + escapeHtml(
            t('webui.aias_ds_none_add', '⚠️ 暂无可用数据源，请先在「数据源管理」中添加')) + '</div>';
        }
      }).catch(function () {
        resultDiv.innerHTML = '<div class="aias-sql-result-error">' + escapeHtml(
          t('webui.aias_ds_list_failed', '⚠️ 获取数据源列表失败')) + '</div>';
      });
    }
  }

  /**
   * 真正发请求的那一步。
   * 分支顺序是**先判 multi 再判 ok** —— 多语句里某条失败时 data.ok 也是 false，
   * 先走单条错误分支就会把已经成功那几条的结果整段丢掉，只剩一句「执行失败」。
   */
  function runSql(sqlId, dsName) {
    var sql = state.sqlStore[sqlId] || '';
    var resultDiv = resultBoxFor(sqlId);
    if (!resultDiv) return;
    if (!dsName) {
      resultDiv.innerHTML = '<div class="aias-sql-result-error">' + escapeHtml(
        t('webui.aias_no_ds', '⚠️ 未选择数据源')) + '</div>';
      return;
    }
    // 记录到会话上下文（后续 SQL 默认使用该数据源）
    trackDatasource({ datasource_name: dsName });
    var sessId = state.sessionId || '';
    var maxRows = rowLimitValue(resultDiv);
    writeResult(sqlId, '<div class="aias-sql-result-loading">'
      + escapeHtml(t('webui.aias_running_prefix', '⏳ 在数据源 ')) + '<b>' + escapeHtml(dsName)
      + '</b>' + escapeHtml(t('webui.aias_running_suffix', ' 上执行中...')) + '</div>');
    return requestJson('/api/ai/assistant/execute-sql', {
      method: 'POST',
      body: JSON.stringify({ datasource_name: dsName, sql: unescapeHtml(sql),
                             session_id: sessId, max_rows: maxRows })
    }).then(function (data) {
      data = data || {};
      if (data.multi) {
        state.sqlDs[sqlId] = dsName;
        if (data.error) state.sqlErrors[sqlId] = data.error;
        else delete state.sqlErrors[sqlId];
        state.sqlRepair[sqlId] = data.repair || null;
        // 块已被拆成语句子块 → 结果直接分发到各子块（页面上只有一份 SQL）
        if (fillSplitResults(sqlId, data, dsName)) return data;
        // 紧凑视图兜底：给失败子句也登记上下文，保证「AI 修复」按钮可点
        var statements = data.statements || [];
        for (var index = 0; index < statements.length; index += 1) {
          var item = statements[index] || {};
          if (item.ok || item.skipped) continue;
          var sid = sqlId + '-s' + item.index;
          state.sqlErrors[sid] = item.error || t('webui.aias_exec_failed', '执行失败');
          state.sqlDs[sid] = dsName;
          state.sqlRepair[sid] = item.repair || null;
        }
        writeResult(sqlId, dsOverrideTag(dsName) + buildMultiResultHtml(data, sqlId));
        return data;
      }
      if (!data.ok) {
        // 记录报错信息 / 数据源 / 修复载荷，供「AI 修复」按钮使用
        state.sqlErrors[sqlId] = data.error || t('webui.aias_exec_failed', '执行失败');
        state.sqlDs[sqlId] = dsName;
        state.sqlRepair[sqlId] = data.repair || null;
        // 仅当错误来自真实数据库执行（db_error）时才给「AI 修复」按钮
        writeResult(sqlId, dsOverrideTag(dsName)
          + buildSqlErrorHtml(sqlId, state.sqlErrors[sqlId], !!data.db_error, data.repair));
        return data;
      }
      writeResult(sqlId, dsOverrideTag(dsName) + rewriteNoteTag(data.result)
        + buildOneResultHtml(data.result, data.var_name)
        + zeroRowPlaceholderHint(data.result, sqlId));
      return data;
    }).catch(function (failure) {
      writeResult(sqlId, '<div class="aias-sql-result-error">'
        + escapeHtml(t('webui.aias_request_failed', '⚠️ 请求失败: '))
        + escapeHtml((failure && failure.message) || '') + '</div>');
      return { ok: false, error: String((failure && failure.message) || failure) };
    });
  }

  /**
   * 写结果区 + 落缓存：
   * 流式渲染每帧重建气泡，「只写 DOM」的写法会把刚跑出来的
   * 结果抹掉，所以写完 DOM 立刻按 sqlId 存一份，重绘后由 applyStoredExtras 贴回去。
   */
  function writeResult(sqlId, html) {
    var box = resultBoxFor(sqlId);
    if (box) box.innerHTML = html;
    var stored = state.blockExtras[sqlId] || {};
    stored.fp = sqlFingerprint(blockRawSql(sqlId));
    stored.result = html;
    state.blockExtras[sqlId] = stored;
    return !!box;
  }

  function storeBlockExtra(target, field, html) {
    var id = typeof target === 'string' ? target : sqlIdOf(target);
    if (!id) return;
    var stored = state.blockExtras[id] || {};
    stored.fp = sqlFingerprint(blockRawSql(id));
    stored[field] = html;
    state.blockExtras[id] = stored;
  }

  /**
   * 重绘后把缓存里的执行结果贴回当前节点（本仓库特有的一层，见 writeResult）。
   * 只在「内容没变」时贴：内容变了（槽位替换 / AI 修复 / 方言改写）旧结果与旧报错就作废，
   * 否则修完 SQL 界面里还挂着修复前的 0 行结果和错误框。
   */
  function applyStoredExtras(root) {
    Object.keys(state.blockExtras).forEach(function (sqlId) {
      var stored = state.blockExtras[sqlId];
      if (!stored) return;
      if (state.sqlStore[sqlId] !== undefined
          && stored.fp && stored.fp !== sqlFingerprint(blockRawSql(sqlId))) {
        delete state.blockExtras[sqlId];           // 语句已改写 → 旧结果不再属于这块
        return;
      }
      var box = resultBoxFor(sqlId);
      if (!box || box.innerHTML) return;           // 只有还空着才贴，别覆盖正在跑的状态
      if (stored.result) box.innerHTML = stored.result;
    });
    var scope = root || byId('aias-messages');
    if (scope && scope.querySelector) {
      var split = scope.querySelector('.aias-sql-split');
      if (split && split.getAttribute('data-sql-id')) {
        var note = state.blockExtras[split.getAttribute('data-sql-id')];
        var noteEl = split.querySelector('.aias-sql-split-note');
        if (note && noteEl && note.splitNote) noteEl.innerHTML = note.splitNote;
      }
    }
  }

  /** 渲染层之后统一的三个后处理动作：拆句扫描 + 方言预检 + 观察器补挂。 */
  function refreshSqlBlockLayer(root) {
    applyStoredExtras(root);
    scheduleMultiSqlScan();
    scheduleDialectScan();
    initMultiSqlObserver();
  }

  // ── 结果 HTML：单条 / 多条 / 错误 ──────────────────────────

  /**
   * 成功结果的固定结构
   * （结论行 → maxbar（N 列 · M 行 + 复制 + ⛶ 最大化）→ table-scroll > table）。
   * 最大化按钮**必须在这层**：批量详情、多语句里的每条成功结果都靠它拿到全屏入口。
   */
  function buildOneResultHtml(res, varName) {
    res = res || {};
    var columns = res.columns || [];
    var rows = res.rows || [];
    var total = res.total || 0;
    // 这一行只有「✅ 查询成功，共 N 行（显示前 M 行）」：不显示 @rN（varName 参数收下不用），
    // 也不显示耗时（耗时在多条语句的「第 N 条」头上）。结果区里再挂一遍 @r 徽标和 ms
    // 会和行头重复，用户看不出哪个数才是真的。
    var html = '<div class="aias-sql-result-ok">'
      + escapeHtml(tpl('webui.aias_query_ok_rows', '✅ 查询成功，共 {n} 行', { n: total }))
      + (rows.length < total
          ? escapeHtml(tpl('webui.aias_showing_first', '（显示前 {n} 行）', { n: rows.length })) : '')
      // 这里必须按后端事实来判：本接口的 total 就是「已取回行数」，
      // 截断与否要看 truncated 标志（rows<total 判不出截断）。
      // 不写这一句就会把「达到上限的 20 行」说成「共 20 行」，用户以为表里只有 20 条。
      + (res.truncated && rows.length >= total
          ? ' ' + escapeHtml(tpl('webui.aias_row_limit_hit', '已达行数上限（{n} 行），实际可能更多',
              { n: rows.length })) : '')
      + '</div>';
    if (columns.length > 0) {
      html += '<div class="aias-sql-result-table-wrap">'
        + '<div class="aias-sql-result-maxbar">'
        + '<span class="aias-sql-result-maxtip">' + escapeHtml(
            tpl('webui.aias_col_row_meta', '{cols} 列 · {rows} 行',
                { cols: columns.length, rows: rows.length })) + '</span>'
        + '<button type="button" class="aias-sql-result-maxbtn" title="' + escapeHtml(
            t('webui.aias_maximize_tip', '最大化查看结果（Esc 退出）')) + '">⛶ ' + escapeHtml(
            t('webui.aias_maximize', '最大化')) + '</button>'
        + '</div>'
        + '<div class="aias-sql-result-table-scroll"><table class="aias-sql-result-table"><thead><tr>';
      for (var ci = 0; ci < columns.length; ci += 1) {
        html += '<th>' + escapeHtml(String(columns[ci])) + '</th>';
      }
      html += '</tr></thead><tbody>';
      for (var ri = 0; ri < rows.length; ri += 1) {
        html += '<tr>';
        for (var cj = 0; cj < columns.length; cj += 1) {
          var cell = rows[ri][cj];
          html += '<td>' + (cell === null || cell === undefined
            ? '<span class="aias-sql-null">NULL</span>' : escapeHtml(String(cell))) + '</td>';
        }
        html += '</tr>';
      }
      html += '</tbody></table></div></div>';
    } else {
      html += '<div class="aias-sql-result-ok">'
        + escapeHtml(t('webui.aias_no_columns', '（无返回列）')) + '</div>';
    }
    return html;
  }

  /**
   * 多条语句结果的紧凑视图（块**没被拆成子块**时的兜底）。
   * 每条语句都要独立成块：号 / 状态徽标 / 耗时 / 语句原文 / 各自的成功表或错误框，
   * 末尾再补整块级别的错误（预检拒绝时 statements 只有一条，靠这里给出原因）。
   */
  function buildMultiResultHtml(data, sqlId) {
    var statements = data.statements || [];
    var failedIndex = data.failed_index;
    var html = '<div class="aias-sql-multi-summary' + (failedIndex ? ' has-err' : '') + '">'
      + (failedIndex
          ? escapeHtml(t('webui.aias_multi_warn_prefix', '⚠️ 共 ')) + data.count
            + escapeHtml(t('webui.aias_multi_statements', ' 条语句：成功 ')) + data.succeeded
            // 这里加粗的是「第 N 条失败」。<b> 必须在 escapeHtml 外面拼：
            // 把标签写进 i18n 文案再整体转义，界面上就会显示字面的 <b>…</b>（实测踩过）。
            + escapeHtml(t('webui.aias_multi_failed_at', ' 条，')) + '<b>'
            + escapeHtml(tpl('webui.aias_multi_failed_bold', '第 {i} 条失败', { i: failedIndex }))
            + '</b>'
            + escapeHtml(t('webui.aias_multi_failed_tail', '，其后的语句未执行'))
          : escapeHtml(tpl('webui.aias_multi_all_ok', '✅ 共 {n} 条语句，全部执行成功',
              { n: data.count })))
      + '</div>';
    for (var index = 0; index < statements.length; index += 1) {
      var item = statements[index] || {};
      html += '<div class="aias-sql-stmt-block ' + (item.ok ? 'ok' : 'err') + '">';
      html += '<div class="aias-sql-stmt-head">'
        + '<span class="aias-sql-stmt-no">' + escapeHtml(
            tpl('webui.aias_stmt_no', '第 {i} 条', { i: item.index })) + '</span>'
        + '<span class="aias-sql-stmt-badge">' + escapeHtml(item.skipped
            ? t('webui.aias_stmt_skipped', '未执行')
            : (item.ok ? t('webui.aias_stmt_ok', '✓ 成功')
                       : t('webui.aias_stmt_err', '✗ 失败'))) + '</span>'
        + (item.duration_ms ? '<span class="aias-sql-stmt-ms">' + item.duration_ms + 'ms</span>' : '')
        + '</div>';
      html += '<pre class="aias-sql-stmt-sql">' + escapeHtml(item.sql || '') + '</pre>';
      if (item.ok) {
        html += buildOneResultHtml(item.result, item.var_name);
      } else {
        html += buildSqlErrorHtml(sqlId + '-s' + item.index,
          item.error || t('webui.aias_exec_failed', '执行失败'), true, item.repair);
      }
      html += '</div>';
    }
    if (data.error) {
      html += buildSqlErrorHtml(sqlId, data.error, !!data.db_error, data.repair);
    }
    return html;
  }

  /**
   * 错误框 + 「字段不存在」的确定性修正信息 + AI 修复按钮。
   * repair 载荷是后端按真实数据字典算出来的（不是模型猜的）：把真实列清单与建议列摊开，
   * 用户一眼能看出是字段名记错了；点「✨ AI 修复」时这份载荷还会一起带给模型。
   * 只有 showFixBtn（=错误真来自数据库执行 db_error）才给修复按钮：
   * 预检拒绝 / 参数不全这类「语句还没碰过库」的报错，模型改不出任何东西。
   */
  function buildSqlErrorHtml(sqlId, errText, showFixBtn, repair) {
    var html = '<div class="aias-sql-result-error">'
      + '<div>⚠️ ' + escapeHtml(errText) + '</div>';
    try {
      if (repair && typeof repair === 'object') {
        var bad = repair.bad_column || '';
        var tables = Array.isArray(repair.tables) ? repair.tables : [];
        var suggestion = repair.suggestion || null;
        var parts = [];
        tables.forEach(function (table) {
          var cols = Array.isArray(table.columns) ? table.columns : [];
          if (cols.length) {
            parts.push('<div class="aias-repair-obj"><span>' + escapeHtml(t('webui.aias_repair_col', '列 '))
              + '</span><code>' + escapeHtml(bad) + '</code><span>'
              + escapeHtml(t('webui.aias_repair_in', ' 在 ')) + '</span><b>' + escapeHtml(table.table)
              + '</b><span>' + escapeHtml(t('webui.aias_repair_missing', ' 中不存在')) + '</span>'
              + '<div class="aias-repair-cols">' + escapeHtml(t('webui.aias_real_columns_label', '真实列：'))
              + escapeHtml(cols.join(', ')) + '</div></div>');
          }
        });
        if (suggestion && suggestion.suggested) {
          parts.push('<div class="aias-repair-sug">' + escapeHtml(t('webui.aias_repair_suggested', '✅ 建议列：'))
            + '<code>' + escapeHtml(suggestion.suggested) + '</code>'
            + escapeHtml(t('webui.aias_repair_table_prefix', '（表 ')) + escapeHtml(suggestion.table)
            + escapeHtml(t('webui.aias_br_close', '）')) + '</div>');
        } else if (!parts.length) {
          parts.push('<div class="aias-repair-cols">' + escapeHtml(t('webui.aias_repair_col', '列 '))
            + '<code>' + escapeHtml(bad) + '</code>'
            + escapeHtml(t('webui.aias_repair_unknown', ' 在目标对象中不存在，可能是字段名记错了。'))
            + '</div>');
        }
        html += '<div class="aias-repair-box">' + parts.join('')
          + '<div class="aias-repair-tip">' + escapeHtml(
              t('webui.aias_repair_tip', '点下方「✨ AI 修复」将按真实列清单重写此 SQL。')) + '</div></div>';
      }
    } catch (ignore) { /* 修复载荷形状不对就只给报错原文，不能把错误框整块弄丢 */ }
    if (showFixBtn) {
      html += '<button type="button" class="aias-sql-fix-btn" data-sql-id="' + escapeHtml(sqlId) + '">'
        + escapeHtml(t('webui.aias_fix_btn', '✨ AI 修复')) + '</button>';
    }
    html += '</div>';
    return html;
  }

  /** 后端按目标库版本自动改写过才标一句。 */
  function rewriteNoteTag(result) {
    try {
      if (!result || !result.rewritten) return '';
      var note = result.rewrite_note || t('webui.aias_rewrite_default_note', '已按数据源版本自动改写 SQL 后执行');
      return '<div class="aias-sql-rewrite-tag">🔧 ' + escapeHtml(note) + '</div>';
    } catch (ignore) { return ''; }
  }

  /**
   * 0 行不能只说「条件可能过严」。
   * 库里明明有数据、而语句里还留着 `'YOUR_TABLESPACE'` 之类命名式占位符时，
   * 用户会以为「这张视图是空的」；这里把占位符原样点出来，并告诉他怎么替换。
   * 两种情形分开说：认得出具体占位符就逐个列出来；只认出「含占位符」形态就说通用一句。
   */
  function zeroRowPlaceholderHint(res, sqlId) {
    try {
      if (!res || res.total !== 0) return '';
      var sql = unescapeHtml(state.sqlStore[sqlId] || '');
      if (!sql) return '';
      var re = new RegExp(NAMED_PH_RE.source, 'gi');
      var hits = [];
      var matched;
      while ((matched = re.exec(sql)) !== null) {
        if (hits.indexOf(matched[0]) < 0) hits.push(matched[0]);
      }
      if (!hits.length) {
        if (!SLOT_HINT_RE.test(sql)) return '';
        return '<div class="aias-zero-row-hint">' + escapeHtml(
          t('webui.aias_zero_slot_generic', '没查到数据，而这条语句里还有未替换的占位符 —— 在 SQL 上点')
          + '<b>' + escapeHtml(t('webui.aias_zero_slot_rightclick', '右键')) + '</b>'
          + escapeHtml(t('webui.aias_zero_slot_tail', '即可替换成真实取值')) ) + '</div>';
      }
      return '<div class="aias-zero-row-hint">'
        + escapeHtml(t('webui.aias_zero_slot_named', '没查到数据，很可能是语句里还留着占位符：'))
        + hits.map(function (hit) { return '<code>' + escapeHtml(hit) + '</code>'; }).join(' ')
        + escapeHtml(t('webui.aias_zero_slot_named_tail', ' —— 在 SQL 上点')) + '<b>'
        + escapeHtml(t('webui.aias_zero_slot_rightclick', '右键')) + '</b>'
        + escapeHtml(t('webui.aias_zero_slot_named_end', '换成真实取值再执行')) + '</div>';
    } catch (ignore) { return ''; }
  }

  /**
   * 块已被拆成语句子块时，把多语句响应**分发**到各子块结果区。
   * 三个要点：
   *   · 整块级的「异源」提示只在块顶标一次（afterbegin），不逐条刷屏；
   *   · 每条失败各自登记 sqlId=`sqlId-sN` 的上下文，这样「AI 修复」只修这一条，
   *     不会牵连其他条（只登记整块的话，「AI 修复」会把成功那条一起改掉）；
   *   · 面板头的 note 用成功/失败两种颜色一句说清，用户不必逐条数。
   * 返回 false = 这块没被拆（调用方回落到紧凑视图）。
   */
  function fillSplitResults(sqlId, data, dsName) {
    var box = document.querySelector('.aias-sql-split[data-sql-id="' + sqlId + '"]');
    if (!box) return false;
    var tip = dsOverrideTag(dsName);
    if (tip) box.insertAdjacentHTML('afterbegin', tip);
    var statements = data.statements || [];
    for (var index = 0; index < statements.length; index += 1) {
      var item = statements[index] || {};
      var sid = sqlId + '-s' + item.index;
      var target = byId(sid + '-result');
      if (!target) continue;
      var html;
      if (item.skipped) {
        html = '<div class="aias-sql-result-error">' + escapeHtml(
          t('webui.aias_stmt_not_run', '未执行（前一条失败或超时）')) + '</div>';
      } else if (item.ok) {
        html = buildOneResultHtml(item.result, item.var_name)
          + zeroRowPlaceholderHint(item.result, sid);
      } else {
        state.sqlErrors[sid] = item.error || t('webui.aias_exec_failed', '执行失败');
        state.sqlDs[sid] = dsName || '';
        state.sqlRepair[sid] = item.repair || null;
        html = buildSqlErrorHtml(sid, item.error || t('webui.aias_exec_failed', '执行失败'),
                                 true, item.repair);
      }
      target.innerHTML = html;
      var stored = state.blockExtras[sid] || {};
      stored.fp = sqlFingerprint(blockRawSql(sid));
      stored.result = html;
      state.blockExtras[sid] = stored;
    }
    var note = box.querySelector('.aias-sql-split-note');
    var noteHtml = '';
    if (note) {
      if (data.error) {
        noteHtml = '<span style="color:#d97706">⚠️ ' + escapeHtml(t('webui.aias_split_ok_prefix', '成功 '))
          + (data.succeeded || 0) + '/' + (data.count || statements.length) + ' '
          + escapeHtml(t('webui.aias_split_ok_mid', '条 · ')) + escapeHtml(data.error) + '</span>';
      } else {
        noteHtml = '<span style="color:#4caf50">✅ ' + (data.count || statements.length) + ' '
          + escapeHtml(t('webui.aias_split_all_ok', '条全部执行成功')) + '</span>';
      }
      note.innerHTML = noteHtml;
    }
    var blockStored = state.blockExtras[sqlId] || {};
    blockStored.splitNote = noteHtml;
    state.blockExtras[sqlId] = blockStored;
    return true;
  }

  // ── 多语句拆分：面板构建 + 扫描 ────────

  /**
   * 把整块 pre 换成「拆分面板」。
   * 结构照搬：面板头（共 N 条 + note + 版本徽标 + 全部执行/复制全部）+ 每条一个 item，
   * item 里是**独立的一条语句 pre**（挂 data-sql-id="sqlId-sN"、data-multi-checked="1"
   * 防止再被拆一遍）+ 自己的执行栏与结果区；非只读子块整项 `is-static`，
   * 只展示 + 一句 🔒 提示，**绝不给执行入口**（写语句不可点执行是硬要求）。
   * 末尾保留整块的 `sqlId-result` 锚点：头部「全部执行」发的还是整块 SQL，后端会再拆一次。
   * 收尾四步顺序不能乱：关菜单 → 作废旧台账 → 摘掉原 pre 与旧 exec-wrap（避免 id 重名）→ 插面板。
   */
  function splitSqlBlock(pre, stmts, executable) {
    var wrap = pre.nextElementSibling;
    if (!wrap || !wrap.classList || !wrap.classList.contains('aias-sql-exec-wrap')) return;
    var sqlId = sqlIdOf(pre);
    if (!sqlId) return;
    var wholeSql = blockRawSql(pre);
    executable = executable || [];

    var allExec = stmts.length > 0;
    for (var e = 0; e < stmts.length; e += 1) {
      if (!executable[e]) { allExec = false; break; }
    }

    var box = document.createElement('div');
    box.className = 'aias-sql-split';
    box.setAttribute('data-sql-id', sqlId);
    var html = '<div class="aias-sql-split-head">'
      + '<span class="aias-sql-split-title">' + escapeHtml(
          tpl('webui.aias_split_head', '共 {n} 条语句', { n: stmts.length })) + '</span>'
      + '<span class="aias-sql-split-note">' + escapeHtml(allExec
          ? t('webui.aias_split_note_exec', '纯查询，每条可单独执行 —— 失败那条改完只需重跑它自己')
          : t('webui.aias_split_note_mixed', '查询语句可单独执行；非查询语句仅展示，不提供执行')) + '</span>'
      + ' <span class="aias-dialect-badge is-loading" data-dialect-sql-id="' + sqlId + '" title="'
      + escapeHtml(t('webui.aias_dialect_probing_tip', '正在确认目标库版本…')) + '">'
      + escapeHtml(t('webui.aias_dialect_probing', '⏳ 版本确认中…')) + '</span>';
    if (allExec) {
      html += '<button type="button" class="aias-ibtn ok" data-sql-id="' + sqlId + '" aria-label="'
        + escapeHtml(t('webui.aias_run_all_aria', '全部执行')) + '" title="'
        + escapeHtml(t('webui.aias_run_all_tip', '全部执行（按语句顺序，遇错即停）')) + '">'
        + IC_PLAY_ALL + '</button>';
    }
    html += '<button type="button" class="aias-ibtn" data-sql-id="' + sqlId + '" aria-label="'
      + escapeHtml(t('webui.aias_copy_all_aria', '复制全部语句')) + '" title="'
      + escapeHtml(t('webui.aias_copy_all_tip', '复制全部语句')) + '" data-copy-raw="1">'
      + COPY_BTN_HTML + '</button>'
      + '</div>';
    for (var index = 0; index < stmts.length; index += 1) {
      var sid = sqlId + '-s' + (index + 1);
      // ★ 指纹覆盖：子块这条语句若被 AI 修复过，用覆盖后的版本渲染/执行
      var statementText = stmts[index];
      try {
        var override = sqlOverrideFind(statementText);
        if (override && override.fixedSql) statementText = override.fixedSql;
      } catch (ignore) { /* 覆盖层读不到就按后端拆出来的原文 */ }
      setStoredSql(sid, statementText);          // 子块自己就是一条语句
      var canExec = !!executable[index];
      var preClass = canExec ? 'aias-code-pre aias-sql-pre' : 'aias-code-pre';
      html += '<div class="aias-sql-split-item' + (canExec ? '' : ' is-static') + '">'
        + '<div class="aias-sql-split-no">' + (index + 1) + '</div>'
        + '<div class="aias-sql-split-body">'
        + '<pre class="' + preClass + '" data-sql-id="' + sid + '" data-multi-checked="1"><code>'
        + escapeHtml(statementText) + '</code>'
        + '<button type="button" class="aias-pre-restore-btn is-idle" data-sql-id="' + sid + '" title="'
        + escapeHtml(t('webui.slot_restore_idle', '撤销占位符替换（当前没有替换记录）')) + '" aria-label="'
        + escapeHtml(t('webui.aias_restore_action', '撤销占位符替换')) + '">' + RESTORE_BTN_HTML + '</button>'
        + '<button type="button" class="aias-pre-copy-btn" title="' + escapeHtml(
            canExec ? t('webui.aias_copy_one_sql', '复制该条 SQL') : t('webui.aias_copy_one', '复制该条'))
        + '" aria-label="' + escapeHtml(t('webui.aias_copy_one_aria', '复制该条')) + '">'
        + COPY_BTN_HTML + '</button>'
        + '</pre>';
      if (canExec) {
        html += '<div class="aias-sql-exec-wrap">'
          + '<button type="button" class="aias-sql-batch-btn" data-sql-id="' + sid + '" title="'
          + escapeHtml(t('webui.aias_batch_title', '把这条 SQL 批量执行到多个同类库')) + '">'
          + escapeHtml(t('webui.aias_batch_short', '批量')) + '</button>'
          + '<button type="button" class="aias-sql-exec-btn" data-sql-id="' + sid + '">'
          + '<span class="aias-exec-label">' + escapeHtml(
              tpl('webui.aias_exec_nth', '▶ 执行第 {i} 条', { i: index + 1 })) + '</span></button>'
          + '<div class="aias-sql-result" id="' + sid + '-result"></div>'
          + '</div>';
      } else {
        html += '<div class="aias-sql-static-tip">' + escapeHtml(
          t('webui.aias_split_static', '🔒 非查询语句，仅展示')) + '</div>';
      }
      html += '</div></div>';
    }
    // 「全部执行」用的结果区：整块 SQL 仍在台账里，后端会再拆一次并逐条执行
    html += '<div class="aias-sql-result" id="' + sqlId + '-result"></div>';
    box.innerHTML = html;

    var parent = pre.parentNode;
    var anchor = wrap.nextSibling;
    setStoredSql(sqlId, wholeSql);
    slotClose();                                  // 若占位符菜单正开在这个块上，先关掉
    slotDropLedger(pre);                          // 块被换成子块 → 旧台账（连值一起）作废
    parent.removeChild(pre);
    wrap.parentNode.removeChild(wrap);            // 先摘掉旧的 -result，避免 id 重名
    parent.insertBefore(box, anchor);
    applyStoredExtras(box);                       // 重绘后拆回来的面板：把已有结果贴回各子块
    loadDialectBadge(box, sqlId);                 // 阶段2：异步填充「版本确认」徽标
  }

  /**
   * 扫出「可能是多语句」的块并请求拆分。
   * 守卫逐条照搬，每一条都对应一个真实踩过的坑：
   *   · 已拆出的子块（data-multi-checked=1 / 在 .aias-sql-split-body 里）不再递归；
   *   · 没有分号 → 必然单条，省一次请求；
   *   · 没有执行区的块也要救回（否则会整块误摘「首句非查询的多语句块」的执行按钮），
   *     但**先只插一个纯占位锚点**，不放任何按钮 —— 写语句绝不出现执行入口；
   *   · 接口异常必须把占位锚点删干净（catch 里那一段），否则写语句旁边挂着个空执行栏。
   */
  function scanMultiSql() {
    multiScanTimer = 0;
    var pres = document.querySelectorAll('pre.aias-sql-pre');
    var need = [];
    var next = [];
    Array.prototype.forEach.call(pres, function (pre) {
      if (pre.getAttribute('data-multi-checked') === '1') return;
      if (pre.closest('.aias-sql-split-body')) return;        // 已拆出的子块不再递归
      var text = preText(pre.querySelector('code') || pre);
      if (!text || text.indexOf(';') < 0) return;             // 没分号 → 必然单条
      var sibling = pre.nextElementSibling;
      var hasWrap = !!(sibling && sibling.classList
        && sibling.classList.contains('aias-sql-exec-wrap'));
      if (!hasWrap && !pre.getAttribute('data-sql-id')) return;   // 无 id 无法重建执行区
      if (hasWrap && !sqlIdOf(pre)) return;                     // 没有 sqlId 就没有执行入口
      pre.setAttribute('data-multi-checked', '1');
      need.push(text);
      next.push(pre);
    });
    if (!need.length) return;
    requestJson('/api/ai/assistant/split-sql', { method: 'POST',
      body: JSON.stringify({ sqls: need }) }).then(function (d) {
      if (!d || !d.ok || !d.results) {
        dropTempExecWraps();                      // 响应不成形状也要把占位锚点清干净
        return;
      }
      for (var k = 0; k < next.length && k < d.results.length; k += 1) {
        var entry = d.results[k] || {};
        var pre = next[k];
        if (!pre.isConnected) continue;
        var sibling = pre.nextElementSibling;
        var hasWrap = !!(sibling && sibling.classList
          && sibling.classList.contains('aias-sql-exec-wrap'));
        if (!hasWrap) {
          // 无按钮块（首句非只读的混合块 / 写块）：插一个**纯占位**执行区锚点供拆分重建，
          // 不放任何执行按钮；若不该拆则随后移除，保持原样。
          var sid = pre.getAttribute('data-sql-id');
          var shell = document.createElement('div');
          shell.className = 'aias-sql-exec-wrap';
          shell.setAttribute('data-tmp', '1');
          pre.parentNode.insertBefore(shell, pre.nextSibling);
          setStoredSql(sid, preText(pre.querySelector('code') || pre));
        }
        var flags = executableFlags(entry);
        var anyExec = flags.some(function (flag) { return !!flag; });
        if ((entry.count || 0) > 1 && anyExec) {
          // 至少要有一条可执行才拆（纯非查询多语句没有拆的意义）
          try { splitSqlBlock(pre, entry.statements || [], flags); } catch (ignore) { /* 单个块拆失败不影响其他块 */ }
          continue;
        }
        // 不该拆：清掉刚插的占位执行区（恢复原状）
        var tail = pre.nextElementSibling;
        if (tail && tail.classList && tail.classList.contains('aias-sql-exec-wrap')
            && tail.getAttribute('data-tmp') === '1') {
          delete state.sqlStore[pre.getAttribute('data-sql-id')];
          tail.parentNode.removeChild(tail);
        }
      }
    }).catch(function () {
      // 接口异常：清理可能残留的占位执行区，避免写语句意外出现可点击的执行入口
      dropTempExecWraps();
    });
  }

  /**
   * 本仓库 /split-sql 回的 `executable` 是**可执行条目的下标数组**，
   * 后端要的是与 statements 同长的布尔数组（`executable[i]` 直接判第 i 条）。
   * 不做这层转换的话 `executable.some(...)` 里那些下标会被当成 true/false 的错位值，
   * 结果是「只有第一条能执行」这类难查的偏移 bug。
   */
  function executableFlags(entry) {
    var count = (entry.statements || []).length;
    var flags = [];
    for (var index = 0; index < count; index += 1) flags.push(false);
    (entry.executable || []).forEach(function (item) {
      if (typeof item === 'number') flags[item] = true;
      else if (item === true) flags[indexOfTrue(flags)] = true;
    });
    // 兼容另一种形状（后端哪天改成布尔数组也不用改前端）
    if ((entry.executable || []).length === count
        && (entry.executable || []).every(function (item) { return typeof item === 'boolean'; })) {
      flags = (entry.executable || []).slice();
    }
    return flags;
  }

  function indexOfTrue(flags) {
    for (var index = 0; index < flags.length; index += 1) { if (!flags[index]) return index; }
    return -1;
  }

  // ── 结果最大化：进入全屏遮罩 / 退出还原 ──

  /**
   * 做法是**把原表格节点移进遮罩**（不是克隆），退出时再移回去。
   * 为什么不用克隆：克隆会把「这份结果的唯一节点」变成两份，遮罩里滚动/选中的是副本，
   * 退出后原件还是老样子，用户以为界面没跟着动；更要紧的是复制/导出的目标会错位。
   * 配套：三个句柄（maxHome / maxOverlay / maxOnKey）、锁 body 滚动、
   * 点遮罩空白处关闭（只认 e.target === 遮罩本身）、Esc 关闭。
   */
  function maximizeResultTable(btn) {
    try {
      var wrap = (btn && btn.closest) ? btn.closest('.aias-sql-result-table-wrap') : null;
      if (!wrap) return;
      var table = wrap.querySelector('table.aias-sql-result-table');
      if (!table) return;
      closeResultMaximize();                       // 已打开则先关（重复点击）
      var overlay = document.createElement('div');
      overlay.className = 'aias-result-max-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      var head = document.createElement('div');
      head.className = 'aias-result-max-head';
      head.innerHTML = '<span class="aias-result-max-title">' + escapeHtml(
          t('webui.aias_maximize_title', '📊 查询结果全屏查看')) + '</span>'
        + '<button type="button" class="aias-result-max-close" title="' + escapeHtml(
          t('webui.aias_maximize_close_tip', '关闭（Esc）')) + '">'
        + escapeHtml(t('webui.aias_maximize_close', '✕ 关闭 (Esc)')) + '</button>';
      var body = document.createElement('div');
      body.className = 'aias-result-max-body';
      maxHome = wrap;                              // 记住原件的家，退出时搬回去
      body.appendChild(table);                     // 移动表格进全屏层
      overlay.appendChild(head);
      overlay.appendChild(body);
      document.body.appendChild(overlay);
      head.querySelector('.aias-result-max-close').addEventListener('click', closeResultMaximize);
      // 遮罩点击（非内容区）关闭
      overlay.addEventListener('mousedown', function (event) {
        if (event.target === overlay) closeResultMaximize();
      });
      maxOverlay = overlay;
      maxOnKey = function (event) {
        if (event && (event.key === 'Escape' || event.key === 'Esc')) {
          if (event.preventDefault) event.preventDefault();
          closeResultMaximize();
        }
      };
      document.addEventListener('keydown', maxOnKey);
      document.body.style.overflow = 'hidden';     // 锁住背景滚动
    } catch (ignore) { /* 最大化失败只是少个全屏查看，绝不能影响结果本身 */ }
  }

  /**
   * 退出全屏：摘 keydown → 解锁滚动 → 把表格移回原 wrap。
   * 回不去的情况必须兜住：全屏期间消息被重建（流式又落了一帧 / 切会话），
   * 原 wrap 已经不在文档里 —— 这时就地留一个静态表格，**不能把表格跟着遮罩一起删掉**
   * （否则等于用户点个最大化就把结果弄丢了）。
   */
  function closeResultMaximize() {
    try {
      if (maxOnKey) {
        document.removeEventListener('keydown', maxOnKey);
        maxOnKey = null;
      }
      document.body.style.overflow = '';
      if (!maxOverlay) return;
      var overlay = maxOverlay;
      maxOverlay = null;
      var body = overlay.querySelector('.aias-result-max-body');
      var table = body ? body.querySelector('table.aias-sql-result-table') : null;
      if (table) {
        var home = maxHome;
        maxHome = null;
        var scroller = (home && home.isConnected)
          ? home.querySelector('.aias-sql-result-table-scroll') : null;
        if (scroller) {
          scroller.appendChild(table);
        } else {
          var holder = document.createElement('div');
          holder.className = 'aias-sql-result-table-scroll';
          holder.appendChild(table);
          // 兜底容器必须挂在 document.body 上、插在遮罩**之前**：
          // 若挂在遮罩里，紧接着遮罩被 remove，表格会跟着一起没了（结果直接丢失）。
          // 挂在这里（静态表格就地保留）摘遮罩时表格才留在页面里。
          document.body.insertBefore(holder, overlay);
        }
      }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    } catch (ignore) { /* 收尾异常不能让遮罩卡在半开状态，下面已尽力摘节点 */ }
  }

  // ── AI 修复 + 指纹覆盖持久化 ──

  /**
   * 拿「执行报错 + 真实列载荷 + 数据源」去问模型，只改语法不改语义。
   * 成功后三件事一件不能少（少了第 2 件，刷新后修复就消失了）：
   *   1) 更新台账 +  DOM（后续「执行SQL」用修复后的语句）；
   *   2) 回写消息正文的围栏代码块（persistFixedSql：先写指纹覆盖层，再尝试逐字回写）；
   *   3) 摘掉 data-dialect-checked —— 语句变了，方言预检要允许重做一次。
   * 失败（模型没改出来 / 请求异常）时**保留原始数据库报错**，重试仍然基于它修复，
   * 另起一行说清失败原因 —— 把报错换成「修复失败」等于把线索抹了。
   */
  function fixSql(sqlId) {
    var oldSql = unescapeHtml(state.sqlStore[sqlId] || '');
    var error = state.sqlErrors[sqlId] || '';
    var dsName = state.sqlDs[sqlId] || '';
    var repair = state.sqlRepair[sqlId] || null;
    var resultDiv = resultBoxFor(sqlId);
    if (!resultDiv || !oldSql || !error) return;
    writeResult(sqlId, '<div class="aias-sql-result-loading">' + escapeHtml(
      t('webui.aias_fixing_wait', '⏳ AI 正在分析报错并修复 SQL，请稍候...')) + '</div>');
    requestJson('/api/ai/assistant/fix-sql', { method: 'POST',
      body: JSON.stringify({ sql: oldSql, error: error, datasource_name: dsName, repair: repair }) })
      .then(function (data) {
        data = data || {};
        if (!data.ok || !data.fixed_sql) {
          var fixError = data.error || t('webui.aias_fix_failed', 'AI 修复失败');
          writeResult(sqlId, buildSqlErrorHtml(sqlId,
            state.sqlErrors[sqlId] || t('webui.aias_exec_failed', '执行失败'), true)
            + '<div class="aias-sql-fix-note">' + escapeHtml(
                t('webui.aias_fix_failed_prefix', '⚠️ AI 修复失败：')) + escapeHtml(fixError) + '</div>');
          return;
        }
        var fixedSql = data.fixed_sql;
        setStoredSql(sqlId, fixedSql);              // 1) 台账：后续执行用修复后的语句
        delete state.sqlErrors[sqlId];
        delete state.sqlRepair[sqlId];
        var box = byId(sqlId + '-result');
        var wrap = box ? box.closest('.aias-sql-exec-wrap') : null;
        if (wrap) {
          var pre = wrap.previousElementSibling;
          while (pre && pre.tagName !== 'PRE') pre = pre.previousElementSibling;
          if (pre) {
            // 2) 写回 DOM + 台账并重建占位符台账（统一走 setBlockSql，
            //    与「方言一键改写」共用同一套收尾动作）
            setBlockSql(pre, fixedSql, false);
            pre.removeAttribute('data-dialect-checked');   // 修复后允许重新做方言预检
          }
          // 3) 回写会话消息（重载页面 / 切换会话后仍显示修复后的 SQL）
          persistFixedSql(wrap, oldSql, fixedSql);
        }
        writeResult(sqlId, (data.note
            ? '<div class="aias-sql-fix-note">💡 ' + escapeHtml(data.note) + '</div>' : '')
          + '<div class="aias-sql-result-ok">' + escapeHtml(
              t('webui.aias_fix_done', '✅ AI 修复完成，SQL 已更新，可重新点击「执行SQL」验证')) + '</div>');
      })
      .catch(function (failure) {
        writeResult(sqlId, buildSqlErrorHtml(sqlId,
          state.sqlErrors[sqlId] || t('webui.aias_exec_failed', '执行失败'), true)
          + '<div class="aias-sql-fix-note">' + escapeHtml(
              t('webui.aias_fix_request_failed', '⚠️ AI 修复请求失败：'))
          + escapeHtml((failure && failure.message) || t('webui.aias_network_error', '网络异常')) + '</div>');
      });
  }

  /**
   * 把「原句 → 修复后」这条映射落到会话里。
   * 顺序很重要：
   *   1) **先写指纹覆盖层**（这是可靠持久化的根基，不依赖文本逐字匹配）；
   *   2) 再做 content 的精确回写：只替换「这一块」对应的第 n 次出现 —— n 由当前执行按钮
   *      在消息内的 DOM 顺序算出，同一条消息里两处出现同样的 SQL 时才不会串块；
   *   3) 理解文本是 content 的前缀，被替换片段落在前缀里时必须同步改，
   *      否则下一次重绘会用旧前缀把新 SQL 又盖回去。
   * 逐字回写没命中（转义差异 / 后端落库时格式变了）也不算失败：覆盖层兜得住。
   */
  function persistFixedSql(wrap, oldSql, fixedSql) {
    try {
      var msgEl = wrap.closest('.aias-msg');
      if (!msgEl || !oldSql || !fixedSql) return;
      var idx = parseInt(msgEl.getAttribute('data-idx'), 10);
      var session = currentSession();
      var messages = sessionMessages();
      if (isNaN(idx) || !messages[idx]) return;
      // 定位当前执行按钮在消息内的位置序号（DOM 顺序，0 基）
      var button = wrap.querySelector('.aias-sql-exec-btn');
      var occurrence = 0;
      if (button) {
        var all = msgEl.querySelectorAll('.aias-sql-exec-btn');
        for (var i = 0; i < all.length; i += 1) {
          if (all[i] === button) break;
          occurrence += 1;
        }
      }
      var message = messages[idx];
      if (!message) return;
      sqlOverridePut(message, oldSql, fixedSql);       // ★ 第一优先：指纹覆盖层
      var content = message.content || '';
      if (content.indexOf(oldSql) !== -1) {
        message.content = replaceNthOccurrence(content, oldSql, fixedSql, occurrence);
        if (message.understandingContent && content.indexOf(message.understandingContent) === 0) {
          var position = findNthOccurrenceIndex(content, oldSql, occurrence);
          if (position !== -1 && position < message.understandingContent.length) {
            message.understandingContent = replaceNthOccurrence(
              message.understandingContent, oldSql, fixedSql, occurrence);
          }
        }
      }
      // 指纹与 content 都挂在会话对象上，这里负责把它写回当前会话。
      // 会话由后端 SQLite 持久化，目前没有「整条消息正文回写」接口
      // （只有 POST /api/ai/sessions/<id>/messages 追加），所以这里的落盘等价物
      // 只能是内存态 —— 不伪造请求。
      if (state.sessions && session) state.messages = messages;
      void idx;
    } catch (ignore) { /* 持久化失败不能打断已经成功的修复展示 */ }
  }

  /**
   * SQL 指纹归一化。**只做不改变语义的归一化**：
   * 统一换行 → 去行尾空白 → 压 `;` 前空白 → 去收尾分号 → 多空白压单空格。
   * 关键是**不能把字符串字面量内部的空格压掉**（`'A  B'` 与 `'A B'` 是两个不同取值，
   * 归一化了就会把两条语义不同的语句认成同一指纹，覆盖层互相贴错），
   * 所以这里只动空白、不动引号里的内容。
   */
  function normSqlFp(sql) {
    try {
      var text = String(sql || '').trim();
      return text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\s+;/g, ';')
        .replace(/[\u000d\u000a]\s*$/g, '')
        .replace(/;\s*$/, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+/g, ' ');
    } catch (ignore) { return String(sql || '').trim(); }
  }

  /** 按原句指纹查这条消息的覆盖层（`#` 前缀是历史兼容键）。 */
  function sqlOverrideGet(message, rawSql) {
    try {
      if (!message || !message.sqlOverrides) return null;
      var fp = normSqlFp(rawSql);
      if (!fp) return null;
      return message.sqlOverrides[fp] || message.sqlOverrides['#' + fp] || null;
    } catch (ignore) { return null; }
  }

  /**
   * 渲染 / 拆分子块时按整会话查覆盖层。
   * 为什么要跨消息查：同一条 SQL 可能在两轮回答里都出现，修复过一次就不该
   * 在第二轮里又长出「没修过的旧写法」。
   */
  function sqlOverrideFind(rawSql) {
    try {
      var messages = state.messages || [];
      var fp = normSqlFp(rawSql);
      if (!fp) return null;
      for (var index = 0; index < messages.length; index += 1) {
        var message = messages[index];
        if (!message || !message.sqlOverrides) continue;
        var value = message.sqlOverrides[fp] || message.sqlOverrides['#' + fp];
        if (value) return { fixedSql: value, idx: index };
      }
      return null;
    } catch (ignore) { return null; }
  }

  /** 把「原句指纹 → 修复后语句」写进消息。 */
  function sqlOverridePut(message, rawOldSql, rawFixedSql) {
    try {
      var fp = normSqlFp(rawOldSql);
      if (!fp || !rawFixedSql) return;
      if (!message.sqlOverrides) message.sqlOverrides = {};
      message.sqlOverrides[fp] = rawFixedSql;
    } catch (ignore) { /* 覆盖层写不进去就不写，正文回写仍会尝试 */ }
  }

  /** 第 n 次出现（0 基）的位置，找不到返回 -1。 */
  function findNthOccurrenceIndex(text, search, n) {
    if (!text || !search) return -1;
    var position = -1;
    for (var i = 0; i <= n; i += 1) {
      position = text.indexOf(search, position + 1);
      if (position === -1) return -1;
    }
    return position;
  }

  /** 只替换第 n 次出现，其余保持原样。 */
  function replaceNthOccurrence(text, search, replacement, n) {
    var position = findNthOccurrenceIndex(text, search, n);
    if (position === -1) return text;
    return text.substring(0, position) + replacement
      + text.substring(position + search.length);
  }

  /**
   * 代码块文本被程序改写时的唯一出口。
   * 五步一个都不能少：写 DOM 文本 → 写台账 → **按新语句重建占位符台账基线** →
   * 刷新撤销按钮 → 更新提示。
   * 为什么要重建基线：语句已经被改写（AI 修字段名、方言改写），拿改写前的旧基线去撤销
   * 会把刚改好的语法又吃回去；重建后「撤销占位符替换」依然可用，且恢复的是
   * 适配新 SQL 的占位符版本。
   * 第三个参数 rerender 是本仓库的接缝：槽位面板正握着这个节点时不让宿主整段重绘。
   */
  function setBlockSql(node, newSql, rerender) {
    var pre = node && node.tagName === 'PRE' ? node : (node && node.querySelector
      ? node.querySelector('pre.aias-code-pre, pre.aias-sql-pre') : null);
    if (!pre) return;
    var code = pre.querySelector('code') || pre;
    code.textContent = newSql;
    var id = sqlIdOf(pre);
    if (id) setStoredSql(id, newSql);
    slotRebaseLedger(pre, newSql);
    slotRefreshRestoreBtn(pre);
    slotUpdateHint(pre);
    // DOM 之外还要把会话正文跟着改，
    // 否则刷新后围栏里仍是旧语句、界面上却是新的那一份（槽位替换同样依赖这一步）。
    persistFenceOfBlock(pre, newSql, rerender);
  }

  /**
   * 把块的当前文本同步回消息正文里的围栏代码块。正文回写只有这一处入口，
   * 槽位替换与 AI 修复都靠它。定位按「消息内第几个围栏块」，
   * 与渲染时的 uid（m{消息下标}-b{块序号}）一致。
   */
  function persistFenceOfBlock(pre, newSql, rerender) {
    var uid = sqlIdOf(pre);
    var message = messageOfBlock(uid);
    var fenceIndex = fenceIndexOf(uid);
    var persisted = false;
    if (message && fenceIndex >= 0) {
      var rewritten = replaceNthFence(message.content, fenceIndex, newSql);
      if (rewritten !== message.content) {
        message.content = rewritten;
        persisted = true;
      }
    }
    if (uid) delete state.blockExtras[uid];      // 内容变了：旧结果/旧报错/旧方言提示作废
    if (pre.getAttribute) pre.setAttribute('data-raw-sql', newSql);
    if (persisted && rerender !== false) renderMessages();
    return persisted;
  }

  function messageOfBlock(uid) {
    var matched = String(uid || '').match(/^m(\d+)/);
    return matched ? state.messages[Number(matched[1])] : null;
  }

  function fenceIndexOf(uid) {
    var matched = String(uid || '').match(/-b(\d+)$/);
    return matched ? Number(matched[1]) : -1;
  }

  /** 只替换消息正文里第 n 个围栏代码块的内容（语言标记保留）。 */
  function replaceNthFence(text, index, newCode) {
    var counter = 0;
    return String(text == null ? '' : text).replace(
      /```([a-zA-Z0-9_+.-]*)\r?\n?([\s\S]*?)```/g, function (match, language) {
        var current = counter;
        counter += 1;
        if (current !== index) return match;
        return '```' + language + '\n' + newCode + '\n```';
      });
  }

  /** 当前会话的消息数组（切会话时整个被替换，每次都取当下这一份）。 */
  function sessionMessages() {
    var session = currentSession();
    if (session && session.messages) return session.messages;
    return state.messages || [];
  }

  // ── 方言：徽标 + 预检 + 一键改写 ──

  /**
   * 徽标要覆盖的「目标库集合」=
   * 会话 currentDatasource + 本次会话用过的 datasources（去重）。
   * 集合为空就把徽标**摘掉**（没选定目标库，谈不上版本确认）；
   * 同一个集合的结果缓存在 state.dialectStatusCache，
   * 否则每次重绘、每个块都会对同一批源再问一次版本。
   */
  function loadDialectBadge(box, sqlId) {
    if (!box) return;
    var badge = box.querySelector('.aias-dialect-badge[data-dialect-sql-id="' + sqlId + '"]');
    if (!badge) return;
    var names = [];
    var seen = {};
    var session = currentSession();
    if (session) {
      var current = session.currentDatasource || state.defaultDatasource || '';
      if (current) { seen[current] = true; names.push(current); }
      (session.datasources || state.usedDatasources || []).forEach(function (name) {
        var clean = String(name || '').trim();
        if (clean && !seen[clean]) { seen[clean] = true; names.push(clean); }
      });
    } else {
      (state.usedDatasources || []).forEach(function (name) {
        var clean = String(name || '').trim();
        if (clean && !seen[clean]) { seen[clean] = true; names.push(clean); }
      });
    }
    if (!names.length) { if (badge.remove) badge.remove(); else if (badge.parentNode) badge.parentNode.removeChild(badge); return; }
    var key = names.join('|');
    if (state.dialectStatusCache[key] !== undefined) {
      renderDialectBadge(badge, state.dialectStatusCache[key]);
      return;
    }
    requestJson('/api/ai/assistant/dialect-status', { method: 'POST',
      body: JSON.stringify({ datasource_names: names }) }).then(function (d) {
      var rows = (d && d.ok && Array.isArray(d.datasources)) ? d.datasources : [];
      state.dialectStatusCache[key] = rows;
      if (badge.isConnected) renderDialectBadge(badge, rows);
    }).catch(function () {
      if (badge.isConnected) { if (badge.remove) badge.remove(); else if (badge.parentNode) badge.parentNode.removeChild(badge); }
    });
  }

  /**
   * 徽标的四种情形，各自给出对应的文案与 tooltip。
   * 常态（单库已确认）只显示版本、把库名放进 tooltip —— 输入框上方胶囊已经展示了
   * 当前默认源，徽标再重复一遍只会刷屏。
   */
  function renderDialectBadge(badge, ds) {
    var confirmed = ds.filter(function (item) { return item && item.confirmed; });
    var unknown = ds.filter(function (item) { return item && !item.confirmed; });
    badge.classList.remove('is-loading');
    if (confirmed.length === 1 && ds.length === 1) {
      var version = confirmed[0].label || confirmed[0].version || t('webui.aias_ver_unknown', '版本未知');
      badge.textContent = '🛢 ' + version;
      badge.setAttribute('title', tpl('webui.aias_badge_tip_one',
        '目标库 {name} · {ver}，已确认版本，生成 SQL 已按此版本适配',
        { name: confirmed[0].name,
          ver: confirmed[0].version || confirmed[0].label || t('webui.aias_ver_unknown', '版本未知') }));
      return;
    }
    if (confirmed.length === ds.length && ds.length > 1) {
      badge.textContent = tpl('webui.aias_badge_multi_ok', '🛢 版本已确认({n}库)', { n: ds.length });
      badge.classList.remove('is-unknown');
      badge.setAttribute('title', t('webui.aias_badge_tip_all', '全部数据源版本已确认：') + '\n'
        + confirmed.map(function (item) {
            return item.name + ' · ' + (item.label || item.version || t('webui.aias_ver_unknown', '未知'));
          }).join('\n'));
      return;
    }
    if (unknown.length === ds.length) {
      badge.textContent = t('webui.aias_badge_unknown', '⚠ 版本未知');
      badge.classList.add('is-unknown');
      badge.setAttribute('title', t('webui.aias_badge_tip_unknown',
        '未探测到目标库版本，生成 SQL 已采用跨版本保守写法，可能与你的库存在语法差异'));
      return;
    }
    badge.textContent = t('webui.aias_badge_partial', '⚠ 部分库版本未知');
    badge.classList.add('is-unknown');
    badge.setAttribute('title', t('webui.aias_badge_tip_partial_ok', '已确认：')
      + confirmed.map(function (item) { return item.name; }).join('、')
      + t('webui.aias_badge_tip_partial_mid', '；未知：')
      + unknown.map(function (item) { return item.name; }).join('、'));
  }

  /**
   * 按 `data-dialect-checked` 幂等，
   * 且**只对命中关键字预筛（DIALECT_HINT_RE）的块**发请求 —— 不含 FETCH FIRST /
   * 窗口函数 / JSON_TABLE 之类版本敏感语法的块，问后端也是白问。
   * 预筛过的一律打上 checked（不含可疑关键字 = 永远不会再需要问），
   * 所以重绘之间不会重复请求。
   */
  function scanDialectSql() {
    dialectScanTimer = 0;
    var pres = document.querySelectorAll('pre.aias-code-pre');
    var datasource = slotDs();
    var need = [];
    var target = [];
    var cacheKeys = [];
    Array.prototype.forEach.call(pres, function (pre) {
      if (pre.getAttribute('data-dialect-checked') === '1') return;
      var text = preText(pre.querySelector('code') || pre);
      pre.setAttribute('data-dialect-checked', '1');
      if (!text || !DIALECT_HINT_RE.test(text)) return;      // 不含可疑关键字 → 不必问后端
      need.push(text);
      target.push(pre);
      cacheKeys.push(datasource + '|' + sqlFingerprint(normSqlFp(text)));
    });
    if (!need.length) return;
    // /dialect-check 必须指定数据源（未指定目标源时后端直接 400「缺少数据源」），
    // 没有目标源时不打后端，等胶囊选定后自然再扫。
    if (!datasource) return;
    var send = [];
    for (var i = 0; i < need.length; i += 1) {
      if (state.dialectCache[cacheKeys[i]] !== undefined) continue;
      send.push(need[i]);
    }
    if (!send.length) {
      // 全部命中缓存：直接按缓存把提示补回来（重绘后 warn 框需要重新贴）
      for (var k = 0; k < target.length; k += 1) {
        applyDialectCache(target[k], cacheKeys[k], datasource);
      }
      return;
    }
    requestJson('/api/ai/assistant/dialect-check', { method: 'POST',
      body: JSON.stringify({ datasource_name: datasource, sqls: need }) })
      .then(function (d) {
        if (!d || !d.ok || !d.results) return;
        for (var index = 0; index < target.length && index < d.results.length; index += 1) {
          state.dialectCache[cacheKeys[index]] = { meta: d, violations: (d.results[index] || {}).violations || [] };
          applyDialectCache(target[index], cacheKeys[index], datasource);
        }
      }).catch(function () { /* 预检不通不影响执行本身 */ });
  }

  /** 命中缓存 / 刚拿到的结果都走这一步：把违规提示贴回这个块。 */
  function applyDialectCache(pre, cacheKey, datasource) {
    var cached = state.dialectCache[cacheKey];
    if (!cached) return;
    var violations = cached.violations || [];
    if (violations.length && pre.isConnected) {
      try { showDialectWarning(pre, cached.meta || {}, violations); } catch (ignore) { /* 单个块贴不上不影响其他块 */ }
    }
    void datasource;
  }

  /** 徽标/预检用的目标数据源 = 会话默认源 → 本次会话碰过的第一个。 */
  function slotDs() {
    var datasource = getSqlDatasource();
    if (!datasource && state.usedDatasources.length) datasource = state.usedDatasources[0];
    return datasource || '';
  }

  /**
   * 把「目标库不支持这段语法」贴在**这块 SQL 之前**。
   * pre.__dialectWarn 是幂等句柄（同一个块只贴一个框）；violations 多于一条时
   * 说明「另有 N 处同类问题」，正文只展开第一条 + 正确写法；
   * 后端判定存在歧义（会话没指定数据源）时额外说明「按 X 判定」。
   * 两个动作按钮：**一键改写**（后端确定性改写，不是模型猜的）+ **忽略**（这条我确认没问题）。
   */
  function showDialectWarning(pre, meta, violations) {
    if (!pre || !pre.parentNode || pre.__dialectWarn) return;
    var violation = violations[0];
    var box = document.createElement('div');
    box.className = 'aias-dialect-warn';
    var more = violations.length > 1 ? tpl('webui.aias_dialect_more', '（另有 {n} 处同类问题）',
      { n: violations.length - 1 }) : '';
    box.innerHTML = '<div class="aias-dialect-head">' + escapeHtml(
        t('webui.aias_dialect_head_prefix', '⚠️ 目标库 ')) + '<b>' + escapeHtml(
        meta.label || t('webui.aias_ver_unknown_label', '未知版本')) + '</b>' + escapeHtml(
        t('webui.aias_dialect_head_tail', ' 不支持这条语句里的语法')) + escapeHtml(more) + '</div>'
      + '<div class="aias-dialect-body"><div>' + escapeHtml(violation.msg || '') + '</div>'
      + (violation.alt ? '<div class="aias-dialect-alt">' + escapeHtml(
          t('webui.aias_dialect_correct', '正确写法：')) + '<code>' + escapeHtml(violation.alt)
          + '</code></div>' : '')
      + (meta.ambiguous ? '<div class="aias-dialect-alt">' + escapeHtml(
          t('webui.aias_dialect_ambiguous', 'ℹ️ 会话未指定数据源，按 ')) + '<b>' + escapeHtml(
          meta.datasource || '') + '</b>' + escapeHtml(
          t('webui.aias_dialect_ambiguous_tail', ' 判定；若执行目标是别的库，请先选定数据源'))
        + '</div>' : '')
      + '</div><div class="aias-dialect-actions"></div>';
    var actions = box.querySelector('.aias-dialect-actions');
    if (violation.rewrite) {
      var fix = document.createElement('button');
      fix.type = 'button';
      fix.className = 'aias-dialect-fix';
      fix.textContent = t('webui.aias_dialect_rewrite', '一键改写为兼容写法');
      fix.setAttribute('title', t('webui.aias_dialect_rewrite_tip',
        '按目标库版本做确定性改写（不是 AI 猜的）'));
      fix.addEventListener('click', function () { dialectRewrite(pre, box, fix, violation.rewrite); });
      actions.appendChild(fix);
    }
    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'aias-dialect-dismiss';
    dismiss.textContent = t('webui.aias_dialect_ignore', '忽略');
    dismiss.setAttribute('title', t('webui.aias_dialect_ignore_tip', '这条语句我确认没问题，不再提示'));
    dismiss.addEventListener('click', function () {
      if (box.parentNode) box.parentNode.removeChild(box);
      pre.__dialectWarn = null;
    });
    actions.appendChild(dismiss);
    pre.__dialectWarn = box;
    pre.parentNode.insertBefore(box, pre);
  }

  /**
   * 摘掉为「无按钮块」临时插的占位执行区（连同写进台账的那一句）。
   * 只在接口异常的 catch 里摘是不够的：requestJson 会把「200 但响应不成形状」
   * 归一成 {}，所以这一句在**响应不可用**时也要调用一次 —— 否则占位锚点会留在写语句旁边，
   * 下一轮渲染或用户点击就可能出现「写语句有执行入口」这种最不该出现的界面。
   */
  function dropTempExecWraps() {
    Array.prototype.forEach.call(document.querySelectorAll('.aias-sql-exec-wrap[data-tmp="1"]'),
      function (shell) {
        var owner = shell.previousElementSibling;
        if (owner && owner.getAttribute && owner.getAttribute('data-sql-id')) {
          delete state.sqlStore[owner.getAttribute('data-sql-id')];
        }
        if (shell.parentNode) shell.parentNode.removeChild(shell);
      });
  }

  /**
   * 调后端做**确定性**改写（不是让模型猜）。
   * 改不动也要把 reason 讲清楚并在原地回一行说明 —— 静默失败最让人恼火；
   * 成功则走 setBlockSql（DOM + 台账 + 台账基线一起改），摘掉当前提示框、
   * 清掉 data-dialect-checked 让改写后的语句重新预检一次。
   */
  function dialectRewrite(pre, box, btn, kind) {
    if (!pre || !btn) return;
    var sql = preText(pre.querySelector('code') || pre);
    var oldLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('webui.aias_rewriting', '改写中…');
    requestJson('/api/ai/assistant/dialect-rewrite', { method: 'POST',
      body: JSON.stringify({ sql: sql, kind: kind }) }).then(function (d) {
      btn.disabled = false;
      btn.textContent = oldLabel;
      if (!d || !d.ok || !d.changed) {
        var note = box.querySelector('.aias-dialect-alt');
        if (note) {
          note.innerHTML = escapeHtml(t('webui.aias_rewrite_noop', 'ℹ️ ')) + escapeHtml(
            (d && (d.reason || d.error))
            || t('webui.aias_rewrite_failed_hint', '无法自动改写，请参考上面的正确写法手工调整'));
        }
        return;
      }
      setBlockSql(pre, d.sql, false);
      if (box.parentNode) box.parentNode.removeChild(box);
      pre.__dialectWarn = null;
      pre.removeAttribute('data-dialect-checked');   // 改写后可能有新问题，允许再检一次
      scheduleDialectScan();
    }).catch(function (failure) {
      btn.disabled = false;
      btn.textContent = oldLabel;
      var note = box.querySelector('.aias-dialect-alt');
      if (note) {
        note.innerHTML = escapeHtml(t('webui.aias_rewrite_request_failed', '⚠️ 改写请求失败：'))
          + escapeHtml((failure && failure.message) || t('webui.aias_network_error', '网络异常'));
      }
    });
  }

  // ── 批量执行：多源串行 + 汇总 + 就地明细 ────────────────────

  /**
   * 把同一句 SQL 串行打到多个同类库上。
   * 结构照搬：先取全量数据源列表 → 多选弹窗（锁同类型 + 全选本类型）→ doRun。
   * doRun 里的要点：
   *   · **一次最多 20 源**，超出直接提示分批（跨几十个库串行会把请求挂死）；
   *   · 状态行「正在执行 i/N · 名称」+「■ 停止」按钮（batchStop 只置标志位，
   *     下一条 before send 前检查，已经在跑的那条不打断）；
   *   · 逐条结果按 {name, db_type, total, ok, error, result, multi} 收集，
   *     全部跑完再 renderBatchSummary 汇总（不是边跑边刷表格）。
   */
  function executeSqlBatch(sqlId) {
    var sql = state.sqlStore[sqlId] || '';
    var resultDiv = resultBoxFor(sqlId);
    if (!resultDiv) return;
    if (!sql.trim()) {
      resultDiv.innerHTML = '<div class="aias-sql-result-error">'
        + escapeHtml(t('webui.aias_sql_empty', 'SQL 为空')) + '</div>';
      return;
    }
    var sessId = state.sessionId || '';
    var maxRows = rowLimitValue(resultDiv);

    var doRun = function (dsList) {
      if (!dsList || !dsList.length) return;
      if (dsList.length > 20) {
        notify(tpl('webui.aias_batch_too_many',
          '一次最多批量执行 20 个数据源，当前 {n} 个，请分批执行', { n: dsList.length }), 'error');
        return;
      }
      writeResult(sqlId, '<div class="aias-sql-result-loading">🔄 ' + escapeHtml(
          tpl('webui.aias_batch_running_hint', '正在批量执行到 {n} 个数据源（串行）…',
              { n: dsList.length })) + '</div>'
        + '<div class="aias-batch-status"></div>'
        + '<button type="button" class="aias-batch-stop">'
        + escapeHtml(t('webui.aias_batch_stop_btn', '■ 停止')) + '</button>');
      batchAbort = false;
      var results = [];
      var names = dsList.map(function (item) { return item.name || item.datasource_name || ''; });
      var cursor = 0;
      var box = resultBoxFor(sqlId) || resultDiv;
      (function next() {
        if (batchAbort) {
          box.innerHTML = '<div class="aias-sql-result-error">⚠️ ' + escapeHtml(
            t('webui.aias_batch_stopped_at', '已手动停止（完成 ')) + results.length + '/'
            + dsList.length + '）</div>';
          return;
        }
        if (cursor >= dsList.length) {
          renderBatchSummary(box, sqlId, dsList, results);
          return;
        }
        var ds = dsList[cursor];
        var name = names[cursor];
        var statusEl = box.querySelector('.aias-batch-status');
        if (statusEl) {
          statusEl.textContent = tpl('webui.aias_batch_status', '正在执行 {i}/{n} · {name}',
            { i: cursor + 1, n: dsList.length, name: name });
        }
        requestJson('/api/ai/assistant/execute-sql', { method: 'POST',
          body: JSON.stringify({ datasource_name: name, sql: unescapeHtml(sql),
                                 session_id: sessId, max_rows: maxRows }) })
          .then(function (data) {
            data = data || {};
            var error = '';
            if (data.multi) {
              error = data.error || (data.failed_index
                ? tpl('webui.aias_batch_nth_failed', '第 {i} 条失败', { i: data.failed_index }) : '');
            } else if (!data.ok) {
              error = data.error || t('webui.aias_exec_failed', '执行失败');
            }
            results.push({
              name: name,
              db_type: ds.db_type || '',
              total: (data.result && data.result.total)
                || (data.multi && data.statements ? data.statements.length : 0),
              ok: !error,
              error: error,
              result: data.result || null,
              multi: data.multi || false
            });
            cursor += 1;
            next();
          })
          .catch(function (failure) {
            results.push({ name: name, db_type: ds.db_type || '', total: 0, ok: false,
              error: t('webui.aias_request_failed', '请求失败: ')
                + ((failure && failure.message) || t('webui.aias_network_error', '网络异常')),
              result: null, multi: false });
            cursor += 1;
            next();
          });
      })();
    };

    // 先取全量数据源列表 → 打开多选弹窗（锁定同类型 + 全选本类型）
    writeResult(sqlId, '<div class="aias-sql-result-loading">' + escapeHtml(
      t('webui.aias_loading_ds', '⏳ 加载数据源列表...')) + '</div>');
    requestJson('/api/pro/datasources').then(function (data) {
      if (data && data.ok && data.datasources && data.datasources.length) {
        state.datasources = data.datasources;
        showDatasourceMultiModal(data.datasources,
          t('webui.aias_batch_modal_title', '批量执行 · 选择要执行的同类库'), doRun);
      } else {
        writeResult(sqlId, '<div class="aias-sql-result-error">' + escapeHtml(
          t('webui.aias_ds_empty', '⚠️ 暂无可用数据源，请先到「数据源管理」添加')) + '</div>');
      }
    }).catch(function () {
      writeResult(sqlId, '<div class="aias-sql-result-error">' + escapeHtml(
        t('webui.aias_ds_list_failed', '⚠️ 获取数据源列表失败')) + '</div>');
    });
  }

  /** 只置标志位，正在跑的那一条自然跑完，下一条不再发。 */
  function batchStop() {
    batchAbort = true;
  }

  /**
   * 汇总表（数据源 / 类型 / 状态 / 行数 / 详情）
   * + 一个就地展开面板的容器 + 隐藏的结果映射。
   * 结果数组还挂到 window['_aiasBatchResults_' + sqlId] 上：
   * 「详情」按钮是内联 onclick 触发的，靠这个名字找回这一次批量的原始结果
   * （本仓库改成 data 属性 + 委托，但保留同一个全局名，方便回归用例直接驱动）。
   */
  function renderBatchSummary(resultDiv, sqlId, dsList, results) {
    var okCount = results.filter(function (item) { return item.ok; }).length;
    var failCount = results.length - okCount;
    var html = '<div class="aias-batch-summary' + (failCount ? ' has-err' : '') + '">'
      + (failCount
          ? '⚠️ ' + escapeHtml(t('webui.aias_batch_done', '批量完成：成功 ')) + '<b>' + okCount
            + '</b> / ' + results.length + '，' + escapeHtml(t('webui.aias_batch_failed_label', '失败 '))
            + '<b>' + failCount + '</b>'
          : '✅ ' + escapeHtml(t('webui.aias_batch_all_ok_prefix', '批量完成：')) + results.length
            + escapeHtml(t('webui.aias_batch_all_ok_tail', ' 个数据源全部执行成功')))
      + '</div>';
    html += '<table class="aias-batch-table"><thead><tr>'
      + '<th>' + escapeHtml(t('webui.aias_th_ds', '数据源')) + '</th>'
      + '<th>' + escapeHtml(t('webui.aias_th_type', '类型')) + '</th>'
      + '<th>' + escapeHtml(t('webui.aias_th_status', '状态')) + '</th>'
      + '<th>' + escapeHtml(t('webui.aias_th_rows', '行数')) + '</th>'
      + '<th>' + escapeHtml(t('webui.aias_th_detail', '详情')) + '</th>'
      + '</tr></thead><tbody>';
    for (var index = 0; index < results.length; index += 1) {
      var row = results[index];
      html += '<tr class="' + (row.ok ? '' : 'is-err') + '">'
        + '<td class="aias-batch-ds">' + escapeHtml(row.name) + '</td>'
        + '<td>' + escapeHtml(row.db_type || '') + '</td>'
        + '<td>' + (row.ok ? escapeHtml(t('webui.aias_batch_row_ok', '✓ 成功'))
            : '✗ ' + escapeHtml(row.error || t('webui.aias_batch_row_fail', '失败'))) + '</td>'
        + '<td>' + (row.total || 0) + '</td>'
        + '<td>' + (row.result
            ? '<button type="button" class="aias-batch-detail" data-batch-name="'
              + escapeHtml(row.name) + '">' + escapeHtml(t('webui.aias_batch_view', '查看')) + '</button>'
            : '') + '</td>'
        + '</tr>';
    }
    html += '</tbody></table>';
    html += '<div class="aias-batch-detail-panels" id="aias-batch-detail-' + sqlId + '"></div>';
    html += '<div class="aias-batch-dsname-map" style="display:none" id="aias-batch-map-' + sqlId + '">'
      + escapeHtml(JSON.stringify(results.map(function (item) {
          return { name: item.name, result: item.result, ok: item.ok, error: item.error, multi: item.multi };
        }))) + '</div>';
    writeResult(sqlId, html);
    window['_aiasBatchResults_' + sqlId] = results;
  }

  /** 明细面板句柄：数据源名多为中文，\\W+ 会把整串压成同一个 '_'，
      两个库抢同一个 id 就表现为「第二个库的查看点了没反应」。名字哈希保证一名一柄。 */
  function batchPanelKey(sqlId, name) {
    var s = String(name == null ? '' : name);
    var h = 0;
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    var readable = s.slice(0, 12).replace(/[^\w\u4e00-\u9fff]+/g, '_').replace(/^_+|_+$/g, '');
    return 'aias-batch-panel-' + sqlId + '-' + (readable || 'ds') + '-' + (h >>> 0).toString(36);
  }

  /**
   * 点「查看」在同一个汇总区下方**就地**展开/收起该源明细。
   * 三种 body：多语句（逐条 ✓/✗ + 行数或错误）、单表（迷你表，无数据给一行占位）、错误（一行文本）。
   * 已存在的面板只切 display（不重建），这样用户的滚动位置与选中的文本都还在。
   */
  function batchToggleDetail(btn, name) {
    var box = btn && btn.closest ? btn.closest('[id$="-result"]') : null;
    if (!box) return;
    var sqlId = String(box.id || '').replace(/-result$/, '');
    var panelsEl = byId('aias-batch-detail-' + sqlId);
    if (!panelsEl) return;
    var results = window['_aiasBatchResults_' + sqlId] || [];
    var found = results.filter(function (item) { return item.name === name; })[0];
    if (!found) return;
    var key = batchPanelKey(sqlId, name);
    var existing = byId(key);
    if (existing) {
      existing.style.display = existing.style.display === 'none' ? 'block' : 'none';
      return;
    }
    var body = '';
    if (found.multi && found.result && found.result.statements) {
      body += '<div class="aias-batch-stmt">' + found.result.statements.map(function (item) {
        return (item.ok ? '✓' : '✗') + ' ' + escapeHtml(item.sql || '') + ' → '
          + (item.ok
              ? escapeHtml(t('webui.aias_total_rows', '共 ')) + (item.total || 0) + ' '
                + escapeHtml(t('webui.aias_rows_unit', '行'))
              : escapeHtml(item.error || t('webui.aias_batch_row_fail', '失败')));
      }).join('<br>') + '</div>';
    } else if (found.result && found.result.columns) {
      var columns = found.result.columns;
      var rows = found.result.rows || [];
      body += '<div class="aias-batch-mini-table-wrap"><table class="aias-result-table"><thead><tr>';
      columns.forEach(function (column) { body += '<th>' + escapeHtml(column) + '</th>'; });
      body += '</tr></thead><tbody>';
      if (rows.length) {
        rows.forEach(function (row) {
          body += '<tr>';
          row.forEach(function (cell) {
            body += '<td>' + (cell === null || cell === undefined
              ? '<span class="ait-null">NULL</span>' : escapeHtml(cell)) + '</td>';
          });
          body += '</tr>';
        });
      } else {
        body += '<tr><td colspan="' + Math.max(columns.length, 1) + '" class="ait-empty-row">'
          + escapeHtml(t('webui.aias_no_data', '（无数据）')) + '</td></tr>';
      }
      body += '</tbody></table></div>';
    } else {
      body = '<div class="aias-batch-err">' + escapeHtml(
        found.error || t('webui.aias_batch_no_result', '无结果')) + '</div>';
    }
    var panel = document.createElement('div');
    panel.id = key;
    panel.className = 'aias-batch-detail-panel';
    panel.innerHTML = '<div class="aias-batch-detail-head">🏢 ' + escapeHtml(name) + escapeHtml(
      t('webui.aias_batch_detail_tail', ' 明细')) + '</div>' + body;
    panelsEl.appendChild(panel);
  }

  /**
   * 执行用的源与会话默认**不同**才标一句「↪ 已用数据源」。
   * 相同的时候不标（每块都重复一遍会话默认源就是噪音）。
   */
  function dsOverrideTag(dsName) {
    try {
      var fallback = getSqlDatasource();
      if (!dsName || (fallback && dsName === fallback)) return '';
      return '<div class="aias-sql-override-tag">' + escapeHtml(
        t('webui.aias_ds_override_prefix', '↪ 已用数据源：')) + '<b>' + escapeHtml(dsName)
        + '</b>' + escapeHtml(t('webui.aias_ds_override_suffix', '（与会话默认不同）')) + '</div>';
    } catch (ignore) { return ''; }
  }

  /**
   * 兼容层：任务回溯页与回归用例还在用 resultHtml(body, ds, sql) 这个入口。
   * 内部一律走结果渲染那一族 builder（先判 multi → 再判 ok → 单条成功），
   * 保证界面与助手页完全一致，不再另写一套结果结构。
   */
  function resultHtml(body, datasource, originSql) {
    var data = body || {};
    if (data.multi) {
      return dsOverrideTag(datasource) + buildMultiResultHtml(data, 'aitask-' + sqlFingerprint(originSql || ''));
    }
    if (!data.ok) {
      return dsOverrideTag(datasource) + buildSqlErrorHtml(
        'aitask-' + sqlFingerprint(originSql || ''),
        data.error || t('webui.aias_exec_failed', '执行失败'),
        !!data.db_error, data.repair);
    }
    return dsOverrideTag(datasource) + rewriteNoteTag(data.result)
      + buildOneResultHtml(data.result, data.var_name);
  }

  /**
   * 会话用过的数据源：
   * streamRequest 要把它当 datasource_names 带给模型，模型才知道「这台机器上本次会话碰过谁」。
   * 注意不是「全部可见数据源」——那会让模型在十几个同名源里瞎猜。
   */
  function trackDatasource(arguments_) {
    var name = (arguments_ || {}).datasource_name;
    if (!name) return;
    state.defaultDatasource = name;
    if (state.usedDatasources.indexOf(name) < 0) state.usedDatasources.push(name);
    var select = byId('aias-ds-select');
    if (select) select.value = name;
    refreshDatasourceCapsule();
    if (window.FusionAiSqlSlots) window.FusionAiSqlSlots.setDatasource(name);
  }

  /** 会话默认源 → 页面上下文当前源。 */
  function getSqlDatasource() {
    if (state.defaultDatasource) return state.defaultDatasource;
    // 这里要直接读 getChatContext().datasource_name：pageContext() 是白名单式的
    // （只挑 page/sql_content/... 几个键），datasource_name 不在里面，绕过去取原值，
    // 否则「页面当前选中数据源」这一层回退永远是空串。
    try {
      if (typeof window.getChatContext === 'function') {
        var raw = window.getChatContext() || {};
        if (raw.datasource_name) return raw.datasource_name;
      }
    } catch (ignore) { /* 上下文取不到就当没有 */ }
    return '';
  }

  /** 胶囊显示会话默认源，没选过时给 is-empty 态。 */
  function refreshDatasourceCapsule() {
    var bar = byId('aias-ds-capsule');
    if (!bar) return;
    var nameEl = byId('aias-ds-capsule-name');
    var btnEl = byId('aias-ds-capsule-btn');
    var ds = getSqlDatasource();
    if (nameEl) {
      nameEl.textContent = ds || t('webui.aias_ds_none', '未选择数据源');
      nameEl.setAttribute('title', ds || t('webui.aias_ds_none', '未选择数据源'));
    }
    if (btnEl) btnEl.classList.toggle('is-empty', !ds);
  }

  /** 数据源条目那一行 meta：「类型 · 主机:端口 · 目录 · 标签 · N 节点」。 */
  function dsItemMeta(item, withType) {
    var meta = [
      withType ? (item.db_type || '') : '',
      item.host ? String(item.host) + (item.port ? (':' + item.port) : '') : '',
      t('webui.aias_dir_prefix', '目录: ') + (item.dir_path || t('webui.aias_dir_unassigned', '未分配')),
      (item.labels && item.labels.length)
        ? t('webui.aias_label_prefix', '标签: ') + item.labels.join('/') : '',
      (Number(item.node_count || 0) > 1)
        ? item.node_count + ' ' + t('webui.aias_nodes', '节点') : ''
    ].filter(Boolean);
    return meta.join(' · ');
  }

  /**
   * 先走共享的「左目录 / 右表格」选择器（dsOpenPicker），
   * 只有该组件不在时才退回扁平列表。两条分支的回调契约一样：拿到名称字符串。
   * 关键点是 aiasSelectDs 的注释那句：必须先取回调再关窗 ——
   * 关窗会清空回调，反过来写就是「选了数据源却什么都不执行」。
   */
  function showDatasourceModal(dsList, title, onSelect, options) {
    var picker = window.FusionDsPicker;
    if (picker && typeof picker.open === 'function') {
      // 把会话当前默认源回填成高亮，clearLabel 用「不指定数据源」
      // allowClear 恒为 true（不看调用方传什么），
      // 因为「把会话默认源清掉」任何时候都该能做。写成按 options 判断，
      // 从胶囊进来时就少一条「不指定数据源」，用户没法把会话默认源清掉。
      picker.open({
        title: title || t('webui.aias_pick_datasource', '选择数据源'),
        multi: false,
        allowClear: true,
        clearLabel: t('webui.aias_ds_clear', '不指定数据源'),
        selected: getSqlDatasource() ? [getSqlDatasource()] : [],
        dataList: (dsList && dsList.length) ? dsList : null
      }).then(function (ds) {
        if (ds === undefined) return;                 // 取消 / Esc / 点遮罩：什么都不做
        if (typeof onSelect === 'function') onSelect(ds ? (ds.name || ds.datasource_name || '') : '');
      });
      return;
    }
    dsState.list = dsList || [];
    dsState.callback = onSelect;
    dsState.allowClear = !!(options && options.allowClear);
    dsState.chosen = null;
    var modal = byId('aias-ds-modal');
    if (!modal) return;
    var titleEl = modal.querySelector('.aias-ds-modal-title');
    if (titleEl) titleEl.textContent = title || t('webui.aias_pick_datasource', '选择数据源');
    var body = modal.querySelector('.aias-ds-modal-body');
    if (!body) return;
    var current = getSqlDatasource();
    if (!dsState.list.length) {
      body.innerHTML = '<div class="aias-ds-empty">' +
        escapeHtml(t('webui.aias_ds_empty', '暂无可用数据源，请先到「数据源管理」添加')) + '</div>';
    } else {
      body.innerHTML = dsState.list.map(function (item) {
        var name = item.name || item.datasource_name || '';
        return '<div class="aias-ds-item' + (name === current ? ' is-on' : '') +
          '" data-ds-name="' + escapeHtml(name) + '">' +
          '<div class="aias-ds-item-name">' + escapeHtml(name) + '</div>' +
          '<div class="aias-ds-item-meta">' + escapeHtml(dsItemMeta(item, true)) + '</div></div>';
      }).join('');
      if (dsState.allowClear) {
        // picker 分支有 allowClear/clearLabel，回退分支也要给一条「不指定数据源」，否则两条路的退路不一致
        body.insertAdjacentHTML('beforeend', '<div class="aias-ds-item is-clear" data-ds-name="">' +
          '<div class="aias-ds-item-name">' +
          escapeHtml(t('webui.aias_ds_clear', '不指定数据源')) + '</div></div>');
      }
    }
    bindDsModalOnce(modal);
    modal.style.display = 'flex';
  }

  function bindDsModalOnce(modal) {
    if (modal.dataset.bound === '1') return;
    modal.dataset.bound = '1';
    modal.querySelectorAll('[data-close-ds-modal]').forEach(function (closer) {
      closer.onclick = closeDatasourceModal;
    });
    modal.addEventListener('click', function (event) {
      if (event.target === modal) { closeDatasourceModal(); return; }
      var row = event.target.closest('.aias-ds-item');
      if (row) chooseDatasource(row.getAttribute('data-ds-name') || '');
    });
  }

  /** 选中数据源：先取回调、再关窗。 */
  function chooseDatasource(name) {
    var callback = dsState.callback;
    dsState.callback = null;
    closeDatasourceModal();
    if (typeof callback === 'function') callback(name);
  }

  function closeDatasourceModal() {
    var modal = byId('aias-ds-modal');
    if (modal) modal.style.display = 'none';
    dsState.callback = null;
  }

  /** 胶囊点按 = 换会话默认执行源。 */
  function changeDefaultDatasource() {
    showDatasourceModal(state.datasources,
      t('webui.aias_change_default_ds', '选择会话默认数据源（SQL 默认执行于此）：'),
      function (name) {
        state.defaultDatasource = name;
        if (name && state.usedDatasources.indexOf(name) < 0) state.usedDatasources.push(name);
        var select = byId('aias-ds-select');
        if (select) select.value = name;
        refreshDatasourceCapsule();
        if (window.FusionAiSqlSlots) window.FusionAiSqlSlots.setDatasource(name);
      }, { allowClear: true });
  }

  /**
   * 列表分支：批量执行只允许**同一数据库类型**，
   * 勾第一个就锁类型，其他类型整组禁用（跨库语法不兼容，跑一半报错最坑）。
   */
  function showDatasourceMultiModal(dsList, title, onConfirm) {
    var picker = window.FusionDsPicker;
    if (picker && typeof picker.open === 'function') {
      // 批量 = 多选 + 锁同一类型（跨库语法不兼容）
      picker.open({
        title: title || t('webui.aias_batch_pick_title', '批量执行 · 选择数据源'),
        multi: true,
        sameType: true,
        dataList: (dsList && dsList.length) ? dsList : null
      }).then(function (arr) {
        if (!arr || !arr.length) return;
        if (typeof onConfirm === 'function') onConfirm(arr);
      });
      return;
    }
    dsMultiState.list = dsList || [];
    dsMultiState.callback = onConfirm;
    dsMultiState.selected = [];
    dsMultiState.lockType = '';
    var modal = byId('aias-ds-multi-modal');
    if (!modal) return;
    var titleEl = modal.querySelector('.aias-ds-multi-title');
    if (titleEl) titleEl.textContent = title || t('webui.aias_batch_pick_title', '批量执行 · 选择数据源');
    bindDsMultiOnce(modal);
    renderDsMulti();
    modal.style.display = 'flex';
  }

  function bindDsMultiOnce(modal) {
    if (modal.dataset.bound === '1') return;
    modal.dataset.bound = '1';
    modal.querySelectorAll('[data-close-ds-multi]').forEach(function (closer) {
      closer.onclick = closeDsMultiModal;
    });
    modal.addEventListener('click', function (event) {
      if (event.target === modal) { closeDsMultiModal(); return; }
      var selectAll = event.target.closest('.aias-ds-multi-selectall');
      if (selectAll) { dsMultiSelectAll(selectAll.getAttribute('data-type') || ''); return; }
      if (event.target.closest('.aias-ds-multi-ok')) { confirmDsMulti(); return; }
      if (event.target.closest('.aias-ds-multi-cancel')) { closeDsMultiModal(); return; }
      var check = event.target.closest('input[type=checkbox][data-midx]');
      if (check) dsMultiToggle(check);
    });
  }

  function dsTypeOf(item) {
    return String(item.db_type || '').trim() || t('webui.aias_ds_other_type', '其他');
  }

  function renderDsMulti() {
    var modal = byId('aias-ds-multi-modal');
    if (!modal) return;
    var note = modal.querySelector('.aias-ds-multi-note');
    if (note) {
      note.innerHTML = dsMultiState.lockType
        ? escapeHtml(t('webui.aias_batch_locked', '已锁定类型 ')) + '<b>' +
          escapeHtml(dsMultiState.lockType) + '</b>' +
          escapeHtml(t('webui.aias_batch_locked_tail', '，其他类型已自动禁用'))
        : escapeHtml(t('webui.aias_batch_note', '仅可批量执行')) + '<b>' +
          escapeHtml(t('webui.aias_batch_same_type', '同一数据库类型')) + '</b>' +
          escapeHtml(t('webui.aias_batch_note_tail', '，勾选首个即锁定类型'));
    }
    var groups = {};
    dsMultiState.list.forEach(function (item) {
      var type = dsTypeOf(item);
      (groups[type] = groups[type] || []).push(item);
    });
    var body = modal.querySelector('.aias-ds-multi-body');
    body.innerHTML = Object.keys(groups).map(function (type) {
      var items = groups[type];
      var disabled = !!dsMultiState.lockType && dsMultiState.lockType !== type;
      var rows = items.map(function (item) {
        var index = dsMultiState.list.indexOf(item);
        var checked = dsMultiState.selected.indexOf(index) >= 0;
        return '<label class="aias-ds-multi-item' + (checked ? ' is-on' : '') +
          (disabled ? ' is-off' : '') + '">' +
          '<input type="checkbox" data-midx="' + index + '" data-mtype="' +
          escapeHtml(type) + '"' + (checked ? ' checked' : '') +
          (disabled ? ' disabled' : '') + '>' +
          '<span class="aias-ds-multi-item-name">' +
          escapeHtml(item.name || item.datasource_name || '') + '</span>' +
          '<span class="aias-ds-multi-item-meta">' + escapeHtml(dsItemMeta(item, false)) + '</span></label>';
      }).join('');
      return '<div class="aias-ds-multi-group"><div class="aias-ds-multi-grouphead">' +
        '<span class="aias-ds-multi-type">🛢 ' + escapeHtml(type) + '（' + items.length + '）</span>' +
        '<button type="button" class="aias-ds-multi-selectall" data-type="' + escapeHtml(type) + '"' +
        (disabled ? ' disabled' : '') + '>☑ ' +
        escapeHtml(t('webui.aias_batch_select_all_type', '全选本类型')) + '</button></div>' +
        rows + '</div>';
    }).join('') || '<div class="aias-ds-empty">' +
      escapeHtml(t('webui.aias_ds_empty', '暂无可用数据源，请先到「数据源管理」添加')) + '</div>';
    var count = modal.querySelector('.aias-ds-multi-count');
    if (count) count.textContent = t('webui.aias_batch_selected_n', '已选') + ' ' + dsMultiState.selected.length;
    var ok = modal.querySelector('.aias-ds-multi-ok');
    if (ok) ok.textContent = t('webui.aias_batch_run_label', '批量执行') +
      '(' + dsMultiState.selected.length + ')';
  }

  function dsMultiToggle(checkbox) {
    var index = Number(checkbox.getAttribute('data-midx'));
    var type = checkbox.getAttribute('data-mtype') || '';
    if (checkbox.checked) {
      if (dsMultiState.lockType && dsMultiState.lockType !== type) {
        checkbox.checked = false;
        notify(t('webui.aias_batch_lock_conflict', '仅支持同一类型批量：当前已锁定 ') +
          dsMultiState.lockType + ' · ' +
          t('webui.aias_batch_lock_hint', '请先取消已选中的其它库'), 'error');
        return;
      }
      if (!dsMultiState.lockType) dsMultiState.lockType = type;
      if (dsMultiState.selected.indexOf(index) < 0) dsMultiState.selected.push(index);
    } else {
      dsMultiState.selected = dsMultiState.selected.filter(function (kept) { return kept !== index; });
      if (!dsMultiState.selected.length) dsMultiState.lockType = '';
    }
    renderDsMulti();
  }

  function dsMultiSelectAll(type) {
    if (dsMultiState.lockType && dsMultiState.lockType !== type) {
      notify(t('webui.aias_batch_lock_conflict', '仅支持同一类型批量：当前已锁定 ') +
        dsMultiState.lockType, 'error');
      return;
    }
    dsMultiState.lockType = type;
    dsMultiState.list.forEach(function (item, index) {
      if (dsTypeOf(item) !== type) return;
      if (dsMultiState.selected.indexOf(index) < 0) dsMultiState.selected.push(index);
    });
    renderDsMulti();
  }

  function closeDsMultiModal() {
    var modal = byId('aias-ds-multi-modal');
    if (modal) modal.style.display = 'none';
    dsMultiState.callback = null;
  }

  /** 多选确认：同样先取回调再关窗。 */
  function confirmDsMulti() {
    var callback = dsMultiState.callback;
    dsMultiState.callback = null;
    var picked = dsMultiState.selected.map(function (index) { return dsMultiState.list[index]; });
    closeDsMultiModal();
    if (!picked.length) return;
    if (typeof callback === 'function') callback(picked);
  }

  // ══════════════════════════════════════════════════════════
  // 发送与流式接收
  // ══════════════════════════════════════════════════════════

  /**
   * 发送一句提问。返回「是否真的发出去了」——
   * 调用方（输入框）据此决定要不要清空草稿：生成中或空内容时不该把字吞掉。
   */
  function sendText(text) {
    if (state.generating) return false;
    var message = String(text || '').trim();
    if (!message) return false;
    if (!state.sessionId) {
      createSession().then(function () { sendInternal(message); });
      return true;
    }
    sendInternal(message);
    return true;
  }

  /** 从输入框发送：只有发出去了才清空 + 收回高度，草稿不该被 Enter 吃掉。 */
  function submitFromInput() {
    var input = byId('aias-input');
    if (!input) return false;
    var text = String(input.value || '');
    if (!sendText(text)) return false;
    input.value = '';
    autoGrow(input);
    return true;
  }

  /** 首问自动命名：只在该会话还没起过名字时生效，手工改过名的不动。 */
  function titleSessionFromQuestion(message) {
    var session = currentSession();
    if (!session) return;
    var fallback = t('webui.aias_new_title', '新对话');
    if (session.title && session.title !== fallback) return;
    var text = String(message || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    renameSession(session.id,
      text.length > SESSION_TITLE_MAX ? text.slice(0, SESSION_TITLE_MAX) + '...' : text);
  }

  /**
   * 新的 AI 占位消息 —— 字段与历史回填的那一条一致：
   * toolChainHtml 存**已构建好的 HTML 字符串**（每次工具事件都重建整条链路再贴回），
   * 确认状态用 needConfirmation / confirmQuestion / confirmOptions /
   * pendingToolCalls / confirmUnderstanding 五个字段（流式过程写、
   * 消息渲染与确认选择读的就是这几个）。
   */
  function newAiMessage() {
    return { role: 'ai', content: '', timestamp: Date.now(), streaming: true,
             toolChainHtml: '', understandingContent: '', thinkingContent: '',
             needConfirmation: false, confirmQuestion: '', confirmOptions: null,
             pendingToolCalls: null, confirmUnderstanding: '', taskId: '' };
  }

  function sendInternal(message, extra) {
    var firstTurn = !state.messages.length;
    state.messages.push({ role: 'user', content: message, timestamp: Date.now() });
    state.messages.push(newAiMessage());
    var aiMsgIdx = state.messages.length - 1;
    // 首句提问即会话标题，否则侧栏一排「新对话」回头找不到
    if (firstTurn) titleSessionFromQuestion(message);
    renderMessages();
    var msgText = byId('aias-msg-text-' + aiMsgIdx);
    if (msgText) {
      msgText.innerHTML = '<div class="aias-typing"><span></span><span></span><span></span></div>';
    }
    streamRequest(message, aiMsgIdx, extra || {});
  }

  /** 往前找最近一条用户提问（确认续跑要复用原问句，而不是把确认问句当新问题发）。 */
  function originalQuestionFor(index) {
    for (var position = index - 1; position >= 0; position -= 1) {
      var item = state.messages[position];
      if (item && item.role === 'user') return item.content;
    }
    return t('webui.aias_confirm_user_action', '用户确认执行');
  }

  /**
   * 一条流的完整生命周期：逐事件驱动界面。
   * 事件 → UI 的映射：thinking_* 走 renderThinking（原地更新思考块），
   * tool_* 每次都重建整条链路 HTML 走 updateMessageWithToolsAndThinking，
   * chunk 按「是否已进入分析阶段」分流到 analysisContent / fullContent，
   * need_confirmation 把卡片**追加**到当前正文后面（不重建，避免抹掉已渲染内容）。
   * 确认选项的循环只写一份，两个入口共用，避免两处行为走偏。
   */
  function streamRequest(message, aiMsgIdx, extra) {
    var sess = currentSession();
    var context = pageContext();
    // 这里显式补 datasource_name/datasource_names：getChatContext 只在数据源页/SQL 编辑器页
    // 才带数据源，助手页不带 → 后端拿不到目标库 → 提示词里没有「数据源实际版本」那一节 →
    // LLM 按最新语法编（给 Oracle 11g 写 FETCH FIRST，执行就 ORA-00933）。
    var dsCtx = {};
    if (state.defaultDatasource) dsCtx.datasource_name = state.defaultDatasource;
    if (state.usedDatasources.length) {
      dsCtx.datasource_names = state.usedDatasources.slice(0, 5);
    }
    var payload = Object.assign({
      message: message,
      session_id: sess ? sess.id : state.sessionId,
      history: historyMessages(aiMsgIdx)
    }, context, dsCtx, extra || {});

    state.generating = true;
    setGeneratingUi(true);
    state.userScrolledUp = false;
    state.abortController = window.AbortController ? new AbortController() : null;

    var fullContent = '';            // 纯文本回复（无工具时）
    var understandingContent = '';   // Phase 1 理解文本
    var analysisContent = '';        // Phase 3 分析正文（Markdown）
    var analysisStarted = false;
    var hasToolChain = false;
    var toolReasoning = '';
    var toolSteps = [];
    var toolAnalyzing = false;
    var thinkingContent = '';
    var thinkingActive = false;
    var thinkingDone = false;

    function target() { return state.messages[aiMsgIdx]; }

    function combinedHtml() {
      // 流式期间把思考块按「已完成 + 折叠」带上（正文在长，思考过程收起来不占地方）
      var think = thinkingDone ? buildThinkingHtml(thinkingContent, true, true) : '';
      return think + (hasToolChain
        ? buildToolChainHtml(toolReasoning, toolSteps, toolAnalyzing) : '');
    }

    function dispatch(data) {
      var type = data.type;
      if (type === 'thinking_start') {
        thinkingActive = true;
        thinkingDone = false;
        thinkingContent = '';
        renderThinking(aiMsgIdx, '', true);
        return;
      }
      if (type === 'thinking') {
        if (data.replace) thinkingContent = data.content || '';
        else thinkingContent += (data.content || '');
        renderThinking(aiMsgIdx, thinkingContent, true);
        return;
      }
      if (type === 'thinking_end') {
        thinkingActive = false;
        thinkingDone = true;
        // 思考完成默认展开（要让人看到模型怎么想的），autoCollapse=false 是不许自动收起
        renderThinking(aiMsgIdx, thinkingContent, false, false);
        return;
      }
      if (type === 'need_confirmation') {
        var message = target();
        if (!message) return;
        message.needConfirmation = true;
        message.confirmQuestion = data.question || '';
        message.confirmOptions = data.options || [];
        message.pendingToolCalls = data.pending_tool_calls || [];
        message.confirmUnderstanding = data.understanding || '';
        message.streaming = false;
        state.generating = false;
        setGeneratingUi(false);
        var card = byId('aias-msg-text-' + aiMsgIdx);
        if (card) {
          card.innerHTML = String(card.innerHTML || '')
            .replace('<span class="aias-cursor"></span>', '') +
            buildConfirmationHtml(data.question, data.options);
        }
        scrollToBottom(false);
        return;
      }
      if (type === 'tool_start') {
        hasToolChain = true;
        understandingContent = fullContent.trim();
        toolReasoning = data.reasoning || understandingContent.substring(0, 200) ||
          t('webui.aias_tc_default_reasoning', '根据用户请求调用对应工具');
        toolSteps = [];
        toolAnalyzing = false;
        updateMessageWithToolsAndThinking(aiMsgIdx, combinedHtml(), understandingContent, true);
        return;
      }
      if (type === 'tool_executing') {
        toolSteps.push({ tool: data.tool, arguments: data.arguments || {}, status: 'running' });
        trackDatasource(data.arguments || {});
        // 追加取数（round>1）：上一轮分析是基于不完整数据的中间内容（还可能带 <query> 标签），
        // 必须清掉，最终结论才只落在完整数据上
        if (data.round && data.round > 1 && analysisStarted) analysisContent = '';
        updateMessageWithToolsAndThinking(aiMsgIdx, combinedHtml(), understandingContent, true);
        return;
      }
      if (type === 'tool_progress') {
        if (!toolSteps.length) return;
        var current = toolSteps[toolSteps.length - 1];
        current.progress = {
          step: data.step, total: data.total, chapter: data.chapter || '',
          query_key: data.query_key || '', description: data.description || '',
          status: data.status || 'running'
        };
        updateMessageWithToolsAndThinking(aiMsgIdx, combinedHtml(), understandingContent, true);
        return;
      }
      if (type === 'tool_result') {
        if (!toolSteps.length) return;
        var last = toolSteps[toolSteps.length - 1];
        last.result = data.result;
        last.status = data.status || 'success';
        last.duration_ms = data.duration_ms;
        updateMessageWithToolsAndThinking(aiMsgIdx, combinedHtml(), understandingContent, true);
        return;
      }
      if (type === 'tool_analyzing') {
        toolAnalyzing = true;
        analysisStarted = true;
        updateMessageWithToolsAndThinking(aiMsgIdx, combinedHtml(), understandingContent, true);
        return;
      }
      if (type === 'token' || type === 'chunk') {
        var chunkText = data.content || data.token || '';
        if (analysisStarted) {
          analysisContent += chunkText;
          // 分析正文已经在长了：链路头部不再显示「分析中」转圈（这一步传 analyzing=false）
          var thinkingHtml = thinkingDone ? buildThinkingHtml(thinkingContent, true, true) : '';
          var chainHtml = toolAnalyzing ? buildToolChainHtml(toolReasoning, toolSteps, false) : '';
          updateMessageWithToolsAndThinking(aiMsgIdx, thinkingHtml + chainHtml, analysisContent, true);
        } else if (hasToolChain) {
          analysisContent += chunkText;
          updateMessageWithToolsAndThinking(aiMsgIdx, combinedHtml(), analysisContent, true);
        } else {
          fullContent += chunkText;
          var thinkPlain = thinkingDone ? buildThinkingHtml(thinkingContent, true, true) : '';
          updateMessageWithThinking(aiMsgIdx, thinkPlain, fullContent, true);
        }
        return;
      }
      if (type === 'error') {
        var errMsg = '\n\n⚠️ **' + t('webui.aias_error_label', '错误') + '**: ' +
          (data.message || t('webui.aias_model_error', 'AI 返回错误'));
        if (hasToolChain) {
          analysisContent += errMsg;
          updateMessageWithToolsAndThinking(aiMsgIdx, combinedHtml(), analysisContent, true);
        } else {
          fullContent += errMsg;
          updateMessageWithThinking(aiMsgIdx,
            thinkingDone ? buildThinkingHtml(thinkingContent, true, true) : '', fullContent, true);
        }
        return;
      }
      if (type === 'inspect_done') {
        var doneMsg = '\n\n✅ ' + (data.message || t('webui.aias_inspect_done', '巡检完成'));
        if (hasToolChain) {
          analysisContent += doneMsg;
          updateMessageWithToolsAndThinking(aiMsgIdx, combinedHtml(), analysisContent, true);
        } else {
          fullContent += doneMsg;
          updateMessageWithThinking(aiMsgIdx,
            thinkingDone ? buildThinkingHtml(thinkingContent, true, true) : '', fullContent, true);
        }
        return;
      }
      if (type === 'continue_query') {
        var roundNum = data.round || '?';
        updateMessageWithToolsAndThinking(aiMsgIdx,
          buildToolChainHtml(toolReasoning, toolSteps, false) + '\n\n💡 ' +
          tpl('webui.aias_continue_query', '**[第 {n} 轮分析] 继续查询中: {reason}**', {
            n: roundNum,
            reason: data.reasoning || t('webui.aias_tc_analyzing_data', '正在分析数据...')
          }),
          analysisContent, true);
        return;
      }
      if (type === 'needs_clarification') {
        var clarify = '❓ ' + tpl('webui.aias_clarify_round', '**第 {n} 轮：需要澄清**',
          { n: data.round || '?' }) + '\n\n' +
          (data.question || t('webui.aias_ask_more', '请补充更多信息。'));
        if (hasToolChain) {
          analysisContent = clarify;
          updateMessageWithToolsAndThinking(aiMsgIdx, combinedHtml(), analysisContent, true);
        } else {
          fullContent = clarify;
          updateMessageWithThinking(aiMsgIdx, '', fullContent, true);
        }
        return;
      }
      if (type === 'intermediate_analysis') {
        var analysisMsg = '📊 ' + tpl('webui.aias_intermediate_round', '**[第 {n} 轮分析]**',
          { n: data.round || '?' }) + '\n\n' + (data.analysis || '');
        if (hasToolChain) {
          analysisContent += analysisMsg;
          updateMessageWithToolsAndThinking(aiMsgIdx, combinedHtml(), analysisContent, true);
        } else {
          fullContent += analysisMsg;
          updateMessageWithThinking(aiMsgIdx, '', fullContent, true);
        }
        return;
      }
      if (type === 'inspect_result' || type === 'inspect_progress') {
        var progressText = (data.message || '') + '\n';
        if (hasToolChain) {
          analysisContent += progressText;
          updateMessageWithToolsAndThinking(aiMsgIdx, combinedHtml(), analysisContent, true);
        } else {
          fullContent += progressText;
          updateMessageWithThinking(aiMsgIdx, '', fullContent, true);
        }
        return;
      }
      if (type === 'inspect_ask') {
        var askText = data.message || t('webui.aias_pick_datasource_first', '请选择数据源');
        if (data.candidates && data.candidates.length) {
          askText += '\n\n' + t('webui.aias_ds_candidates', '可选数据源：') + '\n';
          data.candidates.forEach(function (name) { askText += '- ' + name + '\n'; });
        }
        if (hasToolChain) {
          analysisContent = askText;
          updateMessageWithToolsAndThinking(aiMsgIdx, combinedHtml(), analysisContent, true);
        } else {
          fullContent = askText;
          updateMessageWithThinking(aiMsgIdx, '', fullContent, true);
        }
        return;
      }
      if (type === 'start') {
        var message2 = target();
        if (message2 && data.task_id) message2.taskId = data.task_id;
        return;
      }
      // debug / done / end / 其它：一律忽略，界面上不该出现心跳文本
    }

    function finish() {
      var message = target();
      if (!message) return;
      message.streaming = false;
      // 残留的 <query> 取数标签：成对的整体去掉；未闭合的只删起始标签本身 ——
      // 用 <query[\s\S]*$ 会把后面的建议 SQL 整段截掉
      analysisContent = String(analysisContent || '')
        .replace(/<query[\s\S]*?<\/query>/gi, '').replace(/<query[^>]*>/gi, '');
      if (hasToolChain) {
        message.content = understandingContent + '\n\n' + analysisContent;
        message.understandingContent = understandingContent;
        message.toolChainHtml = buildToolChainHtml(toolReasoning, toolSteps, false);
      } else {
        message.content = fullContent;
      }
      if (thinkingDone && thinkingContent) message.thinkingContent = thinkingContent;
      state.generating = false;
      setGeneratingUi(false);
      finalizeMessage(aiMsgIdx);
      loadSessions();
    }

    return fetch('/api/ai/assistant/stream', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: state.abortController ? state.abortController.signal : undefined
    }).then(function (response) {
      if (!response.ok || !response.body || !response.body.getReader) {
        throw new Error('HTTP ' + response.status);
      }
      return readSse(response.body, dispatch).then(finish);
    }).catch(function (failure) {
      var message = target();
      if (message) {
        if (failure && failure.name === 'AbortError') {
          // 停止：半截正文照样留在界面上，并由后端把这轮任务标 stopped
          message.streaming = false;
          message.content = (message.content || fullContent || '') + '\n\n' +
            t('webui.aias_interrupted_mark', '*[已中断]*');
        } else {
          var reason = (failure && failure.message) || t('webui.aias_request_failed', '请求失败');
          message.content = (message.content || fullContent || '') + '\n\n⚠️ **' +
            t('webui.aias_error_label', '错误') + '**: ' + reason;
          message.streaming = false;
        }
      }
      finish();
      return null;
    });
  }

  /** 发送最近 20 条历史（取 messages 里除最后一条外的内容，最多 10 轮）。 */
  function historyMessages(aiMsgIdx) {
    var history = [];
    var limit = aiMsgIdx === undefined ? state.messages.length - 1 : aiMsgIdx;
    for (var i = 0; i < limit && history.length < 20; i += 1) {
      var item = state.messages[i];
      if (item && item.content) {
        history.push({ role: item.role === 'user' ? 'user' : 'assistant', content: item.content });
      }
    }
    return history;
  }


  /** 打断这条流；半截正文由流的 catch 落定。 */
  function stopGeneration() {
    if (state.abortController) {
      try { state.abortController.abort(); } catch (ignore) { /* 已结束 */ }
      state.abortController = null;
    }
    requestJson('/api/ai/assistant/stop', { method: 'POST',
      body: JSON.stringify({ session_id: state.sessionId }) });
  }

  /**
   * 确认选择：找到**最后一条**带 needConfirmation 的消息，
   * 把候选项里的数据源/模板 id 填进 pending_tool_calls，标记已确认并把
   * 「✅ 已确认选择：X」追加进正文，再推一条新的 AI 占位气泡续跑
   *（不发新的用户气泡 —— 用户那句原话才是这条流的问题）。
   */
  function chooseConfirmation(messageIndex, optionIndex) {
    var message = state.messages[messageIndex];
    if (!message || !message.needConfirmation || state.generating) return;
    var options = message.confirmOptions || [];
    var option = options[optionIndex];
    if (!option) return;
    var confirmed = (message.pendingToolCalls || []).map(function (call) {
      var args = Object.assign({}, call.arguments || {});
      // 候选项里的名字可能只在 value 上（模型直接产 confirm_options 时不带 datasource_name）：
      // 两个键名都要认，只认一个就等于没填参数
      if (option.action === 'set_datasource') {
        args.datasource_name = option.datasource_name || option.value || '';
      }
      if (option.action === 'select_template') {
        args.template_id = option.template_id || option.value;
      }
      return { name: call.name, arguments: args };
    });
    if (option.action === 'set_datasource') trackDatasource({ datasource_name: option.datasource_name || option.value });
    message.needConfirmation = false;
    message.content = (message.content || '') + '\n\n✅ ' +
      t('webui.aias_confirm_chosen', '**已确认选择：') + (option.label || option.value || '') + '**';
    var understood = message.confirmUnderstanding || '';
    var question = originalQuestionFor(messageIndex) || message.confirmQuestion ||
      t('webui.aias_confirm_continue', '确认继续');
    state.messages.push(newAiMessage());
    var aiMsgIdx = state.messages.length - 1;
    renderMessages();
    var msgText = byId('aias-msg-text-' + aiMsgIdx);
    if (msgText) {
      msgText.innerHTML = '<div class="aias-typing"><span></span><span></span><span></span></div>';
    }
    state.generating = true;
    state.userScrolledUp = false;
    setGeneratingUi(true);
    streamRequest(question, aiMsgIdx, {
      confirmed_tool_calls: confirmed,
      understanding: understood,
      selected_action: option.action || ''
    });
  }


  function pageContext() {
    var context = {};
    try {
      if (typeof window.getChatContext === 'function') {
        var raw = window.getChatContext() || {};
        context.page = raw.page || 'ai-assistant';
        context.page_title = raw.page_title || t('webui.aias_page_title', 'AI 巡检助手');
        if (raw.sql_content) context.sql_content = raw.sql_content;
        if (raw.template_id) context.template_id = raw.template_id;
        if (raw.db_type) context.db_type = raw.db_type;
      }
    } catch (ignore) { /* 页面上下文取不到不影响对话 */ }
    return context;
  }

  function readSse(body, onEvent) {
    var reader = body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buffer = '';
    function pump() {
      return reader.read().then(function (result) {
        if (result.done) return null;
        buffer += decoder.decode(result.value, { stream: true });
        var frames = buffer.split('\n\n');
        buffer = frames.pop();
        frames.forEach(function (frame) {
          frame.split('\n').forEach(function (line) {
            if (line.indexOf('data: ') !== 0) return;
            try { onEvent(JSON.parse(line.slice(6))); }
            catch (ignore) { /* 半帧：等下一个 chunk 再解 */ }
          });
        });
        return pump();
      });
    }
    return pump();
  }

  function stripQueryTags(text) {
    return String(text || '')
      .replace(/<query[\s\S]*?<\/query>/gi, '')
      .replace(/<query[^>]*>/gi, '');
  }

  /** 往前找最近一条用户提问（确认续跑要复用它，而不是把确认问句当新问题）。 */
  function setGeneratingUi(generating) {
    var send = byId('aias-send-btn');
    var stop = byId('aias-stop-btn');
    if (send) send.style.display = generating ? 'none' : 'inline-flex';
    if (stop) stop.style.display = generating ? 'inline-flex' : 'none';
    var input = byId('aias-input');
    if (input) input.disabled = false;      // 生成中也允许继续打字
  }

  // ══════════════════════════════════════════════════════════
  // 弹窗：任务历史 / 巡检进度 / 数据源版本
  // ══════════════════════════════════════════════════════════

  function showTaskHistory() {
    var modal = byId('aias-task-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    refreshTaskHistory();
    clearInterval(state.historyTimer);
    state.historyTimer = setInterval(refreshTaskHistory, TASK_POLL_MS);
    modal.querySelector('.aias-task-list').addEventListener('click', function (event) {
      var row = event.target.closest('[data-task-id]');
      if (!row) return;
      showTaskDetail(row.getAttribute('data-task-id'), modal.querySelector('.aias-task-detail'));
    });
    var closers = modal.querySelectorAll('[data-close-task-modal]');
    closers.forEach(function (closer) {
      closer.onclick = function () {
        modal.style.display = 'none';
        clearInterval(state.historyTimer);
      };
    });
  }

  function refreshTaskHistory() {
    var modal = byId('aias-task-modal');
    if (!modal || modal.style.display === 'none') return;
    requestJson('/api/ai/assistant/tasks').then(function (body) {
      var rows = (body && body.tasks) || [];
      var host = modal.querySelector('.aias-task-list');
      var counter = modal.querySelector('.aias-task-count');
      if (counter) counter.textContent = tpl('webui.aias_task_total', '共 {n} 条', { n: rows.length });
      if (!rows.length) {
        host.innerHTML = '<div class="aias-task-empty">' + escapeHtml(
          tpl('webui.aias_task_empty_hint', '还没有巡检任务记录。可以试试：「巡检 {ds}」',
            { ds: state.defaultDatasource || t('webui.aias_ds_any', '某数据源') })) + '</div>';
        return;
      }
      host.innerHTML = rows.map(function (task) {
        return '<div class="aias-task-item" data-task-id="' + escapeHtml(task.task_id) + '">' +
          '<span class="aias-task-state is-' + escapeHtml(task.status) + '">' +
          escapeHtml(task.status) + '</span>' +
          '<span class="aias-task-name">' + escapeHtml(task.datasource || task.db_type || '') + '</span>' +
          '<span class="aias-task-time">' + escapeHtml(truncate(task.started_at, 19)) + '</span>' +
          '</div>';
      }).join('');
    });
  }

  function showTaskDetail(taskId, host) {
    if (!host) return;
    host.innerHTML = '<div class="aias-task-empty">' +
        escapeHtml(t('webui.aias_loading', '加载中…')) + '</div>';
    requestJson('/api/ai/assistant/task/' + encodeURIComponent(taskId)).then(function (body) {
      if (!body || !body.ok) { host.innerHTML = '<div class="aias-task-empty">' +
        escapeHtml((body && body.error) || t('webui.aias_task_missing', '任务不存在')) + '</div>'; return; }
      var logs = body.log || [];
      host.innerHTML = '<div class="aias-track-head"><b>' +
        escapeHtml(body.datasource || t('webui.aias_inspection_task', '巡检任务')) + '</b>' +
        '<span class="aias-badge is-' + escapeHtml(body.status) + '">' +
        escapeHtml(taskStatusLabel(body.status)) + '</span></div>' +
        (body.health_score !== undefined && body.health_score !== null
          ? '<div class="aias-track-score">' + escapeHtml(
            tpl('webui.aias_track_score_level', '健康分 {s} · 风险 {r}（{level}）',
              { s: body.health_score, r: body.risk_count || 0, level: body.risk_level || '' })) + '</div>'
          : '') +
        '<pre class="aias-track-log">' + escapeHtml((logs.length ? logs : [t('webui.aias_no_logs', '（暂无日志）')]).join('\n')) +
        '</pre>' +
        (body.report_file ? '<div class="aias-track-actions">' +
          '<a class="aias-track-btn" href="/api/download_file?name=' +
          encodeURIComponent(body.report_file) + '">' +
              escapeHtml(t('webui.aias_download_report', '📥 原始报告')) + '</a>' +
          '<button type="button" class="aias-track-btn" data-goto-reports>' +
              escapeHtml(t('webui.aias_goto_reports', '📊 在巡检历史中查看')) + '</button>' +
          '</div>' : '') +
        (body.error_msg ? '<div class="aias-track-error">⚠ ' + escapeHtml(body.error_msg) + '</div>' : '');
      var jump = host.querySelector('[data-goto-reports]');
      if (jump) jump.onclick = function () {
        byId('aias-task-modal').style.display = 'none';
        clearInterval(state.historyTimer);
        if (typeof window.showPage === 'function') window.showPage('reports');
      };
    });
  }

  function trackInspection(taskId, datasource) {
    var modal = byId('aias-track-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    var body = modal.querySelector('.aias-track-body');
    var title = modal.querySelector('.aias-track-title');
    if (title) title.textContent = tpl('webui.aias_track_title', '巡检进度 · {name}',
      { name: datasource || taskId });
    var stopped = false;
    var offset = 0;
    function poll() {
      if (stopped || modal.style.display === 'none') return;
      requestJson('/api/ai/assistant/task/' + encodeURIComponent(taskId) + '?offset=' + offset)
        .then(function (response) {
          if (!response || !response.ok) {
            body.innerHTML = '<div class="aias-task-empty">' +
              escapeHtml((response && response.error) || t('webui.aias_task_expired', '任务不存在或已过期')) + '</div>';
            return;
          }
          offset = response.offset || offset;
          body.innerHTML = '<div class="aias-track-head"><b>' +
            escapeHtml(response.datasource || datasource || taskId) + '</b>' +
            '<span class="aias-badge is-' + escapeHtml(response.status) + '">' +
            escapeHtml(taskStatusLabel(response.status)) + '</span></div>' +
            (response.health_score !== undefined && response.health_score !== null
              ? '<div class="aias-track-score">' + escapeHtml(
                tpl('webui.aias_track_score', '健康分 {s} · 风险 {r}',
                  { s: response.health_score, r: response.risk_count || 0 })) + '</div>' : '') +
            '<pre class="aias-track-log">' +
            escapeHtml((response.log || []).join('\n') || t('webui.aias_wait_logs', '（等待日志）')) + '</pre>' +
            (response.report_file ? '<div class="aias-track-actions">' +
              '<a class="aias-track-btn" href="/api/download_file?name=' +
              encodeURIComponent(response.report_file) + '">' +
              escapeHtml(t('webui.aias_download_report', '📥 原始报告')) + '</a></div>' : '');
          if (response.status === 'running') setTimeout(poll, TASK_POLL_MS);
        });
    }
    poll();
    modal.querySelectorAll('[data-close-track]').forEach(function (closer) {
      closer.onclick = function () { stopped = true; modal.style.display = 'none'; };
    });
  }

  var VERSION_SOURCE_LABELS = {
    live: 'webui.aias_ver_source_live', cache: 'webui.aias_ver_source_cache',
    stale: 'webui.aias_ver_source_stale', unknown: 'webui.aias_ver_source_unknown'
  };
  var VERSION_SOURCE_FALLBACKS = {
    live: '本次实探', cache: '缓存', stale: '历史值（刷新中）', unknown: '未探到'  // i18n-fallback 来源兜底
  };

  function versionAgeText(seconds) {
    var value = Number(seconds);
    if (!isFinite(value) || value < 0) return '';
    return value < 60
      ? ' · ' + Math.round(value) + ' ' + t('webui.aias_ver_age_seconds', '秒前')
      : ' · ' + Math.round(value / 60) + ' ' + t('webui.aias_ver_age_minutes', '分钟前');
  }

  /** 任务状态的中文标签（后端只回 running/done/error，界面不该把英文直接甩给用户）。 */
  function taskStatusLabel(status) {
    var keys = { running: ['webui.aias_task_running', '进行中'],  // i18n-fallback 状态兜底
                 done: ['webui.aias_task_done', '已完成'],  // i18n-fallback 状态兜底
                 success: ['webui.aias_task_done', '已完成'],  // i18n-fallback 状态兜底
                 error: ['webui.aias_task_error', '失败'],  // i18n-fallback 状态兜底
                 failed: ['webui.aias_task_error', '失败'],  // i18n-fallback 状态兜底
                 stopped: ['webui.aias_task_stopped', '已停止'],  // i18n-fallback 状态兜底
                 pending: ['webui.aias_task_pending', '排队中'] };  // i18n-fallback 状态兜底
    var item = keys[status];
    return item ? t(item[0], item[1]) : (status || '—');
  }

  function showDatasourceVersions() {
    var modal = byId('aias-ver-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    renderVersions(modal, false);
    if (modal.dataset.bound === '1') return;
    modal.dataset.bound = '1';
    var refresh = modal.querySelector('[data-refresh-versions]');
    if (refresh) refresh.onclick = function () { renderVersions(modal, true); };
    modal.querySelectorAll('[data-close-ver]').forEach(function (closer) {
      closer.onclick = function () { modal.style.display = 'none'; };
    });
  }

  function renderVersions(modal, force) {
    var host = modal.querySelector('.aias-ver-list');
    var refresh = modal.querySelector('[data-refresh-versions]');
    var refreshText = refresh ? (refresh.querySelector('span') || refresh) : null;
    host.innerHTML = '<div class="aias-task-empty">' + escapeHtml(force
      ? t('webui.aias_ver_probing', '正在重新探测各数据源的真实版本…（连不上时会等待超时）')
      : t('webui.aias_ver_reading', '正在读取版本…')) + '</div>';
    if (refresh) refresh.disabled = !!force;
    if (refreshText) refreshText.textContent = force
      ? t('webui.aias_ver_probing_btn', '探测中…')
      : t('webui.aias_reprobe', '重新探测');
    var url = '/api/ai/assistant/datasource-versions' + (force ? '?refresh=1' : '');
    requestJson(url).then(function (body) {
      if (refresh) refresh.disabled = false;
      if (refreshText) refreshText.textContent = t('webui.aias_reprobe', '重新探测');
      if (!body || body.ok === false) {
        host.innerHTML = '<div class="aias-ver-err">⚠️ ' +
          escapeHtml((body && body.error) || t('webui.aias_ver_failed', '获取失败')) + '</div>';
        return;
      }
      var rows = (body && body.datasources) || [];
      var summary = (body && body.summary) || {};
      // 摘要按「版本标签」分桶（Oracle 19c ×3 · MySQL 8 ×2），
      // 后端 by_family 只到 oracle/mysql 这一层，看不出配的具体版本
      var bucketsMap = {};
      rows.forEach(function (item) {
        var bucket = item.label || (item.db_type
          ? item.db_type + ' ' + t('webui.aias_ver_unknown_label', '未知版本') : '—');
        bucketsMap[bucket] = (bucketsMap[bucket] || 0) + 1;
      });
      var buckets = Object.keys(bucketsMap).sort(function (a, b) {
        return bucketsMap[b] - bucketsMap[a];
      }).map(function (key) { return key + ' ×' + bucketsMap[key]; }).join(' · ');
      var counter = modal.querySelector('.aias-ver-summary');
      if (counter) {
        counter.textContent = (buckets || '') +
          (buckets ? ' · ' : '') + tpl('webui.aias_versions_summary',
            '共 {total} 个 · 已确认 {ok} · 未确认 {fail}',
            { total: summary.total || rows.length, ok: summary.confirmed || 0,
              fail: summary.failed || 0 });
      }
      if (!rows.length) {
        host.innerHTML = '<div class="aias-task-empty">' +
          escapeHtml(t('webui.aias_ver_none', '未配置任何启用中的数据源。')) + '</div>';
        return;
      }
      // 版本来源/探测时间/连接目标都要摊开：DBA 判断「这个版本号是不是现取的」需要这些信息
      host.innerHTML = '<div class="aias-ver-hint">' + escapeHtml(
        t('webui.aias_ver_hint', '版本由系统自动实探，无需手工配置。标「当前目标」的是本次会话生成/执行 SQL 所用的数据源。')) +
        '</div>' + rows.map(function (item) {
          var failed = !item.confirmed || !item.version;
          var isTarget = !!state.defaultDatasource && item.name === state.defaultDatasource;
          var meta = [
            item.dir_path ? '📁 ' + item.dir_path : '',
            String(item.host || '') + (item.port ? (':' + item.port) : ''),
            item.database || '',
            VERSION_SOURCE_FALLBACKS[item.source]
              ? t(VERSION_SOURCE_LABELS[item.source], VERSION_SOURCE_FALLBACKS[item.source]) : ''
          ].filter(Boolean).join(' · ');
          return '<div class="aias-ver-row' + (failed ? ' is-fail' : '') +
            (isTarget ? ' is-target' : '') + '">' +
            '<div class="aias-ver-row-top"><span class="aias-ver-name" title="' +
            escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</span>' +
            (isTarget ? '<span class="aias-ver-tag is-current">' +
              escapeHtml(t('webui.aias_ver_current_target', '当前目标')) + '</span>' : '') +
            (item.db_type ? '<span class="aias-ver-tag">' + escapeHtml(item.db_type) + '</span>' : '') +
            '<span class="aias-ver-label">' +
            escapeHtml(item.label || t('webui.aias_ver_unknown_label', '未知版本')) + '</span></div>' +
            '<div class="aias-ver-ver">' + escapeHtml(item.version ||
              t('webui.aias_ver_no_version', '（未取到版本）')) + '</div>' +
            '<div class="aias-ver-meta">' + escapeHtml(meta) +
            escapeHtml(versionAgeText(item.age_s)) + '</div>' +
            (item.error ? '<div class="aias-ver-err">⚠️ ' + escapeHtml(item.error) + '</div>' : '') +
            '</div>';
        }).join('');
    }).catch(function (failure) {
      if (refresh) refresh.disabled = false;
      if (refreshText) refreshText.textContent = t('webui.aias_reprobe', '重新探测');
      host.innerHTML = '<div class="aias-ver-err">⚠️ ' +
        escapeHtml(t('webui.aias_ver_request_failed', '请求失败')) + '：' +
        escapeHtml(failure.message || '') + '</div>';
    });
  }

  // ══════════════════════════════════════════════════════════
  // 输入区 / 顶栏 / 侧栏 / 初始化
  // ══════════════════════════════════════════════════════════

  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, INPUT_MAX_HEIGHT) + 'px';
  }

  function bindStaticEvents() {
    var root = byId('page-ai-assistant');
    if (!root || root.dataset.bound === '1') return;
    root.dataset.bound = '1';

    var input = byId('aias-input');
    if (input) {
      input.addEventListener('input', function () { autoGrow(input); });
      input.addEventListener('keydown', function (event) {
        // 键位约定：Enter 发送、Shift+Enter 换行；Ctrl/Cmd+Enter 等价于 Enter
        //（不少 DBA 的手感就是 Ctrl+Enter，这个键没反应就像页面卡住了）
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        submitFromInput();
      });
    }
    var send = byId('aias-send-btn');
    if (send) send.addEventListener('click', submitFromInput);
    var stop = byId('aias-stop-btn');
    if (stop) stop.addEventListener('click', stopGeneration);

    // 「↓ 有新内容」提示条必须能点（点击滚到底，且是平滑滚，
    // 突然跳底会把人正在读的位置整个丢掉）
    var prompt = byId('aias-scroll-prompt');
    if (prompt) prompt.addEventListener('click', function () { scrollToBottom(false); });

    var select = byId('aias-ds-select');
    if (select) select.addEventListener('change', function () {
      state.defaultDatasource = select.value;
      refreshDatasourceCapsule();
      if (window.FusionAiSqlSlots) window.FusionAiSqlSlots.setDatasource(select.value);
    });
    var rowLimit = byId('aias-global-max-rows');
    if (rowLimit) {
      syncRowLimitInput();
      rowLimit.addEventListener('change', function () {
        // 钳制完把值写回输入框：填 99999 的人得看见真正生效的是 5000
        state.maxRows = clampRowLimit(rowLimit.value);
        rowLimit.value = state.maxRows;
        try { localStorage.setItem(ROW_LIMIT_KEY, String(state.maxRows)); } catch (ignore) {}
      });
    }
    var capsule = byId('aias-ds-capsule-btn');
    // 胶囊点按换的是**会话默认执行源**，不是「给某一块临时选源」。
    if (capsule) capsule.addEventListener('click', changeDefaultDatasource);

    var newChat = byId('aias-new-chat-btn');
    if (newChat) newChat.addEventListener('click', createSession);
    var clearButton = byId('aias-clear-btn');
    if (clearButton) clearButton.addEventListener('click', clearChat);
    var historyButton = byId('aias-history-btn');
    if (historyButton) historyButton.addEventListener('click', showTaskHistory);
    var retroButton = byId('aias-retro-btn');
    if (retroButton) retroButton.addEventListener('click', function () {
      if (typeof window.showPage === 'function') window.showPage('ai-tasks');
    });
    var toolsButton = byId('aias-tools-btn');
    if (toolsButton) toolsButton.addEventListener('click', function () {
      if (typeof window.showPage === 'function') window.showPage('tool-mgmt');
    });
    var versionButton = byId('aias-dsver-btn');
    if (versionButton) versionButton.addEventListener('click', showDatasourceVersions);

    var list = byId('aias-session-list');
    if (list) {
      list.addEventListener('click', function (event) {
        // 一律先定位到「哪一行」，再判断点的是行本身还是行上的控件
        var row = event.target.closest('.aias-session-item');
        if (!row) return;
        var sessionId = row.getAttribute('data-session-id');
        if (!sessionId) return;
        if (hasClass(row, 'editing')) {
          // 行内改名态：点行不切会话（input / actions 都要挡掉冒泡）
          if (event.target.closest('.aias-rename-save')) saveRename(sessionId);
          else if (event.target.closest('.aias-rename-cancel')) cancelRename(sessionId);
          return;
        }
        if (event.target.closest('.aias-session-del')) { deleteSession(sessionId); return; }
        if (event.target.closest('.aias-session-rename')) { startRename(sessionId); return; }
        // 生成中不切会话 —— 切了之后流式内容会往新会话的气泡里写，画面直接错乱
        if (state.generating) return;
        openSession(sessionId);
      });
      list.addEventListener('keydown', onRenameKeydown);
    }

    var collapse = byId('aias-collapse-btn');
    if (collapse) collapse.addEventListener('click', toggleSidebar);
    // 折叠后贴在右边缘的「会话列表」停靠页签：点击展开（CSS 只在折叠态把它显示出来）
    var dock = byId('aias-dock-tab');
    if (dock) dock.addEventListener('click', toggleSidebar);
    bindModalEscape();
  }

  /** 行数上限钳制在 1~5000，非法/空值一律回落 20。 */
  function clampRowLimit(value) {
    var n = parseInt(value, 10);
    if (isNaN(n) || n < ROW_LIMIT_MIN) return ROW_LIMIT_DEFAULT;
    if (n > ROW_LIMIT_MAX) return ROW_LIMIT_MAX;
    return n;
  }

  /** 每次进页面都把持久化的上限写回输入框。 */
  function syncRowLimitInput() {
    var rowLimit = byId('aias-global-max-rows');
    if (!rowLimit) return;
    state.maxRows = clampRowLimit(rowLimit.value || state.maxRows);
    rowLimit.value = state.maxRows;
  }

  function toggleSidebar() {
    var sidebar = byId('aias-sidebar');
    if (!sidebar) return;
    state.sidebarCollapsed = !state.sidebarCollapsed;
    if (state.sidebarCollapsed) {
      // 折叠：先加折叠类走宽度动画，动画结束再彻底移出布局、主区占满。
      // 直接 display:none 没有过渡（看着是「啪」地消失），所以要两段式
      sidebar.classList.add('aias-collapsed');
      setTimeout(function () {
        if (!state.sidebarCollapsed) return;
        sidebar.style.display = 'none';
        setMainFullWidth(true);
      }, SIDEBAR_ANIM_MS);
    } else {
      sidebar.style.display = '';
      setMainFullWidth(false);
      void sidebar.offsetWidth;   // 强制重排，宽度才会从 0 过渡回 260px
      sidebar.classList.remove('aias-collapsed');
    }
    try { localStorage.setItem(SIDEBAR_KEY, state.sidebarCollapsed ? '1' : '0'); } catch (ignore) {}
  }

  /** 侧栏移出布局后主区要占满（给 .aias-main 直接改 width）。 */
  function setMainFullWidth(full) {
    var main = document.querySelector('.aias-main');
    if (!main || !main.style) return;
    main.style.width = full ? '100%' : '';
  }

  function bindModalEscape() {
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      ['aias-ds-modal', 'aias-task-modal', 'aias-track-modal', 'aias-ver-modal'].forEach(function (id) {
        var modal = byId(id);
        if (modal && modal.style.display !== 'none') { modal.style.display = 'none'; }
      });
      // 结果最大化遮罩：必须走 closeResultMaximize()，不能直接把节点 remove 掉 ——
      // 表格节点是移进遮罩的，remove 会连表格一起删（结果就没了）。
      // 最大化自己挂了 keydown，这里再兜一次是防「同一按键两条监听」里哪条先跑都不丢结果。
      if (maxOverlay) closeResultMaximize();
    });
    // 点遮罩空白处关闭：弹窗类交互的通用退路（版本弹窗也是这个习惯），
    // 只认点在最外层遮罩上的事件，点内容区不算。
    ['aias-ds-modal', 'aias-task-modal', 'aias-track-modal', 'aias-ver-modal'].forEach(function (id) {
      var modal = byId(id);
      if (!modal || modal.dataset.overlayBound === '1') return;
      modal.dataset.overlayBound = '1';
      modal.addEventListener('click', function (event) {
        if (event.target === modal) modal.style.display = 'none';
      });
    });
  }

  // 「右侧聊天抽屉」（#ai-chat-sidebar + #ai-chat-fab）是本页的回退实现，
  // 保留代码与开关，但在全屏助手页里必须收起：否则同屏出现两个「🤖 AI 巡检助手」，
  // 用户根本分不清该在哪儿问。离开本页后抽屉照旧可用。
  var DRAWER_PAGES = ['page-ai-assistant', 'page-ai-tasks', 'page-tool-mgmt'];

  // 按「当前活动页」决定抽屉去留：助手家族三页（全屏助手 / 任务历史 / 工具管理）都收起抽屉，
  // 其它页面（首页、数据源、SQL 编辑器…）抽屉照旧可用。
  function setLegacyDrawerVisible() {
    if (!document.body) return;
    var active = (document.querySelector('.page.active') || {}).id || '';
    document.body.classList.toggle('aias-page-active', DRAWER_PAGES.indexOf(active) >= 0);
  }

  function enter() {
    try {
      // 先把持久化的上限灌进输入框，再由 syncRowLimitInput 统一钳制回写
      var stored = clampRowLimit(localStorage.getItem(ROW_LIMIT_KEY));
      state.maxRows = stored;
      var rowLimit = byId('aias-global-max-rows');
      if (rowLimit) rowLimit.value = stored;
      state.sidebarCollapsed = localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch (ignore) { /* 隐私模式下 localStorage 不可用也照常工作 */ }
    setLegacyDrawerVisible();
    // 右键「替换占位符」等 SQL 槽位交互由独立模块承担，这里只负责在进入页面时挂上
    if (window.FusionAiSqlSlots) window.FusionAiSqlSlots.init();
    bindStaticEvents();
    applySidebarState();
    setGeneratingUi(false);
    loadModelInfo();
    loadDatasources();
    loadSessions();
    focusInput(200);   // 进页面 200ms 后聚焦输入框，直接就能打字
  }

  /** 恢复上次的侧栏折叠状态：折叠时侧栏要真正移出布局（不是只把宽度压成 0）。 */
  function applySidebarState() {
    var sidebar = byId('aias-sidebar');
    if (!sidebar) return;
    if (state.sidebarCollapsed) {
      sidebar.classList.add('aias-collapsed');
      sidebar.style.display = 'none';
      setMainFullWidth(true);
    } else {
      sidebar.classList.remove('aias-collapsed');
      sidebar.style.display = '';
      setMainFullWidth(false);
    }
  }

  function leave() {
    setLegacyDrawerVisible();
    clearInterval(state.historyTimer);
    if (state.generating) stopGeneration();
  }

  window.FusionAiAssistant = {
    enter: enter,
    leave: leave,
    send: sendText,
    stop: stopGeneration,
    state: state,
    renderMessages: renderMessages,   // 供历史页/回归用例在改过 state 后手动重绘
    setBlockSql: setBlockSql,         // 供槽位模块：替换后的 SQL 要同时成为被执行的那句
    // SQL 族入口（按 sqlId 驱动，回归用例直接驱动这一层）
    executeSql: executeSql,
    runSql: runSql,
    fixSql: fixSql,
    executeSqlBatch: executeSqlBatch,
    batchStop: batchStop,
    batchToggleDetail: batchToggleDetail,
    scanMultiSql: scanMultiSql,
    scanDialectSql: scanDialectSql,
    scheduleDialectScan: scheduleDialectScan,
    rowLimitValue: rowLimitValue,
    maximizeResultTable: maximizeResultTable,
    closeResultMaximize: closeResultMaximize,
    buildOneResultHtml: buildOneResultHtml,
    buildMultiResultHtml: buildMultiResultHtml,
    buildSqlErrorHtml: buildSqlErrorHtml,
    renderDialectBadge: renderDialectBadge,
    loadDialectBadge: loadDialectBadge,
    normSqlFp: normSqlFp,
    sqlOverrideFind: sqlOverrideFind,
    sqlOverridePut: sqlOverridePut,
    persistFixedSql: persistFixedSql,
    splitSqlBlock: splitSqlBlock,
    fillSplitResults: fillSplitResults,
    showDialectWarning: showDialectWarning,
    dialectRewrite: dialectRewrite,
    plsqlBlockIsReadOnly: plsqlBlockIsReadOnly,
    resultHtml: resultHtml,           // 结果区渲染兼容入口（任务回溯页 + 回归断言都用它）
    // 渲染族入口：流式四个更新点 + 定格 + 思考块 + 轨迹卡 + 结果操作条
    updateMessage: updateMessage,
    updateMessageWithThinking: updateMessageWithThinking,
    updateMessageWithToolsAndThinking: updateMessageWithToolsAndThinking,
    finalizeMessage: finalizeMessage,
    renderThinking: renderThinking,
    buildThinkingHtml: buildThinkingHtml,
    buildToolChainHtml: buildToolChainHtml,
    buildConfirmationHtml: buildConfirmationHtml,
    enhanceResults: enhanceResults,
    resultText: resultText,
    askFollowup: askFollowup,
    smartRender: smartRender,
    flushRender: flushRender,
    // 数据源族接缝（回归用例直接驱动弹窗，不靠真点击链路）
    trackDatasource: trackDatasource,
    getSqlDatasource: getSqlDatasource,
    showDatasourceModal: showDatasourceModal,
    showDatasourceMultiModal: showDatasourceMultiModal,
    markdownToHtml: markdownToHtml
  };
})();
