# -----------------------------------------------------------------------------
# NanoClaw AWS Infrastructure -- Application Load Balancer (t6-40)
#
# Fronts the orchestrator's HTTP surface (/health, admin UI, webhooks) with an
# ALB so deploys can use target-group health checks + connection draining
# (deregistration delay) for zero-downtime cutover of the HTTP layer.
#
# IMPORTANT ARCHITECTURAL CONSTRAINT (read before assuming "blue/green"):
#   The orchestrator also holds a STATEFUL WhatsApp (Baileys) websocket. WA
#   permits exactly ONE active session per number; a second concurrent login
#   forcibly logs out the first. So you CANNOT run blue and green orchestrators
#   live in parallel for the WhatsApp path. The ALB gives zero-downtime for the
#   HTTP surface; the WA session requires a SEQUENCED handoff (drain blue ->
#   final S3 auth backup -> green restores from S3 and re-claims). See
#   scripts/deploy/blue-green.sh and BLUE-GREEN-RUNBOOK.md.
#
# Gated by enable_alb (default false). Apply is user-gated.
# -----------------------------------------------------------------------------

# Second public subnet (AZ-b) -- an ALB requires >= 2 subnets in distinct AZs.
resource "aws_subnet" "public_b" {
  count                   = var.enable_alb ? 1 : 0
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_b_cidr
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.project_name}-public-b"
  }
}

resource "aws_route_table_association" "public_b" {
  count          = var.enable_alb ? 1 : 0
  subnet_id      = aws_subnet.public_b[0].id
  route_table_id = aws_route_table.public.id
}

# ALB security group -- public 80/443 in, 3000 out to the EC2 SG.
resource "aws_security_group" "alb" {
  count       = var.enable_alb ? 1 : 0
  name_prefix = "${var.project_name}-alb-"
  description = "ALB ingress for NanoClaw orchestrator HTTP surface"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.alb_ingress_cidrs
    description = "HTTP (redirected to HTTPS when a cert is set)"
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.alb_ingress_cidrs
    description = "HTTPS"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "All outbound"
  }

  tags = {
    Name = "${var.project_name}-alb-sg"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Let the ALB reach the orchestrator on the app port.
resource "aws_security_group_rule" "ec2_from_alb" {
  count                    = var.enable_alb ? 1 : 0
  type                     = "ingress"
  from_port                = var.orchestrator_port
  to_port                  = var.orchestrator_port
  protocol                 = "tcp"
  security_group_id        = aws_security_group.ec2.id
  source_security_group_id = aws_security_group.alb[0].id
  description              = "Orchestrator app port from ALB"
}

resource "aws_lb" "main" {
  count              = var.enable_alb ? 1 : 0
  name               = "${var.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb[0].id]
  subnets            = [aws_subnet.public.id, aws_subnet.public_b[0].id]

  drop_invalid_header_fields = true
  enable_deletion_protection = var.alb_deletion_protection

  tags = {
    Name = "${var.project_name}-alb"
  }
}

# Target group with a deregistration delay so in-flight HTTP requests drain on
# cutover. Health check hits /health (the orchestrator's existing endpoint).
resource "aws_lb_target_group" "orchestrator" {
  count                = var.enable_alb ? 1 : 0
  name                 = "${var.project_name}-orch-tg"
  port                 = var.orchestrator_port
  protocol             = "HTTP"
  vpc_id               = aws_vpc.main.id
  target_type          = "instance"
  deregistration_delay = var.alb_deregistration_delay

  health_check {
    enabled             = true
    path                = "/health"
    port                = "traffic-port"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name = "${var.project_name}-orch-tg"
  }
}

resource "aws_lb_target_group_attachment" "orchestrator" {
  count            = var.enable_alb ? 1 : 0
  target_group_arn = aws_lb_target_group.orchestrator[0].arn
  target_id        = aws_instance.main.id
  port             = var.orchestrator_port
}

# HTTPS listener when a cert ARN is provided; otherwise HTTP-only (dev).
resource "aws_lb_listener" "https" {
  count             = var.enable_alb && var.alb_certificate_arn != "" ? 1 : 0
  load_balancer_arn = aws_lb.main[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.alb_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.orchestrator[0].arn
  }
}

# HTTP listener: redirect to HTTPS when a cert exists, else forward (dev).
resource "aws_lb_listener" "http" {
  count             = var.enable_alb ? 1 : 0
  load_balancer_arn = aws_lb.main[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = var.alb_certificate_arn != "" ? "redirect" : "forward"

    dynamic "redirect" {
      for_each = var.alb_certificate_arn != "" ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }

    target_group_arn = var.alb_certificate_arn != "" ? null : aws_lb_target_group.orchestrator[0].arn
  }
}
