// @ts-nocheck
/** Derived selection outlines; never changes the native range or editing mode. */
export class BlockObjectSelection {
    constructor(editor) {
        this.editor = editor;
        this.observer = null;
    }

    setup() {
        const document = this.editor.ownerDocument;
        document.addEventListener('selectionchange', () => this.update());
        // Paste, history restoration and preview switches can replace content
        // without moving the selection. Ignore our own class-only mutations.
        const Observer = document.defaultView?.MutationObserver;
        if (Observer && !this.observer) {
            this.observer = new Observer(() => this.update());
            this.observer.observe(this.editor, {
                childList: true, characterData: true, subtree: true,
                attributes: true,
                attributeFilter: ['data-mermaid-view', 'data-math-view', 'data-mdw-math']
            });
        }
        this.update();
    }

    update() {
        const selection = this.editor.ownerDocument.defaultView?.getSelection?.();
        const ranges = [];
        for (let index = 0; index < (selection?.rangeCount || 0); index++) {
            const range = selection.getRangeAt(index);
            if (!range.collapsed && typeof range.isPointInRange === 'function' &&
                this.editor.contains(range.startContainer) && this.editor.contains(range.endContainer)) {
                ranges.push(range);
            }
        }
        const blocks = Array.from(this.editor.querySelectorAll('pre, span[data-mdw-math="display"], .md-block-whole-selected'));
        for (const block of blocks) {
            const code = block.tagName === 'PRE'
                ? Array.from(block.children).find(child => child.tagName === 'CODE') : null;
            const formula = block.matches('span[data-mdw-math="display"]');
            const preview = block.getAttribute('data-mermaid-view') === 'diagram' ||
                block.getAttribute('data-math-view') === 'preview';
            const eligible = (code || formula) && !block.closest('[data-mdw-opaque-source], [data-exclude-from-markdown="true"]');
            let selected = false;
            if (eligible && ranges.length) {
                const boundaries = formula || preview ? this._nodeBoundaries(block) : this._codeBoundaries(code);
                selected = ranges.some(range => boundaries.every(point => range.isPointInRange(point.node, point.offset)));
            }
            if (selected && !block.classList.contains('md-block-whole-selected')) {
                block.classList.add('md-block-whole-selected');
            } else if (!selected && block.classList.contains('md-block-whole-selected')) {
                block.classList.remove('md-block-whole-selected');
                if (block.getAttribute('class') === '') block.removeAttribute('class');
            }
        }
    }

    _nodeBoundaries(node) {
        const offset = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
        return [{ node: node.parentNode, offset }, { node: node.parentNode, offset: offset + 1 }];
    }

    _codeBoundaries(code) {
        // Syntax spans are presentation only. Preserve spaces/indentation and
        // blank lines, but ignore caret controls and one terminal newline, as
        // code-block navigation does for its final placeholder line.
        const parts = [];
        const endsWithNewline = () => {
            const last = parts.at(-1);
            return last && (last.newline || last.text[last.end.offset - 1] === '\n');
        };
        const visit = node => {
            if (node.nodeType === 3) {
                const text = node.textContent || '';
                const start = text.search(/[^\u200B\u2060\uFEFF]/);
                if (start < 0) return;
                const end = text.length - /[\u200B\u2060\uFEFF]*$/.exec(text)[0].length;
                parts.push({ start: { node, offset: start }, end: { node, offset: end }, text });
            } else if (node.nodeType === 1) {
                if (node.getAttribute('data-exclude-from-markdown') === 'true' || node.getAttribute('aria-hidden') === 'true') return;
                if (node.tagName === 'BR') {
                    const [start, end] = this._nodeBoundaries(node);
                    parts.push({ start, end, newline: true });
                } else {
                    const startIndex = parts.length;
                    Array.from(node.childNodes).forEach((child, index) => {
                        const line = child.nodeType === 1 && (child.tagName === 'DIV' || child.tagName === 'P');
                        if (line && parts.length > startIndex && !endsWithNewline()) {
                            parts.push({ start: parts.at(-1).end, end: { node, offset: index }, newline: true });
                        }
                        visit(child);
                    });
                    // Chromium uses DIV/P line containers as well as BRs.
                    // Their implicit line feeds must count toward full selection.
                    if ((node.tagName === 'DIV' || node.tagName === 'P') &&
                        (parts.length === startIndex || !endsWithNewline())) {
                        parts.push({ start: { node, offset: node.childNodes.length },
                            end: this._nodeBoundaries(node)[1], newline: true });
                    }
                }
            }
        };
        visit(code);
        const last = parts.at(-1);
        if (last) {
            if (last.newline) {
                parts.pop();
            } else if (last.text[last.end.offset - 1] === '\n') {
                last.end = { node: last.end.node, offset: last.end.offset - 1 };
                if (last.end.offset === last.start.offset) parts.pop();
            }
        }
        if (!parts.length) {
            return [{ node: code, offset: 0 }, { node: code, offset: code.childNodes.length }];
        }
        return [parts[0].start, parts.at(-1).end];
    }
}
