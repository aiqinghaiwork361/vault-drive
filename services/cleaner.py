# -*- coding: utf-8 -*-
"""
数据清洗与分类/画质归一化引擎
"""
from __future__ import annotations
import re
from typing import Any, Dict, List, Optional, Tuple

STANDARD_TYPES = [
    "电影", "电视剧", "短剧", "动漫", "综艺", "纪录片", "教程", "游戏", "音乐", "书籍", "软件"
]

GENERIC_GENRES = {
    "剧情", "动作", "喜剧", "恐怖", "惊悚", "科幻", "奇幻", "爱情", "战争", "犯罪", "悬疑", "武侠", "古装", "历史"
}

TYPE_MAPPING = {
    # 电视剧明确分类
    "电视剧": ("电视剧", None), "剧集": ("电视剧", None), "国产剧": ("电视剧", "国产剧"),
    "大陆剧": ("电视剧", "国产剧"), "香港剧": ("电视剧", "港剧"), "港剧": ("电视剧", "港剧"),
    "台湾剧": ("电视剧", "台剧"), "台剧": ("电视剧", "台剧"), "欧美剧": ("电视剧", "欧美剧"),
    "美剧": ("电视剧", "美剧"), "美国剧": ("电视剧", "美剧"), "英剧": ("电视剧", "英剧"),
    "日剧": ("电视剧", "日剧"), "日本剧": ("电视剧", "日剧"), "韩剧": ("电视剧", "韩剧"),
    "韩国剧": ("电视剧", "韩剧"), "泰剧": ("电视剧", "泰剧"), "泰国剧": ("电视剧", "泰剧"),
    "海外剧": ("电视剧", "海外剧"),
    # 短剧
    "短剧": ("短剧", None), "微短剧": ("短剧", None),
    # 电影明确分类
    "电影": ("电影", None), "剧情片": ("电影", "剧情"), "动作片": ("电影", "动作"),
    "喜剧片": ("电影", "喜剧"), "恐怖片": ("电影", "恐怖"), "惊悚片": ("电影", "惊悚"),
    "科幻片": ("电影", "科幻"), "奇幻片": ("电影", "奇幻"), "爱情片": ("电影", "爱情"),
    "战争片": ("电影", "战争"), "犯罪片": ("电影", "犯罪"), "悬疑片": ("电影", "悬疑"),
    # 动漫
    "动漫": ("动漫", None), "动画": ("动漫", None), "动画片": ("动漫", None),
    "动画电影": ("动漫", "动画电影"),
    "国产动漫": ("动漫", "国漫"), "国漫": ("动漫", "国漫"), "日漫": ("动漫", "日漫"),
    "日本动漫": ("动漫", "日漫"), "日韩动漫": ("动漫", "日韩动漫"), "欧美动漫": ("动漫", "欧美动漫"),
    # 纪录片
    "记录片": ("纪录片", None), "纪录片": ("纪录片", None),
    # 综艺
    "综艺": ("综艺", None), "大陆综艺": ("综艺", "大陆综艺"), "港台综艺": ("综艺", "港台综艺"),
    "日韩综艺": ("综艺", "日韩综艺"), "欧美综艺": ("综艺", "欧美综艺"), "真人秀": ("综艺", "真人秀"),
    # 教程
    "教程": ("教程", None), "课程": ("教程", None), "培训": ("教程", None), "公开课": ("教程", None),
    # 游戏
    "游戏": ("游戏", None), "ns游戏": ("游戏", "Switch"), "switch游戏": ("游戏", "Switch"),
    "pc游戏": ("游戏", "PC游戏"), "ps5游戏": ("游戏", "PS5"), "ps4游戏": ("游戏", "PS4"),
    # 音乐
    "音乐": ("音乐", None), "无损音乐": ("音乐", "无损"), "专辑": ("音乐", "专辑"),
    # 书籍
    "书籍": ("书籍", None), "电子书": ("书籍", "电子书"), "小说": ("书籍", "小说"), "漫画": ("动漫", "漫画"),
    # 软件
    "软件": ("软件", None), "源码": ("软件", "源码"),
}

QUALITY_PATTERNS = [
    (re.compile(r"(?i)\b(2160p|4k|uhd)\b"), "4K"),
    (re.compile(r"(?i)\b(1080p|fhd|1080i)\b"), "1080P"),
    (re.compile(r"(?i)\b(720p|hd)\b"), "720P"),
    (re.compile(r"(?i)\b(480p|sd)\b"), "480P"),
    (re.compile(r"(?i)\b(remux)\b"), "REMUX"),
    (re.compile(r"(?i)\b(bluray|blu-ray|蓝光)\b"), "BluRay"),
    (re.compile(r"(?i)\b(hdr10\+|hdr10|hdr|杜比视界|dolby\s*vision|dv)\b"), "HDR"),
]

def extract_quality(text: str) -> Optional[str]:
    if not text:
        return None
    for pattern, qual in QUALITY_PATTERNS:
        if pattern.search(text):
            return qual
    return None

def clean_type_string(raw_type: str) -> str:
    if not raw_type:
        return ""
    s = raw_type.strip()
    s = re.sub(r"^[【\[\(（\s]+|[】\]\)）\s]+$", "", s)
    s = re.sub(r"[【\[].*?[】\]]", "", s)
    s = s.replace("】", "").replace("【", "").replace("]", "").replace("[", "")
    s = re.sub(r"/\s*$", "", s).strip()
    return s

def classify_resource(title: str = "", raw_type: str = "", note: str = "", existing_quality: str = "") -> Dict[str, Any]:
    title = (title or "").strip()
    raw_type_clean = clean_type_string(raw_type)
    note = (note or "").strip()
    full_text = f"{title} {raw_type_clean} {note}"

    # 1. 提取画质
    quality = existing_quality.strip() if existing_quality else ""
    if not quality or quality not in ["4K", "1080P", "720P", "480P", "REMUX", "BluRay", "HDR"]:
        extracted_q = extract_quality(full_text)
        if extracted_q:
            quality = extracted_q

    matched_type = None
    matched_subtype = None
    tags = []

    # 2. 检查强特征（短剧 / 教程 / 游戏 / 音乐 / 剧集 / 动漫）
    if re.search(r"\|\s*短剧|短剧|（\d+集）|\(\d+集\)|【\d+集】", title):
        matched_type = "短剧"
    elif re.search(r"课程|教程|训练营|架构师|全套视频|讲座|网课|零基础|实战|从入门到精通", title):
        matched_type = "教程"
    elif re.search(r"\[动漫\]|\[动画\]|【动漫】|【动画】|国漫|日漫|番剧|OVA|剧场版", title):
        matched_type = "动漫"
    elif re.search(r"\[NS\]|\[PC\]|Switch游戏|NS游戏|Steam|免安装版|中文版游戏|豪华版|游戏源码|单机游戏", title):
        matched_type = "游戏"
    elif re.search(r"FLAC|APE|无损|Hi-Res|320K|单曲|专辑|音乐合集", title):
        matched_type = "音乐"
    elif re.search(r"全\d+集|更新至\d+集|更至\d+集|第[0-9一二三四五六七八九十]+[季部集]|EP?\d{2}|S\d{2}E\d{2}|\[(国产剧|美剧|韩剧|日剧|港剧|台剧|泰剧|电视剧)\]|【(国产剧|美剧|韩剧|日剧|港剧|台剧|泰剧|电视剧)】", title, re.IGNORECASE):
        matched_type = "电视剧"
    elif re.search(r"纪录片|记录片|探索频道|BBC|国家地理|NHK", title):
        matched_type = "纪录片"

    # 3. 匹配原始分类
    if not matched_type and raw_type_clean:
        low_t = raw_type_clean.lower()
        if low_t in TYPE_MAPPING:
            matched_type, matched_subtype = TYPE_MAPPING[low_t]
        elif low_t in GENERIC_GENRES:
            # 泛类型（如 剧情、动作、科幻），若标题有电影特征或无其他特征，默认为电影
            matched_type = "电影"
            matched_subtype = low_t
        else:
            parts = [p.strip() for p in re.split(r"[/|,，、\s]+", raw_type_clean) if p.strip()]
            for p in parts:
                p_low = p.lower()
                if p_low in TYPE_MAPPING:
                    main_t, sub_t = TYPE_MAPPING[p_low]
                    if not matched_type:
                        matched_type = main_t
                    if sub_t:
                        tags.append(sub_t)
                elif p_low in GENERIC_GENRES:
                    if not matched_type:
                        matched_type = "电影"
                    tags.append(p)

    # 4. 若仍未匹配，检查电影特征
    if not matched_type:
        if re.search(r"\[电影\]|【电影】|HD中字|BD中英双字|TC抢先|HD国语|TS抢先|2160p|1080p|BluRay|REMUX", title, re.IGNORECASE):
            matched_type = "电影"

    if not matched_type:
        matched_type = "其他"

    if matched_subtype and matched_subtype not in tags:
        tags.append(matched_subtype)

    return {"type": matched_type, "quality": quality, "tags_to_add": tags}

def clean_single_row(row: Dict[str, Any]) -> Dict[str, Any]:
    res = classify_resource(
        title=row.get("title") or "",
        raw_type=row.get("type") or "",
        note=row.get("note") or "",
        existing_quality=row.get("quality") or "",
    )
    updates = {}
    new_type = res["type"]
    new_quality = res["quality"]
    curr_type = (row.get("type") or "").strip()
    curr_quality = (row.get("quality") or "").strip()

    if new_type and new_type != "其他" and new_type != curr_type:
        updates["type"] = new_type

    if new_quality and new_quality != curr_quality:
        updates["quality"] = new_quality

    return updates

def preview_clean_batch(cur, limit: int = 50) -> Dict[str, Any]:
    cur.execute(
        """
        SELECT id, title, type, quality, note
        FROM resources
        WHERE type = %s OR type LIKE %s OR type LIKE %s OR quality = %s
        ORDER BY id DESC
        LIMIT %s
        """,
        ("", "%】%", "%/%", "", limit),
    )
    rows = cur.fetchall() or []
    samples = []
    for r in rows:
        updates = clean_single_row(r)
        if updates:
            samples.append({
                "id": r["id"],
                "title": r["title"],
                "old_type": r["type"],
                "new_type": updates.get("type", r["type"]),
                "old_quality": r["quality"],
                "new_quality": updates.get("quality", r["quality"]),
            })
    return {
        "scanned": len(rows),
        "will_update": len(samples),
        "samples": samples[:limit],
    }

def run_clean_batch(cur, batch_size: int = 1000) -> Dict[str, Any]:
    batch_size = min(max(10, int(batch_size or 1000)), 5000)
    cur.execute(
        """
        SELECT id, title, type, quality, note
        FROM resources
        WHERE type = %s OR type LIKE %s OR type LIKE %s OR quality = %s
        ORDER BY id ASC
        LIMIT %s
        """,
        ("", "%】%", "%/%", "", batch_size),
    )
    rows = cur.fetchall() or []
    if not rows:
        return {"ok": True, "scanned": 0, "updated": 0, "has_more": False}

    updated_count = 0
    for r in rows:
        updates = clean_single_row(r)
        if not updates:
            continue
        set_clauses = []
        params = []
        for k, v in updates.items():
            set_clauses.append(f"{k} = %s")
            params.append(v)
        params.append(r["id"])
        
        sql = "UPDATE resources SET " + ", ".join(set_clauses) + " WHERE id = %s"
        cur.execute(sql, params)
        updated_count += 1

    return {
        "ok": True,
        "scanned": len(rows),
        "updated": updated_count,
        "has_more": len(rows) == batch_size,
    }
