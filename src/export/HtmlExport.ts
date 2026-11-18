import * as vscode from 'vscode';
import * as path from 'path';
import { buildPdfContent } from './PdfHtmlBuilder';
import { buildHtmlPage } from './BrowserPdfRenderer';
import { exportDocumentFile } from './ExportFile';

export async function exportHtml(
    extensionUri: vscode.Uri,
    sourceUri: vscode.Uri,
    capture: () => Promise<{ source: string }>,
    resolveImage: (source: string) => Promise<string | null>,
): Promise<void> {
    await exportDocumentFile(sourceUri, 'HTML', ['html', 'htm'], async () => {
        const { source } = await capture();
        const content = await buildPdfContent(source, sourceUri, resolveImage);
        const html = await buildHtmlPage(vscode.Uri.joinPath(extensionUri, 'media').fsPath, content.html,
            path.posix.basename(sourceUri.path, path.posix.extname(sourceUri.path)));
        return { bytes: Buffer.from(html, 'utf8'), warnings: content.warnings };
    });
}
