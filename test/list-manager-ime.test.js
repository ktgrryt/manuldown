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

for (const [operation, html] of [
    ['indentListItem', '<ul><li>parent</li><li id="target">target</li></ul>'],
    ['outdentListItem', '<ul><li>parent<ul><li id="target">target</li></ul></li></ul>'],
]) {
    test(`${operation} finishes its caret restore before Japanese input starts`, async () => {
        const [{ ListManager }, { DOMUtils }] = await Promise.all([
            listManagerModulePromise,
            domUtilsModulePromise,
        ]);
        const window = domino.createWindow(`<div id="editor">${html}</div>`);
        const document = window.document;
        const editor = document.getElementById('editor');
        const target = document.getElementById('target');
        const text = target.firstChild;
        const createRange = (node, offset) => ({
            startContainer: node,
            startOffset: offset,
            setStart(container, position) {
                this.startContainer = container;
                this.startOffset = position;
            },
            collapse() {},
        });
        let range = createRange(text, 0);
        let selectionWrites = 0;
        const selection = {
            rangeCount: 1,
            getRangeAt: () => range,
            removeAllRanges() {},
            addRange(nextRange) {
                range = nextRange;
                selectionWrites += 1;
            },
        };
        const pendingPlacements = [];
        const frames = [];
        const previous = {
            window: global.window,
            document: global.document,
            Node: global.Node,
            NodeFilter: global.NodeFilter,
            requestAnimationFrame: global.requestAnimationFrame,
        };
        global.window = { getSelection: () => selection };
        global.document = document;
        global.Node = window.Node;
        global.NodeFilter = window.NodeFilter;
        global.requestAnimationFrame = (callback) => frames.push(callback);
        document.createRange = () => createRange(null, 0);
        editor.focus = () => {};

        try {
            const manager = new ListManager(editor, new DOMUtils(editor), {
                deferCaretPlacement: (place) => pendingPlacements.push(place),
            });
            manager[operation](target, text, 0);
            assert.equal(pendingPlacements.length, 1);
            assert.equal(selectionWrites, 0);

            // The editor flushes this queue in keydown/compositionstart, before
            // the browser inserts the first uncommitted Roman character.
            pendingPlacements.splice(0).forEach((place) => place());
            assert.equal(range.startContainer, text);
            assert.equal(range.startOffset, 0);
            assert.equal(selectionWrites, 1);

            text.data = 'ttarget';
            range = createRange(text, 1);
            frames.splice(0).forEach((callback) => callback());
            pendingPlacements.splice(0).forEach((place) => place());
            assert.equal(selectionWrites, 1, 'no later frame may move the active IME caret');
            assert.equal(range.startContainer, text);
            assert.equal(range.startOffset, 1);
            assert.equal(text.data, 'ttarget');
        } finally {
            Object.assign(global, previous);
        }
    });
}
