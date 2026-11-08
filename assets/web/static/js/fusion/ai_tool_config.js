/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * Fusion page logic: AI 工具管理（#page-tool-mgmt）。
 * 负责工具清单的启停、编辑与新增：
 * 「启用 / 工具名 / 说明 / 分类 / 参数个数 / 内置·自定义 / 操作」七列，
 * 说明列截断并在 hover 时给全文，分类下拉按子串过滤，启停与保存后都回读列表。
 * 接口走 /api/ai/assistant/tools*。
 *
 * 归属：本页交互与实现思路属 fiyo (Jack Ge) <sdfiyon@gmail.com>（MIT License,
 * Copyright (c) 2025-2026 fiyo (Jack Ge)），品牌与标识归 DBCheck / RaccoonX 作者所有。
 *
 * 安全语义：内置工具只能停用不能删除；自定义工具只有定义、
 * 没有后端实现，且不在只读白名单里 —— 助手调用时会被边界直接拒绝，
 * 「改定义」不等于「给执行权」。
 *
 * 文案一律走 i18n，中英两份都补齐，不写死中文。
 */
(function () {
  'use strict';

  var state = { tools: [], categories: [], keyword: '', category: '', editing: null };

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
    if (kind === 'error') console.error('[tool-config] ' + message);
  }

  function loadTools() {
    return requestJson('/api/ai/assistant/tools').then(function (body) {
      state.tools = (body && body.tools) || [];
      var categories = (body && body.categories) || [];
      // categories 既可能是列表也可能是分类计数的对象，两种都吃
      state.categories = categories.length && categories.map ? categories : [];
      renderCategoryFilter();
      renderTable();
    }).catch(function (failure) {
      var host = byId('tool-table-body');
      if (host) host.innerHTML = '<tr><td colspan="7">' +
        escapeHtml(t('webui.tool_load_failed', '读取失败') + '：') +
        escapeHtml(failure.message || '') + '</td></tr>';
    });
  }

  function renderCategoryFilter() {
    var select = byId('tool-category-filter');
    if (!select) return;
    var categories = state.categories;
    if (categories && !Array.isArray(categories)) categories = Object.keys(categories);
    select.innerHTML = '<option value="">' +
      escapeHtml(t('webui.tool_all_categories', '全部分类')) + '</option>' +
      (categories || []).map(function (category) {
        return '<option value="' + escapeHtml(category) + '">' + escapeHtml(category) + '</option>';
      }).join('');
    select.value = state.category;
  }

  /** 参数个数：模型调用时要填几个参数，DBA 判断「这个工具好不好用」的第一眼信息。 */
  function parameterCount(tool) {
    var parameters = tool.parameters || {};
    var properties = parameters.properties || parameters;
    return Object.keys(properties || {}).length;
  }

  function visibleTools() {
    var needle = state.keyword.trim().toLowerCase();
    return state.tools.filter(function (tool) {
      // 分类用子串匹配：接口里的分类偶尔带前后缀，全等会把工具筛没
      if (state.category && String(tool.category || '').indexOf(state.category) < 0) return false;
      if (!needle) return true;
      return (tool.name + ' ' + (tool.description || '')).toLowerCase().indexOf(needle) >= 0;
    });
  }

  function renderTable() {
    var host = byId('tool-table-body');
    if (!host) return;
    var rows = visibleTools();
    var counter = byId('tool-count');
    if (counter) {
      counter.textContent = t('webui.tool_filtered_count', '筛选后 {shown} 个 / 共 {total} 个工具')
        .replace('{shown}', rows.length).replace('{total}', state.tools.length);
    }
    if (!rows.length) {
      host.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:28px">' +
        escapeHtml(t('webui.tool_none', '没有匹配的工具')) + '</td></tr>';
      return;
    }
    host.innerHTML = rows.map(function (tool) {
      var count = parameterCount(tool);
      return '<tr data-tool-name="' + escapeHtml(tool.name) + '">' +
        '<td><label class="tool-switch"><input type="checkbox" data-toggle="' +
          escapeHtml(tool.name) + '"' + (tool.enabled !== false ? ' checked' : '') + '></label></td>' +
        '<td><code>' + escapeHtml(tool.name) + '</code></td>' +
        '<td class="tool-desc" title="' + escapeHtml(tool.description || '') + '">' +
          escapeHtml(tool.description || '') + '</td>' +
        '<td><span class="tool-tag">' + escapeHtml(tool.category || t('webui.tool_custom', '自定义')) +
          '</span></td>' +
        '<td>' + count + ' ' + escapeHtml(t('webui.tool_params_unit', '个')) + '</td>' +
        '<td>' + (tool.is_custom
          ? '<span class="tool-tag custom">✦ ' + escapeHtml(t('webui.tool_custom', '自定义')) + '</span>'
          : '<span class="tool-tag builtin">📦 ' + escapeHtml(t('webui.tool_builtin', '内置')) + '</span>') +
          (tool.readonly
            ? '<span class="tool-tag ok">' + escapeHtml(t('webui.tool_readonly', '只读')) + '</span>'
            : '<span class="tool-tag warn">' +
              escapeHtml(t('webui.tool_would_reject', '会被拒绝')) + '</span>') + '</td>' +
        '<td class="tool-ops">' +
        '<button type="button" data-edit="' + escapeHtml(tool.name) + '">✏️ ' +
          escapeHtml(t('webui.tool_edit', '编辑')) + '</button>' +
        (tool.is_custom
          ? '<button type="button" class="is-danger" data-del="' + escapeHtml(tool.name) +
            '">🗑</button>'
          : '<span class="tool-builtin" title="' +
            escapeHtml(t('webui.tool_builtin_no_delete', '内置工具只能停用，不能删除')) + '">—</span>') +
        '</td></tr>';
    }).join('');
  }

  function toggleTool(name, enabled) {
    requestJson('/api/ai/assistant/tools', { method: 'POST',
      body: JSON.stringify({ name: name, enabled: enabled }) })
      .then(function (body) {
        if (!body || body.ok === false) {
          notify((body && body.error) || t('webui.tool_toggle_failed', '操作失败'), 'error');
          return loadTools();                     // 失败也要回读，别让开关和后端状态不一致
        }
        notify(enabled ? t('webui.tool_enabled_ok', '已启用，助手下次对话即可调用')
                       : t('webui.tool_disabled_ok', '已停用，会从模型的可用工具里消失'), 'success');
        return loadTools();                       // 启停后整表刷新，enabled 态与统计一起对齐
      });
  }

  function openEditor(tool) {
    var modal = byId('tool-edit-modal');
    if (!modal) return;
    state.editing = tool ? tool.name : '';
    modal.style.display = 'flex';
    var title = modal.querySelector('[data-editor-title]');
    if (title) {
      title.textContent = tool ? t('webui.tool_editor_edit', '编辑工具')
                               : t('webui.tool_editor_new', '新增工具');
    }
    field(modal, 'name').value = tool ? tool.name : '';
    // 内置工具的名字由代码注册，改不了；自定义工具可以改名前先删再建，这里保持禁用更安全
    field(modal, 'name').disabled = !!tool;
    field(modal, 'description').value = tool ? (tool.description || '') : '';
    field(modal, 'category').value = tool ? (tool.category || '') : t('webui.tool_custom', '自定义');
    field(modal, 'parameters').value = tool
      ? JSON.stringify(tool.parameters || {}, null, 2)
      : '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}';
    var enabledBox = modal.querySelector('[data-field="enabled"]');
    if (enabledBox) enabledBox.checked = !tool || tool.enabled !== false;
    Array.prototype.forEach.call(modal.querySelectorAll('[data-close-editor]'), function (closer) {
      closer.onclick = function () { modal.style.display = 'none'; };
    });
    var save = modal.querySelector('[data-save-tool]');
    if (save) save.onclick = function () { saveTool(modal); };
  }

  function field(modal, name) {
    return modal.querySelector('[data-field="' + name + '"]') || { value: '', checked: false };
  }

  function saveTool(modal) {
    var name = String(field(modal, 'name').value || '').trim().toLowerCase();
    var description = String(field(modal, 'description').value || '').trim();
    var category = String(field(modal, 'category').value || '').trim() || t('webui.tool_custom', '自定义');
    var parametersText = String(field(modal, 'parameters').value || '');
    var enabledBox = modal.querySelector('[data-field="enabled"]');
    var enabled = enabledBox ? !!enabledBox.checked : true;
    // 这两条校验是给 DBA 兜底的：空描述会让模型选错工具，非 object 的 schema 会让
    // 模型侧参数拼装直接失败。
    if (!name || !description) {
      notify(t('webui.tool_need_name_desc', '请填写工具名称和说明'), 'error');
      return;
    }
    var parameters;
    try {
      parameters = parametersText.trim() ? JSON.parse(parametersText) : {};
    } catch (failure) {
      notify(t('webui.tool_params_json_bad', '参数定义必须是合法 JSON') + '：' + failure.message, 'error');
      return;
    }
    if (!parameters || typeof parameters !== 'object' || parameters.type !== 'object') {
      notify(t('webui.tool_params_type_object', '参数定义必须包含 type: "object"'), 'error');
      return;
    }
    var request;
    if (state.editing) {
      request = requestJson('/api/ai/assistant/tools/' + encodeURIComponent(state.editing), {
        method: 'PUT', body: JSON.stringify({ description: description, category: category,
                                              parameters: parameters, enabled: enabled }) });
    } else {
      request = requestJson('/api/ai/assistant/tools', { method: 'POST',
        body: JSON.stringify({ name: name, description: description, category: category,
                               parameters: parameters, enabled: enabled }) });
    }
    request.then(function (body) {
      if (!body || body.ok === false) {
        notify((body && body.error) || t('webui.tool_save_failed', '保存失败'), 'error');
        return;
      }
      modal.style.display = 'none';
      notify(t('webui.tool_saved', '已保存') + ' · ' +
        t('webui.tool_saved_hint', '没有后端实现的工具只会被拒绝执行'), 'success');
      loadTools();                                 // 保存后回读整表，界面跟着后端走
    });
  }

  function removeTool(name) {
    if (!window.confirm(t('webui.tool_confirm_delete', '确定删除工具「{name}」？此操作不可恢复。')
      .replace('{name}', name))) return;
    requestJson('/api/ai/assistant/tools/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function (body) {
        if (!body || body.ok === false) {
          notify((body && body.error) || t('webui.tool_save_failed', '删除失败'), 'error');
          return;
        }
        notify(t('webui.tool_deleted', '已删除'), 'success');
        loadTools();
      });
  }

  function bind() {
    var root = byId('page-tool-mgmt');
    if (!root || root.dataset.bound === '1') return;
    root.dataset.bound = '1';
    var search = byId('tool-search');
    if (search) search.addEventListener('input', function () {
      state.keyword = search.value;
      renderTable();
    });
    var filter = byId('tool-category-filter');
    if (filter) filter.addEventListener('change', function () {
      state.category = filter.value;
      renderTable();
    });
    var body = byId('tool-table-body');
    if (body) body.addEventListener('change', function (event) {
      var toggle = event.target.closest('[data-toggle]');
      if (toggle) toggleTool(toggle.getAttribute('data-toggle'), toggle.checked);
    });
    if (body) body.addEventListener('click', function (event) {
      var edit = event.target.closest('[data-edit]');
      if (edit) {
        var name = edit.getAttribute('data-edit');
        openEditor(state.tools.filter(function (tool) { return tool.name === name; })[0] || null);
        return;
      }
      var del = event.target.closest('[data-del]');
      if (del) removeTool(del.getAttribute('data-del'));
    });
    var create = byId('tool-create-btn');
    if (create) create.addEventListener('click', function () { openEditor(null); });
    var reload = byId('tool-reload-btn');
    if (reload) reload.addEventListener('click', loadTools);
    document.addEventListener('keydown', function (event) {
      var modal = byId('tool-edit-modal');
      if (event.key === 'Escape' && modal && modal.style.display !== 'none') {
        modal.style.display = 'none';
      }
    });
  }

  function enter() {
    bind();
    loadTools();
  }

  window.FusionToolConfig = { enter: enter, reload: loadTools, state: state };
})();
