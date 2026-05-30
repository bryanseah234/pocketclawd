# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw AWS Infrastructure — EC2 Instance
# ─────────────────────────────────────────────────────────────────────────────

# Latest Ubuntu 22.04 LTS AMI
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ─── IAM Role (pre-created manually) ────────────────────────────────────────
# The role "nanoclaw-ec2-role" was created manually in the AWS console with
# AdministratorAccess. We reference it here instead of creating it.

data "aws_iam_role" "ec2" {
  name = "nanoclaw-ec2-role"
}

data "aws_iam_instance_profile" "ec2" {
  name = "nanoclaw-ec2-role"
}

# ─── EC2 Instance ────────────────────────────────────────────────────────────

resource "aws_instance" "main" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = var.key_pair_name
  subnet_id              = aws_subnet.private.id
  vpc_security_group_ids = [aws_security_group.ec2.id]
  iam_instance_profile   = data.aws_iam_instance_profile.ec2.name

  root_block_device {
    volume_size           = 64
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  # Data disk for Docker images and container layers
  ebs_block_device {
    device_name           = "/dev/sdf"
    volume_size           = 100
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = false
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 1
  }

  user_data = base64encode(templatefile("${path.module}/user-data.sh.tpl", {
    project_name      = var.project_name
    aws_region        = var.aws_region
    redis_host        = local.redis_host
    redis_port        = local.redis_port
    s3_bucket         = aws_s3_bucket.data.id
    ecr_registry      = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
    orchestrator_image = "${aws_ecr_repository.orchestrator.repository_url}:latest"
    agent_image       = "${aws_ecr_repository.agent.repository_url}:latest"
  }))

  tags = {
    Name = "${var.project_name}-orchestrator"
  }

  lifecycle {
    ignore_changes = [ami] # Don't recreate on AMI updates
  }
}
