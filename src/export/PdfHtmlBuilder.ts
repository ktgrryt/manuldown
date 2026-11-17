import type * as vscode from 'vscode';
import { createHash } from 'crypto';
import { MarkdownDocument } from '../editor/MarkdownDocument';
import { normalizeExternalLinkHref } from '../utils/workspaceLinks';
import { ExportBlock, ExportContent } from './PdfExportSession';
const { createWindow } = require('@mixmark-io/domino');

// Match the shared parser's source fragments against its complete rendering.
// IDs, footnote numbers and generated TOC text depend on the whole document;
// those are deliberately excluded from the comparison.
function sourceSignature(node: any): string {
    if (node.nodeType === 3) { return JSON.stringify(node.nodeValue.replace(/\s+/g, ' ')); }
    if (node.nodeType !== 1) { return ''; }
    if (node.hasAttribute('data-mdw-caret-anchor') || node.hasAttribute('data-mdw-image-hardbreak-placeholder')) { return ''; }
    for (const key of ['data-mdw-toc', 'data-mdw-footnote-definition', 'data-mdw-footnote-ref']) {
        if (node.hasAttribute(key)) { return `${key}:${node.getAttribute(key)}`; }
    }
    const attributes = ['src', 'href', 'alt', 'data-mdw-math', 'data-mdw-opaque-kind'];
    return `${node.tagName}(${attributes.map(key => node.getAttribute(key) || '').join('|')})[${Array.from(node.childNodes, sourceSignature).join('')}]`;
}

function associateSource(root: any, markdown: MarkdownDocument, source: string): Map<any, ExportBlock['source']> {
    const crlf = [...source.matchAll(/\r\n/g)].map((match, index) => match.index! - index);
    const originalOffset = (offset: number): number => {
        let low = 0, high = crlf.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (crlf[middle] < offset) { low = middle + 1; } else { high = middle; }
        }
        return offset + low;
    };
    const candidates = new Map<string, Array<{ source: string; start: number; end: number; part: number }>>();
    for (const block of markdown.getSourceBlocks().filter(block => !block.inline)) {
        const fragment = createWindow(`<main>${block.html}</main>`).document.querySelector('main');
        Array.from<any>(fragment.children).forEach((node, part) => {
            const key = sourceSignature(node);
            if (!candidates.has(key)) { candidates.set(key, []); }
            candidates.get(key)!.push({ ...block, part });
        });
    }
    const associations = new Map<any, ExportBlock['source']>();
    for (const node of Array.from<any>(root.children)) {
        const match = candidates.get(sourceSignature(node))?.shift();
        if (!match) { continue; }
        const normalized = match.source.replace(/\r\n?/g, '\n').trim();
        associations.set(node, { start: originalOffset(match.start), end: originalOffset(match.end),
            fingerprint: createHash('sha256').update(`${match.part}\n${normalized}`).digest('hex').slice(0, 32),
            excerpt: normalized.length > 2048 ? normalized.slice(0, 1024) + normalized.slice(-1024) : normalized });
    }
    return associations;
}

export function escapePdfHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export async function buildPdfContent(
    source: string,
    uri: vscode.Uri,
    resolveImage: (source: string) => Promise<string | null>,
): Promise<ExportContent> {
    const document = { getText: () => source, uri } as vscode.TextDocument;
    const markdown = new MarkdownDocument(document);
    const root = createWindow(`<main>${markdown.toHtml()}</main>`).document.querySelector('main');
    const associations = associateSource(root, markdown, source);
    const kinds = new Map(Array.from<any>(root.children).map(node => [node,
        node.querySelector('img') && !node.textContent.trim() ? 'image' : node.tagName.toLowerCase()] as const));
    const warnings: string[] = [];
    // Do not clone live editor DOM: formulas live in shadow roots there, and
    // diagram/code toggles reflect editing state rather than output semantics.
    for (const node of Array.from<any>(root.querySelectorAll('[data-mdw-caret-anchor], [data-mdw-image-hardbreak-placeholder]'))) {
        node.remove();
    }
    const usedIds = new Set<string>();
    for (const [index, heading] of Array.from<any>(root.querySelectorAll('h1,h2,h3,h4,h5,h6')).entries()) {
        // Same slug rules as MarkdownToc and MarkdownHeadingSlug.js.
        const base = String(heading.textContent || '').trim().toLowerCase()
            .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || `heading-${index}`;
        let id = base;
        let suffix = 1;
        while (usedIds.has(id)) { id = `${base}-${suffix++}`; }
        usedIds.add(id);
        heading.id = id;
    }
    for (const link of Array.from<any>(root.querySelectorAll('a[href]'))) {
        const href = link.getAttribute('href') || '';
        if (!href.startsWith('#') && !normalizeExternalLinkHref(href)) { link.removeAttribute('href'); }
    }
    const resources = new Map<string, Promise<string | null>>();
    for (const image of Array.from<any>(root.querySelectorAll('img'))) {
        const path = image.getAttribute('src') || '';
        if (!resources.has(path)) { resources.set(path, resolveImage(path)); }
        let resolved: string | null = null;
        try { resolved = await resources.get(path)!; } catch { /* Report a bounded placeholder below. */ }
        if (resolved && /^data:image\/[a-z0-9.+-]+[;,]/i.test(resolved) && resolved.length <= 30 * 1024 * 1024) {
            image.setAttribute('src', resolved);
        } else {
            const label = image.getAttribute('alt') || path || 'Image';
            const placeholder = root.ownerDocument.createElement('span');
            placeholder.className = 'export-missing-image';
            placeholder.textContent = `[Image unavailable: ${label}]`;
            image.replaceWith(placeholder);
            warnings.push(`Image unavailable or blocked: ${label.slice(0, 160)}`);
        }
    }
    const notes = Array.from<any>(root.querySelectorAll('[data-mdw-footnote-definition]'));
    if (notes.length) {
        const section = root.ownerDocument.createElement('section');
        section.className = 'export-footnotes';
        section.setAttribute('aria-label', 'Footnotes');
        const title = root.ownerDocument.createElement('h2');
        title.textContent = 'Footnotes';
        section.appendChild(title);
        for (const note of notes) { section.appendChild(note); }
        associations.set(section, associations.get(notes[0]));
        root.appendChild(section);
    }
    for (const checkbox of Array.from<any>(root.querySelectorAll('input'))) {
        checkbox.setAttribute('disabled', '');
    }
    const blocks: ExportBlock[] = [];
    const occurrences = new Map<string, number>();
    for (const node of Array.from<any>(root.children)) {
        if (!node.textContent.trim() && !node.querySelector('img,input,hr,svg') && node.tagName !== 'HR') { continue; }
        const sourceBlock = associations.get(node);
        // An unknown/generated fragment remains printable but is not editable.
        // Never guess an editable source position from a visual ordinal.
        if (!sourceBlock) { continue; }
        const occurrence = occurrences.get(sourceBlock.fingerprint) || 0;
        occurrences.set(sourceBlock.fingerprint, occurrence + 1);
        const id = `block-${sourceBlock.fingerprint}-${occurrence}`;
        const wrapper = root.ownerDocument.createElement('div');
        wrapper.className = /^H[1-6]$/.test(node.tagName) ? 'export-block export-heading' : 'export-block';
        wrapper.setAttribute('data-export-block', id);
        node.replaceWith(wrapper);
        wrapper.appendChild(node);
        const image = node.querySelector('img');
        const text = String(node.textContent || image?.getAttribute('alt') || 'Image').replace(/\s+/g, ' ').trim();
        blocks.push({
            id, label: text.slice(0, 140) || node.tagName.toLowerCase(),
            kind: kinds.get(node) || node.tagName.toLowerCase(),
            heading: /^H[1-6]$/.test(node.tagName),
            source: sourceBlock,
        });
    }
    // Attributes used for Markdown round-tripping are unnecessary in the PDF.
    for (const node of Array.from<any>(root.querySelectorAll('*'))) {
        for (const attribute of Array.from<any>(node.attributes)) {
            if (/^on/i.test(attribute.name) || attribute.name === 'contenteditable' ||
                attribute.name === 'tabindex' || /^(?:data-mdw-opaque-source|data-mdw-footnote-source)$/.test(attribute.name)) {
                node.removeAttribute(attribute.name);
            }
        }
    }
    return { html: root.innerHTML, blocks, warnings: [...new Set(warnings)] };
}
