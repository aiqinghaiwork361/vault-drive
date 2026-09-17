#!/usr/bin/env python3
from services.link_checker import check_single_link

cases = [
    ("https://www.alipan.com/s/fP43UcChsQ7", "aliyun"),
    ("https://pan.quark.cn/s/e637ac4e8605", "quark"),
    ("https://pan.quark.cn/s/000000000000", "quark"),
    ("https://123865.com/s/Oqtgvd-XXXXX", "123"),
    ("https://115cdn.com/s/sws5drn33xj?password=5hq7", "115"),
    ("https://cloud.189.cn/t/AVZ7zqrEn2Un", "tianyi"),
]
for u, s in cases:
    st, code, msg = check_single_link(u, s)
    print(f"{s:8} {st:8} {code} {msg[:60]}")
