/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * Fusion page logic: Zabbix 监控（MVP）。
 * 左栏是本地手工主机清单（/api/zabbix/servers，可批量添加/编辑/删除），
 * 选中后按 IP/主机名匹配 Zabbix 主机；右栏单主机仪表盘：
 * 6 张指标卡 + 磁盘明细 + 活动问题。数据全部来自 Zabbix 最新值。
 */
(function () {
  'use strict';

  var ZM = {
    servers: [],
    currentServer: null,
    searchTimer: null,
    refreshTimer: null,
    refreshInterval: 60,
    configured: false,
    _editId: null
  };

  function t(key, fallback) {
    try {
      if (typeof window.i18n === 'function') {
        var v = window.i18n(key);
        if (v && v !== key) return v;
      }
    } catch (e) { /* i18n 未就绪时退回中文 */ }
    return fallback || key;
  }

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtNum(v, digits) {
    if (v === null || v === undefined || v === '') return '—';
    var n = Number(v);
    if (isNaN(n)) return String(v);
    return n.toFixed(digits === undefined ? 1 : digits);
  }

  function fmtBps(v) {
    if (v === null || v === undefined || v === '') return '—';
    var n = Number(v);
    if (isNaN(n)) return String(v);
    var units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    var x = n, i = 0;
    while (Math.abs(x) >= 1000 && i < units.length - 1) { x /= 1000; i++; }
    return x.toFixed(2) + units[i];
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(Number(ts) * 1000);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  async function apiGet(url) {
    var res = await fetch(url, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } });
    var data = await res.json();
    if (data.ok === false) throw new Error(data.error || t('webui.zbxm_fetch_fail', '加载失败'));
    return data;
  }

  async function apiSend(url, body, method) {
    var res = await fetch(url, {
      method: method || 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body)
    });
    var data = await res.json();
    if (data.ok === false) throw new Error(data.error || t('webui.zbxm_fetch_fail', '加载失败'));
    return data;
  }

  function toastOk(msg) {
    if (typeof window.toastSuccess === 'function') window.toastSuccess(msg);
  }

  function toastErr(msg) {
    if (typeof window.toastError === 'function') window.toastError(msg);
    else alert(msg);
  }

  // 严重级别（自低到高，与 Zabbix 优先级一致；配色与后端 monitor.py 相同）
  var SEV_LEVELS = [
    { sev: 0, key: 'webui.zbxm_sev_0', fallback: '未分类', color: '#97aab3' },
    { sev: 1, key: 'webui.zbxm_sev_1', fallback: '信息', color: '#7499ff' },
    { sev: 2, key: 'webui.zbxm_sev_2', fallback: '警告', color: '#ffc859' },
    { sev: 3, key: 'webui.zbxm_sev_3', fallback: '一般严重', color: '#ffa059' },
    { sev: 4, key: 'webui.zbxm_sev_4', fallback: '严重', color: '#e97659' },
    { sev: 5, key: 'webui.zbxm_sev_5', fallback: '灾难', color: '#e45959' }
  ];

  function sevColor(sev) {
    var n = parseInt(sev, 10);
    for (var i = 0; i < SEV_LEVELS.length; i++) {
      if (SEV_LEVELS[i].sev === n) return SEV_LEVELS[i].color;
    }
    return '#97aab3';
  }

  // ─── 页面入口 ─────────────────────────────────────────────
  async function load() {
    try {
      var cfg = await apiGet('/api/zabbix/config');
      ZM.configured = !!cfg.configured;
      var z = (cfg.data || {}).zabbix || {};
      ZM.refreshInterval = parseInt(z.refresh_interval, 10);
      if (isNaN(ZM.refreshInterval) || ZM.refreshInterval < 0) ZM.refreshInterval = 60;
    } catch (e) {
      ZM.configured = false;
    }
    setupAutoRefresh();
    // 左栏是本地清单，与 Zabbix 是否已配置无关，始终可维护
    await loadServers();
    if (!ZM.configured) renderUnconfigured();
  }

  function renderUnconfigured() {
    var body = $('zbxm-body');
    if (!body) return;
    body.innerHTML = '<div class="zbxm-empty"><div class="icon">🔌</div>' +
      '<div>' + esc(t('webui.zbxm_unconfigured', '尚未配置 Zabbix，请先在「Zabbix 监控设置」页填写地址与凭据')) + '</div>' +
      '<div style="margin-top:14px"><button class="btn btn-primary" onclick="showPage(\'zabbix\')">' +
      esc(t('webui.zbxm_goto_settings', '前往设置')) + '</button></div></div>';
  }

  function renderEmptyHint() {
    var body = $('zbxm-body');
    if (!body) return;
    body.innerHTML = '<div class="zbxm-empty"><div class="icon">📊</div>' +
      '<div>' + esc(t('webui.zbxm_empty_hint', '请点击左侧主机查看监控数据')) + '</div></div>';
  }

  function setupAutoRefresh() {
    if (ZM.refreshTimer) { clearInterval(ZM.refreshTimer); ZM.refreshTimer = null; }
    if (ZM.refreshInterval > 0) {
      ZM.refreshTimer = setInterval(function () {
        // 只在页面可见且已选中主机时轮询，避免后台空转打 Zabbix
        var page = $('page-zabbix-monitor');
        if (!page || !page.classList.contains('active')) return;
        if (ZM.currentServer) loadDashboard(ZM.currentServer, true);
      }, ZM.refreshInterval * 1000);
    }
  }

  // ─── 左栏：本地手工主机清单 ───────────────────────────────
  async function loadServers(silent) {
    var list = $('zbxm-host-list');
    if (list && !silent) {
      list.innerHTML = '<div class="zbxm-host-empty">' +
        esc(t('webui.zbxm_loading', '加载中...')) + '</div>';
    }
    try {
      var data = await apiGet('/api/zabbix/servers');
      ZM.servers = data.data || [];
      renderServers();
    } catch (e) {
      if (list && !silent) {
        list.innerHTML = '<div class="zbxm-host-empty" style="color:var(--danger,#e45959)">' +
          esc(e.message) + '</div>';
      }
    }
  }

  function filteredServers() {
    var q = (($('zbxm-search') || {}).value || '').trim().toLowerCase();
    if (!q) return ZM.servers;
    return ZM.servers.filter(function (s) {
      return [s.ip, s.hostname, s.remark].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderServers() {
    var list = $('zbxm-host-list');
    var count = $('zbxm-host-count');
    if (count) count.textContent = ZM.servers.length + ' ' + t('webui.zbxm_hosts_unit', '台');
    if (!list) return;
    var rows = filteredServers();
    if (!rows.length) {
      list.innerHTML = '<div class="zbxm-host-empty"><div style="font-size:30px;margin-bottom:8px">🖥️</div>' +
        esc(ZM.servers.length
          ? t('webui.zbxm_no_hosts', '未找到主机')
          : t('webui.zbxm_no_servers', '暂无服务器，点击上方「➕」登记要监控的服务器 IP')) + '</div>';
      return;
    }
    list.innerHTML = rows.map(function (s) {
      var active = ZM.currentServer && String(ZM.currentServer.id) === String(s.id) ? ' active' : '';
      return '<div class="zbxm-host-item' + active + '" data-server-id="' + esc(s.id) + '" ' +
        'onclick="FusionZabbixMonitor.selectServer(\'' + esc(s.id) + '\')">' +
        '<span style="font-size:13px">🖥️</span>' +
        '<div class="zbxm-host-main">' +
          '<div class="zbxm-host-name">' + esc(s.ip) +
            (s.hostname ? ' <span style="font-weight:400;color:var(--text-muted)">' + esc(s.hostname) + '</span>' : '') + '</div>' +
          '<div class="zbxm-host-ip">' +
            (s.remark ? esc(s.remark) : '<span style="opacity:.5">' + esc(t('webui.zbxm_no_remark', '无备注')) + '</span>') + '</div>' +
        '</div>' +
        '<span class="zbxm-server-actions">' +
          '<button class="btn btn-ghost" title="' + esc(t('webui.zbxm_edit', '编辑')) + '" ' +
            'onclick="event.stopPropagation();FusionZabbixMonitor.showEdit(\'' + esc(s.id) + '\')">✏️</button>' +
          '<button class="btn btn-ghost" title="' + esc(t('webui.zbxm_del', '删除')) + '" ' +
            'onclick="event.stopPropagation();FusionZabbixMonitor.deleteServer(\'' + esc(s.id) + '\')">🗑️</button>' +
        '</span></div>';
    }).join('');
  }

  function onSearch() {
    if (ZM.searchTimer) clearTimeout(ZM.searchTimer);
    // 清单在本地，过滤不需要请求后端
    ZM.searchTimer = setTimeout(renderServers, 200);
  }

  async function refresh() {
    await loadServers();
    if (ZM.currentServer) {
      // 清单可能已被别处改动：按 id 重新取最新条目，取不到说明已被删除
      var id = String(ZM.currentServer.id);
      var fresh = null;
      for (var i = 0; i < ZM.servers.length; i++) {
        if (String(ZM.servers[i].id) === id) { fresh = ZM.servers[i]; break; }
      }
      if (fresh) {
        ZM.currentServer = fresh;
        await loadDashboard(fresh);
      } else {
        ZM.currentServer = null;
        renderEmptyHint();
      }
    }
  }

  // ─── 清单维护：批量添加 / 编辑 / 删除 ─────────────────────
  function showAdd() {
    var ta = $('zbxm-add-textarea');
    if (ta) ta.value = '';
    var m = $('zbxm-add-modal');
    if (m) m.style.display = 'flex';
  }

  function closeAdd() {
    var m = $('zbxm-add-modal');
    if (m) m.style.display = 'none';
  }

  async function doAdd() {
    var text = ($('zbxm-add-textarea') || {}).value || '';
    var servers = [];
    text.split('\n').forEach(function (line) {
      line = line.trim();
      if (!line) return;
      var parts = line.split(/\s+/);
      var ip = parts[0];
      if (ip) servers.push({ ip: ip, hostname: parts[1] || '', remark: parts.slice(2).join(' ') });
    });
    if (!servers.length) { toastErr(t('webui.zbxm_input_ip', '请输入服务器 IP')); return; }
    try {
      var res = await apiSend('/api/zabbix/servers', { servers: servers }, 'POST');
      toastOk(res.msg || t('webui.zbxm_save', '保存'));
      closeAdd();
      await loadServers();
    } catch (e) {
      toastErr(e.message);
    }
  }

  function findServer(id) {
    for (var i = 0; i < ZM.servers.length; i++) {
      if (String(ZM.servers[i].id) === String(id)) return ZM.servers[i];
    }
    return null;
  }

  function showEdit(id) {
    var server = findServer(id);
    if (!server) return;
    ZM._editId = id;
    if ($('zbxm-edit-ip')) $('zbxm-edit-ip').value = server.ip || '';
    if ($('zbxm-edit-hostname')) $('zbxm-edit-hostname').value = server.hostname || '';
    if ($('zbxm-edit-remark')) $('zbxm-edit-remark').value = server.remark || '';
    var m = $('zbxm-edit-modal');
    if (m) m.style.display = 'flex';
  }

  function closeEdit() {
    var m = $('zbxm-edit-modal');
    if (m) m.style.display = 'none';
  }

  async function doEdit() {
    var id = ZM._editId;
    var ip = (($('zbxm-edit-ip') || {}).value || '').trim();
    var hostname = (($('zbxm-edit-hostname') || {}).value || '').trim();
    var remark = (($('zbxm-edit-remark') || {}).value || '').trim();
    if (!ip) { toastErr(t('webui.zbxm_input_ip', '请输入服务器 IP')); return; }
    try {
      var res = await apiSend('/api/zabbix/servers/' + encodeURIComponent(id),
        { ip: ip, hostname: hostname, remark: remark }, 'PUT');
      toastOk(res.msg || t('webui.zbxm_save', '保存'));
      closeEdit();
      await loadServers();
      // 编辑的是当前选中项时，用新 IP/主机名重新匹配并刷新监控数据
      if (ZM.currentServer && String(ZM.currentServer.id) === String(id)) {
        ZM.currentServer = findServer(id) || ZM.currentServer;
        await loadDashboard(ZM.currentServer);
      }
    } catch (e) {
      toastErr(e.message);
    }
  }

  async function deleteServer(id) {
    var server = findServer(id);
    if (!server) return;
    var msg = t('webui.zbxm_del_confirm', '确定删除服务器 {} 吗？').replace('{}', server.ip);
    var okc = (typeof window.toastConfirm === 'function') ? await window.toastConfirm(msg) : confirm(msg);
    if (!okc) return;
    try {
      var res = await apiSend('/api/zabbix/servers/' + encodeURIComponent(id), null, 'DELETE');
      toastOk(res.msg || t('webui.zbxm_del', '删除'));
      if (ZM.currentServer && String(ZM.currentServer.id) === String(id)) {
        ZM.currentServer = null;
        renderEmptyHint();
      }
      await loadServers();
    } catch (e) {
      toastErr(e.message);
    }
  }

  // ─── 右栏：仪表盘 ─────────────────────────────────────────
  async function selectServer(id) {
    var server = findServer(id);
    if (!server) return;
    ZM.currentServer = server;
    renderServers();
    await loadDashboard(server);
  }

  async function loadDashboard(server, silent) {
    if (!ZM.configured) { renderUnconfigured(); return; }
    var body = $('zbxm-body');
    var label = server.hostname || server.ip;
    if (body && !silent) {
      body.innerHTML = '<div class="zbxm-empty"><span class="spinner"></span> ' +
        esc(t('webui.zbxm_loading_data', '正在加载监控数据...')) + ' (' + esc(label) + ')</div>';
    }
    try {
      var params = [];
      if (server.ip) params.push('ip=' + encodeURIComponent(server.ip));
      if (server.hostname) params.push('hostname=' + encodeURIComponent(server.hostname));
      var data = await apiGet('/api/zabbix/monitor?' + params.join('&'));
      // 轮询回来时用户可能已切换主机，丢弃过期响应
      if (!ZM.currentServer || String(ZM.currentServer.id) !== String(server.id)) return;
      renderDashboard(data.data || {});
    } catch (e) {
      if (!ZM.currentServer || String(ZM.currentServer.id) !== String(server.id)) return;
      if (body && !silent) {
        body.innerHTML = '<div class="zbxm-empty"><div class="icon">⚠️</div>' +
          '<div style="color:var(--danger,#e45959)">' + esc(e.message) + '</div></div>';
      }
    }
  }

  function statusBadge(host) {
    if (host.status === '1') {
      return '<span class="badge" style="background:#e45959;color:#fff">' +
        esc(t('webui.zbxm_disabled', '停用')) + '</span>';
    }
    if (host.available === '2') {
      return '<span class="badge" style="background:#e45959;color:#fff">' +
        esc(t('webui.zbxm_unavailable', '不可达')) + '</span>';
    }
    if (host.available === '1') {
      return '<span class="badge" style="background:var(--success,#00C8A0);color:#fff">' +
        esc(t('webui.zbxm_available', '可用')) + '</span>';
    }
    return '<span class="badge" style="background:#ffc859;color:#fff">' +
      esc(t('webui.zbxm_unknown', '未知')) + '</span>';
  }

  function severityBadges(problems) {
    var counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    (problems || []).forEach(function (p) {
      var k = parseInt(p.priority, 10);
      if (k >= 0 && k <= 5) counts[k]++;
    });
    var badges = SEV_LEVELS.map(function (lv) {
      var name = t(lv.key, lv.fallback);
      var c = counts[lv.sev];
      if (c > 0) {
        return '<span class="zbxm-sev-badge" style="background:' + lv.color + ';color:#fff" ' +
          'title="' + esc(name) + ': ' + c + '">' + esc(name) + ' ' + c + '</span>';
      }
      return '<span class="zbxm-sev-badge off" style="border-color:' + lv.color + '99;color:' + lv.color + '">' +
        esc(name) + ' 0</span>';
    }).join('');
    return '<span class="zbxm-sev-group" title="' +
      esc(t('webui.zbxm_sev_tip', '活动问题按严重级别统计（自低到高）')) + '">' + badges + '</span>';
  }

  function renderDashboard(data) {
    var body = $('zbxm-body');
    if (!body) return;
    var host = data.host || {};
    var s = data.summary || {};
    var problems = data.problems || [];

    var osBadge = host.os === 'windows'
      ? '<span class="badge" style="background:#2ea44f;color:#fff">Windows</span>'
      : '<span class="badge" style="background:#1f6feb;color:#fff">Linux</span>';

    var cards = [
      { label: t('webui.zbxm_cpu', 'CPU 使用率'), value: fmtNum(s.cpu, 1) + '%', color: '#1f6feb' },
      { label: t('webui.zbxm_memory', '内存使用率'), value: fmtNum(s.memory, 1) + '%', color: '#2ea44f' },
      { label: t('webui.zbxm_disk', '磁盘使用率'), value: fmtNum(s.disk, 1) + '%', color: '#e97659' },
      { label: t('webui.zbxm_load', '系统负载'), value: fmtNum(s.load, 2), color: '#ffc859' },
      { label: t('webui.zbxm_net_in', '入网流量'), value: fmtBps(s.net_in), color: '#7499ff' },
      { label: t('webui.zbxm_net_out', '出网流量'), value: fmtBps(s.net_out), color: '#9b59b6' }
    ];

    var diskDetail = '';
    if (s.disk_items && s.disk_items.length) {
      diskDetail = '<div class="zbxm-disk-detail">' + s.disk_items.map(function (d) {
        return '<span>' + esc(d.name) + ': <b>' + fmtNum(d.lastvalue, 1) + '%</b></span>';
      }).join('') + '</div>';
    }

    var problemHtml = problems.length
      ? problems.map(function (p) {
          return '<div class="zbxm-problem-item">' +
            '<span class="badge" style="background:' + esc(p.severity_color || sevColor(p.priority)) +
              ';color:#fff;flex-shrink:0">' + esc(p.severity_name || '') + '</span>' +
            '<span class="zbxm-problem-desc">' + esc(p.description) + '</span>' +
            '<span class="zbxm-problem-time">' + fmtTime(p.lastchange) + '</span>' +
            '</div>';
        }).join('')
      : '<div class="zbxm-no-problems">' + esc(t('webui.zbxm_no_problems', '当前无活动问题 🎉')) + '</div>';

    body.innerHTML =
      '<div class="zbxm-head">' +
        '<h3>' + esc(host.name || host.host || '') + '</h3>' +
        '<span class="zbxm-head-ip">' + esc(host.ip || '') + '</span>' +
        osBadge + statusBadge(host) + severityBadges(problems) +
        '<span style="flex:1"></span>' +
        '<span class="zbxm-source">' + esc(t('webui.zbxm_source', '数据来源')) + ': Zabbix</span>' +
        '<button class="btn btn-ghost" onclick="FusionZabbixMonitor.refresh()">🔄 ' +
          esc(t('webui.zbxm_refresh', '刷新')) + '</button>' +
      '</div>' +
      '<div class="zbxm-cards">' + cards.map(function (c) {
        return '<div class="zbxm-card"><div class="zbxm-card-label">' + esc(c.label) + '</div>' +
          '<div class="zbxm-card-value" style="color:' + c.color + '">' + esc(c.value) + '</div></div>';
      }).join('') + '</div>' +
      diskDetail +
      '<h4 class="zbxm-problems-title">' + esc(t('webui.zbxm_problems', '活动问题')) + '</h4>' +
      problemHtml;
  }

  window.FusionZabbixMonitor = {
    load: load,
    refresh: refresh,
    onSearch: onSearch,
    selectServer: selectServer,
    showAdd: showAdd,
    closeAdd: closeAdd,
    doAdd: doAdd,
    showEdit: showEdit,
    closeEdit: closeEdit,
    doEdit: doEdit,
    deleteServer: deleteServer
  };
})();