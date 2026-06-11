"""
Lambda: start-clawd
Starts EC2 i-0f9cd20350cfdc1a6 when called with the correct token.
ECS scaling is handled separately by Hermes via SSM after EC2 is running.
"""
import os
import json
import boto3

EC2_INSTANCE_ID = "i-0f9cd20350cfdc1a6"
SECRET_TOKEN    = os.environ["START_TOKEN"]
REGION          = os.environ.get("AWS_REGION", "ap-southeast-1")


def lambda_handler(event, context):
    # Validate token — present in query string or Authorization header
    qs     = (event.get("queryStringParameters") or {})
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    token  = qs.get("token") or headers.get("x-start-token", "")

    if token != SECRET_TOKEN:
        return {"statusCode": 403, "body": json.dumps({"error": "forbidden"})}

    ec2 = boto3.client("ec2", region_name=REGION)

    # Describe current state
    resp  = ec2.describe_instances(InstanceIds=[EC2_INSTANCE_ID])
    state = resp["Reservations"][0]["Instances"][0]["State"]["Name"]

    if state == "running":
        return {"statusCode": 200, "body": json.dumps({"status": "already_running", "instance": EC2_INSTANCE_ID})}

    if state in ("pending", "stopping"):
        return {"statusCode": 200, "body": json.dumps({"status": state, "instance": EC2_INSTANCE_ID})}

    # Start it
    ec2.start_instances(InstanceIds=[EC2_INSTANCE_ID])
    return {"statusCode": 200, "body": json.dumps({"status": "starting", "instance": EC2_INSTANCE_ID})}
