#!/bin/bash
# Install and enable the NanoClaw orchestrator systemd service
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR/nanoclaw-orchestrator.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable nanoclaw-orchestrator
systemctl start nanoclaw-orchestrator
echo "Service installed and started"
systemctl status nanoclaw-orchestrator
