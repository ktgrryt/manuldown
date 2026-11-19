import { CalloutVariant, fencedDescriptor, FencedService, gitbookCloser, gitbookOpener, mystHasOptions } from './CalloutFormats';
import { marked } from 'marked';
import { createBoundedTokenizer } from './MarkdownNesting';

export { CalloutService, CalloutVariant, isCalloutService, resolveCalloutService } from './CalloutFormats';

export type Callout = {
    raw: string;
    body: string;
    header: string;
    footer: string;
    format: 'quote' | 'container' | 'mkdocs' | FencedService;
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
    if (format === 'gitbook' || format === 'myst' || format === 'quarto') {
        const spec = fencedDescriptor(header);
        if (!spec || spec.dialect !== format) { return null; }
        return { header, format, sourceType: spec.current, variant: spec.variant(spec.current),
            title: spec.title ?? spec.current, indent: header.match(/^ */)![0] };
    }
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
    const fenced = fencedDescriptor(original.header);
    if (fenced) {
        return fenced.options.includes(updated.sourceType) && fenced.rewrite(updated.sourceType) === updated.header;
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
    const lexer = new marked.Lexer({ ...marked.defaults, tokenizer: createBoundedTokenizer(), extensions: null });
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
                if (child.type !== 'code' && child.type !== 'html' &&
                    !(child.type === 'codespan' && child.raw.includes('\n'))) {return;}
                const trailing = child.raw.endsWith('\n');
                const parts = child.raw.replace(/\n$/, '').split('\n');
                const escaped = parts.map(line => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                const pattern = new RegExp(escaped.join('\\n[ \\t]*(?:>[ \\t]*)*') + (trailing ? '\\n' : ''), 'g');
                for (const match of token.raw.matchAll(pattern)) {
                    ranges.push({ start: start + match.index!, end: start + match.index! + match[0].length });
                }
            });
        } else if (token.raw.includes('`') && token.raw.includes('\n')) {
            let inlineCursor = 0;
            marked.walkTokens([token], child => {
                if (child.type !== 'codespan' || !child.raw.includes('\n')) { return; }
                const offset = token.raw.indexOf(child.raw, inlineCursor);
                if (offset >= 0) {
                    inlineCursor = offset + child.raw.length;
                    ranges.push({ start: start + offset, end: start + inlineCursor });
                }
            });
        }
    }
    return ranges.sort((a, b) => a.start - b.start);
}

/** The reader and writer must agree on which body lines can end a block. */
function* bodyDelimiters(source: string, gitbook: boolean) {
    const candidates = gitbook ? /^ {0,3}\{%[^\r\n]*%\}[ \t]*\r?$/gm
        : /^ {0,3}(:{3,})[ \t]*([A-Za-z{][^\r\n]*)?\r?$/gm;
    let literalRanges: ReturnType<typeof literalMarkdownRanges> | undefined;
    let literalIndex = 0;
    for (const match of source.matchAll(candidates)) {
        const line = match[0].replace(/\r$/, '');
        const closing = gitbook ? gitbookCloser.test(line) : !match[2];
        if (gitbook && !closing && !gitbookOpener.test(line)) { continue; }
        const offset = match.index!;
        literalRanges ??= literalMarkdownRanges(source);
        while (literalIndex < literalRanges.length && literalRanges[literalIndex].end <= offset) { literalIndex++; }
        if (literalIndex < literalRanges.length && literalRanges[literalIndex].start <= offset) { continue; }
        const spec = closing ? null : fencedDescriptor(line);
        const width = gitbook ? 0 : spec?.dialect === 'quarto' ? 3 : match[1].length;
        const supported = closing || !!spec || !!calloutDeclaration(line, 'container');
        yield { offset, line, closing, width, supported };
    }
}

function containerExtent(source: string): { raw: string; body: string; footer: string; unsupported: boolean } | null {
    const firstEnd = source.indexOf('\n');
    if (firstEnd < 0) { return null; }
    const first = source.slice(0, firstEnd).replace(/\r$/, '');
    const spec = fencedDescriptor(first);
    if (spec?.fence.startsWith('`')) {
        // MyST backtick directives follow Markdown's closing-fence length rule.
        const close = /^ {0,3}(`{3,})[ \t]*\r?$/gm;
        close.lastIndex = firstEnd + 1;
        let match: RegExpExecArray | null;
        while ((match = close.exec(source))) {
            if (match[1].length < spec.fence.length) { continue; }
            const body = source.slice(firstEnd + 1, match.index);
            return { raw: source.slice(0, close.lastIndex + (source[close.lastIndex] === '\n' ? 1 : 0)),
                body, footer: match[0].replace(/\r$/, ''), unsupported: mystHasOptions(body) };
        }
        return null;
    }

    const hint = gitbookOpener.test(first);
    const opening = /^ {0,3}(:{3,})[ \t]*[a-z]+(?:[ \t\[].*)?$/.exec(first);
    const quarto = spec?.dialect === 'quarto' || (!spec && /^ {0,3}:{3,}[ \t]*(?:\{[^}\n]*\.callout-|callout-)/.test(first));
    const myst = /^ {0,3}:{3,}[ \t]*\{[\w-]+\}/.test(first);
    if (!hint && !opening && !spec && !quarto && !myst) { return null; }
    const bodySource = source.slice(firstEnd + 1);
    if (hint ? !bodySource.includes('endhint') : !/^ {0,3}:{3,}[ \t]*\r?$/m.test(bodySource)) { return null; }
    const widths = [quarto ? 3 : (spec?.fence.length ?? first.match(/:{3,}/)?.[0].length ?? 0)];
    let unsupported = !spec && !calloutDeclaration(first, 'container');
    for (const marker of bodyDelimiters(bodySource, hint)) {
        if (!marker.closing) {
            widths.push(marker.width);
            if (!marker.supported) { unsupported = true; }
        } else if (marker.width >= widths[widths.length - 1]) {
            widths.pop();
            if (!widths.length) {
                const body = bodySource.slice(0, marker.offset);
                const end = firstEnd + 1 + marker.offset + marker.line.length;
                return { raw: source.slice(0, end + (source[end] === '\r' ? 2 : source[end] === '\n' ? 1 : 0)),
                    body, footer: marker.line, unsupported: unsupported || (spec?.dialect === 'myst' && mystHasOptions(body)) };
            }
        }
    }
    return null;
}

/** Return one complete, explicitly supported callout at the start of source. */
export function parseCallout(source: string): Callout | null {
    const firstEnd = source.indexOf('\n');
    const header = source.slice(0, firstEnd < 0 ? source.length : firstEnd).replace(/\r$/, '');
    const format = fencedDescriptor(header)?.dialect ?? (/^ {0,3}>/.test(header) ? 'quote'
        : /^ {0,3}:/.test(header) ? 'container' : /^ {0,3}(?:!!!|\?\?\?)/.test(header) ? 'mkdocs' : null);
    if (!format) {return null;}
    const declaration = calloutDeclaration(header, format);
    if (!declaration) {return null;}
    source = source.replace(/\r\n?/g, '\n');
    if (format !== 'quote' && format !== 'mkdocs') {
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
    let body = bodyMarkdown.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    if (callout.format === 'quote') {
        return callout.header + (body ? '\n' + body.split('\n').map(line => callout.indent + (line ? '> ' + line : '>')).join('\n') : '') + '\n';
    }
    if (callout.format === 'mkdocs') {
        return callout.header + '\n' + (body || '').split('\n').map(line => line || !body ? callout.indent + '    ' + line : '').join('\n') + '\n';
    }
    let header = callout.header;
    let footer = callout.footer;
    if (callout.format === 'myst' && header.trimStart().startsWith('`')) {
        const opening = header.match(/`+/)![0].length;
        let width = opening;
        for (const match of body.matchAll(/^ {0,3}(`{3,})[ \t]*$/gm)) { width = Math.max(width, match[1].length + 1); }
        if (width > opening) {
            header = header.replace(/`+/, '`'.repeat(width));
            footer = footer.replace(/`+/, run => '`'.repeat(Math.max(width, run.length)));
        }
        return header + '\n' + body + '\n' + footer + '\n';
    }
    const gitbook = callout.format === 'gitbook';
    const canWiden = !gitbook && callout.format !== 'quarto';
    const originalWidth = gitbook ? 0 : header.match(/:{3,}/)![0].length;
    let width = originalWidth;
    type BodyMarker = { width: number; offset: number };
    const nested: { opener: BodyMarker; shorterClosers: BodyMarker[] }[] = [];
    const escapes = new Set<number>();
    const protectCloser = (marker: BodyMarker) => {
        if (canWiden) { width = Math.max(width, marker.width + 1); }
        else { escapes.add(marker.offset); }
    };
    for (const marker of bodyDelimiters(body, gitbook)) {
        if (!marker.closing) {
            nested.push({ opener: marker, shorterClosers: [] });
        } else if (nested.length) {
            const inner = nested[nested.length - 1];
            if (marker.width >= inner.opener.width) { nested.pop(); }
            else { inner.shorterClosers.push(marker); }
        } else {
            protectCloser(marker);
        }
    }
    // Fixed closing markers (and unpaired openers) must stay visible as literal text.
    for (const { opener, shorterClosers } of nested) {
        escapes.add(opener.offset);
        shorterClosers.forEach(protectCloser);
    }
    if (escapes.size) {
        body = body.replace(/^ */gm, (indent, offset) => escapes.has(offset) ? indent + '\\' : indent);
    }
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
    if (bodyHtml.includes('data-mdw-opaque-source=')) {
        const { createWindow } = require('@mixmark-io/domino');
        const root = createWindow(bodyHtml).document;
        const editable = Array.from<any>(root.querySelectorAll('p, pre, td, th, img, input, hr'))
            .some(node => !node.closest('[contenteditable="false"]'));
        // A body made entirely of preserved source still needs a real text
        // position. A DOM boundary before a read-only PRE is not a stable
        // Chromium caret and can jump outside the callout on the next key.
        if (!editable) { bodyHtml = '<p><br></p>' + bodyHtml; }
    }
    const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');
    return `<div class="mdw-callout" data-mdw-callout="true" data-mdw-callout-source="${base64(callout.raw)}" data-mdw-callout-header="${base64(callout.header)}" data-mdw-callout-footer="${base64(callout.footer)}" data-mdw-callout-format="${callout.format}" data-mdw-callout-type="${escape(callout.sourceType)}" data-mdw-callout-variant="${callout.variant}"><div class="mdw-callout-title" contenteditable="false" role="button" tabindex="-1" aria-haspopup="listbox" aria-expanded="false" aria-label="Change callout type (${escape(callout.sourceType)})">${escape(callout.title)}</div><div class="mdw-callout-content">${bodyHtml || '<p><br></p>'}</div></div>\n`;
}
