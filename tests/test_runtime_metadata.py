from pathlib import Path
from types import SimpleNamespace

from ombrebrain.app import runtime_metadata
from ombrebrain.app.runtime_metadata import build_runtime_metadata


def _runtime_tree(root: Path) -> None:
    (root / "src").mkdir(parents=True)
    (root / "frontend").mkdir()
    (root / "src" / "server.py").write_text("VALUE = 1\n", encoding="utf-8")
    (root / "frontend" / "dashboard.html").write_text("<h1>OB</h1>\n", encoding="utf-8")


def test_runtime_metadata_is_safe_and_stable_for_the_process_snapshot(tmp_path, monkeypatch):
    _runtime_tree(tmp_path)
    injected_commit = "c" * 40
    monkeypatch.setenv("OMBRE_BUILD_COMMIT", injected_commit)

    metadata = build_runtime_metadata(tmp_path, "2.15.0")

    assert metadata.version == "2.15.0"
    assert metadata.git_commit == injected_commit
    assert len(metadata.code_fingerprint) == 64
    assert metadata.to_public_dict() == metadata.to_public_dict()
    assert str(tmp_path) not in repr(metadata.to_public_dict())


def test_runtime_metadata_degrades_when_the_runtime_tree_is_incomplete(tmp_path, monkeypatch):
    monkeypatch.setenv("OMBRE_BUILD_COMMIT", "not-a-commit-or-a-secret")
    metadata = build_runtime_metadata(tmp_path, "2.15.0")

    assert metadata.git_commit == "unknown"
    assert metadata.code_fingerprint == "unavailable"


def test_readable_git_commit_wins_over_the_image_build_commit(tmp_path, monkeypatch):
    _runtime_tree(tmp_path)
    git_commit = "a" * 40
    monkeypatch.setenv("OMBRE_BUILD_COMMIT", "b" * 40)
    monkeypatch.setattr(
        runtime_metadata.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(returncode=0, stdout=git_commit + "\n"),
    )

    assert runtime_metadata._git_commit(tmp_path) == git_commit
