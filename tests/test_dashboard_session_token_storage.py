"""Dashboard session registry must never persist a bearer cookie token."""

import json
import time

import pytest

from web import _shared as sh


class _Request:
    def __init__(self, token: str):
        self.cookies = {"ombre_session": token}


@pytest.fixture
def session_dir(tmp_path, monkeypatch):
    monkeypatch.setitem(sh.config, "buckets_dir", str(tmp_path))
    sh._sessions.clear()
    yield tmp_path
    sh._sessions.clear()


def test_session_file_is_schema_v2_digest_only_and_survives_restart(session_dir):
    token = sh._create_session()
    path = session_dir / ".dashboard_sessions.json"
    stored = json.loads(path.read_text(encoding="utf-8"))

    assert stored["schema_version"] == 2
    assert token not in path.read_text(encoding="utf-8")
    assert list(stored["sessions"]) == [sh._session_digest(token)]
    assert sh._is_authenticated(_Request(token))

    sh._sessions.clear()
    sh._load_sessions()
    assert sh._is_authenticated(_Request(token))
    assert sh._revoke_session(token)
    assert not sh._is_authenticated(_Request(token))


def test_legacy_raw_session_file_is_migrated_before_publish(session_dir):
    token = "legacy-dashboard-cookie-token-12345678901234567890"
    path = session_dir / ".dashboard_sessions.json"
    path.write_text(json.dumps({token: time.time() + 60}), encoding="utf-8")

    sh._load_sessions()

    rewritten = path.read_text(encoding="utf-8")
    assert token not in rewritten
    assert json.loads(rewritten)["schema_version"] == 2
    assert sh._is_authenticated(_Request(token))


def test_malformed_v2_session_keys_are_dropped_and_rewritten(session_dir):
    path = session_dir / ".dashboard_sessions.json"
    good = sh._session_digest("valid-dashboard-cookie-token-12345678901234567890")
    path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "sessions": {good: time.time() + 60, "raw-token": time.time() + 60, "sha256:" + "A" * 64: time.time() + 60},
            }
        ),
        encoding="utf-8",
    )

    sh._load_sessions()

    assert list(sh._sessions) == [good]
    assert list(json.loads(path.read_text(encoding="utf-8"))["sessions"]) == [good]
