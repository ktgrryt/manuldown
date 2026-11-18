import * as vscode from 'vscode';
import * as path from 'path';
import { buildPdfContent } from './PdfHtmlBuilder';
import { buildHtmlPage } from './BrowserPdfRenderer';
import { getNonce } from '../utils/getNonce';

export async function exportHtml(
    extensionUri: vscode.Uri,
    sourceUri: vscode.Uri,
    capture: () => Promise<{ source: string }>,
    resolveImage: (source: string) => Promise<string | null>,
): Promise<void> {
    const target = await vscode.window.showSaveDialog({
        defaultUri: sourceUri.with({ path: sourceUri.path.replace(/\.md$/i, '') + '.html' }),
        filters: { html: ['html', 'htm'] }, saveLabel: 'Export HTML',
    });
    if (!target) { return; }
    if (!/\.html?$/i.test(target.path)) { throw new Error('Choose a filename ending in .html or .htm.'); }
    const { source } = await capture();
    const content = await buildPdfContent(source, sourceUri, resolveImage);
    const html = await buildHtmlPage(vscode.Uri.joinPath(extensionUri, 'media').fsPath, content.html,
        path.posix.basename(sourceUri.path, path.posix.extname(sourceUri.path)));
    const temporary = target.with({ path: `${target.path}.${getNonce()}.tmp` });
    try {
        await vscode.workspace.fs.writeFile(temporary, Buffer.from(html, 'utf8'));
        await vscode.workspace.fs.rename(temporary, target, { overwrite: true });
    } finally {
        await vscode.workspace.fs.delete(temporary).then(undefined, () => {});
    }
    if (content.warnings.length) {
        void vscode.window.showWarningMessage(`HTML exported. ${content.warnings.join(' ')}`);
    } else {
        void vscode.window.showInformationMessage('HTML exported.');
    }
}
