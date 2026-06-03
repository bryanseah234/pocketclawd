
=== ROUND 1 CONFIRMED DEFECT LIST (judged) ===

[D5][HIGH] Onboarding re-activates mid-session / hijacks conversation.
  Root: main.py:302-307 fires discovery wizard on ANY message when is_new_user=True,
  with no "already active this session" guard. Once active, swallows all non-slash msgs
  ("reply with 1/2/3/4"). Hit 88 rows across alpha/beta/delta. charlie unaffected (had
  discoveryCompleted=True).
  Fix: (a) only auto-activate onboarding on a user's FIRST-EVER message (gate on a Redis
  'greeted:<user>' marker), never mid-session; (b) treat NL questions as implicit skip.

[D6][HIGH] Fail-open onboarding under load. preference_probe returns is_new_user=True on
  ANY DataGateway timeout (5s). Under parallel load probes timed out -> spurious onboarding
  on established users. Couples conversation flow to DataGateway latency.
  Fix: fail-CLOSED for the activation decision (timeout -> assume returning user, skip
  onboarding) OR cache the greeted marker so a timeout can't re-trigger.

[D7][HIGH] Text-to-speech BROKEN (G16). All TTS -> "permissions issue... not wired up."
  Polly perms or wiring missing. Affects Q83/Q84 for all users.
  Fix: investigate Polly IAM on sub-agent task role + tool wiring.

[D1][HIGH] Live vision pipeline dead (G10). Inbound photos go to indexer (RAG) not the
  live vision call; main.py _image_attachments expects a JSON-attachments envelope at S3
  key .../staging/wa-{msgId}/{name} that nothing produces. "Describe this image" never
  does live vision (works only after indexing, as RAG text).
  Fix: route kind:'image' payload.url into _image_bytes_list directly.

[D8][HIGH] Document upload->Q&A broken via test path (G9). Uploaded file text treated as
  chat; QA says "I don't see a document"; /list shows DRAFT outputs (research PDFs) not the
  uploaded file. Drafts are being saved into the user's document store, polluting /list.
  Q56 /delete fails (uploaded filename absent). Needs: (a) verify upload->index path sets
  the doc under the user; (b) stop /draft outputs from registering as user documents (or
  mark them distinctly).

[D9][MED] /draft <unknown-single-token> returns generic Usage instead of "Unknown draft
  type 'x'". commands.py checks len(parts)<2 before the type-validation branch. Q75/Q74e.

[D10][MED] /draft returns text only, no download link (.docx/.pptx/.pdf) as script expects.
  Possibly by design on admin-test (no channel attachment) -- verify vs real channel.

[D2][LOW] Reminder parser: "/remind X tomorrow at 9am" puts "tomorrow" in reminder TEXT
  (splits on first ' at '); fires at 9am today/next. Minor wording bug.

[D11][LOW] /remind with time but no task ("/remind at 3pm") -> "Couldn't understand the
  time" instead of "What should I remind you about?". Wrong error branch. Q64f.

[D12][LOW] Q51 "summarise that article" lost context -> "you asked about time in London".
  Context-threading miss when prior turns include a URL then unrelated Qs. Intermittent.

[D13][LOW] convert_currency passes negative amounts through (-50 USD -> -S$63.92). Cosmetic.

[D14][INFO] /forget returns degraded fallback ("local session cleared, background deletion
  running") not the full "all data wiped" confirmation -- the full wipe likely partially
  failed. Re-consent DID work. Verify the DynamoDB/OpenSearch wipe completes.

=== NON-DEFECTS (rubric/fixture issues, NOT bugs) ===
- Q4 "no preferences (first run)" expectation invalid: users have persistent DynamoDB prefs
  from prior runs; /profile SHOW works correctly. Harness state-reset doesn't clear DynamoDB.
- Edge cases ALL handled well: ZZZZ, florbglax, Atlantis, Wakanda, Klingon, unicorn stable,
  Moon directions, 404/500 URLs, asdfqwerzxcv wiki -> all graceful.
