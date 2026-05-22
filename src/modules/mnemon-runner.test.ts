/**
 * mnemon-runner — retry-on-SQLITE_BUSY + write serialization.
 *
 * We mock `node:child_process.spawn` with a fake ChildProcess that emits
 * the events the runner listens for. This lets us drive deterministic
 * BUSY-then-success scenarios and assert on attempt counts, lock
 * ordering, and non-retry behaviour without depending on a real
 * `mnemon.exe` shim (which is fragile on Windows where spawning `.cmd`
 * files requires `shell: true`, and we explicitly do NOT use shell-mode
 * in production).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

type FakeStep =
  | { kind: 'busy'; stderr?: string }
  | { kind: 'ok'; stdout?: string }
  | { kind: 'fail'; code: number; stderr?: string };

interface FakeProc {
  args: readonly string[];
  startedAt: number;
  endedAt: number;
}

const calls: FakeProc[] = [];
let plan: FakeStep[] = [];
let stepDelayMs = 0;

const BUSY_STDERR =
  'open database: migrate: database is locked (5) (SQLITE_BUSY)\n';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>(
    'node:child_process',
  );
  return {
    ...actual,
    spawn: (_bin: string, args: readonly string[]) => {
      // The runner only uses three things on the returned ChildProcess:
      //   - .stdout / .stderr (EventEmitters with 'data' events)
      //   - .on('error' | 'exit', cb)
      //   - .kill()
      // Plain EventEmitters with manual emit() are easier to drive than
      // Readable streams (which buffer pushes before listeners attach).
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: null;
        kill: (sig?: string) => boolean;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = null;
      proc.kill = () => true;

      const recorded: FakeProc = {
        args: [...args],
        startedAt: Date.now(),
        endedAt: 0,
      };
      calls.push(recorded);

      // Pull the next step from the plan; if exhausted, default ok.
      const step: FakeStep = plan.shift() ?? { kind: 'ok' };

      const finish = () => {
        recorded.endedAt = Date.now();
        if (step.kind === 'ok') {
          proc.stdout.emit('data', Buffer.from(step.stdout ?? 'ok'));
          proc.emit('exit', 0);
        } else if (step.kind === 'busy') {
          proc.stderr.emit('data', Buffer.from(step.stderr ?? BUSY_STDERR));
          proc.emit('exit', 1);
        } else {
          proc.stderr.emit(
            'data',
            Buffer.from(step.stderr ?? 'some other error\n'),
          );
          proc.emit('exit', step.code);
        }
      };

      // Always defer at least one macrotask so the runner can attach its
      // listeners (which it does synchronously after `spawn()` returns)
      // before we start emitting events.
      const delay = stepDelayMs > 0 ? stepDelayMs : 0;
      setTimeout(finish, delay);

      return proc as unknown as ReturnType<typeof actual.spawn>;
    },
  };
});

// Import after mock so the runner picks up our fake spawn.
const { runMnemon, _drainWritesForTest } = await import('./mnemon-runner.js');

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls.length = 0;
  plan = [];
  stepDelayMs = 0;
  // Silence + capture telemetry warnings.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  await _drainWritesForTest();
  warnSpy.mockRestore();
});

describe('runMnemon — happy path', () => {
  it('returns code 0 when fake mnemon succeeds first try', async () => {
    plan = [{ kind: 'ok', stdout: 'ok' }];
    const r = await runMnemon(['remember', 'hello']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('ok');
    expect(r.attempts).toBe(1);
    expect(r.retried).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['remember', 'hello']);
  });
});

describe('runMnemon — SQLITE_BUSY retry', () => {
  it('retries on BUSY then succeeds', async () => {
    plan = [{ kind: 'busy' }, { kind: 'busy' }, { kind: 'ok' }];
    const r = await runMnemon(['remember', 'after-busy'], {
      initialBackoffMs: 1,
      maxBackoffMs: 5,
    });
    expect(r.code).toBe(0);
    expect(r.attempts).toBe(3);
    expect(r.retried).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('gives up after maxRetries and surfaces the BUSY stderr', async () => {
    plan = [{ kind: 'busy' }, { kind: 'busy' }, { kind: 'busy' }];
    const r = await runMnemon(['remember', 'always-busy'], {
      maxRetries: 2,
      initialBackoffMs: 1,
      maxBackoffMs: 5,
    });
    expect(r.code).toBe(1);
    expect(r.attempts).toBe(3); // 1 initial + 2 retries
    expect(r.stderr).toMatch(/database is locked/i);
    expect(calls).toHaveLength(3);
  });

  it('does NOT retry on non-BUSY errors', async () => {
    plan = [
      {
        kind: 'fail',
        code: 2,
        stderr: 'UNIQUE constraint failed: insights.id\n',
      },
    ];
    const r = await runMnemon(['remember', 'unique-violation'], {
      initialBackoffMs: 1,
    });
    expect(r.code).toBe(2);
    expect(r.attempts).toBe(1);
    expect(r.retried).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('treats SQLITE_BUSY phrasing variants as retryable', async () => {
    plan = [
      { kind: 'busy', stderr: 'insert insight: database is locked (5)\n' },
      { kind: 'ok' },
    ];
    const r = await runMnemon(['remember', 'variant'], {
      initialBackoffMs: 1,
    });
    expect(r.code).toBe(0);
    expect(r.attempts).toBe(2);
  });
});

describe('runMnemon — write serialization', () => {
  it('serializes concurrent write subcommands (FIFO, no overlap)', async () => {
    // Each write takes ~20ms in our fake; if they ran concurrently the
    // intervals would overlap, so we assert end[i] <= start[i+1].
    stepDelayMs = 20;
    plan = [{ kind: 'ok' }, { kind: 'ok' }, { kind: 'ok' }];

    const writes = [
      runMnemon(['remember', 'A']),
      runMnemon(['remember', 'B']),
      runMnemon(['remember', 'C']),
    ];
    const results = await Promise.all(writes);
    for (const r of results) expect(r.code).toBe(0);

    expect(calls.map((c) => c.args[1])).toEqual(['A', 'B', 'C']);
    // Non-overlap: each call ends before the next starts.
    for (let i = 0; i < calls.length - 1; i += 1) {
      const cur = calls[i]!;
      const nxt = calls[i + 1]!;
      expect(cur.endedAt).toBeLessThanOrEqual(nxt.startedAt);
    }
  });

  it('reads run concurrently (no lock)', async () => {
    stepDelayMs = 20;
    plan = [{ kind: 'ok' }, { kind: 'ok' }, { kind: 'ok' }];

    const t0 = Date.now();
    await Promise.all([
      runMnemon(['recall', 'X']),
      runMnemon(['recall', 'Y']),
      runMnemon(['recall', 'Z']),
    ]);
    const elapsed = Date.now() - t0;
    // Three concurrent 20ms calls should finish well under serialized 60ms.
    expect(elapsed).toBeLessThan(50);
  });
});

describe('runMnemon — write subcommand recognition', () => {
  it('treats forget/link/embed/gc/store as writes (serialized)', async () => {
    stepDelayMs = 15;
    plan = [
      { kind: 'ok' },
      { kind: 'ok' },
      { kind: 'ok' },
      { kind: 'ok' },
      { kind: 'ok' },
    ];
    const start = Date.now();
    await Promise.all([
      runMnemon(['forget', '--id', '1']),
      runMnemon(['link', 'a', 'b']),
      runMnemon(['embed', '--all']),
      runMnemon(['gc']),
      runMnemon(['store', 'use', 'default']),
    ]);
    const elapsed = Date.now() - start;
    // 5 serialized 15ms calls ≈ 75ms+; well above any realistic concurrent
    // floor. Use a lower bound of 60ms so slow CI doesn't flake.
    expect(elapsed).toBeGreaterThanOrEqual(60);
  });
});

describe('runMnemon — retry telemetry', () => {
  it('warns once per retry with attempt# and sanitized args', async () => {
    plan = [{ kind: 'busy' }, { kind: 'busy' }, { kind: 'ok' }];
    const r = await runMnemon(['remember', 'secret-content', '--store', 'main'], {
      initialBackoffMs: 1,
      maxBackoffMs: 5,
    });
    expect(r.code).toBe(0);
    // 2 BUSY responses → 2 retry warns. The terminal success does NOT warn.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const msgs = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    for (const m of msgs) {
      expect(m).toMatch(/^\[mnemon-runner\] BUSY retry attempt=\d+\/\d+/);
      expect(m).toContain('args=remember --store');
      // Sanitizer must NOT leak the message body.
      expect(m).not.toContain('secret-content');
    }
  });

  it('warns once on BUSY-retries-exhausted', async () => {
    plan = [{ kind: 'busy' }, { kind: 'busy' }, { kind: 'busy' }];
    const r = await runMnemon(['remember', 'always-busy'], {
      maxRetries: 2,
      initialBackoffMs: 1,
      maxBackoffMs: 5,
    });
    expect(r.code).toBe(1);
    // 2 retry warns + 1 exhaustion warn = 3 total.
    expect(warnSpy).toHaveBeenCalledTimes(3);
    const last = String(warnSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(last).toMatch(/BUSY retries exhausted attempts=3/);
    expect(last).toContain('args=remember');
    expect(last).not.toContain('always-busy');
  });

  it('does NOT warn on non-BUSY failures', async () => {
    plan = [{ kind: 'fail', code: 2, stderr: 'unrelated\n' }];
    await runMnemon(['remember', 'x']);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

