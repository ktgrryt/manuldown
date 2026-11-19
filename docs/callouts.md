# Callout compatibility

Use **/callout** to insert a callout and start editing its body.
The **Callout: Default Service** setting (`manulDown.callout.defaultService`)
chooses the initial format for new callouts in `.md` files. The default uses the
alert syntax shared by GitHub, GitLab, and Microsoft Learn. After you choose a
service from a callout's **…** menu, the next `/callout` uses that service in
any document in the same VS Code window. Choosing the current service also
counts. Reloading or restarting the window restores the configured default.
Like quote blocks, callouts are not inserted inside list items or table cells.
The body uses the existing rich editor. Its type label
can be selected with the cursor, like a code block's language label. Enter or a
click opens the supported types for that callout's existing Markdown dialect.
Qiita offers `info`, `warn`, and `alert`; Zenn offers `message` and `alert`.
Choosing a type changes the declaration within that dialect, not its format.
The **…** button at the right of the title row opens the format picker.
From the type label, Right or Tab focuses this button; Left returns to the label.
Enter opens its menu, Up/Down moves through the options, and Enter selects one.
Escape closes the menu and returns focus to the button. Down or Right from the
button returns to the editable body.
Choosing a format converts that callout's Markdown declaration and offers the
types supported by the selected format. The body and Undo/Redo history are
preserved. Types without an exact counterpart use the closest supported type.
The picker disables destinations that would discard a custom title or service-specific
attributes such as a GitBook icon or a Quarto cross-reference ID.
Default labels use the original type spelling and case: Qiita `alert` stays
`alert`, `warn` stays `warn`, and GitHub `WARNING` stays `WARNING`. The shared
note/tip/important/warning/caution variants determine only color and icons.
Custom titles remain as written in the source.

Backspace or Delete removes a callout once its body is empty; macOS Ctrl+H also
works. Undo restores the removed callout. At a nonempty body's boundaries,
deletion keeps the callout and surrounding content separate.
Arrow navigation offers temporary input lines between consecutive callouts or
code blocks, and at the start or end of the document. Leave a temporary line
without typing to remove it, or type to keep it as a normal paragraph. Untouched
temporary lines do not change saved Markdown or Undo/Redo history.

## Supported syntax

| Syntax | Types |
| --- | --- |
| GitHub / GitLab / Microsoft Learn `> [!TYPE]` | `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION` (uppercase when inserting) |
| Obsidian `> [!type]` | The above plus `info`, `abstract`, `summary`, `tldr`, `todo`, `hint`, `success`, `check`, `done`, `question`, `help`, `faq`, `attention`, `failure`, `fail`, `missing`, `danger`, `error`, `bug`, `example`, `quote`, `cite` |
| Qiita | `:::note`, `:::note info`, `:::note warn`, `:::note alert` |
| Zenn | `:::message`, `:::message alert` |
| Docusaurus / VitePress | `:::note`, `:::tip`, `:::info`, `:::important`, `:::warning`, `:::danger`, `:::caution` |
| MkDocs | `!!! type`, `??? type`, `???+ type` with the known Obsidian types |
| GitBook `{% hint style="info" %}` … `{% endhint %}` | `info`, `success`, `warning`, `danger` |
| MyST / Jupyter Book `:::{note}` … `:::` | `note`, `important`, `hint`, `seealso`, `tip`, `attention`, `caution`, `warning`, `danger`, `error`. Backtick directive fences are also supported. |
| Quarto `::: {.callout-note}` … `:::` | `note`, `tip`, `important`, `warning`, `caution` |

GitBook's optional `icon` and Quarto's ID, classes, `title`, `icon`, `collapse`,
and `appearance` attributes survive body edits and type changes. A heading used
as a title in a GitBook or Quarto body stays an editable heading. MyST accepts a
title after the directive, for example `:::{warning} 注意事項`.

For an alert shared across GitHub, GitLab, and Microsoft Learn, put the type on
its own quoted line and start the body on the next line. GitLab also supports a
custom title after the type. [GitLab alerts](https://docs.gitlab.com/user/markdown/#alerts)

Astro Starlight uses the existing colon syntax for `note`, `tip`, `caution`, and
`danger`, including titles such as `:::tip[Getting started]`. These forms already
open in the editor. [Starlight asides](https://starlight.astro.build/guides/authoring-content/#asides)

Quote titles, Obsidian `+`/`-`, Docusaurus `[title]`, VitePress space-separated
titles, and MkDocs quoted titles are retained. Folded declarations are displayed
expanded. Titles are displayed as text and edited in the Markdown source view.
MkDocs `""` retains its empty title. Container fences may have more than three
colons. Callouts cannot nest. Existing nested callouts are displayed as
read-only Markdown source inside the outer callout and retain their source on save.
Ordinary quotations support at most two levels; deeper parts likewise remain
read-only source. Insertion and paste follow the same nesting limits.

Custom titles and folding signs survive type changes. Enter selects a type,
Escape cancels the picker, and the normal history restores type changes with
Undo/Redo. A bare `:::note` is ambiguous between Qiita and generic containers;
without a custom title, its picker offers the narrow Qiita subtype family.

## Recognition and safe fallback

The Marked block lexer determines Markdown context. Container and MkDocs
declarations start at a block boundary (normally after a blank line); they do not
interrupt existing paragraphs. This keeps multiline inline code literal. Fenced
and indented code, escaped declarations, raw HTML, unknown types, and incomplete
declarations are not converted to editable callouts.

Colon containers require a closing fence. Quarto accepts three or more closing
colons regardless of the opening width. MkDocs requires an indented
body. Quote callouts require explicit quote prefixes; lazy continuations fall
back to ordinary Markdown. GitLab `>>>` blocks, MkDocs extra layout modifiers,
and MDX/directive attributes are not interpreted as callouts. Balanced unknown
containers and unsupported nested directives are shown as read-only Markdown.
MyST blocks with directive options (such as `:class:` or YAML options), GitBook
hints with unknown styles, and Quarto callouts with unsupported attributes also
keep their original source.

Live shortcuts intentionally recognize a narrower subset: Enter confirms a
quote declaration or a MkDocs declaration with an indented body; completing a
colon closing line or a GitBook `{% endhint %}` recognizes a simple block. They move existing DOM nodes
and use existing history snapshots. IME composition and noncollapsed selections
do not trigger conversions. The source view supports the full parser subset.
Direct Markdown paste also recognizes simple quoted callouts, including several
alerts separated by blank lines. Both the declaration and body need their `>`
prefix; bare `[!IMPORTANT]` followed by a hard line break remains ordinary text.

## Preservation

`Callouts.ts` validates declarations and retains the original header, footer,
source type, and body independently of the five shared visual variants. These
values live on each callout's DOM wrapper, so mixed formats and history snapshots
retain their own dialect. The existing source comparison reuses unchanged
Markdown. A validated type-only edit can retain the exact original body and
replace only its declaration. After body edits, the normal serializer converts the body and restores
that callout's delimiters, including surrounding list/quote prefixes. Delimiter
width increases when required to contain newly entered literal fences. In
GitBook and Quarto, a stray closing marker typed as body text is escaped so the
following content stays in the callout.

Raw source metadata is reused only when it matches the current document or an
already validated enclosing body. New live blocks validate their header/footer
before serialization. External clipboard HTML passes through the existing
sanitizer. Exact local copies can retain their callout metadata. Copies between
documents reconstruct the format, type and title from validated opening/closing
declarations and sanitized visible content; they never reuse hidden raw source.
Literal Markdown inside copied rich callout bodies stays literal.

## Official references

- [GitHub alerts](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#alerts)
- [GitLab alerts](https://docs.gitlab.com/user/markdown/#alerts)
- [Microsoft Learn alerts](https://learn.microsoft.com/en-us/contribute/content/markdown-reference#alerts-note-tip-important-caution-warning)
- [Obsidian callouts](https://obsidian.md/help/Editing+and+formatting/Callouts)
- [Qiita Markdown](https://qiita.com/Qiita/items/c686397e4a0f4f11683d)
- [Zenn Markdown](https://zenn.dev/zenn/articles/markdown-guide)
- [Docusaurus admonitions](https://docusaurus.io/docs/markdown-features/admonitions)
- [VitePress containers](https://vitepress.dev/guide/markdown#custom-containers)
- [Material for MkDocs admonitions](https://squidfunk.github.io/mkdocs-material/reference/admonitions/)
- [GitBook hints](https://gitbook.com/docs/create-content/blocks/hint)
- [MyST admonitions](https://mystmd.org/guide/admonitions) and [Jupyter Book Markdown files](https://jupyterbook.org/stable/authoring/file-types)
- [Quarto callout blocks](https://quarto.org/docs/authoring/callouts.html) and [Pandoc fenced divs](https://pandoc.org/MANUAL.html#extension-fenced_divs)
