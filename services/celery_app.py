# -*- coding: utf-8 -*-
"""VaultDrive 死链 · Celery（Python 消息队列 / 分布式任务）。

Broker / Result backend：现有 Redis（resource_web_redis）。
队列：
  deadlink.extract — 从 MySQL 大批量抽出并投递检测任务
  deadlink.check   — 消费检测任务
  deadlink.write   — 按检测结果写回 MySQL
"""
from __future__ import annotations

import os

from celery import Celery


def _broker_url() -> str:
    host = os.environ.get("REDIS_HOST", "127.0.0.1")
    port = os.environ.get("REDIS_PORT", "6379")
    db = os.environ.get("CELERY_REDIS_DB", os.environ.get("REDIS_DB", "0"))
    password = os.environ.get("REDIS_PASSWORD") or ""
    auth = f":{password}@" if password else ""
    return f"redis://{auth}{host}:{port}/{db}"


app = Celery("vault_deadlink", include=["services.deadlink_tasks"])
app.conf.broker_url = _broker_url()
app.conf.result_backend = _broker_url()

app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Shanghai",
    enable_utc=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_default_queue="deadlink.check",
    task_routes={
        "deadlink.extract": {"queue": "deadlink.extract"},
        "deadlink.check_batch": {"queue": "deadlink.check"},
        "deadlink.write_batch": {"queue": "deadlink.write"},
    },
    broker_transport_options={
        "visibility_timeout": 3600,
    },
    result_expires=3600,
    worker_hijack_root_logger=False,
    broker_connection_retry_on_startup=True,
)