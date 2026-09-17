# -*- coding: utf-8 -*-
"""网盘分享链接有效性检测（单源真相）。

支持：夸克 / 阿里 / 百度 / 115 / 123 / UC / 天翼 / PikPak / 光鸭 / 和彩云(139) / 迅雷。
返回: (status, http_code, msg)
  status ∈ alive|dead|unknown|timeout|error|skip|invalid
"""
from __future__ import annotations

import logging
import os
import re
import threading
from typing import Callable
from urllib.parse import urlparse, parse_qs

import requests

logger = logging.getLogger("services.link_checker")

# 死链检测强制直连：清掉代理环境变量，Session 也不读系统代理
def _force_direct() -> None:
    for k in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "http_proxy",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ):
        os.environ.pop(k, None)


_force_direct()

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Accept-Encoding": "identity",
}

TIMEOUT = 3  # 大批量扫描：超时尽快标 timeout，靠复检补漏



def _safe_headers(extra: dict | None = None) -> dict:
    """HTTP 头必须 latin-1；URL 常含中文「访问码」等，不能直接塞 Referer。"""
    h = dict(HEADERS)
    if not extra:
        return h
    for k, v in extra.items():
        if v is None:
            continue
        s = str(v)
        try:
            s.encode("latin-1")
            h[k] = s
        except UnicodeEncodeError:
            ascii_s = s.encode("ascii", "ignore").decode("ascii").strip()
            if ascii_s:
                h[k] = ascii_s
    return h


# 夸克/UC 明确失效业务码
_QUARK_DEAD_CODES = {
    40001,
    40002,
    40003,
    40004,
    40005,
    41001,
    41002,
    41006,
    41007,
    41009,
}
_QUARK_NEED_PWD = {41008}  # 需要提取码 → 分享仍在

_HTML_DEAD = [
    "啊哦，你来晚了，分享的文件已经被取消了",
    "分享的文件已经失效",
    "该分享已不存在",
    "分享已被取消",
    "取消分享",
    "链接已失效",
    "该链接已失效",
    "无法访问该分享",
    "该分享已删除",
    "文件不存在",
    "已失效",
    "已过期",
    "已被删除",
    "share has been deleted",
    "sharelink.cancelled",
    "share not found",
]

_HTML_ALIVE = [
    "请输入提取码",
    "提取码",
    "输入密码",
    "文件列表",
    "保存到网盘",
    "转存",
    "分享文件",
]


def _pwd_from_url(url: str) -> str:
    m = re.search(
        r"[?&#](?:pwd|passcode|password|code|accessCode)=([A-Za-z0-9]+)",
        url,
        re.I,
    )
    if m:
        return m.group(1)
    m = re.search(r"访问码[：:]\s*([A-Za-z0-9]+)", url)
    return m.group(1) if m else ""


def extract_share_id(url: str, pan: str = "") -> str | None:
    patterns = {
        "quark": r"/s/([a-zA-Z0-9]+)",
        "uc": r"/s/([a-zA-Z0-9]+)",
        "baidu": r"/s/([a-zA-Z0-9_-]+)",
        "aliyun": r"/s/([a-zA-Z0-9]+)",
        "xunlei": r"/s/([a-zA-Z0-9_-]+)",
        "115": r"/s/([a-zA-Z0-9]+)",
        "123": r"/s/([A-Za-z0-9_-]+)",
        "pikpak": r"/s/([a-zA-Z0-9_-]+)",
        "tianyi": r"/t/([A-Za-z0-9]+)",
        "guangya": r"/s/([^/?#]+)",
        "caiyun": r"(?:/#/w/i/|/m/i\?|/w/i/)([A-Za-z0-9]+)",
    }
    key = pan or "quark"
    pat = patterns.get(key) or r"/s/([a-zA-Z0-9_-]+)"
    m = re.search(pat, url)
    return m.group(1) if m else None


def detect_pan(url: str = "", source: str = "") -> str:
    u = (url or "").strip().lower()
    s = (source or "").strip().lower()
    rules = (
        ("magnet:", "magnet"),
        ("ed2k:", "ed2k"),
        ("pan.quark.cn", "quark"),
        ("quark.cn", "quark"),
        ("drive.uc.cn", "uc"),
        ("alipan.com", "aliyun"),
        ("aliyundrive.com", "aliyun"),
        ("pan.baidu.com", "baidu"),
        ("yun.baidu.com", "baidu"),
        ("pan.xunlei.com", "xunlei"),
        ("cloud.189.cn", "tianyi"),
        ("115.com", "115"),
        ("115cdn.com", "115"),
        ("anxia.com", "115"),
        ("123pan.com", "123"),
        ("123684.com", "123"),
        ("123865.com", "123"),
        ("123912.com", "123"),
        ("123641.com", "123"),
        ("mypikpak.com", "pikpak"),
        ("guangyapan.com", "guangya"),
        ("caiyun.139.com", "caiyun"),
        ("yun.139.com", "caiyun"),
    )
    for needle, pan in rules:
        if needle in u:
            return pan
    aliases = {
        "quark": "quark",
        "uc": "uc",
        "baidu": "baidu",
        "aliyun": "aliyun",
        "ali": "aliyun",
        "115": "115",
        "123": "123",
        "123pan": "123",
        "pikpak": "pikpak",
        "tianyi": "tianyi",
        "guangya": "guangya",
        "mobile": "caiyun",
        "caiyun": "caiyun",
        "yidong": "caiyun",
        "xunlei": "xunlei",
        "thunder": "xunlei",
    }
    if s in aliases:
        return aliases[s]
    return "other"


import threading

_req_tls = threading.local()


def _session() -> requests.Session:
    """每线程复用 Session + 大连接池；trust_env=False 忽略 7890 等系统代理。"""
    s = getattr(_req_tls, "session", None)
    if s is not None:
        return s
    _force_direct()
    s = requests.Session()
    s.trust_env = False  # 关键：不走 HTTP(S)_PROXY
    s.headers.update(HEADERS)
    adapter = requests.adapters.HTTPAdapter(pool_connections=64, pool_maxsize=64, max_retries=0)
    s.mount("http://", adapter)
    s.mount("https://", adapter)
    _req_tls.session = s
    return s


def _get(url: str, **kwargs):
    headers = kwargs.pop("headers", None)
    kwargs["headers"] = _safe_headers(headers)
    kwargs.setdefault("timeout", TIMEOUT)
    return _session().get(url, **kwargs)


def _post(url: str, **kwargs):
    headers = kwargs.pop("headers", None)
    kwargs["headers"] = _safe_headers(headers)
    kwargs.setdefault("timeout", TIMEOUT)
    return _session().post(url, **kwargs)


def _check_quark_like(url: str, api: str, label: str) -> tuple[str, int, str]:
    sid = extract_share_id(url, "quark")
    if not sid:
        return "unknown", 0, f"无法提取{label}分享ID"
    pwd = _pwd_from_url(url)
    r = _session().post(
        api,
        json={"pwd_id": sid, "passcode": pwd},
        timeout=TIMEOUT,
    )
    if r.status_code == 404:
        return "dead", 404, f"{label}分享不存在或已取消"
    if r.status_code != 200:
        return "unknown", r.status_code, f"{label} HTTP {r.status_code}"
    d = r.json() if r.text else {}
    code = d.get("code")
    status = d.get("status")
    msg = str(d.get("message") or d.get("msg") or "")
    if code == 0 or status == 200:
        return "alive", 200, "正常"
    if code in _QUARK_NEED_PWD or "提取码" in msg:
        return "alive", 200, "需提取码(分享仍在)"
    if code in _QUARK_DEAD_CODES or any(
        w in msg for w in ("不存在", "取消", "删除", "违规", "失效")
    ):
        return "dead", 200, f"{label}失效(code={code})"
    # 未知业务码：勿再一律 alive
    return "unknown", 200, f"{label}未知码({code}):{msg[:40]}"


def _check_aliyun(url: str) -> tuple[str, int, str]:
    sid = extract_share_id(url, "aliyun")
    if not sid:
        return "unknown", 0, "无法提取阿里分享ID"
    r = _session().post(
        "https://api.aliyundrive.com/adrive/v3/share_link/get_share_by_anonymous",
        json={"share_id": sid},
        timeout=TIMEOUT,
    )
    try:
        d = r.json() if r.text else {}
    except Exception:
        d = {}
    code = str(d.get("code") or "")
    msg = str(d.get("message") or "")
    dead_codes = (
        "ShareLinkNotFound",
        "ShareLinkForbidden",
        "ShareLink.Cancelled",
        "ShareLinkCancelled",
        "NotFound",
        "Forbidden",
    )
    if r.status_code in (400, 404) or code in dead_codes or any(
        w in msg.lower() for w in ("cancel", "not found", "forbidden", "取消")
    ):
        return "dead", r.status_code, f"阿里已取消/不存在({code or r.status_code})"
    if r.status_code == 200 and (d.get("share_name") or d.get("file_infos") is not None or d.get("creator_name")):
        return "alive", 200, "正常"
    if r.status_code == 200 and not code:
        return "alive", 200, "正常"
    return "unknown", r.status_code, code or msg[:40]


def _check_baidu(url: str) -> tuple[str, int, str]:
    r = _session().get(url, timeout=TIMEOUT, allow_redirects=True)
    if r.status_code in (404, 410):
        return "dead", r.status_code, "百度页面不存在"
    body = r.text or ""
    for sig in _HTML_DEAD:
        if sig in body:
            return "dead", 200, f"百度提示:{sig[:12]}"
    if "请输入提取码" in body or "init?" in (r.url or "") or "百度网盘" in body:
        return "alive", 200, "正常"
    if r.status_code == 200 and len(body) > 500:
        return "alive", 200, "正常"
    return "unknown", r.status_code, ""


def _check_115(url: str) -> tuple[str, int, str]:
    sid = extract_share_id(url, "115")
    if not sid:
        return "unknown", 0, "无法提取115分享码"
    pwd = _pwd_from_url(url)
    r = _session().get(
        "https://webapi.115.com/share/snap",
        params={"share_code": sid, "receive_code": pwd},
        timeout=TIMEOUT,
    )
    try:
        d = r.json() if r.text else {}
    except Exception:
        return "unknown", r.status_code, "115非JSON"
    if d.get("state") is True:
        return "alive", 200, "正常"
    errno = d.get("errno")
    err = str(d.get("error") or "")
    # 访问码错误 → 分享仍在
    if errno in (4100008, 4100019) or "访问码" in err:
        return "alive", 200, "访问码错误(分享仍在)"
    if errno in (4100001, 4100000, 990001) or any(
        w in err for w in ("不存在", "取消", "失效", "过期", "删除")
    ):
        return "dead", 200, f"115失效({errno}:{err[:20]})"
    if d.get("state") is False:
        # 参数错误等不确定
        if errno == 990002:
            return "dead", 200, f"115无效分享({err[:20]})"
        return "unknown", 200, f"115:{errno}:{err[:30]}"
    return "unknown", r.status_code, ""


def _check_123(url: str) -> tuple[str, int, str]:
    sid = extract_share_id(url, "123")
    if not sid:
        return "unknown", 0, "无法提取123分享Key"
    host = urlparse(url).netloc or "www.123pan.com"
    headers = {**HEADERS, "Platform": "web", "App-Version": "3", "Accept": "application/json", "Referer": url}
    # 优先同域，再回退常见域名
    hosts = [host, "123865.com", "www.123684.com", "www.123pan.com"]
    seen = set()
    last = ("unknown", 0, "")
    for h in hosts:
        if h in seen:
            continue
        seen.add(h)
        try:
            r = requests.get(
                f"https://{h}/api/share/info",
                params={"shareKey": sid},
                timeout=TIMEOUT,
                headers=headers,
            )
        except requests.RequestException as e:
            last = ("unknown", 0, str(e)[:40])
            continue
        if "text/html" in (r.headers.get("content-type") or "") and r.status_code == 404:
            continue
        try:
            d = r.json() if r.text else {}
        except Exception:
            continue
        code = d.get("code")
        msg = str(d.get("message") or "")
        if code == 0 and d.get("data"):
            return "alive", 200, "正常"
        # 5107 分享页面不存在；400 ShareKey格式异常
        if code in (5103, 5104, 5105, 5106, 5107, 400) or any(
            w in msg for w in ("不存在", "失效", "取消", "过期", "异常")
        ):
            return "dead", 200, f"123失效({code}:{msg[:20]})"
        last = ("unknown", r.status_code, f"123 code={code}:{msg[:30]}")
    return last


def _check_tianyi(url: str) -> tuple[str, int, str]:
    sid = extract_share_id(url, "tianyi")
    if not sid:
        # 有时链接在正文里
        m = re.search(r"cloud\.189\.cn/t/([A-Za-z0-9]+)", url)
        sid = m.group(1) if m else ""
    if not sid:
        return "unknown", 0, "无法提取天翼分享码"
    r = _session().get(
        "https://cloud.189.cn/api/open/share/getShareInfoByCodeV2.action",
        params={"shareCode": sid},
        timeout=TIMEOUT,
        headers={**HEADERS, "Referer": "https://cloud.189.cn/", "Accept": "application/json, text/xml"},
    )
    text = r.text or ""
    if "ShareNotFound" in text or "share not found" in text.lower() or "不存在" in text:
        return "dead", r.status_code, "天翼分享不存在/已取消"
    if r.status_code == 200 and ("shareId" in text or "fileName" in text or "ShareInfo" in text):
        return "alive", 200, "正常"
    # InvalidSessionKey 但仍可能有 share 信息；无 ShareNotFound 时保守 unknown
    if "InvalidSessionKey" in text and "ShareNotFound" not in text:
        # 再试网页关键词
        return _check_html_generic(url, "天翼")
    return "unknown", r.status_code, text[:60].replace("\n", " ")


def _check_xunlei(url: str) -> tuple[str, int, str]:
    # 迅雷前端 SPA；用 pass page + 关键词，避免假 alive
    return _check_html_generic(url, "迅雷", spa_strict=True)


def _check_pikpak(url: str) -> tuple[str, int, str]:
    u = url.lower()
    if "magnet:" in u or "__add_url=magnet" in u:
        return "skip", 0, "PikPak磁力跳转免测"
    return _check_html_generic(url, "PikPak", spa_strict=True)


def _check_guangya(url: str) -> tuple[str, int, str]:
    """光鸭 API 需登录态；页面为 SPA。无明确死链信号时标 unknown，禁止假 alive。"""
    sid = extract_share_id(url, "guangya")
    if not sid:
        return "unknown", 0, "无法提取光鸭分享ID"
    # 尝试公开 API（多数情况 401）
    try:
        r = _session().get(
            "https://api.guangyapan.com/share",
            params={"shareId": sid},
            timeout=TIMEOUT,
            headers={
                **HEADERS,
                "Accept": "application/json",
                "Origin": "https://www.guangyapan.com",
                "Referer": url,
            },
        )
        if r.status_code == 200:
            d = r.json() if r.text else {}
            if isinstance(d, dict) and (d.get("code") in (0, 200) or d.get("data")):
                return "alive", 200, "正常"
            code = d.get("code")
            msg = str(d.get("msg") or d.get("message") or "")
            if code and code not in (0, 117) and any(w in msg for w in ("不存在", "取消", "失效", "过期")):
                return "dead", 200, f"光鸭失效({code})"
        # 401 无效 token：无法鉴权，走 SPA 策略
    except requests.RequestException:
        pass
    return _check_html_generic(url, "光鸭", spa_strict=True)


def _check_caiyun(url: str) -> tuple[str, int, str]:
    """和彩云 / 移动云盘（yun.139 / caiyun.139）— SPA，严格模式。"""
    return _check_html_generic(url, "和彩云", spa_strict=True)


def _looks_like_spa_shell(body: str) -> bool:
    b = (body or "").lower()
    if len(body) < 800:
        return True
    markers = (
        'id="root"',
        'id="app"',
        "data-n-head",
        "__nuxt__",
        "react",
        "vite",
        "webpack",
    )
    has_marker = any(m in b for m in markers)
    has_content = any(w in body for w in _HTML_ALIVE + _HTML_DEAD)
    return has_marker and not has_content


def _check_html_generic(
    url: str, label: str = "", spa_strict: bool = False
) -> tuple[str, int, str]:
    r = _session().get(url, timeout=TIMEOUT, allow_redirects=True)
    if r.status_code in (404, 410, 410):
        return "dead", r.status_code, f"{label}页面不存在"
    body = r.text or ""
    for sig in _HTML_DEAD:
        if sig.lower() in body.lower() or sig in body:
            return "dead", r.status_code, f"{label}提示:{sig[:12]}"
    if spa_strict and _looks_like_spa_shell(body):
        return "unknown", r.status_code, f"{label}SPA无法无登录判定"
    for sig in _HTML_ALIVE:
        if sig in body:
            return "alive", 200, "正常"
    if not spa_strict and r.status_code == 200 and len(body) > 1500:
        return "alive", 200, "正常"
    return "unknown", r.status_code, f"{label}无明确信号"


_CHECKERS: dict[str, Callable[[str], tuple[str, int, str]]] = {
    "quark": lambda u: _check_quark_like(
        u, "https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token", "夸克"
    ),
    "uc": lambda u: _check_quark_like(
        u, "https://pc-api.uc.cn/1/clouddrive/share/sharepage/token", "UC"
    ),
    "aliyun": _check_aliyun,
    "baidu": _check_baidu,
    "115": _check_115,
    "123": _check_123,
    "tianyi": _check_tianyi,
    "xunlei": _check_xunlei,
    "pikpak": _check_pikpak,
    "guangya": _check_guangya,
    "caiyun": _check_caiyun,
}


def check_single_link(url: str, source: str = "") -> tuple[str, int, str]:
    if not url:
        return "invalid", 0, "空链接"
    u = url.strip()
    low = u.lower()
    if low.startswith("magnet:") or low.startswith("ed2k:"):
        return "skip", 0, "磁力/电驴链接免测"

    pan = detect_pan(u, source)
    if pan in ("magnet", "ed2k"):
        return "skip", 0, "磁力/电驴链接免测"

    try:
        checker = _CHECKERS.get(pan)
        if checker:
            return checker(u)
        return _check_html_generic(u, pan or "其它", spa_strict=True)
    except requests.exceptions.Timeout:
        return "timeout", 0, "请求超时"
    except requests.exceptions.ConnectionError:
        return "unknown", 0, "连接失败(网络)"
    except UnicodeEncodeError:
        return "unknown", 0, "URL含非ASCII导致请求头失败"
    except Exception as e:
        logger.exception("check_single_link error")
        return "error", 0, str(e)[:50]


# 兼容旧名
check_link = check_single_link
