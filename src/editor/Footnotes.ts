const { createWindow } = require('@mixmark-io/domino');

// Deeper definitions stay as preserved, read-only Markdown instead of
// recursively expanding their source into every ancestor's HTML.
export const MAX_EDITABLE_FOOTNOTE_DEPTH = 4;

export function decodeFootnoteLabel(key: string | null): string | null {
    try {
        const label = decodeURIComponent(key ?? '');
        return /^[^\[\]\s\\]+$/.test(label) ? label : null;
    } catch {
        return null;
    }
}

export function parseFootnoteDefinition(source: string): { label: string; content: string } | null {
    const match = source.match(/^ {0,3}\[\^([^\[\]\s\\]+)\]:[ \t]*(.*)(?:\r?\n|$)/);
    if (!match) {
        return null;
    }
    const continuation = source.slice(match[0].length).replace(/^(?: {4}|\t)/gm, '');
    return {
        label: match[1],
        content: `${match[2]}\n${continuation}`.replace(/\n+$/, '')
    };
}

export function serializeFootnoteDefinition(label: string, content: string): string {
    const lines = content.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
    return `[^${label}]: ${lines[0]}\n` + lines.slice(1)
        .map(line => line === '' ? '\n' : `    ${line}\n`).join('');
}

/** Number and order notes by reading order, keeping repeated labels together. */
export function numberFootnotes(html: string): string {
    if (!html.includes('data-mdw-footnote-')) {
        return html;
    }
    const document = createWindow(`<div id="footnotes-root">${html}</div>`).document;
    const root = document.getElementById('footnotes-root')!;
    const numbers = new Map<string, number>();
    const counts = new Map<string, number>();
    const references = Array.from<any>(root.querySelectorAll('[data-mdw-footnote-ref]'));
    const definitions = Array.from<any>(root.querySelectorAll('[data-mdw-footnote-definition]'));
    const defined = new Set(definitions.map(node => node.getAttribute('data-mdw-footnote-definition')));
    // References in notes follow all references in the body.
    const ordered = references.filter(node => !node.closest('[data-mdw-footnote-definition]'))
        .concat(references.filter(node => node.closest('[data-mdw-footnote-definition]')));
    for (const reference of ordered) {
        const key = reference.getAttribute('data-mdw-footnote-ref')!;
        const label = decodeFootnoteLabel(key);
        if (!label) {
            continue;
        }
        if (!numbers.has(key)) {
            numbers.set(key, numbers.size + 1);
        }
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        reference.id = `mdw-fnref-${key}-${count}`;
        const link = reference.querySelector('a');
        if (link) {
            link.textContent = String(numbers.get(key));
            link.setAttribute('title', defined.has(key) ? `Footnote ${label}` : `Missing footnote: ${label}`);
        }
        reference.classList.toggle('mdw-footnote-missing', !defined.has(key));
    }
    for (const definition of definitions) {
        const key = definition.getAttribute('data-mdw-footnote-definition')!;
        const link = definition.querySelector('[data-mdw-footnote-backref]');
        if (link) {
            link.textContent = `${numbers.get(key) ?? `[${decodeFootnoteLabel(key)}]`} ↩`;
        }
    }
    const groups = new Map<any, any[]>();
    for (const definition of definitions) {
        const parent = definition.parentNode;
        if (!groups.has(parent)) {
            groups.set(parent, []);
        }
        groups.get(parent)!.push(definition);
    }
    for (const [parent, siblings] of groups) {
        const sorted = siblings.slice().sort((a, b) =>
            (numbers.get(a.getAttribute('data-mdw-footnote-definition')) ?? Infinity) -
            (numbers.get(b.getAttribute('data-mdw-footnote-definition')) ?? Infinity));
        if (siblings.every((node, index) => node === sorted[index])) {
            continue;
        }
        const slots = siblings.map(node => {
            const slot = document.createComment('footnote-slot');
            parent.replaceChild(slot, node);
            return slot;
        });
        slots.forEach((slot, index) => parent.replaceChild(sorted[index], slot));
    }
    return root.innerHTML;
}
