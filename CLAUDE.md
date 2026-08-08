# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Ombre Brain (OB) is a long-term emotional memory system for LLMs, exposed as an MCP server (15 tools on a single `/mcp` connector) plus a REST/Dashboard web layer. Memories are Markdown files with YAML frontmatter (Obsidian-compatible), tagged with Russell valence/arousal coordinates, retrieved via a hybrid of rapidfuzz + BM25 keyword search and cosine vector similarity, and aged out by an Ebbinghaus-style decay engine. Full behavior spec: [docs/INTERNALS.md](docs/INTERNALS.md). Model-facing usage contract: [docs/CLAUDE_PROMPT.md](docs/CLAUDE_PROMPT.md).

Do not confuse the two audiences: `docs/CLAUDE_PROMPT.md` and the first-person-principle rules below govern text the *product* shows to the LLM using it as memory. This CLAUDE.md governs how *you*, Claude Code, work on the codebase.

## Working rules

This is a **personal fork** (`origin` = `yxengram/Ombre-Brain`) maintained solo by the repo owner, tracking the upstream project (`upstream` = `P0luz/Ombre-Brain`). The owner decides everything here; `main` is the working branch and pushes go straight to `origin main`. `upstream` is a read-only reference for pulling changes — never push there.

[rule.md](rule.md) holds the product's philosophical boundaries and remains the single source of truth for memory semantics — dozens of source comments cite it by section for design rationale and magic-number justification. Read it before nontrivial changes. Rules that actually change how you operate here:

- **Respond in Chinese**, including reasoning/thinking, commit message bodies, and code comments — the owner works in Chinese. Exception: identifiers, function names, API fields, CLI commands, raw error text, and error codes (e.g. `OB-W005`) stay in their original technical form. (Only relaxed if the owner explicitly asks otherwise in a given session.)
- **Stop and ask instead of guessing** when a decision touches a philosophical boundary in `rule.md` (memory semantics, decay, `I`/plan/anchor/pinned structure) and the project has no documented stance. Ordinary engineering calls don't need a check-in.
- **Use git locally to track this project's edit history** — commit completed changes as you go, so the working tree stays under version control. Never `git push` (to `origin`, `upstream`, or anywhere else) unless the owner explicitly asks for that push in the given session.
- **Environment variable names**: [docs/ENVIRONMENT_VARIABLES.md](docs/ENVIRONMENT_VARIABLES.md) is the single source of truth. Never silently rename or drop an existing env var — keep a compat alias, deprecation note, and migration/regression test if you must rename one. A silent rename means existing deployments lose their key on upgrade.
- **Versioning**: bumping code requires updating *both* `VERSION` and `src/VERSION` to the same value (runtime reads `src/VERSION` first; hot-update only refreshes `src/`, so the root file drifts). Patch bump for bug fixes, minor bump (reset patch to 0) for new features, major never moves without explicit direction.
- **Never point tests, cleanup, or "reset the environment" operations at the real `buckets/` directory** — it holds actual memory data, and per `rule.md` §1 nobody has the right to physically erase it. Tests already isolate themselves via `tests/conftest.py` (temp `OMBRE_VAULT_DIR`); manual verification must use a dedicated test vault, never anything that could be a real one.
- Never put real API keys, Dashboard passwords, or OAuth/Tunnel tokens into chat, commit messages, comments, or committed files — use variable names and placeholders.
- Delete temporary scripts and scratch files once the work lands; don't commit them.

## Commands

Install (dev, from a venv):
```bash
pip install --require-hashes -r requirements-dev.lock.txt
```

Run the server locally (stdio by default; needs a real dehydration/embedding API key unless embedding is disabled):
```bash
cp config.example.yaml config.yaml
python src/server.py
```

Lint (must be clean; matches CI):
```bash
ruff check src tools deploy tests
```

Security checks (matches CI):
```bash
bandit -r src tools deploy -ll -ii -q
pip-audit -r requirements.lock.txt
```

**Upgrading dependencies.** CI pins a package-index snapshot via `UV_EXCLUDE_NEWER` in `.github/workflows/ci.yml`, regenerates both lockfiles from scratch, and fails on any diff. `pip-audit` meanwhile checks the *live* vulnerability DB. So whenever a CVE lands against a package whose fix was published after the snapshot date, CI deadlocks — the lock step can only produce the vulnerable version, and pip-audit rejects it. This is structural, not a flake; it recurs. The fix is always: advance `UV_EXCLUDE_NEWER` past the fix's release date, then regenerate both locks with the *same* uv version CI pins (`uv==0.11.23`, from `requirements-dev.in`), passing the cutoff by env var — never `--exclude-newer`, which `tests/test_update_source_gate.py` forbids because uv would write it into the lock header.

```bash
rm -f requirements.lock.txt requirements-dev.lock.txt
UV_EXCLUDE_NEWER='<new-cutoff>Z' uv pip compile requirements.txt --universal --python-version 3.12 --generate-hashes --output-file requirements.lock.txt
UV_EXCLUDE_NEWER='<new-cutoff>Z' uv pip compile requirements-dev.in --universal --python-version 3.12 --generate-hashes --output-file requirements-dev.lock.txt
```

Advancing the snapshot re-resolves *everything* (the step deletes both locks and compiles with no `--upgrade`, so there is no pin preference) — diff old against new and check what moved before trusting a green run. Establish a local test baseline before the bump so post-bump failures are attributable.

Full test suite (matches CI; tests run against an isolated temp vault regardless of your real config — see `tests/conftest.py`):
```bash
python -m pytest tests -q --asyncio-mode=auto --cov=src --cov-report=term-missing
```

Fast check after any change — run this before declaring a change done:
```bash
pytest tests/ -x --tb=short -q
```

Single test file / single test:
```bash
python -m pytest tests/test_scoring.py -q --asyncio-mode=auto
python -m pytest tests/test_scoring.py::TestTimeWeight::test_half_life_25h -q --asyncio-mode=auto
```

LLM-quality and Docker-integration suites are excluded from the fast loop — they need a real `OMBRE_COMPRESS_API_KEY` or a running Docker MCP stack (see `.github/workflows/ci.yml` for the exact stub/container setup):
```bash
python -m pytest tests/test_llm_quality.py -v --asyncio-mode=auto
python -m pytest tests/test_mcp_tools_docker_integration.py -q --timeout=60
python -m pytest tests/test_web_api_docker_integration.py -q --timeout=120
```

Docker build/run (from source):
```bash
docker compose -f deploy/docker-compose.yml up -d
curl http://localhost:18001/health
```

A change is only "done" when tests are green *and* a real Docker build/up has been exercised for anything beyond a trivial logic change; unit tests alone have missed real deployment breakage before (e.g. a `.dockerignore` excluding `deploy/` broke every Docker build while 596 unit tests stayed green).

## Architecture

### Entry point and assembly

Fixed entry point: `python src/server.py`. It builds every engine (bucket manager, decay engine, dehydrator, embedding engine, import engine), injects them into `tools/_runtime.py` (dependency container for the MCP tool layer), and calls `web.register_all(mcp)` to mount the HTTP/Dashboard layer. All 15 MCP tools are `@mcp.tool()` thin wrappers on the single public `/mcp` connector.

```
src/server.py  →  tools._runtime.init(...)        (MCP tool layer)
               →  web.register_all(mcp)            (HTTP/Dashboard layer)
                        │
        ┌───────────────┼────────────────┬──────────────────┐
        ▼                ▼                ▼                  ▼
 bucket_manager    decay_engine      dehydrator        embedding_engine
 (CRUD+search,     (Ebbinghaus       (LLM analyze/      (facade + single
  +bm25_index)      score/archive)    merge/digest)      OpenAI-compat backend)
        └────────────────┴────────────────┴──────────────────┘
                                  ▼
                              utils.py   (config load, IDs, path safety, token estimate)
```

Dependency rules enforced by convention (not by tooling — respect them when adding code): `bucket_manager` must never call `decay_engine` directly (avoids a cycle); `embedding_engine` is injected into `BucketManager`, never imported back; `tools/*` only reach dependencies through `tools._runtime`, never `import server`; new HTTP routes go in `web/<domain>.py` + a line in `web/register_all`, never back into `server.py`.

### `src/tools/` — MCP tool implementations

```
src/tools/
├── _runtime.py    # DI container: config / bucket_mgr / dehydrator / decay_engine / embedding_engine / ...
├── _common.py     # shared helpers: content-size limits, pinned quota, duplicate check, merge_or_create
├── breath/ hold/ grow/ dream/ trace/ anchor/ plan/ i/
```
Call path: `server.X(...)` → `tools.X.dispatch(...)` (each package's `__init__.py`) → branch function. Branches import `from .. import _runtime as rt`, never `server`.

### `src/web/` — HTTP/Dashboard routes

`src/web/<domain>.py`, one module per domain (`auth`, `oauth`, `dashboard`, `system`, `search`, `buckets`, `import_api`, `github`, `embedding`, `config_api`, `tunnel`, ...), each exporting `register(mcp)`. Shared auth/session/cookie helpers live in `web/_shared.py`. Every `/api/*` route calls the `_shared` auth helper first.

### `src/` flat modules vs. `src/ombrebrain/` package

`src/` still has top-level flat modules (`bucket_manager.py`, `decay_engine.py`, `dehydrator.py`, `embedding_engine.py`, `bm25_index.py`, `import_memory.py`, `migrate_engine.py`/`migration_engine.py`, `github_sync.py`, `utils.py`, `errors.py`, ...) alongside a growing `src/ombrebrain/` package (canonical home, e.g. `ombrebrain/storage/`, `ombrebrain/eventsourcing/`, `ombrebrain/projection/`, `ombrebrain/security/`, `ombrebrain/domain/`, `ombrebrain/retrieval/`). This is a deliberate, in-progress one-file-at-a-time migration — see [docs/SRC_PACKAGE_MIGRATION_PLAN.md](docs/SRC_PACKAGE_MIGRATION_PLAN.md). Rules if you touch a module in this space: new code imports the canonical `ombrebrain.*` path only; old top-level paths are compatibility shims kept for one release cycle; never move a stateful module (singletons, locks, caches, monkeypatch targets) without a stated object-identity plan; each file is its own migration step, independently revertable, never combined with a logic rewrite.

Separately, several `src/ombrebrain/` subpackages (`kernel/`, `microkernel/`, `fabric/`, `distributed/`, `cluster/` (incl. `raft/`), `collab/`, `decision/`, `eventsourcing/`, `policy/`, `protocol/`, `resilience/`, `architecture/`) implement a parallel "vNext"/"v3" architecture-contract layer described in `docs/INTERNALS.md` §4.3.10 — these are **shadow/diagnostic contracts and audits** (e.g. `ArchitectureAuditor`, formal invariant checkers, a Rust replay-kernel scaffold under `kernel/rust/`), not a swap-in replacement for the legacy runtime above. Don't assume code under these packages is on the live request path just because it exists; check whether it's wired into `server.py`/`web/` or only exercised by its own `test_v3_*` contract tests.

### Memory bucket lifecycle

```
hold/grow → dehydrator.analyze()/digest() → _merge_or_create()
  → bucket_mgr.search() score > merge_threshold(75)?
       yes → append + update()   |   no → create()
  → buckets/dynamic/{domain}/{name}_{id}.md   (activation_count=0)
  → embedding outbox (durable, background worker; retried, survives restarts)
  → touch() on retrieval hits only (never on passive surfacing) → last_active, activation_count+1, ±48h time-ripple
  → decay_engine.run_decay_cycle() (every 24h) → score < 0.3 → archive/  (never physically deleted)
```
`feel/`, `plans/active/`, `letters/history/` buckets are fixed-score (never decay, never auto-surface in plain `breath`) and have their own read paths — see `docs/INTERNALS.md` §2.3 before changing anything there.

### Config

Load order: env var > `config.yaml` > built-in default, resolved in `utils.load_config()` (`$OMBRE_CONFIG_PATH` → `cwd/config.yaml` → `<repo_root>/config.yaml`). New env vars must be wired in there (register in `docs/ENVIRONMENT_VARIABLES.md` too — see working rules above).

### Non-negotiable invariants (see `rule.md` for the full list)

- Memories decay/archive but are never physically erased through any tool, API, or Dashboard action — "delete" moves a file to `archive/` and hides it from recall, nothing more. The only exception is buckets explicitly created as test data.
- `touch()` fires only on retrieval hits, never on passive surfacing — this is intentional so `breath()` can't let a high-activity bucket permanently monopolize surfacing by resetting its own decay clock.
- Metadata fields describing *why*/*how* to treat a memory (e.g. "actively forgotten") never feed into decay/relevance scoring.
- Don't promote any one storage layer (Markdown, ledger, SQLite projection, vector index) to sole source of truth, and don't change core memory semantics (deletion, auto-merge, free association, dream/plan/pinned/anchor/`I`, emotion scoring) without explicit alignment with the project owner first — this is an explicit stop-and-ask trigger, not an engineering judgment call.
