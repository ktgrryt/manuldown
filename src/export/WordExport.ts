import type * as vscode from 'vscode';
import { createExportDocument, prepareExportDocument } from './ExportDocument';
import { exportDocumentFile } from './ExportFile';

export async function exportWord(
    sourceUri: vscode.Uri,
    capture: () => Promise<{ source: string }>,
    resolveImage: (source: string) => Promise<string | null>,
): Promise<void> {
    await exportDocumentFile(sourceUri, 'Word', ['docx'], async () => {
        const { source } = await capture();
        const { root } = createExportDocument(source, sourceUri);
        const warnings = new Set(await prepareExportDocument(root, resolveImage));

        for (const formula of Array.from<any>(root.querySelectorAll('[data-mdw-math], pre > code.language-math'))) {
            const block = formula.tagName === 'CODE';
            const element = block ? formula.parentElement : formula;
            element.setAttribute('data-latex', formula.textContent);
            if (block || formula.getAttribute('data-mdw-math') === 'display') {
                element.setAttribute('display', 'block');
            }
        }

        // docx/html matches fragment links against decoded IDs and expects notes after their references.
        for (const ref of Array.from<any>(root.querySelectorAll('[data-mdw-footnote-ref]'))) {
            ref.id = decodeURIComponent(ref.id);
            ref.setAttribute('role', 'doc-noteref');
        }
        for (const note of Array.from<any>(root.querySelectorAll('[data-mdw-footnote-definition]'))) {
            note.id = decodeURIComponent(note.id);
            note.setAttribute('role', 'doc-footnote');
            root.appendChild(note);
        }

        const [docx, { htmlToContent }] = await Promise.all([import('docx'), import('docx/html')]);
        const children = htmlToContent(root.innerHTML, {
            stylesheet: `
                table { width: 100%; }
                th, td { border: 1px solid #d0d7de; padding: 4pt 6pt; }
                th, pre { background-color: #f6f8fa; }
                .mdw-callout-title { font-weight: bold; }
            `,
            onWarning: warning => warnings.add(warning.message),
        });
        const document = new docx.Document({ creator: 'ManulDown', sections: [{ children }] });
        return { bytes: await docx.Packer.toBuffer(document), warnings: [...warnings] };
    });
}
