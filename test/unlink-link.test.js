const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');
const stateSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', 'StateManager.js'), 'utf8');
const stateModule = import(`data:text/javascript;base64,${Buffer.from(stateSource).toString('base64')}`);

function extractFunction(name, indent = '    ') {
    const start = editorSource.indexOf(`${indent}function ${name}(`);
    const end = editorSource.indexOf(`\n${indent}}\n`, start);
    assert.ok(start >= 0 && end > start, `${name} exists`);
    return editorSource.slice(start, end + indent.length + 2);
}

async function fixture(html) {
    const window = domino.createWindow(`<div id="editor">${html}</div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    let range = null;
    const selection = { removeAllRanges: () => { range = null; }, addRange: (next) => { range = next; } };
    window.getSelection = () => selection;
    document.createRange = () => ({
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
        setStartAfter(node) { this.setStart(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node) + 1); },
        collapse() { this.collapsed = true; }
    });
    const { StateManager } = await stateModule;
    const manager = new StateManager(editor, { postMessage() {} });
    manager.saveSelection = () => null;
    manager.restoreSelection = () => false;
    manager.seedState();
    const updates = [];
    const hidden = [];
    let focused = false;
    const unlink = new Function(
        'document', 'window', 'Node', 'currentLink', 'stateManager',
        'focusEditorWithoutScroll', 'notifyChange', 'hideLinkPopover',
        `${extractFunction('placeCollapsedCaret')}\n${extractFunction('placeCollapsedCaretAfter')}\n${extractFunction('unlinkLink', '        ')}\nreturn unlinkLink;`
    )(document, window, window.Node, editor.querySelector('a'), manager,
        () => { focused = true; }, () => updates.push(editor.innerHTML), (skipSave) => hidden.push(skipSave));
    return { editor, manager, unlink, updates, hidden, get range() { return range; }, get focused() { return focused; } };
}

test('unlinking an image keeps the original image and its attributes in place', async () => {
    const f = await fixture('<p>before<a href="https://example.com"><img src="images/cat.png" alt="cat|120x80" width="120" data-md-path="images/cat.png"></a>after</p>');
    const image = f.editor.querySelector('img');
    const attributes = image.outerHTML;
    f.unlink();
    assert.equal(f.editor.querySelectorAll('a').length, 0);
    assert.ok(f.editor.querySelector('img') === image, 'the original image must remain');
    assert.equal(image.outerHTML, attributes);
    assert.equal(f.editor.innerHTML, `<p>before${attributes}after</p>`);
    assert.ok(f.range.startContainer === image.parentNode);
    assert.equal(f.range.startOffset, 2);
    assert.equal(f.range.collapsed, true);
    assert.equal(f.focused, true);
    assert.deepEqual(f.updates, [f.editor.innerHTML]);
    assert.deepEqual(f.hidden, [true]);
});

test('unlink keeps mixed image, text, and formatted content in their original order', async () => {
    const f = await fixture('<p><a href="https://example.com"><strong>bold</strong><img src="one.png"><em>italic</em><img src="two.png">tail</a></p>');
    const originalNodes = Array.from(f.editor.querySelector('a').childNodes);
    f.unlink();
    const children = Array.from(f.editor.querySelector('p').childNodes);
    assert.equal(children.length, originalNodes.length);
    children.forEach((node, index) => assert.ok(node === originalNodes[index]));
    assert.equal(f.editor.querySelectorAll('img').length, 2);
    assert.ok(f.range.startContainer === originalNodes[4]);
    assert.equal(f.range.startOffset, 4);
});

test('text links still leave the caret at the end of their text', async () => {
    const f = await fixture('<p>before<a href="https://example.com">label</a>after</p>');
    f.unlink();
    assert.equal(f.editor.innerHTML, '<p>beforelabelafter</p>');
    assert.equal(f.range.startContainer.textContent, 'label');
    assert.equal(f.range.startOffset, 5);
});

test('an empty link is removed with the caret at its former position', async () => {
    const f = await fixture('<p>before<a href="https://example.com"></a>after</p>');
    f.unlink();
    assert.equal(f.editor.innerHTML, '<p>beforeafter</p>');
    assert.ok(f.range.startContainer === f.editor.querySelector('p'));
    assert.equal(f.range.startOffset, 1);
});

test('unlinking an image can be undone and redone without losing the image', async (t) => {
    const f = await fixture('<p><a href="https://example.com"><img src="cat.png" alt="cat"></a></p>');
    t.after(() => f.manager.clearHistory());
    const linkedHtml = f.editor.innerHTML;
    f.unlink();
    const unlinkedHtml = f.editor.innerHTML;
    assert.equal(f.editor.querySelectorAll('img').length, 1);
    assert.equal(f.manager.performUndo(() => {}), true);
    assert.equal(f.editor.innerHTML, linkedHtml);
    assert.equal(f.manager.performRedo(() => {}), true);
    assert.equal(f.editor.innerHTML, unlinkedHtml);
    assert.equal(f.editor.querySelectorAll('a').length, 0);
    assert.equal(f.editor.querySelector('img').getAttribute('src'), 'cat.png');
});
