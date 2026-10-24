/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * Fusion page logic: data source management (left tree + right table).
 * Layout and UX adapted from DBCheck v2.6 (MIT License,
 * Copyright (c) 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>),
 * rewritten for the RaccoonX module layout.
 * Reuses the existing RaccoonX data-source modal / test / delete handlers.
 */
(function () {
  'use strict';

  var state = {
    dirs: [],
    data: [],
    currentDir: '',
    currentLabel: '',
    view: 'dir',
    search: '',
    collapsed: {},
    dirsAvailable: true
  };

  var STORAGE_KEY = 'fusion_ds_collapsed_dirs';

  function $(id) { return document.getElementById(id); }

  function t(key, fallback) {
    try {
      if (typeof window.i18n === 'function') {
        var v = window.i18n(key);
        if (v && v !== key) return v;
      }
    } catch (e) { /* ignore */ }
    return fallback || key;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function attr(value) { return esc(value); }

  function isAdmin() {
    return window._IS_ADMIN === true || window.__userRole === 'admin' || window.__userRole === '管理员';
  }

  function dbIcon(type) {
    if (window.DB_ICONS && window.DB_ICONS[type]) return window.DB_ICONS[type];
    return '🗄️';
  }

  // 首屏渲染可能早于全局 loadDbTypes()：类型图标/名称都取自 dbTypes，这里兜底拉一次
  async function ensureDbTypes() {
    if (window.dbTypes && window.dbTypes.length) return;
    try {
      var res = await fetch('/api/db_types', { credentials: 'same-origin' });
      var list = await res.json();
      if (Array.isArray(list) && list.length) {
        window.dbTypes = list;
        if (typeof window.rebuildDbMetaMaps === 'function') window.rebuildDbMetaMaps();
      }
    } catch (e) { /* 拉不到就退回原始 db_type 文案，不影响列表 */ }
  }

  // 数据库类型显示名：与编辑表单「数据库类型」下拉项文案保持一致（图标已单列，这里只取 label）
  function dbTypeLabel(type) {
    var key = String(type || '').toLowerCase();
    if (!key) return t('webui.ds_type_unknown', '未设置');
    var list = window.dbTypes || [];
    for (var i = 0; i < list.length; i++) {
      var v = String(list[i].value || list[i].db_type || '').toLowerCase();
      if (v === key) return list[i].label || list[i].name || key;
    }
    if (window.LABEL_MAP && window.LABEL_MAP[key]) return window.LABEL_MAP[key];
    return key;
  }

  function labelsOf(ds) {
    var v = ds.labels;
    if (v == null) v = ds.tags;
    if (Array.isArray(v)) return v.filter(Boolean);
    if (typeof v === 'string' && v) {
      try {
        var parsed = JSON.parse(v);
        if (Array.isArray(parsed)) return parsed.filter(Boolean);
      } catch (e) { /* ignore */ }
    }
    return [];
  }

  function loadCollapsed() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) state.collapsed = JSON.parse(raw) || {};
    } catch (e) { /* ignore */ }
  }

  function saveCollapsed() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.collapsed)); } catch (e) { /* ignore */ }
  }

  function dirById(id) {
    for (var i = 0; i < state.dirs.length; i++) {
      if (state.dirs[i].id === id) return state.dirs[i];
    }
    return null;
  }

  function dirChildren(id) {
    return state.dirs.filter(function (d) { return (d.parent_id || '') === (id || ''); });
  }

  function descendantIds(id) {
    var out = {};
    var stack = dirChildren(id).map(function (d) { return d.id; });
    while (stack.length) {
      var cur = stack.pop();
      if (out[cur]) continue;
      out[cur] = true;
      dirChildren(cur).forEach(function (d) { stack.push(d.id); });
    }
    return out;
  }

  function ancestorsOf(id) {
    var out = {};
    var d = dirById(id);
    while (d && d.parent_id) {
      out[d.parent_id] = true;
      d = dirById(d.parent_id);
    }
    return out;
  }

  function expandAncestors(id) {
    var changed = false;
    var d = dirById(id);
    while (d && d.parent_id) {
      if (state.collapsed[d.parent_id]) {
        state.collapsed[d.parent_id] = false;
        changed = true;
      }
      d = dirById(d.parent_id);
    }
    if (changed) saveCollapsed();
  }

  function allLabels() {
    var map = {};
    state.data.forEach(function (ds) {
      labelsOf(ds).forEach(function (l) {
        map[l] = (map[l] || 0) + 1;
      });
    });
    return Object.keys(map).sort(function (a, b) { return a.localeCompare(b); }).map(function (name) {
      return { name: name, count: map[name] };
    });
  }

  function matchesSearch(ds) {
    if (!state.search) return true;
    var hay = [
      ds.name, ds.host, ds.port, ds.database, ds.service_name, ds.db_type,
      ds.dir_path, ds.dir_name, ds.group
    ].join(' ').toLowerCase();
    // 表格已单列展示数据库类型显示名，搜索要能按看到的文案命中
    hay += ' ' + dbTypeLabel(ds.db_type).toLowerCase();
    hay += ' ' + labelsOf(ds).join(' ').toLowerCase();
    return hay.indexOf(state.search) !== -1;
  }

  function visibleData() {
    var rows = state.data.slice();
    if (state.view === 'label') {
      if (state.currentLabel === '__untagged__') {
        rows = rows.filter(function (ds) { return labelsOf(ds).length === 0; });
      } else if (state.currentLabel) {
        rows = rows.filter(function (ds) { return labelsOf(ds).indexOf(state.currentLabel) !== -1; });
      }
    } else if (state.currentDir) {
      var allowed = descendantIds(state.currentDir);
      allowed[state.currentDir] = true;
      rows = rows.filter(function (ds) {
        return allowed[ds.dir_id || 'dir_unassigned'];
      });
    }
    return rows.filter(matchesSearch);
  }

  function renderTree() {
    var tree = $('ds-tree');
    var title = $('ds-tree-title');
    var hint = $('ds-tree-hint');
    if (!tree) return;
    var dirAdmin = state.view === 'dir' && isAdmin() && state.dirsAvailable;
    if (hint) {
      hint.textContent = t('webui.ds_tree_hint', '右键目录可管理');
      hint.style.display = dirAdmin ? '' : 'none';
    }
    if (state.view === 'label') {
      if (title) title.textContent = t('webui.ds_view_label', '按标签');
      var labels = allLabels();
      var html = treeNodeHtml({
        id: '', name: t('webui.ds_all_labels', '全部标签'), icon: '🏷️', count: state.data.length,
        active: !state.currentLabel, special: 'label'
      });
      labels.forEach(function (l) {
        html += treeNodeHtml({
          id: l.name, name: l.name, icon: '🏷️', count: l.count,
          active: state.currentLabel === l.name, special: 'label'
        });
      });
      var untagged = state.data.filter(function (ds) { return labelsOf(ds).length === 0; }).length;
      if (untagged) {
        html += treeNodeHtml({
          id: '__untagged__', name: t('webui.ds_untagged', '未标注'), icon: '🏷️', count: untagged,
          active: state.currentLabel === '__untagged__', special: 'label'
        });
      }
      tree.innerHTML = html;
      return;
    }

    if (title) title.textContent = t('webui.ds_tree_title', '目录');
    expandAncestors(state.currentDir);
    var ancestors = ancestorsOf(state.currentDir);

    function renderDirBranch(d, rootLevel) {
      var kids = dirChildren(d.id).filter(function (x) { return x.id !== 'dir_unassigned'; });
      var collapsed = !!state.collapsed[d.id];
      var childrenHtml = '';
      if (kids.length && !collapsed) {
        childrenHtml = '<div class="ds-tree-children">' +
          kids.map(function (child) { return renderDirBranch(child, false); }).join('') + '</div>';
      }
      return treeNodeHtml({
        id: d.id, name: d.name, fullPath: d.full_path, icon: kids.length && !collapsed ? '📂' : '📁',
        count: d.count || 0, active: state.currentDir === d.id,
        ancestor: !!ancestors[d.id], hasChildren: kids.length > 0, collapsed: collapsed,
        color: d.color, special: 'dir', rootLevel: rootLevel
      }, childrenHtml);
    }

    var topDirs = dirChildren('').filter(function (d) { return d.id !== 'dir_unassigned'; });
    var unassigned = state.dirs.filter(function (d) { return d.id === 'dir_unassigned'; })[0];
    var branchHtml = topDirs.map(function (d) { return renderDirBranch(d, true); }).join('');
    if (unassigned && (unassigned.count || 0) > 0) {
      branchHtml += treeNodeHtml({
        id: 'dir_unassigned', name: t('webui.ds_unassigned', '未分配'), icon: '📂',
        count: unassigned.count || 0, active: state.currentDir === 'dir_unassigned',
        special: 'dir', unassigned: true
      }, '');
    }
    tree.innerHTML = treeNodeHtml({
      id: '', name: t('webui.ds_all', '全部数据源'), icon: '🗄️', count: state.data.length,
      active: !state.currentDir, hasChildren: topDirs.length > 0, special: 'dir'
    }, '<div class="ds-tree-children level-root">' + branchHtml + '</div>');
  }

  function treeNodeHtml(node, childrenHtml) {
    var caret = '';
    if (node.hasChildren) {
      caret = '<span class="ds-tree-caret" data-caret="' + attr(node.id) + '">' +
        (node.collapsed ? '▸' : '▾') + '</span>';
    } else {
      caret = '<span class="ds-tree-caret"></span>';
    }
    var icon = '<span class="ds-tree-icon">' + (node.icon || '📁') + '</span>';
    var classes = 'ds-tree-node';
    if (node.active) classes += ' active';
    if (node.ancestor) classes += ' ancestor';
    if (node.unassigned) classes += ' unassigned';
    var label = '<span class="ds-tree-label" title="' + attr(node.fullPath || node.name) + '">' + esc(node.name) + '</span>';
    var row = '<div class="' + classes + '" role="treeitem" data-id="' + attr(node.id) + '"' +
      ' data-special="' + attr(node.special || '') + '" aria-selected="' + (node.active ? 'true' : 'false') + '"' +
      ' onclick="FusionDataSources.selectNode(this)">' +
      caret + icon + label + '<span class="ds-tree-count">' + (node.count || 0) + '</span></div>';
    var branchClass = 'ds-tree-branch' + (node.rootLevel ? ' root-branch' : '');
    return '<div class="' + branchClass + '">' + row + (childrenHtml || '') + '</div>';
  }

  function renderTable() {
    var tbody = $('ds-tbody');
    var empty = $('ds-empty');
    var countEl = $('datasources-count');
    var crumbs = $('ds-breadcrumb');
    if (!tbody) return;
    var rows = visibleData();
    if (countEl) countEl.textContent = rows.length;

    if (crumbs) {
      if (state.view === 'label') {
        crumbs.textContent = t('webui.ds_view_label', '按标签') + ' / ' + (state.currentLabel === '__untagged__' ? t('webui.ds_untagged', '未标注') : (state.currentLabel || t('webui.ds_all_labels', '全部标签')));
      } else if (state.currentDir) {
        var d = dirById(state.currentDir);
        var crumbName = state.currentDir === 'dir_unassigned'
          ? t('webui.ds_unassigned', '未分配')
          : (d ? (d.full_path || d.name) : t('webui.ds_unassigned', '未分配'));
        crumbs.textContent = t('webui.ds_all', '全部数据源') + ' / ' + crumbName;
      } else {
        crumbs.textContent = t('webui.ds_all', '全部数据源');
      }
    }

    if (!rows.length) {
      tbody.innerHTML = '';
      if (empty) {
        empty.style.display = '';
        empty.innerHTML = state.search
          ? esc(t('webui.ds_empty_search', '没有匹配的数据源')) + '<div class="ds-empty-hint">' + esc(t('webui.ds_empty_search_hint', '换个关键字或清空搜索试试')) + '</div>'
          : (state.data.length ? esc(t('webui.ds_empty_dir', '当前目录暂无数据源')) + '<div class="ds-empty-hint">' + esc(t('webui.ds_empty_dir_hint', '可在右上角添加数据源，或切换到其他目录')) + '</div>'
            : esc(t('webui.ds_empty_none', '暂无数据源')) + '<div class="ds-empty-hint">' + esc(t('webui.ds_empty_none_hint', '点击右上角「添加数据源」开始')) + '</div>');
      }
      return;
    }
    if (empty) empty.style.display = 'none';

    tbody.innerHTML = rows.map(function (ds) {
      var labels = labelsOf(ds);
      var labelHtml = labels.length
        ? labels.slice(0, 4).map(function (l) {
            return '<span class="ds-label-chip" data-label="' + attr(l) + '">' + esc(l) + '</span>';
          }).join('') + (labels.length > 4 ? '<span class="ds-label-chip">+' + (labels.length - 4) + '</span>' : '')
        : '<span style="color:var(--text-muted);font-size:11px">—</span>';
      var enabled = ds.enabled !== false && ds.enabled !== 0 && ds.enabled !== '0';
      var path = (ds.dir_id === 'dir_unassigned' || !ds.dir_path)
        ? t('webui.ds_unassigned', '未分配')
        : ds.dir_path;
      var typeLabel = dbTypeLabel(ds.db_type);
      return '<tr>' +
        '<td class="ds-icon-cell" title="' + attr(typeLabel) + '">' + dbIcon(ds.db_type) + '</td>' +
        '<td><div class="ds-name-main" title="' + attr(ds.name || '') + '">' + esc(ds.name || '(未命名)') + '</div>' +
          '<div class="ds-name-sub">' + esc(ds.group || 'default') + '</div></td>' +
        '<td class="ds-type-cell"><span class="ds-type-tag">' + esc(typeLabel) + '</span></td>' +
        '<td><span class="ds-mono">' + esc(ds.host || '') + ':' + esc(ds.port || '') + '</span>' +
          (ds.database ? '<div class="ds-name-sub">' + esc(ds.database) + '</div>' : '') + '</td>' +
        '<td><span class="ds-path" title="' + attr(path) + '">' + esc(path) + '</span></td>' +
        '<td>' + labelHtml + '</td>' +
        '<td><span class="ds-status' + (enabled ? '' : ' off') + '"><span class="ds-status-dot"></span>' + (enabled ? t('webui.ds_status_ok', '正常') : t('webui.ds_status_off', '停用')) + '</span></td>' +
        '<td><span class="ds-actions">' +
          '<button type="button" title="' + attr(t('webui.pro_datasource_edit', '编辑')) + '" onclick="editDatasource(\'' + attr(ds.id) + '\')">✏️</button>' +
          (state.dirsAvailable ? '<button type="button" title="' + attr(t('webui.ds_move_title', '移动数据源')) + '" onclick="FusionDataSources.moveDs(\'' + attr(ds.id) + '\')">📁</button>' : '') +
          '<button type="button" title="' + attr(t('webui.pro_datasource_test', '测试连接')) + '" onclick="testDatasourceConnection(\'' + attr(ds.id) + '\')">🔗</button>' +
          '<button type="button" class="danger" title="' + attr(t('webui.pro_datasource_delete_btn', '删除')) + '" onclick="deleteDatasource(\'' + attr(ds.id) + '\')">🗑</button>' +
        '</span></td>' +
      '</tr>';
    }).join('');
  }

  function render() {
    renderTree();
    renderTable();
  }

  async function load() {
    try {
      await ensureDbTypes();
      // 目录接口可能尚未部署（旧版后端）：失败时降级为单层「未分配」，不阻塞数据源列表
      var dirsData = null;
      try {
        var dirsRes = await fetch('/api/pro/dirs', { credentials: 'same-origin' });
        if (dirsRes.ok) dirsData = await dirsRes.json();
      } catch (e) { /* fallback below */ }

      var dsRes = await fetch('/api/pro/datasources', { credentials: 'same-origin' });
      var dsData = await dsRes.json();
      if (!dsData.ok) throw new Error(dsData.error || t('webui.ds_load_fail', '数据源加载失败'));
      state.data = dsData.datasources || [];

      if (!dirsData || !dirsData.ok || !Array.isArray(dirsData.dirs) || !dirsData.dirs.length) {
        state.dirsAvailable = false;
        dirsData = {
          ok: true,
          dirs: [{
            id: 'dir_unassigned', parent_id: '', name: t('webui.ds_unassigned', '未分配'),
            full_path: t('webui.ds_unassigned', '未分配'), kind: 'unassigned',
            color: '#888888', sort_order: -1, count: state.data.length
          }]
        };
      } else {
        state.dirsAvailable = true;
      }
      state.dirs = dirsData.dirs || [];
      if (state.currentDir && !dirById(state.currentDir) && state.currentDir !== 'dir_unassigned') {
        state.currentDir = '';
      }
      render();
    } catch (e) {
      if (typeof toastError === 'function') toastError(t('webui.ds_load_fail', '数据源加载失败') + ': ' + e.message);
      var tbody = $('ds-tbody');
      if (tbody) tbody.innerHTML = '';
      var empty = $('ds-empty');
      if (empty) {
        empty.style.display = '';
        empty.textContent = t('webui.ds_load_fail', '数据源加载失败') + '：' + e.message;
      }
    }
  }

  function onSearch(value) {
    state.search = String(value || '').trim().toLowerCase();
    renderTable();
  }

  function setView(view) {
    state.view = view === 'label' ? 'label' : 'dir';
    state.currentDir = '';
    state.currentLabel = '';
    var dirBtn = $('ds-view-dir');
    var labelBtn = $('ds-view-label');
    if (dirBtn) dirBtn.classList.toggle('active', state.view === 'dir');
    if (labelBtn) labelBtn.classList.toggle('active', state.view === 'label');
    render();
  }

  function selectNode(el) {
    var special = el.getAttribute('data-special');
    var id = el.getAttribute('data-id') || '';
    if (special === 'label') {
      state.currentLabel = id;
    } else {
      state.currentDir = id;
      expandAncestors(id);
    }
    render();
  }

  function toggleNode(id) {
    state.collapsed[id] = !state.collapsed[id];
    saveCollapsed();
    renderTree();
  }

  function filterLabel(label) {
    state.view = 'label';
    state.currentLabel = label;
    var dirBtn = $('ds-view-dir');
    var labelBtn = $('ds-view-label');
    if (dirBtn) dirBtn.classList.remove('active');
    if (labelBtn) labelBtn.classList.add('active');
    render();
  }

  // ── 目录 CRUD ──────────────────────────────────────────

  function openDirModal(title, name, color, onSubmit) {
    var old = $('ds-dir-modal-backdrop');
    if (old) old.remove();
    var html = '<div id="ds-dir-modal-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999999;display:flex;align-items:center;justify-content:center;padding:16px">' +
      '<div style="background:var(--surface-solid,var(--surface));border:1px solid var(--border);border-radius:12px;padding:20px;width:min(360px,100%);box-sizing:border-box;box-shadow:0 10px 40px rgba(0,0,0,.3)">' +
        '<div style="font-size:15px;font-weight:600;margin-bottom:14px">' + esc(title) + '</div>' +
        '<div style="display:grid;gap:12px">' +
          '<div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">' + esc(t('webui.ds_dir_name', '目录名称')) + '</label>' +
            '<input id="ds-dir-name" value="' + attr(name || '') + '" placeholder="如：华东 / 上海机房 / 核心业务" style="width:100%;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;box-sizing:border-box"></div>' +
          '<div><label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">' + esc(t('webui.ds_dir_color', '颜色')) + '</label>' +
            '<input id="ds-dir-color" type="color" value="' + attr(color || '#378ADD') + '" style="width:42px;height:28px;padding:0;border:1px solid var(--border);border-radius:6px;background:transparent;cursor:pointer"></div>' +
        '</div>' +
        '<div id="ds-dir-msg" style="margin-top:10px;font-size:12px;min-height:16px"></div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">' +
          '<button class="btn btn-ghost" type="button" onclick="document.getElementById(\'ds-dir-modal-backdrop\').remove()">' + esc(t('webui.ds_cancel', '取消')) + '</button>' +
          '<button class="btn btn-primary" type="button" id="ds-dir-save">' + esc(t('webui.ds_save', '保存')) + '</button>' +
        '</div>' +
      '</div></div>';
    document.documentElement.insertAdjacentHTML('beforeend', html);
    var input = $('ds-dir-name');
    if (input) { input.focus(); input.select(); }
    $('ds-dir-save').onclick = async function () {
      var val = ($('ds-dir-name').value || '').trim();
      var col = $('ds-dir-color').value || '#378ADD';
      var msg = $('ds-dir-msg');
      if (!val) { msg.style.color = 'var(--danger)'; msg.textContent = t('webui.ds_dir_name_required', '请输入目录名称'); return; }
      try {
        await onSubmit(val, col);
      } catch (e) {
        msg.style.color = 'var(--danger)';
        msg.textContent = e.message;
      }
    };
  }

  function newDir(parentId) {
    openDirModal(parentId ? t('webui.ds_dir_new_child', '新建子目录') : t('webui.ds_dir_new', '新建目录'), '', '#378ADD', async function (name, color) {
      var res = await fetch('/api/pro/dirs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: name, parent_id: parentId || '', color: color })
      });
      var data = await res.json();
      if (!data.ok) throw new Error(data.message || data.error || '创建失败');
      $('ds-dir-modal-backdrop').remove();
      if (typeof toastSuccess === 'function') toastSuccess(t('webui.ds_dir_created', '目录已创建'));
      await load();
    });
  }

  function renameDir(id) {
    var d = dirById(id);
    if (!d) return;
    openDirModal(t('webui.ds_dir_rename', '重命名目录'), d.name, d.color || '#378ADD', async function (name, color) {
      var res = await fetch('/api/pro/dirs/' + encodeURIComponent(id), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: name, color: color })
      });
      var data = await res.json();
      if (!data.ok) throw new Error(data.message || data.error || '更新失败');
      $('ds-dir-modal-backdrop').remove();
      if (typeof toastSuccess === 'function') toastSuccess(t('webui.ds_dir_updated', '目录已更新'));
      await load();
    });
  }

  function deleteDir(id) {
    var d = dirById(id);
    if (!d) return;
    var msg = t('webui.ds_dir_delete_msg', '目录「{}」将被删除。其中的数据源和子目录会移动到上级目录；未分配目录不可删除。')
      .replace('{}', d.full_path || d.name);
    if (typeof showConfirmModal === 'function') {
      showConfirmModal(t('webui.ds_dir_delete', '删除目录'), esc(msg), async function () {
        try {
          var res = await fetch('/api/pro/dirs/' + encodeURIComponent(id) + '?mode=move_parent', {
            method: 'DELETE', credentials: 'same-origin'
          });
          var data = await res.json();
          if (!data.ok) throw new Error(data.message || data.error || '删除失败');
          if (state.currentDir === id) state.currentDir = '';
          if (typeof toastSuccess === 'function') toastSuccess(t('webui.ds_dir_deleted', '目录已删除'));
          await load();
        } catch (e) {
          if (typeof toastError === 'function') toastError(e.message);
        }
      });
    }
  }

  // ── 移动数据源：内嵌目录树，直接看到层级再决定放哪 ──
  var moveCtx = null;

  function closeMoveModal() {
    var old = $('ds-move-modal-backdrop');
    if (old) old.remove();
    moveCtx = null;
    document.removeEventListener('mousedown', onMoveDocMouseDown, true);
    document.removeEventListener('keydown', onMoveKeyDown, true);
  }

  function onMoveDocMouseDown(ev) {
    var dialog = $('ds-move-modal-dialog');
    if (dialog && !dialog.contains(ev.target)) closeMoveModal();
  }

  function onMoveKeyDown(ev) {
    if (ev.key !== 'Escape') return;
    if ($('ds-dir-picker-backdrop')) return;   // 目录选择器在最上层，先交给它处理
    closeMoveModal();
  }

  async function moveDs(id) {
    var ds = null;
    for (var i = 0; i < state.data.length; i++) {
      if (state.data[i].id === id) { ds = state.data[i]; break; }
    }
    if (!ds) return;
    var ctx;
    try {
      ctx = await fetchDirTree(ds.dir_id || 'dir_unassigned');
    } catch (e) {
      if (typeof toastError === 'function') toastError(e.message);
      return;
    }
    closeMoveModal();
    moveCtx = ctx;

    var html = '<div id="ds-move-modal-backdrop" class="ds-move-backdrop">' +
      '<div id="ds-move-modal-dialog" class="ds-dir-picker ds-move-box" role="dialog" aria-modal="true">' +
        '<div class="ds-move-title">' + esc(t('webui.ds_move_title', '移动数据源')) + '</div>' +
        '<div class="ds-move-sub">' + esc(ds.name || ds.host || id) + '</div>' +
        '<div class="ds-picker-tree-wrap ds-move-tree"><div id="ds-move-tree" class="ds-picker-tree" role="tree"></div></div>' +
        '<div class="ds-picker-current">' +
          '<span>' + esc(t('webui.ds_picker_selected', '当前选择')) + '：</span>' +
          '<strong id="ds-move-path"></strong>' +
        '</div>' +
        '<div id="ds-move-msg" class="ds-move-msg"></div>' +
        '<div class="ds-move-actions">' +
          '<button class="btn btn-ghost" type="button" id="ds-move-cancel">' + esc(t('webui.ds_cancel', '取消')) + '</button>' +
          '<button class="btn btn-primary" type="button" id="ds-move-save">' + esc(t('webui.ds_move_btn', '移动到该目录')) + '</button>' +
        '</div>' +
      '</div></div>';
    (document.body || document.documentElement).insertAdjacentHTML('beforeend', html);
    bindDirTree({ rootId: 'ds-move-tree', ctx: ctx, pathId: 'ds-move-path' });

    $('ds-move-cancel').onclick = closeMoveModal;
    $('ds-move-save').onclick = async function () {
      var target = moveCtx ? moveCtx.selected : 'dir_unassigned';
      var msg = $('ds-move-msg');
      try {
        var res = await fetch('/api/pro/datasources/' + encodeURIComponent(id) + '/move', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ dir_id: target })
        });
        var data = await res.json();
        if (!data.ok) throw new Error(data.message || data.error || '移动失败');
        closeMoveModal();
        if (typeof toastSuccess === 'function') toastSuccess(t('webui.ds_moved', '数据源已移动'));
        await load();
      } catch (e) {
        if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = e.message; }
      }
    };
    document.addEventListener('mousedown', onMoveDocMouseDown, true);
    document.addEventListener('keydown', onMoveKeyDown, true);
  }

  // ── 目录右键菜单 ──────────────────────────────────────────
  var ctxMenu = null;

  function closeContextMenu() {
    if (ctxMenu) {
      ctxMenu.remove();
      ctxMenu = null;
      document.removeEventListener('mousedown', onCtxDocMouseDown, true);
      document.removeEventListener('keydown', onCtxKeyDown, true);
      window.removeEventListener('resize', closeContextMenu);
      window.removeEventListener('scroll', closeContextMenu, true);
    }
  }

  function onCtxDocMouseDown(ev) {
    if (ctxMenu && !ctxMenu.contains(ev.target)) closeContextMenu();
  }

  function onCtxKeyDown(ev) {
    if (ev.key === 'Escape') closeContextMenu();
  }

  function menuButton(label, action, nodeId, danger) {
    return '<button type="button" class="ds-ctx-item' + (danger ? ' danger' : '') + '" role="menuitem" ' +
      'data-action="' + attr(action) + '" data-node-id="' + attr(nodeId || '') + '">' + esc(label) + '</button>';
  }

  function openContextMenu(nodeId, x, y) {
    closeContextMenu();
    if (state.view !== 'dir' || !isAdmin() || !state.dirsAvailable) return;
    if (nodeId === 'dir_unassigned') return;

    var html;
    if (nodeId) {
      html = '<div id="ds-ctx-menu" class="ds-ctx-menu" role="menu">' +
        menuButton(t('webui.ds_dir_new_child', '新建子目录'), 'new-child', nodeId) +
        menuButton(t('webui.ds_dir_rename', '重命名目录'), 'rename', nodeId) +
        menuButton(t('webui.ds_dir_delete', '删除目录'), 'delete', nodeId, true) +
        '</div>';
    } else {
      html = '<div id="ds-ctx-menu" class="ds-ctx-menu" role="menu">' +
        menuButton(t('webui.ds_dir_new', '新建目录'), 'new') +
        '</div>';
    }
    (document.body || document.documentElement).insertAdjacentHTML('beforeend', html);
    ctxMenu = $('ds-ctx-menu');
    if (!ctxMenu) return;

    var rect = ctxMenu.getBoundingClientRect();
    var left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    var top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    ctxMenu.style.left = left + 'px';
    ctxMenu.style.top = top + 'px';

    ctxMenu.addEventListener('click', function (ev) {
      var item = ev.target.closest ? ev.target.closest('.ds-ctx-item') : null;
      if (!item) return;
      var action = item.getAttribute('data-action');
      var targetId = item.getAttribute('data-node-id') || '';
      closeContextMenu();
      if (action === 'new') newDir('');
      else if (action === 'new-child') newDir(targetId);
      else if (action === 'rename') renameDir(targetId);
      else if (action === 'delete') deleteDir(targetId);
    });

    document.addEventListener('mousedown', onCtxDocMouseDown, true);
    document.addEventListener('keydown', onCtxKeyDown, true);
    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('scroll', closeContextMenu, true);
  }

  // ── 目录选择器：数据源表单里显示原始层级，不再依赖扁平下拉 ──
  var dirPicker = null;

  function dirTreeCtx(dirs, unassigned, selected) {
    var list = (dirs || []).filter(function (d) { return d && d.id && d.id !== 'dir_unassigned'; });
    return {
      dirs: list,
      unassignedCount: unassigned ? (unassigned.count || 0) : 0,
      selected: selected || 'dir_unassigned',
      query: '',
      collapsed: {},
      ancestors: {}
    };
  }

  function ctxChildren(ctx, parentId) {
    if (!ctx) return [];
    return ctx.dirs
      .filter(function (d) { return (d.parent_id || '') === (parentId || ''); })
      .sort(function (a, b) {
        return (a.sort_order || 0) - (b.sort_order || 0) ||
          String(a.full_path || a.name || '').localeCompare(String(b.full_path || b.name || ''));
      });
  }

  function ctxVisible(ctx, d) {
    if (!ctx || !ctx.query) return true;
    var hay = String(d.full_path || d.name || '').toLowerCase();
    if (hay.indexOf(ctx.query) !== -1) return true;
    return ctxChildren(ctx, d.id).some(function (k) { return ctxVisible(ctx, k); });
  }

  function ctxPath(ctx, id) {
    if (!id || id === 'dir_unassigned') return t('webui.ds_unassigned', '未分配');
    var pool = (ctx && ctx.dirs && ctx.dirs.length) ? ctx.dirs : (state.dirs || []);
    var d = pool.filter(function (x) { return x.id === id; })[0];
    return d ? (d.full_path || d.name) : id;
  }

  function ctxAncestors(ctx, id) {
    var out = {};
    if (!ctx) return out;
    var d = ctx.dirs.filter(function (x) { return x.id === id; })[0];
    while (d && d.parent_id) {
      out[d.parent_id] = true;
      d = ctx.dirs.filter(function (x) { return x.id === d.parent_id; })[0];
    }
    return out;
  }

  function ctxExpandAncestors(ctx, id) {
    if (!ctx) return;
    var d = ctx.dirs.filter(function (x) { return x.id === id; })[0];
    while (d && d.parent_id) {
      ctx.collapsed[d.parent_id] = false;
      d = ctx.dirs.filter(function (x) { return x.id === d.parent_id; })[0];
    }
  }

  function ctxBranchHtml(ctx, d) {
    var kids = ctxChildren(ctx, d.id).filter(function (k) { return ctxVisible(ctx, k); });
    var collapsed = !ctx.query && !!ctx.collapsed[d.id];
    var selected = ctx.selected === d.id;
    var ancestor = !!ctx.ancestors[d.id];
    var html = '<div class="ds-picker-branch">' +
      '<div class="ds-picker-node' + (selected ? ' selected' : '') + (ancestor ? ' ancestor' : '') + '"' +
      ' role="treeitem" aria-selected="' + (selected ? 'true' : 'false') + '" data-id="' + attr(d.id) + '"' +
      ' title="' + attr(d.full_path || d.name) + '">' +
      (kids.length ? '<span class="ds-picker-caret">' + (collapsed ? '▸' : '▾') + '</span>' : '<span class="ds-picker-caret"></span>') +
      '<span class="ds-picker-icon">' + (kids.length && !collapsed ? '📂' : '📁') + '</span>' +
      '<span class="ds-picker-label">' + esc(d.name) + '</span>' +
      '<span class="ds-picker-count">' + (d.count || 0) + '</span></div>';
    if (kids.length && !collapsed) {
      html += '<div class="ds-picker-children">' + kids.map(function (k) { return ctxBranchHtml(ctx, k); }).join('') + '</div>';
    }
    return html + '</div>';
  }

  // 渲染目录树；层级用缩进 + 竖线保留，选中项的祖先链高亮
  function renderDirTree(ctx, rootId, pathId) {
    var root = $(rootId);
    if (!root || !ctx) return;
    var kids = ctxChildren(ctx, '').filter(function (d) { return ctxVisible(ctx, d); });
    var html = kids.map(function (d) { return ctxBranchHtml(ctx, d); }).join('');
    var selected = ctx.selected === 'dir_unassigned';
    html += '<div class="ds-picker-node' + (selected ? ' selected' : '') + '" role="treeitem"' +
      ' aria-selected="' + (selected ? 'true' : 'false') + '" data-id="dir_unassigned">' +
      '<span class="ds-picker-caret"></span><span class="ds-picker-icon">📂</span>' +
      '<span class="ds-picker-label">' + esc(t('webui.ds_unassigned', '未分配')) + '</span>' +
      '<span class="ds-picker-count">' + (ctx.unassignedCount || 0) + '</span></div>';
    root.innerHTML = html;
    var pathEl = $(pathId);
    if (pathEl) pathEl.textContent = ctxPath(ctx, ctx.selected);
  }

  function bindDirTree(opts) {
    var root = $(opts.rootId);
    if (!root || !opts.ctx) return;
    var ctx = opts.ctx;
    var redraw = function () { renderDirTree(ctx, opts.rootId, opts.pathId); };
    ctx.ancestors = ctxAncestors(ctx, ctx.selected);
    root.addEventListener('click', function (ev) {
      var caret = ev.target.closest ? ev.target.closest('.ds-picker-caret') : null;
      var node = ev.target.closest ? ev.target.closest('.ds-picker-node[data-id]') : null;
      if (!node) return;
      ctx.selected = node.getAttribute('data-id');
      ctx.ancestors = ctxAncestors(ctx, ctx.selected);
      if (caret) ctx.collapsed[ctx.selected] = !ctx.collapsed[ctx.selected];
      redraw();
      if (opts.onSelect) opts.onSelect(ctx.selected);
    });
    if (opts.onDblClick) root.addEventListener('dblclick', opts.onDblClick);
    var search = opts.searchId ? $(opts.searchId) : null;
    if (search) {
      search.addEventListener('input', function (ev) {
        ctx.query = String(ev.target.value || '').trim().toLowerCase();
        redraw();
      });
    }
    redraw();
  }

  function closeDirPicker() {
    var old = $('ds-dir-picker-backdrop');
    if (old) old.remove();
    dirPicker = null;
    document.removeEventListener('mousedown', onPickerDocMouseDown, true);
    document.removeEventListener('keydown', onPickerKeyDown, true);
  }

  function onPickerDocMouseDown(ev) {
    var dialog = $('ds-dir-picker-dialog');
    if (dialog && !dialog.contains(ev.target)) closeDirPicker();
  }

  function onPickerKeyDown(ev) {
    if (ev.key === 'Escape') closeDirPicker();
  }

  function setDirValue(valueId, labelId, id) {
    var path = ctxPath(dirPicker, id);
    var valueEl = $(valueId);
    if (valueEl && valueEl.tagName === 'SELECT') {
      var has = Array.prototype.some.call(valueEl.options, function (o) { return o.value === id; });
      if (!has) {
        var opt = document.createElement('option');
        opt.value = id;
        opt.textContent = path;
        valueEl.appendChild(opt);
      }
    }
    if (valueEl) {
      valueEl.value = id;
      valueEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    var labelEl = labelId ? $(labelId) : null;
    if (labelEl) labelEl.value = path;
  }

  function confirmDirPicker() {
    if (!dirPicker) return;
    var id = dirPicker.selected || 'dir_unassigned';
    setDirValue(dirPicker.valueId, dirPicker.labelId, id);
    closeDirPicker();
  }

  function clearDirPicker(valueId, labelId) {
    setDirValue(valueId, labelId, 'dir_unassigned');
  }

  async function fetchDirTree(selectedId) {
    var res = await fetch('/api/pro/dirs', { credentials: 'same-origin' });
    var data = await res.json();
    if (!data.ok) throw new Error(data.error || data.message || t('webui.ds_load_fail', '数据源加载失败'));
    var unassigned = (data.dirs || []).filter(function (d) { return d.id === 'dir_unassigned'; })[0];
    var ctx = dirTreeCtx(data.dirs, unassigned, selectedId);
    ctxExpandAncestors(ctx, ctx.selected);
    return ctx;
  }

  async function openDirPicker(valueId, labelId) {
    closeDirPicker();
    var valueEl = $(valueId);
    var ctx;
    try {
      ctx = await fetchDirTree((valueEl && valueEl.value) || 'dir_unassigned');
    } catch (e) {
      if (typeof toastError === 'function') toastError(e.message);
      return;
    }
    dirPicker = ctx;
    dirPicker.valueId = valueId;
    dirPicker.labelId = labelId || '';

    var html = '<div id="ds-dir-picker-backdrop" class="ds-dir-picker-backdrop">' +
      '<div id="ds-dir-picker-dialog" class="ds-dir-picker" role="dialog" aria-modal="true">' +
        '<div class="ds-dir-picker-title">' + esc(t('webui.ds_picker_title', '选择目录')) + '</div>' +
        '<input id="ds-picker-search" class="ds-picker-search" type="search" placeholder="' +
          attr(t('webui.ds_picker_search', '搜索目录...')) + '" autocomplete="off" />' +
        '<div class="ds-picker-tree-wrap"><div id="ds-picker-tree" class="ds-picker-tree" role="tree"></div></div>' +
        '<div class="ds-picker-current">' +
          '<span>' + esc(t('webui.ds_picker_selected', '当前选择')) + '：</span>' +
          '<strong id="ds-picker-path"></strong>' +
        '</div>' +
        '<div class="ds-dir-picker-actions">' +
          '<button class="btn btn-ghost" type="button" id="ds-picker-cancel">' + esc(t('webui.ds_cancel', '取消')) + '</button>' +
          '<button class="btn btn-primary" type="button" id="ds-picker-confirm">' + esc(t('webui.ds_picker_confirm', '选择')) + '</button>' +
        '</div>' +
      '</div></div>';
    (document.body || document.documentElement).insertAdjacentHTML('beforeend', html);
    bindDirTree({
      rootId: 'ds-picker-tree', ctx: dirPicker,
      pathId: 'ds-picker-path', searchId: 'ds-picker-search',
      onDblClick: confirmDirPicker
    });
    $('ds-picker-cancel').onclick = closeDirPicker;
    $('ds-picker-confirm').onclick = confirmDirPicker;
    document.addEventListener('mousedown', onPickerDocMouseDown, true);
    document.addEventListener('keydown', onPickerKeyDown, true);
    $('ds-picker-search').focus();
  }

  // 目录树展开/收起：点击 caret 不触发筛选
  document.addEventListener('click', function (ev) {
    var caret = ev.target.closest ? ev.target.closest('[data-caret]') : null;
    if (!caret) return;
    ev.stopPropagation();
    toggleNode(caret.getAttribute('data-caret'));
  }, true);

  // 标签 chip 使用事件委托，避免把用户标签拼进 inline onclick（XSS/引号断裂）
  document.addEventListener('click', function (ev) {
    var chip = ev.target.closest ? ev.target.closest('.ds-label-chip[data-label]') : null;
    if (!chip) return;
    ev.stopPropagation();
    filterLabel(chip.getAttribute('data-label'));
  }, true);

  // 目录管理统一走右键菜单，节点上不再常驻操作按钮
  document.addEventListener('contextmenu', function (ev) {
    var panel = ev.target.closest ? ev.target.closest('#page-datasources .ds-tree-panel') : null;
    closeContextMenu();
    if (!panel) return;
    if (state.view !== 'dir' || !isAdmin() || !state.dirsAvailable) return;

    var node = ev.target.closest ? ev.target.closest('.ds-tree-node') : null;
    var special = node ? node.getAttribute('data-special') : '';
    var id = node ? node.getAttribute('data-id') : '';
    if (special === 'label' || id === 'dir_unassigned') return;

    ev.preventDefault();
    openContextMenu(id, ev.clientX, ev.clientY);
  }, true);

  loadCollapsed();

  window.FusionDataSources = {
    load: load,
    render: render,
    onSearch: onSearch,
    setView: setView,
    selectNode: selectNode,
    filterLabel: filterLabel,
    newDir: newDir,
    renameDir: renameDir,
    deleteDir: deleteDir,
    moveDs: moveDs,
    showContextMenu: openContextMenu,
    openDirPicker: openDirPicker,
    clearDirPicker: clearDirPicker
  };
})();
