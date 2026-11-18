/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * 历史趋势分析页面脚本：异常识别 + 变化语义 + 指标溯源抽屉。
 * 只读：仅 GET /api/history_instances、/api/trend/analysis、
 *       /api/trend/metric/detail、/api/trend/metric/raw，不发任何写请求。
 * 事件全部走 document 级分发（遮罩与抽屉为兄弟节点），无内联 onclick。
 */
(function () {
  'use strict';

  // 目标环境 toast 签名为 toast(msg, type, duration)，这里映射源端两个助手
  function toastError(msg) {
    if (typeof window.toast === 'function') window.toast(msg, 'error');
    else console.error(msg);
  }
  function toastSuccess(msg) {
    if (typeof window.toast === 'function') window.toast(msg, 'success');
  }

// ─── Trend Analysis（重构版：异常识别 + 变化语义）────────────────────
let trendInstances = [];
let trendAnalysis = null;    // 最近一次分析结果
let trResizeTimer = null;
let trSearchTimer = null;

// ── 指标总览的视图状态（筛选 / 搜索 / 排序 / 折叠 / 展开）──
let trFilterMode = 'all';       // all | anomaly | changed | primary
let trSearch = '';
let trGroupFilter = '';
let trCoverageMode = 'all';     // all | full（仅完整采集）
let trSortMode = 'smart';       // smart | change | name
let trCollapsedGroups = new Set();
let trOpenKeys = new Set();     // 展开详情的指标 key

// ── 实例选择器（目录树形下拉面板）状态 ──
let trDirs = [];                // /api/pro/dirs 目录节点
let trDsList = [];              // /api/pro/datasources 数据源（仅用来给历史实例归目录）
let trInstMeta = [];            // 与 trendInstances 同序：{dirId,dirPath,dirName,dsName,dsId,matched}
let trInstDirFilter = '__all__';// 左树当前选中的目录 id（__all__ = 全部）
let trInstSearch = '';          // 面板搜索词
let trInstPanelOpen = false;
let trInstSearchTimer = null;
let trTreeExpanded = new Set(); // 展开的目录 id

const TR_GROUP_ORDER = ['health', 'os', 'space', 'memory', 'conn', 'perf', 'config', 'index', 'other'];

/** i18n 取值 + 兜底：服务端未重启时新 key 可能尚未注入，回退到中文常量 */
function trT(key, fallback) {
  const v = (typeof window.i18n === 'function') ? window.i18n(key) : undefined;
  return (v === undefined || v === null || v === '') ? fallback : v;
}

/** HTML 转义：异常项名称/描述来自巡检数据，必须转义后再拼进 innerHTML */
function trEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 数值格式化：兼顾大数（TOP SQL 耗时）与小数（偏差百分比） */
function trFmt(v) {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (!isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a === 0) return '0';
  let s;
  if (a >= 1000) s = Math.round(n).toLocaleString();
  else if (a >= 100) s = n.toFixed(1);
  else if (a >= 10) s = n.toFixed(2);
  else s = n.toFixed(3);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

const TR_STATUS_TEXT = {
  worsening: () => trT('webui.trend_status_worsening', '恶化'),
  improving: () => trT('webui.trend_status_improving', '改善'),
  stable:    () => trT('webui.trend_status_stable', '平稳'),
  rising:    () => trT('webui.trend_status_rising', '上升'),
  falling:   () => trT('webui.trend_status_falling', '下降'),
  unknown:   () => trT('webui.trend_status_unknown', '数据不足'),
};
const TR_VERDICT_TEXT = {
  worsening: () => trT('webui.trend_verdict_worsening', '整体恶化'),
  attention: () => trT('webui.trend_verdict_attention', '需要关注'),
  improving: () => trT('webui.trend_verdict_improving', '整体改善'),
  stable:    () => trT('webui.trend_verdict_stable', '运行平稳'),
};
const TR_VERDICT_ICON = { worsening: '🔴', attention: '🟡', improving: '🟢', stable: '🔵' };
const TR_ISSUE_TEXT = {
  new:        () => trT('webui.trend_issue_new', '新增'),
  persistent: () => trT('webui.trend_issue_persistent', '持续'),
  resolved:   () => trT('webui.trend_issue_resolved', '已消除'),
};
const TR_GROUP_COLOR = {
  health: '#f85149', os: '#e3b341', space: '#a371f7', memory: '#79c0ff',
  conn: '#2ea043', perf: '#06b6d4', config: '#ff7b72', index: '#8b5cf6',
};

function trStatusText(s) { const f = TR_STATUS_TEXT[s]; return f ? f() : String(s || ''); }

function trHideResult() {
  const r = document.getElementById('trend-result');
  if (r) r.style.display = 'none';
  const e = document.getElementById('trend-empty');
  if (e) e.style.display = 'block';
  const m = document.getElementById('trend-empty-msg');
  if (m) m.textContent = trT('webui.trend_no_data', '执行巡检后，历史趋势数据将在这里显示');
}

async function loadTrendInstances() {
  const sel = document.getElementById('trend-instance-select');
  if (!sel) return;
  // 刷新前记住当前选中的实例 key，刷新后尽量保持选择（而不是跳回第一个）
  const prevIdx = parseInt(sel.value, 10);
  const prevKey = (!isNaN(prevIdx) && trendInstances[prevIdx]) ? trendInstances[prevIdx].key : null;
  trendAnalysis = null;
  trResetMetricUI();
  sel.innerHTML = '<option value="">' + trT('webui.trend_loading', '-- 加载中 --') + '</option>';
  trInstSetTriggerLoading();
  trHideResult();
  try {
    const [histRes, picker] = await Promise.all([
      fetch('/api/history_instances').then(r => r.json()),
      trPickerData()
    ]);
    trendInstances = histRes.instances || [];
    trDirs = picker.dirs || [];
    trDsList = picker.list || [];
    trBuildInstMeta();
    trTreeExpanded = new Set(trDirs.map(d => d.id));   // 目录默认全展开，层级一眼可见
    if (trendInstances.length === 0) {
      sel.innerHTML = '<option value="">' + trT('webui.trend_no_history', '-- 暂无历史记录，请先执行巡检 --') + '</option>';
      trInstRenderTree(); trInstRenderList();
      trInstSetTriggerEmpty(); trInstRefreshInfo();
      return;
    }
    // 隐藏的原生 select 仍是取值载体（value=实例序号），loadTrendData 契约不变
    sel.innerHTML = trendInstances.map((inst, i) =>
      `<option value="${i}">${trEsc(inst.label || inst.host)}</option>`
    ).join('');
    let idx = 0;
    if (prevKey) {
      const found = trendInstances.findIndex(x => x.key === prevKey);
      if (found >= 0) idx = found;
    }
    sel.value = String(idx);
    trInstDirFilter = '__all__'; trInstSearch = '';
    const searchEl = document.getElementById('tr-inst-search');
    if (searchEl) searchEl.value = '';
    trInstRenderTree(); trInstRenderList();
    trInstRefreshTrigger(); trInstRefreshInfo();
    loadTrendData();   // 选中即加载，省掉一次「查看趋势」点击
  } catch (e) {
    sel.innerHTML = '<option value="">' + trT('webui.trend_load_fail', '-- 加载失败 --') + '</option>';
    trInstSetTriggerEmpty();
  }
}

function onTrendInstanceChange() {
  trendAnalysis = null;
  trResetMetricUI();
  trHideResult();
}

async function loadTrendData() {
  const sel = document.getElementById('trend-instance-select');
  const idx = parseInt(sel.value, 10);
  if (isNaN(idx) || !trendInstances[idx]) return;
  const inst = trendInstances[idx];
  const days = document.getElementById('trend-range-select').value || '0';
  const btn = document.querySelector('#page-trend .btn-primary');

  if (btn) { btn.disabled = true; btn.style.opacity = '.6'; }
  try {
    const res = await fetch('/api/trend/analysis?db_type=' + encodeURIComponent(inst.db_type) +
      '&host=' + encodeURIComponent(inst.host) + '&port=' + encodeURIComponent(inst.port) +
      '&days=' + encodeURIComponent(days));
    const data = await res.json();
    if (!data.ok || !data.analysis) {
      toastError((data && data.error) || '加载趋势分析失败');
      trHideResult();
      return;
    }
    trendAnalysis = data.analysis;
    trResetMetricUI();
    trRenderAll(inst);
  } catch(e) {
    console.error(e);
    toastError('加载趋势分析失败: ' + e.message);
    trHideResult();
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

// ─── 实例选择器：目录树形下拉面板 ───────────────────────────────────
// 历史实例（/api/history_instances）本身不带目录，这里用 主机+端口+归一化类型
// 去 /api/pro/datasources 里匹配数据源，借它的 dir_id/dir_path 归目录；匹配不到的
// 落进「未分配」。展示名一律用历史 label（同一数据源可能因连接方式不同产生多条
// 历史，如 oracle 与 oracle_jdbc，靠 label + 类型徽标区分，不能拿数据源名覆盖）。

/** 目录 + 数据源：优先复用全站选择器的共享缓存，未就绪时直接取数兜底 */
function trPickerData() {
  if (window.FusionDsPicker && typeof window.FusionDsPicker.pickerData === 'function') {
    return window.FusionDsPicker.pickerData(true).catch(() => ({ dirs: [], list: [] }));
  }
  return Promise.all([
    fetch('/api/pro/dirs').then(r => r.json()).catch(() => ({ dirs: [] })),
    fetch('/api/pro/datasources').then(r => r.json()).catch(() => ({ datasources: [] }))
  ]).then(([d, s]) => ({ dirs: (d && d.dirs) || [], list: (s && s.datasources) || [] }));
}

/** 类型归一（oracle_jdbc/oracle_thin→oracle 等），与全站选择器同口径 */
function trNormType(v) {
  if (window.FusionDsPicker && typeof window.FusionDsPicker.normType === 'function') {
    return window.FusionDsPicker.normType(v);
  }
  return String(v || '').toLowerCase().trim().replace(/_jdbc$|_thin$/, '');
}

/** 给每个历史实例算出所属目录（同序写入 trInstMeta） */
function trBuildInstMeta() {
  const unassigned = trDirs.find(d => d.kind === 'unassigned') ||
    { id: 'dir_unassigned', full_path: '未分配', name: '未分配' };
  trInstMeta = trendInstances.map(h => {
    const ht = trNormType(h.db_type);
    const cands = trDsList.filter(d =>
      String(d.host) === String(h.host) &&
      String(d.port) === String(h.port) &&
      trNormType(d.db_type) === ht);
    let ds = null;
    if (cands.length) {
      // 同 host:port 可能登记了多条数据源，优先原始 db_type 完全一致的那条
      ds = cands.find(d => String(d.db_type).toLowerCase() === String(h.db_type).toLowerCase()) || cands[0];
    }
    if (ds && ds.dir_id && ds.dir_id !== 'dir_unassigned') {
      return {
        dirId: ds.dir_id, dirPath: ds.dir_path || ds.dir_name || '',
        dirName: ds.dir_name || ds.dir_path || '', dsName: ds.name || '', dsId: ds.id, matched: true
      };
    }
    return {
      dirId: unassigned.id, dirPath: unassigned.full_path || '未分配',
      dirName: unassigned.name || '未分配', dsName: '', dsId: '', matched: false
    };
  });
}

function trDirChildren() {
  const map = {};
  trDirs.forEach(d => { const p = d.parent_id || ''; (map[p] = map[p] || []).push(d); });
  return map;
}

function trInstCountByDir() {
  const c = {};
  trInstMeta.forEach(m => { c[m.dirId] = (c[m.dirId] || 0) + 1; });
  return c;
}

/** 各目录的子树实例数（含自身），用于左树徽标与「只显示有实例的目录」 */
function trDirSubtreeCounts(children, direct) {
  const sub = {};
  function walk(id) {
    if (id in sub) return sub[id];
    let n = direct[id] || 0;
    (children[id] || []).forEach(ch => { n += walk(ch.id); });
    sub[id] = n;
    return n;
  }
  trDirs.forEach(d => walk(d.id));
  return sub;
}

function trDirDescendants(id, children) {
  const set = new Set([id]);
  (children[id] || []).forEach(ch => {
    trDirDescendants(ch.id, children).forEach(x => set.add(x));
  });
  return set;
}

const TR_CARET_SVG = '<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const TR_ICON_ALL = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>';
const TR_ICON_DIR = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>';
const TR_ICON_UNASSIGNED = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M9 13h6"/></svg>';

function trInstRenderTree() {
  const el = document.getElementById('tr-inst-tree');
  if (!el) return;
  const children = trDirChildren();
  const direct = trInstCountByDir();
  const sub = trDirSubtreeCounts(children, direct);
  let html =
    `<div class="tr-tree-node${trInstDirFilter === '__all__' ? ' active' : ''}" data-tr-inst-dir="__all__" role="treeitem" aria-selected="${trInstDirFilter === '__all__'}">` +
      `<span class="tr-tree-caret empty">${TR_CARET_SVG}</span>` +
      `<span class="tr-tree-icon">${TR_ICON_ALL}</span>` +
      `<span class="tr-tree-name">全部实例</span>` +
      `<span class="tr-tree-count">${trendInstances.length}</span>` +
    `</div>`;
  (children[''] || []).filter(d => (sub[d.id] || 0) > 0)
    .forEach(d => { html += trTreeNodeHtml(d, children, sub, 0); });
  el.innerHTML = html;
}

function trTreeNodeHtml(d, children, sub, depth) {
  const kids = (children[d.id] || []).filter(k => (sub[k.id] || 0) > 0);
  const hasKids = kids.length > 0;
  const expanded = trTreeExpanded.has(d.id);
  const active = trInstDirFilter === d.id;
  const pad = 6 + depth * 14;
  const caret = hasKids
    ? `<span class="tr-tree-caret${expanded ? ' open' : ''}" data-tr-caret="${trEsc(d.id)}">${TR_CARET_SVG}</span>`
    : `<span class="tr-tree-caret empty">${TR_CARET_SVG}</span>`;
  let html =
    `<div class="tr-tree-node${active ? ' active' : ''}" data-tr-inst-dir="${trEsc(d.id)}" style="padding-left:${pad}px" role="treeitem" aria-selected="${active}"${hasKids ? ` aria-expanded="${expanded}"` : ''}>` +
      caret +
      `<span class="tr-tree-icon">${d.kind === 'unassigned' ? TR_ICON_UNASSIGNED : TR_ICON_DIR}</span>` +
      `<span class="tr-tree-name" title="${trEsc(d.full_path || d.name)}">${trEsc(d.name)}</span>` +
      `<span class="tr-tree-count">${sub[d.id] || 0}</span>` +
    `</div>`;
  if (hasKids && expanded) kids.forEach(k => { html += trTreeNodeHtml(k, children, sub, depth + 1); });
  return html;
}

/** 健康徽标：优秀/良好→绿，一般→蓝，需关注→黄，差/风险→红 */
function trHealthBadge(h) {
  const s = String(h || '');
  let cls = 'tr-hb-fair';
  if (/优秀|良好|Excellent|Good/i.test(s)) cls = 'tr-hb-good';
  else if (/需关注|注意|Attention/i.test(s)) cls = 'tr-hb-warn';
  else if (/差|风险|危险|Poor|Bad/i.test(s)) cls = 'tr-hb-bad';
  return `<span class="tr-hb ${cls}">${trEsc(s || '—')}</span>`;
}

/** 最近巡检时间收窄成 MM-DD HH:mm（完整值放 title） */
function trShortTime(t) {
  if (!t) return '—';
  const m = String(t).match(/^\d{4}-(\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? (m[1] + ' ' + m[2]) : String(t);
}

function trInstRenderList() {
  const el = document.getElementById('tr-inst-list');
  if (!el) return;
  const children = trDirChildren();
  const allow = (trInstDirFilter === '__all__') ? null : trDirDescendants(trInstDirFilter, children);
  const q = trInstSearch.trim().toLowerCase();
  const rows = [];
  trendInstances.forEach((h, i) => {
    const m = trInstMeta[i] || {};
    if (allow && !allow.has(m.dirId)) return;
    if (q) {
      const hay = [h.label, h.host, h.port, h.db_type, m.dirPath, m.dsName].join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return;
    }
    rows.push({ h, i, m });
  });
  rows.sort((a, b) =>
    String(a.m.dirPath || '').localeCompare(String(b.m.dirPath || ''), 'zh') ||
    String(a.h.label || '').localeCompare(String(b.h.label || ''), 'zh'));
  const cnt = document.getElementById('tr-inst-panel-count');
  if (cnt) cnt.textContent = rows.length + ' / ' + trendInstances.length + ' 个实例';
  if (!rows.length) {
    el.innerHTML = '<div class="tr-inst-empty">没有匹配的实例</div>';
    return;
  }
  const sel = document.getElementById('trend-instance-select');
  const selIdx = sel ? parseInt(sel.value, 10) : NaN;
  el.innerHTML = rows.map(({ h, i, m }) => {
    const name = h.label || h.host;
    const sub = (h.db_type || '').toUpperCase() + ' · ' + h.host + ':' + h.port;
    const dirTxt = '📁 ' + (m.dirPath || m.dirName || '未分配');
    const selected = i === selIdx;
    return `<div class="tr-inst-row${selected ? ' selected' : ''}" data-tr-inst="${i}" role="option" aria-selected="${selected}">` +
      `<div class="tr-inst-cell-name"><div class="tr-inst-name" title="${trEsc(name)}">${trEsc(name)}</div>` +
        `<div class="tr-inst-sub" title="${trEsc(sub)}">${trEsc(sub)}</div></div>` +
      `<div class="tr-inst-cell-dir" title="${trEsc(m.dirPath || '未分配')}">${trEsc(dirTxt)}</div>` +
      `<div class="tr-inst-cell-count"><span class="tr-count-badge">${trEsc(h.snapshot_count)}<i>次</i></span></div>` +
      `<div class="tr-inst-cell-health">${trHealthBadge(h.last_health)}</div>` +
      `<div class="tr-inst-cell-time" title="${trEsc(h.last_time || '')}">${trEsc(trShortTime(h.last_time))}</div>` +
    `</div>`;
  }).join('');
}

function trInstRefreshTrigger() {
  const sel = document.getElementById('trend-instance-select');
  const lab = document.getElementById('tr-inst-trigger-label');
  const meta = document.getElementById('tr-inst-trigger-meta');
  const idx = sel ? parseInt(sel.value, 10) : NaN;
  const h = trendInstances[idx];
  if (!h) {
    if (lab) lab.textContent = '-- 请选择实例 --';
    if (meta) meta.textContent = '';
    return;
  }
  const m = trInstMeta[idx] || {};
  if (lab) lab.textContent = h.label || h.host;
  if (meta) meta.textContent = '📁 ' + (m.dirPath || '未分配') + ' · ' + h.snapshot_count + ' 次巡检';
}

function trInstRefreshInfo() {
  const el = document.getElementById('tr-inst-info');
  if (!el) return;
  const sel = document.getElementById('trend-instance-select');
  const idx = sel ? parseInt(sel.value, 10) : NaN;
  const h = trendInstances[idx];
  if (!h) { el.hidden = true; el.innerHTML = ''; return; }
  const m = trInstMeta[idx] || {};
  el.hidden = false;
  el.innerHTML =
    '<span class="tr-info-item"><b>目录</b>📁 ' + trEsc(m.dirPath || '未分配') + '</span>' +
    '<span class="tr-info-item"><b>类型</b>' + trEsc((h.db_type || '').toUpperCase()) + '</span>' +
    '<span class="tr-info-item"><b>地址</b>' + trEsc(h.host + ':' + h.port) + '</span>' +
    '<span class="tr-info-item"><b>巡检</b>' + trEsc(h.snapshot_count) + ' 次</span>' +
    '<span class="tr-info-item"><b>最近健康</b>' + trHealthBadge(h.last_health) + '</span>' +
    '<span class="tr-info-item"><b>风险项</b>' + trEsc(h.last_risk == null ? '—' : h.last_risk) + ' 项</span>' +
    '<span class="tr-info-item"><b>最近巡检</b>' + trEsc(h.last_time || '—') + '</span>';
}

function trInstSetTriggerLoading() {
  const l = document.getElementById('tr-inst-trigger-label');
  if (l) l.textContent = '-- 加载中 --';
  const m = document.getElementById('tr-inst-trigger-meta');
  if (m) m.textContent = '';
  trInstClosePanel();
  const info = document.getElementById('tr-inst-info');
  if (info) { info.hidden = true; info.innerHTML = ''; }
}

function trInstSetTriggerEmpty() {
  const l = document.getElementById('tr-inst-trigger-label');
  if (l) l.textContent = '-- 暂无历史实例 --';
  const m = document.getElementById('tr-inst-trigger-meta');
  if (m) m.textContent = '';
}

function trInstTogglePanel() {
  const panel = document.getElementById('tr-inst-panel');
  const trig = document.getElementById('tr-inst-trigger');
  if (!panel) return;
  trInstPanelOpen = !trInstPanelOpen;
  panel.hidden = !trInstPanelOpen;
  if (trig) trig.setAttribute('aria-expanded', String(trInstPanelOpen));
  if (trInstPanelOpen) {
    trInstRenderTree(); trInstRenderList();
    trInstPositionPanel();
    const s = document.getElementById('tr-inst-search');
    if (s) { s.value = trInstSearch; setTimeout(() => s.focus(), 0); }
  }
}

/** 面板定位：默认绝对定位、宽度=触发框宽（width:100%），右缘与选择框对齐。
    仅当触发框太窄（窄屏放不下 树+表）或右缘会超出视口时，改 fixed 并把宽度放宽到
    可用下限、水平位置夹取进视口。面板始终留在 .tr-inst-wrap 的 DOM 子树里，
    外部点击判定（closest('.tr-inst-wrap')）不受影响。 */
function trInstPositionPanel() {
  const panel = document.getElementById('tr-inst-panel');
  const trig = document.getElementById('tr-inst-trigger');
  if (!panel || !trig || panel.hidden) return;
  panel.style.position = ''; panel.style.left = ''; panel.style.top = ''; panel.style.width = '';
  const vw = document.documentElement.clientWidth;
  const tr = trig.getBoundingClientRect();
  const margin = 12;
  const natural = panel.offsetWidth;          // = 触发框宽（width:100%）
  const minW = 480;                           // 左树180 + 右表≈300 的可用下限
  const maxW = vw - margin * 2;
  const w = Math.min(Math.max(natural, Math.min(minW, maxW)), maxW);
  let left = tr.left;
  if (left + w > vw - margin) left = Math.max(margin, vw - margin - w);
  // 与默认（贴触发器、同宽、绝对定位）一致时保持不动；否则 fixed 夹取
  if (w !== natural || Math.abs(left - tr.left) > 0.5) {
    panel.style.position = 'fixed';
    panel.style.width = w + 'px';
    panel.style.left = left + 'px';
    panel.style.top = (tr.bottom + 6) + 'px';
  }
}

function trInstClosePanel() {
  if (!trInstPanelOpen) return;
  trInstPanelOpen = false;
  const panel = document.getElementById('tr-inst-panel');
  if (panel) panel.hidden = true;
  const trig = document.getElementById('tr-inst-trigger');
  if (trig) trig.setAttribute('aria-expanded', 'false');
}

/** 选中某实例：写回隐藏 select → 刷触发器/信息条/列表高亮 → 关面板 → 自动加载 */
function trSelectInstance(idx) {
  const sel = document.getElementById('trend-instance-select');
  if (!sel || !trendInstances[idx]) return;
  sel.value = String(idx);
  trInstRefreshTrigger(); trInstRefreshInfo(); trInstRenderList();
  trInstClosePanel();
  onTrendInstanceChange();
  loadTrendData();
}

function trRenderAll(inst) {
  const a = trendAnalysis;
  const result = document.getElementById('trend-result');
  const empty = document.getElementById('trend-empty');

  if (!a || !a.snapshots_count) {
    // 有历史但该时间范围内没有快照：明确告知，避免误以为「没巡检过」
    const msg = document.getElementById('trend-empty-msg');
    if (msg) msg.textContent = trT('webui.trend_range_empty', '该时间范围内没有巡检快照，请调整时间范围后重试');
    result.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  const msg = document.getElementById('trend-empty-msg');
  if (msg) msg.textContent = trT('webui.trend_no_data', '执行巡检后，历史趋势数据将在这里显示');

  empty.style.display = 'none';
  result.style.display = 'block';

  trRenderVerdict(a, inst);
  trRenderIssues(a);
  trRenderHealthRisk(a);
  trRenderMetrics(a);
}

/** ① 结论横幅：一眼看出「整体变好还是变坏」 */
function trRenderVerdict(a, inst) {
  const s = a.summary || {};
  const v = TR_VERDICT_TEXT[s.verdict] ? s.verdict : 'stable';
  const el = document.getElementById('trend-verdict');
  const range = a.range ? (a.range.from + ' ~ ' + a.range.to) : '';

  const stats = [
    { cls: 'is-new',        num: s.new_count || 0,                     label: trT('webui.trend_stat_new', '新增异常') },
    { cls: 'is-persistent', num: s.persistent_count || 0,              label: trT('webui.trend_stat_persistent', '持续异常') },
    { cls: 'is-resolved',   num: s.resolved_count || 0,                label: trT('webui.trend_stat_resolved', '已消除') },
    { cls: 'is-worsening',  num: (s.worsening_metrics || []).length,   label: trT('webui.trend_stat_worsening', '恶化指标') },
  ].filter(x => x.num > 0).map(x =>
    `<div class="tr-stat ${x.cls}"><div class="tr-stat-num">${x.num}</div><div class="tr-stat-label">${trEsc(x.label)}</div></div>`
  ).join('');

  const healthTxt = (s.last_health_score === null || s.last_health_score === undefined)
    ? ''
    : trT('webui.trend_last_health', '最新健康评分') + ': ' + trFmt(s.last_health_score) +
      (s.last_health_status ? ' (' + s.last_health_status + ')' : '');
  const meta = [
    a.snapshots_count + ' ' + trT('webui.trend_snapshots', '快照数'),
    range, healthTxt,
  ].filter(Boolean).join(' · ');

  el.innerHTML = `
    <div class="tr-verdict ${v}">
      <div class="tr-verdict-icon">${TR_VERDICT_ICON[v] || '🔵'}</div>
      <div class="tr-verdict-body">
        <div class="tr-verdict-title">${trEsc(TR_VERDICT_TEXT[v]())}
          <span style="font-size:12px;font-weight:500;color:var(--text-muted)">${trEsc(inst ? (inst.label || inst.host) : '')}</span>
        </div>
        <div class="tr-verdict-reason">${trEsc(s.verdict_reason || '')}</div>
        <div class="tr-verdict-meta">${trEsc(meta)}</div>
        ${stats ? `<div class="tr-stats">${stats}</div>` : ''}
      </div>
    </div>`;
}

/** ② 异常项看板：新增 / 持续 / 已消除 + 迷你出现条 */
function trRenderIssues(a) {
  const card = document.getElementById('trend-issue-card');
  const board = document.getElementById('trend-issue-board');
  const countEl = document.getElementById('trend-issue-count');
  const issues = a.issues || [];
  const n = a.snapshots_count || 0;

  card.style.display = 'block';
  countEl.textContent = issues.length;
  if (!issues.length) {
    board.innerHTML = `<div style="padding:22px;text-align:center;color:var(--text-muted);font-size:13px">${trEsc(trT('webui.trend_issue_none', '该时间范围内未发现异常项'))}</div>`;
    return;
  }

  const rows = issues.map(e => {
    const sev = e.severity >= 3 ? 'sev-high' : (e.severity === 2 ? 'sev-mid' : 'sev-low');
    const hitSet = new Set(e.hit_indices || []);
    let bar = '';
    for (let i = 0; i < n; i++) {
      bar += `<i class="${hitSet.has(i) ? 'on ' + e.status : ''}"></i>`;
    }
    const streakTxt = e.streak > 1
      ? ' · ' + trT('webui.trend_col_streak', '连续') + ' ' + e.streak + trT('webui.trend_streak_unit', '次')
      : '';
    const fix = e.fix_sql
      ? `<button class="tr-fix-btn" data-tr-fix="${trEsc(encodeURIComponent(e.fix_sql))}">${trEsc(trT('webui.trend_copy_fix', '复制修复 SQL'))}</button>`
      : '<span style="color:var(--text-muted)">—</span>';
    return `<tr class="tr-row-${e.status}">
      <td>
        <div class="tr-issue-name">${trEsc(e.name)}</div>
        ${e.description ? `<div class="tr-issue-desc">${trEsc(e.description)}</div>` : ''}
      </td>
      <td><span class="tr-badge ${e.status}">${trEsc(TR_ISSUE_TEXT[e.status] ? TR_ISSUE_TEXT[e.status]() : e.status)}</span></td>
      <td><span class="tr-badge ${sev}">${trEsc(e.level || '—')}</span></td>
      <td><div class="tr-presence">${bar}<span class="tr-presence-txt">${e.total_hits}/${n}${streakTxt}</span></div></td>
      <td style="white-space:nowrap;font-size:12px;color:var(--text-muted)">${trEsc(String(e.last_ts || '').slice(0, 16))}</td>
      <td>${fix}</td>
    </tr>`;
  }).join('');

  board.innerHTML = `<div style="overflow-x:auto"><table class="tr-issue-table">
    <thead><tr>
      <th>${trEsc(trT('webui.trend_col_issue', '异常项'))}</th>
      <th>${trEsc(trT('webui.trend_col_status', '状态'))}</th>
      <th>${trEsc(trT('webui.trend_col_level', '等级'))}</th>
      <th>${trEsc(trT('webui.trend_col_presence', '出现情况'))}</th>
      <th>${trEsc(trT('webui.trend_col_last', '最近出现'))}</th>
      <th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

/** ③ 健康评分 + 风险项数量（双轴合并图） */
function trRenderHealthRisk(a) {
  const card = document.getElementById('trend-hr-card');
  const health = (a.health_scores || []).map(v => (v === null || v === undefined) ? null : Number(v));
  const risk = (a.risk_counts || []).map(v => (v === null || v === undefined) ? null : Number(v));
  if (!health.some(v => v !== null)) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  const last = health.filter(v => v !== null).pop();
  document.getElementById('trend-hr-latest').textContent =
    (last === undefined) ? '' : trT('webui.trend_last_health', '最新健康评分') + ' ' + trFmt(last);
  trDrawHealthRisk('trend-hr-canvas', a.labels || [], health, risk);
}

// ─── 指标总览：判定 / 排序 / 筛选 ───────────────────────────────

/** 是否异常：当前超标 / 恶化 / 窗口内曾超标 */
function trIsAnomaly(m) {
  return !!(m.breaching_now || m.status === 'worsening' || (m.breaches || []).length);
}

/** 是否有变化：窗口内确有波动且非平稳（单点采集天然无变化） */
function trIsChanged(m) {
  return !!m.has_variance && m.status !== 'stable' && m.status !== 'unknown';
}

/** 变化的好坏（null = 中性指标，只显示涨跌不判优劣） */
function trDeltaGood(m) {
  const d = m.delta;
  if (d === null || d === undefined || d === 0) return null;
  if (m.direction === 'up_bad') return d < 0;
  if (m.direction === 'up_good') return d > 0;
  return null;
}

/** 智能排序权重：当前超标 → 恶化 → 曾超标 → 其他 → 改善 → 单点采集 */
function trMetricRank(m) {
  if (m.breaching_now) return 0;
  if (m.status === 'worsening') return 1;
  if ((m.breaches || []).length) return 2;
  if (m.single_sample) return 5;
  if (m.status === 'improving') return 4;
  return 3;
}

/** 按当前视图状态筛出要展示的指标 */
function trFilteredMetrics(a) {
  const all = Object.keys(a.metrics || {}).map(k => a.metrics[k]);
  const usable = all.filter(m => !m.no_data);
  const hidden = all.length - usable.length;
  const q = trSearch.trim().toLowerCase();

  const list = usable.filter(m => {
    if (trGroupFilter && m.group !== trGroupFilter) return false;
    if (trCoverageMode === 'full' && (m.partial || m.single_sample)) return false;
    if (trFilterMode === 'anomaly' && !trIsAnomaly(m)) return false;
    if (trFilterMode === 'changed' && !trIsChanged(m)) return false;
    if (trFilterMode === 'primary' && !m.primary) return false;
    if (q) {
      const hay = (String(m.label) + ' ' + String(m.key)).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });

  if (trSortMode === 'change') {
    list.sort((x, y) => y.significance - x.significance || x.label.localeCompare(y.label));
  } else if (trSortMode === 'name') {
    list.sort((x, y) => x.label.localeCompare(y.label));
  } else {
    list.sort((x, y) => trMetricRank(x) - trMetricRank(y) ||
      y.significance - x.significance || x.label.localeCompare(y.label));
  }
  return { list: list, usable: usable.length, hidden: hidden };
}

/** 分组下拉：选项来自全部可用指标，避免筛掉后选项消失 */
function trSyncGroupSelect(a) {
  const sel = document.getElementById('trend-metric-group');
  if (!sel) return;
  const seen = new Map();
  Object.keys(a.metrics || {}).forEach(k => {
    const m = a.metrics[k];
    if (!m.no_data && !seen.has(m.group)) seen.set(m.group, m.group_label || m.group);
  });
  const groups = TR_GROUP_ORDER.filter(g => seen.has(g));
  seen.forEach((label, g) => { if (groups.indexOf(g) < 0) groups.push(g); });
  sel.innerHTML = '<option value="">' + trEsc(trT('webui.trend_all_groups', '全部分组')) + '</option>' +
    groups.map(g => `<option value="${trEsc(g)}">${trEsc(seen.get(g))}</option>`).join('');
  if (groups.indexOf(trGroupFilter) < 0) trGroupFilter = '';
  sel.value = trGroupFilter;
}

/** 把视图状态写回控件（切实例/刷新后调用） */
function trSyncToolbar() {
  const segs = document.querySelectorAll('#trend-metric-filter .tr-seg-btn');
  for (let i = 0; i < segs.length; i++) {
    segs[i].classList.toggle('active', segs[i].getAttribute('data-tr-filter') === trFilterMode);
  }
  const q = document.getElementById('trend-metric-search');
  if (q && q.value !== trSearch) q.value = trSearch;
  const cov = document.getElementById('trend-metric-coverage');
  if (cov) cov.value = trCoverageMode;
  const srt = document.getElementById('trend-metric-sort');
  if (srt) srt.value = trSortMode;
  const fold = document.getElementById('trend-metric-fold');
  if (fold) fold.textContent = trCollapsedGroups.size
    ? trT('webui.trend_expand_all', '展开分组')
    : trT('webui.trend_collapse_all', '折叠分组');
}

function trResetMetricUI() {
  trFilterMode = 'all';
  trSearch = '';
  trGroupFilter = '';
  trCoverageMode = 'all';
  trSortMode = 'smart';
  trCollapsedGroups = new Set();
  trOpenKeys = new Set();
  // 换实例/换时间范围后血缘与报告关联都会失效，必须一起清掉
  trDetailCache = {};
  trDetailPending = {};
  trRawCache = {};
  trDrawerClose();
  trSyncToolbar();
}

/** 变化单元格：环比数值 + 变化率 + 变化幅度条 */
function trChangeCell(m) {
  const unit = trEsc(m.unit || '');
  const d = m.delta;
  if (d === null || d === undefined) return '<span class="tr-chg-num flat">—</span>';
  if (d === 0) return `<span class="tr-chg-num flat">─ 0${unit}</span>`;
  const good = trDeltaGood(m);
  const cls = (good === null) ? 'flat' : (good ? 'down' : 'up');
  const pct = (m.change_pct === null || m.change_pct === undefined) ? '' :
    `<span class="tr-chg-pct">${m.change_pct > 0 ? '+' : ''}${trFmt(m.change_pct)}%</span>`;
  const w = Math.max(6, Math.min(100, Math.round((m.significance || 0) * 100)));
  return `<div class="tr-chg">
    <span class="tr-chg-num ${cls}">${d > 0 ? '▲' : '▼'} ${trFmt(Math.abs(d))}${unit}</span>
    ${pct}
    <span class="tr-chg-bar"><i class="${cls}" style="width:${w}%"></i></span>
  </div>`;
}

function trMetricRowHtml(m) {
  const ano = trIsAnomaly(m);
  const gcolor = TR_GROUP_COLOR[m.group] || '#388bfd';
  const badges = [];
  if (m.breaching_now) {
    badges.push(`<span class="tr-badge sev-high">${trEsc(trT('webui.trend_breach_badge', '超标'))}</span>`);
  } else if (m.status === 'worsening') {
    badges.push(`<span class="tr-badge status-worsening">${trEsc(trStatusText('worsening'))}</span>`);
  }
  if ((m.breaches || []).length && !m.breaching_now) {
    badges.push(`<span class="tr-badge sev-mid">${trEsc(trT('webui.trend_breached_ever', '曾超标'))}</span>`);
  }
  if (m.single_sample) {
    badges.push(`<span class="tr-badge tr-badge-sparse">${trEsc(trT('webui.trend_single_sample', '单次采集'))}</span>`);
  } else if (m.partial) {
    badges.push(`<span class="tr-badge tr-badge-sparse">${trEsc(trT('webui.trend_partial', '偶发缺采'))}</span>`);
  }
  if (m.discovered) {
    badges.push(`<span class="tr-badge tr-badge-disc">${trEsc(trT('webui.trend_discovered', '自动发现'))}</span>`);
  }
  const covCls = (m.partial || m.single_sample) ? ' partial' : '';
  const total = m.coverage + m.missing_points;
  return `<tr class="tr-mrow${ano ? ' is-anomaly' : ''}${trOpenKeys.has(m.key) ? ' is-open' : ''}" data-tr-key="${trEsc(m.key)}">
    <td><div class="tr-name-cell">
      <span class="tr-gdot" style="background:${gcolor}"></span>
      <span class="tr-name">${trEsc(m.label)}</span>
      ${m.unit ? `<span class="tr-unit">(${trEsc(m.unit)})</span>` : ''}
      <span class="tr-badges">${badges.join('')}</span>
    </div></td>
    <td><div class="tr-spark-box"><canvas id="tr-sp-${trEsc(m.key)}"></canvas></div></td>
    <td><span class="tr-latest">${trFmt(m.latest)}${m.unit ? `<small>${trEsc(m.unit)}</small>` : ''}</span></td>
    <td>${trChangeCell(m)}</td>
    <td><span class="tr-range">${trFmt(m.min)} ~ ${trFmt(m.max)} · ${trEsc(trT('webui.trend_mean_short', '均'))} ${trFmt(m.mean)}</span></td>
    <td><span class="tr-cov${covCls}">${m.coverage}/${total}</span></td>
    <td class="tr-src-cell">${trSrcBtnHtml(m)}</td>
  </tr>`;
}

/** 点击行展开的详情：大图 + 统计量（自动发现指标附带原始路径 + 来源） */
function trDetailRowHtml(m) {
  const unit = m.unit || '';
  const total = m.coverage + m.missing_points;
  const items = [
    [trT('webui.trend_latest', '最新'), trFmt(m.latest) + unit],
    [trT('webui.trend_mean', '均值'), trFmt(m.mean) + unit],
    [trT('webui.trend_min', '最小'), trFmt(m.min) + unit],
    [trT('webui.trend_max', '最大'), trFmt(m.max) + unit],
    [trT('webui.trend_slope', '趋势斜率'), trFmt(m.slope)],
    [trT('webui.trend_breach_count', '超标次数'), String((m.breaches || []).length)],
    [trT('webui.trend_coverage', '采集覆盖'), m.coverage + '/' + total],
  ];
  const path = m.discovered ? `<span class="tr-detail-path">${trEsc(m.key)}</span>` : '';
  const cached = trDetailCache[m.key];
  const srcHtml = cached
    ? (cached.origin_template
        ? trT('webui.trend_src_from', '来源') + ': ' +
          `<span class="tr-src-link" data-tr-src="${trEsc(trAttrSel(m.key))}">${trEsc(cached.origin_template.ref)}</span>`
        : trT('webui.trend_src_no_raw', '无原始采集记录（仅扁平兜底列）'))
    : '';
  return `<tr class="tr-drow"><td colspan="7"><div class="tr-detail">
    <div class="tr-detail-chart"><canvas id="tr-dt-${trEsc(m.key)}" data-tr-canvas-key="${trEsc(trAttrSel(m.key))}"></canvas></div>
    <div class="tr-detail-stats">${items.map(it => `<span>${trEsc(it[0])} <b>${trEsc(it[1])}</b></span>`).join('')}${path}</div>
    <div class="tr-detail-stats" style="margin-top:6px">
      <span data-tr-src-info="${trEsc(trAttrSel(m.key))}">${srcHtml}</span>
      <span>${trEsc(trT('webui.trend_src_hint', '点击折线图上的数据点可查看该点原始数据'))}</span>
    </div>
  </div></td></tr>`;
}

/** ④ 指标总览表：全量指标 + 迷你趋势线 + 变化幅度 + 分组折叠 + 点击展开 */
function trRenderMetrics(a) {
  const card = document.getElementById('trend-metric-card');
  const wrap = document.getElementById('trend-metric-table');
  if (!wrap || !a) return;
  if (card) card.style.display = 'block';
  const labels = a.labels || [];
  const res = trFilteredMetrics(a);
  const list = res.list;

  trSyncGroupSelect(a);
  trSyncToolbar();

  const countEl = document.getElementById('trend-metric-count');
  if (countEl) countEl.textContent = list.length + ' / ' + res.usable;

  const note = document.getElementById('trend-metric-note');
  if (note) {
    const parts = [];
    if (res.hidden > 0) {
      parts.push(trT('webui.trend_metric_hidden', '另有 {n} 项指标在当前时间范围内未采集到数据，已隐藏')
        .replace('{n}', res.hidden));
    }
    if (!list.length) {
      parts.push(trT('webui.trend_metric_empty_filter', '当前筛选条件下没有匹配的指标，试试切换筛选条件或清空搜索'));
    }
    note.style.display = parts.length ? 'block' : 'none';
    note.textContent = parts.join(' · ');
  }

  if (!list.length) {
    wrap.innerHTML = `<div class="tr-empty">${trEsc(trT('webui.trend_no_metric', '该时间范围内无可用指标数据'))}</div>`;
    return;
  }

  // 按分组组织；组内顺序沿用排序结果
  const byGroup = {};
  list.forEach(m => { (byGroup[m.group] = byGroup[m.group] || []).push(m); });
  const groups = TR_GROUP_ORDER.filter(g => byGroup[g]);
  Object.keys(byGroup).forEach(g => { if (groups.indexOf(g) < 0) groups.push(g); });

  let html = `<table class="tr-mtable"><thead><tr>
      <th style="min-width:200px">${trEsc(trT('webui.trend_col_metric', '指标'))}</th>
      <th>${trEsc(trT('webui.trend_col_spark', '走势'))}</th>
      <th>${trEsc(trT('webui.trend_col_latest', '最新值'))}</th>
      <th style="min-width:160px">${trEsc(trT('webui.trend_col_change', '变化'))}</th>
      <th>${trEsc(trT('webui.trend_col_range', '区间 / 均值'))}</th>
      <th>${trEsc(trT('webui.trend_col_coverage', '覆盖'))}</th>
      <th style="width:1%"></th>
    </tr></thead><tbody>`;

  groups.forEach(g => {
    const items = byGroup[g];
    const collapsed = trCollapsedGroups.has(g);
    const anoN = items.filter(trIsAnomaly).length;
    const gLabel = (items[0] && items[0].group_label) || g;
    html += `<tr class="tr-grow${collapsed ? ' collapsed' : ''}" data-tr-group="${trEsc(g)}">
      <td colspan="7"><span class="tr-caret">▾</span>${trEsc(gLabel)}<span class="tr-gcount">${items.length}${
        anoN ? ` · <span style="color:var(--danger)">${anoN} ${trEsc(trT('webui.trend_anomaly_short', '异常'))}</span>` : ''
      }</span></td></tr>`;
    if (collapsed) return;
    items.forEach(m => {
      html += trMetricRowHtml(m);
      if (trOpenKeys.has(m.key)) html += trDetailRowHtml(m);
    });
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;

  // 迷你趋势线 + 展开的大图（等布局完成后再画，否则容器尺寸为 0）
  requestAnimationFrame(() => {
    list.forEach(m => {
      if (trCollapsedGroups.has(m.group)) return;
      trDrawSpark('tr-sp-' + m.key, m.values, {
        color: TR_GROUP_COLOR[m.group] || '#388bfd',
        warn: m.warn, crit: m.crit,
      });
      if (trOpenKeys.has(m.key)) {
        trDrawLine('tr-dt-' + m.key, labels, m.values, {
          color: TR_GROUP_COLOR[m.group] || '#388bfd',
          warn: m.warn, crit: m.crit, breaches: m.breaches || [],
          key: m.key,
        });
      }
    });
  });
}

/** 迷你趋势线：无坐标轴，仅走势 + 末点高亮 + 阈值参考线 */
function trDrawSpark(canvasId, values, opts) {
  const setup = trCanvasSetup(canvasId);
  if (!setup || !values || !values.length) return;
  const { ctx, W, H } = setup;
  const nums = values.filter(v => v !== null && v !== undefined && isFinite(Number(v))).map(Number);
  if (!nums.length) return;

  const pad = { top: 4, right: 4, bottom: 4, left: 4 };
  const cw = Math.max(W - pad.left - pad.right, 4);
  const ch = Math.max(H - pad.top - pad.bottom, 4);

  let minV = Math.min.apply(null, nums), maxV = Math.max.apply(null, nums);
  if (opts.warn !== null && opts.warn !== undefined) { minV = Math.min(minV, opts.warn); maxV = Math.max(maxV, opts.warn); }
  if (opts.crit !== null && opts.crit !== undefined) { minV = Math.min(minV, opts.crit); maxV = Math.max(maxV, opts.crit); }
  if (maxV === minV) { maxV += 1; minV -= 1; }
  const range = maxV - minV;
  const n = values.length;
  const toX = i => pad.left + (n > 1 ? (cw / (n - 1)) * i : cw / 2);
  const toY = v => pad.top + ch - ((v - minV) / range) * ch;

  const refLine = (val, color) => {
    if (val === null || val === undefined) return;
    const y = toY(val);
    if (y < pad.top || y > pad.top + ch) return;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
    ctx.restore();
  };
  refLine(opts.warn, 'rgba(227,179,65,.55)');
  refLine(opts.crit, 'rgba(248,81,73,.55)');

  const pts = values.map((v, i) => {
    const num = (v === null || v === undefined || !isFinite(Number(v))) ? null : Number(v);
    return num === null ? null : { x: toX(i), y: toY(num) };
  });

  if (pts.every(p => p)) {
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
    grad.addColorStop(0, opts.color + '4d');
    grad.addColorStop(1, opts.color + '00');
    ctx.fillStyle = grad;
    ctx.beginPath();
    pts.forEach((p, i) => { i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); });
    ctx.lineTo(pts[n - 1].x, pad.top + ch);
    ctx.lineTo(pts[0].x, pad.top + ch);
    ctx.closePath(); ctx.fill();
  }

  ctx.strokeStyle = opts.color; ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  let started = false;
  pts.forEach(p => {
    if (!p) { started = false; return; }
    if (!started) { ctx.moveTo(p.x, p.y); started = true; } else { ctx.lineTo(p.x, p.y); }
  });
  ctx.stroke();

  const lastP = pts[pts.length - 1];
  if (lastP) {
    ctx.fillStyle = opts.color;
    ctx.beginPath(); ctx.arc(lastP.x, lastP.y, 2.4, 0, Math.PI * 2); ctx.fill();
  }
}

// ─── 趋势图绘制（原生 Canvas，不依赖外部库）────────────────────────

/** 按 devicePixelRatio 适配画布，返回 {ctx, W, H}；容器不可见时返回 null */
function trCanvasSetup(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !canvas.parentElement) return null;
  const box = canvas.parentElement;
  const W = box.clientWidth, H = box.clientHeight;
  if (!W || !H) return null;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return { ctx, W, H };
}

function trMutedColor() {
  const c = getComputedStyle(document.body).getPropertyValue('--text-muted');
  return (c || '').trim() || '#94a3b8';
}

/** 单指标折线图：警戒线 / 严重线 / 越线点高亮 */
function trDrawLine(canvasId, labels, values, opts) {
  const setup = trCanvasSetup(canvasId);
  if (!setup || !values || !values.length) return;
  const { ctx, W, H } = setup;

  const nums = values.filter(v => v !== null && v !== undefined && isFinite(Number(v))).map(Number);
  if (!nums.length) return;

  const pad = { top: 12, right: 12, bottom: 22, left: 46 };
  const cw = Math.max(W - pad.left - pad.right, 10);
  const ch = Math.max(H - pad.top - pad.bottom, 10);

  let minV = Math.min(...nums), maxV = Math.max(...nums);
  // 把阈值线纳入值域，保证「超标」这件事在图上看得见
  if (opts.warn !== null && opts.warn !== undefined) { minV = Math.min(minV, opts.warn); maxV = Math.max(maxV, opts.warn); }
  if (opts.crit !== null && opts.crit !== undefined) { minV = Math.min(minV, opts.crit); maxV = Math.max(maxV, opts.crit); }
  if (maxV === minV) { maxV += 1; minV -= 1; }
  const padV = (maxV - minV) * 0.08;
  minV -= padV; maxV += padV;
  const range = maxV - minV;

  const n = values.length;
  const toX = i => pad.left + (n > 1 ? (cw / (n - 1)) * i : cw / 2);
  const toY = v => pad.top + ch - ((v - minV) / range) * ch;

  const muted = trMutedColor();
  ctx.font = '10px -apple-system, "Segoe UI", sans-serif';

  // 横向网格 + 左轴刻度
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 3; i++) {
    const y = pad.top + (ch / 3) * i;
    ctx.strokeStyle = 'rgba(148,163,184,0.16)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(trFmt(maxV - (range / 3) * i), pad.left - 6, y);
  }

  // 阈值线
  const thresh = (val, color) => {
    if (val === null || val === undefined) return;
    const y = toY(val);
    if (y < pad.top || y > pad.top + ch) return;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
    ctx.restore();
  };
  thresh(opts.warn, 'rgba(227,179,65,0.8)');
  thresh(opts.crit, 'rgba(248,81,73,0.8)');

  const pts = values.map((v, i) => {
    const num = (v === null || v === undefined || !isFinite(Number(v))) ? null : Number(v);
    return num === null ? null : { x: toX(i), y: toY(num) };
  });

  // 记住点位与指标 key：点击画布时按 x 距离找最近点，打开该点的原数据
  const _cv = document.getElementById(canvasId);
  if (_cv && opts && opts.key) {
    _cv._trPts = pts;
    _cv._trKey = opts.key;
    _cv.classList.add('tr-canvas-clickable');
    _cv.setAttribute('title', trT('webui.trend_src_hint', '点击折线图上的数据点可查看该点原始数据'));
  }

  // 渐变填充（存在断点则跳过，避免错误连线）
  if (pts.every(p => p)) {
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
    grad.addColorStop(0, opts.color + '55');
    grad.addColorStop(1, opts.color + '00');
    ctx.fillStyle = grad;
    ctx.beginPath();
    pts.forEach((p, i) => { i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); });
    ctx.lineTo(pts[n - 1].x, pad.top + ch);
    ctx.lineTo(pts[0].x, pad.top + ch);
    ctx.closePath(); ctx.fill();
  }

  // 折线
  ctx.strokeStyle = opts.color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  let started = false;
  pts.forEach(p => {
    if (!p) { started = false; return; }
    if (!started) { ctx.moveTo(p.x, p.y); started = true; } else { ctx.lineTo(p.x, p.y); }
  });
  ctx.stroke();

  // 数据点（越线点红色放大）
  const breachSet = new Set(opts.breaches || []);
  pts.forEach((p, i) => {
    if (!p) return;
    const hit = breachSet.has(i);
    ctx.fillStyle = hit ? '#f85149' : opts.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, hit ? 3.5 : 2.5, 0, Math.PI * 2); ctx.fill();
  });

  // X 轴标签（MM-DD HH:mm）
  ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const step = Math.max(1, Math.ceil(n / 5));
  labels.forEach((l, i) => {
    if (i % step === 0 || i === n - 1) ctx.fillText(String(l).slice(5, 16), toX(i), pad.top + ch + 6);
  });
}

/** 健康评分（折线，左轴 0-100）+ 风险项数量（柱，右轴）双轴合并图 */
function trDrawHealthRisk(canvasId, labels, health, risk) {
  const setup = trCanvasSetup(canvasId);
  if (!setup || !labels.length) return;
  const { ctx, W, H } = setup;

  const pad = { top: 14, right: 46, bottom: 24, left: 46 };
  const cw = Math.max(W - pad.left - pad.right, 10);
  const ch = Math.max(H - pad.top - pad.bottom, 10);
  const n = labels.length;
  const bandW = cw / n;
  const xAt = i => pad.left + bandW * i + bandW / 2;

  const riskVals = risk.filter(v => v !== null && v !== undefined && isFinite(Number(v))).map(Number);
  const riskMax = riskVals.length ? Math.max(1, ...riskVals) : 1;
  const toYRisk = v => pad.top + ch - (v / riskMax) * ch;
  const toYHealth = v => pad.top + ch - (Math.max(0, Math.min(100, v)) / 100) * ch;

  const muted = trMutedColor();
  ctx.font = '10px -apple-system, "Segoe UI", sans-serif';

  // 网格 + 左轴(健康评分) / 右轴(风险项数量)
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (ch / 4) * i;
    ctx.strokeStyle = 'rgba(148,163,184,0.16)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
    ctx.fillStyle = muted;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(String(100 - i * 25), pad.left - 6, y);
    ctx.textAlign = 'left';
    ctx.fillText(trFmt(riskMax - (riskMax / 4) * i), pad.left + cw + 6, y);
  }

  // 风险项柱（半透明红，垫在折线下面）
  const barW = Math.max(2, Math.min(bandW * 0.5, 16));
  risk.forEach((v, i) => {
    const num = (v === null || v === undefined) ? null : Number(v);
    if (num === null || !isFinite(num) || num <= 0) return;
    const y = toYRisk(num);
    ctx.fillStyle = 'rgba(248,81,73,0.45)';
    ctx.fillRect(xAt(i) - barW / 2, y, barW, pad.top + ch - y);
  });

  // 健康评分折线
  ctx.strokeStyle = '#388bfd'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  let started = false;
  health.forEach((v, i) => {
    const num = (v === null || v === undefined) ? null : Number(v);
    if (num === null || !isFinite(num)) { started = false; return; }
    const x = xAt(i), y = toYHealth(num);
    if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
  });
  ctx.stroke();
  health.forEach((v, i) => {
    const num = (v === null || v === undefined) ? null : Number(v);
    if (num === null || !isFinite(num)) return;
    ctx.fillStyle = '#388bfd';
    ctx.beginPath(); ctx.arc(xAt(i), toYHealth(num), 2.5, 0, Math.PI * 2); ctx.fill();
  });

  // X 轴标签
  ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const step = Math.max(1, Math.ceil(n / 6));
  labels.forEach((l, i) => {
    if (i % step === 0 || i === n - 1) ctx.fillText(String(l).slice(5, 16), xAt(i), pad.top + ch + 6);
  });
}

// ══════════════════════════════════════════════════════════════
// 溯源：指标 → 原数据（血缘 + 单点下钻）
//   ① 指标行右上角 icon-only「查看原数据」
//   ② 展开详情后点击折线图上的数据点
//   ③ 详情区「来源」标签
// 全链路只读：/api/trend/metric/detail（全窗口血缘）+ /api/trend/metric/raw（单点原数据）
// ══════════════════════════════════════════════════════════════

const TR_ICON_SOURCE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>';
const TR_ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

const TR_KIND_TEXT = {
  chapter_table: () => trT('webui.trend_src_kind_chapter', '模板章节表格'),
  ctx_list:      () => trT('webui.trend_src_kind_list', 'context 列表'),
  ctx_scalar:    () => trT('webui.trend_src_kind_scalar', 'context 标量'),
  flat_column:   () => trT('webui.trend_src_kind_flat', '扁平兜底列'),
  derived:       () => trT('webui.trend_src_kind_derived', '派生指标'),
  issue_list:    () => trT('webui.trend_src_kind_issues', '异常项列表'),
};
function trKindText(k) { const f = TR_KIND_TEXT[k]; return f ? f() : String(k || ''); }

let trDetailCache = {};     // 指标 key → detail 响应
let trDetailPending = {};   // 指标 key → 进行中的请求
let trRawCache = {};        // '<key>|<snapshotId>' → raw 响应
let trDrawerState = null;   // { key, index, tab, offset, limit, raw, hasSql }

function trCurrentInstance() {
  const sel = document.getElementById('trend-instance-select');
  const idx = parseInt(sel && sel.value, 10);
  if (isNaN(idx) || !trendInstances[idx]) return null;
  return trendInstances[idx];
}

function trApiQs(extra) {
  const inst = trCurrentInstance();
  if (!inst) return '';
  const el = document.getElementById('trend-range-select');
  const days = (el && el.value) || '0';
  return 'db_type=' + encodeURIComponent(inst.db_type) +
         '&host=' + encodeURIComponent(inst.host) +
         '&port=' + encodeURIComponent(inst.port) +
         '&days=' + encodeURIComponent(days) + (extra || '');
}

function trAttrSel(v) { return String(v == null ? '' : v).replace(/["\\]/g, ''); }

/** 指标行的溯源按钮：无原数据时置灰但仍可打开（抽屉里会解释为什么没有） */
function trSrcBtnHtml(m) {
  const d = trDetailCache[m.key];
  const on = d ? (d.stats && d.stats.matched_points > 0) : true;
  const title = on ? trT('webui.trend_src_open', '查看原数据')
                   : trT('webui.trend_src_none', '该指标无原始采集记录');
  return `<button class="tr-src-btn${on ? '' : ' is-off'}" data-tr-src="${trEsc(trAttrSel(m.key))}"
    title="${trEsc(title)}" aria-label="${trEsc(title)}">${TR_ICON_SOURCE}</button>`;
}

/** 拉取某指标的全窗口血缘（缓存，去重并发） */
function trEnsureDetail(key) {
  if (trDetailCache[key]) { trApplyDetail(key); return Promise.resolve(trDetailCache[key]); }
  if (trDetailPending[key]) return trDetailPending[key];
  const qs = trApiQs('&key=' + encodeURIComponent(key));
  if (!qs) return Promise.resolve(null);
  const p = fetch('/api/trend/metric/detail?' + qs)
    .then(r => r.json())
    .then(d => {
      if (d && d.ok && d.detail) { trDetailCache[key] = d.detail; trApplyDetail(key); return d.detail; }
      return null;
    })
    .catch(() => null)
    .then(v => { delete trDetailPending[key]; return v; });
  trDetailPending[key] = p;
  return p;
}

/** 血缘到位后就地更新 DOM（不整表重绘，避免折线图闪烁） */
function trApplyDetail(key) {
  const d = trDetailCache[key];
  if (!d) return;
  const sel = '[data-tr-src="' + trAttrSel(key) + '"]';
  document.querySelectorAll(sel).forEach(b => {
    const on = d.stats && d.stats.matched_points > 0;
    b.classList.toggle('is-off', !on);
    const title = on ? trT('webui.trend_src_open', '查看原数据')
                     : trT('webui.trend_src_none', '该指标无原始采集记录');
    b.setAttribute('title', title);
    b.setAttribute('aria-label', title);
  });
  const info = document.querySelector('[data-tr-src-info="' + trAttrSel(key) + '"]');
  if (info) {
    const tpl = d.origin_template;
    if (tpl) {
      info.innerHTML = trT('webui.trend_src_from', '来源') + ': ' +
        `<span class="tr-src-link" data-tr-src="${trEsc(trAttrSel(key))}">${trEsc(tpl.ref)}</span>`;
    } else {
      info.innerHTML = trT('webui.trend_src_no_raw', '无原始采集记录（仅扁平兜底列）');
    }
  }
}

// ─── 抽屉 ───────────────────────────────────────────────────

function trDrawerOpen(key, index) {
  if (!trendAnalysis) return;
  const d = trDetailCache[key];
  const pts = (d && d.points) || [];
  const i = (index === undefined || index === null || index < 0) ? Math.max(pts.length - 1, 0) : index;
  trDrawerState = { key: key, index: i, tab: 'raw', offset: 0, limit: 100, raw: null };
  const mask = document.getElementById('tr-drawer-mask');
  const dr = document.getElementById('tr-drawer');
  if (mask) mask.classList.add('is-open');
  if (dr) dr.classList.add('is-open');
  trDrawerRender();
  trEnsureDetail(key).then(dd => {
    if (!dd) { trDrawerBody('<div class="tr-warn-box is-err">' + trEsc(trT('webui.trend_src_load_fail', '血缘加载失败')) + '</div>'); return; }
    const p = dd.points[trDrawerState.index];
    if (!p) { trDrawerBody('<div class="tr-warn-box">' + trEsc(trT('webui.trend_src_no_point', '该点不在当前时间范围内。')) + '</div>'); return; }
    // 该点没有任何来源（连扁平兜底列都没有值）→ 不请求原数据，直接说明原因
    if (!p.hit) { trDrawerNoSource(); return; }
    if (p.snapshot_id) trLoadRaw();
    else trDrawerBody('<div class="tr-warn-box">' + trEsc(trT('webui.trend_src_no_id', '该快照缺少唯一定位标识（历史库升级前的旧快照），无法定位原始数据')) + '</div>');
  });
}

/** 该点完全无来源：给出「为什么没有」而不是空白或报错 */
function trDrawerNoSource() {
  const st = trDrawerState;
  const d = trDetailCache[st.key] || {};
  trDrawerBody('<div class="tr-warn-box">' +
    trEsc(trT('webui.trend_src_none_note',
      '该快照里这个指标没有任何来源记录（采集器未采到，且扁平兜底列也为空），因此无法下钻到原始数据。')) +
    '</div>' +
    `<div class="tr-raw-toolbar"><span>${trEsc(trT('webui.trend_src_stats', '本指标来源统计'))}：` +
    `${trEsc(trT('webui.trend_src_primary', '主来源（实际取值）'))} ${(d.stats || {}).matched_points || 0} · ` +
    `${trEsc(trT('webui.trend_src_flat_short', '扁平兜底'))} ${(d.stats || {}).fallback_points || 0} · ` +
    `${trEsc(trT('webui.trend_src_none_short', '无来源'))} ${(d.stats || {}).no_source_points || 0}</span></div>`);
  trDrawerFoot('');
}

function trDrawerClose() {
  const mask = document.getElementById('tr-drawer-mask');
  const dr = document.getElementById('tr-drawer');
  if (mask) mask.classList.remove('is-open');
  if (dr) dr.classList.remove('is-open');
  trDrawerState = null;
}

function trDrawerBody(html) {
  const b = document.getElementById('tr-drawer-body');
  if (b) b.innerHTML = html;
}

function trDrawerFoot(html) {
  const f = document.getElementById('tr-drawer-foot');
  if (f) f.innerHTML = html || '';
}

/** 抽屉骨架：标题 + 副标题 + tab 态 + 底部元信息 */
function trDrawerRender() {
  const st = trDrawerState;
  if (!st) return;
  const d = trDetailCache[st.key];
  const m = (trendAnalysis && trendAnalysis.metrics) ? trendAnalysis.metrics[st.key] : null;
  const pt = d && d.points ? d.points[st.index] : null;

  const titleEl = document.getElementById('tr-drawer-title');
  if (titleEl) {
    titleEl.innerHTML = trEsc(m ? m.label : st.key) +
      (m && m.unit ? `<span class="tr-unit">(${trEsc(m.unit)})</span>` : '') +
      (pt ? `<span class="tr-badge">${trEsc(String(pt.ts).slice(0, 16))}</span>` : '');
  }
  const subEl = document.getElementById('tr-drawer-sub');
  if (subEl) {
    const val = pt ? (pt.missing ? '—' : trFmt(pt.value)) : '';
    subEl.innerHTML = trT('webui.trend_src_value', '该点值') + ': <b>' +
      trEsc(String(val)) + (m && m.unit ? trEsc(m.unit) : '') + '</b>';
  }
  document.querySelectorAll('#tr-drawer-tabs .tr-tab').forEach(b => {
    const name = b.getAttribute('data-tr-tab');
    b.classList.toggle('active', name === st.tab);
    if (name === 'raw') b.textContent = trT('webui.trend_src_tab_raw', '原数据');
    else if (name === 'sql') b.textContent = trT('webui.trend_src_tab_sql', '采集 SQL');
    else if (name === 'chain') b.textContent = trT('webui.trend_src_tab_chain', '血缘');
    else if (name === 'same') b.textContent = trT('webui.trend_src_tab_same', '同点其他指标');
  });
}

function trDrawerTab(name) {
  const st = trDrawerState;
  if (!st) return;
  st.tab = name;
  trDrawerRender();
  if (name === 'sql') {
    if (st.raw && st.raw.sql) trDrawerRenderSql();
    else trLoadRaw(true);
    return;
  }
  trDrawerRenderBody();
}

function trLoadRaw(withSql) {
  const st = trDrawerState;
  if (!st) return;
  const d = trDetailCache[st.key];
  const pt = d && d.points ? d.points[st.index] : null;
  if (!pt || !pt.snapshot_id) return;
  const cacheKey = st.key + '|' + pt.snapshot_id;
  if (trRawCache[cacheKey] && !withSql) { st.raw = trRawCache[cacheKey]; trDrawerRenderBody(); return; }
  trDrawerBody('<div class="tr-loading">' + trEsc(trT('webui.trend_src_loading', '正在读取原数据…')) + '</div>');
  const qs = trApiQs('&key=' + encodeURIComponent(st.key) +
                     '&snapshot_id=' + encodeURIComponent(pt.snapshot_id) +
                     '&offset=' + (withSql ? 0 : st.offset) +
                     '&limit=' + st.limit + (withSql ? '&with_sql=1' : ''));
  fetch('/api/trend/metric/raw?' + qs)
    .then(r => r.json())
    .then(res => {
      if (!res || !res.ok) {
        if (res && res.error === 'no_provenance') { trDrawerNoSource(); return; }
        trDrawerBody('<div class="tr-warn-box is-err">' + trEsc((res && res.error) || trT('webui.trend_src_load_fail', '血缘加载失败')) + '</div>');
        return;
      }
      if (withSql && st.raw) { st.raw.sql = res.sql || null; trDrawerRenderSql(); return; }
      st.raw = res;
      trRawCache[cacheKey] = res;
      trDrawerRenderBody();
    })
    .catch(e => trDrawerBody('<div class="tr-warn-box is-err">' + trEsc(String(e.message || e)) + '</div>'));
}

function trDrawerRenderBody() {
  const st = trDrawerState;
  if (!st || !st.raw) return;
  if (st.tab === 'raw') trDrawerRenderRaw();
  else if (st.tab === 'chain') trDrawerRenderChain();
  else if (st.tab === 'same') trDrawerRenderSame();
  else if (st.tab === 'sql') trDrawerRenderSql();
}

/** Tab 1：原数据表格（命中行/列高亮 + 分页 + 采集失败原文） */
function trDrawerRenderRaw() {
  const st = trDrawerState;
  const res = st.raw;
  const raw = res.raw || {};
  const prov = res.provenance || {};
  const parts = [];

  if (raw.collect_error) {
    parts.push(`<div class="tr-warn-box is-err"><b>${trEsc(trT('webui.trend_src_collect_error', '该章节采集失败'))}</b>：${trEsc(raw.collect_error)}</div>`);
  }
  if (raw.note === 'flat_fallback') {
    parts.push(`<div class="tr-warn-box">${trEsc(trT('webui.trend_src_flat_note', '该指标来自快照扁平列，未匹配到原始采集结构（采集器未采到或该版本未采集），无法给出更细的原始数据。'))}</div>`);
  }
  if (raw.note === 'derived_only') {
    const formula = (prov.origin || {}).formula || '';
    parts.push(`<div class="tr-warn-box">${trEsc(trT('webui.trend_src_derived_note', '该指标由其他数据推导，没有单一物理采样点。口径：'))}${trEsc(formula)}</div>`);
  }
  if (raw.note === 'collect_missing') {
    parts.push(`<div class="tr-warn-box is-err">${trEsc(trT('webui.trend_src_missing_note', '该快照中没有找到这条原始记录（该章节/字段本次未采集）。'))}</div>`);
  }
  // 独立复算校验
  const v = res.verify || {};
  if (v.ok === false) {
    parts.push(`<div class="tr-warn-box is-err">${trEsc(trT('webui.trend_src_verify_bad', '校验不一致：展示值 '))}${trEsc(trFmt(v.value))} / ${trEsc(trT('webui.trend_src_recomputed', '按来源复算'))} ${trEsc(trFmt(v.recomputed))}</div>`);
  } else if (v.value !== null && v.value !== undefined) {
    parts.push(`<div class="tr-warn-box is-ok">${trEsc(trT('webui.trend_src_verify_ok', '已校验：按上述来源独立复算，结果与展示值一致。'))}</div>`);
  }
  // 口径说明
  parts.push(`<div class="tr-raw-toolbar"><span class="tr-badge">${trEsc(trKindText(prov.kind))}</span><span style="flex:1">${trEsc(prov.explain || '')}</span></div>`);

  if (raw.view === 'scalar' || raw.view === 'text') {
    const rows = raw.rows || [];
    const kv = rows.map(r => `<div class="tr-scalar-row"><span class="k">${trEsc(String(r[0]))}</span><span class="v big">${trEsc(r[1] === null || r[1] === undefined ? '—' : String(r[1]))}</span></div>`).join('');
    let html = parts.join('') + `<div class="tr-scalar-card">${kv}</div>`;
    if (raw.siblings && (raw.siblings.columns || []).length) {
      html += `<div class="tr-raw-toolbar" style="margin-top:14px">${trEsc(trT('webui.trend_src_siblings', '同层字段（便于交叉核对）'))}</div>` +
        trRawTable(raw.siblings.columns, raw.siblings.rows, null, null);
    }
    trDrawerBody(html);
    trDrawerFoot(trFootHtml(res));
    return;
  }

  const isIssues = raw.view === 'issues';
  let html = parts.join('');
  if (raw.filter) {
    html += `<div class="tr-raw-toolbar">${trEsc(trT('webui.trend_src_filtered', '已按血缘筛选'))}：${trEsc(raw.filter.field)} = ${trEsc(String(raw.filter.value))} （${raw.filter.after} / ${raw.filter.before}）</div>`;
  }
  if (!(raw.rows || []).length) {
    html += `<div class="tr-warn-box">${trEsc(trT('webui.trend_src_empty_raw', '本次快照该来源没有返回任何行。'))}</div>`;
    trDrawerBody(html);
    trDrawerFoot(trFootHtml(res));
    return;
  }
  html += trRawTable(raw.columns, raw.rows, raw.highlight_row, raw.highlight_col, isIssues);
  // 分页
  const total = raw.total || 0;
  const from = st.offset + 1;
  const to = st.offset + (raw.returned || 0);
  if (total > st.limit) {
    html += `<div class="tr-raw-pager">
      <button class="btn btn-ghost tr-mini-btn" data-tr-page="prev"${st.offset <= 0 ? ' disabled' : ''}>${trEsc(trT('webui.trend_src_prev', '上一页'))}</button>
      <span>${from}–${to} / ${total}${raw.truncated ? ' ' + trEsc(trT('webui.trend_src_truncated', '（已截断）')) : ''}</span>
      <button class="btn btn-ghost tr-mini-btn" data-tr-page="next"${raw.truncated ? '' : ' disabled'}>${trEsc(trT('webui.trend_src_next', '下一页'))}</button>
    </div>`;
  } else if (total > 1) {
    html += `<div class="tr-raw-pager"><span>${total} ${trEsc(trT('webui.trend_src_rows', '行'))}</span></div>`;
  }
  trDrawerBody(html);
  trDrawerFoot(trFootHtml(res));
}

function trRawTable(cols, rows, hlRow, hlCol, isIssues) {
  const head = (cols || []).map((c, i) =>
    `<th${i === hlCol ? ' style="color:var(--accent2)"' : ''}>${trEsc(String(c))}</th>`).join('');
  const body = (rows || []).map((r, ri) => {
    const isHit = (hlRow !== null && hlRow !== undefined && ri === hlRow);
    const tds = (r || []).map((v, ci) =>
      `<td class="${ci === hlCol ? 'is-hit-col' : ''}">${trEsc(v === null || v === undefined ? '—' : String(v))}</td>`).join('');
    return `<tr class="${isHit ? 'is-hit' : ''}">${tds}</tr>`;
  }).join('');
  const note = isIssues
    ? `<div class="tr-raw-toolbar">${trEsc(trT('webui.trend_src_issue_cols', '列：异常名 / 等级 / 说明 / 优先级 / 修复 SQL'))}</div>` : '';
  return note + `<div class="tr-raw-wrap"><table class="tr-raw-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Tab 3：血缘兜底链（主来源 + 尝试过但未命中的候选） */
function trDrawerRenderChain() {
  const res = trDrawerState.raw;
  const prov = res.provenance || {};
  const chain = prov.chain || [];
  const items = chain.map(c => {
    const cls = c.matched ? 'tr-chain-item is-hit' : 'tr-chain-item';
    const mark = c.matched ? '✅' : '➖';
    const label = c.matched ? trT('webui.trend_src_primary', '主来源（实际取值）') : trT('webui.trend_src_fallback', '备选（未命中）');
    return `<div class="${cls}">
      <div class="tr-chain-mark">${mark}</div>
      <div style="min-width:0">
        <div class="tr-chain-ref">${trEsc(c.ref || '')}</div>
        <div class="tr-chain-why">${trEsc(label)} · ${trEsc(trKindText(c.kind))}${c.why ? ' · ' + trEsc(c.why) : ''}${c.picked !== undefined && c.picked !== null ? ' · ' + trEsc(trT('webui.trend_src_val', '值')) + ' ' + trEsc(trFmt(c.picked)) : ''}</div>
      </div></div>`;
  }).join('');
  let html = chain.length ? `<div class="tr-chain">${items}</div>`
    : `<div class="tr-warn-box">${trEsc(trT('webui.trend_src_no_chain', '未记录到血缘。'))}</div>`;
  html += `<div class="tr-raw-toolbar" style="margin-top:16px">${trEsc(trT('webui.trend_src_explain', '口径说明'))}</div>
    <div class="tr-scalar-card"><div class="tr-scalar-row"><span class="v">${trEsc(prov.explain || '')}</span></div></div>`;
  trDrawerBody(html);
  trDrawerFoot(trFootHtml(res));
}

/** Tab 4：同一快照点的其他指标（客户端计算，不额外请求） */
function trDrawerRenderSame() {
  const st = trDrawerState;
  const idx = st.index;
  const metrics = (trendAnalysis && trendAnalysis.metrics) || {};
  const list = Object.keys(metrics).map(k => metrics[k])
    .filter(m => !m.no_data && m.values && m.values[idx] !== null && m.values[idx] !== undefined)
    .sort((a, b) => trMetricRank(a) - trMetricRank(b) || b.significance - a.significance)
    .slice(0, 20);
  if (!list.length) {
    trDrawerBody(`<div class="tr-warn-box">${trEsc(trT('webui.trend_src_same_empty', '该快照点没有其他可比指标。'))}</div>`);
    return;
  }
  const rows = list.map(m => {
    const ano = trIsAnomaly(m);
    return `<tr class="${ano ? 'is-hit' : ''}">
      <td>${trEsc(m.label)}</td>
      <td style="text-align:right">${trEsc(trFmt(m.values[idx]))}${trEsc(m.unit || '')}</td>
      <td>${trEsc(m.status ? trStatusText(m.status) : '')}</td>
      <td class="tr-src-cell"><button class="tr-src-btn" data-tr-src="${trEsc(trAttrSel(m.key))}" title="${trEsc(trT('webui.trend_src_open', '查看原数据'))}" aria-label="${trEsc(trT('webui.trend_src_open', '查看原数据'))}">${TR_ICON_SOURCE}</button></td>
    </tr>`;
  }).join('');
  trDrawerBody(`<div class="tr-raw-wrap"><table class="tr-raw-table">
    <thead><tr><th>${trEsc(trT('webui.trend_col_metric', '指标'))}</th><th>${trEsc(trT('webui.trend_col_latest', '最新值'))}</th><th>${trEsc(trT('webui.trend_col_status', '状态'))}</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`);
  trDrawerFoot(trFootHtml(trDrawerState.raw));
}

/** Tab 2：采集 SQL（右上角复制，严格保留原文缩进换行） */
function trDrawerRenderSql() {
  const res = trDrawerState.raw;
  const sql = res && res.sql;
  if (!sql || !sql.query_key) {
    trDrawerBody(`<div class="tr-warn-box">${trEsc(trT('webui.trend_src_sql_none', '该指标不对应模板章节查询（无采集 SQL）。'))}</div>`);
    return;
  }
  if (!sql.query_sql) {
    trDrawerBody(`<div class="tr-warn-box">${trEsc(trT('webui.trend_src_sql_notfound', '该次巡检确实执行了这条查询，但在模板库中找不到它的 SQL（可能使用了自定义模板，或该模板已被删除/改名）。'))}
      <br><span style="font-family:ui-monospace,monospace">query_key = ${trEsc(sql.query_key)}</span></div>`);
    trDrawerFoot(trFootHtml(res));
    return;
  }
  const guess = sql.matched_by !== 'recorded_template';
  let html = '';
  if (guess) {
    html += `<div class="tr-warn-box">${trEsc(trT('webui.trend_src_sql_guess', '该快照未记录所使用的巡检模板，此处按同类型的默认模板反查（仅供参考）：'))}${trEsc(sql.template_name || '')}</div>`;
  }
  html += `<div class="tr-raw-toolbar">
      <span class="tr-badge">${trEsc(sql.query_key || '')}</span>
      <span class="tr-badge">${trEsc(trT('webui.trend_src_chapter', '章节'))} ${trEsc(String(sql.chapter_number == null ? '—' : sql.chapter_number))}</span>
      <span>${trEsc(sql.template_name || '')}</span></div>`;
  html += `<div class="tr-sql-wrap"><button class="tr-sql-copy" id="tr-sql-copy" title="${trEsc(trT('webui.trend_copy', '复制'))}" aria-label="${trEsc(trT('webui.trend_copy', '复制'))}">${TR_ICON_COPY}</button><pre class="tr-sql-box">${trEsc(sql.query_sql || '')}</pre></div>`;
  trDrawerBody(html);
  trDrawerFoot(trFootHtml(res));
}

/** 底部：报告跳转 + 落库的模板/采集器信息 */
function trFootHtml(res) {
  if (!res) return '';
  const rep = res.report;
  let html = '';
  if (rep && rep.file) {
    const guess = rep.matched_by !== 'recorded';
    if (rep.exists === false) {
      // 报告已删除：置灰 + 提示，不出死链
      const tip = trEsc(trT('webui.trend_src_report_gone', '报告文件已不存在（可能已被删除）'));
      html += `<button class="btn btn-ghost tr-mini-btn" disabled title="${tip}" aria-label="${tip}" style="opacity:.45;cursor:not-allowed">${trEsc(trT('webui.trend_src_open_report', '打开报告'))}</button>
        <span class="tr-foot-meta">${tip}：${trEsc(rep.file)}</span>`;
    } else {
      html += `<button class="btn btn-ghost tr-mini-btn" data-tr-rep="open" data-tr-repname="${trEsc(trAttrSel(rep.file))}">${trEsc(trT('webui.trend_src_open_report', '打开报告'))}</button>
        <button class="btn btn-ghost tr-mini-btn" data-tr-rep="down" data-tr-repname="${trEsc(trAttrSel(rep.file))}">${trEsc(trT('webui.trend_src_down_report', '下载报告'))}</button>`;
      if (guess) html += `<span class="tr-foot-meta">${trEsc(trT('webui.trend_src_report_guess', '（按时间邻近推测，未落库精确关联）'))}</span>`;
    }
  } else {
    html += `<span class="tr-foot-meta">${trEsc(trT('webui.trend_src_no_report', '该快照没有可用的报告文件'))}</span>`;
  }
  const meta = [];
  if (res.template_id) meta.push(trT('webui.trend_src_template', '模板') + ' #' + res.template_id);
  if (res.engine) meta.push(trT('webui.trend_src_engine', '采集器') + ' ' + res.engine);
  if (res.risk_count !== null && res.risk_count !== undefined) meta.push(trT('webui.ind_risk_count', '风险项数量') + ' ' + res.risk_count);
  if (meta.length) html += `<span class="tr-foot-meta" style="margin-left:auto">${trEsc(meta.join(' · '))}</span>`;
  return html;
}

// 指标总览：筛选 / 分组折叠 / 行展开 / 复制修复 SQL
document.addEventListener('click', function(ev) {
  const t = ev.target;
  if (!t || typeof t.closest !== 'function') return;

  // ── 实例选择器面板（目录树 + 实例行）──
  const instCaret = t.closest('[data-tr-caret]');
  if (instCaret) {
    const id = instCaret.getAttribute('data-tr-caret');
    if (trTreeExpanded.has(id)) trTreeExpanded.delete(id); else trTreeExpanded.add(id);
    trInstRenderTree();
    return;
  }
  const instDir = t.closest('[data-tr-inst-dir]');
  if (instDir) {
    trInstDirFilter = instDir.getAttribute('data-tr-inst-dir');
    trInstRenderTree(); trInstRenderList();
    return;
  }
  const instRow = t.closest('[data-tr-inst]');
  if (instRow) {
    trSelectInstance(parseInt(instRow.getAttribute('data-tr-inst'), 10));
    return;
  }
  // 点击面板与触发器之外 → 收起面板（不 return，允许该点击继续命中别的控件）
  if (trInstPanelOpen && !t.closest('.tr-inst-wrap')) trInstClosePanel();

  // ── 溯源入口（必须先于指标行点击判定，否则点按钮会连带展开行）──
  const srcBtn = t.closest('[data-tr-src]');
  if (srcBtn) {
    const key = srcBtn.getAttribute('data-tr-src');
    trDrawerOpen(key, null);
    return;
  }
  // 抽屉内切换 tab
  const tab = t.closest('#tr-drawer-tabs .tr-tab');
  if (tab) { trDrawerTab(tab.getAttribute('data-tr-tab')); return; }
  // 原数据分页
  const pager = t.closest('[data-tr-page]');
  if (pager && trDrawerState) {
    const dir = pager.getAttribute('data-tr-page');
    trDrawerState.offset = Math.max(0, trDrawerState.offset + (dir === 'next' ? trDrawerState.limit : -trDrawerState.limit));
    trLoadRaw(false);
    return;
  }
  // 采集 SQL 复制（严格保留原文）
  if (t.closest('#tr-sql-copy')) {
    const pre = document.querySelector('#tr-drawer-body .tr-sql-box');
    const sql = pre ? pre.textContent : '';
    if (!sql) return;
    navigator.clipboard.writeText(sql).then(
      () => toastSuccess(trT('webui.trend_src_copied', 'SQL 已复制到剪贴板')),
      err => toastError(trT('webui.trend_src_copy_fail', '复制失败') + ': ' + err.message)
    );
    return;
  }
  // 报告跳转 / 下载
  const rep = t.closest('[data-tr-rep]');
  if (rep) {
    const name = rep.getAttribute('data-tr-repname') || '';
    if (!name) return;
    const mode = rep.getAttribute('data-tr-rep');
    window.open('/api/' + (mode === 'down' ? 'download_file_html' : 'preview_file_html') +
                '?name=' + encodeURIComponent(name), '_blank');
    return;
  }
  // 折线图上点击数据点 → 定位到该点的原数据
  if (t.tagName === 'CANVAS' && t._trPts && t._trKey) {
    const box = t.getBoundingClientRect();
    const x = ev.clientX - box.left;
    let best = -1, bestD = Infinity;
    t._trPts.forEach((p, i) => {
      if (!p) return;
      const d = Math.abs(p.x - x);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) trDrawerOpen(t._trKey, best);
    return;
  }

  const seg = t.closest('#trend-metric-filter .tr-seg-btn');
  if (seg && trendAnalysis) {
    trFilterMode = seg.getAttribute('data-tr-filter') || 'all';
    trRenderMetrics(trendAnalysis);
    return;
  }

  const fold = t.closest('#trend-metric-fold');
  if (fold && trendAnalysis) {
    if (trCollapsedGroups.size) {
      trCollapsedGroups = new Set();
    } else {
      Object.keys(trendAnalysis.metrics || {}).forEach(k => {
        if (!trendAnalysis.metrics[k].no_data) trCollapsedGroups.add(trendAnalysis.metrics[k].group);
      });
    }
    trRenderMetrics(trendAnalysis);
    return;
  }

  const grow = t.closest('[data-tr-group]');
  if (grow && trendAnalysis) {
    const name = grow.getAttribute('data-tr-group');
    if (trCollapsedGroups.has(name)) trCollapsedGroups.delete(name); else trCollapsedGroups.add(name);
    trRenderMetrics(trendAnalysis);
    return;
  }

  // 点击指标行展开/收起大图详情（详情行本身不含 data-tr-key，不会误触）
  const row = t.closest('[data-tr-key]');
  if (row && trendAnalysis) {
    const key = row.getAttribute('data-tr-key');
    if (trOpenKeys.has(key)) {
      trOpenKeys.delete(key);
    } else {
      trOpenKeys.add(key);
      trEnsureDetail(key);   // 展开即预热血缘，详情区直接显示「来源」
    }
    trRenderMetrics(trendAnalysis);
    return;
  }

  // 复制修复 SQL（用 encodeURIComponent 承载，避免 SQL 破坏属性）
  const fix = t.closest('[data-tr-fix]');
  if (fix) {
    const sql = decodeURIComponent(fix.getAttribute('data-tr-fix') || '');
    if (!sql) return;
    navigator.clipboard.writeText(sql).then(
      () => toastSuccess('SQL 已复制到剪贴板'),
      err => toastError('复制失败: ' + err.message)
    );
  }
});

// 指标总览搜索 / 实例选择器搜索（均防抖）
document.addEventListener('input', function(ev) {
  const t = ev.target;
  if (!t) return;
  if (t.id === 'tr-inst-search') {
    trInstSearch = t.value || '';
    clearTimeout(trInstSearchTimer);
    trInstSearchTimer = setTimeout(trInstRenderList, 150);
    return;
  }
  if (t.id !== 'trend-metric-search') return;
  trSearch = t.value || '';
  clearTimeout(trSearchTimer);
  trSearchTimer = setTimeout(function() {
    if (trendAnalysis) trRenderMetrics(trendAnalysis);
  }, 200);
});

document.addEventListener('change', function(ev) {
  const t = ev.target;
  if (!t || !trendAnalysis) return;
  if (t.id === 'trend-metric-group') { trGroupFilter = t.value || ''; trRenderMetrics(trendAnalysis); }
  else if (t.id === 'trend-metric-coverage') { trCoverageMode = t.value || 'all'; trRenderMetrics(trendAnalysis); }
  else if (t.id === 'trend-metric-sort') { trSortMode = t.value || 'smart'; trRenderMetrics(trendAnalysis); }
});

// 窗口尺寸变化时重绘（趋势页可见才重绘）
window.addEventListener('resize', function() {
  if (!trendAnalysis) return;
  const page = document.getElementById('page-trend');
  if (!page || page.style.display === 'none') return;
  clearTimeout(trResizeTimer);
  trResizeTimer = setTimeout(function() {
    if (!trendAnalysis) return;
    trRenderHealthRisk(trendAnalysis);
    trRenderMetrics(trendAnalysis);
  }, 180);
});

// 实例选择器面板：窗口尺寸变化时重定位；页面滚动时收起（面板内部树/表滚动除外）
window.addEventListener('resize', function() {
  if (trInstPanelOpen) trInstPositionPanel();
});
window.addEventListener('scroll', function(ev) {
  if (!trInstPanelOpen) return;
  const t = ev.target;
  if (t && typeof t.closest === 'function' && t.closest('.tr-inst-panel')) return;
  trInstClosePanel();
}, true);

// Esc：先收实例选择器面板，再关溯源抽屉
document.addEventListener('keydown', function(ev) {
  if (ev.key !== 'Escape') return;
  if (trInstPanelOpen) { trInstClosePanel(); ev.stopPropagation(); return; }
  if (trDrawerState) { trDrawerClose(); ev.stopPropagation(); }
});

  // 页面级入口导出：index.html 的 showPage / 工具栏 onclick 依赖这些全局名
  window.loadTrendInstances = loadTrendInstances;
  window.onTrendInstanceChange = onTrendInstanceChange;
  window.loadTrendData = loadTrendData;
  window.trDrawerClose = trDrawerClose;
  window.trInstTogglePanel = trInstTogglePanel;
})();
