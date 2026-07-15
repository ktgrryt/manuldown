const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const cursorManagerSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'CursorManager.js'),
    'utf8'
);
const cursorManagerModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(cursorManagerSource).toString('base64')}`
);
const INLINE_CODE_LEFT_CARET_ANCHOR = '\uFEFF';
const INLINE_CODE_RIGHT_CARET_ANCHOR = '\u200B';

class TestRange {
    constructor() {
        this.startContainer = null;
        this.startOffset = 0;
        this.endContainer = null;
        this.endOffset = 0;
        this.collapsed = true;
        this._selectedContents = null;
    }

    get commonAncestorContainer() {
        if (this.startContainer === this.endContainer) {
            return this.startContainer;
        }
        let current = this.startContainer;
        while (current) {
            if (current.contains?.(this.endContainer)) {
                return current;
            }
            current = current.parentNode;
        }
        return this.startContainer;
    }

    setStart(container, offset) {
        this.startContainer = container;
        this.startOffset = offset;
        if (this.collapsed || !this.endContainer) {
            this.endContainer = container;
            this.endOffset = offset;
        }
        this.collapsed = this.startContainer === this.endContainer &&
            this.startOffset === this.endOffset;
    }

    setEnd(container, offset) {
        this.endContainer = container;
        this.endOffset = offset;
        this.collapsed = this.startContainer === this.endContainer &&
            this.startOffset === this.endOffset;
    }

    collapse(toStart) {
        if (toStart) {
            this.endContainer = this.startContainer;
            this.endOffset = this.startOffset;
        } else {
            this.startContainer = this.endContainer;
            this.startOffset = this.endOffset;
        }
        this.collapsed = true;
    }

    selectNodeContents(node) {
        this._selectedContents = node;
        this.startContainer = node;
        this.startOffset = 0;
        this.endContainer = node;
        this.endOffset = node.childNodes?.length || 0;
        this.collapsed = false;
    }

    cloneRange() {
        const clone = new TestRange();
        clone.startContainer = this.startContainer;
        clone.startOffset = this.startOffset;
        clone.endContainer = this.endContainer;
        clone.endOffset = this.endOffset;
        clone.collapsed = this.collapsed;
        clone._selectedContents = this._selectedContents;
        return clone;
    }

    compareBoundaryPoints() {
        return 1;
    }

    toString() {
        if (!this._selectedContents) {
            return '';
        }
        const root = this._selectedContents;
        const textNodes = collectTextNodes(root);
        let end = 0;
        for (const textNode of textNodes) {
            if (textNode === this.endContainer) {
                end += Math.max(0, Math.min(this.endOffset, textNode.data.length));
                return root.textContent.slice(0, end);
            }
            end += textNode.data.length;
        }
        return root.textContent;
    }
}

TestRange.START_TO_START = 0;
TestRange.END_TO_END = 2;

class TestSelection {
    constructor(range) {
        this._range = range;
    }

    get rangeCount() {
        return this._range ? 1 : 0;
    }

    get isCollapsed() {
        return !!this._range?.collapsed;
    }

    getRangeAt() {
        return this._range;
    }

    removeAllRanges() {
        this._range = null;
    }

    addRange(range) {
        this._range = range;
    }
}

function collectTextNodes(root) {
    const result = [];
    const visit = (node) => {
        if (node.nodeType === 3) {
            result.push(node);
            return;
        }
        for (const child of Array.from(node.childNodes || [])) {
            visit(child);
        }
    };
    visit(root);
    return result;
}

function createDomUtils(editor) {
    const getParentElement = (node, tagName) => {
        let current = node?.nodeType === 1 ? node : node?.parentElement;
        while (current) {
            if (current.tagName === tagName) {
                return current;
            }
            if (current === editor) {
                break;
            }
            current = current.parentElement;
        }
        return null;
    };
    const allEditorTextNodes = () => collectTextNodes(editor);

    return {
        getParentElement,
        getTextNodes: collectTextNodes,
        getFirstTextNode: (element) => collectTextNodes(element)[0] || null,
        getLastTextNode: (element) => collectTextNodes(element).at(-1) || null,
        getNextTextNode: (node) => {
            const nodes = allEditorTextNodes();
            return nodes[nodes.indexOf(node) + 1] || null;
        },
        getPreviousTextNode: (node) => {
            const nodes = allEditorTextNodes();
            return nodes[nodes.indexOf(node) - 1] || null;
        },
        isBlockElement: (element) => ['P', 'DIV', 'LI'].includes(element?.tagName),
    };
}

async function createInlineCodeFixture(options = {}) {
    const before = options.before ?? 'a';
    const codeText = options.codeText ?? 'bc';
    const after = options.after ?? 'd';
    const domWindow = domino.createWindow(
        `<div id="editor"><p>${before}<code>${codeText}</code>${after}</p></div>`
    );
    const editor = domWindow.document.querySelector('#editor');
    const paragraph = editor.querySelector('p');
    const code = paragraph.querySelector('code');
    Object.defineProperty(code, 'isConnected', { get: () => true });

    const previousGlobals = {
        document: global.document,
        window: global.window,
        Node: global.Node,
        NodeFilter: global.NodeFilter,
        Range: global.Range,
    };
    const initialRange = new TestRange();
    const initialTextNode = paragraph.firstChild.nodeType === 3
        ? paragraph.firstChild
        : code.firstChild;
    initialRange.setStart(initialTextNode, 0);
    initialRange.collapse(true);
    const selection = new TestSelection(initialRange);

    domWindow.document.createRange = () => new TestRange();
    domWindow.getSelection = () => selection;
    global.document = domWindow.document;
    global.window = domWindow;
    global.Node = domWindow.Node;
    global.NodeFilter = {
        SHOW_TEXT: 4,
        FILTER_SKIP: 3,
        FILTER_ACCEPT: 1,
    };
    global.Range = TestRange;

    const { CursorManager } = await cursorManagerModulePromise;
    const manager = new CursorManager(editor, createDomUtils(editor));
    manager._normalizeSelectionForNavigation = () => false;
    manager._normalizeCollapsedImageAnchor = () => false;
    manager._getSelectedImageNode = () => null;
    manager._getImageAheadFromCollapsedRange = () => null;
    manager._getImageBehindFromCollapsedRange = () => null;

    return {
        manager,
        paragraph,
        code,
        selection,
        restoreGlobals: () => {
            for (const [key, value] of Object.entries(previousGlobals)) {
                if (value === undefined) {
                    delete global[key];
                } else {
                    global[key] = value;
                }
            }
        },
    };
}

function describeCaret(fixture) {
    const range = fixture.selection.getRangeAt(0);
    const node = range.startContainer;
    const offset = range.startOffset;
    if (fixture.code.contains(node)) {
        const logicalOffset = (node.data || '')
            .slice(0, offset)
            .replace(/[\u200B\u2060\uFEFF]/g, '')
            .length;
        return `code:${logicalOffset}`;
    }
    if (node.nodeType === 3 && node.data.replace(/[\u200B\u2060\uFEFF]/g, '') === '') {
        if (node.nextSibling === fixture.code) {
            return 'outside-left';
        }
        if (node.previousSibling === fixture.code) {
            return 'outside-right';
        }
    }
    if (node.nodeType === 3) {
        return `${node.data}:${offset}`;
    }
    return `${node.tagName}:${offset}`;
}

test('right arrow visits both sides of each inline-code boundary', async () => {
    const fixture = await createInlineCodeFixture();
    try {
        const positions = [describeCaret(fixture)];
        for (let i = 0; i < 7; i++) {
            assert.equal(fixture.manager.moveCursorForward(), true);
            positions.push(describeCaret(fixture));
        }
        assert.deepEqual(positions, [
            'a:0',
            'a:1',
            'outside-left',
            'code:0',
            'code:1',
            'code:2',
            'outside-right',
            'd:1',
        ]);
    } finally {
        fixture.restoreGlobals();
    }
});

test('normalized outside-left anchor does not skip the inline-code start', async () => {
    const fixture = await createInlineCodeFixture();
    try {
        const beforeCodeRange = new TestRange();
        beforeCodeRange.setStart(fixture.paragraph.firstChild, 1);
        beforeCodeRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(beforeCodeRange);

        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(describeCaret(fixture), 'outside-left');
        assert.equal(fixture.selection.getRangeAt(0).startContainer.data, INLINE_CODE_LEFT_CARET_ANCHOR);

        // Chromium WebView can expose the outside anchor as the first DOM point
        // inside <code>. The next keypress must establish inside-left without
        // advancing over the first code character.
        const normalizedRange = new TestRange();
        normalizedRange.setStart(fixture.code.firstChild, 0);
        normalizedRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(normalizedRange);

        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(describeCaret(fixture), 'code:0');
    } finally {
        fixture.restoreGlobals();
    }
});

test('an inline-code-only line has stable outside-left and outside-right carets', async () => {
    const fixture = await createInlineCodeFixture({ before: '', codeText: 'aaa', after: '' });
    try {
        const codeTextNode = fixture.code.firstChild;
        const insideLeftRange = new TestRange();
        insideLeftRange.setStart(codeTextNode, 0);
        insideLeftRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(insideLeftRange);

        assert.equal(fixture.manager.moveCursorBackward(), true);
        assert.equal(describeCaret(fixture), 'outside-left');
        assert.equal(fixture.selection.getRangeAt(0).startContainer.data, INLINE_CODE_LEFT_CARET_ANCHOR);

        assert.equal(fixture.manager.moveCursorBackward(), true);
        assert.equal(describeCaret(fixture), 'outside-left');
        assert.equal(fixture.selection.getRangeAt(0).startOffset, 1);

        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(describeCaret(fixture), 'code:0');

        const insideRightRange = new TestRange();
        insideRightRange.setStart(codeTextNode, codeTextNode.data.length);
        insideRightRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(insideRightRange);

        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(describeCaret(fixture), 'outside-right');
        assert.equal(fixture.selection.getRangeAt(0).startContainer.data, INLINE_CODE_RIGHT_CARET_ANCHOR);

        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(describeCaret(fixture), 'outside-right');
        assert.equal(fixture.selection.getRangeAt(0).startOffset, 1);

        assert.equal(fixture.manager.moveCursorBackward(), true);
        assert.equal(describeCaret(fixture), 'code:3');
    } finally {
        fixture.restoreGlobals();
    }
});

test('long surrounding text still stops at every inline-code boundary', async () => {
    const fixture = await createInlineCodeFixture({
        before: 'feaoj',
        codeText: 'fioafoiae',
        after: 'jofjfaioje',
    });
    try {
        const beforeNode = fixture.paragraph.firstChild;
        const afterNode = fixture.paragraph.lastChild;
        const codeTextNode = fixture.code.firstChild;
        const beforeCodeRange = new TestRange();
        beforeCodeRange.setStart(beforeNode, beforeNode.data.length);
        beforeCodeRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(beforeCodeRange);

        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(describeCaret(fixture), 'outside-left');
        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(describeCaret(fixture), 'code:0');

        const codeEndRange = new TestRange();
        codeEndRange.setStart(codeTextNode, codeTextNode.data.length);
        codeEndRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(codeEndRange);

        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(describeCaret(fixture), 'outside-right');
        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(fixture.selection.getRangeAt(0).startContainer, afterNode);
        assert.equal(fixture.selection.getRangeAt(0).startOffset, 1);
    } finally {
        fixture.restoreGlobals();
    }
});

test('left arrow reverses through both sides of each inline-code boundary', async () => {
    const fixture = await createInlineCodeFixture();
    try {
        const endRange = new TestRange();
        endRange.setStart(fixture.paragraph.lastChild, 1);
        endRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(endRange);

        const positions = [describeCaret(fixture)];
        const handled = [];
        for (let i = 0; i < 7; i++) {
            handled.push(fixture.manager.moveCursorBackward());
            positions.push(describeCaret(fixture));
        }
        assert.deepEqual(positions, [
            'd:1',
            'outside-right',
            'code:2',
            'code:1',
            'code:0',
            'outside-left',
            'a:1',
            'a:0',
        ]);
        assert.deepEqual(handled, Array(7).fill(true));
    } finally {
        fixture.restoreGlobals();
    }
});
