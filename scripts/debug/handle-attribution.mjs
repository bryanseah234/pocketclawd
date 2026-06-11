// Handle attribution probe.
//
// Connects to a running node process started with `--inspect=127.0.0.1:9230`,
// evaluates `process._getActiveHandles()` every 5s, groups them by the
// constructor name, and prints a table of {type → count} plus the delta from
// the previous snapshot. After N samples it summarises which type grew most.
//
// Why not use a heap snapshot or a CPU profile? Because handle leaks aren't
// visible in V8's heap (they live in libuv / kernel handle tables). Walking
// `process._getActiveHandles()` is the only reliable way to attribute them
// from inside the running process.
//
// Usage:
//   node scripts/debug/handle-attribution.mjs                 # 12 samples x 5s = 60s
//   node scripts/debug/handle-attribution.mjs --samples 20    # custom sample count
//   node scripts/debug/handle-attribution.mjs --interval 3    # custom interval (s)
//   node scripts/debug/handle-attribution.mjs --port 9230     # custom inspector port

const PORT = Number(getArg('--port', '9230'));
const SAMPLES = Number(getArg('--samples', '12'));
const INTERVAL_S = Number(getArg('--interval', '5'));

function getArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function findWsUrl() {
  // Retry up to 30s — service can take ~13s to bind, plus startup races.
  const deadline = Date.now() + 30_000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (!r.ok) throw new Error(`inspector http ${r.status}`);
      const arr = await r.json();
      if (!arr.length) throw new Error('no inspector targets');
      return arr[0].webSocketDebuggerUrl;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error(`inspector connect failed after 30s: ${lastErr?.message ?? lastErr}`);
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: false,
    });
    if (r.exceptionDetails) {
      throw new Error(`eval: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description ?? '')}`);
    }
    return r.result.value;
  }
}

async function snapshot(cdp) {
  const expr = `(() => {
    const handles = process._getActiveHandles();
    const requests = process._getActiveRequests();
    const byCtor = {};
    const sockDetail = {};
    for (const h of handles) {
      const name = h?.constructor?.name ?? 'Unknown';
      byCtor[name] = (byCtor[name] ?? 0) + 1;
      if (name === 'Socket' || name === 'TLSSocket') {
        const ra = h.remoteAddress ?? null;
        const rp = h.remotePort ?? null;
        const key = ra ? (ra + ':' + rp) : (h.destroyed ? '(destroyed)' : (h.readable === false ? '(half-closed)' : '(unbound)'));
        sockDetail[key] = (sockDetail[key] ?? 0) + 1;
      }
    }
    const reqByCtor = {};
    for (const r of requests) {
      const name = r?.constructor?.name ?? 'Unknown';
      reqByCtor[name] = (reqByCtor[name] ?? 0) + 1;
    }
    let resInfo = null;
    try {
      const arr = process.getActiveResourcesInfo();
      resInfo = {};
      for (const t of arr) resInfo[t] = (resInfo[t] ?? 0) + 1;
    } catch {}
    return {
      ts: Date.now(),
      pid: process.pid,
      mem: process.memoryUsage(),
      handles_total: handles.length,
      requests_total: requests.length,
      handles_by_ctor: byCtor,
      requests_by_ctor: reqByCtor,
      sock_detail: sockDetail,
      active_resources: resInfo,
    };
  })()`;
  return cdp.eval(expr);
}

function diff(prev, curr) {
  const out = {};
  const keys = new Set([...Object.keys(prev ?? {}), ...Object.keys(curr ?? {})]);
  for (const k of keys) {
    const p = prev?.[k] ?? 0;
    const c = curr?.[k] ?? 0;
    if (c !== p) out[k] = `${p}->${c} (${c - p >= 0 ? '+' : ''}${c - p})`;
  }
  return out;
}

function pct(num, den) {
  if (!den) return '0%';
  return ((num / den) * 100).toFixed(1) + '%';
}

(async () => {
  console.log(`[probe] connecting to inspector on 127.0.0.1:${PORT}`);
  const wsUrl = await findWsUrl();
  console.log(`[probe] ws=${wsUrl}`);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const cdp = new CdpClient(ws);
  await cdp.send('Runtime.enable');
  console.log('[probe] connected, taking snapshots');

  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const s = await snapshot(cdp);
    samples.push(s);
    const prev = samples[samples.length - 2];
    console.log('');
    console.log(`--- sample ${i + 1}/${SAMPLES} ts=${new Date(s.ts).toISOString().slice(11, 19)} pid=${s.pid} ---`);
    console.log(`handles_total=${s.handles_total} requests_total=${s.requests_total} rss=${(s.mem.rss / 1e6).toFixed(0)}MB external=${(s.mem.external / 1e6).toFixed(0)}MB`);
    console.log('handles_by_ctor:', JSON.stringify(s.handles_by_ctor));
    if (Object.keys(s.requests_by_ctor).length) console.log('requests_by_ctor:', JSON.stringify(s.requests_by_ctor));
    if (s.active_resources) console.log('active_resources:', JSON.stringify(s.active_resources));
    if (Object.keys(s.sock_detail).length) console.log('sock_detail:', JSON.stringify(s.sock_detail));
    if (prev) {
      const dh = diff(prev.handles_by_ctor, s.handles_by_ctor);
      const dr = diff(prev.requests_by_ctor, s.requests_by_ctor);
      const dRes = prev.active_resources && s.active_resources ? diff(prev.active_resources, s.active_resources) : {};
      const dSock = diff(prev.sock_detail, s.sock_detail);
      if (Object.keys(dh).length) console.log('delta handles:', JSON.stringify(dh));
      if (Object.keys(dr).length) console.log('delta requests:', JSON.stringify(dr));
      if (Object.keys(dRes).length) console.log('delta resources:', JSON.stringify(dRes));
      if (Object.keys(dSock).length) console.log('delta sock_detail:', JSON.stringify(dSock));
    }
    if (i < SAMPLES - 1) await new Promise(r => setTimeout(r, INTERVAL_S * 1000));
  }

  console.log('');
  console.log('=== SUMMARY ===');
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = (last.ts - first.ts) / 1000;
  console.log(`elapsed ${dt.toFixed(1)}s, handles ${first.handles_total} -> ${last.handles_total} (delta ${last.handles_total - first.handles_total}, ${((last.handles_total - first.handles_total) / dt).toFixed(1)}/s)`);
  const ctorsGrowth = {};
  for (const k of new Set([...Object.keys(first.handles_by_ctor), ...Object.keys(last.handles_by_ctor)])) {
    ctorsGrowth[k] = (last.handles_by_ctor[k] ?? 0) - (first.handles_by_ctor[k] ?? 0);
  }
  const sorted = Object.entries(ctorsGrowth).sort((a, b) => b[1] - a[1]);
  const totalDelta = last.handles_total - first.handles_total;
  console.log('top growing handle types:');
  for (const [k, d] of sorted.slice(0, 8)) {
    if (d === 0) continue;
    console.log(`  ${k.padEnd(28)} +${d.toString().padStart(5)} (${pct(d, totalDelta)} of growth)`);
  }
  if (last.active_resources && first.active_resources) {
    console.log('top growing resource types (libuv-level):');
    const dRes = {};
    for (const k of new Set([...Object.keys(first.active_resources), ...Object.keys(last.active_resources)])) {
      dRes[k] = (last.active_resources[k] ?? 0) - (first.active_resources[k] ?? 0);
    }
    for (const [k, d] of Object.entries(dRes).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      if (d === 0) continue;
      console.log(`  ${k.padEnd(28)} +${d.toString().padStart(5)}`);
    }
  }

  ws.close();
  process.exit(0);
})().catch(e => { console.error('[probe] FATAL', e.stack || e.message); process.exit(1); });
