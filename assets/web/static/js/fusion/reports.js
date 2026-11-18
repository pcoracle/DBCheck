/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * 数据库巡检历史（融合页）
 * Attribution: 布局与交互设计归 MIT License,
 * Copyright (c) 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com> 所有，
 * 按 RaccoonX 的模块结构与主题变量实现。
 *
 * 交互对齐源系统现役 reports 页：
 *   - 筛选全部下推后端：类型（规范名）/ 来源（manual/scheduled/ai_assistant）/
 *     关键词（实例名+主机）/ 日期范围 / 左树（目录含子目录 / 单数据源 / 无目录）
 *   - 后端按条件返回当前页切片，前端不再二次 filter；分页条固定于滚动区下方
 *   - 左树：数据源目录树，计数来自后端 instance_counts/no_dir_count，
 *     折叠状态记忆、搜索只保留命中目录及其祖先、计数未变不重绘避免闪动
 *   - 行内问题列表沿用本仓库 inline auto_analyze（showReportIssues(name, b64)），
 *     不引入源端按需 /api/report_ai 与 AI-DBA 按钮（超出本次范围）
 */
(function () {
  'use strict';

  // ── 筛选 / 分页状态 ──
  var currentReportFilter = '';   // 当前数据库类型过滤（规范名）
  var currentTriggerFilter = '';  // 当前触发来源过滤（manual/scheduled/ai_assistant）
  var currentKeyword = '';        // 当前搜索关键词
  var allReportFiles = [];        // 后端返回的当前页切片
  var reportCurrentPage = 1;      // 报告列表当前页
  var reportPageSize = 50;        // 报告列表每页条数
  var reportTotal = 0;            // 过滤后总条数
  var _reportKwTimer = null;      // 关键词输入防抖定时器
  var _rpReqSeq = 0;              // 请求序号：并发筛选时只认最新一次响应，避免列表与分页条错位

  // ── 左树状态 ──
  var rpDirs = [], rpDirsById = new Map(), rpDsList = [];
  var rpInstanceCounts = {}, rpNoDirCount = 0;
  var rpSelectedDirId = null, rpSelectedInstanceId = null, rpNoDirSel = false;
  var rpTreeSearch = '';
  var rpTreeLoaded = false;
  var _rpCountsSig = '';
  var rpTreeCollapsed = new Set();
  var rpTreePanelCollapsed = false;
  var rpTreeStateReady = false;
  var rpShowEmptyDirs = false;

  var RP_TREE_COLLAPSE_KEY = 'dbcheck.rpTreeCollapsed';
  var RP_TREE_PANEL_KEY = 'dbcheck.rpTreePanelCollapsed';
  var RP_TREE_EMPTY_KEY = 'dbcheck.rpShowEmptyDirs';
  var RP_TREE_NONE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="m10 11 4 4M14 11l-4 4"/></svg>';
  var WI_TREE_CARET = '<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  var WI_TREE_FOLDER = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>';

  // 数据源类型 → 图标/展示名（左树叶子用；含本仓库常见别名）
  var DB_TYPE_META = {
    oracle:    { icon: '🔴', label: 'Oracle' },
    mysql:     { icon: '🐬', label: 'MySQL' },
    mariadb:   { icon: '🐬', label: 'MariaDB' },
    pg:        { icon: '🐘', label: 'PostgreSQL' },
    postgresql:{ icon: '🐘', label: 'PostgreSQL' },
    dm:        { icon: '🟡', label: 'DM8' },
    dm8:       { icon: '🟡', label: 'DM8' },
    sqlserver: { icon: '🟠', label: 'SQLServer' },
    mssql:     { icon: '🟠', label: 'SQLServer' },
    tidb:      { icon: '🟢', label: 'TiDB' },
    ivorysql:  { icon: '🐘', label: 'IvorySQL' },
    yashandb:  { icon: '🏔️', label: 'YashanDB' },
    kingbase:  { icon: '🐘', label: 'KingbaseES' },
    gbase:     { icon: '🟢', label: 'GBase 8s' },
    oceanbase: { icon: '🌊', label: 'OceanBase' }
  };

  function $(id) { return document.getElementById(id); }

  function escHtml(s) {
    if (typeof window.escHtml === 'function') return window.escHtml(String(s == null ? '' : s));
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function _wiEsc(v) { return escHtml(v); }
  function _wiEscAttr(v) {
    return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  }
  function tr(key, fallback) {
    if (typeof window.i18n === 'function') {
      var v = window.i18n(key);
      if (v && v !== key) return v;
    }
    return fallback;
  }
  function rpToast(msg, type) {
    try {
      if (type === 'error' && typeof window.toastError === 'function') { window.toastError(msg); return; }
      if (type === 'success' && typeof window.toastSuccess === 'function') { window.toastSuccess(msg); return; }
      if (typeof window.toast === 'function') { window.toast(msg, type || 'info'); return; }
    } catch (e) {}
    console.log('[reports] ' + msg);
  }
  function rpConfirm(msg) {
    if (typeof window.toastConfirm === 'function') return window.toastConfirm(msg);
    return Promise.resolve(window.confirm(msg));
  }
  // 行内 onclick 用的单引号转义（文件名嵌入 JS 字符串字面量）
  function jsq(s) { return escHtml(s).replace(/'/g, "\\'"); }

  // 日期占位符同步 / 兜底打开原生选择器（与服务器巡检历史页同名同实现，
  // 这里仅在全局尚未提供时补挂，保证本页独立可用）
  function syncDatePlaceholder(el) {
    var wrap = el && el.closest ? el.closest('.sh-date-wrap') : null;
    if (wrap) wrap.classList.toggle('has-value', !!el.value);
  }
  function openDatePicker(el) {
    if (el && typeof el.showPicker === 'function') {
      try { el.showPicker(); } catch (e) { /* 已打开或浏览器不支持则忽略 */ }
    }
  }

  // ── 数据加载（筛选全部下推后端）──
  async function loadReports() {
    var list = $('reports-list');
    if (!list) return;
    var seq = ++_rpReqSeq;
    list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:32px">' + tr('webui.reports_loading', '正在加载...') + '</div>';
    try {
      var params = new URLSearchParams();
      params.set('page', String(reportCurrentPage));
      params.set('page_size', String(reportPageSize));
      if (currentReportFilter) params.set('db_type', currentReportFilter);
      if (currentTriggerFilter) params.set('trigger_type', currentTriggerFilter);
      if (currentKeyword) params.set('keyword', currentKeyword);
      var df = $('report-date-from') ? $('report-date-from').value : '';
      var dt = $('report-date-to') ? $('report-date-to').value : '';
      if (df) params.set('date_from', df);
      if (dt) params.set('date_to', dt);
      // 左树筛选（三选一）
      if (rpSelectedInstanceId) params.set('instance_id', rpSelectedInstanceId);
      else if (rpSelectedDirId) params.set('dir_id', rpSelectedDirId);
      else if (rpNoDirSel) params.set('no_dir', '1');
      var res = await fetch('/api/reports?' + params.toString());
      var data = await res.json();
      // 已有更新的请求发出 → 丢弃这次过期响应，避免旧切片覆盖新筛选结果
      if (seq !== _rpReqSeq) return;
      allReportFiles = data.files || [];
      reportTotal = data.total || 0;
      rpInstanceCounts = data.instance_counts || {};
      rpNoDirCount = data.no_dir_count || 0;
      renderReports();
      // 计数没变就不重建树，避免点击节点后「选中重绘 + 数据回来再重绘」的二次闪动
      var sig = JSON.stringify([rpInstanceCounts, rpNoDirCount]);
      if (rpTreeLoaded && sig !== _rpCountsSig) { _rpCountsSig = sig; renderReportTree(); }
      _rpUpdateCrumb();
    } catch (e) {
      if (seq !== _rpReqSeq) return;
      list.innerHTML = '<div class="status-banner err">' + tr('webui.reports_load_fail', '加载失败') + ': ' + escHtml(e.message) + '</div>';
    }
  }

  function renderReports() {
    var list = $('reports-list');
    if (!list) return;
    // 后端已按筛选条件返回当前页切片，前端不再二次 filter
    var files = allReportFiles;
    if (files.length === 0) {
      list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:48px">' + tr('webui.reports_empty', '暂无报告') + '</div>';
      updateBatchBar();
      renderReportsPager();
      return;
    }
    list.innerHTML = files.map(function (f) {
      var isMySQL = f.name.includes('MySQL');
      var isPG    = f.name.includes('PostgreSQL') || f.name.includes('Postgres');
      var isOracle = f.name.includes('Oracle');
      var isDM    = f.name.includes('DM8') || f.name.includes('达梦');
      var isSQLServer = f.name.includes('SQLServer');
      var isTiDB = f.name.includes('TiDB');
      var tagHtml = isMySQL ? '<span class="tag tag-mysql">' + tr('webui.db_type_mysql', 'MySQL') + '</span>'
        : isPG ? '<span class="tag tag-pg">' + tr('webui.db_type_pg', 'PostgreSQL') + '</span>'
        : isOracle ? '<span class="tag tag-oracle">' + tr('webui.db_type_oracle', 'Oracle') + '</span>'
        : isDM ? '<span class="tag tag-dm">' + tr('webui.db_type_dm', 'DM8') + '</span>'
        : isSQLServer ? '<span class="tag tag-sqlserver">' + tr('webui.db_type_sqlserver', 'SQLServer') + '</span>'
        : isTiDB ? '<span class="tag tag-tidb">' + tr('webui.db_type_tidb', 'TiDB') + '</span>' : '';
      // 触发类型标签（人工 / 定时 / AI 助手）
      var triggerType = f.trigger_type || f.trigger || 'manual';
      var triggerBadge = triggerType === 'scheduled'
        ? '<span style="margin-left:6px;font-size:11px;padding:2px 7px;border-radius:4px;background:rgba(59,130,246,0.15);color:#3b82f6;font-weight:600">⏰ 定时</span>'
        : triggerType === 'ai_assistant'
        ? '<span style="margin-left:6px;font-size:11px;padding:2px 7px;border-radius:4px;background:rgba(139,92,246,0.15);color:#8b5cf6;font-weight:600">🤖 AI助手</span>'
        : '<span style="margin-left:6px;font-size:11px;padding:2px 7px;border-radius:4px;background:rgba(34,197,94,0.15);color:#22c55e;font-weight:600">👤 人工</span>';
      var size = f.size > 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(1) + ' MB' : (f.size / 1024).toFixed(1) + ' KB';
      var dt = new Date(f.mtime * 1000).toLocaleString('zh-CN');
      var high = f.high || 0, mid = f.mid || 0, low = f.low || 0;
      var total = high + mid + low;
      var riskBadges = total > 0
        ? '<span class="severity-tag severity-high" style="margin-left:8px;font-size:11px;padding:2px 7px">🔴 ' + tr('webui.risk_high', '高') + ' ' + high + '</span><span class="severity-tag severity-mid" style="margin-left:4px;font-size:11px;padding:2px 7px">🟡 ' + tr('webui.risk_mid', '中') + ' ' + mid + '</span><span class="severity-tag severity-low" style="margin-left:4px;font-size:11px;padding:2px 7px">🟢 ' + tr('webui.risk_low', '低') + ' ' + low + '</span>'
        : '<span style="margin-left:8px;font-size:12px;color:var(--text-muted)">' + tr('webui.risk_no_issues', '无风险') + '</span>';
      // 数据源已删除 → 报告归入「无目录」，行上给出醒目标识
      var delTag = f.instance_deleted ? '<span class="rp-deleted-tag">🗑️ 数据源已删除</span>' : '';
      // 问题列表沿用本仓库 inline auto_analyze：把 JSON 编成 base64 随行携带，
      // 点击时 showReportIssues(name, b64) 解码渲染，无需再请求后端
      var autoAnalyzeB64 = btoa(unescape(encodeURIComponent(f.auto_analyze || '[]')));
      var issueBtn = total > 0
        ? '<button class="btn btn-ghost" style="font-size:12px;padding:6px 12px;margin-left:4px" onclick="showReportIssues(\'' + jsq(f.name) + '\', \'' + autoAnalyzeB64 + '\')">' + tr('webui.btn_report_issues', '问题列表') + '</button>'
        : '';
      var metaLine = (f.dir_path ? '📁 ' + escHtml(f.dir_path) + ' · ' : '') + dt + ' · ' + size + (f.node_count > 1 ? (' · ' + f.node_count + ' 节点') : '');
      return '' +
        '<div class="report-item">' +
          '<input type="checkbox" class="ri-checkbox" data-name="' + escHtml(f.name) + '" onchange="updateBatchBar()">' +
          '<div class="ri-icon">📄</div>' +
          '<div class="ri-info">' +
            '<div class="ri-name">' + escHtml(f.name) + ' ' + tagHtml + ' ' + triggerBadge + ' ' + riskBadges + ' ' + delTag + '</div>' +
            '<div class="ri-meta">' + metaLine + '</div>' +
          '</div>' +
          '<div class="ri-actions">' +
            issueBtn +
            '<a class="btn btn-ghost" style="font-size:12px;padding:7px 14px" href="/api/download_file?name=' + encodeURIComponent(f.name) + '" download>' + tr('webui.btn_download_report', '📥 下载') + '</a>' +
            '<button class="btn btn-ghost" style="font-size:12px;padding:7px 12px" onclick="downloadReportHtml(\'' + jsq(f.name) + '\')">📊 分析报告</button>' +
            '<button class="btn btn-ghost" style="font-size:12px;padding:7px 12px" onclick="shareReportFile(\'' + jsq(f.name) + '\')">📤 分享</button>' +
            '<button class="btn btn-danger" style="font-size:12px;padding:7px 12px" onclick="deleteReport(\'' + jsq(f.name) + '\')">' + tr('webui.btn_delete_report', '删除') + '</button>' +
          '</div>' +
        '</div>';
    }).join('');
    updateBatchBar();
    renderReportsPager();
  }

  // ── 报告列表分页条 ──
  function renderReportsPager() {
    var pager = $('reports-pager');
    if (!pager) return;
    var total = reportTotal;
    var pageSize = reportPageSize;
    var pages = Math.max(1, Math.ceil(total / pageSize));
    // 单页时也保留底栏（共 N 条 + 每页条数），只是不显示页码按钮，避免分页条忽隐忽现
    var showNav = pages > 1;
    var cur = reportCurrentPage;
    if (cur > pages) { cur = reportCurrentPage = pages; }
    if (cur < 1) { cur = reportCurrentPage = 1; }
    // 生成页码序列（含省略号）
    var nums = [];
    if (pages <= 7) {
      for (var i = 1; i <= pages; i++) nums.push(i);
    } else {
      nums.push(1);
      if (cur > 4) nums.push('...');
      var s = Math.max(2, cur - 1), e = Math.min(pages - 1, cur + 1);
      for (var j = s; j <= e; j++) nums.push(j);
      if (cur < pages - 3) nums.push('...');
      nums.push(pages);
    }
    function mkBtn(label, target, opts) {
      opts = opts || {};
      var base = 'font-size:12px;padding:5px 10px;border:1px solid var(--border);border-radius:6px;min-width:34px;cursor:pointer;';
      var style = base + 'background:' + (opts.active ? 'var(--accent,#388bfd)' : 'var(--surface)') +
        ';color:' + (opts.active ? '#fff' : 'var(--text)') + ';' +
        (opts.disabled ? 'opacity:.4;cursor:not-allowed;' : '');
      var dis = opts.disabled ? 'disabled' : '';
      var onclick = (opts.disabled || opts.active) ? '' : 'onclick="gotoReportPage(' + target + ')"';
      return '<button ' + dis + ' ' + onclick + ' style="' + style + '">' + label + '</button>';
    }
    var navBtns = [
      mkBtn('‹ 上一页', cur - 1, { disabled: cur <= 1 }),
      nums.map(function (n) {
        return n === '...'
          ? '<span style="padding:0 6px;color:var(--text-muted)">…</span>'
          : mkBtn(String(n), n, { active: n === cur });
      }).join(''),
      mkBtn('下一页 ›', cur + 1, { disabled: cur >= pages })
    ].join('');
    var sizeOpts = [20, 50, 100, 200].map(function (sz) {
      return '<option value="' + sz + '"' + (sz === pageSize ? ' selected' : '') + '>' + sz + ' 条/页</option>';
    }).join('');
    pager.innerHTML =
      '<div style="font-size:12px;color:var(--text-muted)">共 ' + total + ' 条' + (showNav ? ' · 第 ' + cur + '/' + pages + ' 页' : '') + '</div>' +
      (showNav ? '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' + navBtns + '</div>' : '<div></div>') +
      '<div style="display:flex;align-items:center;gap:6px">' +
        '<span style="font-size:12px;color:var(--text-muted)">每页</span>' +
        '<select onchange="changeReportPageSize(this.value)" style="padding:4px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">' + sizeOpts + '</select>' +
      '</div>';
    pager.style.display = 'flex';
  }

  function gotoReportPage(p) {
    var pages = Math.max(1, Math.ceil(reportTotal / reportPageSize));
    p = Math.min(Math.max(1, p), pages);
    if (p === reportCurrentPage) return;
    reportCurrentPage = p;
    loadReports();
  }

  function changeReportPageSize(v) {
    reportPageSize = parseInt(v, 10) || 50;
    reportCurrentPage = 1;
    loadReports();
  }

  // ── 类型筛选（规范名，与后端 _name_matches_db_type 对齐）──
  function filterReports(type) {
    currentReportFilter = type;
    document.querySelectorAll('#report-filter-bar .filter-btn').forEach(function (btn) {
      btn.classList.toggle('filter-active', btn.dataset.type === type);
    });
    var sa = $('select-all-cb'); if (sa) sa.checked = false;
    reportCurrentPage = 1;
    loadReports();
  }

  // ── 触发来源筛选（人工/定时/AI 助手）：助手页「查看巡检历史」带 ai_assistant 跳过来 ──
  function filterReportTrigger(trigger) {
    currentTriggerFilter = trigger;
    document.querySelectorAll('#report-trigger-bar [data-trigger]').forEach(function (btn) {
      btn.classList.toggle('filter-active', btn.dataset.trigger === trigger);
    });
    reportCurrentPage = 1;
    loadReports();
  }

  // ── 关键词搜索（带防抖，筛选下推到后端）──
  function filterReportByKeyword() {
    var input = $('report-search-input');
    currentKeyword = input ? input.value.trim() : '';
    reportCurrentPage = 1;
    if (_reportKwTimer) clearTimeout(_reportKwTimer);
    _reportKwTimer = setTimeout(function () { loadReports(); }, 300);
  }

  // ── 日期范围筛选 ──
  function filterReportByDate() {
    reportCurrentPage = 1;
    loadReports();
  }

  // ── 清除所有筛选 ──
  function clearReportFilters() {
    currentReportFilter = '';
    currentTriggerFilter = '';
    currentKeyword = '';
    var searchInput = $('report-search-input'); if (searchInput) searchInput.value = '';
    var dateFrom = $('report-date-from'); if (dateFrom) dateFrom.value = '';
    var dateTo = $('report-date-to'); if (dateTo) dateTo.value = '';
    document.querySelectorAll('#page-reports .sh-date-wrap').forEach(function (w) { w.classList.remove('has-value'); });
    document.querySelectorAll('#report-filter-bar .filter-btn').forEach(function (btn) {
      btn.classList.toggle('filter-active', btn.dataset.type === '');
    });
    document.querySelectorAll('#report-trigger-bar [data-trigger]').forEach(function (btn) {
      btn.classList.toggle('filter-active', btn.dataset.trigger === '');
    });
    // 同步清除左树选中
    rpSelectedDirId = null; rpSelectedInstanceId = null; rpNoDirSel = false;
    if (rpTreeLoaded) renderReportTree();
    reportCurrentPage = 1;
    loadReports();
  }

  // ── 批量操作栏 ──
  function updateBatchBar() {
    var cbs = document.querySelectorAll('#reports-list .ri-checkbox');
    var checked = document.querySelectorAll('#reports-list .ri-checkbox:checked');
    var bar = $('batch-bar');
    var countEl = $('selected-count');
    if (countEl) countEl.textContent = '已选 ' + checked.length + ' 项';
    if (bar) bar.style.display = checked.length > 0 ? 'flex' : 'none';
    var selectAll = $('select-all-cb');
    if (selectAll) selectAll.checked = cbs.length > 0 && checked.length === cbs.length;
  }

  function toggleSelectAll(checked) {
    document.querySelectorAll('#reports-list .ri-checkbox').forEach(function (cb) { cb.checked = checked; });
    updateBatchBar();
  }

  async function batchDeleteReports() {
    var names = Array.from(document.querySelectorAll('#reports-list .ri-checkbox:checked')).map(function (cb) { return cb.dataset.name; });
    if (names.length === 0) return;
    var msg = '确定删除选中的 ' + names.length + ' 份报告？此操作不可恢复。';
    if (!await rpConfirm(msg)) return;
    var okCount = 0, failNames = [];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      try {
        var res = await fetch('/api/delete_report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name })
        });
        var data = await res.json();
        if (data.ok) okCount++; else failNames.push(name);
      } catch (e) { failNames.push(name); }
    }
    if (failNames.length === 0) rpToast('已删除 ' + okCount + ' 份报告', 'success');
    else rpToast('部分删除失败（' + failNames.length + ' 份）', 'error');
    var sa = $('select-all-cb'); if (sa) sa.checked = false;
    loadReports();
  }

  // ══════════════════════════════════════════════════════════════
  //  左侧数据源目录树（对齐「数据库巡检」左树右表设计）
  //  · 目录节点 → 过滤该目录（含子目录）下所有数据源的报告
  //  · 数据源叶子 → 过滤单个数据源的报告
  //  · 无目录 → 已删除数据源 / 未能匹配到数据源的全部报告
  // ══════════════════════════════════════════════════════════════
  function _rpDsCount(id) { return rpInstanceCounts[String(id)] || 0; }

  function _rpDirSubtreeIds(dirId) {
    var ids = new Set();
    if (!dirId) return ids;
    var children = new Map();
    rpDirs.forEach(function (d) {
      var p = d.parent_id || '';
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(d);
    });
    (function walk(id) {
      ids.add(id);
      (children.get(id) || []).forEach(function (d) { walk(d.id); });
    })(dirId);
    return ids;
  }

  function _rpDirCount(dirId) {
    var ids = _rpDirSubtreeIds(dirId);
    var n = 0;
    rpDsList.forEach(function (ds) {
      if (ds.dir_id && ids.has(ds.dir_id)) n += _rpDsCount(ds.id);
    });
    return n;
  }

  function _rpTreeInitState() {
    if (rpTreeStateReady) return;
    rpTreeStateReady = true;
    try {
      var s = JSON.parse(localStorage.getItem(RP_TREE_COLLAPSE_KEY) || 'null');
      if (Array.isArray(s)) rpTreeCollapsed = new Set(s);
    } catch (e) {}
    try {
      var storedPanel = localStorage.getItem(RP_TREE_PANEL_KEY);
      // 有显式偏好则遵从；否则窄屏（<900px）首次默认收起目录，给报告列表留出可视宽度，
      // 避免固定侧栏 + 左树挤占后动作按钮被裁切。用户可随时点 ⟨/⟩ 切换并记忆。
      rpTreePanelCollapsed = storedPanel === '1' ? true : storedPanel === '0' ? false : window.innerWidth < 900;
    } catch (e) { rpTreePanelCollapsed = window.innerWidth < 900; }
    try { rpShowEmptyDirs = localStorage.getItem(RP_TREE_EMPTY_KEY) === '1'; } catch (e) {}
    _rpApplyTreePanelState();
  }

  function _rpApplyTreePanelState() {
    var split = $('rp-split');
    var btn = $('rp-tree-toggle');
    if (split) split.classList.toggle('tree-collapsed', rpTreePanelCollapsed);
    if (btn) {
      btn.textContent = rpTreePanelCollapsed ? '⟩' : '⟨';
      btn.title = rpTreePanelCollapsed ? '展开目录' : '收起目录';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  function toggleReportTreePanel() {
    _rpTreeInitState();
    rpTreePanelCollapsed = !rpTreePanelCollapsed;
    try { localStorage.setItem(RP_TREE_PANEL_KEY, rpTreePanelCollapsed ? '1' : '0'); } catch (e) {}
    _rpApplyTreePanelState();
  }

  function onReportTreeSearch(v) { rpTreeSearch = v || ''; renderReportTree(); }

  function toggleRpShowEmpty(checked) {
    rpShowEmptyDirs = !!checked;
    try { localStorage.setItem(RP_TREE_EMPTY_KEY, rpShowEmptyDirs ? '1' : '0'); } catch (e) {}
    renderReportTree();
  }

  async function loadReportTreeData() {
    var el = $('rp-tree');
    if (!el) return;
    _rpTreeInitState();
    if (!el.dataset.skeleton) {
      el.dataset.skeleton = '1';
      el.innerHTML =
        '<div class="wi-tree-head">数据源目录</div>' +
        '<div class="rp-tree-search"><input id="rp-tree-search-input" placeholder="过滤目录 / 数据源" autocomplete="off"></div>' +
        '<div id="rp-tree-body"></div>' +
        '<label class="rp-tree-foot"><input type="checkbox" id="rp-show-empty" onchange="toggleRpShowEmpty(this.checked)"> 显示空目录</label>';
      var inp = $('rp-tree-search-input');
      if (inp) inp.addEventListener('input', function () { onReportTreeSearch(this.value); });
    }
    try {
      var results = await Promise.all([
        fetch('/api/pro/dirs').then(function (r) { return r.json(); }).catch(function () { return { ok: false, dirs: [] }; }),
        fetch('/api/pro/datasources').then(function (r) { return r.json(); }).catch(function () { return { ok: false, datasources: [] }; })
      ]);
      var dirRes = results[0], dsRes = results[1];
      rpDirs = (dirRes && dirRes.ok && Array.isArray(dirRes.dirs)) ? dirRes.dirs : [];
      rpDirsById = new Map(rpDirs.map(function (d) { return [d.id, d]; }));
      rpDsList = (dsRes && dsRes.ok && Array.isArray(dsRes.datasources)) ? dsRes.datasources : [];
      // 选中项已失效时自动降级
      if (rpSelectedDirId && !rpDirsById.has(rpSelectedDirId)) rpSelectedDirId = null;
      if (rpSelectedInstanceId && !rpDsList.some(function (d) { return String(d.id) === String(rpSelectedInstanceId); })) {
        rpSelectedInstanceId = null;
        rpNoDirSel = true;  // 选中的数据源被删除 → 切到「无目录」
      }
      rpTreeLoaded = true;
    } catch (e) {
      rpTreeLoaded = false;
    }
    renderReportTree();
  }

  function renderReportTree() {
    var body = $('rp-tree-body');
    if (!body) return;
    // 重绘前后保持左树滚动位置，避免点击节点后树跳回顶部造成“抖动”观感
    var aside = $('rp-tree');
    var keepScrollTop = aside ? aside.scrollTop : 0;
    _rpCountsSig = JSON.stringify([rpInstanceCounts, rpNoDirCount]);
    var emptyCb = $('rp-show-empty');
    if (emptyCb) emptyCb.checked = rpShowEmptyDirs;
    var q = (rpTreeSearch || '').trim().toLowerCase();
    var totalAll = Object.keys(rpInstanceCounts).reduce(function (a, k) { return a + rpInstanceCounts[k]; }, 0) + rpNoDirCount;

    var children = new Map();
    rpDirs.forEach(function (d) {
      var p = d.parent_id || '';
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(d);
    });
    children.forEach(function (arr) {
      arr.sort(function (a, b) {
        return (a.sort_order || 0) - (b.sort_order || 0) || String(a.name).localeCompare(String(b.name));
      });
    });

    var dsByDir = new Map();
    rpDsList.forEach(function (ds) {
      var p = ds.dir_id || '';
      if (!dsByDir.has(p)) dsByDir.set(p, []);
      dsByDir.get(p).push(ds);
    });
    dsByDir.forEach(function (arr) {
      arr.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    });

    // 搜索时只保留命中目录/数据源及其祖先目录
    var visible = null;
    if (q) {
      visible = new Set();
      rpDirs.forEach(function (d) {
        if (String(d.name || '').toLowerCase().indexOf(q) >= 0) {
          var id = d.id;
          while (id) { visible.add(id); id = (rpDirsById.get(id) || {}).parent_id || ''; }
        }
      });
      rpDsList.forEach(function (ds) {
        if ([ds.name, ds.host].join(' ').toLowerCase().indexOf(q) < 0) return;
        var id = ds.dir_id || '';
        while (id) { visible.add(id); id = (rpDirsById.get(id) || {}).parent_id || ''; }
      });
    }

    function hi(text) {
      var raw = String(text == null ? '' : text);
      if (!q) return _wiEsc(raw);
      var idx = raw.toLowerCase().indexOf(q);
      if (idx < 0) return _wiEsc(raw);
      return _wiEsc(raw.slice(0, idx)) +
        '<span class="wi-tree-search-hit">' + _wiEsc(raw.slice(idx, idx + q.length)) + '</span>' +
        _wiEsc(raw.slice(idx + q.length));
    }

    var html = '<div class="wi-tree-node' + (!rpSelectedDirId && !rpSelectedInstanceId && !rpNoDirSel ? ' active' : '') +
      '" data-node="all" role="treeitem" style="padding-left:8px">' +
      '<span class="wi-tree-caret empty">' + WI_TREE_CARET + '</span>' +
      '<span class="wi-tree-icon">' + WI_TREE_FOLDER + '</span>' +
      '<span class="wi-tree-name">全部数据源</span>' +
      '<span class="wi-tree-count">' + totalAll + '</span></div>';

    var expandAll = !!q;

    function walkDs(dirId, level, dirHit) {
      (dsByDir.get(dirId) || []).forEach(function (ds) {
        if (q && !dirHit && [ds.name, ds.host].join(' ').toLowerCase().indexOf(q) < 0) return;
        var n = _rpDsCount(ds.id);
        var meta = DB_TYPE_META[String(ds.db_type || '').toLowerCase()] || null;
        var icon = meta ? meta.icon : '🗄️';
        html += '<div class="wi-tree-node rp-tree-node-ds' + (String(rpSelectedInstanceId) === String(ds.id) ? ' active' : '') + (n ? ' has-items' : ' rp-tree-zero') +
          '" data-node="ds" data-ds-id="' + _wiEscAttr(ds.id) + '" role="treeitem" style="padding-left:' + (8 + level * 14 + 8) + 'px">' +
          '<span class="wi-tree-caret empty">' + WI_TREE_CARET + '</span>' +
          '<span class="wi-tree-icon" title="' + _wiEscAttr((meta ? meta.label : (ds.db_type || '')) + ' · ' + (ds.host || '')) + '">' + icon + '</span>' +
          '<span class="wi-tree-name" title="' + _wiEscAttr(ds.name + ' · ' + (ds.host || '')) + '">' + hi(ds.name) + '</span>' +
          '<span class="wi-tree-count">' + (n || '') + '</span></div>';
      });
    }

    function walk(parent, level, ancestorHit) {
      (children.get(parent) || []).forEach(function (d) {
        if (visible && !visible.has(d.id)) return;
        var kids = children.get(d.id) || [];
        var dsList = dsByDir.get(d.id) || [];
        var count = _rpDirCount(d.id);
        // 默认隐藏没有报告的目录（搜索命中时不排除）
        if (!q && !rpShowEmptyDirs && count === 0 && !dsList.some(function (ds) { return _rpDsCount(ds.id) > 0; })) return;
        var nameHit = q ? String(d.name || '').toLowerCase().indexOf(q) >= 0 : false;
        var hit = nameHit || ancestorHit;
        var open = expandAll ? true : !rpTreeCollapsed.has(d.id);
        html += '<div class="wi-tree-node' + (rpSelectedDirId === d.id ? ' active' : '') + (count ? ' has-items' : ' rp-tree-zero') +
          '" data-node="dir" data-dir-id="' + _wiEscAttr(d.id) + '" data-level="' + level + '" role="treeitem" style="padding-left:' + (8 + level * 14) + 'px">' +
          '<span class="wi-tree-caret' + (open ? ' open' : '') + ((kids.length || dsList.length) ? '' : ' empty') + '" data-caret="1">' + WI_TREE_CARET + '</span>' +
          '<span class="wi-tree-icon" style="color:' + _wiEscAttr(d.color || 'inherit') + '">' + WI_TREE_FOLDER + '</span>' +
          '<span class="wi-tree-name" title="' + _wiEscAttr(d.full_path || d.name) + '">' + hi(d.name) + '</span>' +
          '<span class="wi-tree-count">' + (count || '') + '</span></div>';
        if (!open) return;
        walk(d.id, level + 1, hit);
        walkDs(d.id, level + 1, hit);
      });
    }
    walk('', 0, false);

    html += '<div class="wi-tree-node' + (rpNoDirSel ? ' active' : '') + (rpNoDirCount ? ' has-items' : '') +
      '" data-node="none" role="treeitem" style="padding-left:8px;margin-top:4px">' +
      '<span class="wi-tree-caret empty">' + WI_TREE_CARET + '</span>' +
      '<span class="wi-tree-icon">' + RP_TREE_NONE_ICON + '</span>' +
      '<span class="wi-tree-name" title="已删除数据源或未能匹配到数据源的报告">无目录</span>' +
      '<span class="wi-tree-count">' + rpNoDirCount + '</span></div>';

    if (!rpDirs.length) {
      html += '<div class="wi-tree-empty">还没有目录。<br>可在「数据源管理」中新建目录并归入数据源。</div>';
    }
    body.innerHTML = html;

    body.querySelectorAll('.wi-tree-node').forEach(function (node) {
      node.addEventListener('click', function (ev) {
        var dirId = node.dataset.dirId || '';
        var caret = ev.target.closest('[data-caret]');
        if (caret && node.dataset.node === 'dir' && dirId) {
          ev.stopPropagation();
          if (rpTreeCollapsed.has(dirId)) rpTreeCollapsed.delete(dirId);
          else rpTreeCollapsed.add(dirId);
          try { localStorage.setItem(RP_TREE_COLLAPSE_KEY, JSON.stringify(Array.from(rpTreeCollapsed))); } catch (e) {}
          renderReportTree();
          return;
        }
        if (node.dataset.node === 'dir') rpSelectTreeNode('dir', dirId);
        else if (node.dataset.node === 'ds') rpSelectTreeNode('ds', node.dataset.dsId);
        else if (node.dataset.node === 'none') rpSelectTreeNode('none', null);
        else rpSelectTreeNode('all', null);
      });
    });

    if (aside) aside.scrollTop = keepScrollTop;
    _rpUpdateCrumb();
  }

  function rpSelectTreeNode(kind, id) {
    if (kind === 'dir') { if (rpSelectedDirId === id) return; }
    else if (kind === 'ds') { if (String(rpSelectedInstanceId) === String(id)) return; }
    else if (kind === 'none') { if (rpNoDirSel) return; }
    else { if (!rpSelectedDirId && !rpSelectedInstanceId && !rpNoDirSel) return; }
    rpSelectedDirId = kind === 'dir' ? id : null;
    rpSelectedInstanceId = kind === 'ds' ? id : null;
    rpNoDirSel = kind === 'none';
    reportCurrentPage = 1;
    renderReportTree();
    loadReports();
  }

  function _rpUpdateCrumb() {
    var el = $('rp-crumb-path');
    var cnt = $('rp-crumb-count');
    if (cnt) cnt.textContent = '共 ' + reportTotal + ' 条';
    if (!el) return;
    var text = '全部数据源';
    if (rpSelectedInstanceId) {
      var ds = rpDsList.find(function (d) { return String(d.id) === String(rpSelectedInstanceId); });
      text = ds ? (ds.name + (ds.host ? ' · ' + ds.host : '')) : '数据源';
    } else if (rpSelectedDirId) {
      var dir = rpDirsById.get(rpSelectedDirId);
      text = dir ? (dir.full_path || dir.name || '全部数据源') : '全部数据源';
    } else if (rpNoDirSel) {
      text = '无目录（已删除数据源 / 未匹配的巡检报告）';
    }
    el.innerHTML = '<b>' + _wiEsc(text) + '</b>';
  }

  // ── 页面激活入口：拉左树 + 拉列表（showPage('reports') 调用）──
  function loadReportsPage() {
    loadReportTreeData();
    loadReports();
  }

  // ── 暴露全局（DOM onclick / 跨页跳转用）──
  window.loadReports = loadReports;
  window.loadReportsPage = loadReportsPage;
  window.renderReports = renderReports;
  window.filterReports = filterReports;
  window.filterReportTrigger = filterReportTrigger;
  window.filterReportByKeyword = filterReportByKeyword;
  window.filterReportByDate = filterReportByDate;
  window.clearReportFilters = clearReportFilters;
  window.gotoReportPage = gotoReportPage;
  window.changeReportPageSize = changeReportPageSize;
  window.updateBatchBar = updateBatchBar;
  window.toggleSelectAll = toggleSelectAll;
  window.batchDeleteReports = batchDeleteReports;
  window.toggleReportTreePanel = toggleReportTreePanel;
  window.onReportTreeSearch = onReportTreeSearch;
  window.toggleRpShowEmpty = toggleRpShowEmpty;
  window.loadReportTreeData = loadReportTreeData;
  if (typeof window.syncDatePlaceholder !== 'function') window.syncDatePlaceholder = syncDatePlaceholder;
  if (typeof window.openDatePicker !== 'function') window.openDatePicker = openDatePicker;
})();