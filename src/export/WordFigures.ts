import type { HtmlImage } from 'docx/html';
import { buildHtmlPage, findPdfBrowser, loadPrintPage, openPdfBrowser } from './BrowserPdfRenderer';
import { escapePdfHtml } from './PdfHtmlBuilder';

export type WordFigure = {
    kind: 'diagram' | 'image' | 'inline-math' | 'display-math';
    source: string;
    element: any;
};

type FigureImage = { png: Buffer; width: number; alt: string };

function figureHtml({ kind, source }: WordFigure): string {
    const text = escapePdfHtml(source);
    if (kind === 'diagram') { return `<pre><code class="language-mermaid">${text}</code></pre>`; }
    if (kind === 'image') { return `<img src="${text}">`; }
    const mode = kind === 'display-math' ? 'display' : 'inline';
    return `<span data-mdw-math="${mode}">${text}</span>`;
}

async function renderFigures(
    figures: WordFigure[], mediaRoot: string, browserPath: string, width: number, height: number,
): Promise<(FigureImage | undefined)[]> {
    const executable = await findPdfBrowser(browserPath);
    const figuresHtml = figures.map(figure => `<div class="word-figure">${figureHtml(figure)}</div>`).join('');
    const html = await buildHtmlPage(mediaRoot, `<style>
        html, body { background: transparent; }
        .word-figure { width: ${width}px; font-size: 11pt; }
        .word-figure img, .word-figure .export-diagram svg { max-height: ${height}px; }
        .word-figure .katex { display: inline-block; }
        .word-figure [data-mdw-math=inline] .katex { font-size: 1em; }
    </style>${figuresHtml}`, '');
    const browser = await openPdfBrowser(executable);
    try {
        const cdp = browser.connection;
        const { sessionId } = await loadPrintPage(cdp, html);
        await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
        // Capture the rendered element, including Mermaid's HTML labels and the actual math fonts.
        // A failed diagram remains a PRE in the export page, and has no picture to capture.
        const bounds = await cdp.send('Runtime.evaluate', {
            expression: `Array.from(document.querySelectorAll('.word-figure'), figure => {
                const node = figure.querySelector('.export-diagram > svg, img, .katex');
                if (!node) return null;
                const box = node.getBoundingClientRect();
                let top = box.top, bottom = box.bottom;
                if (node.closest('[data-mdw-math=inline]')) {
                    // Word aligns the picture's bottom to the text baseline. Trim the
                    // empty line box using KaTeX's own height and depth for each group.
                    const groups = Array.from(node.querySelectorAll('.katex-html > .katex-base > .katex-strut'),
                        strut => strut.getBoundingClientRect());
                    if (groups.length) {
                        top = Math.max(top, Math.floor(Math.min(...groups.map(rect => rect.top))) - 1);
                        bottom = Math.min(bottom, Math.ceil(Math.max(...groups.map(rect => rect.bottom))) + 1);
                    }
                }
                const alt = node.querySelector('title')?.textContent || '';
                return { x: box.x, y: top, width: box.width, height: bottom - top, alt };
            })`, returnByValue: true,
        }, sessionId);
        if (!Array.isArray(bounds.result?.value)) { throw new Error('Could not measure the Word illustrations.'); }
        const images: (FigureImage | undefined)[] = [];
        for (const [index, box] of bounds.result.value.entries()) {
            let image: FigureImage | undefined;
            if (box && box.width > 0 && box.height > 0) {
                const resolution = figures[index].kind === 'image' ? 2 : 3;
                const scale = resolution * Math.min(1, width / box.width, height / box.height);
                try {
                    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
                        clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale } }, sessionId);
                    image = { png: Buffer.from(data, 'base64'), width: box.width, alt: box.alt };
                } catch { /* Preserve this figure's original content and continue with the others. */ }
            }
            images.push(image);
        }
        return images;
    } finally { await browser.dispose(); }
}

export async function embedWordFigures(
    figures: WordFigure[], mediaRoot: string, browserPath: string, width: number, height: number, warnings: Set<string>,
): Promise<Record<string, HtmlImage>> {
    const images: Record<string, HtmlImage> = {};
    if (!figures.length) { return images; }
    const groups = new Map<string, WordFigure[]>();
    for (const figure of figures) {
        const key = figure.kind + ':' + figure.source;
        const group = groups.get(key);
        if (group) { group.push(figure); } else { groups.set(key, [figure]); }
    }
    const unique = [...groups.values()];
    let rendered: (FigureImage | undefined)[] = [];
    try {
        rendered = await renderFigures(unique.map(group => group[0]), mediaRoot, browserPath, width, height);
    } catch {
        warnings.add('Some illustrations could not be rendered. Check the Chrome or Edge installation and the PDF Browser Path setting.');
    }
    for (const [index, group] of unique.entries()) {
        const picture = rendered[index];
        const key = `word-figure-${index}`;
        for (const { kind, source, element } of group) {
            const svg = kind === 'image' && /^data:image\/svg\+xml[;,]/i.test(source);
            if (!picture) {
                if (kind === 'diagram') { warnings.add(`Mermaid source kept: ${source.trim().slice(0, 80)}`); }
                else if (kind !== 'image') {
                    warnings.add(element.querySelector('math') ? 'A formula keeps its editable equation with simplified styling.'
                        : `Formula source kept: ${source.trim().slice(0, 80)}`);
                }
                else if (!svg) {
                    const alt = element.getAttribute('alt') || 'Image';
                    element.replaceWith(element.ownerDocument.createTextNode(`[Image unavailable: ${alt}]`));
                    warnings.add(`Image could not be converted for Word: ${alt.slice(0, 160)}`);
                }
                continue;
            }
            images[key] = svg ? { data: source, fallback: picture.png } : picture.png;
            const image = kind === 'image' ? element : element.ownerDocument.createElement('img');
            image.setAttribute('src', key);
            if (!image.hasAttribute('width') && !image.hasAttribute('height')) {
                image.setAttribute('width', String(Math.max(1, Math.round(picture.width))));
            }
            if (kind !== 'image') {
                image.setAttribute('alt', picture.alt || source.trim());
                if (kind === 'diagram') {
                    const paragraph = element.ownerDocument.createElement('p');
                    paragraph.className = 'export-diagram';
                    paragraph.appendChild(image);
                    element.replaceWith(paragraph);
                } else {
                    element.textContent = '';
                    element.appendChild(image);
                }
            }
        }
    }
    return images;
}
