import { promises as fs } from 'fs';
import * as path from 'path';
import type { Uri } from 'vscode';

const bidiControlPattern = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/g;
const unsafeExternalLinkCharacterPattern = /[\u0000-\u001f\u007f-\u009f\s\\]/u;
const unsafeExternalLinkBidiPattern = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const unsafeDecodedExternalLinkPattern = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const maxExternalLinkLength = 4096;
const unsafePastedPathPattern = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
const maxPastedPathLength = 4096;

export function sanitizeWorkspaceLinkDisplayText(value: string, maxLength = 240): string {
    const normalized = String(value || '')
        .replace(bidiControlPattern, '')
        .replace(controlCharacterPattern, ' ')
        // QuickPick renders $(name) as a codicon. Do not let a hostile file name
        // or heading impersonate native picker UI.
        .replace(/\$\(/g, '$ (')
        .replace(/\s+/g, ' ')
        .trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

export function normalizeExternalLinkHref(value: string): string | null {
    const rawValue = String(value || '');
    const rawHref = rawValue.trim();
    if (
        !rawHref ||
        rawValue.length > maxExternalLinkLength ||
        unsafeExternalLinkCharacterPattern.test(rawValue) ||
        unsafeExternalLinkBidiPattern.test(rawValue) ||
        !/^(?:https?:\/\/|mailto:)/i.test(rawHref)
    ) {
        return null;
    }

    try {
        if (unsafeDecodedExternalLinkPattern.test(decodeURIComponent(rawHref))) {
            return null;
        }
        // URL parsing is local and performs no network request. Returning its
        // canonical href also avoids displaying a Unicode hostname differently
        // from the value that will actually be opened.
        const parsed = new URL(rawHref);
        const protocol = parsed.protocol.toLowerCase();
        if (protocol === 'http:' || protocol === 'https:') {
            if (!parsed.hostname || parsed.username || parsed.password) {
                return null;
            }
        } else if (protocol === 'mailto:') {
            if (!parsed.pathname || parsed.pathname.startsWith('//')) {
                return null;
            }
        } else {
            return null;
        }

        const normalizedHref = parsed.href;
        return normalizedHref.length <= maxExternalLinkLength
            ? normalizedHref
            : null;
    } catch {
        return null;
    }
}

export function normalizeNativeAbsolutePathForLink(
    value: string,
    platform = process.platform
): string | null {
    const rawPath = String(value || '');
    if (
        !rawPath ||
        rawPath.length > maxPastedPathLength ||
        rawPath !== rawPath.trim() ||
        unsafePastedPathPattern.test(rawPath)
    ) {
        return null;
    }

    if (platform === 'win32') {
        // Do not turn UNC shares, device paths, or drive-relative paths into
        // links. A second colon would address an NTFS alternate data stream.
        if (
            /^[\\/]{2}/.test(rawPath) ||
            !/^[a-z]:[\\/]/i.test(rawPath)
        ) {
            return null;
        }
        const normalized = path.win32.normalize(rawPath);
        return normalized.slice(2).includes(':') ? null : normalized;
    }

    if (!rawPath.startsWith('/') || rawPath.startsWith('//')) {
        return null;
    }
    return path.posix.normalize(rawPath);
}

export function encodeMarkdownRelativePath(relativePath: string): string {
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    const encoded = normalized
        .split('/')
        .map((segment) => {
            if (segment === '.' || segment === '..') {
                return segment;
            }
            return encodeURIComponent(segment).replace(/[!'()*]/g, (character) =>
                `%${character.charCodeAt(0).toString(16).toUpperCase()}`
            );
        })
        .join('/');

    if (encoded.startsWith('./') || encoded.startsWith('../')) {
        return encoded;
    }
    return `./${encoded}`;
}

function getFileSystemVolumeRoot(uri: Uri): string {
    if (uri.scheme !== 'file') {
        return '';
    }
    const root = path.parse(uri.fsPath).root;
    return process.platform === 'win32' ? root.toLowerCase() : root;
}

export function canCreateRelativeWorkspaceLink(
    documentUri: Uri,
    targetUri: Uri
): boolean {
    if (
        documentUri.scheme !== targetUri.scheme ||
        documentUri.authority !== targetUri.authority
    ) {
        return false;
    }
    if (documentUri.scheme === 'file') {
        return getFileSystemVolumeRoot(documentUri) === getFileSystemVolumeRoot(targetUri);
    }
    return true;
}

export function buildWorkspaceRelativeHref(
    documentUri: Uri,
    targetUri: Uri,
    fragment = ''
): string | null {
    if (!canCreateRelativeWorkspaceLink(documentUri, targetUri)) {
        return null;
    }

    const normalizedFragment = String(fragment || '').replace(/^#+/, '');
    if (
        normalizedFragment &&
        documentUri.scheme === targetUri.scheme &&
        documentUri.authority === targetUri.authority &&
        documentUri.path === targetUri.path
    ) {
        return `#${encodeURIComponent(normalizedFragment)}`;
    }

    let relativePath: string;
    if (documentUri.scheme === 'file') {
        relativePath = path
            .relative(path.dirname(documentUri.fsPath), targetUri.fsPath)
            .replace(/\\/g, '/');
    } else {
        relativePath = path.posix.relative(
            path.posix.dirname(documentUri.path),
            targetUri.path
        );
    }
    if (!relativePath) {
        relativePath = path.posix.basename(targetUri.path);
    }

    const encodedPath = encodeMarkdownRelativePath(relativePath);
    return normalizedFragment
        ? `${encodedPath}#${encodeURIComponent(normalizedFragment)}`
        : encodedPath;
}

export function isUriLexicallyWithinDirectory(
    candidate: Uri,
    directory: Uri
): boolean {
    if (candidate.scheme !== directory.scheme || candidate.authority !== directory.authority) {
        return false;
    }
    const relativePath = path.posix.relative(directory.path, candidate.path);
    return relativePath === '' || (
        relativePath !== '..' &&
        !relativePath.startsWith('../') &&
        !path.posix.isAbsolute(relativePath)
    );
}

export function isNativePathWithinDirectory(candidatePath: string, directoryPath: string): boolean {
    const normalizeForComparison = (value: string) =>
        process.platform === 'win32' ? value.toLowerCase() : value;
    const relativePath = path.relative(
        normalizeForComparison(directoryPath),
        normalizeForComparison(candidatePath)
    );
    return relativePath === '' || (
        relativePath !== '..' &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativePath)
    );
}

export async function isUriSecurelyWithinDirectory(
    candidate: Uri,
    directory: Uri,
    readStat?: (uri: Uri) => PromiseLike<{ type: number }>
): Promise<boolean> {
    if (!isUriLexicallyWithinDirectory(candidate, directory)) {
        return false;
    }
    if (candidate.scheme !== 'file') {
        if (!readStat) {
            // Non-file providers have no realpath equivalent. Do not call a
            // lexical check "secure" unless every visible path component can
            // at least be checked for a symbolic-link file type.
            return false;
        }
        try {
            const relativePath = path.posix.relative(directory.path, candidate.path);
            const pathSegments = relativePath.split('/').filter(Boolean);
            if (pathSegments.length > 256) {
                return false;
            }
            const componentPaths = [directory.path];
            let currentPath = directory.path;
            for (const segment of pathSegments) {
                currentPath = path.posix.join(currentPath, segment);
                componentPaths.push(currentPath);
            }
            for (const componentPath of componentPaths) {
                const stat = await readStat(directory.with({ path: componentPath }));
                // vscode.FileType.SymbolicLink. Keep the numeric flag here so
                // this low-level utility retains a type-only vscode import.
                if ((stat.type & 64) !== 0) {
                    return false;
                }
            }
            return true;
        } catch {
            return false;
        }
    }
    try {
        const [canonicalCandidate, canonicalDirectory] = await Promise.all([
            fs.realpath(candidate.fsPath),
            fs.realpath(directory.fsPath),
        ]);
        return isNativePathWithinDirectory(canonicalCandidate, canonicalDirectory);
    } catch {
        // Missing, inaccessible, or unresolvable paths must not cross the trust
        // boundary merely because their lexical path looked safe.
        return false;
    }
}
