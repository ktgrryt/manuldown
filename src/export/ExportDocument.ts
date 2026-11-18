import type * as vscode from 'vscode';
import { MarkdownDocument } from '../editor/MarkdownDocument';
import { imageRenderMaxWidthPx, parseImageAltSizeSpec } from '../editor/ImageSize';
import { normalizeExternalLinkHref } from '../utils/workspaceLinks';

const { createWindow } = require('@mixmark-io/domino');

export function createExportDocument(source: string, uri: vscode.Uri) {
    const document = { getText: () => source, uri } as vscode.TextDocument;
    const markdown = new MarkdownDocument(document);
    const root = createWindow(`<main>${markdown.toHtml()}</main>`).document.querySelector('main');
    return { root, markdown };
}

export async function prepareExportDocument(
    root: any,
    resolveImage: (source: string) => Promise<string | null>,
): Promise<string[]> {
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
        const { altText, width, height } = parseImageAltSizeSpec(image.getAttribute('alt') || '');
        image.setAttribute('alt', altText);
        // With a width, the editor derives height from the image's intrinsic aspect ratio.
        if (width) {
            image.setAttribute('width', String(Math.min(width, imageRenderMaxWidthPx)));
        } else if (height) {
            image.setAttribute('height', String(height));
        }
        const path = image.getAttribute('src') || '';
        if (!resources.has(path)) { resources.set(path, resolveImage(path)); }
        let resolved: string | null = null;
        try { resolved = await resources.get(path)!; } catch { /* Report a bounded placeholder below. */ }
        if (resolved && /^data:image\/[a-z0-9.+-]+[;,]/i.test(resolved) && resolved.length <= 30 * 1024 * 1024) {
            image.setAttribute('src', resolved);
        } else {
            const label = altText || path || 'Image';
            const placeholder = root.ownerDocument.createElement('span');
            placeholder.className = 'export-missing-image';
            placeholder.textContent = `[Image unavailable: ${label}]`;
            image.replaceWith(placeholder);
            warnings.push(`Image unavailable or blocked: ${label.slice(0, 160)}`);
        }
    }
    return [...new Set(warnings)];
}
