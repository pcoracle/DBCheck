/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * Fusion page logic: inspection configuration (three-pane master-detail).
 * Interaction and inline SQL editor behaviour ported from DBCheck v2.6
 * (MIT License, Copyright (c) 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>)
 * — 保持原有操作习惯：单击选中章节 / 双击全屏查看、SQL 行内手风琴编辑、
 * 放大编辑、折行开关、安全格式化、复制、拖拽调高、Ctrl+S / Esc / Ctrl+Shift-F。
 * Rewritten for the RaccoonX module layout and /api/inspection/* endpoints.
 */
(function () {
  'use strict';

  // ── 与旧版一致的行内 SVG 图标（viewBox 16，currentColor 描边）──
  var SVG = {
    edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.2 2.3 13.7 4.8 5.6 12.9 2.3 13.7 3.1 10.4z"/></svg>',
    del: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3 4.5h10"/><path d="M6.5 4.5V3.2h3v1.3"/><path d="M4.5 4.5 5 13.2h6l.5-8.7"/><path d="M6.8 7v3.6M9.2 7v3.6"/></svg>',
    expand: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2H2v4"/><path d="M10 14h4v-4"/><path d="M2 2l4.4 4.4"/><path d="M14 14l-4.4-4.4"/></svg>',
    shrink: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6h4V2"/><path d="M14 10h-4v4"/><path d="M6 6 2 2"/><path d="M10 10l4 4"/></svg>',
    wrap: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4h12"/><path d="M2 8h8.5a2.5 2.5 0 0 1 0 5H7"/><path d="M9 11l-2 2 2 2"/><path d="M2 12h3"/></svg>',
    format: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2 4h12"/><path d="M5 8h9"/><path d="M2 12h12"/></svg>',
    copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.6" y="5.6" width="7.9" height="7.9" rx="1.6"/><path d="M10.4 5.6V4.1A1.6 1.6 0 0 0 8.8 2.5H4.1A1.6 1.6 0 0 0 2.5 4.1v4.7a1.6 1.6 0 0 0 1.6 1.6h1.5"/></svg>'
  };

  var RAIL_KEY = 'raccoonx.inspection.railCollapsed';
  var COL_KEY = 'raccoonx.inspection.colWidths';
  // 三栏可拖拽调宽：min/max 保证任何一栏都不会被拖没（模板列尤其不能消失）
  var COL = {
    rail: { el: 'icx-rail', min: 210, max: 560, def: 258 },
    chapters: { el: 'icx-chapters-col', min: 220, max: 620, def: 288 }
  };
  var SQL_H_KEY = 'dbcheck.inspection.sqlEditorH';   // 沿用旧键，换系统后高度偏好不丢
  var SQL_WRAP_KEY = 'dbcheck.inspection.sqlWrap';

  var state = {
    templates: [],
    templateId: 0,
    template: null,
    chapters: [],
    chapterId: 0,
    search: '',
    dbTypes: [],
    stacked: false,
    railCollapsed: false,
    cloneRouteOk: true,
    cmReady: false,
    sortableReady: false,
    sqlWrap: true,
    manualH: null,
    colW: {},
    containers: {}      // cid -> {queries, filter, chapterId, large}
  };

  var edit = null;      // {queryId, cid, row, slot, cm}

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

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function attr(v) { return esc(v); }

  function isAdmin() {
    return window._IS_ADMIN === true || window.__userRole === 'admin' || window.__userRole === '管理员';
  }

  function say(msg, type) {
    if (typeof window.toast === 'function') { window.toast(msg, type || 'info'); return; }
    if (type === 'error') console.error(msg); else console.log(msg);
  }

  function confirmIt(title, message, onOk) {
    if (typeof window.showConfirmModal === 'function') {
      window.showConfirmModal(title, esc(message), onOk);
      return;
    }
    if (window.confirm(message)) onOk();
  }

  function get(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); });
  }

  function post(url, body, method) {
    return fetch(url, {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, json: j }; });
    }).then(function (res) {
      if (res.status >= 400 || (res.json && res.json.success === false)) {
        var e = new Error((res.json && (res.json.message || res.json.error)) || ('HTTP ' + res.status));
        e.code = res.json && res.json.code;
        e.status = res.status;
        throw e;
      }
      return res.json;
    });
  }

  // ── 惰性加载 CodeMirror / Sortable（仓库已 vendored，index.html 未引用其 JS）──
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var id = 'icx-js-' + src.replace(/[^\w]/g, '_');
      if ($(id)) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src;
      s.id = id;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('load failed: ' + src)); };
      document.head.appendChild(s);
    });
  }

  function ensureCm() {
    if (window.CodeMirror) { state.cmReady = true; return Promise.resolve(); }
    return loadScript('/static/codemirror/lib/codemirror.js')
      .then(function () { return loadScript('/static/codemirror/mode/sql/sql.js'); })
      .then(function () { state.cmReady = true; })
      .catch(function () { state.cmReady = false; });
  }

  function ensureSortable() {
    if (window.Sortable) { state.sortableReady = true; return Promise.resolve(); }
    return loadScript('/static/js/Sortable.min.js')
      .then(function () { state.sortableReady = !!window.Sortable; })
      .catch(function () { state.sortableReady = false; });
  }

  // ── 第 1 栏：模板 ─────────────────────────────────────────
  function toggleRail(force) {
    state.railCollapsed = force === undefined ? !state.railCollapsed : !!force;
    var rail = $('icx-rail');
    if (rail) rail.classList.toggle('icx-collapsed', state.railCollapsed);
    var lay = $('icx-layout');
    if (lay) lay.classList.toggle('icx-rail-collapsed', state.railCollapsed);
    var btn = $('icx-rail-toggle');
    if (btn) {
      btn.textContent = state.railCollapsed ? '»' : '«';
      btn.title = state.railCollapsed
        ? t('webui.icx_rail_expand', '展开模板栏') : t('webui.icx_rail_collapse', '收起模板栏');
    }
    applyRailFlex();
    fitLayout();
    try { localStorage.setItem(RAIL_KEY, state.railCollapsed ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  function dbIcon(type) {
    return (window.DB_ICONS && window.DB_ICONS[type]) || '🗄️';
  }

  function badge(cls, text) {
    return '<span class="icx-badge ' + cls + '">' + esc(text) + '</span>';
  }

  function tplBadges(x) {
    var out = [];
    if (x.is_preset) out.push(badge('preset', t('webui.icx_badge_preset', '预置')));
    if (x.is_default) out.push(badge('def', t('webui.icx_badge_default', '默认')));
    if (x.clone_from) out.push(badge('clone', t('webui.icx_badge_clone', '副本')));
    return out.join('');
  }

  // 类型筛选与数据源表单「数据库类型」用同一套生态分层（MySQL 系 / PostgreSQL 系 / …），
  // 直接复用全局 fillGroupedSelect，避免两处各维护一份分组表。
  // 类型筛选：多选面板，分组口径与数据源「数据库类型」一致（复用全局 dbGroupOf）
  function typeUniverse() {
    var out = [], seen = {};
    (window.dbTypes || []).forEach(function (x) {
      var v = String(x.value || x.db_type || '');
      if (v && !seen[v]) { seen[v] = 1; out.push({ v: v, label: x.label || v, emoji: x.emoji, group: '' }); }
    });
    state.templates.forEach(function (x) {
      var v = String(x.db_type || '');
      if (v && !seen[v]) { seen[v] = 1; out.push({ v: v, label: v, emoji: '', group: '其他' }); }
    });
    if (typeof window.dbGroupOf === 'function') {
      out.forEach(function (o) {
        try { o.group = window.dbGroupOf({ value: o.v }) || o.group || '其他'; }
        catch (e) { o.group = o.group || '其他'; }
      });
    }
    return out;
  }

  function typeCounts() {
    var m = {};
    state.templates.forEach(function (x) {
      var v = String(x.db_type || '').toLowerCase();
      if (v) m[v] = (m[v] || 0) + 1;
    });
    return m;
  }

  function renderTypeLabel() {
    var el = $('icx-dbfilter-text');
    if (!el) return;
    var sel = state.dbTypes || [];
    var uni = typeUniverse();
    if (!sel.length) {
      el.textContent = t('webui.icx_dbfilter_all', '全部');
    } else if (sel.length === 1) {
      var one = uni.filter(function (o) { return o.v === sel[0]; })[0];
      el.textContent = one ? (one.label || one.v) : sel[0];
    } else {
      el.textContent = sel.length + ' ' + t('webui.icx_dbfilter_types', '种类型');
    }
    var btn = $('icx-dbfilter-btn');
    if (btn) btn.classList.toggle('active', !!sel.length);
  }

  function setBtnExpanded(on) {
    var btn = $('icx-dbfilter-btn');
    if (btn) btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  function closeTypePanel() {
    var el = $('icx-type-panel');
    if (el) el.remove();
    setBtnExpanded(false);
    document.removeEventListener('mousedown', closeTypePanelOutside, true);
    document.removeEventListener('keydown', typePanelKeydown, true);
  }

  function closeTypePanelOutside(e) {
    var panel = $('icx-type-panel'), btn = $('icx-dbfilter-btn');
    if (!panel) return;
    if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
    closeTypePanel();
  }

  function typePanelKeydown(e) { if (e.key === 'Escape') closeTypePanel(); }

  function toggleTypePanel(ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if ($('icx-type-panel')) { closeTypePanel(); return; }
    var btn = $('icx-dbfilter-btn');
    if (!btn) return;
    var uni = typeUniverse();
    var counts = typeCounts();
    var selected = state.dbTypes || [];
    var groups = {}, order = [], groupValues = {};
    uni.forEach(function (o) {
      var g = o.group || '其他';
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(o);
      (groupValues[g] = groupValues[g] || []).push(o.v);
    });
    var html = '<div class="icx-tp-head"><span>' +
      esc(t('webui.icx_dbfilter_hint', '可多选；全不选即全部')) + '</span><span>' +
      '<button type="button" data-tp="all">' + esc(t('webui.icx_dbfilter_select_all', '全选')) + '</button> ' +
      '<button type="button" data-tp="none">' + esc(t('webui.icx_dbfilter_clear', '清空')) + '</button></span></div>';
    order.forEach(function (g) {
      // 组名上也放一个勾选框：勾上即选中该「系」下全部类型（半选状态由 JS 维护）
      var gCount = groupValues[g].reduce(function (n, v) { return n + (counts[v.toLowerCase()] || 0); }, 0);
      html += '<label class="icx-tp-group"><input type="checkbox" data-group="' + attr(g) + '" /> ' +
        esc(g) + '<span class="icx-tp-count">' + gCount + '</span></label>';
      groups[g].forEach(function (o) {
        var on = selected.indexOf(o.v) >= 0;
        html += '<label class="icx-tp-item"><input type="checkbox" value="' + attr(o.v) + '"' +
          (on ? ' checked' : '') + ' /> <span>' + esc((o.emoji ? o.emoji + ' ' : '') + (o.label || o.v)) + '</span>' +
          '<span class="icx-tp-count">' + (counts[o.v.toLowerCase()] || 0) + '</span></label>';
      });
    });
    var panel = document.createElement('div');
    panel.className = 'icx-type-panel';
    panel.id = 'icx-type-panel';
    panel.innerHTML = html;
    (document.body || document.documentElement).appendChild(panel);
    var r = btn.getBoundingClientRect();
    var left = Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8));
    var top = r.bottom + 4 + panel.offsetHeight > window.innerHeight
      ? Math.max(8, r.top - panel.offsetHeight - 4) : r.bottom + 4;
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    setBtnExpanded(true);

    function syncGroupStates() {
      Object.keys(groupValues).forEach(function (g) {
        var box = panel.querySelector('[data-group="' + g.replace(/"/g, '\\"') + '"]');
        if (!box) return;
        var vals = groupValues[g];
        var on = vals.filter(function (v) { return state.dbTypes.indexOf(v) >= 0; }).length;
        box.checked = on === vals.length && !!vals.length;
        box.indeterminate = on > 0 && on < vals.length;
      });
    }

    panel.addEventListener('change', function (e) {
      var cb = e.target;
      if (!cb || cb.type !== 'checkbox') return;
      var arr = state.dbTypes.slice();
      var g = cb.getAttribute('data-group');
      var vals = g ? (groupValues[g] || []) : [cb.value];
      vals.forEach(function (v) {
        var i = arr.indexOf(v);
        if (cb.checked && i < 0) arr.push(v);
        else if (!cb.checked && i >= 0) arr.splice(i, 1);
      });
      state.dbTypes = arr;
      Array.prototype.forEach.call(panel.querySelectorAll('.icx-tp-item input[type=checkbox]'), function (x) {
        x.checked = state.dbTypes.indexOf(x.value) >= 0;
      });
      syncGroupStates();
      renderTypeLabel();
      loadTemplates(true);
    });
    panel.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-tp]') : null;
      if (!b) return;
      state.dbTypes = b.getAttribute('data-tp') === 'all'
        ? typeUniverse().map(function (o) { return o.v; }) : [];
      Array.prototype.forEach.call(panel.querySelectorAll('.icx-tp-item input[type=checkbox]'), function (cb) {
        cb.checked = state.dbTypes.indexOf(cb.value) >= 0;
      });
      syncGroupStates();
      renderTypeLabel();
      loadTemplates(true);
    });
    setTimeout(function () {
      document.addEventListener('mousedown', closeTypePanelOutside, true);
      document.addEventListener('keydown', typePanelKeydown, true);
    }, 0);
  }

  function renderTemplates() {
    var box = $('icx-tpl-list');
    var countEl = $('icx-tpl-count');
    if (countEl) countEl.textContent = state.templates.length;
    if (!box) return;
    if (!state.templates.length) {
      box.innerHTML = '<div class="icx-tpl-sub">' + esc(t('webui.icx_tpl_empty', '没有匹配的模板')) + '</div>';
      return;
    }
    box.innerHTML = state.templates.map(function (x) {
      return '<div class="icx-tpl-item' + (Number(x.id) === state.templateId ? ' active' : '') + '"' +
        ' role="option" data-id="' + attr(x.id) + '"' +
        ' title="' + attr((x.template_name || '') + ' · ' + (x.description || '')) + '"' +
        ' onclick="FusionInspection.selectTemplate(' + Number(x.id) + ')">' +
        '<div class="icx-tpl-name"><span>' + dbIcon(x.db_type) + '</span>' +
        '<span class="icx-tpl-name-text">' + esc(x.template_name) + '</span>' + tplBadges(x) + '</div>' +
        '<div class="icx-tpl-sub">' + esc(x.db_type) + ' · ' + esc(x.version || 'v1') + ' · ' +
        esc(t('webui.icx_tpl_counts', '章节/SQL')) + ' ' + (x.chapter_count || 0) + '/' + (x.query_count || 0) +
        '</div></div>';
    }).join('');
  }

  function onTplSearch(v) {
    state.search = String(v || '').trim();
    var timer = state._searchTimer;
    if (timer) clearTimeout(timer);
    state._searchTimer = setTimeout(function () { loadTemplates(true); }, 220);
  }

  function onTplDbType(v) { state.dbTypes = v ? [v] : []; renderTypeLabel(); loadTemplates(); }

  function loadTemplates(keepCurrent) {
    var qs = [];
    (state.dbTypes || []).forEach(function (v) {
      qs.push('db_type=' + encodeURIComponent(v));
    });
    if (state.search) qs.push('keyword=' + encodeURIComponent(state.search));
    return get('/api/inspection/templates' + (qs.length ? '?' + qs.join('&') : '')).then(function (d) {
      if (!d || d.success === false) throw new Error((d && d.message) || t('webui.icx_load_fail', '加载失败'));
      state.templates = d.data || [];
      renderTypeLabel();
      if (!keepCurrent || !state.templates.some(function (x) { return Number(x.id) === state.templateId; })) {
        state.templateId = state.templates.length ? Number(state.templates[0].id) : 0;
      }
      renderTemplates();
      if (!state.templateId) {
        state.template = null;
        state.chapters = [];
        state.chapterId = 0;
        renderTemplateHead();
        renderChapters();
        setChapterDetail(null);
        return null;
      }
      return selectTemplate(state.templateId, true);
    }).catch(function (e) { say(e.message, 'error'); });
  }

  function selectTemplate(id, keepChapter) {
    if (id !== state.templateId) { if (!guardSwitch(function () { selectTemplate(id, keepChapter); })) return Promise.resolve(); }
    id = Number(id);
    if (!id) return Promise.resolve();
    state.templateId = id;
    renderTemplates();
    return get('/api/inspection/templates/' + id).then(function (d) {
      state.template = (d && d.success !== false && d.data) ||
        state.templates.filter(function (x) { return Number(x.id) === id; })[0] || null;
      renderTemplateHead();
      return loadChapters(keepChapter);
    }).catch(function (e) { say(e.message, 'error'); });
  }

  function renderTemplateHead() {
    var x = state.template;
    var nameEl = $('icx-tpl-name');
    if (nameEl) nameEl.textContent = x ? (x.template_name || '') : '—';
    var bEl = $('icx-tpl-badges');
    if (bEl) bEl.innerHTML = x ? tplBadges(x) : '';
    var metaEl = $('icx-tpl-meta');
    if (metaEl) {
      metaEl.textContent = x
        ? [x.db_type, x.version, x.template_name_en, x.description].filter(Boolean).join(' · ')
        : '';
    }
    var preset = !!(x && x.is_preset);
    var has = !!x;
    var set = function (id, show) {
      var el = $(id);
      if (el) el.style.display = show ? '' : 'none';
    };
    set('icx-btn-del-tpl', isAdmin() && has && !preset);
    set('icx-btn-clone', isAdmin() && has && state.cloneRouteOk);
    set('icx-btn-new', isAdmin());
    set('icx-btn-import', isAdmin());
    var addCh = $('icx-btn-add-chapter');
    if (addCh) addCh.disabled = !isAdmin() || !has;
  }

  // ── 模板弹窗：新建 / 编辑信息（含副本不可设默认的提醒，同旧版）──
  function openTplModal(mode) {
    var x = mode === 'edit' ? state.template : null;
    if (mode === 'edit' && !x) return;
    var preset = !!(x && x.is_preset);
    var isClone = !!(x && x.clone_from);
    var list = (window.dbTypes && window.dbTypes.length) ? window.dbTypes
      : (x ? [{ value: x.db_type, label: x.db_type }] : []);
    var html = '<div class="icx-modal-backdrop" id="icx-modal-backdrop">' +
      '<div class="icx-modal" role="dialog" aria-modal="true">' +
        '<div class="icx-modal-title">' + esc(mode === 'edit'
          ? t('webui.icx_tpl_edit_title', '编辑模板信息')
          : t('webui.icx_tpl_new_title', '新建巡检模板')) + '</div>' +
        (preset ? '<div class="icx-readonly-hint">' + esc(t('webui.icx_tpl_preset_hint',
          '预置模板的名称/版本/类型只读，如需定制请「克隆」为副本后修改。')) + '</div>' : '') +
        (isClone ? '<div class="icx-readonly-hint">' + esc(t('webui.icx_tpl_clone_tip',
          '这是复制出来的副本，仅作备用，不能设为默认模板。副本一旦顶替正在使用的默认模板，巡检实际执行的 SQL 就会改变。')) + '</div>' : '') +
        '<div class="icx-modal-grid">' +
          '<div class="icx-field"><label>' + esc(t('webui.icx_tpl_name', '模板名称')) +
            ' <span class="icx-req">*</span></label>' +
            '<input type="text" id="icx-m-name" value="' + attr(x ? x.template_name : '') + '"' +
            (preset ? ' readonly' : '') + ' /></div>' +
          '<div class="icx-field"><label>' + esc(t('webui.icx_tpl_version', '版本')) + '</label>' +
            '<input type="text" id="icx-m-version" value="' + attr(x ? (x.version || 'v1') : 'v1') + '"' +
            (preset ? ' readonly' : '') + ' /></div>' +
          '<div class="icx-field"><label>' + esc(t('webui.icx_tpl_type', '数据库类型')) + '</label>' +
            '<select id="icx-m-dbtype"' + (preset ? ' disabled' : '') + '>' +
            list.map(function (o) {
              var v = o.value || o.db_type || '';
              return '<option value="' + attr(v) + '"' + (x && x.db_type === v ? ' selected' : '') + '>' +
                esc((o.emoji ? o.emoji + ' ' : '') + (o.label || v)) + '</option>';
            }).join('') + '</select></div>' +
          '<div class="icx-field"><label>' + esc(t('webui.icx_tpl_name_en', '英文名称')) + '</label>' +
            '<input type="text" id="icx-m-name-en" value="' + attr(x ? x.template_name_en : '') + '" /></div>' +
          '<div class="icx-field icx-span2"><label class="icx-check">' +
            '<input type="checkbox" id="icx-m-default"' + (x && x.is_default ? ' checked' : '') +
            (isClone ? ' disabled' : '') + ' /> ' +
            esc(t('webui.icx_tpl_set_default', '设为该类型的默认模板')) + '</label></div>' +
          '<div class="icx-field icx-span2"><label>' + esc(t('webui.icx_tpl_desc', '描述')) + '</label>' +
            '<textarea id="icx-m-desc" rows="2">' + esc(x ? x.description : '') + '</textarea></div>' +
        '</div>' +
        '<div class="icx-modal-msg" id="icx-m-msg"></div>' +
        '<div class="icx-modal-actions">' +
          '<button class="btn btn-ghost" type="button" onclick="FusionInspection.closeModal()">' +
            esc(t('webui.icx_cancel', '取消')) + '</button>' +
          '<button class="btn btn-primary" type="button" id="icx-m-save">' +
            esc(t('webui.icx_save', '保存')) + '</button>' +
        '</div>' +
      '</div></div>';
    showModal(html);
    var nameEl = $('icx-m-name');
    if (nameEl) nameEl.focus();
    $('icx-m-save').onclick = function () {
      var payload = {
        template_name: $('icx-m-name').value.trim(),
        version: $('icx-m-version').value.trim(),
        db_type: $('icx-m-dbtype').value,
        template_name_en: $('icx-m-name-en').value.trim(),
        description: $('icx-m-desc').value.trim(),
        is_default: $('icx-m-default').checked ? 1 : 0
      };
      if (!payload.template_name) { modalMsg(t('webui.icx_tpl_name_required', '请填写模板名称'), true); return; }
      if (preset) payload = { description: payload.description, is_default: payload.is_default };
      var p = mode === 'edit'
        ? post('/api/inspection/templates/' + state.templateId, payload, 'PUT')
        : post('/api/inspection/templates', payload);
      p.then(function () {
        closeModal();
        say(t('webui.icx_tpl_saved', '模板已保存'), 'success');
        return loadTemplates(true);
      }).catch(function (e) { modalMsg(e.message, true); });
    };
  }

  function showModal(html) {
    var old = $('icx-modal-backdrop');
    if (old) old.remove();
    (document.body || document.documentElement).insertAdjacentHTML('beforeend', html);
  }

  function closeModal() {
    var el = $('icx-modal-backdrop');
    if (el) el.remove();
  }

  function modalMsg(text, isError) {
    var el = $('icx-m-msg');
    if (!el) return;
    el.style.color = isError ? 'var(--danger)' : 'var(--text-muted)';
    el.textContent = text;
  }

  function newTemplate() { openTplModal('create'); }
  function editTemplateMeta() { openTplModal('edit'); }

  function cloneTemplate() {
    if (!state.templateId) return;
    confirmIt(t('webui.icx_tpl_clone', '克隆'),
      t('webui.icx_tpl_clone_msg', '将连同章节和 SQL 一起复制为可编辑的副本，继续？'),
      function () {
        post('/api/inspection/templates/' + state.templateId + '/clone', {}).then(function (d) {
          var nid = d && d.data && d.data.id;
          say(t('webui.icx_tpl_cloned', '已生成副本'), 'success');
          return loadTemplates().then(function () { return nid ? selectTemplate(nid) : null; });
        }).catch(function (e) {
          if (e.status === 404) {
            state.cloneRouteOk = false;
            renderTemplateHead();
          }
          say(e.message, 'error');
        });
      });
  }

  function deleteTemplate() {
    if (!state.templateId) return;
    var x = state.template || {};
    // 预置模板不显示删除按钮，这里也不带 force：状态滞后时由后端 preset_protected 兜住
    confirmIt(t('webui.icx_tpl_delete', '删除模板'),
      t('webui.icx_tpl_delete_msg', '模板「{}」及其全部章节和 SQL 将被删除，不可恢复。').replace('{}', x.template_name || ''),
      function () {
        post('/api/inspection/templates/' + state.templateId, {}, 'DELETE').then(function () {
          state.templateId = 0;
          say(t('webui.icx_tpl_deleted', '模板已删除'), 'success');
          return loadTemplates();
        }).catch(function (e) { say(e.message, 'error'); });
      });
  }

  function exportTemplate() {
    if (!state.templateId) return;
    get('/api/inspection/templates/' + state.templateId + '/export').then(function (d) {
      if (!d || d.success === false) throw new Error((d && d.message) || t('webui.icx_export_fail', '导出失败'));
      var name = ((d.data && d.data.template_name) || ('template-' + state.templateId)) + '.json';
      var blob = new Blob([JSON.stringify(d.data, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }).catch(function (e) { say(e.message, 'error'); });
  }

  function pickImportFile() { var el = $('icx-import-file'); if (el) el.click(); }

  function importFromFile(input) {
    var f = input.files && input.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var cfg;
      try { cfg = JSON.parse(String(reader.result)); }
      catch (e) { say(t('webui.icx_import_bad', '文件不是合法 JSON'), 'error'); return; }
      post('/api/inspection/templates/import', { template_config: cfg, overwrite: false }).then(function (d) {
        var nid = d && d.data && d.data.id;
        say(t('webui.icx_imported', '模板已导入'), 'success');
        return loadTemplates().then(function () { return nid ? selectTemplate(nid) : null; });
      }).catch(function (e) { say(e.message, 'error'); });
    };
    reader.readAsText(f, 'utf-8');
    input.value = '';
  }

  // ── 第 2 栏：章节（单击选中、双击全屏、✕ 删除、拖拽排序）──
  function chapterTitle(c) {
    return c.chapter_title_zh || c.chapter_title_en || ('#' + c.chapter_number);
  }

  function renderChapters() {
    var box = $('icx-chapter-list');
    if (!box) return;
    if (!state.chapters.length) {
      box.innerHTML = '<div class="icx-empty-line">' + esc(t('webui.icx_ch_empty', '暂无章节，请点击 ＋ 添加')) + '</div>';
      return;
    }
    box.innerHTML = '<ul class="icx-ch-ul">' + state.chapters.map(function (c) {
      return '<li class="icx-ch-item' + (Number(c.id) === state.chapterId ? ' active' : '') +
        (c.enabled ? '' : ' off') + '" data-chapter-id="' + attr(c.id) + '"' +
        ' onclick="FusionInspection.selectChapter(' + Number(c.id) + ')"' +
        ' ondblclick="FusionInspection.openChapterDetail(' + Number(c.id) + ')"' +
        ' title="' + attr(t('webui.icx_ch_click_hint', '单击选中，双击全屏查看章节详情')) + '">' +
        '<div class="icx-ch-info"><span class="icx-ch-num">' + esc(c.chapter_number) + '</span>' +
        '<div class="icx-ch-text"><span class="icx-ch-title">' + esc(c.chapter_title_zh || '') + '</span>' +
        (c.chapter_title_en ? '<span class="icx-ch-title-en">' + esc(c.chapter_title_en) + '</span>' : '') +
        '</div></div>' +
        '<span class="icx-ch-count">' + (c.query_count || 0) + '</span>' +
        (isAdmin() ? '<span class="icx-ch-x" title="' + attr(t('webui.icx_ch_delete', '删除章节')) + '"' +
          ' onclick="event.stopPropagation();FusionInspection.deleteChapter(' + Number(c.id) + ')">✕</span>' : '') +
        '</li>';
    }).join('') + '</ul>';
    bindChapterDrag();
  }

  function bindChapterDrag() {
    var box = $('icx-chapter-list');
    if (!box) return;
    var ul = box.querySelector('.icx-ch-ul');
    if (!ul || !window.Sortable || !isAdmin()) {
      // 没有 Sortable 时给出键盘/按钮式排序兜底
      if (ul && isAdmin() && !window.Sortable) ul.classList.add('icx-no-drag');
      return;
    }
    if (ul._icxSortable) ul._icxSortable.destroy();
    ul._icxSortable = new window.Sortable(ul, {
      animation: 150,
      ghostClass: 'icx-ch-ghost',
      onEnd: function () {
        var ids = Array.prototype.map.call(ul.querySelectorAll('[data-chapter-id]'), function (el) {
          return parseInt(el.getAttribute('data-chapter-id'), 10);
        });
        post('/api/inspection/chapters/reorder', { template_id: state.templateId, chapter_ids: ids })
          .catch(function (e) { say(t('webui.icx_ch_reorder_fail', '排序保存失败') + ': ' + e.message, 'error'); });
      }
    });
  }

  function selectChapter(id) {
    id = Number(id);
    if (!id) return;
    if (id !== state.chapterId && !guardSwitch(function () { selectChapter(id); })) return;
    state.chapterId = id;
    renderChapters();
    var ch = currentChapter();
    setChapterDetail(ch);
    loadQueries('icx-query-list');
  }

  function currentChapter() {
    return state.chapters.filter(function (c) { return Number(c.id) === state.chapterId; })[0] || null;
  }

  function loadChapters(keepChapter) {
    if (!state.templateId) return Promise.resolve();
    return get('/api/inspection/templates/' + state.templateId + '/chapters').then(function (d) {
      if (!d || d.success === false) throw new Error((d && d.message) || t('webui.icx_load_fail', '加载失败'));
      state.chapters = d.data || [];
      if (!keepChapter || !state.chapters.some(function (c) { return Number(c.id) === state.chapterId; })) {
        state.chapterId = state.chapters.length ? Number(state.chapters[0].id) : 0;
      }
      renderChapters();
      var ch = currentChapter();
      setChapterDetail(ch);
      loadQueries('icx-query-list');
      refreshDetailModalIfOpen();
    }).catch(function (e) { say(e.message, 'error'); });
  }

  function openChapterModal(ch) {
    var isNew = !ch;
    ch = ch || {};
    var next = state.chapters.reduce(function (m, c) { return Math.max(m, Number(c.chapter_number) || 0); }, 0) + 1;
    var html = '<div class="icx-modal-backdrop" id="icx-modal-backdrop">' +
      '<div class="icx-modal" role="dialog" aria-modal="true">' +
        '<div class="icx-modal-title">' + esc(isNew
          ? t('webui.icx_ch_new_title', '新建章节') : t('webui.icx_ch_edit_title', '编辑章节')) + '</div>' +
        '<div class="icx-modal-grid" style="grid-template-columns:110px 1fr">' +
          '<div class="icx-field"><label>' + esc(t('webui.icx_ch_no', '章节序号')) +
            ' <span class="icx-req">*</span></label>' +
            '<input type="number" id="icx-c-no" value="' + attr(isNew ? next : ch.chapter_number) + '" /></div>' +
          '<div class="icx-field"><label class="icx-check" style="margin-top:20px">' +
            '<input type="checkbox" id="icx-c-enabled"' + (isNew || ch.enabled ? ' checked' : '') + ' /> ' +
            esc(t('webui.icx_ch_enabled', '启用')) + '</label></div>' +
        '</div>' +
        '<div class="icx-modal-grid">' +
          '<div class="icx-field"><label>' + esc(t('webui.icx_ch_title_zh', '章节标题（中文）')) +
            ' <span class="icx-req">*</span></label>' +
            '<input type="text" id="icx-c-zh" placeholder="' +
            attr(t('webui.icx_ch_title_zh_ph', '如：基本信息采集')) + '" value="' +
            attr(ch.chapter_title_zh || '') + '" /></div>' +
          '<div class="icx-field"><label>' + esc(t('webui.icx_ch_title_en', '章节标题（英文）')) + '</label>' +
            '<input type="text" id="icx-c-en" placeholder="Basic Info Collection" value="' +
            attr(ch.chapter_title_en || '') + '" /></div>' +
        '</div>' +
        '<div class="icx-field"><label>' + esc(t('webui.icx_ch_desc', '章节描述')) + '</label>' +
          '<textarea id="icx-c-desc" rows="2">' + esc(ch.description || '') + '</textarea></div>' +
        '<div class="icx-modal-msg" id="icx-m-msg"></div>' +
        '<div class="icx-modal-actions">' +
          '<button class="btn btn-ghost" type="button" onclick="FusionInspection.closeModal()">' +
            esc(t('webui.icx_cancel', '取消')) + '</button>' +
          '<button class="btn btn-primary" type="button" id="icx-c-save">' +
            esc(t('webui.icx_save', '保存')) + '</button>' +
        '</div>' +
      '</div></div>';
    showModal(html);
    $('icx-c-zh').focus();
    $('icx-c-save').onclick = function () {
      var title = $('icx-c-zh').value.trim();
      if (!title) { modalMsg(t('webui.icx_ch_title_required', '请填写章节标题'), true); return; }
      var payload = {
        chapter_number: parseInt($('icx-c-no').value, 10) || next,
        chapter_title_zh: title,
        chapter_title_en: $('icx-c-en').value.trim(),
        description: $('icx-c-desc').value.trim(),
        enabled: $('icx-c-enabled').checked ? 1 : 0,
        sort_order: Number(ch.sort_order || 0)
      };
      var p = isNew
        ? post('/api/inspection/templates/' + state.templateId + '/chapters', payload)
        : post('/api/inspection/chapters/' + ch.id, payload, 'PUT');
      p.then(function (d) {
        closeModal();
        var jump = isNew && d && d.data ? Number(d.data.id) : 0;
        return loadChapters(true).then(function () {
          if (jump) selectChapter(jump);
          refreshDetailModalIfOpen();
        });
      }).catch(function (e) { modalMsg(e.message, true); });
    };
  }

  function newChapter() {
    if (!state.templateId) { say(t('webui.icx_save_tpl_first', '请先保存模板'), 'error'); return; }
    openChapterModal(null);
  }

  function editChapter(id) {
    var ch = state.chapters.filter(function (c) { return Number(c.id) === Number(id); })[0];
    if (ch) openChapterModal(ch);
  }

  function deleteChapter(id) {
    var ch = state.chapters.filter(function (c) { return Number(c.id) === Number(id); })[0];
    if (!ch) return;
    confirmIt(t('webui.icx_ch_delete', '确认删除'),
      t('webui.icx_ch_delete_msg', '确定要删除章节「{}」吗？其下 SQL 查询会一并删除。').replace('{}', chapterTitle(ch)),
      function () {
        cancelEdit();
        post('/api/inspection/chapters/' + id, {}, 'DELETE').then(function () {
          if (state.chapterId === Number(id)) state.chapterId = 0;
          return loadChapters(false);
        }).catch(function (e) { say(e.message, 'error'); });
      });
  }

  // ── 第 3 栏 / 全屏详情：章节详情 + SQL 列表（两处共用渲染）──
  function detailHtml(ch, cid, large) {
    // data-detail-root：把「头部计数徽标 + 描述 + 查询列表」绑成一个作用域，
    // 否则头部与列表是兄弟节点，closest() 找不到徽标，数量会永远停在 0。
    var open = '<div class="icx-detail-root" data-detail-root="' + attr(cid) + '">';
    var close = '</div>';
    var c = containers(cid);
    c.chapterId = ch ? Number(ch.id) : 0;
    c.large = !!large;
    if (!ch) {
      return open + '<div class="icx-detail-empty">' +
        esc(t('webui.icx_pick_chapter_first', '请先在中间栏单击选择章节，双击可全屏查看')) + '</div>' + close;
    }
    return open + '<div class="icx-detail-head">' +
        '<span class="icx-detail-title">📝 ' + esc(ch.chapter_number) + ' · ' + esc(chapterTitle(ch)) + '</span>' +
        '<span class="icx-meta' + (ch.enabled ? '' : ' off') + '">' + (ch.enabled ? '✅ 启用' : '❌ 禁用') + '</span>' +
        '<span class="icx-meta queries" data-qcount-tag>📋 0 ' +
          esc(t('webui.icx_q_sql_unit', '条 SQL')) + '</span>' +
        (isAdmin() ? '<button type="button" class="btn btn-ghost icx-btn-xs" data-act="edit-chapter"' +
          ' onclick="FusionInspection.editChapter(' + Number(ch.id) + ')">✏️ ' +
          esc(t('webui.icx_ch_edit', '编辑章节')) + '</button>' : '') +
      '</div>' +
      (ch.description ? '<div class="icx-detail-desc">' + esc(ch.description) + '</div>' : '') +
      '<div data-query-host>' + buildQueryListHtml(cid) + '</div>' + close;
  }

  function containers(cid) {
    if (!state.containers[cid]) state.containers[cid] = { queries: [], filter: '', chapterId: 0, large: false };
    return state.containers[cid];
  }

  function setChapterDetail(ch) {
    var host = $('icx-detail-panel');
    if (!host) return;
    host.innerHTML = detailHtml(ch, 'icx-query-list', false);
  }

  function buildQueryListHtml(cid) {
    return buildToolbarHtml(cid) + '<div class="icx-q-rows" data-rows="' + attr(cid) + '">' +
      buildRowsHtml(cid) + '</div>';
  }

  function buildToolbarHtml(cid) {
    var c = containers(cid);
    var all = c.queries || [];
    var html = '<div class="icx-q-toolbar">' +
      '<span class="icx-q-toolbar-title">' + esc(t('webui.icx_q_list_title', 'SQL 查询列表')) + '</span>' +
      '<span class="icx-count" title="' + attr(t('webui.icx_q_total', '查询总数')) + '">' + all.length + '</span>';
    if (all.length > 3) {
      html += '<input type="search" class="icx-q-filter" placeholder="' +
        attr(t('webui.icx_q_filter_ph', '筛选键名 / SQL / 描述')) + '" value="' + attr(c.filter || '') + '"' +
        ' oninput="FusionInspection.filterQueries(this.value,\'' + attr(cid) + '\')" />';
    }
    if (isAdmin()) {
      html += '<button type="button" class="btn btn-primary icx-btn-xs" ' +
        'onclick="FusionInspection.newQuery(\'' + attr(cid) + '\')">＋ ' +
        esc(t('webui.icx_q_add', '添加查询')) + '</button>';
    }
    return html + '</div>';
  }

  function sqlSummary(sql, max) {
    var m = max || 120;
    var one = String(sql == null ? '' : sql).replace(/\s+/g, ' ').trim();
    return one.length > m ? one.slice(0, m) + '…' : one;
  }

  function buildRowsHtml(cid) {
    var c = containers(cid);
    var all = c.queries || [];
    if (!all.length) {
      return '<div class="icx-empty-line">' +
        esc(t('webui.icx_q_empty', '暂无 SQL 查询，点击「＋ 添加查询」新增')) + '</div>';
    }
    var kw = String(c.filter || '').trim().toLowerCase();
    var list = kw ? all.filter(function (q) {
      return [q.query_key, q.query_sql, q.query_description_zh, q.query_description_en]
        .join(' ').toLowerCase().indexOf(kw) >= 0;
    }) : all;
    if (!list.length) {
      return '<div class="icx-empty-line">' + esc(t('webui.icx_q_no_match', '没有匹配的查询')) + '</div>';
    }
    return '<ul class="icx-q-ul">' + list.map(function (q) {
      var zh = String(q.query_description_zh || '').trim();
      var key = String(q.query_key || '').trim();
      // 展示层次同旧版：中文说明给人看（主），英文标识给程序用（次）
      var nameHtml = zh
        ? '<span class="icx-q-name">' + esc(zh) + '</span>'
        : '<span class="icx-q-name missing">' + esc(key || t('webui.icx_q_unnamed', '未命名')) +
          '<span class="icx-q-name-hint">' + esc(t('webui.icx_q_no_desc', '（未填中文说明）')) + '</span></span>';
      var keyHtml = (zh && key) ? '<code class="icx-q-key">' + esc(key) + '</code>' : '';
      var lines = String(q.query_sql || '').split('\n').length;
      var tip = (zh ? zh + (key ? '（' + key + '）' : '') : (key || t('webui.icx_q_unnamed', '未命名'))) +
        ' — ' + t('webui.icx_q_row_tip', '点击展开查看 / 编辑') +
        (q.query_sql ? '\n\nSQL（' + lines + ' 行）：\n' + sqlSummary(q.query_sql, 220) : '');
      return '<li class="icx-q-row" data-query-id="' + attr(q.id) + '">' +
        '<div class="icx-q-head" role="button" tabindex="0" title="' + attr(tip) + '"' +
          ' onclick="FusionInspection.toggleQueryEdit(' + Number(q.id) + ',\'' + attr(cid) + '\')"' +
          ' onkeydown="if(event.key===\'Enter\')FusionInspection.toggleQueryEdit(' + Number(q.id) + ',\'' + attr(cid) + '\')">' +
          '<span class="icx-q-caret" aria-hidden="true"></span>' + nameHtml + keyHtml +
          '<span class="icx-q-state ' + (q.enabled ? 'on' : 'off') + '" title="' +
            attr(q.enabled ? t('webui.icx_q_on', '已启用（参与巡检）') : t('webui.icx_q_off', '已禁用（不参与巡检）')) + '">' +
            (q.enabled ? '✅' : '❌') + '</span>' +
          (isAdmin() ? '<span class="icx-q-actions">' +
            '<button type="button" class="icx-ibtn" title="' + attr(t('webui.icx_q_row_tip', '点击展开查看 / 编辑')) + '"' +
              ' aria-label="' + attr(t('webui.icx_q_edit', '展开查看或编辑')) + '"' +
              ' onclick="event.stopPropagation();FusionInspection.toggleQueryEdit(' + Number(q.id) + ',\'' + attr(cid) + '\')">' + SVG.edit + '</button>' +
            '<button type="button" class="icx-ibtn danger" title="' + attr(t('webui.icx_q_delete_title', '删除该查询')) + '"' +
              ' aria-label="' + attr(t('webui.icx_q_delete_title', '删除该查询')) + '"' +
              ' onclick="event.stopPropagation();FusionInspection.deleteQuery(' + Number(q.id) + ',\'' + attr(cid) + '\')">' + SVG.del + '</button>' +
            '</span>' : '') +
        '</div>' +
        '<div class="icx-q-slot" hidden></div>' +
      '</li>';
    }).join('') + '</ul>';
  }

  function refreshRows(cid) {
    if (edit && edit.cid === cid) cancelEdit();
    var host = document.querySelector('[data-rows="' + cid + '"]');
    if (host) host.innerHTML = buildRowsHtml(cid);
    var tb = host ? host.parentNode.querySelector('.icx-q-toolbar') : null;
    if (tb) tb.outerHTML = buildToolbarHtml(cid);
    syncCountTag(cid);
  }

  function syncCountTag(cid) {
    var c = containers(cid);
    var root = document.querySelector('[data-detail-root="' + cid + '"]');
    if (!root) return;
    var tag = root.querySelector('[data-qcount-tag]');
    if (tag) tag.textContent = '📋 ' + (c.queries || []).length + ' ' + t('webui.icx_q_sql_unit', '条 SQL');
  }

  function filterQueries(kw, cid) {
    var c = containers(cid);
    c.filter = kw || '';
    refreshRows(cid);
    var input = document.querySelector('[data-rows="' + cid + '"]').parentNode.querySelector('.icx-q-filter');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  function loadQueries(cid) {
    var c = containers(cid);
    if (!c.chapterId) { c.queries = []; refreshRows(cid); return Promise.resolve(); }
    return get('/api/inspection/chapters/' + c.chapterId + '/queries').then(function (d) {
      if (!d || d.success === false) throw new Error((d && d.message) || t('webui.icx_load_fail', '加载失败'));
      c.queries = d.data || [];
      refreshRows(cid);
    }).catch(function (e) { say(e.message, 'error'); });
  }

  // ── 行内编辑表单（字段顺序 / 提示文案 / 工具按钮均沿用旧版）──
  function inlineFormHtml(q) {
    q = q || {};
    var enabled = (q.enabled === 0 || q.enabled === false) ? '' : 'checked';
    var sql = String(q.query_sql || '');
    var meta = sql ? (sql.split('\n').length + ' 行 · ' + sql.length + ' 字符') : t('webui.icx_q_empty_sql', '空');
    return '<div class="icx-inline">' +
      '<div class="icx-inline-head">' +
        '<div class="icx-inline-field"><label>' + esc(t('webui.icx_q_key', '查询标识')) +
          '<span class="icx-inline-tip">' + esc(t('webui.icx_q_key_tip', '英文，程序内部用，不建议改动')) + '</span></label>' +
          '<input type="text" class="icx-inline-key" placeholder="如：my_version" value="' + attr(q.query_key || '') + '" /></div>' +
        '<label class="icx-inline-switch" title="' + attr(t('webui.icx_q_switch_tip', '禁用后该查询仍保留，但不参与巡检')) + '">' +
          '<input type="checkbox" class="icx-inline-enabled" ' + enabled + ' /> ' +
          esc(t('webui.icx_q_switch', '启用')) + '</label>' +
      '</div>' +
      '<div class="icx-inline-desc">' +
        '<div class="icx-inline-field"><label>' + esc(t('webui.icx_q_desc_zh', '中文说明')) +
          '<span class="icx-inline-tip">' + esc(t('webui.icx_q_desc_zh_tip', '列表上展示给人看，写清「这个查询查什么」')) + '</span></label>' +
          '<input type="text" class="icx-inline-desc-zh" placeholder="' +
            attr(t('webui.icx_q_desc_zh_ph', '如：获取 MySQL 版本')) + '" value="' + attr(q.query_description_zh || '') + '" /></div>' +
        '<div class="icx-inline-field"><label>' + esc(t('webui.icx_q_desc_en', '英文说明')) +
          '<span class="icx-inline-tip">' + esc(t('webui.icx_q_optional', '选填')) + '</span></label>' +
          '<input type="text" class="icx-inline-desc-en" placeholder="' +
            attr(t('webui.icx_q_desc_en_ph', '如：Get MySQL version')) + '" value="' + attr(q.query_description_en || '') + '" /></div>' +
      '</div>' +
      '<div class="icx-sqlblock">' +
        '<div class="icx-sql-head"><label class="icx-inline-label">' +
          esc(t('webui.icx_q_sql', 'SQL 语句')) + ' <span class="icx-req">*</span>' +
          '<span class="icx-sql-meta">· ' + esc(meta) + '</span></label>' +
          '<div class="icx-sql-tools">' +
            '<button type="button" class="icx-sql-tool" data-tool="focus" title="' +
              attr(t('webui.icx_q_focus_tip', '放大编辑（左右栏收纳，专注改这条 SQL）')) + '" aria-label="' +
              attr(t('webui.icx_q_focus', '放大编辑')) + '" aria-pressed="false"' +
              ' onclick="FusionInspection.toggleFocusEdit()">' + SVG.expand + '</button>' +
            '<button type="button" class="icx-sql-tool wrap' + (state.sqlWrap ? ' active' : '') + '" data-tool="wrap" title="' +
              attr(state.sqlWrap ? t('webui.icx_q_wrap_on', '自动折行：开（长语句折行显示，点按可关闭）')
                                  : t('webui.icx_q_wrap_off', '自动折行：关（长语句横向滚动，点按可开启）')) + '" aria-label="' +
              attr(t('webui.icx_q_wrap_toggle', '切换自动折行')) + '" aria-pressed="' + (state.sqlWrap ? 'true' : 'false') + '"' +
              ' onclick="FusionInspection.toggleSqlWrap()">' + SVG.wrap + '</button>' +
            '<button type="button" class="icx-sql-tool" data-tool="format" title="' +
              attr(t('webui.icx_q_format_tip', '格式化 SQL（Ctrl+Shift+F）')) + '" aria-label="' +
              attr(t('webui.icx_q_format', '格式化 SQL')) + '"' +
              ' onclick="FusionInspection.formatSql()">' + SVG.format + '</button>' +
            '<button type="button" class="icx-sql-tool" data-tool="copy" title="' +
              attr(t('webui.icx_q_copy_tip', '复制 SQL（保留原始换行与对齐）')) + '" aria-label="' +
              attr(t('webui.icx_q_copy', '复制 SQL')) + '"' +
              ' onclick="FusionInspection.copySql()">' + SVG.copy + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="icx-cm-host"></div>' +
        '<div class="icx-sql-resize" title="' + attr(t('webui.icx_q_resize_tip', '上下拖动调整 SQL 编辑区高度 · 双击恢复自适应')) + '"' +
          ' onpointerdown="FusionInspection.startSqlResize(event)" ondblclick="FusionInspection.resetSqlHeight()">' +
          '<span class="icx-grip" aria-hidden="true"></span></div>' +
      '</div>' +
      '<div class="icx-inline-foot">' +
        '<span class="icx-inline-hint">' + esc(t('webui.icx_q_hint', 'Ctrl+S 保存 · Esc 取消 · 长语句建议先「放大编辑」')) + '</span>' +
        '<div class="icx-inline-foot-btns">' +
          '<button type="button" class="btn btn-ghost icx-btn-xs" onclick="FusionInspection.cancelEdit()">' +
            esc(t('webui.icx_cancel', '取消')) + '</button>' +
          '<button type="button" class="btn btn-primary icx-btn-xs" onclick="FusionInspection.saveEdit()">' +
            esc(t('webui.icx_save', '保存')) + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function findRow(cid, queryId) {
    return document.querySelector('[data-rows="' + cid + '"] .icx-q-row[data-query-id="' + queryId + '"]');
  }

  function toggleQueryEdit(queryId, cid) {
    if (edit && String(edit.queryId) === String(queryId) && edit.cid === cid) { cancelEdit(); return; }
    var c = containers(cid);
    var q = (c.queries || []).filter(function (x) { return String(x.id) === String(queryId); })[0];
    if (!q) return;
    if (!isAdmin()) { say(t('webui.icx_need_admin', '只有管理员才能编辑'), 'error'); return; }
    var row = findRow(cid, queryId);
    if (!row) return;
    openEditor(row, q, cid);
  }

  function openEditor(row, q, cid) {
    cancelEdit();
    var slot = row.querySelector('.icx-q-slot');
    if (!slot) return;
    slot.innerHTML = inlineFormHtml(q);
    slot.hidden = false;
    row.classList.add('editing');

    var host = slot.querySelector('.icx-cm-host');
    var cm = null;
    if (host && window.CodeMirror) {
      try { cm = makeEditor(host, q.query_sql || ''); }
      catch (e) { console.warn('[inspection] CodeMirror 初始化失败，退回文本框：', e); cm = null; }
    }
    if (host && !cm) {
      var ta = document.createElement('textarea');
      ta.className = 'icx-cm-fallback';
      ta.rows = 6;
      ta.value = q.query_sql || '';
      host.appendChild(ta);
    }
    edit = { queryId: q.id || null, cid: cid, row: row, slot: slot, cm: cm, dirty: false };
    slot.addEventListener('input', markDirty);
    document.addEventListener('keydown', globalEsc);
    updateSqlMeta();
    if (!q.id) {
      var zhEl = slot.querySelector('.icx-inline-desc-zh');   // 新建：先想清楚这条查询查什么
      if (zhEl) zhEl.focus();
    } else if (cm) {
      setTimeout(function () { try { autoSize(cm); cm.refresh(); cm.focus(); } catch (e) {} }, 40);
    }
    try { row.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }

  function newQuery(cid) {
    cid = cid || 'icx-query-list';
    var c = containers(cid);
    if (!c.chapterId) { say(t('webui.icx_pick_chapter_first', '请先选择一个章节'), 'error'); return; }
    if (!isAdmin()) return;
    cancelEdit();
    var rows = document.querySelector('[data-rows="' + cid + '"]');
    if (!rows) return;
    var empty = rows.querySelector('.icx-empty-line');
    if (empty) empty.remove();
    var ul = rows.querySelector('.icx-q-ul');
    if (!ul) { ul = document.createElement('ul'); ul.className = 'icx-q-ul'; rows.appendChild(ul); }
    var li = document.createElement('li');
    li.className = 'icx-q-row editing draft';
    li.setAttribute('data-query-id', 'draft');
    li.innerHTML = '<div class="icx-q-head" title="' + attr(t('webui.icx_q_draft_tip', '新查询（未保存）')) + '">' +
      '<span class="icx-q-caret" aria-hidden="true"></span>' +
      '<span class="icx-q-name missing">' + esc(t('webui.icx_q_draft', '新查询')) +
      '<span class="icx-q-name-hint">' + esc(t('webui.icx_q_draft_unsaved', '（未保存）')) + '</span></span>' +
      '<span class="icx-q-state on" title="' + attr(t('webui.icx_q_will_enable', '将创建为启用')) + '">✅</span></div>' +
      '<div class="icx-q-slot"></div>';
    ul.insertBefore(li, ul.firstChild);
    openEditor(li, { id: null, query_key: '', query_sql: '', query_description_zh: '',
                     query_description_en: '', enabled: 1 }, cid);
  }

  function globalEsc(e) {
    if (e.key !== 'Escape' || !edit) return;
    var el = e.target;
    if (el && el.closest && (el.closest('.CodeMirror') || el.closest('.CodeMirror-hints'))) return;
    cancelEdit();
  }

  function cancelEdit() {
    if (!edit) return;
    var st = edit;
    edit = null;
    document.removeEventListener('keydown', globalEsc);
    var layout = $('icx-layout');
    if (layout) layout.classList.remove('icx-focus-edit');   // 收起编辑一并退出放大，避免下次展开还是收拢态
    try { if (st.cm) st.cm.toTextArea(); } catch (e) {}
    try {
      if (st.row && st.row.classList.contains('draft')) {
        if (st.row.parentNode) st.row.parentNode.removeChild(st.row);
        var c = containers(st.cid);
        if (!c.queries.length && st.row.parentNode) {
          var host = document.querySelector('[data-rows="' + st.cid + '"]');
          if (host) host.innerHTML = buildRowsHtml(st.cid);
        }
      } else if (st.slot) {
        st.slot.innerHTML = '';
        st.slot.hidden = true;
        if (st.row) st.row.classList.remove('editing');
      }
    } catch (e) {}
  }

  function currentSql() {
    if (!edit) return '';
    if (edit.cm) { try { return edit.cm.getValue(); } catch (e) {} }
    var ta = edit.slot ? edit.slot.querySelector('.icx-cm-fallback') : null;
    return ta ? ta.value : '';
  }

  function saveEdit() {
    if (!edit) return;
    var slot = edit.slot;
    var key = (slot.querySelector('.icx-inline-key') || {}).value || '';
    var zh = (slot.querySelector('.icx-inline-desc-zh') || {}).value || '';
    var en = (slot.querySelector('.icx-inline-desc-en') || {}).value || '';
    var sql = currentSql();
    var payload = {
      query_key: key.trim(),
      query_sql: sql.trim(),
      query_description_zh: zh.trim(),
      query_description_en: en.trim(),
      enabled: (slot.querySelector('.icx-inline-enabled') || {}).checked ? 1 : 0
    };
    if (!payload.query_key) { say(t('webui.icx_q_key_required', '请填写查询标识'), 'error'); return; }
    if (!payload.query_sql) { say(t('webui.icx_q_sql_required', 'SQL 不能为空'), 'error'); return; }
    var cid = edit.cid;
    var isUpdate = !!edit.queryId;
    var url = isUpdate ? '/api/inspection/queries/' + edit.queryId
      : '/api/inspection/chapters/' + containers(cid).chapterId + '/queries';
    post(url, payload, isUpdate ? 'PUT' : 'POST').then(function () {
      cancelEdit();
      say(t('webui.icx_q_saved', '查询已保存'), 'success');
      return loadQueries(cid).then(function () { return loadChapters(true); });
    }).catch(function (e) { say(e.message, 'error'); });
  }

  function deleteQuery(qid, cid) {
    if (!isAdmin()) return;
    var c = containers(cid || 'icx-query-list');
    var q = (c.queries || []).filter(function (x) { return String(x.id) === String(qid); })[0];
    cancelEdit();
    confirmIt(t('webui.icx_q_delete_confirm', '确认删除'),
      t('webui.icx_q_delete_msg', '确定要删除查询「{}」吗？').replace('{}', (q && q.query_key) || t('webui.icx_q_unnamed', '未命名')),
      function () {
        post('/api/inspection/queries/' + qid, {}, 'DELETE').then(function () {
          var target = cid || 'icx-query-list';
          return loadQueries(target).then(function () { return loadChapters(true); });
        }).catch(function (e) { say(e.message, 'error'); });
      });
  }

  // ── CodeMirror 行内编辑器：自适应高度 / 手工拖高 / 放大编辑 / 折行 ──
  function makeEditor(host, value) {
    var ta = document.createElement('textarea');
    ta.value = value == null ? '' : String(value);
    host.appendChild(ta);
    var cm = window.CodeMirror.fromTextArea(ta, {
      mode: 'text/x-sql',
      theme: 'dracula',
      lineNumbers: true,
      matchBrackets: true,
      indentUnit: 2,
      tabSize: 2,
      indentWithTabs: false,
      lineWrapping: state.sqlWrap,
      viewportMargin: 20,
      extraKeys: {
        'Ctrl-Shift-F': function () { formatSql(); },
        'Ctrl-S': function () { saveEdit(); },
        'Esc': function (c) {
          if (c.state && c.state.completionActive) { try { c.closeHint(); } catch (e) {} return; }
          cancelEdit();
        }
      }
    });
    autoSize(cm);
    cm.on('change', function () {
      markDirty();
      if (cm._szTimer) clearTimeout(cm._szTimer);
      cm._szTimer = setTimeout(function () { autoSize(cm); updateSqlMeta(); }, 120);
    });
    setTimeout(function () { try { autoSize(cm); cm.refresh(); } catch (e) {} }, 30);
    return cm;
  }

  function hMin() { return 96; }
  function hMax() { return Math.max(240, Math.round(window.innerHeight * 0.7)); }

  function inDetailModal() {
    var m = $('icx-detail-modal');
    return !!(m && m.style.display === 'flex');
  }

  function availableH(cm) {
    try {
      var wrap = cm.getWrapperElement();
      var form = wrap.closest('.icx-inline');
      var body = form && form.closest('.icx-col-body');
      if (!form || !body) return Infinity;
      var others = form.offsetHeight - wrap.offsetHeight;
      var outside = body.scrollHeight - form.offsetHeight;
      var rect = body.getBoundingClientRect();
      var visibleH = Math.min(body.clientHeight, Math.max(0, window.innerHeight - rect.top) - 8);
      var avail = visibleH - outside - others - 8;
      return avail > 0 ? avail : 0;
    } catch (e) { return Infinity; }
  }

  // 手工拖过的高度优先；否则按内容自适应，且不同场景给不同上下限，
  // 保证「保存 / 取消」始终留在视野内（长 SQL 时按钮不被顶出屏幕）。
  function autoSize(cmArg) {
    var cm = cmArg || (edit && edit.cm);
    if (!cm) return;
    if (state.manualH) {
      var mh = Math.max(hMin(), Math.min(hMax(), state.manualH));
      try { cm.setSize(null, mh); } catch (e) {}
      return;
    }
    var focusOn = !!($('icx-layout') && $('icx-layout').classList.contains('icx-focus-edit'));
    var modal = inDetailModal();
    var vh = window.innerHeight;
    var minH = focusOn ? 240 : (modal ? 140 : 96);
    var maxH = focusOn ? Math.round(vh * 0.52) : (modal ? Math.round(vh * 0.46) : 280);
    var contentH = 0;
    try {
      var lineH = cm.defaultTextHeight() || 19;
      var last = Math.max(0, cm.lineCount() - 1);
      contentH = cm.heightAtLine(last, 'local') + lineH + 14;
    } catch (e) { contentH = 0; }
    if (!contentH || contentH < 1 || !isFinite(contentH)) contentH = minH;
    var capH = maxH;
    if (focusOn) {
      var avail = availableH(cm);
      if (isFinite(avail) && avail > minH) capH = Math.min(maxH, avail);
    }
    try { cm.setSize(null, Math.max(minH, Math.min(capH, Math.round(contentH)))); } catch (e) {}
  }

  function saveManualH() {
    try {
      if (state.manualH) localStorage.setItem(SQL_H_KEY, String(state.manualH));
      else localStorage.removeItem(SQL_H_KEY);
    } catch (e) {}
  }

  function startSqlResize(e) {
    if (!edit || !edit.cm) return;
    if (typeof e.button === 'number' && e.button !== 0) return;
    var handle = e.currentTarget;
    var cm = edit.cm;
    var startY = e.clientY;
    var startH = cm.getWrapperElement().getBoundingClientRect().height;
    var prevManual = state.manualH;
    var moved = false;
    handle.classList.add('active');
    document.body.classList.add('icx-resizing-sql');
    var onMove = function (ev) {
      var dy = ev.clientY - startY;
      if (Math.abs(dy) > 2) moved = true;
      if (!moved) return;
      var h = Math.max(hMin(), Math.min(hMax(), Math.round(startH + dy)));
      state.manualH = h;
      try { cm.setSize(null, h); } catch (err) {}
    };
    var onUp = function () {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      handle.classList.remove('active');
      document.body.classList.remove('icx-resizing-sql');
      if (moved) saveManualH(); else state.manualH = prevManual;
      try { cm.refresh(); } catch (err) {}
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  function resetSqlHeight() {
    state.manualH = null;
    saveManualH();
    autoSize();
    if (edit && edit.cm) { try { edit.cm.refresh(); } catch (e) {} }
    say(t('webui.icx_q_h_reset', '已恢复自适应高度'), 'info');
  }

  function toggleFocusEdit() {
    var layout = $('icx-layout');
    if (!layout) return;
    var on = layout.classList.toggle('icx-focus-edit');
    var btn = edit && edit.slot ? edit.slot.querySelector('[data-tool="focus"]') : null;
    if (btn) {
      btn.innerHTML = on ? SVG.shrink : SVG.expand;
      btn.title = on ? t('webui.icx_q_unfocus_tip', '退出放大（恢复左右栏）')
                     : t('webui.icx_q_focus_tip', '放大编辑（左右栏收纳，专注改这条 SQL）');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    setTimeout(function () {
      autoSize();
      fitLayout();
      if (edit && edit.cm) { try { edit.cm.refresh(); } catch (e) {} }
    }, 160);
  }

  function toggleSqlWrap() {
    if (!edit) return;
    state.sqlWrap = !state.sqlWrap;
    try { localStorage.setItem(SQL_WRAP_KEY, state.sqlWrap ? '1' : '0'); } catch (e) {}
    var cm = edit.cm;
    if (cm) { try { cm.setOption('lineWrapping', state.sqlWrap); cm.refresh(); } catch (e) {} }
    var btn = edit.slot ? edit.slot.querySelector('[data-tool="wrap"]') : null;
    if (btn) {
      btn.classList.toggle('active', state.sqlWrap);
      btn.setAttribute('aria-pressed', state.sqlWrap ? 'true' : 'false');
      btn.title = state.sqlWrap ? t('webui.icx_q_wrap_on', '自动折行：开（长语句折行显示，点按可关闭）')
                                : t('webui.icx_q_wrap_off', '自动折行：关（长语句横向滚动，点按可开启）');
    }
    setTimeout(function () { autoSize(cm); try { if (cm) cm.refresh(); } catch (e) {} }, 60);
  }

  function updateSqlMeta() {
    if (!edit || !edit.slot) return;
    var el = edit.slot.querySelector('.icx-sql-meta');
    if (!el) return;
    var sql = currentSql();
    el.textContent = sql
      ? '· ' + sql.split('\n').length + ' 行 · ' + sql.length + ' 字符'
      : '· ' + t('webui.icx_q_empty_sql', '空');
  }

  function copySql() {
    var sql = currentSql();
    if (!sql) { say(t('webui.icx_q_sql_empty', 'SQL 为空'), 'info'); return; }
    var done = function () { say(t('webui.icx_q_copied', 'SQL 已复制'), 'success'); };
    var fail = function () { say(t('webui.icx_q_copy_fail', '复制失败，请手动选中复制'), 'error'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(sql).then(done).catch(fail);
      } else {
        var ta = document.createElement('textarea');
        ta.value = sql;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      }
    } catch (e) { fail(); }
  }

  /**
   * 保守格式化：保护字符串/行注释/块注释，按子句换行 + 括号缩进 + 关键字大写。
   * 算法取自 DBCheck v2.6 的 _formatInspectionSql（MIT），异常时保留原文不破坏 SQL。
   */
  function formatSqlText(src) {
    src = src == null ? '' : String(src);
    if (!src.trim()) return src;
    var KW_BREAK = {}, KW_SUB = {}, KW_ALL = {};
    ['SELECT','FROM','WHERE','GROUP','HAVING','ORDER','UNION','INTERSECT','MINUS','INSERT','UPDATE',
     'DELETE','CREATE','ALTER','DROP','TRUNCATE','MERGE','WITH','INTO','VALUES','SET','RETURNING',
     'LIMIT','OFFSET','FETCH','EXPLAIN','ANALYZE','PIVOT','UNPIVOT','START','FOR','CONNECT','CYCLE']
      .forEach(function (k) { KW_BREAK[k] = 1; });
    ['AND','OR','LEFT','RIGHT','FULL','INNER','OUTER','CROSS','NATURAL','JOIN','ON','USING',
     'WHEN','THEN','ELSE','CASE','END','PRIOR']
      .forEach(function (k) { KW_SUB[k] = 1; });
    Object.keys(KW_BREAK).forEach(function (k) { KW_ALL[k] = true; });
    Object.keys(KW_SUB).forEach(function (k) { KW_ALL[k] = true; });
    ['AS','BY','IN','LIKE','BETWEEN','EXISTS','ANY','ALL','SOME','NULL','IS','NOT','TRUE','FALSE',
     'DISTINCT','UNIQUE','CHECK','CONSTRAINT','DEFAULT','PRIMARY','FOREIGN','REFERENCES','KEY',
     'INDEX','TABLE','COMMIT','ROLLBACK','SAVEPOINT','GRANT','REVOKE','ROWNUM','ROWID','LEVEL',
     'DUAL','ASC','DESC','SYSDATE','SYSTIMESTAMP','CURRENT_DATE']
      .forEach(function (k) { KW_ALL[k] = true; });

    var toks = [], i = 0, n = src.length, buf = '';
    var pushSql = function () { if (buf) { toks.push({ t: 'sql', v: buf }); buf = ''; } };
    while (i < n) {
      var c = src[i];
      if (c === "'") {
        pushSql();
        var j = i + 1, s = "'";
        while (j < n) {
          s += src[j];
          if (src[j] === "'") {
            if (src[j + 1] === "'") { s += "'"; j += 2; continue; }
            j += 1; break;
          }
          j += 1;
        }
        toks.push({ t: 'str', v: s });
        i = j;
      } else if (c === '-' && src[i + 1] === '-') {
        pushSql();
        var nl = src.indexOf('\n', i);
        toks.push({ t: 'lc', v: (nl === -1) ? src.slice(i) : src.slice(i, nl) });
        i = (nl === -1) ? n : (nl + 1);
      } else if (c === '/' && src[i + 1] === '*') {
        pushSql();
        var en2 = src.indexOf('*/', i + 2);
        toks.push({ t: 'bc', v: (en2 === -1) ? src.slice(i) : src.slice(i, en2 + 2) });
        i = (en2 === -1) ? n : (en2 + 2);
      } else { buf += c; i += 1; }
    }
    pushSql();

    var indent = 0, lineIndent = 0, lines = [], cur = '', noSpaceNext = false;
    var flush = function () { if (cur) { lines.push('  '.repeat(lineIndent) + cur); cur = ''; } noSpaceNext = false; };
    var addToken = function (tok) {
      if (!cur) { cur = tok; lineIndent = indent; noSpaceNext = false; }
      else if (noSpaceNext) { cur += tok; noSpaceNext = false; }
      else { cur += ' ' + tok; }
    };
    toks.forEach(function (tk) {
      if (tk.t === 'lc') { flush(); lines.push('  '.repeat(indent) + tk.v); return; }
      if (tk.t === 'bc') {
        if (tk.v.indexOf('\n') >= 0) { flush(); lines.push('  '.repeat(indent) + tk.v); }
        else addToken(tk.v);
        return;
      }
      if (tk.t === 'str') { addToken(tk.v); return; }
      tk.v.split(/(\s+|\(|\)|<>|!=|<=|>=|=|<|>)/).forEach(function (w) {
        if (!w || /^\s+$/.test(w)) return;
        if (w === '(') { indent += 1; cur = cur ? cur + '(' : '('; noSpaceNext = true; return; }
        if (w === ')') { if (indent > 0) indent -= 1; cur = cur ? cur + ')' : ')'; return; }
        var up = w.toUpperCase();
        if (KW_BREAK[up] || KW_SUB[up]) flush();
        var isKw = KW_ALL[up] && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w);
        addToken(isKw ? up : w);
      });
    });
    flush();
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '');
  }

  function formatSql() {
    if (!edit) return;
    var current = currentSql();
    if (!current || !String(current).trim()) {
      say(t('webui.icx_q_fmt_empty', 'SQL 为空，无需格式化'), 'info');
      return;
    }
    var out;
    try { out = formatSqlText(current); }
    catch (e) {
      console.warn('[inspection] SQL 格式化失败：', e);
      say(t('webui.icx_q_fmt_fail', '格式化失败，已保留原文'), 'error');
      return;
    }
    if (edit.cm) {
      var ref = edit.cm;
      ref.setValue(out);
      autoSize(ref);
      setTimeout(function () { autoSize(ref); try { ref.refresh(); } catch (e) {} }, 60);
    } else if (edit.slot) {
      var ta = edit.slot.querySelector('.icx-cm-fallback');
      if (ta) ta.value = out;
    }
    updateSqlMeta();
    say(t('webui.icx_q_fmt_done', 'SQL 已格式化'), 'success');
  }

  // ── 全屏章节详情弹窗（双击中栏章节打开，ESC 或右上角 × 关闭）──
  var DETAIL_CID = 'icx-detail-query-list';

  function openChapterDetail(id) {
    if (!guardSwitch(function () { openChapterDetail(id); })) return;
    get('/api/inspection/chapters/' + Number(id)).then(function (d) {
      if (!d || !d.data) throw new Error((d && d.message) || t('webui.icx_ch_load_fail', '加载章节详情失败'));
      state.chapterId = Number(id);
      renderChapters();
      var body = $('icx-detail-body');
      var c = containers(DETAIL_CID);
      c.filter = '';
      body.innerHTML = '<div class="icx-detail-full">' +
        detailHtml(d.data, DETAIL_CID, true) + '</div>';
      var m = $('icx-detail-modal');
      m.style.display = 'flex';
      document.addEventListener('keydown', detailKeydown);
      loadQueries(DETAIL_CID);
    }).catch(function (e) { say(e.message, 'error'); });
  }

  function closeChapterDetail() {
    cancelEdit();
    var m = $('icx-detail-modal');
    if (m) m.style.display = 'none';
    document.removeEventListener('keydown', detailKeydown);
  }

  function detailKeydown(e) {
    if (e.key !== 'Escape' || edit) return;      // 行内编辑中：交给编辑器自己的 Esc
    if ($('icx-modal-backdrop')) return;         // 其上还有模板/章节弹窗
    closeChapterDetail();
  }

  function refreshDetailModalIfOpen() {
    var m = $('icx-detail-modal');
    if (!m || m.style.display !== 'flex' || !state.chapterId) return;
    openChapterDetail(state.chapterId);
  }

  // ── 未保存守卫 + 列宽拖拽 ─────────────────────────────────
  // 编辑器展开时切换章节/模板：先确认再丢弃改动，并把「放大编辑」状态一并收尾。
  // （旧版只标记 inspectionQueryUnsaved，这里等价实现）
  function guardSwitch(next) {
    if (edit && edit.dirty) {
      confirmIt(t('webui.icx_q_unsaved', '有未保存的修改'),
        t('webui.icx_q_unsaved_msg', '当前 SQL 有未保存改动，切换会丢弃这些改动，继续？'),
        function () { edit && (edit.dirty = false); cancelEdit(); next(); });
      return false;
    }
    cancelEdit();
    return true;
  }

  function markDirty() { if (edit) edit.dirty = true; }

  function applyCol(which, px) {
    var cfg = COL[which], el = $(cfg.el);
    if (!el) return 0;
    if (!px) { el.style.flex = ''; return 0; }
    var v = Math.max(cfg.min, Math.min(cfg.max, Math.round(px)));
    if (state.stacked) return v;              // 堆叠态宽度由 .icx-stacked 规则决定
    if (which === 'rail' && state.railCollapsed) { el.style.flex = ''; return v; }
    el.style.flex = '0 1 ' + v + 'px';        // 0 1 basis：容器窄时按比例收缩，铺满边缘不留白
    return v;
  }

  // 堆叠判定按「容器实测宽度」而不是窗口宽度：侧栏 260px、AI 面板 420px 都会吃掉可用空间
  function syncMode() {
    var layout = $('icx-layout');
    if (!layout) return;
    var w = layout.clientWidth || layout.getBoundingClientRect().width || 0;
    var needStack = w > 0 && w < 720;
    if (needStack !== state.stacked) {
      state.stacked = needStack;
      layout.classList.toggle('icx-stacked', needStack);
      restoreCols();
    }
    applyRailFlex();
    fitLayout();
  }

  // 高度同样按实测贴合，避免栏底留一大块空白
  function fitLayout() {
    var layout = $('icx-layout');
    if (!layout) return;
    if (state.stacked) { layout.style.height = ''; return; }
    var top = layout.getBoundingClientRect().top;
    var h = Math.round(window.innerHeight - top - 14);
    layout.style.height = Math.max(420, h) + 'px';
  }

  // 收缩完全交给 CSS（.icx-collapsed / .icx-rail-collapsed + !important 锁 52px），
  // 这里只负责在展开时把用户自定义宽度放回内联样式，两者不再互相覆盖。
  function applyRailFlex() {
    var rail = $('icx-rail');
    if (!rail) return;
    rail.classList.toggle('icx-collapsed', !!state.railCollapsed);
    var layout = $('icx-layout');
    if (layout) layout.classList.toggle('icx-rail-collapsed', !!state.railCollapsed);
    if (state.railCollapsed || state.stacked) { rail.style.flex = ''; return; }
    rail.style.flex = '0 1 ' + (state.colW.rail || COL.rail.def) + 'px';
  }

  function saveCols() {
    try { localStorage.setItem(COL_KEY, JSON.stringify(state.colW)); } catch (e) {}
  }

  function restoreCols() {
    var w = {};
    try { w = JSON.parse(localStorage.getItem(COL_KEY) || '{}') || {}; } catch (e) { return; }
    Object.keys(COL).forEach(function (k) {
      if (w[k]) {
        var v = applyCol(k, w[k]);
        if (v) state.colW[k] = v; else delete state.colW[k];
      }
    });
  }

  function initSplitters() {
    Array.prototype.forEach.call(document.querySelectorAll('#icx-layout .icx-splitter'), function (sp) {
      var which = sp.getAttribute('data-split');
      if (!COL[which]) return;
      sp.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        var el = $(COL[which].el);
        if (!el) return;
        var startX = e.clientX, startW = el.getBoundingClientRect().width;
        sp.classList.add('active');
        document.body.classList.add('icx-resizing-col');
        var move = function (ev) {
          var v = applyCol(which, startW + (ev.clientX - startX));
          if (v) state.colW[which] = v;
          if (edit && edit.cm) { try { edit.cm.refresh(); } catch (err) {} }
        };
        var up = function () {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
          document.removeEventListener('pointercancel', up);
          sp.classList.remove('active');
          document.body.classList.remove('icx-resizing-col');
          saveCols();
          autoSize();
          fitLayout();
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
        document.addEventListener('pointercancel', up);
      });
      // 双击分隔条：清掉内联宽度，回到样式默认
      sp.addEventListener('dblclick', function () {
        applyCol(which, 0);
        delete state.colW[which];
        saveCols();
        say(t('webui.icx_col_reset', '已恢复默认列宽'), 'info');
      });
    });
  }

  // ── 入口 ──────────────────────────────────────────────────
  function load() {
    try {
      state.railCollapsed = localStorage.getItem(RAIL_KEY) === '1';
      var hv = parseInt(localStorage.getItem(SQL_H_KEY), 10);
      if (hv && hv > 0) state.manualH = hv;
      var wv = localStorage.getItem(SQL_WRAP_KEY);
      if (wv === '0') state.sqlWrap = false;
    } catch (e) {}
    var layout = $('icx-layout');
    if (layout) layout.classList.remove('icx-focus-edit');   // 防御：上次遗留的放大态会把左栏藏掉
    toggleRail(state.railCollapsed);
    syncMode();
    initSplitters();
    if (!state._resizeBound) {
      state._resizeBound = true;
      window.addEventListener('resize', function () {
        if (state._rz) clearTimeout(state._rz);
        state._rz = setTimeout(syncMode, 140);
      });
    }
    ensureCm();
    ensureSortable().then(function () { renderChapters(); });
    return loadTemplates();
  }

  window.FusionInspection = {
    load: load,
    toggleRail: toggleRail,
    onTplSearch: onTplSearch,
    onTplDbType: onTplDbType,
    toggleTypePanel: toggleTypePanel,
    closeTypePanel: closeTypePanel,
    syncMode: syncMode,
    fitLayout: fitLayout,
    selectTemplate: selectTemplate,
    newTemplate: newTemplate,
    editTemplateMeta: editTemplateMeta,
    cloneTemplate: cloneTemplate,
    deleteTemplate: deleteTemplate,
    exportTemplate: exportTemplate,
    pickImportFile: pickImportFile,
    importFromFile: importFromFile,
    selectChapter: selectChapter,
    openChapterDetail: openChapterDetail,
    closeChapterDetail: closeChapterDetail,
    newChapter: newChapter,
    editChapter: editChapter,
    deleteChapter: deleteChapter,
    filterQueries: filterQueries,
    toggleQueryEdit: toggleQueryEdit,
    newQuery: newQuery,
    cancelEdit: cancelEdit,
    saveEdit: saveEdit,
    deleteQuery: deleteQuery,
    formatSql: formatSql,
    copySql: copySql,
    toggleFocusEdit: toggleFocusEdit,
    toggleSqlWrap: toggleSqlWrap,
    startSqlResize: startSqlResize,
    resetSqlHeight: resetSqlHeight,
    closeModal: closeModal
  };
})();
