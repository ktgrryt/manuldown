const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');

function extractFunction(name) {
    const start = editorSource.indexOf(`    function ${name}(`);
    assert.notEqual(start, -1, `editor.js must define ${name}`);
    const end = editorSource.indexOf('\n    }\n', start);
    return editorSource.slice(start, end + '\n    }'.length);
}

// Domino does not implement Range. The anchor helpers only need caret boundaries.
class TestRange {
    setStart(node, offset) {
        this.startContainer = node;
        this.startOffset = offset;
    }

    setEnd(node, offset) {
        this.endContainer = node;
        this.endOffset = offset;
    }

    collapse() { this.setEnd(this.startContainer, this.startOffset); }

    get collapsed() {
        return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
    }

    get commonAncestorContainer() {
        let node = this.startContainer;
        while (node && node !== this.endContainer && !node.contains(this.endContainer)) node = node.parentNode;
        return node;
    }
}

function createFixture(html) {
    const window = domino.createWindow(`<div id="editor">${html}</div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    document.createRange = () => new TestRange();
    let range = null;
    const selection = {
        get rangeCount() { return range ? 1 : 0; },
        get isCollapsed() { return !range || range.collapsed; },
        getRangeAt: () => range,
        removeAllRanges() { range = null; },
        addRange(next) { range = next; },
    };
    window.getSelection = () => selection;
    const names = [
        'captureRangeDeleteListAnchor', 'restoreEmptyLineAtRangeDeleteAnchor',
        'getTopLevelLineContainer', 'placeCollapsedCaret',
    ];
    const helpers = new Function('window', 'document', 'Node', 'editor',
        `${names.map(extractFunction).join('\n')}\nreturn {
            capture: captureRangeDeleteListAnchor,
            restore: restoreEmptyLineAtRangeDeleteAnchor,
        };`
    )(window, document, window.Node, editor);
    return {
        editor,
        selection,
        ...helpers,
        select(start, startOffset, end = start, endOffset = startOffset) {
            range = new TestRange();
            range.setStart(start, startOffset);
            range.setEnd(end, endOffset);
            return range;
        },
    };
}

test('deleting a list and its following paragraph keeps the caret before surviving text', () => {
    const f = createFixture('<p>before</p><ul><li>remove</li></ul><p>also remove</p><p>survivor</p><p>last</p>');
    const list = f.editor.querySelector('ul');
    const item = list.firstElementChild;
    const removedParagraph = list.nextSibling;
    const survivor = removedParagraph.nextSibling;
    const last = f.editor.lastChild;
    f.select(item.firstChild, 0, removedParagraph.firstChild, removedParagraph.textContent.length);
    const anchor = f.capture([item]);

    // Native deletion and list pruning remove the anchor's immediate next sibling.
    list.remove();
    removedParagraph.remove();
    f.select(f.editor, 1);
    assert.equal(f.restore(anchor, [item]), true);

    const blank = survivor.previousSibling;
    assert.equal(blank.outerHTML, '<p><br></p>');
    assert.equal(f.editor.lastChild, last);
    assert.equal(f.selection.getRangeAt(0).startContainer, blank);
    assert.equal(f.selection.getRangeAt(0).startOffset, 0);
});

test('range deletion finds the first surviving sibling after several removed paragraphs', () => {
    const f = createFixture('<ul><li>remove</li></ul><p>first</p><p>second</p><p>survivor</p>');
    const list = f.editor.firstChild;
    const item = list.firstElementChild;
    const removedParagraphs = [list.nextSibling, list.nextSibling.nextSibling];
    const survivor = f.editor.lastChild;
    f.select(item.firstChild, 0, removedParagraphs[1].firstChild, removedParagraphs[1].textContent.length);
    const anchor = f.capture([item]);

    list.remove();
    removedParagraphs.forEach(node => node.remove());
    f.select(f.editor, 0);
    assert.equal(f.restore(anchor, [item]), true);

    assert.equal(f.editor.innerHTML, '<p><br></p><p>survivor</p>');
    assert.equal(f.selection.getRangeAt(0).startContainer, survivor.previousSibling);
});

test('deleting only a list retains a blank line in the original list position', () => {
    const f = createFixture('<p>before</p><ul><li>remove</li></ul><p>after</p>');
    const list = f.editor.querySelector('ul');
    const item = list.firstElementChild;
    f.select(item.firstChild, 0, item.firstChild, item.textContent.length);
    const anchor = f.capture([item]);

    list.remove();
    f.select(f.editor, 1);
    assert.equal(f.restore(anchor, [item]), true);

    assert.equal(f.editor.innerHTML, '<p>before</p><p><br></p><p>after</p>');
    assert.equal(f.selection.getRangeAt(0).startContainer, f.editor.childNodes[1]);
});

test('range deletion preserves a native caret in the surviving paragraph before the list', () => {
    const f = createFixture('<p>keep start</p><ul><li>remove</li></ul><p>end</p><p>last</p>');
    const before = f.editor.firstChild;
    const list = f.editor.querySelector('ul');
    const item = list.firstElementChild;
    const removedParagraph = list.nextSibling;
    f.select(before.firstChild, 4, removedParagraph.firstChild, 0);
    const anchor = f.capture([item]);

    // A cross-block deletion merges the remaining suffix into the start paragraph.
    before.firstChild.data = 'keepend';
    list.remove();
    removedParagraph.remove();
    f.select(before.firstChild, 4);
    assert.equal(f.restore(anchor, [item]), false);

    assert.equal(f.editor.innerHTML, '<p>keepend</p><p>last</p>');
    assert.equal(f.selection.getRangeAt(0).startContainer, before.firstChild);
    assert.equal(f.selection.getRangeAt(0).startOffset, 4);
});

test('range deletion preserves a native caret in the surviving paragraph after the list', () => {
    const f = createFixture('<ul><li>remove</li></ul><p>suffix</p><p>last</p>');
    const list = f.editor.firstChild;
    const item = list.firstElementChild;
    const paragraph = list.nextSibling;
    f.select(item.firstChild, 0, paragraph.firstChild, 3);
    const anchor = f.capture([item]);

    list.remove();
    paragraph.firstChild.data = 'fix';
    f.select(paragraph.firstChild, 0);
    assert.equal(f.restore(anchor, [item]), false);

    assert.equal(f.editor.innerHTML, '<p>fix</p><p>last</p>');
    assert.equal(f.selection.getRangeAt(0).startContainer, paragraph.firstChild);
    assert.equal(f.selection.getRangeAt(0).startOffset, 0);
});

test('range deletion without a native range restores before the first surviving following block', () => {
    const f = createFixture('<p>before</p><ul><li>remove</li></ul><p>first</p><p>second</p><p>survivor</p><p>last</p>');
    const list = f.editor.querySelector('ul');
    const item = list.firstElementChild;
    const removedParagraphs = [list.nextSibling, list.nextSibling.nextSibling];
    const survivor = removedParagraphs[1].nextSibling;
    f.select(item.firstChild, 0, removedParagraphs[1].firstChild, removedParagraphs[1].textContent.length);
    const anchor = f.capture([item]);

    list.remove();
    removedParagraphs.forEach(node => node.remove());
    f.selection.removeAllRanges();
    assert.equal(f.restore(anchor, [item]), true);

    assert.equal(f.editor.innerHTML, '<p>before</p><p><br></p><p>survivor</p><p>last</p>');
    assert.equal(f.selection.getRangeAt(0).startContainer, survivor.previousSibling);
});

test('range deletion retains the native empty paragraph without creating a duplicate blank line', () => {
    const f = createFixture('<p>before</p><ul><li>remove</li></ul><p>after</p>');
    const list = f.editor.querySelector('ul');
    const item = list.firstElementChild;
    f.select(item.firstChild, 0, item.firstChild, item.textContent.length);
    const anchor = f.capture([item]);

    const paragraph = f.editor.ownerDocument.createElement('p');
    paragraph.appendChild(f.editor.ownerDocument.createElement('br'));
    list.replaceWith(paragraph);
    f.select(paragraph, 0);
    assert.equal(f.restore(anchor, [item]), false);

    assert.equal(f.editor.innerHTML, '<p>before</p><p><br></p><p>after</p>');
    assert.equal(f.selection.getRangeAt(0).startContainer, paragraph);
    assert.equal(f.selection.getRangeAt(0).startOffset, 0);
});

test('range deletion through the actual document end restores a blank line at the end', () => {
    const f = createFixture('<p>before</p><ul><li>remove</li></ul><p>also remove</p>');
    const list = f.editor.querySelector('ul');
    const item = list.firstElementChild;
    const removedParagraph = list.nextSibling;
    f.select(item.firstChild, 0, removedParagraph.firstChild, removedParagraph.textContent.length);
    const anchor = f.capture([item]);

    list.remove();
    removedParagraph.remove();
    f.select(f.editor, 1);
    assert.equal(f.restore(anchor, [item]), true);

    assert.equal(f.editor.innerHTML, '<p>before</p><p><br></p>');
    assert.equal(f.selection.getRangeAt(0).startContainer, f.editor.lastChild);
    assert.equal(f.selection.getRangeAt(0).startOffset, 0);
});

test('a removed nested mixed list restores before the surviving quote after a removed heading', () => {
    const f = createFixture('<p>before</p><ol><li>parent<ul><li>child<ol><li>deep</li></ol></li></ul></li></ol>' +
        '<h2><strong>remove heading</strong></h2><blockquote><p><em>keep quote</em></p></blockquote><p>last</p>');
    const list = f.editor.querySelector('ol');
    const items = Array.from(list.querySelectorAll('li'));
    const heading = list.nextSibling;
    const quote = heading.nextSibling;
    const quoteHtml = quote.outerHTML;
    const anchor = f.capture(items.slice(1));

    list.remove();
    heading.remove();
    f.selection.removeAllRanges();
    assert.equal(f.restore(anchor, items.slice(1)), true);

    const blank = quote.previousSibling;
    assert.equal(f.editor.innerHTML, `<p>before</p><p><br></p>${quoteHtml}<p>last</p>`);
    assert.equal(f.selection.getRangeAt(0).startContainer, blank);
    assert.equal(f.selection.getRangeAt(0).startOffset, 0);
    assert.equal(quote.outerHTML, quoteHtml);
});

test('range deletion restores before a surviving atomic or structured block without changing it', async t => {
    const blocks = [
        ['image', '<p><a href="photo.png"><img src="photo.png" alt="Photo"></a></p>'],
        ['table', '<table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>'],
        ['math', '<pre><code class="language-math" data-mdw-math-delimiter="$$">x^2\n</code></pre>'],
    ];
    for (const [name, html] of blocks) {
        await t.test(name, () => {
            const f = createFixture(`<ul><li>remove</li></ul><p>also remove</p>${html}<p>last</p>`);
            const list = f.editor.firstChild;
            const item = list.firstElementChild;
            const paragraph = list.nextSibling;
            const survivor = paragraph.nextSibling;
            const survivorHtml = survivor.outerHTML;
            const anchor = f.capture([item]);

            list.remove();
            paragraph.remove();
            f.selection.removeAllRanges();
            assert.equal(f.restore(anchor, [item]), true);

            assert.equal(f.editor.innerHTML, `<p><br></p>${survivorHtml}<p>last</p>`);
            assert.equal(f.selection.getRangeAt(0).startContainer, survivor.previousSibling);
            assert.equal(survivor.outerHTML, survivorHtml);
        });
    }
});

test('range deletion preserves the native caret inside formatted heading text', () => {
    const f = createFixture('<ul><li>remove</li></ul><h2><strong>keep</strong> heading</h2><p>last</p>');
    const list = f.editor.firstChild;
    const item = list.firstElementChild;
    const heading = list.nextSibling;
    const text = heading.querySelector('strong').firstChild;
    const anchor = f.capture([item]);

    list.remove();
    const nativeRange = f.select(text, 2);
    const html = f.editor.innerHTML;
    assert.equal(f.restore(anchor, [item]), false);

    assert.equal(f.editor.innerHTML, html);
    assert.equal(f.selection.getRangeAt(0), nativeRange);
    assert.equal(nativeRange.startContainer, text);
    assert.equal(nativeRange.startOffset, 2);
});

test('range restoration preserves a newer noncollapsed selection across formatted paragraphs and a quote', () => {
    const f = createFixture('<ul><li>remove</li></ul><p><strong>first</strong> paragraph</p>' +
        '<h2>Heading</h2><blockquote><p>last <em>quote</em></p></blockquote>');
    const list = f.editor.firstChild;
    const item = list.firstElementChild;
    const start = f.editor.querySelector('strong').firstChild;
    const end = f.editor.querySelector('em').firstChild;
    const anchor = f.capture([item]);

    list.remove();
    const nativeRange = f.select(start, 2, end, 3);
    const html = f.editor.innerHTML;
    assert.equal(nativeRange.commonAncestorContainer, f.editor);
    assert.equal(f.restore(anchor, [item]), false);

    assert.equal(f.editor.innerHTML, html);
    assert.equal(f.selection.getRangeAt(0), nativeRange);
    assert.equal(nativeRange.startContainer, start);
    assert.equal(nativeRange.startOffset, 2);
    assert.equal(nativeRange.endContainer, end);
    assert.equal(nativeRange.endOffset, 3);
    assert.equal(nativeRange.collapsed, false);
});

test('range restoration does not add a blank line when one selected list item survives', () => {
    const f = createFixture('<p>before</p><ol><li>remove</li><li><strong>surviving suffix</strong></li></ol><p>after</p>');
    const list = f.editor.querySelector('ol');
    const items = Array.from(list.children);
    const anchor = f.capture(items);

    items[0].remove();
    const nativeRange = f.select(f.editor, 1);
    const html = f.editor.innerHTML;
    assert.equal(f.restore(anchor, items), false);

    assert.equal(f.editor.innerHTML, html);
    assert.equal(list.firstElementChild, items[1]);
    assert.equal(f.selection.getRangeAt(0), nativeRange);
});
