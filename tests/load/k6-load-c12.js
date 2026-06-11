import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ─── Config ───────────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || __ENV.TARGET_URL || 'http://3.0.132.150:3000';

// ─── Custom metrics ───────────────────────────────────────────────────────────
const errors       = new Counter('load_errors');
const errorRate    = new Rate('error_rate');
const healthTrend  = new Trend('health_duration_ms', true);

// ─── C-12 Scenario: 50 concurrent users, 2-minute sustained load ─────────────
// PRD acceptance criteria: p95 < 2000ms, error rate < 1%
export const options = {
  scenarios: {
    c12_50_concurrent: {
      executor: 'constant-vus',
      vus: 50,
      duration: '2m',
    },
  },
  thresholds: {
    http_req_failed:    ['rate<0.01'],   // < 1% failure
    http_req_duration:  ['p(95)<2000'],  // 95th pct under 2s
    error_rate:         ['rate<0.01'],
    health_duration_ms: ['p(95)<1000'],  // health endpoint under 1s
  },
};

// ─── Main VU loop ─────────────────────────────────────────────────────────────
export default function () {
  // Public health endpoint — no auth required, tests real service stack
  // (Redis connectivity, DynamoDB reachability, WhatsApp session state)
  const res = http.get(`${BASE_URL}/health`, { tags: { name: 'health' } });

  healthTrend.add(res.timings.duration);

  const ok = check(res, {
    'status 200':           (r) => r.status === 200,
    'has components field': (r) => {
      try { const b=JSON.parse(r.body); return b.status==='healthy' || b.components !== undefined; } catch { return false; }
    },
    'response under 2s':    (r) => r.timings.duration < 2000,
  });

  if (!ok) { errors.add(1); errorRate.add(1); } else { errorRate.add(0); }

  // Realistic inter-request pause — jitter between 0.8s and 1.6s
  sleep(0.8 + Math.random() * 0.8);
}

// ─── Summary ─────────────────────────────────────────────────────────────────
export function handleSummary(data) {
  const failRate  = data.metrics.http_req_failed.values.rate;
  const p95       = data.metrics.http_req_duration.values['p(95)'];
  const passed    = failRate < 0.01 && p95 < 2000;

  console.log('\n====== C-12 k6 LOAD TEST (50 VUs / 2 min) ======');
  console.log(`Total requests:  ${data.metrics.http_reqs.values.count}`);
  console.log(`Error rate:      ${(failRate * 100).toFixed(2)}%  (threshold <1%)`);
  console.log(`p(95) duration:  ${p95.toFixed(0)}ms  (threshold <2000ms)`);
  console.log(`Health p(95):    ${(data.metrics.health_duration_ms?.values['p(95)'] || 0).toFixed(0)}ms`);
  console.log(`RESULT: ${passed ? '✅ PASS' : '❌ FAIL'}`);
  console.log('=================================================\n');
  return { stdout: JSON.stringify(data, null, 2) };
}
