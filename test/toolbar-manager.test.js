const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const toolbarManagerSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'ToolbarManager.js'),
    'utf8'
);
const toolbarManagerModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(toolbarManagerSource).toString('base64')}`
);

async function createToolbarManager() {
    const { ToolbarManager } = await toolbarManagerModulePromise;
    const savedStates = [];
    const manager = new ToolbarManager(
        { focus: () => {} },
        { saveState: () => savedStates.push(true) }
    );
    manager.isSelectionInTableCellContext = () => false;
    manager.isSelectionInListContext = () => false;
    manager.updateToolbarState = () => {};
    return { manager, savedStates };
}

test('clicking the active heading level toggles it back to a paragraph', async () => {
    const { manager, savedStates } = await createToolbarManager();
    const formattedBlocks = [];
    manager.getActiveHeadingCommand = () => 'h1';
    manager.formatBlock = (tag) => formattedBlocks.push(tag);

    manager.executeCommand('h1');

    assert.deepEqual(formattedBlocks, ['p']);
    assert.equal(savedStates.length, 1);
});

test('clicking a different heading level still changes the heading level', async () => {
    const { manager } = await createToolbarManager();
    const formattedBlocks = [];
    manager.getActiveHeadingCommand = () => 'h1';
    manager.formatBlock = (tag) => formattedBlocks.push(tag);

    manager.executeCommand('h2');

    assert.deepEqual(formattedBlocks, ['h2']);
});

test('the footnote toolbar command dispatches insertion only in an allowed context', async () => {
    const { manager, savedStates } = await createToolbarManager();
    let inserted = 0;
    manager.onInsertFootnote = () => { inserted++; };
    manager.canInsertFootnote = () => true;
    manager.executeCommand('footnote');
    manager.canInsertFootnote = () => false;
    manager.executeCommand('footnote');
    assert.equal(inserted, 1);
    assert.equal(savedStates.length, 0);
});

test('opening the insert menu delegates focus and creates no document history entry', async () => {
    const { manager, savedStates } = await createToolbarManager();
    let opened = 0;
    manager.onOpenInsertMenu = () => { opened++; };
    manager.canOpenInsertMenu = () => true;
    manager.executeCommand('insert-menu');
    manager.canOpenInsertMenu = () => false;
    manager.executeCommand('insert-menu');
    assert.equal(opened, 1);
    assert.equal(savedStates.length, 0);
});

test('the active heading button remains enabled and exposes its pressed state', async () => {
    const { manager } = await createToolbarManager();
    const classes = new Set();
    const attributes = new Map();
    const button = {
        disabled: false,
        classList: {
            toggle: (name, enabled) => {
                if (enabled) {
                    classes.add(name);
                } else {
                    classes.delete(name);
                }
            },
        },
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: (name) => attributes.delete(name),
    };
    manager.commandButtons.set('h1', button);
    manager.isSelectionInHeadingContext = () => true;
    manager.isSelectionInCodeBlockContext = () => false;
    manager.getActiveHeadingCommand = () => 'h1';

    manager.updateCommandAvailability();

    assert.equal(button.disabled, false);
    assert.equal(classes.has('is-current-heading'), true);
    assert.equal(classes.has('is-disabled'), false);
    assert.equal(attributes.get('aria-pressed'), 'true');
    assert.equal(attributes.has('aria-disabled'), false);
});

async function inlineCodeFixture(t, html) {
    const domWindow = domino.createWindow(`<div id="editor" contenteditable="true">${html}</div>`);
    const editor = domWindow.document.getElementById('editor');
    let activeElement = editor;
    Object.defineProperty(domWindow.document, 'activeElement', { get: () => activeElement });
    const { ToolbarManager } = await toolbarManagerModulePromise;
    const savedStates = [];
    const manager = new ToolbarManager(editor, { saveState: () => savedStates.push(true) });
    let range = null;
    domWindow.getSelection = () => ({
        rangeCount: range ? 1 : 0,
        getRangeAt: () => range,
    });
    const originals = {};
    for (const [key, value] of Object.entries({
        window: domWindow, document: domWindow.document,
        Node: domWindow.Node, NodeFilter: domWindow.NodeFilter,
    })) {
        originals[key] = global[key];
        global[key] = value;
    }
    t.after(() => {
        for (const key of Object.keys(originals)) {
            if (originals[key] === undefined) delete global[key];
            else global[key] = originals[key];
        }
    });
    const select = (node, startOffset, endOffset = startOffset) => {
        activeElement = editor;
        range = {
            startContainer: node, endContainer: node,
            startOffset, endOffset, collapsed: startOffset === endOffset,
            intersectsNode: (candidate) => candidate === node || candidate.contains(node),
        };
    };
    const focus = element => {
        activeElement = element;
        if (element !== editor) range = null;
        const event = domWindow.document.createEvent('Event');
        event.initEvent('focusin', true, false);
        element.dispatchEvent(event);
    };
    Object.defineProperty(editor, 'focus', { value: () => focus(editor) });
    return { manager, editor, select, focus, savedStates };
}

const editingCommands = ['bold', 'italic', 'strikethrough', 'inlinecode', 'h1', 'h2', 'h3', 'ul', 'ol',
    'checkbox', 'quote', 'codeblock', 'table', 'image', 'link', 'footnote', 'math', 'mathblock'];

test('footnote number focus disables editing commands and guards execution before editor focus', async (t) => {
    const f = await inlineCodeFixture(t, '<p>Body<sup data-mdw-footnote-ref="a" contenteditable="false"><a>1</a></sup> after</p>' +
        '<div data-mdw-footnote-definition="a"><a data-mdw-footnote-backref="a" contenteditable="false">1 ↩</a><div class="mdw-footnote-content"><p>Note</p></div></div>');
    const document = f.editor.ownerDocument;
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    document.body.insertBefore(toolbar, f.editor);
    for (const command of [...editingCommands, 'settings']) {
        const button = document.createElement('button');
        button.className = 'toolbar-btn';
        button.setAttribute('data-command', command);
        toolbar.appendChild(button);
    }
    f.manager.setup();
    let settingsOpened = 0;
    f.manager.onOpenSettings = () => { settingsOpened++; };
    const original = f.editor.innerHTML;
    for (const number of [f.editor.querySelector('sup a'), f.editor.querySelector('[data-mdw-footnote-backref]')]) {
        f.focus(number);
        for (const command of editingCommands) {
            const button = f.manager.commandButtons.get(command);
            assert.equal(button.disabled, true, command);
            assert.equal(button.getAttribute('aria-disabled'), 'true', command);
            assert.equal(button.classList.contains('is-disabled'), true, command);
            f.manager.executeCommand(command);
            assert.equal(document.activeElement, number, 'A rejected command must keep the number focused');
        }
        assert.equal(f.manager.commandButtons.get('settings').disabled, false);
        f.manager.executeCommand('settings');
        assert.equal(document.activeElement, number);
        f.focus(f.manager.commandButtons.get('settings'));
        f.manager.updateToolbarState();
        assert.equal(f.manager.commandButtons.get('bold').disabled, true, 'Moving focus into the toolbar retains the note-number context');
    }
    assert.equal(settingsOpened, 2);
    assert.equal(f.savedStates.length, 0);
    assert.equal(f.editor.innerHTML, original);
    f.select(f.editor.querySelector('.mdw-footnote-content p').firstChild, 0);
    f.manager.updateToolbarState();
    for (const command of editingCommands) assert.equal(f.manager.commandButtons.get(command).disabled, false, command);
});

test('native ranges inside a footnote number disable tools while note text formatting stays available', async (t) => {
    const f = await inlineCodeFixture(t, '<div data-mdw-footnote-definition="a"><a data-mdw-footnote-backref="a" contenteditable="false">1 ↩</a><div class="mdw-footnote-content"><p>Note</p></div></div>');
    const button = f.editor.ownerDocument.createElement('button');
    f.manager.commandButtons.set('bold', button);
    f.select(f.editor.querySelector('[data-mdw-footnote-backref]').firstChild, 0);
    f.manager.updateCommandAvailability();
    assert.equal(button.disabled, true);
    f.select(f.editor.querySelector('.mdw-footnote-content p').firstChild, 0, 4);
    f.manager.updateCommandAvailability();
    assert.equal(button.disabled, false);
    assert.equal(f.manager.canToggleInlineCode(), true);
});

test('inline code is active at a caret inside code but not outside it', async (t) => {
    const f = await inlineCodeFixture(t, '<p>before<code>value</code>after</p>');
    f.select(f.editor.querySelector('code').firstChild, 2);
    assert.equal(f.manager.isInlineCodeActive(), true);
    assert.equal(f.manager.canToggleInlineCode(), true);

    f.select(f.editor.querySelector('p').firstChild, 2);
    assert.equal(f.manager.isInlineCodeActive(), false);
});

test('selected code exposes its pressed state and remains available', async (t) => {
    const f = await inlineCodeFixture(t, '<p><code>value</code></p>');
    f.select(f.editor.querySelector('code').firstChild, 1, 4);
    const button = f.editor.ownerDocument.createElement('button');
    f.manager.commandButtons.set('inlinecode', button);
    f.manager.updateToolbarState();
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(button.classList.contains('is-active'), true);
    assert.equal(button.disabled, false);
});

test('inline code remains available inside headings, lists and table cells', async (t) => {
    const f = await inlineCodeFixture(t, '<h1>heading</h1><ul><li>item</li></ul><table><tbody><tr><td>cell</td></tr></tbody></table>');
    for (const selector of ['h1', 'li', 'td']) {
        f.select(f.editor.querySelector(selector).firstChild, 0, 2);
        assert.equal(f.manager.canToggleInlineCode(), true, selector);
    }
});

test('inline code is disabled in code blocks and ignores commands there', async (t) => {
    const f = await inlineCodeFixture(t, '<pre><code>value</code></pre>');
    f.select(f.editor.querySelector('code').firstChild, 2);
    assert.equal(f.manager.isInlineCodeActive(), false);
    assert.equal(f.manager.canToggleInlineCode(), false);
    assert.equal(f.manager.toggleInlineCode(), false);
    assert.equal(f.savedStates.length, 0);
    assert.equal(f.editor.innerHTML, '<pre><code>value</code></pre>');
});

test('inline code is unavailable without a selection or on editor UI', async (t) => {
    const f = await inlineCodeFixture(t, '<p><span contenteditable="false" data-exclude-from-markdown="true">handle</span>text</p>');
    assert.equal(f.manager.canToggleInlineCode(), false);
    f.select(f.editor.querySelector('span').firstChild, 1);
    assert.equal(f.manager.canToggleInlineCode(), false);
});

test('the image button delegates to the picker without creating an undo step', async (t) => {
    const f = await inlineCodeFixture(t, '<p>text</p>');
    f.select(f.editor.querySelector('p').firstChild, 2);
    let requests = 0;
    f.manager.onInsertImage = () => { requests++; };
    f.manager.executeCommand('image');
    assert.equal(requests, 1);
    assert.equal(f.savedStates.length, 0);
});

test('the image button is unavailable inside inline code and fenced code', async (t) => {
    const f = await inlineCodeFixture(t, '<p><code>inline</code></p><pre><code>fenced</code></pre>');
    const button = f.editor.ownerDocument.createElement('button');
    f.manager.commandButtons.set('image', button);
    let requests = 0;
    f.manager.onInsertImage = () => { requests++; };
    for (const code of Array.from(f.editor.querySelectorAll('code'))) {
        f.select(code.firstChild, 2);
        f.manager.updateCommandAvailability();
        assert.equal(button.disabled, true);
        f.manager.executeCommand('image');
    }
    assert.equal(requests, 0);
    assert.equal(f.savedStates.length, 0);
});
