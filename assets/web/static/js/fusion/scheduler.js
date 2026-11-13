/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 */

/*
 * 定时巡检（融合页）
 * - 复用目标系统 /api/scheduler/* 接口与任务数据模型
 * - 列表 / 卡片 / 4 步向导 / 执行日志按源系统交互还原
 */
(function () {
  'use strict';

  var _schedJobs = [];
  var _schedEditingId = null;
  var _schedStep = 1;
  var _schedFreq = 'daily';
  var _schedSysMode = 'none';
  var _schedLogJobId = null;
  var _schedDsIds = {};

  function $(id) { return document.getElementById(id); }
  function val(id) { var el = $(id); return el ? el.value : ''; }
  function checked(id) { var el = $(id); return !!(el && el.checked); }

  function sToast(msg, type) {
    try {
      if (type === 'success' && typeof toastSuccess === 'function') return toastSuccess(msg);
      if (type === 'error' && typeof toastError === 'function') return toastError(msg);
      if (typeof toast === 'function') return toast(msg, type || 'info');
    } catch (e) {}
    console.log('[scheduler] ' + msg);
  }

  function sConfirm(title, msg) {
    if (typeof showConfirmDialog === 'function') return showConfirmDialog(title, msg);
    return Promise.resolve(window.confirm(msg));
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).replace('T', ' ').slice(0, 16);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function dbLabel(type) {
    var map = { mysql: 'MySQL', pg: 'PostgreSQL', postgresql: 'PostgreSQL', oracle: 'Oracle', oracle_jdbc: 'Oracle', sqlserver: 'SQL Server', dm: '达梦', kingbase: '人大金仓', gbase: 'GBase', mongodb: 'MongoDB', redis: 'Redis', mariadb: 'MariaDB', tidb: 'TiDB' };
    return map[String(type || '').toLowerCase()] || String(type || '').toUpperCase();
  }

  // ── 列表 ─────────────────────────────────────────────────
  async function loadSchedulerJobs() {
    var list = $('scheduler-job-list');
    if (!list) return;
    try {
      var results = await Promise.all([
        fetch('/api/scheduler/jobs').then(function (r) { return r.json(); }).catch(function () { return {}; }),
        // 数据源存在性用于卡片「⚠️ 数据源已失效」提示（数据源被删后任务仍保留配置）
        fetch('/api/pro/datasources').then(function (r) { return r.json(); }).catch(function () { return {}; })
      ]);
      var data = results[0] || {};
      _schedJobs = data.jobs || (Array.isArray(data) ? data : []);
      _schedDsIds = {};
      ((results[1] || {}).datasources || []).forEach(function (ds) { _schedDsIds[ds.id] = true; });
      renderScheduler(_schedJobs);
    } catch (e) {
      list.innerHTML = '<div class="sched-empty">加载失败：' + (typeof escHtml === 'function' ? escHtml(e.message) : e.message) + '</div>';
    }
  }

  function isRunning(job) { return job.enabled !== false; }

  function renderScheduler(jobs) {
    // 供旧版内联逻辑取任务配置：始终暴露全量列表，筛选只影响渲染入参
    window._schedulerJobs = _schedJobs || [];
    var list = $('scheduler-job-list');
    if (!list) return;
    // 统计始终按全量任务计算（与源系统一致：搜索/筛选只影响列表，不影响统计栏）
    var all = _schedJobs || [];
    var total = all.length;
    var active = all.filter(function (j) { return j.enabled !== false; }).length;
    var lastOk = all.filter(function (j) { return j.last_status === 'success'; }).length;
    var lastFail = all.filter(function (j) { return j.last_status === 'failed'; }).length;
    var set = function (id, v) { var el = $(id); if (el) el.textContent = v; };
    set('sched-stat-total', total);
    set('sched-stat-active', active);
    set('sched-stat-paused', total - active);
    set('sched-stat-success', lastOk);
    set('sched-stat-fail', lastFail);

    if (!jobs.length) {
      var hasFilter = String(val('sched-search-input') || '').trim() || val('sched-status-filter');
      list.innerHTML = '<div class="sched-empty"><div class="icon">' + (hasFilter ? '🔍' : '⏰') + '</div>' +
        '<div>' + (hasFilter ? '未找到匹配的任务' : '还没有定时巡检任务') + '</div>' +
        (hasFilter ? '' : '<button class="btn btn-primary" style="margin-top:6px" onclick="showAddJobForm()">➕ 新建定时任务</button>') +
        '</div>';
      return;
    }
    list.innerHTML = jobs.map(function (job) {
      var db = job.db_info || {};
      var type = db.db_type || job.db_type || '';
      var dsMissing = !!(db.datasource_id && !_schedDsIds[db.datasource_id]);
      var target = dsMissing
        ? '<span style="color:var(--danger)">⚠️ 数据源已失效</span>'
        : (db.datasource_id ? ('📁 ' + esc(db.host || db.label || db.datasource_id))
          : ('🌐 ' + esc((db.host || '未知') + (db.port ? ':' + db.port : ''))));
      var cronText = (typeof formatCronText === 'function') ? formatCronText(job.cron) : '—';
      var enabled = isRunning(job);
      var dotClass = enabled ? 'running' : 'paused';
      var cardClass = 'sched-job-card' + (!enabled ? ' is-paused' : (job.last_status === 'failed' ? ' has-fail' : (job.last_status === 'success' ? ' has-success' : '')));
      var lastRunHtml = job.last_run
        ? '<span class="sched-job-meta-item"><span class="sched-last-status ' + (job.last_status === 'success' ? 'success' : 'failed') + '">' +
          (job.last_status === 'success' ? '✓ 成功' : '✗ 失败') + '</span> ' + esc(fmtTime(job.last_run)) + '</span>'
        : '<span class="sched-job-meta-item" style="opacity:.6">未执行过</span>';
      var nextHtml = enabled
        ? (job.next_run ? '<span class="sched-job-meta-item">⏭ 下次 ' + esc(fmtTime(job.next_run)) + '</span>' : '<span class="sched-job-meta-item" style="opacity:.6">待调度</span>')
        : '<span class="sched-job-meta-item" style="opacity:.5">已暂停</span>';
      var mailHtml = job.notify_email === false ? ''
        : '<span class="sched-job-meta-item" title="完成后邮件通知' + (job.notify_attach === false ? '（不含附件）' : '（含附件）') + '">📧' +
          (job.notify_attach === false ? '' : '📎') + '</span>';
      return '<div class="' + cardClass + '">' +
        '<div class="sched-job-status-dot ' + dotClass + '"></div>' +
        '<div class="sched-job-info">' +
          '<div class="sched-job-name-row">' +
            '<span class="sched-job-name" title="' + esc(job.name || '') + '">' + esc(job.name || '未命名任务') + '</span>' +
            '<span class="sched-db-badge ' + escAttr(String(type).toLowerCase()) + '">' + esc(dbLabel(type)) + '</span>' +
          '</div>' +
          '<div class="sched-job-meta">' +
            '<span class="sched-job-meta-item">🕐 ' + esc(cronText) + '</span>' +
            '<span class="sched-job-meta-item">' + target + '</span>' +
            lastRunHtml + nextHtml + mailHtml +
          '</div>' +
        '</div>' +
        '<div class="sched-job-actions">' +
          '<label class="sched-switch" title="' + (enabled ? '点击暂停' : '点击启用') + '"><input type="checkbox" ' + (enabled ? 'checked' : '') +
            ' onchange="toggleJob(\'' + escAttr(job.id) + '\', this.checked)"><span></span></label>' +
          '<button class="sched-action-btn primary" title="立即执行" onclick="runJobNow(\'' + escAttr(job.id) + '\')">▶ 执行</button>' +
          '<button class="sched-action-btn" title="编辑任务" onclick="editJob(\'' + escAttr(job.id) + '\')">✏️ 编辑</button>' +
          '<button class="sched-action-btn" title="查看执行日志" onclick="openJobLogModal(\'' + escAttr(job.id) + '\')">📋 日志</button>' +
          '<button class="sched-action-btn danger" title="删除任务" onclick="deleteJob(\'' + escAttr(job.id) + '\')">🗑</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function esc(v) { return typeof escHtml === 'function' ? escHtml(v == null ? '' : v) : String(v == null ? '' : v); }
  function escAttr(v) { return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

  function filterSchedulerJobs() {
    var kw = String(val('sched-search-input') || '').trim().toLowerCase();
    var st = val('sched-status-filter');
    var rows = _schedJobs.filter(function (job) {
      var db = job.db_info || {};
      if (st === 'running' && !isRunning(job)) return false;
      if (st === 'paused' && isRunning(job)) return false;
      if (st === 'failed' && job.last_status !== 'failed') return false;
      if (kw) {
        var hay = [job.name, db.label, db.host, job.db_type, db.datasource_id].join(' ').toLowerCase();
        if (hay.indexOf(kw) < 0) return false;
      }
      return true;
    });
    renderScheduler(rows);
  }

  // ── 任务操作 ─────────────────────────────────────────────
  async function toggleJob(id, enabled) {
    try {
      var res = await fetch('/api/scheduler/jobs/' + encodeURIComponent(id) + '/toggle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !!enabled })
      });
      var data = await res.json();
      if (!data.ok) throw new Error(data.error || '操作失败');
      sToast(enabled ? '任务已启用' : '任务已暂停', 'success');
      loadSchedulerJobs();
    } catch (e) { sToast('操作失败：' + e.message, 'error'); }
  }

  async function runJobNow(id) {
    try {
      var res = await fetch('/api/scheduler/jobs/' + encodeURIComponent(id) + '/run', { method: 'POST' });
      var data = await res.json();
      if (!data.ok) throw new Error(data.error || '启动失败');
      sToast('已触发一次巡检，稍后可在执行日志查看结果', 'success');
      setTimeout(loadSchedulerJobs, 1800);
    } catch (e) { sToast('启动失败：' + e.message, 'error'); }
  }

  async function deleteJob(id) {
    var ok = await sConfirm('删除定时任务', '确定删除该定时任务？已生成的历史报告不会被删除。');
    if (!ok) return;
    try {
      var res = await fetch('/api/scheduler/jobs/' + encodeURIComponent(id), { method: 'DELETE' });
      var data = await res.json();
      if (!data.ok) throw new Error(data.error || '删除失败');
      sToast('任务已删除', 'success');
      loadSchedulerJobs();
    } catch (e) { sToast('删除失败：' + e.message, 'error'); }
  }

  // ── 向导开合与步骤 ───────────────────────────────────────
  function resetForm() {
    var setV = function (id, v) { var el = $(id); if (el) el.value = v; };
    var setC = function (id, v) { var el = $(id); if (el) el.checked = !!v; };
    setV('sched-job-name', '');
    setV('sched-freq-hourly-min', '0');
    setV('sched-freq-daily-time', '02:00');
    setV('sched-freq-weekly-time', '02:00');
    setV('sched-freq-weekly-dow', 'mon');
    setV('sched-freq-monthly-time', '02:00');
    setV('sched-freq-monthly-dom', '1');
    setV('sched-freq-year-dom', '1');
    setV('sched-freq-year-time', '02:00');
    setV('sched-cron-input', '');
    setV('sched-datasource', '');
    setV('sched-db-type', 'mysql');
    setV('sched-host', '');
    setV('sched-port', '3306');
    setV('sched-user', '');
    setV('sched-password', '');
    setV('sched-database', '');
    setV('sched-service-name', '');
    setV('sched-ssh-host', '');
    setV('sched-ssh-port', '22');
    setV('sched-ssh-user', '');
    setV('sched-ssh-password', '');
    setV('sched-zabbix-host', '');
    setV('sched-email-to', '');
    setV('sched-email-cc', '');
    setV('sched-template', '');
    setV('sched-test-status', '');
    setC('sched-sysdba', false);
    setC('sched-notify-on', true);
    setC('sched-notify-email', true);
    setC('sched-notify-anomaly', true);
    setC('sched-notify-attach', true);
    _schedEditingId = null;
    _schedSysMode = 'none';
    schedRenderMonthChips();
    schedSetMonths([new Date().getMonth() + 1]);
    schedSelectFreq('daily');
    schedSetSysCollect('none');
    schedOnDbTypeChange();
  }

  async function showAddJobForm(id) {
    _schedEditingId = id || null;
    resetForm();
    var title = $('sched-modal-title');
    if (title) title.textContent = id ? '编辑定时任务' : '新建定时任务';
    await loadSchedulerDatasources();
    if (id) {
      var job = (_schedJobs || []).filter(function (j) { return j.id === id; })[0];
      if (job) await fillJobForm(job);
    }
    schedGoStep(1);
    var modal = $('sched-job-modal');
    if (modal) modal.style.display = 'flex';
  }

  function hideAddJobForm() {
    var modal = $('sched-job-modal');
    if (modal) modal.style.display = 'none';
    _schedEditingId = null;
  }

  function editJob(id) { showAddJobForm(id); }

  function schedModalBackdrop(ev) {
    if (ev && ev.target === $('sched-job-modal')) hideAddJobForm();
  }

  function schedGoStep(n) {
    _schedStep = Math.max(1, Math.min(4, n));
    for (var i = 1; i <= 4; i++) {
      var pane = $('sched-pane-' + i);
      if (pane) pane.classList.toggle('active', i === _schedStep);
      var step = document.querySelector('#sched-steps .sched-step[data-step="' + i + '"]');
      if (step) {
        step.classList.toggle('active', i === _schedStep);
        step.classList.toggle('done', i < _schedStep);
      }
    }
    var prev = $('sched-btn-prev');
    var next = $('sched-btn-next');
    var save = $('sched-btn-save');
    if (prev) prev.style.display = _schedStep > 1 ? '' : 'none';
    if (next) next.style.display = _schedStep < 4 ? '' : 'none';
    if (save) save.style.display = _schedStep === 4 ? '' : 'none';
    if (_schedStep === 4) updateSummary();
  }

  function schedNextStep() {
    if (_schedStep === 1) {
      if (!String(val('sched-job-name') || '').trim()) { sToast('请填写任务名称', 'error'); return; }
      if (_schedFreq === 'yearly' && !schedSelectedMonths().length) {
        sToast('请至少选择一个执行月份', 'error');
        return;
      }
    }
    if (_schedStep === 2) {
      var ds = val('sched-datasource');
      if (!ds && !String(val('sched-host') || '').trim()) { sToast('请选择数据源或填写主机地址', 'error'); return; }
      if (!ds && !String(val('sched-user') || '').trim()) { sToast('请填写数据库用户名', 'error'); return; }
    }
    schedGoStep(_schedStep + 1);
  }

  function schedPrevStep() { schedGoStep(_schedStep - 1); }

  // ── 频率 ─────────────────────────────────────────────────
  var SCHED_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  function schedRenderMonthChips() {
    var box = $('sched-freq-year-month-chips');
    if (!box || box.children.length) return;
    box.innerHTML = SCHED_MONTHS.map(function (m) {
      return '<button type="button" class="sched-month-chip" data-month="' + m + '" onclick="schedToggleMonth(' + m + ')">' + m + '月</button>';
    }).join('');
  }

  function schedToggleMonth(m) {
    var el = document.querySelector('.sched-month-chip[data-month="' + m + '"]');
    if (el) el.classList.toggle('active');
    updateCronPreview();
  }

  function schedSelectedMonths() {
    return Array.prototype.slice.call(document.querySelectorAll('.sched-month-chip.active'))
      .map(function (b) { return parseInt(b.getAttribute('data-month'), 10); })
      .filter(function (n) { return n >= 1 && n <= 12; })
      .sort(function (a, b) { return a - b; });
  }

  function schedSetMonths(list) {
    var set = {};
    (list || []).forEach(function (m) { set[Number(m)] = true; });
    document.querySelectorAll('.sched-month-chip').forEach(function (b) {
      b.classList.toggle('active', !!set[parseInt(b.getAttribute('data-month'), 10)]);
    });
  }

  function schedYearPreset(mode) {
    if (mode === 'all') schedSetMonths(SCHED_MONTHS);
    else if (mode === 'quarter') schedSetMonths([1, 4, 7, 10]);
    else schedSetMonths([]);
    updateCronPreview();
  }

  function schedSelectFreq(freq) {
    _schedFreq = freq;
    document.querySelectorAll('#sched-freq-tabs .freq-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-freq') === freq);
    });
    document.querySelectorAll('.freq-panel').forEach(function (p) {
      var on = p.getAttribute('data-panel') === freq;
      p.style.display = on ? 'flex' : 'none';
      p.classList.toggle('active', on);
    });
    var custom = $('sched-cron-input');
    if (custom) custom.style.display = freq === 'custom' ? '' : 'none';
    updateCronPreview();
  }

  function _hm(id) {
    var v = String(val(id) || '02:00');
    var parts = v.split(':');
    return { h: parseInt(parts[0], 10) || 0, m: parseInt(parts[1], 10) || 0 };
  }

  function buildCron() {
    if (_schedFreq === 'custom') {
      return { expression: String(val('sched-cron-input') || '').trim() || '0 2 * * *' };
    }
    if (_schedFreq === 'hourly') {
      return { minute: String(val('sched-freq-hourly-min') || '0'), hour: '*', day: '*', month: '*', day_of_week: '*' };
    }
    if (_schedFreq === 'weekly') {
      var t = _hm('sched-freq-weekly-time');
      return { minute: String(t.m), hour: String(t.h), day: '*', month: '*', day_of_week: val('sched-freq-weekly-dow') || 'mon' };
    }
    if (_schedFreq === 'monthly') {
      var t2 = _hm('sched-freq-monthly-time');
      return { minute: String(t2.m), hour: String(t2.h), day: val('sched-freq-monthly-dom') || '1', month: '*', day_of_week: '*' };
    }
    if (_schedFreq === 'yearly') {
      var months = schedSelectedMonths();
      var t3 = _hm('sched-freq-year-time');
      return {
        minute: String(t3.m), hour: String(t3.h),
        day: val('sched-freq-year-dom') || '1',
        month: months.length ? months.join(',') : '*',
        day_of_week: '*'
      };
    }
    var d = _hm('sched-freq-daily-time');
    return { minute: String(d.m), hour: String(d.h), day: '*', month: '*', day_of_week: '*' };
  }

  function describeCron(cron) {
    if (typeof formatCronText === 'function') {
      try { return formatCronText(cron); } catch (e) {}
    }
    return cron && cron.expression ? '自定义 ' + cron.expression : '按 Crontab 执行';
  }

  function updateCronPreview() {
    var el = $('sched-cron-preview');
    if (el) el.textContent = describeCron(buildCron());
  }

  // ── 数据源与连接 ─────────────────────────────────────────
  async function loadSchedulerDatasources() {
    var sel = $('sched-datasource');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- 手动输入连接信息 --</option>';
    try {
      var res = await fetch('/api/pro/datasources');
      var data = await res.json();
      (data.datasources || []).forEach(function (ds) {
        var opt = document.createElement('option');
        opt.value = ds.id;
        opt.textContent = (ds.name || ds.host) + ' · ' + dbLabel(ds.db_type);
        sel.appendChild(opt);
      });
    } catch (e) { /* 无 Pro 模块时仅支持手动输入 */ }
  }

  function schedOnDbTypeChange() {
    var type = val('sched-db-type');
    var isOracle = type === 'oracle' || type === 'oracle_jdbc';
    var showDb = ['mysql', 'mariadb', 'tidb', 'pg', 'postgresql', 'sqlserver', 'kingbase', 'gbase', 'ivorysql'].indexOf(type) >= 0;
    var dbWrap = $('sched-database-wrap');
    var svcWrap = $('sched-service-wrap');
    var sysWrap = $('sched-sysdba-wrap');
    if (dbWrap) dbWrap.style.display = showDb ? '' : 'none';
    if (svcWrap) svcWrap.style.display = isOracle ? '' : 'none';
    if (sysWrap) sysWrap.style.display = isOracle ? '' : 'none';
    var ports = { mysql: 3306, mariadb: 3306, tidb: 4000, pg: 5432, postgresql: 5432, sqlserver: 1433, oracle: 1521, oracle_jdbc: 1521, dm: 5236, kingbase: 54321, gbase: 5258, mongodb: 27017, redis: 6379 };
    var portEl = $('sched-port');
    if (portEl && (!portEl.value || ports[type])) portEl.value = ports[type] || portEl.value;
    if (typeof loadInspectionTemplatesForSelect === 'function') {
      try { loadInspectionTemplatesForSelect(type, 'sched-template'); } catch (e) {}
    }
  }

  // 把一个（已解密的）数据源对象铺到定时任务表单上。
  // 新建时选数据源、编辑时按 datasource_id 回捞，都走这里，保证两条路径口径一致。
  function schedApplyDatasource(ds) {
    if (!ds) return;
    var setV = function (fid, v) { var el = $(fid); if (el) el.value = v == null ? '' : v; };
    setV('sched-db-type', ds.db_type || 'mysql');
    setV('sched-host', ds.host || '');
    setV('sched-port', ds.port || '');
    setV('sched-user', ds.user || '');
    setV('sched-password', ds.password || '');
    setV('sched-database', ds.database || '');
    setV('sched-service-name', ds.service_name || '');
    var cb = $('sched-sysdba'); if (cb) cb.checked = !!ds.sysdba;
    schedOnDbTypeChange();
  }

  async function schedOnDatasourceChange() {
    var id = val('sched-datasource');
    var setV = function (fid, v) { var el = $(fid); if (el) el.value = v == null ? '' : v; };
    if (!id) {
      setV('sched-host', ''); setV('sched-port', ''); setV('sched-user', '');
      setV('sched-password', ''); setV('sched-database', ''); setV('sched-service-name', '');
      var cb = $('sched-sysdba'); if (cb) cb.checked = false;
      return;
    }
    try {
      var res = await fetch('/api/pro/datasources/' + encodeURIComponent(id) + '/decrypt', { credentials: 'same-origin' });
      var data = await res.json();
      schedApplyDatasource(data.datasource);
    } catch (e) { sToast('加载数据源失败：' + e.message, 'error'); }
  }

  async function schedTestDb() {
    var box = $('sched-test-status');
    if (box) { box.style.color = 'var(--text-muted)'; box.textContent = '正在测试连接...'; }
    var payload = {
      db_type: val('sched-db-type'), host: val('sched-host'), port: parseInt(val('sched-port'), 10) || 0,
      user: val('sched-user'), password: val('sched-password'), database: val('sched-database'),
      service_name: val('sched-service-name') || null, sysdba: checked('sched-sysdba')
    };
    try {
      var res = await fetch('/api/test_db', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      var data = await res.json();
      if (box) {
        box.style.color = data.ok ? 'var(--success)' : 'var(--danger)';
        box.textContent = data.ok ? ('✅ ' + (data.message || '连接成功') + (data.version ? ' · ' + data.version : '')) : ('❌ ' + (data.error || '连接失败'));
      }
    } catch (e) {
      if (box) { box.style.color = 'var(--danger)'; box.textContent = '❌ ' + e.message; }
    }
  }

  // ── 系统采集 / 通知 ──────────────────────────────────────
  function schedSetSysCollect(mode) {
    _schedSysMode = mode;
    document.querySelectorAll('.sched-radio-card').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-sys') === mode);
    });
    var ssh = $('sched-ssh-fields');
    var zbx = $('sched-zabbix-fields');
    if (ssh) ssh.style.display = mode === 'ssh' ? '' : 'none';
    if (zbx) zbx.style.display = mode === 'zabbix' ? '' : 'none';
    if (mode === 'ssh' && !val('sched-ssh-host')) {
      var h = $('sched-ssh-host'); if (h) h.value = val('sched-host') || '';
    }
  }

  function schedUpdateEmailSubOptions() {
    var on = checked('sched-notify-on');
    ['sched-notify-email', 'sched-notify-anomaly', 'sched-notify-attach'].forEach(function (id) {
      var el = $(id); if (el) el.disabled = !on;
    });
    ['sched-email-to', 'sched-email-cc'].forEach(function (id) {
      var el = $(id); if (el) el.disabled = !on;
    });
    updateSummary();
  }

  function updateSummary() {
    var box = $('sched-summary');
    if (!box) return;
    var target = val('sched-datasource') ? (($('sched-datasource').selectedOptions[0] || {}).textContent || '') : (val('sched-host') || '未填写');
    box.innerHTML = '📋 <b>' + esc(val('sched-job-name') || '未命名任务') + '</b><br>' +
      '🎯 目标：' + esc(target) + ' · ' + esc(dbLabel(val('sched-db-type'))) + '<br>' +
      '🗓️ 频率：' + esc(describeCron(buildCron())) + '<br>' +
      '🖥️ 系统采集：' + ({ none: '不采集', ssh: 'SSH', zabbix: 'Zabbix' }[_schedSysMode] || '不采集') + '<br>' +
      '🔔 通知：' + (checked('sched-notify-on') ? ('发送' + (checked('sched-notify-email') ? '邮件' : '')) : '不发送');
  }

  // ── 填写 / 保存 ──────────────────────────────────────────
  function fillCron(cron) {
    if (!cron) return;
    if (cron.expression) {
      schedSelectFreq('custom');
      var ci = $('sched-cron-input'); if (ci) ci.value = cron.expression;
      return;
    }
    var h = String(cron.hour == null ? '*' : cron.hour);
    var m = String(cron.minute == null ? '0' : cron.minute);
    var dow = String(cron.day_of_week || '*');
    var day = String(cron.day || '*');
    if (h === '*' && m !== '*') {
      schedSelectFreq('hourly');
      var hm = $('sched-freq-hourly-min'); if (hm) hm.value = m;
      return;
    }
    if (dow !== '*') {
      schedSelectFreq('weekly');
      var wd = $('sched-freq-weekly-dow'); if (wd) wd.value = dow;
      var wt = $('sched-freq-weekly-time'); if (wt) wt.value = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      return;
    }
    // 带月份字段（非 *）→ 每年执行，回填月份多选（必须先于 day 判断：年度任务也有 day）
    if (cron.month && String(cron.month) !== '*') {
      schedSelectFreq('yearly');
      schedRenderMonthChips();
      schedSetMonths(String(cron.month).split(',').map(function (x) { return parseInt(x, 10); }));
      var yd = $('sched-freq-year-dom'); if (yd) yd.value = String(parseInt(day, 10) || 1);
      var yt = $('sched-freq-year-time'); if (yt) yt.value = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      return;
    }
    if (day !== '*') {
      schedSelectFreq('monthly');
      var md = $('sched-freq-monthly-dom'); if (md) md.value = day;
      var mt = $('sched-freq-monthly-time'); if (mt) mt.value = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      return;
    }
    schedSelectFreq('daily');
    var dt = $('sched-freq-daily-time');
    if (dt) dt.value = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  function isMaskedSecret(v) {
    var s = String(v == null ? '' : v);
    return !s || s === '***' || /^[\u2022*]+$/.test(s);
  }

  async function fillJobForm(job) {
    var setV = function (id, v) { var el = $(id); if (el) el.value = v == null ? '' : v; };
    var setC = function (id, v) { var el = $(id); if (el) el.checked = !!v; };
    setV('sched-job-name', job.name);
    fillCron(job.cron);
    var db = job.db_info || {};
    var dsId = db.datasource_id || '';
    var filledFromDatasource = false;
    if (dsId) {
      var sel = $('sched-datasource');
      if (sel) {
        if (!sel.querySelector('option[value="' + dsId + '"]')) {
          var opt = document.createElement('option');
          opt.value = dsId; opt.textContent = db.label || db.datasource_id;
          sel.appendChild(opt);
        }
        sel.value = dsId;
      }
      // 任务绑定数据源时，接口回的 db_info 是「列表展示用」的脱敏视图：
      // host 被换成数据源名称、password 置空或 ***（见 scheduler.py 的 list_jobs）。
      // 直接拿它回填会把中文名写进主机栏、密码留空，测试连接必然失败。
      // 真值按 datasource_id 走 /decrypt 取回，与新建时选数据源是同一条路径。
      try {
        var res = await fetch('/api/pro/datasources/' + encodeURIComponent(dsId) + '/decrypt',
                              { credentials: 'same-origin' });
        var data = await res.json();
        var ds = data && data.datasource;
        if (ds && (ds.host || ds.db_type)) {
          schedApplyDatasource(ds);
          filledFromDatasource = true;
        }
      } catch (e) { /* 数据源已删除或接口异常时回退到展示值，保证仍可编辑 */ }
      if (!filledFromDatasource) {
        sToast('数据源已不可用，以下显示的是任务里保存的旧值，请重新选择数据源', 'warning');
      }
    }
    if (!filledFromDatasource) {
      setV('sched-db-type', db.db_type || job.db_type || 'mysql');
      setV('sched-host', db.host || '');
      setV('sched-port', db.port || '');
      setV('sched-user', db.user || '');
      // 脱敏占位符不能当密码回填，否则一保存/一测试就把 *** 当真密码发出去
      setV('sched-password', isMaskedSecret(db.password) ? '' : db.password);
      var pwdEl = $('sched-password');
      if (pwdEl && isMaskedSecret(db.password)) pwdEl.placeholder = '（不修改请留空）';
      setV('sched-database', db.database || '');
      setV('sched-service-name', db.service_name || '');
      setC('sched-sysdba', db.sysdba);
    }
    if (db.ssh_host) {
      schedSetSysCollect('ssh');
      setV('sched-ssh-host', db.ssh_host); setV('sched-ssh-port', db.ssh_port || 22);
      setV('sched-ssh-user', db.ssh_user || ''); setV('sched-ssh-password', db.ssh_password || '');
    } else {
      schedSetSysCollect(job.syscollect_mode || 'none');
      setV('sched-zabbix-host', (job.syscollect && job.syscollect.zabbix_host) || '');
    }
    setC('sched-notify-on', job.notify_on_done !== false);
    setC('sched-notify-email', job.notify_email !== false);
    setC('sched-notify-anomaly', job.notify_anomaly !== false);
    setC('sched-notify-attach', job.notify_attach !== false);
    setV('sched-email-to', job.email_to || '');
    setV('sched-email-cc', job.email_cc || '');
    if (job.template_id) setV('sched-template', job.template_id);
    schedOnDbTypeChange();
    schedUpdateEmailSubOptions();
  }

  function buildPayload() {
    var dsId = val('sched-datasource');
    var payload = {
      name: String(val('sched-job-name') || '').trim(),
      inspector_name: 'Jack',
      notify_on_done: checked('sched-notify-on'),
      notify_email: checked('sched-notify-email'),
      notify_anomaly: checked('sched-notify-anomaly'),
      notify_attach: checked('sched-notify-attach'),
      email_to: val('sched-email-to') || '',
      email_cc: val('sched-email-cc') || '',
      syscollect_mode: _schedSysMode,
      syscollect: _schedSysMode === 'zabbix' ? { zabbix_host: val('sched-zabbix-host') } : {},
      cron: buildCron()
    };
    var tmpl = val('sched-template');
    if (tmpl) payload.template_id = parseInt(tmpl, 10);
    if (dsId) {
      payload.datasource_id = dsId;
      payload.label = (($('sched-datasource').selectedOptions[0] || {}).textContent || dsId);
    } else {
      payload.db_type = val('sched-db-type');
      payload.label = val('sched-host');
      payload.host = val('sched-host');
      payload.port = parseInt(val('sched-port'), 10) || 3306;
      payload.user = val('sched-user');
      payload.password = val('sched-password');
      payload.database = val('sched-database');
      payload.service_name = val('sched-service-name') || null;
      payload.sysdba = checked('sched-sysdba');
      if (_schedSysMode === 'ssh') {
        payload.ssh_host = val('sched-ssh-host') || val('sched-host');
        payload.ssh_port = parseInt(val('sched-ssh-port'), 10) || 22;
        payload.ssh_user = val('sched-ssh-user');
        payload.ssh_password = val('sched-ssh-password');
      }
    }
    return payload;
  }

  async function saveJob() {
    var payload = buildPayload();
    if (!payload.name) { sToast('请填写任务名称', 'error'); schedGoStep(1); return; }
    if (!payload.datasource_id && !payload.host) { sToast('请填写数据库主机', 'error'); schedGoStep(2); return; }
    if (_schedFreq === 'yearly' && !schedSelectedMonths().length) {
      sToast('请至少选择一个执行月份', 'error'); schedGoStep(1); return;
    }
    // Cron 合法性预检：调用后端 preview
    if (payload.cron.expression) {
      try {
        var pv = await fetch('/api/scheduler/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cron: payload.cron })
        });
        var pdata = await pv.json();
        if (!pdata.ok) throw new Error(pdata.error || 'Cron 表达式无效');
      } catch (e) {
        sToast('Cron 表达式无效：' + e.message, 'error');
        schedGoStep(1);
        return;
      }
    }
    var isEdit = !!_schedEditingId;
    var url = isEdit ? '/api/scheduler/jobs/' + encodeURIComponent(_schedEditingId) : '/api/scheduler/jobs';
    try {
      var res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var data = await res.json();
      if (!data.ok) throw new Error(data.error || '保存失败');
      sToast(isEdit ? '任务已更新' : '任务已创建', 'success');
      hideAddJobForm();
      loadSchedulerJobs();
    } catch (e) { sToast('保存失败：' + e.message, 'error'); }
  }

  // ── 执行日志 ─────────────────────────────────────────────
  async function openJobLogModal(id) {
    _schedLogJobId = id;
    var job = (_schedJobs || []).filter(function (j) { return j.id === id; })[0];
    var title = $('sched-log-title');
    if (title) title.textContent = '执行日志' + (job ? ' · ' + job.name : '');
    var modal = $('sched-log-modal');
    if (modal) modal.style.display = 'flex';
    var body = $('sched-log-body');
    if (body) body.innerHTML = '<div class="sched-log-empty">加载中...</div>';
    try {
      var res = await fetch('/api/scheduler/jobs/' + encodeURIComponent(id) + '/logs?limit=100');
      var data = await res.json();
      var logs = data.logs || [];
      if (!logs.length) {
        if (body) body.innerHTML = '<div class="sched-log-empty">暂无执行记录</div>';
        return;
      }
      var html = '<table class="sched-log-table"><thead><tr>' +
        '<th style="width:132px">开始时间</th><th style="width:132px">结束时间</th><th style="width:70px">状态</th>' +
        '<th style="width:64px">触发</th><th style="width:60px">耗时</th><th style="width:150px">目标</th>' +
        '<th>说明 / 报告</th></tr></thead><tbody>';
      logs.forEach(function (l) {
        var badge = { success: 'success', failed: 'failed', skipped: 'skipped' }[l.status] || 'paused';
        var statusText = { success: '成功', failed: '失败', skipped: '跳过' }[l.status] || l.status || '—';
        var target = [l.db_type, l.host].filter(Boolean).join(' · ') || '—';
        var msg = esc(l.message || '');
        if (l.report) msg += (msg ? ' · ' : '') + '<a href="/api/download_file?name=' + encodeURIComponent(l.report) + '" target="_blank">📄 下载报告</a>';
        html += '<tr>' +
          '<td>' + esc(fmtTime(l.start_time)) + '</td>' +
          '<td>' + esc(fmtTime(l.end_time)) + '</td>' +
          '<td><span class="sched-badge ' + badge + '">' + esc(statusText) + '</span></td>' +
          '<td>' + esc(l.triggered_by === 'manual' ? '手动' : '定时') + '</td>' +
          '<td>' + esc(l.duration != null ? l.duration + 's' : '—') + '</td>' +
          '<td>' + esc(target) + '</td>' +
          '<td>' + msg + '</td>' +
          '</tr>';
      });
      html += '</tbody></table>';
      if (body) body.innerHTML = html;
    } catch (e) {
      if (body) body.innerHTML = '<div class="sched-log-empty">加载失败：' + esc(e.message) + '</div>';
    }
  }

  function closeJobLogModal() {
    var modal = $('sched-log-modal');
    if (modal) modal.style.display = 'none';
    _schedLogJobId = null;
  }

  function schedLogBackdrop(ev) {
    if (ev && ev.target === $('sched-log-modal')) closeJobLogModal();
  }

  async function clearJobLogs() {
    if (!_schedLogJobId) return;
    var ok = await sConfirm('清空执行日志', '确定清空该任务的全部执行记录？此操作不可恢复。');
    if (!ok) return;
    try {
      var res = await fetch('/api/scheduler/jobs/' + encodeURIComponent(_schedLogJobId) + '/logs', { method: 'DELETE' });
      var data = await res.json();
      if (!data.ok) throw new Error(data.error || '清空失败');
      sToast('执行日志已清空', 'success');
      openJobLogModal(_schedLogJobId);
    } catch (e) { sToast('清空失败：' + e.message, 'error'); }
  }

  // 频率控件变化时实时刷新预览
  schedRenderMonthChips();
  ['sched-freq-hourly-min', 'sched-freq-daily-time', 'sched-freq-weekly-time', 'sched-freq-weekly-dow',
   'sched-freq-monthly-time', 'sched-freq-monthly-dom', 'sched-freq-year-time', 'sched-freq-year-dom',
   'sched-cron-input'].forEach(function (id) {
    document.addEventListener('input', function (e) { if (e.target && e.target.id === id) updateCronPreview(); });
    document.addEventListener('change', function (e) { if (e.target && e.target.id === id) updateCronPreview(); });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var logModal = $('sched-log-modal');
    if (logModal && logModal.style.display !== 'none') { closeJobLogModal(); return; }
    var modal = $('sched-job-modal');
    if (modal && modal.style.display !== 'none') hideAddJobForm();
  });

  // 暴露给页面内联 onclick（覆盖旧版同名函数）
  window.loadSchedulerJobs = loadSchedulerJobs;
  window.renderScheduler = renderScheduler;
  window.filterSchedulerJobs = filterSchedulerJobs;
  window.showAddJobForm = showAddJobForm;
  window.hideAddJobForm = hideAddJobForm;
  window.editJob = editJob;
  window.deleteJob = deleteJob;
  window.toggleJob = toggleJob;
  window.runJobNow = runJobNow;
  window.saveJob = saveJob;
  window.schedSelectFreq = schedSelectFreq;
  window.schedToggleMonth = schedToggleMonth;
  window.schedYearPreset = schedYearPreset;
  window.schedNextStep = schedNextStep;
  window.schedPrevStep = schedPrevStep;
  window.schedGoStep = schedGoStep;
  window.schedOnDbTypeChange = schedOnDbTypeChange;
  window.schedOnDatasourceChange = schedOnDatasourceChange;
  window.schedTestDb = schedTestDb;
  window.schedSetSysCollect = schedSetSysCollect;
  window.schedUpdateEmailSubOptions = schedUpdateEmailSubOptions;
  window.schedModalBackdrop = schedModalBackdrop;
  window.openJobLogModal = openJobLogModal;
  window.closeJobLogModal = closeJobLogModal;
  window.schedLogBackdrop = schedLogBackdrop;
  window.clearJobLogs = clearJobLogs;
})();
