
"""beta_send_v2.py -- JSON + multipart file sender for the live admin test API."""
import json, time, http.client, base64, urllib.request, uuid, mimetypes

HOST = "3.0.132.150"; PORT = 3000
ADMIN_USER = "admin"; ADMIN_PASS = "NcLaw$2026!xK9m"

def _cookies():
    creds = base64.b64encode(f"{ADMIN_USER}:{ADMIN_PASS}".encode()).decode()
    conn = http.client.HTTPConnection(HOST, PORT, timeout=15)
    conn.request("GET", "/admin", headers={"Authorization": f"Basic {creds}"})
    resp = conn.getresponse(); resp.read()
    ck = {}
    for h, v in resp.getheaders():
        if h.lower() == "set-cookie":
            part = v.split(";")[0].strip()
            if "=" in part:
                k, val = part.split("=", 1); ck[k.strip()] = val.strip()
    conn.close(); return ck

def _hdrs(ck, extra=None):
    s = ck.get("nanoclaw_admin_session",""); c = ck.get("nanoclaw_admin_csrf","")
    h = {"Cookie": f"nanoclaw_admin_session={s}; nanoclaw_admin_csrf={c}", "X-CSRF-Token": c}
    if extra: h.update(extra)
    return h

def _parse(data, t0):
    elapsed = round(time.time()-t0, 2)
    if data.get("status") == "ok":
        body = data.get("response","")
        if isinstance(body, dict):
            body = body.get("text") or body.get("content") or json.dumps(body)
        return {"ok": True, "response": str(body), "elapsed_s": elapsed}
    return {"ok": False, "response": None, "elapsed_s": elapsed,
            "error": data.get("note") or data.get("error") or json.dumps(data)[:200]}

def send_message(user_id, text, timeout=50):
    t0 = time.time()
    try:
        ck = _cookies()
        payload = json.dumps({"userId": user_id, "text": text}).encode()
        req = urllib.request.Request(f"http://{HOST}:{PORT}/admin/api/test/send",
            data=payload, headers=_hdrs(ck, {"Content-Type":"application/json"}), method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return _parse(json.loads(r.read()), t0)
    except urllib.error.HTTPError as e:
        try: body = json.loads(e.read())
        except Exception: body = {"error": f"HTTP {e.code}"}
        return _parse(body, t0) if isinstance(body, dict) and body.get("status") else \
               {"ok": False, "response": None, "elapsed_s": round(time.time()-t0,2), "error": body.get("note") or body.get("error") or f"HTTP {e.code}"}
    except Exception as e:
        return {"ok": False, "response": None, "elapsed_s": round(time.time()-t0,2), "error": str(e)}

def send_file(user_id, file_path, text="", timeout=60, filename=None, mime=None):
    """POST multipart/form-data: userId, text, file."""
    t0 = time.time()
    try:
        ck = _cookies()
        fn = filename or os.path.basename(file_path)
        ct = mime or (mimetypes.guess_type(fn)[0] or "application/octet-stream")
        with open(file_path, "rb") as f: fbytes = f.read()
        boundary = "----clawdv2" + uuid.uuid4().hex
        CRLF = "\r\n"
        parts = []
        def field(name, val):
            parts.append(f"--{boundary}{CRLF}Content-Disposition: form-data; name=\"{name}\"{CRLF}{CRLF}{val}{CRLF}".encode())
        field("userId", user_id); field("text", text)
        head = (f"--{boundary}{CRLF}"
                f"Content-Disposition: form-data; name=\"file\"; filename=\"{fn}\"{CRLF}"
                f"Content-Type: {ct}{CRLF}{CRLF}").encode()
        body = b"".join(parts) + head + fbytes + f"{CRLF}--{boundary}--{CRLF}".encode()
        req = urllib.request.Request(f"http://{HOST}:{PORT}/admin/api/test/send",
            data=body, headers=_hdrs(ck, {"Content-Type": f"multipart/form-data; boundary={boundary}"}), method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return _parse(json.loads(r.read()), t0)
    except urllib.error.HTTPError as e:
        try: b = json.loads(e.read())
        except Exception: b = {}
        return {"ok": False, "response": None, "elapsed_s": round(time.time()-t0,2), "error": b.get("note") or b.get("error") or f"HTTP {e.code}"}
    except Exception as e:
        return {"ok": False, "response": None, "elapsed_s": round(time.time()-t0,2), "error": str(e)}

import os
