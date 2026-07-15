import { promises as fs } from 'fs';
import * as path from 'path';
import type { Uri } from 'vscode';

export type MarkdownHeadingLink = {
    level: number;
    label: string;
    slug: string;
};

const bidiControlPattern = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/g;
const unsafeExternalLinkCharacterPattern = /[\u0000-\u001f\u007f-\u009f\s\\]/u;
const unsafeExternalLinkBidiPattern = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const unsafeDecodedExternalLinkPattern = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const maxExternalLinkLength = 4096;

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
    directory: Uri
): Promise<boolean> {
    if (!isUriLexicallyWithinDirectory(candidate, directory)) {
        return false;
    }
    if (candidate.scheme !== 'file') {
        return true;
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

function decodeBasicHtmlEntities(value: string): string {
    const namedEntities: Record<string, string> = {
        amp: '&',
        apos: "'",
        gt: '>',
        lt: '<',
        nbsp: ' ',
        quot: '"',
    };
    return value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi, (
        match,
        decimal,
        hexadecimal,
        named
    ) => {
        if (decimal || hexadecimal) {
            const codePoint = Number.parseInt(decimal || hexadecimal, decimal ? 10 : 16);
            if (
                Number.isSafeInteger(codePoint) &&
                codePoint > 0 &&
                codePoint <= 0x10ffff &&
                !(codePoint >= 0xd800 && codePoint <= 0xdfff)
            ) {
                return String.fromCodePoint(codePoint);
            }
            return match;
        }
        return namedEntities[String(named || '').toLowerCase()] || match;
    });
}

export function normalizeMarkdownHeadingText(rawValue: string): string {
    // Heading candidates are line-oriented. Bound every regex input even when a
    // hostile Markdown file contains a megabyte-long single line.
    let value = String(rawValue || '').slice(0, 4096);
    value = value
        .replace(/!\[([^\]]*)\]\([^\r\n)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^\r\n)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\[[^\r\n\]]*\]/g, '$1')
        .replace(/`+([^`]*?)`+/g, '$1')
        .replace(/<[^>\r\n]{1,512}>/g, '')
        .replace(/\\([\\`*_{}\[\]()#+.!|>~-])/g, '$1')
        .replace(/[\u200b\u2060\ufeff]/g, '')
        .replace(/[*_~]/g, '');
    value = decodeBasicHtmlEntities(value);
    return sanitizeWorkspaceLinkDisplayText(value, 240);
}

export function slugifyMarkdownHeading(value: string): string {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
        .replace(/\s+/g, '-');
}

function stripBlockquotePrefix(line: string): string {
    let current = line;
    while (/^ {0,3}>[ \t]?/.test(current)) {
        current = current.replace(/^ {0,3}>[ \t]?/, '');
    }
    return current;
}

export function extractMarkdownHeadings(
    markdown: string,
    maxHeadings = 200
): MarkdownHeadingLink[] {
    const boundedMaxHeadings = Math.max(0, Math.min(1000, Math.floor(maxHeadings)));
    if (boundedMaxHeadings === 0) {
        return [];
    }

    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const headings: MarkdownHeadingLink[] = [];
    const usedSlugs = new Set<string>();
    let fenceMarker: '`' | '~' | null = null;
    let fenceLength = 0;
    let inFrontMatter = lines.length > 0 && /^(?:\ufeff)?---[ \t]*$/.test(lines[0]);

    const appendHeading = (level: number, rawLabel: string) => {
        if (headings.length >= boundedMaxHeadings) {
            return;
        }
        const label = normalizeMarkdownHeadingText(rawLabel);
        const baseSlug = slugifyMarkdownHeading(label);
        if (!label || !baseSlug) {
            return;
        }
        let slug = baseSlug;
        let duplicateIndex = 1;
        while (usedSlugs.has(slug)) {
            slug = `${baseSlug}-${duplicateIndex++}`;
        }
        usedSlugs.add(slug);
        headings.push({ level, label, slug });
    };

    for (let index = 0; index < lines.length && headings.length < boundedMaxHeadings; index++) {
        const rawLine = lines[index];
        if (rawLine.length > 8192) {
            continue;
        }
        const line = stripBlockquotePrefix(rawLine);

        if (inFrontMatter) {
            if (index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line)) {
                inFrontMatter = false;
            }
            continue;
        }

        const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (fenceMatch) {
            const run = fenceMatch[1];
            const marker = run[0] as '`' | '~';
            if (fenceMarker === null) {
                fenceMarker = marker;
                fenceLength = run.length;
            } else if (marker === fenceMarker && run.length >= fenceLength) {
                fenceMarker = null;
                fenceLength = 0;
            }
            continue;
        }
        if (fenceMarker !== null) {
            continue;
        }

        const atxMatch = line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/);
        if (atxMatch) {
            const rawLabel = atxMatch[2].replace(/[ \t]+#+[ \t]*$/, '');
            appendHeading(atxMatch[1].length, rawLabel);
            continue;
        }

        if (index + 1 >= lines.length || line.trim() === '') {
            continue;
        }
        const nextRawLine = lines[index + 1];
        if (nextRawLine.length > 8192) {
            continue;
        }
        const nextLine = stripBlockquotePrefix(nextRawLine);
        const setextMatch = nextLine.match(/^ {0,3}(=+|-+)[ \t]*$/);
        if (!setextMatch || /^ {0,3}(?:>|[-+*]\s|\d+[.)]\s|<)/.test(line)) {
            continue;
        }
        appendHeading(setextMatch[1][0] === '=' ? 1 : 2, line.trim());
        index++;
    }

    return headings;
}
