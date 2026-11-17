import { marked } from 'marked';

export type CalloutVariant = 'note' | 'tip' | 'important' | 'warning' | 'caution';
export type CalloutService = 'github' | 'qiita' | 'zenn' | 'obsidian' | 'container' | 'mkdocs';

export function resolveCalloutService(value: unknown): CalloutService {
    return typeof value === 'string' && ['github', 'qiita', 'zenn', 'obsidian', 'container', 'mkdocs'].includes(value)
        ? value as CalloutService : 'github';
}

export type Callout = {
    raw: string;
    body: string;
    header: string;
    footer: string;
    format: 'quote' | 'container' | 'mkdocs';
    sourceType: string;
    variant: CalloutVariant;
    title: string;
    indent: string;
};

const variants: Record<string, CalloutVariant> = Object.assign(Object.create(null), {
    note: 'note', info: 'note', abstract: 'note', summary: 'note', tldr: 'note',
    todo: 'note', example: 'note', quote: 'note', cite: 'note',
    tip: 'tip', hint: 'tip', success: 'tip', check: 'tip', done: 'tip',
    important: 'important', question: 'important', help: 'important', faq: 'important',
    warning: 'warning', warn: 'warning', attention: 'warning',
    caution: 'caution', danger: 'caution', error: 'caution', failure: 'caution',
    fail: 'caution', missing: 'caution', bug: 'caution',
});
const containerTypes = new Set(['note', 'tip', 'info', 'important', 'warning', 'danger', 'caution']);

function lines(source: string): string[] {
    return source.match(/[^\n]*\n|[^\n]+$/g) || [];
}
function lineText(line: string): string { return line.replace(/\r?\n$/, ''); }

/** Validate a declaration independently of its body, preserving its spelling. */
export function calloutDeclaration(header: string, format: Callout['format']): Omit<Callout, 'raw' | 'body' | 'footer'> | null {
    let match: RegExpMatchArray | null;
    let sourceType: string;
    let title: string | undefined;
    let indent = '';
    if (format === 'quote') {
        match = header.match(/^( {0,3})>[ \t]?\[!([A-Za-z][A-Za-z0-9-]*)\]([+-]?)(?:[ \t]+(.*))?[ \t]*$/);
        if (!match || !variants[match[2].toLowerCase()]) {return null;}
        indent = match[1];
        sourceType = match[2];
        title = (match[4] || '').trim() || undefined;
    } else if (format === 'container') {
        match = header.match(/^( {0,3}):{3,}[ \t]*([a-z]+)(.*)$/);
        if (!match) {return null;}
        indent = match[1];
        sourceType = match[2];
        const rest = match[3];
        if (sourceType === 'note' && /^(?:[ \t]+(?:info|warn|alert))[ \t]*$/.test(rest)) {
            sourceType = rest.trim();
        } else if (sourceType === 'message') {
            if (!/^(?:[ \t]+alert)?[ \t]*$/.test(rest)) {return null;}
            sourceType = rest.trim() || 'message';
        } else {
            if (!containerTypes.has(sourceType)) {return null;}
            if (rest.startsWith('[')) {
                if (!/^\[[^\r\n]*\][ \t]*$/.test(rest)) {return null;}
                title = rest.slice(1, rest.lastIndexOf(']'));
            } else if (rest && !/^[ \t]/.test(rest)) {
                return null;
            } else {
                title = rest.trim() || undefined;
            }
        }
    } else {
        match = header.match(/^( {0,3})(?:!!!|\?\?\?\+?)[ \t]+([a-z]+)(?:[ \t]+"([^"\r\n]*)")?[ \t]*$/);
        if (!match || !variants[match[2]]) {return null;}
        indent = match[1];
        sourceType = match[2];
        title = match[3];
    }
    const variant: CalloutVariant = sourceType === 'alert' ? 'caution'
        : sourceType === 'message' ? 'note' : variants[sourceType.toLowerCase()];
    return { header, format, sourceType, variant, title: title ?? sourceType, indent };
}

/** Validate a type-picker edit without trusting a rewritten body or title. */
export function isCalloutTypeChange(original: Callout, updated: Callout): boolean {
    if (original.format !== updated.format || original.footer !== updated.footer) {
        return false;
    }
    const descriptor = (callout: Callout, expectedDialect?: string): { dialect: string; prefix: string; suffix: string } | null => {
        const { header, format } = callout;
        if (!calloutDeclaration(header, format)) {
            return null;
        }
        if (format === 'quote') {
            const match = header.match(/^( {0,3}>[ \t]?\[!)[A-Za-z][A-Za-z0-9-]*(\].*)$/);
            return match ? { dialect: 'quote', prefix: match[1], suffix: match[2] } : null;
        }
        if (format === 'mkdocs') {
            const match = header.match(/^( {0,3}(?:!!!|\?\?\?\+?)[ \t]+)[a-z]+(.*)$/);
            return match ? { dialect: 'mkdocs', prefix: match[1], suffix: match[2] } : null;
        }
        // A bare :::note is shared by Qiita and generic containers. In the
        // absence of a title, its picker keeps the narrow Qiita subtype family.
        const qiita = header.match(/^( {0,3}:{3,}[ \t]*note)(?:[ \t]+(?:info|warn|alert))?[ \t]*$/);
        if (qiita && expectedDialect !== 'container') {
            return { dialect: 'qiita', prefix: qiita[1], suffix: '' };
        }
        const zenn = header.match(/^( {0,3}:{3,}[ \t]*message)(?:[ \t]+alert)?[ \t]*$/);
        if (zenn && expectedDialect !== 'container') {
            return { dialect: 'zenn', prefix: zenn[1], suffix: '' };
        }
        const generic = header.match(/^( {0,3}:{3,}[ \t]*)([a-z]+)(.*)$/);
        return generic && containerTypes.has(generic[2])
            ? { dialect: 'container', prefix: generic[1], suffix: generic[3] } : null;
    };
    const before = descriptor(original);
    const after = descriptor(updated, before?.dialect);
    return !!before && !!after && before.dialect === after.dialect &&
        before.prefix === after.prefix && before.suffix === after.suffix;
}

/** A format change may replace delimiters and default labels, but not a custom title. */
export function isCalloutFormatChange(original: Callout, updated: Callout): boolean {
    const before = calloutDeclaration(original.header, original.format);
    const after = calloutDeclaration(updated.header, updated.format);
    if (!before || !after) {return false;}
    return before.title === after.title ||
        (before.title === before.sourceType && after.title === after.sourceType);
}

function literalMarkdownRanges(source: string): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    // Disable extensions to avoid recursion while inspecting Markdown contexts.
    const lexer = new marked.Lexer({ ...marked.defaults, tokenizer: new marked.Tokenizer(), extensions: null });
    for (const token of lexer.lex(source)) {
        const start = source.indexOf(token.raw, cursor);
        if (start < 0) {break;}
        cursor = start + token.raw.length;
        if (token.type === 'code' || token.type === 'html') {ranges.push({ start, end: cursor });}
        else if (token.type === 'list' || token.type === 'blockquote') {
            // Nested code tokens have their list/quote prefixes removed by
            // Marked. Locate their literal lines inside this container, allowing
            // only those structural prefixes between lines. Delimiters inside
            // a list's fenced example must not close the surrounding callout.
            marked.walkTokens([token], child => {
                if (child.type !== 'code' && child.type !== 'html') {return;}
                const trailing = child.raw.endsWith('\n');
                const parts = child.raw.replace(/\n$/, '').split('\n');
                const escaped = parts.map(line => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                const pattern = new RegExp(escaped.join('\\n[ \\t]*(?:>[ \\t]*)*') + (trailing ? '\\n' : ''), 'g');
                for (const match of token.raw.matchAll(pattern)) {
                    ranges.push({ start: start + match.index!, end: start + match.index! + match[0].length });
                }
            });
        }
    }
    return ranges.sort((a, b) => a.start - b.start);
}

/**
 * Scan colon delimiters line by line, with code blocks recognized by Marked.
 * Unknown nested directives are retained as source rather than guessed.
 */
function containerExtent(source: string): { raw: string; body: string; footer: string; unsupported: boolean } | null {
    const first = lineText(source.slice(0, source.indexOf('\n') < 0 ? source.length : source.indexOf('\n') + 1));
    const opening = first.match(/^ {0,3}(:{3,})/);
    if (!opening || !/^ {0,3}:{3,}[ \t]*[a-z]+(?:[ \t\[].*)?$/.test(first) || !source.includes('\n')) {return null;}
    // Incomplete declarations are common while typing. Avoid lexing every
    // suffix of a malformed document when no closing delimiter even exists.
    if (!/^ {0,3}:{3,}[ \t]*(?:\r?\n|$)/m.test(source.slice(first.length + 1))) {return null;}
    const segments = lines(source);
    const widths = [opening[1].length];
    let unsupported = !calloutDeclaration(first, 'container');
    let bodyEnd = -1;
    // Lex body code/HTML as Markdown so delimiter examples remain literal.
    // Token raw ranges give context without interpreting Markdown with a regex.
    const bodySource = segments.slice(1).join('');
    const literalRanges = literalMarkdownRanges(bodySource);
    let bodyOffset = 0;
    let literalIndex = 0;
    for (let index = 1; index < segments.length; index++) {
        while (literalIndex < literalRanges.length && literalRanges[literalIndex].end <= bodyOffset) {literalIndex++;}
        const literal = literalRanges[literalIndex];
        const protectedLine = literal && bodyOffset >= literal.start && bodyOffset < literal.end;
        const line = lineText(segments[index]);
        if (!protectedLine) {
            const close = line.match(/^ {0,3}(:{3,})[ \t]*$/);
            const nested = line.match(/^ {0,3}(:{3,})[ \t]*[A-Za-z][^\r\n]*$/);
            if (close) {
                if (close[1].length >= widths[widths.length - 1]) {
                    widths.pop();
                    if (widths.length === 0) { bodyEnd = index; break; }
                }
            } else if (nested) {
                if (!calloutDeclaration(line, 'container')) {unsupported = true;}
                widths.push(nested[1].length);
            }
        }
        bodyOffset += segments[index].length;
    }
    if (bodyEnd < 0) {return null;}
    return {
        raw: segments.slice(0, bodyEnd + 1).join(''),
        body: segments.slice(1, bodyEnd).join(''),
        footer: lineText(segments[bodyEnd]), unsupported,
    };
}

/** Return one complete, explicitly supported callout at the start of source. */
export function parseCallout(source: string): Callout | null {
    const firstEnd = source.indexOf('\n');
    const header = source.slice(0, firstEnd < 0 ? source.length : firstEnd).replace(/\r$/, '');
    const format: Callout['format'] | null = /^ {0,3}>/.test(header) ? 'quote'
        : /^ {0,3}:/.test(header) ? 'container' : /^ {0,3}(?:!!!|\?\?\?)/.test(header) ? 'mkdocs' : null;
    if (!format) {return null;}
    const declaration = calloutDeclaration(header, format);
    if (!declaration) {return null;}
    source = source.replace(/\r\n?/g, '\n');
    if (format === 'container') {
        const extent = containerExtent(source);
        if (!extent || extent.unsupported) {return null;}
        return { ...declaration, ...extent };
    }
    const segments = lines(source);
    if (format === 'quote') {
        let end = 1;
        while (end < segments.length && /^ {0,3}>/.test(segments[end])) {end++;}
        const raw = segments.slice(0, end).join('');
        const body = segments.slice(1, end).map(segment => segment.replace(/^ {0,3}>[ \t]?/, '')).join('');
        return { ...declaration, raw, body, footer: '' };
    }
    let end = 1;
    let hasBody = false;
    const bodyIndent = new RegExp('^(?:' + declaration.indent + ' {4}|\\t)');
    for (; end < segments.length; end++) {
        const text = lineText(segments[end]);
        if (bodyIndent.test(text)) {
            // An explicitly indented empty body keeps an emptied callout
            // editable after saving, without inserting visible placeholder text.
            hasBody = true;
            continue;
        }
        if (text.trim() === '') {
            // Blank lines only belong to this callout when another body line follows.
            let next = end + 1;
            while (next < segments.length && lineText(segments[next]).trim() === '') {next++;}
            if (next >= segments.length || !bodyIndent.test(segments[next])) {break;}
            continue;
        }
        break;
    }
    if (!hasBody) {return null;}
    const raw = segments.slice(0, end).join('');
    const body = segments.slice(1, end).map(segment => segment.replace(bodyIndent, '')).join('');
    return { ...declaration, raw, body, footer: '' };
}

export function unsupportedCalloutSource(source: string): string | null {
    const extent = containerExtent(source);
    return extent?.unsupported ? extent.raw : null;
}

/** Top-level token ranges, retaining original CRLF offsets. */
export function calloutRanges(source: string): Array<{ start: number; end: number }> {
    let normalized = '';
    const offsets: number[] = [];
    for (let index = 0; index < source.length; index++) {
        offsets.push(index);
        normalized += source[index] === '\r' ? '\n' : source[index];
        if (source[index] === '\r' && source[index + 1] === '\n') {index++;}
    }
    offsets.push(source.length);
    const ranges: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    for (const token of marked.lexer(normalized)) {
        const start = normalized.indexOf(token.raw, cursor);
        if (start < 0) {break;}
        cursor = start + token.raw.length;
        if (token.type === 'callout') {ranges.push({ start: offsets[start], end: offsets[cursor] });}
    }
    return ranges;
}

/** Rebuild only the delimiters; inline/body Markdown uses the normal serializer. */
export function serializeCallout(callout: Callout, bodyMarkdown: string): string {
    const body = bodyMarkdown.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    if (callout.format === 'quote') {
        return callout.header + (body ? '\n' + body.split('\n').map(line => callout.indent + (line ? '> ' + line : '>')).join('\n') : '') + '\n';
    }
    if (callout.format === 'mkdocs') {
        return callout.header + '\n' + (body || '').split('\n').map(line => line || !body ? callout.indent + '    ' + line : '').join('\n') + '\n';
    }
    let header = callout.header;
    let footer = callout.footer;
    // A literal delimiter typed into the body must never close the outer block.
    const literalRanges = literalMarkdownRanges(body);
    const nestedWidths: number[] = [];
    const bodyWidths: number[] = [];
    for (const match of body.matchAll(/^ {0,3}(:{3,})([^\n]*)$/gm)) {
        if (literalRanges.some(range => match.index! >= range.start && match.index! < range.end)) {continue;}
        if (/^[ \t]*[A-Za-z]/.test(match[2])) {nestedWidths.push(match[1].length);}
        else if (/^[ \t]*$/.test(match[2])) {
            if (nestedWidths.length && match[1].length >= nestedWidths[nestedWidths.length - 1]) {nestedWidths.pop();}
            else if (!nestedWidths.length) {bodyWidths.push(match[1].length);}
        }
    }
    const originalWidth = header.match(/^ {0,3}(:{3,})/)![1].length;
    const width = Math.max(originalWidth, ...bodyWidths.map(value => value + 1));
    if (width !== originalWidth) {
        header = header.replace(/:{3,}/, ':'.repeat(width));
        footer = footer.replace(/:{3,}/, ':'.repeat(width));
    }
    return header + '\n' + body + '\n' + footer + '\n';
}

function escape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function renderCallout(callout: Callout, bodyHtml: string): string {
    const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');
    return `<div class="mdw-callout" data-mdw-callout="true" data-mdw-callout-source="${base64(callout.raw)}" data-mdw-callout-header="${base64(callout.header)}" data-mdw-callout-footer="${base64(callout.footer)}" data-mdw-callout-format="${callout.format}" data-mdw-callout-type="${escape(callout.sourceType)}" data-mdw-callout-variant="${callout.variant}"><div class="mdw-callout-title" contenteditable="false" role="button" tabindex="-1" aria-haspopup="listbox" aria-expanded="false" aria-label="Change callout type (${escape(callout.sourceType)})">${escape(callout.title)}</div><div class="mdw-callout-content">${bodyHtml || '<p><br></p>'}</div></div>\n`;
}
