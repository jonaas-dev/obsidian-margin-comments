# Security Policy

## Supported Versions

Only the latest release series is supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0.0 | :x:                |

## Reporting a Vulnerability

Please report security vulnerabilities privately so we can fix them before public disclosure.

- **GitHub Security Advisories**: Use [Private vulnerability reporting](https://github.com/jonaas-dev/obsidian-margin-comments/security/advisories/new) on this repository.
- **Response time**: We aim to acknowledge reports within 7 days.
- **Scope**: Vulnerabilities in the plugin code, build tooling, or published release assets.

Please do not open public issues for undisclosed security problems.

## Trust model for comment bodies

Comments are rendered as Markdown, but they are stored in sidecar files that can travel with a vault through Git or file sync. In a shared vault another user may be able to write those sidecars, so comment bodies are treated as **less trusted than the user's own notes**.

Before rendering a comment body, the plugin:

- Renders the body in a document with no browsing context, where nothing fetches whatever its URL says, and copies the result into the card only once every remote load has been taken out. Rendering first and cleaning after is the point: matching the Markdown source cannot see a URL that arrives at the DOM already decoded. Because the card gets a copy, content a renderer adds to the original later never reaches the card.
- Decides whether a URL is remote on the URL as the page resolves it, not as it is written, so whitespace, control characters and backslashes change nothing.
- Converts anything that would fetch from the network into a plain link, so it cannot be used as a network beacon: `<img>` and its `srcset`, `<picture>`, `<video>`, `<audio>`, `<track>`, `<iframe>`, `<embed>`, `<object>`, `<input type="image">`, SVG `<image>` and `<use>`, and `<link>`.
- Removes every other attribute that takes a remote URL, on any element, and SVG presentation attributes whose value is anything but a plain value or a reference inside the same SVG.
- Strips all styling: every `style` attribute and `<style>` block, whatever it says.
- Offers only `http` and `https` addresses as links in place of what it removed.
- Converts Obsidian embeds (`![[another note]]`) into regular internal links, so another note is not pulled into a card until the user chooses to open it.

Local images and normal internal links continue to render normally.

### Limits

Comment bodies are rendered with Obsidian's Markdown renderer, which runs the code-block processors of every enabled plugin. Whatever such a processor fetches by itself, without putting it in the rendered content, is outside what this plugin can see or stop; it would do the same for that code block in a note. Disable a plugin you do not trust with the content of a shared vault.
