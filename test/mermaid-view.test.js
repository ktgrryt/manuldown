const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

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
    const clickView = (pre, view) => {
        const event = document.createEvent('Event');
        event.initEvent('click', true, true);
        pre.querySelector(`.code-block-view-btn[data-mermaid-view="${view}"]`).dispatchEvent(event);
    };
    const pre = editor.querySelector('pre');
    manager.highlightCodeBlocks();
    return {
        editor, pre, manager, domUtils, history, clickView, renders,
        selectCode: () => { range = { startContainer: pre.querySelector('code').firstChild }; },
        get range() { return range; },
    };
}

test('opening Mermaid blocks defaults to diagrams and exposes the toggle beside Copy', async t => {
    const f = await fixture(t);
    assert.equal(f.pre.getAttribute('data-mermaid-view'), 'diagram');
    assert.ok(f.pre.querySelector('.mermaid-preview svg'));
    const actions = f.pre.querySelector('.code-block-actions');
    assert.equal(actions.firstElementChild.className, 'code-block-view-toggle');
    assert.equal(actions.querySelector('[data-mermaid-view="diagram"]').getAttribute('aria-pressed'), 'true');
    assert.equal(actions.querySelector('[data-mermaid-view="code"]').getAttribute('aria-pressed'), 'false');
    assert.ok(actions.querySelector('.code-block-copy-btn'));
    assert.equal(actions.querySelectorAll('.code-block-export-btn').length, 2);
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
