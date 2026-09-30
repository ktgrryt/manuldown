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
