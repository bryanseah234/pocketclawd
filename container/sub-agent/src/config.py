"""
Sub-agent configuration.

Reads configuration from environment variables injected at container startup.
In production, secrets are fetched from AWS Secrets Manager by the orchestrator
and passed via the Redis inbound queue or mounted config file — never as env vars
containing raw credentials.
"""

from pydantic import Field
from pydantic_settings import BaseSettings


class RedisConfig(BaseSettings):
    """Redis connection settings for queue communication with the orchestrator."""

    host: str = Field(default="localhost", alias="REDIS_HOST")
    port: int = Field(default=6379, alias="REDIS_PORT")
    password: str = Field(default="", alias="REDIS_PASSWORD")
    db: int = Field(default=0, alias="REDIS_DB")
    ssl: bool = Field(default=False, alias="REDIS_SSL")

    @property
    def url(self) -> str:
        scheme = "rediss" if self.ssl else "redis"
        auth = f":{self.password}@" if self.password else ""
        return f"{scheme}://{auth}{self.host}:{self.port}/{self.db}"


class AgentConfig(BaseSettings):
    """Per-user agent configuration injected by the orchestrator."""

    user_id: str = Field(default="", alias="AGENT_USER_ID")
    queue_poll_timeout: int = Field(default=5, alias="QUEUE_POLL_TIMEOUT")
    max_retries: int = Field(default=3, alias="MAX_RETRIES")


class Settings(BaseSettings):
    """Top-level application settings."""

    redis: RedisConfig = RedisConfig()
    agent: AgentConfig = AgentConfig()

    # AWS region for Bedrock, S3, DynamoDB calls
    aws_region: str = Field(default="ap-southeast-1", alias="AWS_REGION")

    # Application metadata
    app_name: str = "nanoclaw-sub-agent"
    version: str = "0.1.0"

    @property
    def inbound_queue_key(self) -> str:
        """Redis key for receiving messages from the orchestrator.

        Worker-pool mode: all workers pull from the shared dispatch queue.
        Each message carries userId for per-user data isolation. AGENT_USER_ID
        is still set but used for identity, not queue routing. Sourced from the
        shared namespace (redis_keys.py) which mirrors src/cloud/redis-keys.ts.
        """
        from .redis_keys import WORKER_POOL_INBOUND

        return WORKER_POOL_INBOUND

    @property
    def response_queue_key(self) -> str:
        """Redis key for sending responses back to the orchestrator."""
        from .redis_keys import ORCHESTRATOR_RESPONSES

        return ORCHESTRATOR_RESPONSES


def get_settings() -> Settings:
    """Create and return application settings. Call once at startup."""
    return Settings()
