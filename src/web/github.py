"""
========================================
web/github.py — GitHub 同步配置与触发
========================================

把所有 bucket .md 备份到 GitHub 仓库。状态/保存配置/验证/立即同步四个路由。

状态共享：github 实例存在 sh.github_sync_instance（server.py 的后台定时同步循环
_github_sync_loop / _restart_github_auto_task 也读 sh.github_sync_instance，
保证这里改了实例后台循环立刻看到）。后台任务起停走 sh.restart_github_auto_task。

对外暴露：register(mcp)。
========================================
"""

import asyncio
import os
import shutil
import stat
import time
import uuid
import zipfile
from pathlib import Path

from starlette.requests import Request
from starlette.responses import Response

from . import _shared as sh

logger = sh.logger
_import_lock = asyncio.Lock()


class PreImportBackupSafetyError(RuntimeError):
    """The existing vault cannot be safely snapshotted before overwrite."""

try:
    from github_sync import GitHubSync  # type: ignore
    from utils import parse_bool, atomic_update_config_yaml  # type: ignore
except ImportError:  # pragma: no cover
    from ..github_sync import GitHubSync  # type: ignore
    from ..utils import parse_bool, atomic_update_config_yaml  # type: ignore


def _save_github_config_to_disk(gh_cfg: dict) -> None:
    """把 github_sync 这一个 key 原子写回 config.yaml，失败即抛异常。

    走 utils.atomic_update_config_yaml 共用锁 + 原子写 + 读回校验，
    不再是「open(w) 直接整份覆盖、失败只记 warning」——那样调用方会误以为保存成功，
    内存里的新配置在下次重启（崩溃/热更新/手动重启按钮）读盘时被这份没写成功的旧文件覆盖，
    表现为「填好过一两个小时自动清空」。"""
    atomic_update_config_yaml(lambda save_config: save_config.__setitem__("github_sync", gh_cfg))


def _pre_import_backup(buckets_dir: str) -> str:
    """导入前把当前所有 .md 打成 zip 存到 <buckets_dir>/.import_backups/。

    只接受真实的普通 Markdown 文件，遇到任意符号链接即失败关闭；恢复前的
    后悔药绝不能把 vault 外部的内容经由链接带入 zip。一般 IO 失败返回空串，
    由调用者的 force 闸门处理；安全失败则抛出不可绕过的异常。
    """
    zpath: Path | None = None
    try:
        raw_vault = Path(buckets_dir)
        if raw_vault.is_symlink():
            raise PreImportBackupSafetyError("记忆目录必须是非链接目录")
        vault = raw_vault.resolve(strict=True)
        if not vault.is_dir():
            raise PreImportBackupSafetyError("记忆目录必须是非链接目录")
        bdir = vault / ".import_backups"
        bdir.mkdir(mode=0o700, exist_ok=True)
        if bdir.is_symlink() or not bdir.is_dir():
            raise PreImportBackupSafetyError("导入备份目录必须是非链接目录")
        ts = time.strftime("%Y%m%d_%H%M%S")
        unique = f"{time.time_ns()}_{uuid.uuid4().hex[:8]}"
        zpath = bdir / f"pre_import_{ts}_{unique}.zip"
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            for root, dirs, files in os.walk(vault, followlinks=False):
                root_path = Path(root)
                checked_dirs: list[str] = []
                for dirname in dirs:
                    candidate = root_path / dirname
                    if candidate.is_symlink():
                        raise PreImportBackupSafetyError("记忆目录包含符号链接，已拒绝导入前备份")
                    if dirname != ".import_backups":
                        checked_dirs.append(dirname)
                dirs[:] = checked_dirs
                if root_path == bdir:
                    continue
                for fn in files:
                    full = root_path / fn
                    try:
                        file_stat = os.lstat(full)
                    except OSError as exc:
                        raise PreImportBackupSafetyError("无法安全读取记忆文件") from exc
                    if stat.S_ISLNK(file_stat.st_mode):
                        raise PreImportBackupSafetyError("记忆目录包含符号链接，已拒绝导入前备份")
                    if not stat.S_ISREG(file_stat.st_mode) or full.suffix != ".md":
                        continue
                    try:
                        relative = full.relative_to(vault)
                    except ValueError as exc:  # Defensive: os.walk should never escape vault.
                        raise PreImportBackupSafetyError("记忆备份路径越界") from exc
                    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                    fd = os.open(full, flags)
                    try:
                        opened = os.fstat(fd)
                        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (file_stat.st_dev, file_stat.st_ino):
                            raise PreImportBackupSafetyError("记忆文件在备份期间发生变化")
                        with os.fdopen(fd, "rb") as source, z.open(relative.as_posix(), "w") as destination:
                            fd = -1
                            shutil.copyfileobj(source, destination, length=64 * 1024)
                    finally:
                        if fd >= 0:
                            os.close(fd)
        return str(zpath)
    except PreImportBackupSafetyError:
        if zpath is not None:
            try:
                zpath.unlink(missing_ok=True)
            except OSError:
                pass
        raise
    except Exception as exc:
        logger.warning("github pre-import backup failed exception_type=%s", type(exc).__name__)
        return ""


def register(mcp) -> None:

    @mcp.custom_route("/api/github/status", methods=["GET"])
    async def api_github_status(request: Request) -> Response:
        from starlette.responses import JSONResponse
        err = sh._require_auth(request)
        if err:
            return err
        _gh_cfg_now = sh.config.get("github_sync", {}) or {}
        _auto_min = int(_gh_cfg_now.get("auto_interval_minutes") or 0)
        _token_set = bool(
            os.environ.get("OMBRE_GITHUB_TOKEN") or _gh_cfg_now.get("token")
        )
        if sh.github_sync_instance is None:
            return JSONResponse({
                "ok": True,
                "configured": False,
                "repo": _gh_cfg_now.get("repo", ""),
                "branch": _gh_cfg_now.get("branch", "main"),
                "path_prefix": _gh_cfg_now.get("path_prefix", "ombre"),
                "include_media": bool(_gh_cfg_now.get("include_media", False)),
                "token_set": _token_set,
                "auto_interval_minutes": _auto_min,
            })
        return JSONResponse({
            "ok": True,
            "configured": True,
            "token_set": _token_set,
            "auto_interval_minutes": _auto_min,
            **sh.github_sync_instance.status(),
        })

    @mcp.custom_route("/api/github/config", methods=["POST"])
    async def api_github_config(request: Request) -> Response:
        from starlette.responses import JSONResponse
        err = sh._require_auth(request)
        if err:
            return err
        try:
            body = await sh._read_json_object(request)
        except Exception:
            return JSONResponse({"ok": False, "error": "无效 JSON"}, status_code=400)

        if "clear" in body and not isinstance(body["clear"], bool):
            return JSONResponse(
                {"ok": False, "error": "clear 必须是布尔值"},
                status_code=400,
            )
        if "include_media" in body and not isinstance(body["include_media"], bool):
            return JSONResponse(
                {"ok": False, "error": "include_media 必须是布尔值"},
                status_code=400,
            )
        string_fields = ("token", "repo", "branch", "path_prefix")
        if any(key in body and not isinstance(body[key], str) for key in string_fields):
            return JSONResponse({"ok": False, "error": "GitHub 配置字段必须是字符串"}, status_code=400)

        supplied = {
            key: str(body[key]).strip()
            for key in string_fields
            if key in body
        }
        if any(len(supplied.get(key, "")) > limit for key, limit in (
            ("token", 8192),
            ("repo", 255),
            ("branch", 255),
            ("path_prefix", 512),
        )):
            return JSONResponse({"ok": False, "error": "GitHub 配置字段过长"}, status_code=400)
        if any("\n" in value or "\r" in value for value in supplied.values()):
            return JSONResponse({"ok": False, "error": "GitHub 配置不能包含换行"}, status_code=400)

        current_cfg = dict(sh.config.get("github_sync", {}) or {})
        try:
            auto_raw = (
                body["auto_interval_minutes"]
                if "auto_interval_minutes" in body
                else current_cfg.get("auto_interval_minutes", 0)
            )
            if isinstance(auto_raw, bool):
                raise ValueError("boolean is not an interval")
            auto_interval = int(auto_raw or 0)
        except (TypeError, ValueError, OverflowError):
            return JSONResponse({"ok": False, "error": "auto_interval_minutes 必须是整数"}, status_code=400)
        if not 0 <= auto_interval <= 10_080:
            return JSONResponse({"ok": False, "error": "auto_interval_minutes 必须在 0-10080 之间"}, status_code=400)

        if body.get("clear") is True:
            # 清空是破坏性操作，只接受显式 clear=true。空表单或部分
            # 更新绝不能再被误解为「删掉 token/repo」。
            gh_cfg = {
                "repo": "",
                "branch": supplied.get("branch") or "main",
                "path_prefix": supplied.get("path_prefix", "ombre"),
                "auto_interval_minutes": 0,
                "include_media": False,
            }
            try:
                _save_github_config_to_disk(gh_cfg)
            except Exception as exc:
                return JSONResponse(
                    sh.unexpected_api_error("github.config_clear", exc), status_code=500
                )
            sh.github_sync_instance = None
            sh.restart_github_auto_task(0)
            sh.config["github_sync"] = gh_cfg
            return JSONResponse({
                "ok": True,
                "message": "已清空 GitHub 同步配置",
                "configured": False,
                "token_set": bool(os.environ.get("OMBRE_GITHUB_TOKEN")),
            })

        # 持久化到 config.yaml（含 token，config.yaml 是 bind mount 重启不丢）。
        # 先落盘、落盘成功才更新内存里的 sh.config / github_sync_instance——
        # 避免「内存里已经是新配置、但磁盘还是旧的」这种半保存状态在下次重启时丢数据。
        gh_cfg = current_cfg
        # Secret inputs are write-only: an empty token means "keep the saved
        # token", never "erase it".  Empty repo follows the same safe partial
        # update rule; explicit clear=true is the only erasure path.
        if supplied.get("token"):
            gh_cfg["token"] = supplied["token"]
        if supplied.get("repo"):
            gh_cfg["repo"] = supplied["repo"]
        if "branch" in supplied:
            gh_cfg["branch"] = supplied["branch"] or "main"
        else:
            gh_cfg.setdefault("branch", "main")
        if "path_prefix" in supplied:
            # Empty is meaningful here: it selects the repository root.
            gh_cfg["path_prefix"] = supplied["path_prefix"]
        else:
            gh_cfg.setdefault("path_prefix", "ombre")
        gh_cfg["auto_interval_minutes"] = auto_interval
        if "include_media" in body:
            gh_cfg["include_media"] = body["include_media"]
        else:
            gh_cfg.setdefault("include_media", False)
        try:
            _save_github_config_to_disk(gh_cfg)
        except Exception as exc:
            return JSONResponse(
                sh.unexpected_api_error("github.config_save", exc), status_code=500
            )

        sh.config["github_sync"] = gh_cfg
        # 重建实例。平台环境 token 与启动时语义一致，优先于磁盘值。
        _tok = str(
            os.environ.get("OMBRE_GITHUB_TOKEN") or gh_cfg.get("token") or ""
        ).strip()
        repo = str(gh_cfg.get("repo") or "").strip()
        branch = str(gh_cfg.get("branch") or "main").strip() or "main"
        path_prefix = str(gh_cfg.get("path_prefix", "ombre") or "").strip()
        if _tok and repo:
            sh.github_sync_instance = GitHubSync(
                token=_tok,
                repo=repo,
                branch=branch,
                path_prefix=path_prefix,
                max_source_bytes=int(
                    (sh.config.get("limits") or {}).get(
                        "max_grow_input_bytes", 2 * 1024 * 1024
                    )
                ),
                include_media=bool(gh_cfg.get("include_media", False)),
            )
            sh.restart_github_auto_task(auto_interval)
        else:
            sh.github_sync_instance = None
            sh.restart_github_auto_task(0)
        return JSONResponse({
            "ok": True,
            "message": "配置已保存",
            "configured": sh.github_sync_instance is not None,
            "token_set": bool(_tok),
        })

    @mcp.custom_route("/api/github/validate", methods=["POST"])
    async def api_github_validate(request: Request) -> Response:
        from starlette.responses import JSONResponse
        err = sh._require_auth(request)
        if err:
            return err
        if sh.github_sync_instance is None:
            return JSONResponse({"ok": False, "error": "尚未配置 GitHub 同步"}, status_code=400)
        result = await sh.github_sync_instance.validate()
        return JSONResponse(result)

    @mcp.custom_route("/api/github/sync", methods=["POST"])
    async def api_github_sync(request: Request) -> Response:
        from starlette.responses import JSONResponse
        err = sh._require_auth(request)
        if err:
            return err
        if sh.github_sync_instance is None:
            return JSONResponse({"ok": False, "error": "尚未配置 GitHub 同步，请先填写配置并保存"}, status_code=400)
        buckets_dir = sh.config.get("buckets_dir", "")
        if not buckets_dir:
            return JSONResponse(
                {"ok": False, "error_code": "OB-WEB-MISCONFIGURED", "error": "服务存储尚未配置"},
                status_code=500,
            )
        result = await sh.github_sync_instance.sync(buckets_dir)
        return JSONResponse(result)

    @mcp.custom_route("/api/github/import", methods=["POST"])
    async def api_github_import(request: Request) -> Response:
        """从 GitHub 拉回记忆（恢复 / 回滚）。⚠️ 会覆盖本地同名记忆。

        合并覆盖语义 + 导入前自动 zip 备份本地（可退回）。导入后建议跑 backfill 重建
        向量（前端会自动接着调 /api/embedding/backfill）。embeddings.db 不在仓库里。
        """
        from starlette.responses import JSONResponse
        err = sh._require_auth(request)
        if err:
            return err
        if sh.github_sync_instance is None:
            return JSONResponse({"ok": False, "error": "尚未配置 GitHub 同步，请先填写配置并保存"}, status_code=400)
        buckets_dir = sh.config.get("buckets_dir", "")
        if not buckets_dir:
            return JSONResponse(
                {"ok": False, "error_code": "OB-WEB-MISCONFIGURED", "error": "服务存储尚未配置"},
                status_code=500,
            )
        try:
            body = await sh._read_json_object(request)
        except Exception:
            return JSONResponse({"ok": False, "error": "无效 JSON"}, status_code=400)
        try:
            force = parse_bool(body.get("force", False))
        except ValueError:
            return JSONResponse(sh.invalid_api_input_error(), status_code=400)
        async with _import_lock:
            # 1) 导入前自动备份本地（合并覆盖会改动本地，留个后悔药）
            try:
                backup = _pre_import_backup(buckets_dir)
            except PreImportBackupSafetyError:
                return JSONResponse({
                    "ok": False,
                    "error": "检测到不安全的记忆目录链接，已取消导入以保护本地数据。",
                    "backup_failed": True,
                    "backup_unsafe": True,
                }, status_code=409)
            # 记忆安全闸门：备份没成功就默认不动本地记忆——覆盖不可逆，宁可拦下。
            # 用户确认愿意冒险（force=true）才放行，并如实标注这次没有后悔药。
            if not backup and not force:
                return JSONResponse({
                    "ok": False,
                    "error": "导入前的本地备份没有成功，为避免覆盖后无法找回记忆，已取消本次导入。"
                             "请检查数据目录是否可写、磁盘是否有空间后重试；确要强制导入可带 force=true。",
                    "backup_failed": True,
                }, status_code=409)
            # 2) 从 GitHub 拉回。GitHubSync 内部再与定时 sync 共用同一把锁。
            result = await sh.github_sync_instance.import_from_github(buckets_dir)
            result["pre_import_backup"] = backup
            # 3) 让 bucket_mgr 的 BM25 索引失效（导入直写磁盘，绕过了 bucket_mgr 的脏标记）
            try:
                if sh.bucket_mgr is not None:
                    sh.bucket_mgr._invalidate_bm25()
            except Exception:
                pass
        return JSONResponse(result)
