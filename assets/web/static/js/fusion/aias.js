/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * AI 巡检助手前端：全屏对话页（左侧会话列表 / 中间消息流 / 底部输入），
 * 覆盖会话管理、SSE 流式问答与深度思考、SQL 代码块的执行/拆分/批量/方言预检与
 * AI 修复、SQL 占位符槽位的识别与替换、数据源胶囊与版本一览、巡检任务进度与历史。
 *
 * 文件按三段组织：
 *   · 页头「壳层依赖」：本页面需要、但由外层壳（index.html）或共享组件提供的
 *     escAttr / toastOk / dsOpenPicker / 跨页跳转，缺省时在此补齐或给安全空实现；
 *   · 主体：助手页全部功能；
 *   · 页尾「会话存储」：读写两个边界函数改接服务端接口，其余数据结构与调用时序不变
 *     —— 会话必须落在服务端，换机器/清缓存才不会丢历史。
 * 接口一律走 /api/chat/*，由 modules/ai/chat_alias.py 承接。
 */

'use strict';

// ────────────────────────────────────────────────────────────
//  壳层依赖：跨模块的全局名，缺了就在本页补齐
// ────────────────────────────────────────────────────────────
(function () {
  // 属性值转义：壳层只提供了文本转义 escHtml，属性里的双引号要额外处理
  if (typeof window.escAttr !== 'function') {
    window.escAttr = function (value) {
      var text = (typeof window.escHtml === 'function')
        ? window.escHtml(String(value == null ? '' : value))
        : String(value == null ? '' : value);
      return text.replace(/"/g, '&quot;');
    };
  }
  if (typeof window.toastOk !== 'function') {
    window.toastOk = function (message) {
      if (typeof window.toast === 'function') window.toast(message, 'success');
    };
  }
  // 数据源选择器：统一走共享组件 FusionDsPicker（单选/多选/清除三态由它保证），
  // 这里只挂一个同名入口，弹窗调用直接命中它。
  if (typeof window.dsOpenPicker !== 'function' && window.FusionDsPicker) {
    window.dsOpenPicker = function (opts) { return window.FusionDsPicker.open(opts); };
  }
  // 跨功能页跳转（诊断 tab、报告页按来源筛选、报告下载）：目标页有自己的实现，
  // 没加载时给安全空函数，绝不让助手页因为别的页面缺失而抛错。
  ['switchAiDbaTab', 'filterReportTrigger', 'downloadReportHtml'].forEach(function (name) {
    if (typeof window[name] === 'function') return;
    window[name] = function () {
      if (window.console && console.warn) {
        console.warn('[aias] ' + name + ' 属于诊断/报告页功能，当前页面未提供实现');
      }
    };
  });
})();

// ─── AI-DBA 导航追踪与返回逻辑 ───
var _aiDbaNavHistory = null; // 存储跳转前的 {tab, scrollY}

function navigateFromAiDba(targetPage, fromTab) {
  // 记录当前 AI-DBA 的 Tab 和滚动位置
  var activeTab = fromTab;
  if (!activeTab) {
    var activeBtn = document.querySelector('.ai-dba-tab[style*="border-bottom"]');
    if (activeBtn) activeTab = activeBtn.getAttribute('data-tab');
  }
  _aiDbaNavHistory = {
    tab: activeTab || 'architecture',
    scrollY: document.getElementById('page-ai-dba') ? document.getElementById('page-ai-dba').scrollTop : 0
  };
  showPage(targetPage);
  // 显示返回按钮
  var btn = document.getElementById('aiDbaBackBtn');
  if (btn) btn.style.display = 'flex';
}

function returnToAiDba() {
  showPage('ai-dba');
  if (_aiDbaNavHistory) {
    // 恢复之前的 Tab
    if (_aiDbaNavHistory.tab) {
      switchAiDbaTab(_aiDbaNavHistory.tab);
    }
    // 恢复滚动位置
    var pageEl = document.getElementById('page-ai-dba');
    if (pageEl && _aiDbaNavHistory.scrollY) {
      setTimeout(function() { pageEl.scrollTop = _aiDbaNavHistory.scrollY; }, 50);
    }
    _aiDbaNavHistory = null;
  }
  // 隐藏返回按钮
  var btn = document.getElementById('aiDbaBackBtn');
  if (btn) btn.style.display = 'none';
}

// 监听 showPage，如果离开 AI-DBA 相关页面且不是从 AI-DBA 跳转的，隐藏返回按钮
var _originalShowPage = showPage;
showPage = function(name) {
  // 如果用户手动导航到其他页面（非 AI-DBA 跳转），隐藏返回按钮
  if (name !== 'ai-dba' && !_aiDbaNavHistory) {
    var btn = document.getElementById('aiDbaBackBtn');
    if (btn) btn.style.display = 'none';
  }
  // 如果回到 ai-dba 页面，隐藏返回按钮并清除历史
  if (name === 'ai-dba') {
    var btn2 = document.getElementById('aiDbaBackBtn');
    if (btn2) btn2.style.display = 'none';
    _aiDbaNavHistory = null;
  }
  _originalShowPage(name);
};

/* ════════════════════════════════════════════════════════════
   AI 巡检助手 (AI Assistant) — 全窗口对话 JavaScript
   功能：流式SSE · 会话中断 · 重试 · 编辑重发 · 智能滚动
   ════════════════════════════════════════════════════════════ */
var _aias = {
  sessions: [],         // 所有会话列表 [{id, title, messages: []}]
  currentSessionId: null,
  isGenerating: false,
  abortController: null,
  userScrolledUp: false,  // 用户是否手动上滚
  scrollPromptShown: false,
  // 流式渲染节流（requestAnimationFrame 对齐浏览器绘制周期）
  renderPending: null,    // 待执行的渲染函数
  renderRafId: null,      // rAF 请求ID
  renderLastTime: 0,      // 上次渲染时间戳
  renderMinInterval: 120, // 最小渲染间隔(ms)，约8fps —— 流式是整条 innerHTML 重建，
  // 帧率过高会导致反复重绘抖动；压低后肉眼流畅度仍可，但“闪动”明显减轻
};

// ── 初始化 ──
// 本地镜像（localStorage['aias_sessions']）读回来必须先归一成「会话数组」。
// 这个归一不能省：镜像曾写入过服务端 sync 的请求体形状 {"sessions":[…]}，
// 于是 sessions[0] 是 undefined，aiasInit 在这里直接抛异常 ——
// 会话列表、模型信息、消息渲染全都不再执行，整个助手页看起来是坏的。
// 坏镜像不用用户手动清：接得住，下一次保存就写回正确形状。
function aiasNormalizeSessions(raw) {
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.sessions)) return parsed.sessions;
  return [];
}

function aiasInit() {
  // 从 localStorage 加载会话
  var saved = null;
  try { saved = localStorage.getItem('aias_sessions'); } catch (e) { saved = null; }
  _aias.sessions = saved ? aiasNormalizeSessions(saved) : [];

  if (!_aias.sessions.length) {
    aiasNewChat();
  } else {
    _aias.currentSessionId = _aias.sessions[0].id;
    aiasRenderSessionList();
    aiasRenderMessages();
  }
  aiasRefreshDsCapsule();
  aiasInitGlobalRowLimit();

  // 会话列表：恢复悬浮/钉住、宽度、收起三态，并挂上拖宽手柄
  aiasInitSidebarDrawer();

  // 监听滚动，判断用户是否上滚（passive 提升滚动性能）
  var msgArea = document.getElementById('aias-messages');
  if (msgArea) {
    msgArea.addEventListener('scroll', function(e) {
      // 仅处理用户真实滚动（滚轮/触摸/键盘）。程序化 scrollTop 赋值触发的
      // scroll 事件 isTrusted=false，忽略之，避免流式渲染时误判用户上滚。
      if (!e.isTrusted) return;
      var atBottom = msgArea.scrollHeight - msgArea.scrollTop - msgArea.clientHeight < 30;
      if (atBottom) {
        _aias.userScrolledUp = false;
        aiasHideScrollPrompt();
      } else {
        _aias.userScrolledUp = true;
      }
    }, { passive: true });
  }

  // 对话缩略导航：滚动同步、点击定位、内容变化重绘
  aiasInitMinimap();

  // 双击单元格取词 → 高亮本次结果里所有相同值（Notepad++ 式，见文件末节）
  aiasInitValueHighlight();

  // 加载模型信息
  aiasLoadModelInfo();
}

function aiasLoadModelInfo() {
  fetch('/api/ai_config').then(function(r) { return r.json(); }).then(function(cfg) {
    var info = document.getElementById('aias-model-info');
    if (!info) return;
    var backend = cfg.backend || 'disabled';
    if (backend === 'disabled' || !backend) {
      info.innerHTML = '⚠ AI 未启用';
      info.style.color = '#ef4444';
    } else if (backend === 'openai') {
      var model = cfg.online_model || cfg.model || '未知';
      info.innerHTML = model;
    } else if (backend === 'ollama') {
      info.innerHTML = cfg.model || 'ollama';
    }
  }).catch(function() {
    var info = document.getElementById('aias-model-info');
    if (info) info.innerHTML = '⚠ 配置加载失败';
  });
}

// ── 会话管理 ──
function aiasNewChat() {
  var session = {
    id: 'sess_' + Date.now(),
    title: '新对话',
    messages: [],
    createdAt: Date.now(),
  };
  _aias.sessions.unshift(session);
  _aias.currentSessionId = session.id;
  aiasSaveSessions();
  aiasRenderSessionList();
  aiasRenderMessages();
  aiasRefreshDsCapsule();
  // 聚焦输入框
  setTimeout(function() {
    var input = document.getElementById('aias-input');
    if (input) input.focus();
  }, 100);
}

function aiasSwitchSession(sessionId) {
  if (_aias.isGenerating) return;
  _aias.currentSessionId = sessionId;
  aiasRenderSessionList();
  aiasRenderMessages();
  aiasRefreshDsCapsule();
}

function aiasDeleteSession(sessionId, event) {
  if (event) event.stopPropagation();
  if (!confirm('确定删除此对话？')) return;
  _aias.sessions = _aias.sessions.filter(function(s) { return s.id !== sessionId; });
  if (_aias.currentSessionId === sessionId) {
    _aias.currentSessionId = _aias.sessions.length > 0 ? _aias.sessions[0].id : null;
    if (!_aias.currentSessionId) aiasNewChat();
  }
  aiasSaveSessions();
  aiasRenderSessionList();
  aiasRenderMessages();
}

function aiasRenameSession(sessionId, event) {
  if (event) event.stopPropagation();
  var item = document.getElementById('aias-session-' + sessionId);
  if (!item) return;
  var sess = _aias.sessions.find(function(s) { return s.id === sessionId; });
  if (!sess) return;
  var current = sess.title || '新对话';
  item.classList.add('editing');
  item.innerHTML = '<input class="aias-session-rename-input" id="aias-rename-input-' + sessionId + '" maxlength="100" value="' + escAttr(current) + '" onclick="event.stopPropagation()">'
                 + '<div class="aias-session-rename-actions" onclick="event.stopPropagation()">'
                 + '<button class="aias-rename-save" onclick="aiasSaveRename(\'' + sessionId + '\')">保存</button>'
                 + '<button onclick="aiasCancelRename(\'' + sessionId + '\')">取消</button>'
                 + '</div>';
  var input = document.getElementById('aias-rename-input-' + sessionId);
  if (input) {
    input.focus();
    input.select();
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); aiasSaveRename(sessionId); }
      else if (e.key === 'Escape') { e.preventDefault(); aiasCancelRename(sessionId); }
    });
  }
}

function aiasSaveRename(sessionId) {
  var input = document.getElementById('aias-rename-input-' + sessionId);
  if (!input) return;
  var newTitle = (input.value || '').trim() || '新对话';
  var sess = _aias.sessions.find(function(s) { return s.id === sessionId; });
  if (sess) {
    sess.title = newTitle;
    aiasSaveSessions();
  }
  aiasRenderSessionList();  // 重渲染恢复列表并展示新标题
  if (typeof toastOk === 'function') toastOk('已重命名');
}

function aiasCancelRename(sessionId) {
  aiasRenderSessionList();  // 取消即恢复原始列表
}

function aiasClearChat() {
  var sess = aiasCurrentSession();
  if (!sess) return;
  if (sess.messages.length > 0 && !confirm('确定清空当前对话？')) return;
  sess.messages = [];
  sess.title = '新对话';
  aiasSaveSessions();
  aiasRenderSessionList();
  aiasRenderMessages();
}

function aiasCurrentSession() {
  return _aias.sessions.find(function(s) { return s.id === _aias.currentSessionId; });
}

function aiasSaveSessions() {
  try {
    // 只保留最近 20 个会话
    if (_aias.sessions.length > 20) {
      _aias.sessions = _aias.sessions.slice(0, 20);
    }
    localStorage.setItem('aias_sessions', JSON.stringify(_aias.sessions));
  } catch(e) {}
}

function aiasRenderSessionList() {
  var list = document.getElementById('aias-session-list');
  if (!list) return;
  var html = '';
  _aias.sessions.forEach(function(sess) {
    var active = sess.id === _aias.currentSessionId ? ' active' : '';
    var title = escHtml(sess.title || '新对话');
    html += '<div class="aias-session-item' + active + '" id="aias-session-' + sess.id + '" onclick="aiasSwitchSession(\'' + sess.id + '\')">';
    html += '<span class="aias-session-ico">💬</span>';
    html += '<span class="aias-session-title" id="aias-sess-title-' + sess.id + '">' + title + '</span>';
    html += '<span class="aias-session-actions">';
    html += '<span class="aias-session-rename" title="重命名" onclick="event.stopPropagation();aiasRenameSession(\'' + sess.id + '\', event)">✎</span>';
    html += '<span class="aias-session-del" onclick="aiasDeleteSession(\'' + sess.id + '\', event)">✕</span>';
    html += '</span>';
    html += '</div>';
  });
  list.innerHTML = html;

  // 更新标题
  var sess = aiasCurrentSession();
  var titleEl = document.getElementById('aias-topbar-title');
  if (titleEl && sess) titleEl.textContent = sess.title || '新对话';
}

// ── 消息渲染 ──
function aiasRenderMessages() {
  var container = document.getElementById('aias-messages');
  if (!container) return;
  aiasInitResultBarObserver();   // 先装兜底观察器（空会话时后面会提前 return，不能放到末尾）
  var sess = aiasCurrentSession();
  if (!sess || sess.messages.length === 0) {
    // 显示欢迎界面
    container.innerHTML = '<div class="aias-welcome">' +
      '<div class="aias-welcome-icon">🤖</div>' +
      '<h2>AI 巡检助手</h2>' +
      '<p>自然语言驱动 · 工具智能调用 · 上下文感知</p>' +
      '<div class="aias-suggestion-grid">' +
        '<div class="aias-suggestion-card" onclick="aiasQuickSend(\'查看所有数据源\')"><span class="aias-suggestion-icon">📊</span><span>查看所有数据源</span></div>' +
        '<div class="aias-suggestion-card" onclick="aiasQuickSend(\'有哪些巡检模板\')"><span class="aias-suggestion-icon">📋</span><span>查看巡检模板</span></div>' +
        '<div class="aias-suggestion-card" onclick="aiasQuickSend(\'系统状态概览\')"><span class="aias-suggestion-icon">🏠</span><span>系统状态概览</span></div>' +
        '<div class="aias-suggestion-card" onclick="aiasQuickSend(\'查看慢查询监控\')"><span class="aias-suggestion-icon">⚡</span><span>查看慢查询监控</span></div>' +
      '</div></div>';
    aiasRebuildMinimap();   // 空会话没有可导航内容，缩略条要收起
    return;
  }

  var html = '';
  sess.messages.forEach(function(msg, idx) {
    html += aiasRenderMessageHTML(msg, idx);
  });
  container.innerHTML = html;
  // ★ 恢复/切换会话后，历史里的 AI 回答同样要挂操作条。
  // 缺这一步的表现：刷新页面后"所有历史回答都没有复制按钮"，只有本次新生成的才有。
  var aiTexts = container.querySelectorAll('.aias-msg.ai .aias-msg-text');
  for (var i = 0; i < aiTexts.length; i++) {
    aiasEnhanceResults(aiTexts[i]);
    // 历史消息里的多语句块同样要拆成独立子块（每条一个执行按钮）
    aiasValidateSqlBlocks(aiTexts[i]);
  }
  aiasScrollToBottom(true);
  aiasRebuildMinimap();
}

function aiasRenderMessageHTML(msg, idx) {
  var isUser = msg.role === 'user';
  var avatar = isUser ? '🧑' : '🤖';
  var role = isUser ? '你' : 'AI 巡检助手';
  var rawContent = msg.content || '';

  // 工具链路可视化（仅AI消息且有工具链路数据时显示）
  var toolChainHtml = '';
  var understandingContent = '';
  if (!isUser && msg.toolChainHtml) {
    toolChainHtml = msg.toolChainHtml;
    understandingContent = msg.understandingContent || '';
  }

  var html = '<div class="aias-msg ' + (isUser ? 'user' : 'ai') + '" data-idx="' + idx + '">';
  html += '<div class="aias-msg-avatar">' + avatar + '</div>';
  html += '<div class="aias-msg-content">';
  html += '<div class="aias-msg-role">' + role + '</div>';

  // 正文渲染顺序：过程（折叠）→ 结论卡 → 其余正文
  var innerHtml = '';
  var evidenceHtml = '';
  if (isUser) {
    // 用户消息：直接转义显示
    innerHtml += escHtml(rawContent);
  } else {
    var proofHtml = '';
    // 思考过程：生成中实时展开，落定后归入「怎么得出的」这一层
    if (msg.thinkingContent) {
      proofHtml += aiasBuildThinkingHtml(msg.thinkingContent, true, true);
    }
    // 理解文本属于过程，分析文本才是答案
    if (understandingContent) {
      proofHtml += aiasMarkdownToHtml(understandingContent);
    }
    proofHtml += toolChainHtml;
    // 从 rawContent 中去除 understandingContent 部分，只保留分析文本
    var analysisMd = rawContent;
    if (understandingContent && rawContent.startsWith(understandingContent)) {
      analysisMd = rawContent.substring(understandingContent.length).replace(/^\n+/, '');
    }
    var ev = aiasEvidenceFromToolChain(toolChainHtml);
    evidenceHtml = aiasEvidenceChipsHtml(ev, aiasEvidenceDatasources(toolChainHtml, aiasCurrentSession()));
    innerHtml += aiasProofDetailsHtml(proofHtml, ev);
    innerHtml += aiasAnswerHtml(analysisMd, ev.errors > 0);
  }

  // 确认卡片（页面重载后仍可显示）
  if (!isUser && msg.needConfirmation && msg.confirmOptions) {
    innerHtml += aiasBuildConfirmationHtml(msg.confirmQuestion, msg.confirmOptions);
  }

  html += evidenceHtml;
  html += '<div class="aias-msg-text" id="aias-msg-text-' + idx + '">' + innerHtml + '</div>';

  // 编辑区域（仅用户消息）
  if (isUser) {
    html += '<div class="aias-edit-area" id="aias-edit-area-' + idx + '">';
    html += '<textarea class="aias-edit-textarea" id="aias-edit-input-' + idx + '">' + escHtml(msg.content) + '</textarea>';
    html += '<div class="aias-edit-actions">';
    html += '<button class="aias-edit-btn cancel" onclick="aiasCancelEdit(' + idx + ')">取消</button>';
    html += '<button class="aias-edit-btn save" onclick="aiasSaveEdit(' + idx + ')">保存并重发</button>';
    html += '</div></div>';
  }

  // 操作按钮
  html += '<div class="aias-msg-actions">';
  if (isUser) {
    html += '<button class="aias-action-btn" onclick="aiasStartEdit(' + idx + ')">✏️ 编辑重发</button>';
  } else {
    html += '<button class="aias-action-btn" onclick="aiasCopyMessage(' + idx + ')">📋 复制</button>';
    html += '<button class="aias-action-btn" onclick="aiasRetry(' + idx + ')">🔄 重新生成</button>';
  }
  html += '</div>';

  html += '</div></div>';
  return html;
}

// ── Markdown 简易渲染 ──
// ── AI 回复中的 SQL 一键执行 ──
var _aiasSqlStore = {};
var _aiasSqlSeq = 0;
var _aiasSqlErrors = {};   // sqlId -> 执行报错信息（供「AI 修复」使用）
var _aiasSqlDs = {};       // sqlId -> 执行时使用的数据源名（供 AI 修复时识别数据库方言）
var _aiasSqlRepair = {};   // sqlId -> 「字段不存在」确定性修复载荷（真实列清单），供展示与修复注入
var _aiasDsDsList = [];    // 数据源选择弹窗的列表缓存（胶囊点击时避免重复请求）

function unescHtml(s) {
  return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// 判断代码块内容是否真的是 SQL 语句（避免非 SQL 内容误显示执行按钮）
// 宽口径：只要以常见 SQL 关键字（含写/事务）开头就算"SQL 块"——
// 用途仅是把 pre 挂上 `.aias-sql-pre`，使其能被多语句拆分扫描到；
// 拆分后每条由后端 executable 判定，**写语句永远不会拿到执行按钮**。
function isLikelySql(text) {
  var t = String(text || '').trim();
  if (!t) return false;
  // 去掉开头的注释行
  t = t.replace(/^--.*$/gm, '').replace(/^\/\*[\s\S]*?\*\//, '').trim();
  if (!t) return false;
  var upper = t.toUpperCase();
  var kws = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'USE', 'SET', 'CALL', 'PREPARE', 'EXECUTE',
             'ALTER', 'CREATE', 'DROP', 'TRUNCATE', 'RENAME', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE',
             'BEGIN', 'DECLARE', 'GRANT', 'REVOKE', 'COMMENT', 'LOCK', 'UNLOCK', 'START', 'COMMIT', 'ROLLBACK', 'DO', 'TABLE', 'VALUES'];
  for (var i = 0; i < kws.length; i++) {
    if (upper === kws[i] || upper.indexOf(kws[i] + ' ') === 0 || upper.indexOf(kws[i] + '\n') === 0 || upper.indexOf(kws[i] + '\t') === 0) {
      return true;
    }
  }
  // 排除明显不是 SQL 的文本（如普通中文/英文段落）
  return false;
}

// 严格口径：**只读查询 / 只读分析** 才允许出现「执行SQL/批量」按钮。
// 写/事务语句（ALTER/CREATE/DROP/INSERT/UPDATE/DELETE…）一律不在这里返回 true。
// 但 BEGIN/DECLARE 匿名块**例外**：它可能是"调用只读分析过程"（如 FOR..IN(SELECT..)
// LOOP .. DBMS_OUTPUT 遍历查询结果），属于只读分析，不应一刀切全禁 —— 由
// aiasPlsqlBlockIsReadOnly 做块内深度扫描，仅纯只读才给执行按钮。
// 后端 `_detect_sql_type` 仍会二次拦截写操作（双保险）。
function isLikelyReadSql(text) {
  var t = String(text || '').trim();
  if (!t) return false;
  t = t.replace(/^--.*$/gm, '').replace(/^\/\*[\s\S]*?\*\//, '').trim();
  if (!t) return false;
  var upper = t.toUpperCase();
  // BEGIN / DECLARE 开头的匿名 PL/SQL 块 → 块内深度只读判定
  if (upper.indexOf('BEGIN ') === 0 || upper.indexOf('BEGIN\n') === 0 || upper === 'BEGIN'
   || upper.indexOf('DECLARE ') === 0 || upper.indexOf('DECLARE\n') === 0 || upper === 'DECLARE') {
    return aiasPlsqlBlockIsReadOnly(t);
  }
  var kws = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'USE', 'SET', 'CALL', 'PREPARE', 'EXECUTE', 'TABLE', 'VALUES'];
  for (var i = 0; i < kws.length; i++) {
    if (upper === kws[i] || upper.indexOf(kws[i] + ' ') === 0 || upper.indexOf(kws[i] + '\n') === 0 || upper.indexOf(kws[i] + '\t') === 0) {
      return true;
    }
  }
  return false;
}

// 前端插件：判断匿名 PL/SQL 块是否纯只读（口径与后端 _classify_plsql_block 一致）。
// 回归安全目标：只有**纯只读分析**块才返回 true；含任何写/DML/DDL/动态 SQL → false。
// 用单词边界正则匹配，且先剥离字符串字面量，避免把 'no update here' 等误判为写。
var _AIAS_PLSQL_FENCE = "['\\\"](?:\\\\.|[^'\\\"\\\\])*?['\\\"]";
var _AIAS_PLSQL_WRITE_KWS = ['INSERT','UPDATE','DELETE','MERGE','REPLACE','CREATE',
  'ALTER','DROP','TRUNCATE','RENAME','GRANT','REVOKE','COMMIT','ROLLBACK','SAVEPOINT',
  'PURGE','FLASHBACK','STARTUP','SHUTDOWN','PASSWORD','PROFILE','ANALYZE'];
var _AIAS_PLSQL_DANGEROUS_PKGS = ['DBMS_JOB','DBMS_SCHEDULER','DBMS_DDL','DBMS_REDEFINITION',
  'DBMS_AQ','DBMS_REFRESH','DBMS_TRANSACTION','DBMS_FLASHBACK','DBMS_STREAMS','DBMS_REPAIR',
  'DBMS_STATS','DBMS_ADMIN','DBMS_ALERT','DBMS_PIPE','DBMS_DEBUG','DBMS_SQL'];
function aiasPlsqlBlockIsReadOnly(sql) {
  var t = String(sql || '');
  if (!t) return false;
  // 1) 剥离块内字符串字面量（含单/双引号），防止 'no update here' / 'commit test' 误杀
  try {
    t = t.replace(new RegExp(_AIAS_PLSQL_FENCE, 'g'), ' ');
  } catch(e) {}
  var up = t.toUpperCase();
  // 2) 动态 SQL / 未知管理包 → 从严拒绝（先于普通写关键字，避免 EXECUTE 特例）
  if (up.indexOf('EXECUTE IMMEDIATE') !== -1) return false;
  for (var j = 0; j < _AIAS_PLSQL_DANGEROUS_PKGS.length; j++) {
    if (up.indexOf(_AIAS_PLSQL_DANGEROUS_PKGS[j]) !== -1) return false;
  }
  // 3) 显式写/DDL/事务 → 非只读（单词边界匹配）
  var fence = new RegExp(_AIAS_PLSQL_FENCE);
  for (var i = 0; i < _AIAS_PLSQL_WRITE_KWS.length; i++) {
    var kw = _AIAS_PLSQL_WRITE_KWS[i];
    var re = new RegExp('\\b' + kw + '\\b');
    if (re.test(up)) return false;
  }
  // 4) 纯只读分析块 → 放行
  return true;
}

// 用后端 sqlparse 引擎校验消息中的 SQL 代码块，非 SQL 内容移除执行按钮
function aiasValidateSqlBlocks(msgText) {
  if (!msgText) return;
  aiasScheduleMultiSqlScan();          // 顺带把"多语句块"拆开（见下方 aiasScanMultiSql）
  aiasScheduleDialectScan();           // 顺带做执行前的方言预检（见下方 aiasScanDialectSql）
  var btns = msgText.querySelectorAll('.aias-sql-exec-btn');
  if (!btns.length) return;
  btns.forEach(function(btn) {
    var sqlId = btn.getAttribute('data-sql-id');
    if (!sqlId) return;
    var sql = _aiasSqlStore[sqlId] || '';
    if (!sql) return;
    fetch('/api/chat/check-sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: unescHtml(sql) })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.is_sql === false) {
        // 非 SQL：移除按钮和结果容器
        var wrap = btn.closest('.aias-sql-exec-wrap');
        if (wrap) wrap.parentNode.removeChild(wrap);
        delete _aiasSqlStore[sqlId];
      }
    })
    .catch(function() {});
  });
}

// ── 多语句「语句级拆分」──
// 一个代码块里多条语句是 AI 建议 SQL 的常见形态。批量执行本身早已支持
// （后端拆开逐条跑、前端逐条展示结果），但有个硬伤：**遇错即停之后，想只重跑失败的那条
// 做不到** —— 只能把整块再跑一遍，已经成功的那条（可能是几千万行的全表扫描）跟着重跑，
// 这在生产库上不可接受。
// 所以这里把块**在界面上拆开**：每条一个子块，各自有独立的「执行第 N 条」与结果区，
// 整块另留一个「全部执行」。★ 拆分口径与执行口径共用后端同一个拆分器
// （POST /api/chat/split-sql → sql_split.split_sql_statements），
// 保证"界面上看到几条 == 后端会跑几条"。
var _aiasMultiScanTimer = null;

function aiasScheduleMultiSqlScan() {
  // 流式进行中不扫：此时 SQL 块是半截的，拆了只会闪一下又变
  if (document.querySelector('.aias-cursor, .aias-drilldown-cursor, .aias-typing')) return;
  if (_aiasMultiScanTimer) clearTimeout(_aiasMultiScanTimer);
  _aiasMultiScanTimer = setTimeout(aiasScanMultiSql, 260);
}

// ── 兜底：自动扫描新插入的 SQL 块 ──
// 拆分依赖"渲染完成后有人调用 aiasScheduleMultiScanSql"。但 =渲染路径不止一条（流式、
// 会话恢复、工具链、智能巡检分析面板、历史追问回放…），任何一条漏调，块就停在"整体
// 一个执行按钮"不拆分。这里用 MutationObserver 兜底：凡是 DOM 里新出现 `pre.aias-sql-pre`
// 就触发一次扫描。aiasScanMultiSql 用 data-multi-checked + 跳过 .aias-sql-split-body
// 保证幂等，重复触发无副作用；流式半截块由 aiasScheduleMultiSqlScan 内部的游标守卫生效。
var _aiasMultiObserver = null;
function aiasInitMultiSqlObserver() {
  if (_aiasMultiObserver) return;
  try {
    _aiasMultiObserver = new MutationObserver(function(records) {
      var hit = false;
      for (var r = 0; r < records.length && !hit; r++) {
        var nodes = records[r].addedNodes || [];
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if (!n || n.nodeType !== 1) continue;
          if (n.matches && n.matches('pre.aias-sql-pre')) { hit = true; break; }
          if (n.querySelector && n.querySelector('pre.aias-sql-pre')) { hit = true; break; }
        }
      }
      if (hit) aiasScheduleMultiSqlScan();
    });
    _aiasMultiObserver.observe(document.body, { childList: true, subtree: true });
  } catch (e) {}
}
if (typeof window !== 'undefined' && document.body) {
  aiasInitMultiSqlObserver();
} else if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', aiasInitMultiSqlObserver);
}

function aiasScanMultiSql() {
  _aiasMultiScanTimer = null;
  // 注意：pre 的 id 现在挂在自身 data-sql-id 上（渲染层已给），选择器仍用
  // `pre.aias-sql-pre`（不依赖按钮存在），兼容"被旧版 check-sql 摘过按钮"的块。
  var pres = document.querySelectorAll('pre.aias-sql-pre');
  var need = [], next = [];
  for (var i = 0; i < pres.length; i++) {
    var pre = pres[i];
    if (pre.getAttribute('data-multi-checked') === '1') continue;
    if (pre.closest('.aias-sql-split-body')) continue;      // 已拆出的子块不再递归
    var txt = aiasSlotText(pre);
    if (!txt || txt.indexOf(';') < 0) continue;             // 没有分号 → 必然单条，省一次请求
    var nx = pre.nextElementSibling;
    var hasWrap = !!(nx && nx.classList && nx.classList.contains('aias-sql-exec-wrap'));
    // 无执行按钮的块（旧版把「首句非查询的多语句块」整块误摘）：也尝试拆分救回
    if (!hasWrap && !pre.getAttribute('data-sql-id')) continue;   // 无 id 无法重建执行区
    if (hasWrap && !aiasSlotSqlId(pre)) continue;          // 没有 sqlId 就没有执行入口
    pre.setAttribute('data-multi-checked', '1');
    need.push(txt);
    next.push(pre);
  }
  if (!need.length) return;
  fetch('/api/chat/split-sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sqls: need })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d || !d.ok || !d.results) return;
    for (var k = 0; k < next.length && k < d.results.length; k++) {
      var res = d.results[k] || {};
      var pre = next[k];
      if (!pre.isConnected) continue;
      var nx2 = pre.nextElementSibling;
      var hasWrap2 = !!(nx2 && nx2.classList && nx2.classList.contains('aias-sql-exec-wrap'));
      if (!hasWrap2) {
        // 无按钮块（首句非只读的混合块/写块）：插一个**纯占位**执行区锚点，供拆分重建；
        // 不放任何执行按钮（写语句绝不出现执行入口）；若不该拆则移除，保持原样
        var sid = pre.getAttribute('data-sql-id');
        var tw = document.createElement('div');
        tw.className = 'aias-sql-exec-wrap';
        tw.setAttribute('data-tmp', '1');
        pre.parentNode.insertBefore(tw, pre.nextSibling);
        _aiasSqlStore[sid] = escHtml(aiasSlotText(pre));
      }
      var execArr = res.executable || [];
      var anyExec = execArr.some(function (x) { return !!x; });
      if ((res.count || 0) > 1 && anyExec) {
        // 至少要有一条可执行才拆（纯非查询多语句没有拆的意义）
        try { aiasSplitSqlBlock(pre, res.statements || [], execArr); } catch (e) {}
        continue;
      }
      // 不该拆：清掉刚插的占位执行区（恢复原状）
      var w3 = pre.nextElementSibling;
      if (w3 && w3.classList && w3.classList.contains('aias-sql-exec-wrap') && w3.getAttribute('data-tmp') === '1') {
        delete _aiasSqlStore[pre.getAttribute('data-sql-id')];
        w3.parentNode.removeChild(w3);
      }
    }
  }).catch(function () {
    // 接口异常：清理可能残留的占位执行区，避免写语句意外出现可点击的执行入口
    var left = document.querySelectorAll('.aias-sql-exec-wrap[data-tmp="1"]');
    for (var i = 0; i < left.length; i++) {
      var pid = left[i].previousElementSibling;
      if (pid && pid.getAttribute && pid.getAttribute('data-sql-id')) {
        delete _aiasSqlStore[pid.getAttribute('data-sql-id')];
      }
      if (left[i].parentNode) left[i].parentNode.removeChild(left[i]);
    }
  });
}

// 把"一个多条语句的 pre + exec-wrap"原地换成"头栏 + N 个语句子块"
function aiasSplitSqlBlock(pre, stmts, executable) {
  var wrap = pre.nextElementSibling;
  if (!wrap || !wrap.classList || !wrap.classList.contains('aias-sql-exec-wrap')) return;
  var sqlId = aiasSlotSqlId(pre);
  if (!sqlId) return;
  var wholeSql = aiasSlotText(pre);
  executable = executable || [];

  // 逐条是否只读查询（executable 与后端 split-sql 返回的逐条判定一一对应）
  var allExec = stmts.length > 0;
  for (var e = 0; e < stmts.length; e++) { if (!executable[e]) { allExec = false; break; } }

  var box = document.createElement('div');
  box.className = 'aias-sql-split';
  box.setAttribute('data-sql-id', sqlId);
  var html = '<div class="aias-sql-split-head">'
    + '<span class="aias-sql-split-title">共 ' + stmts.length + ' 条语句</span>'
    + '<span class="aias-sql-split-note">' + (allExec
        ? '纯查询，每条可单独执行 —— 失败那条改完只需重跑它自己'
        : '查询语句可单独执行；非查询语句仅展示，不提供执行') + '</span>'
    + ' <span class="aias-dialect-badge is-loading" data-dialect-sql-id="' + sqlId
        + '" title="正在确认目标库版本…">⏳ 版本确认中…</span>';
  if (allExec) {
    html += '<button class="aias-ibtn ok" data-sql-id="' + sqlId + '" aria-label="全部执行" '
      + 'title="全部执行（按语句顺序，遇错即停）" '
      + 'onclick="aiasExecuteSql(this.getAttribute(\'data-sql-id\'))">' + _AIAS_IC.playAll + '</button>';
  }
  html += '<button class="aias-ibtn" data-sql-id="' + sqlId + '" aria-label="复制全部语句" '
      + 'title="复制全部语句" onclick="aiasCopySqlRaw(this)">' + _AIAS_COPY_BTN_HTML + '</button>'
    + '</div>';
  for (var i = 0; i < stmts.length; i++) {
    var sid = sqlId + '-s' + (i + 1);
    // ★ 指纹覆盖：子块这条语句若被 AI 修复过，用覆盖后的版本渲染/执行
    var stmtTxt = stmts[i];
    try {
      var sov = aiasSqlOverrideFind(stmtTxt);
      if (sov && sov.fixedSql) stmtTxt = sov.fixedSql;
    } catch (e) {}
    _aiasSqlStore[sid] = escHtml(stmtTxt); // 子块自己就是一条语句
    var exec = !!executable[i];
    // 只有只读查询子块才挂 .aias-sql-pre 并生成执行按钮；非查询子块仅展示
    var preCls = exec ? 'aias-code-pre aias-sql-pre' : 'aias-code-pre';
    html += '<div class="aias-sql-split-item' + (exec ? '' : ' is-static') + '">'
      + '<div class="aias-sql-split-no">' + (i + 1) + '</div>'
      + '<div class="aias-sql-split-body">'
      + '<pre class="' + preCls + '" data-sql-id="' + sid + '" data-multi-checked="1"><code>'
      + escHtml(stmtTxt) + '</code>'
      + '<button class="aias-pre-restore-btn is-idle" data-sql-id="' + sid + '" '
      + 'title="撤销占位符替换（当前没有替换记录）" aria-label="撤销占位符替换" '
      + 'onclick="aiasSlotRestoreFromBlock(this)">' + _AIAS_RESTORE_BTN_HTML + '</button>'
      + '<button class="aias-pre-copy-btn" title="' + (exec ? '复制该条 SQL' : '复制该条') + '" '
      + 'aria-label="复制该条" onclick="aiasCopySqlPre(this)">' + _AIAS_COPY_BTN_HTML + '</button>'
      + '</pre>';
    if (exec) {
      html += '<div class="aias-sql-exec-wrap">'
        + '<button class="aias-sql-batch-btn" data-sql-id="' + sid + '" '
        + 'title="把这条 SQL 批量执行到多个同类库" '
        + 'onclick="aiasExecuteSqlBatch(this.getAttribute(\'data-sql-id\'))">批量</button>'
        + '<button class="aias-sql-exec-btn" data-sql-id="' + sid + '" '
        + 'onclick="aiasExecuteSql(this.getAttribute(\'data-sql-id\'))">▶ 执行第 ' + (i + 1) + ' 条</button>'
        + '<div class="aias-sql-result" id="' + sid + '-result"></div>'
        + '</div>';
    } else {
      html += '<div class="aias-sql-static-tip">🔒 非查询语句，仅展示</div>';
    }
    html += '</div></div>';
  }
  // 「全部执行」用的结果区：整块 SQL 仍在 store 里，后端会再拆一次并逐条执行
  html += '<div class="aias-sql-result" id="' + sqlId + '-result"></div>';
  box.innerHTML = html;

  var parent = pre.parentNode;
  var anchor = wrap.nextSibling;
  _aiasSqlStore[sqlId] = escHtml(wholeSql);
  aiasSlotClose();                             // 若占位符菜单正开在这个块上，先关掉
  aiasSlotDropLedger(pre);                     // 块被换成子块 → 旧台账（连值一起）作废
  parent.removeChild(pre);
  wrap.parentNode.removeChild(wrap);           // 先摘掉旧的 -result，避免 id 重名
  parent.insertBefore(box, anchor);
  aiasLoadDialectBadge(box, sqlId);           // 阶段2：异步填充「版本确认」徽标
}

// ── 阶段2：SQL 块头部「数据源版本」徽标 ──
// 与后端 /api/chat/dialect-status 配套：它输出的「版本确认状态」和注入给模型的
// `_build_db_version_context` 来自同一套判定，保证「用户看到的徽标」与「AI 写 SQL 时
// 用的版本口径」一致。多语句块在拆分后异步填充，失败/无数据源时静默隐藏不打扰。
var _aiasDialectStatusCache = {};   // datasource名列表|join -> 状态数组

function aiasLoadDialectBadge(box, sqlId) {
  if (!box) return;
  var badge = box.querySelector('.aias-dialect-badge[data-dialect-sql-id="' + sqlId + '"]');
  if (!badge) return;
  var names = [], _seen = {};
  try {
    var _sess = aiasCurrentSession();
    if (_sess) {
      if (_sess.currentDatasource) { _seen[_sess.currentDatasource] = true; names.push(_sess.currentDatasource); }
      if (Array.isArray(_sess.datasources)) {
        _sess.datasources.forEach(function (n) {
          n = String(n || '').trim(); if (n && !_seen[n]) { _seen[n] = true; names.push(n); }
        });
      }
    }
  } catch (e) {}
  if (!names.length) { badge.remove(); return; }   // 无可确认数据源 → 藏掉徽标
  var key = names.join('|');
  if (_aiasDialectStatusCache[key] !== undefined) {
    aiasRenderDialectBadge(badge, _aiasDialectStatusCache[key]);
    return;
  }
  fetch('/api/chat/dialect-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasource_names: names })
  }).then(function (r) { return r.json(); }).then(function (d) {
    var ds = (d && d.ok && Array.isArray(d.datasources)) ? d.datasources : [];
    _aiasDialectStatusCache[key] = ds;
    if (badge.isConnected) aiasRenderDialectBadge(badge, ds);
  }).catch(function () { if (badge.isConnected) badge.remove(); });
}

function aiasRenderDialectBadge(badge, ds) {
  var confirmed = ds.filter(function (d) { return d && d.confirmed; });
  var unknown = ds.filter(function (d) { return d && !d.confirmed; });
  badge.classList.remove('is-loading');
  if (confirmed.length === 1 && ds.length === 1) {
    // 常态只显示「版本」降低刷屏；库名放进 tooltip（输入框胶囊已展示当前默认源）
    var _ver1 = confirmed[0].label || confirmed[0].version || '版本未知';
    badge.textContent = '🛢 ' + _ver1;
    badge.title = '目标库 ' + confirmed[0].name
      + ' · ' + (confirmed[0].version || confirmed[0].label || '版本未知')
      + '，已确认版本，生成 SQL 已按此版本适配';
    return;
  }
  if (confirmed.length === ds.length && ds.length > 1) {
    badge.textContent = '🛢 版本已确认(' + ds.length + '库)';
    badge.classList.remove('is-unknown');
    badge.title = '全部数据源版本已确认：\n' + confirmed.map(function (d) {
      return d.name + ' · ' + (d.label || d.version || '未知');
    }).join('\n');
    return;
  }
  if (unknown.length === ds.length) {
    badge.textContent = '⚠ 版本未知';
    badge.classList.add('is-unknown');
    badge.title = '未探测到目标库版本，生成 SQL 已采用跨版本保守写法，可能与你的库存在语法差异';
    return;
  }
  badge.textContent = '⚠ 部分库版本未知';
  badge.classList.add('is-unknown');
  badge.title = '已确认：' + confirmed.map(function (d) { return d.name; }).join('、')
    + '；未知：' + unknown.map(function (d) { return d.name; }).join('、');
}

// 复制"整块原始 SQL"（多语句头栏用）：文本从 store 取，与执行口径一致
function aiasCopySqlRaw(btn) {
  var id = btn ? (btn.getAttribute('data-sql-id') || '') : '';
  if (!id) return;
  aiasDoCopy(unescHtml(_aiasSqlStore[id] || ''), btn);
}

// ── 执行前「方言预检」──
// 解决的痛点（用户原话："每次都要修复语句呢，感觉一点都不智能"）：
// AI 不知道目标库版本时会写出该版本不支持的语法 —— 最典型是给 Oracle 11g 写
// 12c 的 `FETCH FIRST 20 ROWS ONLY`，点执行拿 ORA-00933、再点「AI 修复」，来回好几轮。
// 这里在**渲染 SQL 块时**就把结论摆出来，并给出**确定性**的一键改写。
//
// 规则与改写逻辑只在后端 `dbcheck/ai/dialect.py` 维护**一份**，前端只做：
//   ① 便宜的本地关键字预筛（不命中就不发请求）；② 展示结论；③ 调改写接口贴回结果。
var _aiasDialectTimer = null;
// 预筛用的粗关键字：命中才值得问后端（宁可多问几个，也不要漏掉真正的违规）
var _AIAS_DIALECT_HINT_RE = new RegExp(
  '\\bFETCH\\s+(FIRST|NEXT)\\b|\\bOFFSET\\s+\\d+\\s+ROWS?\\b|\\bIDENTITY\\b'
  + '|\\bJSON_(VALUE|QUERY|TABLE|EXISTS|OBJECT|ARRAY)\\s*\\(|\\bMATCH_RECOGNIZE\\s*\\('
  + '|\\bLATERAL\\s*\\(|\\bCROSS\\s+APPLY\\b|\\bAPPROX_COUNT_DISTINCT\\s*\\('
  + '|\\b(ROW_NUMBER|RANK|DENSE_RANK|LAG|LEAD|NTILE|FIRST_VALUE|LAST_VALUE)\\s*\\([^)]*\\)\\s*OVER\\s*\\('
  + '|\\bNULLS\\s+(FIRST|LAST)\\b'
  + '|(^|[\\s(])WITH\\s+[\\w`]+\\s+AS\\s*\\(', 'i');

function aiasScheduleDialectScan() {
  if (document.querySelector('.aias-cursor, .aias-drilldown-cursor, .aias-typing')) return;
  if (_aiasDialectTimer) clearTimeout(_aiasDialectTimer);
  _aiasDialectTimer = setTimeout(aiasScanDialectSql, 320);
}

function aiasScanDialectSql() {
  _aiasDialectTimer = null;
  var pres = document.querySelectorAll('pre.aias-code-pre');
  var need = [], target = [];
  for (var i = 0; i < pres.length; i++) {
    var pre = pres[i];
    if (pre.getAttribute('data-dialect-checked') === '1') continue;
    var txt = aiasSlotText(pre);
    if (!txt || !_AIAS_DIALECT_HINT_RE.test(txt)) {
      pre.setAttribute('data-dialect-checked', '1');   // 不含可疑关键字 → 不必问后端
      continue;
    }
    pre.setAttribute('data-dialect-checked', '1');
    need.push(txt);
    target.push(pre);
  }
  if (!need.length) return;
  fetch('/api/chat/dialect-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasource_name: aiasSlotDs(), sqls: need })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d || !d.ok || !d.results) return;
    for (var k = 0; k < target.length && k < d.results.length; k++) {
      var vs = ((d.results[k] || {}).violations) || [];
      if (vs.length && target[k].isConnected) {
        try { aiasShowDialectWarning(target[k], d, vs); } catch (e) {}
      }
    }
  }).catch(function () {});
}

function aiasShowDialectWarning(pre, meta, violations) {
  if (!pre || !pre.parentNode || pre.__dialectWarn) return;
  var v = violations[0];
  var box = document.createElement('div');
  box.className = 'aias-dialect-warn';
  var more = violations.length > 1 ? '（另有 ' + (violations.length - 1) + ' 处同类问题）' : '';
  box.innerHTML = '<div class="aias-dialect-head">⚠️ 目标库 <b>' + escHtml(meta.label || '未知版本')
    + '</b> 不支持这条语句里的语法' + more + '</div>'
    + '<div class="aias-dialect-body"><div>' + escHtml(v.msg || '') + '</div>'
    + (v.alt ? '<div class="aias-dialect-alt">正确写法：<code>' + escHtml(v.alt) + '</code></div>' : '')
    + (meta.ambiguous ? '<div class="aias-dialect-alt">ℹ️ 会话未指定数据源，按 <b>'
        + escHtml(meta.datasource || '') + '</b> 判定；若执行目标是别的库，请先选定数据源</div>' : '')
    + '</div><div class="aias-dialect-actions"></div>';
  var acts = box.querySelector('.aias-dialect-actions');
  if (v.rewrite) {
    var fix = document.createElement('button');
    fix.className = 'aias-dialect-fix';
    fix.textContent = '一键改写为兼容写法';
    fix.title = '按目标库版本做确定性改写（不是 AI 猜的）';
    fix.onclick = function () { aiasDialectRewrite(pre, box, fix, v.rewrite); };
    acts.appendChild(fix);
  }
  var ig = document.createElement('button');
  ig.className = 'aias-dialect-dismiss';
  ig.textContent = '忽略';
  ig.title = '这条语句我确认没问题，不再提示';
  ig.onclick = function () { if (box.parentNode) box.parentNode.removeChild(box); pre.__dialectWarn = null; };
  acts.appendChild(ig);
  pre.__dialectWarn = box;
  pre.parentNode.insertBefore(box, pre);
}

function aiasDialectRewrite(pre, box, btn, kind) {
  if (!pre || !btn) return;
  var sql = aiasSlotText(pre);
  var oldLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '改写中…';
  fetch('/api/chat/dialect-rewrite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: sql, kind: kind })
  }).then(function (r) { return r.json(); }).then(function (d) {
    btn.disabled = false;
    btn.textContent = oldLabel;
    if (!d || !d.ok || !d.changed) {
      // 改不动就把原因讲清楚 —— 静默失败最让人恼火
      var note = box.querySelector('.aias-dialect-alt');
      if (note) note.innerHTML = 'ℹ️ ' + escHtml((d && (d.reason || d.error)) || '无法自动改写，请参考上面的正确写法手工调整');
      return;
    }
    aiasSetBlockSql(pre, d.sql);
    if (box.parentNode) box.parentNode.removeChild(box);
    pre.__dialectWarn = null;
    pre.removeAttribute('data-dialect-checked');      // 改写后可能有新问题，允许再检一次
    aiasScheduleDialectScan();
  }).catch(function (e) {
    btn.disabled = false;
    btn.textContent = oldLabel;
    var note = box.querySelector('.aias-dialect-alt');
    if (note) note.innerHTML = '⚠️ 改写请求失败：' + escHtml((e && e.message) || '网络异常');
  });
}

// 把新的 SQL 写回某个代码块（DOM + 执行用的存储 + 台账/按钮/提示同步）
// 抽出来是因为「AI 修复」与「方言一键改写」是同一套收尾动作，别两处各写一遍漂移。
function aiasSetBlockSql(pre, newSql) {
  if (!pre) return;
  var code = pre.querySelector('code') || pre;
  code.textContent = newSql;
  var id = aiasSlotSqlId(pre);
  if (id) _aiasSqlStore[id] = escHtml(newSql);
  // ★ 语句本身被改写了 → 台账要**按新语句重建**（不能拿改写前的旧基线回写，
  //   否则撤销替换会把刚改好的语法又吃回去）。重建后右上角「撤销占位符替换」
  //   依然可用，且恢复的是适配新 SQL 的占位符版本。
  aiasSlotRebaseLedger(pre, newSql);
  aiasSlotRefreshRestoreBtn(pre);
  aiasSlotUpdateHint(pre);
}

// 从工具参数中提取数据源并记录到会话上下文（供 SQL 一键执行引用上文数据源）
function aiasTrackDatasource(args) {
  try {
    if (!args || !args.datasource_name) return;
    var sess = aiasCurrentSession();
    if (sess) {
      sess.currentDatasource = args.datasource_name;
      if (!sess.datasources) sess.datasources = [];
      if (sess.datasources.indexOf(args.datasource_name) === -1) {
        sess.datasources.push(args.datasource_name);
      }
      aiasSaveSessions();
      aiasRefreshDsCapsule();
    }
  } catch(e) {}
}

// 刷新输入框上方的「当前数据源」常驻胶囊（显示会话默认执行源）
function aiasRefreshDsCapsule() {
  try {
    var bar = document.getElementById('aias-ds-capsule');
    if (!bar) return;
    var nameEl = document.getElementById('aias-ds-capsule-name');
    var icoEl = document.getElementById('aias-ds-capsule-icon');
    var btnEl = document.getElementById('aias-ds-capsule-btn');
    var ds = '';
    try { ds = (aiasCurrentSession() || {}).currentDatasource || ''; } catch(e) {}
    if (nameEl) nameEl.textContent = ds || '未选择数据源';
    if (btnEl) btnEl.classList.toggle('is-empty', !ds);
    if (icoEl) icoEl.textContent = ds ? '🏢' : '🏢';
  } catch(e) {}
}

// 点击胶囊 → 弹出数据源选择框，选中即固化为会话默认执行源
function aiasChangeDefaultDs() {
  var modal = document.getElementById('aias-ds-modal');
  var opts = _aiasDsDsList || [];
  if (opts.length) {
    aiasShowDsModal(opts, '选择会话默认数据源（SQL 默认执行于此）：', function(ds) {
      aiasTrackDatasource({ datasource_name: ds });
    });
    return;
  }
  fetch('/api/pro/datasources')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok && data.datasources && data.datasources.length) {
        _aiasDsDsList = data.datasources;
        aiasShowDsModal(data.datasources, '选择会话默认数据源（SQL 默认执行于此）：', function(ds) {
          aiasTrackDatasource({ datasource_name: ds });
        });
      } else {
        aiasShowDsModal([], '暂无可用数据源，请先到「数据源管理」添加', function() {});
      }
    })
    .catch(function() {
      aiasShowDsModal([], '获取数据源列表失败', function() {});
    });
}

// 获取 SQL 执行使用的数据源：优先会话上下文（上文提到的数据源），回退页面当前选择
function aiasGetSqlDatasource() {
  try {
    var sess = aiasCurrentSession();
    if (sess && sess.currentDatasource) return sess.currentDatasource;
  } catch(e) {}
  try {
    var ctx = getChatContext();
    if (ctx && ctx.datasource_name) return ctx.datasource_name;
  } catch(e) {}
  return '';
}

// 构建 SQL 执行错误展示 HTML（可选附「AI 修复」按钮）
function aiasBuildSqlErrorHtml(sqlId, errText, showFixBtn, repair) {
  var html = '<div class="aias-sql-result-error">'
    + '<div>⚠️ ' + escHtml(errText) + '</div>';
  // 「字段不存在」：给出确定性修正信息（真实列清单 + 建议列），并提示 AI 修复会据此重写
  try {
    if (repair && typeof repair === 'object') {
      var bad = repair.bad_column || '';
      var tables = Array.isArray(repair.tables) ? repair.tables : [];
      var sug = repair.suggestion || null;
      var parts = [];
      tables.forEach(function (t) {
        var cols = Array.isArray(t.columns) ? t.columns : [];
        if (cols.length) {
          parts.push('<div class="aias-repair-obj"><span>列 </span><code>'
            + escHtml(bad) + '</code><span> 在 </span><b>' + escHtml(t.table)
            + '</b><span> 中不存在</span>'
            + '<div class="aias-repair-cols">真实列：' + escHtml(cols.join(', ')) + '</div></div>');
        }
      });
      if (sug && sug.suggested) {
        parts.push('<div class="aias-repair-sug">✅ 建议列：<code>' + escHtml(sug.suggested)
          + '</code>（表 ' + escHtml(sug.table) + '）</div>');
      } else if (!parts.length) {
        parts.push('<div class="aias-repair-cols">列 <code>' + escHtml(bad)
          + '</code> 在目标对象中不存在，可能是字段名记错了。</div>');
      }
      html += '<div class="aias-repair-box">' + parts.join('')
        + '<div class="aias-repair-tip">点下方「✨ AI 修复」将按真实列清单重写此 SQL。</div></div>';
    }
  } catch (e) {}
  if (showFixBtn) {
    html += '<button class="aias-sql-fix-btn" onclick="aiasFixSql(\'' + sqlId + '\')">✨ AI 修复</button>';
  }
  html += '</div>';
  return html;
}

// 单条查询结果的 HTML（表头 + 行数 + @rN 承接提示 + 数据表格）
// 抽成独立函数：单语句与多语句共用，避免两处渲染逻辑漂移。
function aiasBuildOneResultHtml(res, varName) {
  res = res || {};
  var columns = res.columns || [];
  var rows = res.rows || [];
  var total = res.total || 0;
  var html = '<div class="aias-sql-result-ok">✅ 查询成功，共 ' + total + ' 行'
    + (rows.length < total ? '（显示前 ' + rows.length + ' 行）' : '') + '</div>';
  if (columns.length > 0) {
    html += '<div class="aias-sql-result-table-wrap">'
      + '<div class="aias-sql-result-maxbar">'
      + '<span class="aias-sql-result-maxtip">' + columns.length + ' 列 · ' + rows.length + ' 行</span>'
      + '<button class="aias-sql-result-maxbtn" onclick="aiasMaximizeResultTable(this)" '
      + 'title="最大化查看结果（Esc 退出）">⛶ 最大化</button>'
      + '</div>'
      + '<div class="aias-sql-result-table-scroll"><table class="aias-sql-result-table"><thead><tr>';
    for (var ci = 0; ci < columns.length; ci++) {
      html += '<th>' + escHtml(String(columns[ci])) + '</th>';
    }
    html += '</tr></thead><tbody>';
    for (var ri = 0; ri < rows.length; ri++) {
      html += '<tr>';
      for (var cj = 0; cj < columns.length; cj++) {
        var cell = rows[ri][cj];
        html += '<td>' + (cell === null || cell === undefined
          ? '<span class="aias-sql-null">NULL</span>' : escHtml(String(cell))) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table></div></div>';
  } else {
    html += '<div class="aias-sql-result-ok">（无返回列）</div>';
  }
  return html;
}

// ── 结果表格「最大化」查看 ──
// 点击「⛶ 最大化」把结果表格放到全屏遮罩层完整查看；Esc / 点击遮罩 / 关闭按钮退出。
// 同一套机制服务三类表格：单条 SQL 的结果、批量执行汇总、批量执行里每个库的明细。
// 它们原本各自实现（或压根没有）的最大化，行为会出现差别 —— 比如批量明细只能在一小块
// 里横向滚，宽表根本看不全，而单条结果却有全屏按钮。
var _aiasMaxOv = null;
var _aiasMaxOnKey = null;
var _aiasMaxHome = null;      // 最大化前表格所在 wrap，退出时移回原位
var _aiasMaxExtras = [];      // 跟着进全屏层的附属节点（明细面板容器），关闭时按原位放回
var _aiasSplitBottom = false; // 分栏时明细的位置：false=右侧（同屏对照），true=底部（占满整宽）。本会话内记住用户的选择

/**
 * 把 wrap 里的第一张表格搬进全屏查看层。
 * 直接搬原 DOM（不克隆）：退出后回到原位，滚动位置与行内状态都不丢。
 * 同一时刻只允许一个全屏层，重复点击先关旧的（否则遮罩会叠遮罩，Esc 只退得掉最上层）。
 */
function aiasMaximizeTableIn(wrap, title) {
  try {
    if (!wrap || !wrap.querySelector) return;
    var tbl = wrap.querySelector('table');
    if (!tbl) return;
    aiasCloseResultMaximize();
    var ov = document.createElement('div');
    ov.className = 'aias-result-max-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    var head = document.createElement('div');
    head.className = 'aias-result-max-head';
    var ttl = document.createElement('span');
    ttl.className = 'aias-result-max-title';
    ttl.textContent = title || '📊 查询结果全屏查看';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'aias-result-max-close';
    closeBtn.setAttribute('onclick', 'aiasCloseResultMaximize()');
    closeBtn.title = '关闭（Esc）';
    closeBtn.textContent = '✕ 关闭 (Esc)';
    head.appendChild(ttl);
    head.appendChild(closeBtn);
    var body = document.createElement('div');
    body.className = 'aias-result-max-body';
    // 移动表格进全屏层；退出时再移回原 wrap
    _aiasMaxHome = wrap;
    body.appendChild(tbl);
    ov.appendChild(head);
    ov.appendChild(body);
    document.body.appendChild(ov);
    // 遮罩点击（非内容区）关闭
    ov.addEventListener('mousedown', function (e) {
      if (e.target === ov) aiasCloseResultMaximize();
    });
    _aiasMaxOv = ov;
    _aiasMaxOnKey = function (e) {
      if (e && (e.key === 'Escape' || e.key === 'Esc')) {
        e.preventDefault();
        // 层里正在用双击取词时，第一次 Esc 先收掉高亮：两个监听都挂在 document 上，
        // 让关层这条自己认输，比靠 stopImmediatePropagation 抢顺序可靠
        // （取词条是开层之后才挂的监听，抢不过）。
        if (_aiasHl && _aiasHl.term && _aiasHl.bar && ov.contains && ov.contains(_aiasHl.bar)) {
          aiasHlDeactivate();
          return;
        }
        aiasCloseResultMaximize();
      }
    };
    document.addEventListener('keydown', _aiasMaxOnKey);
    document.body.style.overflow = 'hidden';   // 锁住背景滚动
    return true;
  } catch (e) { return false; }
}

/** 单条 SQL 结果的最大化入口（语句块结果区里那个 ⛶）。 */
function aiasMaximizeResultTable(btn) {
  var wrap = (btn && btn.closest) ? btn.closest('.aias-sql-result-table-wrap') : null;
  return aiasMaximizeTableIn(wrap, '📊 查询结果全屏查看');
}

/** 批量执行明细的最大化入口：标题带上是哪个库，横向对比时不会认错窗口。 */
function aiasMaximizeBatchDetail(btn) {
  var panel = (btn && btn.closest) ? btn.closest('.aias-batch-detail-panel') : null;
  if (!panel) return;
  var wrap = panel.querySelector('.aias-batch-mini-table-wrap');
  var name = panel.getAttribute('data-ds-name') || '该数据源';
  var rows = wrap ? (wrap.querySelectorAll('tbody tr').length) : 0;
  aiasMaximizeTableIn(wrap, '🏢 ' + name + ' · 结果全屏查看（' + rows + ' 行）');
}

/** 明细面板容器跟着表格进全屏层，并让全屏层变成分栏（左表格 / 右明细）。
    原位置记下来，关闭全屏层时按原位放回：面板内容不重建，已展开的状态也不丢。 */
function aiasMovePanelsIntoOverlay(panelsEl, overlay) {
  var body = overlay.querySelector ? overlay.querySelector('.aias-result-max-body') : null;
  if (!body || panelsEl.parentNode === body) return;
  if (!panelsEl.__aiasHome) {
    panelsEl.__aiasHome = { parent: panelsEl.parentNode, next: panelsEl.nextSibling };
    _aiasMaxExtras.push(panelsEl);
  }
  body.appendChild(panelsEl);
  body.classList.add('is-split');
  aiasEnsureSplitToggle(overlay);
}

/** 分栏时给全屏层头部加一个「明细位置」切换按钮（右侧 ⇄ 底部）。
    默认右侧分栏：汇总在左、明细在右，同屏对照不用滚动，是批量对比的主用法；
    明细列特别多时一键改到下方占满整宽。选择在本会话内记住，下次开层沿用。
    只在有明细面板（is-split）时出现；窄屏（≤1100px）本来就强制上下堆叠，CSS 里隐藏。 */
function aiasEnsureSplitToggle(overlay) {
  if (!overlay || !overlay.querySelector) return null;
  var head = overlay.querySelector('.aias-result-max-head');
  var body = overlay.querySelector('.aias-result-max-body');
  if (!head || !body) return null;
  var btn = head.querySelector('.aias-split-toggle');
  if (!btn) {
    btn = document.createElement('button');
    btn.className = 'aias-split-toggle';
    btn.setAttribute('type', 'button');
    btn.addEventListener('click', function () {
      _aiasSplitBottom = !_aiasSplitBottom;
      aiasApplySplitLayout(body, btn);
    });
    var closeBtn = head.querySelector('.aias-result-max-close');
    if (closeBtn) head.insertBefore(btn, closeBtn); else head.appendChild(btn);
  }
  aiasApplySplitLayout(body, btn);
  return btn;
}

/** 按当前选择给全屏层 body 上/下 is-bottom 标记，并把按钮文案切成「下一步动作」。 */
function aiasApplySplitLayout(body, btn) {
  if (!body) return;
  if (_aiasSplitBottom) body.classList.add('is-bottom');
  else body.classList.remove('is-bottom');
  if (btn) {
    btn.textContent = _aiasSplitBottom
      ? aiasT('webui.aias_split_to_right', '⇨ 明细居右')
      : aiasT('webui.aias_split_to_bottom', '⇩ 明细置底');
    btn.title = _aiasSplitBottom
      ? aiasT('webui.aias_split_tip_right', '切换：明细显示在汇总表右侧（同屏对照）')
      : aiasT('webui.aias_split_tip_bottom', '切换：明细显示在汇总表下方（占满整宽）');
    btn.setAttribute('aria-pressed', _aiasSplitBottom ? 'true' : 'false');
  }
}

function aiasRestoreOverlayExtras() {
  for (var i = _aiasMaxExtras.length - 1; i >= 0; i--) {
    var node = _aiasMaxExtras[i];
    var home = node.__aiasHome;
    node.__aiasHome = null;
    try {
      if (!home || !home.parent || !home.parent.insertBefore) continue;
      // 锚点必须还在这个父节点里，否则 insertBefore 在真实 DOM 会抛 NotFoundError；
      // 收尾一旦中断，遮罩就关不掉了（全屏层卡死在页面上）。
      var ref = (home.next && home.next.parentNode === home.parent) ? home.next : null;
      home.parent.insertBefore(node, ref);
    } catch (e) {}
  }
  _aiasMaxExtras = [];
}

/** 批量执行汇总表的最大化入口：几十个库一起跑时，五列表格在一行里根本排不开。 */
function aiasMaximizeBatchSummary(btn) {
  var box = (btn && btn.closest) ? btn.closest('.aias-batch-summary-wrap') : null;
  if (!box) return;
  var host = box.querySelector('.aias-batch-table-wrap') || box;
  // 明细面板容器要在搬表之前取引用：表格一搬进全屏层，原容器里就查不到它了
  var panelsEl = box.querySelector('.aias-batch-detail-panels');
  if (!aiasMaximizeTableIn(host, '📊 批量执行结果汇总全屏查看')) return;
  // 已经展开过的明细一起搬进来：否则全屏层里只剩表格，点「查看」出来的东西
  // 还在被遮住的底下，看起来就是「点了没反应」
  var overlay = document.querySelector('.aias-result-max-overlay');
  if (panelsEl && panelsEl.children.length && overlay) {
    aiasMovePanelsIntoOverlay(panelsEl, overlay);
  }
}

function aiasCloseResultMaximize() {
  try {
    if (_aiasMaxOnKey) {
      document.removeEventListener('keydown', _aiasMaxOnKey);
      _aiasMaxOnKey = null;
    }
    document.body.style.overflow = '';
    if (!_aiasMaxOv) return;
    var ov = _aiasMaxOv;
    _aiasMaxOv = null;
    var body = ov.querySelector('.aias-result-max-body');
    var tbl = body ? body.querySelector('table') : null;
    if (tbl) {
      // 移回原位置（若消息已被重建/移除则就地保留成静态表格，避免数据丢失）
      var home = _aiasMaxHome;
      _aiasMaxHome = null;
      var scroller = (home && home.isConnected)
        ? (home.querySelector('.aias-sql-result-table-scroll') ||
           (home.tagName === 'TABLE' ? null : home)) : null;
      if (scroller) {
        scroller.appendChild(tbl);
      } else {
        // 原位失效：就地挂一张静态表，位置放在遮罩**的兄弟节点**处。
        // 挂进遮罩里等于跟着遮罩一起被摘掉（表格当场消失），而且在真实 DOM 里
        // insertBefore(holder, ov) 因 ov 不是遮罩的子节点会抛 NotFoundError，
        // 整个收尾被 catch 吞掉 —— 全屏层就永远关不掉了。
        var holder = document.createElement('div');
        holder.className = 'aias-sql-result-table-scroll';
        holder.appendChild(tbl);
        var anchor = ov.parentNode || document.body;
        if (anchor && anchor.insertBefore && ov.parentNode) {
          anchor.insertBefore(holder, ov);
        } else if (anchor && anchor.appendChild) {
          anchor.appendChild(holder);
        }
      }
    }
    // 面板必须在遮罩被摘掉之前搬回原位，否则连同遮罩一起被丢弃（明细就永久消失了）
    if (body) { body.classList.remove('is-split'); body.classList.remove('is-bottom'); }
    aiasRestoreOverlayExtras();
    aiasHlOverlayClosed(ov);   // 层里的高亮条要跟着收掉，不然 Esc/↑↓ 会挂在死条上
    ov.parentNode && ov.parentNode.removeChild(ov);
  } catch (e) {}
}

// 多语句结果：按执行顺序逐条分块展示（每条带「第 N 条」+ 语句原文 + 独立结果/报错）。
// 一个框里多条语句是 AI 建议 SQL 的常见形态，必须逐条给出结果，否则用户无法判断
// 到底是哪一条查到了数据、哪一条失败。
function aiasBuildMultiResultHtml(data, sqlId) {
  var stmts = data.statements || [];
  var failedIdx = data.failed_index;
  var html = '<div class="aias-sql-multi-summary' + (failedIdx ? ' has-err' : '') + '">'
    + (failedIdx
        ? '⚠️ 共 ' + data.count + ' 条语句：成功 ' + data.succeeded + ' 条，<b>第 ' + failedIdx
          + ' 条失败</b>，其后的语句未执行'
        : '✅ 共 ' + data.count + ' 条语句，全部执行成功')
    + '</div>';
  for (var i = 0; i < stmts.length; i++) {
    var st = stmts[i];
    html += '<div class="aias-sql-stmt-block ' + (st.ok ? 'ok' : 'err') + '">';
    html += '<div class="aias-sql-stmt-head">'
      + '<span class="aias-sql-stmt-no">第 ' + st.index + ' 条</span>'
      + '<span class="aias-sql-stmt-badge">' + (st.skipped ? '未执行' : (st.ok ? '✓ 成功' : '✗ 失败')) + '</span>'
      + (st.duration_ms ? '<span class="aias-sql-stmt-ms">' + st.duration_ms + 'ms</span>' : '')
      + '</div>';
    html += '<pre class="aias-sql-stmt-sql">' + escHtml(st.sql || '') + '</pre>';
    if (st.ok) {
      html += aiasBuildOneResultHtml(st.result, st.var_name);
    } else {
      html += aiasBuildSqlErrorHtml(sqlId + '-s' + st.index, st.error || '执行失败', true, st.repair);
    }
    html += '</div>';
  }
  if (data.error) {
    html += aiasBuildSqlErrorHtml(sqlId, data.error, !!data.db_error, data.repair);
  }
  return html;
}

// 「全部执行」时把逐条结果**分发回各语句子块**。
// 不这么做的话：整块会再渲染一遍"第 N 条 + SQL 原文 + 结果"，页面上就出现两份一样的 SQL，
// 用户还得自己对齐哪份是哪份。
function aiasFillSplitResults(sqlId, data, dsName) {
  var box = document.querySelector('.aias-sql-split[data-sql-id="' + sqlId + '"]');
  if (!box) return false;
  // 整块级「异源」提示（拆分子块只在块顶标一次，不逐条刷屏）
  var _tip = aiasDsOverrideTag(dsName);
  if (_tip) box.insertAdjacentHTML('afterbegin', _tip);
  var stmts = data.statements || [];
  for (var i = 0; i < stmts.length; i++) {
    var st = stmts[i] || {};
    var sid = sqlId + '-s' + st.index;
    var rd = document.getElementById(sid + '-result');
    if (!rd) continue;
    if (st.skipped) {
      rd.innerHTML = '<div class="aias-sql-result-error">未执行（前一条失败或超时）</div>';
    } else if (st.ok) {
      rd.innerHTML = aiasBuildOneResultHtml(st.result, st.var_name)
        + aiasZeroRowPlaceholderHint(st.result, sid);
    } else {
      // 每条失败各自记上下文：这样「AI 修复」只修这一条，不会牵连其他条
      _aiasSqlErrors[sid] = st.error || '执行失败';
      _aiasSqlDs[sid] = dsName || '';
      _aiasSqlRepair[sid] = st.repair || null;
      rd.innerHTML = aiasBuildSqlErrorHtml(sid, st.error || '执行失败', true, st.repair);
    }
  }
  var note = box.querySelector('.aias-sql-split-note');
  if (note) {
    if (data.error) {
      note.innerHTML = '<span style="color:#d97706">⚠️ 成功 ' + (data.succeeded || 0) + '/'
        + (data.count || stmts.length) + ' 条 · ' + escHtml(data.error) + '</span>';
    } else {
      note.innerHTML = '<span style="color:#4caf50">✅ ' + (data.count || stmts.length)
        + ' 条全部执行成功</span>';
    }
  }
  return true;
}

// 读取「行数上限」：全局优先（输入框上方胶囊旁，所有 SQL 共用）；
// 历史消息若无全局值则回退块内输入（兼容旧消息），默认 20，钳制在 [1,5000]。
function aiasRowLimitValue(resultDiv) {
  var v = 20;
  try {
    var input = null;
    var g = document.getElementById('aias-global-max-rows');
    if (g && g.value) {
      input = g;
    } else if (resultDiv) {
      var splitBox = resultDiv.closest('.aias-sql-split');
      if (splitBox) {
        input = splitBox.querySelector('.aias-sql-split-head .aias-row-limit input');
      } else {
        var wrap = resultDiv.closest('.aias-sql-exec-wrap');
        if (wrap) input = wrap.querySelector('.aias-row-limit input');
      }
    }
    if (input) {
      var n = parseInt(input.value, 10);
      if (!isNaN(n) && n >= 1) v = n;
    }
  } catch(e) {}
  if (v > 5000) v = 5000;
  return v;
}

// 全局行数上限：保存（钳制 1-5000）并持久化到 localStorage，重新执行后生效
function aiasSaveGlobalRowLimit() {
  try {
    var input = document.getElementById('aias-global-max-rows');
    if (!input) return;
    var n = parseInt(input.value, 10);
    if (isNaN(n) || n < 1) n = 20;
    if (n > 5000) n = 5000;
    input.value = n;
    localStorage.setItem('aias_global_max_rows', String(n));
  } catch(e) {}
}
// 初始化全局行数上限（从 localStorage 恢复上次设置）
function aiasInitGlobalRowLimit() {
  try {
    var input = document.getElementById('aias-global-max-rows');
    if (!input) return;
    var saved = localStorage.getItem('aias_global_max_rows');
    var n = saved ? parseInt(saved, 10) : 20;
    if (isNaN(n) || n < 1) n = 20;
    if (n > 5000) n = 5000;
    input.value = n;
  } catch(e) {}
}

// 实际执行 SQL（指定数据源）
function aiasRunSql(sqlId, dsName) {
  var sql = _aiasSqlStore[sqlId] || '';
  var resultDiv = document.getElementById(sqlId + '-result');
  if (!resultDiv) return;
  if (!dsName) {
    resultDiv.innerHTML = '<div class="aias-sql-result-error">⚠️ 未选择数据源</div>';
    return;
  }
  // 记录到会话上下文（后续 SQL 默认使用该数据源）
  aiasTrackDatasource({ datasource_name: dsName });
  // 获取会话 ID（用于变量承接）
  var sessId = '';
  try {
    var sess = aiasCurrentSession();
    sessId = (sess && sess.id) || '';
  } catch(e) {}
  // 行数上限：拆分行取头栏输入、单行取执行栏输入；读取逻辑里已有钳制与兜底
  var maxRows = aiasRowLimitValue(resultDiv);
  resultDiv.innerHTML = '<div class="aias-sql-result-loading">⏳ 在数据源 <b>' + escHtml(dsName) + '</b> 上执行中...</div>';
  fetch('/api/chat/execute-sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasource_name: dsName, sql: unescHtml(sql), session_id: sessId, max_rows: maxRows })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    // ── 多条语句（一个框里多句，分号分隔）：逐条展示结果 ──
    // 注意必须先判 multi：某条失败时 data.ok 也是 false，
    // 若先走单条错误分支，已成功那几条的结果就丢了。
    if (data.multi) {
      _aiasSqlDs[sqlId] = dsName;
      if (data.error) _aiasSqlErrors[sqlId] = data.error;
      else delete _aiasSqlErrors[sqlId];
      _aiasSqlRepair[sqlId] = data.repair || null;
      // 块已被拆成语句子块 → 结果直接分发到各子块（页面上只有一份 SQL）
      if (aiasFillSplitResults(sqlId, data, dsName)) return;
      // 紧凑视图兜底：给失败子句也登记上下文，保证「AI 修复」按钮可点
      var _stmts = data.statements || [];
      for (var _si = 0; _si < _stmts.length; _si++) {
        var _st = _stmts[_si] || {};
        if (_st.ok || _st.skipped) continue;
        var _sid = sqlId + '-s' + _st.index;
        _aiasSqlErrors[_sid] = _st.error || '执行失败';
        _aiasSqlDs[_sid] = dsName;
        _aiasSqlRepair[_sid] = _st.repair || null;
      }
      resultDiv.innerHTML = aiasDsOverrideTag(dsName) + aiasBuildMultiResultHtml(data, sqlId);
      return;
    }
    if (!data.ok) {
      // 记录报错信息与数据源，供「AI 修复」按钮使用
      _aiasSqlErrors[sqlId] = data.error || '执行失败';
      _aiasSqlDs[sqlId] = dsName;
      _aiasSqlRepair[sqlId] = data.repair || null;
      // 仅当错误来自真实数据库执行（db_error）时显示「AI 修复」按钮
      resultDiv.innerHTML = aiasDsOverrideTag(dsName) + aiasBuildSqlErrorHtml(sqlId, _aiasSqlErrors[sqlId], !!data.db_error, data.repair);
      return;
    }
    resultDiv.innerHTML = aiasDsOverrideTag(dsName) + aiasRewriteNoteTag(data.result, dsName)
      + aiasBuildOneResultHtml(data.result, data.var_name)
      + aiasZeroRowPlaceholderHint(data.result, sqlId);
  })
  .catch(function(err) {
    resultDiv.innerHTML = '<div class="aias-sql-result-error">⚠️ 请求失败: ' + escHtml(err.message) + '</div>';
  });
}

// 方言改写提示：执行前按数据源已确认版本自动改写了 SQL（如 11g 的 FETCH FIRST→ROWNUM）。
// 仅当后端返回 rewritten=true 时输出，常态零噪音。
function aiasRewriteNoteTag(result) {
  try {
    if (!result || !result.rewritten) return '';
    var note = result.rewrite_note || '已按数据源版本自动改写 SQL 后执行';
    return '<div class="aias-sql-rewrite-tag">🔧 ' + escHtml(note) + '</div>';
  } catch(e) { return ''; }
}

// 结果区「异源」提示：仅当此块实际用的数据源与会话默认不一致时才返回标签，否则空串（常态零噪音）
function aiasDsOverrideTag(dsName) {
  try {
    var def = aiasGetSqlDatasource();
    if (!dsName || (def && dsName === def)) return '';
    return '<div class="aias-sql-override-tag">↪ 已用数据源：<b>' + escHtml(dsName) + '</b>（与会话默认不同）</div>';
  } catch(e) { return ''; }
}

// ── 批量执行：同一套 SQL 跑多个同类库 ──
// 选择阶段用多选弹窗（锁定同类型 + 全选本类型）；执行阶段逐源串行调用 /api/chat/execute-sql，
// 每源独立结果；汇总用「源为行」的对比表。批量下不承接 @rN（多源无意义且会串源）。
var _aiasBatchAbort = false;   // 供中途停止
function aiasExecuteSqlBatch(sqlId) {
  var sql = _aiasSqlStore[sqlId] || '';
  var resultDiv = document.getElementById(sqlId + '-result');
  if (!resultDiv) return;
  if (!sql.trim()) {
    resultDiv.innerHTML = '<div class="aias-sql-result-error">SQL 为空</div>';
    return;
  }
  var sessId = '';
  try { sessId = (aiasCurrentSession() || {}).id || ''; } catch(e) {}
  var maxRows = aiasRowLimitValue(resultDiv);

  var doRun = function(dsList) {
    if (!dsList || !dsList.length) return;
    // 上限保护：一次最多 20 源，超出提示分批
    if (dsList.length > 20) {
      alert('一次最多批量执行 20 个数据源，当前 ' + dsList.length + ' 个，请分批执行');
      return;
    }
    resultDiv.innerHTML = '<div class="aias-sql-result-loading">🔄 正在批量执行到 ' + dsList.length + ' 个数据源（串行）…</div>'
      + '<div class="aias-batch-status"></div>'
      + '<button class="aias-batch-stop" onclick="aiasBatchStop()">■ 停止</button>';
    _aiasBatchAbort = false;
    var results = [];
    var names = dsList.map(function(d) { return d.name || d.datasource_name || ''; });
    var i = 0;
    (function next() {
      if (_aiasBatchAbort) {
        resultDiv.innerHTML = '<div class="aias-sql-result-error">⚠️ 已手动停止（完成 ' + results.length + '/' + dsList.length + '）</div>';
        return;
      }
      if (i >= dsList.length) {
        aiasRenderBatchSummary(resultDiv, sqlId, dsList, results);
        return;
      }
      var ds = dsList[i];
      var name = names[i];
      var statusEl = resultDiv.querySelector('.aias-batch-status');
      if (statusEl) statusEl.textContent = '正在执行 ' + (i + 1) + '/' + dsList.length + ' · ' + name;
      fetch('/api/chat/execute-sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasource_name: name, sql: unescHtml(sql), session_id: sessId, max_rows: maxRows })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var err = '';
        if (data.multi) {
          err = data.error || (data.failed_index ? ('第 ' + data.failed_index + ' 条失败') : '');
        } else if (!data.ok) {
          err = data.error || '执行失败';
        }
        results.push({
          name: name,
          db_type: ds.db_type || '',
          total: (data.result && data.result.total) || (data.multi && data.statements ? data.statements.length : 0),
          ok: !err,
          error: err,
          result: data.result || null,
          multi: data.multi || false
        });
        i++;
        next();
      })
      .catch(function(errObj) {
        results.push({ name: name, db_type: ds.db_type || '', total: 0, ok: false, error: '请求失败: ' + (errObj && errObj.message || '网络异常'), result: null, multi: false });
        i++;
        next();
      });
    })();
  };

  // 先取全量数据源列表 → 打开多选弹窗（锁定同类型 + 全选本类型）
  resultDiv.innerHTML = '<div class="aias-sql-result-loading">⏳ 加载数据源列表...</div>';
  fetch('/api/pro/datasources')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok && data.datasources && data.datasources.length) {
        _aiasDsDsList = data.datasources;
        aiasShowDsMultiModal(data.datasources, '批量执行 · 选择要执行的同类库', doRun);
      } else {
        resultDiv.innerHTML = '<div class="aias-sql-result-error">⚠️ 暂无可用数据源，请先在「数据源管理」中添加</div>';
      }
    })
    .catch(function() {
      resultDiv.innerHTML = '<div class="aias-sql-result-error">⚠️ 获取数据源列表失败</div>';
    });
}

function aiasBatchStop() {
  _aiasBatchAbort = true;
}

// 汇总对比表：源为行、成功/行数/状态为列；点行可展开该源的具体结果
function aiasRenderBatchSummary(resultDiv, sqlId, dsList, results) {
  var okCount = results.filter(function(r) { return r.ok; }).length;
  var failCount = results.length - okCount;
  // 整块包一层 wrap： maximize 靠它定位表格，退出时表格能搬回原处
  var html = '<div class="aias-batch-summary-wrap">';
  html += '<div class="aias-batch-summary' + (failCount ? ' has-err' : '') + '">'
    + (failCount
        ? '⚠️ 批量完成：成功 <b>' + okCount + '</b> / ' + results.length + '，失败 <b>' + failCount + '</b>'
        : '✅ 批量完成：' + results.length + ' 个数据源全部执行成功')
    + '</div>';
  html += '<div class="aias-batch-maxbar">'
    + '<span class="aias-batch-maxtip">' + results.length + ' 个数据源 · 成功 ' + okCount + '</span>'
    + '<button class="aias-batch-zoom" onclick="aiasMaximizeBatchSummary(this)" '
    + 'title="全屏查看汇总表（Esc 退出）">⛶ 最大化</button>'
    + '</div>';
  html += '<div class="aias-batch-table-wrap"><table class="aias-batch-table" data-sql-id="'
    + escHtml(sqlId) + '"><thead><tr>'
    + '<th>数据源</th><th>类型</th><th>状态</th><th>行数</th><th>详情</th>'
    + '</tr></thead><tbody>';
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    html += '<tr class="' + (r.ok ? '' : 'is-err') + '">'
      + '<td class="aias-batch-ds">' + escHtml(r.name) + '</td>'
      + '<td>' + escHtml(r.db_type || '') + '</td>'
      + '<td>' + (r.ok ? '✓ 成功' : '✗ ' + escHtml(r.error || '失败')) + '</td>'
      + '<td>' + (r.total || 0) + '</td>'
      + '<td>' + (r.result
          ? '<button class="aias-batch-detail" onclick="aiasBatchToggleDetail(\'' + escHtml(r.name).replace(/'/g, "\\'") + '\')">查看</button>'
          : '') + '</td>'
      + '</tr>';
  }
  html += '</tbody></table></div>';
  html += '<div class="aias-batch-detail-panels" data-sql-id="' + escHtml(sqlId) + '" id="aias-batch-detail-' + sqlId + '"></div>';
  html += '<div class="aias-batch-dsname-map" style="display:none" id="aias-batch-map-' + sqlId + '">'
    + JSON.stringify(results.map(function(r) { return { name: r.name, result: r.result, ok: r.ok, error: r.error, multi: r.multi }; }))
    + '</div>';
  html += '</div>';
  resultDiv.innerHTML = html;
  window['_aiasBatchResults_' + sqlId] = results;
}

// 明细面板的 DOM 句柄：数据源名是中文时，\W+ 会把整串抹成同一个 '_'，
// 两个库就会抢同一个 id —— 表现是「点第二个库的查看没反应，只显示第一个库的结果」。
// 保留可读前缀（便于排查），再挂上名字自身的哈希，保证一名一句柄。
function aiasBatchPanelKey(sqlId, name) {
  var s = String(name == null ? '' : name);
  var h = 0;
  for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  var readable = s.slice(0, 12).replace(/[^\w\u4e00-\u9fff]+/g, '_').replace(/^_+|_+$/g, '');
  return 'aias-batch-panel-' + sqlId + '-' + (readable || 'ds') + '-' + (h >>> 0).toString(36);
}

function aiasBatchToggleDetail(name) {
  // 按钮在汇总表单元格内。sqlId 优先从表格自己的 data-sql-id 取：
  // 表格被「⛶ 最大化」搬进全屏层后，按钮的祖先里已经没有 *-result 容器了，
  // 只靠回溯会静默 return —— 表现就是「全屏层里点查看没反应」。
  var btn = event && event.currentTarget;
  if (!btn) return;
  var tbl = btn.closest ? btn.closest('table[data-sql-id]') : null;
  var box = btn.closest ? btn.closest('[id$="-result"]') : null;
  var sqlId = tbl ? tbl.getAttribute('data-sql-id') : (box ? box.id.replace(/-result$/, '') : '');
  if (!sqlId) return;
  var panelsEl = document.getElementById('aias-batch-detail-' + sqlId);
  if (!panelsEl) return;
  // 表格在全屏层里时，明细面板也搬到同一层并排显示（否则面板在原位置，被全屏层挡住，
  // 用户点了「查看」什么都看不见）
  var maxOv = tbl && tbl.closest ? tbl.closest('.aias-result-max-overlay') : null;
  if (maxOv) aiasMovePanelsIntoOverlay(panelsEl, maxOv);
  var results = window['_aiasBatchResults_' + sqlId] || [];
  var found = results.filter(function(r) { return r.name === name; })[0];
  if (!found) return;
  var key = aiasBatchPanelKey(sqlId, name);
  var existing = document.getElementById(key);
  if (existing) {
    existing.style.display = existing.style.display === 'none' ? 'block' : 'none';
    return;
  }
  var body = '';
  if (found.multi && found.result && found.result.statements) {
    body += '<div class="aias-batch-stmt">' + found.result.statements.map(function(st) {
      return (st.ok ? '✓' : '✗') + ' ' + escHtml(st.sql || '') + ' → ' + (st.ok ? ('共 ' + (st.total || 0) + ' 行') : escHtml(st.error || '失败'));
    }).join('<br>') + '</div>';
  } else if (found.result && found.result.columns) {
    var cols = found.result.columns, rows = found.result.rows || [];
    body += '<div class="aias-batch-mini-table-wrap"><table class="aias-result-table"><thead><tr>';
    cols.forEach(function(c) { body += '<th>' + escHtml(c) + '</th>'; });
    body += '</tr></thead><tbody>';
    if (rows.length) {
      rows.forEach(function(row) {
        body += '<tr>';
        row.forEach(function(cell) { body += '<td>' + (cell === null || cell === undefined ? '<span class="ait-null">NULL</span>' : escHtml(cell)) + '</td>'; });
        body += '</tr>';
      });
    } else {
      body += '<tr><td colspan="' + Math.max(cols.length, 1) + '" class="ait-empty-row">（无数据）</td></tr>';
    }
    body += '</tbody></table></div>';
  } else {
    body = '<div class="aias-batch-err">' + escHtml(found.error || '无结果') + '</div>';
  }
  var panel = document.createElement('div');
  panel.id = key;
  panel.className = 'aias-batch-detail-panel';
  panel.setAttribute('data-ds-name', name);        // 全屏标题要知道这是哪个库的结果
  // 明细里的表往往十几列，缩在消息流的一小块里只能横向拖；给一个和单条结果同样的 ⛶
  var canZoom = !!(found.result && found.result.columns);
  panel.innerHTML = '<div class="aias-batch-detail-head"><span>🏢 ' + escHtml(name) + ' 明细</span>'
    + (canZoom
        ? '<button class="aias-batch-zoom" onclick="aiasMaximizeBatchDetail(this)" '
          + 'title="全屏查看该库的结果（Esc 退出）">⛶ 最大化</button>'
        : '')
    + '</div>' + body;
  panelsEl.appendChild(panel);
}

// 「查询成功，共 0 行」+ 语句里还留着占位符 → 直接把因果关系点出来。
// 这是最让人困惑的一类结果：语句不报错、却什么都没查到，容易被当成"库里真没数据"，
// 而真实原因常常是 `WHERE tablespace_name = 'YOUR_TABLESPACE'` 这种占位符压根没换。
function aiasZeroRowPlaceholderHint(res, sqlId) {
  try {
    if (!res || res.total !== 0) return '';
    var sql = unescHtml(_aiasSqlStore[sqlId] || '');
    if (!sql) return '';
    var re = new RegExp(_AIAS_NAMED_PH_RE.source, 'gi');
    var hits = [], m;
    while ((m = re.exec(sql)) !== null) {
      if (hits.indexOf(m[0]) < 0) hits.push(m[0]);
    }
    if (!hits.length) {
      if (!_AIAS_SLOT_HINT_RE.test(sql)) return '';
      return '<div class="aias-zero-row-hint">没查到数据，而这条语句里还有未替换的占位符 —— '
        + '在 SQL 上点<b>右键</b>即可替换成真实取值</div>';
    }
    return '<div class="aias-zero-row-hint">没查到数据，很可能是语句里还留着占位符：'
      + hits.map(function (h) { return '<code>' + escHtml(h) + '</code>'; }).join(' ')
      + ' —— 在 SQL 上点<b>右键</b>换成真实取值再执行</div>';
  } catch (e) { return ''; }
}

// ── 数据源版本一览（回答"当前系统配了哪些版本的数据源"）──
// 版本由后端**实探**（无需手工配置，也不该手工配：库升级/迁移后没人会记得改）。
// source 含义：live=本次实探 / cache=内存缓存 / stale=历史值(后台正在刷) / unknown=从未探到
var _AIAS_SOURCE_CN = { live: '本次实探', cache: '缓存', stale: '历史值（后台刷新中）', unknown: '未探到' };

function aiasShowDsVersions(force) {
  var modal = document.getElementById('aias-ver-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'aias-ver-modal';
    modal.className = 'aias-ver-modal';
    modal.innerHTML = '<div class="aias-ver-content">'
      + '<div class="aias-ver-header">'
      + '<span class="aias-ver-title">数据源版本一览</span>'
      + '<span class="aias-ver-summary" id="aias-ver-summary"></span>'
      + '<button class="aias-icon-btn" title="关闭 (Esc)" aria-label="关闭" onclick="aiasCloseDsVersions()" style="margin-left:auto">'
      + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
      + '</button></div>'
      + '<div class="aias-ver-body" id="aias-ver-body"></div>'
      + '<div class="aias-ver-foot">'
      + '<button id="aias-ver-refresh" onclick="aiasShowDsVersions(true)">重新探测</button>'
      + '<button onclick="aiasCloseDsVersions()">关闭 (Esc)</button>'
      + '</div></div>';
    modal.onclick = function (ev) { if (ev.target === modal) aiasCloseDsVersions(); };
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
  var body = document.getElementById('aias-ver-body');
  var sum = document.getElementById('aias-ver-summary');
  var btn = document.getElementById('aias-ver-refresh');
  if (body) body.innerHTML = '<div class="aias-ver-hint">'
    + (force ? '⏳ 正在重新探测各数据源的真实版本…（连不上时会等待超时）' : '⏳ 正在读取版本…') + '</div>';
  if (sum) sum.textContent = '';
  if (btn) { btn.disabled = !!force; btn.textContent = force ? '探测中…' : '重新探测'; }
  var target = '';
  try { target = aiasSlotDs() || ''; } catch (e) {}
  fetch('/api/chat/datasource-versions' + (force ? '?refresh=1' : ''))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (btn) { btn.disabled = false; btn.textContent = '重新探测'; }
      if (!d || !d.ok) {
        if (body) body.innerHTML = '<div class="aias-ver-err">⚠️ ' + escHtml((d && d.error) || '获取失败') + '</div>';
        return;
      }
      if (sum) sum.textContent = d.summary || '';
      if (!body) return;
      var rows = d.datasources || [];
      if (!rows.length) { body.innerHTML = '<div class="aias-ver-hint">未配置任何启用中的数据源。</div>'; return; }
      var html = '<div class="aias-ver-hint">版本由系统自动实探，<b>无需手工配置</b>。'
        + '标「当前目标」的是本次会话生成/执行 SQL 所用的数据源。</div>';
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var failed = !r.version;
        var isTarget = !!(target && r.name === target);
        var ageTxt = '';
        if (r.age_s !== null && r.age_s !== undefined) {
          ageTxt = r.age_s < 60 ? (' · ' + r.age_s + ' 秒前') : (' · ' + Math.round(r.age_s / 60) + ' 分钟前');
        }
        html += '<div class="aias-ver-row' + (failed ? ' is-fail' : '') + (isTarget ? ' is-target' : '') + '">'
          + '<div class="aias-ver-row-top">'
          + '<span class="aias-ver-name" title="' + escHtml(r.name) + '">' + escHtml(r.name) + '</span>'
          + (isTarget ? '<span class="aias-ver-tag">当前目标</span>' : '')
          + (r.db_type ? '<span class="aias-ver-tag">' + escHtml(r.db_type) + '</span>' : '')
          + '<span class="aias-ver-label">' + escHtml(r.label || '未知版本') + '</span>'
          + '</div>'
          + '<div class="aias-ver-ver">' + escHtml(r.version || '(未取到版本)') + '</div>'
          + '<div class="aias-ver-meta">' + (r.dir_path ? ('📁 ' + escHtml(r.dir_path) + ' · ') : '')
          + escHtml(String(r.host || '') + (r.port ? (':' + r.port) : ''))
          + (r.database ? ' · ' + escHtml(r.database) : '')
          + ' · ' + escHtml(_AIAS_SOURCE_CN[r.source] || r.source || '') + escHtml(ageTxt)
          + '</div>'
          + (r.error ? '<div class="aias-ver-err">⚠️ ' + escHtml(r.error) + '</div>' : '')
          + '</div>';
      }
      body.innerHTML = html;
    })
    .catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '重新探测'; }
      if (body) body.innerHTML = '<div class="aias-ver-err">⚠️ 请求失败：' + escHtml((e && e.message) || '网络异常') + '</div>';
    });
}

function aiasCloseDsVersions() {
  var m = document.getElementById('aias-ver-modal');
  if (m) m.style.display = 'none';
}

// 数据源选择弹窗
var _aiasDsCallback = null;
function aiasShowDsModal(dsList, title, onSelect) {
  // 统一走「左目录 / 右表格」选择器（T6.6）
  if (typeof dsOpenPicker === 'function') {
    var _cur = '';
    try { _cur = (aiasCurrentSession() || {}).currentDatasource || ''; } catch (e) {}
    dsOpenPicker({
      title: title || '选择数据源',
      multi: false,
      allowClear: true,
      clearLabel: '不指定数据源',
      selected: _cur ? [_cur] : [],
      dataList: (dsList && dsList.length) ? dsList : null,
    }).then(function (ds) {
      if (ds === undefined) return;
      if (typeof onSelect === 'function') onSelect(ds ? (ds.name || '') : '');
    });
    return;
  }
  _aiasDsCallback = onSelect;
  var modal = document.getElementById('aias-ds-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'aias-ds-modal';
    modal.className = 'aias-ds-modal';
    modal.innerHTML = ''
      + '<div class="aias-ds-modal-content">'
      + '  <div class="aias-ds-modal-header">'
      + '    <span class="aias-ds-modal-title" id="aias-ds-modal-title">选择数据源</span>'
      + '    <button class="aias-ds-modal-close" onclick="aiasCloseDsModal()">✕</button>'
      + '  </div>'
      + '  <div class="aias-ds-modal-body" id="aias-ds-modal-body"></div>'
      + '</div>';
    document.body.appendChild(modal);
  }
  var body = document.getElementById('aias-ds-modal-body');
  var titleEl = document.getElementById('aias-ds-modal-title');
  if (titleEl) titleEl.textContent = title || '选择数据源';
  var html = '';
  if (!dsList || !dsList.length) {
    html = '<div class="aias-ds-empty">暂无可用数据源</div>';
  } else {
    for (var i = 0; i < dsList.length; i++) {
      var ds = dsList[i];
      var name = ds.name || ds.datasource_name || '';
      var meta = [ds.db_type || '', (ds.host || '') + (ds.port ? (':' + ds.port) : ''),
                  '目录: ' + (ds.dir_path || '未分配'),
                  (ds.labels && ds.labels.length) ? ('标签: ' + ds.labels.join('/')) : '',
                  (ds.node_count > 1) ? (ds.node_count + ' 节点') : ''].filter(Boolean).join(' · ');
      html += '<div class="aias-ds-item" onclick="aiasSelectDs(\'' + escHtml(name).replace(/'/g, "\\'") + '\')">'
        + '<div class="aias-ds-item-name">' + escHtml(name) + '</div>'
        + (meta ? '<div class="aias-ds-item-meta">' + escHtml(meta) + '</div>' : '')
        + '</div>';
    }
  }
  body.innerHTML = html;
  modal.style.display = 'flex';
}
function aiasSelectDs(name) {
  // 必须先取出回调再关闭弹窗 —— aiasCloseDsModal() 会清空 _aiasDsCallback，
  // 若先关闭再判断，回调恒为 null，用户"选了数据源却什么都不执行"。
  var cb = _aiasDsCallback;
  _aiasDsCallback = null;
  aiasCloseDsModal();
  if (typeof cb === 'function') cb(name);
}
function aiasCloseDsModal() {
  var m = document.getElementById('aias-ds-modal');
  if (m) m.style.display = 'none';
  _aiasDsCallback = null;
}

// ── 多选数据源弹窗（批量执行同一套 SQL 到多个同类库）──
// 规则：仅允许同一 db_type（否则同一套语句在异构库上语法不兼容），并提供「全选本类型」一键。
var _aiasDsmCb = null;         // 确认回调（接收选中的数据源对象数组）
var _aiasDsmList = [];         // 当前全量数据源对象
var _aiasDsmSelected = [];     // 已选 idx
var _aiasDsmLockType = '';     // 已锁定的 db_type（首个勾选决定）

function aiasShowDsMultiModal(dsList, title, onConfirm) {
  // 批量执行：左目录 / 右表格多选，仍限制同一数据库类型
  if (typeof dsOpenPicker === 'function') {
    dsOpenPicker({
      title: title || '批量执行 · 选择数据源',
      multi: true,
      sameType: true,
      dataList: (dsList && dsList.length) ? dsList : null,
    }).then(function (arr) {
      if (!arr || !arr.length) return;
      if (typeof onConfirm === 'function') onConfirm(arr);
    });
    return;
  }
  _aiasDsmCb = onConfirm;
  _aiasDsmList = dsList || [];
  _aiasDsmSelected = [];
  _aiasDsmLockType = '';
  var modal = document.getElementById('aias-ds-multi-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'aias-ds-multi-modal';
    modal.className = 'aias-ds-modal';
    modal.innerHTML = ''
      + '<div class="aias-ds-modal-content">'
      + '  <div class="aias-ds-modal-header">'
      + '    <span class="aias-ds-modal-title" id="aias-ds-multi-title">批量执行 · 选择数据源</span>'
      + '    <button class="aias-ds-modal-close" onclick="aiasCloseDsMultiModal()">✕</button>'
      + '  </div>'
      + '  <div class="aias-ds-multi-note" id="aias-ds-multi-note">仅可批量执行<b>同一数据库类型</b>，勾选首个即锁定类型，避免跨库语法不兼容</div>'
      + '  <div class="aias-ds-modal-body" id="aias-ds-multi-body"></div>'
      + '  <div class="aias-ds-multi-foot">'
      + '    <span class="aias-ds-multi-count" id="aias-ds-multi-count">已选 0</span>'
      + '    <button class="aias-ds-multi-cancel" onclick="aiasCloseDsMultiModal()">取消</button>'
      + '    <button class="aias-ds-multi-ok" id="aias-ds-multi-ok" onclick="aiasConfirmDsMulti()">批量执行(0)</button>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(modal);
  }
  var tEl = document.getElementById('aias-ds-multi-title');
  if (tEl) tEl.textContent = title || '批量执行 · 选择数据源';
  aiasDsMultiRender();
  modal.style.display = 'flex';
}

function aiasDsMultiRender() {
  var body = document.getElementById('aias-ds-multi-body');
  if (!body) return;
  var note = document.getElementById('aias-ds-multi-note');
  if (note) note.innerHTML = _aiasDsmLockType
    ? '已锁定类型 <b>' + escHtml(_aiasDsmLockType) + '</b>，其他类型已自动禁用'
    : '仅可批量执行<b>同一数据库类型</b>，勾选首个即锁定类型';
  var groups = {};   // db_type -> [obj]
  _aiasDsmList.forEach(function(ds) {
    var t = (ds.db_type || '其他').trim() || '其他';
    (groups[t] = groups[t] || []).push(ds);
  });
  var html = '';
  Object.keys(groups).forEach(function(type) {
    var arr = groups[type];
    var disabled = !!(_aiasDsmLockType && _aiasDsmLockType !== type);
    html += '<div class="aias-ds-multi-group">'
      + '<div class="aias-ds-multi-grouphead">'
      + '<span class="aias-ds-multi-type">🛢 ' + escHtml(type) + '（' + arr.length + '）</span>'
      + '<button type="button" class="aias-ds-multi-selectall"' + (disabled ? ' disabled' : '')
      + ' onclick="aiasDsMultiSelectAll(\'' + escHtml(type).replace(/'/g, "\\'") + '\')">☑ 全选本类型</button>'
      + '</div>';
    for (var i = 0; i < arr.length; i++) {
      var dsObj = arr[i];
      var idx = _aiasDsmList.indexOf(dsObj);
      var checked = _aiasDsmSelected.indexOf(idx) >= 0;
      var meta = [(dsObj.host || '') + (dsObj.port ? (':' + dsObj.port) : ''),
                  '目录: ' + (dsObj.dir_path || '未分配'),
                  (dsObj.labels && dsObj.labels.length) ? ('标签: ' + dsObj.labels.join('/')) : ''].filter(Boolean).join(' · ');
      html += '<label class="aias-ds-multi-item' + (checked ? ' is-on' : '') + (disabled ? ' is-off' : '') + '">'
        + '<input type="checkbox" data-midx="' + idx + '" data-mtype="' + escHtml(type).replace(/"/g, '&quot;') + '"'
        + (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + ' onchange="aiasDsMultiToggle(this)">'
        + '<span class="aias-ds-multi-item-name">' + escHtml(dsObj.name || dsObj.datasource_name || '') + '</span>'
        + (meta ? '<span class="aias-ds-multi-item-meta">' + escHtml(meta) + '</span>' : '')
        + '</label>';
    }
    html += '</div>';
  });
  body.innerHTML = html;
  var cnt = document.getElementById('aias-ds-multi-count');
  var ok = document.getElementById('aias-ds-multi-ok');
  if (cnt) cnt.textContent = '已选 ' + _aiasDsmSelected.length;
  if (ok) ok.textContent = '批量执行(' + _aiasDsmSelected.length + ')';
}

function aiasDsMultiToggle(chk) {
  var idx = parseInt(chk.getAttribute('data-midx'), 10);
  var type = chk.getAttribute('data-mtype') || '';
  if (chk.checked) {
    if (_aiasDsmLockType && _aiasDsmLockType !== type) {
      chk.checked = false;
      alert('仅支持同一类型批量：当前已锁定 ' + _aiasDsmLockType + '，请先取消已选中的其它库');
      return;
    }
    if (!_aiasDsmLockType) _aiasDsmLockType = type;
    if (_aiasDsmSelected.indexOf(idx) < 0) _aiasDsmSelected.push(idx);
  } else {
    _aiasDsmSelected = _aiasDsmSelected.filter(function(k) { return k !== idx; });
    if (!_aiasDsmSelected.length) _aiasDsmLockType = '';
  }
  aiasDsMultiRender();
}

function aiasDsMultiSelectAll(type) {
  if (_aiasDsmLockType && _aiasDsmLockType !== type) {
    alert('仅支持同一类型批量：当前已锁定 ' + _aiasDsmLockType);
    return;
  }
  _aiasDsmLockType = type;
  _aiasDsmList.forEach(function(ds, idx) {
    var t = (ds.db_type || '其他').trim() || '其他';
    if (t !== type) return;
    if (_aiasDsmSelected.indexOf(idx) < 0) _aiasDsmSelected.push(idx);
  });
  aiasDsMultiRender();
}

function aiasCloseDsMultiModal() {
  var m = document.getElementById('aias-ds-multi-modal');
  if (m) m.style.display = 'none';
  _aiasDsmCb = null;
}

function aiasConfirmDsMulti() {
  var cb = _aiasDsmCb;
  _aiasDsmCb = null;
  var sel = _aiasDsmSelected.map(function(idx) { return _aiasDsmList[idx]; });
  aiasCloseDsMultiModal();
  if (!sel.length) return;
  if (typeof cb === 'function') cb(sel);
}

// 点击执行 SQL：智能选择数据源
// ── SQL 复制（AI 巡检助手提供的所有 SQL 都可一键复制）──
// 内联 SVG：Material content_copy / check（免字体依赖，跨平台渲染一致）
var _AIAS_COPY_BTN_HTML =
  '<svg class="ic-copy" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">'
  + '<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>'
  + '<svg class="ic-check" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">'
  + '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

// 「恢复原始 SQL」图标（Material restore）：逆时针箭头 + 表盘，语义就是"还原到之前"
var _AIAS_RESTORE_BTN_HTML =
  '<svg class="ic-restore" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">'
  + '<path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>'
  + '<svg class="ic-check" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">'
  + '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

// ── 占位符菜单 / 多语句拆分用到的内联 SVG（免字体依赖，跨平台一致）──
// 全部 icon-only + tooltip + aria-label，符合项目 UI 规范。
var _AIAS_IC = {
  quote: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">'
    + '<path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/></svg>',
  code: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">'
    + '<path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">'
    + '<path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
  undo: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">'
    + '<path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>',
  undoAll: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">'
    + '<path d="M13 3a9 9 0 00-9 9H1l3.89 3.89.07.14L9 12H6a7 7 0 117 7 6.96 6.96 0 01-4.94-2.06l-1.42 1.42A8.94 8.94 0 0013 21a9 9 0 000-18z"/></svg>',
  spark: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">'
    + '<path d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25zM11.5 9.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25z"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">'
    + '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  playAll: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">'
    + '<path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4zm12 0v6l5-3z"/></svg>',
};

function aiasDoCopy(text, btn) {
  if (!text) return;
  function _ok() {
    if (!btn) return;
    btn.classList.add('copied');
    var oldTitle = btn.getAttribute('data-title') || btn.getAttribute('title') || '复制 SQL';
    if (!btn.getAttribute('data-title')) btn.setAttribute('data-title', oldTitle);
    btn.setAttribute('title', '已复制');
    btn.setAttribute('aria-label', '已复制');
    setTimeout(function() {
      btn.classList.remove('copied');
      btn.setAttribute('title', oldTitle);
      btn.setAttribute('aria-label', oldTitle);
    }, 1500);
  }
  function _fallback() {
    // http 环境 / 旧浏览器无 async clipboard API → 隐藏 textarea + execCommand
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); _ok(); } catch (e) {}
    document.body.removeChild(ta);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(_ok, _fallback);
  } else {
    _fallback();
  }
}

// pre/类 pre 容器的"所见文本"提取。
// 关键：全局 markdown 渲染会把 \n 替换为 <br>（含 pre 内部），textContent
// 会把 <br> 读成空字符串 —— 换行全部丢失。必须先把 <br> 还原为 \n 再取文本，
// 复制结果才与视觉显示逐字符一致（缩进/空格/空行/换行都不变）。
function aiasPreText(el) {
  var html = (el.innerHTML || '').replace(/<br\s*\/?>/gi, '\n');
  var d = document.createElement('div');
  d.innerHTML = html;
  return d.textContent || '';
}

// 建议 SQL 代码块（pre 右上角按钮）：复制整个代码块文本。
// 保真原则：剪贴板内容 = 视觉显示内容，逐字符一致（空格/缩进/换行都不动）。
// 构建时 code.trim() 已决定显示范围，因此不再额外 trim、不补换行。
// 注意用 aiasPreText 而非 textContent（<br> 会丢换行，原因见上），
// 也不用 store（存的是 escHtml 后的文本）。
function aiasCopySqlPre(btn) {
  // 复制对**所有**代码块生效：可执行的 SQL 块(.aias-sql-pre) 与不可执行的
  // DDL/脚本块(.aias-code-pre) 都挂了同一个复制按钮
  var pre = btn.closest('pre.aias-code-pre, pre.aias-sql-pre');
  if (!pre) return;
  var code = pre.querySelector('code') || pre;
  aiasDoCopy(aiasPreText(code), btn);
}

// 工具链卡片内的 SQL 块（execute_sql 参数展示）：取容器自身文本（不 trim，与显示一致）
function aiasCopySqlEl(btn) {
  var box = btn.parentElement;
  if (!box) return;
  aiasDoCopy(aiasPreText(box), btn);
}

// 工具链里的「执行结果」/「参数」代码框（深底）：按钮在 .aias-pre-host 内，复制其 pre
// 与 SQL 框同一套保真取文（aiasPreText 先把 <br> 还原为换行）
function aiasCopyPreBox(btn) {
  var host = btn.closest('.aias-pre-host');
  if (!host) return;
  var pre = host.querySelector('pre') || host;
  aiasDoCopy(aiasPreText(pre), btn);
}

// 通用：诊断详情/诊断工单等浅色建议语句框的右上角复制（复用同一套保真取文与反馈）
function sqlPreCopy(btn) {
  var host = btn.closest('.sql-pre-host');
  if (!host) return;
  var pre = host.querySelector('pre') || host;
  aiasDoCopy(aiasPreText(pre), btn);
}

// ── AI 关键结果框：复制该结果 + 基于结果继续向下追问 ──
// 追问图标：Material forum（对话下钻语义）
var _AIAS_FOLLOWUP_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">'
  + '<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg>';

// 取"结果正文"：排除操作条自身与思考过程，避免复制到交互控件文本。
// 富文本块（含标题/段落/列表）必须做**块级换行映射**，否则渲染成 <h2>/<li> 的结构
// 会被 textContent 黏成一行（"关键问题点表空间不足：…"）。只做标签→换行映射，
// 不修剪内部空白，保证与所见结构一致。
function aiasResultText(box) {
  if (!box) return '';
  var clone = box.cloneNode(true);
  var drop = clone.querySelectorAll('.aias-result-actions, [class*="thinking"]');
  for (var i = 0; i < drop.length; i++) {
    if (drop[i].parentNode) drop[i].parentNode.removeChild(drop[i]);
  }
  var html = (clone.innerHTML || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|blockquote|pre|tr)>/gi, '\n');
  var tmp = document.createElement('div');
  tmp.innerHTML = html;
  // 折叠块级标签叠加产生的多余空行（3 个以上连续换行压成 1 个空行），保留正常段落间距
  return (tmp.textContent || '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

// 结果框容器解析：AI 巡检助手正文用 .aias-msg-text；
// 协同诊断的下钻回答用 .aias-drilldown-msg-content / .diag-ai-msg-content；
// 侧栏 AI 助手用 .chat-msg。不统一解析会出现"某个界面的回答拿不到操作条"。
function aiasResultBox(el) {
  if (!el) return null;
  return el.closest('.aias-msg-text')
    || el.closest('.aias-drilldown-msg-content')
    || el.closest('.diag-ai-msg-content')
    || el.closest('.chat-msg')
    || el.parentElement;
}

function aiasCopyResult(btn) {
  aiasDoCopy(aiasResultText(aiasResultBox(btn)), btn);
}

// 点「追问推荐」：后端基于该结果生成 3 个下钻问题，点一下即发送
function aiasAskFollowup(btn) {
  var box = aiasResultBox(btn);
  var bar = btn.closest('.aias-result-actions');
  if (!box || !bar) return;
  var text = aiasResultText(box);
  if (!text) return;
  var wrap = bar.querySelector('.aias-followup-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'aias-followup-wrap';
    bar.appendChild(wrap);
  } else if (wrap.dataset.loaded === '1') {
    wrap.style.display = (wrap.style.display === 'none') ? 'flex' : 'none';
    return;
  }
  wrap.style.display = 'flex';
  wrap.innerHTML = '<span class="aias-followup-loading">⏳ 正在生成追问建议…</span>';

  var ds = '';
  try { var s = aiasCurrentSession(); ds = (s && s.currentDatasource) || ''; } catch (e) {}

  fetch('/api/chat/followup_suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 4000), datasource_name: ds })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if (!d.ok || !d.questions || !d.questions.length) {
      wrap.innerHTML = '<span class="aias-followup-loading">⚠️ ' + escHtml(d.error || '未能生成追问建议') + '</span>';
      return;
    }
    wrap.dataset.loaded = '1';
    wrap.innerHTML = '';
    d.questions.forEach(function(q) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'aias-followup-chip';
      chip.title = q;
      chip.textContent = q;
      chip.onclick = function() { aiasQuickSend(q); };
      wrap.appendChild(chip);
    });
  })
  .catch(function(e) {
    wrap.innerHTML = '<span class="aias-followup-loading">⚠️ 生成失败：' + escHtml(e && e.message || '网络异常') + '</span>';
  });
}

// 给一条 AI 回答挂上操作条（流式结束后调用；已挂过则跳过）
// opts.copyOnly=true → 只加「复制该结果」（用于协同诊断下钻：那里的"继续追问"
// 有自己的输入框与上下文，跨模块发送会串上下文，故不挂追问按钮）
function aiasEnhanceResults(msgText, opts) {
  if (!msgText) return;
  if (msgText.querySelector('.aias-result-actions')) return;
  // 判断是否属于"关键结果框"：
  //   ① 有结构（标题/列表/表格/代码块）→ 一定是结果，无论长短；
  //   ② 否则纯文本需 ≥24 字，过滤"好的/已收到"这类无信息量的寒暄（不值得给按钮）。
  var plain = (msgText.textContent || '').trim();
  var structured = !!msgText.querySelector('h1,h2,h3,h4,ul,ol,li,table,pre,blockquote,details');
  if (!structured && plain.length < 24) return;
  var copyOnly = !!(opts && opts.copyOnly);
  var bar = document.createElement('div');
  bar.className = 'aias-result-actions';
  bar.innerHTML =
    '<button class="aias-result-btn" title="复制该结果" aria-label="复制该结果" onclick="aiasCopyResult(this)">' + _AIAS_COPY_BTN_HTML + '</button>'
    + (copyOnly ? '' :
       '<button class="aias-result-btn" title="基于此结果继续追问" aria-label="基于此结果继续追问" onclick="aiasAskFollowup(this)">' + _AIAS_FOLLOWUP_SVG + '</button>');
  msgText.appendChild(bar);
}

// ── 操作条兜底观察器 ──
// 背景：操作条原本靠"每个渲染点自己记得调用 aiasEnhanceResults"来挂。实测漏了 4 条路径
// （会话恢复/切换会话的整体重渲染、aiasUpdateMessage、aiasUpdateMessageWithTools、
//  中断分支），表现为「刷新页面后历史回答全都没有复制按钮」。
// 这里用 MutationObserver 兜底：只要 AI 消息 DOM 变了，就补挂一次，保证任何渲染路径
// （含以后新增的）都不会漏。流式进行中不动（有光标/typing），等正式渲染点处理。
function aiasInitResultBarObserver() {
  var host = document.getElementById('aias-messages');
  if (!host || host.dataset.enhanceObserved === '1') return;
  host.dataset.enhanceObserved = '1';
  var timer = null;
  var obs = new MutationObserver(function() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function() {
      var list = host.querySelectorAll('.aias-msg.ai .aias-msg-text');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (el.querySelector('.aias-result-actions')) continue;          // 已挂，跳过
        if (el.querySelector('.aias-cursor, .aias-typing')) continue;    // 流式中，等结束
        aiasEnhanceResults(el);
      }
      // 建议 SQL 框：含未替换占位符时给一个可见提示（纯正则，不请求后端）
      var pres = host.querySelectorAll('pre.aias-code-pre, pre.aias-sql-pre');
      for (var j = 0; j < pres.length; j++) {
        try { aiasSlotUpdateHint(pres[j]); } catch (e) {}
      }
      aiasScheduleDialectScan();       // 方言预检兜底（含会话恢复/切会话的重渲染路径）
    }, 150);
  });
  obs.observe(host, { childList: true, subtree: true });
}

// ══════════════ SQL 占位符：右键快捷替换 ══════════════
// 交互：在建议 SQL 框上点右键 → 菜单列出占位符（若都能从上下文推出值，顶部给
// 「全部替换为推荐值」一步完成）→ 或搜索数据字典候选 / 直接输入后回车。
// 替换是**就地**的：DOM 与 _aiasSqlStore 同步更新，点「执行SQL」用的就是替换后的语句。
var _aiasSlotState = null;
// 廉价的"是否含占位符"判断（只做正则，不请求后端）——用于在执行按钮旁给可见提示
// 「这段 SQL 里还有未替换的占位符吗」——用于给用户可见提示（不开菜单也能发现）
// 除尖括号/花括号等标准写法外，还要认 AI 最常用的**命名式占位符**：
// `WHERE tablespace_name = 'YOUR_TABLESPACE'`（后端 sql_slots 的 named 风格）。
// 只列信号强的命名，别把 'TABLE'/'ACTIVE' 这种真实取值也算进来。
// 注意加了 `i` 标志：你的/我的前缀大小写都可能出现（YOUR_/your_）。
var _AIAS_SLOT_HINT_RE = new RegExp(
  "(['\"]?)<[^<>\\s]{1,40}>" +
  "|#[\\u4e00-\\u9fa5A-Za-z_][\\u4e00-\\u9fa5\\w]{0,39}#" +
  "|\\{\\{\\s*[\\u4e00-\\u9fa5A-Za-z_][\\u4e00-\\u9fa5\\w.]*\\s*\\}\\}" +
  "|\\$\\{[^}]+\\}" +
  "|\\[[\\u4e00-\\u9fa5][\\u4e00-\\u9fa5\\w]{0,19}\\]" +
  "|(?:your|my|our)_[a-z0-9_]{1,40}" +
  "|(?:tbd|todo|placeholder|replace[_-]?me|change[_-]?me|fill[_-]?me)" +
  "|待填|待替换|请填写|请替换|请补全", "i");

// 只匹配"带引号的命名式占位符"（用于 0 行归因：得把占位符原样显示给用户）
var _AIAS_NAMED_PH_RE = /'(?:your|my|our)_[a-z0-9_]{1,40}'|'(?:tbd|todo|placeholder|replace[_-]?me|change[_-]?me|fill[_-]?me)'|'待填'|'待替换'|'请填写'|'请替换'|'请补全'|'x{2,}[a-z0-9_]*'/gi;

function aiasSlotDs() {
  var ds = '';
  try {
    var sess = aiasCurrentSession();
    if (sess) {
      ds = sess.currentDatasource || '';
      if (!ds && sess.datasources && sess.datasources.length) ds = sess.datasources[0];
    }
  } catch (e) {}
  if (!ds) { try { var c = getChatContext(); ds = (c && c.datasource_name) || ''; } catch (e) {} }
  return ds || '';
}

// 取 SQL 框文本：必须走 aiasPreText（把 <br> 还原成换行），否则换行丢失、槽位 span 会错位
function aiasSlotText(pre) {
  var code = pre.querySelector('code') || pre;
  return aiasPreText(code);
}

// 鼠标位置 → aiasSlotText 中的字符偏移（<br> 记作一个换行，与 aiasPreText 口径一致）
function aiasSlotOffsetFromPoint(pre, x, y) {
  var range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    var p = document.caretPositionFromPoint(x, y);
    if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
  }
  if (!range || !range.startContainer || !pre.contains(range.startContainer)) return -1;
  var code = pre.querySelector('code') || pre;
  var target = range.startContainer, targetOff = range.startOffset, acc = 0, found = -1;
  function walk(node) {
    if (found >= 0) return;
    if (node.nodeType === 3) {
      if (node === target) { found = acc + targetOff; return; }
      acc += node.nodeValue.length;
      return;
    }
    if (node.nodeName === 'BR') { acc += 1; return; }
    for (var i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
  }
  walk(code);
  return found;
}

function aiasSlotClose() {
  var m = document.getElementById('aias-slot-menu');
  if (m && m.parentNode) m.parentNode.removeChild(m);
  if (_aiasSlotState && _aiasSlotState.timer) clearTimeout(_aiasSlotState.timer);
  _aiasSlotState = null;
}

function aiasSlotPlace(menu, x, y) {
  menu.style.left = '0px';
  menu.style.top = '0px';
  var w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 10)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 10)) + 'px';
}

// 写回：DOM 显示原文（textContent 会自动转义）；store 存 escHtml 后的文本
// （执行时 aiasExecuteSql 会 unescHtml —— 与渲染时的存储格式保持一致）
// 取该代码块对应的 sqlId。
// 现在**每个围栏代码块**的 <pre> 上都直接挂着 data-sql-id（含不可执行的 DDL/脚本块），
// 优先读它；再回退到"执行按钮上找 id"的老结构（兼容早期渲染出来的 DOM）。
function aiasSlotSqlId(pre) {
  if (!pre) return '';
  var own = pre.getAttribute ? (pre.getAttribute('data-sql-id') || '') : '';
  if (own) return own;
  var wrap = pre.parentElement;
  var execBtn = wrap ? wrap.querySelector('.aias-sql-exec-btn') : null;
  return execBtn ? (execBtn.getAttribute('data-sql-id') || '') : '';
}

// 把"派生出来的 SQL"写回 DOM 与执行用的存储（两处必须同步）
function aiasSlotCommit(pre, newSql) {
  var code = pre.querySelector('code') || pre;
  code.textContent = newSql;
  var sqlId = aiasSlotSqlId(pre);
  if (sqlId) _aiasSqlStore[sqlId] = escHtml(newSql);
  aiasSlotRefreshRestoreBtn(pre);      // 有替换记录才让"恢复"按钮可点
}

// ── 替换台账：每个 SQL 块记住「基线 SQL（含占位符）」+「已选值」──
// 这是"替代后还能再改"的关键：占位符**永远留在基线 SQL 里**，替换只是渲染出来的结果。
// 早先的实现是就地改 `st.sql`（把占位符改成值），一改占位符就没了 ——
// 于是再想改这个值就完全没有入口（SQL 框本身不可编辑）。
//
// ★ 基线以「当前框里的文本」为准。台账只在一件事成立时才可信：
//     当前文本 === 基线 + 已替换值（即台账自己算出来的草稿）
//   不等 → 中途有别人改过这个代码块（最典型的就是「AI 修复 SQL」改了字段/语法）
//   → 台账作废。**绝不能拿旧基线回写**，否则点一下"撤销替换"就把 AI 修好的一起回滚了。
var _aiasSlotLedger = {};      // {sqlId: {originalSql, slots, values}}

function aiasSlotLedgerReconcile(pre, domText) {
  var sqlId = aiasSlotSqlId(pre);
  if (!sqlId) return null;
  var led = _aiasSlotLedger[sqlId];
  if (!led) return null;
  var dom = (domText === undefined || domText === null) ? aiasSlotText(pre) : domText;
  if (dom !== aiasSlotDraftFrom(led)) { delete _aiasSlotLedger[sqlId]; return null; }
  return led;
}

// 显式作废某个块的台账（块被整体换成子块等场景，连值一起作废）
function aiasSlotDropLedger(pre) {
  var sqlId = pre ? aiasSlotSqlId(pre) : '';
  if (sqlId) delete _aiasSlotLedger[sqlId];
}

// SQL 被外部改写（选区替换 / AI 修复 / 方言改写）时，把台账**按新语句重建**，
// 而不是整条作废：新 SQL 里仍能辨认的"代入值"还原回占位符 token，其余丢弃。
// 这样右上角「撤销占位符替换」在语句变动后依然可用，且撤销后拿到的是
// "适配新 SQL 的占位符版本"（正确可执行的模板），而不是拿写回过期的旧基线把新改动吃回去。
function aiasSlotRebaseLedger(pre, newSql) {
  var sqlId = pre ? aiasSlotSqlId(pre) : '';
  if (!sqlId) return;
  var oldLed = _aiasSlotLedger[sqlId];
  if (!oldLed) return;
  var slots = oldLed.slots || [];
  var newSlots = [], newValues = {};
  var base = newSql;
  for (var i = 0; i < slots.length; i++) {
    var s = slots[i];
    var v = oldLed.values[s.name];
    if (!v || !s.raw) continue;                     // 没填过的槽位 / 无 token → 不参与还原
    var rep = aiasSlotWrapWith(s, v.value, v.raw);  // 代入后渲染出来的文本
    if (!rep || base.indexOf(rep) === -1) continue; // 该值已被用户改掉，无法映射 → 丢弃
    base = base.split(rep).join(s.raw);             // 代入值 → 占位符 token
    newValues[s.name] = v;
    newSlots.push(s);
  }
  _aiasSlotLedger[sqlId] = { originalSql: base, slots: newSlots, values: newValues };
}

function aiasSlotLedgerAcquire(pre, domText) {
  var led = aiasSlotLedgerReconcile(pre, domText);
  if (led) return led;
  led = { originalSql: domText, slots: [], values: {} };
  var sqlId = aiasSlotSqlId(pre);
  if (sqlId) _aiasSlotLedger[sqlId] = led;
  return led;
}

// 用"基线 SQL + 已选值"渲染出最终 SQL。
// 用整段占位符文本做全局替换（而不是按出现位置切片），好处：
//   ① 位置永远稳定，不需要每次替换后重新识别（省掉一次环境探测的往返）；
//   ② 同名占位符出现多次时**全部**被替换（原先只替换第一处）。
function aiasSlotDraftFrom(led) {
  var sql = led.originalSql;
  var slots = led.slots || [];
  for (var i = 0; i < slots.length; i++) {
    var s = slots[i];
    var v = led.values[s.name];
    if (!v) continue;
    var rep = aiasSlotWrapWith(s, v.value, v.raw);
    if (s.raw) sql = sql.split(s.raw).join(rep);
  }
  return sql;
}

function aiasSlotDraft(st) {
  st.led.slots = st.slots;
  return aiasSlotDraftFrom(st.led);
}

// ── 「撤销占位符替换」按钮（SQL 框右上角，复制按钮左侧）──
function aiasSlotLedgerFor(pre) {
  return aiasSlotLedgerReconcile(pre);
}

// 有替换记录 → 可点；没有 → 弱化成"不可用"外观，避免"点了没反应"的困惑。
// 这里顺带做一次台账对账：块被 AI 修复改写过时，按钮会自动变灰 ——
// 语义始终是"撤销我做的占位符替换"，与语句本身版本无关。
function aiasSlotRefreshRestoreBtn(pre) {
  if (!pre) return;
  var btn = pre.querySelector('.aias-pre-restore-btn');
  if (!btn) return;
  var led = aiasSlotLedgerFor(pre);
  var n = (led && led.values) ? Object.keys(led.values).length : 0;
  var t = n > 0 ? ('撤销 ' + n + ' 处占位符替换（保留语句当前版本）')
                : '撤销占位符替换（当前没有替换记录）';
  if (n > 0) btn.classList.remove('is-idle'); else btn.classList.add('is-idle');
  btn.title = t;
  btn.setAttribute('aria-label', '撤销占位符替换');
}

function aiasSlotRestoreFromBlock(btn) {
  var pre = (btn && btn.closest) ? btn.closest('pre.aias-code-pre, pre.aias-sql-pre') : null;
  if (!pre) return;
  // ★ 先对账：这个块被 AI 修复/外部改写过 → 旧台账作废，这里就没有"替换"可撤销。
  //   只反馈、不回写 —— 回写旧基线会把 AI 修好的字段与语法一起吃掉。
  var led = aiasSlotLedgerReconcile(pre);
  var n = (led && led.values) ? Object.keys(led.values).length : 0;
  if (!n) {
    aiasSlotRefreshRestoreBtn(pre);
    btn.classList.add('done');
    setTimeout(function () { btn.classList.remove('done'); }, 1400);
    if (_aiasSlotState && _aiasSlotState.pre === pre) {
      aiasSlotSetNotice('<div class="aias-slot-verify">ℹ️ 当前没有可撤销的替换 —— SQL 语句保持现版本（不会被回滚）</div>');
    }
    return;
  }
  led.values = {};
  if (led.slots) for (var i = 0; i < led.slots.length; i++) delete led.slots[i].raw_override;
  aiasSlotCommit(pre, aiasSlotDraftFrom(led));   // == 基线：只撤回"值"，语句本身不动
  aiasSlotUpdateHint(pre);
  aiasSlotRefreshRestoreBtn(pre);
  var oldTitle = btn.title;
  btn.classList.add('done');
  btn.title = '已撤销 ' + n + ' 处替换';
  setTimeout(function () { btn.classList.remove('done'); btn.title = oldTitle; }, 1400);
  // 若右键菜单正开着，同步刷新，别显示过期的值
  if (_aiasSlotState && _aiasSlotState.pre === pre) {
    _aiasSlotState.led = led;
    aiasSlotSetNotice('<div class="aias-slot-verify">↩️ 已撤销全部 ' + n + ' 处替换，占位符都回来了</div>');
    aiasSlotRender();
  }
}

// ── 撤销栈（Ctrl+Z）──
// "回撤"要能一步一步退：每改一次值就压一份快照，Ctrl+Z 逐步回退。
// 这比"一键清空全部替换"更贴近手感 —— 改错第 3 个槽位时，不必把前两个也退掉。
var _AIAS_SLOT_UNDO_MAX = 30;

function aiasSlotPushUndo(st) {
  if (!st) return;
  if (!st.undo) st.undo = [];
  st.undo.push(JSON.stringify(st.led.values || {}));
  if (st.undo.length > _AIAS_SLOT_UNDO_MAX) st.undo.shift();
}

function aiasSlotUndo() {
  var st = _aiasSlotState;
  if (!st) return;
  if (!st.undo || !st.undo.length) {
    aiasSlotSetNotice('<div class="aias-slot-verify warn">已到最后一步，没有可回撤的操作</div>');
    return;
  }
  var snap = st.undo.pop();
  try { st.led.values = JSON.parse(snap) || {}; } catch (e) { st.led.values = {}; }
  aiasSlotCommit(st.pre, aiasSlotDraft(st));
  aiasSlotUpdateHint(st.pre);
  aiasSlotSetNotice('<div class="aias-slot-verify">↶ 已回撤一步（还可回撤 '
    + st.undo.length + ' 步）</div>');
  aiasSlotRender();
}

function aiasSlotApplyCand(el) {
  var st = _aiasSlotState;
  if (!st) return;
  // 候选可能来自"就地录入"（列表态，st.active 为 -1）→ 用 data-i 指明是哪个槽位
  var raw = el.getAttribute('data-i');
  var i = (raw === null || raw === '') ? st.active : parseInt(raw, 10);
  // 走"校验后再替换"：值填错了当场提示，而不是等执行出 0 行再猜
  aiasSlotApplyChecked(i, el.getAttribute('data-v'));
}

// ── 插入方式判定：字面量（加引号 + 转义）还是原样插入 ──
// 手工录入时用户会写各种东西：纯值、表达式（SYSDATE-1）、函数（TO_DATE('x','y')）、
// 多值（'A','B'）、已经自带引号的值。一律当字面量加引号会把这些改坏，所以先判定。
function aiasSlotAutoRaw(s, value) {
  var v = String(value === null || value === undefined ? '' : value).trim();
  if (!v) return false;
  if (/^'[\s\S]*'$/.test(v) || /^"[\s\S]*"$/.test(v)) return true;   // 用户自己写了引号
  if (/^(null|sysdate|systimestamp|current_date|current_timestamp)\b/i.test(v)) return true;
  if (/^now\s*\(\s*\)$/i.test(v)) return true;
  if (/^[A-Za-z_][A-Za-z0-9_$.]*\s*\(/.test(v)) return true;          // 函数调用
  if (/^[A-Za-z_][A-Za-z0-9_$.]*\s*[-+*/]/.test(v)) return true;      // SYSDATE-1
  // 纯数字：只有该列本身是数值列才原样插。文本列存数字（如 '007'）必须加引号，
  // 否则 Oracle 会把整列隐式转成数字比较，遇到非数字行直接报错。
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(v)) return s.value_kind === 'num';
  return false;
}

function aiasSlotIsRaw(s, value) {
  if (s && s.raw_override !== undefined && s.raw_override !== null) return !!s.raw_override;
  return aiasSlotAutoRaw(s, value);
}

// 拼出替换文本（插入方式由调用方显式给出）：
//   · 字面量 → 沿用原占位符的引号（无引号但需要引号时补一对），并转义值里的引号
//   · 原样   → 一个字符都不动（表达式 / 多值 / 已带引号的值）
function aiasSlotWrapWith(s, value, raw) {
  var v = String(value === null || value === undefined ? '' : value);
  if (raw) return v;
  var q = s.quote || (s.need_quote ? "'" : '');
  if (!q) return v;
  return q + v.split(q).join(q + q) + q;
}

// 按当前编辑态（自动判定 / 用户手动覆盖）拼出替换文本 —— 供"插入预览"使用
function aiasSlotWrapValue(s, value) {
  return aiasSlotWrapWith(s, value, aiasSlotIsRaw(s, value));
}

// 记下某个槽位的取值并重算 SQL。
// 不再需要"重新识别"：占位符仍留在基线 SQL 里，值只是叠加在上面的渲染结果。
function aiasSlotSetValue(i, value, raw) {
  var st = _aiasSlotState;
  if (!st || i < 0) return;
  var s = st.slots[i];
  if (!s) return;
  value = (value === undefined || value === null) ? '' : String(value).trim();
  if (!value) return;
  aiasSlotPushUndo(st);                // 压一份快照，Ctrl+Z 可逐步回撤
  st.led.values[s.name] = { value: value, raw: !!raw };
  aiasSlotCommit(st.pre, aiasSlotDraft(st));
  aiasSlotSetNotice('');
  aiasSlotUpdateHint(st.pre);
  // 填完一个就把光标带到下一个还没填的槽位 —— 连续录入不用来回点鼠标
  st.focusIndex = aiasSlotNextEmpty(i);
  aiasSlotRender();      // 本地重绘即可：立刻显示"已替换"状态 +「撤销」，不请求后端
}

// 下一个还没替换的槽位（从 from 之后开始绕一圈）
function aiasSlotNextEmpty(from) {
  var st = _aiasSlotState;
  if (!st || !st.slots.length) return from;
  for (var k = 1; k <= st.slots.length; k++) {
    var idx = (from + k) % st.slots.length;
    if (!st.led.values[st.slots[idx].name]) return idx;
  }
  return from;
}

function aiasSlotApply(i, value) {
  var st = _aiasSlotState;
  if (!st) return;
  var s = st.slots[i];
  if (!s) return;
  aiasSlotSetValue(i, value, aiasSlotIsRaw(s, value));
}

// 撤销单个槽位的替换（把占位符放回去）
function aiasSlotRevert(i) {
  var st = _aiasSlotState;
  if (!st) return;
  var s = st.slots[i];
  if (!s) return;
  if (!st.led.values[s.name]) return;      // 本来就没替换 → 什么都不做，别污染撤销栈
  aiasSlotPushUndo(st);
  delete st.led.values[s.name];
  delete s.raw_override;
  aiasSlotCommit(st.pre, aiasSlotDraft(st));
  aiasSlotSetNotice('');
  aiasSlotUpdateHint(st.pre);
  st.focusIndex = i;
  aiasSlotRender();
}

// 撤销全部替换（占位符全放回去）—— 注意：只撤"值"，语句本身保持现版本
function aiasSlotRevertAll() {
  var st = _aiasSlotState;
  if (!st) return;
  var n = Object.keys(st.led.values || {}).length;
  if (!n) {
    aiasSlotSetNotice('<div class="aias-slot-verify warn">当前没有已替换的槽位</div>');
    return;
  }
  aiasSlotPushUndo(st);
  st.led.values = {};
  for (var i = 0; i < st.slots.length; i++) delete st.slots[i].raw_override;
  aiasSlotCommit(st.pre, st.led.originalSql);
  aiasSlotUpdateHint(st.pre);
  aiasSlotSetNotice('<div class="aias-slot-verify">↩️ 已撤销 ' + n
    + ' 处替换，占位符都回来了（Ctrl+Z 可以撤回这一步）</div>');
  aiasSlotRender();
}

// 字段值：先校验"这个值在该列里真的存在吗"，再决定是否替换。
// 没有这一步，`status = 'ACTIVEE'` 会静默返回 0 行 —— 用户分不清填错还是真没数据。
function aiasSlotApplyChecked(i, value) {
  var st = _aiasSlotState;
  if (!st || i < 0) return;
  var s = st.slots[i];
  if (!s) return;
  value = (value === undefined || value === null) ? '' : String(value).trim();
  if (!value) return;
  // 对象类角色（表名/索引/schema/表空间）没有"取值"概念，直接替换
  if (!s.value_like) { aiasSlotApply(i, value); return; }
  if (!st.ds) {
    // 没选数据源就没法查真实数据 —— 依然让用户替换（不能堵死流程），
    // 但必须**明确告知本次没校验**，否则"静默通过"会被误当成"校验过了"。
    aiasSlotApply(i, value);
    aiasSlotSetNotice('<div class="aias-slot-verify">ℹ️ 已替换；当前未选择数据源，本次<b>未做取值校验</b></div>');
    return;
  }
  // 原样插入（表达式 / 多值 / 已带引号的值）不做等值校验：`SYSDATE-1` 这类
  // 根本不存在"某个具体取值"，硬校验只会误报「不存在」。
  if (aiasSlotIsRaw(s, value)) {
    aiasSlotApply(i, value);
    aiasSlotSetNotice('<div class="aias-slot-verify">ℹ️ 已按<b>原样</b>插入（表达式/多值不加引号），未做取值校验</div>');
    return;
  }
  st.pendingValue = value;
  st.pendingIndex = i;
  aiasSlotSetNotice('<div class="aias-slot-verify">⏳ 正在校验该取值…（校验通过后立即替换）</div>');
  // 校验只允许"一次落地"：超时兜底与 fetch 回调谁先到谁生效，另一个直接放弃。
  // 没有这个兜底，探测偶发变慢时用户会一直停在"正在校验…"上 ——
  // 回车按了、屏幕上什么都没发生，是最容易让人以为功能坏了的情形。
  var landed = false;
  var claim = function () { if (landed) return false; landed = true; return true; };
  var guard = setTimeout(function () {
    if (!claim()) return;
    if (!_aiasSlotState || _aiasSlotState !== st) return;
    aiasSlotApply(i, value);
    aiasSlotSetNotice('<div class="aias-slot-verify warn">ℹ️ 取值校验超时（8 秒），已按你输入的值替换 —— '
      + '未确认该取值是否存在</div>');
  }, 8000);
  fetch('/api/chat/sql-slot-verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 校验用的 SQL 传"基线 SQL"：占位符在 FROM 之外，不影响定位表/列，
    // 而且它是稳定的（不随已替换的值变化）。
    body: JSON.stringify({ datasource_name: st.ds, sql: st.originalSql,
                           slot: { name: s.name, role: s.role, col_ref: s.col_ref },
                           value: value })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (!claim()) return;
    clearTimeout(guard);
    if (!_aiasSlotState || _aiasSlotState !== st) return;
    var c = (d && d.ok && (d.checks || [])[0]) || null;
    if (!c || c.exists === null || c.exists === undefined) {
      // 校验不可用（没能定位表/列）→ 不阻塞，直接替换
      aiasSlotApply(i, value);
      if (c && c.reason) {
        // 注意用"只更新提示区"，不要整菜单重绘 —— 否则会把输入框里正在敲的内容清掉
        aiasSlotSetNotice('<div class="aias-slot-verify warn">ℹ️ ' + escHtml(c.reason) + '</div>');
      }
      return;
    }
    if (c.exists === false) {
      var h = '<div class="aias-slot-verify warn">⚠️ ' + escHtml(c.reason || '该取值不存在') + '</div>';
      var ps = c.candidates || c.similar || [];
      if (ps.length) {
        h += '<div class="aias-slot-verify-picks">是否想用：';
        for (var k = 0; k < ps.length && k < 5; k++) {
          var pq = String(ps[k]).replace(/"/g, '&quot;');
          h += '<button data-i="' + i + '" data-v="' + escHtml(pq) + '" title="采用 ' + escHtml(pq) + '" '
            + 'onclick="aiasSlotApplyCand(this)">' + escHtml(ps[k]) + '</button>';
        }
        h += '</div>';
      }
      h += '<div class="aias-slot-verify-picks"><button onclick="aiasSlotForceApply()" '
        + 'title="忽略校验，仍用我刚填的值">仍然使用「' + escHtml(value) + '」</button></div>';
      aiasSlotSetNotice(h);
      return;
    }
    // 存在（或只是时间阈值提示）→ 替换；时间阈值的提醒保留在菜单上
    aiasSlotApply(i, value);
    if (c.warning) {
      aiasSlotSetNotice('<div class="aias-slot-verify warn">ℹ️ ' + escHtml(c.reason) + '</div>');
    }
  }).catch(function () { aiasSlotApply(i, value); });
}

// 只更新提示区，不重绘整个菜单（保住输入框焦点与已输入内容）
function aiasSlotSetNotice(html) {
  var st = _aiasSlotState;
  if (!st) return;
  st.noticeHtml = html || '';
  var el = document.getElementById('aias-slot-notice');
  if (el) el.innerHTML = st.noticeHtml;
}

// 忽略校验结果，强行使用用户填的值
function aiasSlotForceApply() {
  var st = _aiasSlotState;
  if (!st || !st.pendingValue) return;
  var i = (st.pendingIndex === undefined || st.pendingIndex === null) ? st.active : st.pendingIndex;
  if (i < 0) return;
  var v = st.pendingValue;
  st.pendingValue = '';
  aiasSlotSetNotice('');
  // 注意：这里**不能**把 raw_override 设成 true。用户的意思是"就算它不存在也照我写的插"，
  // 而不是"按表达式插入" —— 该加引号还是要加（否则 = TABLEE 直接变成非法标识符）。
  aiasSlotApply(i, v);
}

function aiasSlotApplyAll() {
  var st = _aiasSlotState;
  if (!st) return;
  var pending = [];
  for (var i = 0; i < st.slots.length; i++) {
    var s = st.slots[i];
    if (!s.suggest || st.led.values[s.name]) continue;
    pending.push(s);
  }
  if (!pending.length) return;
  aiasSlotPushUndo(st);                 // 整批算一步，Ctrl+Z 一次撤回
  for (var j = 0; j < pending.length; j++) {
    var sj = pending[j];
    st.led.values[sj.name] = { value: sj.suggest, raw: aiasSlotIsRaw(sj, sj.suggest) };
  }
  st.focusIndex = -1;
  aiasSlotCommit(st.pre, aiasSlotDraft(st));
  aiasSlotUpdateHint(st.pre);
  aiasSlotSetNotice('<div class="aias-slot-verify">✅ 已替换 ' + pending.length
    + ' 个占位符。要改就在对应行的输入框里直接改后回车；要退回点该行的撤销图标，'
    + '或按 Ctrl+Z 逐步回撤。</div>');
  aiasSlotRender();
}

// 名额保留（别处仍会调用）：以前这里要重新请求识别接口 —— 因为旧实现把占位符
// 就地改掉了，剩下的槽位位置全都位移，必须重算。现在占位符留在原始 SQL 里、
// 替换只改"值"，所以本地重绘就够了（顺带省掉每次替换一次环境探测的往返）。
function aiasSlotRefresh() {
  var st = _aiasSlotState;
  if (!st) return;
  aiasSlotUpdateHint(st.pre);
  aiasSlotRender();
}

function aiasSlotRender() {
  var st = _aiasSlotState;
  var menu = document.getElementById('aias-slot-menu');
  if (!st || !menu) return;
  var slots = st.slots;
  var doneCount = 0, pendingSuggest = 0;
  for (var q = 0; q < slots.length; q++) {
    if (st.led.values[slots[q].name]) doneCount++;
    else if (slots[q].suggest) pendingSuggest++;
  }
  // 头部：标题 + 计数 + 关闭（图标按钮）。计数里带数据源，避免"到底在哪个库上校验"要回头找。
  var html = '<div class="aias-slot-menu-head">🔧 SQL 占位符'
    + '<span class="aias-slot-count">共 ' + slots.length + ' 个'
    + (doneCount ? ' · 已替换 ' + doneCount + ' 个' : '')
    + ' · ' + (st.ds ? escHtml(st.ds) : '未选数据源') + '</span>'
    + '<button class="aias-ibtn" title="关闭 (Esc)" aria-label="关闭" '
    + 'onclick="aiasSlotClose()">' + _AIAS_IC.close + '</button></div>';

  // 工具条：全部用推荐值 / 撤销全部 / 撤销一步 —— 全图标、幽灵态、常驻可见。
  // 旧版这里是"图标+文字"的长条按钮，槽位一多菜单就被撑爆（"很难用"的主因之一）。
  var tools = '';
  if (pendingSuggest) {
    tools += '<button class="aias-ibtn ok aias-slot-apply-all" aria-label="全部替换为推荐值" '
      + 'title="全部替换为推荐值（' + pendingSuggest + ' 个，一步完成）" '
      + 'onclick="aiasSlotApplyAll()">' + _AIAS_IC.spark + '</button>';
  }
  if (doneCount) {
    tools += '<button class="aias-ibtn danger aias-slot-undo-all" aria-label="撤销全部替换" '
      + 'title="撤销全部 ' + doneCount + ' 处替换（占位符放回 SQL）" '
      + 'onclick="aiasSlotRevertAll()">' + _AIAS_IC.undoAll + '</button>';
  }
  tools += '<button class="aias-ibtn aias-slot-undo" aria-label="撤销上一步" title="撤销上一步 (Ctrl+Z)" '
    + 'onclick="aiasSlotUndo()">' + _AIAS_IC.undo + '</button>';
  html += '<div class="aias-slot-tools">' + tools
    + '<span class="aias-slot-tools-gap"></span>'
    + '<span class="aias-slot-keys">Enter 替换 · ↑↓ 切行 · Ctrl+Z 撤销</span></div>';

  html += '<div id="aias-slot-notice">' + (st.noticeHtml || '') + '</div>';

  if (st.mode === 'value') {
    var s = slots[st.active] || {};
    html += '<div class="aias-slot-list">';
    html += '<div class="aias-slot-rowtop"><span class="aias-slot-raw"><code>'
      + escHtml(s.raw || '') + '</code>'
      + (s.role_cn ? '<span class="aias-slot-role">' + escHtml(s.role_cn) + '</span>' : '')
      + (s.bare ? '<span class="aias-slot-role">纯对象名</span>' : '') + '</span></div>';
    var ph = s.value_like
      ? '搜索该列的真实取值；或直接输入值后回车'
      : '搜索候选；或直接输入值后回车';
    html += '<input class="aias-slot-search" id="aias-slot-search" placeholder="' + ph + '" value="'
      + escHtml(st.keyword || '').replace(/"/g, '&quot;') + '">';
    html += '<div class="aias-slot-cands" id="aias-slot-cands">'
      + (st.candsHtml || '<div class="aias-slot-hint">输入关键词开始检索…</div>') + '</div>';
    html += '</div>';
  } else {
    html += '<div class="aias-slot-list">';
    for (var i = 0; i < slots.length; i++) {
      var sl = slots[i];
      var cur = st.led.values[sl.name];
      // 一行 = 一个槽位：① 占位符 + 角色；② 输入框 + 三个图标按钮；③ 插入预览。
      // 已替换的行左侧描绿边（状态一眼可辨），不再单独占一行写"✅ 已替换为 X" ——
      // 输入框里本来就是当前值，重复显示只是噪音。
      html += '<div class="aias-slot-row' + (cur ? ' is-done' : '') + '" data-i="' + i + '">';
      html += '<div class="aias-slot-rowtop">'
        + '<span class="aias-slot-idx">' + (i + 1) + '</span>'
        + '<span class="aias-slot-raw"><code>' + escHtml(sl.raw) + '</code>'
        // 角色中文名里可能已经带了列名（"字段值 · 列 X"）→ 已经带了就不重复贴一遍
        + (sl.role_cn ? '<span class="aias-slot-role">' + escHtml(sl.role_cn) + '</span>' : '')
        + (sl.col_ref && (sl.role_cn || '').indexOf(sl.col_ref) < 0
            ? '<span class="aias-slot-role">列 ' + escHtml(sl.col_ref) + '</span>' : '')
        + (sl.bare ? '<span class="aias-slot-role">纯名</span>' : '')
        + '</span></div>';
      // ★ 就地手工录入：右键后直接在这一行打字回车即可替换。
      //   已替换的行把当前值预填进来（聚焦时全选）—— 想改就直接改，回车生效。
      html += '<div class="aias-slot-entry">'
        + '<input class="aias-slot-entry-input" data-i="' + i + '" autocomplete="off" spellcheck="false" '
        + 'aria-label="第 ' + (i + 1) + ' 个占位符的取值" '
        + 'value="' + escHtml(cur ? cur.value : '').replace(/"/g, '&quot;') + '" '
        + 'placeholder="输入取值后回车">'
        + '<button class="aias-ibtn aias-slot-mode" data-i="' + i + '" onclick="aiasSlotToggleMode(this)" '
        + 'title="插入方式" aria-label="插入方式">' + _AIAS_IC.quote + '</button>'
        + '<button class="aias-ibtn aias-slot-find" data-i="' + i + '" onclick="aiasSlotPick(' + i + ')" '
        + 'title="搜索候选（也可以直接在上面的输入框里打字）" aria-label="搜索候选">'
        + _AIAS_IC.search + '</button>'
        + (cur ? '<button class="aias-ibtn danger aias-slot-revert" data-i="' + i + '" '
            + 'onclick="aiasSlotRevert(' + i + ')" title="撤销这一处替换" '
            + 'aria-label="撤销这一处替换">' + _AIAS_IC.undo + '</button>' : '')
        + '</div>';
      html += '<div class="aias-slot-preview" data-i="' + i + '"></div>';
      if (sl.suggest && !cur) {
        html += '<div class="aias-slot-sug">推荐：<button data-i="' + i + '" data-v="'
          + escHtml(sl.suggest).replace(/"/g, '&quot;') + '" onclick="aiasSlotApplyCand(this)" title="点击采用">'
          + escHtml(sl.suggest) + '</button></div>';
      }
      html += '</div>';
    }
    html += '</div>';
  }
  html += '<div class="aias-slot-actions">'
    + (st.mode === 'value' ? '<button onclick="aiasSlotBack()">← 返回</button>' : '')
    + '<button onclick="aiasSlotClose()">关闭 (Esc)</button></div>';
  menu.innerHTML = html;
  aiasSlotPlace(menu, st.x, st.y);
  if (st.mode === 'value') {
    var inp = document.getElementById('aias-slot-search');
    if (inp) {
      inp.focus();
      inp.oninput = function () { aiasSlotSearch(inp.value); };
      inp.onkeydown = function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          var v = inp.value.trim();
          if (v) aiasSlotApplyChecked(st.active, v);
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          aiasSlotBack();
        }
      };
    }
  } else {
    // 列表态：接上每行的"就地录入"（预览 + 回车替换 + 方向键切行 + Ctrl+Z 撤销）
    var entries = menu.querySelectorAll('.aias-slot-entry-input');
    for (var k = 0; k < entries.length; k++) {
      (function (el) {
        var idx = parseInt(el.getAttribute('data-i'), 10);
        el.oninput = function () { aiasSlotEntryPreview(idx); };
        el.onkeydown = function (ev) { aiasSlotEntryKey(ev, idx); };
      })(entries[k]);
    }
    for (var m = 0; m < st.slots.length; m++) aiasSlotEntryPreview(m);
    // 聚焦策略：优先落到"下一个待填"的槽位（连续录入），当前值全选（直接打字即替换）。
    var fi = (st.focusIndex === undefined || st.focusIndex === null) ? 0 : st.focusIndex;
    st.focusIndex = -1;
    if (fi < 0) fi = 0;
    var fe = menu.querySelector('.aias-slot-entry-input[data-i="' + fi + '"]');
    if (!fe && entries.length) fe = entries[0];
    if (fe) { try { fe.focus(); if (fe.value) fe.select(); } catch (e) {} }
  }
}

// 就地录入：实时预览"到底会插进去什么"（引号/转义是否如预期），
// 同时同步"字面量 / 原样"标签，让用户对插入方式心里有数。
function aiasSlotEntryPreview(i) {
  var st = _aiasSlotState;
  if (!st) return;
  var s = st.slots[i];
  if (!s) return;
  var inp = document.querySelector('.aias-slot-entry-input[data-i="' + i + '"]');
  var box = document.querySelector('.aias-slot-preview[data-i="' + i + '"]');
  var chip = document.querySelector('.aias-slot-mode[data-i="' + i + '"]');
  var v = inp ? inp.value.trim() : '';
  var raw = v ? aiasSlotIsRaw(s, v) : (s.raw_override === true);
  if (chip) {
    // 插入方式改成图标按钮：引号 = 字面量（自动加引号+转义），尖括号 = 原样（一个字符都不改）
    chip.innerHTML = raw ? _AIAS_IC.code : _AIAS_IC.quote;
    chip.className = 'aias-ibtn aias-slot-mode' + (raw ? ' raw' : '');
    var mt = raw ? '插入方式：原样（表达式 / 多值 / 已带引号，一个字符都不改）—— 点击改为字面量'
                 : '插入方式：字面量（自动加引号并转义）—— 点击改为原样';
    chip.title = mt;
    chip.setAttribute('aria-label', mt);
  }
  if (!box) return;
  if (!v) { box.innerHTML = ''; return; }
  // 输入内容 == 这一行已经落地的值 → 回车也不会产生变化，不必再显示"将插入 X"
  var applied = st.led.values[s.name];
  if (applied && applied.value === v) { box.innerHTML = ''; return; }
  var pv = aiasSlotWrapValue(s, v);
  // 值 == 插入结果时不必再写一行"将插入：X"（纯噪音）；只有加了引号/转义才提示，
  // 因为那正是用户会"惊喜"的地方。
  if (pv === v) { box.innerHTML = ''; return; }
  box.innerHTML = '将插入：<b>' + escHtml(pv) + '</b>';
}

// 手动切换插入方式（表达式 / 多值 / 已带引号的值不该被自动加引号）
function aiasSlotToggleMode(btn) {
  var st = _aiasSlotState;
  if (!st) return;
  var i = parseInt(btn.getAttribute('data-i'), 10);
  var s = st.slots[i];
  if (!s) return;
  var inp = document.querySelector('.aias-slot-entry-input[data-i="' + i + '"]');
  var v = inp ? inp.value.trim() : '';
  aiasSlotPushUndo(st);
  s.raw_override = !aiasSlotIsRaw(s, v);
  // 已替换的槽位：切换插入方式会改变最终 SQL → 必须立刻重算（不能只改图标）
  if (st.led.values[s.name]) {
    st.led.values[s.name].raw = s.raw_override;
    aiasSlotCommit(st.pre, aiasSlotDraft(st));
    aiasSlotUpdateHint(st.pre);
  }
  aiasSlotEntryPreview(i);
  if (inp) inp.focus();
}

// 把焦点挪到相邻槽位（↑↓），方便连续录入/复核
function aiasSlotMoveFocus(i, delta) {
  var st = _aiasSlotState;
  if (!st || !st.slots.length) return;
  var j = Math.min(st.slots.length - 1, Math.max(0, i + delta));
  var el = document.querySelector('.aias-slot-entry-input[data-i="' + j + '"]');
  if (el) { el.focus(); if (el.value) el.select(); }
}

function aiasSlotEntryKey(ev, i) {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    var v = (ev.target.value || '').trim();
    if (v) aiasSlotApplyChecked(i, v);
    else aiasSlotRevert(i);          // 清空内容再回车 = 撤销这一处（不用去找那个小图标）
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    aiasSlotClose();
  } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    aiasSlotMoveFocus(i, ev.key === 'ArrowDown' ? 1 : -1);
  } else if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'z' || ev.key === 'Z')) {
    ev.preventDefault();
    aiasSlotUndo();
  }
}

function aiasSlotPick(i) {
  var st = _aiasSlotState;
  if (!st) return;
  st.mode = 'value';
  st.active = i;
  st.keyword = '';
  st.candsHtml = '';
  aiasSlotRender();
  aiasSlotSearch('');
}

function aiasSlotBack() {
  var st = _aiasSlotState;
  if (!st) return;
  st.mode = 'list';
  st.active = -1;
  aiasSlotRender();
}

function aiasSlotSearch(kw) {
  var st = _aiasSlotState;
  if (!st) return;
  st.keyword = kw || '';
  if (st.timer) clearTimeout(st.timer);
  var s = st.slots[st.active] || {};
  var box = document.getElementById('aias-slot-cands');
  if (!st.ds) {
    if (box) box.innerHTML = '<div class="aias-slot-hint">⚠️ 未选择数据源，无法检索候选 —— 可直接在上方输入值后回车</div>';
    return;
  }
  if (box) box.innerHTML = '<div class="aias-slot-hint">⏳ 检索中…</div>';
  st.timer = setTimeout(function () {
    fetch('/api/chat/sql-slot-candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ datasource_name: st.ds, name: s.name, role: s.role,
                             keyword: st.keyword, bare: !!s.bare,
                             // 字段值：候选来自"该列的真实取值"，后端需要这些信息
                             col_ref: s.col_ref || '', sql: st.originalSql, quote: s.quote || '' })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!_aiasSlotState || _aiasSlotState !== st) return;
      var b2 = document.getElementById('aias-slot-cands');
      if (!b2) return;
      if (!d.ok) { b2.innerHTML = '<div class="aias-slot-err">⚠️ ' + escHtml(d.error || '检索失败') + '</div>'; return; }
      // 日期型列给的是裸时间文本、原 SQL 无引号 → 采用时要自动补引号
      s.need_quote = !!d.need_quote;
      var cs = d.candidates || [];
      if (!cs.length) {
        b2.innerHTML = '<div class="aias-slot-hint">' + escHtml(d.note || '没有匹配的候选 —— 可直接输入值后回车') + '</div>';
        return;
      }
      var h = '';
      for (var i = 0; i < cs.length; i++) {
        // 兼容两种形态：字符串（数据字典）与 {value,label}（字段值/时间预设）
        var v = (cs[i] && typeof cs[i] === 'object') ? cs[i].value : cs[i];
        var lb = (cs[i] && typeof cs[i] === 'object') ? (cs[i].label || '') : '';
        var q = String(v === null || v === undefined ? '' : v).replace(/"/g, '&quot;');
        h += '<div class="aias-slot-cand" data-i="' + (st.active) + '" data-v="' + escHtml(q).replace(/"/g, '&quot;')
          + '" title="点击采用：' + escHtml(q) + '" onclick="aiasSlotApplyCand(this)">'
          + (lb ? '<span class="aias-slot-cand-label">' + escHtml(lb) + '</span>' : '')
          + '<span class="aias-slot-cand-val">' + escHtml(q) + '</span></div>';
      }
      if (d.note) h += '<div class="aias-slot-hint">' + escHtml(d.note) + '</div>';
      st.candsHtml = h;      // 记住候选，刷新菜单时不至于把检索结果冲掉
      b2.innerHTML = h;
    }).catch(function () {
      var b3 = document.getElementById('aias-slot-cands');
      if (b3) b3.innerHTML = '<div class="aias-slot-err">⚠️ 检索请求失败</div>';
    });
  }, 220);
}

function aiasSlotOpen(pre, x, y) {
  aiasSlotClose();
  var domText = aiasSlotText(pre);
  if (!domText || !domText.trim()) return;
  var ds = aiasSlotDs();
  var ctx = '';
  try {
    var box = pre.closest('.aias-msg-text') || pre.closest('.aias-drilldown-msg-content') || pre.parentElement;
    ctx = (box ? box.textContent : '').slice(0, 4000);
  } catch (e) { ctx = ''; }

  // 取（或建）替换台账：原始 SQL（含占位符）与"已选值"分开存。
  // 这样即使 SQL 里已经被替换成真实值，再打开菜单时占位符依然"在" → 随时可改、可还原。
  var led = aiasSlotLedgerAcquire(pre, domText);

  var menu = document.createElement('div');
  menu.className = 'aias-slot-menu';
  menu.id = 'aias-slot-menu';
  menu.innerHTML = '<div class="aias-slot-hint">⏳ 正在识别占位符…</div>';
  document.body.appendChild(menu);
  aiasSlotPlace(menu, x, y);

  _aiasSlotState = { pre: pre, originalSql: led.originalSql, led: led, ds: ds, ctx: ctx,
                     slots: [], mode: 'list', active: -1, timer: null, x: x, y: y,
                     noticeHtml: '', pendingValue: '', pendingIndex: -1,
                     undo: [], focusIndex: 0 };

  // 识别永远基于**原始 SQL**（占位符齐全）：结果稳定，不受已替换的值影响
  fetch('/api/chat/sql-slots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: led.originalSql, datasource_name: ds, context_text: ctx })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (!_aiasSlotState || _aiasSlotState.pre !== pre) return;
    if (!d.ok) {
      menu.innerHTML = '<div class="aias-slot-err">⚠️ ' + escHtml(d.error || '识别失败') + '</div>';
      return;
    }
    _aiasSlotState.slots = d.slots || [];
    led.slots = _aiasSlotState.slots;
    if (!_aiasSlotState.slots.length) {
      menu.innerHTML = '<div class="aias-slot-menu-head">🔧 SQL 占位符'
        + '<span class="aias-slot-count">共 0 个</span>'
        + '<button class="aias-ibtn" title="关闭 (Esc)" aria-label="关闭" '
        + 'onclick="aiasSlotClose()">' + _AIAS_IC.close + '</button></div>'
        + '<div class="aias-slot-hint">未发现占位符。<br>支持写法：'
        + '<code>&lt;表名&gt;</code>、<code>${db.schema}</code>、<code>' + (window.__DBCHECK_TABLE_PH != null ? window.__DBCHECK_TABLE_PH : '{{table}}') + '</code>、'
        + '<code>#表名#</code>、<code>[表名]</code>、<code>:name</code></div>'
        + '<div class="aias-slot-actions"><button onclick="aiasSlotClose()">关闭 (Esc)</button></div>';
      return;
    }
    // 打开就把光标放到"第一个还没填的槽位"：右键 → 直接打字 → 回车，一步到位
    var fi = 0;
    for (var z = 0; z < _aiasSlotState.slots.length; z++) {
      if (!led.values[_aiasSlotState.slots[z].name]) { fi = z; break; }
    }
    _aiasSlotState.focusIndex = fi;
    aiasSlotRender();
  }).catch(function (e) {
    var m = document.getElementById('aias-slot-menu');
    if (m) m.innerHTML = '<div class="aias-slot-err">⚠️ 请求失败：' + escHtml((e && e.message) || '网络异常') + '</div>';
  });
}

// 代码块旁的"含未替换占位符"提示（幂等：只切换显示，不反复增删节点，
// 否则会与 MutationObserver 互相触发形成死循环）。
// 可执行的 SQL 块挂在它自己的「执行SQL」按钮旁边；**不可执行的块（DDL/脚本）挂在代码块下方** ——
// 否则用户看到 `<file_name>` 这种占位符根本不知道可以右键替换。
//
// ⚠️ 提示节点必须**按代码块各自持有**（挂在 `pre.__slotHint` 上）：
// 早先是 `pre.parentElement.querySelector('.aias-slot-left-hint')` —— 一条回答里多个代码块的
// 父节点都是同一个 `.aias-msg-text`，于是：
//   ① 只有第一个块拿到提示（其余块复用同一个节点，挂在别人身上）；
//   ② 只要有一个没有占位符的块被检查，就会把这个共享节点 `display:none` —— 把别人的提示也关掉。
// 同理执行按钮要按"紧邻的下一个兄弟"取，不能在整个父容器里找（会拿到别的块的）。
function aiasSlotUpdateHint(pre) {
  // 交互调整：不再显示“⚠ 含占位符 · 右键替换”可见提示条。
  // 占位符替换改为「鼠标选中 / 在代码块上右键」触发 —— 见 aiasSlotInitContextMenu：
  // 在含占位符（或可执行）的代码块上右键即弹出替代框，可直接输入并回车完成替换。
  // 调用点（34210 / 34837）保留但无副作用，避免删除后影响其它逻辑。
  return;
}

/* ── 选区替换：选中任意字符串 → 右键 → 原位替换 / 全部替换 ──
   与「占位符菜单」并列的另一条入口，两者共用同一套菜单外观（.aias-slot-menu）。
   占位符菜单填「识别出来的槽位」；这里是针对「鼠标选中的那一段文本」，范围更宽 ——
   在代码块里选中表名、列名、字面量等任意字符串，右键即可替换（本次 或 全部相同文字）。 */
var _aiasSelState = null;   // {pre, target, startContainer, startOffset, endContainer, endOffset}

function aiasSelClose() {
  var m = document.getElementById('aias-sel-menu');
  if (m && m.parentNode) m.parentNode.removeChild(m);
  _aiasSelState = null;
}

// 指定代码块内是否存在有效（非空）文本选区？
function aiasSelGetSelectionIn(pre) {
  try {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
    var code = pre.querySelector('code');
    if (!code) return '';
    var range = sel.getRangeAt(0);
    if (!code.contains(range.startContainer) || !code.contains(range.endContainer)) return '';
    var txt = (sel.toString() || '').replace(/\u00a0/g, ' ').trim();
    if (!txt || txt.length > 400) return '';
    return txt;
  } catch (e) { return ''; }
}

// 在 aiasPreText 字符串坐标下，返回 (container,offset) 的字符偏移（<br> 计 1，与 aiasPreText 口径一致）
function aiasSelOffsetOf(pre, container, offset) {
  if (!container || container.nodeType !== 3) return -1;
  var code = pre.querySelector('code') || pre;
  var acc = 0;
  function walk(n) {
    if (n.nodeType === 3) {
      if (n === container) return acc + offset;
      acc += n.nodeValue.length;
      return -1;
    }
    if (n.nodeName === 'BR') { acc += 1; return -1; }
    for (var i = 0; i < n.childNodes.length; i++) {
      var r = walk(n.childNodes[i]);
      if (r >= 0) return r;
    }
    return -1;
  }
  return walk(code);
}

// 找出「选区所在的那一处」在 cur 中是第 n 次（0 基）出现；选区未命中时返回 -1，调用方回退到第一处
function aiasSelNthOf(cur, target, startOff, endOff) {
  if (!cur || !target) return -1;
  var n = 0, p = cur.indexOf(target, 0);
  while (p !== -1) {
    if (startOff >= 0 && p < endOff && p + target.length > startOff) return n;
    n++; p = cur.indexOf(target, p + target.length);
  }
  return -1;
}

function aiasSelCount(cur, target) {
  return (cur && target && cur.indexOf(target) !== -1) ? cur.split(target).length - 1 : 0;
}

function aiasSelOpen(pre, target, x, y) {
  aiasSelClose();
  aiasSlotClose();
  var startC = null, startO = 0, endC = null, endO = 0;
  try {
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      var r = sel.getRangeAt(0);
      startC = r.startContainer; startO = r.startOffset;
      endC = r.endContainer; endO = r.endOffset;
    }
  } catch (e) {}
  var cur = aiasSlotText(pre);
  var n = aiasSelCount(cur, target);
  var tShow = target.length > 48 ? target.slice(0, 48) + '…' : target;
  var menu = document.createElement('div');
  menu.className = 'aias-slot-menu';
  menu.id = 'aias-sel-menu';
  menu.innerHTML =
    '<div class="aias-slot-menu-head">🔧 替换选中文本'
    + '<span class="aias-slot-count">共 ' + n + ' 处</span>'
    + '<button class="aias-ibtn" title="关闭 (Esc)" aria-label="关闭" onclick="aiasSelClose()">' + _AIAS_IC.close + '</button></div>'
    + '<div class="aias-slot-hint" style="word-break:break-all;">目标：<code>' + escHtml(tShow) + '</code></div>'
    + '<input id="aias-sel-input" autofocus placeholder="输入新的文本（留空 = 删除）" '
    + 'style="width:100%;box-sizing:border-box;padding:5px 8px;font-size:12px;outline:none;'
    + 'border:1px solid var(--border,rgba(0,0,0,.15));border-radius:6px;'
    + 'background:var(--surface2,rgba(0,0,0,.05));color:var(--text-main,#1f2328);">'
    + '<div class="aias-slot-actions">'
    + '<button onclick="aiasSelApply(false)">替换</button>'
    + '<button onclick="aiasSelApply(true)" title="同时替换本代码块内所有相同文本">全部替换</button>'
    + '<button onclick="aiasSelClose()">关闭 (Esc)</button>'
    + '</div>'
    + '<div class="aias-slot-err" id="aias-sel-status" style="display:none;"></div>';
  document.body.appendChild(menu);
  aiasSlotPlace(menu, x, y);
  _aiasSelState = { pre: pre, target: target,
                    startContainer: startC, startOffset: startO,
                    endContainer: endC, endOffset: endO };
  var inp = document.getElementById('aias-sel-input');
  if (inp) { try { inp.focus(); } catch (e) {} }
}

function aiasSelSetStatus(msg) {
  var s = document.getElementById('aias-sel-status');
  if (s) { s.style.display = msg ? '' : 'none'; s.textContent = msg || ''; }
}

function aiasSelApply(all) {
  var st = _aiasSelState;
  if (!st || !st.pre) { aiasSelClose(); return; }
  var input = document.getElementById('aias-sel-input');
  var newVal = input ? input.value : '';
  var pre = st.pre;
  var cur = aiasSlotText(pre);
  var target = st.target;
  if (cur.indexOf(target) === -1) { aiasSelSetStatus('⚠️ 目标文本在当前代码块中已不存在'); return; }
  var newText;
  if (all) {
    newText = cur.split(target).join(newVal);
  } else {
    var startOff = aiasSelOffsetOf(pre, st.startContainer, st.startOffset);
    var endOff = aiasSelOffsetOf(pre, st.endContainer, st.endOffset);
    var nth = aiasSelNthOf(cur, target, startOff, endOff);
    if (nth < 0) nth = 0;
    newText = replaceNthOccurrence(cur, target, newVal, nth);
  }
  if (newText === cur) { aiasSelSetStatus('没有需要替换的内容'); return; }
  aiasSetBlockSql(pre, newText);      // 写回 DOM + 执行存储 + 作废占位符台账
  aiasSelClose();
}

function aiasSlotInitContextMenu() {
  if (window.__aiasSlotCtxBound) return;
  window.__aiasSlotCtxBound = true;
  document.addEventListener('contextmenu', function (e) {
    var t = e.target;
    var pre = (t && t.closest) ? t.closest('pre.aias-code-pre, pre.aias-sql-pre') : null;
    if (!pre) return;                      // 不是代码块 → 保留浏览器原生右键菜单
    // ① 有文本选区 → 走「替换选中文本」：范围不限"打了标签的占位符"，任意选中的字符串都可替换
    var selText = aiasSelGetSelectionIn(pre);
    if (selText) {
      e.preventDefault();
      aiasSelOpen(pre, selText, e.clientX, e.clientY);
      return;
    }
    // ② 无选区时才考虑"占位符菜单/执行 SQL"：只接管"可执行 SQL"或"确实含占位符"的块。
    // 其它代码块（shell / yaml / 普通片段）保留浏览器原生右键菜单 —— 用户还能用系统菜单复制，
    // 不该被无意义地挡掉。
    // ⚠️ 必须按"紧邻的下一个兄弟"判断有没有执行按钮：一条回答里多个代码块共用同一个
    // 父容器（.aias-msg-text），在父容器里找 `.aias-sql-exec-wrap` 会命中**别的**块的执行区，
    // 于是普通脚本块也会被误判成"可执行"、平白吃掉浏览器原生右键菜单。
    var nx = pre.nextElementSibling;
    var hasExec = !!(nx && nx.classList && nx.classList.contains('aias-sql-exec-wrap'));
    if (!hasExec && !_AIAS_SLOT_HINT_RE.test(aiasSlotText(pre))) return;
    e.preventDefault();
    aiasSlotOpen(pre, e.clientX, e.clientY);
  });
  document.addEventListener('keydown', function (e) {
    var sm = document.getElementById('aias-sel-menu');
    if (e.key === 'Enter' && sm && document.activeElement && document.activeElement.id === 'aias-sel-input') {
      e.preventDefault(); e.stopPropagation();
      aiasSelApply(false);
      return;
    }
    if (e.key !== 'Escape') return;
    if (sm) { aiasSelClose(); return; }
    if (document.getElementById('aias-slot-menu')) { aiasSlotClose(); return; }
    var vm = document.getElementById('aias-ver-modal');
    if (vm && vm.style.display !== 'none') aiasCloseDsVersions();
  });
  document.addEventListener('mousedown', function (e) {
    var m = document.getElementById('aias-slot-menu');
    if (m && !m.contains(e.target)) aiasSlotClose();
    var sm = document.getElementById('aias-sel-menu');
    if (sm && !sm.contains(e.target)) aiasSelClose();
  }, true);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', aiasSlotInitContextMenu);
} else {
  aiasSlotInitContextMenu();
}

function aiasExecuteSql(sqlId) {
  var sql = _aiasSqlStore[sqlId] || '';
  var resultDiv = document.getElementById(sqlId + '-result');
  if (!resultDiv) return;
  if (!sql.trim()) {
    resultDiv.innerHTML = '<div class="aias-sql-result-error">SQL 为空</div>';
    return;
  }
  // 会话默认数据源（输入框上方胶囊维护）→ 优先生效；无则回退页面当前数据源 → 再回退诊断上下文
  var currentDs = '';
  try {
    var sess = aiasCurrentSession();
    currentDs = (sess && sess.currentDatasource) || '';
  } catch(e) {}
  try {
    var ctx = getChatContext();
    var _ctxName = (ctx && ctx.datasource_name) || '';
    // 胶囊无默认源但页面当前选中有 → 借用页面当前数据源
    if (_ctxName && !currentDs) { currentDs = _ctxName; }
  } catch(e) {}

  if (currentDs) {
    // 会话已固化默认源 → 直接使用（胶囊点按即可切换）
    aiasRunSql(sqlId, currentDs);
  } else if (_diagDataSourceName && document.querySelector('.diag-detail-overlay')) {
    // 诊断详情上下文：报告已自带对应数据源，直接选用，免去弹窗多选
    aiasRunSql(sqlId, _diagDataSourceName);
  } else {
    // 尚无默认源 → 首次执行弹一次选择并固化为会话默认（此后胶囊显示、后续直接复用）
    resultDiv.innerHTML = '<div class="aias-sql-result-loading">⏳ 加载数据源列表...</div>';
    fetch('/api/pro/datasources')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok && data.datasources && data.datasources.length) {
          _aiasDsDsList = data.datasources;
          aiasShowDsModal(data.datasources, '请选择执行 SQL 的数据源（同时设为会话默认）：', function(ds) {
            aiasTrackDatasource({ datasource_name: ds });   // 固化 + 刷新胶囊
            aiasRunSql(sqlId, ds);
          });
        } else {
          resultDiv.innerHTML = '<div class="aias-sql-result-error">⚠️ 暂无可用数据源，请先在「数据源管理」中添加</div>';
        }
      })
      .catch(function() {
        resultDiv.innerHTML = '<div class="aias-sql-result-error">⚠️ 获取数据源列表失败</div>';
      });
  }
}

// ── AI 修复 SQL：基于执行报错信息修复语句，并覆盖原来显示的 SQL ──
function aiasFixSql(sqlId) {
  var oldSql = unescHtml(_aiasSqlStore[sqlId] || '');
  var error = _aiasSqlErrors[sqlId] || '';
  var dsName = _aiasSqlDs[sqlId] || '';
  var repair = _aiasSqlRepair[sqlId] || null;
  var resultDiv = document.getElementById(sqlId + '-result');
  // 报错上下文找不到时**必须把话说清楚**，不能静默返回：紧凑多语句视图里失败子句的
  // sqlId 形如 `xxx-sN`，它没有独立结果容器，直接按 id 取会取空，用户点「✨ AI 修复」
  // 就成了「按了没反应」。先退回整块的结果区，取不到再明说原因和恢复办法。
  if (!resultDiv) resultDiv = document.getElementById(String(sqlId).replace(/-s\d+$/, '') + '-result');
  if (!resultDiv) return;                       // 整块也被重绘掉了：无处可提示，只能放弃
  if (!oldSql || !error) {
    resultDiv.innerHTML = '<div class="aias-sql-result-error">⚠️ 这条语句的报错上下文已失效'
      + '（消息重绘或页面切换过），请重新点「▶ 执行」后再用「✨ AI 修复」。</div>';
    return;
  }

  resultDiv.innerHTML = '<div class="aias-sql-result-loading">⏳ AI 正在分析报错并修复 SQL，请稍候...</div>';

  fetch('/api/chat/fix-sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: oldSql, error: error, datasource_name: dsName, repair: repair })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (!data.ok || !data.fixed_sql) {
      // 修复失败：保留原始数据库报错（重试时仍基于它修复），并展示失败原因
      var fixErr = (data && data.error) || 'AI 修复失败';
      resultDiv.innerHTML = aiasBuildSqlErrorHtml(sqlId, _aiasSqlErrors[sqlId] || '执行失败', true)
        + '<div class="aias-sql-fix-note">⚠️ AI 修复失败：' + escHtml(fixErr) + '</div>';
      return;
    }
    var fixedSql = data.fixed_sql;
    // 1) 更新内存中的 SQL 存储（后续「执行SQL」使用修复后的语句）
    _aiasSqlStore[sqlId] = escHtml(fixedSql);
    delete _aiasSqlErrors[sqlId];
    delete _aiasSqlRepair[sqlId];
    // 2) 覆盖原来显示的 SQL 代码块
    var wrap = resultDiv.closest('.aias-sql-exec-wrap');
    if (wrap) {
      var pre = wrap.previousElementSibling;
      while (pre && pre.tagName !== 'PRE') pre = pre.previousElementSibling;
      if (pre) {
        // 写回 DOM + store，并作废占位符台账/刷新撤销按钮（统一走 aiasSetBlockSql，
        // 与「方言一键改写」共用同一套收尾动作）
        aiasSetBlockSql(pre, fixedSql);
        pre.removeAttribute('data-dialect-checked');   // 修复后允许重新做方言预检
      }
      // 3) 回写会话消息 Markdown（重载页面/切换会话后仍显示修复后的 SQL）
      aiasPersistFixedSql(wrap, oldSql, fixedSql);
    }
    var noteHtml = data.note ? '<div class="aias-sql-fix-note">💡 ' + escHtml(data.note) + '</div>' : '';
    resultDiv.innerHTML = noteHtml
      + '<div class="aias-sql-result-ok">✅ AI 修复完成，SQL 已更新，可重新点击「执行SQL」验证</div>';
  })
  .catch(function(err) {
    // 请求异常：保留原始数据库报错（重试时仍基于它修复），并展示异常原因
    resultDiv.innerHTML = aiasBuildSqlErrorHtml(sqlId, _aiasSqlErrors[sqlId] || '执行失败', true)
      + '<div class="aias-sql-fix-note">⚠️ AI 修复请求失败：' + escHtml(err.message || '网络异常') + '</div>';
  });
}

// 将修复后的 SQL 回写到对应会话消息（替换消息中第 n 处出现的原 SQL），并持久化到 localStorage
function aiasPersistFixedSql(wrap, oldSql, fixedSql) {
  try {
    var msgEl = wrap.closest('.aias-msg');
    if (!msgEl || !oldSql || !fixedSql) return;
    var idx = parseInt(msgEl.getAttribute('data-idx'), 10);
    var sess = aiasCurrentSession();
    if (!sess || isNaN(idx) || !sess.messages[idx]) return;
    // 定位当前执行按钮在消息内的位置序号（DOM 顺序，0 基）
    var btn = wrap.querySelector('.aias-sql-exec-btn');
    var n = 0;
    if (btn) {
      var all = msgEl.querySelectorAll('.aias-sql-exec-btn');
      for (var i = 0; i < all.length; i++) {
        if (all[i] === btn) break;
        n++;
      }
    }
    var msg = sess.messages[idx];
    if (!msg) return;
    // ★ 第一优先：写入指纹覆盖层（这是可靠持久化的根基，不依赖文本逐字匹配）
    aiasSqlOverridePut(msg, oldSql, fixedSql);
    // 文本精确回写：命中才换，未命中保留覆盖层兜底（刷新后仍显示修复后的 SQL）
    var content = msg.content || '';
    if (content.indexOf(oldSql) !== -1) {
      msg.content = replaceNthOccurrence(content, oldSql, fixedSql, n);
      // 理解文本是 content 的前缀；若被替换的片段落在该前缀内，需同步更新
      if (msg.understandingContent && content.indexOf(msg.understandingContent) === 0) {
        var pos = findNthOccurrenceIndex(content, oldSql, n);
        if (pos !== -1 && pos < msg.understandingContent.length) {
          msg.understandingContent = replaceNthOccurrence(msg.understandingContent, oldSql, fixedSql, n);
        }
      }
    }
    // 指纹与 content 两者都依赖 sess.messages 持久化，统一在此保存
    aiasSaveSessions();
  } catch(e) {}
}

// ── SQL 修复持久化的「指纹覆盖层」 ──
// `aiasPersistFixedSql` 靠文本匹配回写 msg.content，但多语句子块/占位符替换后，
// oldSql 在 content 里逐字命中不了而静默失败 → 刷新即丢。这里加一层按**归一化 SQL
// 指纹**索引的覆盖，避开脆弱的逐字匹配，也不依赖自增 sqlId（其随会话重建而不同）。
// 存进 msg.sqlOverrides：{ [normFp(oldSql)]: fixedSql }；渲染/拆分重建时凡能算出
// 同指纹的 SQL 都被覆盖为修复后的值。这样即使 content 回写失败，刷新后对话块
// 仍显示修复后的 SQL，与任务回溯（数据库持久化）保持一致。
function aiasNormSqlFp(s) {
  try {
    s = String(s || '').trim();
    // 只做不改变语义的归一化：统一换行 → 去收尾分号 → 压多空白为单空格。
    // 保留字符串字面量原样（不去内部空格），但 SQL 关键字/结构不受影响。
    return s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n')
            .replace(/\n[ \t]+/g, '\n')
            .replace(/\s+;/g, ';')
            .replace(/[\u000d\u000a]\s*$/g, '')
            .replace(/;\s*$/, '')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\s+/g, ' ');
  } catch (e) { return String(s || '').trim(); }
}

// 读取会话内某条消息的「修复覆盖值」：归一化指纹匹配即返回覆盖后的 SQL（未转义），否则返回 null
function aiasSqlOverrideGet(msg, rawSql) {
  try {
    if (!msg || !msg.sqlOverrides) return null;
    var fp = aiasNormSqlFp(rawSql);
    if (!fp) return null;
    return msg.sqlOverrides[fp] || msg.sqlOverrides['#' + fp] || null;
  } catch (e) { return null; }
}

// 全会话查找：在当前会话的所有消息里按指纹找覆盖值（渲染层没有精确的 msg 引用时用）。
// 找到即返回 {fixedSql, idx}；否则返回 null。
function aiasSqlOverrideFind(rawSql) {
  try {
    var sess = aiasCurrentSession();
    if (!sess) return null;
    var fp = aiasNormSqlFp(rawSql);
    if (!fp) return null;
    for (var i = 0; i < sess.messages.length; i++) {
      var m = sess.messages[i];
      if (!m || !m.sqlOverrides) continue;
      var v = m.sqlOverrides[fp] || m.sqlOverrides['#' + fp];
      if (v) return { fixedSql: v, idx: i };
    }
    return null;
  } catch (e) { return null; }
}

// 写入会话内某条消息的「修复覆盖值」
function aiasSqlOverridePut(msg, rawOldSql, rawFixedSql) {
  try {
    var fp = aiasNormSqlFp(rawOldSql);
    if (!fp || !rawFixedSql) return;
    if (!msg.sqlOverrides) msg.sqlOverrides = {};
    msg.sqlOverrides[fp] = rawFixedSql;
  } catch (e) {}
}

// 在 str 中查找 search 第 n 次出现（0 基）的起始位置，未找到返回 -1
function findNthOccurrenceIndex(str, search, n) {
  if (!str || !search) return -1;
  var pos = -1;
  for (var i = 0; i <= n; i++) {
    pos = str.indexOf(search, pos + 1);
    if (pos === -1) return -1;
  }
  return pos;
}

// 将 str 中第 n 次出现（0 基）的 search 替换为 replace
function replaceNthOccurrence(str, search, replace, n) {
  var pos = findNthOccurrenceIndex(str, search, n);
  if (pos === -1) return str;
  return str.substring(0, pos) + replace + str.substring(pos + search.length);
}

// ── 围栏代码块的渲染：**每个块都要能复制** ──
// 2026-09-16 修正：复制曾经跟"能不能执行"绑死 —— 只要块不是可执行的只读查询，
// 整块就退化成裸 <pre>，连复制按钮都没有（用户截图里的 `ALTER DATABASE ...` 三个方案全中招，
// 只能手动拖选）。三者必须分开判断：
//   · 复制按钮     → 所有围栏代码块都有（纯前端动作，零风险，不该被执行能力绑死）
//   · 撤销替换按钮 → 该块含占位符时才给（没有占位符就无从替换，给了只是占位噪音）
//   · 执行按钮     → 只有"看起来是只读查询"的块才有（写操作绝不在这里执行，见只读保护）
// 类名：所有块都挂 `.aias-code-pre`；可执行的**额外**再挂 `.aias-sql-pre`
// （这样既有的 `pre.aias-sql-pre` 选择器/样式/测试命中集合完全不变）。
function aiasCodeBlockHtml(code, lang) {
  // ★ AI 修复持久化的指纹覆盖：这个块若已被修复过（修复后 SQL 存在会话覆盖层里），
  // 渲染时就显示修复后的版本，而不是 content 里的旧 SQL（content 的逐字回写可能因
  // 多语句/占位符转义而未命中，必须有这一层兜底才不丢修复）。code 此刻已 HTML 转义。
  try {
    var ov = aiasSqlOverrideFind(unescHtml(code));
    if (ov && ov.fixedSql) code = escHtml(ov.fixedSql);
  } catch (e) {}
  var id = 'aias-sql-' + (++_aiasSqlSeq);
  _aiasSqlStore[id] = code;          // 与渲染同格式（已转义），执行/复制时 unescHtml
  var plain = unescHtml(code);       // 判定用未转义文本：`&lt;file_name&gt;` 不是占位符
  var exec = isLikelyReadSql(plain); // 执行按钮：只给"只读查询"（写语句绝不出现执行入口）
  var sqlLike = isLikelySql(plain);  // SQL 块识别：宽口径，供多语句拆分扫描到混合块/写块
  var hasSlots = _AIAS_SLOT_HINT_RE.test(plain);
  var h = '<pre class="aias-code-pre' + (sqlLike ? ' aias-sql-pre' : '') + '" data-sql-id="' + id + '"'
    + (lang ? ' data-lang="' + lang + '"' : '') + '><code>' + code + '</code>';
  if (exec || hasSlots) {
    // 撤销按钮放在复制按钮**前面**（视觉上在它左侧）：同一套幽灵态样式。
    // 语义是"撤销我做的占位符替换"，**不碰语句本身** —— 语句可能已被 AI 修复过（用户明确要求区分）。
    h += '<button class="aias-pre-restore-btn is-idle" data-sql-id="' + id + '" '
      + 'title="撤销占位符替换（当前没有替换记录）" aria-label="撤销占位符替换" '
      + 'onclick="aiasSlotRestoreFromBlock(this)">' + _AIAS_RESTORE_BTN_HTML + '</button>';
  }
  var copyTitle = exec ? '复制 SQL' : '复制代码';
  h += '<button class="aias-pre-copy-btn" title="' + copyTitle + '" aria-label="' + copyTitle + '" '
    + 'onclick="aiasCopySqlPre(this)">' + _AIAS_COPY_BTN_HTML + '</button></pre>';
  if (exec) {
    h += '<div class="aias-sql-exec-wrap">'
      + '<button class="aias-sql-batch-btn" data-sql-id="' + id + '" '
      + 'title="把这条 SQL 批量执行到多个同类库" aria-label="批量执行" '
      + 'onclick="aiasExecuteSqlBatch(\'' + id + '\')">≣ 批量</button>'
      + '<button class="aias-sql-exec-btn" data-sql-id="' + id + '" aria-label="执行 SQL" '
      + 'onclick="aiasExecuteSql(\'' + id + '\')">▶ 执行SQL</button>'
      + '<div class="aias-sql-result" id="' + id + '-result"></div>'
      + '</div>';
  }
  return h;
}

function aiasMarkdownToHtml(md) {
  if (!md) return '';
  // 转义 HTML
  var html = escHtml(md);
  // ★ 代码块与行内代码先「藏起来」，最后一步再放回原位。
  // 下面的行内规则（加粗/斜体/换行转 <br>）是对整段字符串做的，而代码块此刻已经变成
  // <pre> 混在正文里，于是会直接毁掉 SQL：
  //   · `SELECT *` 和 `COUNT(*)` 的两个星号被当成一对斜体标记吃掉 —— 界面上看到的语句
  //     与真正送去执行的语句就不是同一句；
  //   · `\n → <br>` 把代码块内的换行换成 <br>，按 textContent 读回来就没有换行了；
  //     以 `-- 说明` 开头的 SQL 会因此变成「整句都在注释里」，被当成非查询语句拒绝执行。
  // 占位符用 NUL 包序号：正文里不可能出现 NUL，转义后的文本更不会。
  var stashed = [];
  function stash(fragment) {
    stashed.push(fragment);
    return '\u0000' + (stashed.length - 1) + '\u0000';
  }
  // 代码块 ```
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function(m, lang, code) {
    return stash(aiasCodeBlockHtml(code.trim(), lang));
  });
  // 行内代码
  html = html.replace(/`([^`]+)`/g, function(m, code) { return stash('<code>' + code + '</code>'); });
  // 加粗
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 斜体
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // 标题
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // 无序列表
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
  // 有序列表
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // 表格（简易）
  html = html.replace(/^\|(.+)\|$/gm, function(match) {
    var cells = match.split('|').filter(function(c) { return c.trim(); });
    if (cells.every(function(c) { return /^[\-\s:]+$/.test(c); })) return ''; // 分隔行
    return '<tr>' + cells.map(function(c) { return '<td>' + c.trim() + '</td>'; }).join('') + '</tr>';
  });
  html = html.replace(/(<tr>[\s\S]*?<\/tr>)(?!\s*<tr>)/g, '<table>$1</table>');
  // 换行（非块级元素后）
  html = html.replace(/\n/g, '<br>');
  // 修复块级元素换行
  html = html.replace(/<br>(<(?:pre|h[1-3]|ul|ol|table|blockquote))/g, '$1');
  html = html.replace(/(<\/(?:pre|h[1-3]|ul|ol|table|blockquote)>)<br>/g, '$1');
  // 把藏起来的代码块/行内代码放回原位（内容与转义前逐字一致，星号与换行都在）
  html = html.replace(/\u0000(\d+)\u0000/g, function(m, i) { return stashed[Number(i)] || ''; });
  return html;
}

/* ── 答案优先排版（结论卡）────────────────────────────────────
   一条回答分三层：结论（模型原文的首段，一字不改）→ 要点（紧随其后的列表）→ 其余正文；
   思考过程、理解文本与工具链一起折进「怎么得出的」。
   这里只搬运位置，不重写、不补写、也不删内容：verdict + points + rest 的非空行与原文
   逐行一致（verify_aias_answer_layout.js 钉住这条），所以界面与真正执行的内容不会分家。
   拆不出来就不拆（长段落、一上来就是代码块/表格、只有一个列表项）—— 宁可不做结论行，
   也不把半句话当结论。 */
var AIAS_VERDICT_MAX = 400;      // 首段超过这个长度就当正文，不抬成结论行
var AIAS_POINTS_MAX = 4;         // 列表项多于这么多就整段留给正文（不截断列表）
var _AIAS_LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
var _AIAS_STRUCT_RE = /^\s*(?:```|~~~|#{1,6}\s|>|\||-{3,}$|={3,}$)/;

function aiasSplitAnswer(md) {
  var text = String(md || '');
  var lines = text.split('\n');
  var whole = { verdict: '', points: [], rest: text };
  var i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length) return { verdict: '', points: [], rest: '' };
  var first = lines[i];
  // 结构行（标题/列表/引用/表格/分隔线/代码围栏）开头：正文本身就带结构，不抬结论
  if (_AIAS_STRUCT_RE.test(first) || _AIAS_LIST_RE.test(first)) return whole;

  var para = [];
  while (i < lines.length && lines[i].trim() && !_AIAS_STRUCT_RE.test(lines[i]) && !_AIAS_LIST_RE.test(lines[i])) {
    para.push(lines[i]);
    i++;
  }
  var verdict = para.join('\n').trim();
  if (!verdict || verdict.length > AIAS_VERDICT_MAX) return whole;

  // 探测紧随其后的列表：项数不在 2~上限之间就整段留给正文（绝不截断列表，也绝不丢行）
  var k = i;
  while (k < lines.length && !lines[k].trim()) k++;
  var items = [], cur = null, end = i;
  if (k < lines.length && _AIAS_LIST_RE.test(lines[k])) {
    var j = k;
    while (j < lines.length) {
      var ln = lines[j];
      if (_AIAS_LIST_RE.test(ln)) {
        if (cur) items.push(cur);
        cur = [ln];
      } else if (cur && /^\s{2,}\S/.test(ln)) {
        cur.push(ln);                       // 缩进续行属于上一条
      } else if (!ln.trim()) {
        var ahead = j + 1;
        while (ahead < lines.length && !lines[ahead].trim()) ahead++;
        if (ahead === j + 1 && ahead < lines.length && _AIAS_LIST_RE.test(lines[ahead])) { j = ahead; continue; }
        break;                              // 空行后不是列表项：列表到此结束
      } else {
        break;
      }
      j++;
    }
    if (cur) items.push(cur);
    end = j;
    while (end < lines.length && !lines[end].trim()) end++;
  }
  var takePoints = items.length >= 2 && items.length <= AIAS_POINTS_MAX;
  return {
    verdict: verdict,
    points: takePoints ? items.map(function (it) { return it.join('\n'); }) : [],
    rest: lines.slice(takePoints ? end : i).join('\n')
  };
}

/** 从工具链 HTML 里取真实执行信号：步数、报错步数、累计耗时。取不到就不显示，不猜。 */
function aiasEvidenceFromToolChain(html) {
  var text = String(html || '');
  var steps = (text.match(/class="aias-tc-step\s/g) || []).length;
  var errors = (text.match(/class="aias-tc-step\s+error"/g) || []).length;
  var durationMs = 0;
  var re = /⏱\s*([\d.]+)(ms|s)/g, m;
  while ((m = re.exec(text)) !== null) {
    durationMs += parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1);
  }
  return { steps: steps, errors: errors, durationMs: Math.round(durationMs) };
}

/** 证据栏挂在正文容器之前（消息正文的 id 与内部结构不能被挪动，
    结果区、槽位、方言徽标都靠 closest('.aias-msg-text') 定位）。 */
function aiasSetEvidenceBar(msgText, html) {
  var host = msgText && msgText.parentNode;
  if (!host) return;
  for (var i = host.children.length - 1; i >= 0; i--) {
    var kid = host.children[i];
    if (kid !== msgText && kid.classList && kid.classList.contains('aias-evidence')) host.removeChild(kid);
  }
  if (!html) return;
  var holder = document.createElement('div');
  holder.innerHTML = html;
  var bar = holder.firstElementChild;
  if (bar) host.insertBefore(bar, msgText);
}

/** 本条回答实际打了哪些库：优先从工具链参数里取（每条回答自己的事实），
    取不到再退回会话当前选择，并在 tooltip 里说明是会话默认。 */
function aiasEvidenceDatasources(toolChainHtml, sess) {
  var text = String(toolChainHtml || '').replace(/&quot;/g, '"');
  var names = [], seen = {};
  var re = /"datasource_names?"\s*:\s*"([^"]{1,80})"/g, m;
  while ((m = re.exec(text)) !== null) {
    var n = String(m[1] || '').trim();
    if (n && !seen[n]) { seen[n] = true; names.push(n); }
  }
  if (names.length) return names;
  var seen2 = {};
  if (sess && sess.currentDatasource) {
    seen2[sess.currentDatasource] = true;
    names.push(sess.currentDatasource);
  }
  if (sess && Array.isArray(sess.datasources)) {
    sess.datasources.forEach(function (n) {
      n = String(n || '').trim();
      if (n && !seen2[n]) { seen2[n] = true; names.push(n); }
    });
  }
  return names;
}

/** 结论卡顶部那条证据栏：只放取得到的真实信号，缺项直接不渲染。 */
function aiasEvidenceChipsHtml(ev, dsNames) {
  var chips = [];
  var names = (dsNames || []).filter(function (n) { return n && String(n).trim(); });
  if (names.length) {
    var label = escHtml(names[0]) + (names.length > 1 ? ' +' + (names.length - 1) : '');
    chips.push('<span class="aias-chip is-ds" title="' + escHtml(names.join('、')) + '">🛢 <b>' + label + '</b></span>');
  }
  if (ev.steps) {
    chips.push('<span class="aias-chip">' + escHtml(aiasT('webui.aias_ev_runs', '执行')) + ' <b>' + ev.steps + '</b> '
      + escHtml(aiasT('webui.aias_ev_steps_unit', '步')) + '</span>');
  }
  if (ev.durationMs > 0) {
    // 秒级保留两位：1.98s 被约成 2.0s 就看不出这轮到底跑了多久（步数少时误差肉眼可见）
    var dur = ev.durationMs < 1000 ? ev.durationMs + 'ms'
      : (ev.durationMs / 1000).toFixed(ev.durationMs < 10000 ? 2 : 1) + 's';
    chips.push('<span class="aias-chip">' + escHtml(aiasT('webui.aias_ev_took', '耗时')) + ' <b>' + dur + '</b></span>');
  }
  if (ev.errors) {
    chips.push('<span class="aias-chip is-bad">⚠ <b>' + ev.errors + '</b> '
      + escHtml(aiasT('webui.aias_ev_failed', '步报错')) + '</span>');
  }
  chips.push('<span class="aias-chip is-ro">🔒 ' + escHtml(aiasT('webui.aias_ev_readonly', '只读')) + '</span>');
  return '<div class="aias-evidence">' + chips.join('') + '</div>';
}

/** 正文 → 结论行 + 要点 + 其余（全部走同一套 markdown 渲染，加粗/代码/表格不变）。 */
function aiasAnswerHtml(md, isAlert) {
  var p = aiasSplitAnswer(md);
  var html = '';
  if (p.verdict) {
    html += '<div class="aias-verdict' + (isAlert ? ' is-alert' : '') + '">'
      + '<span class="aias-verdict-badge">' + escHtml(aiasT('webui.aias_verdict_label', '结论')) + '</span>'
      + '<div class="aias-verdict-text">' + aiasMarkdownToHtml(p.verdict) + '</div></div>';
  }
  if (p.points.length) {
    html += '<ul class="aias-points">' + p.points.map(function (item) {
      // 列表项自己渲染（去掉行首符号），保留项内加粗、行内代码与续行
      var one = aiasMarkdownToHtml(item.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
      return '<li>' + one + '</li>';
    }).join('') + '</ul>';
  }
  html += aiasMarkdownToHtml(p.rest);
  return html;
}

/** 过程折叠：思考 + 理解 + 工具链，标题给真实数量；正在生成时不折叠（见调用方）。 */
function aiasProofDetailsHtml(innerHtml, ev) {
  if (!innerHtml) return '';
  var label = aiasT('webui.aias_proof_label', '怎么得出的');
  var counts = [];
  if (ev.steps) counts.push(ev.steps + ' ' + aiasT('webui.aias_ev_steps_unit', '步'));
  if (counts.length) label += ' · ' + counts.join(' / ');
  return '<details class="aias-proof"><summary><span class="aias-proof-car">▸</span>'
    + escHtml(label) + '<span class="aias-proof-hint">'
    + escHtml(aiasT('webui.aias_proof_hint', '展开看思考过程与执行记录')) + '</span></summary>'
    + '<div class="aias-proof-body">' + innerHtml + '</div></details>';
}

// ── 发送消息 ──
function aiasSend() {
  var input = document.getElementById('aias-input');
  if (!input) return;
  var message = input.value.trim();
  if (!message || _aias.isGenerating) return;

  input.value = '';
  aiasAutoResize(input);
  aiasSendInternal(message);
}

function aiasQuickSend(message) {
  if (_aias.isGenerating) return;
  aiasSendInternal(message);
}

function aiasSendInternal(message) {
  var sess = aiasCurrentSession();
  if (!sess) {
    aiasNewChat();
    sess = aiasCurrentSession();
  }

  // 添加用户消息
  sess.messages.push({ role: 'user', content: message, timestamp: Date.now() });

  // 如果是第一条消息，用消息内容作为会话标题
  if (sess.messages.length === 1) {
    sess.title = message.substring(0, 30) + (message.length > 30 ? '...' : '');
  }

  aiasSaveSessions();
  aiasRenderSessionList();

  // 添加 AI 占位消息
  var aiMsgIdx = sess.messages.length;
  sess.messages.push({ role: 'ai', content: '', timestamp: Date.now(), streaming: true });
  aiasRenderMessages();

  // 显示 typing 指示器
  var msgText = document.getElementById('aias-msg-text-' + aiMsgIdx);
  if (msgText) {
    msgText.innerHTML = '<div class="aias-typing"><span></span><span></span><span></span></div>';
  }

  // 切换为生成中状态
  aiasSetGenerating(true);
  _aias.userScrolledUp = false;

  // SSE 流式请求
  aiasStreamRequest(message, sess, aiMsgIdx);
}

function aiasStreamRequest(message, sess, aiMsgIdx) {
  _aias.abortController = new AbortController();

  // 构建上下文
  var context = {};
  try {
    context = getChatContext();
  } catch(e) {}

  // ★ 必须显式带上会话的数据源 —— 这是"AI 不知道目标库版本"的根因：
  //   getChatContext() 只在「数据源页 / SQL 编辑器页」才返回 datasource_name，
  //   助手页返回的 context 里没有它 → 后端 chat_context.datasource_name 为空
  //   → 不预取版本 → 提示词里没有「数据源实际版本」那一节
  //   → LLM 只能按"通用/最新"语法编（典型后果：给 Oracle 11g 写 12c 的 FETCH FIRST，
  //     执行就 ORA-00933，用户只能反复点「AI 修复」）。
  var _dsCtx = {};
  try {
    if (sess.currentDatasource) _dsCtx.datasource_name = sess.currentDatasource;
    if (sess.datasources && sess.datasources.length) {
      _dsCtx.datasource_names = sess.datasources.slice(0, 5);   // 多个也让 AI 知道目标是谁
    }
  } catch(e) {}

  // 构建历史消息（发送最近10轮对话）
  var historyMessages = [];
  for (var i = 0; i < sess.messages.length - 1 && historyMessages.length < 20; i++) {
    var m = sess.messages[i];
    if (m.content) {
      historyMessages.push({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content
      });
    }
  }

  fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({
      message: message,
      session_id: sess.id,
      history: historyMessages,
    }, context, _dsCtx)),
    signal: _aias.abortController.signal,
  }).then(function(response) {
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var fullContent = '';          // 纯文本回复内容（无工具时使用）
    var understandingContent = ''; // Phase 1 理解文本（工具调用前的对话）
    var analysisContent = '';      // AI 分析正文（Markdown）
    var analysisStarted = false;   // 是否进入分析阶段
    var hasToolChain = false;      // 是否有工具链路
    var toolReasoning = '';        // 工具选择推理
    var toolSteps = [];            // 工具执行步骤数组
    var toolAnalyzing = false;     // 是否正在分析
    var thinkingContent = '';      // 思考过程原始文本
    var thinkingActive = false;    // 是否正在思考阶段
    var thinkingDone = false;      // 思考已完成

    function processChunk() {
      return reader.read().then(function(result) {
        if (result.done) {
          // 流结束
          sess.messages[aiMsgIdx].streaming = false;
          // 清理最终分析文本中残留的 <query> 取数标签（最后一轮模型仍可能输出）。
          // 成对标签整体移除；未闭合的 <query 只删起始标签本身，
          // 不能 <query[\s\S]*$ 删光其后内容，否则建议多语句 SQL 会被整段截掉。
          analysisContent = String(analysisContent || '').replace(/<query[\s\S]*?<\/query>/gi, '').replace(/<query[^>]*>/gi, '');
          // 统一对话流：如果有工具链路，保存理解文本+分析文本
          if (hasToolChain) {
            sess.messages[aiMsgIdx].content = understandingContent + '\n\n' + analysisContent;
            sess.messages[aiMsgIdx].understandingContent = understandingContent;
          } else {
            sess.messages[aiMsgIdx].content = fullContent;
          }
          if (hasToolChain) {
            sess.messages[aiMsgIdx].toolChainHtml = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
          }
          // 保存思考过程
          if (thinkingDone && thinkingContent) {
            sess.messages[aiMsgIdx].thinkingContent = thinkingContent;
          }
          aiasSaveSessions();
          aiasFinalizeMessage(aiMsgIdx, sess.messages[aiMsgIdx].content);
          aiasSetGenerating(false);
          return;
        }

        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop(); // 保留不完整的行

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line.startsWith('data: ')) continue;
          var dataStr = line.substring(6);
          try {
            var data = JSON.parse(dataStr);
            // ── 思考过程事件 ──
            if (data.type === 'thinking_start') {
              thinkingActive = true;
              thinkingDone = false;
              thinkingContent = '';
              aiasRenderThinking(aiMsgIdx, '', true);
            } else if (data.type === 'thinking') {
              if (data.replace) { thinkingContent = (data.content || ''); } else { thinkingContent += (data.content || ''); }
              aiasRenderThinking(aiMsgIdx, thinkingContent, true);
            } else if (data.type === 'thinking_end') {
              thinkingActive = false;
              thinkingDone = true;
              // 思考完成，默认展开（让用户看到模型思考过程）
              aiasRenderThinking(aiMsgIdx, thinkingContent, false, false);
            } else
            // ── 需要确认事件（AI 不确定，让用户选择）──
            if (data.type === 'need_confirmation') {
              // 保存确认数据到消息对象
              sess.messages[aiMsgIdx].needConfirmation = true;
              sess.messages[aiMsgIdx].confirmQuestion = data.question || '';
              sess.messages[aiMsgIdx].confirmOptions = data.options || [];
              sess.messages[aiMsgIdx].pendingToolCalls = data.pending_tool_calls || [];
              sess.messages[aiMsgIdx].confirmUnderstanding = data.understanding || '';
              aiasSaveSessions();
              
              // 渲染确认选项 UI
              var confirmHtml = aiasBuildConfirmationHtml(data.question, data.options);
              var msgText = document.getElementById('aias-msg-text-' + aiMsgIdx);
              if (msgText) {
                var existingHtml = msgText.innerHTML.replace('<span class="aias-cursor"></span>', '');
                msgText.innerHTML = existingHtml + confirmHtml;
              }
              aiasScrollToBottom(false);
            } else
            // ── 工具调用事件（可视化链路）──
            if (data.type === 'tool_start') {
              hasToolChain = true;
              // 保存理解文本（新架构：意图检测已在前端流式输出，无需过滤标签）
              understandingContent = fullContent.trim();
              toolReasoning = data.reasoning || understandingContent.substring(0, 200) || '根据用户请求调用对应工具';
              toolSteps = [];
              toolAnalyzing = false;
              var tcHtml = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
              var thinkHtmlT0 = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
              aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, thinkHtmlT0 + tcHtml, understandingContent, true);
            } else if (data.type === 'tool_executing') {
              // 添加新步骤（running状态）
              var step = {
                tool: data.tool,
                arguments: data.arguments || {},
                status: 'running',
              };
              toolSteps.push(step);
              // 记录工具参数中的数据源到会话上下文（供 SQL 一键执行引用上文数据源）
              aiasTrackDatasource(data.arguments || {});
              // 分析阶段发起追加查询（round>1）：上一轮分析文本是基于不完整数据的中间内容
              // （可能还含 <query> 标签），清除之，只保留最终一轮分析，
              // 确保最终结论基于完整且有效的数据
              if (data.round && data.round > 1 && analysisStarted) {
                analysisContent = '';
              }
              var tcHtml2 = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
              var thinkHtmlT1 = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
              aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, thinkHtmlT1 + tcHtml2, understandingContent, true);
            } else if (data.type === 'tool_progress') {
              // 模板检查进度：更新当前步骤的进度信息（步骤/章节/SQL标题）
              if (toolSteps.length > 0) {
                var curStep = toolSteps[toolSteps.length - 1];
                curStep.progress = {
                  step: data.step,
                  total: data.total,
                  chapter: data.chapter || '',
                  query_key: data.query_key || '',
                  description: data.description || '',
                  status: data.status || 'running',
                };
                var tcHtmlP = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
                var thinkHtmlP = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
                aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, thinkHtmlP + tcHtmlP, understandingContent, true);
              }
            } else if (data.type === 'tool_result') {
              // 更新最后一个步骤的结果
              if (toolSteps.length > 0) {
                var lastStep = toolSteps[toolSteps.length - 1];
                lastStep.result = data.result;
                lastStep.status = data.status || 'success';
                lastStep.duration_ms = data.duration_ms;
              }
              var tcHtml3 = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
              var thinkHtmlT2 = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
              aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, thinkHtmlT2 + tcHtml3, understandingContent, true);
            } else if (data.type === 'tool_analyzing') {
              toolAnalyzing = true;
              analysisStarted = true;
              var tcHtml4 = aiasBuildToolChainHtml(toolReasoning, toolSteps, true);
              var thinkHtmlT3 = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
              aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, thinkHtmlT3 + tcHtml4, understandingContent, true);
            } else if (data.type === 'token' || data.type === 'chunk') {
              if (analysisStarted) {
                // Phase 3: 分析结果文本
                analysisContent += (data.content || data.token || '');
                var tcHtml5 = toolAnalyzing ? aiasBuildToolChainHtml(toolReasoning, toolSteps, false) : '';
                var thinkHtml5 = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
                aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, thinkHtml5 + tcHtml5, analysisContent, true);
              } else if (hasToolChain) {
                // 工具链路阶段的文本（不应该出现，但兼容处理）
                analysisContent += (data.content || data.token || '');
                var tcHtml6 = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
                var thinkHtml6 = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
                aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, thinkHtml6 + tcHtml6, analysisContent, true);
              } else {
                // Phase 2: 对话回复文本
                var chunkText = (data.content || data.token || '');
                fullContent += chunkText;
                var thinkHtml7 = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
                aiasUpdateMessageWithThinking(aiMsgIdx, thinkHtml7, fullContent, true);
              }
            } else if (data.type === 'done' || data.type === 'end') {
              // 正常结束
            } else if (data.type === 'error') {
              var errMsg = '\n\n⚠️ **错误**: ' + (data.message || 'AI 返回错误');
              if (hasToolChain) {
                analysisContent += errMsg;
                var tcHtml7 = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
                var thinkHtmlErr = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
                aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, thinkHtmlErr + tcHtml7, analysisContent, true);
              } else {
                fullContent += errMsg;
                var thinkHtmlErr2 = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
                aiasUpdateMessageWithThinking(aiMsgIdx, thinkHtmlErr2, fullContent, true);
              }
            } else if (data.type === 'inspect_done') {
              var doneMsg = '\n\n✅ ' + (data.message || '巡检完成');
              var thinkHtmlID = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
              if (hasToolChain) {
                analysisContent += doneMsg;
                var tcHtml11 = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
                aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, thinkHtmlID + tcHtml11, analysisContent, true);
              } else {
                fullContent += doneMsg;
                aiasUpdateMessageWithThinking(aiMsgIdx, thinkHtmlID, fullContent, true);
              }
            } else if (data.type === 'continue_query') {
              // N 轮迭代：需要继续调用工具
              var roundNum = data.round || '?';
              var queryHint = '\n\n💡 **[第 ' + roundNum + ' 轮分析] 继续查询中: ' + (data.reasoning || '正在分析数据...') + '</div>';
              var tcHtmlCQ = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
              aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, tcHtmlCQ + queryHint, analysisContent, true);
            } else if (data.type === 'needs_clarification') {
              // 需要用户补充信息
              var roundNum2 = data.round || '?';
              var clarifyMsg = '❓ **第 ' + roundNum2 + ' 轮：需要澄清**\n\n' + (data.question || '请补充更多信息。');
              var thinkHtmlNQ = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
              if (hasToolChain) {
                analysisContent = clarifyMsg;
                var tcHtmlNQ = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
                aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, thinkHtmlNQ + tcHtmlNQ, analysisContent, true);
              } else {
                fullContent = clarifyMsg;
                aiasUpdateMessageWithThinking(aiMsgIdx, thinkHtmlNQ, fullContent, true);
              }
            } else if (data.type === 'intermediate_analysis') {
              // N 轮迭代：中间分析结果
              var roundNum3 = data.round || '?';
              var analysisMsg = '📊 **[第 ' + roundNum3 + ' 轮分析]**\n\n' + (data.analysis || '');
              var thinkHtmlIA2 = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
              if (hasToolChain) {
                analysisContent += analysisMsg;
                var tcHtmlIA2 = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
                aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, thinkHtmlIA2 + tcHtmlIA2, analysisContent, true);
              } else {
                fullContent += analysisMsg;
                aiasUpdateMessageWithThinking(aiMsgIdx, thinkHtmlIA2, fullContent, true);
              }
            } else if (data.type === 'inspect_result' || data.type === 'inspect_progress') {
              // 巡检结果/进度
              var thinkHtmlIR = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
              if (hasToolChain) {
                analysisContent += (data.message || '') + '\n';
                var tcHtml9 = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
                aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, thinkHtmlIR + tcHtml9, analysisContent, true);
              } else {
                fullContent += (data.message || '') + '\n';
                aiasUpdateMessageWithThinking(aiMsgIdx, thinkHtmlIR, fullContent, true);
              }
            } else if (data.type === 'inspect_ask') {
              // 巡检需要选择数据源
              var askMsg = (data.message || '请选择数据源');
              if (data.candidates && data.candidates.length > 0) {
                askMsg += '\n\n可选数据源：\n';
                data.candidates.forEach(function(c) { askMsg += '- ' + c + '\n'; });
              }
              var thinkHtmlIA = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
              if (hasToolChain) {
                analysisContent = askMsg;
                var tcHtml10 = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
                aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, thinkHtmlIA + tcHtml10, analysisContent, true);
              } else {
                fullContent = askMsg;
                aiasUpdateMessageWithThinking(aiMsgIdx, thinkHtmlIA, fullContent, true);
              }
            } else if (data.type === 'inspect_done') {
              var doneMsg = '\n\n✅ ' + (data.message || '巡检完成');
              var thinkHtmlID = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
              if (hasToolChain) {
                analysisContent += doneMsg;
                var tcHtml11 = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
                aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, thinkHtmlID + tcHtml11, analysisContent, true);
              } else {
                fullContent += doneMsg;
                aiasUpdateMessageWithThinking(aiMsgIdx, thinkHtmlID, fullContent, true);
              }
            } else if (data.message) {
              // 非流式回复（兼容旧接口）
              var thinkHtmlMsg = thinkingDone ? aiasBuildThinkingHtml(thinkingContent, true) : '';
              if (hasToolChain) {
                analysisContent = data.message;
                var tcHtml12 = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
                aiasUpdateMessageWithToolsAndThinking(aiMsgIdx, thinkHtmlMsg + tcHtml12, analysisContent, true);
              } else {
                fullContent = data.message;
                aiasUpdateMessageWithThinking(aiMsgIdx, thinkHtmlMsg, fullContent, true);
              }
            }
          } catch(e) {}
        }

        return processChunk();
      });
    }

    return processChunk();
  }).catch(function(err) {
    if (err.name === 'AbortError') {
      // 用户主动中断
      sess.messages[aiMsgIdx].streaming = false;
      sess.messages[aiMsgIdx].content += '\n\n*[已中断]*';
      sess.messages[aiMsgIdx].interrupted = true;
      aiasSaveSessions();
      var msgEl = document.getElementById('aias-msg-text-' + aiMsgIdx);
      if (msgEl) {
        var sess2 = aiasCurrentSession();
        msgEl.innerHTML = aiasMarkdownToHtml(sess2.messages[aiMsgIdx].content);
        aiasEnhanceResults(msgEl);   // 被中断的回答也要能复制
        aiasValidateSqlBlocks(msgEl);   // 被中断的回答同样要拆多语句块
      }
    } else {
      sess.messages[aiMsgIdx].streaming = false;
      sess.messages[aiMsgIdx].content = '⚠️ **请求失败**: ' + err.message;
      aiasSaveSessions();
      aiasFinalizeMessage(aiMsgIdx, sess.messages[aiMsgIdx].content);
    }
    aiasSetGenerating(false);
  });
}

// ── 流式渲染节流：requestAnimationFrame 对齐浏览器绘制周期，减少重排抖动 ──
function aiasScheduleRender(fn) {
  _aias.renderPending = fn;
  if (_aias.renderRafId) return;  // 已有 rAF 在等，合并即可
  _aias.renderRafId = requestAnimationFrame(aiasRenderFrame);
}

// rAF 回调：检查最小间隔，满足则执行渲染
function aiasRenderFrame(timestamp) {
  _aias.renderRafId = null;
  if (!_aias.renderPending) return;
  var elapsed = timestamp - _aias.renderLastTime;
  if (elapsed < _aias.renderMinInterval) {
    // 间隔不足，排入下一帧
    _aias.renderRafId = requestAnimationFrame(aiasRenderFrame);
    return;
  }
  var f = _aias.renderPending;
  _aias.renderPending = null;
  _aias.renderLastTime = timestamp;
  f();
}

// 强制立即渲染（用于流结束时的最终渲染）
function aiasFlushRender() {
  if (_aias.renderRafId) {
    cancelAnimationFrame(_aias.renderRafId);
    _aias.renderRafId = null;
  }
  if (_aias.renderPending) {
    var f = _aias.renderPending;
    _aias.renderPending = null;
    f();
  }
}

// ── 滚动处理：用户在底部时跟随，用户上滚时保持位置 ──
function aiasHandleScroll() {
  var msgArea = document.getElementById('aias-messages');
  if (!msgArea) return;
  if (!_aias.userScrolledUp) {
    // 用户在底部，跟随新内容
    msgArea.scrollTop = msgArea.scrollHeight;
  } else {
    // 用户在查看上方内容，不跳动，只提示有新内容
    aiasShowScrollPrompt();
  }
}

// ── 智能滚动渲染：innerHTML 替换前后保存/恢复滚动位置，消除视觉跳动 ──
function aiasSmartRender(msgArea, renderFn) {
  if (!msgArea) { renderFn(); return; }
  // 保存滚动状态（在 DOM 更新前）
  var savedScrollTop = msgArea.scrollTop;
  var savedScrollHeight = msgArea.scrollHeight;
  // 渲染前判断用户是否在底部（容差 30px）——以此为准，避免 userScrolledUp 被误置
  var wasAtBottom = (savedScrollHeight - savedScrollTop - msgArea.clientHeight) < 30;
  // 执行 DOM 更新
  renderFn();
  if (_aias.userScrolledUp && !wasAtBottom) {
    // 用户确实在查看上方内容 — 保持位置不变，新内容在下方不影响视图
    msgArea.scrollTop = savedScrollTop;
    // 有新内容增加时显示"有新内容"提示
    if (msgArea.scrollHeight > savedScrollHeight + 4) {
      aiasShowScrollPrompt();
    }
  } else {
    // 用户在底部（或状态被误置）— 跟随新内容。
    // 防抖：只有内容确实增到“需要下滚”才滚，且单调只增不减；
    // 否则整条 innerHTML 重建时 scrollHeight 会瞬时回落，机械地把
    // scrollTop 赋给变小的值再追回来，就会一帧一抖。
    if (msgArea.scrollHeight > savedScrollHeight + 2) {
      msgArea.scrollTop = msgArea.scrollHeight;
    }
    _aias.userScrolledUp = false;
  }
}

// ── 构建思考过程 HTML ──
function aiasBuildThinkingHtml(content, collapsed, done) {
  var escaped = escHtml(content || '');
  var isDone = (done !== undefined) ? done : collapsed;
  // 思考完成后默认展开（让用户看到模型的思考过程），仅当显式指定 collapsed 和 done 时才可能折叠
  var isCollapsed = (done !== undefined && collapsed) ? ' collapsed' : '';
  var headerIcon = isDone
    ? '<span class="aias-thinking-done-icon">✅</span>'
    : '🧠';
  var headerText = isDone ? '深度思考（已完成）' : '深度思考中...';
  var html = '<div class="aias-thinking' + isCollapsed + '">';
  html += '<div class="aias-thinking-header" onclick="aiasToggleThinking(this)">';
  html += '<span class="aias-thinking-icon">' + headerIcon + '</span>';
  html += '<span class="aias-thinking-text">' + headerText + '</span>';
  html += '<span class="aias-thinking-toggle">▼</span>';
  html += '</div>';
  html += '<div class="aias-thinking-body">' + escaped + '</div>';
  html += '</div>';
  return html;
}

// ── 切换思考过程折叠/展开 ──
function aiasToggleThinking(el) {
  var thinking = el ? el.closest('.aias-thinking') : null;
  if (thinking) thinking.classList.toggle('collapsed');
}

// ── 渲染思考过程（流式） ──
function aiasRenderThinking(idx, content, active, autoCollapse) {
  aiasScheduleRender(function() {
    var msgText = document.getElementById('aias-msg-text-' + idx);
    if (!msgText) return;
    // ★ 用户上滚查看前文时跳过流式重建：否则每次收到内容都把整条 innerHTML
    // 重建（底下的消息不断增高 → 布局/绘制持续变化 → 前文视角闪动，且抹掉已展开的折叠）。
    // 内容已同步到内存，最终渲染或滚回底部后再落一次到 DOM 即可。
    if (_aias.userScrolledUp && active) return;
    var msgArea = document.getElementById('aias-messages');
    aiasSmartRender(msgArea, function() {
      // active=true: 思考中，展开显示
      // active=false && autoCollapse=false: 思考完成，保持展开（让用户看到完整思考过程）
      // active=false && autoCollapse=true: 思考完成，自动折叠
      var collapsed = !active && (autoCollapse !== false);
      var done = !active;
      // 查找已有的思考区块（通过 DOM 查询，避免字符串匹配错误）
      var existingThink = msgText.querySelector('.aias-thinking');
      if (existingThink) {
        // 原地更新（不能 outerHTML 重建：重建会让内部滚动条复位到顶部，
        // 导致深度思考流式输出时用户无法滚动定位到指定位置查看）
        aiasUpdateThinkingInPlace(existingThink, content, done, collapsed);
      } else {
        // 首次创建：插入到最前面，保留已有的 cursor 和内容
        msgText.insertAdjacentHTML('afterbegin', aiasBuildThinkingHtml(content, collapsed, done));
      }
    });
  });
}

// 思考区块原地更新：只改文本与头部状态，内部滚动条保持"底部跟随 / 上滚定位"
// - 用户在思考正文底部 → 内容增长后自动跟随到最新思考
// - 用户上滚到指定位置 → 保持 scrollTop 不动，可以稳定地定位查看某段思考
function aiasUpdateThinkingInPlace(thinkEl, content, done, collapseOnDone) {
  var body = thinkEl.querySelector('.aias-thinking-body');
  if (!body) return;
  // 更新文本前先判断用户是否在思考正文底部（容差 20px）
  var wasAtBottom = (body.scrollHeight - body.scrollTop - body.clientHeight) < 20;
  body.textContent = content || '';
  // 思考完成且需要自动折叠时应用折叠（与原重建行为保持一致）
  if (done && collapseOnDone) {
    thinkEl.classList.add('collapsed');
  }
  // 用户之前跟随在底部 → 内容增长后保持贴底；上滚查看时不动 scrollTop
  if (wasAtBottom && !thinkEl.classList.contains('collapsed')) {
    body.scrollTop = body.scrollHeight;
  }
  // 更新头部状态（思考中 → 已完成，单向转换）
  if (done) {
    var iconEl = thinkEl.querySelector('.aias-thinking-icon');
    var textEl = thinkEl.querySelector('.aias-thinking-text');
    if (iconEl && !iconEl.querySelector('.aias-thinking-done-icon')) {
      iconEl.innerHTML = '<span class="aias-thinking-done-icon">✅</span>';
    }
    if (textEl && textEl.textContent !== '深度思考（已完成）') {
      textEl.textContent = '深度思考（已完成）';
    }
  }
}

// 快照思考块的用户视图状态（必须在重建前调用：节点脱离 DOM 后 scrollTop 读出来是 0）
function aiasSnapshotThinkingView(msgText) {
  var think = msgText ? msgText.querySelector('.aias-thinking') : null;
  if (!think || think.classList.contains('collapsed')) return null;
  var body = think.querySelector('.aias-thinking-body');
  return { scrollTop: body ? body.scrollTop : 0 };
}

// 重建后恢复思考块视图状态（保留用户手动展开的状态与滚动位置）
function aiasApplyThinkingView(msgText, snap) {
  if (!snap) return;
  var think = msgText.querySelector('.aias-thinking');
  if (!think) return;
  think.classList.remove('collapsed');
  var body = think.querySelector('.aias-thinking-body');
  if (body) body.scrollTop = snap.scrollTop;
}

// ── 更新消息内容（含思考过程，流式，rAF节流 + 智能滚动）──
function aiasUpdateMessageWithThinking(idx, thinkingHtml, content, streaming) {
  aiasScheduleRender(function() {
    var msgText = document.getElementById('aias-msg-text-' + idx);
    if (!msgText) return;
    // ★ 用户上滚查看前文时跳过流式重建：否则每次收到内容都把整条 innerHTML
    // 重建（底下的消息不断增高 → 布局/绘制持续变化 → 前文视角闪动，且抹掉已展开的折叠）。
    // 内容已同步到内存，最终渲染或滚回底部后再落一次到 DOM 即可。
    if (streaming && _aias.userScrolledUp) return;
    var msgArea = document.getElementById('aias-messages');
    aiasSmartRender(msgArea, function() {
      var html = (thinkingHtml || '') + aiasMarkdownToHtml(content);
      if (streaming) {
        html += '<span class="aias-cursor"></span>';
      }
      // 整体重建消息前保留用户对思考块的展开/滚动状态
      var thinkSnap = aiasSnapshotThinkingView(msgText);
      msgText.innerHTML = html;
      aiasApplyThinkingView(msgText, thinkSnap);
      if (!streaming) aiasEnhanceResults(msgText);
    });
  });
}

// ── 更新消息内容（含思考过程 + 工具链路，流式，rAF节流 + 智能滚动）──
function aiasUpdateMessageWithToolsAndThinking(idx, combinedHtml, analysisMd, streaming) {
  aiasScheduleRender(function() {
    var msgText = document.getElementById('aias-msg-text-' + idx);
    if (!msgText) return;
    // ★ 用户上滚查看前文时跳过流式重建：否则每次收到内容都把整条 innerHTML
    // 重建（底下的消息不断增高 → 布局/绘制持续变化 → 前文视角闪动，且抹掉已展开的折叠）。
    // 内容已同步到内存，最终渲染或滚回底部后再落一次到 DOM 即可。
    if (streaming && _aias.userScrolledUp) return;
    var msgArea = document.getElementById('aias-messages');
    aiasSmartRender(msgArea, function() {
      var html = (combinedHtml || '') + aiasMarkdownToHtml(analysisMd || '');
      if (streaming) {
        html += '<span class="aias-cursor"></span>';
      }
      // 整体重建消息前保留用户对思考块的展开/滚动状态
      var thinkSnap = aiasSnapshotThinkingView(msgText);
      msgText.innerHTML = html;
      aiasApplyThinkingView(msgText, thinkSnap);
      if (!streaming) aiasEnhanceResults(msgText);
    });
  });
}

// ── 更新消息内容（流式，rAF节流 + 智能滚动） ──
function aiasUpdateMessage(idx, content, streaming) {
  aiasScheduleRender(function() {
    var msgText = document.getElementById('aias-msg-text-' + idx);
    if (!msgText) return;
    // ★ 用户上滚查看前文时跳过流式重建：否则每次收到内容都把整条 innerHTML
    // 重建（底下的消息不断增高 → 布局/绘制持续变化 → 前文视角闪动，且抹掉已展开的折叠）。
    // 内容已同步到内存，最终渲染或滚回底部后再落一次到 DOM 即可。
    if (streaming && _aias.userScrolledUp) return;
    var msgArea = document.getElementById('aias-messages');
    aiasSmartRender(msgArea, function() {
      var html = aiasMarkdownToHtml(content);
      if (streaming) {
        html += '<span class="aias-cursor"></span>';
      }
      msgText.innerHTML = html;
      // 渲染完成后用后端 sqlparse 引擎校验 SQL 代码块
      if (!streaming) aiasValidateSqlBlocks(msgText);
      if (!streaming) aiasEnhanceResults(msgText);      // 非流式渲染 → 补结果操作条
    });
  });
}

// ── 工具链路可视化：更新消息（支持工具链HTML + 分析Markdown，rAF节流 + 智能滚动）──
function aiasUpdateMessageWithTools(idx, toolChainHtml, analysisMd, streaming) {
  aiasScheduleRender(function() {
    var msgText = document.getElementById('aias-msg-text-' + idx);
    if (!msgText) return;
    // ★ 用户上滚查看前文时跳过流式重建：否则每次收到内容都把整条 innerHTML
    // 重建（底下的消息不断增高 → 布局/绘制持续变化 → 前文视角闪动，且抹掉已展开的折叠）。
    // 内容已同步到内存，最终渲染或滚回底部后再落一次到 DOM 即可。
    if (streaming && _aias.userScrolledUp) return;
    var msgArea = document.getElementById('aias-messages');
    aiasSmartRender(msgArea, function() {
      var html = (toolChainHtml || '') + aiasMarkdownToHtml(analysisMd || '');
      if (streaming) {
        html += '<span class="aias-cursor"></span>';
      }
      msgText.innerHTML = html;
      // 渲染完成后用后端 sqlparse 引擎校验 SQL 代码块
      if (!streaming) aiasValidateSqlBlocks(msgText);
      if (!streaming) aiasEnhanceResults(msgText);      // 非流式渲染 → 补结果操作条
    });
  });
}

// ── 构建工具链路可视化 HTML ──
function aiasBuildToolChainHtml(reasoning, steps, analyzing) {
  var html = '<div class="aias-tool-chain">';
  // 头部
  html += '<div class="aias-tc-header">';
  // 阶段进度指示（WorkBuddy 风格）
  var stageIcon = analyzing ? '📊' : (steps && steps.length ? '🔧' : '🧠');
  var stageText = analyzing ? '分析结果中' : (steps && steps.length ? '查询执行' : '准备查询');
  html += '<span class="aias-tc-icon">' + stageIcon + '</span>';
  html += '<span>' + stageText + '</span>';
  if (steps && steps.length > 0) {
    html += '<span class="aias-tc-count">' + steps.length + ' 步</span>';
  }
  html += '</div>';
  // 推理
  if (reasoning) {
    html += '<div class="aias-tc-reasoning">' + escHtml(reasoning) + '</div>';
  }
  // 步骤
  if (steps && steps.length > 0) {
    html += '<div class="aias-tc-steps">';
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      var statusClass = s.status || 'pending';
      var badgeText = statusClass === 'running' ? '执行中' : statusClass === 'success' ? '✓ 完成' : statusClass === 'error' ? '✗ 错误' : '等待中';
      html += '<div class="aias-tc-step ' + statusClass + '">';
      html += '<div class="aias-tc-step-num">' + (i + 1) + '</div>';
      html += '<div class="aias-tc-step-body">';
      html += '<div class="aias-tc-step-head">';
      html += '<span class="aias-tc-step-name">' + escHtml(s.tool || '') + '</span>';
      html += '<span class="aias-tc-step-badge ' + statusClass + '">' + badgeText + '</span>';
      if (s.duration_ms !== undefined && s.duration_ms !== null) {
        var durStr = s.duration_ms < 1000 ? s.duration_ms + 'ms' : (s.duration_ms / 1000).toFixed(1) + 's';
        html += '<span class="aias-tc-step-duration">⏱ ' + durStr + '</span>';
      }
      html += '</div>';
      // 模板检查进度（run_template_check）：显示当前步骤/章节/SQL标题
      if (s.progress) {
        var p = s.progress;
        var pIcon = p.status === 'success' ? '✅' : p.status === 'error' ? '❌' : p.status === 'skipped' ? '⏭️' : '⏳';
        var pPct = p.total ? Math.max(0, Math.min(100, Math.round((p.step / p.total) * 100))) : 0;
        html += '<div class="aias-tc-progress">';
        if (p.total) {
          html += '<div class="aias-tc-progress-bar"><div class="aias-tc-progress-fill" style="width:' + pPct + '%"></div></div>';
        }
        html += '<div class="aias-tc-progress-text">' + pIcon;
        if (p.total) html += ' 第 ' + p.step + '/' + p.total + ' 步';
        if (p.chapter) html += ' · <span class="aias-tc-progress-chapter">' + escHtml(p.chapter) + '</span>';
        if (p.description) {
          // 多行日志：逐行显示（巡检任务进度）
          var descLines = String(p.description).split('\n');
          html += '<div class="aias-tc-progress-desc">';
          for (var di = 0; di < descLines.length; di++) {
            html += '<div>' + escHtml(descLines[di]) + '</div>';
          }
          html += '</div>';
        }
        html += '</div>';
        html += '</div>';
      }
      // 参数（完整显示，默认折叠）
      if (s.arguments && Object.keys(s.arguments).length > 0) {
        // SQL 单独高亮显示（execute_sql 工具）
        if (s.arguments.sql) {
          html += '<div class="aias-tc-sql">' + escHtml(s.arguments.sql)
            + '<button class="aias-tc-copy-btn" title="复制 SQL" aria-label="复制 SQL" onclick="aiasCopySqlEl(this)">' + _AIAS_COPY_BTN_HTML + '</button>'
            + '</div>';
          var otherArgs = {};
          Object.keys(s.arguments).forEach(function(k){ if(k!=='sql') otherArgs[k]=s.arguments[k]; });
          if (Object.keys(otherArgs).length > 0) {
            var argStrOA = '';
            try { argStrOA = JSON.stringify(otherArgs, null, 2); } catch(e) { argStrOA = JSON.stringify(otherArgs); }
            html += '<details class="aias-tc-step-args"><summary>📋 其他参数</summary><div class="aias-pre-host"><pre><code>' + escHtml(argStrOA) + '</code></pre>'
              + '<button class="aias-tc-copy-btn" title="复制参数" aria-label="复制参数" onclick="aiasCopyPreBox(this)">' + _AIAS_COPY_BTN_HTML + '</button></div></details>';
          }
        } else {
          var argStr = '';
          try {
            argStr = JSON.stringify(s.arguments, null, 2);
          } catch(e) {
            argStr = JSON.stringify(s.arguments);
          }
          html += '<details class="aias-tc-step-args">';
          html += '<summary>📋 参数</summary>';
          html += '<div class="aias-pre-host"><pre><code>' + escHtml(argStr) + '</code></pre>'
            + '<button class="aias-tc-copy-btn" title="复制参数" aria-label="复制参数" onclick="aiasCopyPreBox(this)">' + _AIAS_COPY_BTN_HTML + '</button></div>';
          html += '</details>';
        }
      }
      // 结果（可折叠）
      if (s.result !== undefined && s.result !== null) {
        var resultStr = '';
        try {
          resultStr = JSON.stringify(s.result, null, 2);
        } catch(e) {
          resultStr = String(s.result || '');
        }
        if (resultStr.length > 2000) resultStr = resultStr.substring(0, 2000) + '\n... (截断)';
        var resultIcon = s.status === 'error' ? '✗' : '✓';
        html += '<details class="aias-tc-step-result">';
        html += '<summary>' + resultIcon + ' 执行结果</summary>';
        // 结果框也提供复制（此前只有 SQL 框有 → 用户明确要求"不仅是查询语句的框"）
        html += '<div class="aias-pre-host"><pre><code>' + escHtml(resultStr) + '</code></pre>'
          + '<button class="aias-tc-copy-btn" title="复制执行结果" aria-label="复制执行结果" onclick="aiasCopyPreBox(this)">' + _AIAS_COPY_BTN_HTML + '</button>'
          + '</div>';
        html += '</details>';
      }
      // 巡检任务跟踪链接
      if (s.result && typeof s.result === 'object' && s.result.type === 'inspection_started' && s.result.task_id) {
        html += '<div class="aias-tc-task-link">';
        html += '<button class="aias-task-track-btn" onclick="aiasTrackInspection(\'' + escHtml(s.result.task_id) + '\')">📊 查看巡检进度</button>';
        html += '</div>';
      }
      html += '</div>'; // body
      html += '</div>'; // step
    }
    html += '</div>'; // steps
  }
  // 分析中提示
  if (analyzing) {
    html += '<div class="aias-tc-analyzing">';
    html += '<span class="aias-tc-spin"></span>';
    html += '<span>🤖 AI 正在分析结果...</span>';
    html += '</div>';
  }
  html += '</div>'; // tool-chain
  return html;
}

// ── 构建确认选项 HTML ──
function aiasBuildConfirmationHtml(question, options) {
  var html = '<div class="aias-confirm-card">';
  html += '<div class="aias-confirm-header">';
  html += '<span class="aias-confirm-icon">❓</span>';
  html += '<span class="aias-confirm-title">' + escHtml(question || '请确认') + '</span>';
  html += '</div>';
  html += '<div class="aias-confirm-options">';
  if (options && options.length > 0) {
    for (var i = 0; i < options.length; i++) {
      var opt = options[i];
      html += '<button class="aias-confirm-btn" onclick="aiasConfirmChoice(' + i + ')" data-idx="' + i + '">';
      html += '<span class="aias-confirm-btn-icon">🔘</span>';
      html += '<span class="aias-confirm-btn-text">' + escHtml(opt.label || opt.value || '') + '</span>';
      html += '</button>';
    }
  }
  html += '</div>';
  html += '<div class="aias-confirm-hint">点击选项确认后继续执行</div>';
  html += '</div>';
  return html;
}

// ── 用户点击确认选项 ──
function aiasConfirmChoice(optionIdx) {
  var sess = aiasCurrentSession();
  if (!sess || sess.messages.length === 0) return;
  
  // 找到最后一条带 needConfirmation 的 AI 消息
  var aiMsgIdx = -1;
  for (var i = sess.messages.length - 1; i >= 0; i--) {
    if (sess.messages[i].needConfirmation) {
      aiMsgIdx = i;
      break;
    }
  }
  if (aiMsgIdx < 0) return;
  
  var msg = sess.messages[aiMsgIdx];
  var options = msg.confirmOptions || [];
  var pendingToolCalls = msg.pendingToolCalls || [];
  var understanding = msg.confirmUnderstanding || '';
  
  if (optionIdx < 0 || optionIdx >= options.length) return;
  var selectedOpt = options[optionIdx];
  
  // 将用户选择应用到工具调用参数
  var confirmedToolCalls = JSON.parse(JSON.stringify(pendingToolCalls));
  for (var j = 0; j < confirmedToolCalls.length; j++) {
    var tc = confirmedToolCalls[j];
    if (selectedOpt.action === 'set_datasource' && tc.arguments) {
      tc.arguments.datasource_name = selectedOpt.datasource_name || selectedOpt.value;
    }
    if (selectedOpt.action === 'select_template' && tc.arguments) {
      tc.arguments.template_id = selectedOpt.template_id || selectedOpt.value;
    }
  }
  // 记录用户选择的数据源到会话上下文（供 SQL 一键执行引用上文数据源）
  if (selectedOpt.action === 'set_datasource') {
    aiasTrackDatasource({ datasource_name: selectedOpt.datasource_name || selectedOpt.value });
  }
  
  // 标记确认已完成，更新消息显示
  msg.needConfirmation = false;
  msg.content += '\n\n✅ **已确认选择：' + (selectedOpt.label || selectedOpt.value) + '**';
  aiasSaveSessions();
  aiasRenderMessages();
  
  // 发送带确认参数的新请求
  var context = {};
  try { context = getChatContext(); } catch(e) {}
  
  // 获取原始用户消息
  var userMsg = '';
  for (var k = aiMsgIdx - 1; k >= 0; k--) {
    if (sess.messages[k].role === 'user') {
      userMsg = sess.messages[k].content;
      break;
    }
  }
  if (!userMsg) userMsg = '用户确认执行';
  
  // 添加新的 AI 占位消息
  var newAiIdx = sess.messages.length;
  sess.messages.push({ role: 'ai', content: '', timestamp: Date.now(), streaming: true });
  aiasSaveSessions();
  aiasRenderMessages();
  
  var msgText = document.getElementById('aias-msg-text-' + newAiIdx);
  if (msgText) {
    msgText.innerHTML = '<div class="aias-typing"><span></span><span></span><span></span></div>';
  }
  
  aiasSetGenerating(true);
  _aias.userScrolledUp = false;
  
  // 发送确认请求
  _aias.abortController = new AbortController();
  fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({
      message: userMsg,
      session_id: sess.id,
      confirmed_tool_calls: confirmedToolCalls,
      understanding: understanding,
      selected_action: selectedOpt.action || '',
    }, context)),
    signal: _aias.abortController.signal,
  }).then(function(response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var fullContent = '';
    var understandingContent = '';
    var analysisContent = '';
    var analysisStarted = false;
    var hasToolChain = false;
    var toolReasoning = '';
    var toolSteps = [];
    var toolAnalyzing = false;
    
    function processChunk() {
      return reader.read().then(function(result) {
        if (result.done) {
          sess.messages[newAiIdx].streaming = false;
          // 清理最终分析文本中残留的 <query> 取数标签（最后一轮模型仍可能输出）。
          // 成对标签整体移除；未闭合的 <query 只删起始标签本身，
          // 不能 <query[\s\S]*$ 删光其后内容，否则建议多语句 SQL 会被整段截掉。
          analysisContent = String(analysisContent || '').replace(/<query[\s\S]*?<\/query>/gi, '').replace(/<query[^>]*>/gi, '');
          if (hasToolChain) {
            sess.messages[newAiIdx].content = understandingContent + '\n\n' + analysisContent;
            sess.messages[newAiIdx].understandingContent = understandingContent;
            sess.messages[newAiIdx].toolChainHtml = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
          } else {
            sess.messages[newAiIdx].content = fullContent;
          }
          aiasSaveSessions();
          aiasFinalizeMessage(newAiIdx, sess.messages[newAiIdx].content);
          aiasSetGenerating(false);
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line.startsWith('data: ')) continue;
          var dataStr = line.substring(6);
          try {
            var data = JSON.parse(dataStr);
            if (data.type === 'need_confirmation') {
              // 保存确认数据到消息对象（确认流程中的二次确认，如巡检方式/确认执行）
              sess.messages[newAiIdx].needConfirmation = true;
              sess.messages[newAiIdx].confirmQuestion = data.question || '';
              sess.messages[newAiIdx].confirmOptions = data.options || [];
              sess.messages[newAiIdx].pendingToolCalls = data.pending_tool_calls || [];
              sess.messages[newAiIdx].confirmUnderstanding = data.understanding || '';
              aiasSaveSessions();
              // 渲染确认选项 UI
              var confirmHtml2 = aiasBuildConfirmationHtml(data.question, data.options);
              var msgText2 = document.getElementById('aias-msg-text-' + newAiIdx);
              if (msgText2) {
                var existingHtml2 = msgText2.innerHTML.replace('<span class="aias-cursor"></span>', '');
                msgText2.innerHTML = existingHtml2 + confirmHtml2;
              }
              aiasScrollToBottom(false);
            } else if (data.type === 'tool_start') {
              hasToolChain = true;
              understandingContent = fullContent.trim();
              toolReasoning = data.reasoning || understandingContent.substring(0, 200) || '根据用户请求调用对应工具';
              toolSteps = [];
              toolAnalyzing = false;
              var tcHtml = aiasBuildToolChainHtml(toolReasoning, toolSteps, false);
              aiasUpdateMessageWithTools(newAiIdx, tcHtml, understandingContent, true);
            } else if (data.type === 'tool_executing') {
              toolSteps.push({ tool: data.tool, arguments: data.arguments || {}, status: 'running' });
              // 记录工具参数中的数据源到会话上下文（供 SQL 一键执行引用上文数据源）
              aiasTrackDatasource(data.arguments || {});
              // 分析阶段发起追加查询（round>1）：清除上一轮中间分析文本，只保留最终一轮
              if (data.round && data.round > 1 && analysisStarted) {
                analysisContent = '';
              }
              aiasUpdateMessageWithTools(newAiIdx, aiasBuildToolChainHtml(toolReasoning, toolSteps, false), understandingContent, true);
            } else if (data.type === 'tool_progress') {
              // 模板检查进度：更新当前步骤的进度信息（步骤/章节/SQL标题）
              if (toolSteps.length > 0) {
                var curStepP = toolSteps[toolSteps.length - 1];
                curStepP.progress = {
                  step: data.step,
                  total: data.total,
                  chapter: data.chapter || '',
                  query_key: data.query_key || '',
                  description: data.description || '',
                  status: data.status || 'running',
                };
                aiasUpdateMessageWithTools(newAiIdx, aiasBuildToolChainHtml(toolReasoning, toolSteps, false), understandingContent, true);
              }
            } else if (data.type === 'tool_result') {
              if (toolSteps.length > 0) {
                var lastStep = toolSteps[toolSteps.length - 1];
                lastStep.result = data.result;
                lastStep.status = data.status || 'success';
                lastStep.duration_ms = data.duration_ms;
              }
              aiasUpdateMessageWithTools(newAiIdx, aiasBuildToolChainHtml(toolReasoning, toolSteps, false), understandingContent, true);
            } else if (data.type === 'tool_analyzing') {
              toolAnalyzing = true;
              analysisStarted = true;
              aiasUpdateMessageWithTools(newAiIdx, aiasBuildToolChainHtml(toolReasoning, toolSteps, true), understandingContent, true);
            } else if (data.type === 'token' || data.type === 'chunk') {
              if (analysisStarted) {
                analysisContent += (data.content || data.token || '');
                aiasUpdateMessageWithTools(newAiIdx, toolAnalyzing ? aiasBuildToolChainHtml(toolReasoning, toolSteps, false) : '', analysisContent, true);
              } else if (hasToolChain) {
                analysisContent += (data.content || data.token || '');
                aiasUpdateMessageWithTools(newAiIdx, aiasBuildToolChainHtml(toolReasoning, toolSteps, false), analysisContent, true);
              } else {
                fullContent += (data.content || data.token || '');
                aiasUpdateMessage(newAiIdx, fullContent, true);
              }
            } else if (data.type === 'done' || data.type === 'end') {
              // 正常结束
            } else if (data.type === 'error') {
              var errMsg = '\n\n⚠️ **错误**: ' + (data.message || 'AI 返回错误');
              if (hasToolChain) {
                analysisContent += errMsg;
                aiasUpdateMessageWithTools(newAiIdx, aiasBuildToolChainHtml(toolReasoning, toolSteps, false), analysisContent, true);
              } else {
                fullContent += errMsg;
                aiasUpdateMessage(newAiIdx, fullContent, true);
              }
            }
          } catch(e) {}
        }
        return processChunk();
      });
    }
    return processChunk();
  }).catch(function(err) {
    if (err.name === 'AbortError') {
      sess.messages[newAiIdx].streaming = false;
      sess.messages[newAiIdx].content += '\n\n*[已中断]*';
      aiasSaveSessions();
      aiasRenderMessages();
      aiasSetGenerating(false);
    } else {
      var msgText = document.getElementById('aias-msg-text-' + newAiIdx);
      if (msgText) {
        msgText.innerHTML = '<div class="aias-error-msg">⚠️ 请求失败: ' + escHtml(err.message) + '</div>';
      }
      aiasSetGenerating(false);
    }
  });
}

function aiasFinalizeMessage(idx, content) {
  // 强制刷新节流队列中待执行的渲染，避免最终渲染被延迟
  aiasFlushRender();
  var msgText = document.getElementById('aias-msg-text-' + idx);
  var msgArea = document.getElementById('aias-messages');
  if (msgText) {
    var sess = aiasCurrentSession();
    var msg = (sess && sess.messages[idx]) ? sess.messages[idx] : {};
    var toolChainHtml = msg.toolChainHtml || '';
    var understandingContent = msg.understandingContent || '';
    
    // 思考过程：本轮生成时是实时展开的，落定后归入「怎么得出的」
    var thinkingHtml = '';
    if (msg.thinkingContent) {
      thinkingHtml = aiasBuildThinkingHtml(msg.thinkingContent, true, true);
    }

    // 渲染顺序：证据栏 → 过程（折叠）→ 结论卡 → 其余正文
    var understandingHtml = understandingContent ? aiasMarkdownToHtml(understandingContent) : '';
    // content 包含 understandingContent + analysisContent，需要分离
    var analysisMd = content;
    if (understandingContent && content.startsWith(understandingContent)) {
      analysisMd = content.substring(understandingContent.length).replace(/^\n+/, '');
    }

    // 确认卡片（如果需要确认）
    var confirmHtml = '';
    if (msg.needConfirmation && msg.confirmOptions) {
      confirmHtml = aiasBuildConfirmationHtml(msg.confirmQuestion, msg.confirmOptions);
    }

    var ev = aiasEvidenceFromToolChain(toolChainHtml);
    var proofHtml = aiasProofDetailsHtml(thinkingHtml + understandingHtml + toolChainHtml, ev);
    var answerHtml = aiasAnswerHtml(analysisMd, ev.errors > 0);

    // 使用智能滚动渲染，保持用户视图位置
    aiasSmartRender(msgArea, function() {
      msgText.innerHTML = proofHtml + answerHtml + confirmHtml;
      aiasSetEvidenceBar(msgText, aiasEvidenceChipsHtml(ev, aiasEvidenceDatasources(toolChainHtml, sess)));
      aiasEnhanceResults(msgText);
      // 整块重建会抹掉流式过程里已拆好的多语句子块，这里重新校验/拆分，
      // 否则含多条语句（含非查询语句）的框只会剩一个整体执行按钮
      aiasValidateSqlBlocks(msgText);
    });
  } else {
    aiasHandleScroll();
  }
  // 流结束后隐藏滚动提示（不再有新内容）
  if (!_aias.isGenerating) {
    aiasHideScrollPrompt();
  }
}

// ── 停止生成 ──
function aiasStopGeneration() {
  if (_aias.abortController) {
    _aias.abortController.abort();
    _aias.abortController = null;
  }
  // 刷新待渲染内容，确保停止后显示最终状态
  aiasFlushRender();
  aiasSetGenerating(false);
}

// ── 重试（重新生成AI回复） ──
function aiasRetry(idx) {
  if (_aias.isGenerating) return;
  var sess = aiasCurrentSession();
  if (!sess) return;

  // idx 是 AI 消息的索引，找到它前面的用户消息
  if (idx < 1) return;
  var userMsg = sess.messages[idx - 1];
  if (!userMsg || userMsg.role !== 'user') return;

  // 删除当前AI回复
  sess.messages.splice(idx, 1);

  // 重新渲染并重新发送
  aiasRenderMessages();
  // 重新添加AI占位消息
  var aiMsgIdx = sess.messages.length;
  sess.messages.push({ role: 'ai', content: '', timestamp: Date.now(), streaming: true });
  aiasRenderMessages();

  var msgText = document.getElementById('aias-msg-text-' + aiMsgIdx);
  if (msgText) {
    msgText.innerHTML = '<div class="aias-typing"><span></span><span></span><span></span></div>';
  }

  aiasSetGenerating(true);
  _aias.userScrolledUp = false;
  aiasStreamRequest(userMsg.content, sess, aiMsgIdx);
}

// ── 编辑重发 ──
function aiasStartEdit(idx) {
  if (_aias.isGenerating) return;
  // 隐藏正文，显示编辑框
  var textEl = document.getElementById('aias-msg-text-' + idx);
  var editEl = document.getElementById('aias-edit-area-' + idx);
  if (textEl) textEl.style.display = 'none';
  if (editEl) {
    editEl.classList.add('active');
    var input = document.getElementById('aias-edit-input-' + idx);
    if (input) {
      input.focus();
      // 框高 = 内容实际占的行数（不封顶、框内不滚动）；+2 补 textarea 上下各 1px 边框。
      input.style.height = 'auto';
      input.style.height = (input.scrollHeight + 2) + 'px';
    }
  }
}

function aiasCancelEdit(idx) {
  var textEl = document.getElementById('aias-msg-text-' + idx);
  var editEl = document.getElementById('aias-edit-area-' + idx);
  if (textEl) textEl.style.display = '';
  if (editEl) editEl.classList.remove('active');
}

function aiasSaveEdit(idx) {
  if (_aias.isGenerating) return;
  var sess = aiasCurrentSession();
  if (!sess) return;
  var input = document.getElementById('aias-edit-input-' + idx);
  if (!input) return;
  var newContent = input.value.trim();
  if (!newContent) return;

  // 更新用户消息内容
  sess.messages[idx].content = newContent;

  // 删除此消息之后的所有消息（包括AI回复）
  sess.messages = sess.messages.slice(0, idx + 1);

  aiasSaveSessions();
  aiasRenderMessages();

  // 重新发送
  aiasSendInternal(newContent);
}

// ── 复制消息 ──
function aiasCopyMessage(idx) {
  var sess = aiasCurrentSession();
  if (!sess) return;
  var msg = sess.messages[idx];
  if (!msg) return;
  navigator.clipboard.writeText(msg.content || '').then(function() {
    toast('已复制到剪贴板', 'success', 2000);
  }).catch(function() {
    // 降级方案
    var textarea = document.createElement('textarea');
    textarea.value = msg.content || '';
    document.body.appendChild(textarea);
    textarea.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板', 'success', 2000); } catch(e) {}
    document.body.removeChild(textarea);
  });
}

// ── 巡检任务跟踪（从AI助手启动的巡检）──
var _aiasTaskPollTimer = null;
var _aiasTaskPollTaskId = null;

function aiasCloseTaskTrack() {
  if (_aiasTaskPollTimer) { clearTimeout(_aiasTaskPollTimer); _aiasTaskPollTimer = null; }
  _aiasTaskPollTaskId = null;
  var modal = document.getElementById('aias-task-track-modal');
  if (modal) modal.style.display = 'none';
}

function aiasTrackInspection(taskId) {
  // 弹出任务跟踪窗口
  var modal = document.getElementById('aias-task-track-modal');
  if (!modal) {
    // 动态创建跟踪弹窗
    modal = document.createElement('div');
    modal.id = 'aias-task-track-modal';
    modal.className = 'aias-task-track-modal';
    modal.innerHTML = ''
      + '<div class="aias-tt-content">'
      + '  <div class="aias-tt-header">'
      + '    <span class="aias-tt-title">📊 巡检任务跟踪</span>'
      + '    <button class="aias-tt-close" onclick="aiasCloseTaskTrack()">✕</button>'
      + '  </div>'
      + '  <div class="aias-tt-body" id="aias-tt-body">'
      + '    <div class="aias-tt-loading">加载中...</div>'
      + '  </div>'
      + '  <div class="aias-tt-footer">'
      + '    <button class="btn btn-ghost" onclick="aiasRefreshTaskStatus(\'' + taskId + '\')">🔄 刷新</button>'
      + '    <button class="btn btn-primary" onclick="showPage(\'reports\'); aiasCloseTaskTrack()">📄 查看巡检历史</button>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
  aiasRefreshTaskStatus(taskId);
}

function aiasRefreshTaskStatus(taskId) {
  _aiasTaskPollTaskId = taskId;
  var body = document.getElementById('aias-tt-body');
  if (!body) return;
  body.innerHTML = '<div class="aias-tt-loading">查询中...</div>';
  fetch('/api/chat/task/' + taskId)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.ok) {
        body.innerHTML = '<div class="aias-tt-error">⚠️ ' + escHtml(data.error || '任务不存在') + '</div>'
          + '<div style="margin-top:12px;font-size:13px;color:var(--text-muted)">该任务可能已完成或已过期。请到「数据库巡检历史」查看报告。</div>';
        return;
      }
      var statusText = data.status === 'running' ? '🔄 执行中' : data.status === 'done' ? '✅ 已完成' : data.status === 'error' ? '❌ 执行失败' : '⏳ ' + data.status;
      var statusColor = data.status === 'running' ? '#f59e0b' : data.status === 'done' ? '#22c55e' : data.status === 'error' ? '#ef4444' : '#6b7280';
      var html = '<div class="aias-tt-status" style="color:' + statusColor + '">' + statusText + '</div>';

      // 数据源和类型信息
      if (data.datasource || data.db_type) {
        html += '<div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">';
        if (data.datasource) html += '📊 ' + escHtml(data.datasource);
        if (data.datasource && data.db_type) html += ' · ';
        if (data.db_type) html += escHtml(data.db_type);
        html += '</div>';
      }

      // 健康分数和风险（从数据库恢复时有）
      if (data.health_score !== undefined && data.health_score !== null) {
        html += '<div style="display:flex;gap:12px;margin-bottom:10px;font-size:13px">';
        html += '<span>健康分: <strong>' + data.health_score + '</strong></span>';
        html += '<span>风险数: <strong>' + (data.risk_count || 0) + '</strong></span>';
        if (data.risk_level) html += '<span>风险等级: <strong>' + escHtml(data.risk_level) + '</strong></span>';
        html += '</div>';
      }

      // 执行日志
      if (data.log && data.log.length > 0) {
        html += '<div class="aias-tt-section-title">执行日志</div>';
        html += '<div class="aias-tt-log">';
        for (var i = 0; i < data.log.length; i++) {
          html += '<div class="aias-tt-log-line">' + escHtml(data.log[i]) + '</div>';
        }
        html += '</div>';
      }

      // 报告链接
      if (data.status === 'done' && data.report_file) {
        var reportName = data.report_name || '巡检报告';
        var reportFile = data.report_file || '';
        var fileName = reportFile.split(/[\\/]/).pop() || reportName;
        html += '<div class="aias-tt-report">';
        html += '<span>📄 报告: ' + escHtml(reportName) + '</span>';
        html += '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">';
        html += '<button class="btn btn-primary" style="font-size:12px;padding:5px 12px" onclick="window.open(\'/api/download_file?name=' + encodeURIComponent(fileName) + '\')">📥 原始数据</button>';
        html += '<button class="btn btn-ghost" style="font-size:12px;padding:5px 12px" onclick="downloadReportHtml(\'' + fileName.replace(/'/g, "\\'") + '\')">📊 分析报告</button>';
        html += '<button class="btn btn-ghost" style="font-size:12px;padding:5px 12px" onclick="showPage(\'reports\'); document.getElementById(\'aias-task-track-modal\').style.display=\'none\'">📄 在巡检历史中查看</button>';
        html += '</div>';
        html += '</div>';
      }

      // 错误信息
      if (data.status === 'error' && data.error_msg) {
        html += '<div class="aias-tt-error-detail">错误详情: ' + escHtml(data.error_msg) + '</div>';
      }

      body.innerHTML = html;

      // 自动刷新：任务仍在运行时，3秒后再次轮询（实时显示状态）
      if (data.status === 'running') {
        if (_aiasTaskPollTimer) clearTimeout(_aiasTaskPollTimer);
        _aiasTaskPollTimer = setTimeout(function() {
          if (_aiasTaskPollTaskId === taskId) {
            aiasRefreshTaskStatus(taskId);
          }
        }, 3000);
      }
    })
    .catch(function(err) {
      body.innerHTML = '<div class="aias-tt-error">⚠️ 查询失败: ' + escHtml(err.message) + '</div>';
    });
}

// ── AI巡检任务历史 ──
function aiasShowTaskHistory() {
  var modal = document.getElementById('aias-task-history-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'aias-task-history-modal';
    modal.className = 'aias-task-history-modal';
    modal.innerHTML = ''
      + '<div class="aias-th-content">'
      + '  <div class="aias-th-header">'
      + '    <span class="aias-th-title">📋 AI巡检任务历史</span>'
      + '    <button class="aias-th-close" onclick="aiasCloseTaskHistory()">✕</button>'
      + '  </div>'
      + '  <div class="aias-th-body" id="aias-th-body">'
      + '    <div class="aias-th-empty">加载中...</div>'
      + '  </div>'
      + '  <div class="aias-th-footer">'
      + '    <span class="aias-th-count" id="aias-th-count"></span>'
      + '    <div style="display:flex;gap:8px">'
      + '      <button class="aias-th-item-btn" onclick="aiasShowTaskHistory()">🔄 刷新</button>'
      + '      <button class="aias-th-item-btn primary" onclick="showPage(\'reports\'); filterReportTrigger(\'ai_assistant\'); aiasCloseTaskHistory()">📊 查看巡检历史</button>'
      + '    </div>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
  aiasLoadTaskHistory();
}

// 任务历史轮询定时器
var _aiasTaskHistoryTimer = null;

function aiasStopTaskHistoryPolling() {
  if (_aiasTaskHistoryTimer) {
    clearInterval(_aiasTaskHistoryTimer);
    _aiasTaskHistoryTimer = null;
  }
}

function aiasCloseTaskHistory() {
  aiasStopTaskHistoryPolling();
  var modal = document.getElementById('aias-task-history-modal');
  if (modal) {
    modal.style.display = 'none';
    var body = document.getElementById('aias-th-body');
    if (body) delete body.dataset.loaded;
  }
}

function aiasLoadTaskHistory() {
  var body = document.getElementById('aias-th-body');
  if (!body) return;
  // 仅在显示"加载中"时才覆盖，避免轮询时闪烁
  if (body.querySelector('.aias-th-empty') || !body.dataset.loaded) {
    body.innerHTML = '<div class="aias-th-empty">加载中...</div>';
  }
  body.dataset.loaded = '1';

  fetch('/api/chat/tasks')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.ok || !data.tasks || data.tasks.length === 0) {
        body.innerHTML = '<div class="aias-th-empty">📋 暂无AI巡检任务记录<br><br>'
          + '<span style="font-size:12px">在对话中发起巡检指令（如"巡检一下 测试环境-oracle"），任务将自动记录在此处</span></div>';
        var countEl = document.getElementById('aias-th-count');
        if (countEl) countEl.textContent = '共 0 条记录';
        aiasStopTaskHistoryPolling();
        return;
      }

      var countEl = document.getElementById('aias-th-count');
      if (countEl) countEl.textContent = '共 ' + data.total + ' 条记录';

      var hasRunning = false;
      var html = '';
      for (var i = 0; i < data.tasks.length; i++) {
        var t = data.tasks[i];
        var statusIcon, statusBg, statusText;
        if (t.status === 'running') { statusIcon = '🔄'; statusBg = 'rgba(245,158,11,0.15)'; statusText = '执行中'; hasRunning = true; }
        else if (t.status === 'done') { statusIcon = '✅'; statusBg = 'rgba(34,197,94,0.15)'; statusText = '已完成'; }
        else if (t.status === 'error') { statusIcon = '❌'; statusBg = 'rgba(239,68,68,0.15)'; statusText = '失败'; }
        else { statusIcon = '⏳'; statusBg = 'rgba(107,114,128,0.15)'; statusText = t.status; }

        var sourceBadge = t.source === 'memory'
          ? '<span class="aias-th-item-badge" style="background:rgba(99,102,241,0.15);color:#6366f1">运行中</span>'
          : '<span class="aias-th-item-badge" style="background:rgba(139,92,246,0.15);color:#8b5cf6">已归档</span>';

        var dbTypeBadge = t.db_type
          ? '<span class="aias-th-item-badge" style="background:var(--surface2,#f3f4f6);color:var(--text-muted,#6b7280)">' + escHtml(t.db_type) + '</span>'
          : '';

        var timeStr = t.started_at || '';
        try { if (timeStr) timeStr = new Date(timeStr).toLocaleString('zh-CN'); } catch(e) {}

        html += '<div class="aias-th-item' + (t.status === 'running' ? ' aias-th-item-running' : '') + '">';
        html += '  <div class="aias-th-item-status" style="background:' + statusBg + '">' + statusIcon + '</div>';
        html += '  <div class="aias-th-item-info">';
        html += '    <div class="aias-th-item-name">' + escHtml(t.datasource || '未知数据源') + '</div>';
        html += '    <div class="aias-th-item-meta">';
        html += '      <span>' + escHtml(timeStr || '--') + '</span>';
        html += '      ' + dbTypeBadge + sourceBadge;
        if (t.health_score !== undefined && t.health_score !== null) {
          html += '      <span class="aias-th-item-badge" style="background:rgba(34,197,94,0.1);color:#22c55e">健康分 ' + t.health_score + '</span>';
        }
        html += '    </div>';
        // 运行中任务显示实时进度日志
        if (t.status === 'running' && t.recent_logs && t.recent_logs.length > 0) {
          html += '    <div class="aias-th-progress">';
          html += '      <div class="aias-th-progress-bar"><div class="aias-th-progress-fill"></div></div>';
          html += '      <div class="aias-th-progress-logs">';
          for (var j = 0; j < t.recent_logs.length; j++) {
            html += '        <div class="aias-th-progress-log">' + escHtml(t.recent_logs[j]) + '</div>';
          }
          html += '      </div>';
          html += '    </div>';
        }
        // 失败任务显示错误信息
        if (t.status === 'error' && t.error_msg) {
          html += '    <div class="aias-th-error-msg">⚠️ ' + escHtml(t.error_msg) + '</div>';
        }
        html += '  </div>';
        html += '  <div class="aias-th-item-actions">';
        // 运行中的任务可以跟踪进度
        if (t.task_id && t.status === 'running') {
          html += '    <button class="aias-th-item-btn" onclick="aiasTrackInspection(\'' + escHtml(t.task_id) + '\')">📊 跟踪</button>';
        }
        // 已完成的任务可以查看报告
        if (t.status === 'done' && t.report_file) {
          var fileName = (t.report_file || '').split(/[\\/]/).pop() || t.report_name;
          html += '    <button class="aias-th-item-btn primary" onclick="window.open(\'/api/download_file?name=' + encodeURIComponent(fileName) + '\')">📥 原始数据</button>';
          html += '    <button class="aias-th-item-btn" onclick="downloadReportHtml(\'' + fileName.replace(/'/g, "\\'") + '\')">📊 分析报告</button>';
        }
        html += '  </div>';
        html += '</div>';
      }
      body.innerHTML = html;

      // 有运行中任务时自动轮询（3秒间隔）
      aiasStopTaskHistoryPolling();
      if (hasRunning) {
        var modal = document.getElementById('aias-task-history-modal');
        if (modal && modal.style.display !== 'none') {
          _aiasTaskHistoryTimer = setInterval(function() {
            var m = document.getElementById('aias-task-history-modal');
            if (!m || m.style.display === 'none') {
              aiasStopTaskHistoryPolling();
              return;
            }
            aiasLoadTaskHistory();
          }, 3000);
        }
      }
    })
    .catch(function(err) {
      body.innerHTML = '<div class="aias-th-empty">⚠️ 加载失败: ' + escHtml(err.message) + '</div>';
    });
}

// ── 滚动控制 ──
function aiasScrollToBottom(instant) {
  var msgArea = document.getElementById('aias-messages');
  if (!msgArea) return;
  // instant=true: 立即跳到底部（流式跟随）
  // instant=false: 平滑滚动（用户点击"有新内容"提示时）
  if (instant) {
    msgArea.scrollTop = msgArea.scrollHeight;
  } else {
    msgArea.scrollTo({ top: msgArea.scrollHeight, behavior: 'smooth' });
  }
  _aias.userScrolledUp = false;
  aiasHideScrollPrompt();
}

function aiasShowScrollPrompt() {
  if (_aias.scrollPromptShown) return;
  var prompt = document.getElementById('aias-scroll-prompt');
  if (prompt) {
    prompt.style.display = 'block';
    _aias.scrollPromptShown = true;
  }
}

function aiasHideScrollPrompt() {
  var prompt = document.getElementById('aias-scroll-prompt');
  if (prompt) prompt.style.display = 'none';
  _aias.scrollPromptShown = false;
}

// ── UI 状态控制 ──
function aiasSetGenerating(generating) {
  _aias.isGenerating = generating;
  var sendBtn = document.getElementById('aias-send-btn');
  var stopBtn = document.getElementById('aias-stop-btn');
  var input = document.getElementById('aias-input');
  if (sendBtn) sendBtn.style.display = generating ? 'none' : 'flex';
  if (stopBtn) stopBtn.style.display = generating ? 'flex' : 'none';
  if (input) input.disabled = false; // 输入框始终可用，允许准备下一条消息
}

// ── 输入框自适应高度 ──
function aiasAutoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

// ── 键盘事件 ──
function aiasOnKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    aiasSend();
  }
}

/* ── 会话列表：悬浮抽屉 / 可拖宽 / 可钉住 ──────────────────
   默认浮在正文右侧（不挤布局），拖左缘改宽度（220~480px），点图钉钉住后回到占位式；
   收起时整块滑出右缘，只留停靠页签。宽度、钉住、收起三态都记在 localStorage，
   并且每次变化都让刻度尺重新让位。 */
var AIAS_SB_W_KEY = 'aias_sidebar_w';
var AIAS_SB_PIN_KEY = 'aias_sidebar_pinned';
var AIAS_SB_HIDDEN_KEY = 'aias_sidebar_collapsed';   // 沿用旧键：老用户收起状态不丢
var AIAS_SB_W_MIN = 220;
var AIAS_SB_W_MAX = 480;
var AIAS_SB_W_DEFAULT = 260;

function aiasSidebarEls() {
  return {
    container: document.getElementById('aias-container'),
    sidebar: document.getElementById('aias-sidebar'),
    pin: document.getElementById('aias-sb-pin'),
    resizer: document.getElementById('aias-sb-resizer'),
    dock: document.getElementById('aias-dock-tab')
  };
}

function aiasSbStored(key, fallback) {
  try {
    var value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch (ignore) { return fallback; }
}

function aiasClampSidebarWidth(value) {
  var width = parseInt(value, 10);
  if (!isFinite(width)) width = AIAS_SB_W_DEFAULT;
  return Math.max(AIAS_SB_W_MIN, Math.min(AIAS_SB_W_MAX, width));
}

function aiasSidebarWidth() { return aiasClampSidebarWidth(aiasSbStored(AIAS_SB_W_KEY, AIAS_SB_W_DEFAULT)); }
function aiasSidebarPinned() { return aiasSbStored(AIAS_SB_PIN_KEY, '0') === '1'; }
// 展开还是收起完全由人点：抽屉展开时正文按它的宽度让位（不盖住对话），
// 所以没有「选完必须自动收」的理由，默认保持展开，跟原来的侧栏一致。
function aiasSidebarHidden() { return aiasSbStored(AIAS_SB_HIDDEN_KEY, '0') === '1'; }

// 把三态写进 DOM：容器类决定悬浮还是占位，--sb-w 决定宽度，.aias-collapsed 决定收起
function aiasApplySidebar() {
  var el = aiasSidebarEls();
  if (!el.container || !el.sidebar) return;
  var pinned = aiasSidebarPinned();
  var hidden = aiasSidebarHidden();
  el.container.classList.toggle('aias-sb-float', !pinned);
  el.container.classList.toggle('aias-sb-pinned', pinned);
  // 宽度变量挂在容器上：抽屉自己要用，正文也要按它让出等宽的空间（aias-sb-open）
  el.container.style.setProperty('--sb-w', aiasSidebarWidth() + 'px');
  el.container.classList.toggle('aias-sb-open', !hidden);
  el.sidebar.classList.toggle('aias-collapsed', hidden);
  // 收起靠滑出/宽度动画完成，不再用 display:none 硬摘（那会让刻度尺读到 0 宽）
  el.sidebar.style.display = '';
  if (el.pin) {
    el.pin.classList.toggle('on', pinned);
    el.pin.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    el.pin.title = pinned ? '取消钉住（会话列表改回悬浮，不占对话宽度）'
      : '钉住会话列表（钉住后占据布局，不遮挡对话）';
  }
  aiasRebuildMinimap();
}

function aiasToggleSidebar() {
  try { localStorage.setItem(AIAS_SB_HIDDEN_KEY, aiasSidebarHidden() ? '0' : '1'); } catch (ignore) {}
  aiasApplySidebar();
}

function aiasToggleSidebarPin() {
  try { localStorage.setItem(AIAS_SB_PIN_KEY, aiasSidebarPinned() ? '0' : '1'); } catch (ignore) {}
  if (aiasSidebarHidden()) {
    // 钉住一个收起的面板等于没有面板，顺手展开
    try { localStorage.setItem(AIAS_SB_HIDDEN_KEY, '0'); } catch (ignore) {}
  }
  aiasApplySidebar();
}

// 拖左缘改宽度
function aiasInitSidebarDrawer() {
  var el = aiasSidebarEls();
  aiasApplySidebar();
  if (!el.resizer || el.resizer.getAttribute('data-bound') === '1') return;
  el.resizer.setAttribute('data-bound', '1');
  var startX = 0;
  var startW = 0;
  var dragging = false;
  el.resizer.addEventListener('pointerdown', function (e) {
    if (!el.sidebar) return;
    dragging = true;
    startX = e.clientX;
    startW = el.sidebar.getBoundingClientRect().width;
    el.resizer.classList.add('dragging');
    if (el.resizer.setPointerCapture) { try { el.resizer.setPointerCapture(e.pointerId); } catch (ignore) {} }
    e.preventDefault();
  });
  el.resizer.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    // 面板贴右缘：往左拖变宽，往右拖变窄
    var width = aiasClampSidebarWidth(startW + (startX - e.clientX));
    el.container.style.setProperty('--sb-w', width + 'px');
    aiasRebuildMinimap();
  });
  window.addEventListener('pointerup', function () {
    if (!dragging) return;
    dragging = false;
    el.resizer.classList.remove('dragging');
    var width = aiasClampSidebarWidth(el.container.style.getPropertyValue('--sb-w'));
    try { localStorage.setItem(AIAS_SB_W_KEY, String(width)); } catch (ignore) {}
    aiasApplySidebar();
  });
}

// ── 页面切换时初始化 ──
var _aiasOriginalShowPage = showPage;
showPage = function(name) {
  _aiasOriginalShowPage(name);
  if (name === 'ai-assistant') {
    if (!_aias.currentSessionId) {
      aiasInit();
    }
    // 延迟聚焦输入框
    setTimeout(function() {
      var input = document.getElementById('aias-input');
      if (input) input.focus();
      // 确保滚动到底部（等布局稳定后再次滚动，避免刷新后置顶）
      aiasScrollToBottom(true);
      requestAnimationFrame(function() {
        aiasScrollToBottom(true);
      });
    }, 200);
  }
};

// ────────────────────────────────────────────────────────────
//  会话存储：读写走服务端
//
//  历史必须存在服务端 —— 只放浏览器 localStorage 的话，换一台机器就没了，
//  多人共用一台还会互相看到对方的会话。这里接管两个存储边界函数，
//  会话数组的结构与调用时机都保持原样：
//    · aiasSaveSessions()           → 去抖 POST /api/ai/sessions/sync（整组快照，幂等）
//    · aiasLoadSessionsFromServer() → GET /api/ai/sessions?full=1 一次拿回全部会话与消息
//  为什么是「整组快照」而不是逐条 append：内存里的 _aias.sessions 才是唯一真相，
//  编辑重发、清空、撤销、超过 20 条截断都会让消息变少或变样，append 语义会留下
//  删不掉的旧行；服务端 /sync 因此按会话整段替换。
//
//  会话里的富字段（思考过程、工具轨迹 HTML、AI 修复后的 sqlOverrides 覆盖层）
//  在库里没有对应的列，服务端统一存进消息的 meta JSON，读回来时原样并回消息对象，
//  这一层前端不用感知。
// ────────────────────────────────────────────────────────────
(function () {
  var SESSIONS_API = '/api/ai/sessions';
  var saveTimer = 0;
  var saving = false;
  var again = false;

  function snapshot() {
    // 只保留最近 20 个会话（与界面里的会话列表同口径，写入前先裁）
    if (_aias.sessions.length > 20) _aias.sessions = _aias.sessions.slice(0, 20);
    return JSON.stringify({ sessions: _aias.sessions });
  }

  // 本地镜像存的是「会话数组」本身（aiasInit 读的就是这个形状）；
  // snapshot() 那层 {"sessions":[…]} 包装只是服务端 sync 的请求体，不能混用。
  function localMirror() {
    return JSON.stringify(_aias.sessions);
  }

  function push() {
    if (saving) { again = true; return; }
    saving = true;
    fetch(SESSIONS_API + '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: snapshot()
    }).then(function (res) { return res.json(); }).then(function (body) {
      saving = false;
      if (body && body.ok === false && window.console) {
        console.warn('[aias] 会话保存失败：' + (body.error || '未知错误'));
      }
      if (again) { again = false; aiasSaveSessions(); }
    }).catch(function () {
      saving = false;
      // 存不进去也不打断对话：会话还在内存里，本轮问答可以继续；
      // 留一句日志，方便排查「刷新后历史没了」到底是网络还是后端。
      if (window.console) console.warn('[aias] 会话保存请求失败（本地仍可继续对话）');
    });
  }

  window.aiasSaveSessions = function () {
    // 先落一份本地镜像再排去抖：服务端 sync 失败/断网/浏览器崩溃时，
    // 这一份就是「刷新后历史没了」的最后兜底（aiasInit 会先读它）。
    try { localStorage.setItem('aias_sessions', localMirror()); } catch (ignore) {}
    clearTimeout(saveTimer);
    saveTimer = setTimeout(push, 500);
  };

  /* 关页、刷新、切后台时把待保存的快照立刻发出去。
     去抖的 500ms 最容易卡在「AI 刚答完就刷新」这一下 —— 那一轮问答就此丢掉，
     表现正是「重启服务后回复没了」。keepalive 让请求在页面卸载后仍能发完。 */
  function flushPendingSave() {
    if (!saveTimer && !again) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    var body = snapshot();
    try { localStorage.setItem('aias_sessions', localMirror()); } catch (ignore) {}
    try {
      fetch(SESSIONS_API + '/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: body,
        keepalive: true
      }).catch(function () { /* 发不出去还有本地镜像 */ });
    } catch (ignore) { /* 老浏览器不支持 keepalive：本地镜像已经写了 */ }
  }
  window.addEventListener('pagehide', flushPendingSave);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushPendingSave();
  });

  /** 从服务端取回会话数组（含每个会话的消息）；拿到非空结果返回 true。 */
  window.aiasLoadSessionsFromServer = function () {
    return fetch(SESSIONS_API + '?full=1&limit=60', { credentials: 'same-origin' })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (!body || !body.ok) return false;
        var sessions = (body.sessions || []).map(function (item) {
          // 服务端回来的消息是「已结束」的历史：清掉 streaming 标记，
          // 否则重启后读回的 AI 回复会一直停在「生成中」的渲染分支上。
          var messages = (item.messages || []).map(function (msg) {
            if (msg && msg.streaming) {
              var clean = {};
              for (var key in msg) {
                if (Object.prototype.hasOwnProperty.call(msg, key) && key !== 'streaming') clean[key] = msg[key];
              }
              return clean;
            }
            return msg;
          });
          return {
            id: item.id,
            title: item.title || '新对话',
            currentDatasource: item.datasource || '',
            datasources: item.datasources || (item.datasource ? [item.datasource] : []),
            createdAt: item.createdAt || item.created_at || '',
            messages: messages
          };
        });
        if (!sessions.length) return false;          // 服务端还没有会话：保留当前新建的空白会话
        _aias.sessions = sessions;
        if (!sessions.some(function (s) { return s.id === _aias.currentSessionId; })) {
          _aias.currentSessionId = sessions[0].id;
        }
        aiasRenderSessionList();
        aiasRenderMessages();
        aiasRefreshDsCapsule();
        return true;
      })
      .catch(function () { return false; });
  };

  // 初始化本身不动：它先按内存/本地状态渲染一屏，服务端会话回来后再整体替换，
  // 两者表现一致（空数组 = 还没数据），所以只是补一次异步同步，不会闪。
  var originalInit = window.aiasInit;
  window.aiasInit = function () {
    var result = originalInit.apply(this, arguments);
    aiasLoadSessionsFromServer();
    return result;
  };

  // aiasClearChat / aiasDeleteSession 只改内存数组，落盘靠 aiasSaveSessions；
  // 而快照 sync 是整段替换，被删掉的会话在服务端会留下来。这里补一次真正的删除，
  // 保证「删会话」这个操作在服务端也成立。
  ['aiasDeleteSession', 'aiasClearChat'].forEach(function (name) {
    var original = window[name];
    if (typeof original !== 'function') return;
    window[name] = function () {
      var gone = (_aias.currentSessionId || '');
      var result = original.apply(this, arguments);
      var id = (name === 'aiasDeleteSession' && arguments[0]) ? arguments[0] : gone;
      if (id) {
        fetch(SESSIONS_API + '/' + encodeURIComponent(id), {
          method: 'DELETE', credentials: 'same-origin'
        }).catch(function () { /* 删不掉只是留下孤儿会话，不影响继续对话 */ });
      }
      return result;
    };
  });
})();

/* ════════════════════════════════════════════════════════════
   对话缩略导航（minimap）
   消息流右边缘一条刻度尺：一横 = 一个主题（一个提问连同它的回答），横向在细轨里居中，
   纵向等距紧排（每档 6px，整块垂直居中；主题太多就等比压缩档距，仍然等距、一条不落）。
   线长随这个主题的体量，类型取这一串里最要紧的（报错 > 含 SQL > 思考 > 结论）。
   当前在看的主题：那一横转主色，外面套一段高亮带（带的范围就是可见主题占的档位）。
   鼠标扫到某一横：只有那一横变长（粗细一律 2px），左侧滑出这个主题的名字；
   点一横跳到该主题开头，按住拖动按比例滚动；
   Alt+↑/↓ 逐条消息跳转并浮出所属主题。
   内容不满一屏、窄屏（≤768px）、顶栏关掉时都不出现，开关状态记在 localStorage。
   ════════════════════════════════════════════════════════════ */
var AIAS_MM_KEY = 'aias_minimap_enabled';
var AIAS_MM_TOPIC_CHARS = 46;     // 主题一行放多少字
var AIAS_MM_DASH_MIN = 8;         // 最短一横
var AIAS_MM_DASH_MAX = 22;        // 最长一横（大主题）
var AIAS_MM_DASH_CHARS = 60;      // 每多少字换 1px 线长（按主题累计字数）
var AIAS_MM_PITCH = 6;            // 等距档：每档 6px（2px 线 + 4px 空）
var AIAS_MM_LINE = 2;             // 一横自身的厚度（与 CSS height 同口径）
var AIAS_MM_MIN_PITCH = AIAS_MM_LINE;   // 压缩的下限：档距不小于线本身，紧挨着也不重叠
var AIAS_MM_MARGIN = 8;           // 细轨上下留白
var AIAS_MM_HIT_SLACK = 9;        // 指针没正好压在一横上时，多少像素内仍算指着它
var AIAS_MM_TIP_MS = 1400;        // 键盘跳转后主题标签的停留时间
var AIAS_MM_KIND_RANK = { error: 3, sql: 2, think: 1, ai: 0, user: 0 };
var _aiasMm = {
  bound: false,
  enabled: true,
  scale: 1,
  dragging: false,
  dragMoved: false,
  startY: 0,
  activeIdx: null,
  tipIdx: null,
  rebuildTimer: null,
  tipTimer: null,
  dashByMsg: {}       // 消息序号 → 所属主题（一横）的锚点消息序号
};

// 词典没就绪时用兜底文案
function aiasT(key, fallback) {
  try {
    if (typeof window.i18n === 'function') {
      var value = window.i18n(key);
      if (value && value !== key) return value;
    }
  } catch (ignore) { /* 词典未加载完 */ }
  return fallback || key;
}

function aiasMmParts() {
  return {
    stream: document.getElementById('aias-stream'),
    area: document.getElementById('aias-messages'),
    bar: document.getElementById('aias-minimap'),
    blocks: document.getElementById('aias-minimap-blocks'),
    viewport: document.getElementById('aias-minimap-viewport'),
    tip: document.getElementById('aias-mm-tip'),
    button: document.getElementById('aias-minimap-btn')
  };
}

// 单条消息的类型：提问 → 执行报错 → 含查询语句 → 思考/工具链 → 结论
function aiasMmKind(msgEl) {
  if (msgEl.classList.contains('user')) return 'user';
  if (msgEl.querySelector('.aias-sql-result-error')) return 'error';
  if (msgEl.querySelector('.aias-sql-exec-wrap')) return 'sql';
  if (msgEl.querySelector('.aias-thinking') || msgEl.querySelector('.aias-tc-step')) return 'think';
  return 'ai';
}

function aiasMmKindLabel(kind) {
  if (kind === 'user') return aiasT('webui.aias_mm_kind_user', '提问');
  if (kind === 'error') return aiasT('webui.aias_mm_kind_error', '执行报错');
  if (kind === 'sql') return aiasT('webui.aias_mm_kind_sql', '含查询语句');
  if (kind === 'think') return aiasT('webui.aias_mm_kind_think', '思考 · 工具链');
  return aiasT('webui.aias_mm_kind_ai', '结论');
}

// 主题类型取「这一串里最要紧的那个」：有报错就是报错，其次含 SQL；纯问答就是提问
function aiasMmMergeKind(best, kind) {
  if (kind === 'user') return best;
  if (!best || (AIAS_MM_KIND_RANK[kind] || 0) > (AIAS_MM_KIND_RANK[best] || 0)) return kind || best;
  return best;
}

function aiasMmText(msgEl) {
  var textEl = msgEl.querySelector('.aias-msg-text');
  return String((textEl || msgEl).textContent || '');
}

// 主题名 = 这个提问的第一行（跳过空行），一行看得清就够
function aiasMmFirstLine(msgEl) {
  var lines = aiasMmText(msgEl).split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\s+/g, ' ').trim();
    if (!line) continue;
    return line.length > AIAS_MM_TOPIC_CHARS ? line.slice(0, AIAS_MM_TOPIC_CHARS) + '…' : line;
  }
  return aiasT('webui.aias_mm_no_text', '（无可摘取文本）');
}

// 线长 = 这个主题的累计体量，钳在 8~22px
function aiasMmDashWidth(chars) {
  var width = AIAS_MM_DASH_MIN + Math.round(chars / AIAS_MM_DASH_CHARS);
  return Math.max(AIAS_MM_DASH_MIN, Math.min(AIAS_MM_DASH_MAX, width));
}

function aiasMmNarrow() {
  return !!(window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
}

// 出现条件：这条尺子是「主题导航」，不是滚动条 —— 有两个以上主题就该能用，
// 哪怕对话还很短、当前一屏装得下（能装下也照样要跳来跳去）。
function aiasMmWorthShowing(area, topics) {
  return topics >= 2 || area.scrollHeight > area.clientHeight + 24;
}

// 会话列表（悬浮抽屉或停靠页签）会占住右缘：刻度尺按实际情况决定要不要再左让
function aiasMmInsetPx(area) {
  var container = document.querySelector('.aias-container');
  var sidebar = document.getElementById('aias-sidebar');
  // 抽屉展开时正文已经按它的宽度让出空间（.aias-sb-open 的 padding），
  // 刻度尺自然落在收窄后的列右缘，不需要再偏移
  if (sidebar && container && container.classList.contains('aias-sb-float') &&
      !sidebar.classList.contains('aias-collapsed')) {
    return 0;
  }
  var dock = document.getElementById('aias-dock-tab');
  // 收起后留下的竖排页签正好压在右缘上，刻度尺要让开它
  if (dock && dock.offsetParent !== null) {
    var tabW = dock.getBoundingClientRect().width;
    if (tabW > 0) return Math.round(tabW + 6);
  }
  return 0;
}

function aiasMmDashAt(blocks, idx) {
  for (var i = 0; i < blocks.length; i++) {
    if (blocks[i].getAttribute('data-idx') === String(idx)) return blocks[i];
  }
  return null;
}

// 把消息归并成主题：提问开一个新主题，后续回答并进当前主题
function aiasMmCollectTopics(msgs, areaRect, scrollTop) {
  var topics = [];
  for (var i = 0; i < msgs.length; i++) {
    var el = msgs[i];
    var rect = el.getBoundingClientRect();
    var top = rect.top - areaRect.top + scrollTop;
    var bottom = top + rect.height;
    var idx = el.getAttribute('data-idx') || String(i);
    var isUser = el.classList.contains('user');
    var kind = aiasMmKind(el);
    var size = aiasMmText(el).length;
    if (isUser || !topics.length) {
      topics.push({
        anchor: idx, anchorUser: isUser, msgs: [idx], kind: kind,
        ctop: top, cbottom: bottom, size: size, title: aiasMmFirstLine(el)
      });
    } else {
      var cur = topics[topics.length - 1];
      cur.msgs.push(idx);
      cur.kind = aiasMmMergeKind(cur.kind, kind);
      cur.cbottom = Math.max(cur.cbottom, bottom);
      cur.size += size;
    }
    _aiasMm.dashByMsg[idx] = topics[topics.length - 1].anchor;
  }
  for (var t = 0; t < topics.length; t++) {
    // 只有提问本身（后面没回答）才叫「提问」；带回答的主题看内容类型
    if (topics[t].anchorUser && topics[t].msgs.length === 1) topics[t].kind = 'user';
  }
  return topics;
}

/* 纵向排布：等距紧排。档距固定 AIAS_MM_PITCH，整块在细轨里垂直居中；
   主题多到铺不开时等比压缩档距（仍然等距，一条不落）。
   刻度不再按内容偏移折算 —— 刻度尺要的是「一眼数得清的规律」，
   「你正在看第几个主题」由提亮的那一横和可视区高亮带说明。 */
function aiasMmLayoutY(n, railH) {
  if (!n) return [];
  var usable = Math.max(AIAS_MM_LINE, railH - AIAS_MM_MARGIN * 2);
  var pitch = AIAS_MM_PITCH;
  if (n > 1 && (n - 1) * pitch + AIAS_MM_LINE > usable) {
    pitch = Math.max(AIAS_MM_MIN_PITCH, (usable - AIAS_MM_LINE) / (n - 1));
  }
  var blockH = (n - 1) * pitch + AIAS_MM_LINE;
  var start = AIAS_MM_MARGIN + Math.max(0, (usable - blockH) / 2);
  var ys = new Array(n);
  for (var i = 0; i < n; i++) ys[i] = Math.round(start + i * pitch);
  return ys;
}

// 全量重绘：一横一个主题
function aiasRenderMinimap() {
  var p = aiasMmParts();
  if (!p.area || !p.bar || !p.blocks || !p.viewport) return;
  aiasMmHideTip();
  if (!_aiasMm.enabled || aiasMmNarrow()) {
    p.bar.hidden = true;
    return;
  }
  var trackH = p.bar.clientHeight || p.area.clientHeight;
  var contentH = p.area.scrollHeight;
  if (!trackH) { p.bar.hidden = true; return; }
  _aiasMm.scale = contentH ? trackH / contentH : 1;
  _aiasMm.dashByMsg = {};

  var areaRect = p.area.getBoundingClientRect();
  var msgs = p.area.querySelectorAll('.aias-msg');
  var topics = aiasMmCollectTopics(msgs, areaRect, p.area.scrollTop);
  // 先数主题再决定显不显示：两个以上主题就有导航价值，哪怕还没撑满一屏
  if (!aiasMmWorthShowing(p.area, topics.length)) {
    p.bar.hidden = true;
    return;
  }
  var inset = aiasMmInsetPx(p.area);
  if (p.stream && p.stream.style.setProperty) {
    p.stream.style.setProperty('--mm-inset', inset + 'px');
  }
  p.bar.hidden = false;
  var ys = aiasMmLayoutY(topics.length, trackH);
  var frag = document.createDocumentFragment();
  for (var i = 0; i < topics.length; i++) {
    var t = topics[i];
    var dash = document.createElement('div');
    dash.className = 'aias-mm-block';
    dash.setAttribute('data-kind', t.kind);
    dash.setAttribute('data-idx', t.anchor);
    dash.setAttribute('data-topic', t.title);
    dash.setAttribute('data-pos', (i + 1) + '/' + topics.length);
    dash.setAttribute('data-msgs', String(t.msgs.length));
    dash.style.top = ys[i] + 'px';
    // 线长只写进 CSS 变量：内联 width 会盖掉悬停时的 calc(var(--w) + 10px)，那一横就长不出来了
    var wpx = aiasMmDashWidth(t.size) + 'px';
    if (dash.style.setProperty) dash.style.setProperty('--w', wpx);
    else dash.style.width = wpx;
    // 记内容区间：提亮判定看主题实际覆盖的范围，不看避让后的排位
    dash.setAttribute('data-ctop', String(Math.round(t.ctop)));
    dash.setAttribute('data-cbottom', String(Math.round(t.cbottom)));
    frag.appendChild(dash);
  }
  p.blocks.innerHTML = '';
  p.blocks.appendChild(frag);
  aiasUpdateMinimapViewport();
}

// 可视区高亮 + 正在看的主题提亮（滚动、拖动、重绘后都要同步）
function aiasUpdateMinimapViewport() {
  var p = aiasMmParts();
  if (!p.area || !p.bar || p.bar.hidden || !p.viewport) return;
  var visible = p.area.clientHeight;
  var top = p.area.scrollTop;
  var bottom = top + visible;
  var dashes = p.blocks.children;
  var firstY = null;
  var lastY = null;
  for (var i = 0; i < dashes.length; i++) {
    var ctop = Number(dashes[i].getAttribute('data-ctop') || 0);
    var cbottom = Number(dashes[i].getAttribute('data-cbottom') || 0);
    // 严格相交：贴边（上一主题的底 = 视口顶）不算「正在看」
    var inView = cbottom > top && ctop < bottom;
    dashes[i].classList.toggle('in-view', inView);
    if (inView) {
      var y = parseFloat(dashes[i].style.top) || 0;
      if (firstY === null) firstY = y;
      lastY = y;
    }
  }
  // 高亮带贴着刻度尺的格子走：范围就是「在看的这几横」，不再用另一套比例尺
  if (firstY !== null) {
    p.viewport.style.top = Math.round(firstY - 3) + 'px';
    p.viewport.style.height = Math.max(AIAS_MM_LINE + 6, Math.round(lastY - firstY + AIAS_MM_LINE + 6)) + 'px';
  } else {
    p.viewport.style.top = Math.round(top * _aiasMm.scale) + 'px';
    p.viewport.style.height = Math.max(10, Math.round(visible * _aiasMm.scale)) + 'px';
  }
  if (_aiasMm.tipIdx !== null) {
    var anchor = aiasMmDashAt(dashes, _aiasMm.tipIdx);
    if (anchor) aiasMmPositionTip(anchor); else aiasMmHideTip();
  }
}

function aiasMmPositionTip(dash) {
  var p = aiasMmParts();
  if (!p.tip || !p.bar) return;
  var barH = p.bar.clientHeight || 0;
  var tipH = p.tip.offsetHeight || 26;
  var anchorTop = parseFloat(dash.style.top) || 0;
  var want = anchorTop - tipH / 2 + 1;
  // 只改 top，位移交给 CSS 过渡：鼠标在横之间滑动时浮层是滑过去的，不是跳过去的
  p.tip.style.top = Math.round(Math.min(Math.max(want, AIAS_MM_MARGIN),
    Math.max(AIAS_MM_MARGIN, barH - tipH - AIAS_MM_MARGIN))) + 'px';
}

// 浮出某一横（主题）的名字
function aiasMmShowTip(idx) {
  var p = aiasMmParts();
  if (!p.tip || !p.bar || p.bar.hidden) return;
  var dash = aiasMmDashAt(p.blocks.children, idx);
  if (!dash) { aiasMmHideTip(); return; }
  var key = String(idx);
  var dashes = p.blocks.children;
  for (var i = 0; i < dashes.length; i++) {
    dashes[i].classList.toggle('active', dashes[i].getAttribute('data-idx') === key);
  }
  if (_aiasMm.tipIdx !== key) {
    _aiasMm.tipIdx = key;
    p.tip.setAttribute('data-kind', dash.getAttribute('data-kind'));
    p.tip.innerHTML = '<span class="aias-mm-tip-dot"></span>'
      + '<span class="aias-mm-tip-text">' + escHtml(dash.getAttribute('data-topic') || '') + '</span>'
      + '<span class="aias-mm-tip-meta">' + escHtml(aiasMmKindLabel(dash.getAttribute('data-kind')))
      + ' · ' + escHtml(dash.getAttribute('data-pos') || '') + '</span>';
    p.tip.hidden = false;
    p.tip.classList.add('show');
  }
  aiasMmPositionTip(dash);
}

// 某条消息所属主题的浮层（Alt+↑↓ 逐条跳也要浮出它在聊的那个主题）
function aiasMmShowTipForMessage(msgIdx) {
  var anchor = _aiasMm.dashByMsg[String(msgIdx)];
  aiasMmShowTip(anchor === undefined ? msgIdx : anchor);
}

function aiasMmHideTip() {
  var p = aiasMmParts();
  _aiasMm.tipIdx = null;
  if (_aiasMm.tipTimer) { clearTimeout(_aiasMm.tipTimer); _aiasMm.tipTimer = null; }
  if (p.tip) { p.tip.hidden = true; p.tip.classList.remove('show'); }
  if (p.blocks) {
    var dashes = p.blocks.children;
    for (var i = 0; i < dashes.length; i++) dashes[i].classList.remove('active');
  }
}

// 指针没正好压在一横上时，找最近的一横（±9px 内仍算指着它）
function aiasMmIdxAtY(clientY) {
  var p = aiasMmParts();
  if (!p.bar || !p.blocks) return null;
  var rect = p.bar.getBoundingClientRect();
  var y = clientY - rect.top;
  var dashes = p.blocks.children;
  var best = null;
  var bestGap = AIAS_MM_HIT_SLACK + 1;
  for (var i = 0; i < dashes.length; i++) {
    var gap = Math.abs((parseFloat(dashes[i].style.top) || 0) - y);
    if (gap < bestGap) { bestGap = gap; best = dashes[i]; }
  }
  return best && bestGap <= AIAS_MM_HIT_SLACK ? best.getAttribute('data-idx') : null;
}

// 跳到某个主题：顶部对齐（留 8px 让位），并闪一下描边确认落点
function aiasMmJumpTo(idx) {
  var p = aiasMmParts();
  if (!p.area) return;
  var el = p.area.querySelector('.aias-msg[data-idx="' + idx + '"]');
  if (!el) return;
  var target = p.area.scrollTop + el.getBoundingClientRect().top - p.area.getBoundingClientRect().top - 8;
  p.area.scrollTop = Math.max(0, target);
  aiasMmTakeOverScroll(p.area);
  el.classList.remove('aias-mm-flash');
  void el.offsetWidth;                    // 重启动画
  el.classList.add('aias-mm-flash');
  setTimeout(function () { el.classList.remove('aias-mm-flash'); }, 950);
  aiasUpdateMinimapViewport();
}

// 跳转/拖动后接管滚动跟随状态（否则流式更新会把视野抢回底部）
function aiasMmTakeOverScroll(area) {
  var atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 30;
  _aias.userScrolledUp = !atBottom;
  if (atBottom) aiasHideScrollPrompt();
}

// 按比例滚动（在细轨上按住拖动）
function aiasMmScrubToClientY(clientY) {
  var p = aiasMmParts();
  if (!p.area || !p.bar) return;
  var rect = p.bar.getBoundingClientRect();
  var ratio = (clientY - rect.top) / Math.max(1, rect.height);
  ratio = Math.min(1, Math.max(0, ratio));
  p.area.scrollTop = ratio * (p.area.scrollHeight - p.area.clientHeight);
  aiasMmTakeOverScroll(p.area);
  aiasUpdateMinimapViewport();
}

// 内容变化（流式渲染、结果回填、折叠展开）后重绘，200ms 尾部去抖
function aiasRebuildMinimap() {
  if (_aiasMm.rebuildTimer) clearTimeout(_aiasMm.rebuildTimer);
  _aiasMm.rebuildTimer = setTimeout(function () {
    _aiasMm.rebuildTimer = null;
    aiasRenderMinimap();
  }, 200);
}

function aiasToggleMinimap() {
  _aiasMm.enabled = !_aiasMm.enabled;
  try { localStorage.setItem(AIAS_MM_KEY, _aiasMm.enabled ? '1' : '0'); } catch (ignore) {}
  var p = aiasMmParts();
  if (p.button) {
    p.button.classList.toggle('aias-mm-off', !_aiasMm.enabled);
    p.button.setAttribute('aria-pressed', _aiasMm.enabled ? 'true' : 'false');
  }
  aiasRenderMinimap();
}

// Alt+↑/↓ 逐条消息跳转（不跟输入框的 Enter/Escape 抢键），并浮出所属主题
function aiasMmStepMessage(dir) {
  var p = aiasMmParts();
  if (!p.area) return false;
  var msgs = p.area.querySelectorAll('.aias-msg');
  if (!msgs.length) return false;
  var areaTop = p.area.getBoundingClientRect().top;
  var current = 0;
  for (var i = 0; i < msgs.length; i++) {
    if (msgs[i].getBoundingClientRect().top - areaTop < 12) current = i; else break;
  }
  var next = Math.min(Math.max(current + dir, 0), msgs.length - 1);
  var idx = msgs[next].getAttribute('data-idx');
  aiasMmJumpTo(idx);
  aiasMmShowTipForMessage(idx);
  if (_aiasMm.tipTimer) clearTimeout(_aiasMm.tipTimer);
  _aiasMm.tipTimer = setTimeout(function () {
    _aiasMm.tipTimer = null;
    aiasMmHideTip();
  }, AIAS_MM_TIP_MS);
  return true;
}

function aiasMmIndexOf(target, cls) {
  if (!target || !target.closest) return null;
  var hit = target.closest('.' + cls);
  return hit ? hit.getAttribute('data-idx') : null;
}

function aiasInitMinimap() {
  var p = aiasMmParts();
  if (!p.area || !p.bar || !p.blocks || _aiasMm.bound) return;
  _aiasMm.bound = true;
  try { _aiasMm.enabled = localStorage.getItem(AIAS_MM_KEY) !== '0'; } catch (ignore) {}
  if (p.button) {
    p.button.setAttribute('aria-pressed', _aiasMm.enabled ? 'true' : 'false');
    p.button.classList.toggle('aias-mm-off', !_aiasMm.enabled);
  }

  // 在一横上按下：记下目标，抬手时若没拖动就精确跳到那个主题。
  // 刻度只有 2px 高、档距 6px，只按元素命中会「点不到」——与悬停同一口径：
  // 先认按到的那一横，认不到就取最近的那一横（±9px 内）。
  p.bar.addEventListener('pointerdown', function (e) {
    if (p.bar.hidden) return;
    _aiasMm.dragging = true;
    _aiasMm.dragMoved = false;
    _aiasMm.startY = e.clientY;
    _aiasMm.activeIdx = aiasMmIndexOf(e.target, 'aias-mm-block');
    if (_aiasMm.activeIdx === null) _aiasMm.activeIdx = aiasMmIdxAtY(e.clientY);
    if (p.bar.setPointerCapture) { try { p.bar.setPointerCapture(e.pointerId); } catch (ignore) {} }
    e.preventDefault();
  });
  p.bar.addEventListener('pointermove', function (e) {
    if (p.bar.hidden) return;
    if (_aiasMm.dragging) {
      if (Math.abs(e.clientY - _aiasMm.startY) > 4) _aiasMm.dragMoved = true;
      if (_aiasMm.dragMoved) {
        aiasMmHideTip();
        aiasMmScrubToClientY(e.clientY);
      }
      return;
    }
    var idx = aiasMmIndexOf(e.target, 'aias-mm-block');
    if (idx === null) idx = aiasMmIdxAtY(e.clientY);
    if (idx === null) { aiasMmHideTip(); return; }
    aiasMmShowTip(idx);
  });
  window.addEventListener('pointerup', function () {
    if (!_aiasMm.dragging) return;
    _aiasMm.dragging = false;
    if (!_aiasMm.dragMoved) {
      // 点了一下（没拖动）：有对应主题就精确跳过去，落在空白就按比例滚到那一档
      if (_aiasMm.activeIdx !== null) aiasMmJumpTo(_aiasMm.activeIdx);
      else aiasMmScrubToClientY(_aiasMm.startY);
    }
    _aiasMm.activeIdx = null;
    _aiasMm.dragMoved = false;
  });
  p.bar.addEventListener('pointerleave', function () {
    if (!_aiasMm.dragging) aiasMmHideTip();
  });

  // 滚动（含程序滚动）同步可视区、提亮与浮层位置
  p.area.addEventListener('scroll', function () { aiasUpdateMinimapViewport(); }, { passive: true });
  window.addEventListener('resize', function () { aiasRebuildMinimap(); });
  document.addEventListener('keydown', function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || !_aiasMm.enabled) return;
    // 只在助手页、且细轨确实在用的时候接管方向键，别影响其他页面的原生滚动
    var active = (document.querySelector('.page.active') || {}).id || '';
    if (active !== 'page-ai-assistant' || p.bar.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); aiasMmStepMessage(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); aiasMmStepMessage(-1); }
  });

  // 键盘可达：Tab 进细轨后浮出当前正在看的主题，失焦收起
  p.bar.tabIndex = 0;
  p.bar.addEventListener('focus', function () {
    var inView = p.blocks.querySelector ? p.blocks.querySelector('.aias-mm-block.in-view') : null;
    if (inView) aiasMmShowTip(inView.getAttribute('data-idx'));
  });
  p.bar.addEventListener('blur', function () { aiasMmHideTip(); });

  // 消息区任何结构/文本变化（流式、结果回填、折叠）都触发去抖重绘
  if (window.MutationObserver) {
    var mo = new MutationObserver(function () { aiasRebuildMinimap(); });
    mo.observe(p.area, { childList: true, subtree: true, characterData: true });
  }
  // 会话列表悬浮/钉住/拖宽会改变正文宽度（刻度位置与让位距离都要跟着重算），
  // 这类尺寸变化不产生 DOM 变更，只能靠尺寸观察器兜住
  if (window.ResizeObserver && p.area) {
    var ro = new ResizeObserver(function () { aiasRebuildMinimap(); });
    ro.observe(p.area);
  }
  aiasRenderMinimap();
}

/* ════════════════════════════════════════════════════════════
   双击取词 · 同值高亮（Notepad++ 式）
   双击结果表里的一个值 → 把这个值在结果表中出现的位置全部标出来，
   给出「命中几处、分布在几张表」，↑↓ 逐处跳转，Esc 清除。

   为什么是这个做法而不是行转列对比：批量看几个库的同一条查询，真实动作是
   「这个对象/这个值在别的库上是多少」，双击取词一步到位，不必先定义对齐键、
   值列、差异口径那一整套；改动面小，读法也更接近编辑器里的肌肉记忆。

   三条实现约束（都为了不把现有界面搞坏）：
   · 只给单元格加/去 class，不动任何 innerHTML —— 表格 id、执行按钮、结果锚点、
     观察器全都原样保留（观察器只看 childList/characterData，改 class 不会触发重绘风暴）；
   · 匹配口径是「整格相等」而不是子串：搜 12 不能把 1234 或 ROWNUM 里的 12 一起点亮，
     误命中比不命中更害人；
   · 空值与界面控件的文字不当词（点「查看」不该去全表搜"查看"）。
   ════════════════════════════════════════════════════════════ */
var AIAS_HL_MAX = 500;          // 命中上限：再多就只标前这么多，避免大表卡顿
var AIAS_HL_TERM_MAX = 120;     // 词长上限
var _aiasHl = { term: '', ci: false, scope: 'all', hits: [], idx: -1, bar: null, onKey: null, lastCell: null };

/** 取要搜索的词：优先浏览器双击选中的那段，其次整格文本；控件标签返回空串。 */
function aiasHlTermFrom(cell, rawText) {
  var text = String(rawText == null ? (cell ? cell.textContent : '') : rawText).replace(/\s+/g, ' ').trim();
  if (!text || text === '—' || text === '-') return '';
  if (text.length > AIAS_HL_TERM_MAX) text = text.slice(0, AIAS_HL_TERM_MAX);
  if (cell) {
    var btns = cell.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var label = String(btns[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (label && label === text) return '';
    }
  }
  return text;
}

/** 高亮范围：默认整个消息区（跨库找同一个值本来就要跨表），可切到本条回答。 */
function aiasHlScopeEl(container, cell) {
  if (_aiasHl.scope === 'message' && cell) {
    var msg = cell.closest ? cell.closest('.aias-msg') : null;
    if (msg) return msg;
  }
  return container;
}

/**
 * 搜索根：表格被「⛶ 最大化」搬进全屏层后已经不在消息区里了，
 * 这时取词必须在同层里搜（含右侧明细），否则命中永远是 0。
 */
function aiasHlRootEl(container) {
  var cell = _aiasHl.lastCell;
  var ov = (cell && cell.closest) ? cell.closest('.aias-result-max-overlay') : null;
  return ov || container;
}

/** 在范围内按「整格相等」找同值单元格。 */
function aiasHlFind(scope, term) {
  var cells = Array.prototype.slice.call(scope.querySelectorAll('td, th'));
  var hit = [];
  for (var i = 0; i < cells.length; i++) {
    var text = String(cells[i].textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    var equal = _aiasHl.ci ? text.toLowerCase() === term.toLowerCase() : text === term;
    if (equal) hit.push(cells[i]);
    if (hit.length >= AIAS_HL_MAX) break;
  }
  return hit;
}

function aiasHlClearMarks() {
  var marked = document.querySelectorAll('.aias-hl-hit, .aias-hl-cur');
  for (var i = 0; i < marked.length; i++) marked[i].classList.remove('aias-hl-hit', 'aias-hl-cur');
  _aiasHl.hits = [];
  _aiasHl.idx = -1;
}

function aiasHlRemoveBar() {
  if (_aiasHl.bar && _aiasHl.bar.parentNode) _aiasHl.bar.parentNode.removeChild(_aiasHl.bar);
  _aiasHl.bar = null;
  if (_aiasHl.onKey) {
    document.removeEventListener('keydown', _aiasHl.onKey);
    _aiasHl.onKey = null;
  }
}

function aiasHlBarText() {
  var n = _aiasHl.hits.length;
  if (!n) return aiasT('webui.aias_hl_none', '没找到相同的值');
  var tables = [];
  _aiasHl.hits.forEach(function (cell) {
    var t = cell.closest ? cell.closest('table') : null;
    if (t && tables.indexOf(t) < 0) tables.push(t);
  });
  var text = aiasT('webui.aias_hl_hits', '命中 {n} 处 · 分布在 {m} 张表')
    .replace('{n}', n).replace('{m}', tables.length || 1);
  if (n >= AIAS_HL_MAX) {
    text += ' · ' + aiasT('webui.aias_hl_capped', '命中过多，仅标记前 {n} 处').replace('{n}', AIAS_HL_MAX);
  }
  return text;
}

function aiasHlUpdateBar() {
  if (!_aiasHl.bar) return;
  var label = _aiasHl.bar.querySelector('.aias-hl-term');
  var stat = _aiasHl.bar.querySelector('.aias-hl-count');
  if (label) label.textContent = _aiasHl.term;
  if (stat) stat.textContent = aiasHlBarText();
  var scopeBtn = _aiasHl.bar.querySelector('.aias-hl-scope');
  if (scopeBtn) {
    // 全屏层内范围切换没有意义（层里就是本次批量结果），直接收掉避免误导
    var inMax = !!(scopeBtn.closest && scopeBtn.closest('.aias-result-max-overlay'));
    scopeBtn.style.display = inMax ? 'none' : '';
    scopeBtn.textContent = _aiasHl.scope === 'message'
      ? aiasT('webui.aias_hl_scope_message', '本条回答')
      : aiasT('webui.aias_hl_scope_all', '全对话');
  }
  var caseBtn = _aiasHl.bar.querySelector('.aias-hl-case');
  if (caseBtn) caseBtn.classList.toggle('is-on', _aiasHl.ci);
  var pos = _aiasHl.bar.querySelector('.aias-hl-pos');
  if (pos) pos.textContent = _aiasHl.hits.length ? (_aiasHl.idx + 1) + ' / ' + _aiasHl.hits.length : '';
}

function aiasHlGo(delta) {
  if (!_aiasHl.hits.length) return;
  var cur = _aiasHl.hits[_aiasHl.idx];
  if (cur) cur.classList.remove('aias-hl-cur');
  // 到边界绕回：连按 ↓ 应该能循环看完所有命中，而不是停在最后一格没反应
  var next = _aiasHl.idx + delta;
  if (next >= _aiasHl.hits.length) next = 0;
  if (next < 0) next = _aiasHl.hits.length - 1;
  _aiasHl.idx = next;
  var cell = _aiasHl.hits[next];
  cell.classList.add('aias-hl-cur');
  if (cell.scrollIntoView) cell.scrollIntoView({ block: 'center', inline: 'nearest' });
  aiasHlUpdateBar();
}

function aiasHlShowBar() {
  var stream = document.getElementById('aias-stream');
  // 全屏层的 z-index 远高于消息区：条挂在消息区里会被整层盖住，
  // 所以取词发生在层内时，条必须挂在那一层里才看得见。
  var ov = (function () {
    var cell = _aiasHl.lastCell;
    return (cell && cell.closest) ? cell.closest('.aias-result-max-overlay') : null;
  })();
  var host = ov || stream;
  if (!host) return null;
  if (_aiasHl.bar && _aiasHl.bar.parentNode) _aiasHl.bar.parentNode.removeChild(_aiasHl.bar);
  var bar = document.createElement('div');
  bar.className = 'aias-hl-bar' + (ov ? ' is-in-max' : '');
  bar.innerHTML = '<span class="aias-hl-ico">⌕</span>'
    + '<span class="aias-hl-term"></span>'
    + '<span class="aias-hl-count"></span>'
    + '<span class="aias-hl-pos"></span>'
    + '<button class="aias-hl-btn aias-hl-prev" title="' + escHtml(aiasT('webui.aias_hl_prev', '上一处')) + '">↑</button>'
    + '<button class="aias-hl-btn aias-hl-next" title="' + escHtml(aiasT('webui.aias_hl_next', '下一处')) + '">↓</button>'
    + '<button class="aias-hl-btn aias-hl-case" title="' + escHtml(aiasT('webui.aias_hl_case', '区分大小写（点开则忽略）')) + '">Aa</button>'
    + '<button class="aias-hl-btn aias-hl-scope" title="' + escHtml(aiasT('webui.aias_hl_scope', '切换高亮范围')) + '"></button>'
    + '<button class="aias-hl-btn aias-hl-close" title="' + escHtml(aiasT('webui.aias_hl_close', '清除高亮（Esc）')) + '">✕</button>';
  host.appendChild(bar);
  _aiasHl.bar = bar;
  bar.querySelector('.aias-hl-prev').onclick = function () { aiasHlGo(-1); };
  bar.querySelector('.aias-hl-next').onclick = function () { aiasHlGo(1); };
  bar.querySelector('.aias-hl-case').onclick = function () { _aiasHl.ci = !_aiasHl.ci; aiasHlApply(); };
  bar.querySelector('.aias-hl-scope').onclick = function () {
    _aiasHl.scope = _aiasHl.scope === 'message' ? 'all' : 'message';
    aiasHlApply();
  };
  bar.querySelector('.aias-hl-close').onclick = function () { aiasHlDeactivate(); };
  return bar;
}

/** 重新计算命中并刷新状态条（换词/换范围/换大小写都走这里）。 */
function aiasHlApply() {
  var container = document.getElementById('aias-messages');
  if (!container || !_aiasHl.term) return;
  aiasHlClearMarks();
  var root = aiasHlRootEl(container);
  // 全屏层里「本条回答」没有意义（层内就是本次结果），范围固定在这一层
  var scope = root === container ? aiasHlScopeEl(container, _aiasHl.lastCell) : root;
  _aiasHl.hits = aiasHlFind(scope, _aiasHl.term);
  _aiasHl.hits.forEach(function (cell) { cell.classList.add('aias-hl-hit'); });
  aiasHlUpdateBar();
  if (_aiasHl.hits.length) aiasHlGo(1);
}

/** 进入高亮态：挂上 Esc 退出与 ↑↓ 跳转（输入框里的按键不抢）。 */
function aiasHlActivate(term, cell) {
  _aiasHl.term = term;
  _aiasHl.lastCell = cell || null;
  var bar = aiasHlShowBar();
  if (!bar) return;
  if (!_aiasHl.onKey) {
    _aiasHl.onKey = function (e) {
      if (!e) return;
      var tag = String((e.target && e.target.tagName) || '').toUpperCase();
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'Escape') {
        e.preventDefault();
        aiasHlDeactivate();
      }
      else if (typing) return;
      else if (e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'n' || e.key === 'N'))) { e.preventDefault(); aiasHlGo(1); }
      else if (e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'p' || e.key === 'P'))) { e.preventDefault(); aiasHlGo(-1); }
    };
    document.addEventListener('keydown', _aiasHl.onKey);
  }
  aiasHlApply();
}

function aiasHlDeactivate() {
  aiasHlClearMarks();
  aiasHlRemoveBar();
  _aiasHl.term = '';
}

function aiasInitValueHighlight() {
  var container = document.getElementById('aias-messages');
  var root = document.documentElement;
  if (!container || root.getAttribute('data-aias-hl') === '1') return;
  root.setAttribute('data-aias-hl', '1');
  // 委托挂在 document 上：整块重建（切会话、结果回填）都不必重新绑定，
  // 而且「⛶ 最大化」把表格搬进全屏层后它已经不在消息区里了 ——
  // 只绑消息容器会让全屏层里的取词失效，而那恰恰是最需要跨库比对的地方。
  document.addEventListener('dblclick', function (e) {
    var cell = e.target && e.target.closest ? e.target.closest('td, th') : null;
    if (!cell) return;
    var inStream = container.contains ? container.contains(cell) : false;
    var inMax = !!(cell.closest && cell.closest('.aias-result-max-overlay'));
    if (!inStream && !inMax) return;
    var sel = '';
    try { sel = String((window.getSelection && window.getSelection().toString()) || ''); } catch (ignore) {}
    var term = aiasHlTermFrom(cell, sel || null) || aiasHlTermFrom(cell, null);
    if (!term) return;
    aiasHlActivate(term, cell);
  });
}

/** 全屏层被关掉：挂在层里的高亮条会随层一起消失，状态必须一起收干净。 */
function aiasHlOverlayClosed(overlay) {
  try {
    if (!overlay || !_aiasHl.bar || !_aiasHl.bar.parentNode) return;
    if (overlay.contains && overlay.contains(_aiasHl.bar)) aiasHlDeactivate();
  } catch (e) {}
}
