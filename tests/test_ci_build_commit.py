from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_ci_passes_the_checked_out_commit_to_every_production_style_image_build():
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    assert 'docker build --build-arg "OMBRE_BUILD_COMMIT=${GITHUB_SHA}"' in workflow
    assert "build-args: |\n            OMBRE_BUILD_COMMIT=${{ github.sha }}" in workflow


def test_dockerfile_document_copy_is_allowed_by_both_dockerignore_filters():
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    dockerignore = (ROOT / ".dockerignore").read_text(encoding="utf-8")

    assert "docs/MCP_OUTPUT_PROTOCOL.md" in dockerfile
    assert dockerignore.count("!docs/MCP_OUTPUT_PROTOCOL.md") == 2
