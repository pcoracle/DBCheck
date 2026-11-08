/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * AWR 在线生成页：数据源/快照区间 → 生成（轮询进度）→ 预览/下载/Word/AI 诊断；
 * 另含最近报告列表与 HTML 上传（复用目标端已有的 /api/awr/upload、/api/awr/report）。
 */
(function () {
  'use strict';

  var state = { currentId: '', snapshots: [], datasources: [], generating: false };

  function byId(id) { return document.getElementById(id); }
  function text(node, value) { if (node) node.textContent = value == null ? '' : String(value); }
  function request(url, options) {
    var opts = Object.assign({ credentials: 'same-origin' }, options || {});
    if (opts.body && !opts.headers) opts.headers = { 'Content-Type': 'application/json' };
    return fetch(url, opts).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok && !body.error) body.error = 'HTTP ' + response.status;
        return body;
      });
    });
  }
  function snapLabel(item) {
    return '#' + item.snap_id + '  ' + (item.end_time || item.begin_time || '') +
           (item.instance_number != null ? '  inst=' + item.instance_number : '');
  }

  function deleteReports(ids) {
    if (!ids || !ids.length) return;
    request('/api/awr/delete', { method: 'POST', body: JSON.stringify({ task_ids: ids }) })
      .then(function (body) {
        if (!body || !body.ok) { text(byId('awrg-progress'), (body && body.error) || '删除失败'); return; }
        if (ids.indexOf(state.currentId) >= 0) {
          state.currentId = '';
          var frame = byId('awrg-frame');
          if (frame) frame.src = 'about:blank';
          text(byId('awrg-current'), '未选择报告');
        }
        text(byId('awrg-progress'), '已删除 ' + (body.deleted || ids.length) + ' 份报告');
        loadRecent();
      })
      .catch(function (failure) { text(byId('awrg-progress'), '删除失败：' + (failure && failure.message)); });
  }

  function toggleMaximize() {
    var main = document.querySelector('#page-awr-gen .awrg-main');
    if (!main) return;
    var maximized = main.classList.toggle('awrg-maximized');
    var button = byId('awrg-maximize');
    if (button) button.textContent = maximized ? '还原' : '最大化';
  }

  function loadDatasources() {
    return request('/api/pro/datasources').then(function (body) {
      var rows = (body && (body.datasources || body.instances)) || [];
      state.datasources = rows.filter(function (row) {
        return String(row.db_type || '').toLowerCase().indexOf('oracle') >= 0;
      });
      var select = byId('awrg-ds');
      if (!select) return;
      if (!state.datasources.length) {
        select.innerHTML = '<option value="">（没有 Oracle 数据源）</option>';
        return;
      }
      // 按绑定目录分组显示（与数据源管理 / SQL 编辑器一致）
      var groups = {};
      state.datasources.forEach(function (row) {
        var dir = String(row.dir_path || '未分配');
        if (!groups[dir]) groups[dir] = [];
        groups[dir].push(row);
      });
      select.innerHTML = Object.keys(groups).sort().map(function (dir) {
        return '<optgroup label="' + dir + '">' +
          groups[dir].map(function (row) {
            return '<option value="' + row.id + '">' + (row.name || row.id) +
                   ' (' + (row.db_type || '') + ')</option>';
          }).join('') + '</optgroup>';
      }).join('');
      loadSnapshots();
    }).catch(function () {});
  }

  function loadSnapshots() {
    var select = byId('awrg-ds');
    var days = (byId('awrg-days') || {}).value || '7';
    if (!select || !select.value) return;
    text(byId('awrg-progress'), '正在读取快照…');
    return request('/api/awr/snapshots?ds_id=' + encodeURIComponent(select.value) +
                   '&days=' + encodeURIComponent(days)).then(function (body) {
      if (!body || !body.ok) { text(byId('awrg-progress'), (body && body.error) || '读取快照失败'); return; }
      state.snapshots = body.snapshots || [];
      var startSelect = byId('awrg-start');
      var endSelect = byId('awrg-end');
      var options = state.snapshots.map(function (item) {
        return '<option value="' + item.snap_id + '|' + item.instance_number + '">' + snapLabel(item) + '</option>';
      }).join('');
      if (startSelect) startSelect.innerHTML = options;
      if (endSelect) endSelect.innerHTML = options;
      if (state.snapshots.length > 1) {
        if (startSelect) startSelect.selectedIndex = 1;      // 倒数第二个（更早）
        if (endSelect) endSelect.selectedIndex = 0;          // 最新
      }
      text(byId('awrg-progress'), '共 ' + state.snapshots.length + ' 个快照');
    }).catch(function (failure) {
      text(byId('awrg-progress'), '读取快照失败：' + (failure && failure.message));
    });
  }

  function pollGenerate(taskId) {
    return request('/api/awr/generate_status/' + encodeURIComponent(taskId)).then(function (body) {
      if (!body || !body.ok) {
        text(byId('awrg-progress'), (body && body.error) || '任务不存在');
        state.generating = false;
        return;
      }
      var steps = body.steps || [];
      var current = Number(body.current_step || 0);
      var lines = steps.map(function (step, index) {
        var mark = index < current ? '✔' : (index === current ? '…' : '·');
        return mark + ' ' + step;
      });
      text(byId('awrg-progress'), lines.join('\n') + (body.current_detail ? '\n' + body.current_detail : ''));
      if (body.status === 'done') {
        state.generating = false;
        if (body.awr_task_id) { state.currentId = body.awr_task_id; showPreview(body.awr_task_id); loadRecent(); }
        text(byId('awrg-progress'), (lines.join('\n') || '完成') + '\n✅ 已生成');
        return;
      }
      if (body.status === 'error') {
        state.generating = false;
        text(byId('awrg-progress'), lines.join('\n') + '\n❌ ' + (body.error || '生成失败'));
        return;
      }
      setTimeout(function () { pollGenerate(taskId); }, 1500);
    }).catch(function () { setTimeout(function () { pollGenerate(taskId); }, 2500); });
  }

  function generate() {
    if (state.generating) return;
    var dsSelect = byId('awrg-ds');
    var startValue = ((byId('awrg-start') || {}).value || '').split('|');
    var endValue = ((byId('awrg-end') || {}).value || '').split('|');
    if (!dsSelect || !dsSelect.value || !startValue[0] || !endValue[0]) {
      text(byId('awrg-progress'), '请选择数据源与两个快照');
      return;
    }
    state.generating = true;
    var button = byId('awrg-generate');
    if (button) button.disabled = true;
    text(byId('awrg-progress'), '正在启动生成任务…');
    request('/api/awr/generate', {
      method: 'POST',
      body: JSON.stringify({
        ds_id: dsSelect.value,
        start_snap: Number(startValue[0]),
        end_snap: Number(endValue[0]),
        instance_number: Number(endValue[1] || 0) || null,
      })
    }).then(function (body) {
      if (button) button.disabled = false;
      if (!body || !body.ok) {
        state.generating = false;
        text(byId('awrg-progress'), (body && body.error) || '启动失败');
        return;
      }
      pollGenerate(body.task_id);
    }).catch(function (failure) {
      state.generating = false;
      if (button) button.disabled = false;
      text(byId('awrg-progress'), '启动失败：' + (failure && failure.message));
    });
  }

  function loadRecent() {
    return request('/api/awr/recent').then(function (body) {
      var host = byId('awrg-recent');
      if (!host) return;
      var files = (body && body.files) || [];
      state.recentFiles = files;
      if (!files.length) {
        host.innerHTML = '<div class="awrg-hint" style="padding:10px;">暂无报告</div>';
        return;
      }
      host.innerHTML = files.map(function (file) {
        var title = [file.ds_name || '', file.db_name || ''].filter(Boolean).join(' / ') ||
                    (file.manual ? '人工上传的报告' : 'AWR 报告');
        var range = file.begin_time
          ? (file.begin_time + ' → ' + (file.end_time || ''))
          : (file.manual ? '人工上传' : '生成于 ' + (file.modified || ''));
        return '<div class="awrg-item' + (file.task_id === state.currentId ? ' active' : '') +
               '" data-awr-id="' + file.task_id + '">' +
               '<input type="checkbox" class="awrg-check" data-check-id="' + file.task_id + '">' +
               '<div class="awrg-item-main">' +
               '  <div class="awrg-item-title">' + title + '</div>' +
               '  <div class="awrg-item-range">' + range + '</div>' +
               '  <div class="awrg-item-sub">快照 ' + (file.snap_range || '—') + ' · ' +
                    Math.max(1, Math.round((file.size || 0) / 1024)) + 'KB · ' +
                    (file.modified || '') + '</div>' +
               '</div>' +
               '<button type="button" class="awrg-item-del" data-del-id="' + file.task_id +
               '" title="删除">×</button></div>';
      }).join('');
    }).catch(function () {});
  }

  function showPreview(taskId) {
    state.currentId = taskId;
    var frame = byId('awrg-frame');
    var aiBox = byId('awrg-ai-box');
    if (aiBox) aiBox.style.display = 'none';
    if (frame) { frame.style.display = ''; frame.src = '/api/awr/preview/' + encodeURIComponent(taskId); }
    var current = null;
    (state.recentFiles || []).forEach(function (file) {
      if (file.task_id === taskId) current = file;
    });
    var label = current
      ? ([current.ds_name || '', current.db_name || ''].filter(Boolean).join(' / ') +
         (current.begin_time ? '  ' + current.begin_time + ' → ' + (current.end_time || '') : ''))
      : ('报告 ' + taskId);
    text(byId('awrg-current'), label);
    loadRecent();
  }

  function download() {
    if (state.currentId) window.open('/api/awr/download/' + encodeURIComponent(state.currentId), '_blank');
  }

  function buildWord() {
    if (!state.currentId) return;
    text(byId('awrg-progress'), '正在生成 Word 报告…');
    request('/api/awr/report/' + encodeURIComponent(state.currentId), { method: 'POST' }).then(function (body) {
      if (!body || !body.ok) { text(byId('awrg-progress'), (body && body.error) || 'Word 生成失败'); return; }
      var taskId = body.task_id;
      var timer = setInterval(function () {
        request('/api/awr/report_status/' + encodeURIComponent(taskId)).then(function (status) {
          if (!status || !status.ok) { clearInterval(timer); return; }
          if (status.status === 'done') {
            clearInterval(timer);
            text(byId('awrg-progress'), '✅ Word 已生成：' + (status.report_name || ''));
          } else if (status.status === 'error') {
            clearInterval(timer);
            text(byId('awrg-progress'), '❌ Word 生成失败：' + (status.error || ''));
          }
        });
      }, 1500);
    });
  }

  function runAiDiagnosis() {
    if (!state.currentId) return;
    var box = byId('awrg-ai-box');
    var frame = byId('awrg-frame');
    if (box) { box.style.display = ''; box.textContent = '正在诊断…'; }
    if (frame) frame.style.display = 'none';
    request('/api/awr/ai_diagnosis/' + encodeURIComponent(state.currentId)).then(function (body) {
      if (!body || !body.ok) { if (box) box.textContent = (body && body.error) || '诊断失败'; return; }
      if (body.status === 'done') { if (box) box.textContent = body.diagnosis || ''; return; }
      pollDiagnosis(body.diag_key);
    });
  }

  function pollDiagnosis(diagKey) {
    var box = byId('awrg-ai-box');
    return request('/api/awr/ai_diag_status/' + encodeURIComponent(diagKey)).then(function (body) {
      if (!body || !body.ok) { if (box) box.textContent = '诊断任务不存在'; return; }
      if (box) box.textContent = (body.partial || body.detail || '正在诊断…');
      if (body.status === 'done' || body.status === 'error') return;
      setTimeout(function () { pollDiagnosis(diagKey); }, 1500);
    });
  }

  function uploadFile(event) {
    var file = event && event.target && event.target.files && event.target.files[0];
    if (!file) return;
    var form = new FormData();
    form.append('file', file);
    text(byId('awrg-upload-status'), '正在上传并解析…');
    fetch('/api/awr/upload', { method: 'POST', credentials: 'same-origin', body: form })
      .then(function (response) { return response.json(); })
      .then(function (body) {
        if (!body || !body.ok) { text(byId('awrg-upload-status'), (body && body.error) || '上传失败'); return; }
        text(byId('awrg-upload-status'), '已上传：' + (body.filename || '') +
             ' · 识别 ' + (body.chapter_count || 0) + ' 个章节');
        loadRecent();
        showPreview(body.task_id);
      })
      .catch(function (failure) { text(byId('awrg-upload-status'), '上传失败：' + (failure && failure.message)); });
  }

  function bind() {
    var root = byId('page-awr-gen');
    if (!root || root.dataset.bound === '1') return;
    root.dataset.bound = '1';
    var generateButton = byId('awrg-generate');
    if (generateButton) generateButton.addEventListener('click', generate);
    var refreshButton = byId('awrg-refresh');
    if (refreshButton) refreshButton.addEventListener('click', loadRecent);
    var dsSelect = byId('awrg-ds');
    if (dsSelect) dsSelect.addEventListener('change', loadSnapshots);
    var daysSelect = byId('awrg-days');
    if (daysSelect) daysSelect.addEventListener('change', loadSnapshots);
    var previewButton = byId('awrg-preview');
    if (previewButton) previewButton.addEventListener('click', function () {
      if (state.currentId) showPreview(state.currentId);
    });
    var downloadButton = byId('awrg-download');
    if (downloadButton) downloadButton.addEventListener('click', download);
    var wordButton = byId('awrg-word');
    if (wordButton) wordButton.addEventListener('click', buildWord);
    var aiButton = byId('awrg-ai');
    if (aiButton) aiButton.addEventListener('click', runAiDiagnosis);
    var uploadButton = byId('awrg-upload-btn');
    var uploadInput = byId('awrg-upload');
    if (uploadButton && uploadInput) {
      uploadButton.addEventListener('click', function () { uploadInput.click(); });
    }
    if (uploadInput) uploadInput.addEventListener('change', uploadFile);
    var list = byId('awrg-recent');
    if (list) {
      list.addEventListener('click', function (event) {
        var del = event.target.closest('[data-del-id]');
        if (del) {
          event.stopPropagation();
          deleteReports([del.getAttribute('data-del-id')]);
          return;
        }
        if (event.target.closest('.awrg-check')) return;      // 勾选不触发预览
        var item = event.target.closest('[data-awr-id]');
        if (item) showPreview(item.getAttribute('data-awr-id'));
      });
    }
    var selectAll = byId('awrg-select-all');
    if (selectAll) selectAll.addEventListener('click', function () {
      var checks = document.querySelectorAll('#awrg-recent .awrg-check');
      var allChecked = Array.prototype.every.call(checks, function (input) { return input.checked; });
      Array.prototype.forEach.call(checks, function (input) { input.checked = !allChecked; });
    });
    var batchDelete = byId('awrg-batch-delete');
    if (batchDelete) batchDelete.addEventListener('click', function () {
      var ids = Array.prototype.map.call(
        document.querySelectorAll('#awrg-recent .awrg-check:checked'),
        function (input) { return input.getAttribute('data-check-id'); });
      if (!ids.length) { text(byId('awrg-progress'), '请先勾选要删除的报告'); return; }
      deleteReports(ids);
    });
    var maximize = byId('awrg-maximize');
    if (maximize) maximize.addEventListener('click', toggleMaximize);
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (document.querySelector('.awrg-main.awrg-maximized')) toggleMaximize();
    });
  }

  function enter() {
    bind();
    if (!state.datasources.length) loadDatasources(); else loadSnapshots();
    loadRecent();
  }

  window.FusionAwr = { enter: enter, state: state };
})();
