# Repository Guidelines

## Project Structure & Module Organization

Ombre Brain is a Python MCP and web service. `src/server.py` is the main entry point. Core runtime modules remain in `src/`, while newer canonical components live under `src/ombrebrain/`; follow `docs/SRC_PACKAGE_MIGRATION_PLAN.md` before moving code between them. MCP tools are grouped in `src/tools/`, HTTP and Dashboard routes in `src/web/`, and browser assets in `frontend/`. Operational utilities belong in `tools/`, deployment files in `deploy/`, architecture notes in `docs/`, and the experimental Rust kernel in `kernel/rust/ombre-kernel/`. Tests mirror behavior in `tests/test_*.py`.

## Build, Test, and Development Commands

- `pip install --require-hashes -r requirements-dev.lock.txt` installs the pinned development environment.
- `cp config.example.yaml config.yaml && python src/server.py` starts the local service.
- `ruff check src tools deploy tests` runs the CI lint rules.
- `pytest tests/ -x --tb=short -q` provides a fast fail-first check.
- `python -m pytest tests -q --asyncio-mode=auto --cov=src --cov-report=term-missing` runs the full suite with coverage.
- `docker compose -f deploy/docker-compose.yml up -d --build` exercises the production-style container; verify it with `curl http://localhost:18001/health`.

## Coding Style & Naming Conventions

Target Python 3.10 compatibility, use four-space indentation, and keep lines within Ruff's 120-character limit. Use `snake_case` for modules, functions, and variables; `PascalCase` for classes; and `UPPER_SNAKE_CASE` for constants. Keep MCP wrappers thin, access tool dependencies through `tools._runtime`, and place new web routes in a focused `src/web/<domain>.py` module. New imports should prefer `ombrebrain.*` canonical paths. Run Ruff before committing.

## Testing Guidelines

Use pytest, `pytest-asyncio`, and `pytest-cov`. Name files `test_<behavior>.py` and tests `test_<expected_outcome>`. Add regression coverage beside every bug fix. CI requires at least 60% total coverage. Tests are isolated by `tests/conftest.py`; never point tests or cleanup commands at a real memory vault. LLM-quality and Docker integration tests require their documented credentials or services.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit prefixes such as `feat:`, `fix:`, `test:`, `docs:`, `ci:`, and scoped forms like `chore(docker):`. Keep the subject concise and describe the observable change. Pull requests should explain intent, list validation performed, link relevant issues, and include screenshots for Dashboard changes. Call out configuration, migration, security, or compatibility effects explicitly.

## Security & Configuration

Never commit API keys, passwords, OAuth tokens, Tunnel tokens, `config.yaml`, or real vault data. Treat `docs/ENVIRONMENT_VARIABLES.md` as authoritative for environment names. Memory semantics are defined in `rule.md`; ask before changing deletion, decay, merge, pinned, plan, anchor, or `I` behavior. Version changes must update both `VERSION` and `src/VERSION`.
