import { marked } from 'marked';

const { createWindow } = require('@mixmark-io/domino');

export const markdownTocStart = '<!-- manuldown:toc -->';
export const markdownTocEnd = '<!-- /manuldown:toc -->';

/** A generated list has one Markdown link item per line and no literal code. */
export function matchMarkdownTocBlock(source: string): string | undefined {
    const opening = /^ {0,3}<!-- manuldown:toc -->[ \t]*\n/.exec(source);
    if (!opening) {
        return undefined;
    }
    const closing = /^ {0,3}<!-- \/manuldown:toc -->[ \t]*(?:\n|$)/gm;
    closing.lastIndex = opening[0].length;
    const end = closing.exec(source);
    if (!end) {
        return undefined;
    }
    const lines = source.slice(opening[0].length, end.index)
        .replace(/MDW_(?:BLOCKQUOTE_EMPTY_LINE|BLANK_LINE)_[A-Za-z0-9]{32}/g, '')
        .replace(/MDW_LIST_INDENT_[A-Za-z0-9]{32}\d+M[0-9a-f]{2}END /g, '')
        .split('\n');
    if (lines.some(line => line.trim() !== '' && !/^[ \t]*[-+*][ \t]+\[/.test(line))) {
        return undefined;
    }
    return source.slice(0, closing.lastIndex);
}

/** Recognize only actual top-level comment blocks, never code or raw HTML text. */
export function markdownTocRanges(source: string): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    if (!source.includes(markdownTocStart)) {
        return ranges;
    }
    // Marked normalizes CRLF before tokenizing. Retain original source offsets
    // so replacing a token never cuts the following CRLF document text.
    let normalized = '';
    const offsets: number[] = [];
    for (let index = 0; index < source.length; index++) {
        offsets.push(index);
        normalized += source[index] === '\r' ? '\n' : source[index];
        if (source[index] === '\r' && source[index + 1] === '\n') {
            index++;
        }
    }
    offsets.push(source.length);
    let cursor = 0;
    for (const token of marked.lexer(normalized)) {
        const start = normalized.indexOf(token.raw, cursor);
        if (start < 0) {
            break;
        }
        cursor = start + token.raw.length;
        if (token.type !== 'markdownToc' || offsets[start] < (ranges[ranges.length - 1]?.end ?? 0)) {
            continue;
        }
        ranges.push({ start: offsets[start], end: offsets[cursor] });
    }
    return ranges;
}

export function emptyMarkdownTocHtml(): string {
    return '<div class="mdw-toc-block" data-mdw-toc="true" contenteditable="false" tabindex="0" role="group" aria-label="Table of contents"></div>\n';
}

function headings(root: any): Array<{ level: number; text: string; id: string }> {
    const used = new Set<string>();
    return Array.from<any>(root.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        .filter(node => !node.closest('[data-mdw-toc]'))
        .map((node, index) => {
            // Keep this slug algorithm aligned with MarkdownHeadingSlug.js.
            const raw = String(node.textContent || '');
            const base = raw.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
                .replace(/\s+/g, '-') || `heading-${index}`;
            let id = base;
            let duplicate = 1;
            while (used.has(id)) {
                id = `${base}-${duplicate++}`;
            }
            used.add(id);
            node.id = id;
            return { level: Number(node.tagName.slice(1)), text: raw.replace(/\s+/g, ' ').trim(), id };
        }).filter(heading => heading.text !== '');
}

function generatedList(items: ReturnType<typeof headings>, document: any): any {
    const list = document.createElement('ul');
    const ancestors: Array<{ level: number; item: any; list?: any }> = [];
    for (const heading of items) {
        while (ancestors.length && ancestors[ancestors.length - 1].level >= heading.level) {
            ancestors.pop();
        }
        const parent = ancestors[ancestors.length - 1];
        let target = list;
        if (parent) {
            if (!parent.list) {
                parent.list = document.createElement('ul');
                parent.item.appendChild(parent.list);
            }
            target = parent.list;
        }
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.setAttribute('href', `#${heading.id}`);
        link.textContent = heading.text;
        item.appendChild(link);
        target.appendChild(item);
        ancestors.push({ level: heading.level, item });
    }
    return list;
}

export function renderMarkdownTocs(html: string): string {
    if (!html.includes('data-mdw-toc=')) {
        return html;
    }
    const root = createWindow(`<div id="mdw-toc-root">${html}</div>`).document.getElementById('mdw-toc-root');
    const items = headings(root);
    for (const block of Array.from<any>(root.querySelectorAll('div[data-mdw-toc="true"]'))) {
        block.innerHTML = '';
        if (items.length) {
            block.appendChild(generatedList(items, root.ownerDocument));
        } else {
            const empty = root.ownerDocument.createElement('p');
            empty.className = 'mdw-toc-empty';
            empty.textContent = 'No headings yet';
            block.appendChild(empty);
        }
    }
    return root.innerHTML;
}

/** Protect generated Markdown before source reuse can resurrect an obsolete list. */
export function protectMarkdownTocs(html: string, namespace: string): {
    html: string; markers: string[]; restore: (value: string) => string;
} {
    if (!html.includes('data-mdw-toc=')) {
        return { html, markers: [], restore: value => value };
    }
    const root = createWindow(`<div id="mdw-toc-root">${html}</div>`).document.getElementById('mdw-toc-root');
    const items = headings(root);
    const levels: number[] = [];
    const lines = items.map(heading => {
        while (levels.length && levels[levels.length - 1] >= heading.level) {
            levels.pop();
        }
        const text = heading.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/([\\`*_{}\[\]()#+.!|>~-])/g, '\\$1');
        const line = `${'  '.repeat(levels.length)}- [${text}](#${heading.id})`;
        levels.push(heading.level);
        return line;
    });
    const markdown = [markdownTocStart, ...lines, ...(lines.length ? [''] : []), markdownTocEnd].join('\n');
    const markers: string[] = [];
    for (const block of Array.from<any>(root.querySelectorAll('div[data-mdw-toc="true"]'))) {
        const marker = `${namespace}TOC${markers.length}END`;
        markers.push(marker);
        const replacement = root.ownerDocument.createElement('p');
        replacement.textContent = marker;
        block.replaceWith(replacement);
    }
    return {
        html: root.innerHTML,
        markers,
        restore: value => {
            for (const marker of markers) {
                const offset = value.indexOf(marker);
                if (offset < 0) {
                    continue;
                }
                const prefix = value.slice(value.lastIndexOf('\n', offset) + 1, offset);
                // Turndown puts a nested block placeholder after its container
                // prefix. Extend that prefix to every generated line, keeping
                // the first line's list/footnote marker only on the first line.
                const continuation = prefix
                    .replace(/\[\^[^\]\r\n]+\]:[ \t]*/g, '    ')
                    .replace(/(^|[> \t])([*+-]|\d+[.)])([ \t]+)/g,
                        (_match, before: string, bullet: string, spaces: string) =>
                            before + ' '.repeat(bullet.length + spaces.length));
                value = value.slice(0, offset) + markdown.replace(/\n/g, '\n' + continuation) +
                    value.slice(offset + marker.length);
            }
            return value;
        }
    };
}
