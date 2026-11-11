const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');
const prism = require('prismjs');

function importModule(name) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'media/modules', name), 'utf8') +
        `\n//# sourceURL=${name}`;
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const modules = Promise.all([
    importModule('CodeBlockManager.js'), importModule('DOMUtils.js'), importModule('StateManager.js'),
]);

async function fixture(t, html = '<pre><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>') {
    const window = domino.createWindow(`<div id="editor" contenteditable="true">${html}</div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    let focused = null;
    Object.defineProperty(document, 'activeElement', { get: () => focused });
    const createElement = document.createElement.bind(document);
    document.createElement = name => {
        const element = createElement(name);
        Object.defineProperty(element, 'focus', { value() { focused = this; } });
        return element;
    };
    const nodeListPrototype = Object.getPrototypeOf(editor.querySelectorAll('pre'));
    const previousForEach = nodeListPrototype.forEach;
    nodeListPrototype.forEach = Array.prototype.forEach;
    let range = null;
    window.getSelection = () => ({
        get rangeCount() { return range ? 1 : 0; },
        getRangeAt: () => range,
        removeAllRanges: () => { range = null; },
    });
    const renders = [];
    window.mermaid = {
        initialize() {},
        render(_id, code) {
            renders.push(code);
            return '<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>';
        },
    };
    const originals = new Map();
    for (const [key, value] of Object.entries({
        window, document, Node: window.Node, navigator: { platform: 'MacIntel' },
        Prism: { languages: {} }, CustomEvent: window.CustomEvent,
    })) {
        originals.set(key, Object.getOwnPropertyDescriptor(global, key));
        Object.defineProperty(global, key, { configurable: true, writable: true, value });
    }
    const [{ CodeBlockManager }, { DOMUtils }, { StateManager }] = await modules;
    const manager = new CodeBlockManager(editor);
    t.after(() => {
        manager._closeMermaidExportMenu();
        manager._stopCopyButtonStateReconciler();
        editor.querySelectorAll('pre').forEach(pre => manager._clearMermaidPreview(pre));
        if (previousForEach === undefined) delete nodeListPrototype.forEach;
        else nodeListPrototype.forEach = previousForEach;
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(global, key, descriptor);
            else delete global[key];
        }
    });
    const domUtils = new DOMUtils(editor);
    const history = new StateManager(editor, {}, {
        getComparableHtml: () => domUtils.getCleanedHTML({ historyComparable: true }),
    });
    const dispatch = (target, type, properties = {}) => {
        const event = document.createEvent('Event');
        event.initEvent(type, true, true);
        Object.assign(event, properties);
        target.dispatchEvent(event);
        return event;
    };
    const clickView = (pre, view) => dispatch(pre.querySelector(`.code-block-view-btn[data-mermaid-view="${view}"]`), 'click');
    const pre = editor.querySelector('pre');
    manager.highlightCodeBlocks();
    return {
        editor, pre, manager, domUtils, history, clickView, renders, dispatch, document,
        get focused() { return focused; },
        selectCode: () => { range = { startContainer: pre.querySelector('code').firstChild }; },
        get range() { return range; },
    };
}

test('opening Mermaid blocks defaults to diagrams and exposes the toggle beside Copy', async t => {
    const f = await fixture(t);
    assert.equal(f.pre.getAttribute('data-mermaid-view'), 'diagram');
    assert.ok(f.pre.querySelector('.mermaid-preview svg'));
    const actions = f.pre.querySelector('.code-block-actions');
    assert.ok(actions.firstElementChild.classList.contains('code-block-view-toggle'));
    assert.equal(actions.querySelector('[data-mermaid-view="diagram"]').getAttribute('aria-pressed'), 'true');
    assert.equal(actions.querySelector('[data-mermaid-view="code"]').getAttribute('aria-pressed'), 'false');
    assert.ok(actions.querySelector('.code-block-copy-btn'));
    assert.equal(actions.querySelectorAll('.code-block-export-btn').length, 2);
});

test('returning to a cached diagram invalidates an older pending render', async t => {
    const f = await fixture(t);
    const code = f.pre.querySelector('code');
    const original = code.textContent;
    const originalSvg = f.pre.querySelector('.mermaid-preview').innerHTML;
    let finish;
    window.mermaid.render = () => new Promise(resolve => { finish = resolve; });
    f.clickView(f.pre, 'code');
    code.textContent = 'graph TD\nA-->C';
    f.clickView(f.pre, 'diagram');
    f.clickView(f.pre, 'code');
    code.textContent = original;
    f.clickView(f.pre, 'diagram');
    finish({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>stale C</text></svg>' });
    await Promise.resolve();
    assert.equal(f.pre.querySelector('.mermaid-preview').innerHTML, originalSvg);
    assert.equal(f.manager.mermaidCache.get(f.pre).code, original);
    assert.equal(f.manager.mermaidCache.get(f.pre).svg, originalSvg);
});

test('Download offers PNG and SVG, exports the chosen format and closes the menu', async t => {
    const f = await fixture(t);
    const toggle = f.pre.querySelector('.code-block-download-btn');
    const menu = f.pre.querySelector('.code-block-export-menu');
    const exports = [];
    f.manager._exportMermaidPng = (pre, filename) => exports.push({ pre, filename });
    f.manager._exportMermaidSvg = (pre, filename) => exports.push({ pre, filename });
    assert.equal(menu.hidden, true);
    f.dispatch(toggle, 'click');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(menu.hidden, false);
    assert.equal(f.focused.getAttribute('data-format'), 'png');
    f.dispatch(menu.querySelector('[data-format="png"]'), 'click');
    assert.equal(exports[0].pre, f.pre);
    assert.equal(exports[0].filename, 'mermaid-diagram.png');
    assert.equal(menu.hidden, true);
    assert.equal(f.focused, toggle);
    f.dispatch(toggle, 'click');
    f.dispatch(menu.querySelector('[data-format="svg"]'), 'click');
    assert.equal(exports[1].filename, 'mermaid-diagram.svg');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('Download supports keyboard navigation, Escape, outside clicks and focus changes', async t => {
    const f = await fixture(t);
    const toggle = f.pre.querySelector('.code-block-download-btn');
    const menu = f.pre.querySelector('.code-block-export-menu');
    f.dispatch(toggle, 'keydown', { key: 'ArrowDown' });
    assert.equal(f.focused.getAttribute('data-format'), 'png');
    f.dispatch(menu, 'keydown', { key: 'ArrowDown' });
    assert.equal(f.focused.getAttribute('data-format'), 'svg');
    f.dispatch(menu, 'keydown', { key: 'ArrowDown' });
    assert.equal(f.focused.getAttribute('data-format'), 'png');
    f.dispatch(menu, 'keydown', { key: 'End' });
    assert.equal(f.focused.getAttribute('data-format'), 'svg');
    f.dispatch(menu, 'keydown', { key: 'Home' });
    assert.equal(f.focused.getAttribute('data-format'), 'png');
    f.dispatch(menu, 'keydown', { key: 'Escape' });
    assert.equal(menu.hidden, true);
    assert.equal(f.focused, toggle);
    f.dispatch(toggle, 'keydown', { key: 'ArrowUp' });
    assert.equal(f.focused.getAttribute('data-format'), 'svg');
    f.dispatch(f.editor, 'mousedown');
    assert.equal(menu.hidden, true);
    f.dispatch(toggle, 'click');
    f.dispatch(f.pre.querySelector('.code-block-expand-btn'), 'focusin');
    assert.equal(menu.hidden, true);
});

test('only one download menu opens at a time and rebuilding its toolbar dismisses it', async t => {
    const f = await fixture(t, '<pre><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>' +
        '<pre><code class="language-mermaid">graph TD\nC--&gt;D</code></pre>');
    const second = f.editor.querySelectorAll('pre')[1];
    const firstMenu = f.pre.querySelector('.code-block-export-menu');
    const secondMenu = second.querySelector('.code-block-export-menu');
    f.dispatch(f.pre.querySelector('.code-block-download-btn'), 'click');
    f.dispatch(second.querySelector('.code-block-download-btn'), 'click');
    assert.equal(firstMenu.hidden, true);
    assert.equal(secondMenu.hidden, false);
    f.manager.addCodeBlockControls(second, 'mermaid');
    assert.equal(f.manager.mermaidExportMenu, null);
    assert.equal(second.querySelector('.code-block-export-menu').hidden, true);
});

test('the icon copy button copies source and restores its icon after feedback', async t => {
    const f = await fixture(t);
    const button = f.pre.querySelector('.code-block-copy-btn');
    const writes = [];
    f.manager._writeTextToClipboard = async text => writes.push(text);
    f.dispatch(button, 'click');
    await Promise.resolve();
    assert.deepEqual(writes, ['graph TD\nA-->B']);
    assert.equal(button.getAttribute('data-copy-state'), 'success');
    assert.equal(button.getAttribute('aria-label'), 'Copied!');
    assert.ok(button.querySelector('svg'));
    f.manager._resetCopyButtonState(button);
    assert.equal(button.getAttribute('aria-label'), 'Copy Mermaid source');
    assert.ok(button.querySelector('svg'));
    assert.equal(button.textContent, '');
});

test('choosing Mermaid for an existing code block keeps the source visible', async t => {
    const f = await fixture(t, '<pre><code>graph TD\nA--&gt;B</code></pre>');
    f.manager.updateCodeBlockLanguage(f.pre, 'mermaid');
    assert.equal(f.pre.getAttribute('data-mermaid-view'), 'code');
    assert.equal(f.pre.querySelector('code').className, 'language-mermaid');
    assert.equal(f.pre.querySelector('[data-mermaid-view="code"]').getAttribute('aria-pressed'), 'true');
    f.manager.highlightCodeBlocks();
    assert.equal(f.pre.getAttribute('data-mermaid-view'), 'code');
});

test('language changes remove stale Prism classes from PRE while preserving other block metadata', async t => {
    const f = await fixture(t, '<pre class="custom-block" data-example="keep"><code>a</code></pre>');
    global.Prism = prism;
    f.manager.updateCodeBlockLanguage(f.pre, 'javascript');
    assert.equal(f.pre.classList.contains('language-javascript'), true);

    f.manager.updateCodeBlockLanguage(f.pre, 'plaintext');
    assert.equal(f.pre.querySelector('.code-block-language').textContent, 'plaintext');
    assert.equal(f.pre.querySelector('code').className, '');
    assert.equal(Array.from(f.pre.classList).some(name => name.startsWith('language-')), false);
    assert.equal(f.pre.classList.contains('custom-block'), true);
    assert.equal(f.pre.getAttribute('data-example'), 'keep');

    f.manager.updateCodeBlockLanguage(f.pre, 'javascript');
    f.manager.updateCodeBlockLanguage(f.pre, 'mermaid');
    assert.equal(f.pre.querySelector('.code-block-language').textContent, 'mermaid');
    assert.equal(f.pre.querySelector('code').className, 'language-mermaid');
    assert.equal(Array.from(f.pre.classList).some(name => name.startsWith('language-')), false);
    assert.equal(f.pre.classList.contains('custom-block'), true);

    f.manager.updateCodeBlockLanguage(f.pre, 'javascript');
    f.manager.updateCodeBlockLanguage(f.pre, 'python');
    assert.equal(f.pre.classList.contains('language-javascript'), false);
    assert.equal(f.pre.classList.contains('language-python'), true);
    assert.equal(f.pre.querySelector('code').textContent, 'a');
});

test('the display toggle is independent for each block and renders the latest source', async t => {
    const f = await fixture(t,
        '<pre><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>' +
        '<pre><code class="language-mermaid">graph TD\nC--&gt;D</code></pre>');
    f.clickView(f.pre, 'code');
    const second = f.editor.querySelectorAll('pre')[1];
    assert.equal(f.pre.getAttribute('data-mermaid-view'), 'code');
    assert.equal(second.getAttribute('data-mermaid-view'), 'diagram');
    f.pre.querySelector('code').textContent = 'graph TD\nA-->C';
    f.clickView(f.pre, 'diagram');
    assert.equal(f.pre.getAttribute('data-mermaid-view'), 'diagram');
    assert.equal(f.renders.at(-1), 'graph TD\nA-->C');
    assert.equal(f.pre.querySelector('[data-mermaid-view="diagram"]').getAttribute('aria-pressed'), 'true');
});

test('switching to the diagram clears a caret in the hidden source', async t => {
    const f = await fixture(t);
    f.clickView(f.pre, 'code');
    f.selectCode();
    f.clickView(f.pre, 'diagram');
    assert.equal(f.range, null);
});

test('view changes preserve saved source and do not add Undo entries or clear Redo', async t => {
    const f = await fixture(t);
    const cleaned = f.domUtils.getCleanedHTML();
    assert.equal(cleaned, '<pre><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>');
    f.history.seedState();
    f.history.redoStack.push({ html: 'redo state' });
    f.clickView(f.pre, 'code');
    f.history.commitStateAfterChange();
    assert.equal(f.domUtils.getCleanedHTML(), cleaned);
    assert.equal(f.history.undoStack.length, 1);
    assert.equal(f.history.redoStack.length, 1);
    // Raw history snapshots retain the display choice when their controls rebuild.
    f.editor.innerHTML = f.editor.innerHTML;
    f.manager.highlightCodeBlocks();
    const restored = f.editor.querySelector('pre');
    assert.equal(restored.getAttribute('data-mermaid-view'), 'code');
    assert.equal(restored.querySelector('[data-mermaid-view="code"]').getAttribute('aria-pressed'), 'true');
});

test('switching away from Mermaid removes the toggle and cancels pending rendering', async t => {
    const f = await fixture(t);
    f.manager.highlightSingleCodeBlock(f.pre.querySelector('code'));
    f.manager.updateCodeBlockLanguage(f.pre, 'plaintext');
    assert.equal(f.pre.hasAttribute('data-mermaid-view'), false);
    assert.ok(!f.pre.querySelector('.code-block-view-toggle'));
    assert.ok(!f.pre.querySelector('.mermaid-preview'));
    assert.equal(f.manager.mermaidRenderHandles.has(f.pre), false);
    f.manager.updateCodeBlockLanguage(f.pre, 'mermaid');
    assert.equal(f.pre.getAttribute('data-mermaid-view'), 'code');
});
