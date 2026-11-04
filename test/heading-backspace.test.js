const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');
const domUtilsSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', 'DOMUtils.js'), 'utf8');
const domUtilsPromise = import(`data:text/javascript;base64,${Buffer.from(domUtilsSource).toString('base64')}`);
const listManagerSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', 'ListManager.js'), 'utf8');
const listManagerPromise = import(`data:text/javascript;base64,${Buffer.from(listManagerSource).toString('base64')}`);

function extractFunction(name) {
    const start = editorSource.indexOf(`    function ${name}(`);
    assert.notEqual(start, -1);
    const end = editorSource.indexOf('\n    }\n', start);
    return editorSource.slice(start, end + '\n    }'.length);
}

// Domino has no Range; implement the collapsed caret and prefix text read by Backspace.
class TestRange {
    constructor() {
        this.collapsed = true;
    }

    get commonAncestorContainer() { return this.startContainer; }
    setStart(node, offset) {
        this.startContainer = this.endContainer = node;
        this.startOffset = this.endOffset = offset;
    }
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }
    collapse() { this.collapsed = true; }
    selectNodeContents(node) { this.root = node; }

    toString() {
        const prefix = (node) => {
            if (node === this.endContainer) {
                return node.nodeType === 3 ? node.data.slice(0, this.endOffset)
                    : Array.from(node.childNodes).slice(0, this.endOffset).map(child => child.textContent).join('');
            }
            let text = '';
            for (const child of Array.from(node.childNodes)) {
                if (child === this.endContainer || child.contains(this.endContainer)) return text + prefix(child);
                text += child.textContent;
            }
            return text;
        };
        return prefix(this.root);
    }
}

async function createFixture(html, onNativeDelete = () => {}) {
    const window = domino.createWindow(`<div id="editor">${html}</div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    const { DOMUtils } = await domUtilsPromise;
    const previous = { document: global.document, Node: global.Node, NodeFilter: global.NodeFilter, window: global.window };
    global.document = document;
    global.Node = window.Node;
    global.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
    global.window = window;
    document.createRange = () => new TestRange();
    let range;
    const selection = {
        rangeCount: 1,
        getRangeAt: () => range,
        removeAllRanges() { range = null; },
        addRange(next) { range = next; },
    };
    window.getSelection = () => selection;
    let nativeDeletes = 0;
    let changes = 0;
    const history = [];
    const editedMathBlocks = [];
    const caretPlacements = [];
    const { ListManager } = await listManagerPromise;
    const domUtils = new DOMUtils(editor);
    const listManager = new ListManager(editor, domUtils, { deferCaretPlacement: callback => caretPlacements.push(callback) });
    document.execCommand = (command) => {
        assert.equal(command, 'delete');
        nativeDeletes++;
        onNativeDelete(editor, selection);
    };
    const names = [
        'handleBackspace', 'isEffectivelyEmptyBlock', 'placeCollapsedCaret',
        'hasDirectTextContent', 'getDirectTextContent', 'isRangeAtListItemStart',
        'hasCheckboxAtStart', 'hasCheckbox', 'getCheckboxInListItemDirectContent',
        'getFirstDirectTextNode', 'handleBackspaceAfterMathBlock', 'getClosestBlockElement',
        'isAtBlockStartForRange', 'listItemHasDirectImage', 'unwrapListItemContent',
        'isIgnorableEditorTextValue', 'isEditorEffectivelyEmpty', 'isRenderableEditorNode',
        'getFirstDirectTextNodeAfterCheckbox', 'getCheckboxTextMinOffset',
        'getNestedListContainerForListItem', 'hasNestedListChild',
        'convertEmptyNestedListItemToIndentWrapper', 'handleEmptyNestedListItemDelete',
        'handleBackspaceRemoveBlankLineBeforeNestedList', 'isRangeInListItemDirectContent',
    ];
    const handlers = new Function('window', 'editor', 'domUtils', 'notifyChange', 'deferCaretPlacement',
        'cursorManager', 'codeBlockManager', 'stateManager', 'listManager',
        `${names.map(extractFunction).join('\n')}\nreturn { backspace: handleBackspace, emptyDelete: handleEmptyNestedListItemDelete, blankDelete: handleBackspaceRemoveBlankLineBeforeNestedList };`
    )(window, editor, domUtils, () => changes++, callback => caretPlacements.push(callback),
        { getCodeBlockText: code => code.textContent },
        { _editMathSource: pre => editedMathBlocks.push(pre) },
        { saveState: () => history.push('save'), saveStateDebounced: () => history.push('commit') }, listManager);
    return {
        editor, selection, backspace: handlers.backspace, history, editedMathBlocks,
        pressListBackspace() {
            return handlers.blankDelete(selection, range) || handlers.emptyDelete(selection, range) || handlers.backspace();
        },
        flushCaretPlacements() { caretPlacements.splice(0).forEach(callback => callback()); },
        get nativeDeletes() { return nativeDeletes; },
        get changes() { return changes; },
        caret(node, offset = 0) { range = new TestRange(); range.setStart(node, offset); },
        restore() { Object.assign(global, previous); },
    };
}

test('Backspace deletes only the preceding blank line and preserves every heading level', async () => {
    for (let level = 1; level <= 6; level++) {
        for (const blank of ['<p><br></p>', '<div><br></div>', '<p>&nbsp;\u200B</p>']) {
            const fixture = await createFixture(`<p>before</p>${blank}<h${level} id="title">Title</h${level}>`);
            try {
                const heading = fixture.editor.lastElementChild;
                fixture.caret(heading.firstChild);
                assert.equal(fixture.backspace(), true);
                assert.equal(fixture.editor.innerHTML, `<p>before</p><h${level} id="title">Title</h${level}>`);
                assert.equal(fixture.editor.lastElementChild === heading, true);
                assert.equal(fixture.selection.getRangeAt(0).startContainer === heading.firstChild, true);
                assert.equal(fixture.selection.getRangeAt(0).startOffset, 0);
                assert.equal(fixture.nativeDeletes, 0);
                assert.equal(fixture.changes, 1);
            } finally { fixture.restore(); }
        }
    }
});

function mathBlock(tex, view = 'preview') {
    return `<pre data-math-view="${view}"><div class="code-block-toolbar" contenteditable="false">math TeX Preview</div>` +
        `<code class="language-math" data-mdw-math-delimiter="$$">${tex}</code>` +
        '<div class="math-preview" contenteditable="false" data-exclude-from-markdown="true">Empty formula</div></pre>';
}

test('Backspace after an empty math block removes only the formula and preserves formatted text', async () => {
    for (const view of ['preview', 'code']) {
        for (const tex of ['', '\n', ' \t\n\u200B\u2060\uFEFF']) {
            for (const line of ['<p><strong># Project Notes</strong></p>', '<h1><strong>Project Notes</strong></h1>',
                '<p><code>Project Notes</code></p>', '<p><br></p>']) {
                const fixture = await createFixture(mathBlock(tex, view) + line);
                try {
                    const block = fixture.editor.lastElementChild;
                    const caret = block.querySelector('strong')?.firstChild || block;
                    fixture.caret(caret);
                    assert.equal(fixture.backspace(), true);
                    assert.equal(fixture.editor.innerHTML, line);
                    assert.equal(fixture.editor.firstElementChild, block);
                    assert.equal(fixture.selection.getRangeAt(0).startContainer, caret);
                    assert.equal(fixture.selection.getRangeAt(0).startOffset, 0);
                    assert.equal(fixture.nativeDeletes, 0);
                    assert.equal(fixture.changes, 1);
                    assert.deepEqual(fixture.history, ['save', 'commit']);
                } finally { fixture.restore(); }
            }
        }
    }
});

test('Backspace after a nonempty math block opens its source without merging the following text', async () => {
    const html = mathBlock('x^2\n') + '<p><strong># Project Notes</strong></p>';
    const fixture = await createFixture(html);
    try {
        fixture.caret(fixture.editor.querySelector('strong').firstChild);
        assert.equal(fixture.backspace(), true);
        assert.equal(fixture.editor.innerHTML, html);
        assert.equal(fixture.editedMathBlocks.length, 1);
        assert.ok(fixture.editedMathBlocks[0] === fixture.editor.querySelector('pre'));
        assert.equal(fixture.nativeDeletes, 0);
        assert.equal(fixture.changes, 0);
        assert.deepEqual(fixture.history, []);
    } finally { fixture.restore(); }
});

test('Backspace beside math keeps ordinary character deletion and selected-text deletion', async () => {
    for (const [text, offset, collapsed] of [['Project Notes', 3, true], [' Project Notes', 1, true],
        ['Project Notes', 0, false]]) {
        const html = mathBlock('\n') + `<p><strong>${text}</strong></p>`;
        const fixture = await createFixture(html);
        try {
            fixture.caret(fixture.editor.querySelector('strong').firstChild, offset);
            fixture.selection.getRangeAt(0).collapsed = collapsed;
            fixture.backspace();
            assert.equal(fixture.nativeDeletes, 1);
            assert.equal(fixture.editor.innerHTML, html);
            assert.deepEqual(fixture.editedMathBlocks, []);
        } finally { fixture.restore(); }
    }
});

test('Backspace preserves empty, formatted, and code-leading headings above a blank line', async () => {
    for (const [content, textCaret] of [
        ['<br>', false], ['<strong>Title</strong>', false],
        ['\uFEFF<code>Title</code>', false], ['\uFEFF<code>Title</code>', true],
    ]) {
        const fixture = await createFixture(`<p><br></p><h2 data-mdw-heading-style="setext">${content}</h2>`);
        try {
            const heading = fixture.editor.lastElementChild;
            const expected = heading.outerHTML;
            // Cover element-boundary carets as well as text-node carets.
            fixture.caret(textCaret ? heading.firstChild : heading, textCaret ? 1 : 0);
            fixture.backspace();
            assert.equal(fixture.editor.innerHTML, expected);
            assert.equal(fixture.selection.getRangeAt(0).startOffset, 0);
            assert.equal(fixture.nativeDeletes, 0);
        } finally { fixture.restore(); }
    }
});

test('repeated Backspace removes one blank line at a time before a heading', async () => {
    const fixture = await createFixture('<p>before</p><p><br></p><p><br></p><h2>Title</h2>');
    try {
        const heading = fixture.editor.lastElementChild;
        fixture.caret(heading.firstChild);
        fixture.backspace();
        assert.equal(fixture.editor.innerHTML, '<p>before</p><p><br></p><h2>Title</h2>');
        fixture.backspace();
        assert.equal(fixture.editor.innerHTML, '<p>before</p><h2>Title</h2>');
        fixture.backspace();
        assert.equal(fixture.nativeDeletes, 1);
    } finally { fixture.restore(); }
});

test('Backspace after removing a blank line below a list skips invisible boundaries and immediately deletes text', async () => {
    for (const boundary of ['\u200B', '\u2060', '\uFEFF', '\u200B\u2060\uFEFF']) {
        const fixture = await createFixture(`<ul><li>aaa${boundary}</li></ul><p><br></p>`, (editor, selection) => {
            const range = selection.getRangeAt(0);
            if (range.startContainer.nodeName === 'P') {
                // Chromium joins the blank paragraph to the preceding list and
                // puts the caret after the invisible suffix of its text node.
                range.startContainer.remove();
                const text = editor.querySelector('li').firstChild;
                range.setStart(text, text.textContent.length);
            } else {
                const text = range.startContainer;
                const offset = range.startOffset;
                text.textContent = text.textContent.slice(0, offset - 1) + text.textContent.slice(offset);
                range.setStart(text, offset - 1);
            }
        });
        try {
            fixture.caret(fixture.editor.lastElementChild);
            fixture.backspace();
            assert.equal(fixture.editor.querySelectorAll('p').length, 0);
            const text = fixture.editor.querySelector('li').firstChild;
            assert.equal(text.textContent, `aaa${boundary}`);
            fixture.backspace();
            assert.equal(text.textContent, `aa${boundary}`);
            assert.equal(fixture.selection.getRangeAt(0).startOffset, 2);
            fixture.backspace();
            assert.equal(text.textContent, `a${boundary}`);
            assert.equal(fixture.selection.getRangeAt(0).startOffset, 1);
            assert.equal(fixture.nativeDeletes, 3);
        } finally { fixture.restore(); }
    }
});

test('an empty heading without a preceding blank line still becomes a paragraph', async () => {
    const fixture = await createFixture('<h2><br></h2>');
    try {
        fixture.caret(fixture.editor.firstChild);
        fixture.backspace();
        assert.equal(fixture.editor.innerHTML, '<p><br></p>');
        assert.equal(fixture.nativeDeletes, 0);
    } finally { fixture.restore(); }
});

test('Backspace still uses normal deletion after text, inside a heading, and for a selection', async () => {
    for (const [previous, offset, collapsed] of [
        ['<p>before</p>', 0, true],
        ['<p><br></p>', 2, true],
        ['<p><br></p>', 0, false],
    ]) {
        const fixture = await createFixture(`${previous}<h2>Title</h2>`);
        try {
            fixture.caret(fixture.editor.lastElementChild.firstChild, offset);
            fixture.selection.getRangeAt(0).collapsed = collapsed;
            fixture.backspace();
            assert.equal(fixture.nativeDeletes, 1);
            assert.equal(fixture.editor.innerHTML, `${previous}<h2>Title</h2>`);
        } finally { fixture.restore(); }
    }
});

test('Backspace at a list-leading image removes only its list formatting', async () => {
    const imageHtml = '<img src="display.png" data-md-path="images/original.png" alt="diagram|240x120">';
    for (const tag of ['ul', 'ol']) {
        for (const content of [imageHtml, `<p>${imageHtml}</p>`,
            `<a href="https://example.test">${imageHtml}</a> caption`]) {
            const fixture = await createFixture(`<${tag}><li>${content}</li></${tag}>`);
            try {
                const image = fixture.editor.querySelector('img');
                fixture.caret(image.parentElement, Array.from(image.parentNode.childNodes).indexOf(image));
                assert.equal(fixture.pressListBackspace(), true);
                fixture.flushCaretPlacements();
                assert.ok(image.isConnected);
                assert.ok(!image.closest('li'));
                assert.equal(image.outerHTML, imageHtml);
                assert.equal(fixture.editor.querySelectorAll('li').length, 0);
                assert.ok(!fixture.editor.querySelector('p p'));
                assert.equal(fixture.nativeDeletes, 0);
                assert.equal(fixture.changes, 1);
                const caret = fixture.selection.getRangeAt(0);
                assert.ok(caret.startContainer === fixture.editor.firstElementChild);
                assert.equal(caret.startOffset, 0);
            } finally { fixture.restore(); }
        }
    }
});

test('Backspace on an image in the middle of a list preserves both neighboring lists', async () => {
    const fixture = await createFixture('<ul><li>before</li><li><img src="image.png"></li><li>after</li></ul>');
    try {
        const image = fixture.editor.querySelector('img');
        const before = fixture.editor.querySelector('li');
        const after = fixture.editor.querySelector('li:last-child');
        fixture.caret(image.parentElement);
        fixture.pressListBackspace();
        fixture.flushCaretPlacements();
        assert.equal(fixture.editor.innerHTML, '<ul><li>before</li></ul><p><img src="image.png"></p><ul><li>after</li></ul>');
        assert.ok(before.isConnected && after.isConnected && image.isConnected);
    } finally { fixture.restore(); }
});

test('Backspace on a nested image outdents it one level before removing list formatting', async () => {
    for (const tag of ['ul', 'ol']) {
        const fixture = await createFixture(`<${tag}><li>parent<${tag}><li><img src="image.png"></li></${tag}></li></${tag}>`);
        try {
            const image = fixture.editor.querySelector('img');
            const item = image.closest('li');
            fixture.caret(item);
            fixture.pressListBackspace();
            fixture.flushCaretPlacements();
            assert.ok(item.parentElement === fixture.editor.firstElementChild);
            assert.ok(image.closest('li') === item);
            assert.equal(fixture.editor.querySelectorAll(tag).length, 1);
            fixture.pressListBackspace();
            fixture.flushCaretPlacements();
            assert.ok(image.isConnected);
            assert.ok(!image.closest('li'));
        } finally { fixture.restore(); }
    }
});

test('Backspace at an image with children keeps the image and child list in order', async () => {
    const fixture = await createFixture('<ul><li>before</li><li><p><img src="image.png"></p><ul><li>child</li></ul></li><li>after</li></ul>');
    try {
        const image = fixture.editor.querySelector('img');
        const childList = image.closest('li').querySelector('ul');
        fixture.caret(image.parentElement);
        fixture.pressListBackspace();
        fixture.flushCaretPlacements();
        assert.equal(fixture.editor.innerHTML,
            '<ul><li>before</li></ul><p><img src="image.png"></p><ul><li>child</li></ul><ul><li>after</li></ul>');
        assert.ok(image.isConnected && childList.isConnected);
        assert.equal(fixture.nativeDeletes, 0);
    } finally { fixture.restore(); }
});
