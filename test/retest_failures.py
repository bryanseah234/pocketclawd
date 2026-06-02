"""
retest_failures.py -- targeted retest for all 8 original failures.
I (the orchestrator) evaluate every response semantically.
"""
import sys, os, io, json, time

sys.path.insert(0, os.path.dirname(__file__))
from beta_send import send_message

RESULTS = []

def check(tid, user, msg, resp, verdict_fn, desc):
    ok, reason = verdict_fn(resp)
    status = "PASS" if ok else "FAIL"
    RESULTS.append({"id": tid, "ok": ok, "user": user, "desc": desc, "response": resp})
    print(f"[{tid:>3}] {status} | {user} | {desc}")
    if not ok:
        print(f"       REASON: {reason}")
        print(f"       GOT:    {resp[:250]}")
    return ok

def run():
    # [7] profile persistence
    print("\n--- [7] Profile persistence ---")
    send_message("test_delta", "/profile depth=detailed", timeout=20)
    time.sleep(1)
    send_message("test_delta", "/profile domain=frontend", timeout=20)
    time.sleep(1)
    r7 = send_message("test_delta", "/profile", timeout=20)
    resp7 = r7.get("response","")
    check(7, "test_delta", "/profile", resp7,
        lambda r: ("detailed" in r.lower() and "frontend" in r.lower(),
                   "expected depth=detailed and domain=frontend"),
        "profile shows saved depth+domain")

    # [47][48][49] URL ingest
    print("\n--- [47][48][49] URL ingest ---")
    r47 = send_message("test_alpha", "https://en.wikipedia.org/wiki/Retrieval-augmented_generation", timeout=45)
    resp47 = r47.get("response","")
    check(47, "test_alpha", "URL paste", resp47,
        lambda r: (len(r)>80 and any(w in r.lower() for w in ["rag","retrieval","augmented","generation","wikipedia"]),
                   "should summarise the RAG article"),
        "URL fetched and summarised")

    print("  [waiting 20s for async ingest to AOSS...]")
    time.sleep(20)

    r48 = send_message("test_alpha", "What did that article say about RAG?", timeout=30)
    resp48 = r48.get("response","")
    check(48, "test_alpha", "RAG recall", resp48,
        lambda r: (any(w in r.lower() for w in ["retrieval","augmented","rag","language model","knowledge","external"]),
                   "should recall RAG content"),
        "RAG article recalled")

    r49 = send_message("test_alpha", "/ingested", timeout=25)
    resp49 = r49.get("response","")
    check(49, "test_alpha", "/ingested lists URL", resp49,
        lambda r: (
            "wikipedia" in r.lower() or "retrieval" in r.lower() or "augmented" in r.lower()
            or ("no urls" not in r.lower() and len(r) > 30),
            "should list the Wikipedia URL"),
        "/ingested shows the URL")

    # [64] reminder at 3pm today
    print("\n--- [64][66] Reminder parser ---")
    r64 = send_message("test_beta", "/remind me to call John at 3pm today", timeout=20)
    resp64 = r64.get("response","")
    check(64, "test_beta", "/remind at 3pm today", resp64,
        lambda r: (
            "call john" in r.lower() and any(c.isdigit() for c in r)
            and "couldn't parse" not in r.lower() and "couldn't understand" not in r.lower(),
            "should set reminder, not parse error"),
        "/remind at 3pm today parses")

    # [66] reminder tomorrow at 9am
    r66 = send_message("test_beta", "/remind me to check emails tomorrow at 9am", timeout=20)
    resp66 = r66.get("response","")
    check(66, "test_beta", "/remind tomorrow at 9am", resp66,
        lambda r: (
            "check email" in r.lower() and any(c.isdigit() for c in r)
            and "couldn't parse" not in r.lower() and "couldn't understand" not in r.lower(),
            "should set reminder, not parse error"),
        "/remind tomorrow at 9am parses")

    # [91] /list formatter
    print("\n--- [91] /list formatter ---")
    r91 = send_message("test_delta", "/list", timeout=20)
    resp91 = r91.get("response","")
    check(91, "test_delta", "/list", resp91,
        lambda r: (
            "{'key':" not in r and "lastModified" not in r
            and ("no documents" in r.lower() or any(
                x in r.lower() for x in [".pdf",".txt",".doc",".pptx",".xlsx","slides","draft","_","-"]
            )),
            "should show filenames not raw dicts"),
        "/list shows clean filenames")

    # [102] multi-turn
    print("\n--- [102] Multi-turn memory ---")
    send_message("test_charlie", "My name is Alex and I'm a teacher", timeout=20)
    time.sleep(3)
    r102 = send_message("test_charlie", "What did I just tell you about myself?", timeout=25)
    resp102 = r102.get("response","")
    check(102, "test_charlie", "multi-turn recall", resp102,
        lambda r: ("alex" in r.lower() and "teacher" in r.lower(),
                   "should recall Alex+teacher"),
        "recalls Alex+teacher from prior turn")

    # Summary
    passed = sum(1 for x in RESULTS if x["ok"])
    total  = len(RESULTS)
    print(f"\n{'='*55}")
    print(f"RETEST: {passed}/{total} PASS")
    if passed < total:
        print("FAILURES:")
        for x in RESULTS:
            if not x["ok"]:
                print(f"  [{x['id']:>3}] {x['desc']}")
    print("="*55)
    out = os.path.join(os.path.dirname(__file__), "retest_results.json")
    with io.open(out, "w", encoding="utf-8") as f:
        json.dump(RESULTS, f, indent=2, ensure_ascii=False)
    print(f"Saved -> {out}")
    return passed == total

if __name__ == "__main__":
    sys.exit(0 if run() else 1)