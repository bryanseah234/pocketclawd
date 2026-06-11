#!/bin/bash
set -e

# NanoClaw EC2 Instance User Data Script
# Runs on first boot to configure the instance for production

echo "=== NanoClaw EC2 Setup Starting ==="

# System updates
yum update -y

# Install Docker
amazon-linux-extras install docker -y
systemctl enable docker
systemctl start docker
usermod -aG docker ec2-user

# Install Docker Compose
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Install Node.js 22
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
yum install -y nodejs

# Install pnpm
npm install -g pnpm@10

# Create nanoclaw user
useradd -m -s /bin/bash nanoclaw
usermod -aG docker nanoclaw

# Create application directory
mkdir -p /opt/nanoclaw
chown nanoclaw:nanoclaw /opt/nanoclaw

# Login to ECR
aws ecr get-login-password --region ${aws_region} | docker login --username AWS --password-stdin ${ecr_registry}

# Pull latest images
docker pull ${ecr_registry}/${orchestrator_image}:latest
docker pull ${ecr_registry}/${agent_image}:latest

# Tag as current
docker tag ${ecr_registry}/${orchestrator_image}:latest nanoclaw-orchestrator:current
docker tag ${ecr_registry}/${agent_image}:latest nanoclaw-agent:current

# Create systemd service for orchestrator
cat > /etc/systemd/system/nanoclaw-orchestrator.service << 'EOF'
[Unit]
Description=NanoClaw Orchestrator
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=nanoclaw
Restart=always
RestartSec=10
Environment=NANOCLAW_ENV=cloud
Environment=AWS_REGION=${aws_region}

ExecStartPre=-/usr/bin/docker rm -f nanoclaw-orchestrator
ExecStart=/usr/bin/docker run --rm \
    --name nanoclaw-orchestrator \
    --network host \
    -e NANOCLAW_ENV=cloud \
    -e AWS_REGION=${aws_region} \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v /opt/nanoclaw/data:/app/data \
    nanoclaw-orchestrator:current

ExecStop=/usr/bin/docker stop nanoclaw-orchestrator

[Install]
WantedBy=multi-user.target
EOF

# Create data directory
mkdir -p /opt/nanoclaw/data
chown nanoclaw:nanoclaw /opt/nanoclaw/data

# Enable and start the service
systemctl daemon-reload
systemctl enable nanoclaw-orchestrator
systemctl start nanoclaw-orchestrator

# Install CloudWatch agent for log shipping
yum install -y amazon-cloudwatch-agent

cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'EOF'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/messages",
            "log_group_name": "/nanoclaw/system",
            "log_stream_name": "{instance_id}"
          }
        ]
      }
    }
  },
  "metrics": {
    "namespace": "NanoClaw/Infrastructure",
    "metrics_collected": {
      "cpu": { "measurement": ["cpu_usage_idle", "cpu_usage_user", "cpu_usage_system"] },
      "mem": { "measurement": ["mem_used_percent"] },
      "disk": { "measurement": ["disk_used_percent"], "resources": ["*"] }
    }
  }
}
EOF

systemctl enable amazon-cloudwatch-agent
systemctl start amazon-cloudwatch-agent

echo "=== NanoClaw EC2 Setup Complete ==="
