# Security Policy

## Supported Versions

Only the latest release series is supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

## Reporting a Vulnerability

Please report security vulnerabilities privately so we can fix them before public disclosure.

- **GitHub Security Advisories**: Use [Private vulnerability reporting](https://github.com/jonaas-dev/obsidian-margin-comments/security/advisories/new) on this repository.
- **Response time**: We aim to acknowledge reports within 7 days.
- **Scope**: Vulnerabilities in the plugin code, build tooling, or published release assets.

Please do not open public issues for undisclosed security problems.

## Trust model for comment bodies

Comments are rendered as Markdown, but they are stored in sidecar files that can travel with a vault through Git or file sync. In a shared vault another user may be able to write those sidecars, so comment bodies are treated as **less trusted than the user's own notes**.

Before rendering a comment body, the plugin:

- Converts remote images (`![](https://…)`, `<img src="https://…">`) into plain links, so they cannot be used as network beacons.
- Converts Obsidian embeds (`![[another note]]`) into regular internal links, so another note is not pulled into a card until the user chooses to open it.

Local images and normal internal links continue to render normally.
