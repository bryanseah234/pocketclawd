# CLAWD TESTING -- Source of Truth

When the user says **"run the tests"** or **"run the full suite"**, this file
defines exactly what to run. Two distinct layers:

1. UNIT TESTS  -- fast, offline, no AWS. Run on every code change.
2. LIVE BETA SUITE -- 136 questions x 4 users x N rounds against the deployed
   prod orchestrator. Semantic + literal grading. Run before/after a release or
   when explicitly asked for "the full suite".

================================================================================
## QUICK REFERENCE -- what "run tests" means
================================================================================

| User says                          | Run this                                        |
|------------------------------------|-------------------------------------------------|
| "run the unit tests"               | LAYER 1 (pytest, ~7s)                           |
| "run the tests" (after a code edit)| LAYER 1 first; offer LAYER 2 if prod-facing     |
| "run the full suite" / "beta suite"| LAYER 2 (reset -> run round -> judge -> report) |
| "run round 2" / "another round"    | LAYER 2 with an incremented round number        |

================================================================================
## LAYER 1 -- UNIT TESTS (pytest)
================================================================================

Location: container/sub-agent/tests/  (Python, pytest)
Venv:     container/sub-agent/.venv  (uv-managed)

Run the FULL unit suite:
    cd container/sub-agent
    .venv/Scripts/python.exe -m pytest -q

Run the targeted set most often touched (fast smoke):
    .venv/Scripts/python.exe -m pytest -q \
      tests/test_url_ingestion.py tests/test_commands.py \
      tests/test_rag_retrieval.py tests/test_main.py tests/test_document_commands.py

Host orchestrator (Node) unit tests, if touched:
    pnpm test          # vitest, from repo root

NOTE (Windows / X: drive): the git-bash fork bug breaks many shell calls. Run
pytest via subprocess from execute_code with the venv python's ABSOLUTE path, or
from a real PowerShell. Node 22 required for vitest/better-sqlite3 (prepend the
WinGet node-v22 path to PATH).

================================================================================
## LAYER 2 -- LIVE BETA SUITE (the "full suite")
================================================================================

### What it is
- 136 questions in test/beta_v2_bank.json, organized into 20 capability groups
  (G1..G20). Run for 4 test users (test_alpha/beta/charlie/delta) IN PARALLEL,
  with each user's questions executed SEQUENTIALLY (stateful chains: URL
  ingestion, reminders, multi-turn memory depend on order).
- Each question has: id, group, msg, kind (text|pdf|txt|img), contains[]
  (literal expected substrings), semantic (bool), artifact (fixture key), notes.
- Grading rubric (per question, PER USER): test/BETA_V2_RUBRIC.md. Code-grounded
  -- expected strings are LITERAL from container/sub-agent/src/{commands,reminders,
  consent,main}.py unless marked (semantic).

### The files (test/)
| File                       | Role |
|----------------------------|------|
| beta_v2_bank.json          | THE 136-question bank (source of truth for questions) |
| BETA_V2_RUBRIC.md          | Per-question expected output + PASS/PARTIAL/FAIL criteria |
| beta_v2_runner.py          | Orchestrates 4 users in parallel; writes beta_v2_round{N}_results.json |
| beta_send_v2.py            | HTTP sender: send_message (JSON) + send_file (multipart) to the admin test API |
| ratelimit_flusher.py       | Background thread: clears ratelimit:* every 18s via SSM->container (keeps rounds rate-limit-safe) |
| reset_test_users.py        | Clean per-user reset: Redis consent seed + DynamoDB chat-history purge (run BEFORE each round) |
| artifacts/                 | Test fixtures: clawd_doc.pdf, clawd_fixture.txt, img_text.png, img_blank.png |
| _mkart.py                  | Regenerates the artifacts/ fixtures (known seeded content) |
| beta_v2_round{N}_results.json | Raw results per round |
| BETA_FINAL_REPORT.txt      | Last cross-round report |

### Fixture seeded content (so you know what a correct doc/vision answer is)
- clawd_doc.pdf  -> codename BLUEHERON, budget 250000 SGD FY2026, lead Bryan,
  deadline 30 Sep 2026, risk exFAT symlink.
- clawd_fixture.txt -> distinctive phrase "PURPLE PANGOLIN PROTOCOL".
- img_text.png -> "CLAWD VISION TEST", "Total: $42.50 SGD", "Codeword: SCARLET IBIS".
- img_blank.png -> near-empty (graceful-handling edge case).
Regenerate: python test/_mkart.py test/artifacts  (needs reportlab + Pillow).

### Capability groups (G1..G20)
G1 onboarding/commands | G2 conversation | G3 web search/finance | G4 news |
G5 weather | G6 maps/directions | G7 knowledge lookup | G8 URL ingestion+recall |
G9 document upload+QA | G10 photo/vision | G11 fetch-url/deep-read |
G12 reminders | G13 draft docs | G14 SG-specific tools | G15 image generation |
G16 text-to-speech | G18 data/privacy controls (incl. /forget -- runs LAST) |
G19 edge/stress/injection | G20 multi-turn memory.
(G17 intentionally absent; G18z = extra G18 edges.)

### TARGET / AUTH (verify before every run)
- Orchestrator EC2: i-0f9cd20350cfdc1a6, prod, ap-southeast-1.
- beta_send_v2.py reads its target + creds from ENV (with prod fallbacks so it
  runs without setup). Override via:
    CLAWD_TEST_HOST  (default 3.0.132.150 -- the orchestrator EC2 public IP)
    CLAWD_TEST_PORT  (default 3000)
    CLAWD_ADMIN_USER (default admin)
    CLAWD_ADMIN_PASS (default the prod admin password)
- HOST must equal the instance Public IP. CHECK each run:
    aws ec2 describe-instances --instance-ids i-0f9cd20350cfdc1a6 \
      --profile clawd-prod --region ap-southeast-1
  If the IP changed (instance restarted), set CLAWD_TEST_HOST (or update the
  fallback in beta_send_v2.py).
- Do NOT rotate the admin password -- standing instruction. The fallback value
  matches the prod admin pass already present in src/cloud/admin-dashboard/index.ts.

### RUN PROCEDURE (full round)
Step 0 -- preflight: confirm latest deploy is "completed success" and the
  orchestrator container is up; confirm the HOST IP matches (above).

Step 1 -- RESET state for all 4 users (CRITICAL -- skipping this corrupts a round):
  Run the reset payload in reset_test_users.py (RESET_NODE_PAYLOAD) via
  SSM -> docker cp -> docker exec on the orchestrator. It:
    (a) clears all per-user Redis keys,
    (b) seeds consent:{user} HASH = granted  (consent lives in REDIS, not DynamoDB),
    (c) sets greeted:{user}=1 (suppresses onboarding wizard),
    (d) PURGES DynamoDB nanoclaw-chat-messages per user (prevents cross-round
        persona bleed -- the charlie "file-handler" bug),
    (e) clears global ratelimit buckets.

Step 2 -- LAUNCH the round detached (it takes ~20-30 min for a clean round):
  Use PowerShell WMI Win32_Process.Create to launch detached (execute_code
  sandbox tears down at end-of-call, killing in-process children):
    python test/beta_v2_runner.py <round_number>
  It auto-starts the flusher, runs 4 users in parallel, writes
  beta_v2_round{N}_results.json, logs progress to the launch log.

Step 3 -- POLL to completion: watch the log / the results file for
  "DONE round N: 544 rows". 136 x 4 = 544 expected rows.

Step 4 -- JUDGE: read beta_v2_round{N}_results.json and grade PASS/PARTIAL/FAIL
  PER QUESTION PER USER against BETA_V2_RUBRIC.md. Flag contamination
  (consent-gated rows, onboarding-swallow) and transport timeouts SEPARATELY
  from real defects. Build a per-group + per-user scorecard.

Step 5 -- DIFF vs previous round; write/update BETA_FINAL_REPORT.txt.

### Known harness artifacts (NOT product defects -- account for them when judging)
- Generative groups (G11/G15/G16/G18) take 37-39s SOLO; under 4-user concurrency
  they can exceed the cap. timeout_for() already gives them 90s. If a generative
  question times out, re-test it SOLO before calling it a failure.
- channelType=admin-test SUPPRESSES the Wave-1 upload-completion push, so G9 is
  verified by a FOLLOW-UP question, not by waiting for a "done" push. There is a
  ~32s index wait (DOC_INDEX_WAIT) after each doc upload before asking.
- Q92 (/forget) clears consent -> the NEXT message returns the consent prompt
  (that prompt is itself a graded check, Q92post). Runner re-sends "yes" after.
- Multi-turn memory (G20) and reminders (G12) require ordered same-user chains.

### Cost guardrails
~544 live LLM calls per round. Run only on request or around a release. Do NOT
loop gh-run-watch (300s execute_code cap); poll once per call.

================================================================================
## LEGACY / DO-NOT-USE
================================================================================
beta_runner.py + beta_send.py are the v1 (pre-multipart) harness. full_suite_runner.py
and the retest_*.py / *.bat are ad-hoc one-offs from prior sessions. The
CANONICAL live suite is the beta_v2_* set above. Ignore the rest unless
explicitly resurrecting them.
