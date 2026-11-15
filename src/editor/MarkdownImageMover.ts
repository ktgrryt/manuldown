import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { collectMarkdownFilePaths, collectMarkdownImagePaths } from '../utils/markdownImagePaths';
import { encodeMarkdownRelativePath, isUriLexicallyWithinDirectory } from '../utils/workspaceLinks';

type FileMove = { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri };
type DocumentMove = {
    document: vscode.TextDocument;
    version: number;
    newUri: vscode.Uri;
    images: Map<string, vscode.Uri>;
};
type ImageDirectory = { uri: vscode.Uri; boundary: vscode.Uri };

const maxSharedDocuments = 2000;
const maxSharedDocumentBytes = 2 * 1024 * 1024;
const maxSharedScanBytes = 32 * 1024 * 1024;

function key(uri: vscode.Uri): string {
    const value = uri.with({ query: '', fragment: '' }).toString();
    return uri.scheme === 'file' && process.platform === 'win32' ? value.toLowerCase() : value;
}

function imageDirectory(documentUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(documentUri.with({ path: path.posix.dirname(documentUri.path) }),
        'images', path.posix.parse(documentUri.path).name);
}

function resolvePath(documentUri: vscode.Uri, href: string): { uri: vscode.Uri; suffix: string } | undefined {
    if (!href || /^(?:[a-z][a-z0-9+.-]*:|[\\/]|#|\?)/i.test(href)) {
        return undefined;
    }
    const suffixAt = href.search(/[?#]/);
    const pathname = suffixAt < 0 ? href : href.slice(0, suffixAt);
    try {
        const decoded = decodeURIComponent(pathname);
        if (!decoded || /[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith('/')) {
            return undefined;
        }
        return {
            uri: vscode.Uri.joinPath(documentUri.with({ path: path.posix.dirname(documentUri.path),
                query: '', fragment: '' }), decoded),
            suffix: suffixAt < 0 ? '' : href.slice(suffixAt),
        };
    } catch {
        return undefined;
    }
}

function relativeImagePath(documentUri: vscode.Uri, imageUri: vscode.Uri, original: string): string {
    const relative = path.posix.relative(path.posix.dirname(documentUri.path), imageUri.path);
    const encoded = encodeMarkdownRelativePath(relative);
    return original.startsWith('./') ? encoded : encoded.replace(/^\.\//, '');
}

// Sharing checks compare known image URIs only; absolute references never grant
// access to another file or cause a read outside the workspace.
function resolveReaderPaths(documentUri: vscode.Uri, href: string): vscode.Uri[] {
    const relative = resolvePath(documentUri, href);
    if (relative) {
        return [relative.uri];
    }
    try {
        if (/^file:/i.test(href)) {
            return [vscode.Uri.parse(href).with({ query: '', fragment: '' })];
        }
        const pathname = decodeURIComponent(href.split(/[?#]/, 1)[0]);
        if (pathname.startsWith('/') && !pathname.startsWith('//')) {
            const root = vscode.workspace.getWorkspaceFolder(documentUri)?.uri;
            return [documentUri.with({ path: pathname, query: '', fragment: '' }),
                ...(root ? [vscode.Uri.joinPath(root, pathname.slice(1))] : [])];
        }
        if (documentUri.scheme === 'file' && path.win32.isAbsolute(pathname) && /^[a-z]:[\\/]/i.test(pathname)) {
            return [vscode.Uri.file(pathname)];
        }
    } catch {
        // Malformed URLs are not references to any of the known image files.
    }
    return [];
}

/** Plan file and text edits only. The rename participant applies them with the
 * original Explorer operation, giving image moves and copies the same Undo. */
export class MarkdownImageMover {
    private readonly cleanupDirectories = new Map<string, ImageDirectory>();
    private cleanupQueue: Promise<void> = Promise.resolve();

    public async createEdit(files: readonly FileMove[], token: vscode.CancellationToken): Promise<vscode.WorkspaceEdit> {
        const empty = new vscode.WorkspaceEdit();
        if (token.isCancellationRequested || !vscode.workspace.isTrusted) {
            return empty;
        }

        const documents: DocumentMove[] = [];
        const sources = new Map<string, vscode.Uri>();
        let standardLinkUpdates = false;
        for (const move of files) {
            if (token.isCancellationRequested) {
                return empty;
            }
            if (!/\.md$/i.test(move.oldUri.path) || !/\.md$/i.test(move.newUri.path) ||
                key(move.oldUri) === key(move.newUri) ||
                move.oldUri.scheme !== move.newUri.scheme || move.oldUri.authority !== move.newUri.authority ||
                !vscode.workspace.getConfiguration('manulDown', move.oldUri).get<boolean>('images.moveWithDocument', true)) {
                continue;
            }
            const root = vscode.workspace.getWorkspaceFolder(move.oldUri)?.uri;
            const destinationRoot = vscode.workspace.getWorkspaceFolder(move.newUri)?.uri;
            if (!root || !destinationRoot || !await this.safePath(move.oldUri, root, false) ||
                !await this.safePath(move.newUri, destinationRoot, true)) {
                continue;
            }
            if ((await vscode.workspace.fs.stat(move.oldUri)).type !== vscode.FileType.File) {
                continue;
            }
            const document = vscode.workspace.textDocuments.find(doc => key(doc.uri) === key(move.oldUri)) ||
                await vscode.workspace.openTextDocument(move.oldUri);
            const version = document.version;
            const images = new Map<string, vscode.Uri>();
            const directory = imageDirectory(move.oldUri);
            for (const reference of collectMarkdownImagePaths(document.getText())) {
                if (token.isCancellationRequested) {
                    return empty;
                }
                const resolved = resolvePath(move.oldUri, reference.path);
                if (!resolved || !isUriLexicallyWithinDirectory(resolved.uri, directory) ||
                    !await this.safePath(resolved.uri, root, false)) {
                    continue;
                }
                if ((await vscode.workspace.fs.stat(resolved.uri)).type === vscode.FileType.File) {
                    images.set(key(resolved.uri), resolved.uri);
                    sources.set(key(resolved.uri), resolved.uri);
                }
            }
            if (images.size) {
                // VS Code's built-in updater edits the document after the move
                // and again after Undo. Its independent rebasing conflicts with
                // image copies and renamed collision targets. Keep its working
                // links and leave images in place when it owns link updates.
                if (vscode.workspace.getConfiguration('markdown', document.uri)
                    .get<string>('updateLinksOnFileMove.enabled', 'never') !== 'never') {
                    standardLinkUpdates = true;
                    continue;
                }
                documents.push({ document, version, newUri: move.newUri, images });
            }
        }
        if (standardLinkUpdates && !token.isCancellationRequested) {
            void vscode.window.showWarningMessage('ManulDown left images in place because Markdown link updates are enabled. ' +
                'Set "markdown.updateLinksOnFileMove.enabled" to "never" to move images with Markdown files.');
        }
        if (!documents.length || token.isCancellationRequested) {
            return empty;
        }

        const readers = await this.findReaders(sources, token);
        const edit = new vscode.WorkspaceEdit();
        const reserved = new Set(files.map(move => key(move.newUri)));
        const transfers = new Map<string, vscode.Uri>();
        const cleanupDirectories = new Map<string, ImageDirectory>();
        const metadata = { label: 'Move Markdown images', needsConfirmation: false };
        for (const move of documents) {
            const replacements = new Map<string, vscode.Uri>();
            for (const [sourceKey, source] of move.images) {
                if (token.isCancellationRequested) {
                    return empty;
                }
                const alreadyMoved = this.relocatedUri(source, files);
                if (key(alreadyMoved) !== sourceKey) {
                    // The user selected the image (or its parent) as well.
                    replacements.set(sourceKey, alreadyMoved);
                    continue;
                }
                const desired = vscode.Uri.joinPath(imageDirectory(move.newUri),
                    path.posix.relative(imageDirectory(move.document.uri).path, source.path));
                if (key(desired) === sourceKey) {
                    replacements.set(sourceKey, source);
                    continue;
                }
                const transferKey = `${sourceKey}\n${key(desired)}`;
                let target = transfers.get(transferKey);
                if (!target) {
                    const root = vscode.workspace.getWorkspaceFolder(desired)?.uri;
                    if (!root || files.some(file => isUriLexicallyWithinDirectory(desired, file.newUri) &&
                        desired.path !== file.newUri.path) ||
                        !await this.safePath(desired.with({ path: path.posix.dirname(desired.path) }), root, true, true)) {
                        // Keep a reference to the original when the destination
                        // contains a symbolic link or another invalid component.
                        replacements.set(sourceKey, source);
                        continue;
                    }
                    const otherReaders = readers?.get(sourceKey);
                    const shared = !readers || (otherReaders &&
                        [...otherReaders].some(reader => reader !== key(move.document.uri)));
                    const sourceRoot = vscode.workspace.getWorkspaceFolder(source)?.uri;
                    if (!sourceRoot || !await this.safePath(source, sourceRoot, false)) {
                        return empty;
                    }
                    target = await this.reserveTarget(desired, reserved, token);
                    if (!target) {
                        return empty;
                    }
                    if (shared) {
                        edit.createFile(target, { contents: await vscode.workspace.fs.readFile(source),
                            overwrite: false }, metadata);
                    } else {
                        edit.renameFile(source, target, { overwrite: false }, metadata);
                    }
                    transfers.set(transferKey, target);
                    this.collectImageDirectories(source, move.document.uri, cleanupDirectories);
                    this.collectImageDirectories(target, move.newUri, cleanupDirectories);
                }
                replacements.set(sourceKey, target);
            }

            // Edit only destination spans. Formatting, CRLF, titles, and the
            // remainder of the document stay byte-for-byte as authored.
            const source = move.document.getText();
            for (const reference of collectMarkdownFilePaths(source)) {
                const resolved = resolvePath(move.document.uri, reference.path);
                const target = resolved && replacements.get(key(resolved.uri));
                if (!resolved || !target) {
                    continue;
                }
                if (key(resolvePath(move.newUri, reference.path)?.uri || move.newUri) === key(target)) {
                    continue;
                }
                let href = relativeImagePath(move.newUri, target, reference.path) + resolved.suffix;
                if (reference.format === 'html') {
                    href = href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                    if (!reference.quote) {
                        href = href.replace(/[\s=<>`]/g, character => `&#${character.charCodeAt(0)};`);
                    }
                }
                if (href !== source.slice(reference.start, reference.end)) {
                    edit.replace(move.document.uri,
                        new vscode.Range(move.document.positionAt(reference.start), move.document.positionAt(reference.end)),
                        href, metadata);
                }
            }
        }
        // Awaited reads must not let a stale set of URL offsets overwrite typing.
        if (token.isCancellationRequested || documents.some(move => move.document.version !== move.version)) {
            return empty;
        }
        for (const [directoryKey, directory] of cleanupDirectories) {
            this.cleanupDirectories.set(directoryKey, directory);
        }
        return edit;
    }

    private collectImageDirectories(image: vscode.Uri, document: vscode.Uri,
        directories: Map<string, ImageDirectory>): void {
        const boundary = vscode.Uri.joinPath(document.with({ path: path.posix.dirname(document.path) }), 'images');
        let directory = image.with({ path: path.posix.dirname(image.path) });
        while (isUriLexicallyWithinDirectory(directory, boundary)) {
            directories.set(key(directory), { uri: directory, boundary });
            if (key(directory) === key(boundary)) {
                break;
            }
            directory = directory.with({ path: path.posix.dirname(directory.path) });
        }
    }

    /** Run after successful file operations, including Undo/Redo. Image Undo
     * recreates its parents automatically; its later Redo cleans them again.
     * Nonrecursive removal preserves files added after the move was planned. */
    public cleanupEmptyImageDirectories(affected: readonly vscode.Uri[]): Promise<void> {
        const directories = [...this.cleanupDirectories.values()].filter(directory => affected.some(uri =>
            isUriLexicallyWithinDirectory(uri, directory.boundary) ||
            isUriLexicallyWithinDirectory(directory.boundary, uri)))
            .sort((a, b) => b.uri.path.split('/').length - a.uri.path.split('/').length);
        const cleanup = async (): Promise<void> => {
            for (const { uri } of directories) {
                try {
                    const root = vscode.workspace.getWorkspaceFolder(uri)?.uri;
                    if (!root || !await this.safePath(uri, root, false, true)) {
                        continue;
                    }
                    if (uri.scheme === 'file') {
                        // rmdir checks emptiness at deletion time and refuses
                        // symbolic links. Never recursively delete a directory.
                        await fs.rmdir(uri.fsPath);
                    } else if ((await vscode.workspace.fs.readDirectory(uri)).length === 0) {
                        await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
                    }
                } catch {
                    // Nonempty, missing, or unwritable folders stay untouched;
                    // optional cleanup must not interrupt the document move.
                }
            }
        };
        this.cleanupQueue = this.cleanupQueue.then(cleanup, cleanup);
        return this.cleanupQueue;
    }

    private relocatedUri(uri: vscode.Uri, files: readonly FileMove[]): vscode.Uri {
        const parent = files.filter(move => isUriLexicallyWithinDirectory(uri, move.oldUri))
            .sort((a, b) => b.oldUri.path.length - a.oldUri.path.length)[0];
        return parent ? vscode.Uri.joinPath(parent.newUri, path.posix.relative(parent.oldUri.path, uri.path)) : uri;
    }

    private async reserveTarget(desired: vscode.Uri, reserved: Set<string>, token: vscode.CancellationToken):
        Promise<vscode.Uri | undefined> {
        const parsed = path.posix.parse(desired.path);
        for (let sequence = 1; ; sequence++) {
            if (token.isCancellationRequested) {
                return undefined;
            }
            const candidate = sequence === 1 ? desired : desired.with({
                path: path.posix.join(parsed.dir, `${parsed.name}-${sequence}${parsed.ext}`),
            });
            if (!reserved.has(key(candidate)) && !await this.exists(candidate)) {
                reserved.add(key(candidate));
                return candidate;
            }
        }
    }

    private async exists(uri: vscode.Uri): Promise<boolean> {
        try {
            if (uri.scheme === 'file') {
                await fs.lstat(uri.fsPath);
            } else {
                await vscode.workspace.fs.stat(uri);
            }
            return true;
        } catch (error) {
            if (this.isMissing(error)) {
                return false;
            }
            throw error;
        }
    }

    private isMissing(error: unknown): boolean {
        const code = (error as { code?: string }).code;
        return code === 'ENOENT' || code === 'FileNotFound';
    }

    private async safePath(uri: vscode.Uri, root: vscode.Uri, allowMissing: boolean,
        requireDirectory = false): Promise<boolean> {
        if (!isUriLexicallyWithinDirectory(uri, root)) {
            return false;
        }
        const segments = path.posix.relative(root.path, uri.path).split('/').filter(Boolean);
        let current = root;
        for (let index = 0; index < segments.length; index++) {
            current = vscode.Uri.joinPath(current, segments[index]);
            try {
                let directory: boolean;
                if (current.scheme === 'file') {
                    const stat = await fs.lstat(current.fsPath);
                    if (stat.isSymbolicLink()) {
                        return false;
                    }
                    directory = stat.isDirectory();
                } else {
                    const stat = await vscode.workspace.fs.stat(current);
                    if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
                        return false;
                    }
                    directory = stat.type === vscode.FileType.Directory;
                }
                if ((index < segments.length - 1 || requireDirectory) && !directory) {
                    return false;
                }
            } catch (error) {
                return allowMissing && this.isMissing(error);
            }
        }
        return true;
    }

    /** An incomplete scan means copy, never assume an image is unshared. Read
     * dirty buffers first, and bound disk work for large workspaces. */
    private async findReaders(sources: Map<string, vscode.Uri>, token: vscode.CancellationToken):
        Promise<Map<string, Set<string>> | undefined> {
        const readers = new Map<string, Set<string>>();
        try {
            const found = await vscode.workspace.findFiles('**/*.{[mM][dD],[mM][aA][rR][kK][dD][oO][wW][nN]}', null,
                maxSharedDocuments + 1, token);
            if (found.length > maxSharedDocuments || token.isCancellationRequested) {
                return undefined;
            }
            const open = new Map(vscode.workspace.textDocuments
                .filter(doc => doc.languageId === 'markdown' || /\.(?:md|markdown)$/i.test(doc.uri.path))
                .map(doc => [key(doc.uri), doc]));
            const versions = [...open.values()].map(document => ({ document, version: document.version }));
            const uris = new Map(found.map(uri => [key(uri), uri]));
            for (const doc of open.values()) {
                uris.set(key(doc.uri), doc.uri);
            }
            let scannedBytes = 0;
            for (const [documentKey, uri] of uris) {
                if (token.isCancellationRequested) {
                    return undefined;
                }
                const root = vscode.workspace.getWorkspaceFolder(uri)?.uri;
                if (!root) {
                    continue;
                }
                let text = open.get(documentKey)?.getText();
                if (text === undefined) {
                    if (!await this.safePath(uri, root, false)) {
                        return undefined;
                    }
                    const stat = await vscode.workspace.fs.stat(uri);
                    if (stat.size > maxSharedDocumentBytes) {
                        return undefined;
                    }
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    // Do not mistake a UTF-16 document for an absence of readers.
                    if (bytes.includes(0)) {
                        return undefined;
                    }
                    scannedBytes += bytes.byteLength;
                    text = Buffer.from(bytes).toString('utf8');
                } else {
                    scannedBytes += Buffer.byteLength(text, 'utf8');
                }
                if (scannedBytes > maxSharedScanBytes) {
                    return undefined;
                }
                for (const reference of collectMarkdownFilePaths(text)) {
                    for (const resolved of resolveReaderPaths(uri, reference.path)) {
                        const sourceKey = key(resolved);
                        if (sources.has(sourceKey)) {
                            const documents = readers.get(sourceKey) || new Set<string>();
                            documents.add(documentKey);
                            readers.set(sourceKey, documents);
                        }
                    }
                }
            }
            return versions.some(entry => entry.document.version !== entry.version) ? undefined : readers;
        } catch {
            return undefined;
        }
    }
}

export function registerMarkdownImageMover(): vscode.Disposable {
    const mover = new MarkdownImageMover();
    const willRename = vscode.workspace.onWillRenameFiles(event => {
        event.waitUntil(mover.createEdit(event.files, event.token).catch(error => {
            console.error('[images] Failed to prepare Markdown image moves:', error);
            void vscode.window.showWarningMessage('ManulDown could not move the images with the Markdown file.');
            return new vscode.WorkspaceEdit();
        }));
    });
    const didRename = vscode.workspace.onDidRenameFiles(event => {
        void mover.cleanupEmptyImageDirectories(event.files.map(file => file.oldUri));
    });
    const didDelete = vscode.workspace.onDidDeleteFiles(event => {
        void mover.cleanupEmptyImageDirectories(event.files);
    });
    return vscode.Disposable.from(willRename, didRename, didDelete);
}
