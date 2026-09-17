# -*- coding: utf-8 -*-
"""死链三阶段流水线 · Redis 中转。

阶段:
  1) extract  MySQL → Redis jobs（大批量只抽 id/url/source）
  2) check    Redis jobs → 探测 → Redis results
  3) write    Redis results → 批量 UPDATE MySQL

Keys:
  deadlink:jobs      list  待测任务  id\\x1fsource\\x1furl
  deadlink:results   list  检测结果  id\\x1fstatus
  deadlink:pending   set   已抽出未写回的 id（防重复抽）
  deadlink:state     hash  进度
  deadlink:stop      flag
  deadlink:workers   set
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

logger = logging.getLogger("services.deadlink_queue")

SEP = "\x1f"
JOBS_KEY = "deadlink:jobs"
RESULTS_KEY = "deadlink:results"
PENDING_KEY = "deadlink:pending"
STATE_KEY = "deadlink:state"
STOP_KEY = "deadlink:stop"
WORKER_SET = "deadlink:workers"
# 兼容旧键
Q_KEY = JOBS_KEY


def _redis():
    import redis

    # socket_timeout 必须大于 BRPOP 阻塞秒数，否则空队列时会误抛 TimeoutError 把 worker 打崩
    return redis.Redis(
        host=os.environ.get("REDIS_HOST", "127.0.0.1"),
        port=int(os.environ.get("REDIS_PORT", "6379")),
        db=int(os.environ.get("REDIS_DB", "0")),
        password=os.environ.get("REDIS_PASSWORD") or None,
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=60,
        retry_on_timeout=True,
        health_check_interval=30,
    )


def pack_job(rid: int, url: str, source: str = "") -> str:
    # 去掉分隔符污染
    u = (url or "").replace(SEP, " ")
    s = (source or "").replace(SEP, " ")
    return f"{int(rid)}{SEP}{s}{SEP}{u}"


def unpack_job(raw: str) -> tuple[int, str, str] | None:
    if not raw:
        return None
    parts = raw.split(SEP, 2)
    if len(parts) < 3:
        # 兼容旧队列：纯 id
        try:
            return int(raw), "", ""
        except Exception:
            return None
    try:
        return int(parts[0]), parts[2], parts[1]
    except Exception:
        return None


def pack_result(rid: int, status: str) -> str:
    return f"{int(rid)}{SEP}{(status or 'unknown')}"


def unpack_result(raw: str) -> tuple[int, str] | None:
    if not raw:
        return None
    parts = raw.split(SEP, 1)
    if len(parts) != 2:
        return None
    try:
        return int(parts[0]), parts[1]
    except Exception:
        return None


def clear_stop(r=None) -> None:
    (r or _redis()).delete(STOP_KEY)


def request_stop(r=None) -> None:
    (r or _redis()).set(STOP_KEY, "1", ex=7200)


def should_stop(r=None) -> bool:
    return (r or _redis()).get(STOP_KEY) == "1"


def reset_pipeline(r=None, **extra) -> dict[str, Any]:
    """开新任务：清空 jobs/results/pending，重置计数。"""
    r = r or _redis()
    now = time.time()
    state = {
        "running": "1",
        "extracting": "0",
        "extract_done": "0",
        "extracted": "0",
        "scanned": "0",
        "written": "0",
        "alive": "0",
        "dead": "0",
        "unknown": "0",
        "error": "0",
        "queued": "0",
        "total": "0",
        "start_time": str(now),
        "elapsed_s": "0",
        "last_error": "",
        "source_filter": "",
        "rescan_alive": "0",
        "workers": "0",
        **{k: str(v) for k, v in extra.items()},
    }
    pipe = r.pipeline()
    pipe.delete(STATE_KEY, JOBS_KEY, RESULTS_KEY, PENDING_KEY, STOP_KEY, Q_KEY)
    # 兼容删旧 queue 名 + Celery 队列
    pipe.delete(
        "deadlink:queue",
        "deadlink.extract",
        "deadlink.check",
        "deadlink.write",
    )
    pipe.hset(STATE_KEY, mapping=state)
    pipe.execute()
    return get_state(r)


def get_state(r=None) -> dict[str, Any]:
    r = r or _redis()
    raw = r.hgetall(STATE_KEY) or {}
    out: dict[str, Any] = dict(raw)
    for k in (
        "scanned",
        "written",
        "alive",
        "dead",
        "unknown",
        "error",
        "queued",
        "total",
        "extracted",
        "elapsed_s",
        "workers",
    ):
        try:
            out[k] = int(raw.get(k) or 0)
        except Exception:
            out[k] = 0
    try:
        st = float(raw.get("start_time") or 0)
        out["start_time"] = st
        if raw.get("running") == "1" and st:
            out["elapsed_s"] = int(time.time() - st)
            r.hset(STATE_KEY, "elapsed_s", str(out["elapsed_s"]))
    except Exception:
        pass
    out["running"] = raw.get("running") == "1"
    out["extracting"] = raw.get("extracting") == "1"
    out["extract_done"] = raw.get("extract_done") == "1"
    out["rescan_alive"] = raw.get("rescan_alive") in ("1", "true", "True")
    out["engine"] = raw.get("engine") or "celery"
    # Celery 队列长度（Python 消息队列）优先；兼容旧 List 键
    try:
        cq_extract = int(r.llen("deadlink.extract") or 0)
        cq_check = int(r.llen("deadlink.check") or 0)
        cq_write = int(r.llen("deadlink.write") or 0)
    except Exception:
        cq_extract = cq_check = cq_write = 0
    legacy_jobs = int(r.llen(JOBS_KEY) or 0)
    legacy_results = int(r.llen(RESULTS_KEY) or 0)
    out["jobs"] = cq_check + legacy_jobs
    out["results"] = cq_write + legacy_results
    out["celery_extract"] = cq_extract
    out["celery_check"] = cq_check
    out["celery_write"] = cq_write
    out["queue_len"] = out["jobs"]  # 兼容旧 UI
    out["pending"] = int(r.scard(PENDING_KEY) or 0)
    try:
        out["worker_ids"] = list(r.smembers(WORKER_SET) or [])
        # Celery worker 心跳键
        celery_workers = []
        for key in r.scan_iter(match="deadlink:celery:*", count=50):
            celery_workers.append(key.split(":")[-1])
        if celery_workers:
            out["worker_ids"] = list(set(out["worker_ids"] + celery_workers))
        out["workers"] = len(out["worker_ids"]) or int(raw.get("workers") or 0)
    except Exception:
        out["worker_ids"] = []
    return out


def incr_stat(field: str, amount: int = 1, r=None) -> None:
    (r or _redis()).hincrby(STATE_KEY, field, amount)


def set_fields(r=None, **kwargs) -> None:
    r = r or _redis()
    if kwargs:
        r.hset(STATE_KEY, mapping={k: str(v) for k, v in kwargs.items()})


def set_running(flag: bool, r=None) -> None:
    set_fields(r, running="1" if flag else "0")


def enqueue_jobs(jobs: list[tuple[int, str, str]], r=None) -> int:
    """jobs: [(id, url, source), ...] → Redis。返回新入队数。"""
    if not jobs:
        return 0
    r = r or _redis()
    added = 0
    pipe = r.pipeline()
    for rid, url, source in jobs:
        pipe.sadd(PENDING_KEY, str(int(rid)))
    flags = pipe.execute()
    payload = []
    for (rid, url, source), ok in zip(jobs, flags):
        if ok:
            payload.append(pack_job(rid, url, source))
            added += 1
    if payload:
        # 分片 lpush，避免单次过大
        r = r or _redis()
        for i in range(0, len(payload), 2000):
            chunk = payload[i : i + 2000]
            r.lpush(JOBS_KEY, *chunk)
        r.hincrby(STATE_KEY, "queued", added)
        r.hincrby(STATE_KEY, "extracted", added)
        r.hincrby(STATE_KEY, "total", added)
    return added


# 兼容旧 API
def enqueue_ids(ids: list[int], r=None) -> int:
    """仅 id（无 url）—— 检测端会回表补全。"""
    return enqueue_jobs([(i, "", "") for i in ids], r=r)


def pop_jobs(n: int = 32, timeout: int = 2, r=None) -> list[tuple[int, str, str]]:
    r = r or _redis()
    out: list[tuple[int, str, str]] = []
    timeout = max(1, int(timeout or 1))  # 禁止 0：会永久阻塞且易被 socket timeout 误杀
    try:
        pipe = r.pipeline()
        for _ in range(max(1, n)):
            pipe.rpop(JOBS_KEY)
        for item in pipe.execute():
            job = unpack_job(item) if item else None
            if job:
                out.append(job)
        if out:
            return out
        item = r.brpop(JOBS_KEY, timeout=timeout)
        if not item:
            return []
        job = unpack_job(item[1])
        return [job] if job else []
    except Exception as e:
        logger.warning("pop_jobs: %s", e)
        return []


def push_results(pairs: list[tuple[int, str]], r=None) -> None:
    if not pairs:
        return
    r = r or _redis()
    payload = [pack_result(rid, st) for rid, st in pairs]
    for i in range(0, len(payload), 2000):
        r.lpush(RESULTS_KEY, *payload[i : i + 2000])


def pop_results(n: int = 200, timeout: int = 2, r=None) -> list[tuple[int, str]]:
    r = r or _redis()
    out: list[tuple[int, str]] = []
    timeout = max(1, int(timeout or 1))
    try:
        pipe = r.pipeline()
        for _ in range(max(1, n)):
            pipe.rpop(RESULTS_KEY)
        for item in pipe.execute():
            row = unpack_result(item) if item else None
            if row:
                out.append(row)
        if out:
            return out
        item = r.brpop(RESULTS_KEY, timeout=timeout)
        if not item:
            return []
        row = unpack_result(item[1])
        return [row] if row else []
    except Exception as e:
        logger.warning("pop_results: %s", e)
        return []


def clear_orphan_pending(r=None) -> int:
    """jobs/results 都空时，pending 视为孤儿（进程崩溃遗留），清掉以免 running 卡死。"""
    r = r or _redis()
    if int(r.llen(JOBS_KEY) or 0) or int(r.llen(RESULTS_KEY) or 0):
        return 0
    n = int(r.scard(PENDING_KEY) or 0)
    if n:
        r.delete(PENDING_KEY)
    return n


def ack(rid: int, r=None) -> None:
    (r or _redis()).srem(PENDING_KEY, str(int(rid)))


def register_worker(worker_id: str, r=None, ttl: int = 45) -> None:
    r = r or _redis()
    r.sadd(WORKER_SET, worker_id)
    r.setex(f"deadlink:worker:{worker_id}", ttl, "1")
    r.hset(STATE_KEY, "workers", str(len(r.smembers(WORKER_SET) or [])))


def heartbeat_worker(worker_id: str, r=None, ttl: int = 45) -> None:
    r = r or _redis()
    r.setex(f"deadlink:worker:{worker_id}", ttl, "1")
    for wid in list(r.smembers(WORKER_SET) or []):
        if not r.exists(f"deadlink:worker:{wid}"):
            r.srem(WORKER_SET, wid)
    r.hset(STATE_KEY, "workers", str(len(r.smembers(WORKER_SET) or [])))


def unregister_worker(worker_id: str, r=None) -> None:
    r = r or _redis()
    r.srem(WORKER_SET, worker_id)
    r.delete(f"deadlink:worker:{worker_id}")
    r.hset(STATE_KEY, "workers", str(len(r.smembers(WORKER_SET) or [])))


# 旧名兼容
def reset_state(r=None, **extra):
    return reset_pipeline(r=r, **extra)


def brpop_one(timeout: int = 3, r=None):
    jobs = pop_jobs(1, timeout=timeout, r=r)
    return jobs[0][0] if jobs else None
