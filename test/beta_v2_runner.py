
"""beta_v2_runner.py -- full per-user suite runner, 4 users in parallel.
Usage: python beta_v2_runner.py <round_number>
Writes beta_v2_round{N}_results.json
"""
import sys, os, json, time, threading, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from beta_send_v2 import send_message, send_file

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(HERE, "artifacts")
USERS = ["test_alpha", "test_beta", "test_charlie", "test_delta"]
ARTIFACTS = {
    "doc_pdf": (os.path.join(ART,"clawd_doc.pdf"), "application/pdf"),
    "doc_txt": (os.path.join(ART,"clawd_fixture.txt"), "text/plain"),
    "img_text": (os.path.join(ART,"img_text.png"), "image/png"),
    "img_blank": (os.path.join(ART,"img_blank.png"), "image/png"),
}
GAP = 0.7           # seconds between same-user messages (rate-limit safe)
DOC_INDEX_WAIT = 32 # seconds to wait after a doc upload before asking about it

# Per-group response timeout (seconds). Generative groups -- image-gen (G15),
# TTS (G16), and long-running media/multi-step (G11, G18) -- take 37-39s SOLO and
# blow past a tight cap under 4-user concurrency. Give them 90s; everything else 55s.
SLOW_GROUPS = {"G11", "G15", "G16", "G18"}
def timeout_for(group):
    return 90 if group in SLOW_GROUPS else 55

def load_bank():
    with open(os.path.join(HERE,"beta_v2_bank.json"),"r",encoding="utf-8") as f:
        return json.load(f)

def run_user(user, bank, results, lock, prog):
    # Per-user state for runtime placeholders
    uploaded_filename = None
    last_reminder_id = None
    first_ingested_url = None

    def record(q, res, extra=None):
        row = {"user": user, "id": q["id"], "group": q["group"], "question": q["msg"][:300],
               "kind": q["kind"], "expected_contains": q["contains"], "semantic": q["semantic"],
               "notes": q["notes"], "ok": res.get("ok"), "elapsed_s": res.get("elapsed_s"),
               "response": res.get("response"), "error": res.get("error")}
        if extra: row.update(extra)
        with lock:
            results.append(row)
            prog["done"] += 1

    for q in bank:
        qid = q["id"]; msg = q["msg"]
        try:
            # ---- runtime placeholder substitution ----
            if msg == "__DELETE_UPLOADED__":
                if uploaded_filename:
                    res = send_message(user, f"/delete {uploaded_filename}")
                else:
                    res = {"ok": False, "response": None, "error": "no uploaded filename captured"}
                record(q, res); time.sleep(GAP); continue
            if msg == "__CLEAR_REMINDER__":
                if last_reminder_id:
                    res = send_message(user, f"/remindclear {last_reminder_id}")
                else:
                    res = {"ok": False, "response": None, "error": "no reminder id captured"}
                record(q, res); time.sleep(GAP); continue
            if msg == "__FORGET_FIRST_URL__":
                url = first_ingested_url or "https://en.wikipedia.org/wiki/Large_language_model"
                res = send_message(user, f"/forget-url {url}")
                record(q, res); time.sleep(GAP); continue

            # ---- file-based questions ----
            if q["kind"] in ("pdf","txt","img"):
                akey = q["artifact"]
                path, mime = ARTIFACTS[akey]
                if q["kind"] in ("pdf","txt"):
                    # upload as its own step, capture filename, wait for index, then ask
                    up = send_file(user, path, text="", timeout=60)
                    uploaded_filename = os.path.basename(path)
                    time.sleep(DOC_INDEX_WAIT)
                    res = send_message(user, msg, timeout=timeout_for(q["group"]))
                    record(q, res, {"upload_ok": up.get("ok"), "upload_resp": (up.get("response") or up.get("error"))[:200] if (up.get("response") or up.get("error")) else None})
                else:
                    # image: send file WITH the question text (vision path)
                    res = send_file(user, path, text=msg, timeout=max(timeout_for(q["group"]), 60))
                    record(q, res)
                time.sleep(GAP); continue

            # ---- normal text ----
            res = send_message(user, msg, timeout=timeout_for(q["group"]))
            record(q, res)

            # capture runtime values from responses
            if qid == "55" and res.get("response"):  # /list after upload -> filename
                pass
            if q["group"]=="G12" and res.get("response"):
                m = re.search(r"ID:\s*`?([0-9a-f]{6,8})`?", res["response"])
                if m: last_reminder_id = m.group(1)
            if qid == "47":  # first ingested url
                first_ingested_url = "https://en.wikipedia.org/wiki/Retrieval-augmented_generation"
            if qid == "92":
                # after forget, re-consent so box stays usable
                time.sleep(GAP)
            if qid == "92post":
                time.sleep(GAP)
                send_message(user, "yes")  # re-grant consent
            time.sleep(GAP)
        except Exception as e:
            record(q, {"ok": False, "response": None, "elapsed_s": 0, "error": f"harness exc: {e}"})
            time.sleep(GAP)

def main():
    rnd = sys.argv[1] if len(sys.argv) > 1 else "1"
    bank = load_bank()
    results = []
    lock = threading.Lock()
    prog = {"done": 0, "total": len(bank)*len(USERS)}
    threads = []
    t0 = time.time()
    stop_event = threading.Event()
    try:
        from ratelimit_flusher import start_flusher
        start_flusher(stop_event, period=18)
        print("[runner] ratelimit flusher started", flush=True)
    except Exception as _fe:
        print(f"[runner] flusher start failed: {_fe}", flush=True)
    for u in USERS:
        t = threading.Thread(target=run_user, args=(u, bank, results, lock, prog), daemon=True)
        t.start(); threads.append(t); time.sleep(0.5)  # stagger user starts
    # progress watchdog
    while any(t.is_alive() for t in threads):
        time.sleep(15)
        with lock:
            d = prog["done"]
        print(f"[{int(time.time()-t0)}s] progress {d}/{prog['total']}", flush=True)
    for t in threads: t.join(timeout=5)
    stop_event.set()
    out = os.path.join(HERE, f"beta_v2_round{rnd}_results.json")
    with open(out,"w",encoding="utf-8") as f:
        json.dump({"round": rnd, "elapsed_s": round(time.time()-t0,1), "results": results}, f, ensure_ascii=False, indent=1)
    print(f"DONE round {rnd}: {len(results)} rows in {round(time.time()-t0,1)}s -> {out}", flush=True)

if __name__ == "__main__":
    main()
