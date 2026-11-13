/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * Fusion page logic: Zabbix 监控设置。
 * 全局连接配置（地址 / API Token / 备选用户名密码）+ 主机取数自查。
 * 巡检向导第 3 步「系统资源采集」与定时任务的 Zabbix 分支都复用这份配置。
 */
(function () {
  'use strict';

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

  function val(id) { var el = $(id); return el ? String(el.value || '').trim() : ''; }

  function setVal(id, v) { var el = $(id); if (el) el.value = (v == null ? '' : v); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function say(text, ok) {
    var el = $('zbx-conn-result');
    if (!el) return;
    el.innerHTML = '<div class="status-banner ' + (ok ? 'ok' : 'err') + '">' + esc(text) + '</div>';
  }

  function setConfigured(on) {
    var el = $('zbx-status');
    if (!el) return;
    el.textContent = on ? t('webui.zabbix_status_configured', '已配置')
                        : t('webui.zabbix_status_unconfigured', '未配置');
    el.style.color = on ? 'var(--success, #00C8A0)' : 'var(--text-muted)';
  }

  function payload() {
    return {
      zabbix: {
        url: val('zbx-url'),
        api_token: val('zbx-token'),
        username: val('zbx-username'),
        password: val('zbx-password'),
        verify_ssl: ($('zbx-verify-ssl') || {}).value !== '0'
      }
    };
  }

  async function load() {
    try {
      var res = await fetch('/api/zabbix/config', { credentials: 'same-origin' });
      var data = await res.json();
      if (!data.ok) { setConfigured(false); say(data.error || t('webui.zabbix_load_fail', '读取 Zabbix 配置失败'), false); return; }
      var z = (data.data || {}).zabbix || {};
      setVal('zbx-url', z.url);
      // 回显的是 *** 占位符：原样提交回去表示「沿用已保存值」，后端不会覆盖真实凭据
      setVal('zbx-token', z.api_token);
      setVal('zbx-username', z.username);
      setVal('zbx-password', z.password);
      var sel = $('zbx-verify-ssl');
      if (sel) sel.value = (z.verify_ssl === false ? '0' : '1');
      setConfigured(!!data.configured);
    } catch (e) {
      setConfigured(false);
      say(t('webui.zabbix_load_fail', '读取 Zabbix 配置失败') + ': ' + e.message, false);
    }
  }

  async function save() {
    var body = payload();
    if (body.zabbix.url && !/^https?:\/\//i.test(body.zabbix.url)) {
      say(t('webui.zabbix_url_invalid', 'Zabbix 地址需以 http:// 或 https:// 开头'), false);
      return;
    }
    var btn = $('zbx-btn-save');
    if (btn) btn.disabled = true;
    try {
      var res = await fetch('/api/zabbix/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body)
      });
      var data = await res.json();
      if (data.ok) { say(t('webui.zabbix_saved', 'Zabbix 配置已保存'), true); await load(); }
      else { say(data.error || data.message || t('webui.zabbix_save_fail', '保存失败'), false); }
    } catch (e) {
      say(t('webui.zabbix_save_fail', '保存失败') + ': ' + e.message, false);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function testConnection() {
    var btn = $('zbx-btn-test');
    if (btn) btn.disabled = true;
    say(t('webui.zabbix_testing', '正在连接 Zabbix...'), true);
    try {
      var res = await fetch('/api/zabbix/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload().zabbix)
      });
      var data = await res.json();
      if (data.ok) {
        var d = data.data || {};
        say(t('webui.zabbix_test_ok', '连接成功') + ' · Zabbix ' + (d.version || '?') +
            ' · ' + (d.auth || ''), true);
      } else {
        say(t('webui.zabbix_test_fail', '连接失败') + ': ' + (data.error || ''), false);
      }
    } catch (e) {
      say(t('webui.zabbix_test_fail', '连接失败') + ': ' + e.message, false);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function probeHost() {
    var ip = val('zbx-probe-ip');
    var name = val('zbx-probe-name');
    var el = $('zbx-probe-result');
    if (!el) return;
    if (!ip && !name) {
      el.innerHTML = '<div class="status-banner err">' +
        esc(t('webui.zabbix_probe_need_host', '请先填写主机 IP 或 Zabbix 主机名')) + '</div>';
      return;
    }
    el.innerHTML = '<div class="status-banner info"><span class="spinner"></span> ' +
      esc(t('webui.zabbix_probing', '正在从 Zabbix 读取主机数据...')) + '</div>';
    try {
      var qs = 'host_ip=' + encodeURIComponent(ip) + '&hostname=' + encodeURIComponent(name);
      var res = await fetch('/api/zabbix/sysinfo-test?' + qs, { credentials: 'same-origin' });
      var data = await res.json();
      if (!data.ok) {
        el.innerHTML = '<div class="status-banner err">' +
          esc(t('webui.zabbix_probe_fail', '采集失败') + ': ' + (data.error || '')) + '</div>';
        return;
      }
      var d = data.data || {};
      var memDetail = d.memory_detail || {};
      var rows = [
        [t('webui.zabbix_col_host', '主机'), d.name || '-'],
        [t('webui.zabbix_col_os', '操作系统'), (d.os_text || '') +
          (d.os ? ' (' + d.os + ')' : '')],
        [t('webui.zabbix_col_cpu', 'CPU 使用率'), (d.cpu == null ? '-' : d.cpu + '%') +
          (d.cpu_count ? ' · ' + d.cpu_count + ' 核' : '')],
        [t('webui.zabbix_col_mem', '内存'),
          (memDetail.total_mb ? Math.round(memDetail.total_mb / 1024) + ' GB' : '-') +
          (d.memory != null ? ' · ' + t('webui.zabbix_used', '已用') + ' ' + d.memory + '%' : '')],
        [t('webui.zabbix_col_disk', '磁盘'), (d.disk_count || 0) + ' ' +
          t('webui.zabbix_col_disk_units', '个挂载点') +
          (d.disk_max != null ? ' · 最高 ' + d.disk_max + '%' : '')],
        [t('webui.zabbix_col_boot', '启动时间'), d.boot_time || '-']
      ];
      el.innerHTML = '<div class="status-banner ok">' +
        esc(t('webui.zabbix_probe_ok', '采集成功，巡检可直接使用该主机')) + '</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;margin-top:10px">' +
        rows.map(function (r) {
          return '<div style="padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:8px">' +
            '<div style="font-size:11px;color:var(--text-muted)">' + esc(r[0]) + '</div>' +
            '<div style="font-size:13px;font-weight:600;margin-top:2px">' + esc(r[1]) + '</div></div>';
        }).join('') + '</div>';
    } catch (e) {
      el.innerHTML = '<div class="status-banner err">' +
        esc(t('webui.zabbix_probe_fail', '采集失败') + ': ' + e.message) + '</div>';
    }
  }

  window.FusionZabbix = {
    load: load,
    save: save,
    testConnection: testConnection,
    probeHost: probeHost
  };
})();
