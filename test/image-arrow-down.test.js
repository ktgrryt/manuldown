const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

function importModule(relativePath) {
    const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const domUtilsModulePromise = importModule('media/modules/DOMUtils.js');
const cursorManagerModulePromise = importModule('media/modules/CursorManager.js');
const editorSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'editor.js'),
    'utf8'
);

function childIndex(node) {
    return Array.from(node.parentNode.childNodes).indexOf(node);
}

class TestRange {
    constructor() {
        this.startContainer = null;
        this.startOffset = 0;
        this.endContainer = null;
        this.endOffset = 0;
        this.collapsed = true;
    }

    get commonAncestorContainer() {
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

    setStartBefore(node) {
        this.setStart(node.parentNode, childIndex(node));
    }

    setStartAfter(node) {
        this.setStart(node.parentNode, childIndex(node) + 1);
    }

    setEndAfter(node) {
        this.setEnd(node.parentNode, childIndex(node) + 1);
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

    selectNode(node) {
        this.setStartBefore(node);
        this.setEndAfter(node);
    }

    selectNodeContents(node) {
        this.startContainer = node;
        this.startOffset = 0;
        this.endContainer = node;
        this.endOffset = node.childNodes.length;
        this.collapsed = false;
    }

    cloneRange() {
        return Object.assign(new TestRange(), this);
    }

    // Only equality is read by the editor code under test.
    compareBoundaryPoints(_how, other) {
        return this.startContainer === other.startContainer && this.startOffset === other.startOffset ? 0 : 1;
    }

    getBoundingClientRect() {
        return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    }

    getClientRects() {
        return [];
    }

    toString() {
        return '';
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

// The editor lives next to other Webview chrome, as it does in the real page,
// so a caret that leaves the editor is observable.
async function createFixture(editorHtml) {
    const domWindow = domino.createWindow(
        `<div id="editor">${editorHtml}</div><div id="toc-resizer"><p>outside</p></div>`
    );
    const editor = domWindow.document.getElementById('editor');
    domWindow.HTMLElement.prototype.getBoundingClientRect = () => (
        { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }
    );
    domWindow.HTMLElement.prototype.getClientRects = () => [];
    domWindow.document.createRange = () => new TestRange();
    domWindow.document.elementFromPoint = () => null;
    domWindow.document.caretRangeFromPoint = () => null;
    domWindow.getComputedStyle = () => ({ lineHeight: '20px', fontSize: '16px' });
    const selection = new TestSelection(null);
    domWindow.getSelection = () => selection;

    // Domino intentionally exposes a minimal NodeList. The production webview
    // provides NodeList#forEach, which isImageOnlyBlockElement uses.
    const nodeListPrototype = Object.getPrototypeOf(editor.querySelectorAll('img'));
    const previousForEach = nodeListPrototype.forEach;
    nodeListPrototype.forEach = Array.prototype.forEach;

    const previousGlobals = {
        document: global.document,
        window: global.window,
        Node: global.Node,
        NodeFilter: global.NodeFilter,
        Range: global.Range,
    };
    global.document = domWindow.document;
    global.window = domWindow;
    global.Node = domWindow.Node;
    global.NodeFilter = {
        SHOW_ELEMENT: 1,
        SHOW_TEXT: 4,
        FILTER_ACCEPT: 1,
        FILTER_REJECT: 2,
        FILTER_SKIP: 3,
    };
    global.Range = TestRange;

    const { DOMUtils } = await domUtilsModulePromise;
    const { CursorManager } = await cursorManagerModulePromise;
    const domUtils = new DOMUtils(editor);
    const cursorManager = new CursorManager(editor, domUtils);

    return {
        editor,
        domUtils,
        cursorManager,
        selection,
        placeCaret(container, offset) {
            const range = new TestRange();
            range.setStart(container, offset);
            range.collapse(true);
            selection.addRange(range);
            return range;
        },
        restoreGlobals() {
            nodeListPrototype.forEach = previousForEach;
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

function extractEditorFunction(name) {
    const start = editorSource.indexOf(`    function ${name}(`);
    assert.notEqual(start, -1, `${name} is defined in editor.js`);
    const end = editorSource.indexOf('\n    }\n', start);
    return editorSource.slice(start, end + '\n    }'.length);
}

function loadMoveCursorDownBelowTrailingImageBlock(fixture) {
    const sources = [
        'moveCursorDownBelowTrailingImageBlock',
        'isCaretOnTrailingImageLine',
        'getClosestBlockElement',
        'hasMeaningfulTextContent',
        'isImageOnlyBlockElement',
        'isNavigationExcludedElement',
        'getNextNavigableSibling',
        'getNextNavigableNodeAfter',
        'isEffectivelyEmptyBlock',
        'placeCaretInEmptyParagraph',
        'placeCollapsedCaret',
    ].map(extractEditorFunction);
    const notifications = [];
    const factory = new Function(
        'editor',
        'domUtils',
        'cursorManager',
        'notifyChange',
        'syncImageCaretEdgeIndicatorsNow',
        `${sources.join('\n\n')}\nreturn moveCursorDownBelowTrailingImageBlock;`
    );
    const moveDown = factory(
        fixture.editor,
        fixture.domUtils,
        fixture.cursorManager,
        () => notifications.push('change'),
        () => {}
    );
    return {
        notifications,
        moveDown: (range) => moveDown(range, fixture.selection),
    };
}

function assertCaretInNewParagraphAfter(fixture, imageBlock) {
    const paragraph = imageBlock.nextSibling;
    assert.equal(paragraph.tagName, 'P');
    assert.equal(paragraph.textContent, '​');
    const range = fixture.selection.getRangeAt(0);
    assert.equal(range.startContainer, paragraph.firstChild);
    assert.equal(range.startOffset, 1);
}

test('ArrowDown from an editor-level caret after the last block stays in the editor', async () => {
    const fixture = await createFixture('<p>abc</p><p><img src="image.png"></p>');
    try {
        fixture.placeCaret(fixture.editor, 2);
        // Without layout the visual probes fail, which reaches the structural
        // fallback the way a caret after the document's last block does.
        fixture.cursorManager._getCaretRect = () => (
            { left: 20, right: 20, top: 100, bottom: 120, width: 0, height: 20, x: 20, y: 100 }
        );

        fixture.cursorManager.moveCursorDown(() => {});

        const range = fixture.selection.getRangeAt(0);
        assert.equal(range.startContainer, fixture.editor);
        assert.equal(range.startOffset, 2);
    } finally {
        fixture.restoreGlobals();
    }
});

test('ArrowDown right after pasting a trailing image opens a line below it', async () => {
    const fixture = await createFixture('<p>abc</p><p><img src="image.png"></p>');
    try {
        const { moveDown, notifications } = loadMoveCursorDownBelowTrailingImageBlock(fixture);
        const imageBlock = fixture.editor.children[1];

        // A pasted image leaves the caret between top-level blocks.
        assert.equal(moveDown(fixture.placeCaret(fixture.editor, 2)), true);

        assertCaretInNewParagraphAfter(fixture, imageBlock);
        assert.equal(fixture.editor.children.length, 3);
        assert.deepEqual(notifications, ['change']);
    } finally {
        fixture.restoreGlobals();
    }
});

test('ArrowDown from either edge of a trailing image opens a line below it', async () => {
    for (const edge of ['left', 'right']) {
        const fixture = await createFixture('<p>abc</p><p><img src="image.png"></p>');
        try {
            const { moveDown } = loadMoveCursorDownBelowTrailingImageBlock(fixture);
            const imageBlock = fixture.editor.children[1];
            const image = imageBlock.querySelector('img');
            if (edge === 'right') {
                const anchor = fixture.editor.ownerDocument.createTextNode('');
                imageBlock.appendChild(anchor);
                fixture.placeCaret(anchor, 0);
            } else {
                fixture.placeCaret(imageBlock, childIndex(image));
            }

            assert.equal(moveDown(fixture.selection.getRangeAt(0)), true, edge);

            assertCaretInNewParagraphAfter(fixture, imageBlock);
        } finally {
            fixture.restoreGlobals();
        }
    }
});

test('a trailing image after text is its own last line', async () => {
    const fixture = await createFixture('<p>abc</p><p>text <img src="image.png"></p>');
    try {
        const { moveDown } = loadMoveCursorDownBelowTrailingImageBlock(fixture);
        const imageBlock = fixture.editor.children[1];
        const image = imageBlock.querySelector('img');

        // The text line above the image moves to the image, not past it.
        assert.equal(moveDown(fixture.placeCaret(imageBlock.firstChild, 2)), false);
        assert.equal(fixture.editor.children.length, 2);

        assert.equal(moveDown(fixture.placeCaret(imageBlock, childIndex(image))), true);

        assertCaretInNewParagraphAfter(fixture, imageBlock);
    } finally {
        fixture.restoreGlobals();
    }
});

test('the line opened below a trailing image goes before editor-only chrome', async () => {
    const fixture = await createFixture(
        '<p>abc</p><p><img src="image.png"></p>' +
        '<div class="md-table-insert-line" data-exclude-from-markdown="true" contenteditable="false"></div>'
    );
    try {
        const { moveDown } = loadMoveCursorDownBelowTrailingImageBlock(fixture);
        const imageBlock = fixture.editor.children[1];

        assert.equal(moveDown(fixture.placeCaret(fixture.editor, 2)), true);

        assertCaretInNewParagraphAfter(fixture, imageBlock);
        assert.equal(fixture.editor.lastElementChild.className, 'md-table-insert-line');
    } finally {
        fixture.restoreGlobals();
    }
});

test('ArrowDown leaves images that are not a trailing image-only block to normal navigation', async () => {
    const cases = [
        ['text below', '<p><img src="image.png"></p><p>def</p>', (editor) => [editor, 1]],
        ['inline with text', '<p>abc<img src="image.png"></p>', (editor) => [editor, 1]],
        ['empty trailing line', '<p>abc</p><p><br></p>', (editor) => [editor.children[1], 0]],
        ['image in a list item with text below', '<ul><li>a<p><img src="image.png"></p></li><li>b</li></ul>',
            (editor) => [editor.querySelector('li p'), 1]],
        ['image in a table cell', '<table><tbody><tr><td><p><img src="image.png"></p></td></tr></tbody></table>',
            (editor) => [editor.querySelector('td p'), 1]],
    ];
    for (const [name, html, caretAt] of cases) {
        const fixture = await createFixture(html);
        try {
            const { moveDown, notifications } = loadMoveCursorDownBelowTrailingImageBlock(fixture);
            const [container, offset] = caretAt(fixture.editor);

            assert.equal(moveDown(fixture.placeCaret(container, offset)), false, name);

            assert.equal(fixture.editor.innerHTML, html, name);
            assert.deepEqual(notifications, [], name);
        } finally {
            fixture.restoreGlobals();
        }
    }
});

test('ArrowDown from a trailing image in the last list item or quote opens a line after it', async () => {
    const cases = [
        ['list item', '<ul><li>a<p><img src="image.png"></p></li></ul>', 'li p'],
        ['image-only list item', '<ul><li>a</li><li><img src="image.png"></li></ul>', 'li:last-child'],
        ['quote', '<blockquote><p>q</p><p><img src="image.png"></p></blockquote>', 'blockquote p:last-child'],
    ];
    for (const [name, html, imageBlockSelector] of cases) {
        const fixture = await createFixture(html);
        try {
            const { moveDown, notifications } = loadMoveCursorDownBelowTrailingImageBlock(fixture);
            const imageBlock = fixture.editor.querySelector(imageBlockSelector);
            const container = fixture.editor.firstElementChild;

            assert.equal(moveDown(fixture.placeCaret(imageBlock, 1)), true, name);

            assertCaretInNewParagraphAfter(fixture, container);
            assert.deepEqual(notifications, ['change'], name);
        } finally {
            fixture.restoreGlobals();
        }
    }
});

function loadInsertImageBlockBesideTextLine(fixture) {
    const sources = [
        'insertImageBlockBesideTextLine',
        'isNodeBeforeCollapsedRange',
        'splitParagraphAtLineBreak',
        'hasMeaningfulTextContent',
    ].map(extractEditorFunction);
    const factory = new Function(
        'editor',
        'domUtils',
        `${sources.join('\n\n')}\nreturn insertImageBlockBesideTextLine;`
    );
    const insertBeside = factory(fixture.editor, fixture.domUtils);
    return (block, range) => {
        const imageBlock = fixture.editor.ownerDocument.createElement('p');
        imageBlock.appendChild(fixture.editor.ownerDocument.createElement('img'));
        insertBeside(imageBlock, block, range);
    };
}

// Places the caret `offset` characters into the first text node holding `text`.
function placeCaretInText(fixture, text, offset) {
    const textNode = fixture.domUtils.getTextNodes(fixture.editor)
        .find((node) => node.textContent.includes(text));
    return fixture.placeCaret(textNode, textNode.textContent.indexOf(text) + offset);
}

test('an image pasted into text gets its own line beside the caret line', async () => {
    const lines = '<p>abc<br>def<br>ghi</p>';
    const cases = [
        ['end of a line', lines, 'abc', 3, '<p>abc</p><p><img></p><p>def<br>ghi</p>'],
        ['start of a line', lines, 'def', 0, '<p>abc</p><p><img></p><p>def<br>ghi</p>'],
        ['middle of a line', lines, 'def', 1, '<p>abc<br>def</p><p><img></p><p>ghi</p>'],
        ['start of the first line', lines, 'abc', 0, '<p><img></p><p>abc<br>def<br>ghi</p>'],
        ['end of the last line', lines, 'ghi', 3, '<p>abc<br>def<br>ghi</p><p><img></p>'],
        ['line break inside bold', '<p><strong>abc<br>def</strong></p>', 'abc', 3,
            '<p><strong>abc</strong></p><p><img></p><p><strong>def</strong></p>'],
        ['start of a paragraph', '<p>abc</p><p>def</p>', 'def', 0, '<p>abc</p><p><img></p><p>def</p>'],
        ['middle of a paragraph', '<p>abc</p><p>def</p>', 'abc', 1, '<p>abc</p><p><img></p><p>def</p>'],
        ['start of a heading', '<h1>Title</h1><p>abc</p>', 'Title', 0, '<p><img></p><h1>Title</h1><p>abc</p>'],
        ['end of a heading', '<h1>Title</h1><p>abc</p>', 'Title', 5, '<h1>Title</h1><p><img></p><p>abc</p>'],
    ];
    for (const [name, html, text, offset, expected] of cases) {
        const fixture = await createFixture(html);
        try {
            const insertBeside = loadInsertImageBlockBesideTextLine(fixture);
            const range = placeCaretInText(fixture, text, offset);

            insertBeside(fixture.domUtils.getParentElement(range.startContainer, 'P') ||
                fixture.editor.querySelector('h1'), range);

            assert.equal(fixture.editor.innerHTML, expected, name);
        } finally {
            fixture.restoreGlobals();
        }
    }
});

test('an image pasted into a list item stays in it, below its text', async () => {
    const cases = [
        ['end of the item', '<ul><li>a1</li><li>b2</li></ul>', 'a1', 2,
            '<ul><li>a1<p><img></p></li><li>b2</li></ul>'],
        ['start of the item', '<ul><li>a1</li><li>b2</li></ul>', 'a1', 0,
            '<ul><li>a1<p><img></p></li><li>b2</li></ul>'],
        ['item with a nested list', '<ul><li>a1<ul><li>x</li></ul></li></ul>', 'a1', 2,
            '<ul><li>a1<p><img></p><ul><li>x</li></ul></li></ul>'],
        ['checkbox item', '<ul><li><input type="checkbox">a1</li></ul>', 'a1', 2,
            '<ul><li><input type="checkbox">a1<p><img></p></li></ul>'],
    ];
    for (const [name, html, text, offset, expected] of cases) {
        const fixture = await createFixture(html);
        try {
            const insertBeside = loadInsertImageBlockBesideTextLine(fixture);
            const range = placeCaretInText(fixture, text, offset);

            insertBeside(fixture.domUtils.getParentElement(range.startContainer, 'LI'), range);

            assert.equal(fixture.editor.innerHTML, expected, name);
        } finally {
            fixture.restoreGlobals();
        }
    }
});

function loadMoveCaretBelowImageForTextInput(fixture) {
    const sources = [
        'moveCaretToParagraphAfterImageRightEdgeForTextInput',
        'getImageAtCaretRightEdge',
        'getBackspaceTargetImageAtRightEdge',
        'isCollapsedRangeAtImageRightEdge',
        'getImageCaretAnchorNode',
        'createAfterImageCaretRange',
        'shouldCreateImageRightTextAnchor',
        'getImageRightCaretTextAnchor',
        'getSingleImageFromImageOnlyBlock',
        'rangesShareSameCaretPosition',
        'getClosestBlockElement',
        'isImageOnlyBlockElement',
        'hasMeaningfulTextContent',
        'isEffectivelyEmptyBlock',
        'createCollapsedRangeAtElementBoundary',
        'applySelectionRange',
    ].map(extractEditorFunction);
    const factory = new Function(
        'editor',
        'domUtils',
        'cursorManager',
        `${sources.join('\n\n')}\nreturn moveCaretToParagraphAfterImageRightEdgeForTextInput;`
    );
    return factory(fixture.editor, fixture.domUtils, fixture.cursorManager);
}

function assertCaretInEmptyLine(fixture, line) {
    assert.equal(line.tagName, 'P');
    assert.equal(line.innerHTML, '<br>');
    const range = fixture.selection.getRangeAt(0);
    assert.ok(range.startContainer === line || line.contains(range.startContainer));
}

test('text typed right after pasting an image goes on a new line below it', async () => {
    const cases = [
        ['text below', '<p>abc</p><p><img src="image.png"></p><p>def</p>'],
        ['end of the document', '<p>abc</p><p><img src="image.png"></p>'],
    ];
    for (const [name, html] of cases) {
        const fixture = await createFixture(html);
        try {
            const moveBelowImage = loadMoveCaretBelowImageForTextInput(fixture);
            const imageBlock = fixture.editor.children[1];
            // A pasted image leaves the caret between top-level blocks.
            fixture.placeCaret(fixture.editor, 2);

            assert.equal(moveBelowImage(), true, name);

            assertCaretInEmptyLine(fixture, imageBlock.nextSibling);
            assert.equal(imageBlock.innerHTML, '<img src="image.png">', name);
            if (name === 'text below') {
                assert.equal(imageBlock.nextSibling.nextSibling.textContent, 'def');
            }
        } finally {
            fixture.restoreGlobals();
        }
    }
});

test('text typed at the right edge of an image does not join the next line', async () => {
    const fixture = await createFixture('<p>abc</p><p><img src="image.png"></p><p>def</p>');
    try {
        const moveBelowImage = loadMoveCaretBelowImageForTextInput(fixture);
        const imageBlock = fixture.editor.children[1];
        const anchor = fixture.editor.ownerDocument.createTextNode('');
        imageBlock.appendChild(anchor);
        fixture.placeCaret(anchor, 0);

        assert.equal(moveBelowImage(), true);

        assertCaretInEmptyLine(fixture, imageBlock.nextSibling);
        assert.equal(fixture.editor.lastElementChild.textContent, 'def');
    } finally {
        fixture.restoreGlobals();
    }
});

test('an empty line below an image is reused for typing, but Enter opens another', async () => {
    for (const newLine of [false, true]) {
        const fixture = await createFixture('<p><img src="image.png"></p><p><br></p><p>def</p>');
        try {
            const moveBelowImage = loadMoveCaretBelowImageForTextInput(fixture);
            const emptyLine = fixture.editor.children[1];
            fixture.placeCaret(fixture.editor, 1);

            assert.equal(moveBelowImage({ newLine }), true);

            assert.equal(fixture.editor.children.length, newLine ? 4 : 3);
            assertCaretInEmptyLine(fixture, newLine ? fixture.editor.children[1] : emptyLine);
        } finally {
            fixture.restoreGlobals();
        }
    }
});

test('text typed at an image in a list item stays in that item', async () => {
    const fixture = await createFixture('<ul><li>a1<p><img src="image.png"></p></li><li>b2</li></ul>');
    try {
        const moveBelowImage = loadMoveCaretBelowImageForTextInput(fixture);
        const imageBlock = fixture.editor.querySelector('li p');
        fixture.placeCaret(imageBlock, 1);

        assert.equal(moveBelowImage(), true);

        assert.equal(imageBlock.nextSibling.parentNode.tagName, 'LI');
        assertCaretInEmptyLine(fixture, imageBlock.nextSibling);
    } finally {
        fixture.restoreGlobals();
    }
});

test('text typed after a text line is left where it is', async () => {
    const fixture = await createFixture('<p>abc</p><p>def</p>');
    try {
        const moveBelowImage = loadMoveCaretBelowImageForTextInput(fixture);
        fixture.placeCaret(fixture.editor, 1);

        assert.equal(moveBelowImage(), false);

        assert.equal(fixture.editor.innerHTML, '<p>abc</p><p>def</p>');
    } finally {
        fixture.restoreGlobals();
    }
});

test('only keys that type text, including the key that starts IME input, count as text input', () => {
    const isTextInputKeydown = new Function(
        `${extractEditorFunction('getKeyboardEventKeyCode')}\n` +
        `${extractEditorFunction('isTextInputKeydown')}\nreturn isTextInputKeydown;`
    )();
    const cases = [
        [{ key: 'a', keyCode: 65 }, true],
        [{ key: 'A', keyCode: 65, shiftKey: true }, true],
        [{ key: ' ', keyCode: 32 }, true],
        [{ key: 'Process', keyCode: 229 }, true],
        [{ key: 'a', keyCode: 229 }, true],
        [{ key: 'v', keyCode: 86, metaKey: true }, false],
        [{ key: 'n', keyCode: 78, ctrlKey: true }, false],
        [{ key: 'Enter', keyCode: 13 }, false],
        [{ key: 'ArrowDown', keyCode: 40 }, false],
        [{ key: 'ArrowLeft', keyCode: 229 }, false],
        [{ key: 'Backspace', keyCode: 8 }, false],
    ];
    for (const [event, expected] of cases) {
        assert.equal(isTextInputKeydown(event), expected, JSON.stringify(event));
    }
});

test('typing, IME input, Enter, Backspace and ArrowLeft all see a pasted image right edge', () => {
    const keydown = editorSource.indexOf('function handleKeydown(e)');
    const imeEarlyReturn = editorSource.indexOf('if ((isImeInteractionKeydown(e) || isActiveComposition)', keydown);
    const textInputRedirect = editorSource.indexOf('moveCaretToParagraphAfterImageRightEdgeForTextInput();', keydown);
    assert.notEqual(textInputRedirect, -1);
    assert.ok(textInputRedirect < imeEarlyReturn, 'IME input moves below the image before composition starts');

    assert.notEqual(editorSource.indexOf('moveCaretToParagraphAfterImageRightEdgeForTextInput({ newLine: true })'), -1);
    const backspace = editorSource.indexOf('if (moveCaretToImageRightEdgeFromFollowingBlockStartForBackspace(range, selection)) {');
    const backspaceImageCheck = editorSource.indexOf('const imageAtRightEdge = getImageAtCaretRightEdge(range);', backspace);
    assert.ok(backspace !== -1 && backspaceImageCheck - backspace < 400, 'Backspace deletes a pasted image');
});

function loadRemoveEmptyLinePlaceholderAtRange(fixture) {
    const sources = [
        'removeEmptyLinePlaceholderAtRange',
        'getClosestBlockElement',
        'isEffectivelyEmptyBlock',
    ].map(extractEditorFunction);
    const factory = new Function(
        'editor',
        'domUtils',
        `${sources.join('\n\n')}\nreturn removeEmptyLinePlaceholderAtRange;`
    );
    return factory(fixture.editor, fixture.domUtils);
}

test('an image pasted on an empty line replaces the line placeholder', async () => {
    const cases = [
        ['<br> placeholder', '<p>abc</p><p><br></p><p>def</p>', (line) => [line, 0]],
        ['ZWSP placeholder', '<p>abc</p><p>​</p><p>def</p>', (line) => [line.firstChild, 1]],
    ];
    for (const [name, html, caretAt] of cases) {
        const fixture = await createFixture(html);
        try {
            const removePlaceholder = loadRemoveEmptyLinePlaceholderAtRange(fixture);
            const line = fixture.editor.children[1];
            const [container, offset] = caretAt(line);
            const range = fixture.placeCaret(container, offset);

            removePlaceholder(range);

            // The image is inserted at this range, so it ends up alone in the line.
            assert.equal(line.childNodes.length, 0, name);
            assert.equal(range.startContainer, line, name);
            assert.equal(range.startOffset, 0, name);
            assert.equal(range.collapsed, true, name);
        } finally {
            fixture.restoreGlobals();
        }
    }
});

test('an image pasted into a line with content keeps that content', async () => {
    const cases = [
        ['text', '<p>ab</p>', (editor) => [editor.querySelector('p').firstChild, 1]],
        ['soft break between lines', '<p>abc<br>def</p>', (editor) => [editor.querySelector('p').firstChild, 3]],
        ['checkbox item', '<ul><li><input type="checkbox"><br></li></ul>', (editor) => [editor.querySelector('li'), 1]],
        ['code block', '<pre><code><br></code></pre>', (editor) => [editor.querySelector('code'), 0]],
    ];
    for (const [name, html, caretAt] of cases) {
        const fixture = await createFixture(html);
        try {
            const removePlaceholder = loadRemoveEmptyLinePlaceholderAtRange(fixture);
            const [container, offset] = caretAt(fixture.editor);
            const range = fixture.placeCaret(container, offset);

            removePlaceholder(range);

            assert.equal(fixture.editor.innerHTML, html, name);
            assert.equal(range.startContainer, container, name);
            assert.equal(range.startOffset, offset, name);
        } finally {
            fixture.restoreGlobals();
        }
    }
});

test('a pasted image clears the empty line placeholder before it is inserted', () => {
    const insertImageCase = editorSource.indexOf("case 'insertImage':");
    const clearPlaceholder = editorSource.indexOf('removeEmptyLinePlaceholderAtRange(range);', insertImageCase);
    const insertImage = editorSource.indexOf('range.insertNode(img);', insertImageCase);

    assert.notEqual(clearPlaceholder, -1);
    assert.ok(clearPlaceholder < insertImage);
});

test('ArrowDown tries the trailing image line before the generic downward navigation', () => {
    const arrowDownBranch = editorSource.indexOf(
        "if (e.key === 'ArrowDown' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {",
        editorSource.indexOf('function handleArrowKeydown(e)')
    );
    const trailingImageRoute = editorSource.indexOf(
        'if (moveCursorDownBelowTrailingImageBlock(range, selection)) {',
        arrowDownBranch
    );
    const genericMove = editorSource.indexOf('cursorManager.moveCursorDown(notifyChange);', arrowDownBranch);

    assert.notEqual(arrowDownBranch, -1);
    assert.notEqual(trailingImageRoute, -1);
    assert.ok(trailingImageRoute < genericMove);
});
