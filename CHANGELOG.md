# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

## [Unreleased]

### Added
- Unified link insertion from the toolbar, `/link`, `Cmd+K`, or `Ctrl+K`.
- Host-validated HTTP, HTTPS, and email URL input from the same link picker.
- File and Markdown heading selection with safe relative-link generation.

### Security
- Keep workspace discovery inside the extension host with bounded file and heading scans.
- Reject dangerous URL schemes, credentials, control characters, and deceptive bidirectional text during link insertion.
- Canonically validate local link and image targets to block workspace escapes through symbolic links.

## [0.1.0] - 2026-02-11

### Added
- Initial Marketplace release of ManulDown.
- WYSIWYG custom editor for Markdown files (`*.md`).
- Core formatting support (headings, bold, italic, strikethrough, lists, code blocks).
- Table editing commands and keyboard shortcuts.
- Slash commands for table, quote, code block, and checklist insertion.
- Table of contents, find support, and two-way Markdown synchronization.
