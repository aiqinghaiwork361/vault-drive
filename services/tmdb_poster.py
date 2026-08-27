# -*- coding: utf-8 -*-
"""给本站资源补 TMDB 封面。不改海报墙布局，只填 latest/clicks 的 poster。"""
from __future__ import annotations

import hashlib
import json
import re
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import requests

TMDB_IMG = "https://image.tmdb.org/t/p/w342"
CACHE_TTL_HIT = 30 * 24 * 3600
CACHE_TTL_MISS = 2 * 24 * 3600
MAX_FETCH = 20

_JUNK_RE = re.compile(
    r"(\[[^\]]*\]|【[^】]*】|"
    r"\b(1080p|720p|2160p|4k|uhd|web-?dl|webrip|bluray|hdr10|hdr|s\d+e\d+|h-?264)\b|"
    r"更新?\d+集?|第\d+集|更至?\d+|更0?\d+|全\d+集|"
    r"夸克网盘.*|下载[：:].*|"
    r"简繁字幕|国语中字|国粤英?语|内封\S*|内附\S*|连续剧|韩剧|国漫|外挂中字|加更版|动画版|"
    r"［.*?］|"
    r"[🗄📜🎬]|"
    r"三部全|全[1-9]部)",
    re.I,
)
_SPACE_RE = re.compile(r"[\s_\-·・/\\|]+")


def _cache_key(q: str) -> str:
    return "res_web:tmdb_poster:" + hashlib.md5(q.encode("utf-8")).hexdigest()


def poster_url(poster_path: str) -> str:
    if not poster_path:
        return ""
    raw = TMDB_IMG + poster_path
    return "/api/img_proxy?url=" + urllib.parse.quote(raw, safe="")


def proxy_url(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw.startswith("http"):
        return ""
    return "/api/img_proxy?url=" + urllib.parse.quote(raw, safe="")


def douban_search_poster(query: str, timeout: float = 4.0) -> str | None:
    """豆瓣联想封面；失败返回 None（不缓存），无结果返回空串。"""
    if not _searchable(query):
        return ""
    try:
        resp = requests.get(
            "https://movie.douban.com/j/subject_suggest",
            params={"q": query},
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://movie.douban.com/",
            },
            timeout=timeout,
        )
        if resp.status_code != 200:
            return None
        arr = resp.json()
    except Exception:
        return None
    if not isinstance(arr, list):
        return ""
    qn = re.sub(r"[\s·・:：\-]", "", query).lower()
    best_img = ""
    best_score = -1
    for it in arr:
        img = (it.get("img") or "").replace("/s_ratio_poster/small/", "/s_ratio_poster/m/")
        if not img:
            continue
        name = (it.get("title") or it.get("sub_title") or "").strip()
        nn = re.sub(r"[\s·・:：\-]", "", name).lower()
        score = 1
        if nn == qn:
            score = 100
        elif qn and (qn in nn or nn in qn):
            score = 20
        if score > best_score:
            best_score = score
            best_img = img
    return proxy_url(best_img) if best_img else ""


def clean_query(title: str, keyword: str = "") -> str:
    kw = (keyword or "").strip()
    t = (title or "").strip()
    t = re.sub(r"^(动画|电影|剧集|韩剧|日漫|国漫)[:：]\s*", "", t)
    t = _JUNK_RE.sub(" ", t)
    t = re.sub(r"[\(\)（）].{0,24}[\)）]", " ", t)
    t = _SPACE_RE.sub(" ", t).strip()
    if kw and (len(t) > 40 or not t or len(re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", t)) < 2):
        return kw[:40]
    if not t and kw:
        return kw[:40]
    t = re.sub(r"\s*(美国|韩国|日本|英国|中国|大陆|香港|台湾)\s*$", "", t)
    t = re.sub(r"\s*第[一二三四五六七八九十\d]+季\s*$", "", t)
    return (t or kw)[:40]


def _searchable(q: str) -> bool:
    core = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", q or "")
    return len(core) >= 2


def _redis_get(r, key: str) -> str | None:
    try:
        val = r.get(key)
        if val is None:
            return None
        if isinstance(val, bytes):
            val = val.decode("utf-8", "replace")
        return str(val)
    except Exception:
        return None


def _redis_set(r, key: str, val: str, ttl: int) -> None:
    try:
        r.setex(key, ttl, val)
    except Exception:
        pass


def tmdb_search_poster(query: str, api_key: str, timeout: float = 4.0) -> str | None:
    """返回海报 URL；空串=确认无图；None=请求失败不要缓存。"""
    if not api_key or not _searchable(query):
        return ""
    try:
        resp = requests.get(
            "https://api.themoviedb.org/3/search/multi",
            params={"api_key": api_key, "language": "zh-CN", "query": query},
            timeout=timeout,
        )
        if resp.status_code != 200:
            return None
        results = (resp.json() or {}).get("results") or []
    except Exception:
        return None
    best = ""
    best_score = -1.0
    nq = re.sub(r"[\s·・:：\-]", "", query).lower()
    for it in results:
        if it.get("media_type") not in ("movie", "tv"):
            continue
        path = it.get("poster_path") or ""
        if not path:
            continue
        name = (it.get("title") or it.get("name") or "").strip()
        nn = re.sub(r"[\s·・:：\-]", "", name).lower()
        pop = float(it.get("popularity") or 0)
        score = pop
        if nn == nq:
            score += 1000
        elif nq and (nq in nn or nn in nq):
            score += 200
        if score > best_score:
            best_score = score
            best = poster_url(path)
    return best


def resolve_poster(query: str, api_key: str, keyword: str = "") -> str | None:
    """TMDB → 短词 → 豆瓣。None=网络失败。"""
    q = clean_query(query, keyword)
    poster = tmdb_search_poster(q, api_key) if q else ""
    if poster:
        return poster
    kw = (keyword or "").strip()[:40]
    if kw and kw != q and _searchable(kw):
        poster = tmdb_search_poster(kw, api_key)
        if poster:
            return poster
        q2 = kw
    else:
        q2 = q
    if not q2:
        return poster
    db = douban_search_poster(q2)
    if db:
        return db
    return poster if poster is not None else db


def lookup_posters(titles: list[str], redis_client: Any, api_key: str) -> dict[str, str]:
    """批量片名 → poster。给前端补洞用。"""
    out: dict[str, str] = {}
    missing: list[str] = []
    for raw in titles:
        t = (raw or "").strip()
        if not t or t in out:
            continue
        q = clean_query(t, t)
        cached = _redis_get(redis_client, _cache_key(q)) if q else ""
        if cached:
            out[t] = cached
        elif cached == "":
            out[t] = ""
        else:
            missing.append(t)

    def _one(t: str) -> tuple[str, str | None]:
        q = clean_query(t, t)
        return t, resolve_poster(t, api_key, q)

    if missing and api_key:
        workers = min(6, len(missing))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = [pool.submit(_one, t) for t in missing[:24]]
            for fut in as_completed(futs):
                try:
                    t, poster = fut.result()
                except Exception:
                    continue
                if poster is None:
                    continue
                q = clean_query(t, t)
                ttl = CACHE_TTL_HIT if poster else CACHE_TTL_MISS
                if q:
                    _redis_set(redis_client, _cache_key(q), poster, ttl)
                out[t] = poster or ""
    return out


def attach_posters(items: list[dict], redis_client: Any, api_key: str, max_fetch: int = MAX_FETCH) -> None:
    """就地填充 item['poster']。已有封面的跳过；其余走 Redis → TMDB。"""
    if not items:
        return
    missing = []
    for it in items:
        if it.get("poster"):
            continue
        q = clean_query(
            it.get("display_title") or it.get("title") or "",
            it.get("keyword") or it.get("hot_keyword") or "",
        )
        it["_poster_q"] = q
        if not _searchable(q):
            continue
        cached = _redis_get(redis_client, _cache_key(q))
        if cached is not None:
            it["poster"] = cached
        else:
            missing.append(it)

    # 同 query 去重，避免一轮里搜两次「钢铁侠」
    uniq: dict[str, list[dict]] = {}
    for it in missing:
        uniq.setdefault(it["_poster_q"], []).append(it)
    fetch_qs = list(uniq.keys())[:max_fetch]

    def _one(q: str) -> tuple[str, str | None]:
        kw = ""
        for it in uniq.get(q, []):
            kw = (it.get("keyword") or it.get("hot_keyword") or it.get("display_title") or "").strip()[:40]
            break
        return q, resolve_poster(q, api_key, kw)

    if fetch_qs and api_key:
        workers = min(6, len(fetch_qs))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = [pool.submit(_one, q) for q in fetch_qs]
            for fut in as_completed(futs):
                try:
                    q, poster = fut.result()
                except Exception:
                    continue
                if poster is None:
                    continue
                ttl = CACHE_TTL_HIT if poster else CACHE_TTL_MISS
                _redis_set(redis_client, _cache_key(q), poster, ttl)
                for it in uniq.get(q, []):
                    it["poster"] = poster or it.get("poster") or ""

    for it in items:
        it.pop("_poster_q", None)
