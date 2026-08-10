from pathlib import Path


def test_dashboard_contains_system_diagnostics_panel_and_loader():
    html = Path("frontend/dashboard.html").read_text(encoding="utf-8")
    js = Path("frontend/dashboard.js").read_text(encoding="utf-8")

    assert 'id="system-diagnostics-summary"' in html
    assert 'id="system-diagnostics-list"' in html
    assert "async function loadSystemDiagnostics()" in js
    assert "/api/system/diagnostics" in js
    assert "loadSystemDiagnostics();" in js


def test_dashboard_forgotten_state_uses_supported_lucide_icon():
    html = Path("frontend/dashboard.html").read_text(encoding="utf-8")
    js = Path("frontend/dashboard.js").read_text(encoding="utf-8")

    assert 'data-lucide="moon-off"' not in html + js
    assert (html + js).count('data-lucide="eye-off"') >= 4
