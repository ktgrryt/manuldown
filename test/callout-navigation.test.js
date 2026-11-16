const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

function importModule(name) {
    const source = fs.readFileSync(path.join(__dirname, '../media/modules', name), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const modules = Promise.all([importModule('DOMUtils.js'), importModule('CursorManager.js')]);
const editorSource = fs.readFileSync(path.join(__dirname, '../media/editor.js'), 'utf8');
const childIndex = node => Array.from(node.parentNode.childNodes).indexOf(node);
const emptyRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });

// These cases exercise the real keyboard navigation fallback when Chromium has
// no usable caret rectangles (empty paragraphs and newly restored DOM included).
class CaretRange {
    constructor() { this.collapsed = true; }
    get commonAncestorContainer() { return this.startContainer; }
    setStart(node, offset) {
        this.startContainer = node; this.startOffset = offset;
        if (this.collapsed || !this.endContainer) { this.endContainer = node; this.endOffset = offset; }
        this.collapsed = node === this.endContainer && offset === this.endOffset;
    }
    setEnd(node, offset) {
        this.endContainer = node; this.endOffset = offset;
        this.collapsed = this.startContainer === node && this.startOffset === offset;
    }
    setStartBefore(node) { this.setStart(node.parentNode, childIndex(node)); }
    setStartAfter(node) { this.setStart(node.parentNode, childIndex(node) + 1); }
    setEndAfter(node) { this.setEnd(node.parentNode, childIndex(node) + 1); }
    selectNode(node) { this.setStartBefore(node); this.setEndAfter(node); }
    selectNodeContents(node) {
        this.startContainer = node; this.startOffset = 0;
        this.endContainer = node; this.endOffset = node.nodeType === 3 ? node.length : node.childNodes.length;
        this.collapsed = this.endOffset === 0;
    }
    collapse(start) {
        if (start) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
        else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; }
        this.collapsed = true;
    }
    cloneRange() { return Object.assign(new CaretRange(), this); }
    compareBoundaryPoints(_how, other) {
        return this.startContainer === other.startContainer && this.startOffset === other.startOffset ? 0 : 1;
    }
    getBoundingClientRect() { return emptyRect(); }
    getClientRects() { return []; }
    toString() { return ''; }
}
CaretRange.START_TO_START = 0;
CaretRange.END_TO_END = 2;

async function fixture(html) {
    const [{ DOMUtils }, { CursorManager }] = await modules;
    const window = domino.createWindow(`<div id="editor" contenteditable="true">${html}</div><p>Chrome outside editor</p>`);
    const document = window.document, editor = document.getElementById('editor');
    window.HTMLElement.prototype.getBoundingClientRect = emptyRect;
    window.HTMLElement.prototype.getClientRects = () => [];
    window.getComputedStyle = () => ({ lineHeight: '20px', fontSize: '16px' });
    document.createRange = () => new CaretRange();
    document.elementFromPoint = () => null;
    document.caretRangeFromPoint = () => null;
    editor.scrollTo = ({ top }) => { editor.scrollTop = top; };
    let range;
    const selection = {
        get rangeCount() { return range ? 1 : 0; },
        get isCollapsed() { return !!range?.collapsed; },
        getRangeAt: () => range,
        addRange: next => { range = next; },
        removeAllRanges: () => { range = null; },
    };
    window.getSelection = () => selection;
    const previous = { window: global.window, document: global.document, Node: global.Node,
        NodeFilter: global.NodeFilter, Range: global.Range };
    Object.assign(global, { window, document, Node: window.Node, Range: CaretRange,
        NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 } });
    const listPrototype = Object.getPrototypeOf(editor.querySelectorAll('img'));
    const oldForEach = listPrototype.forEach;
    listPrototype.forEach = Array.prototype.forEach;
    const domUtils = new DOMUtils(editor);
    const cursor = new CursorManager(editor, domUtils);
    return { editor, cursor, selection, document, window, domUtils,
        caret(node, offset = 0) {
            range = new CaretRange(); range.setStart(node, offset); range.collapse(true);
        },
        move(method) {
            cursor[method](() => assert.fail('moving the caret must not edit Markdown'));
            const applied = selection.getRangeAt(0);
            const element = applied.startContainer.nodeType === 3 ? applied.startContainer.parentElement : applied.startContainer;
            assert.equal(element.closest('[contenteditable="false"]'), null, 'the caret must never enter a generated title');
            assert.ok(editor.contains(applied.startContainer), 'the caret remains inside the editor');
            return applied;
        },
        restore() {
            listPrototype.forEach = oldForEach;
            for (const [name, value] of Object.entries(previous)) {
                if (value === undefined) delete global[name];
                else global[name] = value;
            }
        }
    };
}

function callout(body, title = 'Note') {
    return `<div class="mdw-callout" data-mdw-callout="true"><div class="mdw-callout-title" contenteditable="false">${title}</div><div class="mdw-callout-content">${body}</div></div>`;
}

for (const [name, body] of [
    ['multiple paragraphs', '<p>First</p><p>Last</p>'],
    ['an empty paragraph', '<p><br></p>'],
    ['a leading empty paragraph', '<p><br></p><p>Last</p>'],
    ['a trailing empty paragraph', '<p>First</p><p><br></p>'],
    ['a nested callout', callout('<p>Inner</p>', 'Tip')],
    ['an empty nested callout', callout('<p><br></p>', 'Tip')],
    ['an empty quoted nested callout', `<blockquote>${callout('<p><br></p>', 'Tip')}</blockquote>`],
    ['an empty listed nested callout', `<ul><li>${callout('<p><br></p>', 'Tip')}</li></ul>`],
    ['loaded paragraph whitespace', '\n<p>First</p>\n<p>Last</p>\n'],
]) {
    for (const [method, fromBefore] of [
        ['moveCursorForward', true], ['moveCursorDown', true],
        ['moveCursorBackward', false], ['moveCursorUp', false],
    ]) {
        test(`${method} enters ${name} through the editable body`, async () => {
            const f = await fixture(`<p>Before</p>${callout(body)}<p>After</p>`);
            try {
                const original = f.editor.innerHTML;
                const source = (fromBefore ? f.editor.firstElementChild : f.editor.lastElementChild).firstChild;
                const paragraphs = f.editor.querySelectorAll('.mdw-callout-content p');
                const target = paragraphs[fromBefore ? 0 : paragraphs.length - 1];
                f.caret(source, fromBefore ? source.length : 0);
                const range = f.move(method);
                assert.ok(target === range.startContainer || target.contains(range.startContainer), 'enter the nearest body paragraph');
                if (method === 'moveCursorForward' && target.firstChild.nodeType === 3) assert.equal(range.startOffset, 0);
                if (method === 'moveCursorBackward' && target.firstChild.nodeType === 3) assert.equal(range.startOffset, target.firstChild.length);
                assert.equal(f.editor.innerHTML, original, 'navigation leaves body and source metadata unchanged');
            } finally { f.restore(); }
        });
    }
}

for (const [method, backwards] of [
    ['moveCursorBackward', true], ['moveCursorUp', true],
    ['moveCursorForward', false], ['moveCursorDown', false],
]) {
    test(`${method} leaves the body without stopping in the callout title`, async () => {
        const f = await fixture(`<p>Before</p>${callout('<p>First</p><p>Last</p>')}<p>After</p>`);
        try {
            const original = f.editor.innerHTML;
            const paragraph = f.editor.querySelector(backwards ? '.mdw-callout-content p:first-child' : '.mdw-callout-content p:last-child');
            const expected = backwards ? f.editor.firstElementChild : f.editor.lastElementChild;
            f.caret(paragraph.firstChild, backwards ? 0 : paragraph.firstChild.length);
            const range = f.move(method);
            assert.ok(expected.contains(range.startContainer));
            if (method === 'moveCursorBackward') assert.equal(range.startOffset, expected.firstChild.length);
            if (method === 'moveCursorForward') assert.equal(range.startOffset, 0);
            assert.equal(f.editor.innerHTML, original);
        } finally { f.restore(); }
    });
}

test('moving backward out of a nested callout returns to the parent body paragraph', async () => {
    const f = await fixture(callout(`<p>Parent before</p>${callout('<p>Inner</p>', 'Tip')}<p>Parent after</p>`));
    try {
        const inner = f.editor.querySelector('.mdw-callout-content .mdw-callout-content p').firstChild;
        const preceding = f.editor.querySelector('.mdw-callout-content > p').firstChild;
        f.caret(inner);
        const range = f.move('moveCursorBackward');
        assert.equal(range.startContainer === preceding, true, 'return to the editable parent paragraph');
        assert.equal(range.startOffset, preceding.length);
    } finally { f.restore(); }
});

test('navigation between paragraphs stays within the callout body', async () => {
    const f = await fixture(`<p>Before</p>${callout('<p>First</p><p>Last</p>')}<p>After</p>`);
    try {
        const first = f.editor.querySelector('.mdw-callout-content p:first-child').firstChild;
        const last = f.editor.querySelector('.mdw-callout-content p:last-child').firstChild;
        for (const [method, start, offset, expected] of [
            ['moveCursorForward', first, first.length, last],
            ['moveCursorBackward', last, 0, first],
            ['moveCursorDown', first, 2, last],
            ['moveCursorUp', last, 2, first],
        ]) {
            f.caret(start, offset);
            assert.equal(f.move(method).startContainer === expected, true, method);
        }
    } finally { f.restore(); }
});

test('line-start fallback from a restored callout boundary targets the body instead of its title', async () => {
    const f = await fixture(`<p>Before</p>${callout('<p>First</p><p>Last</p>')}<p>After</p>`);
    try {
        const block = f.editor.querySelector('[data-mdw-callout]');
        const text = block.querySelector('p').firstChild;
        for (const offset of [0, 1]) {
            f.caret(block, offset);
            const range = f.move('moveCursorToLineStart');
            assert.equal(range.startContainer === text, true, 'line-start targets the first editable body text');
            assert.equal(range.startOffset, 0);
        }
    } finally { f.restore(); }
});

for (const [name, wrap] of [
    ['a quote', body => `<blockquote>${body}</blockquote>`],
    ['a list item', body => `<ul><li>${body}</li></ul>`],
]) {
    for (const [method, fromBefore] of [
        ['moveCursorForward', true], ['moveCursorDown', true],
        ['moveCursorBackward', false], ['moveCursorUp', false],
    ]) {
        test(`${method} retains an empty callout edge nested inside ${name}`, async () => {
            const body = fromBefore ? '<p><br></p><p>Last</p>' : '<p>First</p><p><br></p>';
            const f = await fixture(`<p>Before</p>${wrap(callout(body))}<p>After</p>`);
            try {
                const source = (fromBefore ? f.editor.firstElementChild : f.editor.lastElementChild).firstChild;
                const paragraphs = f.editor.querySelectorAll('.mdw-callout-content p');
                const target = paragraphs[fromBefore ? 0 : paragraphs.length - 1];
                const original = f.editor.innerHTML;
                f.caret(source, fromBefore ? source.length : 0);
                const range = f.move(method);
                assert.ok(range.startContainer === target || target.contains(range.startContainer));
                assert.equal(f.editor.innerHTML, original);
            } finally { f.restore(); }
        });
    }
}

function editorFunctions(f, names = ['getPreferredFirstTextNodeForElement', 'createCollapsedRangeAtElementBoundary', 'placeCursorAtElementBoundary'], stubs = {}) {
    const extract = name => {
        const start = editorSource.indexOf(`    function ${name}(`);
        assert.ok(start >= 0, `${name} exists`);
        const end = editorSource.indexOf('\n    }', start);
        return editorSource.slice(start, end + '\n    }'.length);
    };
    return new Function('document', 'window', 'Node', 'editor', 'domUtils', 'cursorManager', ...Object.keys(stubs),
        `${names.map(extract).join('\n')}\nreturn { ${names.join(', ')} };`
    )(f.document, f.window, f.window.Node, f.editor, f.domUtils, f.cursor, ...Object.values(stubs));
}

for (const [method, fromBefore] of [['moveCursorUp', false], ['moveCursorDown', true]]) {
    test(`${method} rejects a browser geometry hit inside the readonly callout title`, async () => {
        const f = await fixture(`<p>Before</p>${callout('<p>First</p><p>Last</p>')}<p>After</p>`);
        try {
            const title = f.editor.querySelector('.mdw-callout-title');
            const source = (fromBefore ? f.editor.firstElementChild : f.editor.lastElementChild).firstChild;
            const paragraphs = f.editor.querySelectorAll('.mdw-callout-content p');
            const expected = paragraphs[fromBefore ? 0 : paragraphs.length - 1];
            const rect = top => ({ x: 10, y: top, top, bottom: top + 20, left: 10, right: 11, width: 1, height: 20 });
            f.caret(source, fromBefore ? source.length : 0);
            f.selection.getRangeAt(0).getBoundingClientRect = () => rect(fromBefore ? 0 : 100);
            f.cursor._getVisualCaretRectForRange = range => range.getBoundingClientRect();
            let probes = 0;
            f.document.elementFromPoint = () => title;
            f.document.caretRangeFromPoint = () => {
                probes++;
                const range = f.document.createRange();
                range.setStart(title.firstChild, 1); range.collapse(true);
                range.getBoundingClientRect = () => rect(40);
                return range;
            };
            const original = f.editor.innerHTML;
            const range = f.move(method);
            assert.ok(probes > 0, 'the browser hit-test path was exercised');
            assert.ok(expected.contains(range.startContainer) || expected === range.startContainer);
            assert.equal(f.editor.innerHTML, original);
        } finally { f.restore(); }
    });
}

for (const method of ['moveCursorUp', 'moveCursorDown', 'moveCursorForward', 'moveCursorBackward']) {
    test(`${method} recovers a stale title caret into the same callout body`, async () => {
        const f = await fixture(`<p>Before</p>${callout('<p>Body</p>')}<p>After</p>`);
        try {
            const title = f.editor.querySelector('.mdw-callout-title').firstChild;
            const body = f.editor.querySelector('.mdw-callout-content p');
            const original = f.editor.innerHTML;
            f.caret(title, 2);
            const range = f.move(method);
            assert.ok(body.contains(range.startContainer) || range.startContainer === body);
            assert.equal(f.editor.innerHTML, original);
        } finally { f.restore(); }
    });
}

for (const [method, fromBefore] of [['moveCursorUp', false], ['moveCursorDown', true]]) {
    test(`${method} rejects a readonly title returned by the adjusted geometry probe`, async () => {
        const f = await fixture(`<p>Before</p>${callout('<p>First</p><p>Last</p>')}<p>After</p>`);
        try {
            const title = f.editor.querySelector('.mdw-callout-title');
            const source = (fromBefore ? f.editor.firstElementChild : f.editor.lastElementChild).firstChild;
            const paragraphs = f.editor.querySelectorAll('.mdw-callout-content p');
            const expected = paragraphs[fromBefore ? 0 : paragraphs.length - 1];
            const rect = top => ({ x: 10, y: top, top, bottom: top + 20, left: 10, right: 11, width: 1, height: 20 });
            f.caret(source, fromBefore ? source.length : 0);
            f.selection.getRangeAt(0).getBoundingClientRect = () => rect(fromBefore ? 0 : 100);
            f.cursor._getVisualCaretRectForRange = range => range.getBoundingClientRect();
            let probes = 0;
            f.document.elementFromPoint = () => expected;
            f.document.caretRangeFromPoint = () => {
                const range = f.document.createRange();
                range.setStart(++probes === 1 ? expected.firstChild : title.firstChild, 1);
                range.collapse(true);
                range.getBoundingClientRect = () => rect(40);
                return range;
            };
            const original = f.editor.innerHTML;
            const range = f.move(method);
            assert.ok(probes > 1, 'the adjusted line-center probe was exercised');
            assert.ok(expected.contains(range.startContainer) || expected === range.startContainer);
            assert.equal(f.editor.innerHTML, original);
        } finally { f.restore(); }
    });
}

for (const [description, body, targetTag = 'p'] of [
    ['loaded paragraphs', '\n<p>First</p>\n<p>Last</p>\n'],
    ['empty body', '<p><br></p>'],
    ['leading and trailing empty paragraphs', '<p><br></p><p>Middle</p><p><br></p>'],
    ['nested callout', callout('<p>Inner</p>', 'Tip')],
    ['code with generated controls', '<pre><div class="code-block-toolbar" contenteditable="false"><span class="code-block-language">text</span></div><code>Code</code></pre>', 'code'],
    ['empty code with generated controls', '<pre><div class="code-block-toolbar" contenteditable="false"><span class="code-block-language">text</span></div><code></code></pre>', 'code'],
]) {
    test(`preferred entry after another block skips readonly titles for ${description}`, async () => {
        const f = await fixture(`<pre><code>code</code></pre><hr>${callout(body)}<p>After</p>`);
        try {
            const block = f.editor.querySelector('[data-mdw-callout]');
            const target = block.querySelector(targetTag);
            const original = f.editor.innerHTML;
            const node = editorFunctions(f).getPreferredFirstTextNodeForElement(block);
            assert.ok(node === target || target.contains(node));
            assert.equal(f.editor.innerHTML, original);
        } finally { f.restore(); }
    });
    for (const boundary of ['start', 'end']) {
        test(`padding click at the ${boundary} of ${description} resolves to the editable body`, async () => {
            const f = await fixture(`<pre><code>code</code></pre><hr>${callout(body)}<p>After</p>`);
            try {
                const block = f.editor.querySelector('[data-mdw-callout]');
                const paragraphs = block.querySelectorAll(targetTag);
                const target = paragraphs[boundary === 'start' ? 0 : paragraphs.length - 1];
                const original = f.editor.innerHTML;
                const range = editorFunctions(f).createCollapsedRangeAtElementBoundary(block, boundary);
                assert.ok(range.startContainer === target || target.contains(range.startContainer));
                assert.equal(range.collapsed, true);
                assert.equal(f.editor.innerHTML, original);
            } finally { f.restore(); }
        });
        test(`entry from code or a horizontal rule at the ${boundary} of ${description} skips titles`, async () => {
            const f = await fixture(`<pre><code>code</code></pre><hr>${callout(body)}<p>After</p>`);
            try {
                const block = f.editor.querySelector('[data-mdw-callout]');
                const paragraphs = block.querySelectorAll(targetTag);
                const target = paragraphs[boundary === 'start' ? 0 : paragraphs.length - 1];
                const original = f.editor.innerHTML;
                assert.equal(editorFunctions(f).placeCursorAtElementBoundary(block, boundary), true);
                const range = f.selection.getRangeAt(0);
                assert.ok(range.startContainer === target || target.contains(range.startContainer));
                assert.equal(range.collapsed, true);
                assert.equal(f.editor.innerHTML, original);
            } finally { f.restore(); }
        });
    }
}

for (const body of ['<p>First</p><p>Last</p>', '<p><br></p>']) {
    for (const atStart of [true, false]) {
        test(`removing an adjacent image places the caret at the callout body ${atStart ? 'start' : 'end'}: ${body}`, async () => {
            const f = await fixture(callout(body));
            try {
                const block = f.editor.firstElementChild;
                const original = f.editor.innerHTML;
                const paragraphs = block.querySelectorAll('p');
                const expected = paragraphs[atStart ? 0 : paragraphs.length - 1];
                editorFunctions(f, ['placeCaretAfterImageRemoval']).placeCaretAfterImageRemoval(
                    f.editor, atStart ? block : null, atStart ? null : block
                );
                const range = f.selection.getRangeAt(0);
                assert.ok(expected.contains(range.startContainer) || expected === range.startContainer);
                assert.equal(f.editor.innerHTML, original);
            } finally { f.restore(); }
        });
        test(`deleting adjacent code places the caret at the callout body ${atStart ? 'start' : 'end'}: ${body}`, async () => {
            const code = '<pre><code>temporary</code></pre>';
            const f = await fixture(atStart ? code + callout(body) : callout(body) + code);
            try {
                const block = f.editor.querySelector('[data-mdw-callout]');
                const original = block.outerHTML;
                const paragraphs = block.querySelectorAll('p');
                const expected = paragraphs[atStart ? 0 : paragraphs.length - 1];
                const helpers = editorFunctions(f, ['deleteCodeBlock'], {
                    getNextElementSibling: node => node.nextElementSibling,
                    getPreviousElementSibling: node => node.previousElementSibling,
                });
                helpers.deleteCodeBlock(f.editor.querySelector('pre'), f.selection);
                const range = f.selection.getRangeAt(0);
                assert.ok(expected.contains(range.startContainer) || expected === range.startContainer);
                assert.ok(!f.editor.querySelector('pre'));
                assert.equal(block.outerHTML, original);
            } finally { f.restore(); }
        });
        test(`deleting an adjacent rule places the caret at the callout body ${atStart ? 'start' : 'end'}: ${body}`, async () => {
            const f = await fixture(atStart ? '<hr>' + callout(body) : callout(body) + '<hr>');
            try {
                const block = f.editor.querySelector('[data-mdw-callout]');
                const original = block.outerHTML;
                const paragraphs = block.querySelectorAll('p');
                const expected = paragraphs[atStart ? 0 : paragraphs.length - 1];
                editorFunctions(f, ['deleteSelectedHR']).deleteSelectedHR(f.editor.querySelector('hr'), atStart ? 'forward' : 'backward');
                const range = f.selection.getRangeAt(0);
                assert.ok(expected.contains(range.startContainer) || expected === range.startContainer);
                assert.ok(!f.editor.querySelector('hr'));
                assert.equal(block.outerHTML, original);
            } finally { f.restore(); }
        });
    }
    for (const name of ['moveCursorAboveCodeBlockFromLabel', 'moveCursorAboveCodeBlockFromLabelToLineEnd']) {
        test(`${name} enters the last editable callout paragraph: ${body}`, async () => {
            const f = await fixture(callout(body) + '<pre><div class="code-block-toolbar" contenteditable="false"><span class="code-block-language">text</span></div><code>code</code></pre>');
            try {
                const block = f.editor.querySelector('[data-mdw-callout]');
                const original = f.editor.innerHTML;
                const expected = block.querySelector('.mdw-callout-content').lastElementChild;
                const helpers = editorFunctions(f, [name], {
                    codeBlockGapManager: { moveToGap: () => false },
                    setCodeBlockLanguageNavSelection: () => {},
                    getPreviousElementSibling: node => node.previousElementSibling,
                    moveCursorToCodeBlockLastContentLineEnd: () => false,
                });
                assert.equal(helpers[name](f.editor.querySelector('.code-block-language')), true);
                const range = f.selection.getRangeAt(0);
                assert.ok(expected.contains(range.startContainer) || expected === range.startContainer);
                assert.equal(f.editor.innerHTML, original);
            } finally { f.restore(); }
        });
    }
}
