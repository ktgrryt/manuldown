const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

function importModule(fileName) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', fileName), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const markdownConverterModulePromise = importModule('MarkdownConverter.js');
const domUtilsModulePromise = importModule('DOMUtils.js');
const typingUndoGroupModulePromise = importModule('TypingUndoGroup.js');

class CaretRange {
    constructor(container = null, offset = 0) {
        this.startContainer = container;
        this.startOffset = offset;
        this.endContainer = container;
        this.endOffset = offset;
        this.collapsed = true;
    }

    get commonAncestorContainer() {
        return this.startContainer;
    }

    setStart(container, offset) {
        if (!container) {
            throw new TypeError('Range.setStart requires a node');
        }
        this.startContainer = container;
        this.startOffset = offset;
        this.endContainer = container;
        this.endOffset = offset;
    }

    collapse() {
        this.collapsed = true;
    }
}

// Build an editor from HTML, put the caret at `offset` in the text node that
// `findTextNode` returns, and run convertMarkdownSyntax.
async function convertAt(html, findTextNode, offset, insertedText) {
    const { MarkdownConverter } = await markdownConverterModulePromise;
    const { DOMUtils } = await domUtilsModulePromise;
    const window = domino.createWindow(`<div id="editor">${html}</div>`, 'https://example.test/');
    const document = window.document;
    const editor = document.getElementById('editor');
    const textNode = findTextNode(editor);
    assert.ok(textNode && textNode.nodeType === 3, 'test setup needs a text node');

    let activeRange = new CaretRange(textNode, offset === undefined ? textNode.textContent.length : offset);
    const selection = {
        get rangeCount() {
            return activeRange ? 1 : 0;
        },
        getRangeAt: () => activeRange,
        removeAllRanges: () => {
            activeRange = null;
        },
        addRange: (range) => {
            activeRange = range;
        },
    };
    const previous = {
        window: global.window,
        document: global.document,
        Node: global.Node,
        NodeFilter: global.NodeFilter,
    };
    document.createRange = () => new CaretRange();
    global.window = { getSelection: () => selection };
    global.document = document;
    global.Node = window.Node;
    global.NodeFilter = window.NodeFilter;
    try {
        const converter = new MarkdownConverter(editor, new DOMUtils(editor));
        let notified = 0;
        const converted = converter.convertMarkdownSyntax(() => {
            notified++;
        }, { insertedText });
        return { converted, notified, editor, html: editor.innerHTML };
    } finally {
        Object.assign(global, previous);
    }
}

const lastTextNode = (root) => {
    let found = null;
    const visit = (node) => {
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === 3) {
                found = child;
            }
            visit(child);
        }
    };
    visit(root);
    return found;
};

test('a list marker later in an item does not replace the item', async () => {
    const html = '<ul><li><code>--flag</code> - desc<ul><li>child</li></ul></li></ul>';
    const result = await convertAt(
        html,
        (editor) => editor.querySelector('li').childNodes[1],
        undefined,
        'c'
    );
    assert.equal(result.converted, false);
    assert.equal(result.html, html);
});

test('a quote marker after inline code does not split the paragraph', async () => {
    const html = '<p><code>x</code> &gt; 5</p>';
    const result = await convertAt(html, (editor) => editor.querySelector('p').lastChild, undefined, '5');
    assert.equal(result.converted, false);
    assert.equal(result.html, html);
});

test('a heading needs a marker the user just typed', async () => {
    // An escaped "\# foo" renders as the text "# foo"; typing at its end keeps it text.
    const literal = await convertAt('<p># foo</p>', (editor) => editor.querySelector('p').firstChild, undefined, 'o');
    assert.equal(literal.converted, false);
    assert.equal(literal.html, '<p># foo</p>');

    const typed = await convertAt('<p># a</p>', (editor) => editor.querySelector('p').firstChild, undefined, 'a');
    assert.equal(typed.converted, true);
    assert.equal(typed.html, '<h1>a</h1>');

    // An IME commit after "# " converts too.
    const composed = await convertAt('<p># 見出し</p>', (editor) => editor.querySelector('p').firstChild, undefined, '見出し');
    assert.equal(composed.converted, true);
    assert.equal(composed.html, '<h1>見出し</h1>');
});

test('shortcuts never fire inside code', async () => {
    for (const html of ['<p><code># title</code></p>', '<p><code>- item</code></p>', '<p><code>---</code></p>']) {
        const result = await convertAt(html, (editor) => editor.querySelector('code').firstChild, undefined, 'x');
        assert.equal(result.converted, false, html);
        assert.equal(result.html, html);
    }
    const codeBlock = '<pre><code class="language-python"># comment</code></pre>';
    const result = await convertAt(codeBlock, (editor) => editor.querySelector('code').firstChild, undefined, 't');
    assert.equal(result.converted, false);
    assert.equal(result.html, codeBlock);
});

test('--- on a later line of a paragraph keeps the earlier line', async () => {
    const result = await convertAt('<p>foo<br>---</p>', (editor) => editor.querySelector('p').lastChild, undefined, '-');
    assert.equal(result.converted, true);
    assert.match(result.html, /^<p>foo<\/p><hr>/);
});

test('--- stays text inside a list item', async () => {
    const html = '<ul><li>---<ul><li>child</li></ul></li></ul>';
    const result = await convertAt(html, (editor) => editor.querySelector('li').firstChild, undefined, '-');
    assert.equal(result.converted, false);
    assert.equal(result.html, html);
});

test('typing a list marker at the start of an item keeps its other content', async () => {
    const ordered = await convertAt(
        '<ol><li>- text<strong>b</strong><ul><li>child</li></ul></li></ol>',
        (editor) => editor.querySelector('li').firstChild,
        2,
        ' '
    );
    assert.equal(ordered.converted, true);
    assert.equal(ordered.html, '<ul><li>text<strong>b</strong><ul><li>child</li></ul></li></ul>');

    const bullet = await convertAt(
        '<ul><li>- text<strong>b</strong></li></ul>',
        (editor) => editor.querySelector('li').firstChild,
        2,
        ' '
    );
    assert.equal(bullet.converted, true);
    assert.equal(bullet.html, '<ul><li>text<strong>b</strong></li></ul>');
});

test('bold and italic conversion completes and keeps the preceding text', async () => {
    const bold = await convertAt('<p>a  **bold**</p>', (editor) => editor.querySelector('p').firstChild, undefined, '*');
    assert.equal(bold.converted, true);
    assert.equal(bold.notified, 1);
    assert.equal(bold.html, '<p>a&nbsp; <strong>bold</strong> </p>');

    const italic = await convertAt('<p>an *em*</p>', (editor) => editor.querySelector('p').firstChild, undefined, '*');
    assert.equal(italic.converted, true);
    assert.equal(italic.html, '<p>an <em>em</em> </p>');
});

test('delimiters around spaces are not emphasis', async () => {
    const result = await convertAt('<p>5 * 3 *</p>', (editor) => editor.querySelector('p').firstChild, undefined, '*');
    assert.equal(result.converted, false);
    assert.equal(result.html, '<p>5 * 3 *</p>');
});

test('typing is grouped into word-sized undo steps', async () => {
    const { TypingUndoGroup } = await typingUndoGroupModulePromise;
    let now = 0;
    const group = new TypingUndoGroup({ now: () => now, pauseMs: 500 });
    const type = (data) => {
        now += 50;
        return group.shouldCheckpoint({ inputType: 'insertText', data, collapsed: true });
    };
    const backspace = () => {
        now += 50;
        return group.shouldCheckpoint({ inputType: 'deleteContentBackward', collapsed: true });
    };

    assert.deepEqual(['h', 'e', 'l', 'l', 'o'].map(type), [true, false, false, false, false]);
    // The space ends the word; the next word is a new step.
    assert.equal(type(' '), false);
    assert.equal(type('w'), true);
    // Switching to deletion starts a new step, then deletions group.
    assert.deepEqual([backspace(), backspace(), backspace()], [true, false, false]);
    // A pause, a caret move or typing over a selection starts a new step.
    now += 1000;
    assert.equal(type('x'), true);
    group.break();
    assert.equal(type('y'), true);
    now += 50;
    assert.equal(group.shouldCheckpoint({ inputType: 'insertText', data: 'z', collapsed: false }), true);
    // Other edits always get their own step.
    assert.equal(group.shouldCheckpoint({ inputType: 'insertParagraph', collapsed: true }), true);
    assert.equal(group.shouldCheckpoint({ inputType: 'insertFromPaste', collapsed: true }), true);
});
