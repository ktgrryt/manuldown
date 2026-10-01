const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

function importModule(fileName) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', fileName), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const listManagerModulePromise = importModule('ListManager.js');
const domUtilsModulePromise = importModule('DOMUtils.js');
const tableManagerModulePromise = importModule('TableManager.js');

// Run fn with an editor built from html and the DOM globals the modules use.
async function withEditor(html, fn) {
    const window = domino.createWindow(`<div id="editor">${html}</div>`, 'https://example.test/');
    const document = window.document;
    document.createRange = () => ({ setStart() {}, setEnd() {}, collapse() {}, selectNodeContents() {} });
    const previous = {
        window: global.window,
        document: global.document,
        Node: global.Node,
        NodeFilter: global.NodeFilter,
        requestAnimationFrame: global.requestAnimationFrame,
    };
    global.window = { getSelection: () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {} }) };
    global.document = document;
    global.Node = window.Node;
    global.NodeFilter = window.NodeFilter;
    global.requestAnimationFrame = (callback) => callback();
    try {
        return await fn(document.getElementById('editor'));
    } finally {
        Object.assign(global, previous);
    }
}

const structureOf = (element) => element.innerHTML.replace(/\s(?:data-mdw-[\w-]+|class)="[^"]*"/g, '');

const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');

function sliceEditorSource(startMarker, endMarker) {
    const start = editorSource.indexOf(startMarker);
    const end = editorSource.indexOf(endMarker, start);
    assert.ok(start !== -1 && end !== -1, `editor.js must define ${startMarker}`);
    return editorSource.slice(start, end);
}

const childIndex = (node) => Array.prototype.indexOf.call(node.parentNode.childNodes, node);

// The DOM spec's position of boundary point A relative to B: -1 before, 0 equal, 1 after.
function compareBoundaryPoints(nodeA, offsetA, nodeB, offsetB) {
    if (nodeA === nodeB) return Math.sign(offsetA - offsetB);
    if (nodeB.compareDocumentPosition(nodeA) & 4) {
        return -compareBoundaryPoints(nodeB, offsetB, nodeA, offsetA);
    }
    if (nodeA.contains(nodeB)) {
        let child = nodeB;
        while (child.parentNode !== nodeA) child = child.parentNode;
        return childIndex(child) < offsetA ? 1 : -1;
    }
    return -1;
}

// The parts of a DOM Range the list Tab code uses; domino has no Range.
class TestRange {
    setStart(node, offset) {
        this.startContainer = node;
        this.startOffset = offset;
    }

    setEnd(node, offset) {
        this.endContainer = node;
        this.endOffset = offset;
    }

    collapse() {}

    get collapsed() {
        return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
    }

    intersectsNode(node) {
        const index = childIndex(node);
        return compareBoundaryPoints(node.parentNode, index, this.endContainer, this.endOffset) < 0 &&
            compareBoundaryPoints(node.parentNode, index + 1, this.startContainer, this.startOffset) > 0;
    }

    // Only the selected text and the fully selected elements.
    cloneContents() {
        let text = '';
        const elements = [];
        const visit = (node) => {
            for (const child of Array.from(node.childNodes)) {
                if (child.nodeType === 3) {
                    const length = child.data.length;
                    const from = child === this.startContainer ? this.startOffset
                        : compareBoundaryPoints(child, 0, this.startContainer, this.startOffset) >= 0 ? 0 : length;
                    const to = child === this.endContainer ? this.endOffset
                        : compareBoundaryPoints(child, length, this.endContainer, this.endOffset) <= 0 ? length : 0;
                    text += child.data.slice(from, Math.max(from, to));
                } else if (child.nodeType === 1) {
                    const index = childIndex(child);
                    if (compareBoundaryPoints(node, index, this.startContainer, this.startOffset) >= 0 &&
                        compareBoundaryPoints(node, index + 1, this.endContainer, this.endOffset) <= 0) {
                        elements.push(child);
                    }
                    visit(child);
                }
            }
        };
        visit(this.startContainer.ownerDocument.body);
        return {
            textContent: text,
            querySelector: (selectors) => elements.find((element) => element.matches(selectors)) || null,
        };
    }
}

function selectRange(start, end) {
    const range = new TestRange();
    range.setStart(...start);
    range.setEnd(...end);
    return range;
}

const findText = (editor, text) => {
    const walker = editor.ownerDocument.createTreeWalker(editor, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.data.trim() === text) return node;
    }
    throw new Error(`no text node ${text}`);
};

// Each list line as "depth:text", the depth counting the lists around it.
const listLines = (editor) => Array.from(editor.querySelectorAll('li')).map((item) => {
    const text = Array.from(item.childNodes)
        .filter((child) => !/^(?:UL|OL)$/.test(child.nodeName))
        .map((child) => child.textContent).join('').trim();
    let depth = 0;
    for (let node = item.parentNode; node !== editor; node = node.parentNode) {
        if (/^(?:UL|OL)$/.test(node.nodeName)) depth += 1;
    }
    return `${depth}:${text}`;
}).filter((line) => !line.endsWith(':'));

// The list part of the editor.js Tab handler: pick the target items, then
// indent them in order, or outdent them children first.
function pressTab(editor, listManager, range, { shift = false } = {}) {
    const source = sliceEditorSource('function rangeIntersectsNodeSafely(range, node)', 'function createLineExpandedQuoteRange') +
        sliceEditorSource('function getSelectedListItemsFromRange(range)', 'function restoreRangeSelectionAroundListItems');
    const getTargets = new Function(
        'editor', 'domUtils', 'cursorManager', 'document', 'Node',
        `${source}\nreturn getTabOperationTargetListItems;`
    )(editor, listManager.domUtils, null, global.document, global.Node);
    const targets = getTargets(range, null);
    (shift ? targets.slice().reverse() : targets).forEach((item) => {
        if (!item.isConnected) return;
        if (shift) {
            listManager.outdentListItem(item, null, 0);
        } else {
            listManager.indentListItem(item, null, 0);
        }
    });
}

test('Tab and Shift+Tab on a selected parent and child keep the child under the parent', async () => {
    const { ListManager } = await listManagerModulePromise;
    const { DOMUtils } = await domUtilsModulePromise;
    await withEditor('<ul><li>a</li><li>b<ul><li>b1</li></ul></li></ul>', (editor) => {
        const listManager = new ListManager(editor, new DOMUtils(editor));
        const items = () => editor.querySelectorAll('li');

        // editor.js indents the selected items parents first...
        const [parent, child] = [items()[1], items()[2]];
        listManager.indentListItem(parent, null, 0);
        listManager.indentListItem(child, null, 0);
        assert.equal(structureOf(editor), '<ul><li>a<ul><li>b<ul><li>b1</li></ul></li></ul></li></ul>');

        // ...and outdents them children first.
        listManager.outdentListItem(items()[2], null, 0);
        listManager.outdentListItem(items()[1], null, 0);
        assert.equal(structureOf(editor), '<ul><li>a</li><li>b<ul><li>b1</li></ul></li></ul>');
    });
});

// a, then b, c and d one level deeper through an indent wrapper.
const wrappedListHtml = '<ul><li>a<ul><li data-mdw-indent-wrapper="true" class="nested-list-only">' +
    '<ul><li>b</li><li>c</li><li>d</li></ul></li></ul></li></ul>';

test('Tab on lines inside an indent wrapper moves only them and leaves no empty item', async () => {
    const { ListManager } = await listManagerModulePromise;
    const { DOMUtils } = await domUtilsModulePromise;
    for (const selection of [['c', 0, 'd', 1], ['c', 0, 'c', 1]]) {
        await withEditor(wrappedListHtml, (editor) => {
            editor.ownerDocument.createRange = () => new TestRange();
            const listManager = new ListManager(editor, new DOMUtils(editor));
            const [startText, startOffset, endText, endOffset] = selection;
            const range = selectRange(
                [findText(editor, startText), startOffset],
                [findText(editor, endText), endOffset]
            );
            pressTab(editor, listManager, range);
            const moved = endText === 'd' ? '<li>c</li><li>d</li>' : '<li>c</li>';
            const rest = endText === 'd' ? '' : '<li>d</li>';
            assert.equal(
                structureOf(editor),
                `<ul><li>a<ul><li><ul><li>b<ul>${moved}</ul></li>${rest}</ul></li></ul></li></ul>`
            );
        });
    }
});

test('Shift+Tab on lines inside an indent wrapper keeps them under the parent', async () => {
    const { ListManager } = await listManagerModulePromise;
    const { DOMUtils } = await domUtilsModulePromise;
    await withEditor(wrappedListHtml, (editor) => {
        editor.ownerDocument.createRange = () => new TestRange();
        const listManager = new ListManager(editor, new DOMUtils(editor));
        const range = selectRange([findText(editor, 'c'), 0], [findText(editor, 'd'), 1]);
        pressTab(editor, listManager, range, { shift: true });
        assert.equal(structureOf(editor), '<ul><li>a<ul><li><ul><li>b</li></ul></li><li>c</li><li>d</li></ul></li></ul>');
    });
});

test('Tab picks the same lines however the browser writes the selection ends', async () => {
    const { ListManager } = await listManagerModulePromise;
    const { DOMUtils } = await domUtilsModulePromise;
    const listItemOf = (editor, text) => findText(editor, text).parentNode;

    // Ending at the start of d, written in the text or on the item, leaves d out.
    for (const end of [(editor) => [findText(editor, 'd'), 0], (editor) => [listItemOf(editor, 'd'), 0]]) {
        await withEditor('<ul><li>a</li><li>b</li><li>c</li><li>d</li></ul>', (editor) => {
            editor.ownerDocument.createRange = () => new TestRange();
            const listManager = new ListManager(editor, new DOMUtils(editor));
            pressTab(editor, listManager, selectRange([findText(editor, 'b'), 0], end(editor)));
            assert.equal(structureOf(editor), '<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>');
        });
    }

    // Starting at the end of a selects its line break, so a moves too.
    for (const start of [(editor) => [findText(editor, 'a'), 1], (editor) => [listItemOf(editor, 'a'), 1]]) {
        await withEditor('<ul><li>x</li><li>a</li><li>b</li><li>c</li></ul>', (editor) => {
            editor.ownerDocument.createRange = () => new TestRange();
            const listManager = new ListManager(editor, new DOMUtils(editor));
            pressTab(editor, listManager, selectRange(start(editor), [findText(editor, 'c'), 1]));
            assert.equal(structureOf(editor), '<ul><li>x<ul><li>a</li><li>b</li><li>c</li></ul></li></ul>');
        });
    }
});

test('Tab and Shift+Tab keep the line order when list types are mixed', async () => {
    const { ListManager } = await listManagerModulePromise;
    const { DOMUtils } = await domUtilsModulePromise;
    const html = '<ol><li>one<ul><li>d1</li></ul></li><li>two<ul><li>d2</li></ul></li><li>three</li></ol>';
    await withEditor(html, (editor) => {
        editor.ownerDocument.createRange = () => new TestRange();
        const listManager = new ListManager(editor, new DOMUtils(editor));
        const selectTwoToThree = () => selectRange([findText(editor, 'two'), 0], [findText(editor, 'three'), 5]);

        pressTab(editor, listManager, selectTwoToThree());
        assert.deepEqual(listLines(editor), ['1:one', '2:d1', '2:two', '3:d2', '2:three']);

        pressTab(editor, listManager, selectTwoToThree(), { shift: true });
        assert.deepEqual(listLines(editor), ['1:one', '2:d1', '1:two', '2:d2', '1:three']);
        assert.equal(structureOf(editor), html);
    });
});

test('turning a body row into the header row keeps the column alignment', async () => {
    const { TableManager } = await tableManagerModulePromise;
    await withEditor(
        '<table><thead><tr><th align="center">h</th></tr></thead><tbody><tr><td align="center">x</td></tr></tbody></table>',
        (editor) => {
            const manager = Object.create(TableManager.prototype);
            manager._ensureCellNotEmpty = () => {};
            manager._normalizeRowCellTag(editor.querySelector('tbody tr'), 'TH');
            const cell = editor.querySelector('tbody tr').firstElementChild;
            assert.equal(cell.tagName, 'TH');
            assert.equal(cell.getAttribute('align'), 'center');
            assert.equal(cell.textContent, 'x');
        }
    );
});
