"""Static browser-boundary regressions for every shipped frontend asset."""

from pathlib import Path
import re
from urllib.parse import unquote


_DASHBOARD = Path(__file__).resolve().parents[1] / "frontend" / "dashboard.html"
_DASHBOARD_JS = Path(__file__).resolve().parents[1] / "frontend" / "dashboard.js"
_ONBOARDING = Path(__file__).resolve().parents[1] / "frontend" / "onboarding.html"
_ONBOARDING_JS = Path(__file__).resolve().parents[1] / "frontend" / "onboarding.js"
_EVENT_ATTRIBUTE = re.compile(r"\son[a-z]+\s*=", re.IGNORECASE)
_QUOTED_EVENT_ATTRIBUTE = re.compile(r"['\"`]\s*on[a-z]+\s*=", re.IGNORECASE)


def test_dashboard_has_no_automatic_third_party_fetches_or_assets() -> None:
    assets = [
        _DASHBOARD.read_text(encoding="utf-8"),
        _DASHBOARD_JS.read_text(encoding="utf-8"),
        _ONBOARDING.read_text(encoding="utf-8"),
        _ONBOARDING_JS.read_text(encoding="utf-8"),
    ]
    source = "\n".join(assets)

    assert "fonts.googleapis.com" not in source
    assert "unpkg.com" not in source
    assert "api.open-meteo.com" not in source
    assert "raw.githubusercontent.com" not in source
    assert "api.github.com/repos/" not in source
    assert "fetch('http" not in source
    assert 'fetch("http' not in source


def test_external_links_open_without_opener_access() -> None:
    html = _DASHBOARD.read_text(encoding="utf-8")

    assert 'target="_blank"' not in html or 'rel="noopener noreferrer"' in html


def test_dashboard_uses_only_external_javascript_and_no_inline_handlers() -> None:
    html = _DASHBOARD.read_text(encoding="utf-8")
    js = _DASHBOARD_JS.read_text(encoding="utf-8")
    onboarding = _ONBOARDING.read_text(encoding="utf-8")
    onboarding_js = _ONBOARDING_JS.read_text(encoding="utf-8")

    assert '<script src="/static/dashboard.js"></script>' in html
    assert '<script src="/static/onboarding.js"></script>' in onboarding
    assert "<script>" not in html
    assert "<script>" not in onboarding
    assert not _EVENT_ATTRIBUTE.search(html)
    assert not _EVENT_ATTRIBUTE.search(onboarding)
    # DOM0 properties registered from same-origin JavaScript are permitted;
    # only HTML strings that would become CSP-blocked inline attributes are not.
    assert not _QUOTED_EVENT_ATTRIBUTE.search(js)
    assert not _QUOTED_EVENT_ATTRIBUTE.search(onboarding_js)
    assert "new Function" not in js
    assert "eval(" not in js
    assert "new Function" not in onboarding_js
    assert "eval(" not in onboarding_js


def test_every_dynamic_action_is_covered_by_the_static_dispatch_contract() -> None:
    js = _DASHBOARD_JS.read_text(encoding="utf-8")
    values = [unquote(value) for _event, value in re.findall(
        r'data-ob-(click|change|input|submit|keydown|mouseenter|mouseleave)="([^"]+)"', js
    )]
    registered = set(re.findall(r"'([A-Za-z][A-Za-z0-9_]*)'", js.split("const _OB_DYNAMIC_CALLS", 1)[1].split("]);", 1)[0]))
    direct_calls = {
        match.group(1)
        for value in values
        for match in re.finditer(r"(?:^|;)([A-Za-z_$][A-Za-z0-9_$]*)\(", value)
    }
    direct_calls.discard("if")  # handled explicitly by the confirm-delete branch
    assert direct_calls <= registered
    assert "planAction" in direct_calls  # quoted, comma-separated arguments
    assert "toggleBucketSelection" in direct_calls  # element dataset + boolean argument
    assert "replace(/\\\\'/g, \"'\")" in js
    assert set(re.findall(r'data-ob-action="([a-z-]+)"', js)) <= {
        "bucket-page", "scroll-field", "copy-ob-error"
    }
    for action in ("bucket-page", "scroll-field", "copy-ob-error"):
        assert f"'{action}'" in js


def test_dashboard_never_places_a_log_path_in_the_dom() -> None:
    js = _DASHBOARD_JS.read_text(encoding="utf-8")

    assert "d.log_file ||" not in js
    assert "meta.title =" not in js
    assert "d.log_file_name" in js
