#!/usr/bin/env python
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
"""新功能菜单种子同步器：让 nav-item、menus_data、九语言 menu.* 键始终一致。

为什么需要它（每一条都是真实踩过的坑）：
  · loadVisibleMenus() 用 `visibleCodes.includes(code)` 决定导航显隐 ——
    nav 有、menus_data 没有，该页面对包括 admin 在内的所有人直接不可见
    （巡检编排 flow 就这样漏了很久）。
  · menus_data 的 menu_name 存的是 i18n 键，菜单权限界面按当前语言取值；
    某语言字典缺键时界面直接显示原始键名（Zabbix 设置页曾缺 7 种语言）。
  · 人工同步几乎必然只改一处，所以把这三条不变量做成脚本：检测、生成、CI 校验。

用法：
    python scripts/sync_menu_seed.py            # 报告漂移
    python scripts/sync_menu_seed.py --write    # 补齐种子行与九语言 menu.* 键
    python scripts/sync_menu_seed.py --check    # 有漂移即退出码 1（CI 用）

有意不一致必须登记在 EXEMPTIONS 并写明理由，不允许默默留着。
"""

import argparse
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_HTML = os.path.join(ROOT, 'web_templates', 'index.html')
SEED_PY = os.path.join(ROOT, 'modules', 'user_management', 'seed.py')
I18N_DIR = os.path.join(ROOT, 'i18n')
LANGS = ['zh', 'zh_tw', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'ru']

# 已登记的有意不一致：key = menu_code，value = 理由
EXEMPTIONS = {
    # 许可证页存在，但导航项硬编码 style="display:none"，且全仓没有
    # showPage('license') 或解除隐藏的调用 —— 属于「暂未对外放出」。
    # 要正式放出时删掉本条例外并执行 --write。
    'license': '导航硬编码隐藏且无程序化入口，页面暂未对外放出',
    # 菜单行保留、前端无 nav-item：sync_menus() 明确约定「绝不删除任何既有授权」，
    # 所以不能因为没导航就回收这条权限。
    'about': '菜单行保留历史授权，sync_menus 约定不删除既有授权',
}

# i18n 键的连字符/下划线两种历史写法都视为合法：新行统一用 menu.<code>，
# 但既存的 menu.workflow_task 这种写法不该被判成错误。
def key_variants(code):
    return {'menu.' + code, 'menu.' + code.replace('-', '_')}


def read(path):
    return io.open(path, encoding='utf-8', errors='replace').read()


def scan_navs():
    """扫描侧栏 nav-item，返回 [{'code','label_zh','nav_hidden','pro_gated','line'}...]。

    属性顺序不固定（id 可能在 onclick 前或后），所以匹配整个开始标签再取属性。
    pro_available 门控用条件栈判定：逐 token 扫 Jinja if/endif，进 if 压栈、
    遇 endif 弹栈，命中 nav-item 时看栈里有没有 pro_available 条件 ——
    这类页面社区版不渲染，但种子行必须存在，否则 Pro 环境会被菜单权限吃掉。
    """
    lines = read(INDEX_HTML).split('\n')
    stack = []          # [(起始行号, 条件表达式)]
    pro_open = 0
    out = []
    for i, line in enumerate(lines):
        for tok in re.finditer(r"\{%-?\s*(if|elif|else|endif)\b([^%]*?)-?%\}", line):
            kind, expr = tok.group(1), tok.group(2).strip()
            if kind in ('if', 'elif', 'else'):
                if kind == 'if':
                    stack.append(expr or '')
                    if 'pro_available' in (expr or ''):
                        pro_open += 1
            else:  # endif
                if stack:
                    closed = stack.pop()
                    if 'pro_available' in closed:
                        pro_open -= 1
        if not re.search(r'<div\b[^>]*class="nav-item', line):
            continue
        tag_m = re.search(r'<div\b[^>]*class="nav-item[^"]*"[^>]*>', line)
        tag = tag_m.group(0) if tag_m else line
        code = None
        for pat in (r'id="nav-([A-Za-z0-9_-]+)"', r"showPage\('([A-Za-z0-9_-]+)'\)"):
            a = re.search(pat, tag)
            if a:
                code = a.group(1)
                break
        if not code:
            a = re.search(r'id="nav-([A-Za-z0-9_-]+)"', line)
            if not a:
                continue
            code = a.group(1)
        zh = ''
        # 标签往往不在 div 那一行，而在其后的 icon span 之后（本仓常见写法），
        # 所以取到 div 起始后继续往下读，直到该 nav-item 闭合。
        block = '\n'.join(lines[i:i + 6])
        end = block.find('</div>', len(tag))
        if end != -1:
            block = block[:end]
        for lm in re.finditer(
                r'<span[^>]*data-i18n="((?:webui|menu)\.[a-z0-9_.]+)"[^>]*>([^<]{1,60})</span>', block):
            zh = lm.group(2).strip() or zh
        if not zh:
            plain = re.findall(r'>\s*([^<>{}|]{2,40})\s*</span>', block)
            zh = plain[-1].strip() if plain else ''
        out.append({'code': code, 'label_zh': zh,
                    'nav_hidden': bool(re.search(r'style="[^"]*display:\s*none', tag)),
                    'pro_gated': pro_open > 0, 'line': i + 1})
    return out


def scan_seed_menus():
    text = read(SEED_PY)
    m = re.search(r'^menus_data\s*=\s*\[(.*?)^\]', text, re.M | re.S)
    if not m:
        raise SystemExit('ERROR: 没找到 menus_data 列表，脚本与 seed.py 结构已不匹配')
    rows = re.findall(r"\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)", m.group(1))
    return [{'code': c, 'name_key': k, 'parent': int(p), 'sort': int(s)} for c, k, p, s in rows]


def scan_i18n():
    per_lang = {}
    for lang in LANGS:
        path = os.path.join(I18N_DIR, '%s.py' % lang)
        text = read(path) if os.path.exists(path) else ''
        per_lang[lang] = dict(re.findall(
            r'^\s*"([a-zA-Z0-9_.\-]+)"\s*:\s*"((?:[^"\\]|\\.)*)"', text, re.M))
    return per_lang


def build_report(navs, seed, per_lang):
    navs_by_code = {n['code']: n for n in navs}
    nav_codes = [n['code'] for n in navs]
    seed_codes = [r['code'] for r in seed]

    missing_in_seed = [c for c in nav_codes if c not in seed_codes and c not in EXEMPTIONS]
    exempted = [c for c in nav_codes if c not in seed_codes and c in EXEMPTIONS]
    seed_only = [c for c in seed_codes if c not in nav_codes and c not in EXEMPTIONS]
    exempt_seed_only = [c for c in seed_codes if c not in nav_codes and c in EXEMPTIONS]
    dup = sorted({c for c in seed_codes if seed_codes.count(c) > 1})
    style_drift = [r['code'] for r in seed if r['name_key'] not in key_variants(r['code'])]

    # 需要存在的 i18n 键 = 种子行自己声明的键 ∪ 尚未建行但应当建的 nav 项键。
    # 已登记例外的 nav（如 license）没有菜单行，也就不需要 menu.* 键 ——
    # 那些键只服务于菜单权限界面里已存在的行，强行要求会是假警。
    required_keys = set()
    for r in seed:
        required_keys.add(r['name_key'])
    for c in missing_in_seed:
        required_keys.add('menu.' + c)

    i18n_missing = {}
    for lang in LANGS:
        miss = sorted(k for k in required_keys if k not in per_lang[lang])
        if miss:
            i18n_missing[lang] = miss

    blocking = bool(missing_in_seed or seed_only or dup or i18n_missing)
    return {'navs': navs, 'navs_by_code': navs_by_code, 'seed': seed,
            'missing_in_seed': missing_in_seed, 'exempted': exempted,
            'seed_only': seed_only, 'exempt_seed_only': exempt_seed_only,
            'dup': dup, 'style_drift': style_drift, 'i18n_missing': i18n_missing,
            'required_keys': sorted(required_keys), 'blocking': blocking}


def print_report(rep):
    print('nav-item=%d  menus_data=%d  语言=%d  应校验 i18n 键=%d'
          % (len(rep['navs']), len(rep['seed']), len(LANGS), len(rep['required_keys'])))
    if rep['missing_in_seed']:
        print('\n[A] nav 有、menus_data 缺（该页面对所有人不可见，必须补）:')
        for c in rep['missing_in_seed']:
            n = rep['navs_by_code'][c]
            print('    - %-20s index.html:%-6s 「%s」%s' % (
                c, n['line'], n['label_zh'], '（pro 门控）' if n['pro_gated'] else ''))
    if rep['seed_only']:
        print('\n[B] menus_data 有、nav 无（脏菜单，会出现在角色授权界面）: %s' % rep['seed_only'])
    if rep['dup']:
        print('\n[C] menus_data 内重复 menu_code: %s' % rep['dup'])
    if rep['i18n_missing']:
        print('\n[D] menu.* 键在各语言字典的缺失（界面会露出原始键名）:')
        for lang, miss in sorted(rep['i18n_missing'].items()):
            shown = miss if len(miss) <= 8 else miss[:8] + ['…']
            print('    %-6s 缺 %2d  %s' % (lang, len(miss), shown))
    if rep['style_drift']:
        print('\n[E] 命名风格偏差（不判失败，新行请统一用 menu.<code>）: %s' % rep['style_drift'])
    if rep['exempted']:
        print('\n[F] 已登记例外（nav 有、不建行）:')
        for c in rep['exempted']:
            print('    - %-14s %s' % (c, EXEMPTIONS[c]))
    if rep['exempt_seed_only']:
        print('\n[G] 已登记例外（菜单行保留、无 nav）: %s' % rep['exempt_seed_only'])
    if not rep['blocking']:
        print('\nOK: nav-item、menus_data 与九语言 menu.* 一致（无阻断项）')
    return not rep['blocking']


def resolve_label(key, per_lang, navs_by_code):
    """为 menu.* 键解析一个「真实存在过的」标签；解析不出就返回 None。

    兜底链（全部来自本仓库已有文本，绝不机器翻译，也绝不拿键名本身凑数）：
      1. 同语言的 webui.nav_<code>（含下划线写法）——多数语言已翻译齐全，最可靠；
      2. 中文系用 zh 已有的同一个 menu.* 值或 nav 标签里的中文原文；
      3. 其余语言用 en 已有的同一个 menu.* 值；
      4. 以上都没有 → None，由调用方列入「需人工处理」，不写入文件。
    上一版在这里拿 code 当值兜底，结果往 7 个语言字典里写进了
    "menu.ai-assistant": "ai-assistant" 这种垃圾；界面不但不翻译，
    还比原样显示键名更难看的。取不到正确文案时宁可不写。
    """
    code = key[len('menu.'):]
    nav = navs_by_code.get(code) or navs_by_code.get(code.replace('_', '-')) or {}
    nav_zh = nav.get('label_zh') or ''
    en_alt = per_lang['en'].get(key) or per_lang['en'].get('menu.' + code.replace('-', '_')) or ''
    zh_alt = per_lang['zh'].get(key) or per_lang['zh'].get('menu.' + code.replace('-', '_')) or ''

    out = {}
    for lang in LANGS:
        d = per_lang[lang]
        got = ''
        for cand in ('webui.nav_' + code, 'webui.nav_' + code.replace('_', '-'),
                     'webui.nav_' + code.replace('-', '_')):
            got = got or d.get(cand) or ''
        if got:
            out[lang] = got
        elif lang in ('zh', 'zh_tw'):
            out[lang] = zh_alt or nav_zh or ''
        else:
            out[lang] = en_alt or ''
        if not out[lang]:
            out[lang] = None
    return out


def write_seed_rows(rep):
    if not rep['missing_in_seed']:
        return 0
    text = read(SEED_PY)
    m = re.search(r'^menus_data\s*=\s*\[(.*?)^\]', text, re.M | re.S)
    sorts = [r['sort'] for r in rep['seed']]
    nxt = max(sorts or [0]) + 5
    lines = []
    for code in rep['missing_in_seed']:
        nav = rep['navs_by_code'][code]
        note = '  # pro 门控页面：社区版不渲染，但种子必须存在' if nav['pro_gated'] else ''
        lines.append("    ('%s', 'menu.%s', 0, %d),%s" % (code, code, nxt, note))
        nxt += 1
    new_block = m.group(1).rstrip('\n') + '\n' + '\n'.join(lines) + '\n'
    io.open(SEED_PY, 'w', encoding='utf-8', newline='').write(
        text[:m.start(1)] + new_block + text[m.end(1):])
    return len(lines)


def write_i18n_keys(rep, per_lang):
    total, skipped = 0, []
    for lang in LANGS:
        miss = rep['i18n_missing'].get(lang) or []
        if not miss:
            continue
        path = os.path.join(I18N_DIR, '%s.py' % lang)
        text = read(path)
        chunks = []
        for key in miss:
            lab = resolve_label(key, per_lang, rep['navs_by_code'])[lang]
            if not lab:
                # 解析不出真实文案：不写。写进 code 只会让界面显示键名，
                # 比现状更糟，而且之后再想查出「哪些是自动生成垃圾」更难。
                skipped.append((lang, key))
                continue
            esc = lab.replace('\\', '\\\\').replace('"', '\\"')
            chunks.append('    "%s": "%s",' % (key, esc))
        if not chunks:
            continue
        anchor = re.search(r'^[ \t]*"menu\.notifier":\s*"[^"]*",', text, re.M)
        if not anchor:
            anchor2 = re.search(r'^[A-Z_]+\s*=\s*\{', text, re.M)
            if not anchor2:
                print('  WARN: %s 找不到字典锚点，跳过该语言' % lang)
                continue
            pos = anchor2.end()
        else:
            pos = anchor.end()
        text = text[:pos] + '\n' + '\n'.join(chunks) + text[pos:]
        io.open(path, 'w', encoding='utf-8', newline='').write(text)
        total += len(chunks)
    if skipped:
        print('  需人工补翻译（脚本未写入，避免塞入无意义文案）:')
        for lang, key in skipped[:24]:
            print('    %-6s %s' % (lang, key))
    return total


def main():
    ap = argparse.ArgumentParser(description='新功能菜单种子与九语言 menu.* 键同步')
    ap.add_argument('--write', action='store_true', help='生成缺失的种子行与 i18n 键')
    ap.add_argument('--check', action='store_true', help='有阻断项即退出码 1（CI）')
    args = ap.parse_args()

    navs, seed, per_lang = scan_navs(), scan_seed_menus(), scan_i18n()
    rep = build_report(navs, seed, per_lang)
    ok = print_report(rep)

    if args.write:
        added_seed = write_seed_rows(rep)
        added_keys = write_i18n_keys(rep, per_lang)
        print('\n已写入：menus_data +%d 行，menu.* 键 +%d 条' % (added_seed, added_keys))
        print('后续：重启服务由 sync_menus() 幂等 upsert 到 um_menu，并到菜单权限界面确认。')
        navs, seed, per_lang = scan_navs(), scan_seed_menus(), scan_i18n()
        rep = build_report(navs, seed, per_lang)
        ok = print_report(rep)

    if args.check:
        return 0 if ok else 1
    return 0 if (ok or not args.write) else 1


if __name__ == '__main__':
    sys.exit(main())
