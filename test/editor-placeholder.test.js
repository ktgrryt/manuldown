const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media/editor.js'), 'utf8');
const gateSource = fs.readFileSync(path.join(__dirname, '..', 'media/modules/CompositionUpdateGate.js'), 'utf8');
const gateModule = import(`data:text/javascript;base64,${Buffer.from(gateSource).toString('base64')}`);

function extractFunction(name) {
    const start = editorSource.indexOf(`    function ${name}(`);
    const end = editorSource.indexOf('\n    }', start);
    assert.ok(start >= 0 && end > start, `${name} exists`);
    return editorSource.slice(start, end + '\n    }'.length);
}

function extractBetween(startMarker, endMarker) {
    const start = editorSource.indexOf(startMarker);
    const end = editorSource.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start);
    return editorSource.slice(start, end);
}

async function fixture(html = '') {
    const { CompositionUpdateGate } = await gateModule;
    const window = domino.createWindow(`<div id="editor">${html}</div>`);
    const editor = window.document.getElementById('editor');
    const handlers = new Map();
    const timers = [];
    const updates = [];
    editor.addEventListener = (type, handler) => handlers.set(type, handler);
    editor.focus = () => {};
    const dependencies = {
        editor, Node: window.Node, CompositionUpdateGate,
        setTimeout: callback => timers.push(callback),
        tableManager: { handleEdgeCompositionStart() {}, handleEdgeCompositionEnd: () => false },
        domUtils: { commitCaretAnchorInput() {}, normalizeInlineCodeAfterInput() {} },
        stateManager: { saveStateDebounced() {} },
        markdownConverter: { convertMarkdownSyntax: () => false },
        stripEditorControlCharacters() {},
        hideSlashCommandMenu() {},
        notifyChange: () => updates.push(editor.innerHTML),
    };
    const source = `
        let isUpdating = false;
        let isComposing = false;
        let lastCompositionEndTs = 0;
        let pendingEmptyListItemInsert = null;
        const cursorManager = null;
        const compositionUpdateGate = new CompositionUpdateGate();
        const pendingHistoryCommandsAfterComposition = [];
        ${extractFunction('isIgnorableEditorTextValue')}
        ${extractFunction('isRenderableEditorNode')}
        ${extractFunction('isEditorEffectivelyEmpty')}
        ${extractFunction('updateEditorPlaceholderState')}
        ${extractBetween('// IME composition\n', '// A key must act where')}
        ${extractBetween("        editor.addEventListener('input', (e) => {", "        editor.addEventListener('manuldown-code-block-language-change'")}
        updateEditorPlaceholderState();
        return updateEditorPlaceholderState;
    `;
    const updatePlaceholder = new Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
    return {
        editor, updates, updatePlaceholder,
        fire(type, event = {}) { handlers.get(type)(event); },
        runTimers() { while (timers.length) timers.shift()(); },
        get placeholderVisible() { return editor.classList.contains('is-empty'); },
    };
}

test('IME input hides the empty placeholder without replacing the composing text', async () => {
    const f = await fixture();
    assert.equal(f.placeholderVisible, true);
    f.fire('compositionstart');
    assert.equal(f.placeholderVisible, false);

    const text = f.editor.ownerDocument.createTextNode('にほんご');
    f.editor.appendChild(text);
    f.fire('input', { isComposing: true, inputType: 'insertCompositionText' });
    f.updatePlaceholder(); // A scroll/resize update during composition must agree.
    assert.equal(f.placeholderVisible, false);
    assert.equal(f.editor.firstChild, text);
    assert.equal(text.data, 'にほんご');
    assert.deepEqual(f.updates, [], 'Uncommitted IME text must not reach the host');

    text.data = '日本語';
    f.fire('compositionend', { data: '日本語' });
    assert.equal(f.placeholderVisible, false);
    f.runTimers();
    assert.equal(f.editor.firstChild, text);
    assert.deepEqual(f.updates, ['日本語']);
});

test('canceling the first composition immediately restores the empty placeholder', async () => {
    const f = await fixture('<p><br></p>');
    assert.equal(f.placeholderVisible, true);
    f.fire('compositionstart');
    f.updatePlaceholder();
    assert.equal(f.placeholderVisible, false);
    f.fire('input', { isComposing: true, inputType: 'insertCompositionText' });
    f.fire('compositionend', { data: '' });
    assert.equal(f.placeholderVisible, true);
});

test('a composition input event updates the placeholder even without compositionstart', async () => {
    const f = await fixture();
    f.editor.appendChild(f.editor.ownerDocument.createTextNode('日本語'));
    f.fire('input', { isComposing: true, inputType: 'insertCompositionText' });
    assert.equal(f.placeholderVisible, false);
    assert.deepEqual(f.updates, []);
});

test('invisible editor controls stay empty and structural content hides the placeholder', async () => {
    const f = await fixture('<div data-exclude-from-markdown="true" contenteditable="false"></div>');
    assert.equal(f.placeholderVisible, true);
    const controls = f.editor.innerHTML;
    f.fire('compositionstart');
    f.fire('compositionend', { data: '' });
    assert.equal(f.placeholderVisible, true);
    assert.equal(f.editor.innerHTML, controls);
    f.editor.insertAdjacentHTML('beforeend', '<p><img src="local.png"></p>');
    f.updatePlaceholder();
    assert.equal(f.placeholderVisible, false);
});
