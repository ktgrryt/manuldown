import * as path from 'path';
import * as vscode from 'vscode';
import {
    buildWorkspaceRelativeHref,
    canCreateRelativeWorkspaceLink,
    extractMarkdownHeadings,
    isUriLexicallyWithinDirectory,
    isUriSecurelyWithinDirectory,
    normalizeExternalLinkHref,
    sanitizeWorkspaceLinkDisplayText,
} from '../utils/workspaceLinks';

export type WorkspaceLinkSelection = {
    kind: 'external' | 'workspace';
    href: string;
    label: string;
};

type LinkTargetItem = vscode.QuickPickItem & {
    targetKind: 'external' | 'workspace';
};

type WorkspaceFileItem = vscode.QuickPickItem & {
    uri: vscode.Uri;
};

type WorkspaceHeadingItem = vscode.QuickPickItem & {
    fragment: string;
    resultLabel: string;
};

export class WorkspaceLinkPicker {
    private static readonly maxWorkspaceFiles = 2000;
    private static readonly maxMarkdownBytes = 1024 * 1024;
    private static readonly maxMarkdownHeadings = 200;
    private static readonly excludedWorkspaceFiles =
        '**/{.git,.hg,.svn,node_modules,.vscode-test}/**';

    public async pick(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<WorkspaceLinkSelection | null> {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (token.isCancellationRequested) {
            return null;
        }

        const targetItems: LinkTargetItem[] = [
            {
                label: '$(globe) URL',
                description: 'Enter an HTTP, HTTPS, or email link',
                targetKind: 'external',
            },
        ];
        if (workspaceFolder) {
            targetItems.push({
                label: '$(files) Workspace file or heading',
                description: 'Create a safe relative link',
                targetKind: 'workspace',
            });
        }

        const selectedTarget = await vscode.window.showQuickPick(targetItems, {
            title: 'Insert Link',
            placeHolder: 'Choose a link target',
            ignoreFocusOut: false,
        }, token);
        if (!selectedTarget || token.isCancellationRequested) {
            return null;
        }

        if (selectedTarget.targetKind === 'external') {
            return this.pickExternalLink(token);
        }
        if (!workspaceFolder) {
            return null;
        }
        return this.pickWorkspaceLink(document, workspaceFolder, token);
    }

    private async pickExternalLink(
        token: vscode.CancellationToken
    ): Promise<WorkspaceLinkSelection | null> {
        const rawHref = await vscode.window.showInputBox({
            title: 'Insert Link',
            prompt: 'Enter an HTTP, HTTPS, or email link',
            placeHolder: 'https://example.com',
            ignoreFocusOut: false,
            validateInput: (value) => {
                if (!String(value || '').trim()) {
                    return 'Enter a URL.';
                }
                return normalizeExternalLinkHref(value)
                    ? null
                    : 'Use an HTTP, HTTPS, or mailto URL without credentials or spaces.';
            },
        }, token);
        if (rawHref === undefined || token.isCancellationRequested) {
            return null;
        }

        // Validate again after the native input returns. Tests, extensions, and
        // future UI changes must not be able to bypass validateInput.
        const href = normalizeExternalLinkHref(rawHref);
        if (!href) {
            return null;
        }
        return {
            kind: 'external',
            href,
            label: sanitizeWorkspaceLinkDisplayText(href, 240) || 'link',
        };
    }

    private async pickWorkspaceLink(
        document: vscode.TextDocument,
        workspaceFolder: vscode.WorkspaceFolder,
        token: vscode.CancellationToken
    ): Promise<WorkspaceLinkSelection | null> {
        if (token.isCancellationRequested) {
            return null;
        }

        const fileUris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceFolder, '**/*'),
            WorkspaceLinkPicker.excludedWorkspaceFiles,
            WorkspaceLinkPicker.maxWorkspaceFiles,
            token
        );
        if (token.isCancellationRequested) {
            return null;
        }

        const fileItems = fileUris
            .filter((uri) =>
                isUriLexicallyWithinDirectory(uri, workspaceFolder.uri) &&
                canCreateRelativeWorkspaceLink(document.uri, uri)
            )
            .map((uri): WorkspaceFileItem => {
                const relativePath = path.posix.relative(workspaceFolder.uri.path, uri.path);
                const fileName = sanitizeWorkspaceLinkDisplayText(
                    path.posix.basename(uri.path),
                    160
                ) || 'file';
                const displayPath = sanitizeWorkspaceLinkDisplayText(relativePath, 320);
                return {
                    label: `$(file) ${fileName}`,
                    description: displayPath,
                    uri,
                };
            })
            .sort((first, second) =>
                String(first.description || '').localeCompare(
                    String(second.description || ''),
                    undefined,
                    { numeric: true, sensitivity: 'base' }
                )
            );

        if (fileItems.length === 0) {
            void vscode.window.showInformationMessage(
                'No linkable files were found in this workspace folder.'
            );
            return null;
        }

        const selectedFile = await vscode.window.showQuickPick(fileItems, {
            title: 'Insert Link',
            placeHolder: 'Select a file in the current workspace folder',
            matchOnDescription: true,
            ignoreFocusOut: false,
        }, token);
        if (!selectedFile || token.isCancellationRequested) {
            return null;
        }

        if (!await this.isSafeWorkspaceFile(selectedFile.uri, workspaceFolder)) {
            void vscode.window.showErrorMessage(
                'The selected file is no longer a safe workspace link target.'
            );
            return null;
        }

        const targetName = sanitizeWorkspaceLinkDisplayText(
            path.posix.parse(selectedFile.uri.path).name,
            240
        ) || 'link';
        let fragment = '';
        let resultLabel = targetName;

        if (this.isMarkdownFile(selectedFile.uri)) {
            const headings = await this.readMarkdownHeadings(
                selectedFile.uri,
                workspaceFolder,
                token
            );
            if (token.isCancellationRequested) {
                return null;
            }
            if (headings.length > 0) {
                const headingItems: WorkspaceHeadingItem[] = [
                    {
                        label: '$(file) Link to file',
                        description: sanitizeWorkspaceLinkDisplayText(
                            path.posix.basename(selectedFile.uri.path),
                            160
                        ),
                        fragment: '',
                        resultLabel: targetName,
                    },
                    ...headings.map((heading): WorkspaceHeadingItem => ({
                        label: `$(symbol-key) ${sanitizeWorkspaceLinkDisplayText(heading.label, 200)}`,
                        description: `H${heading.level}`,
                        fragment: heading.slug,
                        resultLabel: sanitizeWorkspaceLinkDisplayText(heading.label, 240) || targetName,
                    })),
                ];
                const selectedHeading = await vscode.window.showQuickPick(headingItems, {
                    title: 'Insert Link',
                    placeHolder: 'Link to the file or to one of its headings',
                    matchOnDescription: true,
                    ignoreFocusOut: false,
                }, token);
                if (!selectedHeading || token.isCancellationRequested) {
                    return null;
                }
                fragment = selectedHeading.fragment;
                resultLabel = selectedHeading.resultLabel;
            }
        }

        // The file may have been replaced by a symlink while the second picker
        // was open. Revalidate immediately before returning its href.
        if (!await this.isSafeWorkspaceFile(selectedFile.uri, workspaceFolder)) {
            void vscode.window.showErrorMessage(
                'The selected file is no longer a safe workspace link target.'
            );
            return null;
        }

        const href = buildWorkspaceRelativeHref(document.uri, selectedFile.uri, fragment);
        if (!href) {
            return null;
        }
        return {
            kind: 'workspace',
            href,
            label: resultLabel,
        };
    }

    private isMarkdownFile(uri: vscode.Uri): boolean {
        const extension = path.posix.extname(uri.path).toLowerCase();
        return extension === '.md' || extension === '.markdown';
    }

    private async isSafeWorkspaceFile(
        uri: vscode.Uri,
        workspaceFolder: vscode.WorkspaceFolder
    ): Promise<boolean> {
        if (!isUriLexicallyWithinDirectory(uri, workspaceFolder.uri)) {
            return false;
        }
        if (!await isUriSecurelyWithinDirectory(uri, workspaceFolder.uri)) {
            return false;
        }
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            return (
                (stat.type & vscode.FileType.File) !== 0 &&
                (stat.type & vscode.FileType.SymbolicLink) === 0
            );
        } catch {
            return false;
        }
    }

    private async readMarkdownHeadings(
        uri: vscode.Uri,
        workspaceFolder: vscode.WorkspaceFolder,
        token: vscode.CancellationToken
    ) {
        try {
            if (!await this.isSafeWorkspaceFile(uri, workspaceFolder)) {
                return [];
            }
            const stat = await vscode.workspace.fs.stat(uri);
            if (
                token.isCancellationRequested ||
                (stat.type & vscode.FileType.File) === 0 ||
                (stat.type & vscode.FileType.SymbolicLink) !== 0 ||
                !Number.isSafeInteger(stat.size) ||
                stat.size < 0 ||
                stat.size > WorkspaceLinkPicker.maxMarkdownBytes
            ) {
                return [];
            }
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (
                token.isCancellationRequested ||
                bytes.byteLength > WorkspaceLinkPicker.maxMarkdownBytes
            ) {
                return [];
            }
            // Do not display data read from a target that crossed the workspace
            // boundary or became a symbolic link while it was being read.
            if (!await this.isSafeWorkspaceFile(uri, workspaceFolder)) {
                return [];
            }
            return extractMarkdownHeadings(
                Buffer.from(bytes).toString('utf8'),
                WorkspaceLinkPicker.maxMarkdownHeadings
            );
        } catch {
            return [];
        }
    }
}
