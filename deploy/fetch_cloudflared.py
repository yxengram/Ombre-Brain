#!/usr/bin/env python3
"""构建期下载 cloudflared 二进制（镜像自带 python，无需 curl / apt-get update）。

背景（用户反馈 #3）：旧 Dockerfile 为了拿 curl 去下 cloudflared，先跑
`apt-get update && apt-get install curl ca-certificates`，这一步会打到 Debian
镜像源，间歇性 502 导致**整个镜像构建失败**，每次升级都要手动注释掉那几行。

cloudflared 本来就是从 GitHub Releases 直接下载的静态二进制，跟 apt 无关。这里改用
python:slim 自带的 python（系统已含 ca-certificates）直接下载，并做指数退避重试，
从根上避开 apt。不需要 Tunnel 的用户可在构建时 `--build-arg INSTALL_CLOUDFLARED=0`
完全跳过本步骤。

用法：python fetch_cloudflared.py <目标路径>
"""
from __future__ import annotations

import platform
import hashlib
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# platform.machine() → cloudflared release 资产的架构后缀
_ARCH_MAP = {
    "x86_64": "amd64",
    "amd64": "amd64",
    "aarch64": "arm64",
    "arm64": "arm64",
    "armv7l": "arm",
    "armv6l": "arm",
    "i686": "386",
    "i386": "386",
}

# Pin both the release and the per-architecture artifact digest.  Using the
# GitHub ``latest`` redirect made otherwise identical Docker builds fetch
# different, unauthenticated bytes over time.
_CLOUDFLARED_VERSION = "2026.7.1"
_SHA256 = {
    "386": "8452c2b93f2bfa89f1249bceaec128c90424e25a6ef600f57d92b1fbd0cb502f",
    "amd64": "79a0ade7fc854f62c1aaef48424d9d979e8c2fcd039189d24db82b84cd146be1",
    "arm": "17cedcb83d8239c5f81f6d57b7d50a384f0d57fd523af2763f47ac6cade77bf9",
    "arm64": "18f2c9bfc7a67a971bd96f1a5a1935def3c1e52aa386626f1566f04e9b5478d6",
}
_MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024
_TRUSTED_RELEASE_ASSET_HOSTS = frozenset(
    {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Surface redirects so their target can be checked before a second request."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ARG002
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)


def _validate_release_asset_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme != "https"
        or (parsed.hostname or "").lower() not in _TRUSTED_RELEASE_ASSET_HOSTS
        or parsed.username
        or parsed.password
        or parsed.fragment
        or parsed.port not in (None, 443)
    ):
        raise ValueError("cloudflared 重定向目标不受信任")
    return parsed.geturl()


def _open_no_redirect(request: urllib.request.Request, timeout: int):
    return _NO_REDIRECT_OPENER.open(request, timeout=timeout)


def _open_trusted_release(url: str, *, timeout: int):
    current = _validate_release_asset_url(url)
    for hop in range(4):
        req = urllib.request.Request(current, headers={"User-Agent": "OmbreBrain-Build"})
        try:
            return _open_no_redirect(req, timeout)
        except urllib.error.HTTPError as exc:
            if exc.code not in {301, 302, 303, 307, 308} or hop == 3:
                raise
            location = exc.headers.get("Location", "") if exc.headers else ""
            if not location:
                raise ValueError("cloudflared 重定向缺少 Location") from exc
            current = _validate_release_asset_url(urllib.parse.urljoin(current, location))
    raise ValueError("cloudflared 重定向过多")


def cloudflared_arch(machine: str | None = None) -> str:
    m = (machine or platform.machine()).lower()
    if m not in _ARCH_MAP:
        raise SystemExit(f"不支持的架构：{m!r}（cloudflared 无对应发行资产）")
    return _ARCH_MAP[m]


def release_url(arch: str) -> str:
    return (
        "https://github.com/cloudflare/cloudflared/releases/download/"
        f"{_CLOUDFLARED_VERSION}/cloudflared-linux-{arch}"
    )


def expected_sha256(arch: str) -> str:
    try:
        return _SHA256[arch]
    except KeyError as exc:
        raise SystemExit(f"不支持的 cloudflared 发行架构：{arch!r}") from exc


def download(
    url: str,
    dest: str,
    *,
    expected_digest: str,
    attempts: int = 5,
) -> None:
    last: Exception | None = None
    part = f"{dest}.part"
    for attempt in range(1, attempts + 1):
        try:
            with _open_trusted_release(url, timeout=60) as r, open(part, "wb") as f:
                response_headers = getattr(r, "headers", {}) or {}
                content_length = response_headers.get("Content-Length")
                if content_length:
                    try:
                        declared_bytes = int(content_length)
                    except (TypeError, ValueError) as exc:
                        raise ValueError("无效的 Content-Length") from exc
                    if declared_bytes < 0 or declared_bytes > _MAX_DOWNLOAD_BYTES:
                        raise ValueError(
                            f"下载声明体积超过 {_MAX_DOWNLOAD_BYTES} 字节上限"
                        )
                digest = hashlib.sha256()
                downloaded = 0
                while chunk := r.read(1024 * 1024):
                    downloaded += len(chunk)
                    if downloaded > _MAX_DOWNLOAD_BYTES:
                        raise ValueError(
                            f"下载实际体积超过 {_MAX_DOWNLOAD_BYTES} 字节上限"
                        )
                    digest.update(chunk)
                    f.write(chunk)
            actual_digest = digest.hexdigest()
            if actual_digest != expected_digest:
                raise ValueError(
                    "SHA-256 校验失败："
                    f"expected={expected_digest}, actual={actual_digest}"
                )
            os.replace(part, dest)
            print(
                f"[fetch_cloudflared] 下载并校验成功（第 {attempt} 次尝试）：{url}"
            )
            return
        except Exception as e:  # noqa: BLE001 - 构建期尽量重试，最后一击才失败
            last = e
            try:
                os.remove(part)
            except FileNotFoundError:
                pass
            print(f"[fetch_cloudflared] 第 {attempt}/{attempts} 次失败：{e}")
            if attempt < attempts:
                time.sleep(attempt * 3)
    raise SystemExit(f"[fetch_cloudflared] 重试 {attempts} 次仍失败：{last}")


def main(argv: list[str]) -> int:
    dest = argv[1] if len(argv) > 1 else "/usr/local/bin/cloudflared"
    arch = cloudflared_arch()
    download(
        release_url(arch),
        dest,
        expected_digest=expected_sha256(arch),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
