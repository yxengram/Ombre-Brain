from pathlib import Path


def test_dashboard_import_flow_contains_preflight_confirmation():
    html = Path("frontend/dashboard.html").read_text(encoding="utf-8")
    js = Path("frontend/dashboard.js").read_text(encoding="utf-8")

    assert 'id="import-preflight-panel"' in html
    assert 'id="import-start-confirm-btn"' in html
    assert "async function runImportPreflight(file)" in js
    assert "function renderImportPreflight" in js
    assert "/api/import/preflight" in js
