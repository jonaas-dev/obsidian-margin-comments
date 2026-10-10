# Security Policy

## Supported versions

Only the latest release published to the Obsidian community directory receives security updates. Older releases are not back-ported.

## Reporting a vulnerability

Please report security vulnerabilities through [GitHub private vulnerability reporting](https://github.com/jonaas-dev/obsidian-margin-comments/security/advisories/new). Do not open a public issue for undisclosed security bugs.

We will acknowledge reports within a few days and coordinate a fix and an advisory before any public disclosure.

## Security model

Margin Comments stores comment data in JSON sidecars under `.margin-comments/` and never modifies your Markdown notes. Comment bodies are rendered as HTML inside Obsidian; the plugin strips remote loads and non-HTTP(S) schemes. See the active security remediation plan for the current audit findings and fixes.
