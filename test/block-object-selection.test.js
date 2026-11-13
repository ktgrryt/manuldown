const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const source = fs.readFileSync(path.join(__dirname, '..', 'media/modules/BlockObjectSelection.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// Preserve DOM boundary order, including empty/atomic nodes and the difference
// between a parent offset before a child and offset zero inside that child.
// Flattening textContent would hide precisely the object-boundary bugs below.
function comparePoints(nodeA, offsetA, nodeB, offsetB) {
    if (nodeA === nodeB) return Math.sign(offsetA - offsetB);
    const pathA = [], pathB = [];
    for (let node = nodeA; node; node = node.parentNode) pathA.unshift(node);
    for (let node = nodeB; node; node = node.parentNode) pathB.unshift(node);
    assert.equal(pathA[0], pathB[0], 'boundary points must share a document');
    let index = 0;
    while (pathA[index] === pathB[index]) index++;
    if (index === pathA.length) {
        const childIndex = Array.from(nodeA.childNodes).indexOf(pathB[index]);
        return offsetA <= childIndex ? -1 : 1;
    }
    if (index === pathB.length) return -comparePoints(nodeB, offsetB, nodeA, offsetA);
    const siblings = Array.from(pathA[index - 1].childNodes);
    return Math.sign(siblings.indexOf(pathA[index]) - siblings.indexOf(pathB[index]));
}

class TestRange {
    static START_TO_START = 0;
    static START_TO_END = 1;
    static END_TO_END = 2;
    static END_TO_START = 3;

    setStart(node, offset) {
        this.startContainer = node;
        this.startOffset = offset;
        if (!this.endContainer || comparePoints(node, offset, this.endContainer, this.endOffset) > 0) {
            this.endContainer = node;
            this.endOffset = offset;
        }
    }

    setEnd(node, offset) {
        this.endContainer = node;
        this.endOffset = offset;
        if (!this.startContainer || comparePoints(this.startContainer, this.startOffset, node, offset) > 0) {
            this.startContainer = node;
            this.startOffset = offset;
        }
    }

    setStartBefore(node) { this.setStart(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node)); }
    setStartAfter(node) { this.setStart(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node) + 1); }
    setEndBefore(node) { this.setEnd(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node)); }
    setEndAfter(node) { this.setEnd(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node) + 1); }
    selectNode(node) { this.setStartBefore(node); this.setEndAfter(node); }
    selectNodeContents(node) {
        this.setStart(node, 0);
        this.setEnd(node, node.nodeType === 3 ? node.length : node.childNodes.length);
    }
    collapse(toStart = false) {
        if (toStart) this.setEnd(this.startContainer, this.startOffset);
        else this.setStart(this.endContainer, this.endOffset);
    }
    cloneRange() { return Object.assign(new TestRange(), this); }
    get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
    get commonAncestorContainer() {
        let node = this.startContainer;
        while (node && node !== this.endContainer && !node.contains(this.endContainer)) node = node.parentNode;
        return node;
    }
    isPointInRange(node, offset) { return this.comparePoint(node, offset) === 0; }
    comparePoint(node, offset) {
        if (comparePoints(node, offset, this.startContainer, this.startOffset) < 0) return -1;
        if (comparePoints(node, offset, this.endContainer, this.endOffset) > 0) return 1;
        return 0;
    }
    compareBoundaryPoints(how, other) {
        const thisEnd = how === TestRange.START_TO_END || how === TestRange.END_TO_END;
        const otherEnd = how === TestRange.END_TO_START || how === TestRange.END_TO_END;
        return comparePoints(thisEnd ? this.endContainer : this.startContainer,
            thisEnd ? this.endOffset : this.startOffset,
            otherEnd ? other.endContainer : other.startContainer,
            otherEnd ? other.endOffset : other.startOffset);
    }
    intersectsNode(node) {
        const parent = node.parentNode;
        if (!parent) return true;
        const index = Array.from(parent.childNodes).indexOf(node);
        return comparePoints(parent, index + 1, this.startContainer, this.startOffset) > 0 &&
            comparePoints(parent, index, this.endContainer, this.endOffset) < 0;
    }
}

async function fixture(t, html) {
    const { BlockObjectSelection } = await modulePromise;
    const window = domino.createWindow(`<div id="editor" contenteditable="true">${html}</div><p id="elsewhere">Elsewhere</p>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    const originals = {};
    for (const [key, value] of Object.entries({ window, document, Node: window.Node, NodeFilter: window.NodeFilter,
        Range: TestRange })) {
        originals[key] = Object.getOwnPropertyDescriptor(global, key);
        Object.defineProperty(global, key, { configurable: true, writable: true, value });
    }
    const nodeListPrototype = Object.getPrototypeOf(editor.querySelectorAll('pre'));
    const oldForEach = nodeListPrototype.forEach;
    nodeListPrototype.forEach = Array.prototype.forEach;
    t.after(() => {
        for (const [key, descriptor] of Object.entries(originals)) {
            if (descriptor) Object.defineProperty(global, key, descriptor);
            else delete global[key];
        }
        if (oldForEach) nodeListPrototype.forEach = oldForEach;
        else delete nodeListPrototype.forEach;
    });
    let range = null;
    const selection = {
        get rangeCount() { return range ? 1 : 0; },
        get isCollapsed() { return !range || range.collapsed; },
        getRangeAt(index) { assert.equal(index, 0); return range; },
        removeAllRanges() { range = null; this.anchorNode = this.focusNode = null; },
        addRange(next) {
            range = next;
            Object.assign(this, { anchorNode: range.startContainer, anchorOffset: range.startOffset,
                focusNode: range.endContainer, focusOffset: range.endOffset });
        },
        setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
            const next = new TestRange();
            if (comparePoints(anchorNode, anchorOffset, focusNode, focusOffset) <= 0) {
                next.setStart(anchorNode, anchorOffset); next.setEnd(focusNode, focusOffset);
            } else {
                next.setStart(focusNode, focusOffset); next.setEnd(anchorNode, anchorOffset);
            }
            range = next;
            Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
        },
    };
    document.createRange = () => new TestRange();
    window.getSelection = () => selection;
    const manager = new BlockObjectSelection(editor);
    return {
        manager, editor, document, window, selection,
        node: selector => editor.querySelector(selector),
        text: selector => editor.querySelector(selector).firstChild,
        select(start, startOffset, end, endOffset, backward = false) {
            if (backward) selection.setBaseAndExtent(end, endOffset, start, startOffset);
            else selection.setBaseAndExtent(start, startOffset, end, endOffset);
        },
        selectNode(node) { const next = new TestRange(); next.selectNode(node); selection.addRange(next); },
        selectContents(node) { const next = new TestRange(); next.selectNodeContents(node); selection.addRange(next); },
        update() { manager.update(); },
        selected: node => node.classList.contains('md-block-whole-selected'),
    };
}

for (const backward of [false, true]) {
    test(`a ${backward ? 'backward' : 'forward'} full code selection outlines the complete block`, async t => {
        const f = await fixture(t, '<pre><code>const x = 1;</code></pre>');
        const text = f.text('code');
        f.select(text, 0, text, text.length, backward);
        f.update();
        assert.equal(f.selected(f.node('pre')), true);
        assert.equal(f.selection.anchorOffset, backward ? text.length : 0);
        assert.equal(f.selection.focusOffset, backward ? 0 : text.length);
    });
}

test('missing source characters at either endpoint keeps a code selection partial', async t => {
    const f = await fixture(t, '<pre><code>const x = 1;</code></pre>');
    const text = f.text('code');
    for (const [start, end] of [[1, text.length], [0, text.length - 1]]) {
        f.select(text, start, text, end);
        f.update();
        assert.equal(f.selected(f.node('pre')), false);
    }
});

test('syntax highlighting and excluded toolbar text do not change whole-code coverage', async t => {
    const f = await fixture(t, '<pre><div class="code-block-toolbar" data-exclude-from-markdown="true">JavaScript Copy</div>' +
        '<code><span id="first" class="token keyword">const</span> x = <span id="last" class="token number">1</span>;</code></pre>');
    const first = f.text('#first'), last = f.node('code').lastChild;
    f.select(first, 0, last, last.length);
    f.update();
    assert.equal(f.selected(f.node('pre')), true);
    f.select(first, 0, f.text('#last'), 1);
    f.update();
    assert.equal(f.selected(f.node('pre')), false, 'the final punctuation remains unselected');
    f.selectContents(f.node('.code-block-toolbar'));
    f.update();
    assert.equal(f.selected(f.node('pre')), false, 'a language-label selection is not a block selection');
});

test('exactly one terminal newline is optional while earlier trailing blank lines remain content', async t => {
    const f = await fixture(t, '<pre><code>first\nlast\n\n</code></pre>');
    const text = f.text('code');
    f.select(text, 0, text, text.length - 1);
    f.update();
    assert.equal(f.selected(f.node('pre')), true);
    f.select(text, 0, text, text.length - 2);
    f.update();
    assert.equal(f.selected(f.node('pre')), false);
    f.select(text, 0, text, text.length);
    f.update();
    assert.equal(f.selected(f.node('pre')), true);
});

test('leading and trailing spaces are preserved but injected zero-width anchors are ignored', async t => {
    const f = await fixture(t, '<pre><code>\u200B  x  \u2060\uFEFF</code></pre>');
    const text = f.text('code');
    f.select(text, 1, text, text.length - 2);
    f.update();
    assert.equal(f.selected(f.node('pre')), true);
    f.select(text, 2, text, text.length - 2);
    f.update();
    assert.equal(f.selected(f.node('pre')), false, 'leading indentation must be selected');
    f.select(text, 1, text, text.length - 3);
    f.update();
    assert.equal(f.selected(f.node('pre')), false, 'trailing spaces must be selected');
});

test('an empty code block needs full structural containment rather than a collapsed caret', async t => {
    const f = await fixture(t, '<pre><code><br></code></pre>');
    f.select(f.node('code'), 0, f.node('code'), 0);
    f.update();
    assert.equal(f.selected(f.node('pre')), false);
    f.selectContents(f.node('code'));
    f.update();
    assert.equal(f.selected(f.node('pre')), true);
    f.selectNode(f.node('pre'));
    f.update();
    assert.equal(f.selected(f.node('pre')), true);
});

test('BR line breaks preserve earlier blank lines while the last BR is an optional placeholder', async t => {
    const f = await fixture(t, '<pre><code>first<br><br></code></pre>');
    const code = f.node('code'), text = f.text('code');
    f.select(text, 0, text, text.length);
    f.update();
    assert.equal(f.selected(f.node('pre')), false, 'an earlier blank line remains outside the selected text');
    f.select(text, 0, code, 2);
    f.update();
    assert.equal(f.selected(f.node('pre')), true);
});

for (const tag of ['div', 'p']) {
    test(`${tag.toUpperCase()} line containers preserve a trailing blank line beyond the last visible source text`, async t => {
        const f = await fixture(t, `<pre><code><${tag} id="first">first</${tag}><${tag}><br></${tag}></code></pre>`);
        const text = f.text('#first');
        f.select(text, 0, text, text.length);
        f.update();
        assert.equal(f.selected(f.node('pre')), false, `${tag.toUpperCase()} blank line must not disappear from coverage`);
        f.selectContents(f.node('code'));
        f.update();
        assert.equal(f.selected(f.node('pre')), true);
    });
    test(`an empty leading ${tag.toUpperCase()} line remains part of the complete source range`, async t => {
        const f = await fixture(t, `<pre><code><${tag}></${tag}><${tag} id="last">last</${tag}></code></pre>`);
        const text = f.text('#last');
        f.select(text, 0, text, text.length);
        f.update();
        assert.equal(f.selected(f.node('pre')), false, 'selecting only the later text omits the first blank line');
        f.selectContents(f.node('code'));
        f.update();
        assert.equal(f.selected(f.node('pre')), true);
    });
}

for (const kind of ['mermaid', 'math']) {
    const attribute = kind === 'mermaid' ? 'data-mermaid-view="diagram"' : 'data-math-view="preview"';
    const preview = kind === 'mermaid' ? '<svg><text id="rendered">Diagram text</text></svg>' : '<span id="rendered">Equation</span>';
    test(`${kind} preview is atomic: hidden source and rendered glyphs alone do not select the block`, async t => {
        const f = await fixture(t, `<pre ${attribute}><code>source text</code>` +
            `<div class="${kind}-preview" contenteditable="false" data-exclude-from-markdown="true">${preview}</div></pre>`);
        f.selectContents(f.node('code'));
        f.update();
        assert.equal(f.selected(f.node('pre')), false);
        f.selectContents(f.node('#rendered'));
        f.update();
        assert.equal(f.selected(f.node('pre')), false);
        f.selectNode(f.node('pre'));
        f.update();
        assert.equal(f.selected(f.node('pre')), true);
        f.selectContents(f.node('pre'));
        f.update();
        assert.equal(f.selected(f.node('pre')), false, 'internal content selection does not include both object edges');
    });
    test(`${kind} source view outlines the pre when all source is selected`, async t => {
        const f = await fixture(t, `<pre data-${kind}-view="code"><code>source text\n</code>` +
            `<div class="${kind}-preview" data-exclude-from-markdown="true">Preview content</div></pre>`);
        const text = f.text('code');
        f.select(text, 0, text, text.length - 1);
        f.update();
        assert.equal(f.selected(f.node('pre')), true);
    });
}

test('display math uses whole-node boundaries and inline math is not given the block outline', async t => {
    const f = await fixture(t, '<p>Before<span id="display" data-mdw-math="display" contenteditable="false">x+y</span>' +
        '<span id="inline" data-mdw-math="inline" contenteditable="false">z</span>After</p>');
    f.selectContents(f.node('#display'));
    f.update();
    assert.equal(f.selected(f.node('#display')), false);
    f.selectNode(f.node('#display'));
    f.update();
    assert.equal(f.selected(f.node('#display')), true);
    f.selectNode(f.node('#inline'));
    f.update();
    assert.equal(f.selected(f.node('#display')), false);
    assert.equal(f.selected(f.node('#inline')), false);
});

test('a range spanning outside text and select-all outline multiple objects independently', async t => {
    const f = await fixture(t, '<p id="before">Before</p><pre><code>first</code></pre><p>Between</p>' +
        '<pre data-math-view="preview"><code>x+y</code><div class="math-preview">Formula</div></pre>' +
        '<p><span data-mdw-math="display">a+b</span></p><p id="after">After</p>');
    const blocks = Array.from(f.editor.querySelectorAll('pre, span[data-mdw-math="display"]'));
    f.select(f.text('#before'), 2, f.text('#after'), 3, true);
    f.update();
    assert.deepEqual(blocks.map(f.selected), [true, true, true]);
    f.select(f.text('code'), 1, f.text('#after'), 3);
    f.update();
    assert.deepEqual(blocks.map(f.selected), [false, true, true]);
    f.selectContents(f.editor);
    f.update();
    assert.deepEqual(blocks.map(f.selected), [true, true, true]);
});

test('collapsed, cleared and outside-editor ranges remove selected outlines', async t => {
    const f = await fixture(t, '<pre><code>source</code></pre>');
    const text = f.text('code');
    for (const clear of [
        () => f.select(text, 2, text, 2),
        () => f.selection.removeAllRanges(),
        () => { const elsewhere = f.document.getElementById('elsewhere').firstChild; f.select(elsewhere, 0, elsewhere, 3); },
    ]) {
        f.selectContents(f.node('code'));
        f.update();
        assert.equal(f.selected(f.node('pre')), true);
        clear(); f.update();
        assert.equal(f.selected(f.node('pre')), false);
    }
});

test('outline updates preserve native ranges, directional anchors and block content', async t => {
    const f = await fixture(t, '<pre class="existing"><code><span>first</span> last</code></pre>');
    const first = f.text('span'), last = f.node('code').lastChild;
    f.select(first, 0, last, last.length, true);
    const range = f.selection.getRangeAt(0), html = f.node('pre').innerHTML;
    f.update();
    f.update();
    assert.equal(f.selected(f.node('pre')), true);
    assert.equal(f.selection.getRangeAt(0), range);
    assert.equal(f.selection.anchorNode, last);
    assert.equal(f.selection.anchorOffset, last.length);
    assert.equal(f.selection.focusNode, first);
    assert.equal(f.selection.focusOffset, 0);
    assert.equal(f.node('pre').innerHTML, html);
    assert.equal(f.node('pre').classList.contains('existing'), true);
});

test('setup synchronizes native selection changes without document edits', async t => {
    const f = await fixture(t, '<pre><code>source</code></pre>');
    f.manager.setup();
    f.selectContents(f.node('code'));
    f.document.dispatchEvent(new f.window.Event('selectionchange'));
    assert.equal(f.selected(f.node('pre')), true);
    f.selection.removeAllRanges();
    f.document.dispatchEvent(new f.window.Event('selectionchange'));
    assert.equal(f.selected(f.node('pre')), false);
});

test('view mutations refresh atomic selection state even without a selectionchange event', async t => {
    const f = await fixture(t, '<pre data-math-view="code"><code>x+y</code><div class="math-preview">Formula</div></pre>');
    let callback;
    f.window.MutationObserver = class {
        constructor(next) { callback = next; }
        observe() {}
    };
    f.selectContents(f.node('code'));
    f.manager.setup();
    assert.equal(f.selected(f.node('pre')), true);
    f.node('pre').setAttribute('data-math-view', 'preview');
    callback([{ type: 'attributes', target: f.node('pre'), attributeName: 'data-math-view' }]);
    assert.equal(f.selected(f.node('pre')), false, 'the same hidden source range must lose its outline');
    f.selectNode(f.node('pre'));
    callback([{ type: 'childList', target: f.node('pre') }]);
    assert.equal(f.selected(f.node('pre')), true, 'preview replacement retains a complete object range');
});
