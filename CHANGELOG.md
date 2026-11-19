# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

## [Unreleased]

### Added
- Insert and edit GitBook hints, MyST / Jupyter Book admonitions, and Quarto callouts in Markdown files. The GitHub / GitLab format also covers Microsoft Learn alerts.
- Export from the slash menu with `/export-pdf`, `/export-html`, and `/export-word`.

### Changed
- Start each VS Code window with the configured callout service. Choosing a service in a callout's **…** menu sets it for subsequent insertions across that window.
- Choose PDF, HTML, or DOCX from a single toolbar export menu. Word exports preserve editable equations and more of the document's formatting.

## [2.4.3] - 2026-11-18

### Added
- Export an editable Word document (`.docx`) from the toolbar's **…** menu.

### Fixed
- Keep the selected size of reference-style images when exporting to PDF, including when reopening the preview immediately after a resize.
- Restore keyboard caret navigation to the first line of a callout.

## [2.4.2] - 2026-11-18

### Fixed
- Preserve image sizes set in the editor when exporting to PDF or standalone HTML.

## [2.4.1] - 2026-11-18

### Fixed
- On macOS, make Control+K delete from the caret to the end of the current line on the first line of a new document, in paragraphs, and in table cells. Preserve following lines and retain code block indentation and blank lines.
- Preserve line breaks when restoring deleted text with Control+Y. Keep Control+K in search and code language fields, and during IME composition, from deleting editor text.

## [2.4.0] - 2026-11-18

### Added
- Export a standalone HTML file from the toolbar's **…** menu. The file embeds images, styles, syntax highlighting, math rendering, and Mermaid rendering for offline viewing.
- Use **Preview** on an HTML code block to view its HTML and CSS in a sandbox.

### Fixed
- Preserve the corresponding caret position and selection when switching between ManulDown and the Markdown source with the editor-title buttons or toggle shortcut. Reveal the restored caret and synchronize pending edits before opening the source editor.
- Improve caret placement when clicking callout headers or navigating around callouts, and support deleting empty callouts with Undo/Redo.

## [2.3.0] - 2026-11-17

### Changed
- Disallow nested callouts and limit quotations to two levels during editing, insertion, and paste. Preserve deeper content in existing documents as read-only Markdown source without recursively rendering it.
- Show the shared ManulDown startup spinner while preparing PDF previews, centered on first load and compact during regeneration. Keep loading feedback visible in narrow panels and stop it on completion or errors.
- Match PDF footer page numbers to the document font and increase their size from 9px to 11px.
- Center the PDF manual-break removal action using the shared preview button design. Hide insertion lines at existing page starts and track the current page at the viewport's top edge, including when several pages fit on screen.
- Keep PDF preview labels, tooltips, and notices in English regardless of VS Code's language. Share the actual toolbar/footer/zoom styles with Mermaid, including the compact percentage display and neutral action buttons.
- Use shared editor and Mermaid control styles in PDF previews. Keep document actions in a compact toolbar and page navigation/zoom in the footer, with contextual page break tools and a Done action. Support direct page entry and Mermaid-style zoom shortcuts.

### Added
- Navigate PDF previews with a left thumbnail sidebar, current-page highlighting, keyboard controls, and a show/hide toggle. Render nearby thumbnails after the first main page and bound the bitmap cache for long documents.
- Export PDF from the toolbar's **…** menu: preview pages, adjust page breaks and paper layout, and save the PDF shown in the preview. Adjustments stay separate from Markdown and its editing history. Local VS Code Desktop workspaces require Chrome or Edge; configure a custom executable with `manulDown.pdf.browserPath`.
- Edit page breaks directly on PDF pages using thin horizontal lines that highlight on hover or focus, with separate Remove controls in page gaps. Keep guides visible while updating, confirm changes with a quick Undo action, and clear manual breaks together. Preserve the viewed content while repaginating, support Undo/Redo, and restore document-specific breaks across restarts and source edits without changing Markdown.
- Insert live table-of-contents blocks with `/toc`. They update with heading changes, persist across saves, and can be selected and deleted as one object with Undo/Redo support. Navigate read-only items with arrows or Tab and press Enter to jump to a heading.

### Fixed
- Retry temporarily rejected editor updates without interrupting editing, recognize snapshots already applied during saving, and keep failed edits visible without repeated error notifications. Preserve concurrent external changes and stop retrying after the editor closes.
- Preserve literal task markers, blocked link destinations, empty links, remote-image alt text, and link-title backslashes when loading and editing Markdown. Keep escaped dollars and angle brackets literal, and retain existing punctuation and Windows-path spelling when it remains valid after an edit.
- Load PDF parser and renderer workers as complete Blob bundles in VS Code Webviews, avoiding failed worker imports and slow main-thread fallbacks. Prioritize the first visible PDF page and preserve display completion across resizing during initial loading.
- Keep inline-code arrow navigation on every character after pasting into the middle of code, including text and emoji split across DOM nodes.
- Preserve inline-code formatting when copying or cutting a single line, including selections inside the code and text around it.
- Keep cursor entry into a table of contents stable from wrapped text, formatted text, and blank lines.
- Open pasted images by double-clicking when Markdown filenames contain Japanese, spaces, or other URL-encoded characters.

### Security
- Restrict imported images to supported formats and validate their file headers before saving. Reject fabricated image MIME types that would otherwise create script or HTML files.
- Bound callout and quotation parsing before recursion so deeply nested Markdown cannot monopolize the extension host.

## [2.2.7] - 2026-11-15

### Changed
- Always follow the active VSCode color theme, including high contrast themes, instead of offering separate editor theme modes.

### Added
- Move used images from `images/<document name>/` with Markdown files moved or renamed through VSCode in trusted workspaces, updating relative paths and keeping image operations in the same Undo/Redo step. Shared images are copied, existing files are preserved with numbered names, and unused images stay in place. Disable with `manulDown.images.moveWithDocument`.
- Defer to VSCode's built-in link updater and notify when `markdown.updateLinksOnFileMove.enabled` is `always` or `prompt`; image moves run with the default `never` setting.

### Fixed
- Remove empty source image folders after moving Markdown images, including an empty `images/` parent, in the same Undo/Redo step; preserve remaining files and the original Markdown directory.
- Keep the caret at the deletion point when removing a selection that includes a list and adjacent paragraphs.
- Finish pending caret placement before Undo/Redo so delayed deletion callbacks cannot select removed content.

## [2.2.6] - 2026-11-14

### Changed
- Keep Preview switches in muted colors while retaining the filled on state and outlined off state.

## [2.2.4] - 2026-11-11

### Added
- Mermaid diagrams have a Code/Preview switch and copy, download, and expand icons. Download offers PNG or SVG. The expanded preview supports wheel zoom, drag and keyboard panning, fit-to-view, and actual-size controls.
- Copy selected content as Markdown from the editor's right-click menu or with `Cmd+Shift+C` on macOS / `Ctrl+Shift+C` on Windows/Linux while the editor body has focus.
- Keyboard navigation for footnote references and list numbers: focus a number with arrows or Tab and press Enter to jump between the body and its note.
- Delete a footnote and all its references with Backspace (or macOS Ctrl+H) on its focused list number, with Undo/Redo support.
- Open ManulDown settings from the toolbar's **…** menu or the `/settings` slash command.
- Math: write TeX as `$…$` and `$$…$$`, rendered with KaTeX. Type `$tex$` or `$$` + Enter, use `/math` or `/inline-math`, or the Math and Math Block toolbar items. Inline formulas are edited in a popover with a live result and TeX errors; math blocks are edited like code blocks with a TeX/Preview toggle, and ```` ```math ```` fences render the same way. KaTeX loads only for documents with a formula.
- Unified inline link popover from the toolbar, `/link`, `Cmd+K`, or `Ctrl+K`.
- Host-validated HTTP, HTTPS, email URL, and absolute or explicit relative workspace-path input in the same field.
- Inline workspace file suggestions while typing in the URL/path field, with keyboard navigation and relative-path completion.
- Turn an absolute in-workspace file path pasted over selected text into a relative link.

### Changed
- Bundle the extension and its dependencies instead of shipping `node_modules`, which shrinks the package.
- Load Prism as one script, and load Mermaid only when a document has a Mermaid code block.

### Fixed
- Preserve all cells when converting merged or uneven external tables, and keep newer edits queued behind delayed save/close requests.
- Treat pasted-image file creation as part of the original Undo/Redo step, including responses that arrive after Undo or another edit.
- Invalidate pending Mermaid renders when returning to a cached diagram, and decode percent-encoded binary image URLs as bytes.
- Keep temporary table-boundary input lines out of saved Markdown and Undo history until edited.
- Preserve authored spaces after images while keeping image caret anchors empty so navigation does not add phantom lines.
- Navigate complete Unicode characters and keep quoted text, formulas and intentional blank lines reachable.
- Retain the desired code column across short lines, navigate whitespace-only code lines, and keep vertical positions outside emoji sequences.
- Finish deferred caret placement before a new pointer action and prevent duplicate macOS Ctrl navigation across formulas.
- Save images embedded in pasted rich text or Markdown as image files with relative paths, avoiding long Base64 strings in Markdown while preserving image order and labels.
- Preserve external clipboard images and rich lists, recover native PNGs for local image references, and handle HTML-only or empty clipboard contents without deleting the selection.
- Keep meaningful Unicode characters, fenced-code boundaries and quoted multiline spreadsheet cells intact when pasting.
- Save empty and headerless external tables without conversion failures or read-only reloads, and encode whitespace in pasted link destinations.
- Keep Markdown editable after pasting Word text with numbered lines inside a paragraph, including after reopening the file.
- Resolve `~/` file links against the local home directory before checking workspace access, so blocked home paths show the appropriate explanation.
- Disable Open for blocked or unavailable file links and show the reason, including the user setting that permits local file links outside the workspace.
- Clicking above a code block at the start of a document opens a temporary input line, including for Mermaid previews.
- Clicking below a Mermaid preview opens a temporary input line, including when its language label is selected; untouched lines are not saved.
- Keep code-block language labels in the same font, size, and line height after language changes, and remove stale Prism language classes when switching to plaintext or Mermaid.
- Keep footnote cursor navigation to one step when VS Code and the Webview both receive a macOS Ctrl shortcut, and avoid scrolling numbers that are already visible.
- Move from a footnote text end to the next note number without looping through its delete control; keep the caret stable at the final note end.
- Disable toolbar editing commands while a footnote number is focused, including overflow menu items, and restore their availability when returning to editable text.
- Keep the selected link text intact when editor DOM normalization runs while a pasted path is being validated.
- Preserve unchanged Markdown blocks and inline syntax when another part of a document is edited, including underscore spelling, footnote definition order, and boundary blank lines.
- Keep literal punctuation and backslashes literal, escape image labels and titles correctly, and retain original zero-width characters in text and code.
- Preserve lazy blockquote continuations, loose and empty nested list structure, raw-source whitespace, math expressions, alert markers, table alignment, and code-fence info strings.

### Security
- Validate canonical local image paths before transferring bounded image data; restrict Webview resource roots to extension assets so workspace symlinks cannot bypass image checks.
- Keep workspace discovery inside the extension host with bounded file scans.
- Resolve inline file suggestions through short-lived host-held candidate IDs and revalidate the target before insertion.
- Serialize link resolution and stop remote path validation between component reads after cancellation.
- Reject dangerous URL schemes, credentials, control characters, and deceptive bidirectional text during link insertion.
- Preserve normal plain-text paste behavior when a pasted path is invalid, missing, remote, symbolic, or outside the workspace.
- Canonically validate local link and image targets to block workspace escapes through symbolic links.
- Revalidate links before opening, reject encoded custom schemes, and ignore requests from inactive editor panels.
- Reject symbolic links in each visible path component when validating remote workspace targets.
- Refuse remote images in the Webview CSP unless `manulDown.security.allowRemoteImages` is enabled, closing several paths that loaded blocked images anyway. Changing the setting applies to editors opened afterwards.
- Make the `manulDown.security.*` settings configurable only in user settings, so a workspace's `.vscode/settings.json` cannot enable them.
- Ignore non-boolean setting values and escape the settings embedded in the Webview page.

## [0.1.0] - 2026-02-11

### Added
- Initial Marketplace release of ManulDown.
- WYSIWYG custom editor for Markdown files (`*.md`).
- Core formatting support (headings, bold, italic, strikethrough, lists, code blocks).
- Table editing commands and keyboard shortcuts.
- Slash commands for table, quote, code block, and checklist insertion.
- Table of contents, find support, and two-way Markdown synchronization.
