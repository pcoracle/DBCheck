/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * Fusion 独立前端模块：AI 巡检助手 SQL 占位符「槽位 / 选中即替换」UI。
 * 负责把回答里的占位符换成真实取值：
 * 文档级 contextmenu 拦截（仅代码块）、右键槽位面板（列表态 / 单值检索态）、
 * 候选检索、就地录入 + 实时插入预览、校验后再替换、撤销栈（Ctrl+Z）、
 * 恢复原 SQL、以及「选中一段 SQL 也能替换」的选区小菜单。
 *
 * 归属：本模块的交互与实现思路属 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * （MIT License, Copyright (c) 2025-2026 fiyo (Jack Ge)），品牌与标识归 DBCheck / RaccoonX 作者所有。
 *
 * 模块约定：
 * 1. 后端接口走 /api/ai/assistant/sql-*；
 * 2. 替换记录挂在宿主重渲染不丢的「SQL 指纹 data-sql-fp」上，
 *    afterRender 负责在助手流式重绘后把已替换的 SQL 贴回新节点；
 * 3. 所有函数收在本模块内，不污染 window 全局，交互用真实 DOM 节点 + 闭包监听，
 *    不用内联 onclick 全局函数；
 * 4. 数据源解析走适配器：优先 setDatasource(name)，否则读宿主
 *    FusionAiAssistant.state.defaultDatasource（防御式取值）。
 */
(function () {
  'use strict';

  // 廉价的「是否含占位符」判断（只做正则，不请求后端）——
  // 除标准尖括号/花括号写法外，还要认 AI 最常用的命名式占位符：
  // `WHERE tablespace_name = 'YOUR_TABLESPACE'`。加了 i 标志，你的/我的前缀大小写都认。
  var HINT_RE = new RegExp(
    "(['\"]?)<[^<>\\s]{1,40}>" +
    "|#[\\u4e00-\\u9fa5A-Za-z_][\\u4e00-\\u9fa5\\w]{0,39}#" +
    "|\\{\\{\\s*[\\u4e00-\\u9fa5A-Za-z_][\\u4e00-\\u9fa5\\w.]*\\s*\\}\\}" +
    "|\\$\\{[^}]+\\}" +
    "|\\[[\\u4e00-\\u9fa5][\\u4e00-\\u9fa5\\w]{0,19}\\]" +
    "|(?:your|my|our)_[a-z0-9_]{1,40}" +
    "|(?:tbd|todo|placeholder|replace[_-]?me|change[_-]?me|fill[_-]?me)" +
    "|待填|待替换|请填写|请替换|请补全", "i");   // i18n-fallback 识别模式，不是界面文案

  var CONTEXT_MAX = 4000;         // 传给后端的上下文正文上限
  var UNDO_MAX = 30;             // 每块撤销栈深度
  var SEARCH_DEBOUNCE = 220;     // 候选检索防抖
  var VERIFY_GUARD_MS = 8000;    // 校验兜底超时：接口挂了也不能把用户卡在「校验中」
  var TARGET_MAX = 400;          // 选区替换的最大目标长度

  var MENU_ID = 'aias-slot-menu';
  var SEL_MENU_ID = 'aias-sel-menu';

  var state = {
    datasource: '',
    overrides: {},       // data-sql-fp -> 已替换的 SQL 文本（重渲染后由 afterRender 贴回）
    ledgers: {},         // data-sql-fp -> {originalSql, slots, values}
    liveBlocks: {},      // data-sql-fp -> 当前 DOM 代码块（restoreOriginal / 就地刷新用）
    bound: false,        // 文档级监听是否已绑（幂等）
    current: null,       // 打开中的槽位面板状态
    selCurrent: null     // 打开中的选区替换状态
  };

  // ══════════════════════════════════════════════════════════
  // 基础工具（与宿主 ai_assistant.js 的口径对齐）
  // ══════════════════════════════════════════════════════════

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

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (data && typeof data === 'object') data.httpStatus = response.status;
        if (!response.ok && !data.error) data.error = 'HTTP ' + response.status;
        return data;
      });
    });
  }

  // SQL 文本指纹：与宿主 sqlFingerprint 逐字符一致，作为缺 data-sql-fp 时的兜底键。
  function sqlFingerprint(sql) {
    var normalized = String(sql || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 400);
    var hash = 5381;
    for (var index = 0; index < normalized.length; index += 1) {
      hash = ((hash << 5) + hash + normalized.charCodeAt(index)) >>> 0;
    }
    return hash.toString(16);
  }

  function hasClass(node, name) {
    return !!(node && node.classList && node.classList.contains(name));
  }

  function queryClass(root, cls) {
    if (!root || !root.querySelector) return null;
    try { return root.querySelector('.' + cls); } catch (ignore) { return null; }
  }

  function mk(tag, classes, text) {
    var node = document.createElement(tag);
    if (classes) {
      String(classes).split(/\s+/).forEach(function (name) {
        if (name && node.classList) node.classList.add(name);
      });
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clearChildren(node) {
    while (node.children && node.children.length) {
      node.removeChild(node.children[node.children.length - 1]);
    }
    if (node.innerHTML !== undefined) node.innerHTML = '';
  }

  function on(node, type, handler) {
    if (node && node.addEventListener) node.addEventListener(type, handler);
  }

  // 数据源适配器：优先显式 setDatasource，其次宿主会话默认数据源（防御式取值）。
  function currentDatasource() {
    if (state.datasource) return state.datasource;
    try {
      var host = window.FusionAiAssistant && window.FusionAiAssistant.state;
      if (host && host.defaultDatasource) return host.defaultDatasource;
    } catch (ignore) { /* 宿主未就绪 */ }
    return '';
  }

  // 取代码块文本：宿主把 SQL 作为纯文本塞进 <code>，textContent 即所见原文；
  // 兼容旧渲染把 \n 变 <br> 的情况（先还原换行，槽位 span 才不会错位）。
  function preText(pre) {
    var code = (pre && pre.querySelector) ? (pre.querySelector('code') || pre) : pre;
    if (!code) return '';
    if (code.textContent != null && String(code.textContent).indexOf('\n') >= 0) {
      return String(code.textContent);
    }
    if (code.innerHTML) {
      var html = String(code.innerHTML).replace(/<br\s*\/?>/gi, '\n');
      var box = document.createElement('div');
      box.innerHTML = html;
      if (box.textContent) return String(box.textContent);
    }
    return String(code.textContent == null ? '' : code.textContent);
  }

  function blockOf(pre) {
    if (!pre || !pre.closest) return null;
    try {
      // 代码块就是 <pre class="aias-code-pre aias-sql-pre"> 本身，
      // 执行栏是它的兄弟 .aias-sql-exec-wrap，没有 .aias-code-block 外壳。
      // 所以「块」= 这个 pre；旧外壳只在遇到历史 DOM（任务回溯等）时兜一下。
      var legacy = pre.closest('.aias-code-block');
      if (legacy) return legacy;
      var parent = pre.parentElement;
      if (parent && parent.querySelector && parent.querySelector('.aias-sql-exec-wrap')) return parent;
      return pre;
    } catch (ignore) { return null; }
  }

  /**
   * 块的身份。先看 pre 自己的 data-sql-id（拆分出来的子块就挂在这），
   * 再退到同层执行按钮上的 data-sql-id。这是台账/覆盖层的键。
   */
  function slotSqlId(pre) {
    if (!pre) return '';
    var own = pre.getAttribute ? (pre.getAttribute('data-sql-id') || '') : '';
    if (own) return own;
    var wrap = pre.parentElement;
    var execBtn = wrap && wrap.querySelector ? wrap.querySelector('.aias-sql-exec-btn') : null;
    return execBtn ? (execBtn.getAttribute('data-sql-id') || '') : '';
  }

  // 台账/覆盖层的键：统一走 ledgerKey（data-sql-id 优先，内容指纹只兜底）。
  // 用内容指纹当键会出两类事故：替换一次内容就换一个键（撤销栈、恢复按钮全断链），
  // 而同一段 SQL 在一页里出现两次时两个块共用一个键（在 A 块替换，B 块也被贴回）。
  function blockFingerprint(pre, originalSql) {
    return ledgerKey(pre, originalSql);
  }

  // 上下文正文：取该代码块所在回答（.aias-msg-text）的文本 —— 后端从这里收割推荐值。
  function contextTextOf(pre) {
    try {
      var box = (pre.closest && (pre.closest('.aias-msg-text') || pre.closest('.aias-drilldown-msg-content')))
        || pre.parentElement;
      return String(box && box.textContent ? box.textContent : '').slice(0, CONTEXT_MAX);
    } catch (ignore) { return ''; }
  }

  // ══════════════════════════════════════════════════════════
  // 台账（ledger）：原始 SQL（含占位符）+ 已选值分开存 → 替代后仍可再改、可还原。
  // 基线以「当前框里的文本」为准：只有当 当前文本 === 基线+已替换值 时台账才可信；
  // 不等说明中途被别处改写（AI 修复 / 选区替换），台账作废，绝不拿旧基线回写。
  // ══════════════════════════════════════════════════════════

  function autoRaw(slot, value) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return false;
    if (/^'[\s\S]*'$/.test(v) || /^"[\s\S]*"$/.test(v)) return true;             // 用户自带引号
    if (/^(null|sysdate|systimestamp|current_date|current_timestamp)\b/i.test(v)) return true;
    if (/^now\s*\(\s*\)$/i.test(v)) return true;
    if (/^[A-Za-z_][A-Za-z0-9_$.]*\s*\(/.test(v)) return true;                    // 函数调用
    if (/^[A-Za-z_][A-Za-z0-9_$.]*\s*[-+*/]/.test(v)) return true;                // SYSDATE-1
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(v)) return slot.value_kind === 'num';   // 纯数字仅数值列原样插
    return false;
  }

  function isRaw(slot, value) {
    if (slot && slot.raw_override !== undefined && slot.raw_override !== null) return !!slot.raw_override;
    return autoRaw(slot || {}, value);
  }

  // 值位置判定：槽位右边紧跟比较运算/IN/LIKE 且左邻是列名（col_ref）时，它填的是「取值」
  // 而不是「标识符」。`FROM <表名>` 是标识符位，不能加引号；`tablespace_name = #表空间#`、
  // `owner = :owner` 是值位，不加引号就直接 ORA-00904/ORA-00933。
  var VALUE_POS_RE = /(=\s*$|!=\s*$|<>\s*$|<=?\s*$|>=?\s*$|\blike\s+$|\bin\s*\(\s*$|,\s*$)/i;

  function isValuePosition(slot, sql) {
    if (!slot || !slot.col_ref) return false;
    var before = String(sql || '').slice(0, slot.start);
    return VALUE_POS_RE.test(before);
  }

  // 拼出替换文本：字面量 → 沿用原引号（需要时补一对）并转义；原样 → 一个字符都不动。
  function wrapWith(slot, value, raw, sql) {
    var v = String(value == null ? '' : value);
    if (raw) return v;
    // 只认 need_quote（且只对日期型置真）时，`= #表空间#` 会被替换成 `= SYSTEM`、
    // `owner = :owner` 替换成 `= DEMO_USER` —— 生成的 SQL 直接报错。这里补上「值位置补引号」，
    // 纯数字（阈值/容量类比较）仍按原样插，避免把 `> 90` 变成 `> '90'`。
    var numeric = /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(v);
    var q = slot.quote || ((slot.need_quote || (isValuePosition(slot, sql) && !numeric)) ? "'" : '');
    if (!q) return v;
    return q + v.split(q).join(q + q) + q;
  }

  function draftFrom(ledger) {
    var sql = ledger.originalSql;
    var slots = ledger.slots || [];
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      var v = ledger.values[s.name];
      if (!v) continue;
      // 判断「值位置」必须用基线原文：边替换边判断的话，前一条替换已经让 start 偏移了，
      // 后面的槽位就会拿错上下文，引号该加的没加。
      var rep = wrapWith(s, v.value, v.raw, ledger.originalSql);
      if (s.raw) sql = sql.split(s.raw).join(rep);
    }
    return sql;
  }

  function acquireLedger(fp, domText) {
    var led = state.ledgers[fp];
    if (led) {
      if (domText === draftFrom(led)) return led;                 // 台账自算的草稿 → 可信
      if (domText === led.originalSql) { led.values = {}; return led; } // 回到基线 → 值清空但仍可信
      delete state.ledgers[fp];                                    // 中途被改写 → 作废
    }
    led = { originalSql: domText, slots: [], values: {} };
    state.ledgers[fp] = led;
    return led;
  }

  // 台账对账：块被外部改写过 → 旧台账作废（返回 null），避免撤销回滚把好改动一起吃掉。
  function reconcileLedger(fp, domText) {
    var led = state.ledgers[fp];
    if (!led) return null;
    if (domText === draftFrom(led) || domText === led.originalSql) return led;
    delete state.ledgers[fp];
    return null;
  }

  // SQL 被外部改写（选区替换）时，把台账按新语句重建：仍能辨认的代入值还原回占位符 token。
  function rebaseLedger(fp, newSql) {
    var led = state.ledgers[fp];
    if (!led) return;
    var slots = led.slots || [];
    var newSlots = [];
    var newValues = {};
    var base = newSql;
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      var v = led.values[s.name];
      if (!v || !s.raw) continue;
      // 与 draftFrom 用同一份基线算出「当初替换成什么样」，否则值串对不上 → 台账被误丢
      var rep = wrapWith(s, v.value, v.raw, led.originalSql);
      if (!rep || base.indexOf(rep) === -1) continue;         // 该值已被改掉 → 无法映射 → 丢弃
      base = base.split(rep).join(s.raw);
      newValues[s.name] = v;
      newSlots.push(s);
    }
    state.ledgers[fp] = { originalSql: base, slots: newSlots, values: newValues };
  }

  // 写回：DOM 显示原文（textContent 自动转义），并按指纹存 override（重渲染不丢）。
  // 写块文本的唯一出口：DOM 文本 + 宿主的执行文本(data-raw-sql)/正文围栏一起改。
  // 少了后半段就会出现在界面上替换成功、点「执行 SQL」跑的还是带占位符的原句。
  function writeBlockText(block, text) {
    if (!block) return;
    var host = window.FusionAiAssistant;
    if (host && typeof host.setBlockSql === 'function') {
      host.setBlockSql(block, text, false);   // 面板正握着这个节点，不让宿主整段重绘
      return;
    }
    // 「块」就是 pre 本身（宿主不在时走这条本地兜底写回）：
    // 传进来的可能已经是 pre，也可能是旧的 .aias-code-block 外壳，两种都要认。
    var tag = String(block.tagName || '').toUpperCase();
    var pre = tag === 'PRE' ? block : (block.querySelector ? block.querySelector('pre') : null);
    var code = pre && pre.querySelector ? (pre.querySelector('code') || pre) : pre;
    if (code) code.textContent = text;
    // 执行文本一起改：只改 <code> 的话，界面上是新句、点「执行SQL」跑的还是占位符原句
    if (block.setAttribute) block.setAttribute('data-raw-sql', text);
    if (pre !== block && pre.setAttribute) pre.setAttribute('data-raw-sql', text);
  }

  function commit(pre, fp, newText) {
    var code = (pre && pre.querySelector) ? (pre.querySelector('code') || pre) : pre;
    var block = blockOf(pre) || pre;
    writeBlockText(block, newText);
    if (code && code.textContent !== newText) code.textContent = newText;
    state.overrides[fp] = newText;
    refreshRestoreEnabled(pre, fp);
  }

  function refreshRestoreEnabled(pre, fp) {
    var led = state.ledgers[fp];
    var n = led && led.values ? Object.keys(led.values).length : 0;
    // 撤销按钮刷的是 pre 里那个 .aias-pre-restore-btn，
    // 用 is-idle 类表达「现在没有可撤的替换」，title 里带上处数，按钮本身不禁用
    // （点了走「无替换可撤」的反馈分支，不禁用按钮是为了给得出这句反馈）。
    var host = pre && pre.querySelector ? pre : blockOf(pre);
    var inline = host && host.querySelector ? host.querySelector('.aias-pre-restore-btn') : null;
    if (inline) {
      inline.classList[n > 0 ? 'remove' : 'add']('is-idle');
      inline.title = n > 0
        ? t('webui.slot_restore_has', '撤销 ') + n +
          t('webui.slot_restore_unit', ' 处占位符替换（保留语句当前版本）')
        : t('webui.slot_restore_idle', '撤销占位符替换（当前没有替换记录）');
      inline.setAttribute('aria-label', t('webui.aias_restore_action', '撤销占位符替换'));
    }
    // 动作区若还挂着历史的「恢复原 SQL」按钮，存在就一起同步可用态。
    var block = blockOf(pre) || pre;
    var btn = block && block.querySelector ? block.querySelector('.aias-sql-restore-slot-btn') : null;
    if (!btn) return;
    btn.title = n > 0 ? t('webui.slot_restore_has', '撤销 ') + n + t('webui.slot_restore_unit', ' 处占位符替换（保留语句当前版本）')
                      : t('webui.slot_restore_idle', '撤销占位符替换（当前没有替换记录）');
    btn.disabled = n === 0;
  }

  /**
   * 块右上角「撤销占位符替换」按钮的实现入口（宿主把节点委托给这里）。
   * ★ 第一步必须先对账：这块被 AI 修复 / 方言改写动过 → 旧台账作废，此时「没有替换可撤」，
   *   只给反馈、**绝不回写旧基线** —— 回写会把刚修好的字段名和语法一起吃回去。
   * 有台账时也只撤「值」：values 清空 + 丢掉 raw_override，再按基线草稿写回，语句本身不动。
   */
  function restoreFromBlock(pre) {
    if (!pre) return;
    var fp = blockFingerprint(pre, preText(pre));
    var led = reconcileLedger(fp, preText(pre));
    var n = led && led.values ? Object.keys(led.values).length : 0;
    var btn = pre.querySelector ? pre.querySelector('.aias-pre-restore-btn') : null;
    if (!n) {
      refreshRestoreEnabled(pre, fp);
      if (btn) {
        btn.classList.add('done');
        setTimeout(function () { btn.classList.remove('done'); }, 1400);
      }
      if (state.current && state.current.pre === pre) {
        setNotice('<div class="aias-slot-verify">ℹ️ ' +
          t('webui.slot_restore_none', '当前没有可撤销的替换 —— SQL 语句保持现版本（不会被回滚）') +
          '</div>');
      }
      return;
    }
    led.values = {};
    if (led.slots) {
      for (var i = 0; i < led.slots.length; i += 1) delete led.slots[i].raw_override;
    }
    // 空 values 的 draftFrom == 基线原文：只把占位符 token 放回去，语句保持当前版本
    commit(pre, fp, draftFrom(led));
    refreshRestoreEnabled(pre, fp);
    if (btn) {
      var oldTitle = btn.title;
      btn.classList.add('done');
      btn.title = t('webui.slot_restore_done', '已撤销 ') + n +
        t('webui.slot_restore_done_tail', ' 处替换');
      setTimeout(function () { btn.classList.remove('done'); btn.title = oldTitle; }, 1400);
    }
    if (state.current && state.current.pre === pre) {
      state.current.led = led;
      setNotice('<div class="aias-slot-verify">↩️ ' +
        t('webui.slot_reverted_all', '已撤销全部') + ' ' + n + ' ' +
        t('webui.slot_reverted_tail', '处替换，占位符都回来了') + '</div>');
      renderPanel();
    }
  }

  /**
   * 整块被换成子块（拆分）后，旧台账连值一起作废。
   * 键是 data-sql-id，不删就会让子块认领到父块的替换记录。
   */
  function dropLedger(pre) {
    var fp = slotSqlId(pre) || blockFingerprint(pre, preText(pre));
    if (fp) delete state.ledgers[fp];
  }

  /**
   * **故意是空实现**。
   * 「⚠ 含占位符 · 右键替换」那条可见提示条已经取消，
   * 改由「选中文字 / 在代码块上右键」触发（见 handleContextMenu / openSelMenu）；
   * 调用点保留但不产生副作用，不要"顺手补一个提示条"。
   */
  function updateHint() { return; }

  // 在代码块动作区挂一个「恢复原 SQL」按钮（幂等）。宿主重渲染会重建 DOM，
  // afterRender 时按指纹重新贴 override 并重新挂按钮 —— 不改动宿主自有内容。
  // 撤销按钮 `.aias-pre-restore-btn` 通常由代码块 html 自带，这里只在
  // 遇到带 .aias-code-actions 的历史 DOM 时才补挂，其余情况只刷新可用态。
  function ensureRestoreButton(block, fp) {
    if (!block || !block.querySelector) return;
    var actions = block.querySelector('.aias-code-actions');
    var pre = block.matches && block.matches('pre') ? block
      : (block.querySelector ? block.querySelector('pre.aias-code-pre, pre.aias-sql-pre') : null);
    if (!actions) {
      refreshRestoreEnabled(pre || block, fp);
      return;
    }
    var btn = actions.querySelector('.aias-sql-restore-slot-btn');
    if (!btn) {
      btn = mk('button', 'aias-ibtn aias-sql-restore-slot-btn', t('webui.slot_restore_short', '恢复原 SQL'));
      btn.setAttribute('type', 'button');
      btn.setAttribute('aria-label', t('webui.slot_restore_btn', '撤销占位符替换'));
      btn.addEventListener('click', function () { restoreOriginal(fp); });
      actions.appendChild(btn);
    }
    var led = state.ledgers[fp];
    var n = led && led.values ? Object.keys(led.values).length : 0;
    btn.disabled = n === 0;
  }

  // ══════════════════════════════════════════════════════════
  // 撤销栈（Ctrl+Z）：每改一次值压一份快照，逐步回退。
  // ══════════════════════════════════════════════════════════

  function pushUndo(cur) {
    if (!cur) return;
    if (!cur.undo) cur.undo = [];
    cur.undo.push(JSON.stringify(cur.led.values || {}));
    if (cur.undo.length > UNDO_MAX) cur.undo.shift();
  }

  function undo() {
    var cur = state.current;
    if (!cur) return;
    if (!cur.undo || !cur.undo.length) {
      setNotice('<div class="aias-slot-verify warn">' + t('webui.slot_undo_empty', '已到最后一步，没有可回撤的操作') + '</div>');
      return;
    }
    var snap = cur.undo.pop();
    try { cur.led.values = JSON.parse(snap) || {}; } catch (ignore) { cur.led.values = {}; }
    commit(cur.pre, cur.fp, draftFrom(cur.led));
    setNotice('<div class="aias-slot-verify">↶ ' + t('webui.slot_undone_one', '已回撤一步') + '（' +
      t('webui.slot_undo_left', '还可回撤') + ' ' + cur.undo.length + ' ' + t('webui.slot_unit_steps', '步') + '）</div>');
    renderPanel();
  }

  function revertAll() {
    var cur = state.current;
    if (!cur) return;
    var n = Object.keys(cur.led.values || {}).length;
    if (!n) {
      setNotice('<div class="aias-slot-verify warn">' + t('webui.slot_none_replaced', '当前没有已替换的槽位') + '</div>');
      return;
    }
    pushUndo(cur);
    cur.led.values = {};
    for (var i = 0; i < cur.slots.length; i++) delete cur.slots[i].raw_override;
    commit(cur.pre, cur.fp, cur.led.originalSql);
    setNotice('<div class="aias-slot-verify">↩️ ' + t('webui.slot_reverted_all', '已撤销全部') + ' ' + n +
      ' ' + t('webui.slot_unit_ge', '处') + ' ' + t('webui.slot_reverted_tail', '替换，占位符都回来了') +
      '（' + t('webui.slot_ctrlz_hint', 'Ctrl+Z 可以撤回这一步') + '）</div>');
    renderPanel();
  }

  // 块的关键标识（data-sql-id 优先，退化到指纹）：与 blockFingerprint 同一套口径。
  /**
   * 台账/覆盖层的**唯一**键规则：
   *   1) pre 自己的 data-sql-id（拆分出来的子块就挂在这）；
   *   2) 同层执行按钮 .aias-sql-exec-btn 的 data-sql-id；
   *   3) 旧结构 .aias-code-block 的 data-sql-id / data-sql-fp；
   *   4) 都没有才退回内容指纹。
   * 一律走这个函数，别处再各自拼一遍就会出现「写进 A 键、贴回时查 B 键」的静默丢失。
   */
  function ledgerKey(node, fallbackSql) {
    if (!node) return '';
    var pre = node;
    if (!(node.matches && node.matches('pre')) && node.querySelector) {
      pre = node.querySelector('pre[data-sql-id]') || node.querySelector('pre') || node;
    }
    var id = slotSqlId(pre);
    if (id) return id;
    if (node.getAttribute) {
      id = node.getAttribute('data-sql-id') || node.getAttribute('data-sql-fp') || '';
      if (id) return id;
    }
    if (pre && pre.getAttribute && pre !== node) {
      id = pre.getAttribute('data-sql-fp') || '';
      if (id) return id;
    }
    return sqlFingerprint(fallbackSql !== undefined ? fallbackSql : preText(pre));
  }

  function blockKeyOf(block) {
    return ledgerKey(block);
  }

  function findBlock(key) {
    if (!key || !document.querySelector) return null;
    // 身份挂在 pre 上（拆分出来的子块也各自带 data-sql-id）
    return document.querySelector('pre[data-sql-id="' + key + '"]')
      || document.querySelector('.aias-code-block[data-sql-id="' + key + '"]')
      || document.querySelector('.aias-code-block[data-sql-fp="' + key + '"]');
  }

  // 恢复原 SQL：
  // 只撤「值」，语句本身保持现版本；清 override，把基线（占位符版）贴回。
  function restoreOriginal(fp) {
    if (!fp) return;
    var led = state.ledgers[fp];
    var live = state.liveBlocks[fp] || findBlock(fp);
    var n = led && led.values ? Object.keys(led.values).length : 0;
    if (!led) {
      if (live) {
        var raw = live.getAttribute ? (live.getAttribute('data-raw-sql') || '') : '';
        var code0 = live.querySelector ? (live.querySelector('pre code') || null) : null;
        if (code0 && raw) code0.textContent = raw;
      }
      delete state.overrides[fp];
      return;
    }
    if (led.values) led.values = {};
    if (led.slots) for (var i = 0; i < led.slots.length; i++) delete led.slots[i].raw_override;
    if (live) writeBlockText(live, led.originalSql);
    delete state.overrides[fp];
    delete state.ledgers[fp];
    if (state.current && state.current.fp === fp) {
      setNotice('<div class="aias-slot-verify">↩️ ' + t('webui.slot_reverted_all', '已撤销全部') + ' ' + n +
        ' ' + t('webui.slot_unit_ge', '处') + ' ' + t('webui.slot_reverted_tail', '替换，占位符都回来了') + '</div>');
      renderPanel();
    }
  }

  // 供宿主查询某指纹是否被替换过（宿主执行 SQL 时可据此改用替换后的语句）。
  function getSqlOverride(fp) {
    return (fp && state.overrides[fp]) || '';
  }

  // 助手流式重绘后调用：把已替换的 SQL 贴回新生成的代码块（只改 <code> 文本，不碰宿主自有内容）。
  // 选择器认 pre.aias-code-pre（代码块没有 .aias-code-block 外壳），
  // 顺带兼容旧外壳，避免任务回溯那种历史 DOM 断贴回。
  function afterRender(container) {
    if (!container || !container.querySelectorAll) return;
    var blocks;
    try {
      blocks = container.querySelectorAll(
        'pre.aias-code-pre[data-sql-id], pre.aias-sql-pre[data-sql-id], .aias-code-block.is-sql');
    } catch (ignore) { return; }
    Array.prototype.forEach.call(blocks, function (block) {
      var fp = blockKeyOf(block) || slotSqlId(block);
      if (!fp) return;
      state.liveBlocks[fp] = block;
      var override = state.overrides[fp];
      if (!override) { ensureRestoreButton(block, fp); return; }
      var pre = block.querySelector ? (block.querySelector('pre') || block) : block;
      var code = pre.querySelector ? (pre.querySelector('code') || pre) : null;
      // 宿主重绘出来的新节点文本可能还是原句：连执行文本一起贴回，点执行才跑替换后的 SQL
      if (code && code.textContent !== override) writeBlockText(block, override);
      ensureRestoreButton(block, fp);
    });
  }

  // ══════════════════════════════════════════════════════════
  // 槽位面板：aiasSlotOpen / aiasSlotRender / aiasSlotRefresh 的对应物
  // ══════════════════════════════════════════════════════════

  function closeMenu() {
    var menu = findNode(MENU_ID);
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    if (state.current && state.current.timer) clearTimeout(state.current.timer);
    state.current = null;
  }

  function closeAll() {
    closeMenu();
    closeSelMenu();
  }

  function findNode(id) {
    if (document.getElementById) {
      var byId = document.getElementById(id);
      if (byId) return byId;
    }
    // 兼容假 DOM：从 body 直接子节点里按 id 找
    var kids = (document.body && document.body.children) || [];
    for (var i = 0; i < kids.length; i++) if (kids[i].id === id) return kids[i];
    return null;
  }

  function placeMenu(menu, x, y) {
    if (!menu.style) return;
    menu.style.position = 'fixed';
    menu.style.left = '0px';
    menu.style.top = '0px';
    var w = menu.offsetWidth || 380;
    var h = menu.offsetHeight || 320;
    var vw = (typeof window.innerWidth === 'number') ? window.innerWidth : 1280;
    var vh = (typeof window.innerHeight === 'number') ? window.innerHeight : 800;
    menu.style.left = Math.max(8, Math.min(x, vw - w - 10)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, vh - h - 10)) + 'px';
  }

  function openForBlock(pre, x, y) {
    if (!pre) return;
    closeMenu();
    var domText = preText(pre);
    if (!domText || !domText.trim()) return;
    var fp = blockFingerprint(pre, domText);
    var ds = currentDatasource();
    var ctx = contextTextOf(pre);
    var led = acquireLedger(fp, domText);
    state.liveBlocks[fp] = blockOf(pre) || pre;

    var menu = mk('div', 'aias-slot-menu');
    menu.id = MENU_ID;
    menu.appendChild(mk('div', 'aias-slot-hint', '⏳ ' + t('webui.slot_recognizing', '正在识别占位符…')));
    document.body.appendChild(menu);
    placeMenu(menu, x, y);

    var focus = 0;
    for (var z = 0; z < (led.slots || []).length; z++) {
      if (!led.values[led.slots[z].name]) { focus = z; break; }
    }

    state.current = {
      pre: pre, fp: fp, led: led, ds: ds, ctx: ctx, menu: menu,
      slots: led.slots || [], mode: 'list', active: -1, timer: null,
      x: x, y: y, noticeHtml: '', pendingValue: '', pendingIndex: -1,
      candsHtml: '', keyword: '', undo: [], focusIndex: focus
    };

    post('/api/ai/assistant/sql-slots', { sql: led.originalSql, datasource_name: ds, context_text: ctx })
      .then(function (data) {
        var cur = state.current;
        if (!cur || cur.menu !== menu) return;
        if (!data || !data.ok) {
          clearChildren(menu);
          menu.appendChild(mk('div', 'aias-slot-err', '⚠️ ' + ((data && data.error) || t('webui.slot_identify_failed', '识别失败'))));
          return;
        }
        cur.slots = data.slots || [];
        cur.led.slots = cur.slots;
        if (!cur.slots.length) { renderEmpty(); return; }
        var fi = 0;
        for (var i = 0; i < cur.slots.length; i++) {
          if (!cur.led.values[cur.slots[i].name]) { fi = i; break; }
        }
        cur.focusIndex = fi;
        renderPanel();
        ensureRestoreButton(blockOf(pre), fp);
      })
      .catch(function (failure) {
        var cur = state.current;
        if (!cur || cur.menu !== menu) return;
        clearChildren(menu);
        menu.appendChild(mk('div', 'aias-slot-err', '⚠️ ' + t('webui.slot_net_fail', '请求失败：') +
          ((failure && failure.message) || t('webui.slot_net_error', '网络异常'))));
      });
  }

  function renderEmpty() {
    var cur = state.current;
    if (!cur) return;
    var menu = cur.menu;
    clearChildren(menu);
    menu.appendChild(headHtml(cur.slots.length));
    var hint = mk('div', 'aias-slot-hint');
    hint.appendChild(document.createTextNode(t('webui.slot_no_slot', '未发现占位符。')));
    hint.appendChild(mk('br'));
    hint.appendChild(document.createTextNode(t('webui.slot_support', '支持写法：') +
      t('webui.slot_support_examples', '<表名>、${db.schema}、{{table}}、#表名#、[表名]、:name')));
    menu.appendChild(hint);
    menu.appendChild(footerBar(false));
    placeMenu(menu, cur.x, cur.y);
  }

  // 面板头部：标题 + 计数 + 关闭（图标按钮）。计数带数据源，避免「在哪个库上校验」要回头找。
  function headHtml(total) {
    var cur = state.current;
    var done = 0;
    for (var i = 0; i < cur.slots.length; i++) if (cur.led.values[cur.slots[i].name]) done += 1;
    var head = mk('div', 'aias-slot-menu-head');
    head.appendChild(document.createTextNode('🔧 ' + t('webui.slot_title', 'SQL 占位符')));
    var count = t('webui.slot_count', '共') + ' ' + total + ' ' + t('webui.slot_unit', '个');
    if (done) count += ' · ' + t('webui.slot_replaced', '已替换') + ' ' + done + ' ' + t('webui.slot_unit', '个');
    count += ' · ' + (cur.ds || t('webui.slot_no_ds', '未选数据源'));
    head.appendChild(mk('span', 'aias-slot-count', count));
    var close = mk('button', 'aias-ibtn aias-slot-close', '✕');
    close.setAttribute('type', 'button');
    close.title = t('webui.slot_close', '关闭 (Esc)');
    on(close, 'click', closeMenu);
    head.appendChild(close);
    return head;
  }

  function toolbarHtml() {
    var cur = state.current;
    var done = 0;
    var pending = 0;
    for (var i = 0; i < cur.slots.length; i++) {
      if (cur.led.values[cur.slots[i].name]) done += 1;
      else if (cur.slots[i].suggest) pending += 1;
    }
    var tools = mk('div', 'aias-slot-tools');
    if (pending) {
      var applyAll = mk('button', 'aias-ibtn ok aias-slot-apply-all', '✦');
      applyAll.setAttribute('type', 'button');
      applyAll.title = t('webui.slot_tool_apply_all', '全部替换为推荐值') + '（' + pending + '）';
      on(applyAll, 'click', applyAllSuggested);
      tools.appendChild(applyAll);
    }
    if (done) {
      var undoAll = mk('button', 'aias-ibtn danger aias-slot-undo-all', '⟲');
      undoAll.setAttribute('type', 'button');
      undoAll.title = t('webui.slot_tool_undo_all', '撤销全部替换') + '（' + done + '）';
      on(undoAll, 'click', revertAll);
      tools.appendChild(undoAll);
    }
    var undoStep = mk('button', 'aias-ibtn aias-slot-undo', '↶');
    undoStep.setAttribute('type', 'button');
    undoStep.title = t('webui.slot_tool_undo', '撤销上一步') + ' (Ctrl+Z)';
    on(undoStep, 'click', undo);
    tools.appendChild(undoStep);
    tools.appendChild(mk('span', 'aias-slot-tools-gap'));
    tools.appendChild(mk('span', 'aias-slot-keys', t('webui.slot_keys', 'Enter 替换 · ↑↓ 切行 · Ctrl+Z 撤销')));
    return tools;
  }

  function noticeHost() {
    var cur = state.current;
    var host = queryClass(cur.menu, 'aias-slot-notice-host');
    if (!host) {
      host = mk('div', 'aias-slot-notice-host');
      host.id = 'aias-slot-notice';
    }
    return host;
  }

  function footerBar(isValue) {
    var bar = mk('div', 'aias-slot-actions');
    if (isValue) {
      var back = mk('button', '', '← ' + t('webui.slot_back', '返回'));
      back.setAttribute('type', 'button');
      on(back, 'click', backToList);
      bar.appendChild(back);
    }
    var close = mk('button', '', t('webui.slot_close', '关闭 (Esc)'));
    close.setAttribute('type', 'button');
    on(close, 'click', closeMenu);
    bar.appendChild(close);
    return bar;
  }

  function renderPanel() {
    var cur = state.current;
    if (!cur) return;
    var menu = cur.menu;
    clearChildren(menu);
    menu.appendChild(headHtml(cur.slots.length));
    menu.appendChild(toolbarHtml());
    var notice = noticeHost();
    clearChildren(notice);
    if (cur.noticeHtml) notice.innerHTML = cur.noticeHtml;
    menu.appendChild(notice);

    if (cur.mode === 'value') renderValueMode(menu);
    else renderListMode(menu);

    menu.appendChild(footerBar(cur.mode === 'value'));
    placeMenu(menu, cur.x, cur.y);
  }

  function renderListMode(menu) {
    var cur = state.current;
    var list = mk('div', 'aias-slot-list');
    cur.rows = [];
    cur.slots.forEach(function (slot, index) {
      var value = cur.led.values[slot.name];
      var row = mk('div', 'aias-slot-row' + (value ? ' is-done' : ''));
      row.setAttribute('data-i', String(index));

      var top = mk('div', 'aias-slot-rowtop');
      top.appendChild(mk('span', 'aias-slot-idx', String(index + 1)));
      var rawWrap = mk('span', 'aias-slot-raw');
      rawWrap.appendChild(mk('code', '', slot.raw || ''));
      if (slot.role_cn) rawWrap.appendChild(mk('span', 'aias-slot-role', slot.role_cn));
      if (slot.col_ref && (slot.role_cn || '').indexOf(slot.col_ref) < 0) {
        rawWrap.appendChild(mk('span', 'aias-slot-role', t('webui.slot_col_prefix', '列') + ' ' + slot.col_ref));
      }
      if (slot.bare) rawWrap.appendChild(mk('span', 'aias-slot-role', t('webui.slot_role_bare', '纯名')));
      top.appendChild(rawWrap);
      row.appendChild(top);

      var entry = mk('div', 'aias-slot-entry');
      var input = mk('input', 'aias-slot-entry-input');
      input.setAttribute('type', 'text');
      input.setAttribute('data-i', String(index));
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('spellcheck', 'false');
      // 就地录入：已替换的行预填当前值；否则预填推荐值 —— 打开即聚焦全选，直接改后回车即替换。
      input.value = value ? value.value : (slot.suggest || '');
      input.placeholder = t('webui.slot_input_placeholder', '输入取值后回车');
      on(input, 'input', function () { entryPreview(index); });
      on(input, 'keydown', function (ev) { entryKey(ev, index); });
      entry.appendChild(input);

      var mode = mk('button', 'aias-ibtn aias-slot-mode', value && value.raw ? '<>' : '“”');
      mode.setAttribute('type', 'button');
      on(mode, 'click', function () { toggleMode(index); });
      entry.appendChild(mode);

      var find = mk('button', 'aias-ibtn aias-slot-find', '🔍');
      find.setAttribute('type', 'button');
      find.title = t('webui.slot_find', '搜索候选');
      on(find, 'click', function () { pickSlot(index); });
      entry.appendChild(find);

      var revert = null;
      if (value) {
        revert = mk('button', 'aias-ibtn danger aias-slot-revert', '↩');
        revert.setAttribute('type', 'button');
        revert.title = t('webui.slot_revert_one', '撤销这一处替换');
        on(revert, 'click', function () { revertOne(index); });
        entry.appendChild(revert);
      }
      row.appendChild(entry);

      var preview = mk('div', 'aias-slot-preview');
      preview.setAttribute('data-i', String(index));
      row.appendChild(preview);

      if (slot.suggest && !value) {
        var sug = mk('div', 'aias-slot-sug');
        sug.appendChild(document.createTextNode(t('webui.slot_recommended', '推荐：')));
        var sugBtn = mk('button', 'aias-slot-sug-btn', slot.suggest);
        sugBtn.setAttribute('type', 'button');
        sugBtn.setAttribute('data-i', String(index));
        sugBtn.setAttribute('data-v', slot.suggest);
        on(sugBtn, 'click', function () { applyChecked(index, slot.suggest); });
        sug.appendChild(sugBtn);
        row.appendChild(sug);
      }

      list.appendChild(row);
      cur.rows.push({ slot: slot, input: input, preview: preview, mode: mode, row: row });
    });
    menu.appendChild(list);

    // 列表态：接上就地录入（预览 + 回车替换 + 方向键切行 + Ctrl+Z 撤销）
    for (var m = 0; m < cur.slots.length; m++) entryPreview(m);
    var fi = (cur.focusIndex == null) ? 0 : cur.focusIndex;
    if (fi < 0) fi = 0;
    var target = cur.rows[fi] || cur.rows[0];
    if (target && target.input) {
      try {
        target.input.focus();
        if (target.input.value && target.input.select) target.input.select();
      } catch (ignore) { /* 假 DOM 无焦点 */ }
    }
    cur.focusIndex = -1;
  }

  function entryPreview(index) {
    var cur = state.current;
    if (!cur || !cur.rows) return;
    var ref = cur.rows[index];
    if (!ref) return;
    var slot = ref.slot;
    var v = ref.input ? String(ref.input.value || '').trim() : '';
    var raw = v ? isRaw(slot, v) : (slot.raw_override === true);
    if (ref.mode) {
      ref.mode.textContent = raw ? '<>' : '“”';
      ref.mode.className = '';
      ref.mode.classList.add('aias-ibtn');
      ref.mode.classList.add('aias-slot-mode');
      if (raw) ref.mode.classList.add('raw');
      ref.mode.title = raw ? t('webui.slot_mode_raw', '插入方式：原样') : t('webui.slot_mode_literal', '插入方式：字面量');
    }
    if (!ref.preview) return;
    clearChildren(ref.preview);
    if (!v) return;
    var applied = cur.led.values[slot.name];
    if (applied && applied.value === v) return;
    var pv = wrapWith(slot, v, isRaw(slot, v), cur.led.originalSql);
    if (pv === v) return;
    ref.preview.appendChild(document.createTextNode(t('webui.slot_will_insert', '将插入：')));
    ref.preview.appendChild(mk('b', '', pv));
  }

  function entryKey(ev, index) {
    var cur = state.current;
    if (!cur) return;
    var key = ev.key;
    if (key === 'Enter') {
      ev.preventDefault && ev.preventDefault();
      var v = String((ev.target && ev.target.value) || '').trim();
      if (v) applyChecked(index, v);
      else revertOne(index);
    } else if (key === 'Escape') {
      ev.preventDefault && ev.preventDefault();
      closeMenu();
    } else if (key === 'ArrowDown' || key === 'ArrowUp') {
      ev.preventDefault && ev.preventDefault();
      moveFocus(index, key === 'ArrowDown' ? 1 : -1);
    } else if ((ev.ctrlKey || ev.metaKey) && (key === 'z' || key === 'Z')) {
      ev.preventDefault && ev.preventDefault();
      undo();
    }
  }

  function moveFocus(index, delta) {
    var cur = state.current;
    if (!cur || !cur.rows || !cur.rows.length) return;
    var j = Math.min(cur.rows.length - 1, Math.max(0, index + delta));
    var ref = cur.rows[j];
    if (ref && ref.input) {
      try {
        ref.input.focus();
        if (ref.input.value && ref.input.select) ref.input.select();
      } catch (ignore) { /* 假 DOM 无焦点 */ }
    }
  }

  function toggleMode(index) {
    var cur = state.current;
    if (!cur) return;
    var slot = cur.slots[index];
    if (!slot) return;
    var ref = cur.rows && cur.rows[index];
    var v = ref && ref.input ? String(ref.input.value || '').trim() : '';
    pushUndo(cur);
    slot.raw_override = !isRaw(slot, v);
    if (cur.led.values[slot.name]) {
      cur.led.values[slot.name].raw = slot.raw_override;
      commit(cur.pre, cur.fp, draftFrom(cur.led));
    }
    renderPanel();
    if (ref && ref.input) { try { ref.input.focus(); } catch (ignore) {} }
  }

  function setValue(index, value, raw) {
    var cur = state.current;
    if (!cur || index < 0) return;
    var slot = cur.slots[index];
    if (!slot) return;
    value = (value == null) ? '' : String(value).trim();
    if (!value) return;
    pushUndo(cur);
    cur.led.values[slot.name] = { value: value, raw: !!raw };
    commit(cur.pre, cur.fp, draftFrom(cur.led));
    setNotice('');
    cur.focusIndex = nextEmpty(index);
    renderPanel();
    ensureRestoreButton(blockOf(cur.pre), cur.fp);
  }

  function applyOne(index, value) {
    var cur = state.current;
    if (!cur) return;
    var slot = cur.slots[index];
    if (!slot) return;
    setValue(index, value, isRaw(slot, value));
  }

  function revertOne(index) {
    var cur = state.current;
    if (!cur) return;
    var slot = cur.slots[index];
    if (!slot) return;
    if (!cur.led.values[slot.name]) return;      // 本来就没替换 → 别污染撤销栈
    pushUndo(cur);
    delete cur.led.values[slot.name];
    delete slot.raw_override;
    commit(cur.pre, cur.fp, draftFrom(cur.led));
    setNotice('');
    cur.focusIndex = index;
    renderPanel();
    ensureRestoreButton(blockOf(cur.pre), cur.fp);
  }

  function nextEmpty(from) {
    var cur = state.current;
    if (!cur || !cur.slots.length) return from;
    for (var k = 1; k <= cur.slots.length; k++) {
      var idx = (from + k) % cur.slots.length;
      if (!cur.led.values[cur.slots[idx].name]) return idx;
    }
    return from;
  }

  function applyAllSuggested() {
    var cur = state.current;
    if (!cur) return;
    var pending = [];
    for (var i = 0; i < cur.slots.length; i++) {
      var s = cur.slots[i];
      if (!s.suggest || cur.led.values[s.name]) continue;
      pending.push(s);
    }
    if (!pending.length) return;
    pushUndo(cur);                                // 整批算一步，Ctrl+Z 一次撤回
    for (var j = 0; j < pending.length; j++) {
      var sj = pending[j];
      cur.led.values[sj.name] = { value: sj.suggest, raw: isRaw(sj, sj.suggest) };
    }
    cur.focusIndex = -1;
    commit(cur.pre, cur.fp, draftFrom(cur.led));
    setNotice('<div class="aias-slot-verify">✅ ' + t('webui.slot_replaced_n', '已替换') + ' ' + pending.length +
      ' ' + t('webui.slot_unit_ge', '处') + ' ' + t('webui.slot_replaced_tail', '占位符。要改就在对应行输入框里直接改后回车；要退回点该行撤销图标，或按 Ctrl+Z 逐步回撤。') + '</div>');
    renderPanel();
    ensureRestoreButton(blockOf(cur.pre), cur.fp);
  }

  // 字段值：先校验「这个值在该列里真的存在吗」再决定是否替换。没有这一步，
  // status = 'ACTIVEE' 会静默返回 0 行，用户分不清填错还是真没数据。
  function applyChecked(index, value) {
    var cur = state.current;
    if (!cur || index < 0) return;
    var slot = cur.slots[index];
    if (!slot) return;
    value = (value == null) ? '' : String(value).trim();
    if (!value) return;
    if (!slot.value_like) { applyOne(index, value); return; }   // 对象类角色没有「取值」概念，直接替换
    if (!cur.ds) {
      applyOne(index, value);
      setNotice('<div class="aias-slot-verify">ℹ️ ' + t('webui.slot_verify_unconfirmed',
        '已替换；当前未选择数据源，本次未做取值校验') + '</div>');
      return;
    }
    if (isRaw(slot, value)) {
      applyOne(index, value);
      setNotice('<div class="aias-slot-verify">ℹ️ ' + t('webui.slot_verify_raw',
        '已按原样插入（表达式/多值不加引号），未做取值校验') + '</div>');
      return;
    }
    cur.pendingValue = value;
    cur.pendingIndex = index;
    setNotice('<div class="aias-slot-verify">⏳ ' + t('webui.slot_verifying', '正在校验该取值…') + '</div>');
    // 校验只允许「一次落地」：超时兜底与 fetch 回调谁先到谁生效，另一个直接放弃。
    var landed = false;
    function claim() { if (landed) return false; landed = true; return true; }
    var guard = setTimeout(function () {
      if (!claim()) return;
      if (!state.current || state.current !== cur) return;
      applyOne(index, value);
      setNotice('<div class="aias-slot-verify warn">ℹ️ ' + t('webui.slot_verify_timeout',
        '取值校验超时，已按你输入的值替换 —— 未确认该取值是否存在') + '</div>');
    }, VERIFY_GUARD_MS);

    post('/api/ai/assistant/sql-slot-verify', {
      datasource_name: cur.ds,
      // 校验用的 SQL 传「基线 SQL」：占位符在 FROM 之外，不影响定位表/列且稳定。
      sql: cur.led.originalSql,
      slot: { name: slot.name, role: slot.role, col_ref: slot.col_ref || '' },
      value: value
    }).then(function (data) {
      if (!claim()) return;
      clearTimeout(guard);
      if (!state.current || state.current !== cur) return;
      if (!data || data.ok === false) {
        // 后端明确失败：仍按用户输入替换（不堵死流程），但把错误显示到提示区。
        applyOne(index, value);
        setNotice('<div class="aias-slot-verify warn">⚠️ ' + t('webui.slot_verify_failed', '校验失败：') +
          escapeText((data && data.error) || t('webui.slot_verify_unknown', '该取值无法校验')) + '</div>');
        return;
      }
      var check = (data.checks || [])[0] || null;
      if (!check || check.exists === null || check.exists === undefined) {
        applyOne(index, value);      // 没能定位表/列 → 不阻塞，直接替换
        if (check && check.reason) {
          setNotice('<div class="aias-slot-verify warn">ℹ️ ' + escapeText(check.reason) + '</div>');
        }
        return;
      }
      if (check.exists === false) {
        var html = '<div class="aias-slot-verify warn">⚠️ ' +
          escapeText(check.reason || t('webui.slot_verify_not_exist', '该取值不存在')) + '</div>';
        var picks = check.candidates || check.similar || [];
        if (picks.length) {
          html += '<div class="aias-slot-verify-picks">' + t('webui.slot_verify_suggest', '是否想用：');
          for (var k = 0; k < picks.length && k < 5; k++) {
            html += '<button type="button" data-i="' + index + '" data-v="' + escapeAttr(picks[k]) + '">' +
              escapeText(picks[k]) + '</button>';
          }
          html += '</div>';
        }
        html += '<div class="aias-slot-verify-picks"><button type="button" class="aias-slot-force">' +
          t('webui.slot_force', '仍然使用') + '「' + escapeText(value) + '」</button></div>';
        setNotice(html);
        bindNoticePicks(index);
        return;
      }
      applyOne(index, value);       // 存在（或只是时间阈值提示）→ 替换
      if (check.warning) setNotice('<div class="aias-slot-verify warn">ℹ️ ' + escapeText(check.reason || '') + '</div>');
    }).catch(function () {
      if (!claim()) return;
      clearTimeout(guard);
      applyOne(index, value);
    });
  }

  // 「不存在」时的相似候选 + 强行使用按钮（校验只是提示，不能把手工应用堵死）
  function bindNoticePicks(index) {
    var cur = state.current;
    if (!cur) return;
    var host = queryClass(cur.menu, 'aias-slot-notice-host');
    if (!host || !host.querySelectorAll) return;
    var buttons = host.querySelectorAll('button');
    Array.prototype.forEach.call(buttons, function (button) {
      var v = button.getAttribute('data-v');
      if (v !== null && v !== undefined) {
        on(button, 'click', function () { applyChecked(index, v); });
      }
    });
    var force = queryClass(host, 'aias-slot-force');
    if (force) on(force, 'click', function () { forceApply(index); });
  }

  function forceApply(index) {
    var cur = state.current;
    if (!cur || !cur.pendingValue) return;
    var i = (index == null || index < 0) ? (cur.pendingIndex < 0 ? cur.active : cur.pendingIndex) : index;
    if (i < 0) return;
    var v = cur.pendingValue;
    cur.pendingValue = '';
    setNotice('');
    // 这里不能把 raw_override 设成 true：用户是「就算不存在也照我写的插」，该加引号还是要加。
    applyOne(i, v);
  }

  function escapeText(value) { return String(value == null ? '' : value); }
  function escapeAttr(value) { return String(value == null ? '' : value).replace(/"/g, '&quot;'); }

  // 只更新提示区，不重绘整个菜单（保住输入框焦点与已输入内容）
  function setNotice(html) {
    var cur = state.current;
    if (!cur) return;
    cur.noticeHtml = html || '';
    var host = queryClass(cur.menu, 'aias-slot-notice-host');
    if (host) { host.innerHTML = cur.noticeHtml; }
  }

  // ── 单槽位值模式（aiasSlotPick / aiasSlotSearch / 候选列表）──
  function pickSlot(index) {
    var cur = state.current;
    if (!cur) return;
    cur.mode = 'value';
    cur.active = index;
    cur.keyword = '';
    cur.candsHtml = '';
    renderPanel();
    searchCandidates('');
  }

  function backToList() {
    var cur = state.current;
    if (!cur) return;
    cur.mode = 'list';
    cur.active = -1;
    renderPanel();
  }

  function renderValueMode(menu) {
    var cur = state.current;
    var slot = cur.slots[cur.active] || {};
    var list = mk('div', 'aias-slot-list');
    var top = mk('div', 'aias-slot-rowtop');
    var rawWrap = mk('span', 'aias-slot-raw');
    rawWrap.appendChild(mk('code', '', slot.raw || ''));
    if (slot.role_cn) rawWrap.appendChild(mk('span', 'aias-slot-role', slot.role_cn));
    if (slot.bare) rawWrap.appendChild(mk('span', 'aias-slot-role', t('webui.slot_pure_obj', '纯对象名')));
    top.appendChild(rawWrap);
    list.appendChild(top);

    var search = mk('input', 'aias-slot-search');
    search.setAttribute('type', 'text');
    search.placeholder = slot.value_like
      ? t('webui.slot_search_placeholder', '搜索该列的真实取值；或直接输入值后回车')
      : t('webui.slot_search_placeholder_obj', '搜索候选；或直接输入值后回车');
    search.value = cur.keyword || '';
    on(search, 'input', function () { searchCandidates(search.value); });
    on(search, 'keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault && ev.preventDefault();
        var v = String(search.value || '').trim();
        if (v) applyChecked(cur.active, v);
      } else if (ev.key === 'Escape') {
        ev.preventDefault && ev.preventDefault();
        backToList();
      }
    });
    list.appendChild(search);
    cur.searchInput = search;

    var cands = mk('div', 'aias-slot-cands');
    cands.id = 'aias-slot-cands';
    if (cur.candsNodes && cur.candsNodes.length) {
      cur.candsNodes.forEach(function (node) { cands.appendChild(node); });
    } else {
      cands.appendChild(mk('div', 'aias-slot-hint', t('webui.slot_cand_hint', '输入关键词开始检索…')));
    }
    list.appendChild(cands);
    cur.candsHost = cands;
    menu.appendChild(list);

    try { search.focus(); } catch (ignore) { /* 假 DOM 无焦点 */ }
  }

  function searchCandidates(kw) {
    var cur = state.current;
    if (!cur) return;
    cur.keyword = kw || '';
    var slot = cur.slots[cur.active] || {};
    var host = cur.candsHost;
    if (!cur.ds) {
      if (host) { clearChildren(host); host.appendChild(mk('div', 'aias-slot-hint',
        '⚠️ ' + t('webui.slot_no_ds_cand', '未选择数据源，无法检索候选 —— 可直接在上方输入值后回车'))); }
      return;
    }
    if (host) { clearChildren(host); host.appendChild(mk('div', 'aias-slot-hint', t('webui.slot_searching', '⏳ 检索中…'))); }
    if (cur.timer) clearTimeout(cur.timer);
    cur.timer = setTimeout(function () {
      post('/api/ai/assistant/sql-slot-candidates', {
        datasource_name: cur.ds, name: slot.name, role: slot.role, keyword: cur.keyword,
        col_ref: slot.col_ref || '', sql: cur.led.originalSql, quote: slot.quote || '',
        bare: !!slot.bare
      }).then(function (data) {
        var live = state.current;
        if (!live || live !== cur || !live.candsHost) return;
        var box = live.candsHost;
        clearChildren(box);
        if (!data || !data.ok) {
          box.appendChild(mk('div', 'aias-slot-err', '⚠️ ' + ((data && data.error) || t('webui.slot_search_failed', '检索失败'))));
          return;
        }
        live.slots[live.active].need_quote = !!data.need_quote;
        var cs = data.candidates || [];
        if (!cs.length) {
          box.appendChild(mk('div', 'aias-slot-hint', (data.note || t('webui.slot_no_cand', '没有匹配的候选 —— 可直接输入值后回车'))));
          return;
        }
        var nodes = [];
        cs.forEach(function (item) {
          var v = (item && typeof item === 'object') ? item.value : item;
          var label = (item && typeof item === 'object') ? (item.label || '') : '';
          var cand = mk('div', 'aias-slot-cand');
          if (label) cand.appendChild(mk('span', 'aias-slot-cand-label', label));
          cand.appendChild(mk('span', 'aias-slot-cand-val', String(v == null ? '' : v)));
          on(cand, 'click', function () { applyChecked(live.active, String(v == null ? '' : v)); });
          nodes.push(cand);
        });
        if (data.kind === 'date') {
          (data.presets || []).forEach(function (p) {
            var cand = mk('div', 'aias-slot-cand aias-slot-preset');
            cand.appendChild(mk('span', 'aias-slot-cand-label', t('webui.slot_date_preset', '日期预设')));
            cand.appendChild(mk('span', 'aias-slot-cand-val', String(p.value == null ? '' : p.value)));
            on(cand, 'click', function () { applyChecked(live.active, String(p.value == null ? '' : p.value)); });
            nodes.push(cand);
          });
        }
        if (data.note) nodes.push(mk('div', 'aias-slot-hint', data.note));
        live.candsNodes = nodes;
        nodes.forEach(function (node) { box.appendChild(node); });
      }).catch(function () {
        var live = state.current;
        if (!live || !live.candsHost) return;
        clearChildren(live.candsHost);
        live.candsHost.appendChild(mk('div', 'aias-slot-err', '⚠️ ' + t('webui.slot_search_req_failed', '检索请求失败')));
      });
    }, SEARCH_DEBOUNCE);
  }

  // ══════════════════════════════════════════════════════════
  // 选区替换：选中任意字符串 → 右键 → 原位替换 / 全部替换（aiasSel*）
  // ══════════════════════════════════════════════════════════

  function closeSelMenu() {
    var m = findNode(SEL_MENU_ID);
    if (m && m.parentNode) m.parentNode.removeChild(m);
    state.selCurrent = null;
  }

  // 指定代码块内是否存在有效（非空）文本选区？
  function selectedTextIn(pre) {
    try {
      var sel = window.getSelection && window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
      var txt = (typeof sel.toString === 'function' ? sel.toString() : '')
        .replace(/ /g, ' ').trim();
      if (!txt || txt.length > TARGET_MAX) return '';
      if (preText(pre).indexOf(txt) < 0) return '';   // 选区不在该块文本内 → 不接管
      return txt;
    } catch (ignore) { return ''; }
  }

  // 在 textContent 字符串坐标下返回选区偏移（宿主渲染 <code> 为单一文本节点，直接读 offset）
  function selectionOffsets(pre) {
    var out = { start: -1, end: -1 };
    try {
      var sel = window.getSelection && window.getSelection();
      if (!sel || !sel.rangeCount) return out;
      var range = sel.getRangeAt(0);
      var code = pre.querySelector ? (pre.querySelector('code') || pre) : pre;
      var sc = range.startContainer;
      var ec = range.endContainer;
      if (!sc || sc !== code || ec !== code) return out;   // 复杂多节点：交回退逻辑按第一处
      out.start = range.startOffset;
      out.end = range.endOffset;
    } catch (ignore) { /* 取不到偏移就退化成「替换第一处」 */ }
    return out;
  }

  function countOf(cur, target) {
    return (cur && target && cur.indexOf(target) !== -1) ? cur.split(target).length - 1 : 0;
  }

  function replaceNth(text, search, replacement, n) {
    var pos = -1;
    for (var i = 0; i <= n; i++) {
      pos = text.indexOf(search, pos + 1);
      if (pos === -1) return text;
    }
    return text.substring(0, pos) + replacement + text.substring(pos + search.length);
  }

  function nthOf(text, target, startOff, endOff) {
    if (!text || !target) return -1;
    var n = 0;
    var p = text.indexOf(target, 0);
    while (p !== -1) {
      if (startOff >= 0 && p < endOff && p + target.length > startOff) return n;
      n += 1;
      p = text.indexOf(target, p + target.length);
    }
    return -1;
  }

  function openSelMenu(pre, target, x, y) {
    closeSelMenu();
    closeMenu();
    var fp = blockFingerprint(pre, preText(pre));
    var cur = preText(pre);
    var offsets = selectionOffsets(pre);
    var n = countOf(cur, target);
    var show = target.length > 48 ? target.slice(0, 48) + '…' : target;

    var menu = mk('div', 'aias-slot-menu');
    menu.id = SEL_MENU_ID;
    var head = mk('div', 'aias-slot-menu-head');
    head.appendChild(document.createTextNode('🔧 ' + t('webui.slot_sel_title', '替换选中文本')));
    head.appendChild(mk('span', 'aias-slot-count',
      t('webui.slot_count', '共') + ' ' + n + ' ' + t('webui.slot_sel_occ', '处')));
    var close = mk('button', 'aias-ibtn', '✕');
    close.setAttribute('type', 'button');
    close.title = t('webui.slot_close', '关闭 (Esc)');
    on(close, 'click', closeSelMenu);
    head.appendChild(close);
    menu.appendChild(head);

    var hint = mk('div', 'aias-slot-hint');
    hint.appendChild(document.createTextNode(t('webui.slot_sel_target', '目标：')));
    hint.appendChild(mk('code', '', show));
    menu.appendChild(hint);

    var input = mk('input', 'aias-sel-input');
    input.setAttribute('type', 'text');
    input.placeholder = t('webui.slot_sel_input', '输入新的文本（留空 = 删除）');
    on(input, 'keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault && ev.preventDefault(); applySel(false); }
      else if (ev.key === 'Escape') { ev.preventDefault && ev.preventDefault(); closeSelMenu(); }
    });
    menu.appendChild(input);

    var bar = mk('div', 'aias-slot-actions');
    var one = mk('button', 'aias-sel-replace', t('webui.slot_sel_replace', '替换'));
    one.setAttribute('type', 'button');
    on(one, 'click', function () { applySel(false); });
    bar.appendChild(one);
    var all = mk('button', 'aias-sel-replace-all', t('webui.slot_sel_replace_all', '全部替换'));
    all.setAttribute('type', 'button');
    on(all, 'click', function () { applySel(true); });
    bar.appendChild(all);
    var closeBtn = mk('button', '', t('webui.slot_close', '关闭 (Esc)'));
    closeBtn.setAttribute('type', 'button');
    on(closeBtn, 'click', closeSelMenu);
    bar.appendChild(closeBtn);
    menu.appendChild(bar);

    var status = mk('div', 'aias-slot-err aias-sel-status');
    menu.appendChild(status);

    document.body.appendChild(menu);
    placeMenu(menu, x, y);

    state.selCurrent = {
      pre: pre, fp: fp, target: target, input: input, status: status,
      startOffset: offsets.start, endOffset: offsets.end, menu: menu, count: n
    };
    try { input.focus(); } catch (ignore) { /* 假 DOM 无焦点 */ }
  }

  function setSelStatus(message) {
    var sel = state.selCurrent;
    if (!sel || !sel.status) return;
    sel.status.textContent = message || '';
  }

  function applySel(all) {
    var sel = state.selCurrent;
    if (!sel || !sel.pre) { closeSelMenu(); return; }
    var newVal = sel.input ? String(sel.input.value || '') : '';
    var cur = preText(sel.pre);
    var target = sel.target;
    if (cur.indexOf(target) === -1) {
      setSelStatus('⚠️ ' + t('webui.slot_sel_gone', '目标文本在当前代码块中已不存在'));
      return;
    }
    var newText;
    var replaced;
    if (all) {
      replaced = countOf(cur, target);
      newText = cur.split(target).join(newVal);
    } else {
      var nth = nthOf(cur, target, sel.startOffset, sel.endOffset);
      if (nth < 0) nth = 0;
      var before = countOf(cur, target);
      newText = replaceNth(cur, target, newVal, nth);
      replaced = before - countOf(newText, target);
      if (replaced <= 0) replaced = 1;
    }
    if (newText === cur) { setSelStatus(t('webui.slot_sel_nothing', '没有需要替换的内容')); return; }

    commit(sel.pre, sel.fp, newText);
    rebaseLedger(sel.fp, newText);
    setSelStatus('✅ ' + t('webui.slot_sel_done', '已替换') + ' ' + replaced + ' ' + t('webui.slot_sel_occ', '处'));
    closeSelMenu();
  }

  // ══════════════════════════════════════════════════════════
  // 右键拦截：只在代码块上接管；有选区走选区替换，无选区只在「可执行 / 含占位符」时接管
  // ══════════════════════════════════════════════════════════

  function closestPre(target) {
    if (!target || !target.closest) return null;
    try { return target.closest('pre.aias-code-pre, pre.aias-sql-pre'); }
    catch (ignore) { return null; }
  }

  // 是否可执行：紧邻的下一个兄弟里含 .aias-sql-exec-wrap。
  // 兼容两种 DOM：exec-wrap 直接是 pre 的下一个兄弟，或嵌在 .aias-code-actions 里。
  function isExecutable(pre) {
    var nx = pre.nextElementSibling;
    if (nx) {
      if (hasClass(nx, 'aias-sql-exec-wrap')) return true;
      if (nx.querySelector && nx.querySelector('.aias-sql-exec-wrap')) return true;
    }
    var block = blockOf(pre);
    // 每个 .aias-code-block 是独立块，按块判断不会串到别的块（按 .aias-msg-text 整片找会串）。
    if (block && block.querySelector && block.querySelector('.aias-sql-exec-wrap')) return true;
    return false;
  }

  function handleContextMenu(event) {
    var target = event && event.target;
    var pre = closestPre(target);
    if (!pre) return false;                       // 不是代码块 → 保留浏览器原生右键菜单
    var selText = selectedTextIn(pre);
    if (selText) {
      if (event.preventDefault) event.preventDefault();
      openSelMenu(pre, selText, event.clientX, event.clientY);
      return true;
    }
    // 无选区时才考虑「占位符菜单」：只接管可执行 SQL 或确实含占位符的块，
    // 其它代码块（shell / yaml / 普通片段）保留原生右键菜单（用户还能用系统菜单复制）。
    if (!isExecutable(pre) && !HINT_RE.test(preText(pre))) return false;
    if (event.preventDefault) event.preventDefault();
    openForBlock(pre, event.clientX, event.clientY);
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // 文档级监听：contextmenu / keydown(Esc·Ctrl+Z) / mousedown(外部点击关闭)
  // 绑定一次，幂等；页面重进不重复绑。
  // ══════════════════════════════════════════════════════════

  function onKeyDown(event) {
    var key = event.key;
    if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'Z') && state.current) {
      if (event.preventDefault) event.preventDefault();
      undo();
      return;
    }
    if (key !== 'Escape') return;
    if (findNode(SEL_MENU_ID)) { closeSelMenu(); return; }
    if (findNode(MENU_ID)) closeMenu();
  }

  function onMouseDown(event) {
    var node = event.target;
    var menu = findNode(MENU_ID);
    if (menu && menu.contains && node && !menu.contains(node)) closeMenu();
    var sel = findNode(SEL_MENU_ID);
    if (sel && sel.contains && node && !sel.contains(node)) closeSelMenu();
  }

  function init() {
    if (state.bound) return;
    state.bound = true;
    document.addEventListener('contextmenu', function (event) { handleContextMenu(event); });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown, true);
  }

  function setDatasource(name) {
    state.datasource = name || '';
    if (state.current) {
      state.current.ds = name || '';
      renderPanel();
    }
  }

  function close() { closeAll(); }

  /** 宿主给的是节点，这里换成台账键再重建基线。 */
  function rebaseLedgerFrom(pre, newSql) {
    var fp = slotSqlId(pre) || blockFingerprint(pre, newSql);
    if (fp) rebaseLedger(fp, newSql);
  }

  window.FusionAiSqlSlots = {
    init: init,
    handleContextMenu: handleContextMenu,
    openForBlock: openForBlock,
    setDatasource: setDatasource,
    getSqlOverride: getSqlOverride,
    restoreOriginal: restoreOriginal,
    afterRender: afterRender,
    close: closeAll,
    // 宿主接缝：
    // 代码块重绘 / 拆分 / AI 修复 / 方言改写都要走这几个动作，缺一个就会出现
    // 「界面换了但台账还是旧的」这类静默不一致。
    updateHint: updateHint,
    dropLedger: dropLedger,
    rebaseLedger: rebaseLedgerFrom,
    refreshRestoreBtn: function (pre) {
      refreshRestoreEnabled(pre, slotSqlId(pre) || blockFingerprint(pre, preText(pre)));
    },
    restoreFromBlock: restoreFromBlock,
    state: state
  };
})();
