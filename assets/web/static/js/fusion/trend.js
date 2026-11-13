/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * 历史趋势分析页面脚本（融合自 DBCheck v2.6 page-trends）
 * 只读：仅 GET /api/history_instances、/api/trend/analysis、
 *       /api/trend/metric/detail、/api/trend/metric/raw，不发任何写请求。
 *
 * 注意：index.html 里旧版趋势页已有 global let trendInstances，
 *      这里一律用 TR 前缀状态对象，避免重复声明导致整段脚本报错。
 */
(function () {
  'use strict';

  var TR = {
    instances: [],
    current: null,     // {db_type, host, port, label}
    analysis: null,
    filter: 'all',
    group: '',
    coverage: 'all',
    sort: 'smart',
    fold: false,
    foldedGroups: {},
    metric: null,      // 当前抽屉里的指标 key
    detail: null,
    raw: null,
    rawOffset: 0,
    rawLimit: 50,
    rawLoading: false,
    currentPoint: null, // {snapshotId, ts} 当前原数据对应的快照点
    sql: null
  };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtNum(v) {
    if (v === null || v === undefined || v === '') return '—';
    var n = Number(v);
    if (!isFinite(n)) return esc(v);
    if (Math.abs(n) >= 1000) return n.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
    if (Number.isInteger(n)) return String(n);
    return String(Math.round(n * 100) / 100);
  }

  // ────────────────────────────────────────────────────────
  //  实例列表
  // ────────────────────────────────────────────────────────
  window.loadTrendInstances = function () {
    var sel = $('trend-instance-select');
    if (sel) sel.innerHTML = '<option value="">-- 加载中 --</option>';
    fetch('/api/history_instances', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        TR.instances = (data && data.instances) || [];
        var sel2 = $('trend-instance-select');
        if (!sel2) return;
        if (!TR.instances.length) {
          sel2.innerHTML = '<option value="">-- 暂无历史实例 --</option>';
          trShowEmpty();
          return;
        }
        var prev = sel2.value;
        sel2.innerHTML = TR.instances.map(function (inst, i) {
          var label = (inst.label || inst.host || '') + '  ·  ' + (inst.db_type || '')
            + '  (' + inst.host + ':' + inst.port + ')  ·  ' + (inst.snapshot_count || 0) + ' 次';
          return '<option value="' + i + '">' + esc(label) + '</option>';
        }).join('');
        var idx = 0;
        if (prev !== '' && TR.instances[Number(prev)]) {
          idx = Number(prev);
        }
        sel2.value = String(idx);
        // 自动打开第一个实例，避免用户还要再点一次「查看趋势」
        window.loadTrendData();
      })
      .catch(function (e) {
        var sel3 = $('trend-instance-select');
        if (sel3) sel3.innerHTML = '<option value="">-- 加载失败 --</option>';
        trShowEmpty('实例列表加载失败：' + (e && e.message ? e.message : e));
      });
  };

  window.onTrendInstanceChange = function () { window.trendSelectInstance(); };
  window.trendSelectInstance = function () {
    trShowEmpty();
    window.loadTrendData();
  };

  function trShowEmpty(msg) {
    var empty = $('tr-empty');
    var content = $('tr-content');
    if (empty) {
      empty.style.display = 'block';
      var note = empty.querySelector('.tr-empty-note');
      if (note) {
        note.textContent = msg || '执行巡检后，同一个数据库（IP + 端口）的多次结果将在这里对比展示；数据不足时保持空态，不生成推测结论。';
      }
    }
    if (content) content.style.display = 'none';
  }

  // ────────────────────────────────────────────────────────
  //  主分析数据
  // ────────────────────────────────────────────────────────
  window.loadTrendData = function () {
    var sel = $('trend-instance-select');
    if (!sel || sel.value === '') { trShowEmpty(); return; }
    var inst = TR.instances[Number(sel.value)];
    if (!inst) { trShowEmpty(); return; }
    TR.current = inst;
    var days = ($('tr-days') && $('tr-days').value) || '0';
    var url = '/api/trend/analysis?db_type=' + encodeURIComponent(inst.db_type || '')
      + '&host=' + encodeURIComponent(inst.host || '')
      + '&port=' + encodeURIComponent(inst.port || '')
      + '&days=' + encodeURIComponent(days);

    fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) {
          trShowEmpty('趋势数据加载失败：' + ((data && (data.error || data.msg)) || '未知错误'));
          return;
        }
        var a = data.analysis || {};
        TR.analysis = a;
        if (!a.snapshots_count) {
          trShowEmpty('该实例在所选时间窗口内没有快照数据。完成一次巡检后即可看到趋势。');
          return;
        }
        $('tr-empty').style.display = 'none';
        $('tr-content').style.display = 'block';
        trRenderAll(a);
      })
      .catch(function (e) {
        trShowEmpty('趋势数据加载失败：' + (e && e.message ? e.message : e));
      });
  };

  function trRenderAll(a) {
    trRenderVerdict(a.summary || {});
    trRenderStats(a);
    trRenderIssues(a.issues || []);
    trRenderHealthRisk(a);
    trBuildGroupOptions(a);
    window.trendRenderMetrics();
  }

  // ────────────────────────────────────────────────────────
  //  健康评分 / 风险项数量 双轴折线（纯 SVG，无第三方依赖）
  // ────────────────────────────────────────────────────────
  function trRenderHealthRisk(a) {
    var box = $('tr-hr-chart');
    var badge = $('tr-hr-latest');
    if (!box) return;
    var labels = a.labels || [];
    var hs = (a.health_scores || []).map(function (v) { return v == null ? null : Number(v); });
    var rc = (a.risk_counts || []).map(function (v) { return v == null ? null : Number(v); });
    if (badge) {
      var lastH = null, lastR = null;
      for (var i = hs.length - 1; i >= 0; i--) { if (hs[i] != null) { lastH = hs[i]; break; } }
      for (var j = rc.length - 1; j >= 0; j--) { if (rc[j] != null) { lastR = rc[j]; break; } }
      badge.textContent = '最新 ' + (lastH == null ? '—' : fmtNum(lastH)) + ' 分 · ' + (lastR == null ? '—' : fmtNum(lastR)) + ' 项风险';
    }
    if (!labels.length) {
      box.innerHTML = '<div class="tr-empty-inline">窗口内没有可绘制的快照</div>';
      return;
    }
    var W = 900, H = 230, padL = 38, padR = 40, padT = 14, padB = 26;
    var n = labels.length;
    var xAt = function (i) { return padL + (n <= 1 ? (W - padL - padR) / 2 : i * (W - padL - padR) / (n - 1)); };
    var yH = function (v) { return padT + (100 - Math.max(0, Math.min(100, v))) / 100 * (H - padT - padB); };
    var maxR = 1;
    rc.forEach(function (v) { if (v != null && v > maxR) maxR = v; });
    var yR = function (v) { return padT + (1 - Math.max(0, Math.min(maxR, v)) / maxR) * (H - padT - padB); };

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" class="tr-hr-svg">';
    // 横向网格 + 左轴（健康分 0/50/100）
    [0, 50, 100].forEach(function (g) {
      var y = yH(g);
      svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="var(--border)" stroke-width="1"/>';
      svg += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="var(--text-muted)">' + g + '</text>';
    });
    // 右轴（风险项 0 / max）
    [0, maxR].forEach(function (g) {
      var y = yR(g);
      svg += '<text x="' + (W - padR + 6) + '" y="' + (y + 3) + '" font-size="10" fill="var(--text-muted)">' + g + '</text>';
    });

    function polyline(values, yFn, color) {
      var seg = [], pts = [];
      for (var i = 0; i < n; i++) {
        if (values[i] == null) { if (seg.length) { pts.push(seg); seg = []; } continue; }
        seg.push(xAt(i).toFixed(1) + ',' + yFn(values[i]).toFixed(1));
      }
      if (seg.length) pts.push(seg);
      var out = '';
      pts.forEach(function (p) {
        out += '<polyline fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="' + p.join(' ') + '"/>';
      });
      return out;
    }
    svg += polyline(hs, yH, 'var(--sky)');
    svg += polyline(rc, yR, 'var(--danger)');

    // 最新点标记
    for (var k = n - 1; k >= 0; k--) {
      if (hs[k] != null) { svg += '<circle cx="' + xAt(k) + '" cy="' + yH(hs[k]) + '" r="3" fill="var(--sky)"/>'; break; }
    }
    for (var q = n - 1; q >= 0; q--) {
      if (rc[q] != null) { svg += '<circle cx="' + xAt(q) + '" cy="' + yR(rc[q]) + '" r="3" fill="var(--danger)"/>'; break; }
    }

    // x 轴：首 / 中 / 尾
    var xi = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
    xi.forEach(function (i) {
      var t = String(labels[i] || '').replace('T', ' ');
      var anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
      svg += '<text x="' + xAt(i) + '" y="' + (H - 8) + '" text-anchor="' + anchor + '" font-size="10" fill="var(--text-muted)">' + esc(t.slice(5, 16)) + '</text>';
    });
    svg += '</svg>';
    box.innerHTML = svg;
  }

  function trRenderVerdict(s) {
    var box = $('tr-verdict');
    if (!box) return;
    var map = {
      worsening: { icon: '📉', title: '趋势恶化' },
      attention: { icon: '⚠️', title: '需要关注' },
      improving: { icon: '📈', title: '趋势改善' },
      stable: { icon: '📊', title: '整体平稳' }
    };
    var v = map[s.verdict] || map.stable;
    box.className = 'tr-verdict ' + (s.verdict || 'stable');
    box.innerHTML = '<div class="tr-verdict-icon">' + v.icon + '</div>'
      + '<div class="tr-verdict-main">'
      + '<div class="tr-verdict-title">' + esc(v.title) + '</div>'
      + '<div class="tr-verdict-reason">' + esc(s.verdict_reason || '') + '</div>'
      + '</div>'
      + '<div class="tr-verdict-badge ' + esc(s.verdict || 'stable') + '">' + esc(v.title) + '</div>';
  }

  function trRenderStats(a) {
    var s = a.summary || {};
    var hs = s.last_health_score;
    var items = [
      { icon: '🗂️', num: a.snapshots_count || 0, label: '窗口内快照' },
      { icon: '💚', num: hs === null || hs === undefined ? '—' : fmtNum(hs), label: '最新健康评分' },
      { icon: '🆕', num: s.new_count || 0, label: '新增异常' },
      { icon: '✅', num: s.resolved_count || 0, label: '已消除异常' }
    ];
    var box = $('tr-stats');
    if (!box) return;
    box.innerHTML = items.map(function (it) {
      return '<div class="tr-stat">'
        + '<div class="tr-stat-icon">' + it.icon + '</div>'
        + '<div><div class="tr-stat-num">' + esc(it.num) + '</div>'
        + '<div class="tr-stat-label">' + esc(it.label) + '</div></div>'
        + '</div>';
    }).join('');
  }

  // ────────────────────────────────────────────────────────
  //  指标注册表
  // ────────────────────────────────────────────────────────
  window.trendSetFilter = function (f) {
    TR.filter = f || 'all';
    var tabs = document.querySelectorAll('#tr-filter-tabs .tr-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-filter') === TR.filter);
    }
    window.trendRenderMetrics();
  };

  function trMetricList() {
    var a = TR.analysis || {};
    var metrics = a.metrics || {};
    var out = [];
    Object.keys(metrics).forEach(function (k) {
      var m = metrics[k];
      if (!m || m.no_data) return;
      out.push(m);
    });
    return out;
  }

  function trPassFilter(m) {
    if (TR.filter === 'anomaly') return !!m.anomaly;
    if (TR.filter === 'changed') return !!m.has_variance && m.status !== 'stable' && m.status !== 'unknown';
    if (TR.filter === 'primary') return !!m.primary;
    return true;
  }

  window.trendSetGroup = function (g) {
    TR.group = g || '';
    window.trendRenderMetrics();
  };
  window.trendSetCoverage = function (c) {
    TR.coverage = c === 'full' ? 'full' : 'all';
    window.trendRenderMetrics();
  };
  window.trendSetSort = function (s) {
    TR.sort = (s === 'change' || s === 'name') ? s : 'smart';
    window.trendRenderMetrics();
  };
  window.trendToggleFold = function () {
    TR.fold = !TR.fold;
    TR.foldedGroups = {};
    var btn = $('tr-metric-fold');
    if (btn) btn.textContent = TR.fold ? '展开分组' : '折叠分组';
    window.trendRenderMetrics();
  };
  window.trendToggleGroup = function (name) {
    TR.foldedGroups[name] = !TR.foldedGroups[name];
    window.trendRenderMetrics();
  };

  function trBuildGroupOptions(a) {
    var sel = $('tr-metric-group');
    if (!sel) return;
    var metrics = (a && a.metrics) || {};
    var labels = {};
    Object.keys(metrics).forEach(function (k) {
      var m = metrics[k];
      if (!m || m.no_data) return;
      var g = m.group_label || '其他';
      labels[g] = (labels[g] || 0) + 1;
    });
    var html = '<option value="">全部分组</option>';
    Object.keys(labels).forEach(function (g) {
      html += '<option value="' + esc(g) + '"' + (TR.group === g ? ' selected' : '') + '>' + esc(g) + ' (' + labels[g] + ')</option>';
    });
    sel.innerHTML = html;
    sel.value = TR.group;
  }

  function trSpark(values, color) {
    var nums = [];
    for (var i = 0; i < values.length; i++) {
      if (values[i] !== null && values[i] !== undefined) nums.push(Number(values[i]));
    }
    if (!nums.length) return '';
    var w = 96, h = 34, pad = 4;
    var min = Math.min.apply(null, nums);
    var max = Math.max.apply(null, nums);
    var span = (max - min) || 1;
    var n = values.length;
    var pts = [];
    for (var j = 0; j < n; j++) {
      var v = values[j];
      var x = n <= 1 ? w / 2 : pad + j * (w - 2 * pad) / (n - 1);
      var y = h - pad - (((v === null || v === undefined) ? min : Number(v)) - min) / span * (h - 2 * pad);
      pts.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    var last = pts[pts.length - 1].split(',');
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">'
      + '<polyline fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" points="' + pts.join(' ') + '"/>'
      + '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2.4" fill="' + color + '"/>'
      + '</svg>';
  }

  function trStatusColor(m) {
    if (m.anomaly) return 'var(--danger)';
    if (m.status === 'improving') return 'var(--success)';
    if (m.status === 'worsening') return 'var(--danger)';
    if (m.status === 'stable') return 'var(--sky)';
    return 'var(--accent)';
  }

  function trDeltaHtml(m) {
    var d = m.delta;
    if (d === null || d === undefined) return '<div class="tr-metric-delta flat">—</div>';
    var n = Number(d);
    if (Math.abs(n) < 1e-9) return '<div class="tr-metric-delta flat">— 持平</div>';
    var arrow = n > 0 ? '▲' : '▼';
    var suffix = m.unit ? (' ' + m.unit) : '';
    var cls = 'flat';
    if (m.direction === 'up_good') cls = n > 0 ? 'up-good' : 'down-bad';
    else if (m.direction === 'up_bad') cls = n > 0 ? 'up-bad' : 'down-good';
    return '<div class="tr-metric-delta ' + cls + '">' + arrow + ' ' + fmtNum(Math.abs(n)) + suffix + '</div>';
  }

  function trBadgeHtml(m) {
    if (m.breaching_now) {
      var crit = (m.crit !== null && m.crit !== undefined
        && ((m.direction === 'up_good') ? m.latest <= m.crit : m.latest >= m.crit));
      return '<span class="tr-badge ' + (crit ? 'critical' : 'high') + '">' + (crit ? '严重超标' : '超出警戒') + '</span>';
    }
    if (m.anomaly) return '<span class="tr-badge high">恶化</span>';
    if (m.status === 'improving') return '<span class="tr-badge improving">改善</span>';
    if (m.status === 'worsening') return '<span class="tr-badge worsening">恶化</span>';
    if (m.status === 'stable') return '<span class="tr-badge stable">平稳</span>';
    if (m.status === 'rising') return '<span class="tr-badge medium">上升</span>';
    if (m.status === 'falling') return '<span class="tr-badge low">下降</span>';
    return '<span class="tr-badge stable">样本不足</span>';
  }

  window.trendRenderMetrics = function () {
    var box = $('tr-metric-list');
    var countEl = $('tr-metric-count');
    var noteEl = $('tr-metric-note');
    if (!box) return;
    var kw = (($('tr-metric-search') || {}).value || '').trim().toLowerCase();
    var rows = trMetricList().filter(function (m) {
      if (!trPassFilter(m)) return false;
      if (TR.group && (m.group_label || '其他') !== TR.group) return false;
      if (TR.coverage === 'full' && m.partial) return false;
      if (kw && String(m.label || '').toLowerCase().indexOf(kw) < 0
        && String(m.key || '').toLowerCase().indexOf(kw) < 0) return false;
      return true;
    });
    if (countEl) countEl.textContent = String(rows.length);

    // 排序：智能（主要指标优先+变化幅度）/ 按变化幅度 / 按名称
    if (TR.sort === 'name') {
      rows.sort(function (a, b) { return String(a.label || '').localeCompare(String(b.label || '')); });
    } else if (TR.sort === 'change') {
      rows.sort(function (a, b) {
        return Math.abs(Number(b.change_pct) || 0) - Math.abs(Number(a.change_pct) || 0);
      });
    } else {
      rows.sort(function (a, b) {
        var pa = a.primary ? 1 : 0, pb = b.primary ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return (b.significance || 0) - (a.significance || 0);
      });
    }

    if (noteEl) {
      if (TR.fold) {
        noteEl.style.display = 'block';
        noteEl.textContent = '已折叠分组：点击分组标题可单独展开，再点「展开分组」恢复全部。';
      } else {
        noteEl.style.display = 'none';
        noteEl.textContent = '';
      }
    }

    if (!rows.length) {
      box.innerHTML = '<div class="tr-empty-inline">当前筛选条件下没有指标</div>';
      return;
    }

    // 按分组切块，分组标题可点击折叠
    var groups = {}, order = [];
    rows.forEach(function (m) {
      var g = m.group_label || '其他';
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(m);
    });

    var html = '';
    order.forEach(function (g) {
      var collapsed = TR.fold || !!TR.foldedGroups[g];
      html += '<div class="tr-group' + (collapsed ? ' collapsed' : '') + '">'
        + '<div class="tr-group-title" onclick="trendToggleGroup(\'' + esc(g).replace(/'/g, "\\'") + '\')">'
        + '<span class="tr-group-caret">▾</span>' + esc(g)
        + ' <span class="tr-pill">' + groups[g].length + '</span></div>'
        + '<div class="tr-group-body">';
      groups[g].forEach(function (m) {
        var coverage = '';
        if (m.partial) {
          coverage = '<span style="color:var(--warning)">覆盖 ' + m.coverage + '/' + (m.coverage + m.missing_points) + '</span>';
        }
        var subParts = [];
        if (m.discovered) subParts.push('自动发现');
        if (coverage) subParts.push(coverage);
        var sub = subParts.length ? '<div class="tr-metric-sub">' + subParts.join(' · ') + '</div>' : '';

        html += '<div class="tr-metric' + (m.anomaly ? ' is-anomaly' : '') + '"'
          + ' data-key="' + esc(m.key) + '" onclick="trendOpenDrawer(\'' + esc(m.key).replace(/'/g, "\\'") + '\')">'
          + '<div class="tr-metric-main">'
          + '<div class="tr-metric-label">' + esc(m.label) + ' ' + trBadgeHtml(m) + '</div>'
          + sub
          + '</div>'
          + '<div class="tr-spark">' + trSpark(m.values || [], trStatusColor(m)) + '</div>'
          + '<div class="tr-metric-value">'
          + '<div class="tr-metric-num">' + fmtNum(m.latest) + (m.unit ? '<span class="tr-unit">' + esc(m.unit) + '</span>' : '') + '</div>'
          + trDeltaHtml(m)
          + '</div>'
          + '</div>';
      });
      html += '</div></div>';
    });
    box.innerHTML = html;
  };

  // ────────────────────────────────────────────────────────
  //  异常生命周期
  // ────────────────────────────────────────────────────────
  function trRenderIssues(issues) {
    var box = $('tr-issue-list');
    var countEl = $('tr-issue-count');
    if (countEl) countEl.textContent = String(issues.length);
    if (!box) return;
    if (!issues.length) {
      box.innerHTML = '<div class="tr-empty-inline">窗口内没有检测到异常项</div>';
      return;
    }
    var statusText = { new: '新增', persistent: '持续', resolved: '已消除' };
    var levelCls = { '高': 'critical', '中': 'high', '低': 'medium' };
    box.innerHTML = issues.map(function (it) {
      var st = it.status || 'persistent';
      var fix = it.fix_sql
        ? '<div class="tr-issue-fix" onclick="trendToggleFix(this)">查看修复 SQL ▾</div>'
          + '<div class="tr-issue-sql">' + esc(it.fix_sql) + '</div>'
        : '';
      return '<div class="tr-issue ' + esc(st) + '">'
        + '<div class="tr-issue-head">'
        + '<span class="tr-issue-name">' + esc(it.name || it.topic) + '</span>'
        + '<span class="tr-badge ' + esc(levelCls[it.level] || 'medium') + '">' + esc(it.level || '—') + '风险</span>'
        + '<span class="tr-badge ' + (st === 'new' ? 'critical' : st === 'resolved' ? 'low' : 'high') + '">' + esc(statusText[st] || st) + '</span>'
        + '</div>'
        + '<div class="tr-issue-meta">命中 ' + (it.total_hits || 0) + ' 次 · 最近连续 ' + (it.streak || 0) + ' 次'
        + ' · ' + esc((it.first_ts || '').replace('T', ' ')) + ' → ' + esc((it.last_ts || '').replace('T', ' ')) + '</div>'
        + (it.description ? '<div class="tr-issue-desc">' + esc(it.description) + '</div>' : '')
        + fix
        + '</div>';
    }).join('');
  }

  window.trendToggleFix = function (el) {
    var sql = el.nextElementSibling;
    if (!sql) return;
    var open = sql.style.display === 'block';
    sql.style.display = open ? 'none' : 'block';
    el.textContent = open ? '查看修复 SQL ▾' : '收起修复 SQL ▴';
  };

  // ────────────────────────────────────────────────────────
  //  溯源抽屉
  // ────────────────────────────────────────────────────────
  window.trendOpenDrawer = function (key) {
    var a = TR.analysis || {};
    var m = (a.metrics || {})[key];
    if (!m || !TR.current) return;
    TR.metric = m;
    TR.detail = null;
    TR.raw = null;
    TR.currentPoint = null;
    TR.rawOffset = 0;
    TR.rawLoading = false;
    TR.sql = null;

    var mask = $('tr-drawer-mask');
    if (mask) mask.classList.add('open');
    var t = $('tr-drawer-title');
    if (t) t.textContent = m.label || key;
    var sub = $('tr-drawer-sub');
    if (sub) {
      sub.textContent = (TR.current.label || TR.current.host) + ' · ' + TR.current.host + ':'
        + TR.current.port + ' · 单位 ' + (m.unit || '—');
    }
    window.trendDrawerTab('raw');
    var lg = $('tr-lineage');
    if (lg) lg.innerHTML = '<div class="tr-empty-inline">加载血缘映射…</div>';
    var meta0 = $('tr-raw-meta');
    if (meta0) meta0.innerHTML = '<div class="tr-empty-inline">加载原数据…</div>';

    var url = '/api/trend/metric/detail?db_type=' + encodeURIComponent(TR.current.db_type || '')
      + '&host=' + encodeURIComponent(TR.current.host || '')
      + '&port=' + encodeURIComponent(TR.current.port || '')
      + '&key=' + encodeURIComponent(key)
      + '&days=' + encodeURIComponent(($('tr-days') && $('tr-days').value) || '90');
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) {
          if (lg) lg.innerHTML = '<div class="tr-empty-inline">血缘加载失败：' + esc((data && data.error) || '未知错误') + '</div>';
          return;
        }
        TR.detail = data.detail || {};
        trRenderLineage();
        trAutoLoadRaw();
      })
      .catch(function (e) {
        if (lg) lg.innerHTML = '<div class="tr-empty-inline">血缘加载失败：' + esc(e && e.message) + '</div>';
      });
  };

  function trRenderLineage() {
    var box = $('tr-lineage');
    var d = TR.detail || {};
    var pts = d.points || [];
    if (!box) return;
    if (!pts.length) {
      box.innerHTML = '<div class="tr-empty-inline">窗口内没有可溯源的快照点</div>';
      return;
    }
    var stats = d.stats || {};
    var head = '<div class="tr-raw-meta">'
      + '共 ' + (stats.total_points || pts.length) + ' 个点；'
      + '<span class="tr-raw-ok">精确命中 ' + (stats.matched_points || 0) + '</span> · '
      + '扁平兜底 ' + (stats.fallback_points || 0) + ' · '
      + '无来源 ' + (stats.no_source_points || 0)
      + '</div>';
    box.innerHTML = head + pts.slice().reverse().map(function (p) {
      var hit = p.hit || {};
      var src = hit.ref || hit.kind || '无来源';
      var detail = [];
      if (hit.column) detail.push('列 ' + hit.column);
      if (hit.agg) detail.push('口径 ' + hit.agg);
      if (hit.rows) detail.push('候选 ' + hit.rows + ' 行');
      if (hit.row_label) detail.push(String(hit.row_label));
      var can = hit.has_raw && hit.available && p.snapshot_id != null;
      return '<div class="tr-point" data-sid="' + esc(p.snapshot_id) + '">'
        + '<div class="tr-point-ts">' + esc((p.ts || '').replace('T', ' ')) + '</div>'
        + '<div class="tr-point-val">' + (p.missing ? '缺测' : fmtNum(p.value)) + '</div>'
        + '<div class="tr-point-src" title="' + esc((hit.ref || '') + (detail.length ? ' · ' + detail.join(' · ') : '')) + '">'
        + esc(src) + (detail.length ? ' · ' + esc(detail.join(' · ')) : '')
        + '</div>'
        + (can
          ? '<button class="tr-point-btn" onclick="trendLoadRaw(' + Number(p.snapshot_id) + ', 0)">原数据</button>'
          : '<button class="tr-point-btn" disabled title="该点没有可展开的原始数据">原数据</button>')
        + '</div>';
    }).join('');
  }

  /** 自动挑一个可展开的最近快照点加载原数据（页签默认「原数据」，不能是空白） */
  function trAutoLoadRaw() {
    if (TR.raw || TR.rawLoading || !TR.detail) return;
    var pts = (TR.detail.points || []).slice().reverse();
    for (var i = 0; i < pts.length; i++) {
      var hit = pts[i].hit || {};
      if (hit.has_raw && hit.available && pts[i].snapshot_id != null) {
        window.trendLoadRaw(pts[i].snapshot_id, 0);
        return;
      }
    }
    var meta = $('tr-raw-meta');
    if (meta) meta.innerHTML = '<div class="tr-empty-inline">该指标在窗口内没有可展开的原始数据</div>';
  }

  // ────────────────────────────────────────────────────────
  //  同点其他指标
  // ────────────────────────────────────────────────────────
  function trRenderSame() {
    var box = $('tr-same');
    if (!box) return;
    var a = TR.analysis || {};
    var ids = a.snapshot_ids || [];
    var p = TR.currentPoint;
    if (!p || p.snapshotId == null) {
      box.innerHTML = '<div class="tr-empty-inline">请先在「原数据」页签展开一个快照点，再查看该点的其他指标。</div>';
      return;
    }
    var idx = -1;
    for (var i = 0; i < ids.length; i++) {
      if (Number(ids[i]) === Number(p.snapshotId)) { idx = i; break; }
    }
    if (idx < 0) {
      box.innerHTML = '<div class="tr-empty-inline">当前快照点不在分析窗口内</div>';
      return;
    }
    var metrics = a.metrics || {};
    var rows = [];
    Object.keys(metrics).forEach(function (k) {
      var m = metrics[k];
      if (!m || m.no_data || !TR.metric || k === TR.metric.key) return;
      var v = (m.values || [])[idx];
      if (v === null || v === undefined) return;
      rows.push({ label: m.label || k, group: m.group_label || '其他', value: v, unit: m.unit || '' });
    });
    if (!rows.length) {
      box.innerHTML = '<div class="tr-empty-inline">该快照点没有其他可展示的指标</div>';
      return;
    }
    rows.sort(function (x, y) {
      return String(x.group).localeCompare(String(y.group)) || String(x.label).localeCompare(String(y.label));
    });
    var html = '<div class="tr-raw-meta">快照时间 ' + esc(String(p.ts || '').replace('T', ' ')) + ' · 共 ' + rows.length + ' 项</div>'
      + '<table><thead><tr><th>分组</th><th>指标</th><th>值</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      html += '<tr><td>' + esc(r.group) + '</td><td>' + esc(r.label) + '</td><td>'
        + fmtNum(r.value) + (r.unit ? ' ' + esc(r.unit) : '') + '</td></tr>';
    });
    html += '</tbody></table>';
    box.innerHTML = html;
  }

  window.trendDrawerTab = function (tab) {
    var tabs = document.querySelectorAll('.tr-drawer-tabs .tr-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === tab);
    }
    $('tr-lineage-wrap').style.display = tab === 'lineage' ? 'block' : 'none';
    $('tr-raw-wrap').style.display = tab === 'raw' ? 'block' : 'none';
    $('tr-sql-wrap').style.display = tab === 'sql' ? 'block' : 'none';
    var sameWrap = $('tr-same-wrap');
    if (sameWrap) sameWrap.style.display = tab === 'same' ? 'block' : 'none';

    // 切到「原数据」但还没加载过：自动取最近一个可展开的点，
    // 否则页签会是一片空白，用户还得先回血缘里找按钮。
    if (tab === 'raw') trAutoLoadRaw();
    if (tab === 'same') trRenderSame();
  };

  window.trendCloseDrawer = function (e) {
    // 只有点遮罩（或点关闭按钮）才关；抽屉内部点击被 stopPropagation 挡掉
    if (e && e.target && e.target !== e.currentTarget) return;
    var mask = $('tr-drawer-mask');
    if (mask) mask.classList.remove('open');
  };

  // ────────────────────────────────────────────────────────
  //  原数据
  // ────────────────────────────────────────────────────────
  window.trendLoadRaw = function (snapshotId, offset) {
    if (!TR.metric || !TR.current) return;
    offset = Number(offset || 0);
    if (offset < 0) offset = 0;
    TR.rawOffset = offset;
    TR.rawLoading = true;
    window.trendDrawerTab('raw');
    var meta = $('tr-raw-meta');
    var tbl = $('tr-raw-table');
    if (meta) meta.innerHTML = '加载原数据…';
    if (tbl) tbl.innerHTML = '';

    var url = '/api/trend/metric/raw?db_type=' + encodeURIComponent(TR.current.db_type || '')
      + '&host=' + encodeURIComponent(TR.current.host || '')
      + '&port=' + encodeURIComponent(TR.current.port || '')
      + '&key=' + encodeURIComponent(TR.metric.key)
      + '&snapshot_id=' + encodeURIComponent(snapshotId)
      + '&offset=' + offset + '&limit=' + TR.rawLimit + '&with_sql=1';
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) {
          TR.rawLoading = false;
          if (meta) meta.innerHTML = '<span class="tr-raw-bad">原数据加载失败：' + esc((data && data.error) || '未知错误') + '</span>';
          return;
        }
        TR.raw = data;
        TR.rawLoading = false;
        TR.sql = data.sql || null;
        trRenderRaw(data);
      })
      .catch(function (e) {
        TR.rawLoading = false;
        if (meta) meta.innerHTML = '<span class="tr-raw-bad">原数据加载失败：' + esc(e && e.message) + '</span>';
      });
  };

  function trRawCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch (err) { return String(v); }
    }
    return String(v);
  }

  function trRenderRaw(data) {
    var meta = $('tr-raw-meta');
    var tbl = $('tr-raw-table');
    var raw = data.raw || {};
    var verify = data.verify || {};
    var report = data.report;
    TR.currentPoint = { snapshotId: data.snapshot_id, ts: data.ts };
    var sameWrap = $('tr-same-wrap');
    if (sameWrap && sameWrap.style.display !== 'none') trRenderSame();

    var metaParts = [];
    metaParts.push('快照时间 ' + esc((data.ts || '').replace('T', ' ')));
    metaParts.push('展示值 ' + fmtNum(data.value));
    if (verify.recomputed !== null && verify.recomputed !== undefined) {
      metaParts.push('独立复算 ' + fmtNum(verify.recomputed));
      metaParts.push(verify.ok ? '<span class="tr-raw-ok">✔ 一致</span>' : '<span class="tr-raw-bad">✘ 不一致</span>');
    }
    if (data.engine) metaParts.push('采集器 ' + esc(data.engine));
    if (data.template_id !== null && data.template_id !== undefined) metaParts.push('模板 #' + esc(data.template_id));
    if (report && report.file) {
      metaParts.push(report.exists
        ? '<a href="/api/download_file?name=' + encodeURIComponent(report.file) + '" style="color:var(--sky)">下载报告</a>'
        : '报告已删除');
    }
    if (raw.collect_error) metaParts.push('<span class="tr-raw-bad">采集错误：' + esc(raw.collect_error) + '</span>');
    if (meta) meta.innerHTML = metaParts.join(' · ');

    // table / issues / text 都是「列 + 行」结构，统一走表格渲染；
    // 只有 scalar 是「字段 → 值」两列语义，单独处理
    if (raw.view !== 'scalar' && raw.columns && raw.columns.length && raw.rows) {
      var cols = raw.columns || [];
      var rows = raw.rows || [];
      var hi = raw.highlight_row;
      var hc = raw.highlight_col;
      var total = raw.total || rows.length;
      var start = TR.rawOffset || 0;
      var html = '<table><thead><tr><th>#</th>';
      cols.forEach(function (c) { html += '<th>' + esc(c) + '</th>'; });
      html += '</tr></thead><tbody>';
      rows.forEach(function (row, i) {
        var absIdx = start + i;
        var hit = (hi !== null && hi !== undefined && Number(hi) === absIdx);
        html += '<tr class="' + (hit ? 'hit' : '') + '"><td>' + (absIdx + 1) + '</td>';
        for (var c = 0; c < cols.length; c++) {
          var cellHit = hit && hc !== null && hc !== undefined && Number(hc) === c;
          html += '<td' + (cellHit ? ' style="outline:2px solid var(--accent);outline-offset:-2px"' : '') + '>'
            + esc(trRawCell(row[c])) + '</td>';
        }
        html += '</tr>';
      });
      html += '</tbody></table>';
      if (tbl) tbl.innerHTML = html;

      // 分页
      if (total > TR.rawLimit) {
        var end = Math.min(start + rows.length, total);
        var pager = '<div class="tr-raw-meta" style="margin-top:10px">'
          + '第 ' + (start + 1) + '–' + end + ' 行 / 共 ' + total + ' 行 '
          + (start > 0 ? '<button class="tr-point-btn" onclick="trendLoadRaw(' + Number(data.snapshot_id) + ',' + Math.max(0, start - TR.rawLimit) + ')">上一页</button> ' : '')
          + (end < total ? '<button class="tr-point-btn" onclick="trendLoadRaw(' + Number(data.snapshot_id) + ',' + end + ')">下一页</button>' : '')
          + '</div>';
        if (meta) meta.innerHTML += pager;
      }
    } else if (raw.view === 'scalar') {
      var rows2 = raw.rows || [];
      var h = '<table><thead><tr><th>字段</th><th>值</th></tr></thead><tbody>';
      rows2.forEach(function (r) {
        var k = Array.isArray(r) ? r[0] : (r && r.key);
        var v = Array.isArray(r) ? r[1] : (r && r.value);
        h += '<tr><td>' + esc(trRawCell(k)) + '</td><td>' + esc(trRawCell(v)) + '</td></tr>';
      });
      h += '</tbody></table>';
      if (tbl) tbl.innerHTML = h;
    } else {
      if (tbl) tbl.innerHTML = '<div class="tr-empty-inline">该指标没有可展示的原始数据'
        + (raw.note ? '（' + esc(raw.note) + '）' : '') + '</div>';
    }

    var pre = $('tr-sql');
    if (pre) {
      pre.textContent = data.sql && data.sql.query_sql
        ? data.sql.query_sql
        : '该指标未关联到采集 SQL（可能来自系统层采集或派生计算）。';
    }
  }

  // ────────────────────────────────────────────────────────
  //  首次进入
  // ────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if ($('page-trend') && $('page-trend').classList.contains('active')) {
        window.loadTrendInstances();
      }
    });
  }
})();
