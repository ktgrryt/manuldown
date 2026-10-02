// @ts-nocheck

export function slugifyMarkdownHeading(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
        .replace(/\s+/g, '-');
}

export function assignStableHeadingIds(headings) {
    const items = Array.from(headings || []);
    const usedIds = new Set();

    items.forEach((heading, index) => {
        if (!heading) return;
        const baseSlug = slugifyMarkdownHeading(heading.textContent || '') || `heading-${index}`;
        let slug = baseSlug;
        let duplicateIndex = 1;
        while (usedIds.has(slug)) {
            slug = `${baseSlug}-${duplicateIndex++}`;
        }
        heading.id = slug;
        usedIds.add(slug);
    });
}

export function getMarkdownHeadingLinkSuggestions(headings, value = '', limit = 20) {
    const query = String(value || '');
    if (
        query !== query.trim() || query.length > 256 ||
        /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(query) ||
        /^(?:[a-z][a-z0-9+.-]*:|[\\/]|\.{1,2}[\\/])/i.test(query)
    ) {
        return [];
    }
    const items = Array.from(headings || []);
    // Use the same IDs as the table of contents and fragment-link navigation,
    // including the suffixes assigned to duplicate headings.
    assignStableHeadingIds(items);
    let searchText = query.replace(/^#{1,6}\s*/, '');
    if (query.startsWith('#')) {
        try {
            searchText = decodeURIComponent(searchText);
        } catch (_error) {
            return [];
        }
    }
    const search = searchText.normalize('NFKC').toLowerCase();
    return items.flatMap((heading, index) => {
        if (!/^H[1-6]$/.test(heading?.tagName || '')) return [];
        const text = String(heading.textContent || '').replace(/\s+/g, ' ').trim();
        if (
            search &&
            !text.normalize('NFKC').toLowerCase().includes(search) &&
            !heading.id.normalize('NFKC').toLowerCase().includes(search)
        ) return [];
        return [{
            kind: 'heading',
            headingId: heading.id,
            path: `#${encodeURIComponent(heading.id)}`,
            label: `${'#'.repeat(Number(heading.tagName.slice(1)))} ${text || `Heading ${index + 1}`}`,
            linkLabel: text || `Heading ${index + 1}`
        }];
    }).slice(0, limit);
}
