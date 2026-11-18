import * as vscode from 'vscode';
import { getNonce } from '../utils/getNonce';

export async function exportDocumentFile(
    sourceUri: vscode.Uri,
    format: string,
    extensions: string[],
    build: () => Promise<{ bytes: Buffer; warnings: string[] }>,
): Promise<void> {
    const target = await vscode.window.showSaveDialog({
        defaultUri: sourceUri.with({ path: sourceUri.path.replace(/\.md$/i, '') + '.' + extensions[0] }),
        filters: { [format]: extensions }, saveLabel: `Export ${format}`,
    });
    if (!target) { return; }
    if (!extensions.some(ext => target.path.toLowerCase().endsWith('.' + ext))) {
        throw new Error(`Choose a filename ending in ${extensions.map(ext => '.' + ext).join(' or ')}.`);
    }

    const { bytes, warnings } = await build();
    const temporary = target.with({ path: `${target.path}.${getNonce()}.tmp` });
    try {
        await vscode.workspace.fs.writeFile(temporary, bytes);
        await vscode.workspace.fs.rename(temporary, target, { overwrite: true });
    } finally {
        await vscode.workspace.fs.delete(temporary).then(undefined, () => {});
    }
    if (warnings.length) {
        void vscode.window.showWarningMessage(`${format} exported. ${warnings.join(' ')}`);
    } else {
        void vscode.window.showInformationMessage(`${format} exported.`);
    }
}
