# Callout compatibility

Callouts are a compatibility feature. There is no toolbar button, slash command,
or output-format setting. The body uses the existing rich editor. Its type label
can be selected with the cursor, like a code block's language label. Enter or a
click opens the supported types for that callout's existing Markdown dialect.
Qiita offers `info`, `warn`, and `alert`; Zenn offers `message` and `alert`.
Choosing a type changes the declaration within that dialect, not its format.
Default labels use the original type spelling and case: Qiita `alert` stays
`alert`, `warn` stays `warn`, and GitHub `WARNING` stays `WARNING`. The shared
note/tip/important/warning/caution variants determine only color and icons.
Custom titles remain as written in the source.

## Supported syntax

| Syntax | Types |
| --- | --- |
| GitHub / GitLab `> [!TYPE]` | `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION` (case insensitive) |
| Obsidian `> [!type]` | The above plus `info`, `abstract`, `summary`, `tldr`, `todo`, `hint`, `success`, `check`, `done`, `question`, `help`, `faq`, `attention`, `failure`, `fail`, `missing`, `danger`, `error`, `bug`, `example`, `quote`, `cite` |
| Qiita | `:::note`, `:::note info`, `:::note warn`, `:::note alert` |
| Zenn | `:::message`, `:::message alert` |
| Docusaurus / VitePress | `:::note`, `:::tip`, `:::info`, `:::important`, `:::warning`, `:::danger`, `:::caution` |
| MkDocs | `!!! type`, `??? type`, `???+ type` with the known Obsidian types |

Quote titles, Obsidian `+`/`-`, Docusaurus `[title]`, VitePress space-separated
titles, and MkDocs quoted titles are retained. Folded declarations are displayed
expanded. Titles are displayed as text and edited in the Markdown source view.
MkDocs `""` retains its empty title. Container fences may have more than three
colons, including nested containers. Known quoted callouts can also nest.

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

Colon containers require a matching closing fence. MkDocs requires an indented
body. Quote callouts require explicit quote prefixes; lazy continuations fall
back to ordinary Markdown. GitLab `>>>` blocks, MkDocs extra layout modifiers,
and MDX/directive attributes are not interpreted as callouts. Balanced unknown
containers and unsupported nested directives use the existing read-only source
preservation component, so partial conversion cannot discard their contents.

Live shortcuts intentionally recognize a narrower subset: Enter confirms a
quote declaration or a MkDocs declaration with an indented body; completing a
colon closing line recognizes a simple container. They move existing DOM nodes
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
width increases only when required to contain newly entered literal fences.

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
- [Obsidian callouts](https://obsidian.md/help/Editing+and+formatting/Callouts)
- [Qiita Markdown](https://qiita.com/Qiita/items/c686397e4a0f4f11683d)
- [Zenn Markdown](https://zenn.dev/zenn/articles/markdown-guide)
- [Docusaurus admonitions](https://docusaurus.io/docs/markdown-features/admonitions)
- [VitePress containers](https://vitepress.dev/guide/markdown#custom-containers)
- [Material for MkDocs admonitions](https://squidfunk.github.io/mkdocs-material/reference/admonitions/)
