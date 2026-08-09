"""供健康检查与 MCP 响应使用的稳定、非敏感进程元数据。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import re
import subprocess
import os

from ombrebrain.maintenance.code_fingerprint import fingerprint_code_tree


_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")


@dataclass(frozen=True)
class RuntimeMetadata:
    """进程启动时只计算一次，绝不从请求数据派生的值。"""

    version: str
    git_commit: str
    code_fingerprint: str
    deployed_at: str

    def to_public_dict(self) -> dict[str, str]:
        """返回不含路径、配置或密钥的安全部署身份。"""
        return {
            "version": self.version,
            "git_commit": self.git_commit,
            "code_fingerprint": self.code_fingerprint,
            "deployed_at": self.deployed_at,
        }


def build_runtime_metadata(repo_root: str | Path, version: str) -> RuntimeMetadata:
    """构建稳定进程身份；无源码镜像也有安全的降级值。"""
    root = Path(repo_root).resolve()
    return RuntimeMetadata(
        version=str(version or "0.0.0+unknown"),
        git_commit=_git_commit(root),
        code_fingerprint=_code_fingerprint(root),
        deployed_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    )


def _git_commit(root: Path) -> str:
    """优先返回 git commit；无 git 镜像可使用已校验的构建注入值。"""
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            check=False,
            capture_output=True,
            text=True,
            timeout=1,
        )
    except (OSError, subprocess.SubprocessError):
        completed = None
    if completed is not None:
        commit = completed.stdout.strip().lower()
        if completed.returncode == 0 and _COMMIT_RE.fullmatch(commit):
            return commit
    # Docker 的源码层通常不含 .git。此变量由 Docker build ARG 写入镜像环境，
    # 仅接受完整 SHA-1，拒绝任意文本、路径和密钥，且 git 可用时永远以 git 为准。
    injected = os.environ.get("OMBRE_BUILD_COMMIT", "").strip().lower()
    return injected if _COMMIT_RE.fullmatch(injected) else "unknown"


def _code_fingerprint(root: Path) -> str:
    """复用规范代码树指纹，且绝不暴露内部失败详情。"""
    try:
        return fingerprint_code_tree(root)
    except (OSError, ValueError):
        return "unavailable"
