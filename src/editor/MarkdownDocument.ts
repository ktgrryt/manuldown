import * as vscode from 'vscode';
import { marked } from 'marked';
import * as path from 'path';

export class MarkdownDocument {
    private static readonly blanklineMarkerHtml = '<p data-mdw-blankline="true"><br></p>';

    constructor(
        private readonly document: vscode.TextDocument,
        private readonly webview?: vscode.Webview
    ) {
        // Configure marked options
        marked.setOptions({
            breaks: true,
            gfm: true,
            pedantic: false, // Allow nested lists with proper indentation
        });

        // Custom renderer to preserve code block content exactly as-is
        const renderer = new marked.Renderer();
        const originalCode = renderer.code.bind(renderer);
        renderer.code = function (code: string, language: string | undefined, isEscaped: boolean) {
            // Preserve the code content exactly as-is, including all newlines
            // Don't let marked trim or modify the content
            return originalCode(code, language, isEscaped);
        };
        marked.use({ renderer });

        // Table parsing is enabled via gfm option
    }

    public toHtml(): string {
        const markdown = this.document.getText();
        try {

            const explicitBlockquoteMarkdown = this.breakLazyBlockquoteContinuations(markdown);
            const preprocessedMarkdown = this.preserveExtraBlankLines(explicitBlockquoteMarkdown);
            let html = marked.parse(preprocessedMarkdown) as string;


            // Fix malformed HTML: Remove <p> tags that wrap <ul> or <ol> elements
            // Pattern: <p><ul>...</ul></p> or <p><ol>...</ol></p>
            // This is invalid HTML and causes issues with list indentation
            html = html.replace(/<p>\s*(<ul>[\s\S]*?<\/ul>)\s*<\/p>/gi, '$1');
            html = html.replace(/<p>\s*(<ol>[\s\S]*?<\/ol>)\s*<\/p>/gi, '$1');

            // Fix empty paragraphs: Ensure they have height by adding <br>
            // Pattern: <p></p> or <p>\s*</p>
            html = html.replace(/<p>\s*<\/p>/gi, '<p><br></p>');

            // Normalize image-only paragraphs that include trailing spaces from Markdown
            // lines like "![...](...)  ". Those spaces become text nodes after IMG and can
            // create a phantom blank line / unstable caret behavior around image right edge.
            html = html.replace(
                /<p>\s*((?:<a\b[^>]*>\s*)?<img\b[^>]*>(?:\s*<\/a>)?)\s*<\/p>/gi,
                '<p>$1</p>'
            );

            // Fix empty blockquotes generated from ">" so they stay visible/editable.
            // marked outputs: <blockquote></blockquote> with no paragraph children.
            html = html.replace(/<blockquote>\s*<\/blockquote>/gi, '<blockquote><p><br></p></blockquote>');

            // Fix marked's incorrect parsing of empty list items as headings
            // Pattern: <li><h1></h1> to <li>, <li><h2></h2> to <li>, etc.
            // This happens when there's an empty list item followed by spaces
            html = html.replace(/<li>\s*<h[1-6]>\s*<\/h[1-6]>\s*/gi, '<li>');

            // Fix empty list items: add &nbsp; to preserve them
            // Pattern: <li></li> or <li>\s*</li> (empty or whitespace only)
            // But NOT if it contains nested lists
            html = html.replace(/<li>(\s*)<\/li>/gi, '<li>&nbsp;</li>');

            // Fix empty list items that only contain nested lists
            // Pattern: <li><ul>...</ul></li> or <li><ol>...</ol></li>
            // Don't add &nbsp; - let Turndown handle the empty parent item correctly
            // html = html.replace(/<li>(\s*)(<ul>|<ol>)/gi, '<li>&nbsp;$2');

            // Enable checkboxes: Remove disabled attribute from task list checkboxes
            // marked generates <input disabled="" type="checkbox"> which prevents interaction
            html = html.replace(/<input\s+checked=""\s+disabled=""\s+type="checkbox"/gi, '<input checked="" type="checkbox"');
            html = html.replace(/<input\s+disabled=""\s+type="checkbox"/gi, '<input type="checkbox"');


            // Normalize code blocks: remove only leading whitespace
            // Preserve all trailing whitespace including newlines (user input)
            html = html.replace(/<code([^>]*)>([\s\S]*?)<\/code>/gi, (match, attrs, content) => {
                // Only trim leading whitespace, preserve all trailing content including newlines
                let trimmedContent = content.replace(/^\s+/, '');
                if (trimmedContent === '' && content.includes('\n')) {
                    // Keep a newline so empty fenced blocks stay editable in the webview.
                    trimmedContent = '\n';
                }
                return `<code${attrs}>${trimmedContent}</code>`;
            });


            // Convert relative image paths to webview URIs
            if (this.webview) {
                html = this.convertImagePaths(html);
            }

            return html;
        } catch (error) {
            console.error('Error parsing markdown:', error);
            return '<p>Error parsing markdown</p>';
        }
    }

    private preserveExtraBlankLines(markdown: string): string {
        // Keep original content when there is nothing to transform.
        const segments = markdown.match(/[^\n]*\n|[^\n]+$/g);
        if (!segments || segments.length === 0) {
            return markdown;
        }

        const output: string[] = [];
        const pendingBlankSegments: string[] = [];
        let inFence = false;
        let fenceMarker: '`' | '~' | null = null;
        let fenceLength = 0;

        const isBlankSegment = (segment: string): boolean => {
            if (!segment.endsWith('\n')) {
                return false;
            }
            const line = segment.slice(0, -1);
            return line.trim() === '';
        };

        const flushPendingBlankSegments = (): void => {
            if (pendingBlankSegments.length === 0) {
                return;
            }

            // Keep the first blank line as-is for normal Markdown block separation.
            output.push(pendingBlankSegments[0]);

            // Convert additional blank lines into explicit blank line markers.
            for (let i = 1; i < pendingBlankSegments.length; i++) {
                output.push(`${MarkdownDocument.blanklineMarkerHtml}\n`);
                output.push('\n');
            }

            pendingBlankSegments.length = 0;
        };

        for (const segment of segments) {
            const line = segment.endsWith('\n') ? segment.slice(0, -1) : segment;

            if (inFence) {
                output.push(segment);
                if (fenceMarker && this.isFenceClosingLine(line, fenceMarker, fenceLength)) {
                    inFence = false;
                    fenceMarker = null;
                    fenceLength = 0;
                }
                continue;
            }

            const openingFence = this.parseFenceOpeningLine(line);
            if (openingFence) {
                flushPendingBlankSegments();
                output.push(segment);
                inFence = true;
                fenceMarker = openingFence.marker;
                fenceLength = openingFence.length;
                continue;
            }

            if (isBlankSegment(segment)) {
                pendingBlankSegments.push(segment);
                continue;
            }

            flushPendingBlankSegments();
            output.push(segment);
        }

        flushPendingBlankSegments();
        return output.join('');
    }

    private breakLazyBlockquoteContinuations(markdown: string): string {
        const segments = markdown.match(/[^\n]*\n|[^\n]+$/g);
        if (!segments || segments.length === 0) {
            return markdown;
        }

        const output: string[] = [];
        let inFence = false;
        let fenceMarker: '`' | '~' | null = null;
        let fenceLength = 0;
        let previousWasExplicitBlockquote = false;
        let preferredLineEnding = '\n';

        for (const segment of segments) {
            if (segment.endsWith('\r\n')) {
                preferredLineEnding = '\r\n';
            } else if (segment.endsWith('\n')) {
                preferredLineEnding = '\n';
            }

            const line = this.stripTrailingCarriageReturn(
                segment.endsWith('\n') ? segment.slice(0, -1) : segment
            );

            if (inFence) {
                output.push(segment);
                if (fenceMarker && this.isFenceClosingLine(line, fenceMarker, fenceLength)) {
                    inFence = false;
                    fenceMarker = null;
                    fenceLength = 0;
                }
                previousWasExplicitBlockquote = false;
                continue;
            }

            const openingFence = this.parseFenceOpeningLine(line);
            if (openingFence) {
                output.push(segment);
                inFence = true;
                fenceMarker = openingFence.marker;
                fenceLength = openingFence.length;
                previousWasExplicitBlockquote = false;
                continue;
            }

            const isBlankLine = line.trim() === '';
            const isExplicitBlockquoteLine = /^ {0,3}>[ \t]?/.test(line);

            if (previousWasExplicitBlockquote && !isBlankLine && !isExplicitBlockquoteLine) {
                output.push(preferredLineEnding);
            }

            output.push(segment);
            previousWasExplicitBlockquote = isExplicitBlockquoteLine;
        }

        return output.join('');
    }

    private parseFenceOpeningLine(line: string): { marker: '`' | '~'; length: number } | null {
        const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (!match) {
            return null;
        }

        const markerRun = match[1];
        const marker = markerRun[0] as '`' | '~';
        return { marker, length: markerRun.length };
    }

    private isFenceClosingLine(line: string, marker: '`' | '~', minLength: number): boolean {
        const indentMatch = line.match(/^ {0,3}/);
        const indentLength = indentMatch ? indentMatch[0].length : 0;
        const content = line.slice(indentLength);

        let markerCount = 0;
        while (markerCount < content.length && content[markerCount] === marker) {
            markerCount++;
        }

        if (markerCount < minLength) {
            return false;
        }

        for (let i = markerCount; i < content.length; i++) {
            const char = content[i];
            if (char !== ' ' && char !== '\t') {
                return false;
            }
        }

        return true;
    }

    private stripTrailingCarriageReturn(line: string): string {
        return line.endsWith('\r') ? line.slice(0, -1) : line;
    }

    private convertImagePaths(html: string): string {
        if (!this.webview) {
            return html;
        }

        const documentDir = path.dirname(this.document.uri.fsPath);

        // Replace img src attributes with webview URIs
        return html.replace(/<img([^>]*?)src="([^"]+)"([^>]*?)>/g, (match, before, src, after) => {
            // Decode URL-encoded src (marked encodes non-ASCII characters like Japanese)
            let decodedSrc = src;
            try {
                decodedSrc = decodeURIComponent(src);
            } catch {
                // Use original value when decode fails
            }

            // Skip if already an absolute URL or data URI
            if (decodedSrc.startsWith('http://') || decodedSrc.startsWith('https://') || decodedSrc.startsWith('data:')) {
                return match;
            }

            // Convert relative path to absolute path
            const absolutePath = path.isAbsolute(decodedSrc) ? decodedSrc : path.join(documentDir, decodedSrc);

            try {
                // Convert to webview URI
                const webviewUri = this.webview!.asWebviewUri(vscode.Uri.file(absolutePath));
                return `<img${before}src="${webviewUri}"${after}>`;
            } catch (error) {
                console.error('Error converting image path:', error);
                return match;
            }
        });
    }

    public getText(): string {
        return this.document.getText();
    }
}

// Made with Bob
