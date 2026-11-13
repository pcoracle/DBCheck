/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 */

/*
 * 数据库巡检总览（融合页）
 * 交互习惯对齐源系统 page-wizard：
 *   - 工具栏：新增巡检 → 类型筛选（按现有数据动态生成，带 logo 与计数）→ 搜索 → 活跃/已删除 → 刷新
 *   - 统计口径：健康 ≥80 分，告警 60-79 分，平均评分只统计已巡检实例
 *   - 左树：目录全路径面包屑、折叠状态记忆、搜索只保留命中目录及其祖先
 *   - 公共操作栏：常驻列名上方，按页签切换动作组，未选中时按钮置灰
 *   - 勾选 1 个点「巡检」→ 打开向导并预填该数据源、停在「第 5 步确认」；
 *     勾选多个 → 批量提交巡检任务
 *   - 列宽拖拽（名称列默认 420px、最小 240px），双击手柄恢复默认并落 localStorage
 */
(function () {
  'use strict';

  var TREE_COLLAPSED_KEY = 'dbcheck.wizard.treeCollapsed';
  var COL_WIDTHS_KEY = 'dbcheck.wizard.colWidths.v2';
  // 勾选 / 名称 / 类型 / 主机地址 / 数据库 / 健康评分 / 风险 / 最近巡检
  var COL_DEFAULT_WIDTHS = [44, 420, 130, 160, 120, 100, 160, 120];

  var DB_TYPE_META = {
    mysql:          { label: 'MySQL',       icon: '🐬', color: '#0E7C86', img: '/mysql.png' },
    mariadb:        { label: 'MariaDB',     icon: '🐬', color: '#0E7C86', img: '/mariadb.png' },
    postgresql:     { label: 'PostgreSQL',  icon: '🐘', color: '#336791', img: '/postgresql.png' },
    pg:             { label: 'PostgreSQL',  icon: '🐘', color: '#336791', img: '/postgresql.png' },
    sqlserver:      { label: 'SQL Server',  icon: '🗄️', color: '#A91D22', img: '/sqlserver.png' },
    oracle:         { label: 'Oracle',      icon: '🔴', color: '#C74634', img: '/oracle.png' },
    dm:             { label: '达梦 DM',      icon: '💠', color: '#1F6FB2', img: '/dm.png' },
    dm8:            { label: '达梦 DM8',     icon: '💠', color: '#1F6FB2', img: '/dm8.png' },
    kingbase:       { label: '人大金仓',      icon: '🟠', color: '#B03A2E', img: '/kingbase.png' },
    gbase:          { label: 'GBase',       icon: '🟣', color: '#6C3483', img: '/gbase.png' },
    mongodb:        { label: 'MongoDB',     icon: '🍃', color: '#13AA52', img: '/mongodb.png' },
    redis:          { label: 'Redis',       icon: '🔺', color: '#DC382D', img: '/redis.png' },
    'redis-cluster': { label: 'Redis 集群',  icon: '🔺', color: '#DC382D', img: '/redis.png' },
    clickhouse:     { label: 'ClickHouse',  icon: '🏠', color: '#B8971A', img: '/clickhouse.png' },
    oceanbase:      { label: 'OceanBase',   icon: '🌊', color: '#005BAC', img: '/oceanbase.png' },
    ivorysql:       { label: 'IvorySQL',    icon: '🐘', color: '#336791', img: '/ivorysql.png' },
    tidb:           { label: 'TiDB',        icon: '⚡', color: '#D63A2F', img: '/tidb.png' },
    yashandb:       { label: '崖山 YashanDB', icon: '🗃️', color: '#1E6FBA', img: '/yashandb.png' },
    db2:            { label: 'DB2',         icon: '🗄️', color: '#052FAD', img: '/db2.png' },
    hgdb:           { label: '瀚高 HGDB',    icon: '🐘', color: '#336791', img: '/hgdb.png' },
    uxdb:           { label: '优炫 UXDB',    icon: '🐘', color: '#336791', img: '/uxdb.png' },
    vastbase:       { label: 'Vastbase',    icon: '🐘', color: '#336791', img: '/vastbase.png' },
    tdsqlc_mysql:   { label: 'TDSQL-C',     icon: '🐬', color: '#005BAC', img: '/tdsqlc.png' }
  };

  var _wiAllDs = [];
  var _wiDeletedDs = [];
  var _wiDirs = [];
  var _wiReports = [];
  var _wiLatestReports = {};
  var _wiSelected = {};
  var _wiTab = 'active';
  var _wiActiveDir = '';
  var _wiExpanded = {};
  var _wiCollapsed = {};
  var _wiKeyword = '';
  var _wiTypeFilter = '';
  var _wiLoading = false;
  var _wiColWidths = null;

  function $(id) { return document.getElementById(id); }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function escAttr(v) {
    return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  }

  function wiToast(msg, type) {
    try {
      if (typeof toast === 'function') { toast(msg, type || 'info'); return; }
      if (type === 'error' && typeof toastError === 'function') { toastError(msg); return; }
      if (type === 'success' && typeof toastSuccess === 'function') { toastSuccess(msg); return; }
    } catch (e) {}
    console.log('[inspection] ' + msg);
  }

  function wiConfirm(title, message) {
    if (typeof showConfirmDialog === 'function') return showConfirmDialog(title, message);
    return Promise.resolve(window.confirm(message));
  }

  function wiTypeMeta(type) {
    var key = String(type || '').toLowerCase();
    var meta = DB_TYPE_META[key];
    if (!meta && key.slice(-5) === '_jdbc') meta = DB_TYPE_META[key.slice(0, -5)];
    return meta || { label: (type || '未知').toString().toUpperCase(), icon: '🗄️', color: '#64748B', img: '' };
  }

  function wiTypeIconHtml(meta, size) {
    if (meta.img) {
      return '<img src="' + escAttr(meta.img) + '" alt="" style="height:' + (size || 16) + 'px;width:auto" ' +
        'onerror="this.style.display=\'none\'">';
    }
    return '<span>' + (meta.icon || '') + '</span>';
  }

  function wiFmtShort(ts) {
    if (!ts) return '';
    var d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
    if (isNaN(d.getTime())) return String(ts).replace('T', ' ').slice(5, 16);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function dirOf(ds) {
    return (ds && ds.dir_id) ? ds.dir_id : 'dir_unassigned';
  }

  // ── 数据加载 ──────────────────────────────────────────────
  async function loadWizardHistoryPage() {
    if (_wiLoading) return;
    _wiLoading = true;
    try {
      var results = await Promise.all([
        fetch('/api/pro/datasources').then(function (r) { return r.json(); }).catch(function () { return {}; }),
        fetch('/api/pro/datasources/deleted').then(function (r) { return r.json(); }).catch(function () { return {}; }),
        fetch('/api/pro/dirs').then(function (r) { return r.json(); }).catch(function () { return {}; }),
        fetch('/api/reports').then(function (r) { return r.json(); }).catch(function () { return {}; })
      ]);
      _wiAllDs = ((results[0] || {}).datasources || []).filter(function (d) { return !d.deleted; });
      _wiDeletedDs = ((results[1] || {}).datasources || []);
      _wiDirs = ((results[2] || {}).dirs || []).slice();
      _wiReports = ((results[3] || {}).files || []).slice();
      _wiSelected = {};
      // 选中目录可能已在别处被删除：回落到「全部数据源」，避免列表恒为空
      if (_wiActiveDir && !_wiDirs.some(function (d) { return d.id === _wiActiveDir; })) {
        _wiActiveDir = '';
      }
      wiLoadTreeState();
      renderWizardTree();
      renderWizardHistoryContent();
      updateWizardStats();
    } catch (e) {
      console.error('[inspection] load failed', e);
      wiToast('加载数据源失败：' + e.message, 'error');
      var tb = $('wizard-history-body');
      if (tb) tb.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--danger)">加载失败</td></tr>';
    } finally {
      _wiLoading = false;
    }
  }

  function matchLatestReport(ds) {
    if (!ds) return null;
    var name = String(ds.name || '').toLowerCase();
    var host = String(ds.host || '').toLowerCase();
    var matched = null;
    _wiReports.forEach(function (r) {
      var rn = String(r.name || '').toLowerCase();
      var hit = (name && rn.indexOf(name) >= 0) || (host && rn.indexOf(host) >= 0);
      if (!hit) return;
      if (!matched || Number(r.mtime || 0) > Number(matched.mtime || 0)) matched = r;
    });
    return matched;
  }

  function updateWizardStats() {
    var list = dirScopedList(_wiTab);
    var set = function (id, v) { var el = $(id); if (el) el.textContent = v; };
    set('wi-stat-total', list.length);
    if (_wiTab === 'deleted') {
      set('wi-stat-healthy', '-');
      set('wi-stat-warn', '-');
      set('wi-stat-avg-score', '--');
    } else {
      var healthy = 0, warn = 0, sum = 0, n = 0;
      list.forEach(function (ds) {
        var rep = matchLatestReport(ds);
        if (!rep || rep.health_score == null || rep.health_score === '') return;
        var score = Number(rep.health_score);
        if (!isFinite(score)) return;
        sum += score; n++;
        if (score >= 80) healthy++;
        else if (score >= 60) warn++;
      });
      set('wi-stat-healthy', healthy);
      set('wi-stat-warn', warn);
      set('wi-stat-avg-score', n ? Math.round(sum / n) : '--');
    }
    set('wi-tab-active-count', dirScopedList('active').length);
    set('wi-tab-deleted-count', dirScopedList('deleted').length);
  }

  // ── 目录树 ────────────────────────────────────────────────
  function wiLoadTreeState() {
    _wiCollapsed = {};
    try {
      var arr = JSON.parse(sessionStorage.getItem(TREE_COLLAPSED_KEY) || '[]');
      (arr || []).forEach(function (id) { _wiCollapsed[id] = true; });
    } catch (e) {}
  }

  function wiSaveTreeState() {
    try { sessionStorage.setItem(TREE_COLLAPSED_KEY, JSON.stringify(Object.keys(_wiCollapsed))); } catch (e) {}
  }

  function dirChildren(parentId) {
    return _wiDirs.filter(function (d) { return (d.parent_id || '') === (parentId || ''); })
      .sort(function (a, b) {
        return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) ||
          String(a.name || '').localeCompare(String(b.name || ''));
      });
  }

  function dirSelfAndDescendants(dirId) {
    var ids = {};
    if (!dirId) return null;
    ids[dirId] = true;
    var walk = function (pid) {
      dirChildren(pid).forEach(function (d) {
        if (!ids[d.id]) { ids[d.id] = true; walk(d.id); }
      });
    };
    walk(dirId);
    return ids;
  }

  function dsMatchesKeyword(ds, q) {
    if (!q) return true;
    var hay = [ds.name, ds.host, ds.port, ds.database, ds.service_name, ds.dir_path]
      .join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  // 目录作用域：选中目录时收敛到「该目录 + 其全部子目录」下的数据源；
  // 未选中目录（全部数据源）时返回原列表。列表、统计卡、类型计数共用此口径。
  function dirScopedList(tab) {
    var source = (tab || _wiTab) === 'active' ? _wiAllDs : _wiDeletedDs;
    var dirIds = dirSelfAndDescendants(_wiActiveDir);
    if (!dirIds) return source;
    return source.filter(function (ds) { return !!dirIds[dirOf(ds)]; });
  }

  function renderWizardTree() {
    var host = $('wi-tree-body');
    if (!host) return;
    var list = _wiTab === 'active' ? _wiAllDs : _wiDeletedDs;
    var q = _wiKeyword;

    // 搜索时只保留「命中目录及其祖先」+「命中数据源所在目录及其祖先」
    var visible = null;
    if (q) {
      visible = {};
      var markAncestors = function (id) {
        while (id) {
          visible[id] = true;
          var node = _wiDirs.filter(function (d) { return d.id === id; })[0];
          id = node ? (node.parent_id || '') : '';
        }
      };
      _wiDirs.forEach(function (d) {
        if (String(d.name || '').toLowerCase().indexOf(q) >= 0) markAncestors(d.id);
      });
      list.forEach(function (ds) {
        if (dsMatchesKeyword(ds, q)) markAncestors(dirOf(ds));
      });
    }

    var countUnder = function (dirId) {
      var ids = dirSelfAndDescendants(dirId) || {};
      return list.filter(function (ds) { return ids[dirOf(ds)]; }).length;
    };

    var html = '<div class="wi-tree-node' + (!_wiActiveDir ? ' active' : '') + ' has-items" data-dir-id="" data-wi-caret="0" title="全部数据源">' +
      '<span class="wi-tree-caret empty">▸</span>' +
      '<span class="wi-tree-icon">🗂️</span>' +
      '<span class="wi-tree-name">全部数据源</span>' +
      '<span class="wi-tree-count">' + list.length + '</span></div>';

    var walk = function (parentId, depth) {
      dirChildren(parentId).forEach(function (d) {
        if (visible && !visible[d.id]) return;
        var kids = dirChildren(d.id);
        var count = countUnder(d.id);
        var open = q ? true : (!_wiCollapsed[d.id] || (!!_wiExpanded[d.id]));
        var name = String(d.name || '未命名目录');
        var nameHtml = escHtml(name);
        if (q) {
          var idx = name.toLowerCase().indexOf(q);
          if (idx >= 0) {
            nameHtml = escHtml(name.slice(0, idx)) +
              '<span class="wi-tree-search-hit">' + escHtml(name.slice(idx, idx + q.length)) + '</span>' +
              escHtml(name.slice(idx + q.length));
          }
        }
        html += '<div class="wi-tree-node' + (_wiActiveDir === d.id ? ' active' : '') + (count ? ' has-items' : '') +
          '" data-dir-id="' + escHtml(d.id) + '" data-wi-caret="' + (kids.length ? '1' : '0') + '"' +
          ' style="padding-left:' + (8 + depth * 14) + 'px"' +
          ' title="' + escHtml(d.full_path || d.name || '') + '">' +
          '<span class="wi-tree-caret' + (open ? ' open' : '') + (kids.length ? '' : ' empty') + '">▸</span>' +
          '<span class="wi-tree-icon" style="color:' + escHtml(d.color || 'inherit') + '">' + (kids.length ? '📁' : '📂') + '</span>' +
          '<span class="wi-tree-name">' + nameHtml + '</span>' +
          '<span class="wi-tree-count">' + (count || '') + '</span></div>';
        if (kids.length && open) walk(d.id, depth + 1);
      });
    };
    walk('', 0);

    if (!_wiDirs.length) {
      html += '<div class="wi-tree-empty">还没有目录。<br>可在「数据源管理」中新建目录并归入数据源。</div>';
    }
    host.innerHTML = html;

    host.querySelectorAll('.wi-tree-node').forEach(function (node) {
      node.addEventListener('click', function (ev) {
        var dirId = node.getAttribute('data-dir-id') || '';
        if (ev.target && ev.target.classList && ev.target.classList.contains('wi-tree-caret') && dirId) {
          ev.stopPropagation();
          if (_wiCollapsed[dirId]) delete _wiCollapsed[dirId];
          else _wiCollapsed[dirId] = true;
          wiSaveTreeState();
          renderWizardTree();
          return;
        }
        if ((_wiActiveDir || '') === dirId) return;
        wiSelectDir(dirId);
      });
    });

    wiUpdateCrumb();
  }

  function wiUpdateCrumb() {
    var el = $('wi-crumb-path');
    if (!el) return;
    if (!_wiActiveDir) { el.textContent = '全部数据源'; return; }
    var dir = _wiDirs.filter(function (d) { return d.id === _wiActiveDir; })[0];
    el.textContent = dir ? (dir.full_path || dir.name || '全部数据源') : '全部数据源';
  }

  function wiSelectDir(dirId) {
    _wiActiveDir = dirId || '';
    _wiSelected = {};
    renderWizardTree();
    renderWizardHistoryContent();
    updateWizardStats();
  }

  function wiToggleTree() {
    var split = $('wi-split');
    if (split) split.classList.toggle('tree-collapsed');
  }

  // ── 列表 ──────────────────────────────────────────────────
  // 目录 + 关键字命中集，供类型下拉做计数（类型自身不参与，否则选中后其它类型归零）
  function rowsBeforeTypeFilter() {
    return dirScopedList(_wiTab).filter(function (ds) { return dsMatchesKeyword(ds, _wiKeyword); });
  }

  function currentRows() {
    var type = String(_wiTypeFilter || '').toLowerCase();
    var rows = rowsBeforeTypeFilter();
    if (!type) return rows;
    return rows.filter(function (ds) {
      var dt = String(ds.db_type || '').toLowerCase();
      var dtBare = dt.slice(-5) === '_jdbc' ? dt.slice(0, -5) : dt;
      return dt === type || dtBare === type;
    });
  }

  function renderWizardHistoryContent() {
    var tbody = $('wizard-history-body');
    if (!tbody) return;
    var rows = currentRows();
    _wiLatestReports = {};

    if (!rows.length) {
      var msg;
      if (_wiKeyword || _wiTypeFilter || _wiActiveDir) {
        msg = '未找到匹配的数据源';
      } else if (_wiTab === 'deleted') {
        msg = '没有已删除的数据源';
      } else {
        msg = '暂无数据源，点击「新增巡检」添加';
      }
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text-muted)">' + escHtml(msg) + '</td></tr>';
      updateTypeFilter();
      syncBatchBar(rows);
      return;
    }

    tbody.innerHTML = rows.map(function (ds) {
      var meta = wiTypeMeta(ds.db_type);
      var rep = matchLatestReport(ds);
      _wiLatestReports[ds.id] = rep || null;
      var score = rep && rep.health_score != null && rep.health_score !== '' ? Number(rep.health_score) : null;
      var healthClass = score == null ? 'none' : score >= 80 ? 'good' : score >= 60 ? 'warn' : 'bad';
      var healthText = score == null ? '--' : String(score);
      var dot = _wiTab === 'deleted' ? 'offline'
        : score == null ? 'offline' : score >= 80 ? 'online' : score >= 60 ? 'warn' : 'error';

      var riskHtml;
      if (_wiTab === 'deleted') {
        riskHtml = '<span class="wi-risk-badge none">已删除</span>';
      } else if (!rep) {
        riskHtml = '<span class="wi-risk-badge none">未巡检</span>';
      } else {
        var high = Number(rep.high || 0), mid = Number(rep.mid || 0), low = Number(rep.low || 0);
        riskHtml = (high + mid + low > 0)
          ? '<span class="wi-risk-badge high">🔴 ' + high + '</span>' +
            '<span class="wi-risk-badge mid">🟡 ' + mid + '</span>' +
            '<span class="wi-risk-badge low">🟢 ' + low + '</span>'
          : '<span class="wi-risk-badge none">✓ 无异常</span>';
      }

      var last = _wiTab === 'deleted'
        ? ('删除于 ' + wiFmtShort(ds.deleted_at))
        : (rep ? wiFmtShort(rep.mtime) : '-');
      var checked = !!_wiSelected[ds.id];
      var addr = String(ds.host || '') + (ds.port ? ':' + ds.port : '');
      var dirPath = String(ds.dir_path || '');
      var nameHtml = '<span class="wi-status-dot ' + dot + '"></span>' + escHtml(ds.name || '未命名') +
        (dirPath ? '<div class="wi-ds-path" title="' + escHtml(dirPath) + '">📁 ' + escHtml(dirPath) + '</div>' : '');

      return '<tr class="' + (checked ? 'selected ' : '') + (_wiTab === 'deleted' ? 'deleted-row' : '') + '" data-id="' + escHtml(ds.id) + '">' +
        '<td><input type="checkbox" class="wi-ds-checkbox" ' + (checked ? 'checked' : '') +
        ' onchange="wiToggleRow(\'' + escAttr(ds.id) + '\', this.checked)" onclick="event.stopPropagation()"></td>' +
        '<td class="wi-name-cell">' + nameHtml + '</td>' +
        '<td><span class="wi-type-badge" style="background:' + meta.color + '1f;color:' + meta.color + '">' +
        wiTypeIconHtml(meta, 16) + ' ' + escHtml(meta.label) + '</span></td>' +
        '<td class="wi-host-cell">' + escHtml(addr) + '</td>' +
        '<td class="wi-db-cell">' + escHtml(ds.database || ds.service_name || '-') + '</td>' +
        '<td><span class="wi-health-badge ' + healthClass + '">' + healthText + '</span></td>' +
        '<td class="wi-risk-cell">' + riskHtml + '</td>' +
        '<td class="wi-last-cell">' + escHtml(last) + '</td>' +
        '</tr>';
    }).join('');

    updateTypeFilter();
    syncBatchBar(rows);
  }

  function updateTypeFilter() {
    var sel = $('wi-type-filter');
    if (!sel) return;
    var source = rowsBeforeTypeFilter();
    var counts = {};
    source.forEach(function (ds) {
      var t = String(ds.db_type || 'unknown').toLowerCase();
      counts[t] = (counts[t] || 0) + 1;
    });
    var types = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || a.localeCompare(b);
    });
    var current = _wiTypeFilter || '';
    var html = '<option value="">全部类型</option>';
    types.forEach(function (t) {
      var meta = wiTypeMeta(t);
      html += '<option value="' + escHtml(t) + '"' + (current === t ? ' selected' : '') + '>' +
        escHtml(meta.label) + ' (' + counts[t] + ')</option>';
    });
    sel.innerHTML = html;
    sel.value = current;
  }

  function syncBatchBar(rows) {
    var count = Object.keys(_wiSelected).length;
    var info = $('wh-batch-info');
    if (info) info.textContent = count ? ('已选 ' + count + ' 项') : '未选择数据源';

    var selectAll = $('wh-select-all');
    var headerCheck = $('wh-header-check');
    var allChecked = rows.length > 0 && count === rows.length;
    if (selectAll) selectAll.checked = allChecked;
    if (headerCheck) headerCheck.checked = allChecked;

    var isDeleted = _wiTab === 'deleted';
    var activeGroup = $('wh-batch-active-actions');
    var deletedGroup = $('wh-batch-deleted-actions');
    if (activeGroup) activeGroup.style.display = isDeleted ? 'none' : 'flex';
    if (deletedGroup) deletedGroup.style.display = isDeleted ? 'flex' : 'none';

    var singleRep = null;
    if (count === 1) {
      var onlyId = Object.keys(_wiSelected)[0];
      singleRep = _wiLatestReports[onlyId] || null;
    }
    var setDisabled = function (id, disabled) {
      var btn = $(id);
      if (btn) btn.disabled = !!disabled;
    };
    setDisabled('wh-act-inspect', count === 0);
    setDisabled('wh-act-edit', count !== 1);
    setDisabled('wh-act-report', count !== 1 || !singleRep);
    setDisabled('wh-act-delete', count === 0);
    setDisabled('wh-act-restore', count === 0);
    setDisabled('wh-act-hard-delete', count === 0);
  }

  function wiToggleRow(id, checked) {
    if (checked) _wiSelected[id] = true; else delete _wiSelected[id];
    var tr = document.querySelector('#wizard-history-body tr[data-id="' +
      (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (tr) tr.classList.toggle('selected', !!checked);
    syncBatchBar(currentRows());
  }

  function wiToggleSelectAll(cb) {
    var rows = currentRows();
    if (cb && cb.checked) rows.forEach(function (r) { _wiSelected[r.id] = true; });
    else _wiSelected = {};
    renderWizardHistoryContent();
  }

  function filterWizardHistory(type) {
    _wiTypeFilter = String(type || '').toLowerCase();
    _wiSelected = {};
    renderWizardHistoryContent();
  }

  function filterWizardBySearch() {
    var input = $('wh-search-input');
    _wiKeyword = input ? String(input.value || '').trim().toLowerCase() : '';
    _wiSelected = {};
    renderWizardTree();
    renderWizardHistoryContent();
  }

  function switchWizardTab(tab) {
    if (tab !== 'active' && tab !== 'deleted') return;
    _wiTab = tab;
    _wiSelected = {};
    var a = $('wi-tab-active');
    var d = $('wi-tab-deleted');
    if (a) a.classList.toggle('active', tab === 'active');
    if (d) d.classList.toggle('active', tab === 'deleted');
    renderWizardTree();
    renderWizardHistoryContent();
    updateWizardStats();
  }

  // ── 公共操作栏动作 ────────────────────────────────────────
  function selectedRows() {
    return currentRows().filter(function (d) { return _wiSelected[d.id]; });
  }

  function findDs(id) {
    var all = _wiAllDs.concat(_wiDeletedDs);
    return all.filter(function (d) { return d.id === id; })[0] || null;
  }

  function wiWizardType(type) {
    var t = String(type || '').toLowerCase();
    var wiz = (window.dbTypes || []).map(function (x) { return String(x.value || '').toLowerCase(); });
    if (wiz.indexOf(t) >= 0) return t;
    var alias = { postgresql: 'pg', postgres: 'pg', dm8: 'dm' }[t];
    if (alias) return alias;
    if (t.slice(-5) === '_jdbc') {
      var bare = t.slice(0, -5);
      if (wiz.indexOf(bare) >= 0) return bare;
    }
    return t;
  }

  /** 勾选 1 个数据源点「巡检」：打开向导、预填连接信息，停在「第 5 步确认」 */
  async function wiQuickInspect(dsId) {
    var ds = findDs(dsId);
    if (!ds) return wiToast('数据源不存在或已删除', 'error');
    var type = wiWizardType(ds.db_type);
    if (!type) {
      return wiToast('数据源「' + (ds.name || ds.host) + '」缺少数据库类型，无法确定连接方式', 'error');
    }
    if (typeof startWizard === 'function') startWizard();
    if (typeof selectDbType === 'function') {
      try { await selectDbType(type, true); } catch (e) {}
    }
    if (typeof loadDatasourcesForSelect === 'function') {
      try { await loadDatasourcesForSelect(); } catch (e) {}
    }
    var sel = $('f-datasource');
    if (!sel) return;
    var found = false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === dsId) { found = true; break; }
    }
    if (!found) {
      // 数据源类型与向导类型别名不一致时（如 postgresql / pg），手工补一项兜底
      var opt = document.createElement('option');
      opt.value = dsId;
      opt.textContent = ds.name || (ds.host + ':' + ds.port);
      sel.appendChild(opt);
    }
    sel.value = dsId;
    // 直接用列表里已有的数据源信息填充，不再走 onDatasourceChange（它会真连库做 Oracle
    // 版本探测，慢的时候界面一直停在第 1 步，看起来像"点了没反应"）。巡检请求本身按
    // datasource_id 取连接信息，这里只需把确认面板需要的字段填好。
    var setVal = function (id, v) { var el = $(id); if (el) el.value = (v == null ? '' : v); };
    setVal('f-name', ds.name);
    setVal('f-host', ds.host);
    setVal('f-port', ds.port);
    setVal('f-user', ds.user);
    setVal('f-service-name', ds.service_name);
    setVal('f-database', ds.database);
    if (ds.db_type === 'oceanbase') setVal('f-tenant', ds.tenant);
    var sysdba = $('f-sysdba');
    if (sysdba) sysdba.checked = !!ds.sysdba;
    var useSid = $('f-use-sid');
    if (useSid) useSid.checked = !!ds.use_sid;
    // SSH：数据源带 SSH 配置时一并回填并切到 SSH 采集，确认面板才能反映真实采集方式；
    // 没有 SSH 配置的数据源显式回到「不采集」，避免沿用上一次留下的采集方式。
    var setMode = function (mode) {
      try {
        if (typeof window.setSysCollectMode === 'function') window.setSysCollectMode(mode);
      } catch (e) {}
    };
    if (ds.ssh_enabled || ds.ssh_host) {
      setVal('f-ssh-host', ds.ssh_host);
      setVal('f-ssh-port', ds.ssh_port || 22);
      setVal('f-ssh-user', ds.ssh_user || 'root');
      setVal('f-ssh-password', ds.ssh_password);
      setVal('f-ssh-key', ds.ssh_key_file);
      setMode('ssh');
    } else {
      setVal('f-zb-host', '');
      setVal('f-zb-hostname', '');
      setMode('none');
    }
    if (typeof gotoStep === 'function') gotoStep(5);
    wiToast('已就绪：连接信息已填充，请在第 5 步确认后点击执行巡检', 'info');
  }

  async function wiBatchInspect() {
    if (_wiTab === 'deleted') return wiToast('回收站中的数据源无法巡检', 'warning');
    var rows = selectedRows();
    if (!rows.length) return wiToast('请先勾选要巡检的数据源', 'warning');
    if (rows.length === 1) return wiQuickInspect(rows[0].id);

    var failed = 0, started = 0;
    wiToast('正在提交 ' + rows.length + ' 个巡检任务...', 'info');
    for (var i = 0; i < rows.length; i++) {
      var ds = rows[i];
      try {
        var res = await fetch('/api/start_inspection', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            db_type: ds.db_type,
            datasource_id: ds.id,
            inspector_name: 'AI',
            desensitize: false
          })
        });
        var data = await res.json();
        if (data.ok) started++; else failed++;
      } catch (e) { failed++; }
    }
    if (started) wiToast('已提交 ' + started + ' 个巡检任务' + (failed ? '，失败 ' + failed + ' 个' : ''), failed ? 'warning' : 'success');
    else wiToast('巡检任务提交失败', 'error');
    setTimeout(loadWizardHistoryPage, 1500);
  }

  function wiBatchEdit() {
    if (_wiTab === 'deleted') return wiToast('回收站中的数据源无法编辑', 'warning');
    var rows = selectedRows();
    if (rows.length !== 1) return wiToast('请只勾选 1 个数据源后再编辑', 'warning');
    if (typeof editDatasource === 'function') editDatasource(rows[0].id);
    else wiToast('编辑入口不可用', 'error');
  }

  function wiBatchReport() {
    var rows = selectedRows();
    if (rows.length !== 1) return wiToast('请只勾选 1 个数据源后再查看报告', 'warning');
    if (!_wiLatestReports[rows[0].id]) return wiToast('该数据源还没有巡检报告，请先执行巡检', 'warning');
    if (typeof showPage === 'function') showPage('reports');
    setTimeout(function () {
      if (typeof loadReports === 'function') { try { loadReports(); } catch (e) {} }
    }, 60);
  }

  async function wiBatchDelete() {
    if (_wiTab === 'deleted') return;
    var rows = selectedRows();
    if (!rows.length) return wiToast('请先勾选要删除的数据源', 'warning');
    var ok = await wiConfirm('删除数据源', '确定将选中的 ' + rows.length + ' 个数据源移入回收站？历史巡检报告会保留，可随时恢复。');
    if (!ok) return;
    try {
      var res = await fetch('/api/pro/datasources/batch-soft-delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: rows.map(function (r) { return r.id; }) })
      });
      var data = await res.json();
      if (!data.ok) throw new Error(data.error || data.message || '删除失败');
      wiToast('已移入回收站', 'success');
      _wiSelected = {};
      loadWizardHistoryPage();
    } catch (e) { wiToast('删除失败：' + e.message, 'error'); }
  }

  async function wiBatchRestore() {
    var rows = selectedRows();
    if (!rows.length) return wiToast('请先勾选要恢复的数据源', 'warning');
    try {
      var res = await fetch('/api/pro/datasources/batch-restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: rows.map(function (r) { return r.id; }) })
      });
      var data = await res.json();
      if (!data.ok) throw new Error(data.error || data.message || '恢复失败');
      wiToast('已恢复 ' + (data.restored || rows.length) + ' 个数据源', 'success');
      _wiSelected = {};
      loadWizardHistoryPage();
    } catch (e) { wiToast('恢复失败：' + e.message, 'error'); }
  }

  async function wiBatchHardDelete() {
    var rows = selectedRows();
    if (!rows.length) return wiToast('请先勾选要彻底删除的数据源', 'warning');
    var ok = await wiConfirm('彻底删除', '彻底删除后数据源及其巡检历史将不可恢复，确定继续？');
    if (!ok) return;
    try {
      var res = await fetch('/api/pro/datasources/batch-hard-delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: rows.map(function (r) { return r.id; }) })
      });
      var data = await res.json();
      if (!data.ok) throw new Error(data.error || '删除失败');
      if (data.errors && data.errors.length) wiToast('已删除 ' + data.deleted + ' 个，失败 ' + data.errors.length + ' 个', 'warning');
      else wiToast('已彻底删除 ' + (data.deleted || rows.length) + ' 个数据源', 'success');
      _wiSelected = {};
      loadWizardHistoryPage();
    } catch (e) { wiToast('删除失败：' + e.message, 'error'); }
  }

  // ── 配置弹窗 ──────────────────────────────────────────────
  function closeWizardConfig() {
    var modal = $('wizard-config-modal');
    if (modal) modal.style.display = 'none';
    loadWizardHistoryPage();
  }

  function wiModalBackdropClick(ev) {
    if (ev && ev.target === $('wizard-config-modal')) closeWizardConfig();
  }

  // ── 列宽拖拽（源系统习惯：colgroup + 默认宽度 + 双击恢复默认） ──
  function wiTable() {
    return $('wizard-history-table');
  }

  function wiApplyColWidths() {
    var table = wiTable();
    if (!table || !_wiColWidths) return;
    var cols = table.querySelectorAll('colgroup > col');
    _wiColWidths.forEach(function (w, i) { if (cols[i]) cols[i].style.width = w + 'px'; });
    var total = _wiColWidths.reduce(function (a, b) { return a + b; }, 0);
    table.style.width = 'max(100%, ' + total + 'px)';
  }

  function wiStartColResize(ev, idx, handle) {
    if (!ev || ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    var table = wiTable();
    if (!table || !table.tHead) return;
    var ths = Array.prototype.slice.call(table.tHead.rows[0].children);
    _wiColWidths = ths.map(function (th) { return Math.round(th.getBoundingClientRect().width); });
    var startX = ev.clientX;
    var startW = _wiColWidths[idx];
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    var onMove = function (e) {
      var minW = idx === 1 ? 240 : 80;
      var next = Math.max(minW, Math.round(startW + e.clientX - startX));
      if (next === _wiColWidths[idx]) return;
      _wiColWidths[idx] = next;
      wiApplyColWidths();
    };
    var onUp = function () {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handle.classList.remove('dragging');
      try { localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(_wiColWidths)); } catch (e) {}
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function wiInitTableColumns() {
    var table = wiTable();
    if (!table || !table.tHead) return;
    var ths = Array.prototype.slice.call(table.tHead.rows[0].children);
    if (ths.length !== COL_DEFAULT_WIDTHS.length) return;

    var colgroup = table.querySelector('colgroup');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      table.insertBefore(colgroup, table.firstChild);
    }
    if (colgroup.children.length !== ths.length) {
      colgroup.innerHTML = '';
      for (var i = 0; i < ths.length; i++) colgroup.appendChild(document.createElement('col'));
    }

    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) || 'null'); } catch (e) {}
    _wiColWidths = (Array.isArray(saved) && saved.length === ths.length)
      ? saved.map(function (w, i) { return Number(w) > 0 ? Number(w) : COL_DEFAULT_WIDTHS[i]; })
      : COL_DEFAULT_WIDTHS.slice();
    wiApplyColWidths();

    ths.forEach(function (th, idx) {
      if (idx === 0 || th.querySelector('.wi-col-resizer')) return;
      var handle = document.createElement('div');
      handle.className = 'wi-col-resizer';
      handle.title = '拖动调整列宽，双击恢复默认';
      handle.addEventListener('mousedown', function (ev) { wiStartColResize(ev, idx, handle); });
      handle.addEventListener('dblclick', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        _wiColWidths = COL_DEFAULT_WIDTHS.slice();
        wiApplyColWidths();
        try { localStorage.removeItem(COL_WIDTHS_KEY); } catch (e) {}
      });
      th.appendChild(handle);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wiInitTableColumns);
  } else {
    wiInitTableColumns();
  }

  // 暴露给页面内联 onclick 使用
  window.loadWizardHistoryPage = loadWizardHistoryPage;
  window.filterWizardHistory = filterWizardHistory;
  window.filterWizardBySearch = filterWizardBySearch;
  window.switchWizardTab = switchWizardTab;
  window.wiSelectDir = wiSelectDir;
  window.wiToggleTree = wiToggleTree;
  window.wiToggleRow = wiToggleRow;
  window.wiToggleSelectAll = wiToggleSelectAll;
  window.wiBatchInspect = wiBatchInspect;
  window.wiBatchEdit = wiBatchEdit;
  window.wiBatchReport = wiBatchReport;
  window.wiBatchDelete = wiBatchDelete;
  window.wiBatchRestore = wiBatchRestore;
  window.wiBatchHardDelete = wiBatchHardDelete;
  window.closeWizardConfig = closeWizardConfig;
  window.wiModalBackdropClick = wiModalBackdropClick;
})();
