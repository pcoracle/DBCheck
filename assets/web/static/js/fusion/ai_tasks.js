/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * Fusion page logic: AI 对话任务回溯（#page-ai-tasks）。
 * 归属：本页交互与实现思路属 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * （MIT License, Copyright (c) 2025-2026 fiyo (Jack Ge)），品牌与标识归 DBCheck / RaccoonX 作者所有。
 * 页面布局：左上返回、左栏统计 + 搜索 + 列表、右栏详情。
 * 详情按「思考过程（可折叠）→ 预处理计划 → 工具调用时间线 → 最终分析」顺序展示；
 * 时间线每一步是可折叠卡片（参数 / 结果各自 details），SQL 步骤出结果表、
 * 多语句出汇总表、其余落 JSON 文本（超 3000 字截断），手动执行与追加取数各有徽标。
 *
 * 本页的既有约定：
 * 1. 数据源与任务都按登录用户的可见范围过滤；
 * 2. 行内事件用委托绑定，不用内联 onclick（本仓库 CSP 与代码规范要求）；
 * 3. 文案一律走 i18n key，不写死中文。
 */
(function () {
  'use strict';

  var state = { tasks: [], filtered: [], currentId: '', timer: 0 };
  var TITLE_MAX = 60;            // 列表标题截断长度
  var JSON_MAX = 3000;           // 非表格结果的字符上限

  function byId(id) { return document.getElementById(id); }

  function t(key, fallback) {
    try {
      if (typeof window.i18n === 'function') {
        var value = window.i18n(key);
        if (value && value !== key) return value;
      }
    } catch (ignore) { /* 词典未就绪时用兜底文案 */ }
    return fallback || key;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function requestJson(url, options) {
    var settings = Object.assign({ credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' } }, options || {});
    return fetch(url, settings).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok && !body.error) body.error = 'HTTP ' + response.status;
        return body;
      });
    });
  }

  function notify(message, kind) {
    if (typeof window.toast === 'function') { window.toast(message, kind || 'info'); return; }
    if (kind === 'error') console.error('[ai-tasks] ' + message);
  }

  function fmt(template, value) {
    return String(template).replace('{n}', value).replace('{round}', value);
  }

  function fmt2(template, first, second) {
    return String(template).replace('{total}', first).replace('{count}', first)
      .replace('{shown}', second).replace('{ok}', second);
  }

  function formatDuration(value) {
    var ms = Number(value || 0);
    if (!ms) return '';
    return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
  }

  /** 列表/详情标题：改过的标题优先，否则用原始提问。 */
  function taskTitle(task) {
    var title = String(task.title || task.user_message || '');
    return title.length > TITLE_MAX ? title.slice(0, TITLE_MAX) + '...' : title;
  }

  function loadTasks() {
    return Promise.all([requestJson('/api/ai/tasks?limit=100'),
                        requestJson('/api/ai/tasks/stats')]).then(function (results) {
      var listing = results[0] || {};
      var stats = (results[1] || {}).stats || {};
      state.tasks = listing.items || listing.tasks || [];
      var host = byId('ait-stats');
      if (host) {
        var bold = function (value) { return '<b>' + (value || 0) + '</b>'; };
        host.innerHTML = t('webui.ait_stats_line', '共 {total} 条 · 今日 {today} · 成功 {success} · 失败 {error}')
          .replace('{total}', bold(stats.total))
          .replace('{today}', bold(stats.today))
          .replace('{success}', bold(stats.success))
          .replace('{error}', bold(stats.error));
      }
      applyFilter();
      if (state.filtered.length && !state.currentId) selectTask(state.filtered[0].id);
      return null;
    }).catch(function (failure) {
      var host = byId('ait-list');
      if (host) host.innerHTML = '<div class="ait-empty">' +
        escapeHtml(t('webui.ait_load_failed', '加载失败') + ': ') +
        escapeHtml(failure.message || '') + '</div>';
    });
  }

  function applyFilter() {
    var search = (byId('ait-search') || {}).value || '';
    var needle = search.trim().toLowerCase();
    state.filtered = !needle ? state.tasks.slice() : state.tasks.filter(function (task) {
      return [task.user_message, task.title, task.understanding, task.datasource, task.final_analysis]
        .some(function (field) { return String(field || '').toLowerCase().indexOf(needle) >= 0; });
    });
    renderList();
  }

  function renderList() {
    var host = byId('ait-list');
    if (!host) return;
    if (!state.filtered.length) {
      host.innerHTML = '<div class="ait-empty" style="padding:40px 20px;text-align:center">' +
        escapeHtml(t('webui.ait_empty', '还没有 AI 任务记录')) + '</div>';
      return;
    }
    host.innerHTML = state.filtered.map(function (task) {
      var time = String(task.created_at || '').slice(5, 16).replace('T', ' ');
      // 一行从左到右：✎ → 标题 → 数据源 → 工具数 → 轮次 → 状态 → 时间
      return '<div class="ait-item' + (task.id === state.currentId ? ' active' : '') +
        '" data-task-id="' + escapeHtml(task.id) + '">' +
        '<button type="button" class="ait-rename-btn" data-rename="' + escapeHtml(task.id) +
        '" data-scope="list" title="' + escapeHtml(t('webui.ait_rename', '重命名')) + '">✎</button>' +
        '<div class="ait-item-msg" id="ait-msg-' + escapeHtml(task.id) + '">' +
        escapeHtml(taskTitle(task)) + '</div>' +
        '<div class="ait-item-meta">' +
        '<span>' + escapeHtml(task.datasource || t('webui.ait_unspecified', '未指定')) + '</span>' +
        '<span>🔧' + (task.step_count || 0) + '</span>' +
        (Number(task.round_count || 0) > 1
          ? '<span class="ait-badge round">' +
            escapeHtml(fmt(t('webui.ait_rounds_total', '{n} 轮'), task.round_count)) + '</span>' : '') +
        '<span class="ait-badge ' + escapeHtml(task.status || '') + '">' +
        escapeHtml(labelStatus(task.status)) + '</span>' +
        '<span>' + escapeHtml(time) + '</span>' +
        '</div></div>';
    }).join('');
  }

  function labelStatus(status) {
    if (status === 'done' || status === 'success') return t('webui.ait_status_done', '完成');
    if (status === 'error') return t('webui.ait_status_error', '失败');
    if (status === 'stopped') return t('webui.ait_status_stopped', '已中断');
    return t('webui.ait_status_running', '运行中');
  }

  function selectTask(taskId) {
    state.currentId = taskId;
    renderList();
    var host = byId('ait-detail');
    var empty = byId('ait-empty');
    if (!host) return;
    host.style.display = 'block';
    if (empty) empty.style.display = 'none';
    host.innerHTML = '<div class="ait-empty">' + escapeHtml(t('webui.ait_loading', '加载中…')) + '</div>';
    requestJson('/api/ai/tasks/' + encodeURIComponent(taskId)).then(function (body) {
      var task = (body && body.task) || null;
      if (!task) {
        host.innerHTML = '<div class="ait-empty">' +
          escapeHtml(t('webui.ait_not_found', '任务不存在')) + '</div>';
        return;
      }
      host.innerHTML = detailHtml(task);
      // 换任务时把右栏滚回顶部，否则接着看上一条的中间位置
      if (host.parentElement && host.parentElement.scrollTo) host.parentElement.scrollTo(0, 0);
      else if (host.parentElement) host.parentElement.scrollTop = 0;
    }).catch(function (failure) {
      host.innerHTML = '<div class="ait-empty">' +
        escapeHtml(t('webui.ait_load_failed', '加载失败') + ': ') +
        escapeHtml(failure.message || '') + '</div>';
    });
  }

  function detailHtml(task) {
    var steps = task.tool_steps || [];
    var html = '<div class="ait-detail-header">';
    html += '<div style="display:flex;align-items:flex-start;gap:8px">' +
      '<div class="ait-detail-msg" id="ait-detail-msg-' + escapeHtml(task.id) + '" style="flex:1">' +
      escapeHtml(taskTitle(task)) + '</div>' +
      '<button type="button" class="ait-rename-btn ait-detail-rename" data-rename="' +
      escapeHtml(task.id) + '" data-scope="detail" title="' +
      escapeHtml(t('webui.ait_rename', '重命名')) + '">✎</button></div>';
    html += '<div class="ait-detail-meta">' +
      '<span>📂 ' + escapeHtml(task.datasource || t('webui.ait_unspecified', '未指定')) + '</span>' +
      (task.db_type ? '<span>💾 ' + escapeHtml(task.db_type) + '</span>' : '') +
      '<span>⏱ ' + escapeHtml(String(task.created_at || '').replace('T', ' ').slice(0, 19)) + '</span>' +
      '<span>⌛ ' + escapeHtml(formatDuration(task.elapsed_ms) || '—') + '</span>' +
      '<span>🔄 ' + escapeHtml(fmt(t('webui.ait_rounds_total', '{n} 轮'), task.round_count || 0)) + '</span>' +
      '<span class="ait-badge ' + escapeHtml(task.status || '') + '">' +
      escapeHtml(labelStatus(task.status)) + '</span></div></div>';

    // 模型思考过程：默认收起（原始输出很长，用 details 折叠）
    if (task.thinking_content) {
      html += '<div class="ait-section-title">🧠 ' +
        escapeHtml(t('webui.ait_thinking_title', '模型思考过程')) + '</div>' +
        '<details class="ait-thinking"><summary>' +
        escapeHtml(t('webui.ait_thinking_hint', '点击展开查看模型原始思考输出')) +
        '</summary><pre>' + escapeHtml(task.thinking_content) + '</pre></details>';
    }
    if (task.understanding) {
      html += '<div class="ait-section-title">📋 ' +
        escapeHtml(t('webui.ait_plan_title', '预处理计划')) + '</div>' +
        '<div class="ait-understanding">' + escapeHtml(task.understanding) + '</div>';
    }
    if (steps.length) {
      html += '<div class="ait-section-title">🔧 ' +
        escapeHtml(fmt(t('webui.ait_timeline_count', '工具调用时间线（{n} 步）'), steps.length)) +
        '</div>' + timelineHtml(steps);
    }
    if (task.final_analysis) {
      html += '<div class="ait-section-title">📝 ' +
        escapeHtml(t('webui.ait_final_analysis', '最终分析')) + '</div>' +
        '<div class="ait-analysis">' + renderMarkdown(task.final_analysis) + '</div>';
    }
    html += '<button type="button" class="ait-del-btn" data-del="' + escapeHtml(task.id) +
      '">🗑 ' + escapeHtml(t('webui.ait_delete_task', '删除该任务记录')) + '</button>';
    return html;
  }

  function timelineHtml(steps) {
    var html = '<div class="ait-timeline">';
    steps.forEach(function (step, index) {
      var status = step.status || 'success';
      var round = Number(step.round || 0);
      html += '<div class="ait-step"><div class="ait-step-node' +
        (status === 'error' ? ' error' : '') + '">' + (index + 1) + '</div>' +
        '<div class="ait-step-card"><div class="ait-step-head">' +
        '<span class="ait-step-name">' + escapeHtml(step.tool || '') + '</span>' +
        (step.source === 'manual'
          ? '<span class="ait-badge manual" title="' +
            escapeHtml(t('webui.ait_manual_tip', '你在对话里点「执行」手动触发的 SQL')) + '">' +
            escapeHtml(t('webui.ait_manual', '手动执行')) + '</span>' : '') +
        '<span class="ait-step-badge ' + escapeHtml(status) + '">' +
        (status === 'success' || status === 'done' ? '✓' : status === 'error' ? '✗' : '⋯') + '</span>' +
        (round > 1 ? '<span class="ait-step-round">' +
          escapeHtml(fmt(t('webui.ait_round_label', '第{round}轮'), round)) + '</span>' : '') +
        '<span class="ait-step-dur">⏱ ' + escapeHtml(formatDuration(step.elapsed_ms)) + '</span>' +
        '</div>' + argsHtml(step) + resultHtml(step) + '</div></div>';
    });
    return html + '</div>';
  }

  /** SQL 直接铺出来（最常看），其余参数折进 details。 */
  function argsHtml(step) {
    var args = step.arguments || {};
    if (args.sql) return '<div class="ait-sql">' + escapeHtml(args.sql) + '</div>';
    var keys = Object.keys(args);
    if (!keys.length) return '';
    return '<details class="ait-step-args"><summary>📋 ' +
      escapeHtml(t('webui.ait_arguments', '参数')) + '</summary><pre>' +
      escapeHtml(JSON.stringify(args, null, 2)) + '</pre></details>';
  }

  function resultHtml(step) {
    var result = step.result;
    if (result === null || result === undefined) return '';
    var failed = step.status === 'error';
    var summary = (failed ? '✗ ' : '✓ ') + t('webui.ait_exec_result', '执行结果');
    var isSql = step.tool === 'execute_sql';
    var body = '';
    if (isSql && !failed && Array.isArray(result.columns) &&
        (Array.isArray(result.rows) || Array.isArray(result.preview_rows))) {
      var rows = Array.isArray(result.rows) ? result.rows : result.preview_rows;
      body = '<div class="ait-result-table-wrap"><table class="ait-result-table">' +
        headRow(result.columns) + '<tbody>' +
        (rows.length ? rows.map(rowBody).join('')
          : '<tr><td colspan="' + Math.max((result.columns || []).length, 1) +
            '" class="ait-empty-row">' + escapeHtml(t('webui.ait_no_data', '（无数据）')) + '</td></tr>') +
        '</tbody></table></div>';
      if (typeof result.total === 'number') {
        summary += '（' + fmt2(t('webui.ait_rows_summary', '共 {total} 行，显示前 {shown} 行'),
                              result.total, rows.length) + '）';
      }
    } else if (isSql && result && Array.isArray(result.statements)) {
      body = '<div class="ait-multi-summary"><table class="ait-result-table">' +
        '<thead><tr><th>#</th><th>' + escapeHtml(t('webui.ait_statement_col', '语句')) +
        '</th><th>' + escapeHtml(t('webui.ait_status_col', '状态')) + '</th><th>' +
        escapeHtml(t('webui.ait_rows_col', '行数')) + '</th></tr></thead><tbody>' +
        result.statements.map(function (item) {
          var ok = !!item.ok;
          return '<tr class="' + (ok ? '' : 'ait-row-error') + '"><td>' +
            escapeHtml(item.index || '') + '</td><td style="max-width:360px;white-space:pre-wrap">' +
            escapeHtml(item.sql || '') + '</td><td>' +
            (ok ? '✓ ' + t('webui.ait_ok', '成功')
                : '✗ ' + escapeHtml(item.error || t('webui.ait_failed', '失败'))) +
            '</td><td>' + (typeof item.total === 'number' ? item.total
              : (item.rows_count === undefined ? '' : item.rows_count)) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      summary += '（' + fmt2(t('webui.ait_multi_summary', '共 {count} 条，成功 {ok} 条'),
                            result.count || result.statements.length,
                            result.succeeded || 0) + '）';
    } else {
      var text = '';
      try {
        text = (result && result.error) ? String(result.error)
          : (typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      } catch (ignore) { text = String(result); }
      if (text.length > JSON_MAX) {
        text = text.slice(0, JSON_MAX) + t('webui.aias_truncated', '\n... (截断)');
      }
      body = '<pre>' + escapeHtml(text) + '</pre>';
    }
    return '<details class="ait-step-result"' + (failed ? ' open' : '') + '><summary>' +
      escapeHtml(summary) + '</summary>' + body + '</details>';
  }

  function headRow(columns) {
    return '<thead><tr>' + (columns || []).map(function (column) {
      return '<th>' + escapeHtml(column) + '</th>';
    }).join('') + '</tr></thead>';
  }

  function rowBody(row) {
    return '<tr>' + (row || []).map(function (cell) {
      return cell === null || cell === undefined
        ? '<td><span class="ait-null">NULL</span></td>'
        : '<td>' + escapeHtml(cell) + '</td>';
    }).join('') + '</tr>';
  }

  function renderMarkdown(text) {
    if (window.FusionAiAssistant && window.FusionAiAssistant.markdownToHtml) {
      return window.FusionAiAssistant.markdownToHtml(text);
    }
    return '<p>' + escapeHtml(text).replace(/\n/g, '<br>') + '</p>';
  }

  function bind() {
    var root = byId('page-ai-tasks');
    if (!root || root.dataset.bound === '1') return;
    root.dataset.bound = '1';
    var search = byId('ait-search');
    if (search) search.addEventListener('input', function () {
      clearTimeout(state.timer);
      state.timer = setTimeout(applyFilter, 300);   // 300ms 防抖：逐字打时不要每次都全量重筛
    });
    var refresh = byId('ait-refresh');
    if (refresh) refresh.addEventListener('click', loadTasks);
    var list = byId('ait-list');
    if (list) list.addEventListener('click', function (event) {
      var rename = event.target.closest('[data-rename]');
      if (rename) {
        event.stopPropagation();
        startRename(rename.getAttribute('data-rename'), rename.getAttribute('data-scope'));
        return;
      }
      var row = event.target.closest('[data-task-id]');
      if (row) selectTask(row.getAttribute('data-task-id'));
    });
    var detail = byId('ait-detail');
    if (detail) detail.addEventListener('click', function (event) {
      var rename = event.target.closest('[data-rename]');
      if (rename) {
        startRename(rename.getAttribute('data-rename'), rename.getAttribute('data-scope') || 'detail');
        return;
      }
      var del = event.target.closest('[data-del]');
      if (del) deleteTask(del.getAttribute('data-del'));
    });
  }

  function deleteTask(taskId) {
    if (!window.confirm(t('webui.ait_confirm_delete', '确定删除该任务记录？此操作不可恢复。'))) return;
    requestJson('/api/ai/tasks/' + encodeURIComponent(taskId), { method: 'DELETE' })
      .then(function (body) {
        if (body && body.ok === false) { notify((body && body.error) || t('webui.aias_delete_failed', '删除失败'), 'error'); return null; }
        if (state.currentId === taskId) {
          state.currentId = '';
          var host = byId('ait-detail');
          var empty = byId('ait-empty');
          if (host) host.style.display = 'none';
          if (empty) empty.style.display = 'block';
        }
        notify(t('webui.ait_deleted', '已删除'), 'success');
        return loadTasks();
      });
  }

  /** 行内改名：输入框 + 保存/取消两个按钮，Enter 保存、Esc 取消。 */
  function startRename(taskId, scope) {
    var isDetail = scope === 'detail';
    var target = byId(isDetail ? 'ait-detail-msg-' + taskId : 'ait-msg-' + taskId);
    if (!target) return;
    var task = findTask(taskId);
    var current = String((task && (task.title || task.user_message)) || target.textContent || '');
    target.innerHTML = '<input class="ait-rename-input" maxlength="200" value="' +
      escapeHtml(current) + '">' +
      '<div class="ait-rename-actions">' +
      '<button type="button" class="ait-rename-save">' +
      escapeHtml(t('webui.ait_save', '保存')) + '</button>' +
      '<button type="button" class="ait-rename-cancel">' +
      escapeHtml(t('webui.ait_cancel', '取消')) + '</button></div>';
    var input = target.querySelector('input');
    if (!input) return;
    input.focus();
    input.select();
    var restore = function () {
      target.textContent = scope === 'detail' ? taskTitle(task || { user_message: current }) : current;
    };
    var commit = function () {
      var value = String(input.value || '').trim();
      if (!value || value === current) { restore(); return; }
      requestJson('/api/ai/tasks/' + encodeURIComponent(taskId), { method: 'PATCH',
        body: JSON.stringify({ title: value }) })
        .then(function (body) {
          if (body && body.ok === false) { notify((body && body.error) || t('webui.aias_rename_failed', '重命名失败'), 'error'); return null; }
          return loadTasks();
        });
    };
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); commit(); }
      else if (event.key === 'Escape') { event.preventDefault(); restore(); }
    });
    Array.prototype.forEach.call(target.querySelectorAll('button'), function (button) {
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        if (button.classList.contains('ait-rename-save')) commit();
        else restore();
      });
    });
  }

  function findTask(taskId) {
    return state.tasks.filter(function (task) { return task.id === taskId; })[0] || null;
  }

  function enter() {
    bind();
    loadTasks();
  }

  window.FusionAiTasks = { enter: enter, reload: loadTasks, select: selectTask, state: state };
})();
