# -*- coding: utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""SSH 快捷配置存储（服务器巡检历史连接）。

- 落盘文件 ``ssh_profiles.json``（PROJECT_ROOT），列表结构；
- 密码 / 私钥口令一律用目标统一密钥体系加密（modules.notify 的 Fernet，
  密钥存于 dbc_config.json 的 notification 节点），存储格式 ``_enc_<token>``；
  读时把旧明文 / ``_b64_`` 透明升级为 ``_enc_``，明文不再驻留磁盘；
- 归属隔离：每条配置登记 owner_user_id / owner_tenant_id / scope=private，
  列表按 modules.access.visible_to 过滤，写 / 删 / 解密按 can() 判定
  （非管理员只能操作本人配置，不能解密他人凭据）；
- 解密 fail-close：``_enc_`` 密文解不开（密钥不匹配 / 数据损坏）时拒绝放行，
  要求重新输入密码，不透传密文或错误凭据。
"""

import datetime
import json
import os
import uuid

from modules.core.paths import PROJECT_ROOT
from modules import notify
from modules import access

SSH_PROFILES_FILE = os.path.join(str(PROJECT_ROOT), 'ssh_profiles.json')

# 视为"已加密"的存储前缀（notify 密钥体系）
_ENC_PREFIX = '_enc_'


def _now():
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def _encrypt_field(plain):
    """加密敏感字段；空值原样返回。"""
    if not plain:
        return ''
    return notify._encrypt_password(plain)


def _decrypt_field(stored):
    """解密敏感字段，返回 (明文, 是否成功)。

    ``_enc_`` 密文解不开 → ('', False)（fail-close）；
    旧明文 / ``_b64_`` → 直接可用（fail-safe）。
    """
    if not stored:
        return '', True
    if stored.startswith(_ENC_PREFIX):
        val = notify._decrypt_password(stored)
        return val, bool(val)
    # 旧明文或 _b64_：notify._decrypt_password 已兼容
    return notify._decrypt_password(stored), True


def _upgrade_field(stored):
    """把旧明文 / _b64_ 透明升级为 _enc_；返回 (新值, 是否变化)。"""
    if not stored or stored.startswith(_ENC_PREFIX):
        return stored, False
    plain, ok = _decrypt_field(stored)
    if not ok or not plain:
        return stored, False
    new = _encrypt_field(plain)
    if new and new != stored:
        return new, True
    return stored, False


def _load_raw():
    """读取原始配置列表（不做归属过滤），并透明升级旧密码字段。"""
    if not os.path.exists(SSH_PROFILES_FILE):
        return []
    try:
        with open(SSH_PROFILES_FILE, 'r', encoding='utf-8') as f:
            profiles = json.load(f)
    except Exception:
        return []
    if not isinstance(profiles, list):
        return []
    dirty = False
    for p in profiles:
        if not isinstance(p, dict):
            continue
        for field in ('ssh_password', 'ssh_key_password'):
            new, changed = _upgrade_field(p.get(field))
            if changed:
                p[field] = new
                dirty = True
    if dirty:
        _save_raw(profiles)
    return profiles


def _save_raw(profiles):
    """原子写回配置列表。"""
    tmp = SSH_PROFILES_FILE + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(profiles, f, ensure_ascii=False, indent=2)
        os.replace(tmp, SSH_PROFILES_FILE)
    except Exception as e:
        print('[SSH Profiles] 保存失败: %s' % e)
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass


def _owner_fields(user):
    """从身份主体构造归属字段；匿名返回空（保持旧行为）。"""
    if user is None or user.is_anonymous:
        return {}
    return {
        'owner_user_id': user.id,
        'owner_tenant_id': user.tenant_id or 1,
        'owner_department_id': user.department_id,
        'owner_username': user.username or '',
        'scope': access.SCOPE_PRIVATE,
    }


def _mask(profile):
    """列表展示用：隐藏敏感字段。"""
    p = dict(profile)
    if p.get('ssh_password'):
        p['ssh_password'] = '***'
    if p.get('ssh_key_password'):
        p['ssh_key_password'] = '***'
    return p


def list_profiles(user):
    """按身份过滤后的配置列表（敏感字段已掩码）。"""
    profiles = _load_raw()
    out = []
    for p in profiles:
        if access.visible_to(user, p):
            out.append(_mask(p))
    return out


def get_profile(profile_id):
    """按 id 取原始配置（含密文），不做归属判定。"""
    for p in _load_raw():
        if p.get('id') == profile_id:
            return p
    return None


def upsert_profile(data, user):
    """新增 / 更新配置。返回 (ok, id_or_error)。

    更新他人配置需管理员权限；密码为 '***' 时保留原密文，避免二次加密。
    """
    name = (data.get('name') or '').strip()
    ssh_host = (data.get('ssh_host') or '').strip()
    if not name:
        return False, '请填写配置名称'
    if not ssh_host:
        return False, '请填写 SSH 主机地址'

    profiles = _load_raw()
    profile_id = data.get('id') or str(uuid.uuid4())[:8]
    idx = next((i for i, p in enumerate(profiles) if p.get('id') == profile_id), -1)
    existing = profiles[idx] if idx >= 0 else None

    # 更新已存在配置：先做写权限判定（非管理员不能改他人配置）
    if existing is not None and not access.can(user, 'write', existing):
        return False, '无权修改该配置'

    raw_password = data.get('ssh_password', '')
    raw_key_password = data.get('ssh_key_password', '')

    profile = {
        'id': profile_id,
        'name': name,
        'ssh_host': ssh_host,
        'ssh_port': int(data.get('ssh_port', 22) or 22),
        'ssh_user': (data.get('ssh_user') or 'root').strip(),
        'ssh_auth': data.get('ssh_auth', 'password'),
        'ssh_password': raw_password,
        'ssh_key_file': data.get('ssh_key_file', ''),
        'ssh_key_password': raw_key_password,
        'ai_analyze': 1 if data.get('ai_analyze') in (1, '1', True, 'true') else 0,
        'updated_at': _now(),
    }

    # 密码 / 私钥口令：'***' 保留原密文；新值一律加密落盘
    for field, raw in (('ssh_password', raw_password), ('ssh_key_password', raw_key_password)):
        if raw == '***':
            profile[field] = (existing or {}).get(field, '')
        elif raw:
            profile[field] = _encrypt_field(raw)
        else:
            profile[field] = ''

    if existing is not None:
        # 保留原归属与创建时间
        for k in ('owner_user_id', 'owner_tenant_id', 'owner_department_id',
                  'owner_username', 'scope', 'created_at'):
            if k in existing:
                profile[k] = existing[k]
        profile.setdefault('created_at', existing.get('created_at', profile['updated_at']))
        profiles[idx] = profile
    else:
        profile['created_at'] = profile['updated_at']
        profile.update(_owner_fields(user))
        profiles.append(profile)

    _save_raw(profiles)
    return True, profile_id


def delete_profile(profile_id, user):
    """删除配置（需写权限）。返回 (ok, error_or_none)。"""
    profiles = _load_raw()
    target = next((p for p in profiles if p.get('id') == profile_id), None)
    if target is None:
        return False, '配置不存在'
    if not access.can(user, 'write', target):
        return False, '无权删除该配置'
    profiles = [p for p in profiles if p.get('id') != profile_id]
    _save_raw(profiles)
    return True, None


def decrypt_profile(profile_id, user):
    """取完整配置（含解密后的密码 / 私钥口令）。返回 (ok, profile_or_error)。

    非管理员只能解密本人配置；``_enc_`` 密文解不开时 fail-close。
    """
    profile = get_profile(profile_id)
    if profile is None:
        return False, '配置不存在'
    if not access.can(user, 'decrypt', profile):
        return False, '无权解密该配置'
    out = dict(profile)
    for field in ('ssh_password', 'ssh_key_password'):
        val, ok = _decrypt_field(out.get(field))
        if not ok:
            return False, '密码解密失败，请重新输入'
        out[field] = val
    return True, out