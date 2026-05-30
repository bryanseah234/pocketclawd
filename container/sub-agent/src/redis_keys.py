"""
Canonical Redis key namespace — mirror of src/cloud/redis-keys.ts.

KEEP IN LOCKSTEP with the TypeScript side. Any change here MUST be mirrored
there (and vice versa) or orchestrator/sub-agent will silently stop talking.

KEY CONTRACT:
    Worker-pool inbound (cloud):   queue:agent:dispatch
    Per-user inbound (on-prem):    queue:agent:{userId}:inbound
    Orchestrator responses:        queue:orchestrator:responses
    DataGateway requests:          queue:orchestrator:data_gateway
    Per-user DLQ:                  queue:agent:{userId}:dlq
    DG response (per request):     queue:agent:{userId}:dg_response:{requestId}
    Token response (per request):  queue:agent:{userId}:token_response:{requestId}
    Admin shared inbound:          queue:agent:shared:inbound
"""

DISPATCH_SENTINEL = "dispatch"

WORKER_POOL_INBOUND = "queue:agent:dispatch"
ORCHESTRATOR_RESPONSES = "queue:orchestrator:responses"
DATA_GATEWAY = "queue:orchestrator:data_gateway"
ADMIN_SHARED_INBOUND = "queue:agent:shared:inbound"


def agent_inbound_key(user_id: str) -> str:
    if user_id == DISPATCH_SENTINEL:
        return WORKER_POOL_INBOUND
    return f"queue:agent:{user_id}:inbound"


def orchestrator_response_key() -> str:
    return ORCHESTRATOR_RESPONSES


def dlq_key(user_id: str) -> str:
    return f"queue:agent:{user_id}:dlq"


def dg_response_key(user_id: str, request_id: str) -> str:
    return f"queue:agent:{user_id}:dg_response:{request_id}"


def token_response_key(user_id: str, request_id: str) -> str:
    return f"queue:agent:{user_id}:token_response:{request_id}"
