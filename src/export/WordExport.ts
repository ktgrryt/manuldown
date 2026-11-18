import * as vscode from 'vscode';
import { readExportAsset } from './BrowserPdfRenderer';
import { createExportDocument, prepareExportDocument } from './ExportDocument';
import { exportDocumentFile } from './ExportFile';
import { prepareWordContent } from './WordContent';
import { embedWordFigures } from './WordFigures';

export async function exportWord(
    extensionUri: vscode.Uri,
    sourceUri: vscode.Uri,
    capture: () => Promise<{ source: string }>,
    resolveImage: (source: string) => Promise<string | null>,
): Promise<void> {
    await exportDocumentFile(sourceUri, 'Word', ['docx'], async () => {
        const { source } = await capture();
        const { root } = createExportDocument(source, sourceUri);
        const warnings = new Set(await prepareExportDocument(root, resolveImage));
        const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media').fsPath;
        const [docx, { htmlToContent }, stylesheet, figures] = await Promise.all([
            import('docx'), import('docx/html'), readExportAsset(mediaRoot, 'export.css'), prepareWordContent(root, mediaRoot),
        ]);
        const page = docx.sectionPageSizeDefaults;
        const margin = docx.convertMillimetersToTwip(18);
        // 15 twips per CSS pixel. Leave a line of room below a full-page inline drawing.
        const width = Math.floor((page.WIDTH - 2 * margin) / 15);
        const height = Math.floor((page.HEIGHT - 2 * margin) / 15) - 24;
        const images = await embedWordFigures(figures, mediaRoot,
            figures.length ? vscode.workspace.getConfiguration('manulDown').get('pdf.browserPath', '') : '', width, height, warnings);
        for (const image of Array.from<any>(root.querySelectorAll('td img, th img'))) {
            // Markdown tables have equal-width columns. The importer resolves percentage
            // image widths against the page, so give it the actual cell's inner width.
            const cellWidth = width / image.closest('tr').cells.length;
            image.style.setProperty('max-width', `${Math.max(1, Math.floor(cellWidth - 18))}px`);
        }
        const blocks = htmlToContent(root.outerHTML, {
            images, maxImageWidth: width,
            stylesheet: stylesheet + `
                body { line-height: 1.4; }
                h1, h2, h3, h4, h5, h6 { font-size: initial; color: initial; margin: 12pt 0 5pt; }
                p, ul, ol { margin-bottom: 6pt; }
                img { max-height: ${height}px; }
                pre, code { font-family: "Courier New", monospace; }
                pre, .mdw-callout { margin: 6pt 9pt 8pt; padding: 5pt 8pt; }
                pre > code { display: inline; font-size: 10pt; }
                th, td { padding: 4pt 6pt; }
                th:not([align]) { text-align: left; }
                table + p, table + blockquote { margin-top: 6pt; }
                li:has(> input[type=checkbox]:first-child) { list-style-type: none; }
                .export-diagram { padding: 0; margin: 6pt 0; }
                .mdw-footnote-definition { font-size: 9pt; line-height: 1.25; }
                .word-display-equation { display: block; text-align: center; margin: 5pt 0 8pt; }
                p[data-mdw-blankline] { margin: 0; }
            `,
            // eslint-disable-next-line @typescript-eslint/naming-convention -- docx/html requires CSS selectors as keys.
            styleMap: { '.word-display-equation': 'DisplayEquation', '.mdw-callout-title': 'CalloutTitle' },
            onWarning: warning => warnings.add(warning.message),
        });
        const children = blocks.map(block => {
            if (!(block instanceof docx.Paragraph) || block.options.style !== 'DisplayEquation') { return block; }
            // An isolated oMath is still inline math in Word. oMathPara enables display-size
            // operators, limits and stacked fractions while retaining editable math runs.
            const content = block.options.children;
            if (content?.length !== 1 || !(content[0] instanceof docx.Math)) { return block; }
            const paragraph = block.with({ children: [] });
            paragraph.addChildElement(new docx.BuilderElement({ name: 'm:oMathPara', children: [content[0]] }));
            return paragraph;
        });
        const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(source);
        const document = new docx.Document({
            creator: 'ManulDown',
            styles: {
                default: { document: {
                    run: { font: { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: japanese ? 'Yu Gothic' : undefined },
                        size: 22, language: japanese ? { eastAsia: 'ja-JP' } : undefined },
                } },
                paragraphStyles: [
                    ...[44, 33, 28, 24, 22, 20].map((size, level) => ({
                        id: `Heading${level + 1}`, name: `Heading ${level + 1}`, basedOn: 'Normal', next: 'Normal', quickFormat: true,
                        run: { bold: true, size, color: '24292F' },
                        paragraph: { keepNext: true, keepLines: true, outlineLevel: level },
                    })),
                    { id: 'DisplayEquation', name: 'Display Equation', basedOn: 'Normal',
                        paragraph: { alignment: docx.AlignmentType.CENTER, keepLines: true } },
                    { id: 'CalloutTitle', name: 'Callout Title', basedOn: 'Normal', run: { bold: true }, paragraph: { keepNext: true } },
                ],
            },
            sections: [{ properties: { page: { margin: { top: margin, bottom: margin, left: margin, right: margin } } }, children }],
        });
        return { bytes: await docx.Packer.toBuffer(document), warnings: [...warnings] };
    });
}
