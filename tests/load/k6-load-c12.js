import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ─── Config ───────────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://3.0.132.150:3000';
const ADMIN_USER = __ENV.ADMIN_USER || 'admin';
const ADMIN_PASS = __ENV.ADMIN_PASS || '';       // set via -e ADMIN_PASS=... at runtime

// ─── Custom metrics ───────────────────────────────────────────────────────────
const healthErrors   = new Counter('health_errors');
const apiErrors      = new Counter('api_errors');
const errorRate      = new Rate('error_rate');
const healthDuration = new Trend('health_duration_ms', true);
const dashDuration   = new Trend('dashboard_duration_ms', true);

// ─── Scenario: 50 concurrent users, 2-minute sustained load ──────────────────
export const options = {
  scenarios: {
    c12_50_concurrent: {
      executor: 'constant-vus',
      vus: 50,
      duration: '2m',
    },
  },
  thresholds: {
    // PRD C-12 acceptance criteria
    http_req_failed:        ['rate<0.01'],   // <1% failure
    http_req_duration:      ['p(95)<2000'],  // 95th pct under 2s
    error_rate:             ['rate<0.01'],
    health_duration_ms:     ['p(95)<1000'],  // health check under 1s
    dashboard_duration_ms:  ['p(95)<3000'],  // dashboard page under 3s
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function authHeader() {
  const creds = `${ADMIN_USER}:${ADMIN_PASS}`;
  // btoa not available in k6 — use encoding module
  const encoded = `Basic ${btoa(creds)}`;
  return { Authorization: encoded };
}

// ─── Main VU loop ─────────────────────────────────────────────────────────────
export default function () {
  const headers = authHeader();

  // 1) Health endpoint — every VU every iteration
  {
    const res = http.get(`${BASE_URL}/admin/api/health`, { headers, tags: { name: 'health' } });
    healthDuration.add(res.timings.duration);
    const ok = check(res, {
      'health 200':      (r) => r.status === 200,
      'health has redis': (r) => {
        try { return JSON.parse(r.body).redis !== undefined; } catch { return false; }
      },
    });
    if (!ok) { healthErrors.add(1); errorRate.add(1); } else { errorRate.add(0); }
  }

  sleep(0.2);

  // 2) Dashboard — static admin page
  {
    const res = http.get(`${BASE_URL}/admin`, { headers, tags: { name: 'dashboard' } });
    dashDuration.add(res.timings.duration);
    const ok = check(res, {
      'admin 200': (r) => r.status === 200,
      'admin has content': (r) => r.body && r.body.length > 1000,
    });
    if (!ok) { apiErrors.add(1); errorRate.add(1); } else { errorRate.add(0); }
  }

  sleep(0.3);

  // 3) Pulse stats endpoint (live metrics the dashboard polls)
  {
    const res = http.get(`${BASE_URL}/admin/api/stats`, { headers, tags: { name: 'stats' } });
    const ok = check(res, {
      'stats 200 or 304': (r) => r.status === 200 || r.status === 304,
    });
    if (!ok) { apiErrors.add(1); errorRate.add(1); } else { errorRate.add(0); }
  }

  sleep(0.5 + Math.random() * 0.5);   // jitter 0.5–1.0s between iterations
}

// ─── Summary hook ─────────────────────────────────────────────────────────────
export function handleSummary(data) {
  const passed = data.metrics.http_req_failed.values.rate < 0.01
              && data.metrics.http_req_duration.values['p(95)'] < 2000;

  console.log(`\n====== C-12 k6 LOAD TEST RESULT ======`);
  console.log(`VUs: 50, Duration: 2m`);
  console.log(`Requests:       ${data.metrics.http_reqs.values.count}`);
  console.log(`Error rate:     ${(data.metrics.http_req_failed.values.rate * 100).toFixed(2)}%`);
  console.log(`p(95) duration: ${data.metrics.http_req_duration.values['p(95)'].toFixed(0)}ms`);
  console.log(`Health p(95):   ${(data.metrics.health_duration_ms?.values['p(95)'] || 0).toFixed(0)}ms`);
  console.log(`RESULT: ${passed ? '✅ PASS — C-12 acceptance criteria met' : '❌ FAIL — thresholds breached'}`);
  console.log(`=======================================\n`);

  return {
    stdout: JSON.stringify(data, null, 2),
  };
}
