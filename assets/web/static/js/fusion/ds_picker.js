/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * 共享组件：数据源选择器（左侧目录树筛选 / 右侧数据源表格选择）。
 * 对外只暴露 window.FusionDsPicker.open(opts)，返回一个 Promise，三种结果必须分清楚：
 *   · 确定          → 数据源对象（多选时是数组）
 *   · 清除选择      → null（用户主动表示「不指定数据源」）
 *   · 取消 / ✕ /
 *     点遮罩 / Esc  → undefined（用户什么都没改）
 * 少一种语义就会把「取消」当成「清空」执行，直接抹掉用户已经选好的数据源。
 * 其余行为：单选单击一行即选中并关闭；多选在 sameType 下勾选首个即锁定数据库类型、
 * 跨类型整行禁用；工具条可按类型筛选，可搜索名称 / 主机 / 描述 / 目录 / 标签。
 */
(function () {
  'use strict';

  // 同一引擎在不同页面写法不同（oracle / oracle_full、mssql / sqlserver）。
  // 锁类型前必须归一，否则批量执行会把两类当同类混跑，跑到一半报语法错。
  var TYPE_ALIAS = { postgresql: 'pg', mssql: 'sqlserver', dm8: 'dm', oracle_full: 'oracle',
    // 本仓库特有的口径差异：这里同一个引擎按「连接方式」再分一档（oracle_jdbc /
    // sqlserver_jdbc / uxdb_jdbc…）。不归一就会把
    // 「Oracle JDBC」和「Oracle thin」当两种数据库类型 —— 批量弹窗里同类库被拆开、
    // 同类型锁定也锁不住（用户反馈的「批量弹窗要能按数据库类型筛选」根因之一）。
    oracle_jdbc: 'oracle', sqlserver_jdbc: 'sqlserver', mysql_jdbc: 'mysql',
    postgresql_jdbc: 'pg', postgres_jdbc: 'pg', dm_jdbc: 'dm', dm8_jdbc: 'dm',
    oracle_thin: 'oracle', uxdb_jdbc: 'uxdb' };

  function normType(value) {
    var lower = String(value || '').toLowerCase().trim();
    if (TYPE_ALIAS[lower]) return TYPE_ALIAS[lower];
    // 兜底：任何没列进别名表的 *_jdbc / *_thin 写法都退化成引擎名本身
    if (/_jdbc$|_thin$/.test(lower)) {
      var base = lower.replace(/_jdbc$|_thin$/, '');
      return TYPE_ALIAS[base] || base;
    }
    return lower;
  }

  function t(key, fallback) {
    try {
      if (typeof window.i18n === 'function') {
        var value = window.i18n(key);
        if (value && value !== key) return value;
      }
    } catch (e) { /* i18n 未就绪时用中文原文兜底 */ }
    return fallback || key;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 本仓库壳层的全局提示出口是 index.html 里的 toast(msg, type)，
  // 不是旧版的 showToast/toastError —— 认错名字，加载失败就会一声不吭。
  function notify(message, level) {
    try {
      if (typeof window.toast === 'function') { window.toast(message, level || 'info'); return; }
      if (level === 'error') console.error('[ds-picker] ' + message);
    } catch (e) { /* ignore */ }
  }

  var CARET = '<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  var ICONS = {
    region: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z"/></svg>',
    env: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></svg>',
    custom: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
    label: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.2"/></svg>'
  };

  // ── 数据：目录 + 数据源一次拉全，8 秒短缓存 + 共享 in-flight ──────────
  // 页面加载时多个下拉会同时请求，合并成一次；但选择器必须看到最新列表
  // （刚登记的库要能立刻选到），所以 open 时强制刷新。
  var dataCache = { data: null, ts: 0 };
  var dataPromise = null;

  function requestJson(url) {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (res) { return res.json(); });
  }

  function pickerData(force) {
    var now = Date.now();
    if (!force && dataCache.data && now - dataCache.ts < 8000) return Promise.resolve(dataCache.data);
    if (!force && dataPromise) return dataPromise;
    var pending = Promise.all([
      requestJson('/api/pro/dirs').catch(function () { return { ok: false, dirs: [] }; }),
      requestJson('/api/pro/datasources').catch(function () { return { ok: false, datasources: [] }; })
    ]).then(function (results) {
      var dirsRes = results[0] || {};
      var dsRes = results[1] || {};
      return {
        dirs: (dirsRes.ok && dirsRes.dirs) ? dirsRes.dirs : [],
        list: (dsRes.ok && dsRes.datasources) ? dsRes.datasources : []
      };
    });
    if (!force) dataPromise = pending;
    return pending.then(function (data) {
      dataCache = { data: data, ts: Date.now() };
      if (dataPromise === pending) dataPromise = null;
      return data;
    }, function (err) {
      if (dataPromise === pending) dataPromise = null;
      throw err;
    });
  }

  function dirNameById(dirs, id) {
    for (var i = 0; i < (dirs || []).length; i++) {
      if (dirs[i].id === id) return dirs[i].full_path || dirs[i].name;
    }
    return '';
  }

  /** 搜索口径：名称 / 主机 / 描述 / 目录 / 标签 任一字段命中即可。 */
  function matchesSearch(item, search) {
    if (!search) return true;
    var haystack = [item.name, item.host, item.description, item.dir_path,
                    (item.labels || []).join(' ')].join(' ').toLowerCase();
    return haystack.indexOf(String(search).toLowerCase()) >= 0;
  }

  /**
   * opts：title / subtitle / multi / sameType / allowClear / clearLabel /
   * selected（名称或 id 数组）/ dataList（限定候选）/ dbType / allowedTokens(Set)。
   * 返回 Promise，resolve 语义见文件头。
   */
  function open(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var previous = document.getElementById('ds-picker-overlay');
      if (previous && previous.parentNode) previous.parentNode.removeChild(previous);

      // 取数失败不能把异常抛给调用方：连「同步抛错」（fetch 本身炸了）也要一起兜住，
      // 所以手动转成 rejected Promise 交给下面的 .catch 提示并 resolve(undefined)。
      // 少了这一层，错误会从 open() 里直接漏出去，调用方拿不到任何兜底结果。
      var pending;
      try {
        pending = pickerData(true);
      } catch (syncError) {
        pending = Promise.reject(syncError);
      }

      pending.then(function (data) {
        var list = Array.isArray(opts.dataList) ? opts.dataList.slice() : data.list.slice();
        if (opts.dbType) {
          var want = normType(opts.dbType);
          list = list.filter(function (item) { return normType(item.db_type) === want; });
        }
        if (opts.allowedTokens && opts.allowedTokens.size) {
          // 各页面 select 的 value 有的存 id 有的存名称，两种都认
          var filtered = list.filter(function (item) {
            return opts.allowedTokens.has(String(item.id)) ||
              opts.allowedTokens.has(String(item.name));
          });
          if (filtered.length) list = filtered;
        }
        var dirs = (data.dirs || []).slice();
        var dirMap = new Map(dirs.map(function (item) { return [item.id, item]; }));
        var multi = !!opts.multi;
        var sameType = !!opts.sameType;
        var unassigned = t('webui.ds_picker_unassigned', '未分配');

        // 「按数据库类型筛选」：批量执行同一套语句时，最想要的不是搜索而是「只看 Oracle」。
        // 目录树按业务区域分（深圳/上海…），类型是另一条正交的维度，所以放在工具条上，
        // 与搜索框并列；只有一个类型时不显示（没得筛，纯占位）。
        var typeChoices = (function () {
          var counts = {};
          list.forEach(function (item) {
            var key = normType(item.db_type);
            if (!key) return;
            counts[key] = (counts[key] || 0) + 1;
          });
          return Object.keys(counts).sort(function (a, b) {
            return counts[b] - counts[a] || (a < b ? -1 : 1);
          }).map(function (key) { return { type: key, count: counts[key] }; });
        })();
        var initialType = opts.dbType ? normType(opts.dbType) : '';
        // 下拉里的展示名走 i18n（key = webui.ds_picker_type.<归一键>），
        // 没配的类型退回大写键名兜底，不会出现空白选项。归一键本身是内部口径
        // （pg / sqlserver），直接拿来显示会和右表「类型」列的写法对不上。
        function typeLabel(key) {
          return t('webui.ds_picker_type.' + key, String(key || '').toUpperCase());
        }
        var typeSelectHtml = typeChoices.length > 1
          ? '<select id="ds-picker-type" class="ds-picker-type" aria-label="' +
            esc(t('webui.ds_picker_type_aria', '按数据库类型筛选')) + '">' +
            '<option value="">' + esc(t('webui.ds_picker_type_all', '全部类型')) + '</option>' +
            typeChoices.map(function (choice) {
              return '<option value="' + esc(choice.type) + '"' +
                (choice.type === initialType ? ' selected' : '') + '>' +
                esc(typeLabel(choice.type)) + '（' + choice.count + '）</option>';
            }).join('') + '</select>'
          : '';

        // 「全选本类型」：批量执行时逐个勾二十个同类库不现实，一个勾全部筛出来的。
        // 没选数据库类型时这个框是灰的、点不动 —— 一次批量只能跑同一类库（同一句 SQL
        // 换方言基本跑不通），先说清"批量要打到哪一类"，勾选范围才是确定的，
        // 否则一键勾出 Oracle+PG 混选，确定后要么报错要么静默漏库。
        var selAllHtml = multi
          ? '<label class="ds-picker-selall" id="ds-picker-selall-wrap">' +
            '<input type="checkbox" id="ds-picker-selall" tabindex="-1">' +
            '<span>' + esc(t('webui.ds_picker_selall', '全选本类型')) + '</span></label>'
          : '';

        var overlay = document.createElement('div');
        overlay.id = 'ds-picker-overlay';
        overlay.className = 'ds-picker-overlay';
        overlay.innerHTML =
          '<div class="ds-picker-box" role="dialog" aria-modal="true">' +
            '<div class="ds-picker-head">' +
              '<div><div class="ds-picker-title">' +
                esc(opts.title || t('webui.ds_picker_default_title', '选择数据源')) + '</div>' +
                '<div class="ds-picker-sub">' + esc(opts.subtitle ||
                  t('webui.ds_picker_subtitle', '左侧按目录筛选，右侧选择数据源')) + '</div></div>' +
              '<button type="button" class="ds-picker-close" aria-label="' +
                esc(t('webui.ds_picker_close', '关闭')) + '">✕</button>' +
            '</div>' +
            '<div class="ds-picker-toolbar">' +
              '<div class="ds-search-wrap"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
              '<input id="ds-picker-search" class="ds-search" autocomplete="off" placeholder="' +
                esc(t('webui.ds_picker_search_ph', '搜索名称 / IP / 标签')) + '"></div>' +
              typeSelectHtml +
              selAllHtml +
              '<span class="ds-picker-count" id="ds-picker-count"></span>' +
            '</div>' +
            '<div class="ds-picker-body">' +
              '<aside class="ds-picker-tree" id="ds-picker-tree"></aside>' +
              '<section class="ds-picker-main">' +
                '<div class="ds-picker-list-head"><span></span><span>' +
                  esc(t('webui.ds_picker_col_name', '名称 / 地址')) + '</span><span>' +
                  esc(t('webui.ds_picker_col_type', '类型')) + '</span><span>' +
                  esc(t('webui.ds_picker_col_dir', '目录')) + '</span><span>' +
                  esc(t('webui.ds_picker_col_labels', '标签')) + '</span></div>' +
                '<div class="ds-picker-rows" id="ds-picker-rows"></div>' +
              '</section>' +
            '</div>' +
            '<div class="ds-picker-foot">' +
              '<span class="ds-picker-hint" id="ds-picker-hint">' +
                esc(multi ? t('webui.ds_picker_hint_multi', '可多选，选择后点击「确定」')
                          : t('webui.ds_picker_hint_single', '单击一行即可选择')) + '</span>' +
              (opts.allowClear ? '<button type="button" class="btn btn-ghost" id="ds-picker-clear">' +
                esc(opts.clearLabel || t('webui.ds_picker_clear', '清除选择')) + '</button>' : '') +
              '<button type="button" class="btn btn-ghost" id="ds-picker-cancel">' +
                esc(t('webui.ds_picker_cancel', '取消')) + '</button>' +
              (multi ? '<button type="button" class="btn btn-primary" id="ds-picker-ok">' +
                esc(t('webui.ds_picker_ok', '确定')) + '</button>' : '') +
            '</div>' +
          '</div>';
        document.body.appendChild(overlay);

        // opts.selected 存的可能是名称也可能是 id，行匹配用 id —— 两者都要进同一个
        // Set 一起比对，否则回填的选中高亮永远不亮。
        var wanted = (opts.selected || []).map(String);
        function isSelected(item) {
          return wanted.indexOf(String(item.id)) >= 0 || wanted.indexOf(String(item.name)) >= 0;
        }
        var state = { search: '', dirId: null, selected: new Set(),
                      lockType: '', type: initialType, timer: 0 };
        list.forEach(function (item) { if (isSelected(item)) state.selected.add(String(item.id)); });
        var rowsEl = overlay.querySelector('#ds-picker-rows');
        var treeEl = overlay.querySelector('#ds-picker-tree');
        var countEl = overlay.querySelector('#ds-picker-count');
        var hintEl = overlay.querySelector('#ds-picker-hint');
        var okBtn = overlay.querySelector('#ds-picker-ok');
        if (multi && state.selected.size) {
          // 已选过同类库时把类型钉住：回填的旧选择不能让人再混进别的类型
          for (var s = 0; s < list.length; s++) {
            if (state.selected.has(String(list[s].id))) { state.lockType = normType(list[s].db_type); break; }
          }
        }

        var settled = false;
        function done(value) {
          if (settled) return;
          settled = true;
          document.removeEventListener('keydown', onKey);
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          resolve(value);
        }
        function onKey(event) { if (event.key === 'Escape') done(undefined); }
        document.addEventListener('keydown', onKey);

        function baseList() {
          var rows = list.filter(function (item) { return matchesSearch(item, state.search); });
          // 类型筛选与目录树是两条正交的维度：先按类型收窄，目录树计数与右侧表格都用
          // 收窄后的集合，否则「只看 Oracle」时左树还会显示 MySQL 的数量，点了出来是空的。
          if (state.type) {
            rows = rows.filter(function (item) { return normType(item.db_type) === state.type; });
          }
          return rows;
        }

        function inDir(item, prefix) {
          var path = item.dir_path || '';
          return path === prefix || path.indexOf(prefix + '/') === 0;
        }

        function rowsList() {
          var rows = baseList();
          if (!state.dirId) return rows;
          if (state.dirId === 'dir_unassigned') {
            return rows.filter(function (item) { return !item.dir_path || item.dir_path === unassigned; });
          }
          var dir = dirMap.get(state.dirId);
          var prefix = dir ? (dir.full_path || dir.name) : '';
          return prefix ? rows.filter(function (item) { return inDir(item, prefix); }) : rows;
        }

        function renderTree() {
          var base = baseList();
          var html = '<div class="ds-tree-node' + (state.dirId === null ? ' active' : '') +
            '" data-pdir="" style="padding-left:8px">' +
            '<span class="ds-tree-caret empty">' + CARET + '</span>' +
            '<span class="ds-tree-icon">' + ICONS.custom + '</span>' +
            '<span class="ds-tree-name">' + esc(t('webui.ds_picker_all', '全部数据源')) + '</span>' +
            '<span class="ds-tree-count">' + base.length + '</span></div>';
          var children = new Map();
          dirs.forEach(function (item) {
            var parent = item.parent_id || '';
            if (!children.has(parent)) children.set(parent, []);
            children.get(parent).push(item);
          });
          children.forEach(function (arr) {
            arr.sort(function (a, b) {
              return (a.sort_order || 0) - (b.sort_order || 0) ||
                String(a.name).localeCompare(String(b.name));
            });
          });
          function countFor(dir) {
            return base.filter(function (item) {
              return inDir(item, dir.full_path || dir.name);
            }).length;
          }
          function walk(parent, level) {
            (children.get(parent) || []).forEach(function (dir) {
              var count = countFor(dir);
              // 选择器只展示有数据源的目录（含其祖先），空目录不干扰视线
              if (!count) return;
              html += '<div class="ds-tree-node' + (state.dirId === dir.id ? ' active' : '') +
                '" data-pdir="' + esc(dir.id) + '" style="padding-left:' + (8 + level * 14) + 'px">' +
                '<span class="ds-tree-caret empty">' + CARET + '</span>' +
                '<span class="ds-tree-icon" style="color:' + esc(dir.color || 'inherit') + '">' +
                (ICONS[dir.kind] || ICONS.custom) + '</span>' +
                '<span class="ds-tree-name" title="' + esc(dir.full_path || dir.name) + '">' +
                esc(dir.name) + '</span>' +
                '<span class="ds-tree-count">' + (count || '') + '</span></div>';
              walk(dir.id, level + 1);
            });
          }
          walk('', 0);
          treeEl.innerHTML = html;
        }

        function rowHtml(item) {
          var id = String(item.id);
          var isSel = state.selected.has(id);
          var type = normType(item.db_type);
          var typeDisabled = multi && sameType && state.lockType && state.lockType !== type;
          var labels = (item.labels || []).filter(Boolean);
          var chips = labels.slice(0, 2).map(function (label) {
            return '<span class="ds-label-chip">' + esc(label) + '</span>';
          }).join('') + (labels.length > 2
            ? '<span class="ds-label-chip">+' + (labels.length - 2) + '</span>' : '');
          var place = item.dir_path || unassigned;
          return '<div class="ds-picker-row' + (isSel ? ' selected' : '') +
            (typeDisabled ? ' disabled' : '') + '" data-pid="' + esc(id) + '">' +
            '<input type="' + (multi ? 'checkbox' : 'radio') + '"' + (isSel ? ' checked' : '') +
            ' tabindex="-1">' +
            '<div><div class="ds-picker-name" title="' + esc(item.name || '') + '">' +
              esc(item.name || '') + '</div>' +
            '<div class="ds-picker-name-sub">' + esc(item.db_type || '') + ' / ' +
              esc(item.host || '') + ':' + esc(item.port || '') + '</div></div>' +
            '<div class="ds-picker-cell">' + esc(String(item.db_type || '').toUpperCase()) + '</div>' +
            '<div class="ds-picker-cell" title="' + esc(place) + '">' + esc(place) + '</div>' +
            '<div class="ds-picker-labels">' + (chips || '<span class="ds-picker-cell">—</span>') + '</div>' +
          '</div>';
        }

        // 全选框的三态与可用性：勾的是「当前筛出来的同类库」。范围口径 = 目录/搜索筛完的行，
        // 再按类型收窄：下拉选了类型就按下拉的类型；没选下拉但已经手勾过某个库（lockType 生效）
        // 就按那个库的类型 —— 否则用户明明勾着 Oracle，全选框却因为"没选类型"一直灰着，是死路。
        var selAllWrap = overlay.querySelector('#ds-picker-selall-wrap');
        var selAll = overlay.querySelector('#ds-picker-selall');
        function eligibleRows() {
          var rows = rowsList();
          // 已锁定类型优先于下拉：下拉只是"看哪一类"，锁定才是"能勾哪一类"。
          // 反过来（下拉赢）会让「已勾 Oracle + 下拉切 PG」时一键把 PG 也混进同一批。
          var want = (sameType && state.lockType) ? state.lockType : state.type;
          return want ? rows.filter(function (item) { return normType(item.db_type) === want; }) : rows;
        }
        function selectAllBlocked() {
          if (!selAll) return true;
          // 多于一个类型、且类型与已勾库都没定：批量范围还没确定，框保持灰（不可用）
          return typeChoices.length > 1 && !state.type && !state.lockType;
        }
        function syncSelectAll() {
          if (!selAll) return;
          var visible = eligibleRows();
          var blocked = selectAllBlocked();
          var hit = visible.filter(function (item) {
            return state.selected.has(String(item.id));
          }).length;
          selAll.disabled = blocked || !visible.length;
          if (selAllWrap) {
            selAllWrap.className = 'ds-picker-selall' + (selAll.disabled ? ' is-off' : '');
            selAllWrap.title = selAll.disabled
              ? (blocked
                  ? t('webui.ds_picker_selall_need_type',
                      '先选数据库类型才能批量勾选（一次批量只能打同一类型的库）')
                  : t('webui.ds_picker_selall_none', '当前筛选结果没有可勾选的同类型数据源'))
              : t('webui.ds_picker_selall_tip', '勾选当前筛出的 {n} 个同类库').replace(
                  '{n}', visible.length);
          }
          selAll.checked = !selAll.disabled && hit > 0 && hit === visible.length;
          selAll.indeterminate = !selAll.disabled && hit > 0 && hit < visible.length;
        }

        function renderRows() {
          var rows = rowsList();
          countEl.textContent = t('webui.ds_picker_count', '{n} 个数据源').replace('{n}', rows.length);
          syncSelectAll(rows);
          if (!rows.length) {
            rowsEl.innerHTML = '<div class="ds-picker-empty">' +
              esc(t('webui.ds_picker_empty', '没有匹配的数据源')) +
              (state.search ? '（' + esc(t('webui.ds_picker_kw', '关键词')) + '：' +
                esc(state.search) + '）' : '') + '</div>';
            if (okBtn) okBtn.disabled = !state.selected.size;
            return;
          }
          rowsEl.innerHTML = rows.map(rowHtml).join('');
          if (okBtn) {
            okBtn.disabled = !state.selected.size;
            okBtn.textContent = t('webui.ds_picker_ok', '确定') + '（' + state.selected.size + '）';
          }
        }

        function refresh() { renderTree(); renderRows(); }

        treeEl.addEventListener('click', function (event) {
          var node = event.target.closest('[data-pdir]');
          if (!node) return;
          var id = node.getAttribute('data-pdir');
          state.dirId = id ? id : null;
          refresh();
        });

        rowsEl.addEventListener('click', function (event) {
          var row = event.target.closest('[data-pid]');
          if (!row || row.classList.contains('disabled')) return;
          var id = row.getAttribute('data-pid');
          var item = null;
          for (var i = 0; i < list.length; i++) {
            if (String(list[i].id) === id) { item = list[i]; break; }
          }
          if (!item) return;
          if (!multi) { done(item); return; }
          var type = normType(item.db_type);
          if (state.selected.has(id)) {
            state.selected.delete(id);
            if (sameType && state.lockType === type) {
              var still = list.some(function (other) {
                return state.selected.has(String(other.id)) && normType(other.db_type) === type;
              });
              if (!still) state.lockType = '';
            }
          } else {
            if (sameType && state.lockType && state.lockType !== type) {
              if (hintEl) {
                hintEl.textContent = t('webui.ds_picker_lock_hint',
                  '只能选择同一数据库类型（已锁定 {t}）').replace('{t}', state.lockType);
                hintEl.style.color = 'var(--warn)';
              }
              return;
            }
            state.selected.add(id);
            if (sameType) state.lockType = type;
          }
          renderRows();
        });

        overlay.querySelector('#ds-picker-search').addEventListener('input', function (event) {
          clearTimeout(state.timer);
          var value = event.target.value;
          // 250ms 防抖：边打字边过滤会把目录树和表格重绘几十次
          state.timer = setTimeout(function () {
            state.search = String(value || '').trim();
            refresh();
          }, 250);
        });
        var typeSelect = overlay.querySelector('#ds-picker-type');
        if (typeSelect) {
          typeSelect.onchange = function (event) {
            state.type = String(event.target.value || '');
            refresh();
          };
        }
        if (selAll) {
          selAll.onchange = function (event) {
            var visible = eligibleRows();
            if (selectAllBlocked() || !visible.length) {
              event.target.checked = false;      // 灰框点不动：不留半勾、也不改选择集
              syncSelectAll();
              return;
            }
            if (event.target.checked) {
              visible.forEach(function (item) { state.selected.add(String(item.id)); });
              if (sameType) state.lockType = normType(visible[0].db_type);
              if (hintEl) hintEl.style.color = '';
            } else {
              visible.forEach(function (item) { state.selected.delete(String(item.id)); });
              if (sameType) {
                // 可能还剩「全选之外手勾的别的库」：锁类型按剩下的重算，不能直接清空
                state.lockType = '';
                state.selected.forEach(function (id) {
                  if (state.lockType) return;
                  var rest = list.filter(function (x) { return String(x.id) === id; })[0];
                  if (rest) state.lockType = normType(rest.db_type);
                });
              }
            }
            refresh();
          };
        }
        overlay.querySelector('.ds-picker-close').onclick = function () { done(undefined); };
        overlay.querySelector('#ds-picker-cancel').onclick = function () { done(undefined); };
        overlay.addEventListener('click', function (event) {
          if (event.target === overlay) done(undefined);
        });
        var clearBtn = overlay.querySelector('#ds-picker-clear');
        if (clearBtn) clearBtn.onclick = function () { done(null); };
        if (okBtn) okBtn.onclick = function () {
          if (!state.selected.size) return;
          done(list.filter(function (item) { return state.selected.has(String(item.id)); }));
        };
        refresh();
        setTimeout(function () {
          var input = overlay.querySelector('#ds-picker-search');
          if (input) input.focus();
        }, 30);
      }).catch(function (err) {
        notify(t('webui.ds_picker_load_failed', '加载数据源失败: ') + (err && err.message), 'error');
        resolve(undefined);
      });
    });
  }

  /** 选择器入口（opts 与三种 resolve 结果见文件头）。 */
  function dsOpenPicker(opts) { return open(opts); }

  window.FusionDsPicker = {
    open: dsOpenPicker,
    normType: normType,
    pickerData: pickerData,
    dirNameById: dirNameById,
    matchesSearch: matchesSearch
  };
})();
