#!/usr/bin/env python3
"""触发 Celery 死链流水线：extract → check → write。"""
import os
import sys

os.environ.setdefault("REDIS_HOST", "resource_web_redis")
sys.path.insert(0, "/app")

from services.deadlink_queue import get_state
from services.deadlink_tasks import start_job

src = sys.argv[1] if len(sys.argv) > 1 else ""
st = start_job(source_filter=src, rescan_alive=True, stale_days=30)
print("engine=celery")
print("msg=", st.get("msg"))
for k in (
    "running",
    "extracting",
    "extract_done",
    "extracted",
    "celery_check",
    "celery_write",
    "jobs",
    "results",
    "written",
    "scanned",
    "source_filter",
):
    print(f"  {k}={st.get(k)}")
print("live", get_state())
