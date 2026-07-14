import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { MarkdownDocument } from './MarkdownDocument';
import { getNonce } from '../utils/getNonce';
import TurndownService from 'turndown';
const { gfm } = require('turndown-plugin-gfm');

type CustomSlashCommandTemplate = {
    id: string;
    description: string;
    content: string;
};
type UnorderedListMarker = '-' | '*' | '+';
type EditorThemeMode = 'vscode' | 'light' | 'dark';
type MarkdownListLineInfo = {
    lineIndex: number;
    sequenceIndex: number;
    blockquotePrefix: string;
    indentWidth: number;
    textKey: string;
    isEmpty: boolean;
};

class ImageImportError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ImageImportError';
    }
}

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
    private static readonly viewType = 'manulDown.editor';
    private static readonly builtInSlashCommandIds = new Set(['table', 'quote', 'code', 'checkbox']);
    private static readonly customSlashTemplateDirectoryName = '.manuldown';
    private static readonly customSlashTemplateExtension = '.md';
    private static readonly maxCustomSlashCommands = 200;
    private static readonly maxCustomSlashTemplateBytes = 128 * 1024;
    private static readonly customSlashCommandCacheTtlMs = 2000;
    private static readonly maxImportedImageBytes = 20 * 1024 * 1024;
    private static readonly remoteImageTimeoutMs = 15_000;
    private static readonly maxInternalHeadingMarkerLength = 1024;
    private static readonly maxInternalListIndent = 1024;
    private static readonly defaultTocPanelWidthPx = 150;
    private static readonly minTocPanelWidthPx = 0;
    private static readonly maxTocPanelWidthPx = 480;
    private turndownService: TurndownService;
    private currentListIndent = '  ';
    private webviewPanels = new Map<string, vscode.WebviewPanel>();
    private pendingImageSavePaths = new Set<string>();
    private lastActivePanel: vscode.WebviewPanel | null = null;
    private customSlashCommandCache: { loadedAt: number; items: CustomSlashCommandTemplate[] } | null = null;
    private tocPanelWidthPx = MarkdownEditorProvider.defaultTocPanelWidthPx;
    private currentEmptyListItemMarker: string | null = null;
    public explicitlyRequested = false;

    constructor(private readonly context: vscode.ExtensionContext) {
        // Initialize Turndown service with proper settings for nested lists
        this.turndownService = new TurndownService({
            headingStyle: 'atx',
            hr: '---',
            bulletListMarker: this.getDefaultUnorderedListMarker(),
            codeBlockStyle: 'fenced',
            emDelimiter: '*',
            strongDelimiter: '**',
            // Default nested-list indentation (updated per document on save).
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

        // Override escape behavior:
        // - keep legacy behavior for backticks/hyphens
        // - collapse redundant escaping for already-escaped Markdown markers
        //   (e.g. "\*" should not become "\\\*")
        const originalEscape = (this.turndownService as any).escape;
        const redundantEscapedMarkerPattern = /\\\\\\([\\`*_{}\[\]()#+.!|>~])/g;
        (this.turndownService as any).escape = function (text: string) {
            // Call original escape first, then normalize selected sequences.
            const escaped = originalEscape.call(this, text);
            return escaped
                .replace(redundantEscapedMarkerPattern, '\\$1')
                .replace(/\\`/g, '`')
                .replace(/\\-/g, '-');
        };

        // Override nested-list indentation width (updated dynamically on save).
        (this.turndownService as any).options.indent = this.currentListIndent;

        // Keep default list handling - Turndown handles nested lists correctly by default
        // Just ensure proper indentation
        this.turndownService.keep(['br']);
        this.turndownService.addRule('lineBreak', {
            filter: 'br',
            replacement: function (_content: string, node: any) {
                const hasEncodedPrefix = !!(
                    node &&
                    typeof node.hasAttribute === 'function' &&
                    node.hasAttribute('data-mdw-break-prefix')
                );
                if (hasEncodedPrefix) {
                    const encodedPrefix = node.getAttribute('data-mdw-break-prefix');
                    if (typeof encodedPrefix === 'string' && /^(?:[0-9a-f]{2})*$/i.test(encodedPrefix)) {
                        return `${Buffer.from(encodedPrefix, 'hex').toString('utf8')}\n`;
                    }
                }
                const isSoftBreak = !!(
                    node &&
                    typeof node.getAttribute === 'function' &&
                    node.getAttribute('data-mdw-soft-break') === 'true'
                );
                return isSoftBreak ? '\n' : '  \n';
            }
        });

        this.turndownService.addRule('setextHeading', {
            filter: function (node: any) {
                return !!(
                    node &&
                    (node.nodeName === 'H1' || node.nodeName === 'H2') &&
                    typeof node.getAttribute === 'function' &&
                    node.getAttribute('data-mdw-heading-style') === 'setext'
                );
            },
            replacement: function (content: string, node: any) {
                const level = node.nodeName === 'H1' ? 1 : 2;
                const marker = level === 1 ? '=' : '-';
                const requestedLength = Number(node.getAttribute('data-mdw-heading-marker-length'));
                const markerLength = Number.isSafeInteger(requestedLength) && requestedLength > 0
                    ? Math.min(
                        requestedLength,
                        MarkdownEditorProvider.maxInternalHeadingMarkerLength
                    )
                    : 3;
                const normalizedContent = content.trim();
                if (!normalizedContent || normalizedContent.includes('\n')) {
                    return `\n\n${'#'.repeat(level)} ${normalizedContent}\n\n`;
                }
                return `\n\n${normalizedContent}\n${marker.repeat(markerLength)}\n\n`;
            }
        });

        const provider = this;
        this.turndownService.addRule('tableCell', {
            filter: ['th', 'td'],
            replacement: function (content: string, node: any) {
                const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
                const prefix = index === 0 ? '| ' : ' ';
                const cellContent = provider.serializeTableCellForMarkdown(node, content);
                return prefix + cellContent + ' |';
            }
        });

        // Add custom rule for list items to keep nested-list indentation stable.
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
                const isIndependentIndentWrapper = !!(
                    node &&
                    typeof node.getAttribute === 'function' &&
                    node.getAttribute('data-mdw-indent-wrapper') === 'true' &&
                    hasNestedList &&
                    directText.replace(/\u00A0/g, '').trim() === ''
                );
                const getSourceIndent = (element: any): number | null => {
                    if (!element || typeof element.getAttribute !== 'function') {
                        return null;
                    }
                    const rawValue = element.getAttribute('data-mdw-source-indent');
                    if (rawValue === null || rawValue === undefined || rawValue === '') {
                        return null;
                    }
                    const parsed = Number(rawValue);
                    return Number.isSafeInteger(parsed) &&
                        parsed >= 0 &&
                        parsed <= MarkdownEditorProvider.maxInternalListIndent
                        ? parsed
                        : null;
                };
                const findSourceIndentInListItem = (element: any): number | null => {
                    const ownIndent = getSourceIndent(element);
                    if (ownIndent !== null) {
                        return ownIndent;
                    }
                    const children = Array.prototype.slice.call(element?.children || []);
                    for (const child of children) {
                        const tagName = child.tagName || child.nodeName;
                        if (tagName !== 'UL' && tagName !== 'OL') {
                            continue;
                        }
                        const listItems = Array.prototype.slice.call(child.children || []);
                        for (const listItem of listItems) {
                            if ((listItem.tagName || listItem.nodeName) !== 'LI') {
                                continue;
                            }
                            const nestedIndent = findSourceIndentInListItem(listItem);
                            if (nestedIndent !== null) {
                                return nestedIndent;
                            }
                        }
                    }
                    return null;
                };
                const getFirstLineIndentWidth = (value: string): number => {
                    const lines = String(value || '').split('\n');
                    for (const line of lines) {
                        if (line.trim() === '') {
                            continue;
                        }
                        const indentMatch = line.match(/^([ \t]*)/);
                        return provider.getVisualIndentWidth(indentMatch ? indentMatch[1] : '');
                    }
                    return 0;
                };
                const inferSourceIndentFromAncestors = (element: any): number | null => {
                    if (!element) {
                        return null;
                    }

                    const indentUnit = Math.max(1, provider.getVisualIndentWidth(provider.currentListIndent));
                    let listLevelsFromSourceAncestor = 0;
                    let currentList = element.parentNode;

                    while (currentList) {
                        const listTagName = currentList.tagName || currentList.nodeName;
                        if (listTagName !== 'UL' && listTagName !== 'OL') {
                            currentList = currentList.parentNode;
                            continue;
                        }

                        const parentItem = currentList.parentNode;
                        if (!parentItem || (parentItem.tagName || parentItem.nodeName) !== 'LI') {
                            return listLevelsFromSourceAncestor * indentUnit;
                        }

                        listLevelsFromSourceAncestor++;
                        const parentSourceIndent = getSourceIndent(parentItem);
                        if (parentSourceIndent !== null) {
                            return parentSourceIndent + (listLevelsFromSourceAncestor * indentUnit);
                        }

                        currentList = parentItem.parentNode;
                    }

                    return null;
                };
                const getNestedContentIndent = (nestedContent: string): string => {
                    const parentSourceIndent = getSourceIndent(node) ?? inferSourceIndentFromAncestors(node);
                    if (parentSourceIndent === null) {
                        return provider.currentListIndent;
                    }

                    const nestedLists = Array.prototype.slice.call(node.children || []).filter((child: any) => {
                        const tagName = child.tagName || child.nodeName;
                        return tagName === 'UL' || tagName === 'OL';
                    });
                    for (const nestedList of nestedLists) {
                        const listItems = Array.prototype.slice.call(nestedList.children || []);
                        for (const listItem of listItems) {
                            if ((listItem.tagName || listItem.nodeName) !== 'LI') {
                                continue;
                            }
                            const childSourceIndent = findSourceIndentInListItem(listItem);
                            if (childSourceIndent !== null && childSourceIndent > parentSourceIndent) {
                                const targetRelativeIndent = childSourceIndent - parentSourceIndent;
                                const existingRelativeIndent = getFirstLineIndentWidth(nestedContent);
                                return ' '.repeat(Math.max(0, targetRelativeIndent - existingRelativeIndent));
                            }
                        }
                    }
                    return provider.currentListIndent;
                };

                // Check if this list item contains a checkbox (task list item)
                const hasCheckbox = node.querySelector('input[type="checkbox"]') !== null;

                // Check if this is a completely empty list item (no nested lists, just &nbsp; or empty)
                // Checkbox items are not considered "completely empty" even if they have no text
                const isCompletelyEmpty = !hasCheckbox && !hasNestedList && (directText.trim() === '' || directText.trim() === '\u00A0');
                const isNestedListItem = node.parentNode && node.parentNode.parentNode && node.parentNode.parentNode.nodeName === 'LI';

                if (isIndependentIndentWrapper) {
                    content = content
                        .replace(/^\n+/, '')
                        .replace(/\n+$/, '\n')
                        .replace(/^(?=.)/gm, provider.currentListIndent);

                    return content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
                } else if (isPreservedEmptyWithNestedList) {
                    // Preserved empty list item with nested list: <li>&nbsp;<ul><li>c</li></ul></li>
                    // This is intentionally created by the user (e.g., after backspace)
                    // Use a special marker that will be replaced with &nbsp; later
                    content = content
                        .replace(/^\n+/, '') // remove leading newlines
                        .replace(/\n+$/, '\n'); // replace trailing newlines with just a single one

                    const contentLines = content.split('\n');
                    while (
                        contentLines.length > 0 &&
                        contentLines[0].replace(/&nbsp;/gi, '').replace(/\u00A0/g, '').trim() === ''
                    ) {
                        contentLines.shift();
                    }
                    content = contentLines.join('\n');
                    content = content.replace(/^(?=.)/gm, getNestedContentIndent(content)); // indent nested content

                    let prefix = options.bulletListMarker + ' ';
                    const parent = node.parentNode;
                    if (parent.nodeName === 'OL') {
                        const start = parent.getAttribute('start');
                        const index = Array.prototype.indexOf.call(parent.children, node);
                        prefix = (start ? Number(start) + index : index + 1) + '. ';
                    }

                    // Return marker with special placeholder, then the nested content
                    if (!provider.currentEmptyListItemMarker) {
                        throw new Error('Empty list item marker is not initialized');
                    }
                    return prefix + provider.currentEmptyListItemMarker + '\n' + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
                } else if (isEmptyWithNestedList) {
                    // Empty list item with nested list (not preserved): <li><ul><li>b</li></ul></li>
                    // Output only the nested content without the parent marker
                    // This prevents double markers while preserving the nested list
                    content = content
                        .replace(/^\n+/, '') // remove leading newlines
                        .replace(/\n+$/, '\n') // replace trailing newlines with just a single one
                        .replace(/\n/gm, `\n${provider.currentListIndent}`); // indent

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
                        .replace(/\n/gm, `\n${provider.currentListIndent}`); // indent
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
            replacement: function (_content: string, node: any) {
                const encodedWhitespace = node?.getAttribute?.('data-mdw-code-whitespace');
                const encodedLeading = node?.getAttribute?.('data-mdw-code-leading');
                const encodedTrailing = node?.getAttribute?.('data-mdw-code-trailing');
                const decodeHex = (value: string | null | undefined): string =>
                    value && /^[0-9a-f]+$/i.test(value)
                        ? Buffer.from(value, 'hex').toString('utf8')
                        : '';
                const rawContent = encodedWhitespace
                    ? decodeHex(encodedWhitespace)
                    : `${decodeHex(encodedLeading)}${String(node?.textContent || '')}${decodeHex(encodedTrailing)}`;
                const longestBacktickRun = Math.max(
                    0,
                    ...Array.from(rawContent.matchAll(/`+/g), (match) => match[0].length)
                );
                const fence = '`'.repeat(Math.max(1, longestBacktickRun + 1));
                const needsPadding = rawContent.startsWith('`') ||
                    rawContent.endsWith('`') ||
                    (
                        rawContent.trim() !== '' &&
                        rawContent.startsWith(' ') &&
                        rawContent.endsWith(' ')
                    );
                const padding = needsPadding ? ' ' : '';
                return `${fence}${padding}${rawContent}${padding}${fence}`;
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

                // contenteditable may encode visual newlines as BR/DIV/P. Reading
                // textContent directly would concatenate those lines.
                const serializeCodeNode = (currentNode: any): string => {
                    if (!currentNode) {
                        return '';
                    }
                    if (currentNode.nodeType === 3) {
                        return currentNode.textContent || '';
                    }
                    if (currentNode.nodeType !== 1) {
                        return '';
                    }
                    const tagName = String(currentNode.tagName || currentNode.nodeName || '').toUpperCase();
                    if (tagName === 'BR') {
                        return '\n';
                    }

                    let text = '';
                    const children = Array.prototype.slice.call(currentNode.childNodes || []);
                    for (const child of children) {
                        const childTagName = child && child.nodeType === 1
                            ? String(child.tagName || child.nodeName || '').toUpperCase()
                            : '';
                        const isLineContainer = childTagName === 'DIV' || childTagName === 'P';
                        if (isLineContainer && text !== '' && !text.endsWith('\n')) {
                            text += '\n';
                        }
                        text += serializeCodeNode(child);
                    }
                    if ((tagName === 'DIV' || tagName === 'P') && !text.endsWith('\n')) {
                        text += '\n';
                    }
                    return text;
                };
                const encodedWhitespace = codeNode.getAttribute('data-mdw-whitespace-code');
                const code = encodedWhitespace && /^[0-9a-f]+$/i.test(encodedWhitespace)
                    ? Buffer.from(encodedWhitespace, 'hex').toString('utf8')
                    : serializeCodeNode(codeNode);

                // Preserve the code as-is, but ensure proper formatting
                let codeContent = code;
                if (code === '') {
                    // Empty code block - add a newline to preserve it
                    codeContent = '\n';
                } else {
                    // Ensure code ends with a newline if it doesn't already
                    // This ensures the closing ``` appears on its own line
                    if (!codeContent.endsWith('\n')) {
                        codeContent += '\n';
                    }
                }

                const longestBacktickRun = Math.max(
                    0,
                    ...Array.from(codeContent.matchAll(/`+/g), (match) => match[0].length)
                );
                const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
                // Format: \n\n```language\ncodeContent```\n\n
                // The codeContent already ends with \n, so closing fence will be on its own line
                const result = '\n\n' + fence + language + '\n' + codeContent + fence + '\n\n';

                return result;
            }
        });
    }

    private sanitizeTableCellText(value: string): string {
        return (value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/\|/g, '&#124;');
    }

    private serializeTableCellForMarkdown(node: any, convertedContent: string): string {
        const rawText = String(node?.textContent || '').replace(/\r\n?/g, '\n');
        const splitByBreakTokens = rawText
            .split(/<br\b[^>]*>/gi)
            .flatMap((part) => part.split('\n'));
        const lines = splitByBreakTokens
            .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim());

        // Keep leading empty lines to preserve intentional first-line breaks in table cells.
        while (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
        }

        if (lines.length === 0) {
            return '';
        }

        const normalizedContent = String(convertedContent || '')
            .replace(/\r\n?/g, '\n')
            .replace(/\n+/g, '<br>')
            .trim();
        if (normalizedContent !== '') {
            return normalizedContent.replace(/\|/g, '\\|');
        }
        return lines.map((line) => this.sanitizeTableCellText(line)).join('<br>');
    }

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const wasExplicit = this.explicitlyRequested;
        this.explicitlyRequested = false;
        if (!wasExplicit) {
            const openByDefault = vscode.workspace.getConfiguration('manulDown').get<boolean>('openByDefault', true);
            if (!openByDefault) {
                void this.reopenWithDefaultEditorAndCloseResidualCustomTabs(document.uri);
                return;
            }
        }

        // Setup webview options
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: this.getWebviewLocalResourceRoots(document),
        };

        // Set webview HTML content
        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document);
        this.keepEditorTabOpenOnExplorerClick(wasExplicit);

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
        let documentRenderErrorShown = false;
        const renderDocumentHtml = (): string | null => {
            try {
                const html = markdownDocument.toHtml();
                documentRenderErrorShown = false;
                return html;
            } catch (error) {
                console.error('[markdown render] Failed to render document:', error);
                if (!documentRenderErrorShown) {
                    documentRenderErrorShown = true;
                    void vscode.window.showErrorMessage(
                        'ManulDown could not render this Markdown document. The document was not changed.'
                    );
                }
                return null;
            }
        };

        // Track document text, not just change-event timing. VS Code can emit
        // onDidChangeTextDocument when only the dirty state changes, and an edit
        // event may arrive after applyEdit resolves. Timing alone therefore
        // misclassifies normal ManulDown edits as external changes.
        let lastObservedDocumentText = document.getText();
        let lastAppliedWebviewText: string | null = lastObservedDocumentText;
        const activeWebviewUpdateTexts = new Set<string>();
        let pendingWebviewUpdate: { html: string; revision: number } | null = null;
        let webviewUpdateFlushPromise: Promise<boolean> | null = null;
        let externalChangeSequence = 0;
        let unresolvedExternalChangeId = 0;
        let externalConflictPromptActive = false;
        type WebviewSyncSnapshot = { content: string; revision: number };
        type PendingSyncSnapshotRequest = {
            resolve: (snapshot: WebviewSyncSnapshot | null) => void;
            timeout: NodeJS.Timeout;
        };
        type ExpectedWillSaveUpdate = {
            revision: number;
            expectedDocumentVersion: number;
            timeout: NodeJS.Timeout;
        };
        const pendingSyncSnapshotRequests = new Map<string, PendingSyncSnapshotRequest>();
        const expectedWillSaveUpdates = new Map<string, ExpectedWillSaveUpdate>();
        let syncSnapshotRequestSequence = 0;
        let editorDisposed = false;
        let terminalActionQueue: Promise<void> = Promise.resolve();
        let saveSyncWarningShown = false;
        let synchronizedProgrammaticSaveInProgress = false;

        const normalizeWebviewRevision = (value: unknown): number =>
            typeof value === 'number' && Number.isFinite(value)
                ? Math.max(0, Math.floor(value))
                : 0;

        const getFullDocumentRange = (targetDocument: vscode.TextDocument): vscode.Range => {
            const lastLine = targetDocument.lineAt(targetDocument.lineCount - 1);
            return new vscode.Range(
                0,
                0,
                targetDocument.lineCount - 1,
                lastLine.text.length
            );
        };

        const settleSyncSnapshotRequest = (
            requestId: string,
            snapshot: WebviewSyncSnapshot | null
        ): void => {
            const pendingRequest = pendingSyncSnapshotRequests.get(requestId);
            if (!pendingRequest) {
                return;
            }
            pendingSyncSnapshotRequests.delete(requestId);
            clearTimeout(pendingRequest.timeout);
            pendingRequest.resolve(snapshot);
        };

        const requestWebviewSyncSnapshot = (
            reason: string,
            timeoutMs = 2000
        ): Promise<WebviewSyncSnapshot | null> => {
            if (
                editorDisposed ||
                this.webviewPanels.get(documentKey) !== webviewPanel
            ) {
                return Promise.resolve(null);
            }

            const requestId = `host-sync-${Date.now()}-${++syncSnapshotRequestSequence}`;
            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    settleSyncSnapshotRequest(requestId, null);
                }, Math.max(1, Math.floor(timeoutMs)));
                pendingSyncSnapshotRequests.set(requestId, { resolve, timeout });

                void webviewPanel.webview.postMessage({
                    type: 'prepareSyncSnapshot',
                    requestId,
                    reason,
                }).then(
                    (delivered) => {
                        if (!delivered) {
                            settleSyncSnapshotRequest(requestId, null);
                        }
                    },
                    () => settleSyncSnapshotRequest(requestId, null)
                );
            });
        };

        const registerExpectedWillSaveUpdate = (
            markdown: string,
            revision: number,
            expectedDocumentVersion: number
        ): void => {
            const previous = expectedWillSaveUpdates.get(markdown);
            if (previous) {
                clearTimeout(previous.timeout);
            }
            const timeout = setTimeout(() => {
                const current = expectedWillSaveUpdates.get(markdown);
                if (current?.timeout === timeout) {
                    expectedWillSaveUpdates.delete(markdown);
                }
            }, 10_000);
            expectedWillSaveUpdates.set(markdown, {
                revision,
                expectedDocumentVersion,
                timeout,
            });
        };

        const clearExpectedWillSaveUpdates = (): void => {
            for (const expectedUpdate of expectedWillSaveUpdates.values()) {
                clearTimeout(expectedUpdate.timeout);
            }
            expectedWillSaveUpdates.clear();
        };

        const enqueueTerminalAction = async (action: () => Promise<void>): Promise<void> => {
            const queuedAction = terminalActionQueue.then(action, action);
            terminalActionQueue = queuedAction.then(
                () => undefined,
                () => undefined
            );
            await queuedAction;
        };

        const reportSaveSyncFailure = (detail: string): void => {
            if (
                editorDisposed ||
                this.webviewPanels.get(documentKey) !== webviewPanel
            ) {
                return;
            }
            void webviewPanel.webview.postMessage({ type: 'retryPendingUpdate' });
            if (saveSyncWarningShown) {
                return;
            }
            saveSyncWarningShown = true;
            void vscode.window.showErrorMessage(
                `ManulDown could not synchronize the latest edit before saving (${detail}). Keep the editor open and save again.`
            );
        };

        const postExternalDocumentUpdate = (force = false): void => {
            if (unresolvedExternalChangeId === 0) {
                return;
            }
            const content = renderDocumentHtml();
            if (content === null) {
                return;
            }
            void webviewPanel.webview.postMessage({
                type: force ? 'refresh' : 'update',
                content,
                external: true,
                force,
                changeId: unresolvedExternalChangeId,
            });
        };

        const promptForExternalEditResolution = async (changeId: number): Promise<void> => {
            if (
                externalConflictPromptActive ||
                changeId <= 0 ||
                changeId !== unresolvedExternalChangeId
            ) {
                return;
            }

            externalConflictPromptActive = true;
            const reloadAction = 'Reload External Changes';
            const keepAction = 'Keep ManulDown Changes';
            try {
                const selection = await vscode.window.showWarningMessage(
                    'This Markdown file changed outside ManulDown while the editor had unsaved changes.',
                    { modal: true },
                    reloadAction,
                    keepAction
                );

                if (changeId !== unresolvedExternalChangeId) {
                    void webviewPanel.webview.postMessage({ type: 'retryPendingUpdate' });
                    return;
                }
                if (selection === reloadAction) {
                    pendingWebviewUpdate = null;
                    postExternalDocumentUpdate(true);
                    return;
                }
                if (selection === keepAction) {
                    unresolvedExternalChangeId = 0;
                    void webviewPanel.webview.postMessage({ type: 'requestSync' });
                    return;
                }

                // Dismissing the modal is not a resolution. Keep the local
                // revision pending and ask the Webview to retry after a pause,
                // so closing the dialog cannot silently turn into data loss.
                void webviewPanel.webview.postMessage({ type: 'retryPendingUpdate' });
            } finally {
                externalConflictPromptActive = false;
            }
        };

        const flushPendingWebviewUpdate = (): Promise<boolean> => {
            if (webviewUpdateFlushPromise) {
                return webviewUpdateFlushPromise;
            }

            let operationSucceeded = true;
            const operation = (async (): Promise<boolean> => {
                try {
                    while (pendingWebviewUpdate !== null && unresolvedExternalChangeId === 0) {
                        const updateToApply = pendingWebviewUpdate;
                        pendingWebviewUpdate = null;
                        const markdown = this.normalizeLineEndingsForDocument(
                            this.htmlToMarkdown(updateToApply.html, document),
                            document
                        );
                        activeWebviewUpdateTexts.add(markdown);
                        let applied = false;
                        try {
                            applied = await this.updateTextDocument(document, markdown);
                        } finally {
                            activeWebviewUpdateTexts.delete(markdown);
                        }
                        const appliedTextIsCurrent = applied && document.getText() === markdown;
                        if (appliedTextIsCurrent) {
                            lastObservedDocumentText = markdown;
                            lastAppliedWebviewText = markdown;
                            void webviewPanel.webview.postMessage({
                                type: 'updateApplied',
                                revision: updateToApply.revision,
                            });
                        } else if (!applied) {
                            operationSucceeded = false;
                            void webviewPanel.webview.postMessage({ type: 'retryPendingUpdate' });
                        }

                        // applyEdit normally emits the document-change event while
                        // the expected-text marker is active. If another writer races that edit,
                        // detect the final text mismatch explicitly instead of
                        // suppressing the external change with our own event.
                        if (applied && !appliedTextIsCurrent) {
                            operationSucceeded = false;
                            if (unresolvedExternalChangeId === 0) {
                                unresolvedExternalChangeId = ++externalChangeSequence;
                                postExternalDocumentUpdate();
                            }
                        }
                    }
                    return operationSucceeded &&
                        pendingWebviewUpdate === null &&
                        unresolvedExternalChangeId === 0;
                } catch (error) {
                    console.error('[webview update] Failed to apply editor update:', error);
                    void vscode.window.showErrorMessage(
                        'ManulDown could not convert the edit to Markdown. The document was not changed.'
                    );
                    return false;
                }
            })();

            webviewUpdateFlushPromise = operation;
            const finishOperation = (): void => {
                if (webviewUpdateFlushPromise !== operation) {
                    return;
                }
                webviewUpdateFlushPromise = null;
                // A message can arrive after the drain loop decides it is empty
                // but before this cleanup microtask runs. Start a fresh drain so
                // that update cannot remain stranded.
                if (
                    pendingWebviewUpdate !== null &&
                    unresolvedExternalChangeId === 0 &&
                    !editorDisposed
                ) {
                    void flushPendingWebviewUpdate();
                }
            };
            void operation.then(finishOperation, finishOperation);
            return operation;
        };

        const flushAllPendingWebviewUpdates = async (): Promise<boolean> => {
            while (pendingWebviewUpdate !== null && unresolvedExternalChangeId === 0) {
                const succeeded = await flushPendingWebviewUpdate();
                if (!succeeded && pendingWebviewUpdate === null) {
                    return false;
                }
                // flushPendingWebviewUpdate may have returned an operation that was
                // already resolving when a newer snapshot arrived. Its cleanup runs
                // in a microtask; yield once before starting the next drain.
                await Promise.resolve();
            }
            return pendingWebviewUpdate === null && unresolvedExternalChangeId === 0;
        };

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'syncSnapshot':
                        if (typeof message.requestId === 'string') {
                            settleSyncSnapshotRequest(
                                message.requestId,
                                {
                                    content: typeof message.content === 'string' ? message.content : '',
                                    revision: normalizeWebviewRevision(message.revision),
                                }
                            );
                        }
                        break;
                    case 'update':
                        if (unresolvedExternalChangeId !== 0) {
                            postExternalDocumentUpdate();
                            break;
                        }
                        pendingWebviewUpdate = {
                            html: typeof message.content === 'string' ? message.content : '',
                            revision: normalizeWebviewRevision(message.revision),
                        };
                        void flushPendingWebviewUpdate();
                        break;
                    case 'saveDocument':
                        await enqueueTerminalAction(async () => {
                            if (
                                editorDisposed ||
                                this.webviewPanels.get(documentKey) !== webviewPanel
                            ) {
                                return;
                            }
                            if (unresolvedExternalChangeId !== 0) {
                                postExternalDocumentUpdate();
                                reportSaveSyncFailure('an external edit conflict is unresolved');
                                return;
                            }
                            pendingWebviewUpdate = {
                                html: typeof message.content === 'string' ? message.content : '',
                                revision: normalizeWebviewRevision(message.revision),
                            };
                            if (
                                await flushAllPendingWebviewUpdates() &&
                                !editorDisposed &&
                                this.webviewPanels.get(documentKey) === webviewPanel
                            ) {
                                synchronizedProgrammaticSaveInProgress = true;
                                let saved = false;
                                try {
                                    saved = await document.save();
                                } finally {
                                    synchronizedProgrammaticSaveInProgress = false;
                                }
                                if (!saved) {
                                    void vscode.window.showErrorMessage(
                                        'ManulDown synchronized the edit, but VS Code could not save the Markdown file.'
                                    );
                                }
                            }
                        });
                        break;
                    case 'externalUpdateApplied':
                        if (
                            Number.isFinite(message.changeId) &&
                            Math.floor(message.changeId) === unresolvedExternalChangeId
                        ) {
                            unresolvedExternalChangeId = 0;
                        }
                        break;
                    case 'externalEditConflict':
                        if (Number.isFinite(message.changeId)) {
                            void promptForExternalEditResolution(Math.floor(message.changeId));
                        }
                        break;
                    case 'ready':
                        // Send initial content to webview
                        const initialHtml = renderDocumentHtml();
                        if (initialHtml === null) {
                            webviewPanel.webview.postMessage({ type: 'loadError' });
                        } else {
                            webviewPanel.webview.postMessage({
                                type: 'init',
                                content: initialHtml,
                            });
                        }
                        await this.postCustomSlashCommands(webviewPanel.webview);
                        break;
                    case 'requestCustomSlashCommands':
                        await this.postCustomSlashCommands(webviewPanel.webview);
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
                                showNotification: message.insert === false,
                                requestId: typeof message.requestId === 'string'
                                    ? message.requestId
                                    : undefined
                            }
                        );
                        break;
                    case 'saveImageFromUri':
                        // Save a dropped local image URI (e.g. Finder drag-and-drop)
                        await this.saveImageFromUri(
                            message.uri,
                            document,
                            webviewPanel.webview,
                            {
                                altText: typeof message.altText === 'string' ? message.altText : undefined,
                                source: message.source === 'drop' ||
                                    message.source === 'paste' ||
                                    message.source === 'internal'
                                    ? message.source
                                    : 'unknown',
                                requestId: typeof message.requestId === 'string'
                                    ? message.requestId
                                    : undefined
                            }
                        );
                        break;
                    case 'imageImportTooLarge':
                        void vscode.window.showErrorMessage(
                            this.getImageTooLargeMessage()
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
                        // Open external links. file:// links are opt-in because they can
                        // launch local files, applications, or network shares.
                        if (typeof message.url === 'string') {
                            const rawUrl = message.url.trim();
                            const allowFileLinks = vscode.workspace
                                .getConfiguration('manulDown')
                                .get<boolean>('security.allowFileLinks', false);
                            const targetUri = vscode.Uri.parse(rawUrl);
                            if (targetUri.scheme === 'http' || targetUri.scheme === 'https' || targetUri.scheme === 'mailto') {
                                await vscode.env.openExternal(targetUri);
                            } else if (targetUri.scheme === 'file' && allowFileLinks) {
                                await vscode.env.openExternal(targetUri);
                            } else if (!/^[a-z][a-z0-9+.-]*:/i.test(rawUrl) && !rawUrl.startsWith('#')) {
                                const fragmentIndex = rawUrl.indexOf('#');
                                const rawPath = fragmentIndex >= 0 ? rawUrl.slice(0, fragmentIndex) : rawUrl;
                                const fragment = fragmentIndex >= 0 ? rawUrl.slice(fragmentIndex + 1) : '';
                                let decodedPath = rawPath;
                                try {
                                    decodedPath = decodeURIComponent(rawPath);
                                } catch {
                                    // Use the literal Markdown path if decoding fails.
                                }
                                const relativeTarget = this.resolveImageSourceUri(decodedPath, document).with({ fragment });
                                const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
                                const isInsideWorkspace = !!workspaceFolder &&
                                    this.isUriWithinDirectory(relativeTarget, workspaceFolder.uri);
                                if (isInsideWorkspace || allowFileLinks) {
                                    await vscode.commands.executeCommand('vscode.open', relativeTarget);
                                }
                            }
                        }
                        break;
                    case 'writeClipboard':
                        {
                            const requestId = typeof message.requestId === 'string' ? message.requestId : '';
                            try {
                                await vscode.env.clipboard.writeText(
                                    typeof message.text === 'string' ? message.text : ''
                                );
                                if (requestId) {
                                    webviewPanel.webview.postMessage({
                                        type: 'clipboardWriteResult',
                                        requestId,
                                        success: true
                                    });
                                }
                            } catch (error) {
                                console.error('[clipboard] Failed to write clipboard:', error);
                                if (requestId) {
                                    webviewPanel.webview.postMessage({
                                        type: 'clipboardWriteResult',
                                        requestId,
                                        success: false,
                                        error: error instanceof Error ? error.message : String(error)
                                    });
                                }
                            }
                        }
                        break;
                    case 'tocPanelWidthChanged':
                        this.updateSharedTocPanelWidth(message.width);
                        break;
                    case 'switchEditorTab':
                        if (message.direction === 'next') {
                            await vscode.commands.executeCommand('workbench.action.nextEditor');
                        } else if (message.direction === 'previous') {
                            await vscode.commands.executeCommand('workbench.action.previousEditor');
                        }
                        break;
                    case 'closeEditorTab':
                        await enqueueTerminalAction(async () => {
                            if (
                                editorDisposed ||
                                this.webviewPanels.get(documentKey) !== webviewPanel
                            ) {
                                return;
                            }
                            if (unresolvedExternalChangeId !== 0) {
                                postExternalDocumentUpdate();
                                return;
                            }
                            pendingWebviewUpdate = {
                                html: typeof message.content === 'string' ? message.content : '',
                                revision: normalizeWebviewRevision(message.revision),
                            };
                            if (
                                await flushAllPendingWebviewUpdates() &&
                                !editorDisposed &&
                                this.webviewPanels.get(documentKey) === webviewPanel
                            ) {
                                // The flush can take long enough for focus to move to a
                                // different tab. Close the originating custom-editor tab,
                                // never whichever editor happens to be active now.
                                await this.closeResidualCustomTabs(document.uri);
                            }
                        });
                        break;
                }
            }
        );

        // Handle document changes (external edits)
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.uri.toString() !== document.uri.toString()) {
                return;
            }

            const observedText = e.document.getText();
            if (observedText === lastObservedDocumentText) {
                // Dirty-state/save notifications can have no text difference.
                return;
            }
            lastObservedDocumentText = observedText;

            const expectedWillSaveUpdate = expectedWillSaveUpdates.get(observedText);
            if (expectedWillSaveUpdate) {
                expectedWillSaveUpdates.delete(observedText);
                clearTimeout(expectedWillSaveUpdate.timeout);
                if (e.document.version >= expectedWillSaveUpdate.expectedDocumentVersion) {
                    clearExpectedWillSaveUpdates();
                    lastAppliedWebviewText = observedText;
                    void webviewPanel.webview.postMessage({
                        type: 'updateApplied',
                        revision: expectedWillSaveUpdate.revision,
                    });
                    return;
                }
            }

            // Any other text change means the pre-save transaction was ignored
            // or combined with a concurrent edit. Do not let a stale text-only
            // marker misclassify a later external change.
            clearExpectedWillSaveUpdates();

            if (
                activeWebviewUpdateTexts.has(observedText) ||
                observedText === lastAppliedWebviewText
            ) {
                return;
            }

            lastAppliedWebviewText = null;
            unresolvedExternalChangeId = ++externalChangeSequence;
            postExternalDocumentUpdate();
        });

        const configurationChangeSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('manulDown')) {
                webviewPanel.webview.postMessage({
                    type: 'settings',
                    settings: this.getWebviewSettings(),
                });
            }
        });

        const willSaveDocumentSubscription = vscode.workspace.onWillSaveTextDocument((event) => {
            if (
                event.document.uri.toString() !== document.uri.toString() ||
                editorDisposed ||
                this.webviewPanels.get(documentKey) !== webviewPanel
            ) {
                return;
            }

            // A save requested by this Webview already flushed and acknowledged
            // its exact snapshot before calling document.save(). Avoid a second
            // round-trip that can only add latency or a false timeout warning.
            if (synchronizedProgrammaticSaveInProgress) {
                return;
            }

            event.waitUntil((async (): Promise<vscode.TextEdit[]> => {
                // VS Code shares a short time budget among all will-save listeners.
                // Fetch the Webview snapshot alongside any in-flight host update,
                // and keep enough headroom for conversion and other extensions.
                const syncDeadline = Date.now() + 750;
                const conversionHeadroomMs = 250;
                const timeoutMarker = Symbol('will-save-timeout');
                const waitUntilDeadline = async <T>(promise: Promise<T>): Promise<T | typeof timeoutMarker> => {
                    const remainingMs = syncDeadline - Date.now() - conversionHeadroomMs;
                    if (remainingMs <= 0) {
                        return timeoutMarker;
                    }
                    let timeout: NodeJS.Timeout | null = null;
                    try {
                        return await Promise.race([
                            promise,
                            new Promise<typeof timeoutMarker>((resolve) => {
                                timeout = setTimeout(() => resolve(timeoutMarker), remainingMs);
                            }),
                        ]);
                    } finally {
                        if (timeout) {
                            clearTimeout(timeout);
                        }
                    }
                };

                const snapshotTimeoutMs = Math.max(
                    1,
                    syncDeadline - Date.now() - conversionHeadroomMs
                );
                const pendingFlush = webviewUpdateFlushPromise ?? Promise.resolve(true);
                const syncResult = await waitUntilDeadline(Promise.all([
                    pendingFlush,
                    requestWebviewSyncSnapshot('willSave', snapshotTimeoutMs),
                ]));
                if (syncResult === timeoutMarker) {
                    console.warn('[save sync] Timed out while preparing the ManulDown save snapshot.');
                    reportSaveSyncFailure('the Webview did not respond in time');
                    return [];
                }

                const [flushSucceeded, snapshot] = syncResult;
                if (
                    !flushSucceeded ||
                    unresolvedExternalChangeId !== 0 ||
                    editorDisposed ||
                    this.webviewPanels.get(documentKey) !== webviewPanel
                ) {
                    if (
                        !editorDisposed &&
                        this.webviewPanels.get(documentKey) === webviewPanel
                    ) {
                        reportSaveSyncFailure(
                            unresolvedExternalChangeId !== 0
                                ? 'an external edit conflict is unresolved'
                                : 'a pending editor update failed'
                        );
                    }
                    return [];
                }
                if (
                    !snapshot ||
                    unresolvedExternalChangeId !== 0 ||
                    editorDisposed ||
                    this.webviewPanels.get(documentKey) !== webviewPanel
                ) {
                    if (
                        !snapshot &&
                        !editorDisposed &&
                        this.webviewPanels.get(documentKey) === webviewPanel
                    ) {
                        console.warn('[save sync] Timed out waiting for the ManulDown Webview snapshot.');
                        reportSaveSyncFailure('the Webview snapshot was unavailable');
                    }
                    return [];
                }

                let markdown: string;
                try {
                    markdown = this.normalizeLineEndingsForDocument(
                        this.htmlToMarkdown(snapshot.content, event.document),
                        event.document
                    );
                } catch (error) {
                    console.error('[save sync] Failed to convert the latest Webview snapshot:', error);
                    void vscode.window.showErrorMessage(
                        'ManulDown could not synchronize the latest edit before saving.'
                    );
                    void webviewPanel.webview.postMessage({ type: 'retryPendingUpdate' });
                    return [];
                }

                if (
                    Date.now() >= syncDeadline ||
                    editorDisposed ||
                    this.webviewPanels.get(documentKey) !== webviewPanel
                ) {
                    if (
                        !editorDisposed &&
                        this.webviewPanels.get(documentKey) === webviewPanel
                    ) {
                        reportSaveSyncFailure('snapshot conversion exceeded the save deadline');
                    }
                    return [];
                }

                saveSyncWarningShown = false;

                if (markdown === event.document.getText()) {
                    void webviewPanel.webview.postMessage({
                        type: 'updateApplied',
                        revision: snapshot.revision,
                    });
                    return [];
                }

                registerExpectedWillSaveUpdate(
                    markdown,
                    snapshot.revision,
                    event.document.version + 1
                );
                return [vscode.TextEdit.replace(getFullDocumentRange(event.document), markdown)];
            })());
        });

        const didSaveDocumentSubscription = vscode.workspace.onDidSaveTextDocument((savedDocument) => {
            if (savedDocument.uri.toString() === document.uri.toString()) {
                const savedText = savedDocument.getText();
                const expectedUpdate = expectedWillSaveUpdates.get(savedText);
                if (
                    expectedUpdate &&
                    savedDocument.version >= expectedUpdate.expectedDocumentVersion
                ) {
                    // onDidSave can arrive before the corresponding document-change
                    // notification. Confirm the completed transaction from the saved
                    // text/version so that the delayed event is not reported as external.
                    lastObservedDocumentText = savedText;
                    lastAppliedWebviewText = savedText;
                    void webviewPanel.webview.postMessage({
                        type: 'updateApplied',
                        revision: expectedUpdate.revision,
                    });
                } else if (expectedWillSaveUpdates.size > 0) {
                    reportSaveSyncFailure('the pre-save edit was not applied');
                }
                clearExpectedWillSaveUpdates();
            }
        });

        // Cleanup
        webviewPanel.onDidDispose(() => {
            editorDisposed = true;
            changeDocumentSubscription.dispose();
            configurationChangeSubscription.dispose();
            willSaveDocumentSubscription.dispose();
            didSaveDocumentSubscription.dispose();
            for (const requestId of Array.from(pendingSyncSnapshotRequests.keys())) {
                settleSyncSnapshotRequest(requestId, null);
            }
            clearExpectedWillSaveUpdates();
            if (this.webviewPanels.get(documentKey) === webviewPanel) {
                this.webviewPanels.delete(documentKey);
            }
            if (this.lastActivePanel === webviewPanel) {
                this.lastActivePanel = null;
            }
        });
    }

    public postMessageToActiveEditor(message: any, options?: { reveal?: boolean }): boolean {
        const panel = this.getActiveWebviewPanel();
        if (!panel) {
            return false;
        }
        if (options?.reveal) {
            panel.reveal(panel.viewColumn, false);
            this.lastActivePanel = panel;
        }
        panel.webview.postMessage(message);
        return true;
    }

    private normalizeTocPanelWidth(width: unknown): number {
        if (typeof width !== 'number' || !Number.isFinite(width)) {
            return this.tocPanelWidthPx;
        }
        const roundedWidth = Math.round(width);
        return Math.max(
            MarkdownEditorProvider.minTocPanelWidthPx,
            Math.min(MarkdownEditorProvider.maxTocPanelWidthPx, roundedWidth)
        );
    }

    private updateSharedTocPanelWidth(width: unknown): void {
        const nextWidth = this.normalizeTocPanelWidth(width);
        if (nextWidth === this.tocPanelWidthPx) {
            return;
        }
        this.tocPanelWidthPx = nextWidth;
        this.postSettingsToAllPanels();
    }

    private postSettingsToAllPanels(): void {
        const settings = this.getWebviewSettings();
        for (const panel of this.webviewPanels.values()) {
            panel.webview.postMessage({
                type: 'settings',
                settings,
            });
        }
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

        if (this.lastActivePanel && this.lastActivePanel.visible) {
            return this.lastActivePanel;
        }

        const visiblePanels = Array.from(this.webviewPanels.values()).filter((panel) => panel.visible);
        if (visiblePanels.length === 1) {
            const [visiblePanel] = visiblePanels;
            this.lastActivePanel = visiblePanel;
            return visiblePanel;
        }

        if (this.webviewPanels.size === 1) {
            const onlyPanel = Array.from(this.webviewPanels.values())[0];
            this.lastActivePanel = onlyPanel;
            return onlyPanel;
        }

        return null;
    }

    private keepEditorTabOpenOnExplorerClick(wasExplicit: boolean): void {
        if (wasExplicit) {
            return;
        }

        // Avoid preview-tab replacement when opening Markdown from Explorer.
        setTimeout(() => {
            void vscode.commands.executeCommand('workbench.action.keepEditor');
        }, 0);
    }

    private async reopenWithDefaultEditorAndCloseResidualCustomTabs(documentUri: vscode.Uri): Promise<void> {
        try {
            await vscode.commands.executeCommand('vscode.openWith', documentUri, 'default');
        } finally {
            await this.closeResidualCustomTabs(documentUri);
        }
    }

    private async closeResidualCustomTabs(documentUri: vscode.Uri): Promise<void> {
        const customTabs = vscode.window.tabGroups.all.flatMap((group) =>
            group.tabs.filter((tab) => {
                const input = tab.input;
                return (
                    input instanceof vscode.TabInputCustom &&
                    input.viewType === MarkdownEditorProvider.viewType &&
                    input.uri.toString() === documentUri.toString()
                );
            })
        );

        if (customTabs.length === 0) {
            return;
        }

        await vscode.window.tabGroups.close(customTabs, true);
    }

    private getCustomSlashTemplateRootUri(): vscode.Uri {
        const rootPath = path.join(
            os.homedir(),
            MarkdownEditorProvider.customSlashTemplateDirectoryName
        );
        return vscode.Uri.file(rootPath);
    }

    private getWebviewLocalResourceRoots(document: vscode.TextDocument): vscode.Uri[] {
        const roots = new Map<string, vscode.Uri>();
        const pushRoot = (uri: vscode.Uri | undefined) => {
            if (!uri) {
                return;
            }
            roots.set(uri.toString(), uri);
        };

        pushRoot(this.context.extensionUri);
        pushRoot(vscode.workspace.getWorkspaceFolder(document.uri)?.uri);
        pushRoot(this.getDocumentDirectoryUri(document));

        return Array.from(roots.values());
    }

    private normalizeSlashCommandIdFromFileName(fileName: string): string {
        return fileName
            .trim()
            .replace(/^\/+/, '')
            .replace(/\s+/g, '-')
            .replace(/[\/\\]/g, '-')
            .replace(/^-+/, '')
            .replace(/-+$/, '')
            .toLowerCase();
    }

    private async collectMarkdownTemplateFiles(
        directoryUri: vscode.Uri,
        output: vscode.Uri[]
    ): Promise<void> {
        if (output.length >= MarkdownEditorProvider.maxCustomSlashCommands) {
            return;
        }

        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(directoryUri);
        } catch {
            return;
        }

        entries.sort((a, b) => a[0].localeCompare(b[0], 'en'));

        for (const [name, fileType] of entries) {
            if (output.length >= MarkdownEditorProvider.maxCustomSlashCommands) {
                return;
            }

            const childUri = vscode.Uri.joinPath(directoryUri, name);
            if (fileType === vscode.FileType.Directory) {
                await this.collectMarkdownTemplateFiles(childUri, output);
                continue;
            }
            if (fileType !== vscode.FileType.File) {
                continue;
            }

            if (!name.toLowerCase().endsWith(MarkdownEditorProvider.customSlashTemplateExtension)) {
                continue;
            }

            output.push(childUri);
        }
    }

    private async loadCustomSlashCommandsFromDisk(): Promise<CustomSlashCommandTemplate[]> {
        const templateRootUri = this.getCustomSlashTemplateRootUri();

        try {
            const rootStat = await vscode.workspace.fs.stat(templateRootUri);
            if ((rootStat.type & vscode.FileType.Directory) === 0) {
                return [];
            }
        } catch {
            return [];
        }

        const markdownFiles: vscode.Uri[] = [];
        await this.collectMarkdownTemplateFiles(templateRootUri, markdownFiles);
        if (markdownFiles.length === 0) {
            return [];
        }

        const usedIds = new Set<string>();
        const templates: CustomSlashCommandTemplate[] = [];

        for (const fileUri of markdownFiles) {
            if (templates.length >= MarkdownEditorProvider.maxCustomSlashCommands) {
                break;
            }

            const parsed = path.parse(fileUri.fsPath);
            const commandId = this.normalizeSlashCommandIdFromFileName(parsed.name);
            if (!commandId) {
                continue;
            }
            if (MarkdownEditorProvider.builtInSlashCommandIds.has(commandId)) {
                continue;
            }
            if (usedIds.has(commandId)) {
                continue;
            }

            let fileContent: Uint8Array;
            try {
                fileContent = await vscode.workspace.fs.readFile(fileUri);
            } catch {
                continue;
            }

            if (fileContent.byteLength > MarkdownEditorProvider.maxCustomSlashTemplateBytes) {
                continue;
            }

            const markdownText = Buffer.from(fileContent).toString('utf8');
            if (markdownText.trim() === '') {
                continue;
            }

            const relativePath = path
                .relative(templateRootUri.fsPath, fileUri.fsPath)
                .replace(/\\/g, '/');

            templates.push({
                id: commandId,
                description: `Template: ${relativePath}`,
                content: markdownText
            });
            usedIds.add(commandId);
        }

        return templates;
    }

    private async getCustomSlashCommands(): Promise<CustomSlashCommandTemplate[]> {
        const now = Date.now();
        if (
            this.customSlashCommandCache &&
            now - this.customSlashCommandCache.loadedAt < MarkdownEditorProvider.customSlashCommandCacheTtlMs
        ) {
            return this.customSlashCommandCache.items;
        }

        const items = await this.loadCustomSlashCommandsFromDisk();
        this.customSlashCommandCache = {
            loadedAt: now,
            items
        };
        return items;
    }

    private async postCustomSlashCommands(webview: vscode.Webview): Promise<void> {
        try {
            const commands = await this.getCustomSlashCommands();
            webview.postMessage({
                type: 'customSlashCommands',
                commands
            });
        } catch (error) {
            console.error('[customSlashCommands] Failed to load templates:', error);
            webview.postMessage({
                type: 'customSlashCommands',
                commands: []
            });
        }
    }

    private async updateTextDocument(
        document: vscode.TextDocument,
        markdown: string
    ): Promise<boolean> {
        if (markdown === document.getText()) {
            return true;
        }

        const edit = new vscode.WorkspaceEdit();

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

        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            vscode.window.showErrorMessage('Failed to apply the ManulDown editor update.');
        }
        return applied;
    }

    private getDefaultUnorderedListMarker(): UnorderedListMarker {
        const useDashStyle = vscode.workspace
            .getConfiguration('manulDown')
            .get<boolean>('list.dashStyle', false);
        return useDashStyle ? '-' : '*';
    }

    private getDefaultListIndentSize(): number {
        const configuredIndentSize = vscode.workspace
            .getConfiguration('manulDown')
            .get<number>('list.indentSize', 2);
        return configuredIndentSize === 4 ? 4 : 2;
    }

    private getVisualIndentWidth(value: string): number {
        let width = 0;
        for (const char of value) {
            if (char === '\t') {
                width += 4;
            } else if (char === ' ') {
                width += 1;
            }
        }
        return width;
    }

    private stripLeadingBlockquotePrefix(line: string): string {
        return line.replace(/^\s*(?:>[ \t]?)+/, '');
    }

    private getBlockquoteDepth(line: string): number {
        const prefixMatch = line.match(/^\s*(?:>[ \t]?)+/);
        if (!prefixMatch) {
            return 0;
        }
        const markers = prefixMatch[0].match(/>/g);
        return markers ? markers.length : 0;
    }

    private getFencedCodeLineMask(lines: string[]): boolean[] {
        const fencedLines = new Array<boolean>(lines.length).fill(false);
        let activeFenceChar: '`' | '~' | null = null;
        let activeFenceLength = 0;

        for (let index = 0; index < lines.length; index++) {
            const rawLine = lines[index].endsWith('\r')
                ? lines[index].slice(0, -1)
                : lines[index];
            const line = this.stripLeadingBlockquotePrefix(rawLine);

            if (activeFenceChar !== null) {
                fencedLines[index] = true;
                const closingMatch = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
                if (!closingMatch) {
                    continue;
                }

                const closingToken = closingMatch[1];
                if (
                    closingToken[0] === activeFenceChar &&
                    closingToken.length >= activeFenceLength
                ) {
                    activeFenceChar = null;
                    activeFenceLength = 0;
                }
                continue;
            }

            const openingMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
            if (!openingMatch) {
                continue;
            }

            const openingToken = openingMatch[1];
            const openingChar = openingToken[0] as '`' | '~';
            const infoString = openingMatch[2] || '';
            if (openingChar === '`' && infoString.includes('`')) {
                continue;
            }

            fencedLines[index] = true;
            activeFenceChar = openingChar;
            activeFenceLength = openingToken.length;
        }

        return fencedLines;
    }

    private protectFencedMarkdown(markdown: string): {
        markdown: string;
        restore: (value: string) => string;
    } {
        const lines = markdown.split('\n');
        const fencedLines = this.getFencedCodeLineMask(lines);
        const protectedBlocks: Array<{ token: string; content: string }> = [];
        const output: string[] = [];
        const tokenPrefix = this.createPlaceholderNamespace(markdown, 'PROTECTED_FENCE');

        for (let index = 0; index < lines.length;) {
            if (!fencedLines[index]) {
                output.push(lines[index]);
                index++;
                continue;
            }

            const blockLines: string[] = [];
            while (index < lines.length && fencedLines[index]) {
                blockLines.push(lines[index]);
                index++;
            }
            const token = `${tokenPrefix}${protectedBlocks.length}_END`;
            protectedBlocks.push({ token, content: blockLines.join('\n') });
            output.push(token);
        }

        return {
            markdown: output.join('\n'),
            restore: (value: string): string => {
                let restored = value;
                for (const block of protectedBlocks) {
                    restored = restored.split(block.token).join(block.content);
                }
                return restored;
            },
        };
    }

    private detectListIndentSize(markdown: string): number | null {
        const lines = markdown.split(/\r?\n/);
        const fencedLines = this.getFencedCodeLineMask(lines);
        const indentDeltaCandidates: number[] = [];
        const positiveIndentSamples: number[] = [];
        const previousIndentByBlockquoteDepth = new Map<number, number>();

        for (let index = 0; index < lines.length; index++) {
            if (fencedLines[index]) {
                continue;
            }
            const line = lines[index];

            const lineWithoutBlockquotePrefix = this.stripLeadingBlockquotePrefix(line);
            const listMatch = lineWithoutBlockquotePrefix.match(/^([ \t]*)(?:[*+-]|\d+[.)])\s+/);
            if (!listMatch) {
                continue;
            }

            const indentWidth = this.getVisualIndentWidth(listMatch[1]);
            const blockquoteDepth = this.getBlockquoteDepth(line);
            const previousIndent = previousIndentByBlockquoteDepth.get(blockquoteDepth);
            if (typeof previousIndent === 'number' && indentWidth > previousIndent) {
                indentDeltaCandidates.push(indentWidth - previousIndent);
            }
            previousIndentByBlockquoteDepth.set(blockquoteDepth, indentWidth);

            if (indentWidth > 0) {
                positiveIndentSamples.push(indentWidth);
            }
        }

        const delta2Count = indentDeltaCandidates.filter((value) => value === 2).length;
        const delta4Count = indentDeltaCandidates.filter((value) => value === 4).length;
        if (delta2Count > 0 || delta4Count > 0) {
            return delta2Count > 0 ? 2 : 4;
        }

        const indent2Count = positiveIndentSamples.filter((value) => value === 2).length;
        const indent4Count = positiveIndentSamples.filter((value) => value === 4).length;
        if (indent2Count > 0 || indent4Count > 0) {
            return indent2Count > 0 ? 2 : 4;
        }

        if (positiveIndentSamples.length > 0) {
            const minimumIndent = Math.min(...positiveIndentSamples);
            if (minimumIndent >= 4) {
                return 4;
            }
        }

        return null;
    }

    private detectUnorderedListMarker(markdown: string): UnorderedListMarker | null {
        const lines = markdown.split(/\r?\n/);
        const fencedLines = this.getFencedCodeLineMask(lines);

        for (let index = 0; index < lines.length; index++) {
            if (fencedLines[index]) {
                continue;
            }
            const line = lines[index];

            // Ignore thematic breaks like "***" or "- - -".
            const trimmed = line.trim();
            if (/^([*-])(?:\s*\1){2,}\s*$/.test(trimmed)) {
                continue;
            }

            const listMatch = line.match(/^\s*(?:>\s*)*([*+-])\s+/);
            if (!listMatch) {
                continue;
            }

            const marker = listMatch[1];
            if (marker === '*' || marker === '-' || marker === '+') {
                return marker;
            }
        }

        return null;
    }

    private normalizeListLineTextKey(value: string): string {
        return String(value || '')
            .replace(/\u00A0/g, ' ')
            .replace(/&nbsp;|&#160;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private getMarkdownListLineInfos(markdown: string): MarkdownListLineInfo[] {
        const lines = markdown.split(/\r?\n/);
        const fencedLines = this.getFencedCodeLineMask(lines);
        const items: MarkdownListLineInfo[] = [];

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            if (fencedLines[lineIndex]) {
                continue;
            }
            const line = lines[lineIndex];
            const lineWithoutBlockquotePrefix = this.stripLeadingBlockquotePrefix(line);

            const trimmed = lineWithoutBlockquotePrefix.trim();
            if (/^([*-])(?:\s*\1){2,}\s*$/.test(trimmed)) {
                continue;
            }

            const listMatch = line.match(/^((?:\s*>[ \t]?)*)([ \t]*)([*+-]|\d+[.)])([ \t]+)((?:\[[ xX]\][ \t]+)?)(.*)$/);
            if (!listMatch) {
                continue;
            }

            const [, blockquotePrefix, indent, _marker, _spacing, _taskPrefix, text] = listMatch;
            const textKey = this.normalizeListLineTextKey(text);
            items.push({
                lineIndex,
                sequenceIndex: items.length,
                blockquotePrefix,
                indentWidth: this.getVisualIndentWidth(indent),
                textKey,
                isEmpty: textKey === ''
            });
        }

        return items;
    }

    private restorePreservedEmptyListChildIndents(markdown: string, previousMarkdown: string): string {
        if (!markdown || !previousMarkdown) {
            return markdown;
        }

        const previousItems = this.getMarkdownListLineInfos(previousMarkdown);
        const currentItems = this.getMarkdownListLineInfos(markdown);
        if (previousItems.length === 0 || currentItems.length === 0) {
            return markdown;
        }

        const previousItemsByText = new Map<string, MarkdownListLineInfo[]>();
        for (const item of previousItems) {
            if (item.isEmpty) {
                continue;
            }
            const matchingItems = previousItemsByText.get(item.textKey) || [];
            matchingItems.push(item);
            previousItemsByText.set(item.textKey, matchingItems);
        }

        const lines = markdown.split('\n');
        let changed = false;

        for (let i = 0; i < currentItems.length; i++) {
            const currentItem = currentItems[i];
            if (currentItem.isEmpty) {
                continue;
            }

            const previousMatches = previousItemsByText.get(currentItem.textKey);
            const previousItem = previousMatches ? previousMatches.shift() : undefined;
            if (!previousItem || previousItem.indentWidth <= currentItem.indentWidth) {
                continue;
            }

            const currentPreviousItem = currentItems[i - 1];
            const previousSourceItem = previousItems[previousItem.sequenceIndex - 1];
            if (
                !currentPreviousItem ||
                !currentPreviousItem.isEmpty ||
                !previousSourceItem ||
                currentPreviousItem.blockquotePrefix !== currentItem.blockquotePrefix ||
                previousSourceItem.blockquotePrefix !== previousItem.blockquotePrefix ||
                previousSourceItem.indentWidth !== currentPreviousItem.indentWidth ||
                currentPreviousItem.indentWidth >= previousItem.indentWidth
            ) {
                continue;
            }

            lines[currentItem.lineIndex] = lines[currentItem.lineIndex].replace(
                /^((?:\s*>[ \t]?)*)([ \t]*)([*+-]|\d+[.)])/,
                (_match, blockquotePrefix: string, _indent: string, marker: string) =>
                    `${blockquotePrefix}${' '.repeat(previousItem.indentWidth)}${marker}`
            );
            changed = true;
        }

        return changed ? lines.join('\n') : markdown;
    }

    private getPreferredUnorderedListMarker(document: vscode.TextDocument): UnorderedListMarker {
        const detected = this.detectUnorderedListMarker(document.getText());
        return detected ?? this.getDefaultUnorderedListMarker();
    }

    private getPreferredListIndent(document: vscode.TextDocument): string {
        const detected = this.detectListIndentSize(document.getText());
        const indentSize = detected ?? this.getDefaultListIndentSize();
        return ' '.repeat(indentSize);
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private createPlaceholderNamespace(content: string, purpose: string): string {
        const normalizedPurpose = purpose.replace(/[^A-Za-z0-9]/g, '');
        for (let attempt = 0; attempt < 100; attempt++) {
            const namespace = `MDW${normalizedPurpose}${getNonce()}`;
            if (!content.includes(namespace)) {
                return namespace;
            }
        }
        throw new Error(`Could not create a unique ${purpose} placeholder namespace`);
    }

    private restoreEscapedMarkdownLinks(markdown: string): string {
        const lines = markdown.split('\n');
        const fencedLines = this.getFencedCodeLineMask(lines);

        return lines.map((line, index) => {
            if (fencedLines[index]) {
                return line;
            }

            return line.replace(
                /\\\[([^\]\n]+)\\\]\(((?:https?:\/\/|mailto:|file:)[^\s)]+)\)/g,
                (_match, label: string, href: string) => `[${label}](${href})`
            );
        }).join('\n');
    }

    private protectOpaqueMarkdownSources(
        html: string,
        document: vscode.TextDocument
    ): { html: string; restore: (markdown: string) => string } {
        const documentText = document.getText();
        const normalizedDocumentText = documentText.replace(/^[ \t]+(?=\r?$)/gm, '');
        const placeholderNamespace = this.createPlaceholderNamespace(
            `${html}\n${documentText}`,
            'OPAQUE_SOURCE'
        );
        const preservedSources: Array<{ marker: string; source: string; block: boolean }> = [];
        const allowedKinds = new Set([
            'front-matter',
            'raw-html-block',
            'raw-html-inline',
            'reference-definition',
            'reference-image',
            'reference-link',
        ]);
        const privateAttributePattern = /\sdata-mdw-opaque-(?:kind|source)\s*=\s*(["'])[^"']*\1/gi;

        const getAttribute = (attributes: string, name: string): string | null => {
            const escapedName = this.escapeRegExp(name);
            const match = attributes.match(
                new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(["'])([^"']*)\\1`, 'i')
            );
            return match ? match[2] : null;
        };
        const decodeTrustedSource = (attributes: string): string | null => {
            const kind = getAttribute(attributes, 'data-mdw-opaque-kind');
            const encoded = getAttribute(attributes, 'data-mdw-opaque-source');
            if (
                !kind ||
                !allowedKinds.has(kind) ||
                !encoded ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
            ) {
                return null;
            }

            const decoded = Buffer.from(encoded, 'base64').toString('utf8');
            if (
                decoded === '' ||
                Buffer.from(decoded, 'utf8').toString('base64') !== encoded ||
                (
                    !documentText.includes(decoded) &&
                    !normalizedDocumentText.includes(decoded)
                )
            ) {
                return null;
            }
            return decoded;
        };
        const preserve = (match: string, attributes: string, block: boolean): string => {
            const source = decodeTrustedSource(attributes);
            if (source === null) {
                return match.replace(privateAttributePattern, '');
            }
            const marker = `${placeholderNamespace}${block ? 'BLOCK' : 'INLINE'}${preservedSources.length}END`;
            preservedSources.push({ marker, source, block });
            return block ? `<p>${marker}</p>` : marker;
        };

        let protectedHtml = html;
        protectedHtml = protectedHtml.replace(
            /<pre\b([^>]*)>[\s\S]*?<\/pre>/gi,
            (match, attributes) => preserve(match, attributes, true)
        );
        protectedHtml = protectedHtml.replace(
            /<a\b([^>]*)>[\s\S]*?<\/a>/gi,
            (match, attributes) => preserve(match, attributes, false)
        );
        protectedHtml = protectedHtml.replace(
            /<code\b([^>]*)>[\s\S]*?<\/code>/gi,
            (match, attributes) => preserve(match, attributes, false)
        );
        protectedHtml = protectedHtml.replace(
            /<img\b([^>]*)\/?\s*>/gi,
            (match, attributes) => preserve(match, attributes, false)
        );

        // Unknown elements cannot opt in to source restoration simply by using
        // a private-looking attribute.
        protectedHtml = protectedHtml.replace(privateAttributePattern, '');

        return {
            html: protectedHtml,
            restore: (markdown: string): string => {
                let restored = markdown;
                for (const preserved of preservedSources) {
                    // Turndown surrounds every block placeholder with up to two
                    // structural line endings. The protected source already owns
                    // its exact trailing boundary (including blank lines), so
                    // consume those generated separators before restoring it.
                    const trailingPattern = preserved.block
                        ? '(?:\\r?\\n){0,2}'
                        : '';
                    restored = restored.replace(
                        new RegExp(`${this.escapeRegExp(preserved.marker)}${trailingPattern}`, 'g'),
                        () => preserved.source
                    );
                }
                return restored;
            }
        };
    }

    private htmlToMarkdown(html: string, document: vscode.TextDocument): string {
        // Use Turndown for reliable HTML to Markdown conversion
        const placeholderNamespace = this.createPlaceholderNamespace(html, 'CONVERSION');
        const emptyLineMarker = `${placeholderNamespace}EMPTYLINE`;
        const emptyListItemMarker = `${placeholderNamespace}EMPTYLISTITEM`;
        const imageHardBreakTailMarker = `${placeholderNamespace}IMAGEHARDBREAKEND`;
        const emptyCodeMarkerPrefix = `${placeholderNamespace}EMPTYCODE`;
        const emptyCodeMarkerSuffix = 'END';
        const previousEmptyListItemMarker = this.currentEmptyListItemMarker;
        this.currentEmptyListItemMarker = emptyListItemMarker;
        try {
            const unorderedListMarker = this.getPreferredUnorderedListMarker(document);
            const escapedUnorderedListMarker = this.escapeRegExp(unorderedListMarker);
            const listIndent = this.getPreferredListIndent(document);
            const isEffectivelyEmptyHtmlSegment = (value: string): boolean => {
                const stripped = String(value || '')
                    .replace(/<br\b[^>]*>/gi, '')
                    .replace(/&nbsp;|&#160;/gi, '')
                    .replace(/<[^>]*>/g, '')
                    .replace(/[\u00A0\u200B\u2060\uFEFF\s]/g, '')
                    .trim();
                return stripped === '';
            };
            const getImageHardBreakHtml = (attributes: string): string => {
                const encodedPrefixMatch = String(attributes || '').match(
                    /\bdata-mdw-image-hardbreak-prefix\s*=\s*(["'])((?:[0-9a-f]{2})*)\1/i
                );
                return encodedPrefixMatch
                    ? `<br data-mdw-break-prefix="${encodedPrefixMatch[2]}">`
                    : '<br>';
            };
            this.currentListIndent = listIndent;
            (this.turndownService as any).options.bulletListMarker = unorderedListMarker;
            (this.turndownService as any).options.indent = listIndent;

            // Pre-process HTML to convert webview URIs back to relative paths
            html = this.convertWebviewUrisToRelativePaths(html, document);

            // Raw HTML, front matter, comments, and reference definitions cannot
            // be represented faithfully by the editable DOM. MarkdownDocument
            // renders them as source-backed opaque nodes. Only restore a marker
            // when its decoded source still exists in the current document.
            const protectedOpaqueSources = this.protectOpaqueMarkdownSources(html, document);
            html = protectedOpaqueSources.html;

            // Remove zero-width markers used for caret placement
            html = html.replace(/[\u200B\u2060\uFEFF]/g, '');

            // Restore markdown hard break for image lines that were split into
            // separate paragraphs for stable caret navigation in the webview.
            html = html.replace(
                /<p\b([^>]*)data-mdw-image-hardbreak\s*=\s*(["'])true\2([^>]*)>\s*([\s\S]*?)\s*<\/p>\s*<p\b[^>]*>\s*([\s\S]*?)\s*<\/p>/gi,
                (match, before, _quote, after, imageSegment, trailingSegment) => {
                    const normalizedImage = (imageSegment || '').trim();
                    const normalizedTrailing = (trailingSegment || '').trim();
                    if (!normalizedImage || !/<img\b/i.test(normalizedImage)) {
                        return match;
                    }
                    const hardBreakHtml = getImageHardBreakHtml(`${before || ''} ${after || ''}`);
                    if (isEffectivelyEmptyHtmlSegment(normalizedTrailing)) {
                        return `<p>${normalizedImage}${hardBreakHtml}${imageHardBreakTailMarker}</p>`;
                    }
                    return `<p>${normalizedImage}${hardBreakHtml}${normalizedTrailing}</p>`;
                }
            );
            // Preserve standalone image hard-break lines (e.g. "![...](...)  ")
            // through Turndown by attaching a temporary marker after <br>.
            html = html.replace(
                /<p\b([^>]*)data-mdw-image-hardbreak\s*=\s*(["'])true\2([^>]*)>\s*([\s\S]*?)\s*<\/p>/gi,
                (match, before, _quote, after, imageSegment) => {
                    const normalizedImage = (imageSegment || '').trim();
                    if (!normalizedImage || !/<img\b/i.test(normalizedImage)) {
                        return match;
                    }
                    const hardBreakHtml = getImageHardBreakHtml(`${before || ''} ${after || ''}`);
                    return `<p>${normalizedImage}${hardBreakHtml}${imageHardBreakTailMarker}</p>`;
                }
            );

            // Drop empty anchors left by contenteditable when link text was deleted.
            // Keep links that wrap images so image links still round-trip.
            html = html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (match, _attrs, content) => {
                if (/<img\b/i.test(content)) {
                    return match;
                }

                const visibleText = content
                    .replace(/<br\b[^>]*>/gi, '')
                    .replace(/&nbsp;|&#160;/gi, '')
                    .replace(/[\u00A0\u200B\u2060\uFEFF]/g, '')
                    .replace(/<[^>]*>/g, '')
                    .trim();

                return visibleText === '' ? '' : match;
            });

            // Remove empty strikethrough tags (e.g. <del><br></del>) to avoid "~~" artifacts
            html = html.replace(/<(del|s|strike)(\s[^>]*)?>\s*(?:<br[^>]*>|&nbsp;|\u00A0|\s)*<\/\1>/gi, '');

            // Remove class attributes from list items (they are for display only)
            html = html.replace(/<li\s+class="[^"]*"([^>]*)>/gi, '<li$1>');

            // Remove known editor UI. Do not trust the generic
            // data-exclude-from-markdown attribute as document content can use
            // the same name.
            html = html.replace(/<div class="code-block-toolbar"[^>]*>[\s\S]*?<\/div>/gi, '');

            // Remove drag handles (row-handle and col-handle)
            html = html.replace(/<div class="(row|col)-handle"[^>]*><\/div>/gi, '');

            // These attributes are private, per-conversion transport fields.
            // Remove any same-named attributes originating in Markdown/HTML so
            // document content cannot collide with the preservation mechanism.
            html = html.replace(
                /\sdata-mdw-(?:code-whitespace|code-leading|code-trailing|whitespace-code)="[^"]*"/gi,
                ''
            );

            // Turndown normalizes whitespace around inline CODE elements before
            // custom rules run. Preserve only those boundary characters in
            // temporary attributes while leaving encoded HTML content to its parser.
            const fencedCodeBlocks: string[] = [];
            const fencedCodePlaceholderPrefix = this.createPlaceholderNamespace(html, 'FENCED_CODE');
            html = html.replace(/<pre\b[^>]*>\s*<code\b[^>]*>[\s\S]*?<\/code>\s*<\/pre>/gi, (match) => {
                const placeholder = `${fencedCodePlaceholderPrefix}${fencedCodeBlocks.length}_PLACEHOLDER`;
                fencedCodeBlocks.push(match);
                return placeholder;
            });
            html = html.replace(/<code([^>]*)>([\s\S]*?)<\/code>/gi, (_match, attrs, content) => {
                if (content !== '' && content.trim() === '') {
                    const encodedWhitespace = Buffer.from(content, 'utf8').toString('hex');
                    return `<code${attrs} data-mdw-code-whitespace="${encodedWhitespace}">MDW_INLINE_CODE_WHITESPACE</code>`;
                }
                const leading = content.match(/^\s+/)?.[0] || '';
                const trailing = content.match(/\s+$/)?.[0] || '';
                const coreEnd = Math.max(leading.length, content.length - trailing.length);
                const core = content.slice(leading.length, coreEnd);
                const leadingAttr = leading
                    ? ` data-mdw-code-leading="${Buffer.from(leading, 'utf8').toString('hex')}"`
                    : '';
                const trailingAttr = trailing
                    ? ` data-mdw-code-trailing="${Buffer.from(trailing, 'utf8').toString('hex')}"`
                    : '';
                return `<code${attrs}${leadingAttr}${trailingAttr}>${core}</code>`;
            });
            const fencedCodePlaceholderPattern = new RegExp(
                `${this.escapeRegExp(fencedCodePlaceholderPrefix)}(\\d+)_PLACEHOLDER`,
                'g'
            );
            html = html.replace(
                fencedCodePlaceholderPattern,
                (match, indexText) => fencedCodeBlocks[Number(indexText)] ?? match
            );

            // Turndown treats whitespace-only PRE elements as blank before custom
            // rules run. Temporarily encode that exact content in an attribute so
            // the fenced-code rule can restore it without trimming.
            html = html.replace(/<pre([^>]*)>\s*<code([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi,
                (match, preAttrs, codeAttrs, content) => {
                    if (content === '' || content.trim() !== '') {
                        return match;
                    }
                    const encodedWhitespace = Buffer.from(content, 'utf8').toString('hex');
                    return `<pre${preAttrs}><code${codeAttrs} data-mdw-whitespace-code="${encodedWhitespace}">MDW_WHITESPACE_CODE</code></pre>`;
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
                    return `<pre><code${codeAttrs}>${emptyCodeMarkerPrefix}${markerLanguage}${emptyCodeMarkerSuffix}</code></pre>`;
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
                if (attrs.includes('data-mdw-indent-wrapper="true"')) {
                    return `<li${attrs}>${openTag}`;
                }
                if (attrs.includes('data-preserve-empty="true"')) {
                    return `<li${attrs}>&nbsp;${openTag}`;
                }
                return `<li${attrs} data-preserve-empty="true">&nbsp;${openTag}`;
            });
            html = html.replace(/<li([^>]*)>(\s|&nbsp;)*(<ul>|<ol>)([\s\S]*?)(<\/ul>|<\/ol>)\s*<\/li>/gi, (match, attrs, space, openTag, content, closeTag) => {
                if (attrs.includes('data-mdw-indent-wrapper="true"')) {
                    return `<li${attrs}>${openTag}${content}${closeTag}</li>`;
                }
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
            html = html.replace(/<(td|th)([^>]*)>\s*(?:<br\b[^>]*>|\u00A0|&nbsp;|\s)*<\/\1>/gi, '<$1$2></$1>');

            // Pre-process HTML to handle empty paragraphs and list items with <br>
            // Replace empty paragraphs with a conversion-specific marker.
            html = html.replace(
                /<p\b[^>]*>(?:\s|&nbsp;|\u00A0)*(?:<br\b[^>]*>)?(?:\s|&nbsp;|\u00A0)*<\/p>/gi,
                `<p>${emptyLineMarker}</p>`
            );

            // Don't remove empty list items - they may have nested lists
            // Instead, ensure empty list items have proper content for Turndown

            // Replace <li><br></li> with <li>&nbsp;</li> to preserve empty items
            html = html.replace(/<li>(<br\b[^>]*>)\s*<\/li>/gi, '<li>&nbsp;</li>');

            // Replace completely empty <li></li> with <li>&nbsp;</li> to preserve empty items
            // This must be done BEFORE handling nested lists
            html = html.replace(/<li>\s*<\/li>/gi, '<li>&nbsp;</li>');

            // Don't add space before nested lists - Turndown will handle it
            // The custom listItem rule will detect empty list items with nested lists

            // Handle <li><br><ul>...</ul></li> - remove <br> before nested list
            html = html.replace(/<li>(<br\b[^>]*>)\s*(<ul>|<ol>)/gi, '<li>$2');


            let markdown = this.turndownService.turndown(html);
            markdown = this.restoreEscapedMarkdownLinks(markdown);

            // Resolve the temporary empty-code marker before protecting fenced
            // blocks from the remaining document-level post-processing.
            const emptyCodeMarkerPattern = `${this.escapeRegExp(emptyCodeMarkerPrefix)}([A-Za-z0-9_-]+)${this.escapeRegExp(emptyCodeMarkerSuffix)}`;
            markdown = markdown.replace(new RegExp(`\`\`\`([^\\n]*)\\n${emptyCodeMarkerPattern}\\n\`\`\``, 'g'), (_match, _lang1, lang2) => {
                const language = lang2 === 'NOLANG' ? '' : lang2;
                return '```' + language + '\n\n```';
            });
            markdown = markdown.replace(new RegExp(emptyCodeMarkerPattern, 'g'), (_match, lang) => {
                const language = lang === 'NOLANG' ? '' : lang;
                return '```' + language + '\n\n```';
            });

            // From this point onward, transformations target document structure
            // such as lists and blank paragraphs. Keep every fenced block opaque
            // so code content can never be mistaken for that structure.
            const protectedFencedMarkdown = this.protectFencedMarkdown(markdown);
            markdown = protectedFencedMarkdown.markdown;

            // Post-process the markdown to fix indentation and spacing
            // 0. Replace the conversion-specific empty-line marker with an empty line.
            // NOTE:
            // Turndown emits paragraph separators around block placeholders:
            //   A\n\n<marker>\n\nB
            // Replacing <marker> with "" keeps the line slot and becomes:
            //   A\n\n\n\nB
            // which adds one extra blank line on every round-trip.
            //
            // For non-blockquote placeholders, remove the marker line itself.
            // For blockquote placeholders, keep a bare ">"
            // to preserve an empty quoted line.
            const linesWithEmptyLineMarkers = markdown.split('\n');
            const emptyLinePattern = new RegExp(
                `^(\\s*(?:>\\s*)*)${this.escapeRegExp(emptyLineMarker)}\\s*$`
            );
            for (let i = 0; i < linesWithEmptyLineMarkers.length; i++) {
                const emptyLineMatch = linesWithEmptyLineMarkers[i].match(emptyLinePattern);
                if (!emptyLineMatch) {
                    continue;
                }
                const blockquotePrefix = emptyLineMatch[1];
                const hasBlockquotePrefix = blockquotePrefix.replace(/\s/g, '') !== '';
                if (hasBlockquotePrefix) {
                    linesWithEmptyLineMarkers[i] = blockquotePrefix.replace(/\s+$/, '');
                } else {
                    linesWithEmptyLineMarkers.splice(i, 1);
                    i--;
                }
            }
            markdown = linesWithEmptyLineMarkers.join('\n');

            // Remove temporary marker line while keeping preceding hard-break spaces.
            // Example:
            //   ![img](path)  \n<image-hard-break marker>
            // -> ![img](path)
            markdown = markdown.replace(
                new RegExp(`(^|\\n)(?:\\s*>\\s*)?${this.escapeRegExp(imageHardBreakTailMarker)}\\s*(?=\\n|$)`, 'g'),
                '$1'
            );

            // 1. Fix list marker spacing: "<marker>   " -> "<marker> "
            markdown = markdown.replace(
                new RegExp(`^(\\s*)${escapedUnorderedListMarker}\\s{2,}`, 'gm'),
                `$1${unorderedListMarker} `
            );

            // 1.5. Ensure bare task markers become list items ("[ ]" -> "<marker> [ ]")
            const taskLines = markdown.split('\n');
            const taskFencedLines = this.getFencedCodeLineMask(taskLines);
            for (let i = 0; i < taskLines.length; i++) {
                const line = taskLines[i];
                if (taskFencedLines[i]) {
                    continue;
                }
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
                    taskLines[i] = `${indent}${unorderedListMarker} [${checked}]`;
                    continue;
                }
                const bareMatch = taskLines[i].match(/^(\s*)\[(\s|x|X)\]\s*$/);
                if (bareMatch) {
                    const indent = bareMatch[1];
                    const checked = bareMatch[2] === 'x' || bareMatch[2] === 'X' ? 'x' : ' ';
                    taskLines[i] = `${indent}${unorderedListMarker} [${checked}]`;
                }
            }
            markdown = taskLines.join('\n');

            // 2. Replace the empty-list marker and remove following whitespace-only lines.
            // Convert it to &nbsp; so nested empty items don't get parsed as headings.
            markdown = markdown.replace(
                new RegExp(this.escapeRegExp(emptyListItemMarker), 'g'),
                '&nbsp;'
            );

            // Then, remove whitespace-only lines that appear after empty list items
            const linesForEmptyItemCleanup = markdown.split('\n');
            const cleanedLinesForEmptyItem: string[] = [];
            const emptyUnorderedListItemPattern = new RegExp(`^\\s*${escapedUnorderedListMarker}\\s*(?:&nbsp;)?\\s*$`);
            for (let i = 0; i < linesForEmptyItemCleanup.length; i++) {
                const line = linesForEmptyItemCleanup[i];
                const prevLine = i > 0 ? linesForEmptyItemCleanup[i - 1] : '';

                // Skip whitespace-only lines that come after an empty list item marker
                // Empty list item pattern: any amount of whitespace, then "<marker> ", then optional whitespace, then end of line
                if (line.trim() === '' && line.length > 0) {
                    const isAfterEmptyListItem = emptyUnorderedListItemPattern.test(prevLine);
                    if (isAfterEmptyListItem) {
                        continue;
                    }
                }
                cleanedLinesForEmptyItem.push(line);
            }
            markdown = cleanedLinesForEmptyItem.join('\n');

            // 3. Turndown already handles list indentation according to current options
            // Don't modify indentation as it may break nested list structure

            // 4. Handle empty list items (those with just whitespace)
            // Normalize truly empty markers while preserving &nbsp; for empty items
            markdown = markdown.replace(
                new RegExp(`^(\\s*)${escapedUnorderedListMarker}\\s*$`, 'gm'),
                `$1${unorderedListMarker} `
            );

            // 4. Fix pattern "<marker> <marker> " (empty list item followed by nested list on same line)
            // Convert to "<marker> \n<indent><marker> " (empty parent item + nested child item)
            markdown = markdown.replace(
                new RegExp(`^(\\s*)${escapedUnorderedListMarker}\\s+${escapedUnorderedListMarker}\\s+`, 'gm'),
                (_match, indent: string) => {
                    // Calculate the indentation for the nested list.
                    const nestedIndent = indent + listIndent;
                    return `${indent}${unorderedListMarker} \n${nestedIndent}${unorderedListMarker} `;
                }
            );

            // 4. Remove empty lines between list items only
            const lines = markdown.split('\n');
            const processedLines: string[] = [];
            const unorderedListItemPattern = new RegExp(`^\\s*${escapedUnorderedListMarker}\\s+`);
            const fencedLines = this.getFencedCodeLineMask(lines);

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                // Skip empty lines between list items only (but not in code blocks)
                if (!fencedLines[i] && line.trim() === '' && i > 0 && i < lines.length - 1) {
                    const prevLine = lines[i - 1];
                    const nextLine = lines[i + 1];
                    // Check if both surrounding lines are list items (with any indentation)
                    if (unorderedListItemPattern.test(prevLine) && unorderedListItemPattern.test(nextLine)) {
                        continue;
                    }
                }

                processedLines.push(line);
            }


            // Join lines
            markdown = processedLines.join('\n');
            markdown = this.restorePreservedEmptyListChildIndents(markdown, document.getText());

            // Don't trim trailing whitespace - it may be part of code blocks
            // Just ensure we end with a single newline
            if (!markdown.endsWith('\n')) {
                markdown += '\n';
            }
            return protectedOpaqueSources.restore(
                protectedFencedMarkdown.restore(markdown)
            );
        } catch (error) {
            console.error('Error converting HTML to Markdown:', error);
            throw error;
        } finally {
            this.currentEmptyListItemMarker = previousEmptyListItemMarker;
        }
    }

    private normalizeLineEndingsForDocument(
        markdown: string,
        document: vscode.TextDocument
    ): string {
        const normalized = markdown.replace(/\r\n?/g, '\n');
        return document.eol === vscode.EndOfLine.CRLF
            ? normalized.replace(/\n/g, '\r\n')
            : normalized;
    }

    private getImageTooLargeMessage(): string {
        const maxMiB = MarkdownEditorProvider.maxImportedImageBytes / (1024 * 1024);
        return `Image is too large. Maximum size is ${maxMiB} MiB.`;
    }

    private assertImportedImageSize(byteLength: number): void {
        if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
            throw new ImageImportError('The image is empty or invalid.');
        }
        if (byteLength > MarkdownEditorProvider.maxImportedImageBytes) {
            throw new ImageImportError(this.getImageTooLargeMessage());
        }
    }

    private normalizeImportedImageMimeType(mimeType: string): string {
        const normalized = String(mimeType || '')
            .split(';')[0]
            .trim()
            .toLowerCase();
        if (!/^image\/[a-z0-9][a-z0-9.+-]*$/.test(normalized)) {
            throw new ImageImportError('The selected data is not an image.');
        }
        return normalized;
    }

    private getImportedImageExtension(mimeType: string): string {
        const knownExtensions = new Map<string, string>([
            ['image/jpeg', 'jpg'],
            ['image/jpg', 'jpg'],
            ['image/png', 'png'],
            ['image/gif', 'gif'],
            ['image/bmp', 'bmp'],
            ['image/webp', 'webp'],
            ['image/svg+xml', 'svg'],
            ['image/avif', 'avif'],
            ['image/x-icon', 'ico'],
            ['image/heic', 'heic'],
            ['image/heif', 'heif'],
            ['image/tiff', 'tiff']
        ]);
        const knownExtension = knownExtensions.get(mimeType);
        if (knownExtension) {
            return knownExtension;
        }
        const subtype = mimeType.slice('image/'.length).replace(/\+.*$/, '');
        return /^[a-z0-9]{1,10}$/.test(subtype) ? subtype : 'img';
    }

    private async reserveImageSaveTarget(
        directory: vscode.Uri,
        documentFileName: string,
        extension: string
    ): Promise<{ filename: string; imageUri: vscode.Uri; reservationKey: string }> {
        let sequence = 1;

        while (true) {
            const filename = sequence === 1
                ? `${documentFileName}.${extension}`
                : `${documentFileName}-${sequence}.${extension}`;
            sequence++;

            const imageUri = vscode.Uri.joinPath(directory, filename);
            const reservationKey = imageUri.toString();
            if (this.pendingImageSavePaths.has(reservationKey)) {
                continue;
            }

            let exists = false;
            try {
                await vscode.workspace.fs.stat(imageUri);
                exists = true;
            } catch {
                // A missing candidate can be reserved below.
            }
            if (exists || this.pendingImageSavePaths.has(reservationKey)) {
                continue;
            }

            // Rechecking after the awaited stat closes the race between two image
            // imports that inspected the same missing filename concurrently.
            this.pendingImageSavePaths.add(reservationKey);
            return { filename, imageUri, reservationKey };
        }
    }

    private async saveImageBytes(
        bytes: Uint8Array,
        mimeType: string,
        document: vscode.TextDocument,
        webview: vscode.Webview,
        options: {
            insert?: boolean;
            showNotification?: boolean;
            altText?: string;
            requestId?: string;
        } = {}
    ): Promise<void> {
        this.assertImportedImageSize(bytes.byteLength);
        const normalizedMimeType = this.normalizeImportedImageMimeType(mimeType);
        const extension = this.getImportedImageExtension(normalizedMimeType);
        const documentFileName = this.getDocumentFileName(document);

        const documentDir = this.getDocumentDirectoryUri(document);
        const imagesDir = vscode.Uri.joinPath(documentDir, 'images');
        const documentImagesDir = vscode.Uri.joinPath(imagesDir, documentFileName);

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

        const reservedTarget = await this.reserveImageSaveTarget(
            documentImagesDir,
            documentFileName,
            extension
        );
        const { filename, imageUri, reservationKey } = reservedTarget;

        try {
            await vscode.workspace.fs.writeFile(imageUri, bytes);

            const relativePath = `images/${documentFileName}/${filename}`;
            const altText = typeof options.altText === 'string' && options.altText !== ''
                ? options.altText
                : 'image';

            if (options.insert !== false) {
                void webview.postMessage({
                    type: 'insertImage',
                    requestId: options.requestId,
                    markdown: `![${this.escapeMarkdownImageAltText(altText)}](${relativePath})`,
                    src: webview.asWebviewUri(imageUri).toString(),
                    alt: altText
                });
                void webview.postMessage({ type: 'requestSync' });
            } else if (options.showNotification) {
                void vscode.window.showInformationMessage(`Image saved: ${relativePath}`);
            }
        } finally {
            this.pendingImageSavePaths.delete(reservationKey);
        }
    }

    private async saveImageFromDataUrl(
        dataUrl: string,
        mimeType: string,
        document: vscode.TextDocument,
        webview: vscode.Webview,
        options: {
            insert?: boolean;
            showNotification?: boolean;
            altText?: string;
            requestId?: string;
        } = {}
    ): Promise<boolean> {
        try {
            if (typeof dataUrl !== 'string') {
                throw new ImageImportError('Invalid image data URL.');
            }
            const commaIndex = dataUrl.indexOf(',');
            if (commaIndex <= 5 || commaIndex > 1024) {
                throw new ImageImportError('Invalid image data URL.');
            }

            const header = dataUrl.slice(0, commaIndex);
            const dataPart = dataUrl.slice(commaIndex + 1);
            const headerMatch = header.match(/^data:([^;]+)/i);
            const headerMimeType = headerMatch ? headerMatch[1] : '';
            const normalizedMimeType = this.normalizeImportedImageMimeType(headerMimeType || mimeType);
            const isBase64 = /;base64(?:;|$)/i.test(header);

            let buffer: Buffer;
            if (isBase64) {
                const maxEncodedLength = Math.ceil(
                    MarkdownEditorProvider.maxImportedImageBytes / 3
                ) * 4 + 4;
                if (dataPart.length > maxEncodedLength) {
                    throw new ImageImportError(this.getImageTooLargeMessage());
                }
                const normalizedBase64 = dataPart.replace(/\s/g, '');
                const paddingLength = normalizedBase64.endsWith('==')
                    ? 2
                    : (normalizedBase64.endsWith('=') ? 1 : 0);
                const estimatedBytes = Math.floor(normalizedBase64.length * 3 / 4) - paddingLength;
                this.assertImportedImageSize(estimatedBytes);
                buffer = Buffer.from(normalizedBase64, 'base64');
            } else {
                if (dataPart.length > MarkdownEditorProvider.maxImportedImageBytes * 3) {
                    throw new ImageImportError(this.getImageTooLargeMessage());
                }
                let decoded: string;
                try {
                    decoded = decodeURIComponent(dataPart);
                } catch {
                    throw new ImageImportError('Invalid image data URL.');
                }
                buffer = Buffer.from(decoded, 'utf8');
            }

            this.assertImportedImageSize(buffer.byteLength);
            await this.saveImageBytes(buffer, normalizedMimeType, document, webview, options);
            return true;
        } catch (error) {
            console.error('[saveImageFromDataUrl] Error saving image:', error);
            if (options.insert !== false && options.requestId) {
                void webview.postMessage({
                    type: 'imageInsertFailed',
                    requestId: options.requestId
                });
            }
            const message = error instanceof ImageImportError
                ? error.message
                : 'Failed to save image.';
            void vscode.window.showErrorMessage(message);
            return false;
        }
    }

    private getImageMimeTypeFromPath(pathLike: string): string {
        const normalized = (pathLike || '').split('#')[0].split('?')[0].toLowerCase();

        if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) {
            return 'image/jpeg';
        }
        if (normalized.endsWith('.gif')) {
            return 'image/gif';
        }
        if (normalized.endsWith('.bmp')) {
            return 'image/bmp';
        }
        if (normalized.endsWith('.webp')) {
            return 'image/webp';
        }
        if (normalized.endsWith('.svg')) {
            return 'image/svg+xml';
        }
        if (normalized.endsWith('.avif')) {
            return 'image/avif';
        }
        if (normalized.endsWith('.ico')) {
            return 'image/x-icon';
        }
        if (normalized.endsWith('.heic')) {
            return 'image/heic';
        }
        if (normalized.endsWith('.heif')) {
            return 'image/heif';
        }
        if (normalized.endsWith('.tif') || normalized.endsWith('.tiff')) {
            return 'image/tiff';
        }

        return 'image/png';
    }

    private escapeMarkdownImageAltText(altText: string): string {
        return String(altText || '')
            .replace(/\\/g, '\\\\')
            .replace(/\]/g, '\\]');
    }

    private getDocumentFileName(document: vscode.TextDocument): string {
        const parsed = path.posix.parse(document.uri.path);
        return parsed.name || 'document';
    }

    private getDocumentDirectoryUri(document: vscode.TextDocument): vscode.Uri {
        return document.uri.with({ path: path.posix.dirname(document.uri.path) });
    }

    private isUriWithinDirectory(candidate: vscode.Uri, directory: vscode.Uri): boolean {
        if (candidate.scheme !== directory.scheme || candidate.authority !== directory.authority) {
            return false;
        }
        const relativePath = path.posix.relative(directory.path, candidate.path);
        return relativePath === '' || (
            relativePath !== '..' &&
            !relativePath.startsWith('../') &&
            !path.posix.isAbsolute(relativePath)
        );
    }

    private resolveImageSourceUri(sourceText: string, document: vscode.TextDocument): vscode.Uri {
        const normalized = sourceText.trim();

        if (path.win32.isAbsolute(normalized) || path.posix.isAbsolute(normalized)) {
            return vscode.Uri.file(normalized);
        }

        if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
            return vscode.Uri.parse(normalized);
        }

        return vscode.Uri.joinPath(this.getDocumentDirectoryUri(document), normalized);
    }

    private resolveReadableImageSourceUri(sourceText: string, document: vscode.TextDocument): vscode.Uri {
        return this.resolveImageSourceUri(sourceText, document);
    }

    private async fetchRemoteImage(
        sourceUri: vscode.Uri
    ): Promise<{ bytes: Uint8Array; mimeType: string | null }> {
        type SimpleBodyReader = {
            read(): Promise<{ done: boolean; value?: Uint8Array }>;
            cancel(reason?: unknown): Promise<void>;
        };
        type SimpleFetchResponse = {
            ok: boolean;
            status: number;
            statusText: string;
            headers: { get(name: string): string | null };
            body?: { getReader(): SimpleBodyReader } | null;
        };
        type SimpleFetch = (
            input: string,
            init?: { headers?: Record<string, string>; signal?: AbortSignal }
        ) => Promise<SimpleFetchResponse>;

        const fetchFn = (globalThis as unknown as { fetch?: SimpleFetch }).fetch;
        if (!fetchFn) {
            throw new Error('Fetch API is unavailable.');
        }

        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, MarkdownEditorProvider.remoteImageTimeoutMs);

        try {
            const response = await fetchFn(sourceUri.toString(), {
                headers: {
                    accept: 'image/*,*/*;q=0.8'
                },
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`Request failed: ${response.status} ${response.statusText}`);
            }

            const contentTypeHeader = response.headers.get('content-type');
            const mimeType = contentTypeHeader
                ? contentTypeHeader.split(';')[0].trim().toLowerCase()
                : '';

            if (mimeType && !mimeType.startsWith('image/')) {
                throw new ImageImportError(`The downloaded file is not an image (${mimeType}).`);
            }

            const contentLengthHeader = response.headers.get('content-length');
            if (contentLengthHeader && /^\d+$/.test(contentLengthHeader.trim())) {
                const contentLength = Number(contentLengthHeader);
                if (contentLength > MarkdownEditorProvider.maxImportedImageBytes) {
                    controller.abort();
                    throw new ImageImportError(this.getImageTooLargeMessage());
                }
            }

            let bytes: Uint8Array;
            if (response.body && typeof response.body.getReader === 'function') {
                const reader = response.body.getReader();
                const chunks: Uint8Array[] = [];
                let totalBytes = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }
                    if (!value || value.byteLength === 0) {
                        continue;
                    }
                    totalBytes += value.byteLength;
                    if (totalBytes > MarkdownEditorProvider.maxImportedImageBytes) {
                        controller.abort();
                        void reader.cancel('Image exceeds the import size limit.').catch(() => {});
                        throw new ImageImportError(this.getImageTooLargeMessage());
                    }
                    chunks.push(value);
                }

                bytes = new Uint8Array(totalBytes);
                let offset = 0;
                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                }
            } else {
                throw new ImageImportError(
                    'The remote image response cannot be read with a safe size limit.'
                );
            }

            this.assertImportedImageSize(bytes.byteLength);
            return {
                bytes,
                mimeType: mimeType || null
            };
        } catch (error) {
            if (timedOut) {
                const seconds = MarkdownEditorProvider.remoteImageTimeoutMs / 1000;
                throw new ImageImportError(
                    `Remote image download timed out after ${seconds} seconds.`
                );
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    private async saveImageFromUri(
        imageUriText: string,
        document: vscode.TextDocument,
        webview: vscode.Webview,
        options: {
            altText?: string;
            source?: 'paste' | 'drop' | 'internal' | 'unknown';
            requestId?: string;
        } = {}
    ): Promise<void> {
        try {
            if (!imageUriText || typeof imageUriText !== 'string') {
                throw new Error('Invalid image URI');
            }

            const raw = imageUriText.trim();
            if (!raw) {
                throw new Error('Empty image URI');
            }

            if (/^data:image\//i.test(raw)) {
                await this.saveImageFromDataUrl(
                    raw,
                    '',
                    document,
                    webview,
                    {
                        insert: true,
                        showNotification: false,
                        altText: options.altText,
                        requestId: options.requestId
                    }
                );
                return;
            }

            const importSource = options.source ?? 'unknown';
            const looksLikeAbsolutePath = path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw);
            const looksLikeExplicitScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
            const allowRemoteImageImport = vscode.workspace
                .getConfiguration('manulDown')
                .get<boolean>('security.allowRemoteImageImport', false);

            if (
                importSource === 'paste' &&
                (looksLikeAbsolutePath || !looksLikeExplicitScheme || /^file:/i.test(raw))
            ) {
                throw new Error('Pasted local image URIs are blocked for security reasons.');
            }

            const sourceUri = this.resolveReadableImageSourceUri(raw, document);
            if (
                importSource === 'internal' &&
                !this.isUriWithinDirectory(sourceUri, this.getDocumentDirectoryUri(document))
            ) {
                throw new Error('Internal image URI is outside the Markdown document directory.');
            }
            let bytes: Uint8Array;
            let mimeType = this.getImageMimeTypeFromPath(sourceUri.path || sourceUri.fsPath || raw);

            if (sourceUri.scheme === 'http' || sourceUri.scheme === 'https') {
                if (!allowRemoteImageImport) {
                    throw new Error('Remote image import is disabled.');
                }
                const remoteImage = await this.fetchRemoteImage(sourceUri);
                bytes = remoteImage.bytes;
                if (remoteImage.mimeType) {
                    mimeType = remoteImage.mimeType;
                }
            } else if (sourceUri.scheme === 'file' || !sourceUri.scheme) {
                const sourceStat = await vscode.workspace.fs.stat(sourceUri);
                this.assertImportedImageSize(sourceStat.size);
                bytes = await vscode.workspace.fs.readFile(sourceUri);
                this.assertImportedImageSize(bytes.byteLength);
            } else {
                throw new Error(`Unsupported image URI scheme: ${sourceUri.scheme}`);
            }

            await this.saveImageBytes(
                bytes,
                mimeType,
                document,
                webview,
                {
                    insert: true,
                    showNotification: false,
                    altText: options.altText,
                    requestId: options.requestId
                }
            );
        } catch (error) {
            console.error('[saveImageFromUri] Error saving image from URI:', error);
            if (options.requestId) {
                void webview.postMessage({
                    type: 'imageInsertFailed',
                    requestId: options.requestId
                });
            }
            const message = error instanceof ImageImportError
                ? error.message
                : 'Failed to save dropped image.';
            void vscode.window.showErrorMessage(message);
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
                // Webview resource URLs are display-only capabilities. Never infer a
                // local filesystem path from URL text supplied by document content.
                vscode.window.showErrorMessage('The original image path is unavailable. Reload the ManulDown editor and try again.');
                return;
            } else if (imageSrc.startsWith('http://') || imageSrc.startsWith('https://')) {
                // External URL - open in browser
                vscode.env.openExternal(vscode.Uri.parse(imageSrc));
                return;
            } else {
                // Relative path - resolve relative to the document
                imageUri = this.resolveImageSourceUri(imageSrc, document);
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

            const sourceUri = this.resolveImageSourceUri(decodedSrc, document);

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
            const removeMdPathAttribute = (value: string): string => value.replace(/\sdata-md-path="[^"]*"/gi, '');
            const sanitizedBefore = removeMdPathAttribute(before);
            const sanitizedAfter = removeMdPathAttribute(after);

            // Prefer the original markdown path when present.
            const markdownPathMatch = `${before}${after}`.match(/\sdata-md-path="([^"]+)"/i);
            if (markdownPathMatch && markdownPathMatch[1].trim() !== '') {
                const markdownPath = markdownPathMatch[1].trim();
                return `<img${sanitizedBefore}src="${markdownPath}"${sanitizedAfter}>`;
            }

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

                // A trusted Webview resource should always carry data-md-path. If it
                // does not, keep the URL untouched instead of guessing a local path
                // from attacker-controlled URL text.
                if (decodedSrc.includes('vscode-resource') || decodedSrc.includes('vscode-webview-resource')) {
                    return match;
                } else if (decodedSrc.startsWith('/')) {
                    // Absolute path
                    fsPath = decodedSrc;
                } else {
                    // Already a relative path
                    return match;
                }

                const documentDir = this.getDocumentDirectoryUri(document).fsPath;
                let relativePath = path.relative(documentDir, fsPath).replace(/\\/g, '/');
                if (!relativePath || relativePath.startsWith('..')) {
                    relativePath = fsPath.replace(/\\/g, '/');
                }

                return `<img${sanitizedBefore}src="${relativePath}"${sanitizedAfter}>`;
            } catch (error) {
                console.error('[convertWebviewUrisToRelativePaths] Error converting path to relative:', error);
                return match;
            }
        });
    }

    private getWebviewSettings(): {
        toolbarVisible: boolean;
        tocEnabled: boolean;
        tocPanelWidth: number;
        useVsCodeCtrlP: boolean;
        listDashStyle: boolean;
        editorThemeMode: EditorThemeMode;
        allowRemoteImages: boolean;
        allowRemoteImageImport: boolean;
        allowFileLinks: boolean;
    } {
        const config = vscode.workspace.getConfiguration('manulDown');
        const configuredThemeMode = String(config.get<string>('editor.theme', 'vscode')).toLowerCase();
        const editorThemeMode: EditorThemeMode = configuredThemeMode === 'light'
            ? 'light'
            : configuredThemeMode === 'dark'
                ? 'dark'
                : 'vscode';
        return {
            toolbarVisible: config.get<boolean>('toolbar.visible', true),
            tocEnabled: config.get<boolean>('toc.enabled', true),
            tocPanelWidth: this.tocPanelWidthPx,
            useVsCodeCtrlP: true,
            listDashStyle: config.get<boolean>('list.dashStyle', false),
            editorThemeMode,
            allowRemoteImages: config.get<boolean>('security.allowRemoteImages', false),
            allowRemoteImageImport: config.get<boolean>('security.allowRemoteImageImport', false),
            allowFileLinks: config.get<boolean>('security.allowFileLinks', false),
        };
    }

    private getHtmlForWebview(webview: vscode.Webview, document: vscode.TextDocument): string {
        const nonce = getNonce();
        const settings = this.getWebviewSettings();
        const settingsJson = JSON.stringify(settings);
        const toolbarVisibleAttr = settings.toolbarVisible ? 'true' : 'false';
        const tocEnabledAttr = settings.tocEnabled ? 'true' : 'false';
        const themeModeAttr = settings.editorThemeMode;

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

        // Load the Prism grammars exposed in the code-block language picker.
        // Keep dependency order: shared helpers first, then languages that extend them.
        const prismComponentNames = [
            'markup-templating',
            'c',
            'cpp',
            'csharp',
            'python',
            'typescript',
            'java',
            'php',
            'ruby',
            'go',
            'rust',
            'swift',
            'kotlin',
            'scala',
            'scss',
            'sass',
            'less',
            'json',
            'yaml',
            'toml',
            'markdown',
            'latex',
            'sql',
            'graphql',
            'bash',
            'powershell',
            'docker',
            'makefile',
            'r',
            'matlab',
            'julia',
            'perl',
            'lua',
            'haskell',
            'elixir',
            'erlang',
            'clojure',
            'scheme',
            'lisp',
            'dart',
            'objectivec',
        ];
        const prismComponentScriptTags = prismComponentNames.map((componentName) => {
            const componentUri = webview.asWebviewUri(
                vscode.Uri.joinPath(
                    this.context.extensionUri,
                    'node_modules',
                    'prismjs',
                    'components',
                    `prism-${componentName}.min.js`
                )
            );
            return `    <script nonce="${nonce}" src="${componentUri}"></script>`;
        }).join('\n');
        const mermaidUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'vendor', 'mermaid.bundle.js')
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; worker-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'; style-src ${webview.cspSource} 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; script-src-elem 'nonce-${nonce}'; script-src-attr 'none'; img-src ${webview.cspSource} https: data:;">
    <link href="${styleUri}" rel="stylesheet">
    <link href="${prismCssUri}" rel="stylesheet">
    <title>ManulDown</title>
</head>
<body data-toolbar-visible="${toolbarVisibleAttr}" data-toc-enabled="${tocEnabledAttr}" data-theme-mode="${themeModeAttr}">
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
        <div class="toolbar-separator"></div>
        <button class="toolbar-btn" data-command="quote" title="Quote">
            &gt; Quote
        </button>
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
        <div id="toc-resizer" role="separator" aria-orientation="vertical" aria-label="Resize table of contents panel" tabindex="0"></div>
        <div id="toc-container">
            <div id="toc-header">Index</div>
            <div id="toc-content">
                <div id="toc-empty"></div>
            </div>
        </div>
    </div>
    <script nonce="${nonce}">window.__manulDownSettings = ${settingsJson};</script>
    <script nonce="${nonce}" src="${prismJsUri}"></script>
${prismComponentScriptTags}
    <script nonce="${nonce}" src="${mermaidUri}"></script>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

// Made with Bob
