const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

function importModule(file) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', file), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const modules = Promise.all([importModule('DOMUtils.js'), importModule('CursorManager.js')]);
const indexOf = node => Array.from(node.parentNode.childNodes).indexOf(node);

// Domino has no Range or Selection. Keep real DOM nodes and model only the
// boundary operations used by the editor's horizontal navigation.
class TestRange {
    constructor() { this.collapsed = true; }
    get commonAncestorContainer() { return this.startContainer; }
    setStart(node, offset) {
        this.startContainer = this.endContainer = node;
        this.startOffset = this.endOffset = offset;
        this.collapsed = true;
    }
    setEnd(node, offset) {
        this.endContainer = node;
        this.endOffset = offset;
        this.collapsed = node === this.startContainer && offset === this.startOffset;
    }
    setStartBefore(node) { this.setStart(node.parentNode, indexOf(node)); }
    setStartAfter(node) { this.setStart(node.parentNode, indexOf(node) + 1); }
    setEndAfter(node) { this.setEnd(node.parentNode, indexOf(node) + 1); }
    selectNode(node) { this.setStartBefore(node); this.setEndAfter(node); }
    selectNodeContents(node) { this.setStart(node, 0); this.setEnd(node, node.childNodes.length); }
    collapse(toStart) {
        if (toStart) this.setStart(this.startContainer, this.startOffset);
        else this.setStart(this.endContainer, this.endOffset);
    }
    cloneRange() { return Object.assign(new TestRange(), this); }
    compareBoundaryPoints(_how, other) {
        return this.startContainer === other.startContainer && this.startOffset === other.startOffset ? 0 : 1;
    }
    getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; }
    getClientRects() { return []; }
    toString() { return ''; }
}
TestRange.START_TO_START = 0;
TestRange.END_TO_END = 2;

async function fixture(html) {
    const [{ DOMUtils }, { CursorManager }] = await modules;
    const window = domino.createWindow(`<div id="editor">${html}</div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    let range;
    const selection = {
        get rangeCount() { return range ? 1 : 0; },
        get isCollapsed() { return !!range?.collapsed; },
        getRangeAt: () => range,
        removeAllRanges() { range = null; },
        addRange(next) { range = next; },
    };
    document.createRange = () => new TestRange();
    document.elementFromPoint = () => null;
    document.caretRangeFromPoint = () => null;
    window.getSelection = () => selection;
    window.getComputedStyle = () => ({ display: 'block', lineHeight: '20px', fontSize: '16px' });
    window.HTMLElement.prototype.getBoundingClientRect = TestRange.prototype.getBoundingClientRect;
    window.HTMLElement.prototype.getClientRects = () => [];
    const previous = { window: global.window, document: global.document, Node: global.Node, NodeFilter: global.NodeFilter, Range: global.Range };
    Object.assign(global, { window, document, Node: window.Node, NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 }, Range: TestRange });
    const prototype = Object.getPrototypeOf(editor.querySelectorAll('li'));
    const previousForEach = prototype.forEach;
    prototype.forEach = Array.prototype.forEach;
    const manager = new CursorManager(editor, new DOMUtils(editor));
    return {
        editor, manager, selection,
        place(node, offset) { range = new TestRange(); range.setStart(node, offset); },
        restore() {
            if (previousForEach === undefined) delete prototype.forEach;
            else prototype.forEach = previousForEach;
            Object.assign(global, previous);
        },
    };
}

const images = [
    '<img src="image.png">',
    '<a href="image.png"><img src="image.png"></a>',
    '<p><img src="image.png"></p>',
];

for (const nested of [false, true]) {
    test(`ArrowLeft from ${nested ? 'a child' : 'the next'} item reaches the image right edge`, async () => {
        for (const imageHtml of images) {
            const after = '<li id="after">next</li>';
            const html = nested
                ? `<ul><li>${imageHtml}<ul>${after}</ul></li></ul>`
                : `<ul><li>${imageHtml}</li>${after}</ul>`;
            const f = await fixture(html);
            try {
                const image = f.editor.querySelector('img');
                f.place(f.editor.querySelector('#after').firstChild, 0);
                assert.equal(f.manager.moveCursorBackward(), true);
                assert.equal(f.manager._isCollapsedRangeAtNodeBoundary(f.selection.getRangeAt(0), image, 'after'), true, imageHtml);
                assert.equal(image.closest('li').textContent, nested ? 'next' : '', 'navigation does not add a visible placeholder');
            } finally { f.restore(); }
        }
    });
}

test('ArrowLeft from an empty child item reaches the parent image right edge', async () => {
    for (const imageHtml of images) {
        for (const placeholder of ['<br>', '\u00a0']) {
            const f = await fixture(`<ul><li>${imageHtml}<ul><li id="after" data-preserve-empty="true">${placeholder}</li></ul></li></ul>`);
            try {
                const image = f.editor.querySelector('img');
                const child = f.editor.querySelector('#after');
                const node = child.firstChild.nodeType === 3 ? child.firstChild : child;
                f.place(node, 0);
                assert.equal(f.manager.moveCursorBackward(), true);
                assert.equal(f.manager._isCollapsedRangeAtNodeBoundary(f.selection.getRangeAt(0), image, 'after'), true, imageHtml);
            } finally { f.restore(); }
        }
    }
});

test('ArrowLeft from the next item reaches a trailing image after the previous item text', async () => {
    const f = await fixture('<ul><li>caption<p><img src="image.png"></p></li><li id="after">next</li></ul>');
    try {
        const image = f.editor.querySelector('img');
        f.place(f.editor.querySelector('#after').firstChild, 0);
        assert.equal(f.manager.moveCursorBackward(), true);
        assert.equal(f.manager._isCollapsedRangeAtNodeBoundary(f.selection.getRangeAt(0), image, 'after'), true);
    } finally { f.restore(); }
});

test('ArrowRight into an image item reaches its left edge without inserting a blank line', async () => {
    for (const imageHtml of images) {
        const f = await fixture(`<ul><li id="before">prev</li><li>${imageHtml}<ul><li>child</li></ul></li></ul>`);
        try {
            const image = f.editor.querySelector('img');
            const before = f.editor.innerHTML;
            f.place(f.editor.querySelector('#before').firstChild, 4);
            assert.equal(f.manager.moveCursorForward(), true);
            assert.equal(f.manager._isCollapsedRangeAtNodeBoundary(f.selection.getRangeAt(0), image, 'before'), true, imageHtml);
            assert.equal(f.editor.innerHTML, before, 'moving to the image must not insert NBSP before it');
        } finally { f.restore(); }
    }
});

test('ArrowRight from the image right edge visits an empty child before leaving the list', async () => {
    for (const imageHtml of images) {
        for (const placeholder of ['<br>', '\u00a0']) {
            const f = await fixture(`<ul><li>${imageHtml}<ul><li id="child" data-preserve-empty="true">${placeholder}</li></ul></li></ul><p>outside</p>`);
            try {
                const image = f.editor.querySelector('img');
                const child = f.editor.querySelector('#child');
                const edge = new TestRange();
                f.manager._collapseRangeAfterNode(edge, image);
                f.selection.addRange(edge);
                assert.equal(f.manager.moveCursorForward(), true);
                assert.ok(child.contains(f.selection.getRangeAt(0).startContainer), imageHtml);
                assert.equal(image.closest('li').querySelector('#child'), child);
            } finally { f.restore(); }
        }
    }
});
