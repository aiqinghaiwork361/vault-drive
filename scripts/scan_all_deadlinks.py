import os
import sys
import time
import re
import requests
import pymysql
from concurrent.futures import ThreadPoolExecutor

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

def extract_id(url, source):
    u = (url or "").lower()
    if "quark" in u or "pan.quark.cn" in u:
        m = re.search(r'/s/([a-zA-Z0-9]+)', url)
        return m.group(1) if m else None
    elif "baidu" in u or "pan.baidu.com" in u:
        m = re.search(r'/s/([a-zA-Z0-9_-]+)', url)
        return m.group(1) if m else None
    elif "aliyun" in u or "alipan" in u or "aliyundrive" in u:
        m = re.search(r'/s/([a-zA-Z0-9]+)', url)
        return m.group(1) if m else None
    return None

def check_link(url, source=""):
    u = url.lower().strip()
    if u.startswith("magnet:") or u.startswith("ed2k:"):
        return "skip", "磁力免测"

    try:
        if "pan.quark.cn" in u or "quark" in source:
            sid = extract_id(url, "quark")
            if sid:
                pwd_match = re.search(r'[?&](?:pwd|passcode|code)=([a-zA-Z0-9]+)', url, re.I)
                passcode = pwd_match.group(1) if pwd_match else ""
                r = requests.post("https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token", json={"pwd_id": sid, "passcode": passcode}, timeout=5, headers=headers)
                if r.status_code == 404:
                    return "dead", "404"
                if r.status_code == 200:
                    d = r.json() if r.text else {}
                    code = d.get("code")
                    status = d.get("status")
                    msg = (d.get("message") or d.get("msg") or "")
                    if code == 0 or status == 200:
                        return "alive", "200"
                    elif code == 41008 or "需要提取码" in msg:
                        return "alive", "200_passcode"
                    elif code in (41006, 41009) or any(w in msg for w in ["不存在", "已被取消", "被删除", "违规"]):
                        return "dead", f"code_{code}"
            return "alive", "200"

        elif "pan.baidu.com" in u or "baidu" in source:
            r = requests.get(url, timeout=3, headers=headers, allow_redirects=True)
            if r.status_code in (404, 410):
                return "dead", "404"
            body = r.text
            dead_signals = ["啊哦，你来晚了", "此链接分享内容可能因为涉及侵权", "给您带来的不便", "分享的文件已经失效", "该分享已不存在", "不存在", "已被删除", "取消分享", "链接已失效"]
            for sig in dead_signals:
                if sig in body:
                    return "dead", f"baidu_{sig[:6]}"
            return "alive", "200"

        elif "alipan.com" in u or "aliyundrive.com" in u or "ali" in source:
            sid = extract_id(url, "aliyun")
            if sid:
                r = requests.post("https://api.aliyundrive.com/adrive/v3/share_link/get_share_by_anonymous", json={"share_id": sid}, timeout=3, headers=headers)
                if r.status_code in (400, 404):
                    return "dead", "404"
                d = r.json() if r.text else {}
                if d.get("code") in ("ShareLinkNotFound", "ShareLinkForbidden"):
                    return "dead", "ali_not_found"
            return "alive", "200"

        else:
            r = requests.get(url, timeout=3, allow_redirects=True, headers=headers)
            if r.status_code in (404, 410, 500):
                return "dead", "404"
            body = r.text[:2000].lower()
            for w in ['已失效', '已过期', '已删除', '文件不存在', '取消分享', '侵权已处理']:
                if w in body:
                    return "dead", w
            return "alive", "200"
    except Exception as e:
        return "unknown", str(e)[:30]

def main():
    conn = pymysql.connect(
        host=os.getenv("DB_HOST", "192.168.0.201"),
        port=int(os.getenv("DB_PORT", 3306)),
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "pan_resource"),
        autocommit=True
    )
    cur = conn.cursor()
    print("Fetching unchecked HTTP pan resources...")
    
    # 优先检测网盘类链接（排除 magnet、ed2k）
    cur.execute("""
        SELECT id, url, source FROM resources 
        WHERE (source NOT IN ('magnet','ed2k','plugin:thepiratebay','plugin:nyaa') AND url NOT LIKE 'magnet:%' AND url NOT LIKE 'ed2k:%')
          AND (link_status IS NULL OR link_status = '' OR link_status = 'unknown')
        ORDER BY id DESC LIMIT 5000
    """)
    rows = cur.fetchall()
    print(f"Loaded {len(rows)} candidate links to scan.")

    if not rows:
        print("No unchecked HTTP links.")
        conn.close()
        return

    dead_count = 0
    alive_count = 0

    def _process(row):
        rid, url, src = row
        status, reason = check_link(url, src or "")
        return rid, status, reason

    with ThreadPoolExecutor(max_workers=20) as executor:
        for rid, status, reason in executor.map(_process, rows):
            cur.execute("UPDATE resources SET link_status=%s, last_checked=NOW() WHERE id=%s", (status, rid))
            if status == "dead":
                dead_count += 1
            elif status == "alive":
                alive_count += 1

    print(f"Scan batch complete: Alive={alive_count}, Dead={dead_count}")
    conn.close()

if __name__ == "__main__":
    main()
