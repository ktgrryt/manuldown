const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const importSource = name => import(`data:text/javascript;base64,${Buffer.from(read(name)).toString('base64')}`);
const menuModule = importSource('media/modules/InsertCommandMenu.js');
const footnoteModule = importSource('media/modules/FootnoteManager.js');
const editorSource = read('media/editor.js');

function extractFunction(name) {
    const start = editorSource.indexOf(`    function ${name}(`);
    const end = editorSource.indexOf('\n    }\n', start);
    assert.ok(start >= 0 && end > start, name);
    return editorSource.slice(start, end + '\n    }'.length);
}

async function fixture(html = '<p>本文</p>', isMac = true) {
    const { InsertCommandMenu } = await menuModule;
    const { FootnoteManager } = await footnoteModule;
    const window = domino.createWindow(`<div id="editor" contenteditable="true">${html}</div><input id="other">`);
    const document = window.document;
    const editor = document.getElementById('editor');
    let activeElement = editor;
    let currentRange = null;
    Object.defineProperty(document, 'activeElement', { get: () => activeElement });
    const fire = (element, type, properties = {}) => {
        const event = document.createEvent('Event');
        event.initEvent(type, true, true);
        Object.assign(event, properties);
        element.dispatchEvent(event);
        return event;
    };
    const focusable = element => {
        Object.defineProperty(element, 'focus', { configurable: true,
            value: () => { activeElement = element; fire(element, 'focusin'); } });
        Object.defineProperty(element, 'scrollIntoView', { configurable: true, value: () => {} });
        return element;
    };
    Array.from(document.querySelectorAll('*')).forEach(focusable);
    const createElement = document.createElement.bind(document);
    document.createElement = (...args) => focusable(createElement(...args));
    const selection = {
        get rangeCount() { return currentRange ? 1 : 0; },
        get isCollapsed() { return !!currentRange?.collapsed; },
        getRangeAt: () => currentRange,
        removeAllRanges: () => { currentRange = null; },
        addRange: range => { currentRange = range; }
    };
    window.getSelection = () => selection;
    function makeRange(startContainer, startOffset, endContainer = startContainer, endOffset = startOffset) {
        return {
            startContainer, startOffset, endContainer, endOffset,
            get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; },
            cloneRange() { return makeRange(this.startContainer, this.startOffset, this.endContainer, this.endOffset); },
            collapse(atStart) {
                if (atStart) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
                else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; }
            },
            insertNode(node) {
                if (this.startContainer.nodeType === 3) {
                    const tail = this.startContainer.splitText(this.startOffset);
                    tail.parentNode.insertBefore(node, tail);
                } else this.startContainer.insertBefore(node, this.startContainer.childNodes[this.startOffset] || null);
            }
        };
    }
    const select = (node, start, end = start) => { currentRange = makeRange(node, start, node, end); };
    const canOpen = new Function('editor', 'Node', `
        const isUpdating = false, editorLoadFailed = false, isComposing = false;
        const compositionUpdateGate = {};
        ${extractFunction('canOpenInsertCommandMenu')}
        return canOpenInsertCommandMenu;
    `)(editor, window.Node);
    const history = [];
    const footnotes = new FootnoteManager(editor, {
        saveState: () => history.push(editor.innerHTML),
        commitStateAfterChange: () => history.push(editor.innerHTML)
    });
    footnotes.refresh = () => {};
    footnotes.placeCaret = content => { editor.focus(); select(content, 0); };
    let customCommands = [];
    const executed = [];
    const commands = [
        { id: 'link', source: 'builtin', action() {} },
        { id: 'footnote', source: 'builtin', action: () => footnotes.insert() },
        { id: 'table', source: 'builtin', action() {} }
    ];
    const getCommands = new Function('window', 'editor', 'Node', 'getAllSlashCommands', 'footnoteManager', 'mathManager', `
        const listRestrictedSlashCommandIds = new Set(['table', 'quote', 'code', 'math', 'toc']);
        ${extractFunction('isSelectionInListItem')}
        ${extractFunction('getFilteredSlashCommands')}
        return getFilteredSlashCommands;
    `)(window, editor, window.Node, () => commands.concat(customCommands), footnotes, { canInsert: () => true });
    const positions = [];
    const menu = new InsertCommandMenu(editor, {
        isMac, canOpen, getCommands,
        position: range => positions.push(range),
        onExecute: command => { executed.push(command.id); command.action(); }
    });
    const query = value => { menu.search.value = value; fire(menu.search, 'input'); };
    const key = (key, modifiers = {}) => fire(menu.search, 'keydown', { key, ...modifiers });
    select(editor.querySelector('p')?.firstChild || editor.firstChild, 2);
    return { window, document, editor, menu, select, selection, query, key, fire, positions, executed, history,
        addCustom: command => customCommands.push(command),
        currentRange: () => currentRange };
}

test('searching and inserting a footnote after text adds neither a space nor the query', async () => {
    const f = await fixture();
    const original = f.editor.innerHTML;
    assert.equal(f.menu.open(), true);
    f.query('fo');
    assert.equal(f.editor.innerHTML, original);
    assert.deepEqual(f.menu.items.map(command => command.id), ['footnote']);
    f.key('Enter');
    const reference = f.editor.querySelector('sup[data-mdw-footnote-ref]');
    assert.equal(reference.previousSibling.textContent, '本文');
    assert.equal(f.editor.querySelector('p').textContent, '本文');
    assert.equal(f.editor.querySelectorAll('[data-mdw-footnote-definition]').length, 1);
    assert.deepEqual(f.executed, ['footnote']);
    assert.equal(f.history.length, 2);
    assert.equal(f.menu.visible, false);
});

test('empty results can be edited, and Escape restores the exact selection without editing', async () => {
    const f = await fixture('<p>本文の途中</p>');
    const node = f.editor.firstChild.firstChild;
    f.select(node, 2, 3);
    const original = f.editor.innerHTML;
    f.menu.open();
    f.query('unknown');
    assert.equal(f.menu.visible, true);
    assert.equal(f.menu.items.length, 0);
    f.key('Enter');
    assert.deepEqual(f.executed, []);
    f.query('fo');
    assert.equal(f.menu.items.length, 1);
    f.key('Escape');
    assert.equal(f.menu.visible, false);
    assert.equal(f.document.activeElement, f.editor);
    assert.equal(f.currentRange().startContainer, node);
    assert.equal(f.currentRange().startOffset, 2);
    assert.equal(f.currentRange().endOffset, 3);
    assert.equal(f.editor.innerHTML, original);
    assert.deepEqual(f.history, []);
});

test('query history and IME confirmation affect only the search field', async () => {
    const f = await fixture();
    const original = f.editor.innerHTML;
    f.menu.open();
    f.query('f');
    f.query('fo');
    assert.equal(f.menu.performHistory('undo'), true);
    assert.equal(f.menu.search.value, 'f');
    f.menu.performHistory('redo');
    assert.equal(f.menu.search.value, 'fo');
    f.fire(f.menu.search, 'compositionstart');
    assert.equal(f.key('Enter', { isComposing: true }).defaultPrevented, false);
    f.fire(f.menu.search, 'compositionend');
    assert.equal(f.key('Enter').defaultPrevented, false);
    assert.deepEqual(f.executed, []);
    assert.equal(f.editor.innerHTML, original);
});

test('navigation, repeated opening, custom commands and list restrictions preserve the insertion point', async () => {
    const f = await fixture('<ul><li>本文</li></ul>');
    f.select(f.editor.querySelector('li').firstChild, 2);
    f.menu.open();
    assert.deepEqual(f.menu.items.map(command => command.id), ['link', 'footnote']);
    f.key('ArrowDown');
    assert.equal(f.menu.activeIndex, 1);
    f.key('Tab');
    assert.equal(f.menu.activeIndex, 0);
    f.key('Tab', { shiftKey: true });
    assert.equal(f.menu.activeIndex, 1);
    f.key('p', { ctrlKey: true });
    assert.equal(f.menu.activeIndex, 1, 'DOM keydown must not duplicate the host cursor command');
    assert.equal(f.menu.handleCursorMove('up'), true);
    assert.equal(f.menu.activeIndex, 0);
    f.query('fo');
    f.menu.open();
    assert.equal(f.menu.search.value, 'fo');
    f.addCustom({ id: 'format', source: 'custom', action() {} });
    f.query('f');
    assert.deepEqual(f.menu.items.map(command => command.id), ['footnote', 'format']);
    assert.equal(f.menu.list.lastChild.classList.contains('custom-command'), true);
    const lastPosition = f.positions.length;
    f.fire(f.editor, 'scroll');
    assert.ok(f.positions.length > lastPosition);
});

test('other fields, code, tables and read-only controls cannot open the menu', async () => {
    for (const html of ['<p><code>code</code></p>', '<pre><code>code</code></pre>',
        '<table><tr><td>cell</td></tr></table>', '<p><span contenteditable="false">control</span></p>']) {
        const f = await fixture(html);
        const element = f.editor.querySelector('code, td, span');
        f.select(element.firstChild, 1);
        assert.equal(f.menu.open(), false, html);
    }
    const f = await fixture();
    f.document.getElementById('other').focus();
    assert.equal(f.menu.open(), false);
    f.editor.innerHTML = '<p>本文</p>';
    f.select(f.editor.firstChild.firstChild, 2);
    const control = f.document.createElement('button');
    control.setAttribute('contenteditable', 'false');
    f.editor.firstChild.appendChild(control);
    control.focus();
    assert.equal(f.menu.open(), false);
    // Use an ordinary editable input as well: a stale document selection must
    // not make the shortcut available while typing into a nested field.
    const input = f.document.createElement('input');
    f.editor.firstChild.appendChild(input);
    input.focus();
    assert.equal(f.menu.open(), false);
});

test('clicking elsewhere and external node replacement cannot execute a stale command', async () => {
    const f = await fixture();
    f.menu.open();
    f.document.getElementById('other').focus();
    assert.equal(f.menu.visible, false);
    assert.equal(f.document.activeElement.id, 'other');
    f.editor.focus();
    f.menu.open();
    f.query('fo');
    f.editor.innerHTML = '<p>Replacement</p>';
    f.menu.execute(0);
    assert.equal(f.menu.visible, false);
    assert.equal(f.editor.textContent, 'Replacement');
    assert.deepEqual(f.executed, []);
});

test('the chosen shortcuts ignore plain slash, other modifiers, AltGr and IME', async () => {
    const { isInsertMenuShortcut } = await menuModule;
    for (const isMac of [true, false]) {
        const base = { key: '/', code: 'Slash', ...(isMac ? { ctrlKey: true } : { altKey: true }) };
        assert.equal(isInsertMenuShortcut(base, isMac), true);
        assert.equal(isInsertMenuShortcut({ key: '/' }, isMac), false);
        for (const flag of ['metaKey', 'shiftKey', 'isComposing', isMac ? 'altKey' : 'ctrlKey']) {
            assert.equal(isInsertMenuShortcut({ ...base, [flag]: true }, isMac), false, flag);
        }
        assert.equal(isInsertMenuShortcut({ ...base, keyCode: 229 }, isMac), false);
        assert.equal(isInsertMenuShortcut({ key: ';', code: 'Semicolon', ctrlKey: true }, isMac), false);
        assert.equal(isInsertMenuShortcut({ key: ';', code: 'Semicolon', altKey: true }, isMac), false);
    }
    const bindings = JSON.parse(read('package.json')).contributes.keybindings.filter(entry => entry.command === 'manulDown.openInsertMenu');
    assert.equal(bindings.length, 1);
    const [binding] = bindings;
    assert.equal(binding.key, 'alt+/');
    assert.equal(binding.mac, 'ctrl+/');
    assert.ok(binding.when.includes("activeCustomEditorId == 'manulDown.editor'"));
    assert.ok(binding.when.includes('!accessibleViewIsShown'));
});

test('shortcut capture suppresses native input in the editor and menu search while forwarding one host command', async () => {
    const f = await fixture();
    const { isInsertMenuShortcut } = await menuModule;
    const preventShortcut = new Function('isInsertMenuShortcut', `
        const isMac = true, compositionUpdateGate = {};
        const isImeInteractionKeydown = () => false;
        ${extractFunction('handleInsertMenuShortcutKeydown')}
        return handleInsertMenuShortcutKeydown;
    `)(isInsertMenuShortcut);
    let prevented = false;
    assert.equal(preventShortcut({ key: '/', ctrlKey: true, preventDefault() { prevented = true; } }), true);
    assert.equal(prevented, true);
    assert.equal(f.menu.visible, false);
    const extension = read('src/extension.ts');
    const start = extension.indexOf('const openInsertMenuCommand =');
    const end = extension.indexOf('context.subscriptions.push(openInsertMenuCommand);', start);
    let callback;
    let delivered = 0;
    new Function('vscode', 'provider', extension.slice(start, end))({
        commands: { registerCommand(id, handler) { assert.equal(id, 'manulDown.openInsertMenu'); callback = handler; } }
    }, { postMessageToActiveEditor(message) {
        assert.deepEqual(message, { type: 'openInsertMenu' });
        delivered++;
        f.menu.open();
    } });
    const registration = editorSource.match(/document\.addEventListener\('keydown', handleInsertMenuShortcutKeydown, true\);/);
    assert.ok(registration, 'the shortcut must be captured before child handlers');
    new Function('document', 'handleInsertMenuShortcutKeydown', registration[0])(f.document, preventShortcut);
    // Domino bubbles to Document; VS Code forwards the same event at Window.
    f.document.addEventListener('keydown', event => {
        if (!isInsertMenuShortcut(event, true)) return;
        assert.equal(event.defaultPrevented, true, 'native input is suppressed before VS Code receives the key');
        callback();
    });
    assert.equal(f.fire(f.editor, 'keydown', { key: '/', ctrlKey: true }).defaultPrevented, true);
    assert.equal(delivered, 1);
    assert.equal(f.menu.visible, true);
    const range = f.menu.range;
    f.query('fo');
    assert.equal(f.key('/', { ctrlKey: true }).defaultPrevented, true);
    assert.equal(delivered, 2);
    assert.equal(f.menu.search.value, 'fo');
    assert.equal(f.menu.range, range);
    assert.equal(f.key('/').defaultPrevented, false, 'ordinary slash is still available in the query');
    assert.equal(f.key('/', { ctrlKey: true, isComposing: true }).defaultPrevented, false);
    assert.equal(delivered, 2, 'IME keys do not dispatch a menu command');
    f.menu.close();
    f.document.getElementById('other').focus();
    assert.equal(f.fire(f.document.activeElement, 'keydown', { key: '/', ctrlKey: true }).defaultPrevented, true);
    assert.equal(delivered, 3);
    assert.equal(f.menu.visible, false);
    f.editor.addEventListener('keydown', event => event.stopPropagation());
    assert.equal(f.fire(f.editor, 'keydown', { key: '/', ctrlKey: true }).defaultPrevented, true);
    assert.equal(delivered, 3, 'capture also works when a child prevents bubbling');
});

test('automatic slash matching still requires the existing whitespace boundary and ignores URLs', async () => {
    const f = await fixture();
    const domUtils = { getParentElement: (node, tag) => node.parentElement?.closest(tag) };
    const getMatch = new Function('window', 'editor', 'domUtils', 'Node', `
        ${extractFunction('getActiveTextNodeAtCursor')}
        ${extractFunction('getSlashCommandMatch')}
        return getSlashCommandMatch;
    `)(f.window, f.editor, domUtils, f.window.Node);
    for (const [text, expected] of [['/', true], ['本文 /fo', true], ['本文/fo', false],
        ['https://example.com/footnote', false], ['src/footnote', false], ['A/B', false]]) {
        f.editor.innerHTML = '<p></p>';
        f.editor.firstChild.textContent = text;
        f.select(f.editor.firstChild.firstChild, text.length);
        assert.equal(!!getMatch(), expected, text);
    }
});
