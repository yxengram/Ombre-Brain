import json

import pytest

import web.meta as meta


class _Response:
    def __init__(self, location):
        self.status_code = 302
        self.headers = {"location": location}


class _Stream:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, *_args):
        return False


class _RedirectClient:
    def __init__(self, location):
        self.location = location
        self.requested = []

    def stream(self, _method, url, **_kwargs):
        self.requested.append(url)
        return _Stream(_Response(self.location))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "location",
    [
        "http://github.com/unsafe",
        "https://127.0.0.1/private",
        "https://[::1]/private",
        "https://attacker.example/payload",
        "https://github.com@attacker.example/payload",
    ],
)
async def test_untrusted_release_redirect_is_rejected_before_second_request(tmp_path, location):
    client = _RedirectClient(location)

    with pytest.raises(ValueError, match="重定向目标不受信任"):
        await meta._download_official_release_asset(
            client,
            "https://github.com/yxengram/Ombre-Brain/releases/download/v2.16.0/payload.zip",
            str(tmp_path / "payload.zip"),
        )

    assert len(client.requested) == 1


class _SummaryResponse:
    status_code = 200
    headers = {"content-length": "128"}

    def raise_for_status(self):
        return None

    async def aiter_bytes(self):
        yield json.dumps(
            {"tag_name": "v2.16.0", "published_at": "2026-08-10T00:00:00Z", "body": "x" * 900}
        ).encode()


@pytest.mark.asyncio
async def test_latest_release_summary_is_bounded_and_has_no_user_controlled_url(monkeypatch):
    class _Client:
        requested = []

        def stream(self, method, url, **kwargs):
            self.requested.append((method, url, kwargs))
            return _Stream(_SummaryResponse())

    monkeypatch.setattr(meta, "signing_available", lambda: False)
    client = _Client()
    result = await meta._fetch_latest_release_summary(client)

    assert result["tag_name"] == "v2.16.0"
    assert len(result["body"]) == 700
    assert result["signing_available"] is False
    assert client.requested == [
        ("GET", "https://api.github.com/repos/yxengram/Ombre-Brain/releases/latest", {"headers": {"Accept": "application/vnd.github+json"}, "follow_redirects": False})
    ]
