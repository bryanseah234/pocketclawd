# Development Dockerfile for NanoClaw sub-agent
# Production Dockerfile will be created in task 9.2 with multi-stage build and OCR deps
FROM public.ecr.aws/docker/library/python:3.11-slim AS base

WORKDIR /app

# Install system dependencies needed at runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY pyproject.toml ./
RUN pip install --no-cache-dir .

# Copy application source
COPY src/ ./src/

# Run as non-root user (UID 1000)
RUN useradd -u 1000 -m agent
USER agent

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

ENTRYPOINT ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
