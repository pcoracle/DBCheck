# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck
"""Zabbix JSON-RPC API 客户端。

认证方式按 Zabbix 官方约定分两条：
  - API Token：``Authorization: Bearer <token>`` 头（6.4+ 推荐）
  - 用户名/密码：先 ``user.login`` 拿会话 ID，再放进 JSON-RPC 的 ``auth`` 字段

``apiinfo.version`` 属于免认证方法，不能携带 Authorization 头，走 no_auth 分支。
"""

try:
    import requests
except ImportError:
    requests = None


class ZabbixError(Exception):
    """Zabbix API 调用异常（连接失败 / 认证失败 / 返回错误体）"""
    pass


class ZabbixClient:
    """Zabbix JSON-RPC 客户端。

    所有对外方法都是只读查询，天然幂等，因此连接被对端重置时可以安全重试一次。
    """

    def __init__(self, url=None, api_token=None, username=None, password=None,
                 verify_ssl=True, timeout=30):
        self.url = (url or '').strip().rstrip('/')
        self.api_token = (api_token or '').strip()
        self.username = (username or '').strip()
        self.password = password or ''
        self.verify_ssl = verify_ssl
        # 巡检/后台任务用默认 30s；高频轮询的调用方（监控大屏、指标采集）会传更小值，
        # 避免 Zabbix 不可达时拖住整轮采集。
        try:
            self.timeout = max(3, int(timeout or 30))
        except (TypeError, ValueError):
            self.timeout = 30
        self._request_id = 0
        self._session = None
        self._session_id = None

    @property
    def endpoint(self):
        return self.url + '/api_jsonrpc.php'

    # ── 认证 ──

    def _get_auth(self):
        """用户名/密码模式返回会话 ID；Token 模式返回 None（走 Bearer 头）。"""
        if self.username and self.password:
            if not self._session_id:
                self._session_id = self._login()
            return self._session_id
        return None

    def _login(self):
        if requests is None:
            raise ZabbixError('未安装 requests 库，无法调用 Zabbix API')
        if not self.url:
            raise ZabbixError('Zabbix URL 未配置')
        self._request_id += 1
        payload = {
            'jsonrpc': '2.0',
            'method': 'user.login',
            'params': {'username': self.username, 'password': self.password},
            'id': self._request_id,
        }
        headers = {'Content-Type': 'application/json-rpc', 'Accept': 'application/json'}
        try:
            resp = requests.post(self.endpoint, json=payload, headers=headers,
                                 verify=self.verify_ssl, timeout=self.timeout)
            data = resp.json()
        except Exception as e:
            raise ZabbixError('Zabbix 登录失败: %s' % e)
        if 'error' in data:
            raise ZabbixError('Zabbix 登录失败: %s' % self._error_text(data['error']))
        return data.get('result')

    def _get_session(self):
        if self._session is None:
            self._session = requests.Session()
            self._session.verify = self.verify_ssl
            self._session.headers.update({
                'Content-Type': 'application/json-rpc',
                'Accept': 'application/json',
            })
            if self.api_token:
                self._session.headers['Authorization'] = 'Bearer ' + self.api_token
        return self._session

    def _reset_session(self):
        """丢弃 HTTP 会话，下次请求重建连接。

        Zabbix 前置的 nginx/PHP-FPM 有空闲 keep-alive 超时；轮询复用到已被对端
        关闭的连接时 POST 会直接抛 ConnectionResetError（Windows WinError 10054）。
        urllib3 默认只重试幂等方法，POST 不重试，所以必须由这里重建。
        """
        session, self._session = self._session, None
        if session is not None:
            try:
                session.close()
            except Exception:
                pass

    # ── 传输 ──

    def _post(self, payload, no_auth=False):
        if no_auth:
            # 免认证方法（apiinfo.version）：不能携带 Authorization 头
            return requests.post(
                self.endpoint, json=payload,
                headers={'Content-Type': 'application/json-rpc', 'Accept': 'application/json'},
                verify=self.verify_ssl, timeout=self.timeout)
        if self.api_token:
            return self._get_session().post(self.endpoint, json=payload, timeout=self.timeout)
        auth = self._get_auth()
        if auth:
            payload['auth'] = auth
        return requests.post(
            self.endpoint, json=payload,
            headers={'Content-Type': 'application/json-rpc', 'Accept': 'application/json'},
            verify=self.verify_ssl, timeout=self.timeout)

    def _post_with_retry(self, payload, no_auth=False):
        try:
            return self._post(payload, no_auth=no_auth)
        except requests.exceptions.SSLError:
            raise
        except requests.exceptions.Timeout:
            # ConnectTimeout 是 ConnectionError 的子类，必须先拦下：
            # 服务器不可达时不该再等一轮超时。
            raise
        except requests.exceptions.ConnectionError:
            self._reset_session()
            return self._post(payload, no_auth=no_auth)

    @staticmethod
    def _error_text(err):
        msg = err.get('message', '未知错误')
        detail = err.get('data', '')
        return '%s: %s' % (msg, detail) if detail else msg

    def _call(self, method, params=None, no_auth=False):
        """调用一个 JSON-RPC 方法，返回 result；错误体转 ZabbixError。"""
        if requests is None:
            raise ZabbixError('未安装 requests 库，无法调用 Zabbix API')
        if not self.url:
            raise ZabbixError('Zabbix URL 未配置')
        self._request_id += 1
        payload = {
            'jsonrpc': '2.0',
            'method': method,
            'params': params or {},
            'id': self._request_id,
        }
        try:
            resp = self._post_with_retry(payload, no_auth=no_auth)
        except requests.exceptions.SSLError as e:
            raise ZabbixError('SSL 证书校验失败（可在配置中关闭 verify_ssl）: %s' % e)
        except requests.exceptions.ConnectionError as e:
            raise ZabbixError('无法连接 Zabbix 服务器: %s' % e)
        except requests.exceptions.Timeout:
            raise ZabbixError('连接 Zabbix 服务器超时')
        except Exception as e:
            raise ZabbixError('请求 Zabbix API 失败: %s' % e)

        try:
            data = resp.json()
        except Exception:
            raise ZabbixError('Zabbix API 返回非 JSON 数据（HTTP %s）' % resp.status_code)

        if 'error' in data:
            raise ZabbixError(self._error_text(data['error']))
        return data.get('result')

    # ── 基础查询 ──

    def api_version(self):
        return self._call('apiinfo.version', no_auth=True)

    def test_connection(self):
        """先验版本（免认证），再验凭据是否有效。返回 (ok, info)。"""
        try:
            version = self.api_version()
        except ZabbixError as e:
            return False, {'error': str(e)}
        if not self.api_token and not (self.username and self.password):
            return True, {'version': version, 'url': self.url, 'auth': '未配置认证'}
        try:
            self._call('user.get', {'output': ['userid'], 'limit': 1})
            return True, {'version': version, 'url': self.url, 'auth': '认证有效'}
        except ZabbixError as e:
            return False, {'error': str(e), 'version': version}

    # ── 主机 ──

    HOST_OUTPUT = ['hostid', 'host', 'name', 'status', 'available', 'maintenance_status']

    def get_hosts(self, search=None, limit=500):
        """主机列表（含接口 IP 与触发器）。

        [WARN] 按名字找主机必须用 ``search``，不要拉全量再本地过滤：``limit`` 会按
        ``sortfield`` 截断，主机多时目标主机很可能被截掉。
        ``search`` 同时匹配技术名(host)与显示名(name)——不少主机的可读名在 name 上。
        """
        params = {
            'output': self.HOST_OUTPUT,
            'selectInterfaces': ['interfaceid', 'ip', 'dns', 'port', 'type', 'available'],
            'selectTriggers': ['triggerid', 'description', 'priority', 'value', 'lastchange'],
            'sortfield': 'host',
            'limit': limit,
        }
        if search:
            params['search'] = {'host': search, 'name': search}
            params['searchByAny'] = True
        return self._call('host.get', params)

    def find_host(self, ip=None, hostname=None):
        """按 IP 或主机名精确查找主机（任一命中即返回）。

        只做精确 filter，不做模糊 search——IP 前缀相似（192.0.2.12 与 192.0.2.120）
        用模糊匹配会挑错主机。
        """
        ip = (ip or '').strip()
        hostname = (hostname or '').strip()
        if not ip and not hostname:
            raise ZabbixError('请输入主机 IP 或主机名')

        base = {
            'output': self.HOST_OUTPUT,
            'selectInterfaces': ['interfaceid', 'ip', 'dns', 'port', 'type', 'available'],
            'selectTriggers': ['triggerid', 'description', 'priority', 'value', 'lastchange'],
        }
        if ip:
            params = dict(base)
            params['filter'] = {'ip': [ip]}
            hosts = self._call('host.get', params)
            if hosts:
                return hosts
        if hostname:
            params = dict(base)
            params['filter'] = {'host': [hostname]}
            hosts = self._call('host.get', params)
            if hosts:
                return hosts
        return []

    def get_host(self, hostid):
        hosts = self._call('host.get', {
            'hostids': [hostid],
            'output': self.HOST_OUTPUT,
            'selectInterfaces': ['interfaceid', 'ip', 'dns', 'port', 'type', 'available'],
            'selectTriggers': ['triggerid', 'description', 'priority', 'value', 'lastchange'],
        })
        return hosts[0] if hosts else None

    # ── 监控项 ──

    ITEM_OUTPUT = ['itemid', 'hostid', 'name', 'key_', 'lastvalue', 'lastclock',
                   'units', 'value_type', 'status', 'state', 'error', 'delay']

    def get_items(self, hostid=None, search=None, limit=1000):
        params = {
            'output': self.ITEM_OUTPUT,
            'sortfield': 'name',
            'limit': limit,
        }
        if hostid:
            params['hostids'] = [hostid]
        if search:
            params['search'] = {'key_': search}
        return self._call('item.get', params)

    def get_items_by_keys(self, hostid, key_patterns, limit=500):
        return self._call('item.get', {
            'output': self.ITEM_OUTPUT,
            'hostids': [hostid],
            'search': {'key_': key_patterns},
            'searchByAny': True,
            'sortfield': 'name',
            'limit': limit,
        })
