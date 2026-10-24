/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
 * Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
 *
 * Fusion page logic: notification settings.
 * Layout and UX adapted from DBCheck v2.6 (MIT License,
 * Copyright (c) 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>),
 * rewritten for the RaccoonX module layout.
 * Keeps the existing RaccoonX API contract and adds the v2.6 layout's
 * tab behaviour, CC field, and status messages.
 */
(function () {
  'use strict';

  function t(key, fallback) {
    try {
      if (typeof window.i18n === 'function') {
        var v = window.i18n(key);
        if (v && v !== key) return v;
      }
    } catch (e) { /* ignore i18n errors */ }
    return fallback || key;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function splitList(value) {
    return String(value || '')
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function normalizeList(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    return splitList(value);
  }

  function setMsg(id, text, ok) {
    var el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.style.color = ok ? 'var(--success, #00C8A0)' : 'var(--danger, #EF4444)';
  }

  function setStatus(id, configured) {
    var el = $(id);
    if (!el) return;
    el.textContent = configured
      ? t('webui.email_status_ok', '已配置')
      : t('webui.email_status_fail', '未配置');
  }

  function emailPayload() {
    return {
      host: ($('smtp-host') || {}).value || '',
      port: parseInt(($('smtp-port') || {}).value, 10) || 587,
      user: ($('smtp-user') || {}).value || '',
      password: ($('smtp-password') || {}).value || '',
      use_tls: !!($('smtp-tls') && $('smtp-tls').checked),
      recipients: splitList(($('smtp-recipients') || {}).value),
      cc: splitList(($('smtp-cc') || {}).value)
    };
  }

  function webhookPayload() {
    return {
      type: ($('webhook-type') || {}).value || 'custom',
      url: ($('webhook-url') || {}).value || '',
      proxy: ($('webhook-proxy') || {}).value || '',
      ca_cert: ($('webhook-ca-cert') || {}).value || '',
      verify_ssl: !!($('webhook-verify-ssl') && $('webhook-verify-ssl').checked),
      secret: ($('webhook-secret') || {}).value || '',
      at_mobiles: splitList(($('dingtalk-phones') || {}).value),
      is_at_all: false
    };
  }

  function onWebhookTypeChange() {
    var typeEl = $('webhook-type');
    var type = typeEl ? typeEl.value : 'custom';
    var secretWrap = $('webhook-secret-wrap');
    var dingtalkWrap = $('dingtalk-at-wrap');
    if (secretWrap) secretWrap.style.display = (type === 'wecom' || type === 'dingtalk') ? 'block' : 'none';
    if (dingtalkWrap) dingtalkWrap.style.display = type === 'dingtalk' ? 'block' : 'none';
  }

  function switchTab(tab) {
    var keys = ['email', 'daily', 'webhook'];
    if (keys.indexOf(tab) === -1) tab = 'email';
    keys.forEach(function (key) {
      var isActive = key === tab;
      var tabEl = $('notify-tab-' + key);
      var panelEl = $('notify-panel-' + key);
      if (tabEl) {
        tabEl.classList.toggle('active', isActive);
        tabEl.setAttribute('aria-selected', isActive ? 'true' : 'false');
      }
      if (panelEl) panelEl.classList.toggle('active', isActive);
    });
  }

  async function load() {
    try {
      var res = await fetch('/api/notifier/config', { credentials: 'same-origin' });
      var data = await res.json();
      if (!data || !data.ok) {
        setMsg('email-msg', (data && data.error) || '加载通知配置失败', false);
        return;
      }
      var cfg = data.config || {};
      var email = cfg.email || {};
      if ($('smtp-host')) $('smtp-host').value = email.host || '';
      if ($('smtp-port')) $('smtp-port').value = email.port || 587;
      if ($('smtp-user')) $('smtp-user').value = email.user || '';
      if ($('smtp-password')) {
        $('smtp-password').value = (email.password && email.password !== '***') ? email.password : '';
      }
      if ($('smtp-recipients')) $('smtp-recipients').value = normalizeList(email.recipients).join(', ');
      if ($('smtp-cc')) $('smtp-cc').value = normalizeList(email.cc).join(', ');
      if ($('smtp-tls')) $('smtp-tls').checked = email.use_tls !== false;
      setStatus('email-status', !!email.host);

      var webhook = cfg.webhook || {};
      if ($('webhook-type')) $('webhook-type').value = webhook.type || 'custom';
      if ($('webhook-url')) $('webhook-url').value = webhook.url || '';
      if ($('webhook-proxy')) $('webhook-proxy').value = webhook.proxy || '';
      if ($('webhook-ca-cert')) $('webhook-ca-cert').value = webhook.ca_cert || '';
      if ($('webhook-verify-ssl')) $('webhook-verify-ssl').checked = webhook.verify_ssl !== false;
      if ($('webhook-secret')) $('webhook-secret').value = webhook.secret || '';
      if ($('dingtalk-phones')) $('dingtalk-phones').value = normalizeList(webhook.at_mobiles).join(', ');
      onWebhookTypeChange();
      var whStatus = $('webhook-status');
      if (whStatus) {
        whStatus.textContent = webhook.url
          ? t('webui.webhook_status_ok', '已配置')
          : t('webui.webhook_status_fail', '未配置');
      }
    } catch (e) {
      setMsg('email-msg', '加载通知配置失败：' + e.message, false);
    }
  }

  async function saveEmail() {
    var cfg = emailPayload();
    if (!cfg.host || !cfg.user) {
      setMsg('email-msg', '请先填写 SMTP 服务器和邮箱地址', false);
      return;
    }
    if (!cfg.recipients.length) {
      setMsg('email-msg', '请至少填写一个收件人', false);
      return;
    }
    try {
      var res = await fetch('/api/notifier/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: cfg })
      });
      var data = await res.json();
      if (data && data.ok) {
        setMsg('email-msg', '✅ ' + t('webui.email_save_ok', '邮件配置已保存'), true);
        setStatus('email-status', true);
        if ($('smtp-password')) $('smtp-password').value = '';
      } else {
        setMsg('email-msg', '❌ ' + t('webui.email_save_fail', '保存失败：{}').replace('{}', (data && data.error) || ''), false);
      }
    } catch (e) {
      setMsg('email-msg', '❌ ' + t('webui.email_save_fail', '保存失败：{}').replace('{}', e.message), false);
    }
  }

  async function testEmail() {
    var cfg = emailPayload();
    if (!cfg.host || !cfg.user || !cfg.recipients.length) {
      setMsg('email-msg', '请先填写 SMTP 服务器、邮箱地址和收件人', false);
      return;
    }
    setMsg('email-msg', t('webui.email_testing', '正在测试...'), true);
    try {
      var res = await fetch('/api/notifier/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: cfg, test_recipients: cfg.recipients })
      });
      var data = await res.json();
      if (data && data.ok) {
        setMsg('email-msg', '✅ ' + (data.msg || t('webui.email_test_ok', '测试邮件发送成功')), true);
      } else {
        setMsg('email-msg', '❌ ' + ((data && data.msg) || t('webui.email_test_fail', '测试发送失败：{}')), false);
      }
    } catch (e) {
      setMsg('email-msg', '❌ ' + t('webui.email_test_fail', '测试发送失败：{}').replace('{}', e.message), false);
    }
  }

  async function saveWebhook() {
    var cfg = webhookPayload();
    if (!cfg.url) {
      setMsg('webhook-msg', '请先填写 Webhook 地址', false);
      return;
    }
    try {
      var res = await fetch('/api/notifier/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ webhook: cfg })
      });
      var data = await res.json();
      if (data && data.ok) {
        setMsg('webhook-msg', '✅ ' + t('webui.webhook_save_ok', 'Webhook 配置已保存'), true);
        var st = $('webhook-status');
        if (st) st.textContent = t('webui.webhook_status_ok', '已配置');
      } else {
        setMsg('webhook-msg', '❌ ' + t('webui.webhook_save_fail', '保存失败：{}').replace('{}', (data && data.error) || ''), false);
      }
    } catch (e) {
      setMsg('webhook-msg', '❌ ' + t('webui.webhook_save_fail', '保存失败：{}').replace('{}', e.message), false);
    }
  }

  async function testWebhook() {
    var cfg = webhookPayload();
    if (!cfg.url) {
      setMsg('webhook-msg', '请先填写 Webhook 地址', false);
      return;
    }
    setMsg('webhook-msg', '正在测试...', true);
    try {
      var res = await fetch('/api/notifier/test-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ webhook: cfg })
      });
      var data = await res.json();
      if (data && data.ok) {
        setMsg('webhook-msg', '✅ ' + ((data && data.msg) || t('webui.webhook_test_ok', 'Webhook 测试成功')), true);
      } else {
        setMsg('webhook-msg', '❌ ' + ((data && data.msg) || t('webui.webhook_test_fail', 'Webhook 测试失败')), false);
      }
    } catch (e) {
      setMsg('webhook-msg', '❌ ' + t('webui.webhook_test_fail', 'Webhook 测试失败：{}').replace('{}', e.message), false);
    }
  }

  window.FusionNotifier = {
    load: load,
    switchTab: switchTab,
    onWebhookTypeChange: onWebhookTypeChange,
    saveEmail: saveEmail,
    testEmail: testEmail,
    saveWebhook: saveWebhook,
    testWebhook: testWebhook
  };
})();
