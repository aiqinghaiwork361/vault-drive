# -*- coding: utf-8 -*-
"""
VaultDrive 官方邮件发送服务
- 支持腾讯企业邮 / SMTP SSL 发信
- 提供 6 位验证码富文本邮件模板
"""
from __future__ import annotations
import os
import smtplib
from email.mime.text import MIMEText
from email.header import Header
from typing import Tuple


def get_mail_config():
    return {
        "host": os.environ.get("SMTP_HOST", "smtp.exmail.qq.com"),
        "port": int(os.environ.get("SMTP_PORT", 465)),
        "user": os.environ.get("SMTP_USER", "admin@aaaaaaaa.host"),
        "password": os.environ.get("SMTP_PASS", "s6zgzvZFz6wcdXwW"),
        "from_name": os.environ.get("SMTP_FROM_NAME", "VaultDrive"),
    }


def send_otp_email(to_email: str, code: str, action: str = "register") -> Tuple[bool, str]:
    """发送 6 位验证码邮件"""
    cfg = get_mail_config()
    sender = cfg["user"]
    pwd = cfg["password"]
    host = cfg["host"]
    port = cfg["port"]
    from_name = cfg["from_name"]

    action_text = {
        "register": "注册新账号",
        "login": "快捷登录",
        "reset": "重置密码",
    }.get(action, "账号验证")

    subject = f"【VaultDrive】{code} 是您的{action_text}验证码"
    
    html_content = f"""
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="margin:0;padding:30px 15px;background-color:#0d0e12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2e8f0;">
      <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:480px;background-color:#16181d;border-radius:16px;border:1px solid #27272a;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.5);">
        <tr>
          <td style="padding:28px 28px 10px;text-align:center;">
            <div style="font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#2dd4bf;margin-bottom:6px;">VaultDrive</div>
            <div style="font-size:12px;color:#71717a;letter-spacing:0.1em;text-transform:uppercase;">影视与网盘资源聚合</div>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 28px 24px;text-align:center;">
            <p style="font-size:14px;color:#a1a1aa;margin:0 0 18px;line-height:1.6;">
              您正在申请<strong>{action_text}</strong>，验证码如下（10分钟内有效）：
            </p>
            <div style="display:inline-block;padding:12px 28px;background:rgba(45,212,191,0.08);border:1px solid rgba(45,212,191,0.3);border-radius:10px;font-family:Courier New,Courier,monospace;font-size:28px;font-weight:bold;letter-spacing:6px;color:#2dd4bf;">
              {code}
            </div>
            <p style="font-size:12px;color:#71717a;margin:20px 0 0;line-height:1.5;">
              如非本人操作，请忽略此邮件。请勿向任何人泄露验证码。
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 28px;background-color:#111216;border-top:1px solid #222328;text-align:center;font-size:11px;color:#52525b;">
            © 2026 VaultDrive · admin@aaaaaaaa.host
          </td>
        </tr>
      </table>
    </body>
    </html>
    """

    msg = MIMEText(html_content, "html", "utf-8")
    hdr_name = Header(from_name, "utf-8").encode()
    msg["From"] = f"{hdr_name} <{sender}>"
    msg["To"] = to_email
    msg["Subject"] = Header(subject, "utf-8").encode()

    try:
        if port == 465:
            server = smtplib.SMTP_SSL(host, port, timeout=10)
        else:
            server = smtplib.SMTP(host, port, timeout=10)
            server.starttls()
        server.login(sender, pwd)
        server.sendmail(sender, [to_email], msg.as_string())
        server.quit()
        return True, "发送成功"
    except Exception as e:
        return False, f"邮件发送失败: {str(e)}"
