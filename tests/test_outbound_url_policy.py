"""Shared egress policy rejects unsafe provider and webhook destinations."""

from __future__ import annotations

import pytest

from ombrebrain.security.outbound_url import OutboundURLRejected, validate_outbound_url


def test_outbound_url_requires_https_except_explicit_local_endpoints(monkeypatch):
    assert validate_outbound_url("http://127.0.0.1:11434/v1") == "http://127.0.0.1:11434/v1"
    assert validate_outbound_url("http://ombre-ollama:11434/v1") == "http://ombre-ollama:11434/v1"
    with pytest.raises(OutboundURLRejected):
        validate_outbound_url("http://provider.example/v1")
    monkeypatch.setenv("OMBRE_INSECURE_LOCAL_HOSTS", "ollama.lan")
    assert validate_outbound_url("http://ollama.lan:11434/v1") == "http://ollama.lan:11434/v1"


@pytest.mark.parametrize(
    "url",
    (
        "https://0.0.0.0/v1",
        "https://169.254.169.254/latest/meta-data",
        "https://224.0.0.1/v1",
        "https://240.0.0.1/v1",
        "https://[::]/v1",
        "https://[fe80::1]/v1",
        "https://[ff02::1]/v1",
        "https://2130706433/v1",
        "https://127.1/v1",
        "https://0x7f000001/v1",
    ),
)
def test_outbound_url_rejects_forbidden_direct_ip_classes(url):
    with pytest.raises(OutboundURLRejected):
        validate_outbound_url(url)


def test_private_https_ip_requires_exact_operator_allowlist(monkeypatch):
    assert validate_outbound_url("https://127.0.0.1:8443/v1") == "https://127.0.0.1:8443/v1"
    with pytest.raises(OutboundURLRejected):
        validate_outbound_url("https://192.168.1.10:8443/v1")
    monkeypatch.setenv("OMBRE_INSECURE_LOCAL_HOSTS", "192.168.1.10,fd00::10")
    assert validate_outbound_url("https://192.168.1.10:8443/v1") == "https://192.168.1.10:8443/v1"
    assert validate_outbound_url("https://[fd00::10]:8443/v1") == "https://[fd00::10]:8443/v1"


@pytest.mark.parametrize(
    "url",
    (
        "file:///etc/passwd",
        "https://user:password@provider.example/v1",
        "https://provider.example/v1#fragment",
        "https://provider.example/has space",
        "https://provider.example/" + ("x" * 2048),
    ),
)
def test_outbound_url_rejects_ambiguous_or_sensitive_forms(url):
    with pytest.raises(OutboundURLRejected):
        validate_outbound_url(url)


@pytest.mark.asyncio
async def test_provider_sdk_clients_disable_redirects(tmp_path):
    from dehydrator import Dehydrator
    from embedding_engine import APIEmbeddingEngine

    dehydrator = Dehydrator(
        {
            "buckets_dir": str(tmp_path / "vault"),
            "dehydration": {"api_key": "key", "base_url": "https://provider.example/v1"},
        }
    )
    embedding = APIEmbeddingEngine("key", "https://provider.example/v1", "model")
    try:
        assert dehydrator.client is not None
        assert dehydrator.client._client.follow_redirects is False
        assert embedding._client._client.follow_redirects is False
    finally:
        await dehydrator.client.close()
        await embedding._client.close()
        dehydrator.close()
