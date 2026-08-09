"""桶存储所用的纯 YAML frontmatter 归一化函数。

这里不持有 vault、缓存、锁或运行时状态。``BucketManager`` 仍从既有私有静态
入口暴露同一函数对象；本包路径则是唯一的 canonical implementation。
"""

from __future__ import annotations

import math
from datetime import date, datetime
from typing import Any


MAX_METADATA_DEPTH = 16
MAX_METADATA_NODES = 10_000


def sanitize_float_field(value: Any, default: float) -> float:
    """从历史标量形式取有限数值，并钳制到 0..1。"""
    if isinstance(value, (int, float)):
        numeric = float(value)
        if not math.isfinite(numeric):
            return default
        return max(0.0, min(1.0, numeric))
    try:
        import re

        numbers = re.findall(r"[-+]?\d*\.?\d+", str(value))
        if not numbers:
            return default
        numeric = float(numbers[0])
        if not math.isfinite(numeric):
            return default
        return max(0.0, min(1.0, numeric))
    except Exception:
        return default


def normalize_metadata_value(
    value: Any,
    *,
    _depth: int = 0,
    _seen: set[int] | None = None,
    _budget: list[int] | None = None,
) -> Any:
    """返回有界、无 alias、可安全供 JSON 使用的 YAML metadata。

    SafeLoader 会拦截对象构造，却允许递归和共享 alias；在解析后的
    frontmatter 图进入 JSON 消费端前，拒绝重复容器并限制图展开规模。
    """
    if _depth > MAX_METADATA_DEPTH:
        raise ValueError("bucket metadata exceeds nesting-depth limit")
    if _seen is None:
        _seen = set()
    if _budget is None:
        _budget = [MAX_METADATA_NODES]
    _budget[0] -= 1
    if _budget[0] < 0:
        raise ValueError("bucket metadata exceeds node limit")
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (bytes, bytearray, memoryview, set, frozenset)):
        raise ValueError(
            f"bucket metadata contains non-JSON-safe value: {type(value).__name__}"
        )
    if isinstance(value, dict):
        identity = id(value)
        if identity in _seen:
            raise ValueError("bucket metadata contains recursive/shared aliases")
        _seen.add(identity)
        normalized: dict[str, Any] = {}
        for key, item in value.items():
            if isinstance(key, datetime):
                normalized_key = key.isoformat()
            elif isinstance(key, date):
                normalized_key = key.isoformat()
            elif key is None or isinstance(key, (str, bool, int)):
                normalized_key = str(key)
            elif isinstance(key, float) and math.isfinite(key):
                normalized_key = str(key)
            else:
                raise ValueError("bucket metadata contains a non-JSON mapping key")
            if normalized_key in normalized:
                raise ValueError("bucket metadata contains colliding normalized keys")
            normalized[normalized_key] = normalize_metadata_value(
                item,
                _depth=_depth + 1,
                _seen=_seen,
                _budget=_budget,
            )
        return normalized
    if isinstance(value, (list, tuple)):
        identity = id(value)
        if identity in _seen:
            raise ValueError("bucket metadata contains recursive/shared aliases")
        _seen.add(identity)
        return [
            normalize_metadata_value(
                item,
                _depth=_depth + 1,
                _seen=_seen,
                _budget=_budget,
            )
            for item in value
        ]
    raise ValueError(f"bucket metadata contains unsupported scalar: {type(value).__name__}")
