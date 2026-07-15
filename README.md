# ManulDown for VSCode

ManulDown is a VSCode extension that lets you edit Markdown files in a WYSIWYG editor.

![image](images/README/README.png)  

## Features

- **WYSIWYG editing**: Edit while previewing the rendered result in real time.
- **Core formatting**:
  - Bold (`Ctrl+B` / `Cmd+B`)
  - Italic (`Ctrl+I` / `Cmd+I`)
  - Strikethrough (`Cmd+Shift+X`)
  - Headings (H1-H6)
  - Unordered lists
  - Ordered lists
  - Code blocks (with syntax highlighting)
- **Automatic Markdown syntax conversion**: Recognizes syntax such as `#`, `**`, `*`, `-`, and `` ``` `` while typing.
- **Syntax highlighting**: Multi-language highlighting powered by Prism.js.
- **Image support**: Paste and drag-and-drop images.
- **Links**: Insert HTTP, HTTPS, and email links, or safely encoded links to files in the current workspace folder.
- **Table of contents**: Auto-generated from headings.
- **Two-way sync**: Changes in the editor are reflected in the Markdown file immediately.
- **Toolbar**: Quick access buttons for common formatting.
- **Undo/Redo**: Edit history support.

## Usage

1. Open a Markdown file (`.md`).
2. Right-click the file and choose `Open with ManulDown Editor`.

- Or run `ManulDown: Open with ManulDown Editor` from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).

3. Start editing in the WYSIWYG editor.

### Toolbar Buttons

- **B**: Bold
- **I**: Italic
- **H1, H2, H3**: Heading levels
- **• List**: Unordered list
- **1\. List**: Ordered list
- **Link**: Open the inline link field for a URL, an absolute workspace path, or workspace file search

Select text and use the Link button, `/link`, `Cmd+K`, or `Ctrl+K` to open the same inline link popover used for existing links. Paste an HTTP, HTTPS, or `mailto:` URL directly, paste an absolute path or an explicit `./` / `../` path to an existing file in the current workspace, or type at least two characters such as `test3` to see matching workspace files below the field. Choosing a suggestion fills the field with its relative path; press **Apply** or Enter to confirm it. Absolute paths are stored as relative Markdown links.

Pasting an absolute local path directly over selected text also creates a relative link. Invalid, missing, symbolic-link, remote, and out-of-workspace targets remain an ordinary plain-text paste.

### Slash Commands

Type `/` in the editor to open the slash command menu. You can narrow results by typing a prefix such as `/ta`.

| Command | Action |
| --- | --- |
| `/link` | Open the inline link field and insert a URL or workspace link |
| `/table` | Insert a 2x2 table |
| `/quote` | Convert the current block into a quote (or insert an empty quote block if conversion is not possible) |
| `/code` | Insert a code block and focus the language label for editing |
| `/checkbox` | Create a checklist item (task list) |

Custom slash commands:

Drop .md files into ~/.manuldown, and each file becomes a slash command based on its filename.
For example, ~/.manuldown/meeting-minutes.md can be inserted with /meeting-minutes at the current cursor position.
- The command name is the filename without .md
- Running the command inserts the file contents at the cursor
- User-defined commands appear in green in the slash menu

Notes for custom command names:

- Command IDs are normalized from file names (`spaces` -> `-`, leading `/` removed, lowercase).
- Built-in command IDs (`link`, `table`, `quote`, `code`, `checkbox`) are reserved.
- Duplicate normalized command IDs are ignored.

Menu controls:

- `Enter`: Run the selected command
- `Tab` / `Shift+Tab`: Move to next/previous command
- `ArrowUp` / `ArrowDown`: Move to previous/next command (`Ctrl+P` / `Ctrl+N` also work on macOS)
- `Esc`: Close the menu

Notes:

- Slash commands are available in normal text input context. The menu does not appear inside code blocks, inside table cells, or during IME composition.

### Keyboard Shortcuts

#### Formatting

| Action | Mac | Windows / Linux |
| --- | --- | --- |
| Bold | `Cmd+B` | `Ctrl+B` |
| Italic | `Cmd+I` | `Ctrl+I` |
| Strikethrough | `Cmd+Shift+X` | `Alt+Shift+5` |

#### Editing

| Action | Mac | Windows / Linux |
| --- | --- | --- |
| Insert link | `Cmd+K` | `Ctrl+K` |
| Undo | `Cmd+Z` | `Ctrl+Z` |
| Redo | `Cmd+Shift+Z` | `Ctrl+Shift+Z` |
| Find | `Cmd+F` | `Ctrl+F` |
| Find next match | `Enter` | `Enter` |
| Find previous match | `Shift+Enter` | `Shift+Enter` |
| Select image from image edge caret | `ArrowLeft` / `ArrowRight` | `ArrowLeft` / `ArrowRight` |
| Resize selected image smaller | `Shift+ArrowDown` | `Shift+ArrowDown` |
| Resize selected image larger | `Shift+ArrowUp` | `Shift+ArrowUp` |
| Toggle editor | `Cmd+Option+M` | `Ctrl+Alt+M` |

Image resize flow: place the caret on the left or right edge of an image, press `ArrowLeft` / `ArrowRight` to select the image, then use `Shift+ArrowUp` or `Shift+ArrowDown`.

#### Table Operations

| Action | Mac | Windows / Linux |
| --- | --- | --- |
| Insert row/column | `Cmd+Ctrl+Shift+Up/Down/Left/Right` | `Ctrl+Shift+Alt+Up/Down/Left/Right` |
| Select current column | `Ctrl+Shift+Option+Up/Down` | `Ctrl+Alt+Up/Down` |
| Select current row | `Ctrl+Shift+Option+Left/Right` | `Ctrl+Alt+Left/Right` |
| Move selected column / row | `Shift+Left/Right` (column), `Shift+Up/Down` (row) | `Shift+Left/Right` (column), `Shift+Up/Down` (row) |

#### Emacs Keybindings (macOS only)

ManulDown supports standard macOS-style Emacs keybindings. These are disabled on Windows/Linux.

| Action | Key |
| --- | --- |
| Move cursor up | `Ctrl+P` |
| Move cursor down | `Ctrl+N` |
| Move cursor left | `Ctrl+B` |
| Move cursor right | `Ctrl+F` |
| Move to beginning of line | `Ctrl+A` |
| Move to end of line | `Ctrl+E` |
| Delete line/list item | `Ctrl+K` |
| Yank last `Ctrl+K` text | `Ctrl+Y` |
| Delete backward one character | `Ctrl+H` |

### Settings

You can change the following options from VSCode settings (`Ctrl+,` / `Cmd+,`):

| Setting | Default | Description |
| --- | --- | --- |
| `manulDown.toolbar.visible` | `true` | Show the toolbar |
| `manulDown.toc.enabled` | `true` | Automatically show the table of contents when headings exist |
| `manulDown.openByDefault` | `true` | Open Markdown files with ManulDown by default (updates `workbench.editorAssociations` immediately) |
| `manulDown.editor.theme` | `"vscode"` | Editor theme mode: `"vscode"` (follow VSCode), `"light"`, or `"dark"` |
| `manulDown.list.dashStyle` | `false` | Use `-` as the bullet marker style |
| `manulDown.list.indentSize` | `2` | Default nested list indentation width (`2` or `4` spaces) when the document style cannot be detected |
| `manulDown.security.allowRemoteImages` | `false` | Allow remote http/https images to load inside the editor |
| `manulDown.security.allowRemoteImageImport` | `false` | Allow pasted or dropped remote http/https image URLs to be downloaded into the workspace |
| `manulDown.security.allowFileLinks` | `false` | Allow `file://` links to be opened from the editor |

Security notes:

The `manulDown.security.*` options are disabled by default. Enabling them can let Markdown documents trigger outbound network requests, download files from external sources, disclose network metadata such as IP address or access time, or open local `file://` targets such as files, applications, shortcuts, or Windows network shares. Only enable these options when you trust the Markdown files you open.

Link selection runs only after you invoke the link command. Text entered in the inline URL/path field is sent to VSCode's extension host for validation; workspace file discovery stays in the host, and the editable document receives only bounded display labels and relative candidate paths. Candidate selection is resolved through a short-lived opaque ID and revalidated before insertion. New external links are limited to HTTP, HTTPS, and `mailto:` URLs, and ManulDown does not probe or open them while creating a link. Pasted absolute paths and explicit relative paths are accepted only for a real, non-symbolic file inside the current document's workspace and are converted to an encoded relative path; rejected absolute-path pastes remain plain text without probing outside the workspace. Workspace links remain relative, and links that resolve outside the current workspace folder stay blocked unless `manulDown.security.allowFileLinks` is enabled.

### Markdown Syntax

The editor automatically converts the following Markdown patterns:

- `# Heading` -> Heading 1
- `## Heading` -> Heading 2
- `### Heading` -> Heading 3
- `**text**` -> **bold**
- `*text*` -> *italic*
- `- item` -> Unordered list
- `1. item` -> Ordered list
- `` ```javascript `` -> Code block (type a language after `` ``` `` and press `Enter`)

## Development

### Project Structure

```
manuldown/
|-- src/
|   |-- extension.ts              # Extension entry point
|   |-- editor/
|   |   |-- MarkdownEditorProvider.ts  # Custom editor provider
|   |   `-- MarkdownDocument.ts        # Markdown document handling
|   `-- utils/
|       `-- getNonce.ts           # Security utility
|-- media/
|   |-- editor.js                 # Webview entry point
|   |-- editor.css                # Editor styles
|   `-- modules/                  # Modularized webview features
|       |-- CodeBlockManager.js
|       |-- CursorManager.js
|       |-- DOMUtils.js
|       |-- ListManager.js
|       |-- MarkdownConverter.js
|       |-- SearchManager.js
|       |-- StateManager.js
|       |-- TableManager.js
|       |-- TableOfContentsManager.js
|       `-- ToolbarManager.js
|-- images/                       # README/document images
|-- out/                          # Compiled output
|-- README.md                     # Overview
|-- USAGE.md                      # Detailed usage guide
|-- package.json                  # Extension manifest
`-- tsconfig.json                 # TypeScript config
```

### Build Commands

- `npm run compile`: Compile TypeScript
- `npm run watch`: Compile on file changes
- `npm run lint`: Run lint checks

## Tech Stack

- **TypeScript**: Type-safe development
- **VSCode Extension API**: Extension platform
- **Custom Editor API**: Custom editor implementation
- **Webview API**: Editor UI rendering
- **marked**: Markdown-to-HTML conversion
- **turndown**: HTML-to-Markdown conversion
- **Prism.js**: Syntax highlighting
- **contenteditable**: WYSIWYG editing behavior

## License

MIT
