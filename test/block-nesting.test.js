const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createWindow } = require('@mixmark-io/domino');

const source = fs.readFileSync(path.join(__dirname, '../media/modules/DOMUtils.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const editorSource = fs.readFileSync(path.join(__dirname, '../media/editor.js'), 'utf8');

async function fixture(html) {
    const { DOMUtils } = await modulePromise;
    const window = createWindow(`<div id="editor">${html}</div>`);
    const editor = window.document.getElementById('editor');
    return { window, editor, domUtils: new DOMUtils(editor) };
}

test('quote commands allow a second level and reject wrapping a selection containing two levels', async () => {
    const f = await fixture('<p>Outside</p><blockquote><p>First</p><blockquote><p>Second</p></blockquote></blockquote>');
    const [outside, first, second] = Array.from(f.editor.querySelectorAll('p'));
    for (const [node, allowed] of [[outside, true], [first, true], [second, false]]) {
        assert.equal(f.domUtils.canInsertQuote({ collapsed: true, startContainer: node, endContainer: node }), allowed);
    }
    assert.equal(f.domUtils.canInsertQuote({
        collapsed: false, startContainer: f.editor, endContainer: f.editor,
        intersectsNode: () => true,
    }), false);
});

test('pasted excess quotes are flattened without discarding their text or formatting', async () => {
    const f = await fixture('<blockquote><blockquote><p>Target</p></blockquote></blockquote>');
    const incoming = f.window.document.createElement('div');
    incoming.innerHTML = '<blockquote><p>One</p><blockquote><p><strong>Two</strong></p><blockquote><p>Three</p></blockquote></blockquote></blockquote>';
    f.domUtils.normalizeBlockNesting(incoming);
    assert.ok(!incoming.querySelector('blockquote blockquote blockquote'));
    assert.equal(incoming.textContent, 'OneTwoThree');
    assert.equal(incoming.querySelector('strong').textContent, 'Two');
    f.domUtils.normalizeBlockNesting(incoming, f.editor.querySelector('p'));
    assert.equal(incoming.querySelectorAll('blockquote').length, 0);
    assert.equal(incoming.textContent, 'OneTwoThree');
});

test('pasting a callout into another callout retains visible content as ordinary rich text', async () => {
    const f = await fixture('<div data-mdw-callout="true"><div class="mdw-callout-content"><p>Target</p></div></div>');
    const incoming = f.window.document.createElement('div');
    incoming.innerHTML = '<div data-mdw-callout="true"><div class="mdw-callout-title">Tip</div><div class="mdw-callout-content"><p><strong>Body</strong></p></div></div>';
    f.domUtils.normalizeBlockNesting(incoming, f.editor.querySelector('p'));
    assert.equal(incoming.querySelectorAll('[data-mdw-callout]').length, 0);
    assert.equal(incoming.textContent, 'TipBody');
    assert.equal(incoming.querySelector('strong').textContent, 'Body');
});

test('toolbar and slash quote handlers do not mutate the document at the maximum depth', async () => {
    const f = await fixture('<blockquote><blockquote><p>Second</p></blockquote></blockquote>');
    const node = f.editor.querySelector('p').firstChild;
    const range = { collapsed: true, startContainer: node, endContainer: node };
    for (const name of ['insertEmptyQuote', 'tryWrapQuoteAtCaret', 'tryWrapQuoteFromSelection']) {
        const start = editorSource.indexOf(`    function ${name}(`);
        const end = editorSource.indexOf('\n    }\n', start);
        const run = new Function('window', 'editor', 'domUtils', 'stateManager', `
            ${editorSource.slice(start, end + 6)}
            return ${name}();
        `);
        const original = f.editor.innerHTML;
        run({ getSelection: () => ({ rangeCount: 1, isCollapsed: name !== 'tryWrapQuoteFromSelection', getRangeAt: () => range }) },
            f.editor, f.domUtils, { saveState: () => assert.fail('a rejected command must not change history') });
        assert.equal(f.editor.innerHTML, original);
    }
});
