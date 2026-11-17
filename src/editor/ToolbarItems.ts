export const toolbarItemDefaults = {
    bold: true,
    italic: true,
    strikethrough: true,
    inlinecode: true,
    h1: true,
    h2: true,
    h3: true,
    h4: false,
    h5: false,
    h6: false,
    ul: true,
    ol: true,
    checkbox: true,
    quote: true,
    codeblock: true,
    table: true,
    link: false,
    image: false,
    footnote: false,
    math: false,
    mathblock: false,
};

export type ToolbarItems = typeof toolbarItemDefaults;

export function resolveToolbarItems(value: unknown): ToolbarItems {
    const items = { ...toolbarItemDefaults };
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return items; }
    for (const key of Object.keys(items) as Array<keyof ToolbarItems>) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) { continue; }
        const selected = (value as Record<string, unknown>)[key];
        if (typeof selected === 'boolean') { items[key] = selected; }
    }
    return items;
}
