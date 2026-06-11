import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const responseTime = new Trend('response_time_ms');

export const options = {
  scenarios: {
    phase_a_baseline: {
      executor: 'constant-vus',
      vus: 5,
      duration: '60s',
      tags: { scenario: 'baseline' },
    },
    phase_c_load: {
      executor: 'constant-vus',
      vus: 50,
      duration: '60s',
      startTime: '70s',
      tags: { scenario: 'load' },
    },
  },
  thresholds: {
    'http_req_duration{scenario:baseline}': ['p(95)<30000'],
    'http_req_duration{scenario:load}': ['p(95)<30000'],
    errors: ['rate<0.05'],
  },
};

const BASE_URL = __ENV.TARGET_URL || 'http://3.0.132.150:3000';
const AUTH = 'Basic ' + btoa('admin:NcLaw$2026!xK9m');

export default function () {
  const health = http.get(`${BASE_URL}/health`);
  check(health, { 'health 200': (r) => r.status === 200 });
  responseTime.add(health.timings.duration);
  errorRate.add(health.status !== 200);

  const admin = http.get(`${BASE_URL}/admin`, { headers: { Authorization: AUTH } });
  check(admin, { 'admin 200': (r) => r.status === 200 });
  errorRate.add(admin.status !== 200);

  sleep(1);
}
