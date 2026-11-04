const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');
const prism = require('prismjs');

function importModule(name) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'media/modules', name), 'utf8') +
        `\n//# sourceURL=${name}`;
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const modules = Promise.all([
    importModule('CodeBlockManager.js'),
    importModule('CursorManager.js'),
    importModule('DOMUtils.js'),
]);

async function fixture(t, codeHtml = 'const x = 1;') {
    const window = domino.createWindow(`<div id="editor"><p id="before">before</p><pre><code class="language-javascript">${codeHtml}</code></pre><p id="after">after</p></div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    const code = editor.querySelector('code');
    const textPosition = (node, offset) => {
        let position = 0;
        let found = false;
        const visit = current => {
            if (found) return;
            if (current === node) {
                position += current.nodeType === 3
                    ? offset
                    : Array.from(current.childNodes).slice(0, offset)
                        .reduce((length, child) => length + child.textContent.length, 0);
                found = true;
            } else if (current.nodeType === 3) {
                position += current.textContent.length;
            } else {
                Array.from(current.childNodes).forEach(visit);
            }
        };
        visit(editor);
        assert.ok(found, 'the selection endpoint must remain in the editor');
        return position;
    };

    class TestRange {
        constructor(startContainer, startOffset, endContainer = startContainer, endOffset = startOffset) {
            Object.assign(this, { startContainer, startOffset, endContainer, endOffset });
        }
        get collapsed() {
            return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
        }
        setStart(node, offset) {
            this.startContainer = this.endContainer = node;
            this.startOffset = this.endOffset = offset;
        }
        selectNodeContents(node) {
            this.startContainer = this.endContainer = node;
            this.startOffset = 0;
            this.endOffset = node.childNodes.length;
        }
        collapse(toStart) {
            if (toStart) {
                this.endContainer = this.startContainer;
                this.endOffset = this.startOffset;
            } else {
                this.startContainer = this.endContainer;
                this.startOffset = this.endOffset;
            }
        }
        compareBoundaryPoints(_how, other) {
            return Math.sign(textPosition(this.startContainer, this.startOffset) -
                textPosition(other.startContainer, other.startOffset));
        }
        intersectsNode(node) {
            const parent = node.parentNode;
            const index = Array.from(parent.childNodes).indexOf(node);
            return textPosition(this.startContainer, this.startOffset) < textPosition(parent, index + 1) &&
                textPosition(this.endContainer, this.endOffset) > textPosition(parent, index);
        }
        toString() {
            return editor.textContent.slice(
                textPosition(this.startContainer, this.startOffset),
                textPosition(this.endContainer, this.endOffset)
            );
        }
    }

    let range = null;
    const selection = {
        get rangeCount() { return range ? 1 : 0; },
        get isCollapsed() { return !range || range.collapsed; },
        getRangeAt: () => range,
        removeAllRanges() { range = null; },
        addRange(nextRange) {
            range = nextRange;
            this.anchorNode = range.startContainer;
            this.anchorOffset = range.startOffset;
            this.focusNode = range.endContainer;
            this.focusOffset = range.endOffset;
        },
        setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
            Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
            range = textPosition(anchorNode, anchorOffset) <= textPosition(focusNode, focusOffset)
                ? new TestRange(anchorNode, anchorOffset, focusNode, focusOffset)
                : new TestRange(focusNode, focusOffset, anchorNode, anchorOffset);
        },
        toString: () => range ? range.toString() : '',
    };
    document.createRange = () => new TestRange();
    window.getSelection = () => selection;
    const originals = new Map();
    for (const [key, value] of Object.entries({ window, document, Node: window.Node, Range: TestRange, Prism: prism })) {
        originals.set(key, Object.getOwnPropertyDescriptor(global, key));
        Object.defineProperty(global, key, { configurable: true, writable: true, value });
    }
    t.after(() => {
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(global, key, descriptor);
            else delete global[key];
        }
    });

    const [{ CodeBlockManager }, { CursorManager }, { DOMUtils }] = await modules;
    const cursorManager = new CursorManager(editor, new DOMUtils(editor));
    const manager = Object.create(CodeBlockManager.prototype);
    Object.assign(manager, { editor, cursorManager, _ensureCodeBlockControlsForPre() {} });
    return { document, code, selection, manager, cursorManager };
}

for (const direction of ['forward', 'backward']) {
    for (const boundary of ['inside', 'into-code', 'out-of-code', 'around-code']) {
        test(`highlighting preserves a ${direction} selection ${boundary}`, async t => {
            const f = await fixture(t);
            const codeText = f.code.firstChild;
            const beforeText = f.document.getElementById('before').firstChild;
            const afterText = f.document.getElementById('after').firstChild;
            const [startNode, startOffset, endNode, endOffset] = {
                inside: [codeText, 10, codeText, 11],
                'into-code': [beforeText, 2, codeText, 11],
                'out-of-code': [codeText, 10, afterText, 3],
                'around-code': [beforeText, 2, afterText, 3],
            }[boundary];
            const endpoints = direction === 'backward'
                ? [endNode, endOffset, startNode, startOffset]
                : [startNode, startOffset, endNode, endOffset];
            f.selection.setBaseAndExtent(...endpoints);
            const selectedText = f.selection.toString();

            f.manager.highlightSingleCodeBlock(f.code);

            assert.equal(f.selection.toString(), selectedText);
            assert.equal(f.selection.isCollapsed, false);
            assert.deepEqual([
                f.selection.anchorNode, f.selection.anchorOffset,
                f.selection.focusNode, f.selection.focusOffset,
            ], endpoints);
            assert.equal(f.code.firstChild, codeText);
        });
    }
}

test('highlighting preserves a selection across visual code line breaks', async t => {
    const f = await fixture(t, 'const x = 1;<br><div>const y = 2;</div>');
    const first = f.code.firstChild;
    const last = f.code.querySelector('div').firstChild;
    f.selection.setBaseAndExtent(last, 11, first, 10);
    f.manager.highlightSingleCodeBlock(f.code);
    assert.equal(f.selection.anchorNode, last);
    assert.equal(f.selection.anchorOffset, 11);
    assert.equal(f.selection.focusNode, first);
    assert.equal(f.selection.focusOffset, 10);
    assert.ok(f.code.querySelector('br'));
});

test('highlighting resumes after a code selection collapses and keeps its caret position', async t => {
    const f = await fixture(t);
    const text = f.code.firstChild;
    f.selection.setBaseAndExtent(text, 11, text, 10);
    f.manager.highlightSingleCodeBlock(f.code);
    f.selection.setBaseAndExtent(text, 11, text, 11);

    f.manager.highlightSingleCodeBlock(f.code);

    assert.ok(f.code.querySelector('.token.keyword'));
    assert.equal(f.code.textContent, 'const x = 1;');
    assert.equal(f.selection.isCollapsed, true);
    assert.equal(f.cursorManager.getCodeBlockCursorOffset(f.code, f.selection.getRangeAt(0)), 11);
});

test('a selection outside the code block does not prevent highlighting or change its endpoints', async t => {
    const f = await fixture(t);
    const before = f.document.getElementById('before').firstChild;
    f.selection.setBaseAndExtent(before, 5, before, 1);

    f.manager.highlightSingleCodeBlock(f.code);

    assert.ok(f.code.querySelector('.token.keyword'));
    assert.equal(f.selection.toString(), 'efor');
    assert.equal(f.selection.anchorNode, before);
    assert.equal(f.selection.anchorOffset, 5);
    assert.equal(f.selection.focusNode, before);
    assert.equal(f.selection.focusOffset, 1);
});
