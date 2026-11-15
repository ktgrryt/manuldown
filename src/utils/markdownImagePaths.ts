import { marked, Token } from 'marked';

const { createWindow } = require('@mixmark-io/domino');

export interface ImagePathReference {
    start: number;
    end: number;
    path: string;
    /** HTML attribute values need entity escaping when replaced directly. */
    format?: 'html' | 'markdown';
    quote?: string;
}

interface SourceText {
    text: string;
    offsets: number[];
}

interface PathReference extends ImagePathReference {
    html?: boolean;
    quote?: string;
}

// Keep offsets into the original text, including CRLF, rather than rendering
// Markdown again and changing unrelated formatting during a file move.
function sourceText(markdown: string): SourceText {
    let text = '';
    const offsets: number[] = [];
    for (let index = 0; index < markdown.length; index++) {
        offsets.push(index);
        text += markdown[index] === '\r' ? '\n' : markdown[index];
        if (markdown[index] === '\r' && markdown[index + 1] === '\n') {
            index++;
        }
    }
    return { text, offsets };
}

function slice(source: SourceText, start: number, end = source.text.length): SourceText {
    return { text: source.text.slice(start, end), offsets: source.offsets.slice(start, end) };
}

// Nested list and quote tokens omit their container prefixes. Match their lines
// independently so each character still refers to its position in the file.
function locate(text: string, source: SourceText, from = 0): { source: SourceText; start: number; end: number } | undefined {
    const exact = source.text.indexOf(text, from);
    if (exact !== -1) {
        return { source: slice(source, exact, exact + text.length), start: exact, end: exact + text.length };
    }
    const offsets: number[] = [];
    let cursor = from;
    let first = -1;
    for (const line of text.split(/(?<=\n)/)) {
        const content = line.replace(/\n$/, '');
        if (content === '') {
            // Marked inserts an extra line feed in some tight-list text tokens.
            const newline = source.text.indexOf('\n', cursor);
            offsets.push(source.offsets[newline >= 0 ? newline : Math.max(0, cursor - 1)]);
            continue;
        }
        let found = source.text.indexOf(content, cursor);
        let positions: number[] | undefined;
        if (found === -1) {
            // GFM removes the escape before a pipe in table-cell token.raw.
            const remaining = source.text.slice(cursor);
            const indices: number[] = [];
            let unescaped = '';
            for (let index = 0; index < remaining.length; index++) {
                if (remaining[index] === '\\' && remaining[index + 1] === '|') {
                    index++;
                }
                unescaped += remaining[index];
                indices.push(cursor + index);
            }
            const match = unescaped.indexOf(content);
            if (match !== -1) {
                positions = indices.slice(match, match + content.length);
                found = positions[0];
            }
        }
        if (found === -1) {
            return undefined;
        }
        if (first === -1) {
            first = found;
        }
        for (let index = 0; index < content.length; index++) {
            offsets.push(source.offsets[positions ? positions[index] : found + index]);
        }
        cursor = positions ? positions[positions.length - 1] + 1 : found + content.length;
        if (line.endsWith('\n')) {
            const newline = source.text.indexOf('\n', cursor);
            if (newline === -1) {
                return undefined;
            }
            offsets.push(source.offsets[newline]);
            cursor = newline + 1;
        }
    }
    return { source: { text, offsets }, start: Math.max(0, first), end: cursor };
}

function closingBracket(text: string, opening: number): number {
    let depth = 0;
    for (let index = opening; index < text.length; index++) {
        if (text[index] === '\\') {
            index++;
        } else if (text[index] === '[') {
            depth++;
        } else if (text[index] === ']' && --depth === 0) {
            return index;
        }
    }
    return -1;
}

function destination(text: string, offset: number): { start: number; end: number } | undefined {
    let start = offset;
    while (/\s/.test(text[start] || '') && start < text.length) {
        start++;
    }
    const angle = text[start] === '<';
    if (angle) {
        start++;
    }
    let depth = 0;
    for (let index = start; index < text.length; index++) {
        const character = text[index];
        if (character === '\\') {
            index++;
        } else if (angle ? character === '>' : /\s/.test(character) || (character === ')' && depth === 0)) {
            return { start, end: index };
        } else if (!angle && character === '(') {
            depth++;
        } else if (!angle && character === ')') {
            depth--;
        }
    }
    return start < text.length ? { start, end: text.length } : undefined;
}

const entityDecoder = createWindow('').document.createElement('textarea');
function decodeEntities(value: string): string {
    if (!value.includes('&')) {
        return value;
    }
    entityDecoder.innerHTML = value.replace(/</g, '&lt;');
    return entityDecoder.textContent;
}

function collectPaths(markdown: string, includeLinks: boolean): PathReference[] {
    const input = sourceText(markdown);
    const tokenizer = new marked.Tokenizer();
    const lexer = new marked.Lexer({ tokenizer, gfm: true });
    const tokens = lexer.lex(input.text);
    const references: PathReference[] = [];
    const definitions: Array<{ label: string; href: string; source: SourceText; start: number; end: number }> = [];
    const usedDefinitions = new Set<string>();
    const seenFootnotes = new Set<number>();
    const normalizeLabel = (label: string): string => label.toLowerCase().replace(/\s+/g, ' ');

    const add = (source: SourceText, start: number, end: number, href: string, html = false, quote?: string): void => {
        if (start >= end || source.offsets[start] === undefined || source.offsets[end - 1] === undefined) {
            return;
        }
        references.push({ start: source.offsets[start], end: source.offsets[end - 1] + 1,
            path: decodeEntities(href), ...(html ? { html, quote } : {}) });
    };

    const scanDefinitions = (source: SourceText): void => {
        const lines = /^(?: {0,3})\[/gm;
        for (let match; (match = lines.exec(source.text));) {
            const definition = tokenizer.def(source.text.slice(match.index));
            if (!definition || definition.tag.startsWith('^') || tokens.links[definition.tag]?.href !== definition.href) {
                continue;
            }
            const closing = closingBracket(definition.raw, definition.raw.indexOf('['));
            const url = destination(definition.raw, closing + 2);
            if (url) {
                definitions.push({ label: definition.tag, href: definition.href, source,
                    start: match.index + url.start, end: match.index + url.end });
            }
        }
    };

    const scanHtml = (source: SourceText): void => {
        // Comments and raw-text/code elements may contain strings resembling
        // tags. They do not provide image references to relocate.
        const tags = /<!--[\s\S]*?(?:-->|$)|<(script|style|pre|code|textarea)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<([a-z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
        for (let tag; (tag = tags.exec(source.text));) {
            const name = tag[2]?.toLowerCase();
            const attribute = name === 'img' ? 'src' : includeLinks && name === 'a' ? 'href' : '';
            if (!attribute) {
                continue;
            }
            const attributes = /([^\s=<>/'"]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
            const contents = tag[0];
            for (let attr; (attr = attributes.exec(contents));) {
                if (attr[1].toLowerCase() !== attribute) {
                    continue;
                }
                const value = attr[2] ?? attr[3] ?? attr[4];
                const quote = attr[2] !== undefined ? '"' : attr[3] !== undefined ? "'" : '';
                const start = attr.index + attr[0].length - value.length - (quote ? 1 : 0);
                add(source, tag.index + start, tag.index + start + value.length, value, true, quote);
                break;
            }
        }
    };

    const scanFootnotes = (source: SourceText, depth: number, protectedRanges: Array<[number, number]>): void => {
        if (depth >= 8) {
            return;
        }
        const prefix = /^ {0,3}\[\^[^\[\]\s\\]+\]:[ \t]*/gm;
        for (let match; (match = prefix.exec(source.text));) {
            const position = source.offsets[match.index];
            if (seenFootnotes.has(position) ||
                (match.index !== 0 && !/(?:^|\n)[ \t]*\n$/.test(source.text.slice(0, match.index))) ||
                protectedRanges.some(([start, end]) => position >= start && position < end)) {
                continue;
            }
            seenFootnotes.add(position);
            const contentStart = match.index + match[0].length;
            const firstEnd = source.text.indexOf('\n', contentStart);
            const parts = [slice(source, contentStart, firstEnd === -1 ? source.text.length : firstEnd + 1)];
            let cursor = firstEnd === -1 ? source.text.length : firstEnd + 1;
            while (cursor < source.text.length) {
                const newline = source.text.indexOf('\n', cursor);
                const end = newline === -1 ? source.text.length : newline + 1;
                const line = source.text.slice(cursor, end);
                if (/^ {0,3}(?:\[\^[^\[\]\s\\]+\]:|#{1,6}(?:[ \t]|$)|>|[*+-][ \t]|\d+[.)][ \t]|`{3,}|~{3,}|<)/.test(line)) {
                    break;
                }
                if (/^[ \t]*\n?$/.test(line)) {
                    const following = source.text.slice(end).match(/^(?:[ \t]*\n)*([^\n]*)/);
                    if (!following || !/^(?: {4}|\t)/.test(following[1])) {
                        break;
                    }
                }
                const indentation = /^(?: {4}|\t)/.exec(line)?.[0].length || 0;
                parts.push(slice(source, cursor + indentation, end));
                cursor = end;
            }
            const body: SourceText = { text: parts.map(part => part.text).join(''),
                offsets: parts.flatMap(part => part.offsets) };
            const noteLexer = new marked.Lexer({ gfm: true });
            // Notes can use reference definitions from the surrounding document.
            noteLexer.tokens.links = tokens.links;
            visit(noteLexer.lex(body.text), body, true, depth + 1);
            prefix.lastIndex = cursor;
        }
    };

    const visit = (sequence: Token[], source: SourceText, block = false, noteDepth = 0,
        protectedRanges: Array<[number, number]> = []): void => {
        let cursor = 0;
        for (const token of sequence) {
            const match = locate(token.raw, source, cursor);
            if (!match) {
                continue;
            }
            if (block) {
                scanDefinitions(slice(source, cursor, match.start));
            }
            cursor = match.end;
            const raw = match.source;
            if (token.type === 'code' || token.type === 'codespan') {
                protectedRanges.push([raw.offsets[0], raw.offsets[raw.offsets.length - 1] + 1]);
                continue;
            }
            if (token.type === 'html') {
                protectedRanges.push([raw.offsets[0], raw.offsets[raw.offsets.length - 1] + 1]);
                scanHtml(raw);
                continue;
            }
            if (token.type === 'image' || (includeLinks && token.type === 'link')) {
                const closing = closingBracket(token.raw, token.type === 'image' ? 1 : 0);
                if (closing === -1 && token.type === 'link' && token.raw.startsWith('<') && token.raw.endsWith('>')) {
                    add(raw, 1, token.raw.length - 1, token.href);
                } else if (closing !== -1 && token.raw[closing + 1] === '(') {
                    const url = destination(token.raw, closing + 2);
                    if (url) {
                        add(raw, url.start, url.end, token.href);
                    }
                } else if (closing !== -1) {
                    const second = token.raw[closing + 1] === '['
                        ? token.raw.slice(closing + 2, closingBracket(token.raw, closing + 1)) : '';
                    const label = second || token.raw.slice(token.type === 'image' ? 2 : 1, closing);
                    usedDefinitions.add(normalizeLabel(label));
                }
            }
            if (token.type === 'list') {
                visit(token.items, raw, false, noteDepth, protectedRanges);
            } else if (token.type === 'table') {
                let cellCursor = 0;
                for (const cell of [...token.header, ...token.rows.flat()]) {
                    const cellSource = locate(cell.text, raw, cellCursor);
                    if (cellSource) {
                        visit(cell.tokens, cellSource.source, false, noteDepth, protectedRanges);
                        cellCursor = cellSource.end;
                    }
                }
            } else if ('tokens' in token && token.tokens) {
                const content = 'text' in token && typeof token.text === 'string'
                    ? locate(token.text, raw)?.source : raw;
                if (content) {
                    visit(token.tokens, content, token.type === 'blockquote' || token.type === 'list_item',
                        noteDepth, protectedRanges);
                }
            }
        }
        if (block) {
            scanDefinitions(slice(source, cursor));
            scanFootnotes(source, noteDepth, protectedRanges);
        }
    };
    visit(tokens, input, true);
    const seenDefinitions = new Set<string>();
    for (const definition of definitions.sort((a, b) => a.source.offsets[a.start] - b.source.offsets[b.start])) {
        if (usedDefinitions.has(definition.label) && !seenDefinitions.has(definition.label)) {
            add(definition.source, definition.start, definition.end, definition.href);
            seenDefinitions.add(definition.label);
        }
    }
    const distinct = new Map(references.map(reference => [reference.start, reference]));
    return [...distinct.values()].sort((a, b) => a.start - b.start);
}

export function collectMarkdownImagePaths(markdown: string): ImagePathReference[] {
    return collectPaths(markdown, false).map(({ start, end, path, html, quote }) =>
        ({ start, end, path, ...(html ? { format: 'html' as const, quote } : {}) }));
}

/** File references include ordinary links so shared image files stay in place. */
export function collectMarkdownFilePaths(markdown: string): ImagePathReference[] {
    return collectPaths(markdown, true).map(({ start, end, path, html, quote }) =>
        ({ start, end, path, ...(html ? { format: 'html' as const, quote } : {}) }));
}

/** Replacements are URL-encoded paths, as produced by encodeMarkdownRelativePath. */
export function rewriteMarkdownImagePaths(markdown: string, replace: (path: string) => string | undefined): string {
    let result = markdown;
    for (const reference of collectPaths(markdown, false).reverse()) {
        let replacement = replace(reference.path);
        if (replacement === undefined) {
            continue;
        }
        if (reference.html) {
            replacement = replacement.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            if (!reference.quote) {
                replacement = replacement.replace(/[\s=<>`]/g, character => `&#${character.charCodeAt(0)};`);
            }
        }
        result = result.slice(0, reference.start) + replacement + result.slice(reference.end);
    }
    return result;
}
