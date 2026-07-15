import * as path from 'path';
import * as vscode from 'vscode';
import {
    buildWorkspaceRelativeHref,
    canCreateRelativeWorkspaceLink,
    isUriLexicallyWithinDirectory,
    isUriSecurelyWithinDirectory,
    normalizeExternalLinkHref,
    normalizeNativeAbsolutePathForLink,
    sanitizeWorkspaceLinkDisplayText,
} from '../utils/workspaceLinks';

export type WorkspaceLinkSelection = {
    kind: 'external' | 'workspace';
    href: string;
    label: string;
};

export type WorkspaceLinkSuggestion = {
    uri: vscode.Uri;
    path: string;
    label: string;
};

export class WorkspaceLinkPicker {
    private static readonly maxWorkspaceFiles = 2000;
    private static readonly maxWorkspaceSuggestions = 20;
    private static readonly maxSuggestionValidationCandidates = 80;
    private static readonly maxSuggestionQueryLength = 256;
    private static readonly maxSuggestionStatReads = 1024;
    private static readonly maxWorkspacePathInputLength = 4096;
    private static readonly unsafeWorkspacePathInputPattern =
        /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
    private static readonly excludedWorkspaceFiles =
        '**/{.git,.hg,.svn,node_modules,.vscode-test}/**';

    public async resolvePastedAbsolutePath(
        document: vscode.TextDocument,
        pathText: string,
        token?: vscode.CancellationToken
    ): Promise<WorkspaceLinkSelection | null> {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        const normalizedPath = normalizeNativeAbsolutePathForLink(pathText);
        if (
            !workspaceFolder ||
            token?.isCancellationRequested ||
            !normalizedPath ||
            document.uri.scheme !== 'file' ||
            workspaceFolder.uri.scheme !== 'file'
        ) {
            return null;
        }

        const targetUri = vscode.Uri.file(normalizedPath);
        // Reject outside paths lexically before realpath/stat to avoid turning a
        // compromised Webview into an existence oracle for arbitrary files.
        if (
            !isUriLexicallyWithinDirectory(targetUri, workspaceFolder.uri) ||
            !canCreateRelativeWorkspaceLink(document.uri, targetUri) ||
            !await this.isSafeWorkspaceFile(targetUri, workspaceFolder, token)
        ) {
            return null;
        }

        const href = buildWorkspaceRelativeHref(document.uri, targetUri);
        if (
            !href ||
            token?.isCancellationRequested ||
            !await this.isSafeWorkspaceFile(targetUri, workspaceFolder, token)
        ) {
            return null;
        }
        return {
            kind: 'workspace',
            href,
            label: sanitizeWorkspaceLinkDisplayText(path.basename(normalizedPath), 240) || 'link',
        };
    }

    public async resolveLinkInput(
        document: vscode.TextDocument,
        rawInput: string,
        token?: vscode.CancellationToken
    ): Promise<WorkspaceLinkSelection | null> {
        if (token?.isCancellationRequested) {
            return null;
        }
        const externalHref = normalizeExternalLinkHref(rawInput);
        if (externalHref) {
            return {
                kind: 'external',
                href: externalHref,
                label: sanitizeWorkspaceLinkDisplayText(externalHref, 240) || 'link',
            };
        }
        const absolutePathSelection = await this.resolvePastedAbsolutePath(
            document,
            rawInput,
            token
        );
        if (absolutePathSelection) {
            return absolutePathSelection;
        }
        return this.resolveWorkspaceRelativePath(document, rawInput, token);
    }

    public async resolveWorkspaceRelativePath(
        document: vscode.TextDocument,
        pathText: string,
        token?: vscode.CancellationToken
    ): Promise<WorkspaceLinkSelection | null> {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        const rawPath = String(pathText || '');
        if (
            !workspaceFolder ||
            token?.isCancellationRequested ||
            !/^(?:\.\/|\.\.\/)/.test(rawPath) ||
            rawPath !== rawPath.trim() ||
            rawPath.length > WorkspaceLinkPicker.maxWorkspacePathInputLength ||
            rawPath.includes('\\') ||
            WorkspaceLinkPicker.unsafeWorkspacePathInputPattern.test(rawPath)
        ) {
            return null;
        }

        let decodedPath: string;
        try {
            decodedPath = decodeURIComponent(rawPath);
        } catch {
            return null;
        }
        if (
            !decodedPath ||
            decodedPath.length > WorkspaceLinkPicker.maxWorkspacePathInputLength ||
            decodedPath.includes('\\') ||
            path.posix.isAbsolute(decodedPath) ||
            WorkspaceLinkPicker.unsafeWorkspacePathInputPattern.test(decodedPath)
        ) {
            return null;
        }

        const documentDirectory = document.uri.with({
            path: path.posix.dirname(document.uri.path),
            query: '',
            fragment: '',
        });
        const targetUri = vscode.Uri.joinPath(documentDirectory, decodedPath);
        if (
            !isUriLexicallyWithinDirectory(targetUri, workspaceFolder.uri) ||
            !canCreateRelativeWorkspaceLink(document.uri, targetUri) ||
            !await this.isSafeWorkspaceFile(targetUri, workspaceFolder, token)
        ) {
            return null;
        }
        const href = buildWorkspaceRelativeHref(document.uri, targetUri);
        if (
            !href ||
            token?.isCancellationRequested ||
            !await this.isSafeWorkspaceFile(targetUri, workspaceFolder, token)
        ) {
            return null;
        }
        return {
            kind: 'workspace',
            href,
            label: sanitizeWorkspaceLinkDisplayText(
                path.posix.parse(targetUri.path).name,
                240
            ) || 'link',
        };
    }

    public async searchWorkspaceFiles(
        document: vscode.TextDocument,
        rawQuery: string,
        token: vscode.CancellationToken
    ): Promise<WorkspaceLinkSuggestion[]> {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        const query = String(rawQuery || '');
        if (
            !workspaceFolder ||
            token.isCancellationRequested ||
            query !== query.trim() ||
            query.length < 2 ||
            query.length > WorkspaceLinkPicker.maxSuggestionQueryLength ||
            /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(query)
        ) {
            return [];
        }

        const normalizedQuery = this.normalizeSuggestionSearchText(query);
        if (!normalizedQuery) {
            return [];
        }
        const fileUris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceFolder, '**/*'),
            WorkspaceLinkPicker.excludedWorkspaceFiles,
            WorkspaceLinkPicker.maxWorkspaceFiles,
            token
        );
        if (token.isCancellationRequested) {
            return [];
        }

        const ranked = fileUris
            .filter((uri) =>
                isUriLexicallyWithinDirectory(uri, workspaceFolder.uri) &&
                canCreateRelativeWorkspaceLink(document.uri, uri)
            )
            .map((uri) => {
                const relativePath = path.posix.relative(workspaceFolder.uri.path, uri.path);
                const fileName = path.posix.basename(uri.path);
                const score = this.getSuggestionScore(
                    normalizedQuery,
                    this.normalizeSuggestionSearchText(fileName),
                    this.normalizeSuggestionSearchText(path.posix.parse(fileName).name),
                    this.normalizeSuggestionSearchText(relativePath)
                );
                return { uri, relativePath, fileName, score };
            })
            .filter((candidate) => candidate.score !== null)
            .sort((first, second) =>
                (first.score as number) - (second.score as number) ||
                first.relativePath.localeCompare(
                    second.relativePath,
                    undefined,
                    { numeric: true, sensitivity: 'base' }
                )
            )
            .slice(0, WorkspaceLinkPicker.maxSuggestionValidationCandidates);

        const suggestionStatCache = new Map<string, Promise<vscode.FileStat>>();
        let suggestionStatReads = 0;
        const readSuggestionStat = async (uri: vscode.Uri): Promise<vscode.FileStat> => {
            if (token.isCancellationRequested) {
                throw new Error('Workspace link suggestion search was cancelled.');
            }
            const key = uri.toString();
            let pendingStat = suggestionStatCache.get(key);
            if (!pendingStat) {
                if (suggestionStatReads >= WorkspaceLinkPicker.maxSuggestionStatReads) {
                    throw new Error('Workspace link suggestion stat budget was exhausted.');
                }
                suggestionStatReads++;
                pendingStat = Promise.resolve(vscode.workspace.fs.stat(uri));
                suggestionStatCache.set(key, pendingStat);
            }
            const stat = await pendingStat;
            if (token.isCancellationRequested) {
                throw new Error('Workspace link suggestion search was cancelled.');
            }
            return stat;
        };

        const suggestions: WorkspaceLinkSuggestion[] = [];
        for (const candidate of ranked) {
            if (token.isCancellationRequested) {
                return [];
            }
            if (!await this.isSafeWorkspaceFile(
                candidate.uri,
                workspaceFolder,
                token,
                readSuggestionStat
            )) {
                continue;
            }
            const href = buildWorkspaceRelativeHref(document.uri, candidate.uri);
            if (!href) {
                continue;
            }
            suggestions.push({
                uri: candidate.uri,
                path: href,
                label: sanitizeWorkspaceLinkDisplayText(candidate.fileName, 160) || 'file',
            });
            if (suggestions.length >= WorkspaceLinkPicker.maxWorkspaceSuggestions) {
                break;
            }
        }
        return suggestions;
    }

    public async resolveWorkspaceFileSuggestion(
        document: vscode.TextDocument,
        candidateUri: vscode.Uri,
        token: vscode.CancellationToken
    ): Promise<WorkspaceLinkSelection | null> {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (
            !workspaceFolder ||
            token.isCancellationRequested ||
            !isUriLexicallyWithinDirectory(candidateUri, workspaceFolder.uri) ||
            !canCreateRelativeWorkspaceLink(document.uri, candidateUri) ||
            !await this.isSafeWorkspaceFile(candidateUri, workspaceFolder, token)
        ) {
            return null;
        }
        const href = buildWorkspaceRelativeHref(document.uri, candidateUri);
        if (
            !href ||
            token.isCancellationRequested ||
            !await this.isSafeWorkspaceFile(candidateUri, workspaceFolder, token)
        ) {
            return null;
        }
        return {
            kind: 'workspace',
            href,
            label: sanitizeWorkspaceLinkDisplayText(
                path.posix.parse(candidateUri.path).name,
                240
            ) || 'link',
        };
    }

    private normalizeSuggestionSearchText(value: string): string {
        return String(value || '').normalize('NFKC').toLocaleLowerCase();
    }

    private getSuggestionScore(
        query: string,
        fileName: string,
        fileStem: string,
        relativePath: string
    ): number | null {
        if (fileStem === query) {
            return 0;
        }
        if (fileName === query) {
            return 10;
        }
        if (fileStem.startsWith(query)) {
            return 100 + fileStem.length - query.length;
        }
        if (fileName.startsWith(query)) {
            return 200 + fileName.length - query.length;
        }
        const stemIndex = fileStem.indexOf(query);
        if (stemIndex >= 0) {
            return 300 + stemIndex;
        }
        const nameIndex = fileName.indexOf(query);
        if (nameIndex >= 0) {
            return 400 + nameIndex;
        }
        const pathSegments = relativePath.split('/');
        const segmentIndex = pathSegments.findIndex((segment) => segment.startsWith(query));
        if (segmentIndex >= 0) {
            return 500 + segmentIndex;
        }
        const pathIndex = relativePath.indexOf(query);
        if (pathIndex >= 0) {
            return 600 + pathIndex;
        }

        let queryIndex = 0;
        let gapPenalty = 0;
        let previousMatch = -1;
        for (let index = 0; index < relativePath.length && queryIndex < query.length; index++) {
            if (relativePath[index] !== query[queryIndex]) {
                continue;
            }
            if (previousMatch >= 0) {
                gapPenalty += index - previousMatch - 1;
            }
            previousMatch = index;
            queryIndex++;
        }
        return queryIndex === query.length ? 700 + gapPenalty : null;
    }

    private async isSafeWorkspaceFile(
        uri: vscode.Uri,
        workspaceFolder: vscode.WorkspaceFolder,
        token?: vscode.CancellationToken,
        readStat: (uri: vscode.Uri) => PromiseLike<vscode.FileStat> =
            (targetUri) => vscode.workspace.fs.stat(targetUri)
    ): Promise<boolean> {
        if (
            token?.isCancellationRequested ||
            !isUriLexicallyWithinDirectory(uri, workspaceFolder.uri)
        ) {
            return false;
        }
        const readCancellationAwareStat = async (
            targetUri: vscode.Uri
        ): Promise<vscode.FileStat> => {
            if (token?.isCancellationRequested) {
                throw new Error('Workspace link validation was cancelled.');
            }
            const stat = await readStat(targetUri);
            if (token?.isCancellationRequested) {
                throw new Error('Workspace link validation was cancelled.');
            }
            return stat;
        };
        if (!await isUriSecurelyWithinDirectory(
            uri,
            workspaceFolder.uri,
            readCancellationAwareStat
        )) {
            return false;
        }
        try {
            const stat = await readCancellationAwareStat(uri);
            return (
                (stat.type & vscode.FileType.File) !== 0 &&
                (stat.type & vscode.FileType.SymbolicLink) === 0
            );
        } catch {
            return false;
        }
    }

}
