# syntax=docker/dockerfile:1
# NanoClaw Sub-Agent — production multi-stage build
# Image: nanoclaw/agent (pushed to ECR)
#
# Stage 1: build deps
# Stage 2: production runtime with OCR dependencies

# ── Stage 1: Install Python dependencies ──────────────────────────────────────
FROM public.ecr.aws/docker/library/python:3.11-slim AS deps

WORKDIR /app

# Install build tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY pyproject.toml ./
RUN pip install --no-cache-dir .

# ── Stage 2: Production runtime ───────────────────────────────────────────────
FROM public.ecr.aws/docker/library/python:3.11-slim AS production

WORKDIR /app

# Runtime system dependencies (OCR + document processing)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-eng \
        libgl1-mesa-glx \
        libglib2.0-0 \
        curl && \
    rm -rf /var/lib/apt/lists/*

# Copy installed Python packages from deps stage
COPY --from=deps /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=deps /usr/local/bin /usr/local/bin

# Copy application source
COPY src/ ./src/

# Copy Clawd persona JSON — loaded by llm/client.py for system prompt assembly
RUN mkdir -p /app/persona
COPY src/persona/system_prompt_template.json /app/persona/system_prompt_template.json

# Create non-root user (uid 1001 — 1000 reserved for host-side builds)
RUN useradd -u 1001 -m -s /bin/sh agent && \
    chown -R agent:agent /app
USER agent

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

ENTRYPOINT ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
