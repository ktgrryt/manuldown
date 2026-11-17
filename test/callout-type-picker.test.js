const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

function importModule(name) {
    const source = fs.readFileSync(path.join(__dirname, '../media/modules', name), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const modules = Promise.all(['CalloutManager.js', 'DOMUtils.js', 'CursorManager.js', 'StateManager.js'].map(importModule));
const uri = { fsPath: '/workspace/callouts.md', path: '/workspace/callouts.md', scheme: 'file', authority: '' };
const documentFor = source => ({ getText: () => source, uri });
const originalLoad = Module._load;
let MarkdownDocument, MarkdownEditorProvider;
Module._load = function (request, ...args) {
    return request === 'vscode' ? {
        workspace: { getWorkspaceFolder: () => null, getConfiguration: () => ({ get: (_key, value) => value }) },
        window: {},
    } : originalLoad.call(this, request, ...args);
};
try {
    ({ MarkdownDocument } = require('../out/editor/MarkdownDocument'));
    ({ MarkdownEditorProvider } = require('../out/editor/MarkdownEditorProvider'));
} finally { Module._load = originalLoad; }
const render = source => new MarkdownDocument(documentFor(source)).toHtml();
const save = (html, source) => new MarkdownEditorProvider({}).htmlToMarkdown(html, documentFor(source));
const decode = (node, name) => Buffer.from(node.getAttribute(`data-mdw-callout-${name}`), 'base64').toString('utf8');
const childIndex = node => Array.from(node.parentNode.childNodes).indexOf(node);
const emptyRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });

class CaretRange {
    constructor() { this.collapsed = true; }
    get commonAncestorContainer() { return this.startContainer; }
    setStart(node, offset) {
        this.startContainer = node; this.startOffset = offset;
        if (this.collapsed || !this.endContainer) { this.endContainer = node; this.endOffset = offset; }
        this.collapsed = this.startContainer === this.endContainer && this.startOffset === this.endOffset;
    }
    setEnd(node, offset) {
        this.endContainer = node; this.endOffset = offset;
        this.collapsed = this.startContainer === this.endContainer && this.startOffset === this.endOffset;
    }
    setStartBefore(node) { this.setStart(node.parentNode, childIndex(node)); }
    setStartAfter(node) { this.setStart(node.parentNode, childIndex(node) + 1); }
    setEndAfter(node) { this.setEnd(node.parentNode, childIndex(node) + 1); }
    selectNode(node) { this.setStartBefore(node); this.setEndAfter(node); }
    selectNodeContents(node) {
        this.startContainer = node; this.startOffset = 0;
        this.endContainer = node; this.endOffset = node.nodeType === 3 ? node.length : node.childNodes.length;
        this.collapsed = this.endOffset === 0;
    }
    collapse(start) {
        if (start) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
        else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; }
        this.collapsed = true;
    }
    cloneRange() { return Object.assign(new CaretRange(), this); }
    compareBoundaryPoints(_how, other) {
        return this.startContainer === other.startContainer && this.startOffset === other.startOffset ? 0 : 1;
    }
    getBoundingClientRect() { return emptyRect(); }
    getClientRects() { return []; }
    toString() { return ''; }
}
CaretRange.START_TO_START = 0;
CaretRange.END_TO_END = 2;

async function fixture(source, { surround = false } = {}) {
    const [{ CalloutManager }, { DOMUtils }, { CursorManager }, { StateManager }] = await modules;
    const html = render(source);
    const window = domino.createWindow(`<div id="editor" contenteditable="true">${surround ? '<p>Before</p>' : ''}${html}${surround ? '<p>After</p>' : ''}</div>`);
    const document = window.document, editor = document.getElementById('editor');
    window.btoa = btoa; window.atob = atob; window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    window.HTMLElement.prototype.getBoundingClientRect = emptyRect;
    window.HTMLElement.prototype.getClientRects = () => [];
    window.HTMLElement.prototype.scrollIntoView = () => {};
    let activeElement = editor;
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => activeElement });
    const createElement = document.createElement.bind(document);
    document.createElement = (...args) => {
        const element = createElement(...args);
        Object.defineProperty(element, 'focus', { value() { activeElement = this; } });
        return element;
    };
    Object.defineProperty(editor, 'focus', { value() { activeElement = this; } });
    window.getComputedStyle = () => ({ lineHeight: '20px', fontSize: '16px' });
    document.createRange = () => new CaretRange();
    document.elementFromPoint = () => null; document.caretRangeFromPoint = () => null;
    editor.scrollTo = ({ top }) => { editor.scrollTop = top; };
    let range;
    const selection = {
        get rangeCount() { return range ? 1 : 0; }, get isCollapsed() { return !!range?.collapsed; },
        getRangeAt: () => range, addRange: value => { range = value; }, removeAllRanges: () => { range = null; },
    };
    window.getSelection = () => selection;
    const previous = { window: global.window, document: global.document, Node: global.Node, NodeFilter: global.NodeFilter, Range: global.Range };
    Object.assign(global, { window, document, Node: window.Node, Range: CaretRange,
        NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 } });
    const listPrototype = Object.getPrototypeOf(editor.querySelectorAll('img'));
    const oldForEach = listPrototype.forEach;
    listPrototype.forEach = Array.prototype.forEach;
    const before = [], after = [];
    const manager = new CalloutManager(editor, {
        beforeChange: () => before.push(editor.innerHTML), onChange: () => after.push(editor.innerHTML),
    });
    const domUtils = new DOMUtils(editor), cursor = new CursorManager(editor, domUtils);
    manager.cursorManager = cursor;
    cursor.moveAcrossCalloutType = (currentSelection, direction) => manager.handleTypeNavigation(currentSelection, direction);
    manager.refresh();
    const block = editor.querySelector('[data-mdw-callout="true"]'), title = block.querySelector('.mdw-callout-title');
    return { window, document, editor, block, title, manager, cursor, domUtils, StateManager, before, after, selection,
        caret(node, offset = 0) { range = new CaretRange(); range.setStart(node, offset); range.collapse(true); },
        range: () => range,
        popup: () => document.querySelector('.mdw-callout-type-picker'),
        restore() {
            manager.closeTypePicker(false);
            listPrototype.forEach = oldForEach;
            for (const [name, value] of Object.entries(previous)) {
                if (value === undefined) delete global[name]; else global[name] = value;
            }
        },
    };
}
const key = (name, extra = {}) => ({ key: name, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra });
const popupKey = (f, name, extra = {}) => {
    const event = new f.window.Event('keydown', { bubbles: true, cancelable: true });
    Object.assign(event, { key: name, ...extra });
    f.document.activeElement.dispatchEvent(event);
    return event;
};

for (const [service, expected, label] of [
    ['github', '> [!NOTE]\n> Body\n', 'NOTE'],
    ['qiita', ':::note info\nBody\n:::\n', 'info'],
    ['zenn', ':::message\nBody\n:::\n', 'message'],
    ['obsidian', '> [!note]\n> Body\n', 'note'],
    ['container', ':::info\nBody\n:::\n', 'info'],
    ['mkdocs', '!!! note\n    Body\n', 'note'],
]) {
    test(`new ${service} callouts save, reopen empty, and retain their format after typing`, async () => {
        const f = await fixture('> [!NOTE]\n> Original.\n');
        try {
            const block = f.manager.createEmptyBlock(service);
            f.editor.innerHTML = ''; f.editor.appendChild(block); f.manager.refresh();
            assert.equal(block.querySelector('.mdw-callout-title').textContent, label);
            assert.equal(f.manager.getTypeDescriptor(block).dialect, service);
            const empty = save(f.editor.innerHTML, '');
            assert.ok(render(empty).includes('data-mdw-callout="true"'), empty);
            block.querySelector('.mdw-callout-content p').textContent = 'Body';
            assert.equal(save(f.editor.innerHTML, ''), expected);
            assert.equal(save(render(expected), expected), expected);
            assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
        } finally { f.restore(); }
    });
}

test('the subtle format control opens a separate menu without changing the document or history', async () => {
    const source = ':::note warn\nBody\n:::\n';
    const f = await fixture(source);
    try {
        const button = f.block.querySelector('.mdw-callout-format-toggle');
        assert.equal(button.textContent, '');
        assert.equal(button.getAttribute('contenteditable'), 'false');
        assert.match(button.getAttribute('aria-label'), /Qiita/);
        button.dispatchEvent(new f.window.Event('click', { bubbles: true, cancelable: true }));
        const menu = f.document.querySelector('.mdw-callout-format-picker');
        assert.ok(menu); assert.equal(f.editor.contains(menu), false);
        assert.equal(f.title.classList.contains('nav-selected'), false);
        assert.equal(button.getAttribute('aria-expanded'), 'true');
        assert.equal(f.title.getAttribute('aria-expanded'), 'false');
        assert.deepEqual(Array.from(menu.children, option => option.textContent),
            ['GitHub / GitLab', 'Qiita', 'Zenn', 'Obsidian', 'Docusaurus / VitePress', 'MkDocs']);
        assert.equal(menu.querySelector('[aria-selected="true"]').getAttribute('data-callout-dialect'), 'qiita');
        popupKey(f, 'Escape');
        assert.ok(!f.document.querySelector('.mdw-callout-format-picker'));
        assert.equal(f.document.activeElement, button);
        assert.equal(save(f.editor.innerHTML, source), source);
        assert.equal(f.domUtils.getCleanedHTML().includes('mdw-callout-format-toggle'), false);
        assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
    } finally { f.restore(); }
});

for (const kind of ['type', 'format']) {
    for (const shiftKey of [false, true]) {
        test(`${shiftKey ? 'Shift+Tab' : 'Tab'} exits the ${kind} picker inside the editor without an edit`, async () => {
            const f = await fixture(':::note warn\nBody\n:::\n');
            try {
                let reveals = 0;
                f.manager.onNavigate = () => { reveals++; };
                f.manager.openTypePicker(f.block, kind);
                assert.equal(popupKey(f, 'Tab', { shiftKey }).defaultPrevented, true);
                assert.ok(!f.manager.typePicker);
                if (shiftKey) assert.equal(f.manager.getSelectedTypeLabel(), f.title);
                else if (kind === 'type') assert.ok(f.manager.getFocusedFormatButton());
                else assert.ok(f.block.querySelector('.mdw-callout-content').contains(f.range().startContainer));
                assert.equal(reveals, 1);
                assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
            } finally { f.restore(); }
        });
    }
}

for (const [source, dialect, expected, types] of [
    [':::note warn\n_Body_\n:::\n', 'github', '> [!WARNING]\n> _Body_\n', ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']],
    ['> [!WARNING]\n> _Body_\n', 'qiita', ':::note warn\n_Body_\n:::\n', ['info', 'warn', 'alert']],
    ['> [!CAUTION]\n> _Body_\n', 'zenn', ':::message alert\n_Body_\n:::\n', ['message', 'alert']],
    [':::note warn\n_Body_\n:::\n', 'obsidian', '> [!warn]\n> _Body_\n', null],
    [':::note warn\n_Body_\n:::\n', 'container', ':::warning\n_Body_\n:::\n', null],
    [':::note warn\n_Body_\n:::\n', 'mkdocs', '!!! warn\n    _Body_\n', null],
    [':::note info\n_Body_\n:::\n', 'container', ':::info\n_Body_\n:::\n', null],
    ['!!! warning "日本語のタイトル"\n    _Body_\n', 'obsidian', '> [!warning] 日本語のタイトル\n> _Body_\n', null],
    ['> [!warning]- Custom title\n> _Body_\n', 'mkdocs', '??? warning "Custom title"\n    _Body_\n', null],
]) {
    test(`format picker converts ${source.split('\n')[0]} to ${dialect} and reopens`, async () => {
        const f = await fixture(source);
        try {
            const content = f.block.querySelector('.mdw-callout-content'), originalHtml = content.innerHTML;
            f.manager.openFormatPicker(f.block);
            f.document.querySelector(`[data-callout-dialect="${dialect}"]`).dispatchEvent(new f.window.Event('click', { bubbles: true, cancelable: true }));
            assert.ok(!f.document.querySelector('.mdw-callout-format-picker'));
            assert.equal(content.innerHTML, originalHtml);
            assert.equal(f.manager.getTypeDescriptor(f.block).dialect, dialect);
            if (types) assert.deepEqual(f.manager.getTypeOptions(f.block), types);
            const saved = save(f.editor.innerHTML, source);
            assert.equal(saved, expected);
            assert.equal(save(render(saved), saved), saved);
            assert.equal(f.before.length, 1); assert.equal(f.after.length, 1);
        } finally { f.restore(); }
    });
}

test('format conversion retains rich source spelling, nested content and subsequent body edits', async () => {
    const source = ':::note warn\n_keep_ and [label][ref].\n\n> [!TIP]\n> Inner _body_.\n\n- first\n- second\n:::\n\n[ref]: https://example.com\n';
    const f = await fixture(source);
    try {
        assert.equal(f.manager.changeFormat(f.block, 'github'), true);
        const saved = save(f.editor.innerHTML, source);
        assert.equal(saved, '> [!WARNING]\n> _keep_ and [label][ref].\n>\n> > [!TIP]\n> > Inner _body_.\n>\n> - first\n> - second\n\n[ref]: https://example.com\n');
        assert.equal(save(render(saved), saved), saved);
        f.block.querySelector('.mdw-callout-content > p').textContent = 'Edited body.';
        const edited = save(f.editor.innerHTML, source);
        assert.match(edited, /^> \[!WARNING\]\n> Edited body\./);
        assert.match(edited, /> > \[!TIP\]/);
        assert.doesNotMatch(edited, /_keep_/);
    } finally { f.restore(); }
});

test('format menu skips choices that cannot retain a custom title and ignores no-op choices', async () => {
    const source = '> [!warning] Custom title\n> Body\n';
    const f = await fixture(source);
    try {
        assert.equal(f.manager.changeFormat(f.block, 'obsidian'), false);
        assert.equal(f.manager.changeFormat(f.block, 'qiita'), false);
        assert.equal(f.manager.changeFormat(f.block, 'invalid'), false);
        f.manager.openFormatPicker(f.block);
        const menu = f.document.querySelector('.mdw-callout-format-picker');
        assert.equal(menu.querySelector('[data-callout-dialect="qiita"]').disabled, true);
        assert.equal(menu.querySelector('[data-callout-dialect="zenn"]').disabled, true);
        popupKey(f, 'Home'); popupKey(f, 'ArrowDown');
        assert.equal(f.document.activeElement.getAttribute('data-callout-dialect'), 'obsidian');
        popupKey(f, 'Enter');
        assert.equal(save(f.editor.innerHTML, source), source);
        assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
    } finally { f.restore(); }
});

test('format conversion and its keyboard control remain usable after Undo/Redo', async () => {
    const source = ':::note warn\nBody **bold**.\n:::\n';
    const f = await fixture(source);
    try {
        const history = new f.StateManager(f.editor, {});
        history.saveSelection = () => null; history.restoreSelection = () => true;
        history.finishHistoryRestore = () => { f.manager.refresh(); history.rebaseCurrentHistoryStateComparable(); };
        f.manager.beforeChange = () => history.saveState();
        f.manager.onChange = () => history.commitStateAfterChange();
        history.seedState();
        assert.equal(f.manager.changeFormat(f.block, 'github'), true);
        const changed = save(f.editor.innerHTML, source);
        assert.equal(history.performUndo(), true);
        assert.equal(save(f.editor.innerHTML, source), source);
        assert.equal(history.performRedo(), true);
        assert.equal(save(f.editor.innerHTML, source), changed);
        const button = f.editor.querySelector('.mdw-callout-format-toggle');
        const event = new f.window.Event('keydown', { bubbles: true, cancelable: true });
        Object.assign(event, { key: 'Enter' }); button.dispatchEvent(event);
        assert.ok(f.document.querySelector('.mdw-callout-format-picker'));
        popupKey(f, 'Escape');
        assert.ok(!f.document.querySelector('.mdw-callout-format-picker'));
    } finally { f.restore(); }
});

test('IME composition blocks format changes and menu opening', async () => {
    const f = await fixture(':::note warn\nBody\n:::\n');
    try {
        f.manager.isComposing = () => true;
        assert.equal(f.manager.openFormatPicker(f.block), false);
        assert.equal(f.manager.changeFormat(f.block, 'github'), false);
        assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
    } finally { f.restore(); }
});

for (const [header, body, initial, next, nextHeader, variant] of [
    [':::note info', '_Body_\n:::', 'info', 'alert', ':::note alert', 'caution'],
    [':::note alert', '_Body_\n:::', 'alert', 'warn', ':::note warn', 'warning'],
    [':::note warn', '_Body_\n:::', 'warn', 'info', ':::note info', 'note'],
    [':::note', '_Body_\n:::', 'note', 'alert', ':::note alert', 'caution'],
    [':::message alert', '_Body_\n:::', 'alert', 'message', ':::message', 'note'],
    [':::message', '_Body_\n:::', 'message', 'alert', ':::message alert', 'caution'],
    ['> [!WARNING]', '> _Body_', 'WARNING', 'CAUTION', '> [!CAUTION]', 'caution'],
    ['> [!warning]', '> _Body_', 'warning', 'danger', '> [!danger]', 'caution'],
    [':::danger', '_Body_\n:::', 'danger', 'warning', ':::warning', 'warning'],
    ['!!! warning', '    _Body_', 'warning', 'danger', '!!! danger', 'caution'],
]) {
    test(`visible label, picker, saved source and reopened label use the original type: ${header}`, async () => {
        const source = header + '\n' + body + '\n';
        const f = await fixture(source);
        try {
            assert.equal(f.title.textContent, initial);
            f.manager.openTypePicker(f.title);
            const choice = f.popup().querySelector(`[data-callout-type="${next}"]`);
            assert.ok(choice);
            choice.dispatchEvent(new f.window.Event('click', { bubbles: true, cancelable: true }));
            assert.equal(f.title.textContent, next);
            assert.equal(f.block.getAttribute('data-mdw-callout-type'), next);
            assert.equal(f.block.getAttribute('data-mdw-callout-variant'), variant);
            assert.equal(save(f.editor.innerHTML, source), nextHeader + '\n' + body + '\n');
            const reopened = domino.createWindow(render(save(f.editor.innerHTML, source))).document;
            assert.equal(reopened.querySelector('.mdw-callout-title').textContent, next);
        } finally { f.restore(); }
    });
}

test('refresh corrects an old shared label without changing source or history', async () => {
    const source = ':::note alert\nBody\n:::\n';
    const f = await fixture(source);
    try {
        f.title.textContent = 'Caution';
        f.manager.refresh();
        assert.equal(f.title.textContent, 'alert');
        assert.equal(save(f.editor.innerHTML, source), source);
        assert.equal(f.before.length, 0);
        assert.equal(f.after.length, 0);
    } finally { f.restore(); }
});

for (const source of [
    '> [!warning]- My title\n> Body\n',
    ':::warning[My title]\nBody\n:::\n',
    '!!! warning "My title"\n    Body\n',
    '!!! warning ""\n    Body\n',
]) {
    test(`an explicit source title survives type changes: ${source.split('\n')[0]}`, async () => {
        const f = await fixture(source);
        try {
            const title = f.title.textContent;
            assert.equal(f.manager.changeType(f.block, 'danger'), true);
            assert.equal(f.title.textContent, title);
            f.manager.refresh();
            assert.equal(f.title.textContent, title);
            const saved = save(f.editor.innerHTML, source);
            assert.equal(saved, source.replace('warning', 'danger'));
            assert.equal(domino.createWindow(render(saved)).document.querySelector('.mdw-callout-title').textContent, title);
        } finally { f.restore(); }
    });
}

for (const [source, expected] of [
    [':::note info\nBody\n:::\n', ['info', 'warn', 'alert']],
    [':::note warn\nBody\n:::\n', ['info', 'warn', 'alert']],
    [':::note\nBody\n:::\n', ['info', 'warn', 'alert']],
    [':::message\nBody\n:::\n', ['message', 'alert']],
    [':::message alert\nBody\n:::\n', ['message', 'alert']],
    ['> [!NOTE]\n> Body\n', ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']],
]) {
    test(`the type options belong to the original dialect: ${source.split('\n')[0]}`, async () => {
        const f = await fixture(source);
        try { assert.deepEqual(f.manager.getTypeOptions(f.block), expected); }
        finally { f.restore(); }
    });
}

test('Obsidian and MkDocs expose their known types without accepting arbitrary names', async () => {
    for (const source of ['> [!info]- Custom\n> Body\n', '???+ warning "Custom"\n    Body\n']) {
        const f = await fixture(source);
        try {
            const options = f.manager.getTypeOptions(f.block);
            for (const type of ['note', 'info', 'tip', 'warning', 'danger', 'success']) assert.ok(options.includes(type));
            for (const type of ['constructor', 'unknown', 'message', 'alert']) assert.ok(!options.includes(type));
            const original = f.editor.innerHTML;
            assert.equal(f.manager.changeType(f.block, 'unknown'), false);
            assert.equal(f.editor.innerHTML, original);
            assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
        } finally { f.restore(); }
    }
});

for (const type of ['INFO', 'BUG', 'Warning']) {
    test(`opening a picker and confirming the current quoted type never changes its spelling: ${type}`, async () => {
        const source = `> [!${type}]+ Custom\n> Body\n`;
        const f = await fixture(source);
        try {
            assert.ok(f.manager.getTypeOptions(f.block).includes(type), 'the existing source type remains selectable');
            assert.equal(f.manager.openTypePicker(f.block), true);
            popupKey(f, 'Enter');
            assert.equal(save(f.editor.innerHTML, source), source);
            assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
        } finally { f.restore(); }
    });
}

for (const [source, type, expectedHeader] of [
    [':::note warn\nBody _unchanged_.\n:::\n', 'alert', ':::note alert'],
    [':::note\nBody _unchanged_.\n:::\n', 'warn', ':::note warn'],
    ['::::message alert\nBody _unchanged_.\n::::\n', 'message', '::::message'],
    ['> [!WARNING]- Custom **title**\n> Body _unchanged_.\n', 'TIP', '> [!TIP]- Custom **title**'],
    ['> [!info]+ Custom title\n> Body _unchanged_.\n', 'warning', '> [!warning]+ Custom title'],
    [':::note[Custom title]\nBody _unchanged_.\n:::\n', 'danger', ':::danger[Custom title]'],
    ['::: warning Custom title\nBody _unchanged_.\n:::\n', 'tip', '::: tip Custom title'],
    ['???+ warning "Custom title"\n    Body _unchanged_.\n', 'note', '???+ note "Custom title"'],
]) {
    test(`changing type keeps the original header structure and body: ${source.split('\n')[0]}`, async () => {
        const f = await fixture(source);
        try {
            const content = f.block.querySelector('.mdw-callout-content'), bodyHtml = content.innerHTML;
            const originalSource = f.block.getAttribute('data-mdw-callout-source');
            const originalFooter = decode(f.block, 'footer');
            assert.equal(f.manager.changeType(f.block, type), true);
            assert.equal(decode(f.block, 'header'), expectedHeader);
            assert.equal(decode(f.block, 'footer'), originalFooter);
            assert.equal(f.block.querySelector('.mdw-callout-content'), content);
            assert.equal(content.innerHTML, bodyHtml);
            assert.equal(f.block.getAttribute('data-mdw-callout-source'), originalSource);
            assert.equal(f.before.length, 1); assert.equal(f.after.length, 1);
            const saved = save(f.editor.innerHTML, source);
            assert.equal(saved, source.replace(source.split('\n')[0], expectedHeader));
            assert.equal(save(render(saved), saved), saved);
        } finally { f.restore(); }
    });
}

test('Qiita same-type selection preserves an omitted default and creates no edit history', async () => {
    const source = ':::note\nBody\n:::\n';
    const f = await fixture(source);
    try {
        assert.equal(f.manager.changeType(f.block, 'info'), false);
        assert.equal(decode(f.block, 'header'), ':::note');
        assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
        assert.equal(save(f.editor.innerHTML, source), source);
    } finally { f.restore(); }
});

test('changing type preserves exact untouched body source including references and protected HTML', async () => {
    const source = ':::note warn\n_keep_ and [label][ref].\n\n<span>literal HTML</span>\n\n- first\n- second\n:::\n\n[ref]: https://example.com\n';
    const f = await fixture(source);
    try {
        assert.equal(f.manager.changeType(f.block, 'alert'), true);
        const saved = save(f.editor.innerHTML, source);
        assert.equal(saved, source.replace(':::note warn', ':::note alert'));
        assert.equal(save(render(saved), saved), saved);
    } finally { f.restore(); }
});

test('changing a type and body together keeps the dialect and does not restore stale body source', async () => {
    const source = ':::note warn\nOld body.\n:::\n';
    const f = await fixture(source);
    try {
        assert.equal(f.manager.changeType(f.block, 'alert'), true);
        f.block.querySelector('.mdw-callout-content p').textContent = 'New body.';
        assert.equal(save(f.editor.innerHTML, source), ':::note alert\nNew body.\n:::\n');
    } finally { f.restore(); }
});

test('mixed callouts change independently and retain every original syntax family', async () => {
    const source = '> [!NOTE]\n> Quote.\n\n:::note info\nQiita.\n:::\n\n:::message\nZenn.\n:::\n';
    const f = await fixture(source);
    try {
        const blocks = f.editor.querySelectorAll('[data-mdw-callout="true"]');
        assert.equal(f.manager.changeType(blocks[0], 'WARNING'), true);
        assert.equal(f.manager.changeType(blocks[1], 'warn'), true);
        assert.equal(f.manager.changeType(blocks[2], 'alert'), true);
        assert.equal(save(f.editor.innerHTML, source), source.replace('[!NOTE]', '[!WARNING]')
            .replace(':::note info', ':::note warn').replace(':::message\n', ':::message alert\n'));
    } finally { f.restore(); }
});

test('copied mixed callout declarations serialize in a different document without hidden source', async () => {
    const source = ':::note alert\nBody\n:::\n\n> [!warning]- Custom title\n> Body\n\n' +
        ':::message alert\nBody\n:::\n\n::::danger[Custom title]\nBody\n::::\n\n' +
        '???+ warning "Custom title"\n    Body\n\n' +
        ':::note info\nOuter body\n:::\n\n> :::note warn\n> Inner body\n> :::\n';
    const f = await fixture(source);
    try {
        const prepared = f.manager.prepareClipboardImport(f.editor.innerHTML, false);
        assert.equal(prepared.blocks.length, 7);
        const container = f.document.createElement('div'); container.innerHTML = prepared.html;
        f.manager.restoreClipboardImport(container, prepared);
        assert.equal(container.querySelectorAll('[data-mdw-callout-source]').length, 0);
        const saved = save(container.innerHTML, '');
        assert.equal(saved, source);
        assert.equal(save(render(saved), saved), saved);
        const reopened = f.document.createElement('div'); reopened.innerHTML = render(saved);
        assert.equal(reopened.querySelectorAll('[data-mdw-callout="true"]').length, 7);
    } finally { f.restore(); }
});

test('plain Markdown quote paste keeps original declarations after editing and reopening', async () => {
    const source = '  >[!IMPORTANT]\n  > 重要な情報です。\n\n> [!CAUTION]- Custom title\n> 注意事項です。\n';
    const f = await fixture('> [!NOTE]\n> Existing.\n');
    try {
        const fragment = f.manager.createPastedQuoteCallouts(source.split('\n'), (paragraph, text) => {
            paragraph.appendChild(f.document.createTextNode(text));
        });
        assert.ok(fragment);
        f.editor.innerHTML = ''; f.editor.appendChild(fragment);
        assert.equal(save(f.editor.innerHTML, ''), source);
        f.editor.querySelectorAll('.mdw-callout-content p')[1].textContent = '編集した注意事項です。';
        const saved = save(f.editor.innerHTML, '');
        assert.equal(saved, source.replace('注意事項です。', '編集した注意事項です。'));
        assert.equal(save(render(saved), saved), saved);
        assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
    } finally { f.restore(); }
});

test('the label is selected as one control and Enter opens dialect-specific options outside the editor', async () => {
    const source = ':::note warn\nBody\n:::\n';
    const f = await fixture(source);
    try {
        assert.equal(f.manager.selectTypeLabel(f.block), true);
        assert.equal(f.manager.getSelectedTypeLabel(), f.title);
        assert.equal(f.range().collapsed, false);
        assert.ok(f.title.classList.contains('nav-selected'));
        const enter = key('Enter');
        assert.equal(f.manager.handleKeydown(enter), true);
        assert.equal(enter.defaultPrevented, true);
        const popup = f.popup();
        assert.ok(popup); assert.equal(popup.getAttribute('role'), 'listbox');
        assert.equal(f.editor.contains(popup), false);
        assert.deepEqual(Array.from(popup.querySelectorAll('[role="option"]'), option => option.getAttribute('data-callout-type')), ['info', 'warn', 'alert']);
        assert.equal(save(f.editor.innerHTML, source), source);
        assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
    } finally { f.restore(); }
});

test('the label-only caret indicator clears when navigation or a click returns to body text', async () => {
    const source = ':::note info\nBody\n:::\n';
    const f = await fixture(source);
    try {
        const baseline = f.domUtils.getCleanedHTML({ historyComparable: true });
        const body = f.block.querySelector('.mdw-callout-content p').firstChild;
        for (const returnToText of [
            () => f.cursor.moveCursorDown(),
            () => { f.caret(body, 2); f.manager.refresh(); },
        ]) {
            f.manager.selectTypeLabel(f.block);
            assert.equal(f.editor.querySelectorAll('.mdw-callout-title.nav-selected').length, 1);
            assert.equal(f.domUtils.getCleanedHTML({ historyComparable: true }), baseline);
            returnToText();
            assert.equal(f.range().collapsed, true);
            assert.equal(f.editor.querySelectorAll('.mdw-callout-title.nav-selected').length, 0);
            assert.equal(f.domUtils.getCleanedHTML({ historyComparable: true }), baseline);
        }
        assert.equal(f.before.length, 0);
        assert.equal(f.after.length, 0);
    } finally { f.restore(); }
});

test('clicking a label opens its picker and clicking an option commits one source-preserving change', async () => {
    const source = ':::note warn\nBody\n:::\n';
    const f = await fixture(source);
    try {
        f.title.dispatchEvent(new f.window.Event('click', { bubbles: true, cancelable: true }));
        const popup = f.popup(); assert.ok(popup);
        const option = popup.querySelector('[data-callout-type="alert"]'); assert.ok(option);
        option.dispatchEvent(new f.window.Event('click', { bubbles: true, cancelable: true }));
        assert.equal(!!f.popup(), false);
        assert.equal(f.block.getAttribute('data-mdw-callout-variant'), 'caution');
        assert.equal(save(f.editor.innerHTML, source), ':::note alert\nBody\n:::\n');
        assert.equal(f.before.length, 1); assert.equal(f.after.length, 1);
    } finally { f.restore(); }
});

test('Escape cancels the popup without changing Markdown or adding history', async () => {
    const source = ':::note warn\nBody\n:::\n';
    const f = await fixture(source);
    try {
        assert.equal(f.manager.openTypePicker(f.title), true);
        assert.equal(popupKey(f, 'Escape').defaultPrevented, true);
        assert.equal(!!f.popup(), false);
        assert.equal(save(f.editor.innerHTML, source), source);
        assert.equal(f.manager.getSelectedTypeLabel(), f.title);
        assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
    } finally { f.restore(); }
});

test('keyboard arrows move through options and Enter commits the selected option', async () => {
    const source = ':::note warn\nBody\n:::\n';
    const f = await fixture(source);
    try {
        assert.equal(f.manager.openTypePicker(f.block), true);
        assert.equal(popupKey(f, 'ArrowDown').defaultPrevented, true);
        assert.equal(popupKey(f, 'Enter').defaultPrevented, true);
        assert.equal(!!f.popup(), false);
        assert.equal(decode(f.block, 'header'), ':::note alert');
        assert.equal(f.before.length, 1); assert.equal(f.after.length, 1);
    } finally { f.restore(); }
});

test('only the active picker option is highlighted while the original value stays unchanged', async () => {
    const source = ':::note warn\nBody\n:::\n';
    const f = await fixture(source);
    try {
        f.manager.openTypePicker(f.block);
        const popup = f.popup();
        const activeType = () => Array.from(popup.querySelectorAll('.active'), option => option.getAttribute('data-callout-type'));
        const info = popup.querySelector('[data-callout-type="info"]');
        assert.deepEqual(activeType(), ['warn']);
        info.dispatchEvent(new f.window.Event('mouseenter'));
        assert.deepEqual(activeType(), ['info']);
        assert.equal(popup.querySelector('[aria-selected="true"]').getAttribute('data-callout-type'), 'warn');
        popupKey(f, 'ArrowDown');
        assert.deepEqual(activeType(), ['warn']);
        popupKey(f, 'ArrowDown');
        assert.deepEqual(activeType(), ['alert']);
        info.dispatchEvent(new f.window.Event('mousemove'));
        assert.deepEqual(activeType(), ['info']);
        assert.equal(save(f.editor.innerHTML, source), source);
        assert.equal(f.before.length, 0);
        assert.equal(f.after.length, 0);
        popupKey(f, 'Enter');
        assert.equal(decode(f.block, 'header'), ':::note info');
    } finally { f.restore(); }
});

test('IME confirmation does not open or commit a type picker', async () => {
    const source = ':::note warn\nBody\n:::\n';
    const f = await fixture(source);
    try {
        f.manager.selectTypeLabel(f.block);
        assert.equal(f.manager.handleKeydown(key('Enter', { isComposing: true, keyCode: 229 })), false);
        assert.equal(!!f.popup(), false);
        assert.equal(save(f.editor.innerHTML, source), source);
    } finally { f.restore(); }
});

test('starting IME from the type label clears its caret suppression without changing the range or source', async () => {
    const source = ':::note info\nBody\n:::\n';
    const f = await fixture(source);
    try {
        const content = f.block.querySelector('.mdw-callout-content');
        const text = content.querySelector('p').firstChild;
        f.manager.selectTypeLabel(f.block);
        const range = f.range(), baseline = f.domUtils.getCleanedHTML({ historyComparable: true });
        const boundaries = [range.startContainer, range.startOffset, range.endContainer, range.endOffset];
        assert.ok(f.title.classList.contains('nav-selected'));
        f.editor.dispatchEvent(new f.window.Event('compositionstart', { bubbles: true }));
        assert.equal(f.title.classList.contains('nav-selected'), false);
        assert.equal(f.range(), range);
        assert.deepEqual([range.startContainer, range.startOffset, range.endContainer, range.endOffset], boundaries);
        assert.equal(content.querySelector('p').firstChild, text);
        assert.equal(f.domUtils.getCleanedHTML({ historyComparable: true }), baseline);
        assert.equal(save(f.editor.innerHTML, source), source);
        assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);

        // Chromium now owns composition and moves its range into the body.
        f.manager.isComposing = () => true;
        text.textContent = 'あBody';
        f.caret(text, 1);
        assert.equal(f.manager.handleInput({ inputType: 'insertCompositionText', isComposing: true }), false);
        assert.equal(f.title.classList.contains('nav-selected'), false);
        assert.equal(f.range().startContainer, text);
        assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
        f.manager.isComposing = () => false;
        f.manager.refresh();
        assert.equal(save(f.editor.innerHTML, source), ':::note info\nあBody\n:::\n');
    } finally { f.restore(); }
});

for (const method of ['moveCursorDown', 'moveCursorForward']) {
    test(`${method} reaches the type label before the body when entering from above`, async () => {
        const f = await fixture(':::note warn\nBody\n:::\n', { surround: true });
        try {
            const text = f.editor.firstElementChild.firstChild;
            f.caret(text, text.length);
            f.cursor[method]();
            assert.equal(f.manager.getSelectedTypeLabel(), f.title);
            assert.equal(f.range().collapsed, false);
            assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
        } finally { f.restore(); }
    });
}

for (const [method, direction] of [['moveCursorUp', 'up'], ['moveCursorBackward', 'backward']]) {
    test(`${method} reaches the type label from the first body boundary`, async () => {
        const f = await fixture(':::note warn\nBody\n:::\n', { surround: true });
        try {
            f.caret(f.block.querySelector('.mdw-callout-content p').firstChild, 0);
            f.cursor[method]();
            assert.equal(f.manager.getSelectedTypeLabel(), f.title, direction);
            assert.equal(f.range().collapsed, false);
        } finally { f.restore(); }
    });
}

for (const [method, intoBody] of [
    ['moveCursorDown', true], ['moveCursorUp', false], ['moveCursorBackward', false],
]) {
    test(`${method} leaves a selected type label in one navigation step`, async () => {
        const f = await fixture(':::note warn\nBody\n:::\n', { surround: true });
        try {
            f.manager.selectTypeLabel(f.block);
            f.cursor[method]();
            const target = intoBody ? f.block.querySelector('.mdw-callout-content p') : f.editor.firstElementChild;
            const range = f.range();
            assert.equal(range.collapsed, true);
            assert.ok(target === range.startContainer || target.contains(range.startContainer));
            assert.equal(f.manager.getSelectedTypeLabel(), null);
            assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
        } finally { f.restore(); }
    });
}

test('Right reaches the format control, Enter opens choices and arrows plus Enter select a format', async () => {
    const source = ':::note warn\nBody\n:::\n';
    const f = await fixture(source);
    try {
        f.manager.selectTypeLabel(f.block);
        f.cursor.moveCursorForward();
        assert.equal(f.manager.getFocusedFormatButton(), f.block.querySelector('.mdw-callout-format-toggle'));
        assert.equal(f.selection.rangeCount, 0);
        assert.equal(f.title.classList.contains('nav-selected'), false);
        assert.equal(popupKey(f, 'Enter').defaultPrevented, true);
        const popup = f.document.querySelector('.mdw-callout-format-picker');
        assert.ok(popup);
        assert.equal(f.document.activeElement.getAttribute('data-callout-dialect'), 'qiita');
        popupKey(f, 'ArrowUp');
        assert.equal(f.document.activeElement.getAttribute('data-callout-dialect'), 'github');
        popupKey(f, 'Enter');
        assert.ok(!f.document.querySelector('.mdw-callout-format-picker'));
        assert.equal(save(f.editor.innerHTML, source), '> [!WARNING]\n> Body\n');
        assert.ok(f.manager.getFocusedFormatButton());
        assert.equal(f.before.length, 1); assert.equal(f.after.length, 1);
    } finally { f.restore(); }
});

test('a focused format control allows modified shortcuts to reach the editor', async () => {
    const f = await fixture(':::note warn\nBody\n:::\n');
    try {
        f.manager.focusFormatButton(f.block);
        let received = false;
        const observe = () => { received = true; };
        f.editor.addEventListener('keydown', observe);
        const event = new f.window.Event('keydown', { bubbles: true, cancelable: true });
        Object.assign(event, { key: 'z', ctrlKey: true });
        f.document.activeElement.dispatchEvent(event);
        f.editor.removeEventListener('keydown', observe);
        assert.equal(received, true);
        assert.equal(event.defaultPrevented, false);
        assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
    } finally { f.restore(); }
});

for (const [method, target] of [
    ['moveCursorBackward', 'title'], ['moveCursorForward', 'body'], ['moveCursorDown', 'body'], ['moveCursorUp', 'before'],
]) {
    test(`${method} leaves the focused format control without creating an edit`, async () => {
        const source = ':::note warn\nBody\n:::\n';
        const f = await fixture(source, { surround: true });
        try {
            const baseline = f.domUtils.getCleanedHTML({ historyComparable: true });
            f.manager.selectTypeLabel(f.block); f.cursor.moveCursorForward();
            assert.ok(f.manager.getFocusedFormatButton());
            f.cursor[method]();
            assert.equal(f.manager.getFocusedFormatButton(), null);
            assert.equal(f.document.activeElement, f.editor);
            if (target === 'title') assert.equal(f.manager.getSelectedTypeLabel(), f.title);
            else {
                const expected = target === 'body' ? f.block.querySelector('.mdw-callout-content p') : f.editor.firstElementChild;
                assert.ok(expected === f.range().startContainer || expected.contains(f.range().startContainer));
                assert.equal(f.range().collapsed, true);
            }
            assert.equal(f.domUtils.getCleanedHTML({ historyComparable: true }), baseline);
            assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
        } finally { f.restore(); }
    });
}

test('type changes participate in the existing Undo and Redo history', async () => {
    const source = ':::note warn\nBody **bold**.\n:::\n';
    const f = await fixture(source);
    try {
        const history = new f.StateManager(f.editor, {});
        history.saveSelection = () => null; history.restoreSelection = () => true;
        history.finishHistoryRestore = () => history.rebaseCurrentHistoryStateComparable();
        f.manager.beforeChange = () => history.saveState();
        f.manager.onChange = () => history.commitStateAfterChange();
        history.seedState();
        assert.equal(f.manager.changeType(f.block, 'alert'), true);
        const changed = save(f.editor.innerHTML, source);
        assert.equal(changed, source.replace(':::note warn', ':::note alert'));
        assert.equal(history.performUndo(), true);
        assert.equal(save(f.editor.innerHTML, source), source);
        assert.equal(history.performRedo(), true);
        assert.equal(save(f.editor.innerHTML, source), changed);
    } finally { f.restore(); }
});

test('nested type declarations remain read-only and are not entered as editable text', async () => {
    const source = '> [!NOTE]\n> > [!TIP]\n> > Body\n';
    const f = await fixture(source);
    try {
        const blocks = f.editor.querySelectorAll('[data-mdw-callout="true"]');
        assert.equal(blocks.length, 1);
        assert.ok(f.editor.querySelector('[data-mdw-opaque-kind="callout-source"]'));
        f.manager.selectTypeLabel(blocks[0]);
        f.cursor.moveCursorDown();
        assert.ok(!f.manager.getSelectedTypeLabel());
        const node = f.range().startContainer;
        const element = node.nodeType === 1 ? node : node.parentElement;
        assert.ok(!element.closest('[data-mdw-opaque-source]'));
        assert.equal(save(f.editor.innerHTML, source), source);
    } finally { f.restore(); }
});

for (const source of [
    ':::note info\n> :::note warn\n> Inner body\n> :::\n:::\n',
    ':::note info\n- > [!WARNING]\n  > Inner body\n:::\n',
    ':::note info\n> - > [!TIP]\n>   > Inner body\n:::\n',
]) {
    for (const method of ['moveCursorDown', 'moveCursorForward']) {
        test(`${method} skips read-only nested declarations through quote and list wrappers: ${source.split('\n')[1]}`, async () => {
            const f = await fixture(source);
            try {
                const blocks = f.editor.querySelectorAll('[data-mdw-callout="true"]');
                assert.equal(blocks.length, 1);
                assert.ok(f.editor.querySelector('[data-mdw-opaque-kind="callout-source"]'));
                f.manager.selectTypeLabel(f.block);
                if (method === 'moveCursorForward') {
                    f.cursor.moveCursorForward();
                    assert.equal(f.manager.getFocusedFormatButton()?.parentElement, f.block);
                }
                f.cursor[method]();
                assert.ok(!f.manager.getSelectedTypeLabel());
                const node = f.range().startContainer;
                const element = node.nodeType === 1 ? node : node.parentElement;
                assert.ok(!element.closest('[data-mdw-opaque-source]'));
                assert.equal(save(f.editor.innerHTML, source), source);
                assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
            } finally { f.restore(); }
        });
    }
}

test('leaving a type label stops in an editable paragraph before preserved nested source', async () => {
    const f = await fixture(':::note info\n> :::note warn\n> Inner body\n> :::\n:::\n');
    try {
        const empty = f.block.querySelector('.mdw-callout-content > p');
        assert.ok(empty);
        f.manager.selectTypeLabel(f.block);
        f.cursor.moveCursorDown();
        assert.equal(f.manager.getSelectedTypeLabel(), null);
        assert.equal(f.range().startContainer, empty);
        assert.equal(f.range().collapsed, true);
        assert.equal(f.before.length, 0); assert.equal(f.after.length, 0);
    } finally { f.restore(); }
});

test('the type label before a code body leads to editable code rather than its toolbar', async () => {
    const f = await fixture(':::note warn\n```js\ncode\n```\n:::\n');
    try {
        const pre = f.block.querySelector('pre');
        const toolbar = f.document.createElement('div');
        toolbar.setAttribute('contenteditable', 'false');
        toolbar.className = 'code-block-toolbar';
        toolbar.innerHTML = '<span class="code-block-language">javascript</span>';
        pre.insertBefore(toolbar, pre.firstChild);
        f.manager.selectTypeLabel(f.block);
        f.cursor.moveCursorDown();
        const range = f.range(), code = pre.querySelector('code');
        assert.ok(code === range.startContainer || code.contains(range.startContainer));
        assert.equal(range.collapsed, true);
    } finally { f.restore(); }
});

test('moving down from the final line of preceding code reaches the type label', async () => {
    const f = await fixture('```js\ncode\n```\n\n:::note warn\nBody\n:::\n');
    try {
        const code = f.editor.querySelector('pre code').firstChild;
        f.caret(code, code.length);
        f.cursor.moveCursorDown();
        assert.equal(f.manager.getSelectedTypeLabel(), f.title);
    } finally { f.restore(); }
});

for (const source of ['> :::note warn\n> Body\n> :::\n', '- > [!NOTE]\n  > Body\n']) {
    for (const method of ['moveCursorForward', 'moveCursorDown']) {
        test(`${method} reaches a type label nested in a quote or list`, async () => {
            const f = await fixture(source, { surround: true });
            try {
                const text = f.editor.firstElementChild.firstChild;
                f.caret(text, text.length);
                f.cursor[method]();
                assert.equal(f.manager.getSelectedTypeLabel(), f.title);
                assert.equal(f.before.length, 0);
            } finally { f.restore(); }
        });
    }
}
