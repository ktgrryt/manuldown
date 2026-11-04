const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const modules = Promise.all(['MermaidViewer.js', 'CodeBlockManager.js', 'DOMUtils.js', 'StateManager.js'].map(name => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'media/modules', name), 'utf8') + `\n//# sourceURL=${name}`;
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}));
const diagram = '<svg id="diagram-1" width="100%" viewBox="-10 -20 2000 1000">' +
    '<style>#diagram-1 .node { fill: #fff; }</style><defs><marker id="arrow-1"/></defs>' +
    '<path marker-end="url(#arrow-1)"/><text>Large diagram</text></svg>';

async function fixture(t) {
    const window = domino.createWindow('<div id="editor" contenteditable="true">' +
        '<pre><code class="language-mermaid">graph LR\nA--&gt;B</code></pre></div>');
    const document = window.document;
    const editor = document.querySelector('#editor');
    const pre = editor.querySelector('pre');
    let range = null;
    let focused = editor;
    Object.defineProperty(document, 'activeElement', { get: () => focused });
    window.getSelection = () => ({
        get rangeCount() { return range ? 1 : 0; },
        getRangeAt: () => range,
        removeAllRanges: () => { range = null; },
        addRange: value => { range = value; },
    });
    window.mermaid = { initialize() {}, render: () => diagram };
    const nodeList = Object.getPrototypeOf(editor.querySelectorAll('pre'));
    const originalForEach = nodeList.forEach;
    nodeList.forEach = Array.prototype.forEach;
    // Domino provides parsing/events; emulate only the browser layout/modal APIs.
    const prototype = window.Element.prototype;
    const shims = {
        clientWidth: { get: () => 1000 },
        clientHeight: { get: () => 700 },
        getBoundingClientRect: { value: () => ({ left: 10, top: 20, width: 1000, height: 700 }) },
        setPointerCapture: { value() {} },
        replaceChildren: { value(...nodes) { this.textContent = ''; nodes.forEach(node => this.appendChild(node)); } },
    };
    const descriptors = new Map();
    for (const [key, value] of Object.entries(shims)) {
        descriptors.set(key, Object.getOwnPropertyDescriptor(prototype, key));
        Object.defineProperty(prototype, key, { configurable: true, ...value });
    }
    const createElement = document.createElement.bind(document);
    const trackFocus = element => Object.defineProperty(element, 'focus', { configurable: true, value() { focused = this; } });
    trackFocus(editor);
    document.createElement = name => {
        const element = createElement(name);
        trackFocus(element);
        if (name === 'dialog') {
            Object.defineProperties(element, {
                showModal: { value() { this.setAttribute('open', ''); } },
                close: { value() { this.removeAttribute('open'); } },
            });
        }
        return element;
    };
    const observers = [];
    class Observer {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe() {}
        disconnect() { this.disconnected = true; }
    }
    const originals = new Map();
    for (const [key, value] of Object.entries({
        window, document, navigator: { platform: 'MacIntel' }, Node: window.Node,
        CustomEvent: window.CustomEvent, ResizeObserver: Observer, Prism: { languages: {} },
    })) {
        originals.set(key, Object.getOwnPropertyDescriptor(global, key));
        Object.defineProperty(global, key, { configurable: true, writable: true, value });
    }
    const [{ MermaidViewer }, { CodeBlockManager }, { DOMUtils }, { StateManager }] = await modules;
    const manager = new CodeBlockManager(editor);
    const viewer = new MermaidViewer(editor);
    manager.highlightCodeBlocks();
    trackFocus(pre.querySelector('.code-block-expand-btn'));
    // The code-block observer is unnecessary here; install the viewer observer after setup.
    originals.set('MutationObserver', Object.getOwnPropertyDescriptor(global, 'MutationObserver'));
    global.MutationObserver = Observer;
    const domUtils = new DOMUtils(editor);
    const history = new StateManager(editor, {}, {
        getComparableHtml: () => domUtils.getCleanedHTML({ historyComparable: true }),
    });
    const dispatch = (node, type, values = {}) => {
        const event = document.createEvent('Event');
        event.initEvent(type, true, true);
        Object.assign(event, values);
        node.dispatchEvent(event);
        return event;
    };
    t.after(() => {
        viewer.close();
        editor.querySelectorAll('pre').forEach(block => manager._clearMermaidPreview(block));
        if (originalForEach === undefined) delete nodeList.forEach;
        else nodeList.forEach = originalForEach;
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(prototype, key, descriptor);
            else delete prototype[key];
        }
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(global, key, descriptor);
            else delete global[key];
        }
    });
    return {
        viewer, manager, editor, pre, document, observers, domUtils, history, dispatch,
        open: () => dispatch(pre.querySelector('.code-block-expand-btn'), 'click'),
        action: name => dispatch(viewer.dialog.querySelector(`[data-action="${name}"]`), 'click'),
        key: key => dispatch(viewer.viewport, 'keydown', { key }),
        selectCode() {
            range = { commonAncestorContainer: pre.querySelector('code'), cloneRange() { return this; } };
            return range;
        },
        get range() { return range; },
        get focused() { return focused; },
    };
}

test('Expand opens a modal fitted to intrinsic SVG dimensions and namespaces styles/markers', async t => {
    const f = await fixture(t);
    f.open();
    const { viewer } = f;
    assert.equal(viewer.dialog.parentElement, f.document.body);
    assert.equal(viewer.dialog.hasAttribute('open'), true);
    assert.equal(viewer.width, 2000);
    assert.equal(viewer.height, 1000);
    assert.equal(viewer.scale, 952 / 2000);
    assert.equal(viewer.x, 24);
    assert.equal(viewer.y, (700 - 476) / 2);
    const svg = viewer.stage.querySelector('svg');
    assert.equal(svg.style.width, '2000px');
    assert.notEqual(svg.id, 'diagram-1');
    assert.ok(svg.querySelector('style').textContent.includes(`#${svg.id} .node`));
    assert.equal(svg.querySelector('path').getAttribute('marker-end'), `url(#${svg.querySelector('marker').id})`);
    assert.equal(f.pre.querySelector('.mermaid-preview svg').id, 'diagram-1');
});

test('zoom stays anchored to the pointer and respects minimum/maximum bounds', async t => {
    const f = await fixture(t);
    f.open();
    const v = f.viewer;
    const point = { x: (200 - v.x) / v.scale, y: (150 - v.y) / v.scale };
    v.zoomTo(2, 200, 150);
    assert.equal(v.x + point.x * v.scale, 200);
    assert.equal(v.y + point.y * v.scale, 150);
    v.zoomTo(100);
    assert.equal(v.scale, 16);
    v.zoomTo(0.00001);
    assert.equal(v.scale, 0.01);
    f.action('fit');
    assert.equal(v.scale, 952 / 2000);
    f.action('actual');
    assert.equal(v.scale, 1);
    f.action('zoom-in');
    assert.equal(v.scale, 1.25);
    f.action('zoom-out');
    assert.equal(v.scale, 1);
});

test('wheel zoom normalizes line deltas and pointer capture keeps drag movement', async t => {
    const f = await fixture(t);
    f.open();
    const v = f.viewer;
    const initialScale = v.scale;
    const wheel = f.dispatch(v.viewport, 'wheel', { deltaY: -1, deltaMode: 1, clientX: 210, clientY: 170 });
    assert.equal(wheel.defaultPrevented, true);
    assert.ok(v.scale > initialScale);
    const { x, y } = v;
    f.dispatch(v.viewport, 'pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    f.dispatch(v.viewport, 'pointermove', { pointerId: 2, clientX: 400, clientY: 300 });
    assert.equal(v.x, x);
    f.dispatch(v.viewport, 'pointermove', { pointerId: 1, clientX: 150, clientY: 125 });
    assert.equal(v.x, x + 50);
    assert.equal(v.y, y + 25);
    f.dispatch(v.viewport, 'pointercancel', { pointerId: 1 });
    assert.equal(v.drag, null);
    assert.equal(v.viewport.classList.contains('is-dragging'), false);
});

test('keyboard pan, zoom and Escape work without changing Markdown or history', async t => {
    const f = await fixture(t);
    const cleaned = f.domUtils.getCleanedHTML();
    f.history.seedState();
    f.history.redoStack.push({ html: 'redo' });
    const range = f.selectCode();
    f.open();
    assert.equal(f.range, null);
    f.key('0');
    assert.equal(f.viewer.scale, 1);
    const x = f.viewer.x;
    f.key('ArrowLeft');
    assert.equal(f.viewer.x, x + 40);
    f.key('+');
    assert.equal(f.viewer.scale, 1.25);
    f.key('f');
    assert.equal(f.viewer.fitted, true);
    f.history.commitStateAfterChange();
    assert.equal(f.domUtils.getCleanedHTML(), cleaned);
    assert.equal(f.history.undoStack.length, 1);
    assert.equal(f.history.redoStack.length, 1);
    f.key('Escape');
    assert.equal(f.viewer.dialog, null);
    assert.equal(f.range, range);
    assert.equal(f.focused, f.pre.querySelector('.code-block-expand-btn'));
    assert.ok(f.observers.every(observer => observer.disconnected));
});

test('a loading or invalid diagram shows status, then updates when rendering finishes', async t => {
    const f = await fixture(t);
    const preview = f.pre.querySelector('.mermaid-preview');
    preview.textContent = 'Loading Mermaid diagram…';
    f.open();
    assert.equal(f.viewer.status.textContent, preview.textContent);
    assert.equal(f.viewer.dialog.querySelector('[data-action="fit"]').disabled, true);
    preview.textContent = 'Mermaid render error: invalid diagram';
    f.observers[0].callback();
    assert.equal(f.viewer.status.textContent, preview.textContent);
    preview.innerHTML = diagram;
    f.observers[0].callback();
    assert.equal(f.viewer.status.hidden, true);
    assert.ok(f.viewer.stage.querySelector('svg'));
    assert.equal(f.viewer.dialog.querySelector('[data-action="fit"]').disabled, false);
});

test('resize refits the whole diagram while manual pan and zoom remain stable', async t => {
    const f = await fixture(t);
    f.open();
    Object.defineProperty(f.viewer.viewport, 'clientWidth', { value: 500 });
    f.observers[1].callback();
    assert.equal(f.viewer.scale, 452 / 2000);
    f.viewer.zoomTo(2);
    f.observers[1].callback();
    assert.equal(f.viewer.scale, 2);
});

test('reopening resets the view and only one modal remains; removed blocks close it', async t => {
    const f = await fixture(t);
    f.open();
    f.viewer.zoomTo(3);
    f.open();
    assert.equal(f.document.querySelectorAll('.mermaid-viewer').length, 1);
    assert.equal(f.viewer.scale, 952 / 2000);
    f.pre.remove();
    f.observers.at(-2).callback();
    assert.equal(f.viewer.dialog, null);
    assert.equal(f.focused, f.editor);
});

test('source view and mixed-case Mermaid language open the same diagram; changing language closes it', async t => {
    const f = await fixture(t);
    f.pre.querySelector('code').className = 'language-Mermaid';
    f.manager._setMermaidView(f.pre, 'code');
    f.open();
    assert.ok(f.viewer.stage.querySelector('svg'));
    assert.equal(f.pre.getAttribute('data-mermaid-view'), 'code');
    f.manager.updateCodeBlockLanguage(f.pre, 'plaintext');
    f.observers[0].callback();
    assert.equal(f.viewer.dialog, null);
    assert.ok(!f.pre.querySelector('.code-block-expand-btn'));
});
