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

  // ── 三栏宽度：拖拽分隔条调整，宽度写入 CSS 变量并存 localStorage ──
  // 左栏/中栏定宽、主栏吃掉剩余空间，因此拖前两条分隔条即可分配三栏比例；
  // 主栏始终保留 MIN_MAIN，避免把预览区拖没。
  var COL_KEY = 'dbcheck.awrgen.cols.v1';
  var COL_DEFAULT = { side: 300, recent: 260 };
  var COL_LIMIT = { side: { min: 200, max: 460 }, recent: { min: 200, max: 480 } };
  var COL_MIN_MAIN = 360;

  function colWidths() {
    var root = byId('page-awr-gen');
    var out = { side: COL_DEFAULT.side, recent: COL_DEFAULT.recent };
    if (!root) return out;
    ['side', 'recent'].forEach(function (key) {
      var value = parseFloat(root.style.getPropertyValue('--awrg-' + key + '-w'));
      if (value > 0) out[key] = value;
    });
    return out;
  }

  function colSpace() {
    var wrap = document.querySelector('#page-awr-gen .awrg-wrap');
    if (!wrap) return 0;
    return wrap.clientWidth - 16 - 20;    // 去掉 .awrg-wrap 左右 padding 与两条 10px 分隔条
  }

  function clampCols(cols) {
    var total = colSpace();
    var side = Math.min(Math.max(cols.side, COL_LIMIT.side.min), COL_LIMIT.side.max);
    var recent = Math.min(Math.max(cols.recent, COL_LIMIT.recent.min), COL_LIMIT.recent.max);
    if (total > 0) {
      side = Math.min(side, Math.max(COL_LIMIT.side.min, total - recent - COL_MIN_MAIN));
      recent = Math.min(recent, Math.max(COL_LIMIT.recent.min, total - side - COL_MIN_MAIN));
    }
    return { side: Math.round(side), recent: Math.round(recent) };
  }

  function applyCols(cols) {
    var root = byId('page-awr-gen');
    if (!root) return;
    root.style.setProperty('--awrg-side-w', cols.side + 'px');
    root.style.setProperty('--awrg-recent-w', cols.recent + 'px');
  }

  function saveCols(cols) {
    try { localStorage.setItem(COL_KEY, JSON.stringify(cols)); } catch (e) {}
  }

  function restoreCols() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(COL_KEY) || 'null'); } catch (e) { saved = null; }
    if (!saved || typeof saved !== 'object') return;
    var cols = { side: COL_DEFAULT.side, recent: COL_DEFAULT.recent };
    if (isFinite(saved.side)) cols.side = Number(saved.side);
    if (isFinite(saved.recent)) cols.recent = Number(saved.recent);
    applyCols(clampCols(cols));
  }

  function commitCols(cols) {
    var applied = clampCols(cols);
    applyCols(applied);
    saveCols(applied);
    return applied;
  }

  function initResizers() {
    var wrap = document.querySelector('#page-awr-gen .awrg-wrap');
    if (!wrap || wrap.dataset.resizers === '1') return;
    wrap.dataset.resizers = '1';
    restoreCols();

    Array.prototype.forEach.call(wrap.querySelectorAll('[data-awrg-resize]'), function (handle) {
      var which = handle.getAttribute('data-awrg-resize');

      handle.addEventListener('pointerdown', function (event) {
        if (event.button != null && event.button !== 0) return;
        var startX = event.clientX;
        var base = clampCols(colWidths());
        var startWidth = base[which];
        handle.classList.add('awrg-resizing');
        document.body.classList.add('awrg-col-resizing');
        if (handle.setPointerCapture && event.pointerId != null) {
          try { handle.setPointerCapture(event.pointerId); } catch (e) {}
        }

        function onMove(moveEvent) {
          var next = { side: base.side, recent: base.recent };
          next[which] = startWidth + (moveEvent.clientX - startX);
          applyCols(clampCols(next));      // 拖动过程只改样式，松手才落盘
        }
        function onUp() {
          handle.classList.remove('awrg-resizing');
          document.body.classList.remove('awrg-col-resizing');
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onUp);
          saveCols(colWidths());
        }
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
        event.preventDefault();
      });

      // 键盘可达：←/→ 微调（Shift 加速），Home 恢复默认
      handle.addEventListener('keydown', function (event) {
        var step = event.shiftKey ? 40 : 12;
        var cols = clampCols(colWidths());
        if (event.key === 'ArrowLeft') cols[which] -= step;
        else if (event.key === 'ArrowRight') cols[which] += step;
        else if (event.key === 'Home') cols = { side: COL_DEFAULT.side, recent: COL_DEFAULT.recent };
        else return;
        event.preventDefault();
        commitCols(cols);
      });

      // 双击恢复该栏默认宽度
      handle.addEventListener('dblclick', function () {
        var cols = clampCols(colWidths());
        cols[which] = COL_DEFAULT[which];
        commitCols(cols);
      });
    });

    // 窗口变窄时重新收敛，避免主栏被挤成 0
    window.addEventListener('resize', function () { applyCols(clampCols(colWidths())); });
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

  function loadRecent(resetScroll) {
    return request('/api/awr/recent').then(function (body) {
      var host = byId('awrg-recent');
      if (!host) return;
      // 重渲染会丢掉列表的滚动位置：点开第 N 条报告时 showPreview() 会回调本函数，
      // 列表被打回顶部，用户只能重新往下翻。这里先记住 scrollTop，渲染后还原，
      // 并把当前选中项滚回可视区（切数据源/来源筛选时才复位到顶部）。
      var keepScroll = resetScroll ? 0 : host.scrollTop;
      var all = (body && body.files) || [];
      var dsSelect = byId('awrg-ds');
      var dsId = (dsSelect && dsSelect.value) || '';
      var src = (byId('awrg-source-filter') || {}).value || '';
      var manualAll = all.filter(function (f) { return f.manual; });
      var genPart = all.filter(function (f) { return !f.manual; });
      var genScoped = dsId
        ? genPart.filter(function (f) { return String(f.ds_id || '') === String(dsId); })
        : genPart;
      var files;
      if (src === 'upload') {
        files = manualAll;                       // 人工上传不联动数据源
      } else if (src === 'generate') {
        files = genScoped;
      } else {
        files = genScoped.concat(manualAll);     // 全部：生成的按数据源联动，上传的始终可见
      }
      state.recentFiles = files;
      if (state.currentId && !files.some(function (f) { return f.task_id === state.currentId; })) {
        state.currentId = '';
      }
      var manCount = files.filter(function (f) { return f.manual; }).length;
      var dsName = '';
      state.datasources.forEach(function (row) { if (String(row.id) === String(dsId)) dsName = row.name || ''; });
      text(byId('awrg-recent-count'),
           (dsName ? dsName + ' · ' : '') + files.length + ' 个' +
           (manCount ? '（人工上传 ' + manCount + '）' : ''));
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
        var incomplete = file.data_complete === false
          ? '<span class="awrg-badge-warn" title="兜底视图方案生成，数据集不完整">最小数据集</span>' : '';
        return '<div class="awrg-item' + (file.task_id === state.currentId ? ' active' : '') +
               '" data-awr-id="' + file.task_id + '" title="' + escapeText(title + '  ' + range) + '">' +
               '<input type="checkbox" class="awrg-check" data-check-id="' + file.task_id + '">' +
               '<div class="awrg-item-main">' +
               '  <div class="awrg-item-title">' + title + incomplete + '</div>' +
               '  <div class="awrg-item-range">' + range + '</div>' +
               '  <div class="awrg-item-sub">快照 ' + (file.snap_range || '—') + ' · ' +
                    Math.max(1, Math.round((file.size || 0) / 1024)) + 'KB · ' +
                    (file.modified || '') + '</div>' +
               '</div>' +
               '<button type="button" class="awrg-item-del" data-del-id="' + file.task_id +
               '" title="删除">×</button></div>';
      }).join('');
      host.scrollTop = keepScroll;
      if (keepScroll && state.currentId) {
        var active = host.querySelector('.awrg-item.active');
        if (active) {
          var hostRect = host.getBoundingClientRect();
          var itemRect = active.getBoundingClientRect();
          if (itemRect.top < hostRect.top) host.scrollTop -= (hostRect.top - itemRect.top);
          else if (itemRect.bottom > hostRect.bottom) host.scrollTop += (itemRect.bottom - hostRect.bottom);
        }
      }
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
          } else {
            var steps = status.steps || [];
            var cur = Number(status.current_step || 0);
            text(byId('awrg-progress'),
                 (steps[cur] || '正在生成 Word 报告…') +
                 (status.current_detail ? '\n' + status.current_detail : ''));
          }
        });
      }, 1500);
    });
  }

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // AI 面板正文：正常结论按 Markdown 渲染（标题/列表/表格），失败信息按纯文本转义
  function renderDiagnosis(box, value, isFailure) {
    if (!box) return;
    var content = String(value == null ? '' : value);
    if (isFailure || typeof window.renderMarkdown !== 'function') {
      box.innerHTML = escapeText(content);
      return;
    }
    box.innerHTML = window.renderMarkdown(content);
  }

  function runAiDiagnosis() {
    if (!state.currentId) return;
    var box = byId('awrg-ai-box');
    var frame = byId('awrg-frame');
    if (box) { box.style.display = ''; box.innerHTML = '<span class="awrg-hint">⏳ 正在调用 AI 诊断…</span>'; }
    if (frame) frame.style.display = 'none';
    request('/api/awr/ai_diagnosis/' + encodeURIComponent(state.currentId)).then(function (body) {
      if (!body || !body.ok) { renderDiagnosis(box, (body && body.error) || '诊断失败', true); return; }
      if (body.status === 'done') { renderDiagnosis(box, body.diagnosis || ''); return; }
      pollDiagnosis(body.diag_key);
    });
  }

  function pollDiagnosis(diagKey) {
    var box = byId('awrg-ai-box');
    return request('/api/awr/ai_diag_status/' + encodeURIComponent(diagKey)).then(function (body) {
      if (!body || !body.ok) { renderDiagnosis(box, '诊断任务不存在', true); return; }
      var partial = body.partial || '';
      var failed = body.status === 'error';
      if (body.status === 'running') {
        // 流式阶段：进度详情 + 已用时 + 逐步生成的内容 + 光标，并保持在底部可见
        var head = '<div class="awrg-ai-detail">⏳ ' + escapeText(body.detail || '') + '</div>' +
                   '<div class="awrg-hint">已用时 ' + Number(body.elapsed || 0) + ' 秒，正在生成内容…</div>';
        if (box) {
          box.innerHTML = head + '<div class="awrg-ai-body">' +
            (typeof window.renderMarkdown === 'function' ? window.renderMarkdown(partial) : escapeText(partial)) +
            '<span class="awrg-ai-caret">▍</span></div>';
          box.scrollTop = box.scrollHeight;
        }
      } else {
        renderDiagnosis(box, partial || (failed ? 'AI 诊断失败' : ''), failed);
        if (box) box.scrollTop = 0;
      }
      if (failed || body.status === 'done') return;
      setTimeout(function () { pollDiagnosis(diagKey); }, 1500);
    });
  }

  // 问 BIC-QA：把当前 AWR 的指标摘要脱敏后交外部知识库做四段式分析
  function askBicqa() {
    if (!state.currentId) return;
    var box = byId('awrg-ai-box');
    var frame = byId('awrg-frame');
    if (box) { box.style.display = ''; box.innerHTML = '<span class="awrg-hint">⏳ 正在解析 AWR 指标摘要并直传 BIC-QA 分析…</span>'; }
    if (frame) frame.style.display = 'none';
    request('/api/bicqa/awr', {
      method: 'POST',
      body: JSON.stringify({ task_id: state.currentId, dbtype: 'oracle' })
    }).then(function (body) {
      if (!box) return;
      if (body && body.ok && body.result) {
        var meta = body.meta || {};
        var head = [meta.db_name, meta.instance, meta.snap_range].filter(Boolean).join(' · ');
        var render = window.bicqaFourSegHtml;
        box.innerHTML = '<div class="awrg-ai-detail">🤖 BIC-QA AWR 分析' +
          (head ? ' <span class="awrg-hint">' + escapeText(head) + '</span>' : '') + '</div>' +
          (typeof render === 'function' ? render(String(body.result))
                                        : '<div class="awrg-ai-body">' + escapeText(body.result) + '</div>');
        box.scrollTop = 0;
        return;
      }
      if (body && body.error_code === 'BICQA_UNAVAILABLE') {
        box.innerHTML = '<div class="awrg-hint">BIC-QA 未启用或未配置 API Key。请前往 ' +
          '<a href="#" onclick="showPage(\'bicqa\');loadBicqaPage();return false">BIC-QA 知识库</a>' +
          ' 页配置后再试；未配置时不向外部发送任何数据。</div>';
        return;
      }
      renderDiagnosis(box, (body && (body.error || body.msg)) || '分析失败', true);
    }).catch(function (failure) {
      renderDiagnosis(box, '请求失败：' + (failure && failure.message), true);
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
    if (dsSelect) dsSelect.addEventListener('change', function () {
      loadSnapshots();
      loadRecent(true);      // 文件列表按数据源联动，换了数据源回到列表顶部
    });
    var daysSelect = byId('awrg-days');
    if (daysSelect) daysSelect.addEventListener('change', loadSnapshots);
    var sourceFilter = byId('awrg-source-filter');
    if (sourceFilter) sourceFilter.addEventListener('change', function () { loadRecent(true); });
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
    var bicqaButton = byId('awrg-bicqa');
    if (bicqaButton) bicqaButton.addEventListener('click', askBicqa);
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
    initResizers();
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
