const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const moduleSource = fs.readFileSync(path.join(__dirname, '../media/modules/InlineTocManager.js'), 'utf8');
const slugSource = fs.readFileSync(path.join(__dirname, '../media/modules/MarkdownHeadingSlug.js'), 'utf8');
const slugUrl = `data:text/javascript;base64,${Buffer.from(slugSource).toString('base64')}`;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource.replace('./MarkdownHeadingSlug.js', slugUrl)).toString('base64')}`;
const modulePromise = import(moduleUrl);

class TestRange {
    constructor() { this.collapsed = true; }
    setStart(node, offset) {
        this.startContainer = node; this.startOffset = offset;
        if (!this.endContainer || this.collapsed) { this.endContainer = node; this.endOffset = offset; }
        this.collapsed = node === this.endContainer && offset === this.endOffset;
    }
    setEnd(node, offset) {
        this.endContainer = node; this.endOffset = offset;
        this.collapsed = node === this.startContainer && offset === this.startOffset;
    }
    setStartBefore(node) { this.setStart(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node)); }
    setStartAfter(node) { this.setStart(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node) + 1); }
    setEndAfter(node) { this.setEnd(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node) + 1); }
    selectNode(node) { this.setStartBefore(node); this.setEndAfter(node); }
    selectNodeContents(node) { this.setStart(node, 0); this.setEnd(node, node.nodeType === 3 ? node.length : node.childNodes.length); }
    collapse(start) {
        if (start) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
        else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; }
        this.collapsed = true;
    }
    cloneRange() { return Object.assign(new TestRange(), this); }
}

async function fixture(html = '', options = {}) {
    const { InlineTocManager } = await modulePromise;
    const window = domino.createWindow(`<div id="editor" contenteditable="true">${html}</div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    let range = null;
    const selection = {
        get rangeCount() { return range ? 1 : 0; },
        getRangeAt: () => range,
        removeAllRanges() { range = null; },
        addRange(value) {
            range = value;
            this.anchorNode = range.startContainer; this.anchorOffset = range.startOffset;
            this.focusNode = range.endContainer; this.focusOffset = range.endOffset;
        }
    };
    window.getSelection = () => selection;
    document.createRange = () => new TestRange();
    const saved = [], notifications = [];
    const manager = new InlineTocManager(editor, {
        beforeChange: () => saved.push(editor.innerHTML),
        onChange: () => notifications.push(editor.innerHTML),
        ...options
    });
    return {
        window, document, editor, manager, selection, saved, notifications,
        range: () => range,
        caret(node, offset) {
            range = new TestRange(); range.setStart(node, offset); range.collapse(true);
        },
        selectText(node, start, end) {
            range = new TestRange(); range.setStart(node, start); range.setEnd(node, end);
        },
        insertBlock() {
            const block = manager.createBlock(); editor.appendChild(block); return block;
        },
    };
}

function keyEvent(key, options = {}) {
    return {
        key, defaultPrevented: false, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...options
    };
}

function links(block) {
    return Array.from(block.querySelectorAll('a')).map(link => [link.textContent, link.getAttribute('href')]);
}

// Browser-shaped line geometry without relying on layout in Domino. Text and
// BRs have visible rectangles; a collapsed element-boundary range has none,
// as Chromium commonly reports after selectNodeContents(p).collapse(false).
function installLineGeometry(f, textLines, breakLines = new Map()) {
    const zero = {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0};
    const lineRect = (top, left = 0, width = 8) =>
        ({top, bottom: top + 20, left, right: left + width, width, height: 20});
    const allRects = node => {
        if (node.nodeType === 3) return (textLines.get(node) || []).map((top, index) => lineRect(top, index * 8));
        if (node.tagName === 'BR') return breakLines.has(node) ? [lineRect(breakLines.get(node), 0, 0)] : [];
        return Array.from(node.childNodes || []).flatMap(allRects);
    };
    const rangeRects = range => {
        const node = range.startContainer;
        if (node !== range.endContainer) return [];
        if (node.nodeType === 3) {
            const lines = textLines.get(node) || [];
            if (range.collapsed) {
                if (!lines.length) return [];
                return [lineRect(lines[Math.min(range.startOffset, lines.length - 1)], range.startOffset * 8, 0)];
            }
            return lines.slice(range.startOffset, range.endOffset)
                .map((top, index) => lineRect(top, (range.startOffset + index) * 8));
        }
        if (range.collapsed) return [];
        return Array.from(node.childNodes).slice(range.startOffset, range.endOffset).flatMap(allRects);
    };
    const bounds = rects => {
        if (!rects.length) return zero;
        const top = Math.min(...rects.map(rect => rect.top));
        const bottom = Math.max(...rects.map(rect => rect.bottom));
        const left = Math.min(...rects.map(rect => rect.left));
        const right = Math.max(...rects.map(rect => rect.right));
        return {top, bottom, left, right, width: right - left, height: bottom - top};
    };
    const decorate = range => {
        range.getClientRects = function () { return rangeRects(this); };
        range.getBoundingClientRect = function () { return bounds(rangeRects(this)); };
        return range;
    };
    f.document.createRange = () => decorate(new TestRange());
    for (const node of Array.from(f.editor.querySelectorAll('*'))) {
        node.getClientRects = () => allRects(node);
        node.getBoundingClientRect = () => bounds(allRects(node));
    }
    decorate(f.range());
}

for (const [description, html, selector] of [
    ['plain text', '<p id="before">Before text</p>', '#before'],
    ['a formatted span', '<p><strong id="before">Before text</strong></p>', '#before'],
    ['inline code', '<p><code id="before">Before text</code></p>', '#before'],
    ['a native DIV paragraph', '<div id="before">Before text</div>', '#before'],
]) {
    test(`Down enters the TOC from the middle of the final line in ${description}, with zero element-boundary rects`, async () => {
        const f = await fixture(html + '<h1>Target</h1>');
        const text = f.editor.querySelector(selector).firstChild;
        const paragraph = text.parentElement.closest('p, div');
        const block = f.manager.createBlock();
        f.editor.insertBefore(block, paragraph.nextSibling);
        f.caret(text, 3);
        installLineGeometry(f, new Map([[text, Array(text.length).fill(30)]]));
        const event = keyEvent('ArrowDown');
        assert.equal(f.manager.handleKeyDown(event), true);
        assert.equal(event.defaultPrevented, true);
        assert.equal(f.manager.getFocusedItem().getAttribute('href'), '#target');
        assert.equal(f.saved.length, 0);
        assert.equal(f.notifications.length, 0);
    });
}

test('Down stays inside earlier wrapped lines and enters the TOC only from the last visual line', async () => {
    const f = await fixture('<p id="before">First line last line</p><h1>Target</h1>');
    const paragraph = f.editor.querySelector('#before'), text = paragraph.firstChild;
    const block = f.manager.createBlock(); f.editor.insertBefore(block, paragraph.nextSibling);
    const lines = Array.from({length: text.length}, (_, index) => index < 11 ? 10 : 35);
    f.caret(text, 3); installLineGeometry(f, new Map([[text, lines]]));
    assert.equal(f.manager.handleKeyDown(keyEvent('ArrowDown')), false);
    assert.equal(f.range().startContainer, text);
    assert.equal(f.range().startOffset, 3);
    f.caret(text, 14); installLineGeometry(f, new Map([[text, lines]]));
    assert.equal(f.manager.handleKeyDown(keyEvent('ArrowDown')), true);
    assert.equal(f.manager.getFocusedItem().textContent, 'Target');
});

test('a real BR-separated final line enters the TOC without skipping it', async () => {
    const f = await fixture('<p id="before">First<br>Last line</p><h1>Target</h1>');
    const paragraph = f.editor.querySelector('#before'), first = paragraph.firstChild, last = paragraph.lastChild;
    const block = f.manager.createBlock(); f.editor.insertBefore(block, paragraph.nextSibling);
    f.caret(last, 3);
    installLineGeometry(f, new Map([[first, Array(first.length).fill(0)], [last, Array(last.length).fill(25)]]),
        new Map([[paragraph.querySelector('br'), 0]]));
    assert.equal(f.manager.handleKeyDown(keyEvent('ArrowDown')), true);
    assert.equal(f.manager.getFocusedItem().textContent, 'Target');
});

test('root text created by native editing enters the following TOC from its final line', async () => {
    const f = await fixture('Root text<h1>Target</h1>');
    const text = f.editor.firstChild;
    const block = f.manager.createBlock(); f.editor.insertBefore(block, text.nextSibling);
    f.caret(text, 3); installLineGeometry(f, new Map([[text, Array(text.length).fill(20)]]));
    assert.equal(f.manager.handleKeyDown(keyEvent('ArrowDown')), true);
    assert.equal(f.manager.getFocusedItem().textContent, 'Target');
});

test('Up enters the previous TOC from the middle of the first wrapped line but not a later line', async () => {
    const f = await fixture('<h1>First</h1><h2>Last</h2><p id="after">First line last line</p>');
    const paragraph = f.editor.querySelector('#after'), text = paragraph.firstChild;
    const block = f.manager.createBlock(); f.editor.insertBefore(block, paragraph);
    const lines = Array.from({length: text.length}, (_, index) => index < 11 ? 10 : 35);
    f.caret(text, 14); installLineGeometry(f, new Map([[text, lines]]));
    assert.equal(f.manager.handleKeyDown(keyEvent('ArrowUp')), false);
    assert.equal(f.range().startOffset, 14);
    f.caret(text, 3); installLineGeometry(f, new Map([[text, lines]]));
    assert.equal(f.manager.handleKeyDown(keyEvent('ArrowUp')), true);
    assert.equal(f.manager.getFocusedItem().textContent, 'Last');
});

test('a trailing empty BR line is traversed before entering the neighboring TOC', async () => {
    const f = await fixture('<p id="before">First<br><br></p><h1>Target</h1>');
    const paragraph = f.editor.querySelector('#before'), text = paragraph.firstChild;
    const block = f.manager.createBlock(); f.editor.insertBefore(block, paragraph.nextSibling);
    const breaks = Array.from(paragraph.querySelectorAll('br'));
    f.caret(text, text.length);
    installLineGeometry(f, new Map([[text, Array(text.length).fill(0)]]), new Map([[breaks[0], 0], [breaks[1], 25]]));
    assert.equal(f.manager.handleKeyDown(keyEvent('ArrowDown')), false, 'an earlier line must keep native paragraph navigation');
    assert.equal(f.range().startContainer, text);
    assert.equal(f.manager.getFocusedItem(), null);
});

test('empty paragraphs can enter the TOC, while selections, Shift navigation and IME are preserved', async () => {
    const f = await fixture('<p id="before"><br></p><h1>Target</h1>');
    const paragraph = f.editor.querySelector('#before');
    const block = f.manager.createBlock(); f.editor.insertBefore(block, paragraph.nextSibling);
    f.caret(paragraph, 0);
    assert.equal(f.manager.handleKeyDown(keyEvent('ArrowDown', {shiftKey: true})), false);
    assert.equal(f.manager.handleKeyDown(keyEvent('ArrowDown', {isComposing: true})), false);
    assert.equal(f.manager.handleKeyDown(keyEvent('ArrowDown')), true);
    assert.equal(f.manager.getFocusedItem().textContent, 'Target');
    f.caret(paragraph, 0); f.range().setEnd(paragraph, 1);
    assert.equal(f.manager.handleKeyDown(keyEvent('ArrowDown')), false);
});

for (const tag of ['p', 'div']) {
    test(`wrapped ${tag.toUpperCase()} element-boundary carets never use the whole paragraph bounds as a single line`, async () => {
        const f = await fixture(`<${tag} id="before">First line last line</${tag}><h1>Target</h1>`, {
            getCaretRect: range => range.startContainer.nodeType === 1
                ? range.startContainer.getBoundingClientRect() : range.getBoundingClientRect()
        });
        const paragraph = f.editor.querySelector('#before'), text = paragraph.firstChild;
        const block = f.manager.createBlock(); f.editor.insertBefore(block, paragraph.nextSibling);
        const lines = Array.from({length: text.length}, (_, index) => index < 11 ? 10 : 35);
        f.caret(paragraph, 0); installLineGeometry(f, new Map([[text, lines]]));
        assert.equal(f.manager.handleKeyDown(keyEvent('ArrowDown')), false,
            'offset zero is on the first wrapped line, even when the shared fallback spans the whole block');
        assert.equal(f.range().startContainer, paragraph);
        f.caret(paragraph, paragraph.childNodes.length); installLineGeometry(f, new Map([[text, lines]]));
        assert.equal(f.manager.handleKeyDown(keyEvent('ArrowDown')), true,
            'the element boundary at the actual text end is on the final line');
        assert.equal(f.manager.getFocusedItem().textContent, 'Target');
    });
}

test('Up from a wrapped paragraph element end stays in that paragraph until its first visual line', async () => {
    const f = await fixture('<h1>Target</h1><p id="after">First line last line</p>', {
        getCaretRect: range => range.startContainer.nodeType === 1
            ? range.startContainer.getBoundingClientRect() : range.getBoundingClientRect()
    });
    const paragraph = f.editor.querySelector('#after'), text = paragraph.firstChild;
    const block = f.manager.createBlock(); f.editor.insertBefore(block, paragraph);
    const lines = Array.from({length: text.length}, (_, index) => index < 11 ? 10 : 35);
    f.caret(paragraph, paragraph.childNodes.length); installLineGeometry(f, new Map([[text, lines]]));
    assert.equal(f.manager.handleKeyDown(keyEvent('ArrowUp')), false);
    f.caret(paragraph, 0); installLineGeometry(f, new Map([[text, lines]]));
    assert.equal(f.manager.handleKeyDown(keyEvent('ArrowUp')), true);
    assert.equal(f.manager.getFocusedItem().textContent, 'Target');
});

test('element-boundary carets traverse multiple blank BR rows before entering the TOC', async () => {
    const f = await fixture('<p id="before">One<br><br><br></p><h1>Target</h1>', {
        getCaretRect: range => range.startContainer.nodeType === 1
            ? range.startContainer.getBoundingClientRect() : range.getBoundingClientRect()
    });
    const paragraph = f.editor.querySelector('#before'), text = paragraph.firstChild;
    const block = f.manager.createBlock(); f.editor.insertBefore(block, paragraph.nextSibling);
    const breaks = Array.from(paragraph.querySelectorAll('br'));
    const breakLines = new Map(breaks.map((node, index) => [node, index * 25]));
    for (const offset of [1, 2]) {
        f.caret(paragraph, offset);
        installLineGeometry(f, new Map([[text, Array(text.length).fill(0)]]), breakLines);
        assert.equal(f.manager.handleKeyDown(keyEvent('ArrowDown')), false,
            `element offset ${offset} still has a lower blank row`);
    }
    f.caret(paragraph, 3);
    installLineGeometry(f, new Map([[text, Array(text.length).fill(0)]]), breakLines);
    assert.equal(f.manager.handleKeyDown(keyEvent('ArrowDown')), true, 'the final empty row can enter the TOC');
    assert.equal(f.manager.getFocusedItem().textContent, 'Target');
});

test('Down moves through each native blank BR row before entering the neighboring TOC', async () => {
    const f = await fixture('<p id="before"><br><br><br></p><h1>Target</h1><p>After</p>');
    const paragraph = f.editor.querySelector('#before');
    const block = f.manager.createBlock(); f.editor.insertBefore(block, paragraph.nextSibling);
    const original = Array.from(f.editor.childNodes).filter(node => node !== block).map(node => node.outerHTML);
    const breaks = Array.from(paragraph.querySelectorAll('br'));
    const breakLines = new Map(breaks.map((node, index) => [node, index * 25]));
    const movements = [];
    f.selection.modify = (alteration, direction, granularity) => {
        movements.push([alteration, direction, granularity]);
        const next = f.document.createRange();
        next.setStart(paragraph, f.range().startOffset + 1); next.collapse(true);
        f.selection.removeAllRanges(); f.selection.addRange(next);
    };
    f.caret(paragraph, 0); installLineGeometry(f, new Map(), breakLines);
    for (const expectedOffset of [1, 2]) {
        const event = keyEvent('ArrowDown');
        assert.equal(f.manager.handleKeyDown(event), true);
        assert.equal(event.defaultPrevented, true, 'generic cursor handling must not skip the blank rows');
        assert.equal(f.range().startContainer, paragraph);
        assert.equal(f.range().startOffset, expectedOffset);
        assert.equal(f.manager.getFocusedItem(), null);
    }
    const event = keyEvent('ArrowDown');
    assert.equal(f.manager.handleKeyDown(event), true);
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.manager.getFocusedItem().textContent, 'Target');
    assert.deepEqual(movements, [['move', 'forward', 'line'], ['move', 'forward', 'line']]);
    assert.deepEqual(Array.from(f.editor.childNodes).filter(node => node !== block).map(node => node.outerHTML), original);
    assert.deepEqual(links(block), [['Target', '#target']]);
    assert.equal(f.saved.length, 0);
    assert.equal(f.notifications.length, 0);
});

test('native line movement that crosses the readonly TOC stops on its first item', async () => {
    const f = await fixture('<p id="before"><br><br><br></p><h1>Target</h1><p id="after">After</p>');
    const paragraph = f.editor.querySelector('#before'), after = f.editor.querySelector('#after').firstChild;
    const block = f.manager.createBlock(); f.editor.insertBefore(block, paragraph.nextSibling);
    const original = Array.from(f.editor.childNodes).filter(node => node !== block).map(node => node.outerHTML);
    const breaks = Array.from(paragraph.querySelectorAll('br'));
    f.caret(paragraph, 1);
    installLineGeometry(f, new Map(), new Map(breaks.map((node, index) => [node, index * 25])));
    f.selection.modify = () => {
        const next = f.document.createRange(); next.setStart(after, 0); next.collapse(true);
        f.selection.removeAllRanges(); f.selection.addRange(next);
    };
    const event = keyEvent('ArrowDown');
    assert.equal(f.manager.handleKeyDown(event), true);
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.manager.getFocusedItem().textContent, 'Target');
    assert.deepEqual(Array.from(f.editor.childNodes).filter(node => node !== block).map(node => node.outerHTML), original);
    assert.deepEqual(links(block), [['Target', '#target']]);
    assert.equal(f.saved.length, 0);
    assert.equal(f.notifications.length, 0);
});

test('a live TOC is a noneditable, focusable object and exists before any headings', async () => {
    const f = await fixture('<p>Body</p>');
    const block = f.insertBlock();
    assert.equal(block.getAttribute('data-mdw-toc'), 'true');
    assert.equal(block.getAttribute('contenteditable'), 'false');
    assert.equal(block.getAttribute('tabindex'), '0');
    assert.equal(block.getAttribute('role'), 'group');
    assert.equal(block.querySelector('.mdw-toc-empty').textContent, 'No headings yet');
    f.editor.querySelector('p').outerHTML = '<h2>New heading</h2>';
    assert.equal(f.manager.refresh(), true);
    assert.deepEqual(links(block), [['New heading', '#new-heading']]);
    assert.equal(f.saved.length, 0, 'derived content does not add history');
    assert.equal(f.notifications.length, 0, 'refresh does not trigger save loops');
});

test('all live TOCs update text, duplicate slugs, hierarchy and ordering without changing their identity', async () => {
    const f = await fixture('<h1>文書</h1><h2>A</h2><h3>Child</h3><h2>A</h2>');
    const first = f.insertBlock(), second = f.insertBlock();
    assert.deepEqual(links(first), [['文書', '#文書'], ['A', '#a'], ['Child', '#child'], ['A', '#a-1']]);
    const headings = Array.from(f.editor.querySelectorAll('h1, h2, h3'));
    headings[1].textContent = 'Changed';
    headings[2].outerHTML = '<h1>Top level</h1>';
    f.editor.insertBefore(headings[3], headings[0]);
    f.manager.refresh();
    assert.deepEqual(links(first), [['A', '#a'], ['文書', '#文書'], ['Changed', '#changed'], ['Top level', '#top-level']]);
    assert.equal(first.innerHTML, second.innerHTML);
    assert.equal(first.querySelector('a[href="#changed"]').parentElement.parentElement.parentElement.firstChild.textContent, '文書');
    assert.equal(first.isConnected, true);
    assert.equal(f.manager.refresh(), false, 'identical derived contents are not replaced');
});

test('deleting the final heading retains the object and adding a heading revives it', async () => {
    const f = await fixture('<h2>Only</h2>');
    const block = f.insertBlock();
    f.editor.querySelector('h2').remove();
    f.manager.refresh();
    assert.equal(block.querySelectorAll('a').length, 0);
    assert.ok(block.querySelector('.mdw-toc-empty'));
    f.editor.insertAdjacentHTML('afterbegin', '<h3>Returned</h3>');
    f.manager.refresh();
    assert.deepEqual(links(block), [['Returned', '#returned']]);
});

test('raw-source headings are excluded and heading text is never interpreted as HTML', async () => {
    const f = await fixture('<div data-mdw-opaque-source="encoded"><h1>Raw</h1></div>' +
        '<h2>&lt;img src=x&gt; <a href="https://example.com">Link</a></h2>');
    const block = f.insertBlock();
    assert.deepEqual(links(block), [['<img src=x> Link', '#img-srcx-link']]);
    assert.ok(!block.querySelector('img'));
});

test('refresh reconstructs stripped accessibility attributes and preserves object selection', async () => {
    const f = await fixture('<h1>Title</h1>');
    const block = f.insertBlock();
    f.manager.select(block);
    const beforeRange = f.range();
    for (const name of ['role', 'tabindex', 'aria-label', 'contenteditable']) block.removeAttribute(name);
    f.editor.querySelector('h1').textContent = 'Renamed';
    f.manager.refresh();
    assert.equal(block.getAttribute('aria-label'), 'Table of contents');
    assert.equal(block.getAttribute('contenteditable'), 'false');
    assert.equal(block.getAttribute('role'), 'group');
    assert.equal(block.getAttribute('tabindex'), '0');
    assert.equal(f.range(), beforeRange);
    assert.equal(f.manager.getSelectedBlock(), block);
});

test('horizontal movement selects the whole object, then exits to editable text', async () => {
    const f = await fixture('<p id="before">Before</p><p id="after">After</p>');
    const block = f.manager.createBlock();
    const after = f.editor.querySelector('#after');
    f.editor.insertBefore(block, after);
    f.caret(after.firstChild, 0);
    assert.equal(f.manager.moveAcross(f.selection, 'backward'), true);
    assert.equal(f.manager.getSelectedBlock(), block);
    assert.equal(f.manager.moveAcross(f.selection, 'backward'), true);
    assert.equal(f.range().startContainer, f.editor.querySelector('#before'));
    assert.equal(f.range().collapsed, true);
    assert.equal(f.manager.getSelectedBlock(), null);
    assert.equal(f.saved.length, 0, 'navigation does not edit the document');
});

test('Backspace selects the adjacent TOC and removes it whole on the next press, with one history snapshot', async () => {
    const f = await fixture('<h1>Title</h1><p id="after">Keep me</p>');
    const block = f.manager.createBlock();
    const after = f.editor.querySelector('#after');
    f.editor.insertBefore(block, after);
    f.caret(after.firstChild, 0);
    assert.equal(f.manager.handleKeyDown(keyEvent('Backspace')), true);
    assert.equal(f.manager.getSelectedBlock(), block);
    assert.equal(f.saved.length, 0);
    assert.equal(f.manager.handleKeyDown(keyEvent('Backspace')), true);
    assert.ok(!f.editor.querySelector('[data-mdw-toc]'));
    assert.equal(after.textContent, 'Keep me');
    assert.equal(f.saved.length, 1);
    assert.equal(f.notifications.length, 1);
    f.editor.innerHTML = f.saved[0];
    f.manager.refresh();
    assert.deepEqual(links(f.editor.querySelector('[data-mdw-toc]')), [['Title', '#title']]);
});

test('deleting the only object leaves an editable paragraph', async () => {
    const f = await fixture();
    const block = f.insertBlock();
    f.manager.select(block);
    assert.equal(f.manager.handleKeyDown(keyEvent('Delete')), true);
    assert.equal(f.editor.innerHTML, '<p><br></p>');
    assert.equal(f.range().startContainer, f.editor.firstChild);
});

test('beforeinput removes partial internal selections as a complete object and normalizes replacement selections', async () => {
    const f = await fixture('<h1>Title</h1>');
    const block = f.insertBlock();
    const label = block.querySelector('a').firstChild;
    f.selectText(label, 1, 3);
    f.manager.handleBeforeInput({...keyEvent(''), inputType: 'insertText'});
    assert.equal(f.manager.getSelectedBlock(), block);
    assert.equal(f.range().startContainer, f.editor);
    const event = {...keyEvent(''), inputType: 'deleteContentBackward'};
    assert.equal(f.manager.handleBeforeInput(event), true);
    assert.equal(event.defaultPrevented, true);
    assert.ok(!f.editor.querySelector('[data-mdw-toc]'));
    assert.equal(f.editor.querySelector('h1').textContent, 'Title');
});

test('Enter on a nonempty object enters its items without creating text or history', async () => {
    const f = await fixture('<h1>Title</h1>');
    const block = f.insertBlock();
    f.manager.select(block);
    assert.equal(f.manager.handleKeyDown(keyEvent('Delete', {isComposing: true})), false);
    f.editor.setAttribute('contenteditable', 'false');
    assert.equal(f.manager.handleKeyDown(keyEvent('Delete')), false);
    f.editor.setAttribute('contenteditable', 'true');
    assert.equal(f.manager.handleKeyDown(keyEvent('Enter')), true);
    assert.equal(f.manager.getFocusedItem(), block.querySelector('a'));
    assert.equal(block.nextElementSibling, null);
    assert.equal(f.saved.length, 0);
    f.manager.select(block);
    f.manager.handleKeyDown(keyEvent('Enter'));
    assert.equal(f.editor.querySelectorAll('p').length, 0);
});

test('clicking the frame selects the object and clicking an item waits for Enter to navigate', async () => {
    const navigated = [];
    const f = await fixture('<h1>Title</h1>', {onNavigate: href => navigated.push(href)});
    const block = f.insertBlock();
    f.manager.setup();
    const click = target => {
        const event = f.document.createEvent('MouseEvents');
        event.initEvent('click', true, true);
        target.dispatchEvent(event);
    };
    click(block);
    assert.equal(f.manager.getSelectedBlock(), block);
    click(block.querySelector('a'));
    assert.deepEqual(navigated, []);
    assert.equal(f.manager.getFocusedItem(), block.querySelector('a'));
    f.manager.handleKeyDown(keyEvent('Enter'));
    assert.deepEqual(navigated, ['#title']);
});

test('whole-object selection focuses the editor even after item navigation', async () => {
    const f = await fixture('<h1>Title</h1>');
    const block = f.insertBlock();
    let active = f.document.createElement('input');
    let focusCalls = 0;
    Object.defineProperty(f.document, 'activeElement', { configurable: true, get: () => active });
    Object.defineProperty(f.editor, 'focus', { configurable: true, value: options => {
        assert.equal(options.preventScroll, true);
        focusCalls++;
        active = f.editor;
    } });
    f.manager.select(block);
    assert.equal(focusCalls, 1);
    assert.equal(active, f.editor);
    active = block;
    f.manager.select(block);
    assert.equal(focusCalls, 2, 'whole-object selection returns focus to the editable host');
});

test('read-only item cursor moves with arrows and Tab, then exits at the document boundaries', async () => {
    const f = await fixture('<p id="before">Before</p><h1>First</h1><h2>Second</h2><h2>Third</h2><p id="after">After</p>');
    const block = f.manager.createBlock();
    f.editor.insertBefore(block, f.editor.querySelector('#after'));
    const items = Array.from(block.querySelectorAll('a'));
    f.manager.focusItem(block);
    for (const [key, expected] of [['ArrowDown', 1], ['ArrowRight', 2], ['ArrowLeft', 1], ['ArrowUp', 0], ['End', 2], ['Home', 0], ['Tab', 1]]) {
        assert.equal(f.manager.handleKeyDown(keyEvent(key)), true, key);
        assert.equal(f.manager.getFocusedItem(), items[expected], key);
        assert.equal(f.range().collapsed, true, 'navigation does not select or edit generated text');
    }
    f.manager.handleKeyDown(keyEvent('Tab', {shiftKey: true}));
    assert.equal(f.manager.getFocusedItem(), items[0]);
    f.manager.focusItem(block, 2);
    f.manager.handleKeyDown(keyEvent('ArrowDown'));
    assert.equal(f.range().startContainer, f.editor.querySelector('#after'));
    assert.equal(f.manager.getFocusedItem(), null);
    assert.equal(f.saved.length, 0);
    assert.equal(f.notifications.length, 0);
});

test('vertical movement enters neighboring TOC items and macOS Control navigation follows the same path', async () => {
    const f = await fixture('<h1>First</h1><h2>Last</h2><p id="after">After</p>', {isMac: true});
    const block = f.manager.createBlock();
    f.editor.insertBefore(block, f.editor.querySelector('#after'));
    f.caret(f.editor.querySelector('#after').firstChild, 0);
    f.manager.handleKeyDown(keyEvent('ArrowUp'));
    assert.equal(f.manager.getFocusedItem().textContent, 'Last');
    f.manager.handleKeyDown(keyEvent('p', {ctrlKey: true}));
    assert.equal(f.manager.getFocusedItem().textContent, 'First');
    f.manager.handleKeyDown(keyEvent('f', {ctrlKey: true}));
    assert.equal(f.manager.getFocusedItem().textContent, 'Last');
    f.manager.handleKeyDown(keyEvent('n', {ctrlKey: true}));
    assert.equal(f.manager.getFocusedItem(), null);
    assert.equal(f.range().startContainer, f.editor.querySelector('#after'));
});

test('Enter on a TOC item moves the caret to the corresponding heading without editing', async () => {
    const f = await fixture('<h1>First</h1><h2>日本語</h2>');
    const block = f.insertBlock();
    f.manager.focusItem(block, 1);
    const before = f.editor.innerHTML;
    assert.equal(f.manager.handleKeyDown(keyEvent('Enter')), true);
    assert.equal(f.range().startContainer, f.editor.querySelector('h2'));
    assert.equal(f.range().collapsed, true);
    assert.equal(f.manager.getFocusedItem(), null);
    assert.equal(f.editor.innerHTML, before);
    assert.equal(f.saved.length, 0);
});

test('typing, paste, cut and drop cannot modify the generated item under the cursor', async () => {
    const f = await fixture('<h1>Title</h1>');
    const block = f.insertBlock();
    f.manager.setup();
    f.manager.focusItem(block);
    const before = block.innerHTML;
    for (const key of ['x', ' ', 'ArrowDown']) {
        if (key === 'ArrowDown') f.manager.focusItem(block);
        else assert.equal(f.manager.handleKeyDown(keyEvent(key)), true);
    }
    for (const inputType of ['insertText', 'insertParagraph', 'deleteContentBackward']) {
        f.manager.focusItem(block);
        const event = {...keyEvent(''), inputType};
        assert.equal(f.manager.handleBeforeInput(event), true, inputType);
        assert.equal(event.defaultPrevented, true, inputType);
        assert.equal(block.innerHTML, before);
    }
    for (const name of ['paste', 'cut', 'drop']) {
        const event = f.document.createEvent('HTMLEvents');
        event.initEvent(name, true, true);
        block.querySelector('a').dispatchEvent(event);
        assert.equal(event.defaultPrevented, true, name);
    }
    assert.equal(f.saved.length, 0);
});

test('item navigation survives automatic refresh without creating history', async () => {
    const f = await fixture('<h1>First</h1><h2>Second</h2>');
    const block = f.insertBlock();
    f.manager.focusItem(block, 1);
    const item = f.manager.getFocusedItem();
    assert.equal(f.manager.refresh(), false, 'focus metadata must not trigger rendering');
    assert.equal(f.manager.getFocusedItem(), item);
    f.editor.querySelector('h1').textContent = 'Changed';
    assert.equal(f.manager.refresh(), true);
    assert.equal(f.manager.getFocusedItem().getAttribute('href'), '#second');
    f.editor.querySelector('h2').remove();
    f.manager.refresh();
    assert.equal(f.manager.getFocusedItem().textContent, 'Changed');
    assert.equal(f.saved.length, 0);
    assert.equal(f.notifications.length, 0);
});

test('Backspace from an item selects the whole block before a second press deletes it', async () => {
    const f = await fixture('<h1>Title</h1>');
    const block = f.insertBlock();
    f.manager.focusItem(block);
    f.manager.handleKeyDown(keyEvent('Backspace'));
    assert.equal(f.manager.getSelectedBlock(), block);
    assert.equal(f.saved.length, 0);
    f.manager.handleKeyDown(keyEvent('Backspace'));
    assert.ok(!f.editor.querySelector('[data-mdw-toc]'));
    assert.equal(f.saved.length, 1);
});

test('Enter still leaves an empty TOC for a following editable paragraph', async () => {
    const f = await fixture();
    const block = f.insertBlock();
    f.manager.select(block);
    assert.equal(f.manager.handleKeyDown(keyEvent('Enter')), true);
    assert.equal(block.nextElementSibling.tagName, 'P');
    assert.equal(f.saved.length, 1);
});

test('native focus on a previously visited item resets an unrelated selection to a navigation cursor', async () => {
    const f = await fixture('<h1>Title</h1>');
    const block = f.insertBlock();
    f.manager.setup();
    f.selectText(f.editor.querySelector('h1').firstChild, 0, 3);
    const event = f.document.createEvent('HTMLEvents');
    event.initEvent('focusin', true, false);
    block.querySelector('a').dispatchEvent(event);
    assert.equal(f.range().collapsed, true);
    assert.equal(f.manager.getFocusedItem(), block.querySelector('a'));
    assert.equal(f.saved.length, 0);
});

test('generic navigation landing in read-only link text receives a visible, stable item focus', async () => {
    const f = await fixture('<h1>Title</h1>');
    const block = f.insertBlock();
    const item = block.querySelector('a');
    let active = f.editor;
    let focuses = 0;
    Object.defineProperty(f.document, 'activeElement', {configurable: true, get: () => active});
    Object.defineProperty(item, 'focus', {configurable: true, value: () => { active = item; focuses++; }});
    f.manager.setup();
    f.caret(item.firstChild, 2);
    assert.equal(f.manager.normalizeSelection(), true);
    assert.equal(active, item);
    const focusedRange = f.range();
    assert.equal(f.manager.normalizeSelection(), false, 'selectionchange must not loop');
    assert.equal(f.range(), focusedRange);
    assert.equal(focuses, 1);
    assert.equal(f.saved.length, 0);
    assert.equal(f.notifications.length, 0);
});

for (const endpoint of ['start', 'end']) {
    for (const backward of [false, true]) {
        test(`${backward ? 'backward' : 'forward'} selection with its ${endpoint} inside the TOC expands only the object endpoint`, async () => {
            const f = await fixture('<p id="before">Before</p><h1>Title</h1><p id="after">After</p>');
            const block = f.manager.createBlock();
            f.editor.insertBefore(block, f.editor.querySelector('#after'));
            const before = f.editor.querySelector('#before').firstChild;
            const after = f.editor.querySelector('#after').firstChild;
            const label = block.querySelector('a').firstChild;
            f.caret(endpoint === 'start' ? label : before, 2);
            f.range().setEnd(endpoint === 'start' ? after : label, 3);
            const original = f.range();
            Object.assign(f.selection, {
                anchorNode: backward ? original.endContainer : original.startContainer,
                anchorOffset: backward ? original.endOffset : original.startOffset,
                focusNode: backward ? original.startContainer : original.endContainer,
                focusOffset: backward ? original.startOffset : original.endOffset,
            });
            f.selection.setBaseAndExtent = (anchorNode, anchorOffset, focusNode, focusOffset) => {
                const next = new TestRange();
                next.setStart(backward ? focusNode : anchorNode, backward ? focusOffset : anchorOffset);
                next.setEnd(backward ? anchorNode : focusNode, backward ? anchorOffset : focusOffset);
                f.selection.addRange(next);
                Object.assign(f.selection, {anchorNode, anchorOffset, focusNode, focusOffset});
            };
            const event = {...keyEvent(''), inputType: 'deleteContentBackward'};
            assert.equal(f.manager.handleBeforeInput(event), false, 'native deletion must retain the selected outside text');
            assert.equal(event.defaultPrevented, false);
            const index = Array.from(f.editor.childNodes).indexOf(block);
            if (endpoint === 'start') {
                assert.equal(f.range().startContainer, f.editor);
                assert.equal(f.range().startOffset, index);
                assert.equal(f.range().endContainer, after);
                assert.equal(f.range().endOffset, 3);
            } else {
                assert.equal(f.range().startContainer, before);
                assert.equal(f.range().startOffset, 2);
                assert.equal(f.range().endContainer, f.editor);
                assert.equal(f.range().endOffset, index + 1);
            }
            assert.equal(f.selection.anchorNode, backward ? f.range().endContainer : f.range().startContainer);
            assert.equal(f.saved.length, 0, 'normalization is selection-only');
            assert.equal(f.notifications.length, 0);
            assert.equal(f.manager.normalizeSelection(), false, 'normalization must not loop on selectionchange');
        });
    }
}

test('typing over a cross-boundary selection preserves its outside endpoint and includes the complete object', async () => {
    const f = await fixture('<h1>Title</h1><p>Keep after</p>');
    const after = f.editor.querySelector('p').firstChild;
    const block = f.manager.createBlock();
    f.editor.insertBefore(block, f.editor.querySelector('p'));
    f.caret(block.querySelector('a').firstChild, 2);
    f.range().setEnd(after, 4);
    assert.equal(f.manager.handleBeforeInput({...keyEvent(''), inputType: 'insertText'}), false);
    assert.equal(f.range().startContainer, f.editor);
    assert.equal(f.range().startOffset, Array.from(f.editor.childNodes).indexOf(block));
    assert.equal(f.range().endContainer, after);
    assert.equal(f.range().endOffset, 4);
});

test('drag and composition selections are left alone until they finish, and Shift-click keeps surrounding text selected', async () => {
    const f = await fixture('<h1>Title</h1><p>After</p>');
    const paragraph = f.editor.querySelector('p');
    const block = f.manager.createBlock();
    f.editor.insertBefore(block, paragraph);
    f.manager.setup();
    const dispatch = (target, name, properties = {}) => {
        const event = f.document.createEvent('HTMLEvents');
        event.initEvent(name, true, true);
        for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, {value});
        target.dispatchEvent(event);
    };
    const selectPartial = () => {
        f.caret(block.querySelector('a').firstChild, 1);
        f.range().setEnd(paragraph.firstChild, 2);
    };
    dispatch(paragraph, 'mousedown', {button: 0});
    selectPartial();
    dispatch(f.document, 'selectionchange');
    assert.equal(f.range().startContainer, block.querySelector('a').firstChild);
    dispatch(f.document, 'mouseup');
    assert.equal(f.range().startContainer, f.editor);
    dispatch(f.editor, 'compositionstart');
    selectPartial();
    dispatch(f.document, 'selectionchange');
    assert.equal(f.range().startContainer, block.querySelector('a').firstChild);
    dispatch(f.editor, 'compositionend');
    dispatch(f.document, 'selectionchange');
    assert.equal(f.range().startContainer, f.editor);
    dispatch(block, 'click', {shiftKey: true});
    assert.equal(f.range().endContainer, paragraph.firstChild);
    assert.equal(f.range().endOffset, 2);
});
