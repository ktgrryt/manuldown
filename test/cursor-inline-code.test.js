const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const cursorManagerSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'CursorManager.js'),
    'utf8'
);
const editorSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'editor.js'),
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
        if (this.endContainer === root && root.nodeType === 1) {
            return Array.from(root.childNodes || [])
                .slice(0, Math.max(0, Math.min(this.endOffset, root.childNodes.length)))
                .map(node => node.textContent || '')
                .join('');
        }
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
        this.normalizeAddedRange = null;
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
        this._range = typeof this.normalizeAddedRange === 'function'
            ? (this.normalizeAddedRange(range) || range)
            : range;
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
        getCaretAnchorOffset: node => node?.mdwCaretAnchor?.text === node?.textContent
            ? node.mdwCaretAnchor.offset : -1,
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
        editor,
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
    const boundary = fixture.manager._getInlineCodeBoundaryElement(fixture.code);
    if (fixture.code.contains(node)) {
        const textBeforeCaret = node === fixture.code
            ? Array.from(fixture.code.childNodes || [])
                .slice(0, offset)
                .map(child => child.textContent || '')
                .join('')
            : (node.data || '').slice(0, offset);
        const logicalOffset = textBeforeCaret
            .replace(/[\u200B\u2060\uFEFF]/g, '')
            .length;
        return `code:${logicalOffset}`;
    }
    if (node.nodeType === 3 && node.data.replace(/[\u200B\u2060\uFEFF]/g, '') === '') {
        if (node.nextSibling === boundary) {
            return 'outside-left';
        }
        if (node.previousSibling === boundary) {
            return 'outside-right';
        }
    }
    if (node.nodeType === 3) {
        const raw = node.data || '';
        let trailingBoundaryStart = raw.length;
        while (trailingBoundaryStart > 0 && /[\u200B\u2060\uFEFF]/.test(raw[trailingBoundaryStart - 1])) {
            trailingBoundaryStart--;
        }
        const nextSibling = node.nextSibling;
        const inlineCodeAfterBoundary = nextSibling === boundary || (
            nextSibling &&
            nextSibling.nodeType === 3 &&
            nextSibling.data.replace(/[\u200B\u2060\uFEFF]/g, '') === '' &&
            nextSibling.nextSibling === boundary
        );
        if (inlineCodeAfterBoundary && offset >= trailingBoundaryStart) {
            return 'outside-left';
        }
        return `${node.data}:${offset}`;
    }
    return `${node.tagName}:${offset}`;
}

test('right arrow visits both sides of each inline-code boundary', async () => {
    const fixture = await createInlineCodeFixture();
    try {
        const positions = [describeCaret(fixture)];
        for (let i = 0; i < 6; i++) {
            assert.equal(fixture.manager.moveCursorForward(), true);
            positions.push(describeCaret(fixture));
        }
        assert.deepEqual(positions, [
            'a:0',
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

test('the visible text end is outside-left and enters the real inside boundary in one keypress', async () => {
    const fixture = await createInlineCodeFixture();
    try {
        const beforeCodeRange = new TestRange();
        beforeCodeRange.setStart(fixture.paragraph.firstChild, 1);
        beforeCodeRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(beforeCodeRange);

        assert.equal(describeCaret(fixture), 'outside-left');

        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(describeCaret(fixture), 'code:0');
        assert.equal(fixture.selection.getRangeAt(0).startContainer, fixture.code);
        assert.equal(fixture.selection.getRangeAt(0).startOffset, 1);
        assert.equal(
            fixture.code.firstChild.getAttribute('data-inline-code-left-caret-anchor'),
            'true'
        );
        assert.equal(fixture.code.textContent, 'bc');
        assert.equal(fixture.code.previousSibling.data, 'a');
    } finally {
        fixture.restoreGlobals();
    }
});

test('inside-left is not reported as successful if Selection is normalized outside code', async () => {
    const fixture = await createInlineCodeFixture();
    try {
        const beforeCodeRange = new TestRange();
        beforeCodeRange.setStart(fixture.paragraph.firstChild, 1);
        beforeCodeRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(beforeCodeRange);

        fixture.selection.normalizeAddedRange = (range) => {
            if (
                range.startContainer === fixture.code &&
                range.startOffset === 1 &&
                fixture.code.firstChild?.getAttribute?.('data-inline-code-left-caret-anchor') === 'true'
            ) {
                const normalized = new TestRange();
                const codeIndex = Array.from(fixture.paragraph.childNodes).indexOf(fixture.code);
                normalized.setStart(fixture.paragraph, codeIndex);
                normalized.collapse(true);
                return normalized;
            }
            return range;
        };

        assert.equal(fixture.manager._placeCursorInsideInlineCodeStart(
            fixture.code,
            fixture.selection
        ), false);
        assert.equal(fixture.manager._inlineCodeLeftBoundaryState, null);
        assert.equal(fixture.selection.getRangeAt(0).startContainer, fixture.paragraph);
    } finally {
        fixture.restoreGlobals();
    }
});

test('a code-only first block enters inside-left from an editor-level normalized range', async () => {
    const fixture = await createInlineCodeFixture({ before: '', codeText: 'aaa', after: '' });
    try {
        const insideLeftRange = new TestRange();
        insideLeftRange.setStart(fixture.code.firstChild, 0);
        insideLeftRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(insideLeftRange);

        assert.equal(fixture.manager.moveCursorBackward(), true);
        assert.equal(fixture.manager._inlineCodeLeftBoundaryState?.zone, 'outside-left');

        // Chromium can lift the caret from the leading <code> through <p> to
        // the boundary before the whole first block: editor, offset 0.
        const normalizedRange = new TestRange();
        normalizedRange.setStart(fixture.editor, 0);
        normalizedRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(normalizedRange);

        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(fixture.manager._inlineCodeLeftBoundaryState?.zone, 'inside-left');
        assert.equal(describeCaret(fixture), 'code:0');
        assert.equal(fixture.selection.getRangeAt(0).startOffset, 1);
    } finally {
        fixture.restoreGlobals();
    }
});

test('an editor-level code-only boundary enters inside-left even if logical state was lost', async () => {
    const fixture = await createInlineCodeFixture({ before: '', codeText: 'aaa', after: '' });
    try {
        fixture.manager.clearInlineCodeBoundaryState();
        const normalizedRange = new TestRange();
        normalizedRange.setStart(fixture.editor, 0);
        normalizedRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(normalizedRange);

        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(fixture.manager._inlineCodeLeftBoundaryState?.zone, 'inside-left');
        assert.equal(describeCaret(fixture), 'code:0');
        assert.equal(fixture.selection.getRangeAt(0).startOffset, 1);
    } finally {
        fixture.restoreGlobals();
    }
});

test('editor routes a valid active inline-code boundary before competing arrow handlers', () => {
    const activeRoute = editorSource.indexOf('const isPlainInlineBoundaryArrow =');
    const movedResult = editorSource.indexOf('const moved =', activeRoute);
    const movedGuard = editorSource.indexOf('if (moved) {', movedResult);
    const preventDefault = editorSource.indexOf('e.preventDefault();', movedGuard);
    const tableRoute = editorSource.indexOf('if (tableManager.handleArrowKeydown(e)) {', activeRoute);
    const nativeTopLineRoute = editorSource.indexOf('if (shouldUseNativeArrowForTopLine(e)) {', activeRoute);
    const inlineExitRoute = editorSource.indexOf('if (moveCursorOutOfInlineCodeRight()) {', activeRoute);

    assert.notEqual(activeRoute, -1);
    assert.notEqual(movedResult, -1);
    assert.notEqual(movedGuard, -1);
    assert.notEqual(preventDefault, -1);
    assert.notEqual(tableRoute, -1);
    assert.notEqual(nativeTopLineRoute, -1);
    assert.notEqual(inlineExitRoute, -1);
    assert.ok(activeRoute < movedResult);
    assert.ok(movedResult < movedGuard);
    assert.ok(movedGuard < preventDefault);
    assert.ok(preventDefault < tableRoute);
    assert.ok(activeRoute < nativeTopLineRoute);
    assert.ok(activeRoute < inlineExitRoute);
});

test('clicks beside inline code are corrected on mouseup for table cells and gap clicks alike', () => {
    const mouseDown = editorSource.indexOf('// mousedownイベント - 箇条書きでのカーソル位置を修正');
    const recordClick = editorSource.indexOf('pendingInlineCodeSideClick = { startX:', mouseDown);
    const tableRoute = editorSource.indexOf('if (tableManager.handleMouseDown(e)) {', mouseDown);
    const gapRoute = editorSource.indexOf('if (!e.shiftKey && isEditorGapClick) {', mouseDown);
    const mouseUp = editorSource.indexOf("document.addEventListener('mouseup', (e) => {", mouseDown);
    const applyClick = editorSource.indexOf('placeCaretAtInlineCodeAfterClick(', mouseUp);

    assert.notEqual(mouseDown, -1);
    assert.notEqual(recordClick, -1);
    assert.notEqual(tableRoute, -1);
    assert.notEqual(gapRoute, -1);
    assert.notEqual(applyClick, -1);
    // Cell clicks return from mousedown at the table route, so recording must
    // come first; the correction itself must not depend on the gap branch.
    assert.ok(recordClick < tableRoute);
    assert.ok(tableRoute < gapRoute);
    assert.ok(mouseUp < applyClick);
});

test('the editor propagates its Webview cache key to CursorManager', () => {
    assert.match(
        editorSource,
        /await import\(`\.\/modules\/CursorManager\.js\$\{new URL\(import\.meta\.url\)\.search\}`\)/
    );
});

test('only an idle plain horizontal arrow may pass a stale IME keyCode guard', async () => {
    const { shouldRouteHorizontalArrowAfterComposition } = await cursorManagerModulePromise;
    const idleArrow = {
        key: 'ArrowRight',
        keyCode: 229,
        isComposing: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
    };

    assert.equal(shouldRouteHorizontalArrowAfterComposition(idleArrow, false), true);
    assert.equal(shouldRouteHorizontalArrowAfterComposition({ ...idleArrow, isComposing: true }, true), false);
    assert.equal(shouldRouteHorizontalArrowAfterComposition(idleArrow, true), false);
    assert.equal(shouldRouteHorizontalArrowAfterComposition({ ...idleArrow, key: 'Enter' }, false), false);
    assert.equal(shouldRouteHorizontalArrowAfterComposition({ ...idleArrow, shiftKey: true }, false), false);
});

test('inside-left uses one stable address without discarding unmarked zero-width text', async () => {
    const fixture = await createInlineCodeFixture();
    try {
        fixture.code.firstChild.data = INLINE_CODE_LEFT_CARET_ANCHOR;
        fixture.code.appendChild(document.createTextNode('bc'));
        const beforeCodeRange = new TestRange();
        beforeCodeRange.setStart(fixture.paragraph.firstChild, 1);
        beforeCodeRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(beforeCodeRange);

        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(describeCaret(fixture), 'code:0');
        assert.equal(fixture.selection.getRangeAt(0).startContainer, fixture.code);
        assert.equal(fixture.selection.getRangeAt(0).startOffset, 1);
        assert.equal(fixture.code.childNodes.length, 2);
        assert.equal(
            fixture.code.firstChild.getAttribute('data-inline-code-left-caret-anchor'),
            'true'
        );
        assert.equal(fixture.code.lastChild.data, INLINE_CODE_LEFT_CARET_ANCHOR + 'bc');
    } finally {
        fixture.restoreGlobals();
    }
});

test('a stale inline-code boundary state does not claim an unrelated selection', async () => {
    const fixture = await createInlineCodeFixture();
    try {
        const beforeCodeRange = new TestRange();
        beforeCodeRange.setStart(fixture.paragraph.firstChild, 1);
        beforeCodeRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(beforeCodeRange);

        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(fixture.manager.hasActiveInlineCodeBoundaryState(), true);

        const unrelatedRange = new TestRange();
        unrelatedRange.setStart(fixture.paragraph.lastChild, 0);
        unrelatedRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(unrelatedRange);

        assert.equal(fixture.manager.hasActiveInlineCodeBoundaryState(), false);
        assert.equal(fixture.manager._inlineCodeLeftBoundaryState, null);
    } finally {
        fixture.restoreGlobals();
    }
});

test('entering inline code preserves newly pasted zero-width characters without source attributes', async () => {
    const text = 'a\u200bb\u2060c\ufeffd';
    const fixture = await createInlineCodeFixture({ codeText: text });
    try {
        assert.equal(fixture.manager._placeCursorInsideInlineCodeStart(fixture.code, fixture.selection), true);
        assert.equal(fixture.code.textContent, text);
    } finally {
        fixture.restoreGlobals();
    }
});

test('an outside-left state never rewinds an actual logical offset one', async () => {
    const fixture = await createInlineCodeFixture();
    try {
        const beforeCodeRange = new TestRange();
        beforeCodeRange.setStart(fixture.paragraph.firstChild, 1);
        beforeCodeRange.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(beforeCodeRange);

        assert.equal(fixture.manager._placeCursorBeforeInlineCodeElement(
            fixture.code,
            fixture.selection
        ), true);
        assert.equal(fixture.manager._inlineCodeLeftBoundaryState?.zone, 'outside-left');

        assert.equal(fixture.manager._placeCursorInsideInlineCodeStart(
            fixture.code,
            fixture.selection
        ), true);
        fixture.manager._setInlineCodeLeftBoundaryState(fixture.code, 'outside-left');
        const codeTextNode = fixture.code.lastChild;

        const alreadyAfterFirstCharacter = new TestRange();
        alreadyAfterFirstCharacter.setStart(codeTextNode, 1);
        alreadyAfterFirstCharacter.collapse(true);
        fixture.selection.removeAllRanges();
        fixture.selection.addRange(alreadyAfterFirstCharacter);

        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(fixture.manager._inlineCodeLeftBoundaryState, null);
        assert.equal(describeCaret(fixture), 'code:2');
        assert.equal(codeTextNode.data, 'bc');
    } finally {
        fixture.restoreGlobals();
    }
});

test('stable left boundary preserves every visible step across repeated round trips', async () => {
    const fixture = await createInlineCodeFixture();
    try {
        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(describeCaret(fixture), 'outside-left');

        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(describeCaret(fixture), 'code:0');
        const insideMarker = fixture.code.firstChild;
        const codeTextNode = fixture.code.lastChild;

        assert.equal(fixture.manager.moveCursorBackward(), true);
        assert.equal(describeCaret(fixture), 'outside-left');
        assert.equal(fixture.manager.moveCursorBackward(), true);
        assert.equal(describeCaret(fixture), 'a:0');

        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(describeCaret(fixture), 'outside-left');
        assert.equal(fixture.manager.moveCursorForward(), true);
        assert.equal(describeCaret(fixture), 'code:0');

        assert.equal(fixture.code.previousSibling.data, 'a');
        assert.equal(fixture.code.firstChild, insideMarker);
        assert.equal(fixture.code.lastChild, codeTextNode);
        assert.equal(codeTextNode.data, 'bc');
        assert.equal(fixture.selection.getRangeAt(0).startContainer, fixture.code);
        assert.equal(fixture.selection.getRangeAt(0).startOffset, 1);
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
        assert.equal(fixture.selection.getRangeAt(0).startContainer, fixture.code);
        assert.equal(fixture.selection.getRangeAt(0).startOffset, 1);
        assert.equal(codeTextNode.data, 'aaa');
        assert.equal(
            fixture.code.firstChild.getAttribute('data-inline-code-left-caret-anchor'),
            'true'
        );

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
        assert.equal(describeCaret(fixture), 'code:0');
        assert.equal(fixture.selection.getRangeAt(0).startContainer, fixture.code);
        assert.equal(fixture.selection.getRangeAt(0).startOffset, 1);

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
        for (let i = 0; i < 6; i++) {
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
            'a:0',
        ]);
        assert.deepEqual(handled, Array(6).fill(true));
    } finally {
        fixture.restoreGlobals();
    }
});

for (const codeText of ['', '\u200B']) {
    test(`arrows cross an empty inline code in both directions (${JSON.stringify(codeText)})`, async () => {
        const fixture = await createInlineCodeFixture({ codeText });
        try {
            if (codeText) {
                fixture.code.setAttribute('data-is-new', 'true');
                fixture.code.firstChild.mdwCaretAnchor = codeText;
            }
            const forward = [describeCaret(fixture)];
            for (let i = 0; i < 4; i++) {
                assert.equal(fixture.manager.moveCursorForward(), true);
                forward.push(describeCaret(fixture));
            }
            assert.deepEqual(forward, [
                'a:0', 'outside-left', 'code:0', 'outside-right', 'd:1',
            ]);

            const backward = [describeCaret(fixture)];
            for (let i = 0; i < 4; i++) {
                assert.equal(fixture.manager.moveCursorBackward(), true);
                backward.push(describeCaret(fixture));
            }
            assert.deepEqual(backward, forward.toReversed());
        } finally {
            fixture.restoreGlobals();
        }
    });

    test(`left arrow enters an empty inline code before visiting the preceding text (${JSON.stringify(codeText)})`, async () => {
        const fixture = await createInlineCodeFixture({ codeText });
        try {
            const endRange = new TestRange();
            endRange.setStart(fixture.paragraph.lastChild, 1);
            endRange.collapse(true);
            fixture.selection.removeAllRanges();
            fixture.selection.addRange(endRange);

            const positions = [describeCaret(fixture)];
            for (let i = 0; i < 4; i++) {
                assert.equal(fixture.manager.moveCursorBackward(), true);
                positions.push(describeCaret(fixture));
            }
            assert.deepEqual(positions, [
                'd:1', 'outside-right', 'code:0', 'outside-left', 'a:0',
            ]);
        } finally {
            fixture.restoreGlobals();
        }
    });

    test(`an empty code-only line keeps one inside position between its outside edges (${JSON.stringify(codeText)})`, async () => {
        const fixture = await createInlineCodeFixture({ before: '', codeText, after: '' });
        try {
            fixture.manager._placeCursorBeforeInlineCodeElement(fixture.code, fixture.selection);
            const positions = [describeCaret(fixture)];
            for (let i = 0; i < 2; i++) {
                assert.equal(fixture.manager.moveCursorForward(), true);
                positions.push(describeCaret(fixture));
            }
            assert.deepEqual(positions, ['outside-left', 'code:0', 'outside-right']);
            for (let i = 0; i < 2; i++) {
                assert.equal(fixture.manager.moveCursorBackward(), true);
                assert.equal(describeCaret(fixture), positions[1 - i]);
            }
        } finally {
            fixture.restoreGlobals();
        }
    });
}

test('first-line arrows use custom navigation for the step reaching an inline-code boundary', async () => {
    const fixture = await createInlineCodeFixture({ before: 'abc', codeText: '', after: 'def' });
    try {
        const start = editorSource.indexOf('    function isCaretAdjacentToInlineCode(');
        const end = editorSource.indexOf('    function moveVerticallyAcrossBlockImages(', start);
        const shouldUseNativeArrowForTopLine = new Function('editor', 'domUtils', 'cursorManager', `
            ${editorSource.slice(start, end)}
            const isInlineCodeNode = node => node?.tagName === 'CODE';
            const isCursorOnCheckbox = () => false;
            const isHRSelected = () => false;
            const getTopLevelBlock = () => editor.firstChild;
            const isAtEscapedMarkdownLineHead = () => false;
            const isCaretNearBlockTop = () => true;
            const getPreviousTopLevelNavigableSibling = () => null;
            const isRangeOnFirstLogicalLineInTopLevelNode = () => true;
            return shouldUseNativeArrowForTopLine;
        `)(fixture.editor, createDomUtils(fixture.editor), fixture.manager);

        for (const [node, offset, key, expected] of [
            [fixture.paragraph.firstChild, 2, 'ArrowRight', false],
            [fixture.paragraph.lastChild, 1, 'ArrowLeft', false],
            [fixture.paragraph.firstChild, 0, 'ArrowRight', true],
            [fixture.paragraph.lastChild, 2, 'ArrowLeft', true],
        ]) {
            const range = new TestRange();
            range.setStart(node, offset);
            range.collapse(true);
            fixture.selection.removeAllRanges();
            fixture.selection.addRange(range);
            assert.equal(shouldUseNativeArrowForTopLine({ key }), expected);
        }
    } finally {
        fixture.restoreGlobals();
    }
});

test('inline-code arrows move by whole graphemes, including emoji, accents and joined emoji', async () => {
    const codeText = '🙂e\u0301👨‍👩‍👧‍👦';
    const fixture = await createInlineCodeFixture({ codeText });
    try {
        const expected = ['a:0', 'outside-left', 'code:0', 'code:2', 'code:4', `code:${codeText.length}`, 'outside-right', 'd:1'];
        const positions = [describeCaret(fixture)];
        for (let i = 1; i < expected.length; i++) {
            assert.equal(fixture.manager.moveCursorForward(), true);
            positions.push(describeCaret(fixture));
        }
        assert.deepEqual(positions, expected);
        for (const position of expected.slice(0, -1).reverse()) {
            assert.equal(fixture.manager.moveCursorBackward(), true);
            assert.equal(describeCaret(fixture), position);
        }
    } finally {
        fixture.restoreGlobals();
    }
});

for (const tag of ['strong', 'em', 'a']) {
    test(`code inside ${tag} retains every boundary in both directions`, async () => {
        const fixture = await createInlineCodeFixture();
        try {
            const wrapper = document.createElement(tag);
            fixture.paragraph.replaceChild(wrapper, fixture.code);
            wrapper.appendChild(fixture.code);
            const expected = ['a:0', 'outside-left', 'code:0', 'code:1', 'code:2', 'outside-right', 'd:1'];
            const positions = [describeCaret(fixture)];
            for (let i = 1; i < expected.length; i++) {
                assert.equal(fixture.manager.moveCursorForward(), true);
                positions.push(describeCaret(fixture));
            }
            assert.deepEqual(positions, expected);
            for (const position of expected.slice(0, -1).reverse()) {
                assert.equal(fixture.manager.moveCursorBackward(), true);
                assert.equal(describeCaret(fixture), position);
            }
        } finally {
            fixture.restoreGlobals();
        }
    });
}

for (const direction of ['forward', 'backward']) {
    test(`${direction} arrow collapses selected code at the selection edge before moving`, async () => {
        const fixture = await createInlineCodeFixture();
        try {
            const range = new TestRange();
            range.setStart(fixture.code.firstChild, 0);
            range.setEnd(fixture.code.firstChild, 2);
            fixture.selection.removeAllRanges();
            fixture.selection.addRange(range);
            const move = direction === 'forward' ? 'moveCursorForward' : 'moveCursorBackward';
            assert.equal(fixture.manager[move](), true);
            assert.equal(describeCaret(fixture), direction === 'forward' ? 'code:2' : 'code:0');
            assert.equal(fixture.manager[move](), true);
            assert.equal(describeCaret(fixture), direction === 'forward' ? 'outside-right' : 'outside-left');
        } finally {
            fixture.restoreGlobals();
        }
    });
}
