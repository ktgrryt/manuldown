// Shared by the Markdown reader and the webview so type changes, pasted blocks
// and new declarations follow the same rules in both directions.
export type CalloutVariant = 'note' | 'tip' | 'important' | 'warning' | 'caution';

export const calloutDialects = [
    { value: 'github', label: 'GitHub / GitLab / Microsoft Learn' },
    { value: 'qiita', label: 'Qiita' },
    { value: 'zenn', label: 'Zenn' },
    { value: 'obsidian', label: 'Obsidian' },
    { value: 'container', label: 'Docusaurus / VitePress' },
    { value: 'mkdocs', label: 'MkDocs' },
    { value: 'gitbook', label: 'GitBook' },
    { value: 'myst', label: 'MyST / Jupyter Book' },
    { value: 'quarto', label: 'Quarto' },
] as const;

export type CalloutService = typeof calloutDialects[number]['value'];
export function isCalloutService(value: unknown): value is CalloutService {
    return calloutDialects.some(option => option.value === value);
}

export function resolveCalloutService(value: unknown): CalloutService {
    return isCalloutService(value) ? value : 'github';
}

const variants = {
    gitbook: { info: 'note', success: 'tip', warning: 'warning', danger: 'caution' },
    myst: {
        note: 'note', important: 'important', hint: 'tip', seealso: 'note', tip: 'tip',
        attention: 'warning', caution: 'caution', warning: 'warning', danger: 'caution', error: 'caution',
    },
    quarto: { note: 'note', tip: 'tip', important: 'important', warning: 'warning', caution: 'caution' },
} as const;

export type FencedService = keyof typeof variants;

export function supportsFencedType(service: FencedService, type: string): boolean {
    return Object.prototype.hasOwnProperty.call(variants[service], type);
}

export type FencedDescriptor = {
    dialect: FencedService;
    current: string;
    options: string[];
    title?: string;
    custom: boolean;
    keepAttributes: boolean;
    fence: string;
    rewrite: (type: string) => string;
    variant: (type: string) => CalloutVariant;
};

function descriptor(header: string, dialect: FencedService, fence: string, type: string, offset: number,
    title?: string, keepAttributes = false): FencedDescriptor | null {
    const types: Record<string, CalloutVariant> = variants[dialect];
    const options = Object.keys(types);
    if (!options.includes(type)) { return null; }
    return { dialect, current: type, options, title, custom: title !== undefined, keepAttributes, fence,
        rewrite: value => header.slice(0, offset) + value + header.slice(offset + type.length),
        variant: value => types[value] };
}

type Attribute = { key: string; value: string; offset: number };

/** Read whole attributes so a class or style mentioned inside a quoted title cannot select the type. */
function readAttributes(text: string): Attribute[] | null {
    const pattern = /[ \t]*(?:([.#])([^\s"'={}]+)|([\w-]+)[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'={}]+)))(?=[ \t]|$)/y;
    const attributes: Attribute[] = [];
    const end = text.trimEnd().length;
    while (pattern.lastIndex < end) {
        const match = pattern.exec(text);
        if (!match) { return null; }
        const value = match[2] ?? match[4] ?? match[5] ?? match[6];
        attributes.push({ key: match[1] ?? match[3], value, offset: match.index + match[0].lastIndexOf(value) });
    }
    return attributes;
}

/** Directive options are source metadata, not Markdown paragraphs to reformat. */
export function mystHasOptions(body: string): boolean {
    return /^\s*(?::[\w-]+:|---[ \t]*(?:\r?\n|$))/.test(body);
}

export const gitbookCloser = /^ {0,3}\{%[ \t]+endhint[ \t]+%\}[ \t]*$/;
export const gitbookOpener = /^ {0,3}\{%[ \t]+hint[ \t]+[^\r\n]*%\}[ \t]*$/;

export function matchesFencedCloser(spec: FencedDescriptor, footer: string): boolean {
    if (/[\r\n]/.test(footer)) { return false; }
    if (spec.dialect === 'gitbook') { return gitbookCloser.test(footer); }
    const close = /^ {0,3}(:{3,}|`{3,})[ \t]*$/.exec(footer);
    return !!close && close[1][0] === spec.fence[0] &&
        (spec.dialect === 'quarto' || close[1].length >= spec.fence.length);
}

export function fencedDescriptor(header: string): FencedDescriptor | null {
    if (/[\r\n]/.test(header)) { return null; }
    const myst = /^( {0,3}(:{3,}|`{3,})[ \t]*\{)([a-z]+)\}(?:[ \t]+(.*?))?[ \t]*$/.exec(header);
    if (myst) {
        if (myst[2][0] === '`' && myst[4]?.includes('`')) { return null; }
        return descriptor(header, 'myst', myst[2], myst[3], myst[1].length, myst[4] || undefined);
    }
    const gitbook = /^( {0,3}\{%[ \t]+hint[ \t]+)(.*?)[ \t]+%\}[ \t]*$/.exec(header);
    if (gitbook) {
        const attrs = readAttributes(gitbook[2]);
        const styles = attrs?.filter(attr => attr.key === 'style');
        if (!attrs || styles?.length !== 1 || attrs.some(attr => attr.key !== 'style' &&
            !(attr.key === 'icon' && /^[\w-]+$/.test(attr.value))) || attrs.length > 2) { return null; }
        const style = styles[0];
        return descriptor(header, 'gitbook', '', style.value, gitbook[1].length + style.offset, undefined, attrs.length > 1);
    }
    const bareQuarto = /^( {0,3}(:{3,})[ \t]+callout-)([a-z]+)[ \t]*(?::{3,}[ \t]*)?$/.exec(header);
    if (bareQuarto) {
        return descriptor(header, 'quarto', bareQuarto[2], bareQuarto[3], bareQuarto[1].length);
    }
    const quarto = /^( {0,3}(:{3,})[ \t]*\{)(.*)\}[ \t]*(?::{3,}[ \t]*)?$/.exec(header);
    if (!quarto) { return null; }
    const attrs = readAttributes(quarto[3]);
    const classes = attrs?.filter(attr => attr.key === '.' && attr.value.startsWith('callout-'));
    if (!attrs || classes?.length !== 1) { return null; }
    const titles = attrs.filter(attr => attr.key === 'title');
    if (titles.length > 1 || attrs.some(attr => !['.', '#', 'title', 'collapse', 'icon', 'appearance'].includes(attr.key))) { return null; }
    const kind = classes[0], prefix = 'callout-'.length;
    return descriptor(header, 'quarto', quarto[2], kind.value.slice(prefix), quarto[1].length + kind.offset + prefix,
        titles[0]?.value, attrs.length > 1 + titles.length);
}
