/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * Fusion page script: 服务器巡检（SSH 配置表 / 执行步骤条 / 命令日志 / 结果与 AI 报告）
 * 与服务器巡检历史（状态卡筛选 / 主机卡片 / 详情模态）。
 * Attribution: 交互流程与布局设计归 MIT License,
 * Copyright (c) 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com> 所有，
 * 按 RaccoonX 的模块结构（IIFE + window.FusionServerInspect）实现。
 *
 * 依赖全局：escHtml / toast / toastSuccess / toastError / toastConfirm /
 *          showConfirmDialog / showShareLinkDialog / showPage。
 * renderMarkdown 只在本模块内使用，不覆盖全局同名函数（AI 助手另有一套实现）。
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function toastInfo(msg) { return toast(msg, 'info'); }

  // ─── 服务器巡检：状态 ──────────────────────────────
  let _si_task_id = null;
  let _si_report_file = '';
  let _si_profiles = [];             // SSH 快捷配置缓存
  let _si_editing_profile_id = null; // 当前编辑的配置 ID
  let _si_ai_enabled = false;        // 当前任务是否开启 AI 分析
  let _si_history_id = null;         // 任务完成后对应的巡检历史记录 ID

  // 巡检步骤定义（系统固定流程，不可调整/增删）
  const SI_STEPS = [
    {name: 'SSH 连接', icon: '🔗', desc: '建立 SSH 连接到目标服务器', keywords: ['SSH', '连接', '本机']},
    {name: 'CPU 信息采集', icon: '🔲', desc: '采集 CPU 使用率、核心数、频率、负载等', keywords: ['CPU', 'cpu']},
    {name: '内存信息采集', icon: '💾', desc: '采集内存总量、已用、可用、Swap 等', keywords: ['内存', 'Mem', 'memory', 'Swap']},
    {name: '磁盘信息采集', icon: '💿', desc: '采集磁盘挂载、使用率、Inode 等', keywords: ['磁盘', 'disk', 'df', 'inode']},
    {name: '进程与系统信息', icon: '⚙️', desc: '采集 Top 进程、主机名、内核、启动时间等', keywords: ['进程', 'process', 'hostname', 'uname', 'uptime', '僵尸']},
    {name: '网络与服务检测', icon: '🌐', desc: '网络连通性检测、服务状态检查', keywords: ['Ping', 'DNS', '网络', '服务', 'service', 'network']},
    {name: '健康评分与报告', icon: '📊', desc: '计算健康评分、生成巡检报告', keywords: ['健康评分', '报告', 'health', 'report', '采集命令清单']},
  ];

  // AI 分析步骤（勾选「AI 分析结果」时追加到最后）
  const SI_AI_STEP = {name: 'AI 智能分析', icon: '🤖', desc: '基于巡检数据生成根因分析与优化建议报告', keywords: ['AI 分析', 'AI 分析报告']};

  function getSiSteps() {
    const steps = SI_STEPS.slice();
    if (_si_ai_enabled) steps.push(SI_AI_STEP);
    return steps;
  }

  // 动态渲染巡检步骤（只读进度展示，无增删改/排序入口）
  function renderSiSteps() {
    const list = $('si-step-list');
    if (!list) return;
    list.innerHTML = getSiSteps().map((s, i) =>
      '<div class="si-step-item">' +
        '<div class="si-step-header">' +
          '<span class="si-step-icon">' + s.icon + '</span>' +
          '<div class="si-step-info">' +
            '<div class="si-step-name">' + escHtml(s.name) + '</div>' +
            '<div class="si-step-desc">' + escHtml(s.desc) + '</div>' +
          '</div>' +
          '<span class="si-step-status pending" id="si-step-' + i + '-status">待执行</span>' +
        '</div>' +
      '</div>'
    ).join('');
  }

  function toggleSiAuth() {
    const authEl = $('si-ssh-auth');
    if (!authEl) return;
    const auth = authEl.value;
    const pwd = $('si-pwd-wrap');
    const key = $('si-key-wrap');
    if (pwd) pwd.style.display = auth === 'password' ? '' : 'none';
    if (key) key.style.display = auth === 'key' ? '' : 'none';
  }

  async function testServerSSH() {
    const host = ($('si-ssh-host').value || '').trim();
    if (!host) { toastError('请输入 SSH 主机地址'); return; }
    const statusEl = $('si-ssh-test-status');
    statusEl.textContent = '⏳ 测试中...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const res = await fetch('/api/test_server_ssh', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ssh_host: host,
          ssh_port: parseInt($('si-ssh-port').value) || 22,
          ssh_user: ($('si-ssh-user').value || '').trim() || 'root',
          ssh_password: $('si-ssh-password').value || '',
          ssh_key_file: ($('si-ssh-key').value || '').trim() || '',
          ssh_key_password: $('si-ssh-key-password') ? ($('si-ssh-key-password').value || '') : '',
        })
      });
      const data = await res.json();
      if (data.ok) {
        statusEl.textContent = '✅ ' + (data.msg || 'SSH 连接成功');
        statusEl.style.color = 'var(--success)';
      } else {
        statusEl.textContent = '❌ ' + (data.msg || 'SSH 连接失败');
        statusEl.style.color = 'var(--danger)';
      }
    } catch (e) {
      statusEl.textContent = '❌ 请求失败: ' + e.message;
      statusEl.style.color = 'var(--danger)';
    }
  }

  // ── 服务器列表表格渲染 ──
  function renderServerTable() {
    const tbody = $('si-server-tbody');
    if (!tbody) return;
    const searchEl = $('si-search-input');
    const search = ((searchEl && searchEl.value) || '').trim().toLowerCase();

    let filtered = _si_profiles;
    if (search) {
      filtered = _si_profiles.filter(p =>
        (p.name || '').toLowerCase().includes(search) ||
        (p.ssh_host || '').toLowerCase().includes(search) ||
        (p.ssh_user || '').toLowerCase().includes(search)
      );
    }

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="padding:40px;text-align:center;color:var(--text-muted);">' +
        (_si_profiles.length === 0 ? '暂无服务器配置，点击「新建服务器」添加' : '未找到匹配的服务器') +
        '</td></tr>';
      return;
    }

    tbody.innerHTML = filtered.map(p => {
      const authBadge = p.ssh_auth === 'key'
        ? '<span class="si-server-auth-badge key">🔑 私钥</span>'
        : '<span class="si-server-auth-badge pwd">🔐 密码</span>';
      return '<tr>' +
        '<td class="si-server-name-cell">' + escHtml(p.name) + '</td>' +
        '<td class="si-server-host-cell">' + escHtml(p.ssh_host || '-') + '</td>' +
        '<td>' + (p.ssh_port || 22) + '</td>' +
        '<td>' + escHtml(p.ssh_user || 'root') + '</td>' +
        '<td>' + authBadge + '</td>' +
        '<td style="font-size:12px;color:var(--text-muted);">' + escHtml(p.updated_at || '-') + '</td>' +
        '<td>' +
          '<div class="si-server-actions">' +
            '<button class="si-act-btn run" onclick="startInspectFromProfile(\'' + p.id + '\')" title="开始巡检">🚀 巡检</button>' +
            '<button class="si-act-btn" onclick="editSiProfile(\'' + p.id + '\')" title="编辑">✏️ 编辑</button>' +
            '<button class="si-act-btn" onclick="viewSiLog(\'' + p.id + '\')" title="巡检日志">📋 日志</button>' +
            '<button class="si-act-btn" onclick="viewSiResult(\'' + p.id + '\')" title="巡检结果">📊 结果</button>' +
            '<button class="si-act-btn del" onclick="deleteSiProfile(\'' + p.id + '\',\'' + escHtml(p.name) + '\')" title="删除">🗑️ 删除</button>' +
          '</div>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  // ── 配置弹窗 ──
  function showSiConfigModal() {
    _si_editing_profile_id = null;
    $('si-config-modal-icon').textContent = '➕';
    $('si-config-modal-title-text').textContent = '新建服务器配置';
    $('si-profile-name-input').value = '';
    $('si-ssh-host').value = '';
    $('si-ssh-port').value = '22';
    $('si-ssh-user').value = 'root';
    $('si-ssh-auth').value = 'password';
    $('si-ssh-password').value = '';
    $('si-ssh-key').value = '';
    if ($('si-ssh-key-password')) $('si-ssh-key-password').value = '';
    $('si-ssh-test-status').textContent = '';
    $('si-ai-analyze').checked = false;
    toggleSiAuth();
    $('si-config-modal').style.display = 'flex';
  }

  function closeSiConfigModal() {
    const modal = $('si-config-modal');
    if (modal) modal.style.display = 'none';
    _si_editing_profile_id = null;
  }

  async function editSiProfile(profileId) {
    try {
      const res = await fetch('/api/server_ssh_profiles/' + profileId + '/decrypt');
      const data = await res.json();
      if (!data.ok || !data.profile) { toastError(data.error || '获取配置失败'); return; }
      const p = data.profile;

      _si_editing_profile_id = profileId;
      $('si-config-modal-icon').textContent = '✏️';
      $('si-config-modal-title-text').textContent = '编辑服务器配置';
      $('si-profile-name-input').value = p.name || '';
      $('si-ssh-host').value = p.ssh_host || '';
      $('si-ssh-port').value = p.ssh_port || 22;
      $('si-ssh-user').value = p.ssh_user || 'root';
      $('si-ssh-auth').value = p.ssh_auth || 'password';
      $('si-ssh-password').value = p.ssh_password || '';
      $('si-ssh-key').value = p.ssh_key_file || '';
      if ($('si-ssh-key-password')) $('si-ssh-key-password').value = p.ssh_key_password || '';
      $('si-ssh-test-status').textContent = '';
      $('si-ai-analyze').checked = !!(p.ai_analyze);
      toggleSiAuth();

      $('si-config-modal').style.display = 'flex';
    } catch (e) {
      toastError('加载配置失败: ' + e.message);
    }
  }

  async function confirmSaveSiConfig() {
    const name = ($('si-profile-name-input').value || '').trim();
    if (!name) { toastError('请填写配置名称'); return; }

    const payload = {
      name: name,
      ssh_host: ($('si-ssh-host').value || '').trim(),
      ssh_port: parseInt($('si-ssh-port').value) || 22,
      ssh_user: ($('si-ssh-user').value || '').trim() || 'root',
      ssh_auth: $('si-ssh-auth').value,
      ssh_password: $('si-ssh-password').value || '',
      ssh_key_file: ($('si-ssh-key').value || '').trim() || '',
      ssh_key_password: $('si-ssh-key-password') ? ($('si-ssh-key-password').value || '') : '',
      ai_analyze: $('si-ai-analyze').checked ? 1 : 0,
    };

    if (!payload.ssh_host) {
      toastError('SSH 主机地址不能为空');
      return;
    }

    if (_si_editing_profile_id) {
      payload.id = _si_editing_profile_id;
    }

    try {
      const res = await fetch('/api/server_ssh_profiles', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.ok) {
        toastSuccess(data.msg || '配置已保存');
        closeSiConfigModal();
        await loadServerSSHProfiles();
      } else {
        toastError(data.error || '保存失败');
      }
    } catch (e) {
      toastError('请求失败: ' + e.message);
    }
  }

  async function deleteSiProfile(profileId, profileName) {
    if (!await toastConfirm('确定要删除服务器配置「' + profileName + '」吗？')) return;
    try {
      const res = await fetch('/api/server_ssh_profiles/' + profileId, {method: 'DELETE'});
      const data = await res.json();
      if (data.ok) {
        toastSuccess(data.msg || '配置已删除');
        await loadServerSSHProfiles();
      } else {
        toastError(data.error || '删除失败');
      }
    } catch (e) {
      toastError('请求失败: ' + e.message);
    }
  }

  // ── 巡检日志查看（左右两栏：最近记录 + 详细命令） ──
  async function viewSiLog(profileId) {
    const profile = _si_profiles.find(p => p.id === profileId);
    if (!profile) return;
    try {
      const res = await fetch('/api/server_inspect_history?limit=100');
      const data = await res.json();
      if (!data.ok) return;
      const history = (data.history || []).filter(h =>
        (h.host || '') === (profile.ssh_host || '')
      );
      if (history.length === 0) {
        toastInfo('该服务器暂无巡检日志');
        return;
      }
      // 最近 10 次巡检记录
      const recent = history.slice(0, 10);
      $('si-log-modal-title').textContent = '巡检日志 - ' + profile.name;
      $('si-log-modal').style.display = 'flex';
      renderSiLogRecords(recent);
      loadSiLogDetail(recent[0].id);
    } catch (e) {
      toastError('加载日志失败: ' + e.message);
    }
  }

  // 渲染左栏：最近巡检记录列表
  function renderSiLogRecords(records) {
    const el = $('si-log-records');
    el.innerHTML = records.map((r, idx) =>
      '<div class="si-log-record-item' + (idx === 0 ? ' active' : '') + '" data-id="' + r.id + '" onclick="selectSiLogRecord(this, ' + r.id + ')">' +
        '<div class="si-log-record-time">' + escHtml(r.inspect_time || '-') + '</div>' +
        '<div class="si-log-record-meta">' +
          '<span class="si-log-record-score">' + (r.health_score || 0) + ' 分</span>' +
          (r.issues_count > 0 ? '<span class="si-log-record-issues">⚠️ ' + r.issues_count + ' 个问题</span>' : '') +
        '</div>' +
      '</div>'
    ).join('');
  }

  // 左栏选中某条记录
  function selectSiLogRecord(el, id) {
    document.querySelectorAll('#si-log-records .si-log-record-item').forEach(i => i.classList.remove('active'));
    el.classList.add('active');
    loadSiLogDetail(id);
  }

  // 加载右栏：选中记录的详细执行命令
  async function loadSiLogDetail(recordId) {
    const summaryEl = $('si-log-summary');
    const listEl = $('si-log-list');
    summaryEl.innerHTML = '';
    listEl.innerHTML = '<div class="si-log-empty">加载中...</div>';
    try {
      const detailRes = await fetch('/api/server_inspect_history/' + recordId);
      const detailData = await detailRes.json();
      if (detailData.ok && detailData.record) {
        const rec = detailData.record;
        const result = typeof rec.result_json === 'string' ? JSON.parse(rec.result_json) : (rec.result_json || rec.result || {});
        summaryEl.innerHTML =
          '<div class="si-log-summary-item">🕐 巡检时间: <b>' + escHtml(rec.inspect_time || '-') + '</b></div>' +
          '<div class="si-log-summary-item">📊 健康评分: <b>' + (rec.health_score || 0) + ' 分</b></div>' +
          '<div class="si-log-summary-item">🖥️ 主机名: <b>' + escHtml(rec.hostname || rec.host || '-') + '</b></div>' +
          (rec.issues_count > 0 ? '<div class="si-log-summary-item">⚠️ 发现问题: <b>' + rec.issues_count + ' 个</b></div>' : '');
        const cmdLog = result.command_log || [];
        if (cmdLog.length === 0) {
          listEl.innerHTML = '<div class="si-log-empty">暂无采集命令日志</div>';
        } else {
          listEl.innerHTML = cmdLog.map(entry => {
            const stepName = entry.step || '';
            const cmdText = entry.command || '';
            return '<div class="si-log-item">' +
              '<span class="si-log-item-step">' + escHtml(stepName) + '</span>' +
              '<span class="si-log-item-cmd">$ ' + escHtml(cmdText) + '</span>' +
            '</div>';
          }).join('');
        }
      } else {
        summaryEl.innerHTML = '';
        listEl.innerHTML = '<div class="si-log-empty">未找到该巡检记录</div>';
      }
    } catch (e) {
      listEl.innerHTML = '<div class="si-log-empty">加载失败: ' + escHtml(e.message) + '</div>';
    }
  }

  function closeSiLogModal() {
    const modal = $('si-log-modal');
    if (modal) modal.style.display = 'none';
  }

  // ── 巡检结果查看：跳转到历史页并按该主机筛选 ──
  function viewSiResult(profileId) {
    const profile = _si_profiles.find(p => p.id === profileId);
    if (!profile) return;
    const host = profile.ssh_host || 'localhost';
    _shSearchQuery = host.toLowerCase();
    _shOsType = '';
    _shStatus = '';
    _shHasIssues = false;
    _shDateFrom = '';
    _shDateTo = '';
    const input = $('sh-search-input');
    if (input) input.value = host;
    const osSel = $('sh-os-filter');
    if (osSel) osSel.value = '';
    const df = $('sh-date-from');
    if (df) df.value = '';
    const dt = $('sh-date-to');
    if (dt) dt.value = '';
    document.querySelectorAll('.sh-date-wrap').forEach(w => w.classList.remove('has-value'));
    showPage('server-history');
  }

  // ── 开始巡检（远程：按快捷配置解密后启动） ──
  async function startInspectFromProfile(profileId) {
    const profile = _si_profiles.find(p => p.id === profileId);
    if (!profile) { toastError('未找到服务器配置'); return; }

    let sshInfo = {host_type: 'remote'};
    try {
      const res = await fetch('/api/server_ssh_profiles/' + profileId + '/decrypt');
      const data = await res.json();
      if (!data.ok || !data.profile) { toastError(data.error || '获取配置失败'); return; }
      const p = data.profile;
      sshInfo = {
        host_type: 'remote',
        ssh_host: p.ssh_host,
        ssh_port: p.ssh_port || 22,
        ssh_user: p.ssh_user || 'root',
        ssh_password: p.ssh_password || '',
        ssh_key_file: p.ssh_key_file || '',
        ssh_key_password: p.ssh_key_password || '',
        ai_analyze: p.ai_analyze ? 1 : 0,
      };
    } catch (e) {
      toastError('获取配置失败: ' + e.message);
      return;
    }

    await runServerInspect(sshInfo, '巡检中 - ' + profile.name);
  }

  // ── 开始巡检（本机：无需 SSH，直接采集运行本服务的主机） ──
  async function startLocalInspect() {
    await runServerInspect({host_type: 'local', ai_analyze: 0}, '本机巡检');
  }

  // 启动任务并接管执行弹窗（远程 / 本机共用步骤条与轮询）
  async function runServerInspect(sshInfo, title) {
    _si_ai_enabled = !!(sshInfo.ai_analyze);
    _si_history_id = null;
    showSiRunModal(title);
    renderSiSteps();
    resetSiSteps();
    $('si-run-result').style.display = 'none';
    $('si-btn-download').style.display = 'none';
    $('si-btn-html').style.display = 'none';
    $('si-btn-ai-report').style.display = 'none';
    $('si-btn-share').style.display = 'none';

    updateSiStepStatus(0, 'running');

    try {
      const res = await fetch('/api/server_inspect', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(sshInfo)
      });
      const data = await res.json();
      if (!data.ok) {
        toastError(data.msg || '启动失败');
        updateSiStepStatus(0, 'error');
        return;
      }
      _si_task_id = data.task_id;
      _si_report_file = '';
      pollServerInspect();
    } catch (e) {
      toastError('请求失败: ' + e.message);
      updateSiStepStatus(0, 'error');
    }
  }

  function showSiRunModal(title) {
    $('si-run-modal-title').textContent = title || '服务器巡检';
    $('si-run-modal').style.display = 'flex';
  }

  function closeSiRunModal() {
    const modal = $('si-run-modal');
    if (modal) modal.style.display = 'none';
    _si_task_id = null;
    _si_history_id = null;
    const aiBtn = $('si-btn-ai-report');
    if (aiBtn) aiBtn.style.display = 'none';
    const shareBtn = $('si-btn-share');
    if (shareBtn) shareBtn.style.display = 'none';
  }

  function resetSiSteps() {
    const steps = getSiSteps();
    for (let i = 0; i < steps.length; i++) {
      updateSiStepStatus(i, 'pending');
    }
  }

  function updateSiStepStatus(stepIdx, status) {
    const el = $('si-step-' + stepIdx + '-status');
    if (!el) return;
    el.className = 'si-step-status ' + status;
    const labels = {pending: '待执行', running: '执行中', done: '已完成', error: '失败'};
    el.textContent = labels[status] || status;
  }

  // 根据日志内容推断当前步骤
  function inferStepFromLog(logMsg) {
    const msg = String(logMsg || '').toLowerCase();
    const steps = getSiSteps();
    for (let i = 0; i < steps.length; i++) {
      for (const kw of steps[i].keywords) {
        if (msg.includes(kw.toLowerCase())) return i;
      }
    }
    return -1;
  }

  async function pollServerInspect() {
    if (!_si_task_id) return;
    let lastLen = 0;

    const poll = async () => {
      try {
        const res = await fetch('/api/task_status/' + _si_task_id);
        const data = await res.json();
        const logs = data.log || [];
        if (logs.length > lastLen) {
          for (let i = lastLen; i < logs.length; i++) {
            // 弹框只展示步骤状态，不展示原始日志
            const stepIdx = inferStepFromLog(logs[i]);
            if (stepIdx >= 0) {
              for (let s = 0; s < stepIdx; s++) {
                const sEl = $('si-step-' + s + '-status');
                if (sEl && sEl.classList.contains('pending')) updateSiStepStatus(s, 'done');
              }
              const curEl = $('si-step-' + stepIdx + '-status');
              if (curEl && curEl.classList.contains('pending')) updateSiStepStatus(stepIdx, 'running');
            }
          }
          lastLen = logs.length;
        }
        if (data.status === 'done' || data.status === 'error') {
          const steps = getSiSteps();
          for (let i = 0; i < steps.length; i++) {
            const el = $('si-step-' + i + '-status');
            if (el && (el.classList.contains('pending') || el.classList.contains('running'))) {
              updateSiStepStatus(i, data.status === 'done' ? 'done' : 'error');
            }
          }
          if (data.result && data.status === 'done') {
            renderSiRunSummary(data.result);
          }
          if (data.report_file) {
            _si_report_file = data.report_file;
            $('si-btn-download').style.display = '';
            $('si-btn-html').style.display = '';
          }
          if (data.history_id) {
            _si_history_id = data.history_id;
          }
          const aiBtn = $('si-btn-ai-report');
          if (aiBtn) {
            aiBtn.style.display = (data.status === 'done' && data.result && data.result.ai_report && _si_history_id) ? '' : 'none';
          }
          // 刷新统计与历史（新记录已落库）
          loadSiHistoryStats();
          return;
        }
        setTimeout(poll, 1500);
      } catch (e) {
        setTimeout(poll, 3000);
      }
    };
    poll();
  }

  // 巡检完成后显示精简结果摘要（完整结果通过历史页「详情」查看）
  function renderSiRunSummary(r) {
    const el = $('si-run-result');
    el.style.display = '';
    const score = r.health_score || 0;
    const status = r.health_status || '';
    let color = 'var(--success)';
    if (score < 60) color = 'var(--danger)';
    else if (score < 75) color = 'var(--warn)';
    else if (score < 90) color = 'var(--accent2)';
    const issues = r.issues || [];
    el.innerHTML =
      '<div class="si-result-summary">' +
        '<div class="si-result-score" style="color:' + color + '">' + score + '</div>' +
        '<div class="si-result-status" style="color:' + color + '">' + escHtml(status) + '</div>' +
        '<div class="si-result-meta">发现问题 ' + issues.length + ' 个 · 主机 ' + escHtml(r.hostname || r.host || '-') + '</div>' +
      '</div>';
    window._si_last_result = r;
    const shareBtn = $('si-btn-share');
    if (shareBtn) shareBtn.style.display = '';
  }

  // 完整结果渲染（CPU / 内存 / 磁盘 / Top 进程 / 系统信息 / 问题清单）
  function renderSiRunResult(r) {
    const el = $('si-run-result');
    el.style.display = '';

    const score = r.health_score || 0;
    const status = r.health_status || '';
    let color = 'var(--success)';
    if (score < 60) color = 'var(--danger)';
    else if (score < 75) color = 'var(--warn)';
    else if (score < 90) color = 'var(--accent2)';

    const cpu = r.cpu || {};
    const mem = r.memory || {};
    const disks = r.disk || [];
    const procs = r.top_processes || [];

    let diskHtml = '<span style="color:var(--text-muted)">未采集到磁盘信息</span>';
    if (disks.length > 0) {
      diskHtml = '<table style="width:100%;border-collapse:collapse;font-size:12px"><tr style="border-bottom:1px solid var(--border)"><th style="text-align:left;padding:4px 8px">挂载点</th><th>设备</th><th>总量</th><th>已用</th><th>使用率</th></tr>';
      disks.forEach(d => {
        const pctColor = d.usage_percent > 90 ? 'var(--danger)' : (d.usage_percent > 80 ? 'var(--warn)' : 'var(--text)');
        diskHtml += '<tr style="border-bottom:1px solid var(--border)"><td style="padding:4px 8px">' + escHtml(d.mountpoint) + '</td><td style="text-align:center">' + escHtml(d.device) + '</td><td style="text-align:center">' + (d.total_gb || 0).toFixed(1) + ' GB</td><td style="text-align:center">' + (d.used_gb || 0).toFixed(1) + ' GB</td><td style="text-align:center;color:' + pctColor + ';font-weight:600">' + (d.usage_percent || 0).toFixed(1) + '%</td></tr>';
      });
      diskHtml += '</table>';
    }

    let procHtml = '<span style="color:var(--text-muted)">未采集到进程信息</span>';
    if (procs.length > 0) {
      procHtml = '<table style="width:100%;border-collapse:collapse;font-size:12px"><tr style="border-bottom:1px solid var(--border)"><th style="text-align:left;padding:4px 8px">PID</th><th>用户</th><th>CPU%</th><th>内存%</th><th style="text-align:left">命令</th></tr>';
      procs.forEach(p => {
        procHtml += '<tr style="border-bottom:1px solid var(--border)"><td style="padding:4px 8px">' + p.pid + '</td><td style="text-align:center">' + escHtml(p.user) + '</td><td style="text-align:center">' + (p.cpu || 0).toFixed(1) + '</td><td style="text-align:center">' + (p.mem || 0).toFixed(1) + '</td><td style="text-align:left;font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(p.command) + '</td></tr>';
      });
      procHtml += '</table>';
    }

    const issues = r.issues || [];
    let issuesHtml = '';
    if (issues.length > 0) {
      issuesHtml = '<div style="margin-top:12px;"><div style="font-weight:600;margin-bottom:8px;">⚠️ 发现的问题 (' + issues.length + ')</div>' +
        issues.map(i => '<div style="padding:6px 10px;margin-bottom:4px;background:var(--danger-soft);border-left:3px solid var(--danger);border-radius:4px;font-size:12px;">' + (typeof i === 'string' ? escHtml(i) : escHtml(i.description || i.msg || JSON.stringify(i))) + '</div>').join('') + '</div>';
    }

    el.innerHTML =
      '<div style="font-weight:600;font-size:14px;margin-bottom:10px;">📊 巡检结果</div>' +
      '<div style="text-align:center;padding:16px;margin-bottom:12px;background:var(--surface2);border-radius:10px;">' +
        '<div style="font-size:42px;font-weight:700;color:' + color + '">' + score + '</div>' +
        '<div style="font-size:14px;color:' + color + ';margin-top:4px">' + escHtml(status) + '</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
        '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px;">' +
          '<div style="font-weight:600;margin-bottom:8px;">🔲 CPU</div>' +
          '<div style="font-size:12px;line-height:1.7;">使用率: <b>' + (cpu.usage_percent || 0).toFixed(1) + '%</b><br/>核心: ' + (cpu.physical_cores || '-') + 'P / ' + (cpu.logical_cores || '-') + 'L<br/>负载: ' + (cpu.load_1m || 0).toFixed(2) + ' / ' + (cpu.load_5m || 0).toFixed(2) + ' / ' + (cpu.load_15m || 0).toFixed(2) + '</div>' +
        '</div>' +
        '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px;">' +
          '<div style="font-weight:600;margin-bottom:8px;">💾 内存</div>' +
          '<div style="font-size:12px;line-height:1.7;">总量: <b>' + (mem.total_gb || 0).toFixed(2) + ' GB</b><br/>已用: ' + (mem.used_gb || 0).toFixed(2) + ' GB (' + (mem.usage_percent || 0).toFixed(1) + '%)<br/>Swap: ' + (mem.swap_used_gb || 0).toFixed(2) + ' / ' + (mem.swap_total_gb || 0).toFixed(2) + ' GB</div>' +
        '</div>' +
      '</div>' +
      '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:10px;">' +
        '<div style="font-weight:600;margin-bottom:8px;">💿 磁盘</div>' +
        '<div style="overflow-x:auto;">' + diskHtml + '</div>' +
      '</div>' +
      '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:10px;">' +
        '<div style="font-weight:600;margin-bottom:8px;">⚙️ Top 进程</div>' +
        '<div style="overflow-x:auto;">' + procHtml + '</div>' +
      '</div>' +
      '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:10px;">' +
        '<div style="font-weight:600;margin-bottom:8px;">ℹ️ 系统信息</div>' +
        '<div style="font-size:12px;line-height:1.7;">主机名: <b>' + escHtml(r.hostname || '-') + '</b><br/>内核: ' + escHtml(r.kernel || '-') + '<br/>运行: ' + (r.uptime_days || 0) + ' 天</div>' +
      '</div>' +
      issuesHtml;

    window._si_last_result = r;
  }

  function downloadServerReport() {
    if (_si_task_id) {
      window.open('/api/download/' + _si_task_id, '_blank');
    } else {
      toastError('当前无可下载的报告');
    }
  }

  function downloadServerReportHtml() {
    if (_si_task_id) {
      window.open('/api/download_html/' + _si_task_id, '_blank');
    } else {
      toastError('暂无可下载的报告');
    }
  }

  // 下载本次巡检的 AI 分析报告（根因分析与优化建议）
  function downloadServerAiReportFromTask() {
    if (_si_history_id) {
      window.open('/api/server_inspect_ai_report/' + _si_history_id, '_blank');
    } else {
      toastError('AI 分析报告暂不可下载（历史保存失败或未开启 AI 分析）');
    }
  }

  async function shareServerReport() {
    const result = window._si_last_result;
    if (!result) { toastError('暂无巡检结果'); return; }
    await shareResultDirect(result);
  }

  async function shareResultDirect(result) {
    try {
      const res = await fetch('/api/server_inspect_share', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({result: result})
      });
      const data = await res.json();
      if (data.ok) {
        const shareUrl = window.location.origin + data.share_url;
        showShareLinkDialog(shareUrl);
      } else {
        toastError(data.msg || '生成分享链接失败');
      }
    } catch (e) {
      toastError('请求失败: ' + e.message);
    }
  }

  // ─── SSH 配置加载与统计 ──────────────────────────
  async function loadServerSSHProfiles() {
    try {
      const res = await fetch('/api/server_ssh_profiles');
      const data = await res.json();
      if (data.ok) {
        _si_profiles = data.profiles || [];
        renderServerTable();
        updateSiStats();
      }
    } catch (e) {
      console.error('Load SSH profiles failed:', e);
    }
    loadSiHistoryStats();
  }

  async function loadSiHistoryStats() {
    try {
      const res = await fetch('/api/server_inspect_history?limit=100');
      const data = await res.json();
      if (data.ok) {
        const history = data.history || [];
        const histEl = $('si-stat-history');
        const avgEl = $('si-stat-avg-score');
        if (histEl) histEl.textContent = history.length;
        if (avgEl) {
          if (history.length === 0) {
            avgEl.textContent = '--';
          } else {
            const avgScore = history.reduce((s, h) => s + (h.health_score || 0), 0) / history.length;
            avgEl.textContent = Math.round(avgScore);
          }
        }
      }
    } catch (e) {
      console.error('Load SI history stats failed:', e);
    }
  }

  function updateSiStats() {
    const totalEl = $('si-stat-total');
    if (totalEl) totalEl.textContent = _si_profiles.length;
  }

  // ─── 服务器巡检历史：状态 ──────────────────────────
  let _shSearchQuery = '';
  let _shOsType = '';
  let _shStatus = '';        // '' | 'healthy' | 'warning' | 'critical'
  let _shHasIssues = false;  // 仅有问题
  let _shDateFrom = '';
  let _shDateTo = '';
  let _shDetailReportName = '';
  let _shDetailRecordId = null;
  let _shDetailResult = null;        // 详情弹窗当前结果，供「分享报告」生成链接

  /** 兜底打开原生日期选择器（部分浏览器 color-scheme 会导致点击不弹出） */
  function openDatePicker(el) {
    if (el && typeof el.showPicker === 'function') {
      try { el.showPicker(); } catch (e) { /* 已打开或浏览器不支持则忽略 */ }
    }
  }

  /** 日期变化：同步自定义占位符状态（has-value 类） */
  function syncDatePlaceholder(el) {
    const wrap = el.closest('.sh-date-wrap');
    if (wrap) wrap.classList.toggle('has-value', !!el.value);
  }

  /** 下载当前详情对应的原始报告 */
  function downloadServerDetailReport() {
    if (!_shDetailReportName) { toastError('无原始数据可下载'); return; }
    window.open('/api/download_file?name=' + encodeURIComponent(_shDetailReportName), '_blank');
  }

  function downloadServerAiReport() {
    if (!_shDetailRecordId) { toastError('无 AI 分析报告可下载'); return; }
    window.open('/api/server_inspect_ai_report/' + _shDetailRecordId, '_blank');
  }

  // AI 输出常把 Markdown 与 HTML/XML 混写（<br> / <sql>…</sql> / <table>），
  // 转义后直接渲染就会把标签原样显示出来。渲染前统一翻译成 Markdown。
  // 白名单与后端 core/ai_text.py::normalize_ai_text() 保持一致。
  function normalizeAiText(text) {
    if (text == null) return '';
    let s = String(text).replace(/\r\n?/g, '\n');
    // HTML 实体解码（&amp; 放最后，避免二次解码）
    s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
         .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
         .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    // 成对代码标签 → 行内代码
    s = s.replace(/<(?:sql|code|pre|kbd|samp)>([\s\S]*?)<\/(?:sql|code|pre|kbd|samp)\s*>/gi,
                  (m, body) => '`' + String(body).replace(/`/g, '').trim() + '`');
    // 换行 / 分割线 / 表格 / 结构类
    s = s.replace(/<br\s*\/?\s*>/gi, '\n');
    s = s.replace(/<hr\s*\/?\s*>/gi, '\n---\n');
    s = s.replace(/<\/?(?:table|thead|tbody|tfoot)\s*\/?>/gi, '\n');
    s = s.replace(/<\/?tr\s*\/?>/gi, '\n');
    s = s.replace(/<\/?(?:td|th)\s*\/?>/gi, ' | ');
    s = s.replace(/<h([1-6])\s*\/?>/gi, (m, n) => '\n' + '#'.repeat(Number(n)) + ' ');
    s = s.replace(/<\/h[1-6]\s*>/gi, '\n');
    s = s.replace(/<li\s*\/?>/gi, '\n- ').replace(/<\/li\s*>/gi, '');
    s = s.replace(/<\/?(?:ul|ol)\s*\/?>/gi, '\n');
    s = s.replace(/<\/?p\s*\/?>/gi, '\n');
    // 强调：成对才翻译；带属性的形式要求含 '='，避免把 SQL 的 a<b 误当标签吃掉
    s = s.replace(/<(?:strong|b)(?:\s[^<>]*=[^<>]*)?>([\s\S]*?)<\/(?:strong|b)\s*>/gi,
                  (m, body) => '**' + body + '**');
    s = s.replace(/<(?:em|i)(?:\s[^<>]*=[^<>]*)?>([\s\S]*?)<\/(?:em|i)\s*>/gi,
                  (m, body) => '*' + body + '*');
    // 落单标签与无语义容器标签
    s = s.replace(/<\/?(?:sql|code|pre|kbd|samp)\s*\/?>/gi, '');
    s = s.replace(/<\/(?:strong|b)\s*>/gi, '').replace(/<\/(?:em|i)\s*>/gi, '');
    s = s.replace(/<\/?(?:span|div|font|small|u|center|section|article|figure|blockquote|sup|sub|mark|del|ins)(?:\s[^<>]*=[^<>]*)?\s*\/?>/gi, '');
    return s;
  }

  // 简单 Markdown → HTML 渲染（仅用于本模块的 AI 分析报告展示）
  function renderMarkdown(text) {
    if (!text) return '';
    const lines = normalizeAiText(text).split('\n');
    let html = '';
    let inList = false;
    let inNumList = false;
    let inCode = false;
    let codeBuf = [];
    const codeStyle = 'background:var(--code-bg);padding:1px 5px;border-radius:4px;font-family:Consolas,Monaco,monospace;font-size:12.5px;';
    const preStyle = 'background:var(--code-bg);border:1px solid var(--border);border-radius:6px;padding:8px 10px;overflow:auto;font-family:Consolas,Monaco,monospace;font-size:12.5px;line-height:1.5;margin:8px 0;';
    const closeLists = () => {
      if (inList) { html += '</ul>'; inList = false; }
      if (inNumList) { html += '</ol>'; inNumList = false; }
    };
    const inline = (s) => escHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code style="' + codeStyle + '">$1</code>');
    const flushCode = () => {
      if (codeBuf.length) {
        html += '<pre style="' + preStyle + '">' + escHtml(codeBuf.join('\n')) + '</pre>';
      }
      codeBuf = [];
      inCode = false;
    };
    lines.forEach(line => {
      const t = line.trim();
      // ``` 代码块（AI 建议里的 SQL 片段）
      if (t.startsWith('```')) {
        if (inCode) flushCode();
        else { closeLists(); inCode = true; }
        return;
      }
      if (inCode) { codeBuf.push(line); return; }
      if (!t) { closeLists(); return; }
      if (t.startsWith('### ')) { closeLists(); html += '<h4>' + inline(t.slice(4)) + '</h4>'; }
      else if (t.startsWith('## ')) { closeLists(); html += '<h3>' + inline(t.slice(3)) + '</h3>'; }
      else if (t.startsWith('# ')) { closeLists(); html += '<h2>' + inline(t.slice(2)) + '</h2>'; }
      else if (t.startsWith('- ') || t.startsWith('* ')) {
        if (!inList) { closeLists(); html += '<ul>'; inList = true; }
        html += '<li>' + inline(t.slice(2)) + '</li>';
      }
      else if (/^\d+\.\s/.test(t)) {
        if (!inNumList) { closeLists(); html += '<ol>'; inNumList = true; }
        html += '<li>' + inline(t.replace(/^\d+\.\s/, '')) + '</li>';
      }
      else { closeLists(); html += '<p>' + inline(t) + '</p>'; }
    });
    if (inCode) flushCode();
    closeLists();
    return html;
  }

  /** 读取筛选条件并刷新 */
  function filterServerHistory() {
    const input = $('sh-search-input');
    _shSearchQuery = input ? input.value.trim().toLowerCase() : '';
    const osSel = $('sh-os-filter');
    _shOsType = osSel ? osSel.value : '';
    const df = $('sh-date-from');
    _shDateFrom = df ? df.value : '';
    const dt = $('sh-date-to');
    _shDateTo = dt ? dt.value : '';
    loadServerHistory();
  }

  /** 点击状态卡片筛选 */
  function setServerStatusFilter(status) {
    if (status === 'issues') {
      _shHasIssues = !_shHasIssues;
      _shStatus = '';
    } else {
      _shStatus = (_shStatus === status) ? '' : status;
      _shHasIssues = false;
    }
    loadServerHistory();
  }

  /** 重置所有筛选条件 */
  function resetServerHistoryFilters() {
    _shSearchQuery = '';
    _shOsType = '';
    _shStatus = '';
    _shHasIssues = false;
    _shDateFrom = '';
    _shDateTo = '';
    const input = $('sh-search-input');
    if (input) input.value = '';
    const osSel = $('sh-os-filter');
    if (osSel) osSel.value = '';
    const df = $('sh-date-from');
    if (df) df.value = '';
    const dt = $('sh-date-to');
    if (dt) dt.value = '';
    document.querySelectorAll('.sh-date-wrap').forEach(w => w.classList.remove('has-value'));
    loadServerHistory();
  }

  /** 加载操作系统类型下拉 */
  async function loadServerOsTypes() {
    const osSel = $('sh-os-filter');
    if (!osSel) return;
    try {
      const res = await fetch('/api/server_inspect_os_types');
      const data = await res.json();
      if (!data.ok) return;
      const current = osSel.value;
      osSel.innerHTML = '<option value="">全部操作系统</option>' +
        (data.os_types || []).map(t => '<option value="' + escHtml(t) + '">' + escHtml(t) + '</option>').join('');
      osSel.value = current;
    } catch (e) { /* 忽略 */ }
  }

  async function loadServerHistory() {
    const listEl = $('sh-server-list');
    const statsEl = $('sh-stats-row');
    const pillsEl = $('sh-filter-pills');
    if (!listEl) return;

    // 组装多维筛选参数
    const params = new URLSearchParams();
    params.set('limit', '500');
    if (_shSearchQuery) params.set('keyword', _shSearchQuery);
    if (_shOsType) params.set('os_type', _shOsType);
    if (_shStatus) params.set('status', _shStatus);
    if (_shHasIssues) params.set('has_issues', '1');
    if (_shDateFrom) params.set('date_from', _shDateFrom);
    if (_shDateTo) params.set('date_to', _shDateTo);

    try {
      const res = await fetch('/api/server_inspect_history?' + params.toString());
      const data = await res.json();
      if (!data.ok) return;
      const history = data.history || [];
      const counts = data.counts || {total: 0, healthy: 0, warning: 0, critical: 0, has_issues: 0};

      // 渲染状态筛选卡片（点击自动筛选）
      if (statsEl) {
        const cards = [
          {key: '', label: '全部', icon: '📊', color: 'var(--sky)', count: counts.total, trend: '所有巡检记录'},
          {key: 'healthy', label: '健康', icon: '✅', color: 'var(--success)', count: counts.healthy, trend: '评分 ≥ 80'},
          {key: 'warning', label: '需关注', icon: '⚠️', color: 'var(--warn)', count: counts.warning, trend: '评分 60-79'},
          {key: 'critical', label: '严重问题', icon: '🔴', color: 'var(--danger)', count: counts.critical, trend: '评分 < 60'},
          {key: 'issues', label: '有问题', icon: '🚨', color: '#a855f7', count: counts.has_issues, trend: '存在告警项'},
        ];
        statsEl.innerHTML = cards.map(c => {
          const active = (c.key === 'issues') ? _shHasIssues : (_shStatus === c.key);
          return '<div class="sh-card ' + (active ? 'active' : '') + '" style="--card-accent: ' + c.color + '" onclick="setServerStatusFilter(\'' + c.key + '\')">' +
            '<div class="sh-card-top"><span class="sh-card-label">' + c.label + '</span><span class="sh-card-icon">' + c.icon + '</span></div>' +
            '<div class="sh-card-num">' + c.count + '</div>' +
            '<div class="sh-card-trend"><span style="color:' + c.color + '">●</span> ' + c.trend + '</div>' +
          '</div>';
        }).join('');
      }

      // 渲染筛选药丸
      if (pillsEl) {
        let pHtml = '';
        const pill = (label, color, clearFn) => '<span class="sh-filter-pill active" style="--pill-color: ' + color + '" onclick="' + clearFn + '">' +
          '<span>' + label + '</span><span class="sh-pill-count">✕</span>' +
        '</span>';
        if (_shSearchQuery) pHtml += pill('关键字: "' + escHtml(_shSearchQuery) + '"', 'var(--accent2)', "document.getElementById('sh-search-input').value='';FusionServerInspect.clearFilter('keyword')");
        if (_shOsType) pHtml += pill('系统: ' + escHtml(_shOsType), '#8b5cf6', "document.getElementById('sh-os-filter').value='';FusionServerInspect.clearFilter('os')");
        if (_shStatus === 'healthy') pHtml += pill('健康', 'var(--success)', "FusionServerInspect.clearFilter('status')");
        if (_shStatus === 'warning') pHtml += pill('需关注', 'var(--warn)', "FusionServerInspect.clearFilter('status')");
        if (_shStatus === 'critical') pHtml += pill('严重问题', 'var(--danger)', "FusionServerInspect.clearFilter('status')");
        if (_shHasIssues) pHtml += pill('有问题', '#a855f7', "FusionServerInspect.clearFilter('issues')");
        if (_shDateFrom) pHtml += pill('从 ' + escHtml(_shDateFrom), 'var(--accent2)', "document.getElementById('sh-date-from').value='';FusionServerInspect.clearFilter('from')");
        if (_shDateTo) pHtml += pill('至 ' + escHtml(_shDateTo), 'var(--accent2)', "document.getElementById('sh-date-to').value='';FusionServerInspect.clearFilter('to')");
        pillsEl.innerHTML = pHtml;
      }

      // 空状态
      if (history.length === 0) {
        listEl.innerHTML = '<div class="sh-empty-hint">' +
          '<span class="sh-empty-icon">📭</span>' +
          '暂无匹配的巡检记录' +
          '<div class="sh-empty-sub">' + ((counts.total || 0) > 0 ? '请调整筛选条件后重试' : '点击右上角「新增巡检」按钮开始服务器巡检') + '</div>' +
        '</div>';
        return;
      }

      // 渲染服务器卡片
      listEl.innerHTML = history.map(h => {
        const score = h.health_score || 0;
        const scoreColor = score >= 80 ? 'var(--success)' : score >= 60 ? 'var(--warn)' : 'var(--danger)';
        const hostname = escHtml(h.hostname || h.host || '-');
        const time = h.inspect_time ? String(h.inspect_time).replace('T', ' ').substring(0, 16) : '-';
        const cpu = (h.cpu_usage || 0).toFixed(1);
        const mem = (h.memory_usage || 0).toFixed(1);
        const disk = (h.disk_usage_max || 0).toFixed(1);
        const issues = h.issues_count || 0;
        const osType = h.os_type ? escHtml(h.os_type) : '';

        // 环形图参数
        const r = 22;
        const circumference = 2 * Math.PI * r;
        const offset = circumference - (score / 100) * circumference;

        // 资源条颜色
        const barColor = (v) => parseFloat(v) > 90 ? 'var(--danger)' : parseFloat(v) > 75 ? 'var(--warn)' : 'var(--success)';
        const cpuColor = barColor(cpu);
        const memColor = barColor(mem);
        const diskColor = barColor(disk);

        return '<div class="sh-server-card" style="--card-color: ' + scoreColor + '" ondblclick="viewServerHistoryDetail(' + h.id + ')" title="双击查看详情">' +
          '<div class="sh-score-ring">' +
            '<svg width="56" height="56" viewBox="0 0 56 56">' +
              '<circle class="sh-score-ring-bg" cx="28" cy="28" r="' + r + '"/>' +
              '<circle class="sh-score-ring-fg" cx="28" cy="28" r="' + r + '" stroke="' + scoreColor + '" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + offset + '"/>' +
            '</svg>' +
            '<div class="sh-score-text" style="color:' + scoreColor + '">' + score + '</div>' +
            '<div class="sh-score-label">评分</div>' +
          '</div>' +
          '<div class="sh-server-info">' +
            '<div class="sh-server-name">' + hostname + (osType ? '<span class="sh-os-badge">' + osType + '</span>' : '') + '</div>' +
            '<div class="sh-server-meta">' +
              '<span>巡检时间: ' + escHtml(time) + '</span>' +
              '<span class="sh-meta-dot"></span>' +
              '<span>CPU: ' + cpu + '%</span>' +
              '<span class="sh-meta-dot"></span>' +
              '<span>内存: ' + mem + '%</span>' +
              '<span class="sh-meta-dot"></span>' +
              '<span>磁盘: ' + disk + '%</span>' +
            '</div>' +
            '<div class="sh-resource-bars">' +
              '<div class="sh-resource-item"><span>CPU</span>' +
                '<div class="sh-resource-bar"><div class="sh-resource-bar-fill" style="width:' + cpu + '%;background:' + cpuColor + '"></div></div>' +
                '<span>' + cpu + '%</span></div>' +
              '<div class="sh-resource-item"><span>MEM</span>' +
                '<div class="sh-resource-bar"><div class="sh-resource-bar-fill" style="width:' + mem + '%;background:' + memColor + '"></div></div>' +
                '<span>' + mem + '%</span></div>' +
              '<div class="sh-resource-item"><span>DSK</span>' +
                '<div class="sh-resource-bar"><div class="sh-resource-bar-fill" style="width:' + disk + '%;background:' + diskColor + '"></div></div>' +
                '<span>' + disk + '%</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="sh-server-tags">' +
            (issues > 0 ? '<span class="sh-tag issues">⚠️ ' + issues + ' 个问题</span>' : '<span class="sh-tag none">✓ 正常</span>') +
            '<span class="sh-tag time">' + escHtml(time) + '</span>' +
          '</div>' +
          '<div class="sh-server-actions">' +
            '<button class="sh-action-btn" onclick="viewServerHistoryDetail(' + h.id + ')">' +
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
              '详情' +
            '</button>' +
            '<button class="sh-action-btn danger" onclick="deleteServerHistory(' + h.id + ')">' +
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
            '</button>' +
          '</div>' +
        '</div>';
      }).join('');
    } catch (e) {
      console.error('Load server history failed:', e);
      listEl.innerHTML = '<div class="sh-empty-hint" style="color:var(--danger)">' +
        '<span class="sh-empty-icon">⚠️</span>' +
        '加载失败: ' + escHtml(e.message) +
      '</div>';
    }
  }

  /** 清除单个筛选条件后刷新（供筛选药丸的 ✕ 调用） */
  function clearFilter(which) {
    if (which === 'keyword') _shSearchQuery = '';
    else if (which === 'os') _shOsType = '';
    else if (which === 'status') _shStatus = '';
    else if (which === 'issues') _shHasIssues = false;
    else if (which === 'from') {
      _shDateFrom = '';
      const df = $('sh-date-from');
      if (df) { df.value = ''; syncDatePlaceholder(df); }
    } else if (which === 'to') {
      _shDateTo = '';
      const dt = $('sh-date-to');
      if (dt) { dt.value = ''; syncDatePlaceholder(dt); }
    }
    loadServerHistory();
  }

  async function viewServerHistoryDetail(id) {
    const modal = $('sh-detail-modal');
    const body = $('sh-detail-body');
    const title = $('sh-detail-title');
    if (!modal || !body) return;
    modal.style.display = 'flex';
    body.innerHTML = '<div class="sh-loading-state">' +
      '<div class="sh-loading-spinner"><div class="sh-spinner-ring"></div></div>' +
      '<div class="sh-loading-text">加载详情中...</div>' +
    '</div>';

    try {
      const res = await fetch('/api/server_inspect_history/' + id);
      const data = await res.json();
      if (!data.ok || !data.record) { toastError('获取详情失败'); modal.style.display = 'none'; return; }
      const record = data.record;
      const result = record.result || (typeof record.result_json === 'string' ? JSON.parse(record.result_json) : (record.result_json || {}));
      if (!result || Object.keys(result).length === 0) { toastError('无巡检结果数据'); modal.style.display = 'none'; return; }

      const hostname = escHtml(record.hostname || record.host || '-');
      const inspectTime = record.inspect_time || '-';
      title.textContent = hostname + ' 巡检详情';

      // 头部下载按钮（原始数据 + AI 分析报告）
      const dlBtn = $('sh-detail-download');
      if (record.report_path) {
        _shDetailReportName = String(record.report_path).split(/[\\/]/).pop();
        if (dlBtn) dlBtn.style.display = 'inline-flex';
      } else {
        _shDetailReportName = '';
        if (dlBtn) dlBtn.style.display = 'none';
      }
      _shDetailRecordId = id;
      _shDetailResult = result;
      const shareBtn = $('sh-detail-share');
      if (shareBtn) shareBtn.style.display = 'inline-flex';
      const aiDlBtn = $('sh-detail-ai-download');
      const aiReport = result.ai_report || record.ai_report || '';
      if (aiDlBtn) aiDlBtn.style.display = aiReport ? 'inline-flex' : 'none';

      // 健康评分
      const score = result.health_score || 0;
      const status = result.health_status || '';
      const scoreColor = score >= 80 ? 'var(--success)' : score >= 60 ? 'var(--warn)' : 'var(--danger)';
      const r = 42;
      const circumference = 2 * Math.PI * r;
      const offset = circumference - (score / 100) * circumference;

      // CPU
      const cpu = result.cpu || {};
      const cpuPct = (cpu.usage_percent || 0).toFixed(1);
      const cpuColor = parseFloat(cpuPct) > 90 ? 'var(--danger)' : parseFloat(cpuPct) > 75 ? 'var(--warn)' : 'var(--success)';

      // 内存
      const mem = result.memory || {};
      const memPct = (mem.usage_percent || 0).toFixed(1);
      const memColor = parseFloat(memPct) > 90 ? 'var(--danger)' : parseFloat(memPct) > 75 ? 'var(--warn)' : 'var(--success)';
      const memTotal = (mem.total_gb || 0).toFixed(1);
      const memUsed = (mem.used_gb || 0).toFixed(1);
      const memAvail = (mem.available_gb || 0).toFixed(1);
      const memSwapUsed = (mem.swap_used_gb || 0).toFixed(1);
      const memSwapTotal = (mem.swap_total_gb || 0).toFixed(1);

      // 磁盘
      const disks = result.disk || [];
      let diskHtml = '';
      if (disks.length > 0) {
        diskHtml = '<table class="sh-detail-table"><thead><tr><th>挂载点</th><th>设备</th><th>文件系统</th><th>总量</th><th>已用</th><th>使用率</th></tr></thead><tbody>';
        disks.forEach(d => {
          const dpct = d.usage_percent || 0;
          const dColor = dpct > 90 ? 'var(--danger)' : dpct > 80 ? 'var(--warn)' : 'var(--success)';
          diskHtml += '<tr>' +
            '<td>' + escHtml(d.mountpoint) + '</td>' +
            '<td style="text-align:center">' + escHtml(d.device) + '</td>' +
            '<td style="text-align:center">' + escHtml(d.fstype) + '</td>' +
            '<td style="text-align:center">' + (d.total_gb || 0).toFixed(1) + ' GB</td>' +
            '<td style="text-align:center">' + (d.used_gb || 0).toFixed(1) + ' GB</td>' +
            '<td style="text-align:center"><span style="color:' + dColor + ';font-weight:600">' + dpct.toFixed(1) + '%</span></td>' +
          '</tr>';
        });
        diskHtml += '</tbody></table>';
      } else {
        diskHtml = '<span style="color:var(--text-muted);font-size:12px">无磁盘信息</span>';
      }

      // 网络
      const network = result.network || {};
      let netHtml = '';
      const hasNet = network.ping || network.dns || (network.ports && network.ports.length);
      if (hasNet) {
        netHtml = '<table class="sh-detail-table"><thead><tr><th>检测项</th><th>状态</th><th>结果</th></tr></thead><tbody>';
        if (network.ping) Object.entries(network.ping).forEach(([t, i]) => {
          netHtml += '<tr><td>Ping ' + escHtml(t) + '</td><td style="text-align:center">' + (i.ok ? '<span style="color:var(--success)">✅ 正常</span>' : '<span style="color:var(--danger)">❌ 超时</span>') + '</td><td style="text-align:center">' + (i.ok ? (i.latency_ms || 0).toFixed(1) + ' ms' : '超时') + '</td></tr>';
        });
        if (network.dns) Object.entries(network.dns).forEach(([d, i]) => {
          netHtml += '<tr><td>DNS ' + escHtml(d) + '</td><td style="text-align:center">' + (i.ok ? '<span style="color:var(--success)">✅ 正常</span>' : '<span style="color:var(--danger)">❌ 失败</span>') + '</td><td style="text-align:center">' + (i.ok ? '解析成功' : '解析失败') + '</td></tr>';
        });
        if (network.ports) network.ports.forEach(p => {
          netHtml += '<tr><td>端口 ' + p.port + ' (' + escHtml(p.name) + ')</td><td style="text-align:center">' + (p.listening ? '<span style="color:var(--success)">✅ 监听中</span>' : '<span style="color:var(--text-muted)">➖ 未监听</span>') + '</td><td style="text-align:center">' + (p.listening ? '正常' : '未监听') + '</td></tr>';
        });
        netHtml += '</tbody></table>';
      }

      // 服务
      const services = result.services || [];
      let svcHtml = '';
      if (services.length > 0) {
        svcHtml = '<div style="display:flex;flex-wrap:wrap;gap:6px">';
        services.forEach(s => {
          const cls = s.status === 'running' ? 'running' : s.status === 'stopped' ? 'stopped' : 'na';
          const label = s.status === 'running' ? '运行中' : s.status === 'stopped' ? '已停止' : '未安装';
          svcHtml += '<span class="sh-svc-badge ' + cls + '">' + (s.status === 'running' ? '▶' : s.status === 'stopped' ? '⏹' : '➖') + ' ' + escHtml(s.name) + ' ' + label + '</span>';
        });
        svcHtml += '</div>';
      }

      // 进程
      const procs = result.top_processes || [];
      let procHtml = '';
      if (procs.length > 0) {
        procHtml = '<table class="sh-detail-table"><thead><tr><th>PID</th><th>用户</th><th>CPU%</th><th>内存%</th><th>命令</th></tr></thead><tbody>';
        procs.forEach(p => {
          procHtml += '<tr><td>' + p.pid + '</td><td style="text-align:center">' + escHtml(p.user) + '</td><td style="text-align:center">' + (p.cpu || 0).toFixed(1) + '</td><td style="text-align:center">' + (p.mem || 0).toFixed(1) + '</td><td style="font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(p.command) + '</td></tr>';
        });
        procHtml += '</tbody></table>';
      }

      // 问题
      const issues = result.issues || [];
      let issuesHtml = '';
      if (issues.length > 0) {
        issuesHtml = issues.map(i => '<div class="sh-issue-item"><span class="sh-issue-icon">⚠️</span><span>' + escHtml(typeof i === 'string' ? i : (i.description || i.msg || JSON.stringify(i))) + '</span></div>').join('');
      }

      // 系统信息
      let sysInfoHtml = '';
      const osInfo = result.os_info || {};
      const osPlatform = result.platform || osInfo.platform || '';
      const osKernel = result.kernel || osInfo.kernel || '';
      const osHostname = result.hostname || osInfo.hostname || '';
      const osUptime = result.uptime_days || osInfo.uptime_days || 0;
      if (osPlatform || osKernel || osHostname) {
        sysInfoHtml = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">' +
          (osPlatform ? '<div><span style="color:var(--text-muted)">系统:</span> ' + escHtml(osPlatform) + '</div>' : '') +
          (osInfo.distribution ? '<div><span style="color:var(--text-muted)">发行版:</span> ' + escHtml(osInfo.distribution) + '</div>' : '') +
          (osKernel ? '<div><span style="color:var(--text-muted)">内核:</span> ' + escHtml(osKernel) + '</div>' : '') +
          (osHostname ? '<div><span style="color:var(--text-muted)">主机名:</span> ' + escHtml(osHostname) + '</div>' : '') +
          (osUptime ? '<div><span style="color:var(--text-muted)">运行时间:</span> ' + osUptime + ' 天</div>' : '') +
        '</div>';
      } else {
        sysInfoHtml = '<span style="color:var(--text-muted);font-size:12px">无系统信息</span>';
      }

      // 组装详情
      body.innerHTML =
        '<div class="sh-detail-score">' +
          '<div class="sh-detail-score-ring">' +
            '<svg width="100" height="100" viewBox="0 0 100 100">' +
              '<circle class="sh-score-ring-bg" cx="50" cy="50" r="' + r + '"/>' +
              '<circle class="sh-score-ring-fg" cx="50" cy="50" r="' + r + '" stroke="' + scoreColor + '" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + offset + '"/>' +
            '</svg>' +
            '<div class="sh-detail-score-text" style="color:' + scoreColor + '">' + score + '</div>' +
            '<div class="sh-detail-score-label">健康分</div>' +
          '</div>' +
          '<div class="sh-detail-score-info">' +
            '<div class="sh-detail-score-status" style="color:' + scoreColor + '">' + escHtml(status) + '</div>' +
            '<div class="sh-detail-score-host">' + hostname + '</div>' +
            '<div class="sh-detail-score-detail">巡检时间: ' + escHtml(inspectTime) + '</div>' +
          '</div>' +
        '</div>' +

        '<div class="sh-detail-grid">' +
          '<div class="sh-detail-panel">' +
            '<div class="sh-detail-panel-title">🔲 CPU</div>' +
            '<div class="sh-progress-item">' +
              '<div class="sh-progress-header"><span class="sh-progress-label">使用率</span><span class="sh-progress-value">' + cpuPct + '%</span></div>' +
              '<div class="sh-progress-track"><div class="sh-progress-fill" style="width:' + cpuPct + '%;background:' + cpuColor + '"></div></div>' +
            '</div>' +
            '<div style="font-size:12px;color:var(--text-muted);margin-top:8px;line-height:1.8">' +
              '物理核心: ' + (cpu.physical_cores || '-') + ' | 逻辑核心: ' + (cpu.logical_cores || '-') + '<br>' +
              '频率: ' + (cpu.current_frequency || '-') + ' / ' + (cpu.max_frequency || '-') + ' GHz<br>' +
              '负载: ' + (cpu.load_1m || 0).toFixed(2) + ' / ' + (cpu.load_5m || 0).toFixed(2) + ' / ' + (cpu.load_15m || 0).toFixed(2) +
            '</div>' +
          '</div>' +
          '<div class="sh-detail-panel">' +
            '<div class="sh-detail-panel-title">💾 内存</div>' +
            '<div class="sh-progress-item">' +
              '<div class="sh-progress-header"><span class="sh-progress-label">使用率</span><span class="sh-progress-value">' + memPct + '%</span></div>' +
              '<div class="sh-progress-track"><div class="sh-progress-fill" style="width:' + memPct + '%;background:' + memColor + '"></div></div>' +
            '</div>' +
            '<div style="font-size:12px;color:var(--text-muted);margin-top:8px;line-height:1.8">' +
              '总量: ' + memTotal + ' GB | 已用: ' + memUsed + ' GB | 可用: ' + memAvail + ' GB<br>' +
              'Swap: ' + memSwapUsed + ' / ' + memSwapTotal + ' GB' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="sh-detail-panel-full">' +
          '<div class="sh-detail-panel-title">💿 磁盘</div>' + diskHtml +
        '</div>' +

        '<div class="sh-detail-panel-full">' +
          '<div class="sh-detail-panel-title">ℹ️ 系统信息</div>' + sysInfoHtml +
        '</div>' +

        (hasNet ? '<div class="sh-detail-panel-full"><div class="sh-detail-panel-title">🌐 网络检测</div>' + netHtml + '</div>' : '') +
        (svcHtml ? '<div class="sh-detail-panel-full"><div class="sh-detail-panel-title">🔧 服务状态</div>' + svcHtml + '</div>' : '') +
        (procHtml ? '<div class="sh-detail-panel-full"><div class="sh-detail-panel-title">⚙️ Top 进程</div>' + procHtml + '</div>' : '') +
        (issuesHtml ? '<div class="sh-detail-panel-full"><div class="sh-detail-panel-title">⚠️ 发现的问题</div>' + issuesHtml + '</div>' : '') +
        (aiReport ? '<div class="sh-detail-panel-full ai-report"><div class="sh-detail-panel-title">🤖 AI 分析报告</div><div class="sh-ai-report-body">' + renderMarkdown(aiReport) + '</div></div>' : '') +

        '<div class="sh-detail-actions">' +
          '<button class="sh-detail-btn" onclick="closeServerDetail()">✕ 关闭</button>' +
        '</div>';
    } catch (e) {
      toastError('请求失败: ' + e.message);
      modal.style.display = 'none';
    }
  }

  function closeServerDetail(e) {
    if (e && e.target !== e.currentTarget) return;
    const modal = $('sh-detail-modal');
    if (modal) modal.style.display = 'none';
    const dlBtn = $('sh-detail-download');
    if (dlBtn) dlBtn.style.display = 'none';
    const aiDlBtn = $('sh-detail-ai-download');
    if (aiDlBtn) aiDlBtn.style.display = 'none';
    const shareBtn = $('sh-detail-share');
    if (shareBtn) shareBtn.style.display = 'none';
    _shDetailReportName = '';
    _shDetailRecordId = null;
    _shDetailResult = null;
  }

  // 分享当前详情弹窗里的巡检结果（生成只读链接）
  async function shareServerDetail() {
    if (!_shDetailResult) { toastError('暂无巡检结果'); return; }
    await shareResultDirect(_shDetailResult);
  }

  async function deleteServerHistory(id) {
    const confirmed = await showConfirmDialog('确认删除', '确定删除这条服务器巡检记录？');
    if (!confirmed) return;
    try {
      const res = await fetch('/api/server_inspect_history/' + id, {method: 'DELETE'});
      const data = await res.json();
      if (data.ok) {
        toastSuccess('已删除');
        loadServerHistory();
      } else {
        toastError(data.msg || '删除失败');
      }
    } catch (e) {
      toastError('请求失败: ' + e.message);
    }
  }

  // ─── 对外接口 ──────────────────────────────────────
  // 页面内联 onclick 沿用原函数名，统一挂到 window；
  // 命名空间供 showPage 钩子与筛选药丸调用。
  const api = {
    // 巡检页
    load: loadServerSSHProfiles,
    loadServerSSHProfiles: loadServerSSHProfiles,
    renderServerTable: renderServerTable,
    updateSiStats: updateSiStats,
    loadSiHistoryStats: loadSiHistoryStats,
    showSiConfigModal: showSiConfigModal,
    closeSiConfigModal: closeSiConfigModal,
    editSiProfile: editSiProfile,
    confirmSaveSiConfig: confirmSaveSiConfig,
    deleteSiProfile: deleteSiProfile,
    toggleSiAuth: toggleSiAuth,
    testServerSSH: testServerSSH,
    startInspectFromProfile: startInspectFromProfile,
    startLocalInspect: startLocalInspect,
    viewSiLog: viewSiLog,
    selectSiLogRecord: selectSiLogRecord,
    closeSiLogModal: closeSiLogModal,
    viewSiResult: viewSiResult,
    closeSiRunModal: closeSiRunModal,
    downloadServerReport: downloadServerReport,
    downloadServerReportHtml: downloadServerReportHtml,
    downloadServerAiReportFromTask: downloadServerAiReportFromTask,
    shareServerReport: shareServerReport,
    renderSiRunResult: renderSiRunResult,
    // 历史页
    loadHistoryPage: function () { loadServerOsTypes(); loadServerHistory(); },
    loadServerHistory: loadServerHistory,
    loadServerOsTypes: loadServerOsTypes,
    filterServerHistory: filterServerHistory,
    setServerStatusFilter: setServerStatusFilter,
    resetServerHistoryFilters: resetServerHistoryFilters,
    clearFilter: clearFilter,
    viewServerHistoryDetail: viewServerHistoryDetail,
    closeServerDetail: closeServerDetail,
    deleteServerHistory: deleteServerHistory,
    downloadServerDetailReport: downloadServerDetailReport,
    downloadServerAiReport: downloadServerAiReport,
    shareServerDetail: shareServerDetail,
    openDatePicker: openDatePicker,
    syncDatePlaceholder: syncDatePlaceholder,
    shareResultDirect: shareResultDirect,
    normalizeAiText: normalizeAiText,
  };

  window.FusionServerInspect = api;
  Object.keys(api).forEach(function (k) {
    if (k === 'load' || k === 'loadHistoryPage' || k === 'clearFilter') return;
    window[k] = api[k];
  });

  // 兼容旧调用名
  window.renderSSHProfiles = renderServerTable;
  window.selectSSHProfile = startInspectFromProfile;
  window.editSSHProfile = editSiProfile;
  window.deleteSSHProfile = deleteSiProfile;
  window.showSaveProfileDialog = showSiConfigModal;
  window.saveCurrentAsProfile = showSiConfigModal;
  window.closeSaveProfileModal = closeSiConfigModal;
  window.confirmSaveProfile = confirmSaveSiConfig;
  window.startServerInspect = startLocalInspect;
})();