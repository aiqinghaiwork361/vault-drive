# -*- coding: utf-8 -*-
"""主页增强：本站动态 / 有源检测 / 个性化摘要。"""
from __future__ import annotations

import re
from typing import Any

# 网盘展示名（按真实盘，不按采集插件）
PAN_LABELS = {
    "quark": "夸克",
    "baidu": "百度",
    "aliyun": "阿里",
    "ali": "阿里",
    "xunlei": "迅雷",
    "thunder": "迅雷",
    "115": "115",
    "magnet": "磁力",
    "pikpak": "PikPak",
    "uc": "UC",
    "tianyi": "天翼",
    "123": "123",
    "123pan": "123",
    "yidong": "移动",
}

# 兼容旧 source 字段
SOURCE_LABELS = {
    **PAN_LABELS,
    "plugin:thepiratebay": "磁力",
    "plugin:u3c3": "磁力",
    "thepiratebay": "磁力",
    "u3c3": "磁力",
}

_PAN_URL_RULES = (
    ("magnet:", "magnet"),
    ("thunder://", "thunder"),
    ("quark.cn", "quark"),
    ("alipan.com", "aliyun"),
    ("aliyundrive.com", "aliyun"),
    ("pan.baidu.com", "baidu"),
    ("yun.baidu.com", "baidu"),
    ("pan.xunlei.com", "xunlei"),
    ("xunlei.com", "xunlei"),
    ("cloud.189.cn", "tianyi"),
    ("115.com", "115"),
    ("115cdn.com", "115"),
    ("drive.uc.cn", "uc"),
    ("mypikpak.com", "pikpak"),
    ("123pan.com", "123"),
    ("123684.com", "123"),
    ("yun.139.com", "yidong"),
)


def detect_pan(url: str = "", source: str = "") -> str:
    """从链接识别网盘类型；识别不到再回退 source 字段。"""
    u = (url or "").strip().lower()
    for needle, pan in _PAN_URL_RULES:
        if needle in u:
            return "aliyun" if pan == "ali" else pan
    s = (source or "").strip().lower()
    if s.startswith("plugin:"):
        s = s.split(":", 1)[1]
    if s in ("ali", "aliyun"):
        return "aliyun"
    if s in PAN_LABELS:
        return s
    if s in SOURCE_LABELS:
        key = s
        label = SOURCE_LABELS[key]
        for k, v in PAN_LABELS.items():
            if v == label:
                return k
    return "other"


def source_label(src: str, url: str = "") -> str:
    pan = detect_pan(url, src)
    return PAN_LABELS.get(pan, "其它")


def _norm_title(t: str) -> str:
    t = (t or "").strip().lower()
    t = re.sub(r"[\s\[\]【】（）()·・\.\,:：\-_/\\|]+", "", t)
    return t


def _is_dump_title(t: str) -> bool:
    t = t or ""
    if len(t) > 48:
        return True
    if "豆瓣" in t or "简　　介" in t or "产　　地" in t or "译　　名" in t:
        return True
    if t.count(".") >= 4:
        return True
    if t.lower().startswith("[vietsub]"):
        return True
    return False


def _decorate(it: dict) -> dict:
    from services.tmdb_poster import clean_query

    it["source_label"] = source_label(it.get("source") or "", it.get("url") or "")
    it["pan"] = detect_pan(it.get("url") or "", it.get("source") or "")
    it["poster"] = _first_image(it.get("images"))
    hot = (it.get("hot_keyword") or "").strip()
    disp = hot or clean_query(it.get("title") or "", it.get("keyword") or "")
    it["display_title"] = (disp or it.get("title") or it.get("keyword") or "")[:40]
    return it



def availability_for_titles(cur, titles: list[str]) -> dict[str, dict]:
    """批量查片名在本站是否有源。返回 title -> 摘要。"""
    result: dict[str, dict] = {}
    clean = []
    for t in titles:
        t = (t or "").strip()
        if t and t not in result:
            result[t] = {
                "count": 0,
                "sources": [],
                "source_labels": [],
                "has_live": False,
                "has_dead": False,
                "status": "none",  # none | live | mixed | dead
            }
            clean.append(t)
    if not clean:
        return result

    # 每片名 LIKE；控制数量避免炸库
    for title in clean[:40]:
        short = title[:40]
        cur.execute(
            """
            SELECT source, url, link_status, is_valid
            FROM resources
            WHERE (title LIKE %s OR keyword LIKE %s)
            LIMIT 80
            """,
            (f"%{short}%", f"%{short}%"),
        )
        rows = cur.fetchall() or []
        sources = set()
        labels_set = []
        live = dead = total = 0
        for r in rows:
            total += 1
            pan = detect_pan(r.get("url") or "", r.get("source") or "")
            lab = PAN_LABELS.get(pan, "其它")
            sources.add(pan)
            if lab not in labels_set:
                labels_set.append(lab)
            st = (r.get("link_status") or "").lower()
            valid = r.get("is_valid")
            if st == "dead" or valid == 0:
                dead += 1
            else:
                live += 1
        labels = [x for x in labels_set if x != "其它"][:5]
        if "其它" in labels_set and len(labels) < 5:
            labels.append("其它")
        if total == 0:
            status = "none"
        elif live > 0 and dead == 0:
            status = "live"
        elif live > 0 and dead > 0:
            status = "mixed"
        else:
            status = "dead"
        result[title] = {
            "count": total,
            "sources": sorted(sources)[:8],
            "source_labels": labels,
            "has_live": live > 0,
            "has_dead": dead > 0,
            "live": live,
            "dead": dead,
            "status": status,
        }
    return result


def personal_summary(cur, user_id: int) -> dict[str, Any]:
    """登录用户：订阅新货 / 想看有源 / 收藏数。"""
    out: dict[str, Any] = {
        "subscriptions": [],
        "watchlist_ready": [],
        "favorites_count": 0,
        "subscription_new_total": 0,
    }
    if not user_id:
        return out

    cur.execute(
        "SELECT id, keyword, created_at FROM subscriptions WHERE user_id=%s ORDER BY id DESC LIMIT 20",
        (user_id,),
    )
    subs = cur.fetchall() or []
    for sub in subs:
        kw = sub.get("keyword") or ""
        cur.execute(
            """
            SELECT COUNT(*) AS c FROM resources
            WHERE (title LIKE %s OR keyword LIKE %s)
              AND created_at > %s
              AND (link_status IS NULL OR link_status != 'dead')
            """,
            (f"%{kw}%", f"%{kw}%", sub.get("created_at")),
        )
        c = int((cur.fetchone() or {}).get("c") or 0)
        item = {
            "id": sub["id"],
            "keyword": kw,
            "created_at": sub.get("created_at"),
            "new_count": c,
        }
        out["subscriptions"].append(item)
        out["subscription_new_total"] += c

    cur.execute(
        "SELECT tmdb_id, media_type, title, poster, year, rating FROM watchlist "
        "WHERE user_id=%s ORDER BY id DESC LIMIT 30",
        (user_id,),
    )
    wl = cur.fetchall() or []
    titles = [w.get("title") or "" for w in wl]
    avail = availability_for_titles(cur, titles) if titles else {}
    for w in wl:
        title = w.get("title") or ""
        info = avail.get(title) or {}
        if info.get("has_live"):
            out["watchlist_ready"].append(
                {
                    "tmdb_id": w.get("tmdb_id"),
                    "media_type": w.get("media_type"),
                    "title": title,
                    "poster": w.get("poster"),
                    "year": w.get("year"),
                    "rating": w.get("rating"),
                    "avail": info,
                }
            )

    cur.execute(
        "SELECT COUNT(*) AS c FROM favorites WHERE user_id=%s", (user_id,)
    )
    out["favorites_count"] = int((cur.fetchone() or {}).get("c") or 0)
    return out


def _detail_score(row: dict, q: str) -> int:
    t = row.get("title") or ""
    k = row.get("keyword") or ""
    nt, nq, nk = _norm_title(t), _norm_title(q), _norm_title(k)
    score = 0
    if nt == nq or nk == nq:
        score += 120
    elif nt.startswith(nq) or nq.startswith(nt):
        score += 70
    elif nq and nq in nt:
        score += 30
    else:
        score -= 20
    if len(t) > 80:
        score -= 15
    if (row.get("link_status") or "").lower() == "dead" or row.get("is_valid") == 0:
        score -= 80
    return score


def _dedup_key(row: dict) -> str:
    src = (row.get("source") or "").lower()
    url = (row.get("url") or "").split("?")[0].rstrip("/")
    if url:
        return src + "|" + url
    return src + "|" + _norm_title(row.get("title") or "")


def title_detail(cur, title: str, limit: int = 40) -> dict[str, Any]:
    """详情抽屉：片名 → 本站链接列表 + 有源摘要（去重、按匹配度排序）。"""
    title = (title or "").strip()
    if not title:
        return {"title": "", "items": [], "avail": {}, "sources": []}
    short = title[:60]
    cur.execute(
        """
        SELECT id, title, keyword, source, url, password, quality, type, year,
               rating, note, link_status, is_valid, images, created_at, size
        FROM resources
        WHERE title LIKE %s OR keyword LIKE %s
        ORDER BY
          CASE WHEN link_status='dead' OR is_valid=0 THEN 1 ELSE 0 END,
          created_at DESC
        LIMIT 200
        """,
        (f"%{short}%", f"%{short}%"),
    )
    raw = cur.fetchall() or []
    raw.sort(key=lambda it: _detail_score(it, title), reverse=True)
    seen = set()
    items = []
    for it in raw:
        key = _dedup_key(it)
        if key in seen:
            continue
        seen.add(key)
        it["source_label"] = source_label(it.get("source") or "", it.get("url") or "")
        it["pan"] = detect_pan(it.get("url") or "", it.get("source") or "")
        it["poster"] = _first_image(it.get("images"))
        items.append(it)
        if len(items) >= limit:
            break
    # 按网盘类型汇总（夸克/阿里/百度…），不暴露 kkv/mizixing/混合盘
    pan_order = ["quark", "aliyun", "baidu", "xunlei", "115", "uc", "tianyi", "123", "pikpak", "yidong", "magnet", "thunder", "other"]
    source_counts: dict[str, int] = {}
    pan_codes: dict[str, str] = {}
    for it in items:
        lab = it.get("source_label") or "其它"
        source_counts[lab] = source_counts.get(lab, 0) + 1
        pan_codes[lab] = it.get("pan") or "other"
    sources = sorted(
        [{"label": k, "count": v, "source": pan_codes.get(k, k)} for k, v in source_counts.items()],
        key=lambda x: (pan_order.index(x["source"]) if x["source"] in pan_order else 99, -x["count"]),
    )
    avail = availability_for_titles(cur, [title]).get(title) or {}
    return {
        "title": title,
        "items": items,
        "avail": avail,
        "count": len(items),
        "raw_count": len(raw),
        "sources": sources,
    }


def _first_image(images: Any) -> str:
    if not images:
        return ""
    if isinstance(images, list):
        return images[0] if images else ""
    s = str(images).strip()
    if not s:
        return ""
    if s.startswith("["):
        try:
            import json

            arr = json.loads(s)
            if isinstance(arr, list) and arr:
                return str(arr[0])
        except Exception:
            pass
    if s.startswith("http"):
        return s.split(",", 1)[0].strip()
    return ""


def pinyin_candidates(cur, q: str, limit: int = 8) -> list[dict]:
    """拼音/首字母粗匹配：可选 pypinyin；无库则返回空。"""
    q = (q or "").strip().lower()
    if not q or not re.fullmatch(r"[a-z0-9]{1,20}", q):
        return []
    try:
        from pypinyin import lazy_pinyin, Style
    except ImportError:
        return []

    cur.execute(
        """
        SELECT keyword AS title, COUNT(*) AS hit_count
        FROM resources
        WHERE keyword IS NOT NULL AND keyword != ''
        GROUP BY keyword
        ORDER BY hit_count DESC
        LIMIT 800
        """
    )
    rows = cur.fetchall() or []
    out = []
    for r in rows:
        title = r.get("title") or ""
        full = "".join(lazy_pinyin(title, style=Style.NORMAL)).lower()
        initials = "".join(lazy_pinyin(title, style=Style.FIRST_LETTER)).lower()
        if q in full or initials.startswith(q) or q in initials:
            out.append({"keyword": title, "hit_count": r.get("hit_count") or 0})
        if len(out) >= limit:
            break
    return out
