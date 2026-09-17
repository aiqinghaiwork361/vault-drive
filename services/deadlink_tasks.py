# -*- coding: utf-8 -*-
"""死链 Celery 任务：extract → check → write。"""
from __future__ import annotations

import logging
import os
import threading
from typing import Any

import pymysql

from services.celery_app import app
from services.deadlink_queue import (
    get_state,
    incr_stat,
    request_stop,
    reset_pipeline,
    set_fields,
    set_running,
    should_stop,
)
from services.link_checker import check_single_link

log = logging.getLogger("deadlink_tasks")
_tls = threading.local()

CHECK_CHUNK = int(os.environ.get("DEADLINK_CHECK_CHUNK", "1"))
EXTRACT_PAGE = int(os.environ.get("DEADLINK_FETCH_BATCH", "3000"))


def _strip_proxy() -> None:
    for k in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "http_proxy",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ):
        os.environ.pop(k, None)


def _db():
    conn = getattr(_tls, "conn", None)
    if conn is not None:
        try:
            conn.ping(reconnect=False)
            return conn
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
    conn = pymysql.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("DB_PORT", "3306")),
        user=os.environ.get("DB_USER", "root"),
        password=os.environ.get("DB_PASSWORD", ""),
        database=os.environ.get("DB_NAME", "pan_resource"),
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=True,
        charset="utf8mb4",
        connect_timeout=5,
        read_timeout=60,
        write_timeout=60,
    )
    _tls.conn = conn
    return conn


def _supported_source_sql() -> str:
    pans = (
        "quark",
        "aliyun",
        "ali",
        "baidu",
        "115",
        "123",
        "123pan",
        "pikpak",
        "guangya",
        "uc",
        "tianyi",
        "mobile",
        "caiyun",
        "yidong",
        "xunlei",
        "thunder",
    )
    in_list = ",".join(f"'{p}'" for p in pans)
    url_like = " OR ".join(
        [
            "url LIKE '%%quark.cn%%'",
            "url LIKE '%%alipan.com%%'",
            "url LIKE '%%aliyundrive.com%%'",
            "url LIKE '%%pan.baidu.com%%'",
            "url LIKE '%%115.com%%'",
            "url LIKE '%%115cdn.com%%'",
            "url LIKE '%%123pan.com%%'",
            "url LIKE '%%123865.com%%'",
            "url LIKE '%%123684.com%%'",
            "url LIKE '%%drive.uc.cn%%'",
            "url LIKE '%%cloud.189.cn%%'",
            "url LIKE '%%guangyapan.com%%'",
            "url LIKE '%%mypikpak.com%%'",
            "url LIKE '%%yun.139.com%%'",
            "url LIKE '%%caiyun.139.com%%'",
            "url LIKE '%%pan.xunlei.com%%'",
        ]
    )
    return f"(source IN ({in_list}) OR ({url_like}))"


def _where_sql(
    source_filter: str = "",
    rescan_alive: bool = True,
    stale_days: int = 3,
) -> tuple[str, list]:
    conds = [
        "url NOT LIKE 'magnet:%%'",
        "url NOT LIKE 'ed2k:%%'",
        "source NOT IN ('magnet','ed2k','plugin:thepiratebay','plugin:nyaa')",
        _supported_source_sql(),
    ]
    params: list = []
    if source_filter:
        conds.append("source = %s")
        params.append(source_filter)
    if rescan_alive:
        conds.append(
            "("
            "last_checked IS NULL OR link_status IS NULL OR link_status IN ('','unknown','timeout','error','suspect') "
            "OR (link_status='alive' AND (last_checked IS NULL OR last_checked < DATE_SUB(NOW(), INTERVAL %s DAY)))"
            ")"
        )
        params.append(int(stale_days))
    else:
        conds.append(
            "(last_checked IS NULL OR link_status IS NULL OR link_status IN ('','unknown','timeout','error'))"
        )
    return " AND ".join(conds), params


def _purge_celery_queues() -> None:
    """开新任务时清掉 Celery 队列残留。"""
    try:
        import redis

        r = redis.Redis(
            host=os.environ.get("REDIS_HOST", "127.0.0.1"),
            port=int(os.environ.get("REDIS_PORT", "6379")),
            db=int(os.environ.get("CELERY_REDIS_DB", os.environ.get("REDIS_DB", "0"))),
            password=os.environ.get("REDIS_PASSWORD") or None,
            decode_responses=True,
        )
        for q in ("deadlink.extract", "deadlink.check", "deadlink.write"):
            r.delete(q)
        # Celery Redis 未确认消息等
        for key in r.scan_iter(match="unacked*", count=200):
            r.delete(key)
        for key in r.scan_iter(match="_kombu*", count=200):
            pass  # 保留 exchange 声明
    except Exception as e:
        log.warning("purge celery queues: %s", e)


def start_job(
    source_filter: str = "",
    rescan_alive: bool = True,
    stale_days: int = 3,
    **_kwargs: Any,
) -> dict:
    """API：重置状态并用 Celery 投递 extract 任务。"""
    _purge_celery_queues()
    reset_pipeline(
        source_filter=source_filter or "",
        rescan_alive="1" if rescan_alive else "0",
        stale_days=str(stale_days),
        engine="celery",
    )
    set_running(True)
    extract_job.delay(source_filter or "", bool(rescan_alive), int(stale_days))
    st = get_state()
    st["msg"] = "已投递 Celery 任务：extract → check → write（Python 消息队列）"
    st["engine"] = "celery"
    return st


def stop_job() -> dict:
    request_stop()
    set_running(False)
    try:
        app.control.purge()
    except Exception:
        pass
    _purge_celery_queues()
    return get_state()


@app.task(name="deadlink.extract", bind=True, max_retries=0)
def extract_job(
    self,
    source_filter: str = "",
    rescan_alive: bool = True,
    stale_days: int = 3,
) -> int:
    """MySQL 游标抽出 → 按块投递 deadlink.check。"""
    _strip_proxy()
    set_fields(extracting="1", extract_done="0", engine="celery")
    where, params = _where_sql(source_filter, rescan_alive, stale_days)
    last_id = 2**31 - 1
    total = 0
    db = _db()
    try:
        while not should_stop():
            cur = db.cursor()
            cur.execute(
                f"SELECT id, url, source FROM resources WHERE {where} AND id < %s "
                f"ORDER BY id DESC LIMIT %s",
                params + [last_id, EXTRACT_PAGE],
            )
            rows = cur.fetchall()
            if not rows:
                break
            jobs = [
                [int(r["id"]), r.get("url") or "", r.get("source") or ""] for r in rows
            ]
            # 分块投递到 check 队列
            for i in range(0, len(jobs), CHECK_CHUNK):
                if should_stop():
                    break
                chunk = jobs[i : i + CHECK_CHUNK]
                check_batch.apply_async(args=[chunk], queue="deadlink.check")
                n = len(chunk)
                total += n
                incr_stat("extracted", n)
                incr_stat("queued", n)
                incr_stat("total", n)
            last_id = int(rows[-1]["id"])
            log.info(
                "celery extract page=%s total_extracted=%s last_id=%s",
                len(rows),
                total,
                last_id,
            )
            if len(rows) < EXTRACT_PAGE:
                break
    except Exception as e:
        log.exception("extract failed")
        set_fields(last_error=str(e)[:200], extracting="0")
        raise
    finally:
        set_fields(extracting="0", extract_done="1")
    log.info("celery extract done total=%s", total)
    return total


@app.task(name="deadlink.check_batch", bind=True, max_retries=2)
def check_batch(self, jobs: list) -> int:
    """检测任务（建议 chunk=1；由 Celery threads 池横向并发）。"""
    _strip_proxy()
    if should_stop() or not jobs:
        return 0

    results: list[list] = []
    for item in jobs:
        if should_stop():
            break
        try:
            rid = int(item[0])
            url = item[1] if len(item) > 1 else ""
            source = item[2] if len(item) > 2 else ""
        except Exception:
            continue
        if not url:
            try:
                db = _db()
                cur = db.cursor()
                cur.execute("SELECT url, source FROM resources WHERE id=%s", (rid,))
                row = cur.fetchone()
                if not row:
                    results.append([rid, "skip"])
                    incr_stat("scanned", 1)
                    incr_stat("unknown", 1)
                    continue
                url = row.get("url") or ""
                source = row.get("source") or source
            except Exception as e:
                log.warning("check id=%s db: %s", rid, e)
                results.append([rid, "error"])
                incr_stat("scanned", 1)
                incr_stat("error", 1)
                continue
        try:
            status, _c, _m = check_single_link(url, source)
            if status == "invalid":
                status = "unknown"
        except Exception as e:
            log.warning("check id=%s: %s", rid, e)
            status = "error"
        results.append([rid, status])
        incr_stat("scanned", 1)
        if status == "dead":
            incr_stat("dead", 1)
        elif status == "alive":
            incr_stat("alive", 1)
        elif status in ("unknown", "timeout", "skip"):
            incr_stat("unknown", 1)
        else:
            incr_stat("error", 1)

    if results:
        write_batch.apply_async(args=[results], queue="deadlink.write")
    _maybe_finish()
    return len(results)


@app.task(name="deadlink.write_batch", bind=True, max_retries=3)
def write_batch(self, pairs: list) -> int:
    """批量写回 link_status。"""
    if should_stop() and not pairs:
        return 0
    if not pairs:
        return 0
    try:
        db = _db()
        cur = db.cursor()
        cur.executemany(
            "UPDATE resources SET link_status=%s, last_checked=NOW() WHERE id=%s",
            [(status, int(rid)) for rid, status in pairs],
        )
        incr_stat("written", len(pairs))
        if len(pairs) >= 20:
            log.info("celery write flushed %s", len(pairs))
    except Exception as e:
        log.exception("write_batch failed")
        raise self.retry(exc=e, countdown=3)
    _maybe_finish()
    return len(pairs)


def _celery_queue_lens() -> tuple[int, int, int]:
    try:
        import redis

        r = redis.Redis(
            host=os.environ.get("REDIS_HOST", "127.0.0.1"),
            port=int(os.environ.get("REDIS_PORT", "6379")),
            db=int(os.environ.get("CELERY_REDIS_DB", os.environ.get("REDIS_DB", "0"))),
            password=os.environ.get("REDIS_PASSWORD") or None,
            decode_responses=True,
        )
        return (
            int(r.llen("deadlink.extract") or 0),
            int(r.llen("deadlink.check") or 0),
            int(r.llen("deadlink.write") or 0),
        )
    except Exception:
        return 0, 0, 0


def _maybe_finish() -> None:
    """抽完且三队列空、已写追上已抽 → running=0。"""
    st = get_state()
    if not st.get("running") or not st.get("extract_done") or st.get("extracting"):
        return
    _ex, check_q, write_q = _celery_queue_lens()
    extracted = int(st.get("extracted") or 0)
    written = int(st.get("written") or 0)
    scanned = int(st.get("scanned") or 0)
    if check_q == 0 and write_q == 0 and _ex == 0:
        if extracted > 0 and written >= extracted and scanned >= extracted:
            set_running(False)
            log.info(
                "celery pipeline drained extracted=%s scanned=%s written=%s",
                extracted,
                scanned,
                written,
            )


# 兼容旧入口：deadlink_worker.start_job 转调这里
