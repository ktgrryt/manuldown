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
    images: Map<string, { uri: vscode.Uri; relativePath: string }>;
};
type ImageDirectory = { uri: vscode.Uri; boundary: vscode.Uri };

const maxSharedDocuments = 2000;
const maxSharedDocumentBytes = 2 * 1024 * 1024;
const maxSharedScanBytes = 32 * 1024 * 1024;
// Keep closed readers consistent with VS Code's built-in Markdown language.
const markdownExtensions = ['md', 'mkd', 'mkdn', 'mdwn', 'mdown', 'markdown', 'markdn',
    'mdtxt', 'mdtext', 'litcoffee', 'ron', 'ronn', 'workbook', 'mdc'];
const markdownReaderPattern = `**/*.{${markdownExtensions.map(extension =>
    [...extension].map(character => `[${character}${character.toUpperCase()}]`).join('')).join(',')}}`;
const markdownReaderExtension = new RegExp(`\\.(?:${markdownExtensions.join('|')})$`, 'i');

function key(uri: vscode.Uri): string {
    const value = uri.with({ query: '', fragment: '' }).toString();
    return uri.scheme === 'file' && process.platform === 'win32' ? value.toLowerCase() : value;
}

function reservationKey(uri: vscode.Uri): string {
    const value = key(uri);
    // Missing destinations have no realpath yet. Reserve case variants together
    // on macOS/Windows so a batch cannot plan two writes to the same pathname.
    return uri.scheme === 'file' && (process.platform === 'darwin' || process.platform === 'win32')
        ? value.toLowerCase() : value;
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
        const identities = new Map<string, Promise<string>>();
        const knownSources = new Map<string, string>();
        const sourceAliases = new Map<string, Set<string>>();
        const existingKey = (uri: vscode.Uri): Promise<string> => {
            const lexicalKey = key(uri);
            let identity = identities.get(lexicalKey);
            if (!identity) {
                // Resolve existing files only: this respects the actual volume's
                // case sensitivity without conflating distinct case-sensitive files.
                identity = uri.scheme === 'file'
                    ? fs.realpath(uri.fsPath).then(value => key(vscode.Uri.file(value)))
                    : Promise.resolve(lexicalKey);
                identities.set(lexicalKey, identity);
            }
            return identity;
        };
        const findSource = async (uri: vscode.Uri): Promise<string | undefined> => {
            const lexicalKey = key(uri);
            const known = knownSources.get(lexicalKey);
            if (known) {
                return known;
            }
            const candidates = sourceAliases.get(lexicalKey.toLowerCase());
            if (!candidates) {
                return undefined;
            }
            // Only inspect aliases of known sources, within the workspace and
            // without following symbolic links. Never probe arbitrary reader URLs.
            const root = vscode.workspace.getWorkspaceFolder(uri)?.uri;
            if (!root || !await this.safePath(uri, root, false)) {
                return undefined;
            }
            const identity = await existingKey(uri);
            return candidates.has(identity) ? identity : undefined;
        };
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
            const images: DocumentMove['images'] = new Map();
            const directory = imageDirectory(move.oldUri);
            if (!await this.safePath(directory, root, false, true)) {
                continue;
            }
            const directoryPath = directory.scheme === 'file' ? await fs.realpath(directory.fsPath) : directory.path;
            for (const reference of collectMarkdownImagePaths(document.getText())) {
                if (token.isCancellationRequested) {
                    return empty;
                }
                const resolved = resolvePath(move.oldUri, reference.path);
                if (!resolved || !await this.safePath(resolved.uri, root, false)) {
                    continue;
                }
                if ((await vscode.workspace.fs.stat(resolved.uri)).type === vscode.FileType.File) {
                    const sourceKey = await existingKey(resolved.uri);
                    const sourcePath = resolved.uri.scheme === 'file'
                        ? vscode.Uri.parse(sourceKey).fsPath : resolved.uri.path;
                    const relative = resolved.uri.scheme === 'file'
                        ? path.relative(directoryPath, sourcePath).replace(/\\/g, '/')
                        : path.posix.relative(directoryPath, sourcePath);
                    if (!relative || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
                        continue;
                    }
                    if (!images.has(sourceKey)) {
                        images.set(sourceKey, { uri: resolved.uri, relativePath: relative });
                    }
                    for (const spelling of [key(resolved.uri), sourceKey]) {
                        knownSources.set(spelling, sourceKey);
                        const alias = spelling.toLowerCase();
                        const candidates = sourceAliases.get(alias) || new Set<string>();
                        candidates.add(sourceKey);
                        sourceAliases.set(alias, candidates);
                    }
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

        const readers = await this.findReaders(findSource, token);
        const edit = new vscode.WorkspaceEdit();
        const reserved = new Set(files.map(move => reservationKey(move.newUri)));
        const transfers = new Map<string, vscode.Uri>();
        const cleanupDirectories = new Map<string, ImageDirectory>();
        const metadata = { label: 'Move Markdown images', needsConfirmation: false };
        for (const move of documents) {
            const replacements = new Map<string, vscode.Uri>();
            for (const [sourceKey, image] of move.images) {
                const source = image.uri;
                if (token.isCancellationRequested) {
                    return empty;
                }
                const alreadyMoved = this.relocatedUri(source, files);
                if (key(alreadyMoved) !== key(source)) {
                    // The user selected the image (or its parent) as well.
                    replacements.set(sourceKey, alreadyMoved);
                    continue;
                }
                const desired = vscode.Uri.joinPath(imageDirectory(move.newUri),
                    image.relativePath);
                if (key(desired) === key(source)) {
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
                let target: vscode.Uri | undefined;
                for (const resolved of resolveReaderPaths(move.document.uri, reference.path)) {
                    const sourceKey = await findSource(resolved);
                    target = sourceKey ? replacements.get(sourceKey) : undefined;
                    if (target) {
                        break;
                    }
                }
                if (!target) {
                    continue;
                }
                if (resolveReaderPaths(move.newUri, reference.path).some(uri => key(uri) === key(target))) {
                    continue;
                }
                const suffixAt = reference.path.search(/[?#]/);
                const suffix = suffixAt < 0 ? '' : reference.path.slice(suffixAt);
                // Keep URI autolinks valid: <file:///...> cannot contain a relative path.
                let href = (/^file:/i.test(reference.path) ? target.toString()
                    : relativeImagePath(move.newUri, target, reference.path)) + suffix;
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
            if (!reserved.has(reservationKey(candidate)) && !await this.exists(candidate)) {
                reserved.add(reservationKey(candidate));
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
    private async findReaders(findSource: (uri: vscode.Uri) => Promise<string | undefined>, token: vscode.CancellationToken):
        Promise<Map<string, Set<string>> | undefined> {
        const readers = new Map<string, Set<string>>();
        try {
            const found = await vscode.workspace.findFiles(markdownReaderPattern, null,
                maxSharedDocuments + 1, token);
            if (found.length > maxSharedDocuments || token.isCancellationRequested) {
                return undefined;
            }
            const open = new Map(vscode.workspace.textDocuments
                .filter(doc => doc.languageId === 'markdown' || markdownReaderExtension.test(doc.uri.path))
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
                        const sourceKey = await findSource(resolved);
                        if (sourceKey) {
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
