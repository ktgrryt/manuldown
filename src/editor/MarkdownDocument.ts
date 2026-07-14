import * as vscode from 'vscode';
import { marked, Tokens } from 'marked';
import * as path from 'path';
import { getNonce } from '../utils/getNonce';

function escapeOpaqueSourceForHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function encodeOpaqueSource(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64');
}

function renderOpaqueSource(value: string, kind: string, block: boolean): string {
    const encodedSource = encodeOpaqueSource(value);
    const escapedSource = escapeOpaqueSourceForHtml(value);
    if (block) {
        return `<pre class="mdw-opaque-source" contenteditable="false" title="Preserved Markdown source (read-only)" data-mdw-opaque-kind="${kind}" data-mdw-opaque-source="${encodedSource}"><code class="language-markdown">${escapedSource}</code></pre>\n`;
    }
    return `<code class="mdw-opaque-source" contenteditable="false" title="Preserved Markdown source (read-only)" data-mdw-opaque-kind="${kind}" data-mdw-opaque-source="${encodedSource}">${escapedSource}</code>`;
}

function isReferenceStyleLink(raw: string): boolean {
    return /^!?\[/.test(raw) && /\]$/.test(raw) && !/\]\(/.test(raw);
}

function escapeAttribute(value: string): string {
    return escapeOpaqueSourceForHtml(value);
}

marked.use({
    breaks: true,
    gfm: true,
    pedantic: false,
    extensions: [
        {
            name: 'br',
            renderer(token) {
                const breakToken = token as Tokens.Br;
                const prefix = breakToken.raw.endsWith('\n')
                    ? breakToken.raw.slice(0, -1)
                    : breakToken.raw;
                const encodedPrefix = Buffer.from(prefix, 'utf8').toString('hex');
                const isSoftBreak = !prefix.endsWith('\\') && !/ {2,}$/.test(prefix);
                const softBreakAttribute = isSoftBreak
                    ? ' data-mdw-soft-break="true"'
                    : '';
                return `<br${softBreakAttribute} data-mdw-break-prefix="${encodedPrefix}">`;
            }
        },
        {
            name: 'heading',
            renderer(token) {
                const headingToken = token as Tokens.Heading;
                const setextMatch = headingToken.raw.match(/\r?\n {0,3}([=-]+)[ \t]*(?:\r?\n)*$/);
                const setextAttributes = setextMatch && headingToken.depth <= 2
                    ? ` data-mdw-heading-style="setext" data-mdw-heading-marker-length="${setextMatch[1].length}"`
                    : '';
                const content = this.parser.parseInline(headingToken.tokens);
                return `<h${headingToken.depth}${setextAttributes}>${content}</h${headingToken.depth}>\n`;
            }
        },
        {
            name: 'html',
            renderer(token) {
                const htmlToken = token as Tokens.HTML;
                return renderOpaqueSource(
                    htmlToken.raw,
                    htmlToken.block ? 'raw-html-block' : 'raw-html-inline',
                    htmlToken.block === true
                );
            }
        },
        {
            name: 'link',
            renderer(token) {
                const linkToken = token as Tokens.Link;
                if (!isReferenceStyleLink(linkToken.raw)) {
                    return false;
                }
                const content = this.parser.parseInline(linkToken.tokens);
                const title = linkToken.title
                    ? ` title="${escapeAttribute(linkToken.title)}"`
                    : '';
                return `<a href="${escapeAttribute(linkToken.href)}"${title} contenteditable="false" data-mdw-opaque-kind="reference-link" data-mdw-opaque-source="${encodeOpaqueSource(linkToken.raw)}">${content}</a>`;
            }
        },
        {
            name: 'image',
            renderer(token) {
                const imageToken = token as Tokens.Image;
                if (!isReferenceStyleLink(imageToken.raw)) {
                    return false;
                }
                const title = imageToken.title
                    ? ` title="${escapeAttribute(imageToken.title)}"`
                    : '';
                return `<img src="${escapeAttribute(imageToken.href)}" alt="${escapeAttribute(imageToken.text)}"${title} data-mdw-opaque-kind="reference-image" data-mdw-opaque-source="${encodeOpaqueSource(imageToken.raw)}">`;
            }
        }
    ]
});

export class MarkdownDocument {
    private static readonly blanklineMarkerHtml = '<p data-mdw-blankline="true"><br></p>';
    private static readonly imageHardBreakMarkerAttr = 'data-mdw-image-hardbreak="true"';
    private static readonly imageHardBreakPlaceholderHtml = '<p data-mdw-image-hardbreak-placeholder="true"><br></p>';
    private static readonly commonHtmlTagNames = new Set([
        'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio',
        'b', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button',
        'canvas', 'caption', 'cite', 'code', 'col', 'colgroup',
        'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt',
        'em',
        'fieldset', 'figcaption', 'figure', 'footer', 'form',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html',
        'i', 'iframe', 'img', 'input', 'ins',
        'kbd',
        'label', 'legend', 'li', 'link',
        'main', 'map', 'mark', 'menu', 'meta', 'meter',
        'nav', 'noscript',
        'object', 'ol', 'optgroup', 'option', 'output',
        'p', 'picture', 'pre', 'progress',
        'q',
        'rp', 'rt', 'ruby',
        's', 'samp', 'script', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup',
        'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track',
        'u', 'ul',
        'var', 'video',
        'wbr'
    ]);

    constructor(
        private readonly document: vscode.TextDocument,
        private readonly webview?: vscode.Webview
    ) { }

    public toHtml(): string {
        const markdown = this.normalizeIgnoredLineWhitespace(this.document.getText());
        try {
            const opaqueBlockProtection = this.protectNonRenderedMarkdown(markdown);
            const blanklineMarker = this.createPlaceholderMarker(
                opaqueBlockProtection.markdown,
                'BLANK_LINE'
            );
            const listIndentWrapperMarker = this.createPlaceholderMarker(
                opaqueBlockProtection.markdown,
                'LIST_INDENT_WRAPPER'
            );
            const listIndentMarkerPrefix = this.createPlaceholderMarker(
                opaqueBlockProtection.markdown,
                'LIST_INDENT'
            );
            const blockquoteEmptyLineMarker = this.createPlaceholderMarker(
                opaqueBlockProtection.markdown,
                'BLOCKQUOTE_EMPTY_LINE'
            );
            const escapedPlaceholderMarkdown = this.escapePlaceholderAngleBrackets(
                opaqueBlockProtection.markdown
            );
            const explicitBlockquoteMarkdown = this.breakLazyBlockquoteContinuations(escapedPlaceholderMarkdown);
            const blockquoteBlankPreservedMarkdown = this.preserveEmptyBlockquoteLines(
                explicitBlockquoteMarkdown,
                blockquoteEmptyLineMarker
            );
            const preprocessedMarkdown = this.preserveExtraBlankLines(
                blockquoteBlankPreservedMarkdown,
                blanklineMarker
            );
            const sourceIndentAnnotatedMarkdown = this.annotateListItemSourceIndents(
                preprocessedMarkdown,
                listIndentWrapperMarker,
                listIndentMarkerPrefix
            );
            let html = marked.parse(sourceIndentAnnotatedMarkdown) as string;
            html = opaqueBlockProtection.restore(html);
            html = html.replace(
                new RegExp(`<p>\\s*${blanklineMarker}\\s*<\\/p>`, 'gi'),
                MarkdownDocument.blanklineMarkerHtml
            );
            html = this.applyListItemSourceIndentMarkers(
                html,
                listIndentWrapperMarker,
                listIndentMarkerPrefix
            );


            // Fix malformed HTML: Remove <p> tags that wrap <ul> or <ol> elements
            // Pattern: <p><ul>...</ul></p> or <p><ol>...</ol></p>
            // This is invalid HTML and causes issues with list indentation
            html = html.replace(/<p>\s*(<ul>[\s\S]*?<\/ul>)\s*<\/p>/gi, '$1');
            html = html.replace(/<p>\s*(<ol>[\s\S]*?<\/ol>)\s*<\/p>/gi, '$1');

            // Fix empty paragraphs: Ensure they have height by adding <br>
            // Pattern: <p></p> or <p>\s*</p>
            html = html.replace(/<p>\s*<\/p>/gi, '<p><br></p>');

            // Restore explicit empty quote lines that were preserved with a marker.
            const blockquoteEmptyLineMarkerPattern = new RegExp(
                `<p>\\s*${blockquoteEmptyLineMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<\\/p>`,
                'gi'
            );
            html = html.replace(
                blockquoteEmptyLineMarkerPattern,
                '<p><br></p>'
            );

            // Treat "image + hard break + text" as separate paragraphs so caret
            // navigation behaves like a blank line exists between them.
            html = html.replace(
                /<p>\s*((?:<a\b[^>]*>\s*)?<img\b[^>]*>(?:\s*<\/a>)?)\s*<br\b([^>]*)>\s*([\s\S]*?)\s*<\/p>/gi,
                (match, imageSegment, breakAttributes, trailingContent) => {
                    if (/\bdata-mdw-soft-break\s*=\s*(["'])true\1/i.test(breakAttributes || '')) {
                        return match;
                    }
                    const normalizedImage = (imageSegment || '').trim();
                    const normalizedTrailing = (trailingContent || '').trim();
                    if (!normalizedImage) {
                        return match;
                    }
                    const encodedPrefixMatch = String(breakAttributes || '').match(
                        /\bdata-mdw-break-prefix\s*=\s*(["'])((?:[0-9a-f]{2})*)\1/i
                    );
                    const imageHardBreakPrefixAttribute = encodedPrefixMatch
                        ? ` data-mdw-image-hardbreak-prefix="${encodedPrefixMatch[2]}"`
                        : '';
                    const imageHardBreakAttributes = `${MarkdownDocument.imageHardBreakMarkerAttr}${imageHardBreakPrefixAttribute}`;
                    if (!normalizedTrailing) {
                        // Keep a blank editable line below an image when the parsed
                        // HTML contains an actual break after the image.
                        return `<p ${imageHardBreakAttributes}>${normalizedImage}</p>${MarkdownDocument.imageHardBreakPlaceholderHtml}`;
                    }
                    return `<p ${imageHardBreakAttributes}>${normalizedImage}</p><p>${normalizedTrailing}</p>`;
                }
            );

            // Normalize any remaining parsed image-only paragraphs that carry
            // literal trailing spaces from external HTML input.
            html = html.replace(
                /<p>\s*((?:<a\b[^>]*>\s*)?<img\b[^>]*>(?:\s*<\/a>)?)([ \t]{2,})<\/p>/gi,
                (_match, imageSegment) => {
                    const normalizedImage = (imageSegment || '').trim();
                    if (!normalizedImage) {
                        return _match;
                    }
                    return `<p ${MarkdownDocument.imageHardBreakMarkerAttr}>${normalizedImage}</p>${MarkdownDocument.imageHardBreakPlaceholderHtml}`;
                }
            );

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
            html = html.replace(/<li\b([^>]*)>\s*<h[1-6]>\s*<\/h[1-6]>\s*/gi, '<li$1>');

            // Fix empty list items: add &nbsp; to preserve them
            // Pattern: <li></li> or <li>\s*</li> (empty or whitespace only)
            // But NOT if it contains nested lists
            html = html.replace(/<li\b([^>]*)>(\s*)<\/li>/gi, '<li$1>&nbsp;</li>');

            // Fix empty list items that only contain nested lists
            // Pattern: <li><ul>...</ul></li> or <li><ol>...</ol></li>
            // Don't add &nbsp; - let Turndown handle the empty parent item correctly
            // html = html.replace(/<li>(\s*)(<ul>|<ol>)/gi, '<li>&nbsp;$2');

            // Enable checkboxes: Remove disabled attribute from task list checkboxes
            // marked generates <input disabled="" type="checkbox"> which prevents interaction
            html = html.replace(/<input\s+checked=""\s+disabled=""\s+type="checkbox"/gi, '<input checked="" type="checkbox"');
            html = html.replace(/<input\s+disabled=""\s+type="checkbox"/gi, '<input type="checkbox"');


            // Keep fenced-code content byte-for-byte. Only truly empty fenced blocks
            // need a newline so Chromium has an editable text position.
            html = html.replace(
                /(<pre\b[^>]*>\s*<code\b[^>]*>)([\s\S]*?)(<\/code>\s*<\/pre>)/gi,
                (_match, openTags, content, closeTags) =>
                    `${openTags}${content === '' ? '\n' : content}${closeTags}`
            );


            // Convert relative image paths to webview URIs
            if (this.webview) {
                html = this.convertImagePaths(html);
            }

            return html;
        } catch (error) {
            console.error('Error parsing markdown:', error);
            throw error;
        }
    }

    private getVisualIndentWidth(value: string): number {
        let width = 0;
        for (const char of value) {
            width += char === '\t' ? 4 : 1;
        }
        return width;
    }

    private detectListIndentSize(markdown: string): number | null {
        const lines = markdown.split(/\r?\n/);
        let activeFenceChar: '`' | '~' | null = null;
        let activeFenceLength = 0;
        const indentDeltaCandidates: number[] = [];
        const positiveIndentSamples: number[] = [];
        const previousIndentByBlockquoteDepth = new Map<number, number>();

        for (const line of lines) {
            const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
            if (fenceMatch) {
                const fenceToken = fenceMatch[1];
                const fenceChar = fenceToken[0] as '`' | '~';
                const fenceLength = fenceToken.length;
                if (activeFenceChar === null) {
                    activeFenceChar = fenceChar;
                    activeFenceLength = fenceLength;
                } else if (activeFenceChar === fenceChar && fenceLength >= activeFenceLength) {
                    activeFenceChar = null;
                    activeFenceLength = 0;
                }
                continue;
            }

            if (activeFenceChar !== null) {
                continue;
            }

            const blockquotePrefixMatch = line.match(/^((?:\s*>[ \t]?)*)(.*)$/);
            const blockquotePrefix = blockquotePrefixMatch?.[1] ?? '';
            const lineWithoutBlockquotePrefix = blockquotePrefixMatch?.[2] ?? line;
            const trimmed = lineWithoutBlockquotePrefix.trim();
            if (/^([*-])(?:\s*\1){2,}\s*$/.test(trimmed)) {
                continue;
            }

            const listMatch = lineWithoutBlockquotePrefix.match(/^([ \t]*)(?:[*+-]|\d+[.)])\s+/);
            if (!listMatch) {
                continue;
            }

            const indentWidth = this.getVisualIndentWidth(listMatch[1]);
            const blockquoteDepth = (blockquotePrefix.match(/>/g) || []).length;
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

    private annotateListItemSourceIndents(
        markdown: string,
        indentWrapperMarker: string,
        sourceIndentMarkerPrefix: string
    ): string {
        const segments = markdown.match(/[^\n]*\n|[^\n]+$/g);
        if (!segments || segments.length === 0) {
            return markdown;
        }

        const output: string[] = [];
        let activeFenceChar: '`' | '~' | null = null;
        let activeFenceLength = 0;
        const activeListStacks = new Map<string, Array<{ sourceIndent: number; depth: number }>>();
        const parserNestedIndent = this.detectListIndentSize(markdown) ?? 2;

        for (const segment of segments) {
            const lineEnding = segment.endsWith('\r\n')
                ? '\r\n'
                : (segment.endsWith('\n') ? '\n' : '');
            const lineWithoutEnding = lineEnding
                ? segment.slice(0, -lineEnding.length)
                : segment;

            const fenceMatch = lineWithoutEnding.match(/^ {0,3}(`{3,}|~{3,})/);
            if (fenceMatch) {
                output.push(segment);
                const fenceToken = fenceMatch[1];
                const fenceChar = fenceToken[0] as '`' | '~';
                const fenceLength = fenceToken.length;
                if (activeFenceChar === null) {
                    activeFenceChar = fenceChar;
                    activeFenceLength = fenceLength;
                } else if (activeFenceChar === fenceChar && fenceLength >= activeFenceLength) {
                    activeFenceChar = null;
                    activeFenceLength = 0;
                }
                continue;
            }

            if (activeFenceChar !== null) {
                output.push(segment);
                continue;
            }

            const trimmed = lineWithoutEnding.trim();
            if (/^([*-])(?:\s*\1){2,}\s*$/.test(trimmed)) {
                activeListStacks.clear();
                output.push(segment);
                continue;
            }

            const listMatch = lineWithoutEnding.match(/^((?:\s*>[ \t]?)*)([ \t]*)([*+-]|\d+[.)])([ \t]+)((?:\[[ xX]\][ \t]+)?)/);
            if (!listMatch) {
                if (trimmed !== '' && !/^<p\b[^>]*\bdata-mdw-blankline=/i.test(trimmed)) {
                    activeListStacks.clear();
                }
                output.push(segment);
                continue;
            }

            const [, blockquotePrefix, indent, marker, spacing, taskPrefix] = listMatch;
            const originalMarkerPrefix = `${blockquotePrefix}${indent}${marker}${spacing}${taskPrefix}`;
            const rest = lineWithoutEnding.slice(originalMarkerPrefix.length);
            const sourceIndent = this.getVisualIndentWidth(indent);
            const stackKey = blockquotePrefix;
            let stack = activeListStacks.get(stackKey) ?? [];

            let sourceDepth = 0;
            let sameIndentIndex = -1;
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].sourceIndent === sourceIndent) {
                    sameIndentIndex = i;
                    break;
                }
            }

            if (sameIndentIndex >= 0) {
                sourceDepth = stack[sameIndentIndex].depth;
                stack = stack.slice(0, sameIndentIndex);
            } else {
                let parentIndex = -1;
                for (let i = stack.length - 1; i >= 0; i--) {
                    if (stack[i].sourceIndent < sourceIndent) {
                        parentIndex = i;
                        break;
                    }
                }

                if (parentIndex >= 0) {
                    const sourceIndentDelta = sourceIndent - stack[parentIndex].sourceIndent;
                    const depthDelta = Math.max(1, Math.round(sourceIndentDelta / parserNestedIndent));
                    sourceDepth = stack[parentIndex].depth + depthDelta;
                    stack = stack.slice(0, parentIndex + 1);
                } else {
                    sourceDepth = sourceIndent >= parserNestedIndent
                        ? Math.max(1, Math.round(sourceIndent / parserNestedIndent))
                        : 0;
                    stack = [];
                }
            }

            const parentDepth = stack.length > 0 ? stack[stack.length - 1].depth : -1;
            for (let depth = parentDepth + 1; depth < sourceDepth; depth++) {
                const wrapperIndentText = ' '.repeat(depth * parserNestedIndent);
                const wrapperPrefix = `${blockquotePrefix}${wrapperIndentText}${marker}${spacing}`;
                output.push(`${wrapperPrefix}${indentWrapperMarker}${lineEnding}`);
            }

            const parserIndent = sourceDepth > 0
                ? sourceDepth * parserNestedIndent
                : Math.min(sourceIndent, 3);
            const parserIndentText = ' '.repeat(Math.max(0, parserIndent));
            const markerPrefix = `${blockquotePrefix}${parserIndentText}${marker}${spacing}${taskPrefix}`;
            output.push(`${markerPrefix}${sourceIndentMarkerPrefix}${sourceIndent}END${rest}${lineEnding}`);
            stack.push({ sourceIndent, depth: sourceDepth });
            activeListStacks.set(stackKey, stack);
        }

        return output.join('');
    }

    private applyListItemSourceIndentMarkers(
        html: string,
        indentWrapperMarker: string,
        sourceIndentMarkerPrefix: string
    ): string {
        const escapedWrapperMarker = indentWrapperMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedIndentMarkerPrefix = sourceIndentMarkerPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return html
            .replace(
                new RegExp(`(<li\\b[^>]*>)((?:\\s|<input\\b[^>]*>\\s*)*)${escapedWrapperMarker}`, 'gi'),
                (_match, openingTag, prefix) => openingTag.replace(
                    /<li\b/i,
                    '<li data-mdw-indent-wrapper="true" class="nested-list-only"'
                ) + prefix
            )
            .replace(
                new RegExp(`(<li\\b[^>]*>)((?:\\s|<input\\b[^>]*>\\s*)*)${escapedIndentMarkerPrefix}(\\d+)END`, 'gi'),
                (_match, openingTag, prefix, indent) => openingTag.replace(
                    /<li\b/i,
                    `<li data-mdw-source-indent="${indent}"`
                ) + prefix
            )
            .replace(
                /<li\b([^>]*)>((?:\s|<input\b[^>]*>\s*)*)<span\b[^>]*data-mdw-indent-wrapper-marker=(["'])true\2[^>]*>\s*<\/span>/gi,
                (_match, attrs, prefix) => `<li${attrs} data-mdw-indent-wrapper="true" class="nested-list-only">${prefix}`
            )
            .replace(
                /<li\b([^>]*)>((?:\s|<input\b[^>]*>\s*)*)<span\b[^>]*data-mdw-list-indent-marker=(["'])(\d+)\2[^>]*>\s*<\/span>/gi,
                (_match, attrs, prefix, _quote, indent) => `<li${attrs} data-mdw-source-indent="${indent}">${prefix}`
            )
            .replace(
                /<li\b([^>]*)>((?:\s|<input\b[^>]*>\s*)*)<!--MDW-INDENT-WRAPPER-->/gi,
                (_match, attrs, prefix) => `<li${attrs} data-mdw-indent-wrapper="true" class="nested-list-only">${prefix}`
            )
            .replace(
                /<li\b([^>]*)>((?:\s|<input\b[^>]*>\s*)*)<!--MDW-LIST-INDENT:(\d+)-->/gi,
                (_match, attrs, prefix, indent) => `<li${attrs} data-mdw-source-indent="${indent}">${prefix}`
            )
            .replace(/<!--MDW-INDENT-WRAPPER-->/g, '')
            .replace(/<!--MDW-LIST-INDENT:\d+-->/g, '')
            .replace(/<span\b[^>]*data-mdw-indent-wrapper-marker=(["'])true\1[^>]*>\s*<\/span>/gi, '')
            .replace(/<span\b[^>]*data-mdw-list-indent-marker=(["'])\d+\1[^>]*>\s*<\/span>/gi, '');
    }

    private protectNonRenderedMarkdown(markdown: string): {
        markdown: string;
        restore: (html: string) => string;
    } {
        const protectedBlocks: Array<{ marker: string; source: string; kind: string }> = [];
        let protectedMarkdown = markdown;

        const addProtectedBlock = (source: string, kind: string): string => {
            const marker = this.createPlaceholderMarker(
                `${protectedMarkdown}\n${protectedBlocks.map((entry) => entry.marker).join('\n')}`,
                `OPAQUE_${kind}`
            );
            protectedBlocks.push({ marker, source, kind });
            return marker;
        };

        // Marked interprets YAML front matter as a horizontal rule followed by a
        // Setext heading. Keep it as source instead of exposing a lossy DOM form.
        const frontMatterMatch = protectedMarkdown.match(
            /^(?:\uFEFF)?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/
        );
        if (frontMatterMatch) {
            let source = frontMatterMatch[0];
            let remainingMarkdown = protectedMarkdown.slice(source.length);
            const followingBlankLines = remainingMarkdown.match(/^(?:[ \t]*\r?\n)+/);
            if (followingBlankLines) {
                source += followingBlankLines[0];
                remainingMarkdown = remainingMarkdown.slice(followingBlankLines[0].length);
            }
            const marker = addProtectedBlock(source, 'front-matter');
            const lineEnding = source.includes('\r\n')
                ? '\r\n'
                : '\n';
            protectedMarkdown = `${marker}${lineEnding}${lineEnding}${remainingMarkdown}`;
        }

        // Marked can split a raw HTML container at a blank line (for example a
        // DIV with multiple paragraphs), which makes the independently converted
        // pieces gain Markdown paragraph spacing. Protect complete, line-oriented
        // containers before lexing so the original bytes stay together.
        const rawHtmlSegments = protectedMarkdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const rawHtmlOutput: string[] = [];
        let rawHtmlFenceMarker: '`' | '~' | null = null;
        let rawHtmlFenceLength = 0;
        const voidHtmlTags = new Set([
            'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
            'link', 'meta', 'param', 'source', 'track', 'wbr',
        ]);
        for (let index = 0; index < rawHtmlSegments.length; index++) {
            const segment = rawHtmlSegments[index];
            const line = segment.replace(/\r?\n$/, '');
            const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
            if (fenceMatch) {
                const run = fenceMatch[1];
                const marker = run[0] as '`' | '~';
                if (rawHtmlFenceMarker === null) {
                    rawHtmlFenceMarker = marker;
                    rawHtmlFenceLength = run.length;
                } else if (
                    rawHtmlFenceMarker === marker &&
                    run.length >= rawHtmlFenceLength
                ) {
                    rawHtmlFenceMarker = null;
                    rawHtmlFenceLength = 0;
                }
                rawHtmlOutput.push(segment);
                continue;
            }

            const openingTag = rawHtmlFenceMarker === null
                ? line.match(/^ {0,3}<([A-Za-z][\w:-]*)\b[^>]*>[ \t]*$/)
                : null;
            const tagName = openingTag?.[1]?.toLowerCase();
            if (!tagName || voidHtmlTags.has(tagName)) {
                rawHtmlOutput.push(segment);
                continue;
            }

            const closingTagPattern = new RegExp(`^ {0,3}<\\/${tagName}\\s*>[ \\t]*$`, 'i');
            const nestedOpeningTagPattern = new RegExp(
                `^ {0,3}<${tagName}\\b[^>]*>[ \\t]*$`,
                'i'
            );
            let closingIndex = -1;
            let nestedDepth = 1;
            for (let candidate = index + 1; candidate < rawHtmlSegments.length; candidate++) {
                const candidateLine = rawHtmlSegments[candidate].replace(/\r?\n$/, '');
                if (nestedOpeningTagPattern.test(candidateLine)) {
                    nestedDepth++;
                    continue;
                }
                if (closingTagPattern.test(candidateLine)) {
                    nestedDepth--;
                    if (nestedDepth === 0) {
                        closingIndex = candidate;
                        break;
                    }
                }
            }
            if (closingIndex < 0) {
                rawHtmlOutput.push(segment);
                continue;
            }

            let boundaryEndIndex = closingIndex;
            while (
                boundaryEndIndex + 1 < rawHtmlSegments.length &&
                rawHtmlSegments[boundaryEndIndex + 1].replace(/\r?\n$/, '').trim() === ''
            ) {
                boundaryEndIndex++;
            }
            const source = rawHtmlSegments.slice(index, boundaryEndIndex + 1).join('');
            const marker = addProtectedBlock(source, 'raw-html-block');
            const lineEnding = source.includes('\r\n')
                ? '\r\n'
                : '\n';
            rawHtmlOutput.push(`${marker}${lineEnding}${lineEnding}`);
            index = boundaryEndIndex;
        }
        protectedMarkdown = rawHtmlOutput.join('');

        // Reference definitions are consumed by Marked and would otherwise
        // disappear. Leave the definition in place so references still resolve,
        // and add an adjacent source marker that is rendered and restored later.
        const segments = protectedMarkdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const output: string[] = [];
        const pendingReferenceDefinitions: string[] = [];
        let fenceMarker: '`' | '~' | null = null;
        let fenceLength = 0;
        const flushReferenceDefinitions = (): void => {
            if (pendingReferenceDefinitions.length === 0) {
                return;
            }
            const source = pendingReferenceDefinitions.join('');
            const marker = addProtectedBlock(source, 'reference-definition');
            const sourceLineEnding = source.includes('\r\n') ? '\r\n' : '\n';
            const previousOutput = output[output.length - 1] || '';
            if (previousOutput !== '' && !previousOutput.endsWith('\n')) {
                output.push(sourceLineEnding);
            }
            output.push(`${marker}${sourceLineEnding}${sourceLineEnding}`);
            pendingReferenceDefinitions.length = 0;
        };
        for (const segment of segments) {
            const lineEnding = segment.endsWith('\r\n')
                ? '\r\n'
                : (segment.endsWith('\n') ? '\n' : '');
            const line = lineEnding ? segment.slice(0, -lineEnding.length) : segment;
            const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
            if (fenceMatch) {
                flushReferenceDefinitions();
                const run = fenceMatch[1];
                const marker = run[0] as '`' | '~';
                if (fenceMarker === null) {
                    fenceMarker = marker;
                    fenceLength = run.length;
                } else if (fenceMarker === marker && run.length >= fenceLength) {
                    fenceMarker = null;
                    fenceLength = 0;
                }
                output.push(segment);
                continue;
            }

            if (
                fenceMarker === null &&
                pendingReferenceDefinitions.length > 0 &&
                line.trim() === ''
            ) {
                pendingReferenceDefinitions.push(segment);
                continue;
            }
            if (fenceMarker === null && /^ {0,3}\[[^\]\r\n]+\]:[ \t]*\S/.test(line)) {
                output.push(segment);
                pendingReferenceDefinitions.push(segment);
                continue;
            }
            if (
                fenceMarker === null &&
                pendingReferenceDefinitions.length > 0 &&
                /^[ \t]+(?:["'(])/.test(line)
            ) {
                output.push(segment);
                pendingReferenceDefinitions.push(segment);
                continue;
            }
            flushReferenceDefinitions();
            output.push(segment);
        }
        flushReferenceDefinitions();
        protectedMarkdown = output.join('');

        return {
            markdown: protectedMarkdown,
            restore: (html: string): string => {
                let restoredHtml = html;
                for (const block of protectedBlocks) {
                    const escapedMarker = block.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const opaqueHtml = renderOpaqueSource(block.source, block.kind, true);
                    restoredHtml = restoredHtml.replace(
                        new RegExp(`<p>\\s*${escapedMarker}\\s*<\\/p>\\s*`, 'i'),
                        opaqueHtml
                    );
                }
                return restoredHtml;
            }
        };
    }

    private normalizeIgnoredLineWhitespace(markdown: string): string {
        const segments = markdown.match(/[^\n]*\n|[^\n]+$/g);
        if (!segments || segments.length === 0) {
            return markdown;
        }

        const output: string[] = [];
        let inFence = false;
        let fenceMarker: '`' | '~' | null = null;
        let fenceLength = 0;

        for (const segment of segments) {
            const lineEnding = segment.endsWith('\r\n')
                ? '\r\n'
                : (segment.endsWith('\n') ? '\n' : '');
            const lineWithoutEnding = lineEnding
                ? segment.slice(0, -lineEnding.length)
                : segment;
            const line = this.stripTrailingCarriageReturn(lineWithoutEnding);

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
                output.push(segment);
                inFence = true;
                fenceMarker = openingFence.marker;
                fenceLength = openingFence.length;
                continue;
            }

            const normalizedLine = line.trim() === '' ? '' : line;
            output.push(`${normalizedLine}${lineEnding}`);
        }

        return output.join('');
    }

    private preserveExtraBlankLines(markdown: string, blanklineMarker: string): string {
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
                output.push(`${blanklineMarker}\n`);
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

    private preserveEmptyBlockquoteLines(markdown: string, blockquoteEmptyLineMarker: string): string {
        const segments = markdown.match(/[^\n]*\n|[^\n]+$/g);
        if (!segments || segments.length === 0) {
            return markdown;
        }

        const output: string[] = [];
        let inFence = false;
        let fenceMarker: '`' | '~' | null = null;
        let fenceLength = 0;
        const getSegmentLineInfo = (segment: string): { line: string; lineEnding: string } => {
            const lineEnding = segment.endsWith('\r\n')
                ? '\r\n'
                : (segment.endsWith('\n') ? '\n' : '');
            const lineWithoutEnding = lineEnding
                ? segment.slice(0, -lineEnding.length)
                : segment;
            return {
                line: this.stripTrailingCarriageReturn(lineWithoutEnding),
                lineEnding,
            };
        };
        const emitEmptyBlockquoteMarker = (quotePrefix: string, lineEnding: string): void => {
            const normalizedLineEnding = lineEnding || '\n';
            output.push(`${quotePrefix}${normalizedLineEnding}`);
            output.push(`${quotePrefix} ${blockquoteEmptyLineMarker}${normalizedLineEnding}`);
            output.push(`${quotePrefix}${normalizedLineEnding}`);
        };

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            const { line } = getSegmentLineInfo(segment);

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
                output.push(segment);
                inFence = true;
                fenceMarker = openingFence.marker;
                fenceLength = openingFence.length;
                continue;
            }

            const parsedQuoteLine = this.parseBlockquoteLine(line);
            if (!parsedQuoteLine || parsedQuoteLine.content.trim() !== '') {
                output.push(segment);
                continue;
            }

            const run: Array<{ hasTrailingSpace: boolean; lineEnding: string }> = [];
            let j = i;
            while (j < segments.length) {
                const runLineInfo = getSegmentLineInfo(segments[j]);
                const runParsedLine = this.parseBlockquoteLine(runLineInfo.line);
                if (!runParsedLine ||
                    runParsedLine.content.trim() !== '' ||
                    runParsedLine.prefixTrimmed !== parsedQuoteLine.prefixTrimmed) {
                    break;
                }
                run.push({
                    hasTrailingSpace: runParsedLine.prefixRaw !== runParsedLine.prefixTrimmed,
                    lineEnding: runLineInfo.lineEnding,
                });
                j++;
            }

            const prevParsedLine = i > 0
                ? this.parseBlockquoteLine(getSegmentLineInfo(segments[i - 1]).line)
                : null;
            const nextParsedLine = j < segments.length
                ? this.parseBlockquoteLine(getSegmentLineInfo(segments[j]).line)
                : null;
            const hasPrevContent = !!(
                prevParsedLine &&
                prevParsedLine.prefixTrimmed === parsedQuoteLine.prefixTrimmed &&
                prevParsedLine.content.trim() !== ''
            );
            const hasNextContent = !!(
                nextParsedLine &&
                nextParsedLine.prefixTrimmed === parsedQuoteLine.prefixTrimmed &&
                nextParsedLine.content.trim() !== ''
            );

            let emptyLineCount = run.length;
            if (run.length > 1) {
                const forms = run.map((entry) => entry.hasTrailingSpace ? 1 : 0);
                const isAlternating = forms.every((form, index) => index === 0 || form !== forms[index - 1]);
                let isCanonicalSerializedRun = false;
                if (isAlternating) {
                    if (hasPrevContent && hasNextContent) {
                        // Between two content paragraphs, one visual empty line is serialized as:
                        // "> ", ">", "> ".
                        isCanonicalSerializedRun =
                            forms[0] === 1 &&
                            forms[forms.length - 1] === 1 &&
                            run.length >= 3;
                    } else if (!hasPrevContent && hasNextContent) {
                        // Leading empty quote lines are serialized as:
                        // ">", "> ", ">", "> ", ...
                        isCanonicalSerializedRun =
                            forms[0] === 0 &&
                            run.length % 2 === 0;
                    } else if (hasPrevContent && !hasNextContent) {
                        // Trailing empty quote lines are serialized as:
                        // "> ", ">", "> ", ">", ...
                        isCanonicalSerializedRun =
                            forms[0] === 1 &&
                            run.length % 2 === 0;
                    }
                }
                if (isCanonicalSerializedRun) {
                    emptyLineCount = Math.floor(run.length / 2);
                }
            }

            const markerLineEnding = run.length > 0
                ? (run[run.length - 1].lineEnding || '\n')
                : '\n';
            for (let k = 0; k < emptyLineCount; k++) {
                emitEmptyBlockquoteMarker(parsedQuoteLine.prefixTrimmed, markerLineEnding);
            }

            i = j - 1;
        }

        return output.join('');
    }

    private parseBlockquoteLine(line: string): { prefixRaw: string; prefixTrimmed: string; content: string } | null {
        const match = line.match(/^( {0,3}(?:>[ \t]?)+)(.*)$/);
        if (!match) {
            return null;
        }
        const prefixRaw = match[1];
        return {
            prefixRaw,
            prefixTrimmed: prefixRaw.replace(/[ \t]+$/, ''),
            content: match[2] ?? '',
        };
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

    private escapePlaceholderAngleBrackets(markdown: string): string {
        const segments = markdown.match(/[^\n]*\n|[^\n]+$/g);
        if (!segments || segments.length === 0) {
            return markdown;
        }

        const output: string[] = [];
        let inFence = false;
        let fenceMarker: '`' | '~' | null = null;
        let fenceLength = 0;

        for (const segment of segments) {
            const lineEnding = segment.endsWith('\r\n')
                ? '\r\n'
                : (segment.endsWith('\n') ? '\n' : '');
            const lineWithoutEnding = lineEnding
                ? segment.slice(0, -lineEnding.length)
                : segment;
            const line = this.stripTrailingCarriageReturn(lineWithoutEnding);

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
                output.push(segment);
                inFence = true;
                fenceMarker = openingFence.marker;
                fenceLength = openingFence.length;
                continue;
            }

            // Keep inline-code and indented-code lines untouched.
            if (line.includes('`') || /^(?: {4,}|\t)/.test(line)) {
                output.push(segment);
                continue;
            }

            output.push(`${this.escapeUnknownPlaceholderTagsInLine(line)}${lineEnding}`);
        }

        return output.join('');
    }

    private escapeUnknownPlaceholderTagsInLine(line: string): string {
        const angleTokens = line.match(/<[^<>\n]+>/g);
        if (!angleTokens || angleTokens.length < 2) {
            return line;
        }

        const hasNonHtmlToken = angleTokens.some((token) => {
            if (this.isAutolinkAngleToken(token)) {
                return false;
            }
            return !this.isHtmlTagLikeAngleToken(token);
        });
        if (!hasNonHtmlToken) {
            return line;
        }

        return line.replace(/<([A-Za-z][A-Za-z0-9-]*)>/g, (match, tagName: string) => {
            if (MarkdownDocument.commonHtmlTagNames.has(tagName.toLowerCase())) {
                return match;
            }
            return `&lt;${tagName}&gt;`;
        });
    }

    private isAutolinkAngleToken(token: string): boolean {
        if (/^<(?:https?:\/\/|ftp:\/\/|mailto:)[^>\s]+>$/i.test(token)) {
            return true;
        }

        return /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}>$/.test(token);
    }

    private isHtmlTagLikeAngleToken(token: string): boolean {
        return /^<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>$/.test(token);
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

    private createPlaceholderMarker(content: string, purpose: string): string {
        for (let attempt = 0; attempt < 100; attempt++) {
            const marker = `MDW_${purpose}_${getNonce()}`;
            if (!content.includes(marker)) {
                return marker;
            }
        }
        throw new Error(`Could not create a unique ${purpose} marker`);
    }

    private convertImagePaths(html: string): string {
        if (!this.webview) {
            return html;
        }

        const documentDir = path.dirname(this.document.uri.fsPath);
        // data-md-path is an internal trust marker added below. Raw Markdown HTML
        // must not be able to provide its own value and influence later imports
        // or Markdown serialization.
        // Work one actual IMG tag at a time. A global attribute regex can cross
        // escaped source text inside an opaque node (for example
        // "&lt;img ... data-md-path=...&gt;") and truncate that node.
        return html.replace(/<img\b[^>]*>/gi, (imageTag) => {
            const cleanedImageTag = imageTag.replace(
                /\sdata-md-path\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
                ''
            );
            const sourceMatch = cleanedImageTag.match(/^<img([^>]*?)src="([^"]+)"([^>]*?)>$/i);
            if (!sourceMatch) {
                return cleanedImageTag;
            }
            const [, before, src, after] = sourceMatch;
            // Decode URL-encoded src (marked encodes non-ASCII characters like Japanese)
            let decodedSrc = src;
            try {
                decodedSrc = decodeURIComponent(src);
            } catch {
                // Use original value when decode fails
            }

            // Skip if already an absolute URL or data URI
            if (decodedSrc.startsWith('http://') || decodedSrc.startsWith('https://') || decodedSrc.startsWith('data:')) {
                return cleanedImageTag;
            }

            // Convert relative path to absolute path
            const absolutePath = path.isAbsolute(decodedSrc) ? decodedSrc : path.join(documentDir, decodedSrc);

            try {
                // Convert to webview URI
                const webviewUri = this.webview!.asWebviewUri(vscode.Uri.file(absolutePath));
                const markdownPath = decodedSrc
                    .replace(/&/g, '&amp;')
                    .replace(/"/g, '&quot;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
                return `<img${before}src="${webviewUri}" data-md-path="${markdownPath}"${after}>`;
            } catch (error) {
                console.error('Error converting image path:', error);
                return cleanedImageTag;
            }
        });
    }

    public getText(): string {
        return this.document.getText();
    }
}

// Made with Bob
