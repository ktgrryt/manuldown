const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');

function extract(name) {
    const start = source.indexOf(`    function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const end = source.indexOf('\n    }', start);
    return source.slice(start, end + '\n    }'.length);
}

function fixture(html) {
    const window = domino.createWindow(`<div id="editor">${html}</div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    const textNodes = element => {
        const result = [];
        const visit = node => {
            if (node.nodeType === 3) result.push(node);
            else Array.from(node.childNodes).forEach(visit);
        };
        visit(element);
        return result;
    };
    document.createRange = () => ({
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
        selectNodeContents(node) { this.startContainer = node; this.startOffset = 0; },
        collapse() { this.collapsed = true; },
    });
    const domUtils = {
        getFirstTextNode: node => textNodes(node)[0] || null,
        getLastTextNode: node => textNodes(node).at(-1) || null,
        getTextWithoutCaretAnchors: node => node.textContent.replace(/[\u200B\uFEFF]/g, ''),
        getParentElement(node, tag) {
            const element = node.nodeType === 1 ? node : node.parentElement;
            return element.closest(tag.toLowerCase());
        },
    };
    return { window, document, editor, domUtils };
}

for (const boundary of ['start', 'end']) {
    test(`a gap click at a code block's ${boundary} uses editable code instead of toolbar text`, () => {
        const f = fixture('<pre><div data-exclude-from-markdown="true" contenteditable="false"><span>plaintext</span><button>Copy</button></div><code>first\nlast</code></pre>');
        const place = new Function('document', 'Node', 'domUtils',
            `${extract('createCollapsedRangeAtElementBoundary')}\nreturn createCollapsedRangeAtElementBoundary;`
        )(f.document, f.window.Node, f.domUtils);
        const code = f.editor.querySelector('code');
        const range = place(f.editor.querySelector('pre'), boundary);
        assert.equal(range.startContainer, code.firstChild);
        assert.equal(range.startOffset, boundary === 'start' ? 0 : code.textContent.length);
        assert.equal(range.collapsed, true);
    });

    test(`a gap click at a table's ${boundary} avoids its input-blocking edge anchors`, () => {
        const f = fixture('<div class="md-table-wrapper"><div data-exclude-from-markdown="true">\u00A0</div><table><tr><td>first</td><td>last</td></tr></table><div data-exclude-from-markdown="true">\u00A0</div></div>');
        const place = new Function('document', 'Node', 'domUtils',
            `${extract('createCollapsedRangeAtElementBoundary')}\nreturn createCollapsedRangeAtElementBoundary;`
        )(f.document, f.window.Node, f.domUtils);
        const cells = f.editor.querySelectorAll('td');
        const text = cells[boundary === 'start' ? 0 : 1].firstChild;
        const range = place(f.editor.firstChild, boundary);
        assert.equal(range.startContainer, text);
        assert.equal(range.startOffset, boundary === 'start' ? 0 : text.length);
    });
}

function emptyCodeClickFixture({ nativeOutside = false, directHit = true, otherBlock = false } = {}) {
    const f = fixture('<p><code data-is-new="true"><span contenteditable="false"></span>\u200B</code><br></p><p>below</p>');
    const code = f.editor.querySelector('code');
    const block = code.parentElement;
    const outsideText = f.document.createTextNode('\uFEFF');
    block.insertBefore(outsideText, code);
    const range = { startContainer: otherBlock ? f.editor.lastChild.firstChild : nativeOutside ? outsideText : code.lastChild, startOffset: 1, collapsed: true };
    f.window.getSelection = () => ({ rangeCount: 1, isCollapsed: true, getRangeAt: () => range });
    f.document.elementFromPoint = () => directHit ? code : block;
    code.getBoundingClientRect = () => ({ left: 20, right: 34, top: 96, bottom: 116 });
    const placements = [];
    const cursorManager = {
        _placeCursorBeforeInlineCodeElement: () => { placements.push('before'); return true; },
        _placeCursorAfterInlineCodeElement: () => { placements.push('after'); return true; },
        _placeCursorInsideInlineCodeStart: () => { placements.push('inside'); return true; },
    };
    const place = new Function('window', 'document', 'editor', 'Node', 'domUtils', 'cursorManager',
        'getCaretRangeFromPoint', 'getInlineCodeEdgeAtRange', 'getClosestBlockElement',
        `${extract('isInlineCodeNode')}\n${extract('placeCaretAtInlineCodeAfterClick')}\nreturn placeCaretAtInlineCodeAfterClick;`
    )(f.window, f.document, f.editor, f.window.Node, f.domUtils, cursorManager,
        () => range, () => ({ code, side: 'empty' }), () => block);
    return { place, placements };
}

for (const nativeOutside of [false, true]) {
    test(`clicking an empty code box enters it when the native caret is ${nativeOutside ? 'outside' : 'inside'}`, () => {
        const f = emptyCodeClickFixture({ nativeOutside });
        assert.equal(f.place(27, 106), true);
        assert.deepEqual(f.placements, ['inside']);
    });
}

for (const [x, expected] of [[15, 'before'], [54, 'after']]) {
    test(`clicking beside empty code places the caret ${expected} the box`, () => {
        const f = emptyCodeClickFixture({ directHit: false });
        assert.equal(f.place(x, 106), true);
        assert.deepEqual(f.placements, [expected]);
    });
}

test('empty-code click correction preserves placements in another row or block', () => {
    const above = emptyCodeClickFixture();
    assert.equal(above.place(27, 88), false);
    assert.deepEqual(above.placements, []);
    const other = emptyCodeClickFixture({ otherBlock: true });
    assert.equal(other.place(27, 106), false);
    assert.deepEqual(other.placements, []);
});

for (const [name, markup, selector] of [
    ['link', '<a href="https://example.test">link</a>', 'a'],
    ['image', '<img alt="image">', 'img'],
    ['checkbox', '<input type="checkbox">', 'input'],
]) {
    test(`Shift-clicking a selected cell's ${name} suppresses its own click action`, () => {
        const f = fixture(`<table><tr><td>${markup}</td></tr></table>`);
        const cell = f.editor.querySelector('td');
        const target = cell.querySelector(selector);
        let childClicks = 0;
        let closedImageUi = 0;
        let closedLinkUi = 0;
        let hasCellSelection = false;
        target.addEventListener('click', () => { childClicks++; });
        const start = source.indexOf('        // Shift-click selects the whole cell without activating its contents.');
        const end = source.indexOf('        // コードブロック言語ラベルのクリックで編集開始', start);
        assert.ok(start >= 0 && end > start);
        new Function('editor', 'Node', 'isUpdating', 'tableManager', 'hideImageResizeOverlay', 'hideLinkPopover',
            source.slice(start, end)
        )(f.editor, f.window.Node, false, { hasCellSelection: () => hasCellSelection },
            () => { closedImageUi++; }, () => { closedLinkUi++; });
        const click = shiftKey => {
            const event = f.document.createEvent('Event');
            event.initEvent('click', true, true);
            event.shiftKey = shiftKey;
            target.dispatchEvent(event);
            return event.defaultPrevented;
        };

        assert.equal(click(false), false);
        assert.equal(click(true), false);
        assert.equal(childClicks, 2);

        hasCellSelection = true;
        cell.classList.add('md-table-cell-selected');
        assert.equal(click(true), true);
        assert.equal(childClicks, 2);
        assert.equal(closedImageUi, 1);
        assert.equal(closedLinkUi, 1);

        assert.equal(click(false), false);
        assert.equal(childClicks, 3);
    });
}
