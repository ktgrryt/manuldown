# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

## [Unreleased]

### Added
- Unified inline link popover from the toolbar, `/link`, `Cmd+K`, or `Ctrl+K`.
- Host-validated HTTP, HTTPS, email URL, and absolute or explicit relative workspace-path input in the same field.
- Inline workspace file suggestions while typing in the URL/path field, with keyboard navigation and relative-path completion.
- Turn an absolute in-workspace file path pasted over selected text into a relative link.

### Fixed
- Keep the selected link text intact when editor DOM normalization runs while a pasted path is being validated.

### Security
- Keep workspace discovery inside the extension host with bounded file scans.
- Resolve inline file suggestions through short-lived host-held candidate IDs and revalidate the target before insertion.
- Serialize link resolution and stop remote path validation between component reads after cancellation.
- Reject dangerous URL schemes, credentials, control characters, and deceptive bidirectional text during link insertion.
- Preserve normal plain-text paste behavior when a pasted path is invalid, missing, remote, symbolic, or outside the workspace.
- Canonically validate local link and image targets to block workspace escapes through symbolic links.
- Revalidate links before opening, reject encoded custom schemes, and ignore requests from inactive editor panels.
- Reject symbolic links in each visible path component when validating remote workspace targets.

## [0.1.0] - 2026-02-11

### Added
- Initial Marketplace release of ManulDown.
- WYSIWYG custom editor for Markdown files (`*.md`).
- Core formatting support (headings, bold, italic, strikethrough, lists, code blocks).
- Table editing commands and keyboard shortcuts.
- Slash commands for table, quote, code block, and checklist insertion.
- Table of contents, find support, and two-way Markdown synchronization.
