const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const source = fs.readFileSync(path.join(__dirname, '..', 'media/modules/ToolbarManager.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

async function fixture(t, initialWidth, { withFootnote = false } = {}) {
    const window = domino.createWindow(`
        <div class="toolbar">
            <button class="toolbar-btn" data-command="bold" title="Bold (Ctrl+B)">B</button>
            <button class="toolbar-btn" data-command="italic" title="Italic (Ctrl+I)">I</button>
            <div class="toolbar-separator"></div>
            <button class="toolbar-btn" data-command="h1" title="Heading 1">H1</button>
            <button class="toolbar-btn" data-command="image" title="Insert Image">Image</button>
            ${withFootnote ? '<button class="toolbar-btn" data-command="settings" title="Settings">Settings</button>' : ''}
            <button class="toolbar-btn toolbar-overflow-toggle" hidden>…</button>
            <div class="toolbar-overflow-menu" hidden></div>
        </div>
        <div id="editor" contenteditable="true"><p>text</p>${withFootnote ? '<div data-mdw-footnote-definition="a"><a data-mdw-footnote-backref="a" contenteditable="false">1 ↩</a><div class="mdw-footnote-content"><p>Note</p></div></div>' : ''}</div>
    `);
    const document = window.document;
    const editor = document.getElementById('editor');
    const toolbar = document.querySelector('.toolbar');
    let width = initialWidth;
    let activeElement = editor;
    let range = null;
    Object.defineProperty(toolbar, 'clientWidth', { get: () => width });
    Object.defineProperty(document, 'activeElement', { get: () => activeElement });
    window.innerWidth = 400;
    window.innerHeight = 600;
    window.getSelection = () => ({
        rangeCount: range ? 1 : 0,
        getRangeAt: () => range,
        removeAllRanges: () => { range = null; },
        addRange: next => { range = next; },
    });
    Object.defineProperty(window, 'getComputedStyle', { value: element => ({
        paddingLeft: '12px', paddingRight: '12px', columnGap: '4px',
        marginLeft: element.classList.contains('toolbar-separator') ? '4px' : '0px',
        marginRight: element.classList.contains('toolbar-separator') ? '4px' : '0px',
    }) });
    for (const element of Array.from(document.querySelectorAll('.toolbar, .toolbar > *'))) {
        element.getBoundingClientRect = () => ({
            width: element.hidden ? 0 : element.classList.contains('toolbar-overflow-toggle') ? 30 :
                element.classList.contains('toolbar-overflow-menu') ? 220 :
                    element.classList.contains('toolbar-separator') ? 1 : 40,
            bottom: 40, right: 120,
        });
    }
    Object.defineProperty(editor, 'focus', { value: () => { activeElement = editor; } });
    const originals = {};
    const bindings = { window, document, Node: window.Node, NodeFilter: window.NodeFilter, ResizeObserver: undefined };
    for (const [key, value] of Object.entries(bindings)) {
        originals[key] = global[key];
        global[key] = value;
    }
    t.after(() => {
        for (const [key, value] of Object.entries(originals)) {
            if (value === undefined) delete global[key];
            else global[key] = value;
        }
    });
    const { ToolbarManager } = await modulePromise;
    const manager = new ToolbarManager(editor, { saveState() {} });
    manager.setup();
    for (const button of [manager.overflowToggle, ...manager.overflowButtons.values()]) {
        Object.defineProperty(button, 'focus', { value: () => { activeElement = button; } });
        button.scrollIntoView = () => {};
    }
    const event = (type, target, key) => {
        const e = document.createEvent('Event');
        e.initEvent(type, true, true);
        if (key) e.key = key;
        target.dispatchEvent(e);
    };
    const select = offset => {
        const node = editor.querySelector('p').firstChild;
        range = {
            startContainer: node, endContainer: node, commonAncestorContainer: node,
            startOffset: offset, endOffset: offset, collapsed: true,
            cloneRange() { return { ...this }; },
        };
    };
    return {
        manager, toolbar, editor, event, select,
        focus: element => { activeElement = element; range = null; event('focusin', element); },
        resize: next => { width = next; manager.updateOverflowLayout(); },
        visible: () => manager.toolbarButtons.filter(b => !b.hidden).map(b => b.getAttribute('data-command')),
        overflow: () => Array.from(manager.overflowButtons).filter(([, b]) => !b.hidden).map(([command]) => command),
        get range() { return range; }, get focused() { return activeElement; },
    };
}

test('footnote numbers keep editing tools disabled in the overflow menu while Settings remains available', async (t) => {
    const f = await fixture(t, 80, { withFootnote: true });
    const original = f.editor.innerHTML;
    const number = f.editor.querySelector('[data-mdw-footnote-backref]');
    f.focus(number);
    for (const command of ['bold', 'italic', 'h1', 'image']) {
        assert.equal(f.manager.commandButtons.get(command).disabled, true, command);
        assert.equal(f.manager.overflowButtons.get(command).disabled, true, command);
    }
    f.manager.openOverflowMenu(true);
    assert.equal(f.focused, f.manager.overflowButtons.get('settings'));
    f.manager.updateToolbarState();
    assert.equal(f.manager.overflowButtons.get('bold').disabled, true, 'Menu focus must not re-enable editing');
    let settingsOpened = 0;
    f.manager.onOpenSettings = () => { settingsOpened++; };
    const commands = [];
    const executeCommand = f.manager.executeCommand.bind(f.manager);
    f.manager.executeCommand = command => { commands.push(command); executeCommand(command); };
    f.event('click', f.manager.commandButtons.get('bold'));
    f.event('click', f.manager.overflowButtons.get('h1'));
    assert.deepEqual(commands, []);
    f.event('keydown', f.focused, 'Escape');
    f.manager.updateToolbarState();
    assert.equal(f.manager.commandButtons.get('bold').disabled, true, 'Focus on the menu toggle still has no editable caret');
    f.manager.openOverflowMenu(true);
    f.event('click', f.manager.overflowButtons.get('settings'));
    assert.deepEqual(commands, ['settings']);
    assert.equal(settingsOpened, 1);
    assert.equal(f.manager.overflowMenu.hidden, true);
    assert.equal(f.editor.innerHTML, original);
    f.select(1);
    f.manager.updateToolbarState();
    assert.equal(f.manager.commandButtons.get('bold').disabled, false);
    assert.equal(f.manager.overflowButtons.get('bold').disabled, false);
});

test('a narrow toolbar moves its trailing commands into the menu and hides a trailing separator', async (t) => {
    const f = await fixture(t, 150);
    assert.deepEqual(f.visible(), ['bold', 'italic']);
    assert.deepEqual(f.overflow(), ['h1', 'image']);
    assert.equal(f.manager.overflowToggle.hidden, false);
    assert.equal(f.toolbar.querySelector('.toolbar-separator').hidden, true);
    assert.equal(f.manager.overflowButtons.get('image').textContent, 'Image');
});

test('widening the toolbar returns every command and closes the overflow menu', async (t) => {
    const f = await fixture(t, 150);
    f.manager.openOverflowMenu();
    f.resize(240);
    assert.deepEqual(f.visible(), ['bold', 'italic', 'h1', 'image']);
    assert.deepEqual(f.overflow(), []);
    assert.equal(f.manager.overflowToggle.hidden, true);
    assert.equal(f.manager.overflowMenu.hidden, true);
    assert.equal(f.manager.overflowToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(f.toolbar.querySelector('.toolbar-separator').hidden, false);
});

test('an extremely narrow toolbar keeps all commands reachable through the ellipsis', async (t) => {
    const f = await fixture(t, 80);
    assert.deepEqual(f.visible(), []);
    assert.deepEqual(f.overflow(), ['bold', 'italic', 'h1', 'image']);
    assert.equal(f.manager.overflowToggle.hidden, false);
    assert.equal(f.toolbar.querySelector('.toolbar-separator').hidden, true);
});

test('overflow items reflect the same active and disabled states as toolbar buttons', async (t) => {
    const f = await fixture(t, 80);
    f.manager.isSelectionInHeadingContext = () => true;
    f.manager.getActiveHeadingCommand = () => 'h1';
    f.manager.updateToolbarState();
    assert.equal(f.manager.overflowButtons.get('bold').disabled, true);
    const heading = f.manager.overflowButtons.get('h1');
    assert.equal(heading.disabled, false);
    assert.equal(heading.getAttribute('aria-checked'), 'true');
    assert.equal(heading.classList.contains('is-active'), true);
});

test('activating an overflow command restores the editor selection captured when opening the menu', async (t) => {
    const f = await fixture(t, 80);
    f.select(1);
    f.manager.openOverflowMenu();
    f.select(3);
    const calls = [];
    f.manager.executeCommand = command => calls.push([command, f.range.startOffset]);
    f.event('click', f.manager.overflowButtons.get('h1'));
    assert.deepEqual(calls, [['h1', 1]]);
    assert.equal(f.manager.overflowMenu.hidden, true);
});

test('keyboard navigation skips disabled items and Escape returns focus to the toggle', async (t) => {
    const f = await fixture(t, 80);
    f.manager.isSelectionInHeadingContext = () => true;
    f.manager.openOverflowMenu(true);
    assert.ok(f.focused === f.manager.overflowButtons.get('italic'), 'focus starts on the first enabled item');
    f.event('keydown', f.focused, 'ArrowDown');
    assert.ok(f.focused === f.manager.overflowButtons.get('h1'), 'ArrowDown advances focus');
    f.event('keydown', f.focused, 'End');
    assert.ok(f.focused === f.manager.overflowButtons.get('image'), 'End focuses the last item');
    f.event('keydown', f.focused, 'Escape');
    assert.equal(f.manager.overflowMenu.hidden, true);
    assert.ok(f.focused === f.manager.overflowToggle, 'Escape returns focus to the toggle');
});

test('clicking outside the menu closes it without restoring a stale selection', async (t) => {
    const f = await fixture(t, 80);
    f.select(1);
    f.manager.openOverflowMenu();
    f.select(3);
    f.event('mousedown', f.editor);
    assert.equal(f.manager.overflowMenu.hidden, true);
    assert.equal(f.range.startOffset, 3);
});

test('Escape closes a mouse-opened menu while focus is still in the editor', async (t) => {
    const f = await fixture(t, 80);
    f.select(1);
    f.manager.openOverflowMenu();
    f.event('keydown', f.editor, 'Escape');
    assert.equal(f.manager.overflowMenu.hidden, true);
    assert.ok(f.focused === f.manager.overflowToggle);
    assert.equal(f.range.startOffset, 1);
});
