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
