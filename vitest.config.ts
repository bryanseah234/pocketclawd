import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'scripts/**/*.test.ts'],
    // The end-to-end router/migration tests run 13 migrations per setup; the
    // 5s default is tight on slow disks (notably exFAT/Windows dev machines).
    // 20s is comfortable everywhere and harmless on fast CI.
    testTimeout: 20000,
    hookTimeout: 20000,
    // Settings-manager tests require live env vars (DATA_BUCKET, S3_BUCKET) not
    // available in unit-test environments — they are integration tests.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'src/cloud/admin-dashboard/settings/settings-manager.test.ts',
      'src/cloud/admin-dashboard/settings/settings-manager.prop.test.ts',
      'src/cloud/admin-dashboard/settings/routes.test.ts',
    ],
  },
});
