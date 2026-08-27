# -*- coding: utf-8 -*-
"""资源去重 / 聚合：写入 resource_aggregate。"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

SOURCE_RANK = {
    "quark": 10,
    "aliyun": 20,
    "ali": 20,
    "baidu": 30,
    "xunlei": 40,
    "115": 50,
    "123pan": 55,
    "pikpak": 60,
    "magnet": 80,
}


def _norm(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"[\s\[\]【】（）()·・\.\,:：\-_/\\|]+", "", s)
    return s


def compute_hash(title: str, year: Any = None, typ: str = "") -> str:
    key = f"{_norm(title)}|{year or ''}|{_norm(typ)}"
    return hashlib.md5(key.encode("utf-8")).hexdigest()


def _quality_score(q: str) -> int:
    q = (q or "").upper()
    for token, score in (("4K", 100), ("2160", 100), ("1080", 80), ("720", 50), ("480", 20)):
        if token in q:
            return score
    return 0


def _pick_best(rows: list[dict]) -> dict:
    def score(r):
        src = (r.get("source") or "").lower()
        live = 0 if (r.get("link_status") == "dead" or r.get("is_valid") == 0) else 1000
        return (
            live,
            -SOURCE_RANK.get(src, 70),
            _quality_score(r.get("quality") or ""),
            int(r.get("id") or 0),
        )

    return sorted(rows, key=score, reverse=True)[0]


def rebuild_aggregate(cur, only_multi: bool = True, max_groups: int = 500) -> dict:
    """按 keyword 聚合（有索引，快）。默认只写重复组。"""
    max_groups = max(20, min(int(max_groups or 500), 2000))
    having = "HAVING cnt > 1" if only_multi else ""
    cur.execute(
        f"""
        SELECT keyword AS k, COUNT(*) AS cnt
        FROM resources
        WHERE keyword IS NOT NULL AND keyword != ''
        GROUP BY keyword
        {having}
        ORDER BY cnt DESC
        LIMIT %s
        """,
        (max_groups,),
    )
    groups = cur.fetchall() or []
    cur.execute("DELETE FROM resource_aggregate")
    written = multi = scanned_members = 0

    for g in groups:
        kw = g["k"]
        cur.execute(
            """
            SELECT id, title, keyword, source, url, quality, type, year, rating,
                   link_status, is_valid
            FROM resources
            WHERE keyword=%s
            ORDER BY id DESC
            LIMIT 60
            """,
            (kw,),
        )
        members = cur.fetchall() or []
        if not members:
            continue
        scanned_members += len(members)
        if len(members) > 1:
            multi += 1
        best = _pick_best(members)
        sources = [
            {
                "id": m.get("id"),
                "source": m.get("source"),
                "url": m.get("url"),
                "quality": m.get("quality"),
                "link_status": m.get("link_status"),
                "is_valid": m.get("is_valid"),
            }
            for m in members
        ]
        title = (best.get("title") or kw)[:500]
        h = compute_hash(kw, best.get("year"), best.get("type") or "")
        cur.execute(
            """
            INSERT INTO resource_aggregate
              (resource_hash, title, sources, best_source, best_url, best_quality,
               type, year, rating, tags, view_count)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,0)
            """,
            (
                h,
                title,
                json.dumps(sources, ensure_ascii=False),
                (best.get("source") or "")[:50],
                best.get("url") or "",
                (best.get("quality") or "")[:50],
                (best.get("type") or "")[:50],
                best.get("year"),
                best.get("rating"),
                json.dumps({"keyword": kw, "count": int(g.get("cnt") or len(members))}, ensure_ascii=False),
            ),
        )
        written += 1

    return {
        "ok": True,
        "groups": written,
        "multi_source_groups": multi,
        "members_scanned": scanned_members,
        "only_multi": only_multi,
    }


def list_aggregate(cur, q: str = "", page: int = 1, per_page: int = 20) -> dict:
    page = max(1, int(page or 1))
    per_page = min(max(1, int(per_page or 20)), 50)
    offset = (page - 1) * per_page
    conds, params = [], []
    if q:
        conds.append("(title LIKE %s)")
        params.append(f"%{q.strip()}%")
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    cur.execute(f"SELECT COUNT(*) c FROM resource_aggregate {where}", params)
    total = int((cur.fetchone() or {}).get("c") or 0)
    cur.execute(
        f"""
        SELECT id, resource_hash, title, sources, best_source, best_url, best_quality,
               type, year, rating, tags, view_count, created_at, updated_at
        FROM resource_aggregate
        {where}
        ORDER BY updated_at DESC
        LIMIT %s OFFSET %s
        """,
        params + [per_page, offset],
    )
    items = cur.fetchall() or []
    for it in items:
        try:
            src = json.loads(it.get("sources") or "[]")
        except Exception:
            src = []
        it["source_count"] = len(src) if isinstance(src, list) else 0
        it["sources_parsed"] = src if isinstance(src, list) else []
    return {"items": items, "total": total, "page": page, "per_page": per_page}
