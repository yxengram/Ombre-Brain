# Security Review — 2026-08

## Scope and threat model

This review considered an unauthenticated Internet client, an authenticated but
malicious Dashboard/MCP client, hostile stored memory and archives, a malicious
or redirected provider endpoint, compromised update delivery, and a local user
able to place files in the vault. It covered MCP/OAuth, HTTP/Dashboard,
providers, archives/GitHub sync, hot update, Docker and CI supply chain.

## Verified controls

- HTTP MCP identity is request-scoped, bearer identities are SHA-256 digests,
  and rate limits are fail-fast per principal.
- A non-loopback network MCP listener with authentication disabled now fails at
  startup unless an operator explicitly sets `OMBRE_ALLOW_INSECURE_MCP=true`;
  stdio and confirmed loopback remain available for local development.
- Tool schemas reject unknown properties; mutating/provider tools are annotated
  and untrusted stored content is nonce-framed with instruction warnings.
- Operator egress rejects credentials, fragments, unsafe literal IP classes and
  remote HTTP. Runtime HTTP clients disable automatic redirects.
- The Ollama installer now blocks urllib auto-redirects and validates each of
  at most three redirect targets before issuing the next request; downloaded
  executables remain size, magic and SHA-256 checked.
- Browser responses apply same-origin CSP, clickjacking, MIME and no-store
  controls for authenticated routes. Dashboard and onboarding fetch same-origin
  URLs only.
- Archive/import and media code applies bounded members, traversal checks,
  symlink rejection and digest/manifest validation. Official hot updates require
  signed release metadata and bound redirect hops to GitHub asset hosts.
- CI pins third-party Actions to full SHAs and runs Ruff, Bandit, pip-audit and
  the test suite before release work.

## Findings and residual risk

- **Resolved — pre-import backup symlink gap:** the legacy GitHub pre-import
  helper now applies the same pre-import symlink rejection as the main backup
  path before it reads vault content.
- **Resolved — authenticated-route error disclosure:** provider testing,
  model catalogue, embedding/Ollama, maintenance, GitHub, search, plans,
  letters, bucket, import, tunnel and configuration persistence failures now
  use stable codes plus generic Chinese text. Their logs retain only a trace
  id and exception class, not exception values.
- **P3 — DNS rebinding:** hostname resolution is intentionally not attempted by
  the process-local URL validator because it cannot pin the later connection.
  Provider and allowlisted local hosts remain administrator-trusted inputs.
- **P2 — optional Ollama container boundary:** the upstream Ollama image keeps
  its root user and writable root filesystem for model-pull compatibility. The
  optional profile is digest-pinned, drops capabilities and forbids privilege
  gain, but remains a weaker boundary than the main application container.
- **Operational — signed releases not provisioned:** the production Ed25519
  public key and protected Environment private-key secret are not configured.
  Hot update and tag publication therefore fail closed until the maintainer
  provisions a matching pair, reviewers and tag protection.
- **Scale — process-local rate limits:** MCP quotas are enforced per process;
  multi-replica deployments need an external shared limiter at the ingress.

## Validation and limits

Targeted diagnostics, request-security, outbound-policy, framing, MCP startup
guard and cross-module gate tests passed. Bandit completed at the configured
high severity threshold; pip-audit reported no known locked dependency
vulnerabilities. Secret-pattern scanning reported no candidate literals, with
values deliberately never printed. A pinned-base Docker image was built and an
isolated non-root, read-only container passed `/health`; the production OAuth
provider, protected GitHub Environment and multi-replica limiter were not
exercised in this local review. Docker Scout was not available locally, so
base-image CVE status was not independently scanned beyond digest pinning and
the locked Python dependency audit.

## Deployment actions

Use HTTPS plus MCP authentication for every non-loopback deployment; restrict
vault/media permissions to the service account; keep provider URLs and
`OMBRE_INSECURE_LOCAL_HOSTS` administrator-controlled; configure the release
signing public key before enabling hot updates; and run
`python tools/security_diagnostics.py --config config.yaml --pretty` before
each deployment.
