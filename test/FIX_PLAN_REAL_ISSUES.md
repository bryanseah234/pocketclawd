# Fix Plan -- Real Issues #1, #4, #5 (post-R2 triage)

Items #2 (Q53 no_docs cache) and #3 (RAG-skip) already fixed + verified live
(commit 4656c6be). This plan covers the three remaining genuine product issues.

## ISSUE #1 -- Chat-history persona bleed (charlie: text Q answered as file-handler)
Evidence: charlie/10e "joke in French" -> "I don't see an image attached... I'll
extract all the text and numbers"; charlie/14 "F1 race" -> "I don't see a text
file... I'll find the distinctive phrase". Only charlie bled. charlie history =
200+ msgs across rounds incl 10 file-handler assistant turns.
Root cause: _get_chat_history loads last 100 msgs verbatim; LLM pattern-matches a
new text question into the file-handler persona repeated in context. No relevance
scoping, no per-turn freshness signal. Real production risk for heavy users.
Fix: (1) make the file-handler system-prompt guidance CONDITIONAL on the current
message having an attachment/doc context (only inject when image_bytes_list or doc
context present); (2) cap history fed to LLM to ~20 turns, not 100.

## ISSUE #4 -- /remind at 3pm (no task) -> "Couldn't understand the time"
Root cause (reminders.py:153-169): body="at 3pm"; split(\s+at\s+) doesn't match
(leading at has no preceding ws) -> generic time-error else branch; empty-task
branch (line 171) never reached.
Fix: detect time-only/no-task BEFORE the generic error; return line-172 friendly
"What should I remind you about?".

## ISSUE #5 -- URL ingestion doesn't persist / isn't queryable in chain
Root cause: schedule_silent_ingest is fire-and-forget; fetch(15s)+extract+embed+
enqueue+DG-write+AOSS eventual-consistency take seconds; Q48/49 run ~1s later.
listIngestedUrls aggregates OpenSearch chunks w/ sourceUrl -> only populates AFTER
index lands. Q47 summary comes from fetch_url tool (separate path), not indexed
chunks -> follow-ups miss it.
Fix: (1) set nanoclaw:indexing:<user> flag when URLs found so the soft-notice
fires; clear in ingest_urls_silently after enqueue. (2) For URL-only messages,
AWAIT the ingest (bounded ~20s) before answering so summary+/ingested are
consistent immediately; URLs in long messages stay fire-and-forget.

## CROSS-CUTTING -- test reset must purge DynamoDB chat history
R2 charlie bleed amplified because reset only cleared Redis, not
nanoclaw-chat-messages. Add per-user history purge (Query userId, BatchWrite
delete) to round-reset.

## EXECUTION ORDER
1. #4 reminders.py (smallest) 2. #5 url_ingestion.py + main.py 3. #1 llm/client.py
prompt-conditional + history cap (highest blast radius, last). 4. push 1 commit,
deploy, verify each live. 5. patch test reset to purge DynamoDB history.
