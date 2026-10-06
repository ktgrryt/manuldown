import { getNonce } from '../utils/getNonce';
import { marked } from 'marked';

const { createWindow } = require('@mixmark-io/domino');

export type MarkdownSourceBlock = { source: string; start: number; end: number; html: string; inline?: boolean };

// Compare document content, excluding reconstructed Webview controls and styles.
// No source supplied by the Webview is trusted: all reused text comes from the
// current TextDocument and must render to the same content as the submitted DOM.
function fingerprint(node: any): string {
    if (!node) {
        return '';
    }
    if (node.nodeType === 3) {
        if (/^[\r\n\t ]*$/.test(node.nodeValue) &&
            /^(DIV|UL|OL|BLOCKQUOTE|TABLE|THEAD|TBODY|TR|PRE)$/.test(node.parentNode?.nodeName)) {
            return '';
        }
        if (node.parentNode?.nodeName === 'LI' && /^[^\S\uFEFF]*$/.test(node.nodeValue) &&
            !(node.previousSibling?.nodeType === 1 && node.nextSibling?.nodeType === 1)) {
            return '';
        }
        return JSON.stringify(node.nodeValue);
    }
    if (node.nodeType !== 1) {
        return '';
    }
    const tag = node.nodeName;
    if (node.hasAttribute('data-mdw-footnote-backref') && node.closest('[data-mdw-footnote-definition]')) {
        return '';
    }
    // A formula holds its TeX as text. It must not compare equal to that text.
    if (tag === 'SPAN' && node.hasAttribute('data-mdw-math')) {
        return `MATH(${node.getAttribute('data-mdw-math')})${JSON.stringify(node.textContent)}`;
    }
    if (tag === 'SPAN' || node.classList.contains('table-wrapper')) {
        return Array.from(node.childNodes, fingerprint).join('');
    }
    if (node.hasAttribute('data-mdw-footnote-ref')) {
        return `footnote:${node.getAttribute('data-mdw-footnote-ref')}`;
    }
    const attributes = ['href', 'src', 'alt', 'title', 'start', 'type', 'checked',
        'data-mdw-soft-break', 'data-mdw-break-prefix', 'data-mdw-image-hardbreak',
        'data-mdw-image-hardbreak-prefix', 'data-mdw-opaque-source', 'data-mdw-footnote-definition',
        'data-mdw-math-delimiter'];
    const values = attributes.map(name => {
        let value = node.getAttribute(name);
        if (name === 'src') {
            value = node.getAttribute('data-md-path') || value;
        }
        return value === null ? '' : `${name}=${JSON.stringify(value)}`;
    }).join(';') + (/^(TH|TD)$/.test(tag) ? `;align=${node.style.textAlign || node.getAttribute('align') || ''}` : '');
    if (tag === 'CODE') {
        const language = (node.getAttribute('class') || '').match(/(?:^|\s)language-(\S+)/)?.[1] || '';
        const decode = (name: string): string => {
            const value = node.getAttribute(name);
            return value && /^(?:[0-9a-f]{2})+$/i.test(value) ? Buffer.from(value, 'hex').toString('utf8') : '';
        };
        const text = decode('data-mdw-code-whitespace') || decode('data-mdw-whitespace-code') ||
            decode('data-mdw-code-leading') + node.textContent + decode('data-mdw-code-trailing');
        return `${tag}(${values};${language};${node.getAttribute('data-mdw-code-info') || ''})${JSON.stringify(text)}`;
    }
    return `${tag}(${values})[${Array.from(node.childNodes, fingerprint).join('')}]`;
}

function root(html: string): any {
    return createWindow(`<div id="mdw-source-root">${html}</div>`).document.getElementById('mdw-source-root');
}

function inlineNeighbor(node: any, backwards: boolean): string {
    const siblingKey = backwards ? 'previousSibling' : 'nextSibling';
    while (node) {
        const sibling = node[siblingKey];
        if (sibling) {
            if (sibling.nodeName === 'BR') {
                return '';
            }
            const text = sibling.textContent || '';
            if (text !== '') {
                const characters = Array.from<string>(text);
                return characters[backwards ? characters.length - 1 : 0];
            }
            node = sibling;
        } else {
            node = node.parentNode;
            if (!node || /^(P|DIV|LI|H[1-6]|TD|TH|BLOCKQUOTE)$/.test(node.nodeName)) {
                return '';
            }
        }
    }
    return '';
}

function canReuseInlineSource(node: any, block: MarkdownSourceBlock): boolean {
    // Marked has already unescaped table pipes in inline token.raw. Let the
    // table serializer escape them, including content copied from prose.
    if (node.closest('td,th') && /[|\r\n]/.test(block.source)) {
        return false;
    }
    if (!/^(EM|STRONG|DEL|S)$/.test(node.nodeName)) {
        return true;
    }
    // A delimiter valid in the old paragraph may cease to be emphasis after
    // neighboring text changes (e.g. "a _word_" -> "a_word_").
    const before = inlineNeighbor(node, true);
    const after = inlineNeighbor(node, false);
    const escape = (value: string): string => value.replace(/([\\`*_{}\[\]()#+.!|>~-])/g, '\\$1');
    const expected = root(block.html);
    if (before) {
        expected.insertBefore(expected.ownerDocument.createTextNode(before), expected.firstChild);
    }
    if (after) {
        expected.appendChild(expected.ownerDocument.createTextNode(after));
    }
    const rendered = root(marked.Parser.parseInline(marked.Lexer.lexInline(
        escape(before) + block.source + escape(after)
    )));
    return fingerprint(rendered) === fingerprint(expected);
}

export function preserveMarkdownSource(html: string, source: string, originalHtml: string,
    blocks: () => MarkdownSourceBlock[]): { html: string; restore: (markdown: string) => string } {
    const submitted = root(html);
    const baseline = root(originalHtml);
    if (fingerprint(submitted) === fingerprint(baseline)) {
        return { html: '', restore: () => source };
    }
    const leadingBlankRetained = baseline.firstElementChild?.getAttribute('data-mdw-blankline') !== 'true' ||
        fingerprint(baseline.firstElementChild) === fingerprint(submitted.firstElementChild);
    const trailingBlankRetained = baseline.lastElementChild?.getAttribute('data-mdw-blankline') !== 'true' ||
        fingerprint(baseline.lastElementChild) === fingerprint(submitted.lastElementChild);
    // The footnote UI orders rows by reference number. Keep existing definition
    // slots in source order when another part of the document is edited.
    const definitions = Array.from<any>(submitted.querySelectorAll('[data-mdw-footnote-definition]'));
    const parents = new Set(definitions.map(node => node.parentNode));
    for (const parent of parents) {
        const siblings = definitions.filter(node => node.parentNode === parent);
        const offset = (node: any): number => {
            const encoded = node.getAttribute('data-mdw-footnote-source') || '';
            const raw = Buffer.from(encoded, 'base64').toString('utf8').replace(/\r\n?/g, '\n');
            const index = raw ? source.indexOf(raw) : -1;
            return index < 0 ? Infinity : index;
        };
        const ordered = siblings.slice().sort((a, b) => offset(a) - offset(b));
        const slots = siblings.map(node => {
            const slot = submitted.ownerDocument.createTextNode('');
            parent.replaceChild(slot, node);
            return slot;
        });
        slots.forEach((slot, index) => parent.replaceChild(ordered[index], slot));
    }
    const namespace = `MDWSOURCE${getNonce()}`;
    const entries: Array<MarkdownSourceBlock & { marker: string }> = [];
    const children = Array.from<any>(submitted.children);
    const signatures = children.map(fingerprint);
    const positions = new Map<string, number[]>();
    signatures.forEach((value, index) => {
        const indices = positions.get(value) || [];
        indices.push(index);
        positions.set(value, indices);
    });
    const used = new Set<number>();
    const sourceBlocks = blocks();
    for (const block of sourceBlocks.filter(block => !block.inline)) {
        const rendered = Array.from<any>(root(block.html).children).map(fingerprint);
        if (rendered.length === 0) {
            continue;
        }
        for (const i of positions.get(rendered[0]) || []) {
            if (i + rendered.length > children.length) {
                continue;
            }
            if (rendered.some((value, offset) => used.has(i + offset) || value !== signatures[i + offset])) {
                continue;
            }
            const marker = `${namespace}${entries.length}END`;
            const placeholder = submitted.ownerDocument.createElement('p');
            placeholder.textContent = marker;
            children[i].parentNode.replaceChild(placeholder, children[i]);
            for (let offset = 0; offset < rendered.length; offset++) {
                used.add(i + offset);
                if (offset > 0) {
                    children[i + offset].remove();
                }
            }
            entries.push({ ...block, marker });
            break;
        }
    }
    const inlineEntries: Array<{ source: string; marker: string }> = [];
    const inlineNodes = new Map<string, any[]>();
    for (const node of Array.from<any>(submitted.querySelectorAll('em,strong,code,a,img,del,s,sup,span[data-mdw-math]'))) {
        if (!node.closest('[data-mdw-footnote-definition]')) {
            const signature = fingerprint(node);
            const candidates = inlineNodes.get(signature) || [];
            candidates.push(node);
            inlineNodes.set(signature, candidates);
        }
    }
    for (const block of sourceBlocks.filter(block => block.inline)) {
        const original = root(block.html);
        const expected = Array.from<any>(original.childNodes).map(fingerprint).join('');
        const candidate = inlineNodes.get(expected)?.find(node =>
            submitted.contains(node) && canReuseInlineSource(node, block));
        if (candidate) {
            const marker = `${namespace}INLINE${inlineEntries.length}END`;
            candidate.replaceWith(submitted.ownerDocument.createTextNode(marker));
            inlineEntries.push({ source: block.source, marker });
        }
    }
    return {
        html: submitted.innerHTML,
        restore(markdown) {
            const pattern = new RegExp(`${namespace}(\\d+)END`, 'g');
            let output = '';
            let cursor = 0;
            let previous: MarkdownSourceBlock | undefined;
            const appendGenerated = (text: string): void => {
                if (/^\n*$/.test(text)) {
                    return;
                }
                if (output !== '' && !output.endsWith('\n\n')) {
                    output += output.endsWith('\n') ? '\n' : '\n\n';
                }
                output += text.replace(/^\n+/, '');
                previous = undefined;
            };
            for (const match of markdown.matchAll(pattern)) {
                appendGenerated(markdown.slice(cursor, match.index));
                const entry = entries[Number(match[1])];
                if (output !== '' && previous?.end !== entry.start && !output.endsWith('\n\n')) {
                    output += output.endsWith('\n') ? '\n' : '\n\n';
                }
                output += entry.source;
                previous = entry;
                cursor = match.index! + match[0].length;
            }
            appendGenerated(markdown.slice(cursor));
            let restored = entries.length ? output : markdown;
            for (const entry of inlineEntries) {
                restored = restored.split(entry.marker).join(entry.source);
            }
            if (restored.trim() !== '' && source !== '') {
                const leading = leadingBlankRetained ? source.match(/^(?:[ \t]*\n)+/)?.[0] || '' : '';
                restored = leading + restored.replace(/^(?:[ \t]*\n)+/, '');
                const trailing = trailingBlankRetained ? source.match(/\n(?:[ \t]*\n)*$/)?.[0] || '' : '\n';
                restored = restored.replace(/\n*$/, '') + trailing;
            }
            return restored;
        }
    };
}
