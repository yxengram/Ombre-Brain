"""Private state is repaired explicitly instead of relying on the process umask."""

import os
import stat

import pytest

from dehydrator import Dehydrator
from embedding_engine import EmbeddingEngine
from utils import load_config
from web import _shared as shared


@pytest.mark.skipif(os.name == "nt", reason="Windows ACLs are best-effort diagnostics")
def test_load_config_repairs_vault_directories_and_config_mode(monkeypatch, tmp_path):
    vault = tmp_path / "vault"
    config_path = tmp_path / "config.yaml"
    config_path.write_text(f"buckets_dir: {vault}\n", encoding="utf-8")
    config_path.chmod(0o644)
    monkeypatch.delenv("OMBRE_VAULT_DIR", raising=False)
    monkeypatch.delenv("OMBRE_BUCKETS_DIR", raising=False)

    config = load_config(str(config_path))

    assert stat.S_IMODE(config_path.stat().st_mode) == 0o600
    for path in (vault, vault / "permanent", vault / "dynamic", vault / "archive", vault / "_media"):
        assert stat.S_IMODE(path.stat().st_mode) == 0o700
    assert config["media_dir"] == str(vault / "_media")


@pytest.mark.skipif(os.name == "nt", reason="Windows ACLs are best-effort diagnostics")
def test_sqlite_private_files_are_created_with_private_mode(tmp_path):
    vault = tmp_path / "vault"
    EmbeddingEngine({"buckets_dir": str(vault), "embedding": {"enabled": False}})
    dehydrator = Dehydrator({"buckets_dir": str(vault), "dehydration": {"api_key": ""}})
    try:
        assert stat.S_IMODE((vault / "embeddings.db").stat().st_mode) == 0o600
        assert stat.S_IMODE((vault / "dehydration_cache.db").stat().st_mode) == 0o600
    finally:
        dehydrator.close()


@pytest.mark.skipif(os.name == "nt", reason="Windows ACLs are best-effort diagnostics")
def test_env_writer_is_atomic_private_and_refuses_symlink(monkeypatch, tmp_path):
    env_path = tmp_path / ".env"
    monkeypatch.setattr(shared, "_project_env_path", lambda: str(env_path))

    shared._write_env_var("SECRET", "value")
    assert env_path.read_text(encoding="utf-8") == "SECRET=value\n"
    assert stat.S_IMODE(env_path.stat().st_mode) == 0o600

    target = tmp_path / "target.env"
    target.write_text("unchanged\n", encoding="utf-8")
    env_path.unlink()
    env_path.symlink_to(target)
    with pytest.raises(ValueError, match="符号链接"):
        shared._write_env_var("SECRET", "new-value")
    assert target.read_text(encoding="utf-8") == "unchanged\n"
