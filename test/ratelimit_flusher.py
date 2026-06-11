
"""ratelimit_flusher.py -- background thread that clears ratelimit:* keys via SSM->container."""
import subprocess, json, tempfile, os, time, threading, base64

_INSTANCE = "i-0f9cd20350cfdc1a6"
_HERE = os.path.dirname(os.path.abspath(__file__))

def _aws(args):
    return subprocess.run(["aws"]+args+["--profile","clawd-prod","--region","ap-southeast-1","--output","json"],
                          capture_output=True, text=True, shell=True)

def _ssm(cmd, wait=7):
    params={"commands":[cmd]}
    tf=tempfile.NamedTemporaryFile("w",suffix=".json",delete=False)
    json.dump({"InstanceIds":[_INSTANCE],"DocumentName":"AWS-RunShellScript","Parameters":params},tf);tf.close()
    r=_aws(["ssm","send-command","--cli-input-json",f"file://{tf.name}"])
    try: cid=json.loads(r.stdout)["Command"]["CommandId"]
    except Exception: os.unlink(tf.name); return "SendFail", "", r.stdout[:200]
    time.sleep(wait)
    out=_aws(["ssm","get-command-invocation","--command-id",cid,"--instance-id",_INSTANCE])
    os.unlink(tf.name)
    try:
        inv=json.loads(out.stdout)
        return inv["Status"], inv.get("StandardOutputContent",""), inv.get("StandardErrorContent","")
    except Exception:
        return "PollFail","",out.stdout[:200]

def _flush_cmd():
    ob = open(os.path.join(_HERE,"_flush_oneshot.txt")).read().strip()
    _,cb = open(os.path.join(_HERE,"_flusher_args.txt")).read().split("\n")[:2]
    return (f"echo {ob} | base64 -d > /tmp/flush1.mjs && docker cp /tmp/flush1.mjs nanoclaw-orchestrator:/app/flush1.mjs && "
            f"docker exec -w /app -e NODE_PATH=/app/node_modules nanoclaw-orchestrator node /app/flush1.mjs {cb}")

def start_flusher(stop_event, period=18):
    cmd=_flush_cmd()
    def loop():
        n=0
        while not stop_event.is_set():
            st,o,e=_ssm(cmd)
            n+=1
            if n%5==1:
                print(f"[flusher] tick {n} status={st} {o.strip()[:60]}", flush=True)
            stop_event.wait(period)
    t=threading.Thread(target=loop, daemon=True); t.start()
    return t
