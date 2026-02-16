import * as vscode from 'vscode';
import { MarkdownDocument } from './MarkdownDocument';
import { getNonce } from '../utils/getNonce';
import TurndownService from 'turndown';
const { gfm } = require('turndown-plugin-gfm');

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
    private static readonly viewType = 'manulDown.editor';
    private turndownService: TurndownService;
    private webviewPanels = new Map<string, vscode.WebviewPanel>();
    private lastActivePanel: vscode.WebviewPanel | null = null;
    public explicitlyRequested = false;

    constructor(private readonly context: vscode.ExtensionContext) {
        // Initialize Turndown service with proper settings for nested lists
        this.turndownService = new TurndownService({
            headingStyle: 'atx',
            hr: '---',
            bulletListMarker: '-',
            codeBlockStyle: 'fenced',
            emDelimiter: '*',
            strongDelimiter: '**',
            // Use 2 spaces for list indentation
            blankReplacement: (content: string, node: any) => {
                return node.isBlock ? '\n\n' : '';
            }
        });
        this.turndownService.use(gfm);

        // Handle strikethrough tags produced by execCommand and markdown conversions
        this.turndownService.addRule('legacyStrikethrough', {
            filter: ['del', 's', 'strike'],
            replacement: function (content: string) {
                return '~~' + content + '~~';
            }
        });

        // Override escape function to not escape backticks and hyphens
        const originalEscape = (this.turndownService as any).escape;
        (this.turndownService as any).escape = function (text: string) {
            // Call original escape but preserve backticks and hyphens
            const escaped = originalEscape.call(this, text);
            // Unescape backticks and hyphens that were escaped
            return escaped.replace(/\\`/g, '`').replace(/\\-/g, '-');
        };

        // Override list item indentation to use 2 spaces instead of 4
        const originalIndent = (this.turndownService as any).options.indent || '    ';
        (this.turndownService as any).options.indent = '  '; // 2 spaces

        // Keep default list handling - Turndown handles nested lists correctly by default
        // Just ensure proper indentation with 2 spaces
        this.turndownService.keep(['br']);

        // Add custom rule for list items to use 2-space indentation
        this.turndownService.addRule('listItem', {
            filter: 'li',
            replacement: function (content: string, node: any, options: any) {
                // Get direct text content (excluding nested lists)
                let directText = '';
                for (let child of node.childNodes) {
                    if (child.nodeType === 3) { // TEXT_NODE
                        directText += child.textContent;
                    } else if (child.nodeType === 1) { // ELEMENT_NODE
                        const tagName = child.tagName;
                        if (tagName !== 'UL' && tagName !== 'OL') {
                            directText += child.textContent;
                        }
                    }
                }

                // Check if this is an empty list item with nested lists
                const hasNestedList = node.querySelector('ul, ol') !== null;
                // Check for &nbsp; which indicates a preserved empty list item
                const hasNbsp = directText.includes('\u00A0');
                const isEmptyWithNestedList = hasNestedList && directText.trim() === '';
                const isPreservedEmptyWithNestedList = hasNestedList && hasNbsp && directText.replace(/\u00A0/g, '').trim() === '';

                // Check if this list item contains a checkbox (task list item)
                const hasCheckbox = node.querySelector('input[type="checkbox"]') !== null;

                // Check if this is a completely empty list item (no nested lists, just &nbsp; or empty)
                // Checkbox items are not considered "completely empty" even if they have no text
                const isCompletelyEmpty = !hasCheckbox && !hasNestedList && (directText.trim() === '' || directText.trim() === '\u00A0');
                const isNestedListItem = node.parentNode && node.parentNode.parentNode && node.parentNode.parentNode.nodeName === 'LI';

                if (isPreservedEmptyWithNestedList) {
                    // Preserved empty list item with nested list: <li>&nbsp;<ul><li>c</li></ul></li>
                    // This is intentionally created by the user (e.g., after backspace)
                    // Use a special marker that will be replaced with &nbsp; later
                    content = content
                        .replace(/^\n+/, '') // remove leading newlines
                        .replace(/\n+$/, '\n') // replace trailing newlines with just a single one
                        .replace(/\n/gm, '\n  '); // indent nested content

                    let prefix = options.bulletListMarker + ' ';
                    const parent = node.parentNode;
                    if (parent.nodeName === 'OL') {
                        const start = parent.getAttribute('start');
                        const index = Array.prototype.indexOf.call(parent.children, node);
                        prefix = (start ? Number(start) + index : index + 1) + '. ';
                    }

                    // Return marker with special placeholder, then the nested content
                    return prefix + 'EMPTYLISTITEM\n' + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
                } else if (isEmptyWithNestedList) {
                    // Empty list item with nested list (not preserved): <li><ul><li>b</li></ul></li>
                    // Output only the nested content without the parent marker
                    // This prevents double markers while preserving the nested list
                    content = content
                        .replace(/^\n+/, '') // remove leading newlines
                        .replace(/\n+$/, '\n') // replace trailing newlines with just a single one
                        .replace(/\n/gm, '\n  '); // indent

                    // Return the indented content without prefix
                    return content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
                } else if (isCompletelyEmpty) {
                    // Completely empty list item - use &nbsp; for nested items to avoid heading parse
                    content = isNestedListItem ? '&nbsp;' : '';
                } else {
                    // Normal list item processing
                    content = content
                        .replace(/^\n+/, '') // remove leading newlines
                        .replace(/\n+$/, '\n') // replace trailing newlines with just a single one
                        .replace(/\n/gm, '\n  '); // indent
                }

                let prefix = options.bulletListMarker + ' ';
                const parent = node.parentNode;
                if (parent.nodeName === 'OL') {
                    const start = parent.getAttribute('start');
                    const index = Array.prototype.indexOf.call(parent.children, node);
                    prefix = (start ? Number(start) + index : index + 1) + '. ';
                }

                return prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
            }
        });

        // Add custom rule for inline code
        this.turndownService.addRule('inlineCode', {
            filter: function (node: any) {
                return (
                    node.nodeName === 'CODE' &&
                    (!node.parentNode || node.parentNode.nodeName !== 'PRE')
                );
            },
            replacement: function (content: string) {
                // Don't escape backticks - just wrap with backticks
                // If content contains backticks, use double backticks
                if (content.includes('`')) {
                    return '`` ' + content + ' ``';
                }
                return '`' + content + '`';
            }
        });

        // Override the default fenced code block rule to preserve empty code blocks
        this.turndownService.addRule('fencedCodeBlock', {
            filter: function (node: any, options: any) {
                return (
                    options.codeBlockStyle === 'fenced' &&
                    node.nodeName === 'PRE' &&
                    typeof node.querySelector === 'function' &&
                    !!node.querySelector('code')
                );
            },
            replacement: function (content: string, node: any, options: any) {
                const codeNode = node.querySelector('code');
                if (!codeNode) {
                    const fence = options.fence || '```';
                    return '\n\n' + fence + '\n\n' + fence + '\n\n';
                }
                const className = codeNode.getAttribute('class') || '';
                const matches = className.match(/(?:^|\s)language-([^\s]+)/);
                const language = matches ? matches[1] : '';

                // Get the text content directly from the code node
                const code = codeNode.textContent || '';

                // Preserve the code as-is, but ensure proper formatting
                let codeContent = code;
                if (code.trim() === '') {
                    // Empty code block - add a newline to preserve it
                    codeContent = '\n';
                } else {
                    // Ensure code ends with a newline if it doesn't already
                    // This ensures the closing ``` appears on its own line
                    if (!codeContent.endsWith('\n')) {
                        codeContent += '\n';
                    }
                }

                const fence = options.fence || '```';
                // Format: \n\n```language\ncodeContent```\n\n
                // The codeContent already ends with \n, so closing fence will be on its own line
                const result = '\n\n' + fence + language + '\n' + codeContent + fence + '\n\n';

                return result;
            }
        });
    }

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        // Check if the user wants to open in WYSIWYG by default
        const wasExplicit = this.explicitlyRequested;
        this.explicitlyRequested = false;
        if (!wasExplicit) {
            const openByDefault = vscode.workspace.getConfiguration('manulDown').get<boolean>('openByDefault', true);
            if (!openByDefault) {
                setTimeout(() => {
                    vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                }, 0);
                return;
            }
        }

        // Setup webview options
        webviewPanel.webview.options = {
            enableScripts: true,
        };

        // Set webview HTML content
        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document);

        const documentKey = document.uri.toString();
        this.webviewPanels.set(documentKey, webviewPanel);
        if (webviewPanel.active) {
            this.lastActivePanel = webviewPanel;
        }

        webviewPanel.onDidChangeViewState((event) => {
            if (event.webviewPanel.active) {
                this.lastActivePanel = webviewPanel;
            }
        });

        // Create document manager
        const markdownDocument = new MarkdownDocument(document, webviewPanel.webview);

        // Track if we're currently updating from webview
        let isUpdatingFromWebview = false;
        let lastWebviewUpdateTime = 0;

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'undoRedo':
                        // Undo/Redo操作の開始を記録（外部変更と判断されないように）
                        lastWebviewUpdateTime = Date.now();
                        break;
                    case 'update':
                        isUpdatingFromWebview = true;
                        lastWebviewUpdateTime = Date.now();
                        try {
                            await this.updateTextDocument(document, message.content);
                        } finally {
                            // Wait for all document change events to be processed
                            // Increased timeout to ensure all async events complete
                            await new Promise(resolve => setTimeout(resolve, 300));
                            isUpdatingFromWebview = false;

                            // Don't send refresh message - WebView already has the correct state
                            // Sending refresh would reset cursor position
                        }
                        break;
                    case 'ready':
                        // Send initial content to webview
                        const initialHtml = markdownDocument.toHtml();
                        webviewPanel.webview.postMessage({
                            type: 'init',
                            content: initialHtml,
                        });
                        break;
                    case 'openImage':
                        // Open the image file in VSCode
                        await this.openImageFile(message.src, document);
                        break;
                    case 'saveImage':
                        // Save the pasted image as a file
                        await this.saveImageFromDataUrl(
                            message.dataUrl,
                            message.mimeType,
                            document,
                            webviewPanel.webview,
                            {
                                insert: message.insert !== false,
                                showNotification: message.insert === false
                            }
                        );
                        break;
                    case 'saveImageFromUri':
                        // Save a dropped local image URI (e.g. Finder drag-and-drop)
                        await this.saveImageFromUri(
                            message.uri,
                            document,
                            webviewPanel.webview
                        );
                        break;
                    case 'resolveImageSrc':
                        {
                            const resolvedSrc = await this.resolveImageSrcForWebview(
                                message.src,
                                document,
                                webviewPanel.webview
                            );
                            webviewPanel.webview.postMessage({
                                type: 'resolvedImageSrc',
                                requestId: message.requestId,
                                resolvedSrc
                            });
                        }
                        break;
                    case 'openLink':
                        // Open the link in the default browser (http/https only)
                        if (message.url && /^https?:\/\//i.test(message.url)) {
                            vscode.env.openExternal(vscode.Uri.parse(message.url));
                        }
                        break;
                }
            }
        );

        // Handle document changes (external edits)
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.uri.toString() === document.uri.toString()) {
                const timeSinceLastUpdate = Date.now() - lastWebviewUpdateTime;
                // Only update webview if not currently updating from webview
                // AND if enough time has passed since the last webview update (2000ms grace period)
                // Increased to 2000ms to account for slow applyEdit operations
                if (!isUpdatingFromWebview && timeSinceLastUpdate > 2000) {
                    webviewPanel.webview.postMessage({
                        type: 'update',
                        content: markdownDocument.toHtml(),
                    });
                }
            }
        });

        const configurationChangeSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('manulDown')) {
                webviewPanel.webview.postMessage({
                    type: 'settings',
                    settings: this.getWebviewSettings(),
                });
            }
        });

        // Cleanup
        webviewPanel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
            configurationChangeSubscription.dispose();
            this.webviewPanels.delete(documentKey);
            if (this.lastActivePanel === webviewPanel) {
                this.lastActivePanel = null;
            }
        });
    }

    public postMessageToActiveEditor(message: any): boolean {
        const panel = this.getActiveWebviewPanel();
        if (!panel) return false;
        panel.webview.postMessage(message);
        return true;
    }

    private getActiveWebviewPanel(): vscode.WebviewPanel | null {
        if (this.lastActivePanel && this.lastActivePanel.active) {
            return this.lastActivePanel;
        }

        for (const panel of this.webviewPanels.values()) {
            if (panel.active) {
                this.lastActivePanel = panel;
                return panel;
            }
        }

        if (this.webviewPanels.size === 1) {
            const onlyPanel = Array.from(this.webviewPanels.values())[0];
            this.lastActivePanel = onlyPanel;
            return onlyPanel;
        }

        return null;
    }

    private async updateTextDocument(document: vscode.TextDocument, html: string): Promise<void> {
        const edit = new vscode.WorkspaceEdit();

        // Convert HTML back to Markdown
        const markdown = this.htmlToMarkdown(html, document);

        // Replace entire document - use proper range to cover all content
        const lastLine = document.lineAt(document.lineCount - 1);
        const fullRange = new vscode.Range(
            0,
            0,
            document.lineCount - 1,
            lastLine.text.length
        );

        edit.replace(
            document.uri,
            fullRange,
            markdown
        );

        await vscode.workspace.applyEdit(edit);
    }

    private htmlToMarkdown(html: string, document: vscode.TextDocument): string {
        // Use Turndown for reliable HTML to Markdown conversion
        try {
            // Pre-process HTML to convert webview URIs back to relative paths
            html = this.convertWebviewUrisToRelativePaths(html, document);

            // Remove zero-width markers used for caret placement
            html = html.replace(/[\u200B\uFEFF]/g, '');

            // Remove empty strikethrough tags (e.g. <del><br></del>) to avoid "~~" artifacts
            html = html.replace(/<(del|s|strike)(\s[^>]*)?>\s*(?:<br[^>]*>|&nbsp;|\u00A0|\s)*<\/\1>/gi, '');

            // Remove class attributes from list items (they are for display only)
            html = html.replace(/<li\s+class="[^"]*"([^>]*)>/gi, '<li$1>');

            // Remove code block toolbars (language labels and copy buttons)
            // Remove any element with data-exclude-from-markdown attribute
            html = html.replace(/<div[^>]*data-exclude-from-markdown="true"[^>]*>[\s\S]*?<\/div>/gi, '');
            // Also remove by class name as fallback
            html = html.replace(/<div class="code-block-toolbar"[^>]*>[\s\S]*?<\/div>/gi, '');

            // Remove drag handles (row-handle and col-handle)
            html = html.replace(/<div class="(row|col)-handle"[^>]*><\/div>/gi, '');

            // Normalize code blocks: remove leading/trailing whitespace inside <code> tags
            // BUT preserve trailing newlines in code blocks (for proper markdown conversion)
            html = html.replace(/<code([^>]*)>([\s\S]*?)<\/code>/gi, (match, attrs, content) => {
                // For code blocks inside <pre>, preserve trailing newlines
                // For inline code, trim all whitespace
                const isInPre = attrs.includes('language-');
                if (isInPre) {
                    // Preserve trailing newlines for code blocks
                    const trimmedContent = content.replace(/^\s+/g, '');
                    return `<code${attrs}>${trimmedContent}</code>`;
                } else {
                    // Trim all whitespace for inline code
                    const trimmedContent = content.replace(/^\s+|\s+$/g, '');
                    return `<code${attrs}>${trimmedContent}</code>`;
                }
            });

            // Handle empty code blocks by adding a placeholder
            // Match: <pre><code class="language-xxx"></code></pre> (now that we've trimmed whitespace)
            html = html.replace(/<pre[^>]*>\s*<code([^>]*)><\/code>\s*<\/pre>/gi,
                (match, codeAttrs) => {
                    const classMatch = codeAttrs.match(/class="([^"]*)"/i);
                    const className = classMatch ? classMatch[1] : '';
                    const languageMatch = className.match(/(?:^|\s)language-([^\s]+)/i);
                    const language = languageMatch ? languageMatch[1] : '';
                    const markerLanguage = language || 'NOLANG';
                    // Add a special marker that Turndown will preserve
                    return `<pre><code${codeAttrs}>EMPTYCODE_${markerLanguage}_EMPTYCODE</code></pre>`;
                });

            // Fix malformed list HTML
            // Note: Don't remove </li> before </ul> or </ol> as it may be part of valid nested structure

            // 1. Move text nodes directly inside <ul> or <ol> into the first <li>
            // Match: <ul> or <ol> followed by text/whitespace before <li>
            // Instead of removing the text, wrap it in the first <li>
            html = html.replace(/(<ul[^>]*>|<ol[^>]*>)\s*([^<]+?)\s*(<li>)/gi, (match, listStart, text, liStart) => {
                // Only apply if the text is not just whitespace
                if (text.trim()) {
                    // Move the text into the first <li>
                    return listStart + liStart + text;
                }
                // If just whitespace, remove it
                return listStart + liStart;
            });

            // 2. Fix empty <li> elements that contain nested lists
            // Pattern: <li><ul>...</ul></li> or <li><ol>...</ol></li>
            // This structure should be merged with the previous <li> to create proper nesting
            // Transform: <li>a</li><li><ul><li>b</li></ul></li> -> <li>a<ul><li>b</li></ul></li>
            // BUT: Don't merge if the list item has data-preserve-empty attribute (user intentionally created it)
            // Mark &nbsp; empty items as preserved so they don't get merged away
            html = html.replace(/<li([^>]*)>\s*(?:&nbsp;|\u00A0)\s*(<ul>|<ol>)/gi, (match, attrs, openTag) => {
                if (attrs.includes('data-preserve-empty="true"')) {
                    return `<li${attrs}>&nbsp;${openTag}`;
                }
                return `<li${attrs} data-preserve-empty="true">&nbsp;${openTag}`;
            });
            html = html.replace(/<li([^>]*)>(\s|&nbsp;)*(<ul>|<ol>)([\s\S]*?)(<\/ul>|<\/ol>)\s*<\/li>/gi, (match, attrs, space, openTag, content, closeTag) => {
                // Check if this list item has data-preserve-empty attribute
                if (attrs.includes('data-preserve-empty="true"')) {
                    // Don't mark for merging - preserve as-is with a special marker
                    // Add &nbsp; to ensure it's not treated as completely empty
                    return `<li${attrs}>&nbsp;${openTag}${content}${closeTag}</li>`;
                }
                // Return a marker that we'll process in a second pass
                return `<li${attrs} data-merge-with-previous="true">${openTag}${content}${closeTag}</li>`;
            });

            // Second pass: merge marked list items with their previous siblings
            html = html.replace(/(<li>[\s\S]*?<\/li>)\s*<li([^>]*) data-merge-with-previous="true">(<ul>|<ol>)([\s\S]*?)(<\/ul>|<\/ol>)<\/li>/gi, (match, prevLi, attrs, openTag, content, closeTag) => {
                // Remove the closing </li> from previous item and append the nested list
                const prevWithoutClosing = prevLi.replace(/<\/li>$/, '');
                return `${prevWithoutClosing}${openTag}${content}${closeTag}</li>`;
            });

            // Clean up any remaining markers (in case there was no previous sibling)
            html = html.replace(/<li([^>]*) data-merge-with-previous="true">/gi, '<li$1>');

            // Remove data-preserve-empty attribute AFTER all processing (it's only for processing, not for Turndown)
            html = html.replace(/\s*data-preserve-empty="true"/gi, '');

            // 3. Fix duplicate closing tags like </ul></ul>
            html = html.replace(/(<\/ul>|<\/ol>)\s*\1+/gi, '$1');

            // Remove placeholder <br> in empty table cells to avoid broken GFM table output
            html = html.replace(/<(td|th)([^>]*)>\s*(?:<br\s*\/?>|\u00A0|&nbsp;|\s)*<\/\1>/gi, '<$1$2></$1>');

            // Pre-process HTML to handle empty paragraphs and list items with <br>
            // Replace empty paragraphs (<p><br></p>, <p></p>, and attribute variants) with EMPTYLINE marker.
            html = html.replace(/<p\b[^>]*>(?:\s|&nbsp;|\u00A0)*(?:<br>|<br\s*\/>)?(?:\s|&nbsp;|\u00A0)*<\/p>/gi, '<p>EMPTYLINE</p>');

            // Don't remove empty list items - they may have nested lists
            // Instead, ensure empty list items have proper content for Turndown

            // Replace <li><br></li> with <li>&nbsp;</li> to preserve empty items
            html = html.replace(/<li>(<br>|<br\s*\/>)\s*<\/li>/gi, '<li>&nbsp;</li>');

            // Replace completely empty <li></li> with <li>&nbsp;</li> to preserve empty items
            // This must be done BEFORE handling nested lists
            html = html.replace(/<li>\s*<\/li>/gi, '<li>&nbsp;</li>');

            // Don't add space before nested lists - Turndown will handle it
            // The custom listItem rule will detect empty list items with nested lists

            // Handle <li><br><ul>...</ul></li> - remove <br> before nested list
            html = html.replace(/<li>(<br>|<br\s*\/>)\s*(<ul>|<ol>)/gi, '<li>$2');


            let markdown = this.turndownService.turndown(html);

            // Post-process the markdown to fix indentation and spacing
            // 0. Replace EMPTYLINE placeholder with empty line
            // Each EMPTYLINE represents one extra blank line. Turndown already adds \n\n
            // between paragraphs, so we consume the preceding \n to avoid doubling.
            markdown = markdown.replace(/\nEMPTYLINE/g, '');
            // Handle EMPTYLINE at the very start of the document
            markdown = markdown.replace(/^EMPTYLINE\n?/g, '');

            // 0.5. Replace EMPTYCODE placeholder with actual empty code blocks
            markdown = markdown.replace(/```([^\n]*)\nEMPTYCODE_([A-Za-z0-9_-]+)_EMPTYCODE\n```/g, (match, lang1, lang2) => {
                const language = lang2 === 'NOLANG' ? '' : lang2;
                return '```' + language + '\n\n```';
            });
            // Also handle case where Turndown doesn't preserve the language in the fence
            markdown = markdown.replace(/EMPTYCODE_([A-Za-z0-9_-]+)_EMPTYCODE/g, (match, lang) => {
                const language = lang === 'NOLANG' ? '' : lang;
                return '```' + language + '\n\n```';
            });

            // 1. Fix list marker spacing: "-   " -> "- "
            markdown = markdown.replace(/^(\s*)-\s{2,}/gm, '$1- ');

            // 1.5. Ensure bare task markers become list items ("[ ]" -> "- [ ]")
            const taskLines = markdown.split('\n');
            let inTaskCodeBlock = false;
            for (let i = 0; i < taskLines.length; i++) {
                const line = taskLines[i];
                if (line.trim().startsWith('```')) {
                    inTaskCodeBlock = !inTaskCodeBlock;
                    continue;
                }
                if (inTaskCodeBlock) continue;
                taskLines[i] = line.replace(
                    /^(\s*(?:[-*+]|\d+\.)\s+)\\\[(\s|x|X)\\\](?=\s|$)/,
                    (_match, prefix, marker) => {
                        const checked = marker === 'x' || marker === 'X' ? 'x' : ' ';
                        return `${prefix}[${checked}]`;
                    }
                );
                const escapedBareMatch = taskLines[i].match(/^(\s*)\\\[(\s|x|X)\\\]\s*$/);
                if (escapedBareMatch) {
                    const indent = escapedBareMatch[1];
                    const checked = escapedBareMatch[2] === 'x' || escapedBareMatch[2] === 'X' ? 'x' : ' ';
                    taskLines[i] = `${indent}- [${checked}]`;
                    continue;
                }
                const bareMatch = taskLines[i].match(/^(\s*)\[(\s|x|X)\]\s*$/);
                if (bareMatch) {
                    const indent = bareMatch[1];
                    const checked = bareMatch[2] === 'x' || bareMatch[2] === 'X' ? 'x' : ' ';
                    taskLines[i] = `${indent}- [${checked}]`;
                }
            }
            markdown = taskLines.join('\n');

            // 2. Replace EMPTYLISTITEM placeholder and remove following whitespace-only lines
            // Convert EMPTYLISTITEM to &nbsp; so nested empty items don't get parsed as headings
            markdown = markdown.replace(/EMPTYLISTITEM/g, '&nbsp;');

            // Then, remove whitespace-only lines that appear after empty list items
            const linesForEmptyItemCleanup = markdown.split('\n');
            const cleanedLinesForEmptyItem: string[] = [];
            for (let i = 0; i < linesForEmptyItemCleanup.length; i++) {
                const line = linesForEmptyItemCleanup[i];
                const prevLine = i > 0 ? linesForEmptyItemCleanup[i - 1] : '';

                // Skip whitespace-only lines that come after an empty list item marker
                // Empty list item pattern: any amount of whitespace, then "- ", then optional whitespace, then end of line
                if (line.trim() === '' && line.length > 0) {
                    const isAfterEmptyListItem = /^\s*-\s*(?:&nbsp;)?\s*$/.test(prevLine);
                    if (isAfterEmptyListItem) {
                        continue;
                    }
                }
                cleanedLinesForEmptyItem.push(line);
            }
            markdown = cleanedLinesForEmptyItem.join('\n');

            // 3. Turndown already handles list indentation correctly with 2 spaces
            // Don't modify indentation as it may break nested list structure

            // 4. Handle empty list items (those with just whitespace)
            // Normalize truly empty markers while preserving &nbsp; for empty items
            markdown = markdown.replace(/^(\s*)-\s*$/gm, '$1- ');

            // 4. Fix pattern "- - " (empty list item followed by nested list on same line)
            // Convert to "- \n  - " (empty list item on its own line, then nested list)
            // This handles the case where Turndown outputs "  - - c" for <li> <ul><li>c</li></ul></li>
            markdown = markdown.replace(/^(\s*)-\s+-\s+/gm, (match, indent) => {
                // Calculate the indentation for the nested list (add 2 spaces)
                const nestedIndent = indent + '  ';
                return indent + '- \n' + nestedIndent + '- ';
            });

            // 4. Remove empty lines between list items only
            const lines = markdown.split('\n');
            const processedLines: string[] = [];

            // Track if we're inside a code block
            let inCodeBlock = false;


            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                // Check if we're entering or exiting a code block
                if (line.trim().startsWith('```')) {
                    inCodeBlock = !inCodeBlock;
                }

                // Skip empty lines between list items only (but not in code blocks)
                if (!inCodeBlock && line.trim() === '' && i > 0 && i < lines.length - 1) {
                    const prevLine = lines[i - 1];
                    const nextLine = lines[i + 1];
                    // Check if both surrounding lines are list items (with any indentation)
                    if (prevLine.match(/^\s*-\s+/) && nextLine.match(/^\s*-\s+/)) {
                        continue;
                    }
                }

                processedLines.push(line);
            }


            // Join lines
            markdown = processedLines.join('\n');

            // Don't trim trailing whitespace - it may be part of code blocks
            // Just ensure we end with a single newline
            if (!markdown.endsWith('\n')) {
                markdown += '\n';
            }
            return markdown;
        } catch (error) {
            console.error('Error converting HTML to Markdown:', error);
            // Fallback to simple text extraction
            return html.replace(/<[^>]*>/g, '').trim();
        }
    }

    private async saveImageFromDataUrl(
        dataUrl: string,
        mimeType: string,
        document: vscode.TextDocument,
        webview: vscode.Webview,
        options: { insert?: boolean; showNotification?: boolean } = {}
    ): Promise<void> {
        try {
            // Extract data from data URL (supports both base64 and URL-encoded data).
            const commaIndex = dataUrl.indexOf(',');
            if (commaIndex === -1) {
                throw new Error('Invalid data URL');
            }

            const header = dataUrl.substring(0, commaIndex);
            const dataPart = dataUrl.substring(commaIndex + 1);
            const isBase64 = /;base64/i.test(header);
            const headerMatch = header.match(/^data:([^;]+)/i);
            const headerMimeType = headerMatch ? headerMatch[1] : '';

            let buffer: Buffer;
            if (isBase64) {
                buffer = Buffer.from(dataPart, 'base64');
            } else {
                let decoded = dataPart;
                try {
                    decoded = decodeURIComponent(dataPart);
                } catch {
                    // Fall back to raw data if decode fails.
                }
                buffer = Buffer.from(decoded, 'utf8');
            }

            // Use the clipboard MIME type to choose the file extension.
            const normalizedMimeType = (mimeType || headerMimeType || '').toLowerCase();
            let extension = 'png';

            if (normalizedMimeType === 'image/jpeg' || normalizedMimeType === 'image/jpg') {
                extension = 'jpg';
            } else if (normalizedMimeType) {
                const rawExtension = normalizedMimeType.split('/')[1];
                if (rawExtension) {
                    extension = rawExtension.replace(/\+.*$/, '');
                }
            }

            // Get document filename without extension
            const documentFileName = document.uri.fsPath.substring(
                document.uri.fsPath.lastIndexOf('/') + 1,
                document.uri.fsPath.lastIndexOf('.')
            );

            // Create images directory structure: images/{documentFileName}/
            const documentDir = vscode.Uri.file(document.uri.fsPath.substring(0, document.uri.fsPath.lastIndexOf('/')));
            const imagesDir = vscode.Uri.joinPath(documentDir, 'images');
            const documentImagesDir = vscode.Uri.joinPath(imagesDir, documentFileName);

            // Create directories if they don't exist
            try {
                await vscode.workspace.fs.stat(imagesDir);
            } catch {
                await vscode.workspace.fs.createDirectory(imagesDir);
            }

            try {
                await vscode.workspace.fs.stat(documentImagesDir);
            } catch {
                await vscode.workspace.fs.createDirectory(documentImagesDir);
            }

            // Find next available filename with sequential numbering
            let filename: string;
            let imageUri: vscode.Uri;
            let counter = 1;

            // Try base filename first
            filename = `${documentFileName}.${extension}`;
            imageUri = vscode.Uri.joinPath(documentImagesDir, filename);

            try {
                await vscode.workspace.fs.stat(imageUri);
                // File exists, try with counter
                let fileExists = true;
                while (fileExists) {
                    counter++;
                    filename = `${documentFileName}-${counter}.${extension}`;
                    imageUri = vscode.Uri.joinPath(documentImagesDir, filename);
                    try {
                        await vscode.workspace.fs.stat(imageUri);
                    } catch {
                        fileExists = false;
                    }
                }
            } catch {
                // File doesn't exist, use base filename
            }

            // Save the image file
            await vscode.workspace.fs.writeFile(imageUri, buffer);

            // Create relative path for markdown
            const relativePath = `images/${documentFileName}/${filename}`;

            if (options.insert !== false) {
                // Send message back to webview to insert the markdown syntax
                webview.postMessage({
                    type: 'insertImage',
                    markdown: `![image](${relativePath})`,
                    src: webview.asWebviewUri(imageUri).toString()
                });
            } else if (options.showNotification) {
                vscode.window.showInformationMessage(`Image saved: ${relativePath}`);
            }

        } catch (error) {
            console.error('[saveImageFromDataUrl] Error saving image:', error);
            vscode.window.showErrorMessage('Failed to save image.');
        }
    }

    private getImageMimeTypeFromPath(pathLike: string): string {
        const normalized = (pathLike || '').split('#')[0].split('?')[0].toLowerCase();

        if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
        if (normalized.endsWith('.gif')) return 'image/gif';
        if (normalized.endsWith('.bmp')) return 'image/bmp';
        if (normalized.endsWith('.webp')) return 'image/webp';
        if (normalized.endsWith('.svg')) return 'image/svg+xml';
        if (normalized.endsWith('.avif')) return 'image/avif';
        if (normalized.endsWith('.ico')) return 'image/x-icon';
        if (normalized.endsWith('.heic')) return 'image/heic';
        if (normalized.endsWith('.heif')) return 'image/heif';
        if (normalized.endsWith('.tif') || normalized.endsWith('.tiff')) return 'image/tiff';

        return 'image/png';
    }

    private async saveImageFromUri(
        imageUriText: string,
        document: vscode.TextDocument,
        webview: vscode.Webview
    ): Promise<void> {
        try {
            if (!imageUriText || typeof imageUriText !== 'string') {
                throw new Error('Invalid image URI');
            }

            const raw = imageUriText.trim();
            if (!raw) {
                throw new Error('Empty image URI');
            }

            let sourceUri: vscode.Uri;
            if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
                sourceUri = vscode.Uri.parse(raw);
            } else if (raw.startsWith('/')) {
                sourceUri = vscode.Uri.file(raw);
            } else {
                const documentDir = vscode.Uri.file(document.uri.fsPath.substring(0, document.uri.fsPath.lastIndexOf('/')));
                sourceUri = vscode.Uri.joinPath(documentDir, raw);
            }

            if (sourceUri.scheme !== 'file') {
                throw new Error(`Unsupported URI scheme: ${sourceUri.scheme}`);
            }

            const bytes = await vscode.workspace.fs.readFile(sourceUri);
            const mimeType = this.getImageMimeTypeFromPath(sourceUri.path || sourceUri.fsPath);
            const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;

            await this.saveImageFromDataUrl(
                dataUrl,
                mimeType,
                document,
                webview,
                { insert: true, showNotification: false }
            );
        } catch (error) {
            console.error('[saveImageFromUri] Error saving image from URI:', error);
            vscode.window.showErrorMessage('Failed to save dropped image.');
        }
    }

    private async openImageFile(imageSrc: string, document: vscode.TextDocument): Promise<void> {
        try {

            // Skip data URIs
            if (imageSrc.startsWith('data:')) {
                vscode.window.showInformationMessage('Data URI images cannot be opened directly. Save the image as a file first.');
                return;
            }

            let imageUri: vscode.Uri;

            // Check if it's a webview URI
            if (imageSrc.includes('vscode-resource') || imageSrc.includes('vscode-webview-resource')) {
                // Parse the webview URI to get the file path
                // Webview URIs have format: vscode-webview-resource://authority/path
                // We need to extract the actual file path
                const uri = vscode.Uri.parse(imageSrc);

                // The fsPath should contain the actual file system path
                imageUri = vscode.Uri.file(uri.fsPath);
            } else if (imageSrc.startsWith('http://') || imageSrc.startsWith('https://')) {
                // External URL - open in browser
                vscode.env.openExternal(vscode.Uri.parse(imageSrc));
                return;
            } else {
                // Relative path - resolve relative to the document
                const documentDir = vscode.Uri.file(document.uri.fsPath.substring(0, document.uri.fsPath.lastIndexOf('/')));
                imageUri = vscode.Uri.joinPath(documentDir, imageSrc);
            }

            // Check if file exists
            try {
                await vscode.workspace.fs.stat(imageUri);
            } catch (statError) {
                console.error('[openImageFile] File does not exist:', imageUri.fsPath);
                vscode.window.showErrorMessage(`Image file not found: ${imageUri.fsPath}`);
                return;
            }

            // Open the image file with imagePreview.previewEditor command for better image viewing
            // This opens the image in a preview tab instead of as a binary file
            await vscode.commands.executeCommand('vscode.open', imageUri, {
                viewColumn: vscode.ViewColumn.Active,
                preview: true
            });
        } catch (error) {
            console.error('[openImageFile] Error opening image file:', error);
            vscode.window.showErrorMessage(`Failed to open image file: ${imageSrc}`);
        }
    }

    private async resolveImageSrcForWebview(
        imageSrc: string,
        document: vscode.TextDocument,
        webview: vscode.Webview
    ): Promise<string | null> {
        try {
            if (!imageSrc || typeof imageSrc !== 'string') {
                return null;
            }

            let decodedSrc = imageSrc.trim();
            if (!decodedSrc) {
                return null;
            }

            try {
                decodedSrc = decodeURIComponent(decodedSrc);
            } catch {
                // Use the original value when decode fails.
            }

            if (
                decodedSrc.startsWith('data:') ||
                decodedSrc.startsWith('http://') ||
                decodedSrc.startsWith('https://') ||
                decodedSrc.includes('vscode-resource') ||
                decodedSrc.includes('vscode-webview-resource')
            ) {
                return decodedSrc;
            }

            let sourceUri: vscode.Uri;
            if (/^[a-z][a-z0-9+.-]*:/i.test(decodedSrc)) {
                sourceUri = vscode.Uri.parse(decodedSrc);
            } else if (decodedSrc.startsWith('/')) {
                sourceUri = vscode.Uri.file(decodedSrc);
            } else {
                const documentDir = vscode.Uri.file(document.uri.fsPath.substring(0, document.uri.fsPath.lastIndexOf('/')));
                sourceUri = vscode.Uri.joinPath(documentDir, decodedSrc);
            }

            if (sourceUri.scheme !== 'file') {
                return null;
            }

            try {
                await vscode.workspace.fs.stat(sourceUri);
            } catch {
                return null;
            }

            return webview.asWebviewUri(sourceUri).toString();
        } catch (error) {
            console.error('[resolveImageSrcForWebview] Error resolving image src:', error);
            return null;
        }
    }

    private convertWebviewUrisToRelativePaths(html: string, document: vscode.TextDocument): string {
        // Convert webview URIs and absolute paths back to relative paths for images
        return html.replace(/<img([^>]*?)src="([^"]+)"([^>]*?)>/g, (match, before, src, after) => {

            // Decode URL-encoded src
            let decodedSrc = src;
            try {
                decodedSrc = decodeURIComponent(src);
            } catch (e) {
                // If decoding fails, use original
            }

            // Skip data URIs
            if (decodedSrc.startsWith('data:')) {
                return match;
            }

            // Skip external URLs (but not vscode-resource URLs)
            if ((decodedSrc.startsWith('http://') || decodedSrc.startsWith('https://')) &&
                !decodedSrc.includes('vscode-resource') && !decodedSrc.includes('vscode-webview-resource')) {
                return match;
            }

            try {
                let fsPath: string;

                // Check if it's a webview URI (including https://file+.vscode-resource...)
                if (decodedSrc.includes('vscode-resource') || decodedSrc.includes('vscode-webview-resource')) {
                    // Extract the file path from the webview URI
                    // Try to parse as URI first
                    try {
                        const uri = vscode.Uri.parse(decodedSrc);
                        fsPath = uri.fsPath;
                    } catch (parseError) {
                        // If parsing fails, try to extract path manually
                        // Format: https://file+.vscode-resource.vscode-cdn.net/path/to/file
                        const pathMatch = decodedSrc.match(/vscode-cdn\.net(.+)$/);
                        if (pathMatch) {
                            fsPath = pathMatch[1];
                        } else {
                            return match;
                        }
                    }
                } else if (decodedSrc.startsWith('/')) {
                    // Absolute path
                    fsPath = decodedSrc;
                } else {
                    // Already a relative path
                    return match;
                }

                // Get the document directory (where the .md file is located)
                const documentDir = document.uri.fsPath.substring(0, document.uri.fsPath.lastIndexOf('/'));

                // Try to make it relative to the document
                let relativePath = fsPath;

                // If the path starts with the document directory, make it relative
                if (fsPath.startsWith(documentDir)) {
                    relativePath = fsPath.substring(documentDir.length);
                    // Remove leading slash
                    if (relativePath.startsWith('/')) {
                        relativePath = relativePath.substring(1);
                    }
                }

                // Get alt text
                const altMatch = match.match(/alt="([^"]*)"/);
                const alt = altMatch ? altMatch[1] : '';


                return `<img${before}src="${relativePath}" alt="${alt}"${after}>`;
            } catch (error) {
                console.error('[convertWebviewUrisToRelativePaths] Error converting path to relative:', error);
                return match;
            }
        });
    }

    private getWebviewSettings(): { toolbarVisible: boolean; tocEnabled: boolean; useVsCodeCtrlP: boolean; listDashStyle: boolean } {
        const config = vscode.workspace.getConfiguration('manulDown');
        return {
            toolbarVisible: config.get<boolean>('toolbar.visible', true),
            tocEnabled: config.get<boolean>('toc.enabled', true),
            useVsCodeCtrlP: true,
            listDashStyle: config.get<boolean>('list.dashStyle', false),
        };
    }

    private getHtmlForWebview(webview: vscode.Webview, document: vscode.TextDocument): string {
        const nonce = getNonce();
        const settings = this.getWebviewSettings();
        const settingsJson = JSON.stringify(settings);
        const toolbarVisibleAttr = settings.toolbarVisible ? 'true' : 'false';
        const tocEnabledAttr = settings.tocEnabled ? 'true' : 'false';

        // Add timestamp to force cache refresh
        const timestamp = Date.now();
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.js')
        ).toString() + `?t=${timestamp}`;
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.css')
        ).toString() + `?t=${timestamp}`;

        // Prism.js for syntax highlighting
        const prismCssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'prismjs', 'themes', 'prism-tomorrow.css')
        );
        const prismJsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'prismjs', 'prism.js')
        );

        // Load common language components directly
        const prismPythonUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-python.min.js')
        );
        const prismTypescriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-typescript.min.js')
        );
        const prismJsonUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-json.min.js')
        );
        const prismBashUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-bash.min.js')
        );
        const mermaidUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data: vscode-resource:;">
    <link href="${styleUri}" rel="stylesheet">
    <link href="${prismCssUri}" rel="stylesheet">
    <title>ManulDown</title>
</head>
<body data-toolbar-visible="${toolbarVisibleAttr}" data-toc-enabled="${tocEnabledAttr}">
    <div class="toolbar">
        <button class="toolbar-btn" data-command="bold" title="Bold (Ctrl+B)">
            <strong>B</strong>
        </button>
        <button class="toolbar-btn" data-command="italic" title="Italic (Ctrl+I)">
            <em>I</em>
        </button>
        <button class="toolbar-btn" data-command="strikethrough" title="Strikethrough">
            <s>S</s>
        </button>
        <div class="toolbar-separator"></div>
        <button class="toolbar-btn" data-command="h1" title="Heading 1">H1</button>
        <button class="toolbar-btn" data-command="h2" title="Heading 2">H2</button>
        <button class="toolbar-btn" data-command="h3" title="Heading 3">H3</button>
        <div class="toolbar-separator"></div>
        <button class="toolbar-btn" data-command="ul" title="Bullet List">
            ${settings.listDashStyle ? '– List' : '• List'}
        </button>
        <button class="toolbar-btn" data-command="ol" title="Numbered List">
            1. List
        </button>
        <button class="toolbar-btn" data-command="checkbox" title="Task List">
            &#9745; List
        </button>
        <button class="toolbar-btn" data-command="quote" title="Quote">
            &gt; Quote
        </button>
        <div class="toolbar-separator"></div>
        <button class="toolbar-btn" data-command="codeblock" title="Insert Code Block">
            Code
        </button>
        <button class="toolbar-btn" data-command="table" title="Insert Table">
            Table
        </button>
    </div>
    <div class="editor-container">
        <div id="editor" contenteditable="true" spellcheck="false"></div>
        <div id="editor-scrollbar-indicator" aria-hidden="true">
            <div id="editor-scrollbar-thumb"></div>
        </div>
        <div id="toc-container">
            <div id="toc-header">Index</div>
            <div id="toc-content">
                <div id="toc-empty"></div>
            </div>
        </div>
    </div>
    <script nonce="${nonce}">window.__manulDownSettings = ${settingsJson};</script>
    <script nonce="${nonce}" src="${prismJsUri}"></script>
    <script nonce="${nonce}" src="${prismPythonUri}"></script>
    <script nonce="${nonce}" src="${prismTypescriptUri}"></script>
    <script nonce="${nonce}" src="${prismJsonUri}"></script>
    <script nonce="${nonce}" src="${prismBashUri}"></script>
    <script nonce="${nonce}" src="${mermaidUri}"></script>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

// Made with Bob
