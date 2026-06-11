"""Tests for the sub-agent FastAPI application."""

import pytest
from httpx import ASGITransport, AsyncClient

from src.main import app


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    """Create a test client that doesn't trigger the full lifespan (no Redis needed)."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.mark.asyncio
async def test_health_endpoint_returns_degraded_without_redis(client: AsyncClient):
    """Health endpoint should return degraded status when Redis is not connected."""
    response = await client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "degraded"
    assert data["redis_connected"] is False
    assert "uptime_seconds" in data
    assert "version" in data


@pytest.mark.asyncio
async def test_process_endpoint_requires_user_id(client: AsyncClient):
    """Process endpoint should return 503 when user_id is not configured."""
    response = await client.post("/process", json={"content": "hello"})
    assert response.status_code == 503
    assert "user_id" in response.json()["detail"]
