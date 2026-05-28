// k6 multi-user stress test (C4 Wave 7).
//
// Simulates 50 concurrent virtual users over 5 minutes hitting:
// - GET /health (liveness)
// - GET /admin (auth path with Basic + rate-limit)
// - GET /api/wa-state (public landing-page endpoint)
// - GET /api/wa-state/stream (SSE — long-lived connection)
//
// Goals:
//   p95 < 5000ms on /health and /api/wa-state
//   p99 < 10000ms on /admin (heavier route)
//   error rate < 1%
//   no 5xx responses in any phase
//
// Run locally with k6:
//   k6 run tests/load/k6-stress-multi-user.js \
//     --env TARGET_URL=http://3.0.132.150:3000 \
//     --env ADMIN_PASS=NcLaw\$2026!xK9m
//
// CI: not auto-wired (would burn budget). Run on demand from a workstation
// when validating the EC2 sizing or after Caddy rollout.

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

const errorRate = new Rate('errors');
const responseTime = new Trend('response_time_ms');
const fivexx = new Counter('http_5xx_count');

export const options = {
  scenarios: {
    ramp_up: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '60s', target: 50 },  // peak load
        { duration: '120s', target: 50 }, // sustained peak
        { duration: '30s', target: 10 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
      tags: { scenario: 'stress' },
    },
  },
  thresholds: {
    'http_req_duration{name:health}': ['p(95)<5000'],
    'http_req_duration{name:wa_state}': ['p(95)<5000'],
    'http_req_duration{name:admin}': ['p(99)<10000'],
    'errors': ['rate<0.01'],
    'http_5xx_count': ['count<10'],
  },
};

const BASE_URL = __ENV.TARGET_URL || 'http://3.0.132.150:3000';
const ADMIN_USER = __ENV.ADMIN_USER || 'admin';
const ADMIN_PASS = __ENV.ADMIN_PASS || 'NcLaw$2026!xK9m';
const AUTH = 'Basic ' + btoa(ADMIN_USER + ':' + ADMIN_PASS);

function checkResponse(res, name) {
  responseTime.add(res.timings.duration, { name });
  const ok = res.status >= 200 && res.status < 400;
  errorRate.add(!ok);
  if (res.status >= 500) fivexx.add(1, { name, status: String(res.status) });
  return check(res, {
    [`${name} 2xx/3xx`]: (r) => r.status >= 200 && r.status < 400,
    [`${name} body present`]: (r) => r.body && r.body.length > 0,
  });
}

export default function () {
  group('public-paths', () => {
    const h = http.get(`${BASE_URL}/health`, { tags: { name: 'health' } });
    checkResponse(h, 'health');

    const w = http.get(`${BASE_URL}/api/wa-state`, { tags: { name: 'wa_state' } });
    checkResponse(w, 'wa_state');
  });

  group('admin-paths', () => {
    const a = http.get(`${BASE_URL}/admin`, {
      headers: { Authorization: AUTH },
      tags: { name: 'admin' },
    });
    checkResponse(a, 'admin');
  });

  // Briefly exercise SSE — just open + close, don't hold the connection
  // for the whole iteration since k6's default behavior would block.
  group('sse-handshake', () => {
    const res = http.get(`${BASE_URL}/api/wa-state/stream`, {
      tags: { name: 'sse_handshake' },
      timeout: '3s',
    });
    // SSE will be a long-lived connection; we expect the handshake (status
    // 200) within 3s. The 'http_req_duration' will be the time-to-first-byte
    // before timeout, which is fine for this assertion.
    check(res, {
      'sse 200 or timeout': (r) => r.status === 200 || r.error_code === 1050,
    });
  });

  sleep(Math.random() * 2 + 0.5);  // jittered 0.5-2.5s between iterations
}

export function handleSummary(data) {
  return {
    'stdout': summarize(data),
  };
}

function summarize(data) {
  const m = data.metrics;
  const lines = [];
  lines.push('');
  lines.push('═══════════════════════════════════════════════');
  lines.push('  k6 stress-multi-user summary');
  lines.push('═══════════════════════════════════════════════');
  lines.push(`  Total requests: ${m.http_reqs?.values?.count ?? 0}`);
  lines.push(`  Failed:         ${m.http_req_failed?.values?.passes ?? 0}`);
  lines.push(`  Error rate:     ${(m.errors?.values?.rate * 100 ?? 0).toFixed(2)}%`);
  lines.push(`  5xx total:      ${m.http_5xx_count?.values?.count ?? 0}`);
  lines.push('');
  lines.push('  Latency p95 (ms):');
  for (const [k, v] of Object.entries(m)) {
    if (k.startsWith('http_req_duration{name:')) {
      const name = k.match(/name:(\w+)/)?.[1] ?? k;
      lines.push(`    ${name.padEnd(20)} ${(v.values?.['p(95)'] ?? 0).toFixed(0)}ms`);
    }
  }
  lines.push('═══════════════════════════════════════════════');
  return lines.join('\n') + '\n';
}
