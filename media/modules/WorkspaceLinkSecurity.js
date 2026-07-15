// @ts-nocheck

const explicitSchemePattern = /^[a-z][a-z0-9+.-]*:/i;
const unsafeLinkCharacterPattern = /[\u0000-\u001f\u007f-\u009f\s\\]/u;
const unsafeLinkBidiPattern = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const unsafeDecodedLinkPattern = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const MAX_INSERTED_LINK_LENGTH = 4096;

export function normalizeWorkspaceLinkLabel(value) {
    const normalized = String(value || '')
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
        .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return (normalized || 'link').slice(0, 240);
}

export function sanitizeInsertedLinkHref(rawHref, linkKind) {
    const rawValue = String(rawHref || '');
    const href = rawValue.trim();
    if (
        !href ||
        rawValue.length > MAX_INSERTED_LINK_LENGTH ||
        unsafeLinkCharacterPattern.test(rawValue) ||
        unsafeLinkBidiPattern.test(rawValue)
    ) {
        return null;
    }

    if (linkKind === 'workspace') {
        if (href.startsWith('//') || explicitSchemePattern.test(href)) {
            return null;
        }
        if (href.startsWith('#')) {
            return /^#[^#\s]+$/.test(href) ? href : null;
        }
        return /^(?:\.\/|\.\.\/)[^\s]+$/.test(href) ? href : null;
    }

    if (
        linkKind !== 'external' ||
        !/^(?:https?:\/\/|mailto:)/i.test(href)
    ) {
        return null;
    }
    try {
        if (unsafeDecodedLinkPattern.test(decodeURIComponent(href))) {
            return null;
        }
        const parsed = new URL(href);
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
        return parsed.href.length <= MAX_INSERTED_LINK_LENGTH
            ? parsed.href
            : null;
    } catch (_error) {
        return null;
    }
}
