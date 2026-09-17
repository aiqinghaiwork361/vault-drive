# -*- coding: utf-8 -*-
"""死链任务入口（兼容层）。

实际消息队列引擎：**Celery**（Python）+ Redis broker。
请用 compose 中的 celery worker；本模块保留 start_job / stop 给管理 API。
"""
from __future__ import annotations

import logging

from services.deadlink_queue import get_state, request_stop, set_running
from services.deadlink_tasks import start_job, stop_job

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("deadlink_worker")

__all__ = ["start_job", "stop_job", "get_state", "main"]


def main() -> None:
    log.error(
        "旧 deadlink_worker 进程已停用。请使用 Celery：\n"
        "  celery -A services.celery_app worker -Q deadlink.check -c 32\n"
        "  celery -A services.celery_app worker -Q deadlink.write -c 4\n"
        "  celery -A services.celery_app worker -Q deadlink.extract -c 1"
    )
    raise SystemExit(2)


if __name__ == "__main__":
    main()
