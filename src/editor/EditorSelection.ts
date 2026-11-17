// Structural DOM types keep this shared helper usable in the Node extension
// host (Domino) as well as the browser without adding DOM globals to the host.
interface Node {
    nodeType: number;
    nodeValue: string | null;
    nodeName: string;
    parentElement: HTMLElement | null;
    parentNode: Node | null;
    previousSibling: Node | null;
    childNodes: ArrayLike<Node>;
}
interface HTMLElement extends Node {
    tagName: string;
    matches(selector: string): boolean;
    contains(node: Node): boolean;
    focus(options: { preventScroll: boolean }): void;
    ownerDocument: { defaultView: { getSelection(): Selection | null } | null };
}
interface Selection {
    anchorNode: Node | null;
    anchorOffset: number;
    focusNode: Node | null;
    focusOffset: number;
    setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number): void;
}

export type EditorTextSelection = { anchor: number; active: number };
type Point = { node: Node; offset: number };

/** A layout-independent view of authored content, shared by the host and Webview. */
export function projectEditorText(root: HTMLElement, caretAnchorOffset?: (node: Node) => number) {
    let text = '';
    const boundaries = new Map<Node, number[]>();
    const points: Point[] = [];
    const append = (value: string, before: Point, after: Point) => {
        if (!points[text.length] || (before.node.nodeType === 3 && points[text.length].node.nodeType !== 3)) {
            points[text.length] = before;
        }
        text += value;
        points[text.length] = after;
    };
    const visit = (node: Node): void => {
        const start = text.length;
        if (node.nodeType === 3) {
            const value = node.nodeValue || '';
            const parent = node.parentElement;
            // Renderer indentation between blocks is not an editing position.
            const indentation = /[\r\n]/.test(value) && /^[\r\n\t ]*$/.test(value) &&
                /^(DIV|LI|UL|OL|TABLE|THEAD|TBODY|TR|BLOCKQUOTE)$/.test(parent?.tagName || '');
            const checkboxSpace = value.startsWith(' ') &&
                node.previousSibling?.nodeName === 'INPUT' ? 0 : -1;
            const anchor = caretAnchorOffset?.(node) ?? -1;
            const offsets = [text.length];
            for (let index = 0; index < value.length; index++) {
                if (!indentation && index !== anchor && index !== checkboxSpace && value[index] !== '\r') {
                    append(value[index], { node, offset: index }, { node, offset: index + 1 });
                }
                offsets.push(text.length);
            }
            boundaries.set(node, offsets);
            return;
        }
        if (node.nodeType !== 1) { return; }
        const element = node as HTMLElement;
        if (element !== root && element.matches(
            '.code-block-toolbar, .mermaid-preview, .math-block-preview, .mdw-footnote-backref, ' +
            '[data-mdw-footnote-backref], .mdw-callout-title, [data-exclude-from-markdown="true"], ' +
            '[data-mdw-code-gap="true"]'
        )) { return; }
        const parent = node.parentNode || root;
        const index = Array.prototype.indexOf.call(parent.childNodes, node);
        if (element.matches('img, hr, input, [data-mdw-math], [data-mdw-toc], [data-mdw-footnote-ref]')) {
            append('\uFFFC', { node: parent, offset: index }, { node: parent, offset: index + 1 });
        } else if (element.tagName === 'BR') {
            append('\n', { node: parent, offset: index }, { node: parent, offset: index + 1 });
        } else {
            const offsets = [text.length];
            for (const child of Array.from(node.childNodes)) {
                visit(child);
                offsets.push(text.length);
            }
            boundaries.set(node, offsets);
        }
        if (element !== root && /^(P|DIV|H[1-6]|LI|PRE|TD|TH)$/.test(element.tagName) &&
            (text.length === start || !text.endsWith('\n'))) {
            append('\n', { node: parent, offset: index + 1 }, { node: parent, offset: index + 1 });
        }
    };
    visit(root);
    return {
        text,
        offsetAt(node: Node, offset: number): number | null {
            let current: Node | null = node;
            while (current && current !== root && !boundaries.has(current)) { current = current.parentNode; }
            const values = current ? boundaries.get(current) : undefined;
            if (!values) { return null; }
            return values[Math.max(0, Math.min(current === node ? offset : 0, values.length - 1))];
        },
        pointAt(offset: number): Point {
            const clamped = Math.max(0, Math.min(Math.floor(offset), text.length));
            for (let index = clamped; index >= 0; index--) {
                if (points[index]) { return points[index]; }
            }
            return { node: root, offset: 0 };
        }
    };
}

export function captureEditorSelection(root: HTMLElement, caretAnchorOffset?: (node: Node) => number,
    savedSelection?: Pick<Selection, 'anchorNode' | 'anchorOffset' | 'focusNode' | 'focusOffset'> | null): EditorTextSelection | null {
    let selection = root.ownerDocument.defaultView?.getSelection();
    if ((!selection?.anchorNode || !root.contains(selection.anchorNode)) && savedSelection) {
        selection = savedSelection as Selection;
    }
    if (!selection?.anchorNode || !selection.focusNode ||
        !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) { return null; }
    const projection = projectEditorText(root, caretAnchorOffset);
    const anchor = projection.offsetAt(selection.anchorNode, selection.anchorOffset);
    const active = projection.offsetAt(selection.focusNode, selection.focusOffset);
    return anchor === null || active === null ? null : { anchor, active };
}

export function restoreEditorSelection(root: HTMLElement, value: EditorTextSelection,
    caretAnchorOffset?: (node: Node) => number): boolean {
    if (!isEditorTextSelection(value)) { return false; }
    const selection = root.ownerDocument.defaultView?.getSelection();
    if (!selection) { return false; }
    const projection = projectEditorText(root, caretAnchorOffset);
    const anchor = projection.pointAt(value.anchor);
    const active = projection.pointAt(value.active);
    root.focus({ preventScroll: true });
    selection.setBaseAndExtent(anchor.node, anchor.offset, active.node, active.offset);
    return true;
}

export function isEditorTextSelection(value: unknown): value is EditorTextSelection {
    return value !== null && typeof value === 'object' &&
        ['anchor', 'active'].every(key => Number.isSafeInteger((value as any)[key]) && (value as any)[key] >= 0);
}

/** Match character boundaries without treating Markdown punctuation as visible text. */
export function mapTextOffset(from: string, to: string, offset: number): number {
    const target = Math.max(0, Math.min(offset, from.length));
    if (from === to) { return target; }
    if (!to.length) { return 0; }
    if (!from.length) { return 0; }
    let prefix = 0;
    while (prefix < from.length && prefix < to.length && from[prefix] === to[prefix]) { prefix++; }
    if (target < prefix) { return target; }
    let suffix = 0;
    while (suffix < from.length - prefix && suffix < to.length - prefix &&
        from[from.length - suffix - 1] === to[to.length - suffix - 1]) { suffix++; }
    if (target > from.length - suffix) { return to.length - (from.length - target); }
    const first = from.slice(prefix, from.length - suffix);
    const second = to.slice(prefix, to.length - suffix);
    if (!first.length || !second.length) { return prefix; }
    const pairs: Array<[number, number]> = [];
    // Code is usually identical and prose blocks are small. Bound dense matching
    // for very large tables/paragraphs instead of blocking the extension host.
    if (first.length * second.length <= 2_000_000) {
        const width = second.length + 1;
        const lengths = new Uint32Array((first.length + 1) * width);
        for (let i = first.length - 1; i >= 0; i--) {
            for (let j = second.length - 1; j >= 0; j--) {
                lengths[i * width + j] = first[i] === second[j]
                    ? lengths[(i + 1) * width + j + 1] + 1
                    : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < first.length && j < second.length) {
            if (first[i] === second[j]) { pairs.push([prefix + i++, prefix + j++]); }
            else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) { i++; }
            else { j++; }
        }
    } else {
        let j = 0;
        for (let i = 0; i < first.length && j < second.length; i++) {
            const next = second.slice(j, j + 128).indexOf(first[i]);
            if (next >= 0) { pairs.push([prefix + i, prefix + j + next]); j += next + 1; }
        }
    }
    if (prefix) { pairs.unshift([prefix - 1, prefix - 1]); }
    if (suffix) { pairs.push([from.length - suffix, to.length - suffix]); }
    if (!pairs.length) { return Math.round(target / from.length * to.length); }
    // Prefer the adjacent authored character over a formatting delimiter.
    const next = pairs.find(pair => pair[0] >= target);
    const previous = [...pairs].reverse().find(pair => pair[0] < target);
    if (previous && previous[0] + 1 === target) { return previous[1] + 1; }
    if (next) { return next[1]; }
    return previous ? previous[1] + 1 : Math.min(target - prefix, second.length) + prefix;
}
