#!/usr/bin/env python3
import os
import pymysql

conn = pymysql.connect(
    host=os.environ.get("DB_HOST", "resource-mysql"),
    port=int(os.environ.get("DB_PORT", 3306)),
    user=os.environ.get("DB_USER", "root"),
    password=os.environ.get("DB_PASSWORD", ""),
    database=os.environ.get("DB_NAME", "pan_resource"),
    cursorclass=pymysql.cursors.DictCursor,
    autocommit=True,
)
cur = conn.cursor()
cur.execute(
    """
SELECT source, COUNT(*) c,
  SUM(link_status='dead') dead,
  SUM(link_status='alive') alive,
  SUM(link_status IS NULL OR link_status='' OR link_status='unknown') unchecked
FROM resources
WHERE url NOT LIKE 'magnet:%' AND url NOT LIKE 'ed2k:%'
GROUP BY source ORDER BY c DESC LIMIT 35
"""
)
for r in cur.fetchall():
    print(
        f"{r['source'] or '(空)'}\t{r['c']}\tdead={r['dead']}\talive={r['alive']}\tunchecked={r['unchecked']}"
    )
cur.execute(
    """
SELECT COUNT(*) c FROM resources WHERE link_status='alive'
 AND (last_checked IS NULL OR last_checked < DATE_SUB(NOW(), INTERVAL 3 DAY))
 AND url NOT LIKE 'magnet:%' AND url NOT LIKE 'ed2k:%'
"""
)
print("alive_stale_3d", cur.fetchone()["c"])
cur.execute(
    """
SELECT source, LEFT(url,100) u FROM resources
WHERE url REGEXP '115|quark|ali|baidu|123|pikpak|uc|189|caiyun|guang|yunpan|xunlei'
ORDER BY id DESC LIMIT 20
"""
)
for r in cur.fetchall():
    print("sample", r["source"], r["u"])
conn.close()
