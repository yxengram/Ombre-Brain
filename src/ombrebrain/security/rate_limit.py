"""Small cross-thread, fail-fast quotas for public MCP tool calls."""

from __future__ import annotations

import threading
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Iterable


WINDOW_SECONDS = 60.0
MAX_PRINCIPALS = 4096


@dataclass(frozen=True)
class Quota:
    calls_per_window: int
    max_concurrent: int


@dataclass(frozen=True)
class QuotaRejection:
    error_code: str
    category: str


@dataclass
class _PrincipalState:
    timestamps: dict[str, deque[float]] = field(default_factory=dict)
    in_flight: dict[str, int] = field(default_factory=dict)
    last_seen: float = 0.0


_QUOTAS = {
    "all": Quota(calls_per_window=120, max_concurrent=8),
    "write": Quota(calls_per_window=30, max_concurrent=2),
    "provider": Quota(calls_per_window=20, max_concurrent=2),
}


class MCPRateLimiter:
    """In-memory principal quota with no waits and no event-loop affinity."""

    def __init__(
        self,
        *,
        quotas: dict[str, Quota] | None = None,
        max_principals: int = MAX_PRINCIPALS,
        clock=time.monotonic,
    ) -> None:
        self._quotas = dict(quotas or _QUOTAS)
        self._max_principals = max(1, int(max_principals))
        self._clock = clock
        self._states: OrderedDict[str, _PrincipalState] = OrderedDict()
        self._lock = threading.Lock()

    def _categories(self, categories: Iterable[str]) -> tuple[str, ...]:
        # Every MCP operation consumes the global category once.  A tuple makes
        # the check/release order deterministic and ignores accidental repeats.
        selected = ["all"]
        for category in categories:
            if category in self._quotas and category not in selected:
                selected.append(category)
        return tuple(selected)

    def _prune_state(self, state: _PrincipalState, now: float) -> None:
        cutoff = now - WINDOW_SECONDS
        for category, values in state.timestamps.items():
            while values and values[0] <= cutoff:
                values.popleft()

    @staticmethod
    def _idle(state: _PrincipalState) -> bool:
        return not any(state.in_flight.values())

    def _trim(self, now: float) -> None:
        # Prefer evicting stale/inactive records.  Active requests are never
        # dropped; at peak the map can transiently exceed its cap only when all
        # records are executing, which preserves correct release accounting.
        cutoff = now - WINDOW_SECONDS
        for principal, state in list(self._states.items()):
            self._prune_state(state, now)
            if self._idle(state) and state.last_seen <= cutoff:
                self._states.pop(principal, None)
        while len(self._states) > self._max_principals:
            evicted = False
            for principal, state in self._states.items():
                if self._idle(state):
                    self._states.pop(principal, None)
                    evicted = True
                    break
            if not evicted:
                return

    def try_acquire(
        self, principal: str, categories: Iterable[str]
    ) -> QuotaRejection | None:
        """Reserve quota atomically, returning immediately on any rejection."""

        normalized = str(principal or "local:stdio")[:160]
        selected = self._categories(categories)
        now = self._clock()
        with self._lock:
            self._trim(now)
            state = self._states.get(normalized)
            if state is None:
                # All retained records are active: do not evict one and lose
                # its release accounting, and do not grow beyond the promised
                # bounded principal map.  This is a fail-fast overload signal.
                if len(self._states) >= self._max_principals:
                    for old_principal, old_state in self._states.items():
                        if self._idle(old_state):
                            self._states.pop(old_principal, None)
                            break
                    if len(self._states) >= self._max_principals:
                        return QuotaRejection("OB-MCP-BUSY", "principals")
                state = _PrincipalState()
                self._states[normalized] = state
            self._states.move_to_end(normalized)
            self._prune_state(state, now)
            for category in selected:
                quota = self._quotas[category]
                if state.in_flight.get(category, 0) >= quota.max_concurrent:
                    return QuotaRejection("OB-MCP-BUSY", category)
                if len(state.timestamps.setdefault(category, deque())) >= quota.calls_per_window:
                    return QuotaRejection("OB-MCP-RATE-LIMITED", category)
            for category in selected:
                state.timestamps.setdefault(category, deque()).append(now)
                state.in_flight[category] = state.in_flight.get(category, 0) + 1
            state.last_seen = now
        return None

    def release(self, principal: str, categories: Iterable[str]) -> None:
        """Release only concurrency reservations; rate events remain recorded."""

        normalized = str(principal or "local:stdio")[:160]
        selected = self._categories(categories)
        now = self._clock()
        with self._lock:
            state = self._states.get(normalized)
            if state is None:
                return
            for category in selected:
                current = state.in_flight.get(category, 0)
                if current > 1:
                    state.in_flight[category] = current - 1
                else:
                    state.in_flight.pop(category, None)
            state.last_seen = now
            self._states.move_to_end(normalized)
            self._trim(now)


DEFAULT_MCP_RATE_LIMITER = MCPRateLimiter()
