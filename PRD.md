# PocketClaw — Personal AI Assistant

## Product Requirements Document v3.0

**Date:** 2026-05-20  
**Status:** Complete PRD — Ready for Implementation  
**Platform:** Cross-platform (Windows / macOS / Linux)  
**User:** Single-user personal deployment

---

## MANDATORY AGENT ONBOARDING — READ BEFORE WRITING ANY CODE

**This section must be executed in full before any implementation begins.**

You are a coding agent. You have been given this PRD as a build specification. However, PocketClaw has an existing repository with its own structure, conventions, skill templates, CLAUDE.md directives, and documentation. You must follow that structure. Do not invent your own.

### Step 1 — Clone the Repository

```bash
git clone https://github.com/[nanoclaw-repo-url] pocketclaw
cd pocketclaw
```

### Step 2 — Read ALL Existing Documentation (Mandatory)

Before writing a single line of code, read every file listed below in full:

```bash
# Read in this exact order
cat README.md
cat CLAUDE.md                          # Existing agent directives — extend, do not replace
cat docs/**/*.md                       # All documentation
cat skills/*/README.md                 # All skill specs
find . -name "*.md" | xargs cat        # Any remaining markdown
find . -name "*.json" -not -path "*/node_modules/*" | xargs cat  # Config schemas
```

### Step 3 — Understand the Existing Skill System

```bash
ls skills/                             # How skills are structured
cat skills/add-telegram/skill.json     # Study a reference skill
cat skills/add-mnemon/skill.json      # Study the memory skill
```

### Step 4 — Then Build

Only after completing Steps 1–3, implement changes described in this PRD. All new files must follow existing naming conventions, directory structure, and code style found in the repo. If this PRD conflicts with an existing repo convention, the repo convention wins — flag the conflict as a comment in code.

---

## Table of Contents

1. [Product Vision](#1-product-vision)
2. [User Stories](#2-user-stories)
3. [Goals and Non-Goals](#3-goals-and-non-goals)
4. [Success Metrics](#4-success-metrics)
5. [Competitive Analysis](#5-competitive-analysis)
6. [System Architecture](#6-system-architecture)
7. [Component Specifications](#7-component-specifications)
8. [UX/Interaction Design](#8-uxinteraction-design)
9. [Security Architecture](#9-security-architecture)
10. [Data Flow](#10-data-flow)
11. [Testing Strategy](#11-testing-strategy)
12. [Cross-Platform Environment & Prerequisites](#12-cross-platform-environment--prerequisites)
13. [Implementation Phases](#13-implementation-phases)
14. [Risks & Mitigations](#14-risks--mitigations)
15. [Non-Functional Requirements](#15-non-functional-requirements)
16. [Open Items & Future Work](#16-open-items--future-work)

---

## 1. Product Vision

### Why PocketClaw?

Modern knowledge workers scatter information across Gmail, WhatsApp, Telegram, Slack, Notion, Obsidian, and local files. Context is siloed. Memory is ephemeral. Forgetting is inevitable.

PocketClaw solves this by creating a personal AI assistant that lives on your own hardware — connecting all your communication channels, maintaining a unified memory graph, and surfacing relevant context exactly when you need it. Unlike cloud-hosted AI assistants, PocketClaw keeps your data on your device. Only the assembled prompt — stripped of raw emails, contacts, and messages — ever leaves your machine to reach the reasoning engine.

### Vision Statement

> PocketClaw is your second brain that never forgets, never hallucinates, and runs entirely on your own hardware. It connects the dots across your emails, messages, calendars, and files — so you don't have to.

### Core Principles

1. **Privacy-first:** All data stays local. Only assembled prompts go to Anthropic's API.
2. **Zero-effort memory:** PocketClaw auto-ingests from cloud sources and files — no manual entry required.
3. **Cross-platform continuity:** Context follows you from Telegram to WhatsApp without re-explanation.
4. **Human-readable output:** Obsidian vault gives you a searchable, navigable knowledge base.

---

## 2. User Stories

### US-1: Cross-Platform Continuity

**As a** busy professional  
**I want** to continue a conversation on Telegram that started on WhatsApp  
**So that** I don't have to re-explain context when switching between devices or platforms  

**Acceptance Criteria:**
- A question asked on WhatsApp and continued on Telegram retrieves the same memory context
- Both platforms share the same Mnemon SQLite database
- Context is per-user (me), not per-channel

---

### US-2: Zero-Effort Memory Ingestion

**As a** forgetful person  
**I want** PocketClaw to automatically remember facts from my emails and messages  
**So that** I can reference them later without manual entry  

**Acceptance Criteria:**
- Daily ingestion pulls from Google, Microsoft, and Apple cloud sources
- Extracted facts are stored in Mnemon with source attribution
- User can query: "What did Sarah Chen say about the project timeline?"

---

### US-3: File Auto-Discovery

**As a** researcher  
**I want** PocketClaw to automatically process files I drop into my watch folder  
**So that** documents become searchable in my memory without manual import  

**Acceptance Criteria:**
- Watchdog monitors configurable paths (e.g., ~/Dropbox/Research)
- Supported formats: .md, .txt, .docx, .pdf, .pptx, .eml, .vcf, .ics
- Extracted entities appear in Mnemon graph within 60 seconds of file save

---

### US-4: Photo Context Preservation

**As a** visually-oriented user  
**I want** to send photos via Telegram or WhatsApp and have PocketClaw describe and remember their content  
**So that** visual information becomes part of my searchable memory  

**Acceptance Criteria:**
- User sends photo attachment with text caption
- PocketClaw generates image description using vision-capable model
- Description is stored in Mnemon with photo context linked
- User can later ask: "What was in the photo of the whiteboard from Tuesday?"

---

### US-5: Action Extraction from Messages

**As a** project manager  
**I want** PocketClaw to identify action items and commitments in my conversations  
**So that** I have a reliable record of what I promised and when  

**Acceptance Criteria:**
- PocketClaw extracts commitments: "I'll send the report by Friday" → stored as future action
- Calendar events are synced and linked to conversation context
- Daily digest includes pending commitments

---

### US-6: LLM-Generated Wiki

**As a** knowledge worker  
**I want** PocketClaw to auto-generate structured wiki entries for people and topics I discuss  
**So that** I have a readable knowledge base without manual curation  

**Acceptance Criteria:**
- Nightly wiki generation creates Obsidian-compatible Markdown
- Wiki entries use [[WikiLink]] syntax for cross-referencing
- User can browse wiki entries in Obsidian with full graph view

---

### US-7: Proactive Daily Summary

**As a** executive  
**I want** PocketClaw to send me a morning summary of yesterday's emails and today's calendar  
**So that** I start each day informed without checking multiple apps  

**Acceptance Criteria:**
- 07:00 local time: morning digest sent via primary interface (Telegram)
- Summary includes: emails from yesterday, today's meetings, pending commitments
- Digest is generated by Claude Code using Mnemon context

---

### US-8: Privacy-Compliant Memory

**As a** privacy-conscious user
**I want** to know exactly what data leaves my device
**So that** I can trust PocketClaw with sensitive information

**Acceptance Criteria:**
- Audit log records every data point sent to Anthropic API
- Only assembled prompts leave the machine — raw emails/messages never leave
- User can query: `/audit yesterday` to see what was shared
- Chat ingestion (Telegram + WhatsApp message archive) defaults to `INGEST_CHAT_MODE=off`. The user must explicitly opt in (`self`, `dms`, or `all`). When enabled at any level beyond `off`, the user accepts that they are storing other people's messages on their local disk.

---

## 3. Goals and Non-Goals

### Goals

- **Cross-platform:** Runs identically on Windows, macOS, and Linux via Docker
- **Persistent shared memory:** Across sessions and across both messaging interfaces (Telegram + WhatsApp)
- **Unified message queue:** 5-second batch window to handle rapid-fire messages
- **Dual interface:** Telegram (primary) and WhatsApp (secondary) — both with persistent sessions and shared Mnemon context
- **Cloud ingestion:** Via official free OAuth APIs: Google (Gmail, Calendar, Contacts), Microsoft 365 (Outlook Mail, Calendar, Contacts), Apple (CardDAV/CalDAV/IMAP)
- **File auto-discovery:** Watchdog on configurable watch paths — no manual file dropping
- **Photo context:** Users can send photo attachments; PocketClaw generates descriptions and stores in memory
- **GPU acceleration:** Toggleable via single `.env` flag, zero code changes
- **Ollama model:** Fully configurable via `.env` for embeddings
- **LLM-supervised Wiki generation:** Karpathy-style structured Obsidian output
- **Obsidian vault:** Synced cross-device via Syncthing (free, self-hosted, no cloud intermediary)
- **Hardened NanoClaw container:** Non-root, minimal capabilities, allowlisted mounts, audit log

### Non-Goals

- **Multi-user or shared-instance deployment** (v1)
- **Voice input or voice notes** (text-only messaging)
- **Video attachments** (photos only)
- **Cloud-hosted deployment**
- **Custom LLM fine-tuning**
- **Real-time collaborative Obsidian editing**
- **Sticker processing** (stickers are ignored; no response generated)

---

## 4. Success Metrics

### Primary KPIs

| Metric | Target | Measurement Method |
|--------|--------|---------------------|
| **Memory retrieval accuracy** | >90% recall of explicitly shared facts | User survey: "Did PocketClaw remember this?" after 30 days |
| **Time saved per day** | >30 minutes | Self-reported by user at 30-day mark |
| **Ingestion completeness** | >95% of cloud emails processed | mnemon entity count vs email count from logs |
| **Cross-platform continuity rate** | <5% re-explanation needed | Track "What did you already know?" flags in audit log |
| **Response latency P95** | <8 seconds (including Anthropic API) | Timestamps logged on every query |
| **Photo description accuracy** | User confirms relevance in >80% of cases | Inline user feedback: "/confirm" or "/deny" |
| **False fact injection rate** | 0 confirmed hallucinations | User-reported + monthly audit log review |

### Secondary KPIs

| Metric | Target | Measurement Method |
|--------|--------|---------------------|
| Container uptime | >99% | Docker container health checks |
| Idempotency compliance | 100% | Re-ingest same file → zero duplicate entries |
| Cross-platform parity | Identical behaviour | Manual test on Windows, macOS, Linux quarterly |
| Wiki generation coverage | >80% of entities have wiki entries | Obsidian vault query via Dataview |
| Audit log completeness | 100% of tool calls logged | Automated log integrity check |

---

## 5. Competitive Analysis

### Why PocketClaw vs Alternatives?

| Alternative | Limitation | PocketClaw Advantage |
|-------------|------------|----------------------|
| **ChatGPT / Mem.ai** | Cloud-hosted; data leaves device; subscription required | 100% local; only prompt leaves; one-time setup cost |
| **Notion AI** | Requires manual curation; cloud storage; siloed | Auto-ingests from all sources; unified memory graph |
| **Apple Notes + Siri** | iOS/macOS only; no cross-platform memory; limited context | Cross-platform (Win/Mac/Linux); unified memory across Telegram + WhatsApp |
| **Obsidian + local LLM** | Manual file handling; no messaging integration | Auto-discovery + Telegram/WhatsApp interfaces; cloud ingestion |
| **Personal.ai / Reclaim.ai** | Subscription; vendor lock-in; data on their servers | Self-hosted; no recurring cost; data stays local |
| **Pi.ai / Pi Assistant** | Cloud-only; no memory persistence; no file integration | Persistent memory; file ingestion; Obsidian output |
| **Microsoft Copilot** | Work/enterprise context; requires Microsoft 365 | Personal deployment; Google + Apple + Microsoft integration |

### Key Differentiators

1. **Local-first architecture:** All reasoning happens on-device except final prompt to Anthropic
2. **Cross-platform messaging:** Unified context across Telegram and WhatsApp
3. **Auto-ingestion:** No manual entry — PocketClaw pulls from cloud sources automatically
4. **Photo memory:** Photos become searchable facts in the memory graph
5. **Obsidian integration:** Human-readable, cross-device knowledge base with Syncthing

---

## 6. System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         MESSAGING INTERFACES                          │
│                                                                      │
│  [Telegram Bot API]  ──────────────────────┐                         │
│  (Long Polling — no inbound port needed)  │                         │
│  [Photo Attachments]  ✓                   │                         │
│  [Text Messages]  ✓                        │                         │
│  [Stickers]  ✗ (ignored)                   │                         │
│                                            ▼                         │
│  [WhatsApp / Baileys] ─────────────► [Unified Message Queue]         │
│  (Persistent named volume session)   5-second batch window           │
│  [Photo Attachments]  ✓                                            │
│  [Text Messages]  ✓                                                │
│  [Stickers]  ✗ (ignored)                                            │
└────────────────────────────────────────────┬─────────────────────────┘
                                             │
                                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    NANOCLAW CONTAINER (Docker)                        │
│                                                                      │
│   [NanoClaw Harness]  ──►  [Claude Code CLI]                         │
│                                  │                                   │
│               ┌──────────────────┼──────────────────┐               │
│               ▼                  ▼                   ▼               │
│          [Mnemon]          [Ingestion]          [LLM Wiki]           │
│          CLI Tool         Pipeline             Generator            │
│         (shared DB)     (file + cloud + photo)                       │
│                                                                      │
│   [Photo Processor]  ──►  Vision Model  ──►  Mnemon Description     │
└───────────────┬──────────────────────────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      LOCAL SERVICES (Host)                            │
│                                                                      │
│  [Ollama :11434]              [~/.pocketclaw/mnemon.db]              │
│  Model: $OLLAMA_EMBED_MODEL   (single SQLite file — shared by        │
│  GPU: $GPU_ENABLED            both Telegram and WhatsApp)            │
│                                                                      │
│  [Obsidian Vault]  ◄──────────────────────────────────────────────  │
│  ~/.pocketclaw/vault/         [Syncthing]  ──► [Mobile / Other PC]  │
└──────────────────────────────────────────────────────────────────────┘
                │
                │  (only assembled prompts leave the machine)
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    ANTHROPIC API (External)                           │
│     Claude Code SDK  ──►  api.anthropic.com  (Claude Max)            │
└──────────────────────────────────────────────────────────────────────┘
```

### Architecture Clarification Notes

> ⚠️ **As-built reality (2026-05-22):** the architecture diagram above is the **original v3.0 spec**. The actual deployed system replaced the top-level Docker container with NanoClaw v2's dynamic per-agent-group spawn model and runs the host as a Windows service via NSSM. Cloud-ingested data lives at `X:\PocketClawData\` (configurable per machine) instead of `~/.pocketclaw/`. See `.omo/notepads/pocketclaw/prd-vs-built-audit.md` for the full delta and `§18` below for everything we built that wasn't in this PRD.

**Why does the diagram show an arrow to Anthropic?**

Claude Code is a CLI that sends the assembled prompt (user message + Mnemon context) to Anthropic's LLM API and returns the reasoning response. It is the only outbound data flow. Embeddings (Ollama), memory (Mnemon), file ingestion, photo processing, and wiki generation all execute locally first — the final prompt is the only thing that leaves.

**Why no Tailscale?**

Telegram uses long polling — the container opens an outbound connection to Telegram's servers and waits for messages. No inbound port is needed. WhatsApp/Baileys similarly opens an outbound WebSocket. Zero inbound surface. Tailscale is listed as an optional hardening layer only.

**Why Syncthing, not OneDrive or iCloud?**

The system is platform-agnostic. OneDrive is Windows-native; iCloud is macOS-native. Syncthing is free, self-hosted, peer-to-peer, and runs identically on Windows, macOS, Linux, Android, and iOS. No cloud intermediary holds your knowledge data.

**Cross-platform context (WhatsApp ↔ Telegram):**

Both interfaces share the same Mnemon SQLite database (single volume mount). A question asked on WhatsApp and continued on Telegram retrieves the same memory graph. Context is not per-channel — it is per-user (you), globally.

**Photo and Sticker Handling:**

- Photos sent via Telegram or WhatsApp are downloaded to the container, processed through a vision model (via Ollama or Claude), and the description is stored in Mnemon
- Stickers are silently ignored — no response is generated, no processing occurs
- Text messages always trigger PocketClaw's response pipeline

---

## 7. Component Specifications

### 7.1 NanoClaw — Harness

**Role:** Orchestrates Claude Code in an isolated Docker container. Routes batched messages from both interfaces to the reasoning engine. Enforces mount allowlist and audit logging.

**Critical:** Follow the existing skill structure in the NanoClaw repo. Do not create a parallel skill system. Install all channel adapters and memory adapters via the existing `/add-*` skill mechanism.

**docker-compose.yml:**

```yaml
version: "3.9"

services:
  nanoclaw:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: pocketclaw
    restart: unless-stopped
    user: "1000:1000"
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp:size=100m,noexec
    volumes:
      - ${VAULT_PATH}:/vault:rw
      - ${MNEMON_DB_PATH}:/home/user/.mnemon:rw
      - ${WATCH_PATHS_ROOT}:/watch:ro              # Auto-discovery root (read-only)
      - wa-session:/home/user/.wa-session:rw        # Persistent WhatsApp session
      - photo-cache:/home/user/.photo-cache:rw       # Temporary photo storage
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - TELEGRAM_ALLOWED_CHAT_ID=${TELEGRAM_ALLOWED_CHAT_ID}
      - OLLAMA_HOST=http://host.docker.internal:11434
      - OLLAMA_EMBED_MODEL=${OLLAMA_EMBED_MODEL:-nomic-embed-text}
      - BATCH_WINDOW_MS=${BATCH_WINDOW_MS:-5000}
      - VISION_MODEL=${VISION_MODEL:-llava}
    extra_hosts:
      - "host.docker.internal:host-gateway"        # Linux host resolution
    networks:
      - pocketclaw-net
    deploy:
      resources:
        limits:
          memory: ${CONTAINER_MEMORY_LIMIT:-2g}

      # GPU block — active only when GPU_ENABLED=true
      # Uncomment this section when GPU_ENABLED=true in .env:
      # resources:
      #   reservations:
      #     devices:
      #       - driver: nvidia
      #         count: 1
      #         capabilities: [gpu]

volumes:
  wa-session:                                       # Persistent WhatsApp session — named volume
  photo-cache:                                      # Temporary photo processing — cleared on restart

networks:
  pocketclaw-net:
    driver: bridge
```

**Mount Allowlist (config/mount-allowlist.json):**

```json
{
  "allowed_write": ["/vault", "/home/user/.mnemon", "/tmp", "/home/user/.photo-cache"],
  "allowed_read": ["/watch", "/home/user/.mnemon"],
  "denied": ["/etc", "/usr", "/bin", "/sbin", "/proc", "/sys"]
}
```

---

### 7.2 Claude Code — Reasoning Engine

**Subscription Required:** Claude Max ($100/mo). Claude Pro is insufficient for agentic workloads.

**Installation (Dockerfile):**

```dockerfile
FROM node:20-slim
RUN npm install -g @anthropic-ai/claude-code
RUN useradd -m -u 1000 user
USER user
WORKDIR /home/user
COPY .claude/ .claude/
CMD ["nanoclaw"]
```

**CLAUDE.md (Agent Directives — Full Text):**

Place at `.claude/CLAUDE.md` in the NanoClaw repo, following its existing CLAUDE.md conventions. If the repo already has a CLAUDE.md, append the PocketClaw-specific sections below rather than replacing.

```markdown
# PocketClaw Agent Directives

## Identity
You are PocketClaw, a personal AI assistant. You know everything the user has
explicitly taught you via memory ingestion. You do not hallucinate facts — if you
are unsure, you say so and offer to search memory.

## Purpose
You are a personal assistant. Your role is to:
- Help the user accomplish tasks efficiently and accurately
- Remember facts, preferences, and contexts the user shares
- Retrieve memories when relevant to the current conversation
- Process photo attachments and generate descriptions for memory storage
- Provide thoughtful, context-aware support across any topic
- Never pretend to know something you haven't been told

## Memory Protocol
- On every session start: run `mnemon recall --query "<session context>"` to load
  relevant memories
- Before answering factual questions about the user: check mnemon first
- After every conversation that contains new facts: run `mnemon remember` to persist
- When photo is received: generate description → store in mnemon

## Tool Use Policy
- Never use --access grants that have not been explicitly approved in this session
- Never write outside the /vault directory
- Never read outside the /watch directory
- Log every tool call to /tmp/audit.log

## Response Style
- Concise. Direct. No filler phrases.
- Lead with the answer, then context if needed
- Use markdown sparingly (headers, lists for clarity)
- Match the user's length preference (short question = short answer)
- Flag conflicting information: "Earlier you said X, now you're saying Y — want me
  to update your memory?"

## Emotional Awareness
- Acknowledge emotional content in user messages
- If user shares frustration or stress, validate briefly before problem-solving
- If user is celebrating, match their energy briefly before continuing
- Never be dismissive of feelings, even if the question is simple

## Permissions
Allowed:
- Read files in /watch or user-specified paths (with approval)
- Write to /vault for new creations
- Search the web ONLY when explicitly requested
- Execute tasks the user assigns
- Download and process photo attachments

Restricted:
- No file system operations outside /vault (write) or /watch (read)
- No API calls without user confirmation
- No execution of shell commands without explicit approval
- No video processing (videos are ignored)

## Boundaries
1. Never fabricate information about the user
2. Never share memories with third parties
3. Never execute commands that could modify system files
4. Refer to yourself as PocketClaw, not Claude
5. Do not reveal the underlying model or infrastructure
6. Stickers are silently ignored — do not respond to sticker messages

## Batched Message Handling
When you receive a batched prompt containing multiple messages from the user
(marked with [BATCH START] / [BATCH END]):
- Identify whether messages belong to the same task or different tasks
- For same-task messages: treat as a single combined instruction
- For different-task messages: list them and ask which to handle first, or
  execute sequentially if order is unambiguous
- Never silently drop any message in a batch

## Photo Handling
When a photo attachment is received:
1. Download photo to temporary storage
2. Generate description using vision model
3. Store description in Mnemon with photo context
4. Associate photo with current conversation thread
5. Respond acknowledging receipt with brief description summary
```

---

### 7.3 Mnemon — Memory Engine

**Backend:** SQLite native (zero-config). Single file at `~/.pocketclaw/mnemon.db`.  
**Shared across interfaces:** Both Telegram and WhatsApp adapters read/write the same DB. Context is globally shared — cross-platform, cross-session.

**Graph Types:**

| Graph | Stores | Example |
|-------|--------|--------|
| Entity | People, orgs, concepts, tools | "Sarah Chen works at DBS Bank" |
| Temporal | Time-stamped events | "Met Sarah at FinTech SG 2025-11-12" |
| Causal | Cause-effect chains | "Deal paused due to Q3 budget freeze" |
| Semantic | Concept associations | "Singapore → ASEAN → trade policy" |
| Photo | Image descriptions | "Whiteboard photo: project timeline Q3" |

**Setup (inside container, after reading repo):**

```bash
mnemon setup --target nanoclaw --yes
mnemon setup --embeddings ollama \
  --model ${OLLAMA_EMBED_MODEL} \
  --endpoint ${OLLAMA_HOST}
```

**Key Agent Commands:**

```bash
mnemon remember "<fact>"
mnemon recall --query "<query>" --depth 3
mnemon link --from "<entity_a>" --to "<entity_b>" --relation "<relation>"
mnemon list --type entity --limit 50
mnemon gc                                    # Decay + dedup
mnemon remember --photo "<description>" --source "<photo_id>"  # Store photo description
```

---

### 7.4 Ollama — Embedding Layer (CPU + Optional GPU)

**Runs on host** (not inside Docker). Accessible from container via `host.docker.internal:11434`.

**Installation:**

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows
# Download installer from https://ollama.com
```

**Pull model:**

```bash
ollama pull ${OLLAMA_EMBED_MODEL}   # Default: nomic-embed-text
```

**Pull vision model (for photo descriptions):**

```bash
ollama pull ${VISION_MODEL}         # Default: llava
```

**GPU Toggle — Zero Code Change:**

Set in `.env`:

```env
GPU_ENABLED=false            # Default — CPU only
# GPU_ENABLED=true           # Uncomment to enable GPU
OLLAMA_EMBED_MODEL=nomic-embed-text   # Swap to any Ollama-supported model
VISION_MODEL=llava                   # Vision model for photo descriptions
```

When `GPU_ENABLED=true`:
- For NVIDIA: Ollama auto-detects CUDA if NVIDIA drivers are installed — no additional config
- For Apple Silicon: Ollama auto-uses Metal — no additional config
- Uncomment the `devices` block in `docker-compose.yml` for NVIDIA GPU passthrough to container

**Model Options (all CPU-capable, GPU-accelerated when available):**

| Model | Size | Notes |
|-------|------|-------|
| `nomic-embed-text` | 274MB | Default. Fast, accurate, well-tested with Mnemon |
| `mxbai-embed-large` | 670MB | Higher accuracy, slower on CPU |
| `all-minilm` | 46MB | Smallest footprint, lower accuracy |
| `llava` | 4.7GB | Vision model for photo descriptions |

---

### 7.5 Unified Message Queue & Batch Engine

**Problem:** Users send rapid-fire messages across two platforms. These may be:
- Type A: Multiple instructions for the same task ("Write a report" → "make it 500 words" → "use bullet points")
- Type B: Completely separate tasks ("What time is my meeting" → "also buy milk reminder")

**Solution:** A per-session message debouncer with a 5-second batch window, implemented as a lightweight service inside the NanoClaw container.

**Architecture:**

```
Telegram message arrives (text or photo)
        │
        ▼
[Per-Channel Queue]   ◄── WhatsApp message arrives (text or photo)
        │
        │  5-second timer starts on first message
        │  Resets if new message arrives within window
        │
        ▼ (timer fires)
[Batch Assembler]
  - Collects all queued messages
  - Tags each with: platform, timestamp, message_id, has_attachment
  - Wraps in structured batch prompt
        │
        ▼
[Claude Code Agent]
```

**Batch Prompt Format:**

```
[BATCH START — 3 messages, 4.2s window]
[1] [Telegram | 14:32:01] Write me a summary of my DBS meeting
[2] [Telegram | 14:32:03] keep it under 200 words
[3] [WhatsApp | 14:32:05] also remind me to follow up with Sarah
[BATCH END]

Instructions: See CLAUDE.md § Batched Message Handling
```

**Photo in Batch Format:**

```
[BATCH START — 2 messages, 2.1s window]
[1] [Telegram | 14:35:01] [PHOTO ATTACHED] whiteboarding session
[2] [Telegram | 14:35:03] can you remember what's on this whiteboard?
[BATCH END]
```

**Implementation (`queue/debouncer.py`):**

```python
import asyncio
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional

BATCH_WINDOW_MS = int(os.getenv("BATCH_WINDOW_MS", "5000")) / 1000

class MessageType(Enum):
    TEXT = "text"
    PHOTO = "photo"
    STICKER = "sticker"  # Silently dropped

@dataclass
class QueuedMessage:
    platform: str
    timestamp: datetime
    message_id: str
    text: str
    message_type: MessageType = MessageType.TEXT
    attachment_path: Optional[str] = None  # Path to downloaded photo

class MessageDebouncer:
    def __init__(self, on_batch):
        self._queues: dict[str, list[QueuedMessage]] = defaultdict(list)
        self._timers: dict[str, asyncio.TimerHandle] = {}
        self._on_batch = on_batch          # callback: async fn(messages)

    async def push(self, session_id: str, message: QueuedMessage):
        # Silently ignore stickers
        if message.message_type == MessageType.STICKER:
            return

        self._queues[session_id].append(message)
        if session_id in self._timers:
            self._timers[session_id].cancel()
        loop = asyncio.get_event_loop()
        self._timers[session_id] = loop.call_later(
            BATCH_WINDOW_MS,
            lambda: asyncio.ensure_future(self._flush(session_id))
        )

    async def _flush(self, session_id: str):
        messages = self._queues.pop(session_id, [])
        self._timers.pop(session_id, None)
        if messages:
            await self._on_batch(messages)
```

**Session ID Strategy:**
- Session key = user identifier (e.g., your Telegram chat ID or WhatsApp number)
- Cross-platform messages from the same user are routed to the same queue
- This ensures a Telegram message and a WhatsApp message sent within 5 seconds are batched together

---

### 7.6 Telegram Interface

**Role:** Primary interface. Official Bot API. Long polling — zero inbound ports required.

**Setup:**

```bash
# 1. Create bot via @BotFather → save TELEGRAM_BOT_TOKEN to .env
# 2. Install via existing NanoClaw skill mechanism
/add-telegram

# 3. Get your chat ID (send /start to @userinfobot)
# 4. Add to .env: TELEGRAM_ALLOWED_CHAT_ID=<your_chat_id>
```

**Long Polling (no webhook, no Tailscale needed):**

```python
# Telegram skill uses python-telegram-bot in polling mode
application = Application.builder().token(BOT_TOKEN).build()
application.run_polling()    # Outbound only — no inbound port
```

**Message routing:**

- Text messages → `MessageDebouncer.push(session_id, message)`
- Photo attachments → download → `MessageDebouncer.push(session_id, photo_message)`
- Stickers → silently ignored
- Session ID = `str(update.effective_chat.id)`

**Commands:**

```
/memory <fact>      → mnemon remember
/recall <query>     → mnemon recall
/wiki <topic>       → trigger LLM Wiki generation
/ingest             → trigger manual ingestion run
/status             → show mnemon entity count, last ingestion time
/digest             → trigger morning digest generation
/audit [date]       → show audit log for date (default: today)
/photo <description> → manually store photo description
/help               → show available commands
```

**Security — Chat ID Allowlist:**

```python
ALLOWED = {int(os.environ["TELEGRAM_ALLOWED_CHAT_ID"])}

async def guard(update, context):
    if update.effective_chat.id not in ALLOWED:
        return   # Silent reject
```

---

### 7.7 WhatsApp Interface (Baileys)

**Role:** Secondary interface. Outbound WebSocket only (no inbound port).  
**Known Risk:** Unofficial protocol. Use a secondary number. This is explicitly acknowledged.

**Persistent Session:**

WhatsApp session persists via a named Docker volume (`wa-session`). Session survives container restarts without requiring QR re-scan.

```yaml
# docker-compose.yml — already included above
volumes:
  wa-session:    # Named volume — persists across restarts
```

```bash
# Install via existing NanoClaw skill mechanism
/add-whatsapp

# First run: scan QR code shown in container logs
docker logs -f pocketclaw | grep "QR"

# Subsequent restarts: session auto-restored from named volume
```

**Message routing:**

- Text messages → `MessageDebouncer.push(session_id, message)`
- Photo attachments → download → `MessageDebouncer.push(session_id, photo_message)`
- Stickers → silently ignored
- Session ID = your registered WhatsApp number (E.164 format: `+6591234567`)
- Same session ID strategy as Telegram ensures cross-platform batching works

**Self-chat model (default for command routing):**

By default, only messages **from the user themselves** wake the agent for command processing. This prevents the agent from auto-replying to friends, family, or group conversations the user happens to be in.

```javascript
// Baileys adapter — only respond/route to messages from self
if (message.key.fromMe || message.key.remoteJid === selfJid) {
    await debouncer.push(sessionId, parsedMessage);
}
```

**Passive chat archive (opt-in, separate from command routing):**

Independent of command routing, every inbound chat message can be archived to mnemon (controlled by `INGEST_CHAT_MODE` env var, default `off`). Archive runs fire-and-forget BEFORE the self-chat filter, so it captures both directions of conversation if enabled. See §17.7 for the full chat-archive design and the privacy posture.

**Session Security:**

- Named volume is NOT mounted read-only — Baileys must write session state
- Exclude `wa-session` from all backups: the session token = full WhatsApp account access
- Add to `.gitignore`: `wa-session/`, `*.wa-session`
- If session is compromised: `docker volume rm pocketclaw_wa-session` → re-authenticate

---

### 7.8 Photo Processing Pipeline

**Role:** Handles photo attachments from Telegram and WhatsApp. Generates descriptions using vision model and stores in Mnemon.

**Supported Formats:** JPEG, PNG, WebP (max 10MB per image)

**Pipeline Flow:**

```
Photo attachment received
         │
         ▼
[Download to /home/user/.photo-cache/]
         │
         ▼
[Validate: JPEG/PNG/WebP, <10MB]
         │
         ▼ (fail → respond with error, don't crash)
[Resize: max 2048px on longest edge (preserve aspect ratio)]
         │
         ▼
[Vision Model (Ollama llava)]: "Describe this image briefly"
         │
         ▼
[Claude Code: enhance description with conversation context]
         │
         ▼
[mnemon remember --photo "<enhanced_description>" --source "<platform>"]
         │
         ▼
[Respond to user with brief description confirmation]
         │
         ▼
[Delete photo from /home/user/.photo-cache/]
```

**Photo Description Prompt:**

```
You have received an image with the following context from the user.

User message: "{user_message_text}"
Platform: {telegram|whapapp}

Task:
1. Describe the image content concisely (2-3 sentences)
2. Extract any text visible in the image
3. Identify any people, objects, locations if recognizable
4. Link to conversation context if relevant

Output format:
Image Description: {concise description}
Extracted Text: {any text found}
Key Elements: {list of identifiable elements}
Related Context: {how this connects to conversation}
```

**Example Output:**

```
Image Description: A whiteboard covered in sticky notes organized in columns labeled "To Do", "In Progress", and "Done". Several team members' names are written on different sticky notes.

Extracted Text: "Q3 Planning", "API Integration - Sarah", "Design Review - James", "Launch Date: Oct 15"

Key Elements: Whiteboard, sticky notes, marker writing, column headers

Related Context: This appears to be a project planning board from a team meeting, possibly for Q3 planning based on the extracted text.
```

---

### 7.9 Cross-Platform Cloud Ingestion

All three cloud ecosystems are connected via official free APIs. No manual export of `.vcf`, `.ost`, or `.ics` files.

---

#### 7.9.1 Google (Gmail, Google Calendar, Google Contacts)

**API:** Google OAuth2 → Gmail API, Calendar API, People API  
**Cost:** Free tier. No billing required for personal use at this scale.

**Setup:**

1. Go to https://console.cloud.google.com → Create project "PocketClaw"
2. Enable: Gmail API, Google Calendar API, People API
3. OAuth 2.0 → Desktop app → Download `credentials.json`
4. Place `credentials.json` at `~/.pocketclaw/secrets/google_credentials.json`
5. On first run: browser opens for OAuth consent → token saved to `~/.pocketclaw/secrets/google_token.json`

**Ingestion scope:**

```python
SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/contacts.readonly",
]
```

**What is extracted:**

| Source | Fields |
|--------|--------|
| Gmail | sender, recipients, subject, body (plain text), date, thread_id |
| Google Calendar | title, attendees, start/end datetime, location, description, recurring flag |
| Google Contacts | full name, emails, phones, company, job title, notes |

---

#### 7.9.2 Microsoft 365 (Outlook Mail, Outlook Calendar, Outlook Contacts)

**API:** Microsoft Graph API  
**Cost:** Free. Microsoft Graph is free for personal/developer use.

**Setup:**

1. Go to https://portal.azure.com → App registrations → New registration
2. Name: "PocketClaw" | Supported account types: Personal Microsoft accounts
3. Authentication → Mobile and desktop applications → `http://localhost` redirect
4. API Permissions → Add: `Mail.Read`, `Calendars.Read`, `Contacts.Read`
5. Save `client_id` to `.env`

```python
# Microsoft Graph — device code flow (no browser popup needed after first run)
from msal import PublicClientApplication

app = PublicClientApplication(client_id=MS_CLIENT_ID, authority="https://login.microsoftonline.com/common")

# First run: device code auth → token cached locally
flow = app.initiate_device_flow(scopes=["Mail.Read", "Calendars.Read", "Contacts.Read"])
print(flow["message"])   # User visits URL, enters code once
token = app.acquire_token_by_device_flow(flow)
```

**What is extracted:**

| Source | Fields |
|--------|--------|
| Outlook Mail | sender, recipients, subject, body, date, conversation_id |
| Outlook Calendar | subject, attendees, start/end, location, body, isRecurring |
| Outlook Contacts | displayName, emails, phones, company, jobTitle |

---

#### 7.9.3 Apple (iCloud Mail, iCloud Calendar, iCloud Contacts)

**API:** Standard open protocols — IMAP, CalDAV, CardDAV  
**Cost:** Free. No API key or developer account required.

**Setup (App-Specific Password required):**

1. Go to https://appleid.apple.com → Security → App-Specific Passwords → Generate
2. Save to `.env` as `APPLE_APP_PASSWORD`

**IMAP (Mail):**

```python
# iCloud IMAP server
IMAP_HOST = "imap.mail.me.com"
IMAP_PORT = 993
IMAP_USER = os.environ["APPLE_ID_EMAIL"]
IMAP_PASS = os.environ["APPLE_APP_PASSWORD"]
```

**CalDAV (Calendar):**

```python
# iCloud CalDAV — requires caldav library
CALDAV_URL = f"https://caldav.icloud.com/{apple_principal_id}/calendars/"
# Auth: APPLE_ID_EMAIL + APPLE_APP_PASSWORD
```

**CardDAV (Contacts):**

```python
# iCloud CardDAV — requires vobject library
CARDDAV_URL = f"https://contacts.icloud.com/{apple_principal_id}/carddavhome/"
# Auth: APPLE_ID_EMAIL + APPLE_APP_PASSWORD
```

---

#### 7.9.4 Cloud Ingestion Scheduler

All three cloud sources are pulled on the same schedule as file ingestion:

```python
# ingestion/cloud_scheduler.py
SOURCES = [
    GoogleMailIngester(),
    GoogleCalendarIngester(),
    GoogleContactsIngester(),
    MicrosoftMailIngester(),
    MicrosoftCalendarIngester(),
    MicrosoftContactsIngester(),
    AppleMailIngester(),
    AppleCalendarIngester(),
    AppleContactsIngester(),
]

async def run_all():
    for source in SOURCES:
        try:
            facts = await source.fetch_and_extract()
            for fact in facts:
                await mnemon.remember(fact)
        except Exception as e:
            logger.error(f"{source.__class__.__name__} failed: {e}")
            # Fault-isolated: one source failing does not block others
```

**Pull frequency:**
- Scheduled: daily at 02:00 local time
- Manual trigger: `/ingest` command via Telegram or WhatsApp

---

### 7.10 File Auto-Discovery & Ingestion Pipeline

**No manual file dropping.** `watchdog` monitors configurable paths and automatically ingests new/modified files.

**Configuration (`.env`):**

```env
WATCH_PATHS=/watch/documents,/watch/downloads,/watch/notes
WATCH_RECURSIVE=true
WATCH_POLL_INTERVAL_SECONDS=30
```

**Supported File Types:**

| Format | Library | Extracts |
|--------|---------|----------|
| `.md`, `.txt` | Built-in | Full text |
| `.docx` | python-docx | Paragraphs, tables, headings |
| `.pptx` | python-pptx | Slide text, speaker notes |
| `.pdf` | pdfplumber | Text, tables (layout-aware) |
| `.eml` | email stdlib | Headers, body (HTML → plain) |
| `.vcf` | vobject | Contact fields |
| `.ics` | icalendar | Event fields |

**Pipeline Flow:**

```
[Watchdog detects new/modified file at /watch/...]
         │
         ▼
[File type → Extractor selected] → raw text
         │
         ▼
[Chunker: 512 tokens, 64-token overlap]
         │
         ▼
[Claude Code: entity extraction prompt per chunk]
  → structured JSON: {entities[], facts[], relationships[], events[]}
         │
         ▼
[For each fact: mnemon remember]
         │
         ▼
[File fingerprinted (SHA256) → stored in processed_files.db]
[Already-processed files skipped on next scan]
         │
         ▼
[If >10 new entities: trigger wiki generation]
         │
         ▼
[Audit log: filename, chunk_count, entity_count, timestamp]
```

**Idempotency:**

Files are fingerprinted with SHA256. Re-scanning the same file is a no-op unless content has changed. Processed file registry stored in `~/.pocketclaw/processed.db`.

---

### 7.11 LLM Wiki Generator

**Pattern:** Andrej Karpathy's LLM-supervised Wiki generation — Claude Code reads Mnemon's memory graph and generates structured Markdown wiki entries directly into the Obsidian vault.

**Triggers:**

- Manual: `/wiki <topic>` via either interface
- Scheduled: nightly at 03:00 (after ingestion at 02:00)
- Event-driven: after ingestion runs producing >10 new entities

**Generation Process (`wiki/generator.py`):**

```
Step 1: mnemon list --type entity --limit 100
        → full entity list

Step 2: for each entity:
        mnemon recall --query "{entity}" --depth 3
        → graph neighbourhood (linked facts, temporal, causal edges)

Step 3: Claude Code prompt (see below)
        → structured Markdown output

Step 4: write to /vault/wiki/{sanitised_entity_name}.md
        (overwrite if exists — wiki entries are regenerated, not appended)
```

**Claude Code Wiki Generation Prompt:**

```
You are a personal knowledge curator for PocketClaw.

Generate a structured Obsidian-compatible Markdown wiki entry for the entity below.

Rules:
- Only include facts present in the memory context provided. No hallucination.
- Use [[WikiLink]] syntax for every related entity.
- Add YAML frontmatter: created, updated, entity_type, tags.
- Tags must use snake_case.
- If memory context is sparse, generate a short stub entry only.
- Output only the Markdown. No preamble.

Entity: {entity_name}
Memory context:
{mnemon_recall_output}

Required structure:
---
created: {date}
updated: {date}
entity_type: {person|organisation|concept|event|project}
tags: [tag1, tag2]
---

# {Entity Name}

## Summary
{2–4 sentence overview}

## Key Facts
{bullet list — sourced only from memory context}

## Relationships
{bullet list — use [[WikiLink]] for every entity}

## Timeline
{chronological events if available}

## Notes
{any additional context or caveats}
```

**Example Output:**

```markdown
---
created: 2026-05-20
updated: 2026-05-20
entity_type: person
tags: [contact, finance, dbs]
---

# Sarah Chen

## Summary
Senior Relationship Manager at DBS Bank, Corporate Banking division.
Primary point of contact for trade finance discussions. First met at
FinTech Singapore 2025.

## Key Facts
- Works at [[DBS Bank]], Corporate Banking
- Specialises in SME lending and trade finance products
- Preferred contact method: LinkedIn DM

## Relationships
- Reports to [[James Tan]] (DBS Head of Corporate Banking)
- Introduced via [[FinTech Singapore 2025]]
- Referenced in [[DBS Meeting 2026-05-15]]

## Timeline
- 2025-11-12: First met at [[FinTech Singapore 2025]]
- 2026-05-15: Meeting to discuss trade finance product line

## Notes
Follow-up pending post Q3 budget confirmation.
```

---

### 7.12 Obsidian Output Layer + Syncthing

**Role:** Human-readable knowledge interface. PocketClaw writes to the vault; the user reads, annotates, and navigates here.

**Vault Path (platform-agnostic via `.env`):**

```env
VAULT_PATH=~/.pocketclaw/vault          # Default — override per platform
```

Platform-specific defaults (set in shell profile or `.env`):

```bash
# macOS/Linux
VAULT_PATH="$HOME/.pocketclaw/vault"

# Windows (in .env)
VAULT_PATH=C:\Users\{user}\.pocketclaw\vault
```

**Vault Directory Structure:**

```
vault/
├── wiki/            # LLM-generated entries (auto-written by PocketClaw)
│   ├── Sarah_Chen.md
│   ├── DBS_Bank.md
│   └── ...
├── meetings/        # Calendar-derived meeting notes (auto-written)
├── contacts/        # Contact-derived entries (auto-written)
├── photos/          # Photo descriptions linked from Mnemon (auto-written)
├── notes/           # User's own notes (manual — never auto-overwritten)
└── .obsidian/
    ├── app.json
    └── plugins/     # See plugin list below
```

**Obsidian Plugins:**

| Plugin | Purpose |
|--------|---------|
| Dataview | Query wiki entries as a live database |
| Graph View | Visualise entity relationships (mirrors Mnemon graph) |
| Calendar | Navigate meeting notes by date |
| Tag Wrangler | Manage entity tags at scale |

**Syncthing Setup (cross-device, free, self-hosted):**

```bash
# Install Syncthing
# macOS: brew install syncthing
# Linux: see https://apt.syncthing.net
# Windows: download from https://syncthing.net

# Start Syncthing
syncthing   # Opens web UI at http://127.0.0.1:8384

# Add vault folder: ~/.pocketclaw/vault
# Add each device (laptop, phone, tablet) via Syncthing device ID
# Share the vault folder with each device
```

Syncthing operates peer-to-peer, encrypted in transit (TLS), with no cloud intermediary. The vault never passes through a third-party server.

---

## 8. UX/Interaction Design

### 8.1 First-Time Setup Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                         STEP 1: CLONE & BUILD                        │
│                                                                      │
│  User clones repo                                                     │
│       │                                                               │
│       ▼                                                               │
│  Runs: docker compose up                                              │
│       │                                                               │
│       ▼                                                               │
│  Container starts → security checks pass                             │
│       │                                                               │
│       ▼                                                               │
│  Success message in logs                                              │
└──────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         STEP 2: TELEGRAM SETUP                        │
│                                                                      │
│  User opens Telegram → contacts @BotFather                            │
│       │                                                               │
│       ▼                                                               │
│  Creates new bot → receives BOT_TOKEN                                 │
│       │                                                               │
│       ▼                                                               │
│  Adds BOT_TOKEN to .env                                               │
│       │                                                               │
│       ▼                                                               │
│  Contacts @userinfobot → receives CHAT_ID                             │
│       │                                                               │
│       ▼                                                               │
│  Adds CHAT_ID to .env                                                │
│       │                                                               │
│       ▼                                                               │
│  Restarts container                                                   │
│       │                                                               │
│       ▼                                                               │
│  Sends /start to bot → PocketClaw responds: "Hello! I'm PocketClaw." │
└──────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         STEP 3: CLOUD AUTH                            │
│                                                                      │
│  User sends /auth google                                              │
│       │                                                               │
│       ▼                                                               │
│  PocketClaw opens browser for OAuth consent                          │
│       │                                                               │
│       ▼                                                               │
│  User approves → credentials cached locally                           │
│       │                                                               │
│       ▼                                                               │
│  Repeat for /auth microsoft, /auth apple                              │
│       │                                                               │
│       ▼                                                               │
│  PocketClaw confirms: "Google, Microsoft, Apple connected."           │
└──────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         STEP 4: OBSIDIAN + SYNCTHING                  │
│                                                                      │
│  User installs Obsidian on primary device                            │
│       │                                                               │
│       ▼                                                               │
│  User points Obsidian to VAULT_PATH                                  │
│       │                                                               │
│       ▼                                                               │
│  User installs Syncthing on all devices                              │
│       │                                                               │
│       ▼                                                               │
│  User adds vault folder to Syncthing                                 │
│       │                                                               │
│       ▼                                                               │
│  Syncthing confirms: "Vault syncing to 2 devices."                   │
└──────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│                              SETUP COMPLETE                            │
│                                                                      │
│  User sends first message: "Hello PocketClaw!"                        │
│       │                                                               │
│       ▼                                                               │
│  PocketClaw responds: "Hello! Memory connected. Ready to assist."     │
│       │                                                               │
│       ▼                                                               │
│  Setup flow complete                                                  │
└──────────────────────────────────────────────────────────────────────┘
```

### 8.2 Daily Usage Patterns

#### Morning Routine (07:00)

```
PocketClaw sends (via Telegram):
────────────────────────────────
☀️ Good morning!

📧 Yesterday's emails (3):
• Sarah Chen: "Re: DBS Meeting follow-up" — "Happy to discuss Q3 timeline..."
• LinkedIn: "James Tan viewed your profile"
• DBS Bank: "Your statement is ready"

📅 Today's calendar:
• 10:00 — DBS Meeting prep (30 min)
• 14:00 — Project review with team (1 hr)
• 18:00 — Flight to Singapore (SIN)

📋 Pending commitments:
• Send Q3 report to James Tan — due Friday
• Follow up with Sarah on trade finance — pending

Anything you'd like me to dig into?
```

#### Commute (WhatsApp)

```
User: [photo of whiteboard] project planning board
User: can you remember this?

PocketClaw:
────────────────────────────────
📸 Photo stored: Whiteboard showing Q3 project timeline with columns
   "To Do", "In Progress", "Done". Key items:
   • API Integration — Sarah
   • Design Review — James
   • Launch Date: Oct 15

Added to memory. Want me to create a wiki entry for this project?
```

#### Work Session (Telegram)

```
User: summarize my emails from Sarah
PocketClaw:
Sarah has sent 3 emails this week:

1. Mon 09:15 — "Re: DBS Meeting follow-up"
   "Happy to discuss Q3 timeline. Free Wed 2pm if you are."

2. Tue 11:30 — "Trade finance proposal attached"
   [Attachment detected — ask me to process it?]

3. Thu 16:45 — "Q3 Budget update"
   "Heads up: budget freeze may affect project X..."

Want me to remember any of these for future reference?
```

#### Evening Review

```
User: what did I do today?
PocketClaw:
────────────────────────────────
📅 Today:
• DBS Meeting prep — discussed trade finance options
• Sent email to James Tan about Q3 report
• Received photo of Q3 planning whiteboard
• Committed to sending report by Friday

🧠 New memories stored:
• Sarah Chen: "Q3 budget freeze may affect project X"
• Whiteboard photo: project timeline, API Integration assigned to Sarah

Anything to add or correct?
```

### 8.3 Command Reference

#### Core Commands

| Command | Platform | Description |
|---------|----------|-------------|
| `/start` | Telegram | Initialize conversation, show welcome |
| `/help` | Both | List all available commands |
| `/status` | Both | Show memory stats, last ingestion time |
| `/memory <fact>` | Both | Manually remember a fact |
| `/recall <query>` | Both | Search memory |
| `/wiki <topic>` | Both | Generate wiki entry for topic |
| `/digest` | Both | Trigger morning digest manually |
| `/ingest` | Both | Trigger cloud + file ingestion |
| `/audit [date]` | Both | View audit log (default: today) |

#### Photo Commands

| Command | Platform | Description |
|---------|----------|-------------|
| [send photo] | Both | Process photo, generate description, store in memory |
| `/photo <description>` | Both | Manually store photo description |

#### Auth Commands

| Command | Platform | Description |
|---------|----------|-------------|
| `/auth google` | Telegram | Start Google OAuth flow |
| `/auth microsoft` | Telegram | Start Microsoft OAuth flow |
| `/auth apple` | Telegram | Configure Apple iCloud credentials |
| `/auth status` | Both | Show connected cloud sources |

### 8.4 Error States

#### Error State Matrix

| Scenario | User Experience | Recovery Action |
|----------|-----------------|-----------------|
| **Anthropic API timeout** | "Taking longer than usual — retrying... (1/3)" | Auto-retry 3x, then: "Sorry, Anthropic is unreachable. Try again in a few minutes." |
| **Anthropic API error** | "Got an error from Anthropic: [code]. Try again?" | User-initiated retry |
| **Mnemon DB locked** | "Memory temporarily busy — retrying..." | Auto-retry 5x with 1s delay |
| **Mnemon DB corruption** | "Memory appears corrupted. Initiating backup restore..." | Auto-restore from latest backup |
| **Cloud auth expired** | Telegram DM: "Google auth expired. Run /auth google to reconnect." | User runs `/auth google` |
| **Cloud ingestion partial failure** | "Ingestion complete with issues: Apple Calendar failed (rate limit). Others succeeded." | Auto-retry Apple in 1 hour |
| **WhatsApp session lost** | Telegram DM: "WhatsApp session expired. Re-auth required." | User runs `/reauth whatsapp` |
| **Photo too large** | "Photo exceeds 10MB limit. Please send a smaller image." | User sends smaller photo |
| **Photo format unsupported** | "Unsupported image format. Please send JPEG, PNG, or WebP." | User sends supported format |
| **File ingestion failure** | "Couldn't process report.docx: [error]. Skipping this file." | Logged to audit, user notified via digest |
| **Wiki generation failure** | "Couldn't generate wiki for [entity]. Try /wiki [entity] later." | User retries manually |
| **Disk space low** | "Storage running low ([X]% used). Consider cleaning vault or logs." | User takes action |
| **Container OOM** | Container restarts automatically | User receives no notification unless persistent |
| **Network disconnected** | "Network unavailable. Messages will queue for up to 1 hour." | Auto-resume when connected |

#### Error Message Templates

```python
ERROR_MESSAGES = {
    "api_timeout": "Taking longer than usual — retrying... ({attempt}/3)",
    "api_error": "Got an error from Anthropic: {code}. Try again?",
    "db_locked": "Memory temporarily busy — retrying...",
    "db_corrupted": "Memory appears corrupted. Initiating restore...",
    "auth_expired": "{provider} auth expired. Run /auth {provider} to reconnect.",
    "ingestion_partial": "Ingestion complete with issues: {failures}. Others succeeded.",
    "wa_session_lost": "WhatsApp session expired. Re-auth required via /reauth whatsapp.",
    "photo_too_large": "Photo exceeds 10MB limit. Please send a smaller image.",
    "photo_unsupported": "Unsupported format. Please send JPEG, PNG, or WebP.",
    "file_ingest_failed": "Couldn't process {filename}: {error}. Skipping.",
    "wiki_failed": "Couldn't generate wiki for {entity}. Try /wiki {entity} later.",
    "disk_low": "Storage at {percent}% used. Consider cleaning vault or logs.",
    "network_offline": "Network unavailable. Messages will queue for up to 1 hour.",
}
```

### 8.5 Sticker Handling

Stickers are **silently ignored**. No processing, no response, no memory entry.

```python
async def handle_sticker(update, context):
    # Sticker received — do nothing
    # Log to audit for debugging (optional)
    logger.debug(f"Sticker ignored from {update.effective_chat.id}")
    return  # Early return — no response
```

**Rationale:** Stickers are expressive but non-informational. Responding to stickers would create noise without value. Users who want PocketClaw to remember sticker-context should send a text message explaining the sticker.

### 8.6 Interaction Boundaries

```
┌──────────────────────────────────────────────────────────────────────┐
│                         WHAT POCKETCLAW DOES                          │
├──────────────────────────────────────────────────────────────────────┤
│ ✅ Responds to text messages                                          │
│ ✅ Processes photo attachments                                         │
│ ✅ Extracts facts from conversations                                  │
│ ✅ Generates summaries and digests                                   │
│ ✅ Creates wiki entries                                               │
│ ✅ Syncs with cloud services                                          │
│ ✅ Auto-discovers files in watch folders                             │
│ ✅ Logs all actions to audit trail                                   │
│ ✅ Acknowledges emotional content                                    │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                         WHAT POCKETCLAW IGNORES                        │
├──────────────────────────────────────────────────────────────────────┤
│ ❌ Sticker messages (no response, no processing)                      │
│ ❌ Video attachments (ignored with error message if user asks)       │
│ ❌ Voice notes / audio messages (text-only interface)                │
│ ❌ Messages from non-allowlisted chat IDs                            │
│ ❌ Requests to modify system files                                   │
│ ❌ Requests to reveal infrastructure details                          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 9. Security Architecture

### 9.1 Threat Model

| Threat | Vector | Mitigation |
|--------|--------|------------|
| Remote attacker | Open ports | Long polling only — zero inbound ports |
| Malicious ingested file | Prompt injection / code exec | /watch mounted read-only; Claude Code tool allowlist |
| Stolen device | Data at rest | Full-disk encryption (BitLocker / FileVault / LUKS) + Mnemon DB on encrypted volume |
| WhatsApp session theft | Named volume exfil | Volume excluded from backups; `docker volume` access requires root |
| Telegram impersonation | Unknown sender | Chat ID allowlist — silent reject |
| API key exposure | Credential theft | `.env` never committed; OS keychain as source of truth |
| Agent overreach | Unapproved tool use | `--access` requires per-session approval; audit log |
| Prompt injection via cloud email | Agent hijacking | Ingestion pipeline strips HTML; extracted facts reviewed before mnemon.remember |
| Photo privacy leak | Photo exfiltration | Photos deleted immediately after processing; only description stored |
| Sticker spam | Noise / DoS | Stickers silently ignored — no processing overhead |

### 9.2 NanoClaw Container Hardening Checklist

```
[ ] Non-root user (uid 1000) — enforced in Dockerfile
[ ] cap_drop: ALL
[ ] cap_add: NET_BIND_SERVICE only
[ ] no-new-privileges: true
[ ] read_only root filesystem
[ ] tmpfs /tmp with noexec flag
[ ] Mount allowlist enforced (config/mount-allowlist.json)
[ ] /watch mounted read-only (ro)
[ ] wa-session named volume — excluded from backups
[ ] photo-cache volume — cleared on restart
[ ] Memory hard limit set (CONTAINER_MEMORY_LIMIT in .env)
[ ] Docker socket NOT mounted inside container
[ ] No --privileged flag anywhere in compose file
[ ] .env in .gitignore and .dockerignore
[ ] Container image pinned to digest — no :latest tags
[ ] Audit log writing to /tmp/audit.log confirmed on startup
```

### 9.3 Secrets Management

```env
# .env — NEVER COMMIT. Add to .gitignore immediately.

# Core
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MAX_SUBSCRIPTION=true

# Interfaces
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_CHAT_ID=...

# Google OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# Microsoft Graph
MS_CLIENT_ID=...

# Apple
APPLE_ID_EMAIL=...
APPLE_APP_PASSWORD=...         # App-specific password, not main Apple ID password

# System
VAULT_PATH=~/.pocketclaw/vault
MNEMON_DB_PATH=~/.pocketclaw/mnemon.db
WATCH_PATHS_ROOT=~/.pocketclaw/watch
OLLAMA_EMBED_MODEL=nomic-embed-text
VISION_MODEL=llava
GPU_ENABLED=false
BATCH_WINDOW_MS=5000
CONTAINER_MEMORY_LIMIT=2g
```

### 9.4 Audit Log Format

Every agent action logged to `/tmp/audit.log`:

```
2026-05-20T14:32:01Z | RECV     | telegram   | chat_id=123456 | "DBS meeting summary"
2026-05-20T14:32:01Z | BATCH    | 2 messages | window=4.2s
2026-05-20T14:32:02Z | TOOL     | mnemon recall | query="DBS meeting"
2026-05-20T14:32:03Z | PHOTO    | received   | size=1.2MB | format=jpeg
2026-05-20T14:32:04Z | PHOTO    | processed  | description_length=256
2026-05-20T14:32:04Z | TOOL     | mnemon remember --photo | "Whiteboard: Q3 planning..."
2026-05-20T14:32:04Z | TOOL     | mnemon remember | "Meeting with Sarah on 2026-05-15"
2026-05-20T14:32:05Z | WRITE    | /vault/wiki/Sarah_Chen.md | 847 bytes
2026-05-20T14:32:05Z | SEND     | telegram   | chat_id=123456 | 312 chars
2026-05-20T14:32:06Z | IGNORE   | telegram   | sticker | chat_id=123456
```

For persistent audit logs across restarts, mount a log volume:

```yaml
volumes:
  - ${LOG_PATH:-~/.pocketclaw/logs}:/logs:rw
```

---

## 10. Data Flow

### 10.1 Conversational Query (Batched Cross-Platform)

```
User sends message on Telegram:   "Summarise DBS meeting"
User sends message on WhatsApp:   "and also add Sarah as a contact"
(both within 5-second window)
         │
         ▼
MessageDebouncer flushes both into one batch prompt
         │
         ▼
NanoClaw routes to Claude Code
         │
         ▼
Claude Code: session start → mnemon recall "DBS meeting, Sarah" (load context)
         │
         ▼
Claude Code: assembled prompt → Anthropic API (only this leaves the machine)
         │
         ▼
Claude Code: response received → mnemon remember new facts → write to vault if needed
         │
         ▼
Response returned via originating platform (Telegram reply + WhatsApp reply)
```

### 10.2 Photo Processing Flow

```
User sends photo on Telegram with caption: "project whiteboard"
         │
         ▼
Telegram handler downloads photo to /home/user/.photo-cache/
         │
         ▼
Validate: format (JPEG/PNG/WebP), size (<10MB)
         │
         ▼ (fail → error response, cleanup)
Resize: max 2048px longest edge
         │
         ▼
Ollama Vision (llava): "Describe this image"
         │
         ▼
Claude Code: enhance with conversation context
         │
         ▼
mnemon remember --photo "<enhanced_description>" --source telegram
         │
         ▼
Delete photo from /home/user/.photo-cache/
         │
         ▼
Respond: "Photo stored: Whiteboard showing Q3 project timeline..."
```

### 10.3 File Ingestion (Auto-Discovery)

```
New file appears at ~/.pocketclaw/watch/documents/report.docx
         │
         ▼
Watchdog detects CREATE/MODIFY event
         │
         ▼
SHA256 fingerprint checked against processed.db → not seen before
         │
         ▼
python-docx extracts text → chunked (512 tokens, 64 overlap)
         │
         ▼
Claude Code: entity extraction per chunk → JSON facts
         │
         ▼
mnemon remember (each fact) → SQLite graph updated
         │
         ▼
SHA256 stored in processed.db (idempotency)
         │
         ▼
If >10 new entities: wiki generation triggered
```

### 10.4 Cloud Ingestion (Scheduled)

```
00 cron fires
         │
         ▼
GoogleMailIngester.fetch() → Gmail API (OAuth2) → last 24h emails
MicrosoftCalendarIngester.fetch() → Graph API → today's calendar
AppleContactsIngester.fetch() → CardDAV → updated contacts
         │
         ▼ (parallel, fault-isolated)
Each ingester: extract facts → mnemon remember
         │
         ▼
00 cron fires → wiki generation runs on all updated entities
```

### 10.5 Wiki Generation

```
Trigger (manual /wiki, scheduled, or post-ingestion)
         │
         ▼
mnemon list --type entity → all known entities
         │
         ▼ (per entity, parallelised)
mnemon recall --query "{entity}" --depth 3 → graph context
         │
         ▼
Claude Code: wiki generation prompt → Markdown
         │
         ▼
Write to /vault/wiki/{entity}.md (overwrite)
         │
         ▼
Syncthing detects change → syncs to all devices (peer-to-peer, encrypted)
```

---

## 11. Testing Strategy

### 11.1 Unit Tests

#### MessageDebouncer

```python
import pytest
from queue.debouncer import MessageDebouncer, QueuedMessage, MessageType
from datetime import datetime

@pytest.fixture
def debouncer():
    collected = []
    async def on_batch(msgs):
        collected.append(msgs)
    return MessageDebouncer(on_batch), collected

@pytest.mark.asyncio
async def test_three_messages_within_5s_batched_together(debouncer):
    d, collected = debouncer
    await d.push("session1", QueuedMessage(
        platform="telegram", timestamp=datetime.now(),
        message_id="1", text="msg1", message_type=MessageType.TEXT
    ))
    await d.push("session1", QueuedMessage(
        platform="telegram", timestamp=datetime.now(),
        message_id="2", text="msg2", message_type=MessageType.TEXT
    ))
    await d.push("session1", QueuedMessage(
        platform="telegram", timestamp=datetime.now(),
        message_id="3", text="msg3", message_type=MessageType.TEXT
    ))
    await asyncio.sleep(6)  # Wait for batch window
    assert len(collected) == 1
    assert len(collected[0]) == 3

@pytest.mark.asyncio
async def test_messages_6s_apart_batched_separately(debouncer):
    d, collected = debouncer
    await d.push("session1", QueuedMessage(
        platform="telegram", timestamp=datetime.now(),
        message_id="1", text="msg1", message_type=MessageType.TEXT
    ))
    await asyncio.sleep(6)
    await d.push("session1", QueuedMessage(
        platform="telegram", timestamp=datetime.now(),
        message_id="2", text="msg2", message_type=MessageType.TEXT
    ))
    await asyncio.sleep(6)
    assert len(collected) == 2
    assert len(collected[0]) == 1
    assert len(collected[1]) == 1

@pytest.mark.asyncio
async def test_stickers_silently_ignored(debouncer):
    d, collected = debouncer
    await d.push("session1", QueuedMessage(
        platform="telegram", timestamp=datetime.now(),
        message_id="1", text="", message_type=MessageType.STICKER
    ))
    await asyncio.sleep(6)
    assert len(collected) == 0  # No batch fired

@pytest.mark.asyncio
async def test_cross_platform_same_session(debouncer):
    d, collected = debouncer
    await d.push("user123", QueuedMessage(
        platform="telegram", timestamp=datetime.now(),
        message_id="1", text="from telegram", message_type=MessageType.TEXT
    ))
    await d.push("user123", QueuedMessage(
        platform="whatsapp", timestamp=datetime.now(),
        message_id="2", text="from whatsapp", message_type=MessageType.TEXT
    ))
    await asyncio.sleep(6)
    assert len(collected) == 1
    assert len(collected[0]) == 2  # Both in same batch
```

#### Photo Processor

```python
import pytest
from photo.processor import PhotoProcessor, validate_photo

def test_valid_photo_formats():
    assert validate_photo("photo.jpg") == True
    assert validate_photo("photo.jpeg") == True
    assert validate_photo("photo.png") == True
    assert validate_photo("photo.webp") == True

def test_invalid_photo_formats():
    assert validate_photo("video.mp4") == False
    assert validate_photo("document.pdf") == False
    assert validate_photo("animation.gif") == False

def test_photo_size_limit():
    # 10MB limit
    assert validate_photo("small.jpg", size_mb=5) == True
    assert validate_photo("large.jpg", size_mb=15) == False
```

#### Chat ID Allowlist

```python
import pytest
from telegram.guard import ChatGuard

def test_known_chat_id_allowed():
    guard = ChatGuard(allowed_ids={123456})
    update = Mock(effective_chat=Mock(id=123456))
    assert guard.is_allowed(update) == True

def test_unknown_chat_id_rejected():
    guard = ChatGuard(allowed_ids={123456})
    update = Mock(effective_chat=Mock(id=999999))
    assert guard.is_allowed(update) == False
```

#### Mnemon Idempotency

```python
import pytest
from ingestion.pipeline import IngestionPipeline

@pytest.mark.asyncio
async def test_same_file_produces_no_duplicates():
    pipeline = IngestionPipeline()
    await pipeline.process("test.docx")
    count_before = await mnemon.count_entities()

    # Re-process same file
    await pipeline.process("test.docx")
    count_after = await mnemon.count_entities()

    assert count_before == count_after  # No new entities

@pytest.mark.asyncio
async def test_modified_file_reprocessed():
    pipeline = IngestionPipeline()
    await pipeline.process("test_v1.docx")
    count_before = await mnemon.count_entities()

    # Modify file (different SHA256)
    await pipeline.process("test_v2.docx")
    count_after = await mnemon.count_entities()

    assert count_after > count_before  # New entities added
```

### 11.2 Integration Tests

#### Telegram → Debouncer → Claude → Mnemon → Telegram (E2E)

```python
@pytest.mark.integration
async def test_telegram_message_lifecycle():
    # 1. Send message via Telegram test client
    response = await telegram_client.send("Summarise my emails from Sarah")

    # 2. Verify response received
    assert response is not None
    assert len(response.text) > 0

    # 3. Verify memory updated
    recall = await mnemon.recall("Sarah emails")
    assert len(recall.results) > 0

    # 4. Verify audit log entry
    log = await audit.get_recent(limit=10)
    assert any("RECV" in entry and "telegram" in entry for entry in log)
    assert any("TOOL" in entry and "mnemon recall" in entry for entry in log)
```

#### Photo → Vision → Mnemon (E2E)

```python
@pytest.mark.integration
async def test_photo_processing_lifecycle():
    # 1. Send photo with caption
    photo_bytes = load_test_photo("whiteboard.jpg")
    response = await telegram_client.send_photo(
        photo=photo_bytes,
        caption="project planning"
    )

    # 2. Verify response mentions photo
    assert "photo stored" in response.text.lower()

    # 3. Verify memory has photo description
    recall = await mnemon.recall("whiteboard project planning")
    assert len(recall.results) > 0
    assert "whiteboard" in recall.results[0].description.lower()

    # 4. Verify photo deleted from cache
    cache_files = list(Path("/tmp/photo-cache").glob("*"))
    assert len(cache_files) == 0  # Cache cleared
```

#### WhatsApp → Debouncer → Cross-Platform Batch (E2E)

```python
@pytest.mark.integration
async def test_cross_platform_batching():
    # 1. Send message on Telegram
    await telegram_client.send("DBS meeting at 2pm")

    # 2. Send message on WhatsApp within 5 seconds
    await whatsapp_client.send("add Sarah to the meeting")

    # 3. Wait for batch window
    await asyncio.sleep(6)

    # 4. Verify both responses received
    tg_response = await telegram_client.get_last_response()
    wa_response = await whatsapp_client.get_last_response()

    # 5. Verify responses are contextually linked
    assert tg_response is not None
    assert wa_response is not None
    assert "Sarah" in tg_response.text  # Telegram knows about Sarah from WhatsApp
```

### 11.3 Performance Tests

#### Batch Processing Latency

```python
@pytest.mark.performance
async def test_batch_processing_under_500ms():
    # Send 10 messages rapidly
    start = time.time()
    for i in range(10):
        await debouncer.push("session1", QueuedMessage(...))
    await asyncio.sleep(6)  # Wait for batch

    batch_duration = time.time() - start
    assert batch_duration < 0.5  # Batch assembled in <500ms
```

#### Photo Processing Performance

```python
@pytest.mark.performance
async def test_photo_processing_under_30s():
    photo_bytes = load_test_photo("5mb.jpg")
    start = time.time()

    result = await photo_processor.process(
        photo_bytes,
        user_message="what's in this photo?"
    )

    duration = time.time() - start
    assert duration < 30  # Complete in <30s
```

#### Wiki Generation Performance

```python
@pytest.mark.performance
async def test_wiki_per_entity_under_30s():
    entities = await mnemon.list_entities(limit=100)

    for entity in entities[:10]:  # Test first 10
        start = time.time()
        await wiki_generator.generate(entity.name)
        duration = time.time() - start
        assert duration < 30
```

#### Concurrent Load Test

```python
@pytest.mark.performance
async def test_50_concurrent_messages():
    # Simulate 50 messages arriving simultaneously
    tasks = [
        debouncer.push(f"session_{i}", QueuedMessage(...))
        for i in range(50)
    ]

    start = time.time()
    await asyncio.gather(*tasks)
    await asyncio.sleep(6)  # Wait for batch

    duration = time.time() - start
    assert duration < 10  # All processed in <10s
```

### 11.4 Security Tests

#### Container Hardening

```python
@pytest.mark.security
def test_container_non_root():
    result = docker.exec("pocketclaw", "whoami")
    assert result.stdout.strip() == "user"

@pytest.mark.security
def test_container_readonly_filesystem():
    result = docker.exec("pocketclaw", "touch /test_file")
    assert result.exit_code != 0  # Should fail

@pytest.mark.security
def test_container_no_new_privileges():
    result = docker.inspect("pocketclaw")
    assert result["HostConfig"]["Privileged"] == False

@pytest.mark.security
def test_env_not_in_container():
    # Verify .env is not baked into image
    result = docker.exec("pocketclaw", "env")
    assert "ANTHROPIC_API_KEY" not in result.stdout
```

#### Audit Log Completeness

```python
@pytest.mark.security
def test_all_tool_calls_logged():
    # Make several tool calls
    mnemon.remember("test fact 1")
    mnemon.recall("test")
    vault.write("test.md", "content")

    # Verify all logged
    log = open("/tmp/audit.log").read()
    assert log.count("TOOL") >= 3
    assert "mnemon remember" in log
    assert "mnemon recall" in log
    assert "WRITE" in log
```

#### Secrets Exclusion

```python
@pytest.mark.security
def test_env_excluded_from_git():
    result = git.status()
    assert ".env" not in result

@pytest.mark.security
def test_credentials_not_in_logs():
    # Trigger an error that might be logged
    trigger_error()

    log = open("/tmp/audit.log").read()
    assert "sk-ant-" not in log
    assert "BOT_TOKEN" not in log
```

---

## 12. Cross-Platform Environment & Prerequisites

### 12.1 Required Software

| Software | macOS | Linux | Windows |
|----------|-------|-------|---------|
| Docker Desktop | brew install --cask docker | docs.docker.com/engine/install | docker.com/desktop |
| Node.js 20 LTS | brew install node | apt install nodejs | nodejs.org |
| Claude Code CLI | npm install -g @anthropic-ai/claude-code | same | same |
| Go 1.24+ | brew install go | apt install golang | go.dev/dl |
| Ollama | brew install ollama | curl -fsSL https://ollama.com/install.sh \| sh | ollama.com |
| Git | brew install git | apt install git | git-scm.com |
| Python 3.12 | brew install python | apt install python3.12 | python.org |
| Obsidian | obsidian.md | obsidian.md | obsidian.md |
| Syncthing | brew install syncthing | apt install syncthing | syncthing.net |

### 12.2 Platform-Specific Notes

**Linux — Docker GPU passthrough (NVIDIA):**

```bash
# Install NVIDIA Container Toolkit
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/libnvidia-container/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo systemctl restart docker
```

**macOS — Docker Desktop memory:**

```
Docker Desktop → Settings → Resources → Memory: 6GB minimum
```

**Windows — WSL2 memory cap:**

```ini
# %USERPROFILE%\.wslconfig
[wsl2]
memory=6GB
processors=4
```

**Windows — Docker Desktop WSL2 Backend:**

```
Settings → General → Use WSL 2 based engine: ON
Settings → Resources → WSL Integration → Ubuntu: ON
```

### 12.3 Path Conventions

All paths use environment variables — never hardcoded OS-specific strings:

```bash
# Set in shell profile (.zshrc / .bashrc) or Windows .env
export POCKETCLAW_HOME="$HOME/.pocketclaw"
export VAULT_PATH="$POCKETCLAW_HOME/vault"
export MNEMON_DB_PATH="$POCKETCLAW_HOME/mnemon.db"
export WATCH_PATHS_ROOT="$POCKETCLAW_HOME/watch"
export LOG_PATH="$POCKETCLAW_HOME/logs"
export PHOTO_CACHE="$POCKETCLAW_HOME/photo-cache"
```

---

## 13. Implementation Phases

### Phase 0 — Repo Onboarding & Prerequisites (Day 1)

```
[ ] Clone NanoClaw repo
[ ] Read ALL existing docs (see Agent Onboarding section above)
[ ] Install all required software per Section 12.1
[ ] Configure Docker memory limits per platform
[ ] Authenticate Claude Code: `claude` → login with Claude Max account
[ ] Install Ollama → pull OLLAMA_EMBED_MODEL
[ ] Install Ollama → pull VISION_MODEL (llava)
[ ] Install Syncthing → create vault folder share
[ ] Create ~/.pocketclaw/ directory structure
[ ] Create .env from template — confirm .gitignore includes .env
```

### Phase 1 — NanoClaw Core + Security (Day 1–2)

```
[ ] Apply docker-compose.yml changes from Section 7.1
[ ] Build and start container: docker compose up -d
[ ] Verify non-root user: docker exec pocketclaw whoami → should return "user"
[ ] Verify read-only filesystem: docker exec pocketclaw touch /test → should fail
[ ] Apply CLAUDE.md directives from Section 7.2
[ ] Confirm audit log writing on startup
[ ] Run security hardening checklist (Section 9.2) — all boxes checked before proceeding
```

### Phase 2 — Mnemon + Embeddings (Day 2)

```
[ ] Install Mnemon: go install github.com/mnemon-dev/mnemon@latest
[ ] Setup: mnemon setup --target nanoclaw --yes
[ ] Configure Ollama embeddings endpoint
[ ] Test round-trip: mnemon remember "test fact" → mnemon recall --query "test"
[ ] Verify SQLite DB at MNEMON_DB_PATH
[ ] Verify hybrid search (graph + vector) returns ranked results
```

### Phase 3 — Unified Message Queue (Day 2–3)

```
[ ] Implement MessageDebouncer (Section 7.5)
[ ] Unit test: 3 messages within 5s → batched; 2 messages 6s apart → two separate calls
[ ] Verify sticker handling: stickers → silently ignored
[ ] Verify cross-platform session ID merging (same user, different platform → same queue)
[ ] Wire to Claude Code agent
```

### Phase 4 — Telegram Interface (Day 3)

```
[ ] Create bot via @BotFather → save TELEGRAM_BOT_TOKEN to .env
[ ] Install via existing NanoClaw skill mechanism: /add-telegram
[ ] Get your chat ID (send /start to @userinfobot)
[ ] Add to .env: TELEGRAM_ALLOWED_CHAT_ID=<your_chat_id>
[ ] Verify long polling works (no webhook, no open port)
[ ] Test Telegram → MessageDebouncer → Claude Code → Telegram reply
[ ] Verify unknown senders rejected silently
[ ] Implement all commands: /memory, /recall, /wiki, /ingest, /status, /digest, /audit, /help
```

### Phase 5 — Photo Processing (Day 3–4)

```
[ ] Implement PhotoProcessor (Section 7.8)
[ ] Configure photo-cache volume mount
[ ] Test Ollama Vision (llava) integration
[ ] Test photo download → resize → describe → store pipeline
[ ] Verify photos deleted from cache after processing
[ ] Test error handling: oversized, unsupported format
[ ] Verify photo descriptions searchable via /recall
```

### Phase 6 — WhatsApp Interface (Day 4)

```
[ ] Install via existing NanoClaw skill mechanism: /add-whatsapp
[ ] First run: scan QR code shown in container logs
[ ] Verify named volume wa-session persists across docker restart
[ ] Test WhatsApp → MessageDebouncer → Claude Code → WhatsApp reply
[ ] Verify stickers silently ignored on WhatsApp
[ ] Test cross-platform batch: Telegram message + WhatsApp message within 5s → one batch
[ ] Verify unknown senders rejected silently on WhatsApp
```

### Phase 7 — Cloud Ingestion (Day 4–5)

```
[ ] Google: create project → enable APIs → OAuth consent → download credentials.json
[ ] Test GoogleMailIngester: fetch last 24h → extract facts → mnemon remember
[ ] Test GoogleCalendarIngester and GoogleContactsIngester
[ ] Microsoft: Azure app registration → device code flow auth
[ ] Test all three Microsoft ingesters
[ ] Apple: generate app-specific password → test IMAP, CalDAV, CardDAV
[ ] Implement cloud_scheduler.py with fault isolation
[ ] Configure daily cron at 02:00
[ ] Test /ingest command triggers full cloud + file run
```

### Phase 8 — File Auto-Discovery (Day 5)

```
[ ] Configure WATCH_PATHS in .env → map to /watch in container
[ ] Implement watchdog file watcher
[ ] Test with sample .docx, .pdf, .pptx, .ics, .vcf files in watch directory
[ ] Verify SHA256 idempotency: re-scan same file → no duplicate mnemon entries
[ ] Verify modified file (different SHA256) → re-ingested correctly
```

### Phase 9 — LLM Wiki + Obsidian (Day 6)

```
[ ] Create vault directory structure (Section 7.12)
[ ] Implement wiki/generator.py
[ ] Test: generate wiki for 3–5 entities from Phase 7/8 ingestion
[ ] Verify WikiLink syntax correct in output
[ ] Verify YAML frontmatter valid
[ ] Install Obsidian → point to VAULT_PATH → verify wiki entries appear
[ ] Install Obsidian plugins (Section 7.12)
[ ] Verify Syncthing syncing vault to second device
[ ] Configure nightly wiki generation cron at 03:00
[ ] Test /wiki <topic> command end-to-end
```

### Phase 10 — Testing & Hardening (Day 7)

> **As-built status (2026-05-22):** ⚠️ Partially done. Unit tests for debouncer, photo-processor, chat-archive, paths, file-watcher (predicate), scheduler (fault isolation), and §17 generators all pass (52 cases). NFR measurements + integration/performance/security suites deferred to v2.

```
[ ] Run full unit test suite (Section 11.1)               — DONE for PocketClaw modules (52 cases)
[ ] Run integration tests (Section 11.2)                  — partial (scheduler fault-isolation, generator round-trips)
[ ] Run performance tests (Section 11.3)                  — DEFERRED v2
[ ] Run security tests (Section 11.4)                     — DEFERRED v2
[ ] Tune NFR targets (Section 15)                         — DEFERRED v2
[ ] Final security review                                 — informal: no Docker socket, no hardcoded secrets, no privileged flag, all credentials env-driven
[ ] Documentation review                                  — DONE: README + docs/SERVICE.md + PRD §17 + §18 + audit notepad
```

---

## 14. Risks & Mitigations

### 14.1 Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-------------|--------|------------|
| **Anthropic API downtime** | Medium | High | Local Ollama fallback mode (future v2); graceful degradation with retry |
| **Claude Max subscription unavailable** | Low | High | Verify before Phase 1; budget for $100/mo commitment |
| **WhatsApp ban (unofficial API)** | Medium | Medium | Use secondary number; silent reject unknown senders; clear abuse policy |
| **Cloud OAuth token expiry** | Medium | Medium | Auto-refresh tokens; cache on disk; notify user before expiry |
| **Obsidian vault conflicts (Syncthing)** | Low | Low | Syncthing auto-resolves; vault is append-only (wiki entries overwritten, notes preserved) |
| **Ollama model drift** | Low | Medium | Pin model version in .env; validate on update |
| **Container OOM (2GB limit)** | Medium | Medium | Monitor with Prometheus; profile memory per component; graceful degradation |
| **Photo processing timeout** | Low | Low | 30s timeout; error message; photo not stored |
| **Vision model quality** | Medium | Medium | Allow user feedback; improve prompt iteratively |
| **File ingestion performance** | Medium | Low | Chunked processing; queue with backpressure; progress logging |

### 14.2 Project Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-------------|--------|------------|
| **Apple Principal ID acquisition** | Low | Medium | Well-documented process; fallback to manual config |
| **Syncthing setup complexity** | Medium | Low | Clear documentation; GUI-based setup for non-technical users |
| **Mnemon skill not ready** | Low | High | Fork and maintain if upstream unavailable; PostgreSQL fallback |
| **Dependency on NanoClaw repo** | Medium | Medium | Contribute upstream; maintain local fork if needed |
| **Multi-platform testing burden** | High | Low | Automated CI/CD on all three platforms; manual spot-check quarterly |

### 14.3 Security Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-------------|--------|------------|
| **API key theft** | Low | Critical | OS keychain; never in .env committed to git; rotation policy |
| **WhatsApp session theft** | Low | High | Volume excluded from backups; root-only docker volume access |
| **Prompt injection via email** | Medium | High | Sandboxed Claude Code; strip HTML; review before memory storage |
| **Photo privacy leak** | Low | High | Photos never stored; only description; cache cleared immediately |
| **Sticker spam DoS** | Low | Low | Silently ignored; minimal processing overhead |

### 14.4 Mitigation Priority Matrix

```
Impact
    │
High │  [API downtime]      [Token expiry]       [Prompt injection]
    │  [Key theft]         [Session theft]      [Claude Max unavailable]
    │
Med  │  [WhatsApp ban]     [Container OOM]      [Vision quality]
    │  [Mnemon skill]      [File perf]          [Model drift]
    │
Low  │  [Vault conflicts]  [Photo timeout]      [Syncthing setup]
    │  [Multi-platform]    [Apple ID]
    │
    └──────────────────────────────────────────────────────
         Low           Medium          High
                          Likelihood
```

---

## 15. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| **Response latency (conversational)** | < 5s round-trip (Telegram/WhatsApp) |
| **Response latency P95** | < 8s (including Anthropic API) |
| **Batch window accuracy** | 5000ms ± 200ms |
| **Photo processing time** | < 30s for 5MB JPEG |
| **Ingestion throughput** | ≥ 50 documents per run |
| **Cloud ingestion per source** | < 2 minutes per provider |
| **Container RAM** | ≤ 2GB (hard limit) |
| **Ollama RAM (host)** | ≤ 1GB (CPU embeddings); ≤ 2GB (CPU + vision) |
| **Mnemon recall latency** | < 500ms |
| **Wiki generation per entity** | < 30s |
| **Syncthing vault sync latency** | < 60s (peer on same LAN) |
| **Idempotency** | Re-ingesting same file produces zero duplicate mnemon entries |
| **Cross-platform parity** | Identical behaviour on Windows, macOS, Linux |
| **Data residency** | All personal data on-device; only assembled prompts sent to Anthropic |
| **Audit log completeness** | 100% of tool calls logged |
| **Photo cache cleanup** | All photos deleted within 60s of processing |
| **Sticker handling** | Zero CPU/memory overhead (immediate drop) |
| **Backup** | Daily: copy mnemon.db + vault to secondary location via Syncthing |

---

## 16. Open Items & Future Work

### Open Items (Resolve Before Phase 5)

> **As-built status (2026-05-22):**
>
> - **Claude Max:** Not used. Switched to AWS Bedrock for Claude (`CLAUDE_CODE_USE_BEDROCK=1`).
> - **Apple Principal ID:** Resolved automatically inside `apple.ts` via `.well-known/carddav` redirect.
> - **WhatsApp secondary number:** ⏸ Not procured. Using primary number per user choice.
> - **Google Cloud project:** ✅ Resolved. OAuth tokens at `${POCKETCLAW_SECRETS_DIR}/google_token.json`.
> - **Microsoft Azure app:** ❌ **Permanently parked.** Personal-account tenant blocked by AADSTS5000225 (lifecycle inactivity). Reactivation requires phoning Microsoft support; user opted out. Code stays compiled and ready in `microsoft.ts`.
> - **Slack:** ❌ **Permanently parked.** User's org policy blocks app creation. Code compiled and ready in `slack.ts`.

1. **Claude Max subscription:** Confirm active before Phase 1. Claude Code at agentic scale requires Max.
2. **Apple Principal ID:** Required for CalDAV/CardDAV URLs. Obtain by calling `https://contacts.icloud.com/.well-known/carddav` with credentials — it redirects to your principal URL.
3. **WhatsApp secondary number:** Procure before Phase 6. Circles.Life eSIM or similar.
4. **Google Cloud project:** Create before Phase 7. Enable APIs and configure OAuth.
5. **Microsoft Azure app:** Register before Phase 7. Configure Graph API permissions.

### Future Work (v2+)

| Feature | Notes |
|---------|-------|
| **Voice input** | Whisper.cpp integration for voice notes |
| **Local reasoning fallback** | Ollama + Mistral/Llama when Anthropic API unreachable |
| **Boss deployment** | Separate Docker instance, separate Mnemon DB, separate vault, separate .env |
| **Additional ingestion** | Slack, Notion, LinkedIn, Telegram message history |
| **Obsidian Publish** | Expose curated wiki entries publicly |
| **Firecracker microVMs** | Replace Docker with Firecracker for stronger isolation |
| **MCP memory gateway** | FastMCP layer over Mnemon for richer tool interface |
| **Automated encrypted backup** | Restic → B2/S3 for off-device Mnemon DB backup |
| **Multi-source deduplication** | Detect same contact/event appearing in Google + Apple + Microsoft → merge in Mnemon |
| **Video thumbnails** | Extract key frame descriptions for video attachments (future) |
| **GIF processing** | Optional: extract key frames from animated GIFs |

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **NanoClaw** | Harness that orchestrates Claude Code in Docker |
| **Mnemon** | Local SQLite-based memory graph with vector embeddings |
| **Claude Code** | Anthropic's CLI for programmatic LLM access |
| **Ollama** | Local LLM server (embeddings + vision) |
| **Syncthing** | Peer-to-peer file sync (no cloud intermediary) |
| **Baileys** | Unofficial WhatsApp Web API |
| **Watchdog** | Python library for file system event monitoring |
| **Karpathy-style wiki** | LLM-supervised structured knowledge base generation |
| **Long polling** | Telegram API pattern — outbound connection waits for inbound messages |
| **Batch window** | Time period (5s default) for collecting rapid-fire messages before processing |
| **Chat ID allowlist** | Security measure — only whitelisted Telegram IDs receive responses |
| **Vision model** | LLM capable of image understanding (e.g., llava) |

---

## Appendix B: Environment Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key (Claude Max) |
| `TELEGRAM_BOT_TOKEN` | Yes | — | Telegram bot token from @BotFather |
| `TELEGRAM_ALLOWED_CHAT_ID` | Yes | — | Your Telegram chat ID |
| `OLLAMA_HOST` | Yes | http://host.docker.internal:11434 | Ollama API endpoint |
| `OLLAMA_EMBED_MODEL` | No | nomic-embed-text | Embedding model for Mnemon |
| `VISION_MODEL` | No | llava | Vision model for photo descriptions |
| `GPU_ENABLED` | No | false | Enable GPU acceleration |
| `BATCH_WINDOW_MS` | No | 5000 | Message batch window in milliseconds |
| `CONTAINER_MEMORY_LIMIT` | No | 2g | Docker container memory limit |
| `VAULT_PATH` | Yes | ~/.pocketclaw/vault | Obsidian vault location |
| `MNEMON_DB_PATH` | Yes | ~/.pocketclaw/mnemon.db | Mnemon SQLite database |
| `WATCH_PATHS_ROOT` | Yes | ~/.pocketclaw/watch | File auto-discovery root |
| `LOG_PATH` | No | ~/.pocketclaw/logs | Persistent audit log location |
| `GOOGLE_CLIENT_ID` | For Google | — | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | For Google | — | Google OAuth client secret |
| `MS_CLIENT_ID` | For Microsoft | — | Microsoft Graph client ID |
| `APPLE_ID_EMAIL` | For Apple | — | Apple iCloud email |
| `APPLE_APP_PASSWORD` | For Apple | — | Apple app-specific password |

---

## Appendix C: File Structure

```
~/.pocketclaw/
├── vault/                      # Obsidian knowledge base (synced via Syncthing)
│   ├── wiki/
│   │   └── *.md
│   ├── meetings/
│   ├── contacts/
│   ├── photos/
│   └── notes/
├── watch/                       # File auto-discovery folder (read-only in container)
│   ├── documents/
│   ├── downloads/
│   └── notes/
├── mnemon.db                    # Mnemon SQLite database (shared volume)
├── processed.db                 # File ingestion idempotency tracker
├── secrets/                     # OAuth credentials (never committed)
│   ├── google_credentials.json
│   ├── google_token.json
│   └── (others as needed)
├── logs/                        # Persistent audit logs
│   └── audit.log
└── .env                         # Environment variables (never committed)
```

---

*Document Version: 3.0*  
*Last Updated: 2026-05-20*  
*Author: MiniMax Agent*

---

## 17. Extended Features (v1.1) — Added Post-Initial Build

### 17.1 GitHub Integration (Read-Only, All Repos)

**Scope:** Read-only PAT with access to all user repos.
**Features:**
- PR summaries (open, merged, stale)
- Commit digests (daily/weekly activity across repos)
- Issue tracking (open issues, assigned to me, stale)
- Slash command: `/github-report [daily|weekly]`
- Auto-ingest: daily pull of PR/issue/commit activity → mnemon

**Auth:** GitHub Personal Access Token (PAT) with `repo:read`, `read:org` scopes.
**Storage:** `.env` → `GITHUB_PAT=ghp_...`

**Implementation:**
- `src/modules/ingestion/github.ts` — GitHub REST API client
- Ingests: PRs, issues, commits, reviews assigned to user
- Stores as mnemon facts with source attribution
- Daily cron at 02:00 (alongside cloud ingestion)

---

### 17.2 Slack Integration (User Token, Multi-Workspace)

**Scope:** Connect as the user (NOT a bot), user chooses workspace.
**Constraint:** Cannot use bot token — must use Slack user OAuth token (xoxp-).

**How user tokens work:**
- Create a Slack app in YOUR workspace → OAuth & Permissions → User Token Scopes
- Required scopes: `channels:history`, `channels:read`, `groups:read`, `groups:history`, `im:history`, `im:read`, `users:read`, `search:read`
- OAuth flow: user approves → receives `xoxp-` token → stored in `.env`
- NOTE: company workspaces may block custom apps; user must have permission to install apps

**Features:**
- Read channel messages (ingest key channels → mnemon)
- Search Slack history via `/recall` (facts from Slack messages)
- Reply via PocketClaw (Telegram command → Slack message)
- Slash command: `/slack-search <query>`

**Storage:** `.env` → `SLACK_USER_TOKEN=xoxp-...`, `SLACK_WORKSPACE=<workspace-name>`

**Implementation:**
- `src/modules/ingestion/slack.ts` — Slack Web API client with user token
- Ingests: messages from configured channels → mnemon facts
- Does NOT use NanoClaw's `/add-slack` skill (that's bot-token based)
- Custom adapter for user-token read/write

---

### 17.3 Meeting Minutes Generator

**Source:** Auto-generated from calendar events + email threads.
**Output:** .docx or .txt file saved to Obsidian vault.

**Flow:**
1. Calendar event detected (from Google/Outlook/iCloud ingestion)
2. PocketClaw pulls email threads related to the meeting (subject match + attendees)
3. Generates structured meeting minutes from context:
   - Attendees, date, duration
   - Agenda (from calendar description)
   - Key discussion points (from emails)
   - Action items extracted
   - Decisions made
4. Saves to `vault/meetings/YYYY-MM-DD_<meeting-title>.docx`

**Slash command:** `/minutes [meeting-name]` — generates from most recent matching calendar event
**Auto-trigger:** After each calendar event ends (if email threads exist)

**Implementation:**
- `src/modules/meeting-minutes.ts` — minutes generator
- Uses `docx` npm package for .docx output
- Pulls from mnemon: calendar facts + email facts for same attendees/timeframe
- Template: attendees → agenda → discussion → actions → decisions

---

### 17.4 Research Report Generator (Local Files Only)

**Source:** User's local files and ingested emails. NO web search (privacy-first).
**Output:** PDF report saved to vault.

**Flow:**
1. User: `/research <topic>` or `/research <topic> --location /path/to/folder`
2. PocketClaw searches:
   - Mnemon graph for all facts related to `<topic>`
   - File watcher index for documents matching topic
   - Email threads mentioning the topic
3. Generates structured research report:
   - Executive summary
   - Key findings (with source citations)
   - Timeline of events
   - Related entities (people, orgs, projects)
   - Appendix: source list
4. Renders to PDF via `pdfkit` or `puppeteer` (HTML → PDF)
5. Saves to `vault/research/YYYY-MM-DD_<topic>.pdf`

**Implementation:**
- `src/modules/research-report.ts` — report generator
- `pdfkit` for PDF output (or puppeteer for richer layout)
- Pulls exclusively from local mnemon + file index
- No external API calls (fully local after Haiku reasoning)

---

### 17.5 Presentation Slide Generator (PPTX)

**Output:** Actual PowerPoint .pptx files.
**Library:** `pptxgenjs` (JavaScript) or `python-pptx` (Python via child process)

**Flow:**
1. User: `/slides <topic> [--slides N] [--style minimal|corporate|creative]`
2. PocketClaw:
   - Recalls all context about `<topic>` from mnemon
   - Generates slide outline (title, bullets, speaker notes per slide)
   - Renders to .pptx with chosen style
3. Saves to `vault/presentations/YYYY-MM-DD_<topic>.pptx`
4. Optionally sends file via Telegram

**Slide structure per deck:**
- Title slide (topic + date + author)
- Agenda/overview slide
- Content slides (3-10 depending on `--slides N`)
- Summary/key takeaways
- Q&A / next steps

**Implementation:**
- `src/modules/slide-generator.ts` — pptx generator
- Uses `pptxgenjs@4` npm package (pure JS, no Python needed)
- Templates: minimal (white, clean), corporate (blue headers), creative (gradients)
- Speaker notes generated by Haiku alongside slide content

---

### 17.6 Speech Draft Generator

**Output:** Markdown or .docx speech draft.

**Flow:**
1. User: `/speech <topic> [--duration 5m|10m|15m] [--tone formal|casual|persuasive]`
2. PocketClaw:
   - Recalls context about `<topic>` from mnemon
   - Generates speech with appropriate length (~150 words/minute)
   - Includes: opening hook, key points, transitions, closing
3. Saves to `vault/speeches/YYYY-MM-DD_<topic>.md`

**Implementation:**
- Handled by agent skill (no separate module needed)
- Speech skill at `groups/pocketclaw/skills/speech/SKILL.md`
- Word count calibrated to requested duration
- Tone adjustment via prompt engineering

---

### 17.7 Chat Archive (Telegram + WhatsApp passive ingestion)

**Status:** Implemented in `src/modules/chat-archive.ts`. **Opt-in only** via `INGEST_CHAT_MODE`.

**Why this exists:** PocketClaw's primary identity is your assistant, not a chat-history scraper. By default the agent only sees messages addressed to it (per §7.7 self-chat model). Some users want their full chat history searchable through mnemon — this module enables that, with explicit consent.

**Modes (env var `INGEST_CHAT_MODE`):**

| Mode | What gets archived | Privacy posture |
|------|---------------------|------------------|
| `off` (default) | Nothing — chat-archive is a no-op | Most private; only direct commands flow |
| `self` | Only messages YOU send (any chat) | Privacy-respecting journal/note-stream |
| `dms` | Self messages + 1-on-1 DMs from anyone | Group chats stay private to participants |
| `all` | Every message in every chat the user is part of | **Privacy bombshell.** Stores other people's messages on the user's local disk. |

**Where archived data goes:**

- Mnemon insight, tagged: `pocketclaw, src:<platform>-chat, chat:<chatId>, kind:group|dm, from:self|other, sender:<senderId>`
- Content format: `<Platform> group "<name>" — <sender>: <body> [N images] [voice note]`
- Attachments are NOTED but NOT downloaded (just `[image]` / `[voice note]` markers). Photos that hit `/photo` flow continue to use the existing photo pipeline (§7.8).
- Stickers are still skipped (matches §8.5).
- Bodies > 600 chars are truncated.
- Stored locally in mnemon DB at `${MNEMON_DATA_DIR}/data/default/mnemon.db` — never leaves the machine unless the user explicitly recalls something into a Claude prompt.

**Implementation:**

- `src/modules/chat-archive.ts` — `archiveChatMessage(record)` — fire-and-forget, serialized through a process-wide promise chain to avoid SQLITE_BUSY under message storms.
- Hooked into `src/channels/whatsapp.ts` inside the `messages.upsert` handler (BEFORE the fromMe self-chat filter, so we capture both directions).
- Hooked into `src/channels/chat-sdk-bridge.ts` — `archiveSdkMessage()` called inside all 4 dispatch paths (subscribed / mention / DM / new). Captures Telegram, Discord, Slack, Matrix, etc.
- Mnemon writes use `--no-diff` (skip dedup) — chat is high-volume and identical-message dedup is more harmful (loses count) than helpful (saves bytes).

**Privacy guarantees:**

- Default `off` — opt-in required.
- Vault and mnemon DB are gitignored. Survive only on local disk.
- No third-party API calls happen as part of archival (mnemon is local).
- The recorded content reaches Anthropic API ONLY if the user explicitly recalls it into a Claude prompt. The audit log (§US-8) tracks this.
- User can `pnpm svc:uninstall:purge` to nuke everything in one command (see `docs/SERVICE.md`).

**Privacy non-guarantees (must communicate to user):**

- If `INGEST_CHAT_MODE=all` is set, the user's local mnemon DB will contain other people's messages. This is legally / ethically loaded in many jurisdictions.
- Anyone with physical access to the user's laptop AND the unlocked OS account can read the archive (mnemon DB is unencrypted SQLite).
- The user is responsible for compliance with applicable laws (e.g. EU GDPR informational duties, US two-party-consent recording laws if voice notes were ever transcribed — currently they aren't).

**Compatibility with existing PRD §7.7:**

The self-chat model in §7.7 still controls **command routing** (which messages wake the agent for a Claude turn). Chat-archive runs **before** that filter and is independent — archival mode is set by `INGEST_CHAT_MODE`, agent routing is set by §7.7 wiring rules. The two are orthogonal.

---

## Environment Variables (Extended — Appendix B v2)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_PAT` | For GitHub | — | Personal Access Token (read-only all repos) |
| `SLACK_USER_TOKEN` | For Slack | — | Slack user OAuth token (xoxp-...) |
| `SLACK_WORKSPACE` | For Slack | — | Workspace name for context |
| `PPTX_STYLE` | No | minimal | Default slide style |
| `MEETING_MINUTES_FORMAT` | No | docx | Output format: docx or txt |
| `RESEARCH_OUTPUT_FORMAT` | No | pdf | Output format: pdf or md |
| `INGEST_CHAT_MODE` | No | off | Chat archive scope: `off`, `self`, `dms`, `all` (see §17.7) |
| `MNEMON_DATA_DIR` | No | `~/.mnemon` | Override mnemon data directory (used to relocate to X: drive) |
| `VAULT_PATH` | No | `~/.pocketclaw/vault` | Override vault location |
| `LOG_PATH` | No | `~/.pocketclaw/logs` | Override service log location |
| `WATCH_PATHS_ROOT` | No | `~/.pocketclaw/watch` | Override file-watcher root |
| `POCKETCLAW_SECRETS_DIR` | No | `~/.pocketclaw/secrets` | Override secrets directory |
| `POCKETCLAW_PROCESSED_DB` | No | `~/.pocketclaw/processed.db` | Override file-watcher dedup DB |


---

## 18. As-Built Additions (not in original PRD)

This section documents everything we shipped during the build that wasn't specified in PRD §1–17. Captured here so the PRD stays the single source of truth instead of drifting from reality. Detailed cross-reference in `.omo/notepads/pocketclaw/prd-vs-built-audit.md`.

### 18.1 Windows service hosting (NSSM)

**Why:** PRD §7.1 assumed Docker-compose with a single long-running container. NanoClaw v2 spawns containers per-agent-group dynamically, so the host itself runs as a Node process. We host that process as a Windows service via [NSSM](https://nssm.cc/) so it auto-starts on boot and self-heals on crash.

**What's there:**

- `scripts/service/install.ps1` — registers the service. Auto-installs NSSM via Chocolatey or winget. Auto-rebuilds `better-sqlite3` native binding if missing. Pins Node 22 (avoids ABI mismatch with Node 26 on the user's PATH). Generates a `.run-host.cmd` wrapper so NSSM's space-in-path tokenizer doesn't break Windows paths.
- `scripts/service/uninstall.ps1` — removes service registration. Handles `Paused` + `Disabled` states caused by SCM crash-loop auto-disable. Optional `-Purge` wipes `X:\PocketClawData\` and `~/.mnemon\`.
- `scripts/service/install-elevated.ps1` + `uninstall-elevated.ps1` — self-elevating UAC wrappers. User runs from non-admin shell, UAC prompt opens, admin window does the work.
- `scripts/service/status.ps1` — read-only snapshot. Reads `.env` paths so it always points at the actual configured locations (not hardcoded `~/.pocketclaw/`). Reports source health (Google ✅, Microsoft ⏸, Apple ✅, GitHub ✅, Slack ⏸).
- `scripts/service/migrate-export.ps1` + `migrate-import.ps1` — bundle creds + memory + vault into a zip on the source machine, restore on the destination. For moving PocketClaw between laptops without re-OAuthing every cloud source.
- `docs/SERVICE.md` — full lifecycle docs.
- `pnpm run` shortcuts (10): `svc`, `svc:status`, `svc:tail`, `svc:install`, `svc:install:elevated`, `svc:install:dry`, `svc:uninstall`, `svc:uninstall:elevated`, `svc:uninstall:purge`, `svc:export`. All prefixed with `cmd /c` to work around a pnpm 10.x Windows shell-tokenizer bug.

### 18.2 Telegram MTProto user-mode ingestion

**Why:** PRD §7.6 used the Telegram Bot API. Bots can only see messages addressed to them — they can't read your DMs or group history. To ingest your full Telegram data we need to sign in as YOU via MTProto.

**What's there:**

- `src/modules/telegram-mtproto-service.ts` — sign-in state machine (idle → awaiting_code → awaiting_password → connected). Uses GramJS (`telegram` npm package). Session string persisted to `${POCKETCLAW_SECRETS_DIR}/telegram_session.txt`.
- `src/modules/ingestion/telegram-mtproto.ts` — runtime ingester. Connects on host startup if a saved session exists, listens for `NewMessage` events, pipes every inbound message through `archiveChatMessage()` so it lands in mnemon with the same tagging as WhatsApp.
- `src/channels/telegram.ts` — extended the existing pairing interceptor with a `/connect_telegram` flow. User DMs the bot `/connect_telegram`, bot asks for phone, kicks off MTProto, asks for SMS code, asks for 2FA password if needed, confirms session saved.
- `scripts/telegram-mtproto-login.ts` — fallback CLI sign-in (`pnpm tg:login`) for users who prefer terminal flow.
- Optional backfill via `TELEGRAM_BACKFILL_DAYS` env var (default 0 = realtime only).

**Privacy posture:** Same as §17.7. The session string is the equivalent of a logged-in Telegram client — anyone with that file can read all your Telegram. Stored in gitignored secrets dir, file mode `0o600` on POSIX.

### 18.3 File auto-discovery on whole drives

**Why:** PRD §7.10 spec'd a single `WATCH_PATHS_ROOT` directory. Real-world use wants to point at a whole drive (e.g. `X:\`) and have ingestion ignore the obvious noise.

**What's there:**

- `src/modules/ingestion/file-watcher.ts` extended with:
  - `WATCH_PATHS_ROOT` now comma-separated for multiple roots (`X:/,X:/PocketClawData/watch`)
  - `shouldIgnore(path)` predicate covering `node_modules`, `.git`, `dist`, `build`, `target`, `__pycache__`, `.next`, `.turbo`, `.gradle`, `$RECYCLE.BIN`, `System Volume Information`, OS junk, our own data dir
  - `ignoreInitial: true` by default — only react to NEW changes. Override with `POCKETCLAW_WATCH_INITIAL=true` for bulk backfill of existing files.
- Wired into `pocketclaw.ts` startup. Each detected file → SHA256 fingerprint → mnemon insight tagged `pocketclaw, src:file, path:<rel>`.

### 18.4 Chat archive (PRD §17.7 was added during build, but worth restating)

Already documented in §17.7 above. Important addendum: real-time hooks live in `src/channels/whatsapp.ts` (Baileys `messages.upsert` event) and `src/channels/chat-sdk-bridge.ts` (Telegram bot + Discord + Slack + Matrix). MTProto ingestion (§18.2) uses the same `archiveChatMessage()` sink so ALL chat sources funnel through one tagged-mnemon writer.

### 18.5 Path helper (`src/modules/paths.ts`)

**Why:** Node doesn't expand `~` in paths. PRD didn't anticipate this. Without it, env vars like `VAULT_PATH=~/.pocketclaw/vault` would create a literal `~` directory inside `cwd`.

**What's there:** `expandHome(path)` + `envPath(envVar, defaultSubdir)`. Used by every module that reads a path env var. Tested: 9 cases in `src/modules/paths.test.ts`.

### 18.6 Per-machine relocatable data root

**Why:** PRD assumed `~/.pocketclaw/`. User's C: drive was tight, so we made every path env-var configurable and put data on `X:\PocketClawData\` (~580 GB free). The mock Obsidian vault structure (`wiki/`, `meetings/`, `research/`, `presentations/`, `speeches/`, `contacts/`, `photos/`, `notes/`, `.obsidian/`) lives there.

**What's there:**

- 7 new path env vars (all optional, default to `~/.pocketclaw/...`):
  `VAULT_PATH`, `MNEMON_DATA_DIR`, `MNEMON_DB_PATH`, `WATCH_PATHS_ROOT`, `LOG_PATH`, `POCKETCLAW_SECRETS_DIR`, `POCKETCLAW_PROCESSED_DB`
- Mock vault populated with `README.md`, `.obsidian/app.json`, plugin placeholder dirs, `notes/inbox.md` starter, `wiki/Example_Wiki_Entry.md` showing the auto-generated format.
- Service migrate scripts (`§18.1`) bundle/restore the entire data root.

### 18.7 Test coverage extension

**Why:** PRD §11 listed unit/integration/performance/security suites in aspirational form. We delivered unit + scoped integration tests for everything PocketClaw-specific.

**What's there (52 cases total, all green):**

- 23 baseline cases (debouncer ×7, photo-processor ×16) from original Phase 5/7
- 9 new cases for `expandHome` + `envPath` (`paths.test.ts`)
- 5 new cases for `archiveChatMessage` filter modes (`chat-archive.test.ts`)
- 8 new cases for `shouldIgnore` (`file-watcher.test.ts`)
- 4 new cases for `CloudScheduler.runAll` fault isolation (`scheduler.test.ts`)
- 3 new cases for §17.3/4/5 generator render round-trips (`generators.test.ts`)

### 18.8 Documentation overhaul

**Why:** README in original repo was the Azure ML template boilerplate. PRD §13 Phase 10 listed "documentation review" as a checkbox but didn't define artifacts.

**What's there:**

- `README.md` — full lifecycle (clone → install → run → migrate → teardown), data location story, source-by-source sign-in walkthroughs (Google, Microsoft, Apple, GitHub, Slack), all `pnpm` commands, troubleshooting.
- `docs/SERVICE.md` — Windows service install/migrate/teardown deep-dive. Covers UAC patterns, NSSM gotchas, log paths, NSSM service-recovery semantics that bit us during initial install.
- `.omo/notepads/pocketclaw/prd-vs-built-audit.md` — phase-by-phase scorecard cross-referencing PRD §1–17 against shipped code.
- `.omo/notepads/pocketclaw/prd-distance.md` — earlier sister doc (live ingestion evidence + commit-by-commit diff).

### 18.9 Environment Variables (extension to Appendix B)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_API_ID` | For MTProto | — | from https://my.telegram.org/apps |
| `TELEGRAM_API_HASH` | For MTProto | — | from https://my.telegram.org/apps — treat as password |
| `TELEGRAM_PHONE` | For MTProto | — | E.164 format, used by `/connect_telegram` flow |
| `TELEGRAM_SESSION_PATH` | No | `${POCKETCLAW_SECRETS_DIR}/telegram_session.txt` | Override MTProto session location |
| `TELEGRAM_BACKFILL_DAYS` | No | 0 | If >0, backfill that many days of history on first connect |
| `INGEST_CHAT_MODE` | No | off | `off` / `self` / `dms` / `all` — see §17.7 |
| `POCKETCLAW_WATCH_INITIAL` | No | false | If `true`, file-watcher ingests existing tree on first start (warning: slow on whole-drive watches) |
| `MNEMON_DATA_DIR` | No | `~/.mnemon` | Override mnemon data dir (used to relocate to X: drive) |
| `VAULT_PATH` | No | `~/.pocketclaw/vault` | Override vault location |
| `LOG_PATH` | No | `~/.pocketclaw/logs` | Override service log location |
| `WATCH_PATHS_ROOT` | No | `~/.pocketclaw/watch` | Comma-separated list of directories to watch |
| `POCKETCLAW_SECRETS_DIR` | No | `~/.pocketclaw/secrets` | Override OAuth tokens + session files dir |
| `POCKETCLAW_PROCESSED_DB` | No | `~/.pocketclaw/processed.db` | Override file-watcher SHA256 dedup DB |

### 18.10 WhatsApp single-number summon + cross-platform identity grants

**Why:** PRD §6 / §7 modelled WhatsApp as a separate-number bot (`ASSISTANT_HAS_OWN_NUMBER=true` implied). Real-world install uses the user's existing number (`6592348112`) so PocketClaw IS the user on WhatsApp. This collides with two NanoClaw v2 invariants:

1. **The `fromMe` echo-loop guard in `src/channels/whatsapp.ts`** drops every message whose sender JID matches the bot's paired account — a deliberate safeguard against infinite reply loops. With a shared number, that means every message *you* type also gets dropped.
2. **The router's `canAccessAgentGroup` strict-policy gate** treats `whatsapp:<phone>@s.whatsapp.net` and `telegram:<id>` as completely separate user rows. Owner role on Telegram does NOT carry over to WhatsApp.

**What's there:**

- `WHATSAPP_OWNER_ALIASES` env var (comma-separated, default `@pocketclaw`). The fromMe guard at `src/channels/whatsapp.ts:~L678` now allows messages where `fromMe=true` AND the trimmed-lowercased content starts with one of these aliases AND `msg.key.id` is not in `sentMessageCache` (excluding actual bot echoes). Echo-safe because outbound bot replies in single-number mode are prefixed `${ASSISTANT_NAME}:` (e.g. `PocketClaw:`), never `@pocketclaw`.
- `engage_pattern` in `messaging_group_agents` is a `startsWith` substring check, so `@pocketclaw` matches both `@pocketclaw ping` and `@pocketclaw234 hello` — alias support without separate wiring rows.
- Cross-platform identity must be granted explicitly. For each new platform identity that should have owner access, insert into `user_roles`:
  ```sql
  INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
  VALUES ('whatsapp:<phone>@s.whatsapp.net', 'owner', NULL, '<existing_owner_user_id>', '<iso_ts>');
  ```
  `isOwner` queries the DB live (no in-memory cache), so the grant takes effect without restarting the host.

**Permanent observability:** added `Inbound WhatsApp message` INFO log at adapter entry in `src/channels/whatsapp.ts`, symmetric with the existing `Inbound DM` / `Inbound group message` lines in `src/channels/chat-sdk-bridge.ts`. Logs `chatJid`, `sender`, `senderName`, `fromMe`, `textLen`, `attachments`, `isMention` — irreplaceable for next-time triage.

### 18.11 Filesystem-safe message IDs (NTFS Alternate Data Stream gotcha)

**Why:** Router builds messageIds as `${chatId}:${msgId}:${agentGroupId}`. The host (Windows native node, NOT Docker) writes per-session attachment inboxes at `data\v2-sessions\<ag>\<sess>\inbox\<messageId>\photo.jpg` BEFORE Docker mounts the path into the agent container. On NTFS, `CreateDirectoryW("foo:bar")` interprets `bar` as an Alternate Data Stream and refuses with `ENOENT`. Docker would have hit the same thing on the bind-mount, but never gets that far because the host fails first.

This is a recurring source of confusion for new contributors who think "everything is in Docker so filesystem rules don't matter" — they do, because the host is the one writer of inbound.db and inbox/.

**What's there:**

- `src/attachment-safety.ts` exports `sanitizeForFilesystem(s)` mapping `[<>:"/\\|?*\x00-\x1F]` → `-`. Filesystem-agnostic so it's safe on NTFS, exFAT, ReFS, ext4, APFS.
- `src/session-manager.ts:extractAttachmentFiles()` calls it on both `inboxDir` (the `<messageId>` path component) and `att.localPath` (the per-attachment filename).
- `src/channels/chat-sdk-bridge.ts` wraps `att.fetchData()` in `Promise.race` with a 30-second timeout, with `Attachment fetch start/ok/timeout` log markers. Without this, a slow Telegram CDN could wedge the inbound pipeline indefinitely (Node 22 `fetch` has no default timeout).

### 18.12 Run-as principal: Scheduled Task with S4U token, not SYSTEM

**Why:** PRD §18.1 documented NSSM hosting. We migrated to a Windows Scheduled Task because:

- NSSM runs as `LocalSystem` by default. SYSTEM cannot reach Docker Desktop's user-owned named pipe (`\\.\pipe\docker_engine_<user>`), giving fatal `spawnSync ETIMEDOUT` when the host tries to spawn a per-session container.
- A Scheduled Task with `Principal=PRAWN-E14\bryan` and `LogonType=S4U` runs the host as the user without storing their password. Docker Desktop pipe is reachable, container spawn works.

**What's there:**

- `scripts/service/install-task.ps1` — `New-ScheduledTask` with `RunLevel=Highest`, `S4U` logon, restart-on-fail, automatic boot trigger.
- `scripts/service/Restart-PocketClaw-v2.ps1` — restart anchor uses `Get-NetTCPConnection -LocalPort 3000 | Select-Object -ExpandProperty OwningProcess` THEN `taskkill /F /T /PID <pid>`. Plain `schtasks /End` does NOT kill the detached child node.exe; the script enforces both.
- `data/circuit-breaker.json` — auto-disable counter; deleted by the restart script before each `/Run` to avoid "attempt 2/3/4 → 30/120/300/900s backoff" lockout.

**Gotcha:** S4U token ≠ interactive token. `Stop-Process -Id <pid>` from a non-elevated PowerShell window returns "Access is denied" when targeting the service node.exe, EVEN when the interactive user matches `PRAWN-E14\bryan`. Kill operations must come from an elevated shell (Win+X → Terminal Admin) or the restart script (which self-elevates via UAC). File ops on the breaker file (delete, etc.) work non-elevated.

### 18.13 Chat-platform silent-drop debugging skill

**Why:** Spent ~half a day across two sessions diagnosing why WhatsApp messages didn't reply, walking through 7 sequential silent-drop sites between Baileys recv and reply send. Captured as a Hermes skill so the next platform integration doesn't pay the same tax.

**Where:** `~/.hermes/skills/software-development/chat-platform-silent-drop-debugging/SKILL.md` (off-repo, lives in user's Hermes skill library).

**What it covers:** the 7 drop sites in order — adapter entry, adapter early-return guards, fromMe echo-loop guard, router strict sender-policy gate, messageId-colon NTFS ADS crash, attachment fetch hang, WhatsApp client-side decryption desync. Each with diagnostic tracer pattern, exact fix site, and verification chain (the 5-line happy-path log signature). Also documents the non-obvious `outbound.db` schema (`id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content` — NOT `destination_channel_id` like generic NanoClaw docs imply).
