#!/usr/bin/env python3
"""Poll IMAP for the newest Microsoft single-use code email and print the code.

Usage:
  IMAP_HOST=mail.reevalmail.com IMAP_PORT=993 IMAP_USER=xxx IMAP_PASS=yyy \
    python3 scripts/ig-imap-code.py [--poll-seconds 90]

Prints the 6-digit code on stdout; exits 1 on timeout.
"""
import imaplib
import os
import re
import ssl
import sys
import time

host = os.environ.get("IMAP_HOST", "mail.reevalmail.com")
port = int(os.environ.get("IMAP_PORT", "993"))
user = os.environ.get("IMAP_USER", "")
password = os.environ.get("IMAP_PASS", "")
poll_seconds = 90
if "--poll-seconds" in sys.argv:
    idx = sys.argv.index("--poll-seconds")
    try:
        poll_seconds = int(sys.argv[idx + 1])
    except (IndexError, ValueError):
        pass

if not user or not password:
    print("ERR missing IMAP_USER/IMAP_PASS", file=sys.stderr)
    sys.exit(1)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def fetch_code(mail):
    typ, data = mail.select("INBOX")
    if typ != "OK":
        return None
    typ, data = mail.search(None, "ALL")
    ids = data[0].split()
    if not ids:
        return None
    for i in ids[-3:]:
        typ, md = mail.fetch(i, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])")
        if typ != "OK":
            continue
        head = md[0][1].decode("utf-8", "replace")
        if "single-use code" not in head.lower() and "security code" not in head.lower():
            continue
        typ2, md2 = mail.fetch(i, "(BODY.PEEK[TEXT])")
        if typ2 != "OK":
            continue
        body = md2[0][1].decode("utf-8", "replace")
        text = head + "\n" + body
        m = re.search(r"code is:?\s*(\d{6})", text, re.I)
        if not m:
            m = re.search(r"\b(\d{6})\b", text)
        if m:
            return m.group(1)
    return None


deadline = time.time() + poll_seconds
last_err = None
while time.time() < deadline:
    mail = None
    try:
        mail = imaplib.IMAP4_SSL(host, port, ssl_context=ctx)
        mail.login(user, password)
        code = fetch_code(mail)
        if code:
            print(code)
            sys.exit(0)
    except Exception as e:  # noqa: BLE001
        last_err = repr(e)
    finally:
        if mail:
            try:
                mail.logout()
            except Exception:  # noqa: BLE001
                pass
    time.sleep(5)

print("ERR timeout waiting for Microsoft code" + (": " + last_err if last_err else ""), file=sys.stderr)
sys.exit(1)
