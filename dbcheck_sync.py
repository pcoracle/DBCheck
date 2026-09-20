#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dbcheck_sync.py  —  DBCheck 仓库一键同步脚本
策略（按优先级）：
  0) 缓存优先：若本地已存在【完整】的 tarball 缓存，直接解包同步，完全不联网
  1) 先尝试 git fetch（带代理重试），成功则 git pull --ff-only
  2) 若 git smart-HTTP 在当前代理下不稳定（实测必败），自动降级：
     - 用 GitHub tarball + HTTP Range 断点续传下载最新 main 快照（单连接大文件反而稳）
     - 解包后同步到工作区，并用 git stash 保护本地未提交改动
代理探测：Windows IE/Internet 设置注册表 → 环境变量 → 常见端口扫描（均验证可连 GitHub 才用）
用法：
  双击 dbcheck_sync.bat，或在命令行运行本脚本
  环境变量 DBCHECK_FORCE_TARBALL=1 可跳过 git 直接走 tarball 兜底
  环境变量 DBCHECK_KEEP_TARBALL=0 可在同步后删除 tarball 缓存（默认保留，便于下次零联网）
"""
import os
import sys
import time
import shutil
import tarfile
import subprocess
import urllib.request

# ---------- 配置 ----------
REPO        = r"D:\codes\DBCheck"
REMOTE      = "https://github.com/pcoracle/DBCheck.git"
BRANCH      = "main"
TARBALL_URL = "https://codeload.github.com/pcoracle/DBCheck/legacy.tar.gz/refs/heads/main"
PROXY       = "http://127.0.0.1:55533"  # 占位；运行时由 find_proxy() 覆盖
TMP_TAR     = os.path.join(REPO, "_dbcheck_sync.tar.gz")
TMP_EXTRACT = os.path.join(REPO, "_dbcheck_sync_extract")
GIT         = shutil.which("git") or r"D:\Program Files\Git\bin\git.exe"

_FORCE_TARBALL  = os.environ.get("DBCHECK_FORCE_TARBALL") == "1"
_KEEP_TARBALL   = os.environ.get("DBCHECK_KEEP_TARBALL", "1") != "0"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------- 代理探测 ----------
def _test_port(host, port, timeout=2):
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return True
    except Exception:
        return False


def _parse_proxy_server(server):
    """把 IE 的 ProxyServer 字符串解析为 https 代理地址。
    形如 '127.0.0.1:55533' 或 'http=127.0.0.1:55533;https=127.0.0.1:55533;ftp=...'
    """
    proxies = {}
    for part in server.split(";"):
        part = part.strip()
        if not part:
            continue
        if "=" in part:
            scheme, addr = part.split("=", 1)
            proxies[scheme.lower().strip()] = addr.strip()
        else:
            for s in ("http", "https"):
                proxies[s] = part
    return proxies.get("https") or proxies.get("http")


def _proxy_from_windows_settings():
    """从 Windows IE/Internet 设置注册表读取当前系统代理（端口常变的客户端写在这里）"""
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        try:
            enable = winreg.QueryValueEx(key, "ProxyEnable")[0]
        except OSError:
            enable = 0
        try:
            server = winreg.QueryValueEx(key, "ProxyServer")[0]
        except OSError:
            server = ""
        winreg.CloseKey(key)
        if enable and server:
            addr = _parse_proxy_server(server)
            if addr:
                return "http://" + addr if "://" not in addr else addr
    except Exception:
        pass
    return None


def _verify_proxy(proxy):
    """验证该代理真能连通 GitHub（握手 + HTTPS 请求）"""
    try:
        hp = proxy.split("://")[-1]
        host, port = hp.rsplit(":", 1)
        if not _test_port(host, int(port)):
            return False
        op = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
        req = urllib.request.Request(
            "https://github.com", headers={"User-Agent": "dbcheck-probe"})
        resp = op.open(req, timeout=12)
        return resp.status in (200, 301, 302)
    except Exception:
        return False


def find_proxy():
    """按优先级找出当前能连通 GitHub 的代理：系统注册表 → 环境变量 → 常见端口扫描"""
    candidates = []
    # 1) Windows IE/Internet 设置（最权威，端口常变的客户端写这里）
    w = _proxy_from_windows_settings()
    if w:
        candidates.append(w)
    # 2) 环境变量
    for ev in ("https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"):
        v = os.environ.get(ev, "").strip()
        if v:
            candidates.append(v if "://" in v else "http://" + v)
    # 3) 常见代理端口
    common = [55533, 65450, 52478, 7890, 8080, 1080, 3128, 8888, 1087, 8118,
              7891, 10809, 20171, 9999]
    for p in common:
        candidates.append(f"http://127.0.0.1:{p}")
    seen, uniq = set(), []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    for c in uniq:
        if _verify_proxy(c):
            log(f"探测到可用代理: {c}")
            return c
    return None


def run(cmd, timeout=120, check_rc=False):
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True,
                           timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return None, -1, "TIMEOUT"
    if check_rc and r.returncode != 0:
        tail = (r.stderr or r.stdout).strip().splitlines()
        log("  git error: " + (tail[-1] if tail else f"rc={r.returncode}"))
    return r.stdout, r.returncode, r.stderr


# ---------- 方式 1：git fetch + pull ----------
def try_git_fetch():
    log("尝试 git fetch（经代理 %s，单次超时 60s）..." % PROXY)
    cmd = [GIT, "-c", f"http.proxy={PROXY}", "fetch", "--depth", "1", REMOTE, BRANCH]
    try:
        r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=60,
                           env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    except subprocess.TimeoutExpired:
        log("  git fetch 超时，判定代理不稳定")
        return False
    if r.returncode == 0:
        log("  git fetch 成功")
        return True
    tail = (r.stderr or "").strip().splitlines()
    log("  git fetch 失败: " + (tail[-1] if tail else f"rc={r.returncode}"))
    return False


# ---------- tarball 缓存完整性校验 ----------
def tarball_is_complete():
    if not os.path.exists(TMP_TAR):
        return False
    try:
        with tarfile.open(TMP_TAR, "r:gz") as tf:
            # 遍历所有成员以确认整包未截断
            n = 0
            for _ in tf:
                n += 1
            return n > 0
    except Exception:
        return False


# ---------- 方式 2：tarball + Range 续传 ----------
def download_tarball():
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
    urllib.request.install_opener(opener)

    start = os.path.getsize(TMP_TAR) if os.path.exists(TMP_TAR) else 0
    refused_streak = 0
    for attempt in range(1, 31):
        try:
            req = urllib.request.Request(
                TARBALL_URL,
                headers={"Range": f"bytes={start}-", "User-Agent": "dbcheck-sync/1.0"})
            resp = urllib.request.urlopen(req, timeout=120)
            code = resp.getcode()
            if code == 206 and start > 0 and os.path.exists(TMP_TAR):
                mode, fpos = "ab", start
            else:
                mode, fpos = "wb", 0
                if os.path.exists(TMP_TAR):
                    os.remove(TMP_TAR)
            got = fpos
            with open(TMP_TAR, mode) as f:
                while True:
                    buf = resp.read(1 << 20)
                    if not buf:
                        break
                    f.write(buf)
                    got += len(buf)
                    if got % (20 * 1048576) < (1 << 20):
                        log(f"  已下载 {got // 1048576} MB")
            log(f"tarball 下载完成：{got} bytes")
            return True
        except Exception as e:
            if os.path.exists(TMP_TAR):
                start = os.path.getsize(TMP_TAR)
            estr = str(e)
            # 代理明显拒绝连接：连续 3 次就放弃，不再空转
            if "10061" in estr or "Could not connect" in estr or "refused" in estr.lower():
                refused_streak += 1
            else:
                refused_streak = 0
            log(f"  第 {attempt} 次中断: {e}；从 {start} 字节续传")
            if refused_streak >= 3:
                log("  代理连续拒绝连接，停止重试")
                return False
            time.sleep(2)
    return False


def sync_from_tarball():
    log("解包并同步到工作区（保护本地未提交改动）...")
    if os.path.exists(TMP_EXTRACT):
        shutil.rmtree(TMP_EXTRACT)
    os.makedirs(TMP_EXTRACT)

    with tarfile.open(TMP_TAR, "r:gz") as tf:
        members = tf.getmembers()
        if not members:
            raise RuntimeError("tarball 为空")
        top = members[0].name.split("/")[0] + "/"
        for m in members:
            name = m.name
            if name.startswith(top):
                name = name[len(top):]
            if not name:
                continue
            target = os.path.join(TMP_EXTRACT, name)
            if m.isdir():
                os.makedirs(target, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                src = tf.extractfile(m)
                with open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)

    # 保护本地改动
    run([GIT, "stash", "-u"], timeout=60)
    # 覆盖工作区（排除 .git 与临时目录）
    for item in os.listdir(TMP_EXTRACT):
        if item == ".git":
            continue
        s = os.path.join(TMP_EXTRACT, item)
        d = os.path.join(REPO, item)
        if item.startswith("_dbcheck_sync"):
            continue
        if os.path.isdir(s):
            if os.path.exists(d):
                shutil.rmtree(d)
            shutil.copytree(s, d)
        else:
            shutil.copy2(s, d)
    # 提交为新快照起点
    run([GIT, "add", "-A"], timeout=180)
    _, rc, _ = run([GIT, "commit", "-q",
                   "-m", "Sync snapshot via tarball (git smart-HTTP blocked by flaky proxy)"],
                  timeout=180, check_rc=False)
    if rc != 0:
        log("  （无新改动，无需提交）")
    # 还原本地改动
    run([GIT, "stash", "pop"], timeout=60)
    log("已从 tarball 同步完成")


# ---------- 清理 ----------
def cleanup_tmp():
    # 始终清理解包临时目录
    if os.path.isdir(TMP_EXTRACT):
        shutil.rmtree(TMP_EXTRACT, ignore_errors=True)
    # tarball 缓存默认保留（便于下次零联网同步），除非用户显式关闭
    if not _KEEP_TARBALL and os.path.exists(TMP_TAR):
        try:
            os.remove(TMP_TAR)
            log("已删除 tarball 缓存（DBCHECK_KEEP_TARBALL=0）")
        except OSError:
            pass


def main():
    global PROXY
    log("=== DBCheck 一键同步开始 ===")
    log(f"仓库: {REPO}")

    # 0) 缓存优先：本地已有完整 tarball 则零联网直接解包
    if tarball_is_complete():
        sz = os.path.getsize(TMP_TAR)
        log(f"发现完整本地 tarball 缓存（{sz // 1048576} MB），直接解包，无需联网")
        try:
            sync_from_tarball()
            log("=== 同步完成（via 本地缓存 tarball，零联网）===")
        except Exception as e:
            log(f"缓存解包失败: {e}；将改用下载方式")
        else:
            cleanup_tmp()
            return

    # 1) git 优先（除非强制 tarball）
    if not _FORCE_TARBALL:
        PROXY = find_proxy() or PROXY
        if try_git_fetch():
            _, rc, _ = run([GIT, "pull", "--ff-only"], timeout=120, check_rc=True)
            if rc == 0:
                log("=== 同步完成（via git）===")
                cleanup_tmp()
                return
        else:
            log("git 不可用（代理不稳定或离线），准备走 tarball")
    else:
        log("已设置 DBCHECK_FORCE_TARBALL=1，跳过 git 直接走 tarball")

    # 2) tarball 下载（带续传）
    PROXY = find_proxy()
    if not PROXY:
        if os.path.exists(TMP_TAR):
            log("未探测到可用代理，但磁盘有 tarball，尝试用现有缓存解包")
            try:
                sync_from_tarball()
                log("=== 同步完成（via 现有 tarball 缓存）===")
                cleanup_tmp()
                return
            except Exception as e:
                log(f"缓存解包也失败: {e}")
        log("致命：无可用代理且本地无完整缓存，无法下载。请检查代理客户端是否启动。")
        sys.exit(1)

    if download_tarball():
        try:
            sync_from_tarball()
            log("=== 同步完成（via tarball 下载）===")
        except Exception as e:
            log(f"同步失败: {e}")
            cleanup_tmp()
            sys.exit(1)
    else:
        if os.path.exists(TMP_TAR):
            log("下载失败，尝试用已下载的部分缓存解包")
            try:
                sync_from_tarball()
                log("=== 同步完成（via 部分 tarball 缓存）===")
            except Exception as e:
                log(f"部分缓存解包失败: {e}")
                cleanup_tmp()
                sys.exit(1)
        else:
            log("致命：git 与 tarball 均失败，请检查网络/代理")
            sys.exit(1)
    cleanup_tmp()


if __name__ == "__main__":
    main()
