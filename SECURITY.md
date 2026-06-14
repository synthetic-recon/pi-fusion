# Security Policy

pi packages run with the same local permissions as the user running pi. Review extensions before installing them.

## Reporting a vulnerability

Please report security issues privately by opening a GitHub security advisory if available, or by contacting the maintainers through the Synthetic Recon organization.

Do not include secrets, API keys, session files, or private repository content in public issues.

## Scope

Security-sensitive areas include:

- Unsafe file writes or shell execution
- Leaking API keys or provider headers
- Exposing private conversation or repository context unexpectedly
- Loading project-local config without trust checks
- Tool-result or prompt-injection paths that bypass user intent

## Current context behavior

The `fusion` tool does not send full conversation history to panel or judge calls by default. If `context_mode: "recent"` is used, recent user/assistant text turns are included in inner model calls. Tool outputs are skipped by default.
