const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

function importModule(name) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', name), 'utf8') +
        `\n//# sourceURL=${name}`;
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const modules = Promise.all([
    importModule('MathManager.js'), importModule('CodeBlockManager.js'), importModule('DOMUtils.js'),
]);
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');

const formulaHtml = (tex, mode = 'inline') =>
    `<span class="mdw-math" data-mdw-math="${mode}" contenteditable="false">${tex}</span>`;

const katex = {
    renderToString(tex, options) {
        if (tex.includes('\\bad')) {
            if (options.throwOnError) throw new Error('KaTeX parse error: Undefined control sequence: \\bad');
            return `<span class="katex-error">${tex}</span>`;
        }
        return `<span class="katex">${options.displayMode ? 'display' : 'inline'}:${tex}</span>`;
    },
};

function createRangeClass() {
    const indexOf = node => Array.prototype.indexOf.call(node.parentNode.childNodes, node);
    return class FakeRange {
        constructor() {
            this.startContainer = this.endContainer = null;
            this.startOffset = this.endOffset = 0;
        }
        get collapsed() {
            return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
        }
        setStart(node, offset) {
            this.startContainer = node;
            this.startOffset = offset;
            if (!this.endContainer) this.setEnd(node, offset);
        }
        setEnd(node, offset) {
            this.endContainer = node;
            this.endOffset = offset;
        }
        setStartBefore(node) { this.setStart(node.parentNode, indexOf(node)); }
        setStartAfter(node) { this.setStart(node.parentNode, indexOf(node) + 1); }
        selectNode(node) {
            this.setStartBefore(node);
            this.setEnd(node.parentNode, indexOf(node) + 1);
        }
        selectNodeContents(node) {
            this.startContainer = this.endContainer = node;
            this.startOffset = 0;
            this.endOffset = node.nodeType === 3 ? node.data.length : node.childNodes.length;
        }
        collapse(toStart = false) {
            if (toStart) this.setEnd(this.startContainer, this.startOffset);
            else this.setStart(this.endContainer, this.endOffset);
        }
        cloneRange() {
            return Object.assign(new FakeRange(), this);
        }
        toString() {
            assert.equal(this.startContainer, this.endContainer, 'tests select within one text node');
            return this.startContainer.data.slice(this.startOffset, this.endOffset);
        }
        deleteContents() {
            const node = this.startContainer;
            node.data = node.data.slice(0, this.startOffset) + node.data.slice(this.endOffset);
            this.collapse(true);
        }
        insertNode(node) {
            const container = this.startContainer;
            if (container.nodeType === 3) {
                const tail = container.splitText(this.startOffset);
                tail.parentNode.insertBefore(node, tail);
            } else {
                container.insertBefore(node, container.childNodes[this.startOffset] || null);
            }
        }
    };
}

async function fixture(html, options = {}) {
    const [{ MathManager }] = await modules;
    const window = domino.createWindow(
        `<div id="editor" contenteditable="true">${html}</div><script nonce="page-nonce"></script>`
    );
    const document = window.document;
    const editor = document.getElementById('editor');
    const bodyScript = document.querySelector('body > script[nonce]');
    bodyScript.nonce = 'page-nonce';
    const elementPrototype = Object.getPrototypeOf(Object.getPrototypeOf(editor));
    elementPrototype.attachShadow = function () {
        const root = document.createElement('div');
        Object.defineProperty(this, 'shadowRoot', { configurable: true, value: root });
        return root;
    };
    Object.defineProperty(document, 'activeElement', { value: editor, writable: true });
    elementPrototype.focus = function () {};
    elementPrototype.setSelectionRange = function () {};
    elementPrototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
    window.katex = options.katex === undefined ? katex : options.katex;
    const FakeRange = createRangeClass();
    document.createRange = () => new FakeRange();
    let range = null;
    window.getSelection = () => ({
        get rangeCount() { return range ? 1 : 0; },
        getRangeAt: () => range,
        removeAllRanges: () => { range = null; },
        addRange: (next) => { range = next; },
    });
    const history = [];
    const stateManager = {
        saveState: () => history.push('save'),
        beginChangeAtSelection: () => history.push('begin'),
        commitStateAfterChange: () => history.push('commit'),
        saveRange: () => ({}),
    };
    let changes = 0;
    const manager = new MathManager(editor, stateManager, {
        onChange: () => { changes++; },
        scriptSrc: options.scriptSrc || '',
        styleHref: options.styleHref || '',
    });
    const select = (node, startOffset, endNode = node, endOffset = startOffset) => {
        range = new FakeRange();
        range.setStart(node, startOffset);
        range.setEnd(endNode, endOffset);
    };
    const input = () => manager.popover.querySelector('.math-popover-input');
    return {
        window, document, editor, manager, history, select, input,
        get range() { return range; },
        get changes() { return changes; },
        // Compare as booleans: a failing assertion would print whole DOM trees.
        caretAt: (node, offset) => !!range && range.collapsed &&
            range.startContainer === node && range.startOffset === offset,
        formula: () => editor.querySelector('span[data-mdw-math]'),
        output: (node) => node.shadowRoot.querySelector('.output'),
    };
}

const key = (name, modifiers = {}) => ({
    key: name, keyCode: 0, isComposing: false, defaultPrevented: false,
    shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
});

test('formulas render in shadow roots, so the document keeps only their TeX', async () => {
    const f = await fixture(`<p>A ${formulaHtml('x^2')} and ${formulaHtml('\\sum', 'display')}</p>`);
    const before = f.editor.innerHTML;
    f.manager.renderAll();
    const [inline, display] = f.editor.querySelectorAll('span[data-mdw-math]');
    assert.equal(f.output(inline).innerHTML, '<span class="katex">inline:x^2</span>');
    assert.equal(f.output(display).innerHTML, '<span class="katex">display:\\sum</span>');
    assert.equal(f.editor.innerHTML, before);
    assert.equal(f.manager.toMarkdown(inline), '$x^2$');
    assert.equal(f.manager.toMarkdown(display), '$$\\sum$$');
});

test('KaTeX loads once with the page nonce, and pending formulas render when it arrives', async () => {
    const f = await fixture(`<p>${formulaHtml('a')}${formulaHtml('b')}</p>`, {
        katex: null,
        scriptSrc: 'https://cdn.example/katex.min.js',
        styleHref: 'https://cdn.example/katex.min.css',
    });
    f.manager.renderAll();
    const scripts = f.document.head.querySelectorAll('script');
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].getAttribute('src'), 'https://cdn.example/katex.min.js');
    assert.equal(scripts[0].nonce, 'page-nonce');
    // The page declares the fonts, which a shadow root's @font-face cannot.
    assert.equal(f.document.head.querySelectorAll('link[rel="stylesheet"]').length, 1);
    const [first, second] = f.editor.querySelectorAll('span[data-mdw-math]');
    assert.equal(f.output(first).className, 'output is-pending');
    assert.equal(f.output(second).textContent, 'b');

    f.window.katex = katex;
    const load = f.document.createEvent('Event');
    load.initEvent('load', false, false);
    scripts[0].dispatchEvent(load);
    assert.equal(f.manager.loadState, 'loaded');
    assert.equal(f.output(first).innerHTML, '<span class="katex">inline:a</span>');
    assert.equal(f.output(second).innerHTML, '<span class="katex">inline:b</span>');
});

test('a KaTeX load failure shows the TeX instead of retrying', async () => {
    const f = await fixture(`<p>${formulaHtml('a')}</p>`, { katex: null, scriptSrc: 'https://cdn.example/katex.min.js' });
    f.manager.renderAll();
    const error = f.document.createEvent('Event');
    error.initEvent('error', false, false);
    f.document.head.querySelector('script').dispatchEvent(error);
    assert.equal(f.output(f.formula()).className, 'output is-error');
    assert.equal(f.output(f.formula()).textContent, 'a');
    f.manager.renderFormula(f.formula(), true);
    assert.equal(f.document.head.querySelectorAll('script').length, 1);
});

test('a new formula opens its editor, follows the typed TeX and commits one history step', async () => {
    const f = await fixture('<p>Sum: </p>');
    const text = f.editor.querySelector('p').firstChild;
    f.select(text, text.data.length);
    assert.equal(f.manager.insert(), true);
    const formula = f.formula();
    assert.equal(formula.textContent, '');
    assert.equal(f.manager.popover.hidden, false);
    assert.deepEqual(f.output(formula).className.split(' ').sort(), ['is-active', 'is-empty', 'output']);

    const input = f.input();
    input.value = 'a+\\bad';
    f.manager.handleInput();
    assert.equal(formula.textContent, 'a+\\bad');
    assert.equal(f.manager.popover.querySelector('.math-popover-error').textContent,
        'Undefined control sequence: \\bad');
    input.value = 'a+b';
    f.manager.handleInput();
    assert.equal(f.output(formula).innerHTML, '<span class="katex">inline:a+b</span>');
    assert.equal(f.manager.popover.querySelector('.math-popover-error').hidden, true);

    f.manager.handleInputKeydown(key('Enter'));
    assert.equal(f.manager.popover.hidden, true);
    assert.deepEqual(f.history, ['save', 'commit']);
    assert.equal(f.editor.innerHTML, `<p>Sum: ${formulaHtml('a+b')}</p>`);
    // Right after the formula, outside its hidden TeX.
    assert.ok(f.caretAt(f.editor.querySelector('p'), 2));
});

test('Escape removes a new formula and restores the TeX of an existing one', async () => {
    const created = await fixture('<p>A </p>');
    const text = created.editor.querySelector('p').firstChild;
    created.select(text, 2);
    created.manager.insert();
    created.manager.handleInputKeydown(key('Escape'));
    assert.ok(!created.formula());
    assert.deepEqual(created.history, ['save', 'commit']);

    const existing = await fixture(`<p>A ${formulaHtml('x')}</p>`);
    existing.manager.edit(existing.formula());
    existing.input().value = 'y';
    existing.manager.handleInput();
    assert.equal(existing.formula().textContent, 'y');
    existing.manager.handleInputKeydown(key('Escape'));
    assert.equal(existing.formula().textContent, 'x');
    assert.equal(existing.output(existing.formula()).className, 'output');
});

test('Done with no TeX and Remove both delete the formula', async () => {
    const emptied = await fixture(`<p>${formulaHtml('x')}</p>`);
    emptied.manager.edit(emptied.formula());
    emptied.input().value = '  ';
    emptied.manager.handleInput();
    emptied.manager.popover.querySelector('[data-action="done"]').click();
    assert.ok(!emptied.formula());
    // The emptied line stays an editable paragraph.
    assert.equal(emptied.editor.innerHTML, '<p><br></p>');

    const removed = await fixture(`<p>a${formulaHtml('x')}b</p>`);
    removed.manager.edit(removed.formula());
    removed.manager.popover.querySelector('[data-action="remove"]').click();
    assert.equal(removed.editor.innerHTML, '<p>ab</p>');
    assert.deepEqual(removed.history, ['begin', 'commit']);
});

test('a selection within one line becomes the TeX of a formula', async () => {
    const f = await fixture('<p>Let x^2 be</p>');
    const text = f.editor.querySelector('p').firstChild;
    f.select(text, 4, text, 7);
    assert.equal(f.manager.insert(), true);
    assert.equal(f.editor.innerHTML, `<p>Let ${formulaHtml('x^2')} be</p>`);
    assert.equal(f.manager.popover, null);
    assert.deepEqual(f.history, ['save', 'commit']);
});

test('formulas cannot be inserted into code', async () => {
    const f = await fixture('<p><code>x</code></p>');
    f.select(f.editor.querySelector('code').firstChild, 1);
    assert.equal(f.manager.canInsert(), false);
    assert.equal(f.manager.insert(), false);
});

test('the caret selects a formula before stepping past it, and deletion removes it in one step', async () => {
    const f = await fixture(`<p>a${formulaHtml('x')}b</p>`);
    const [before, formula, after] = Array.from(f.editor.querySelector('p').childNodes);
    f.select(before, 1);
    assert.equal(f.manager.handleKeydown(key('ArrowRight')), true);
    assert.ok(f.manager.getSelectedFormula(f.range) === formula);
    assert.equal(f.manager.handleKeydown(key('ArrowRight')), true);
    assert.ok(f.caretAt(after, 0));
    assert.equal(f.manager.handleKeydown(key('ArrowLeft')), true);
    assert.ok(f.manager.getSelectedFormula(f.range) === formula);
    assert.equal(f.manager.handleKeydown(key('ArrowLeft')), true);
    assert.ok(f.caretAt(before, 1));
    assert.equal(f.manager.handleKeydown(key('ArrowLeft')), false, 'text before the caret moves natively');

    // A caret placed in the hidden TeX moves beside the formula.
    f.select(formula.firstChild, 1);
    assert.equal(f.manager.normalizeCaret(), true);
    assert.ok(f.caretAt(after, 0));

    assert.equal(f.manager.handleKeydown(key('Backspace')), true);
    assert.equal(f.editor.innerHTML, '<p>ab</p>');
    assert.ok(f.caretAt(before, 1));
    assert.deepEqual(f.history, ['save', 'commit']);

    const forward = await fixture(`<p>a${formulaHtml('x')}</p>`);
    forward.select(forward.editor.querySelector('p').firstChild, 1);
    assert.equal(forward.manager.handleKeydown(key('Delete')), true);
    assert.equal(forward.editor.innerHTML, '<p>a</p>');
});

test('Enter on a selected formula opens its editor', async () => {
    const f = await fixture(`<p>a${formulaHtml('x')}b</p>`);
    const paragraph = f.editor.querySelector('p');
    f.select(paragraph, 1, paragraph, 2);
    assert.equal(f.manager.handleKeydown(key('Enter')), true);
    assert.equal(f.manager.popover.hidden, false);
    assert.equal(f.input().value, 'x');
});

for (const [name, navigation, side, isMac] of [
    ['Right', key('ArrowRight'), 'before', false],
    ['Left', key('ArrowLeft'), 'after', false],
    ['Ctrl+F', key('f', { ctrlKey: true }), 'before', true],
    ['Ctrl+B', key('b', { ctrlKey: true }), 'after', true],
]) {
    test(`${name} selects the whole formula and Enter reopens its TeX for editing`, async () => {
        const f = await fixture(`<p>a${formulaHtml('x^2')}b</p>`);
        const [before, formula, after] = Array.from(f.editor.querySelector('p').childNodes);
        f.manager.setup();
        f.editor.focus();
        f.select(side === 'before' ? before : after, side === 'before' ? 1 : 0);
        const original = f.editor.innerHTML;
        assert.equal(f.manager.handleKeydown(navigation, isMac), true);
        assert.ok(f.manager.getSelectedFormula(f.range) === formula);
        assert.ok(f.output(formula).classList.contains('is-selected'));
        assert.equal(f.editor.innerHTML, original, 'selection UI stays out of saved HTML');
        assert.deepEqual(f.history, []);
        assert.equal(f.changes, 0);
        f.manager.renderFormula(formula, true);
        assert.ok(f.output(formula).classList.contains('is-selected'));

        assert.equal(f.manager.handleKeydown(key('Enter')), true);
        assert.equal(f.manager.popover.hidden, false);
        assert.equal(f.input().value, 'x^2');
        assert.ok(!f.output(formula).classList.contains('is-selected'));
        f.input().value = 'x^3';
        f.manager.handleInput();
        f.manager.handleInputKeydown(key('Enter'));
        assert.equal(formula.textContent, 'x^3');
        assert.ok(f.caretAt(after, 0));
        assert.deepEqual(f.history, ['begin', 'commit']);

        assert.equal(f.manager.handleKeydown(key('ArrowLeft')), true);
        assert.equal(f.manager.handleKeydown(key('Enter')), true);
        assert.equal(f.input().value, 'x^3');
        f.input().value = 'cancelled';
        f.manager.handleInput();
        f.manager.handleInputKeydown(key('Escape'));
        assert.equal(formula.textContent, 'x^3');
    });
}

test('arrow navigation can leave a selected formula on either side without editing', async () => {
    const f = await fixture(`<p>a${formulaHtml('x')}b</p>`);
    const [before, formula, after] = Array.from(f.editor.querySelector('p').childNodes);
    f.manager.renderAll();
    f.editor.focus();
    for (const exitKey of ['ArrowLeft', 'ArrowRight']) {
        f.select(before, 1);
        f.manager.handleKeydown(key('ArrowRight'));
        assert.ok(f.output(formula).classList.contains('is-selected'));
        assert.equal(f.manager.handleKeydown(key(exitKey)), true);
        assert.ok(exitKey === 'ArrowLeft' ? f.caretAt(before, 1) : f.caretAt(after, 0));
        assert.ok(!f.output(formula).classList.contains('is-selected'));
    }
    assert.equal(f.changes, 0);
});

for (const html of [
    `<p>${formulaHtml('x')}</p>`,
    `<p>a<strong>${formulaHtml('x')}</strong>b</p>`,
    `<p>a\u200B${formulaHtml('x')}\u200B</p>`,
    `<ul><li>${formulaHtml('x')}</li></ul>`,
    `<table><tr><td>${formulaHtml('x')}</td></tr></table>`,
]) {
    test(`formula selection works at boundaries and inside formatting: ${html}`, async () => {
        const f = await fixture(html);
        const formula = f.formula();
        for (const [atStart, direction] of [[true, 'forward'], [false, 'backward']]) {
            f.manager.placeCaretBeside(formula, atStart);
            assert.equal(f.manager.moveAcrossFormula(f.window.getSelection(), direction), true);
            assert.ok(f.manager.getSelectedFormula(f.range) === formula);
            assert.equal(f.manager.normalizeCaret(), false, 'normalization keeps the whole-formula selection');
        }
    });
}

test('adjacent formulas are selected individually', async () => {
    const f = await fixture(`<p>${formulaHtml('a')}${formulaHtml('b')}</p>`);
    const [first, second] = Array.from(f.editor.querySelector('p').children);
    f.manager.placeCaretBeside(first, true);
    for (const formula of [first, second]) {
        assert.equal(f.manager.handleKeydown(key('ArrowRight')), true);
        assert.ok(f.manager.getSelectedFormula(f.range) === formula);
        assert.equal(f.manager.handleKeydown(key('ArrowRight')), true);
        assert.equal(f.range.collapsed, true);
    }
});

test('selection highlighting follows native selection and clears when focus leaves the editor', async () => {
    const f = await fixture(`<p>a${formulaHtml('x')}b</p>`);
    f.manager.setup();
    f.editor.focus();
    const paragraph = f.editor.querySelector('p');
    f.select(paragraph, 1, paragraph, 2);
    const change = () => {
        const event = f.document.createEvent('Event');
        event.initEvent('selectionchange', false, false);
        f.document.dispatchEvent(event);
    };
    change();
    assert.ok(f.output(f.formula()).classList.contains('is-selected'));
    f.select(paragraph.firstChild, 0);
    change();
    assert.ok(!f.output(f.formula()).classList.contains('is-selected'));
    f.select(paragraph, 1, paragraph, 2);
    change();
    f.document.activeElement = f.document.body;
    const blur = f.document.createEvent('Event');
    blur.initEvent('focusout', true, false);
    f.editor.dispatchEvent(blur);
    assert.ok(!f.output(f.formula()).classList.contains('is-selected'));
});

test('Shift navigation and selections containing other text retain native behavior', async () => {
    const f = await fixture(`<p>a${formulaHtml('x')}b</p>`);
    const paragraph = f.editor.querySelector('p');
    f.select(paragraph.firstChild, 1);
    assert.equal(f.manager.handleKeydown(key('ArrowRight', { shiftKey: true })), false);
    f.select(paragraph, 0, paragraph, 2);
    assert.equal(f.manager.handleKeydown(key('ArrowRight')), false);
    assert.equal(f.manager.handleKeydown(key('Enter')), false);
    assert.equal(f.manager.popover, null);
});

for (const deletion of ['Backspace', 'Delete']) {
    test(`${deletion} removes a keyboard-selected formula in one history step`, async () => {
        const f = await fixture(`<p>a${formulaHtml('x')}b</p>`);
        f.select(f.editor.querySelector('p').firstChild, 1);
        f.manager.handleKeydown(key('ArrowRight'));
        assert.equal(f.manager.handleKeydown(key(deletion)), true);
        assert.equal(f.editor.innerHTML, '<p>ab</p>');
        assert.deepEqual(f.history, ['save', 'commit']);
    });
}

test('clicking an existing formula reopens the last committed TeX', async () => {
    const f = await fixture(`<p>${formulaHtml('x')}</p>`);
    f.manager.setup();
    f.formula().click();
    assert.equal(f.input().value, 'x');
    f.input().value = 'y';
    f.manager.handleInput();
    f.manager.handleInputKeydown(key('Enter'));
    f.formula().click();
    assert.equal(f.manager.popover.hidden, false);
    assert.equal(f.input().value, 'y');
});

async function pointerFixture(html) {
    const f = await fixture(html);
    f.manager.setup();
    const formula = f.formula();
    Object.defineProperty(formula, 'getBoundingClientRect', {
        value: () => ({ left: 10, right: 70, top: 45, bottom: 62, width: 60, height: 17 }),
    });
    Object.defineProperty(f.output(formula), 'getBoundingClientRect', {
        value: () => ({ left: 10, right: 70, top: 40, bottom: 75, width: 60, height: 35 }),
    });
    f.pointer = (type, target, x, y, modifiers = {}) => {
        const event = f.document.createEvent('Event');
        event.initEvent(type, true, true);
        Object.assign(event, {
            button: 0, detail: 1, clientX: x, clientY: y,
            shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers,
        });
        target.dispatchEvent(event);
        return event;
    };
    return f;
}

test('clicking the rendered right edge places the caret after the formula, including its superscript height', async () => {
    const f = await pointerFixture(`<p>A ${formulaHtml('x^2')} after</p>`);
    const formula = f.formula();
    const original = f.editor.innerHTML;
    for (const [target, x, y] of [[formula, 68, 41], [formula, 69, 74], [formula.parentNode, 74, 55]]) {
        f.select(formula.previousSibling, 0);
        f.pointer('mousedown', target, x, y);
        const click = f.pointer('click', target, x, y);
        assert.equal(click.defaultPrevented, true);
        assert.ok(f.caretAt(formula.nextSibling, 0));
        assert.equal(f.manager.popover, null);
    }
    assert.equal(f.editor.innerHTML, original);
    assert.deepEqual(f.history, []);
    assert.equal(f.changes, 0);
});

for (const usePositionAPI of [false, true]) {
    test(`clicking trailing space after a formula corrects a native caret before it (${usePositionAPI ? 'position' : 'range'} API)`, async () => {
        const f = await pointerFixture(`<p><strong>${formulaHtml('x^2')}</strong></p>`);
        const formula = f.formula();
        f.select(formula.parentNode, 0);
        const nativeRange = f.range.cloneRange();
        if (usePositionAPI) f.document.caretPositionFromPoint = () => ({ offsetNode: nativeRange.startContainer, offset: 0 });
        else f.document.caretRangeFromPoint = () => nativeRange;
        const target = f.editor.querySelector('p');
        f.pointer('mousedown', target, 150, 55);
        f.pointer('click', target, 150, 55);
        assert.ok(f.caretAt(formula.parentNode, 1));
        assert.equal(f.manager.popover, null);
    });
}

test('later text and another visual line keep their native click positions', async () => {
    const f = await pointerFixture(`<p>${formulaHtml('x')} after<br>next line</p>`);
    const paragraph = f.editor.querySelector('p');
    const after = f.formula().nextSibling;
    f.select(after, 3);
    f.document.caretRangeFromPoint = () => f.range.cloneRange();
    for (const [x, y] of [[95, 55], [74, 95]]) {
        f.pointer('mousedown', paragraph, x, y);
        const click = f.pointer('click', paragraph, x, y);
        assert.equal(click.defaultPrevented, false);
        assert.ok(f.caretAt(after, 3));
    }
});

test('modified clicks, double clicks and drags beside a formula keep their selections', async () => {
    const f = await pointerFixture(`<p>A ${formulaHtml('x')} after</p>`);
    const paragraph = f.editor.querySelector('p');
    const before = paragraph.firstChild;
    const after = paragraph.lastChild;
    for (const modifiers of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { detail: 2 }, { button: 2 }]) {
        f.select(before, 1, after, 3);
        f.pointer('mousedown', paragraph, 74, 55, modifiers);
        const click = f.pointer('click', paragraph, 74, 55, modifiers);
        assert.equal(click.defaultPrevented, false);
        assert.equal(f.range.collapsed, false);
    }
    f.pointer('mousedown', paragraph, 74, 55);
    f.pointer('mousemove', paragraph, 100, 55);
    f.pointer('mousemove', paragraph, 74, 55);
    f.select(before, 1, after, 3);
    assert.equal(f.pointer('click', paragraph, 74, 55).defaultPrevented, false);
    assert.equal(f.range.collapsed, false);
});

test('a click between adjacent formulas places the caret between them, while their bodies still open TeX editing', async () => {
    const f = await pointerFixture(`<p>${formulaHtml('a')}${formulaHtml('b')}</p>`);
    const paragraph = f.editor.querySelector('p');
    const second = paragraph.lastChild;
    f.pointer('mousedown', second, 72, 55);
    f.pointer('click', second, 72, 55);
    assert.ok(f.caretAt(paragraph, 1));
    assert.equal(f.manager.popover, null);
    f.pointer('mousedown', f.formula(), 40, 55);
    f.pointer('click', f.formula(), 40, 55);
    assert.equal(f.manager.popover.hidden, false);
    assert.equal(f.input().value, 'a');
});

test('edge clicks do not change a read-only document or reinterpret display math', async () => {
    const f = await pointerFixture(`<p>${formulaHtml('x')} after</p>`);
    f.editor.setAttribute('contenteditable', 'false');
    f.select(f.formula().nextSibling, 2);
    f.pointer('mousedown', f.formula().parentNode, 74, 55);
    assert.equal(f.pointer('click', f.formula().parentNode, 74, 55).defaultPrevented, false);
    assert.ok(f.caretAt(f.formula().nextSibling, 2));
    const display = await pointerFixture(`<p>${formulaHtml('x', 'display')}</p>`);
    display.pointer('mousedown', display.formula(), 68, 55);
    display.pointer('click', display.formula(), 68, 55);
    assert.equal(display.manager.popover.hidden, false);
});

test('formulas and "$$" blocks survive the clipboard sanitizer', async () => {
    const f = await fixture('');
    const functionNames = ['hasExplicitScheme', 'isLikelyAbsoluteFsPath', 'isInternalWebviewCdnUrl', 'isWebviewResourceUrl',
        'sanitizeLinkHref', 'classifyImageSourceForEditor', 'applyImageSourcePolicy', 'unwrapElement',
        'sanitizeFragmentForEditor', 'createSanitizedContainerFromHtml'];
    const functions = functionNames.map(name => {
        const start = editorSource.indexOf(`    function ${name}(`);
        assert.notEqual(start, -1);
        const end = editorSource.indexOf('\n    }\n', start);
        return editorSource.slice(start, end + '\n    }'.length);
    });
    const constantsStart = editorSource.indexOf('    const SAFE_EDITOR_TAGS');
    const constantsEnd = editorSource.indexOf('    function isLikelyAbsoluteFsPath', constantsStart);
    const sanitize = new Function('document', 'Node', 'window', `
        const settingsState = { allowRemoteImages: false };
        const remoteImagesPermittedByCsp = false;
        const BLOCKED_REMOTE_IMAGE_PLACEHOLDER_DATA_URL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        const requestImageSrcResolution = () => {};
        ${editorSource.slice(constantsStart, constantsEnd)}
        ${functions.join('\n')}
        return createSanitizedContainerFromHtml;
    `)(f.document, f.window.Node, f.window);
    const html = `<p>A ${formulaHtml('x&lt;y')}</p>` +
        '<pre><code class="language-math" data-mdw-math-delimiter="$$">a\n</code></pre>';
    assert.doesNotMatch(sanitize(html, { allowLocalImageResolution: false }).innerHTML, /mdw-math/);
    const prepared = f.manager.prepareClipboardImport(html);
    const container = sanitize(prepared.html, { allowLocalImageResolution: false });
    f.manager.restoreClipboardImport(container, prepared);
    assert.equal(container.innerHTML, html);
});

async function codeBlockFixture(t, html) {
    const [, { CodeBlockManager }, { DOMUtils }] = await modules;
    const window = domino.createWindow(`<div id="editor" contenteditable="true">${html}</div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    const nodeListPrototype = Object.getPrototypeOf(editor.querySelectorAll('pre'));
    const previousForEach = nodeListPrototype.forEach;
    nodeListPrototype.forEach = Array.prototype.forEach;
    const FakeRange = createRangeClass();
    document.createRange = () => new FakeRange();
    let range = null;
    window.getSelection = () => ({
        get rangeCount() { return range ? 1 : 0; },
        getRangeAt: () => range,
        removeAllRanges: () => { range = null; },
        addRange: (next) => { range = next; },
    });
    editor.focus = () => {};
    const originals = new Map();
    for (const [name, value] of Object.entries({
        window, document, Node: window.Node, navigator: { platform: 'MacIntel' },
        Prism: { languages: {}, highlightElement() {} }, CustomEvent: window.CustomEvent,
    })) {
        originals.set(name, Object.getOwnPropertyDescriptor(global, name));
        Object.defineProperty(global, name, { configurable: true, writable: true, value });
    }
    t.after(() => {
        if (previousForEach === undefined) delete nodeListPrototype.forEach;
        else nodeListPrototype.forEach = previousForEach;
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(global, name, descriptor);
            else delete global[name];
        }
    });
    const renders = [];
    const manager = new CodeBlockManager(editor);
    manager.setMathRenderer({ render: (target, tex, displayMode) => {
        renders.push({ target, tex, displayMode });
        return true;
    } });
    manager.highlightCodeBlocks();
    const click = (element) => {
        const event = document.createEvent('Event');
        event.initEvent('click', true, true);
        element.dispatchEvent(event);
    };
    return {
        editor, manager, renders, click, domUtils: new DOMUtils(editor),
        pre: editor.querySelector('pre'),
        get range() { return range; },
    };
}

test('math blocks show the formula with a TeX and Preview toggle', async t => {
    const html = '<pre><code class="language-math" data-mdw-math-delimiter="$$">\\frac{a}{b}\n</code></pre>';
    const f = await codeBlockFixture(t, html);
    assert.equal(f.pre.getAttribute('data-math-view'), 'preview');
    const buttons = Array.from(f.pre.querySelectorAll('.code-block-view-btn'));
    assert.deepEqual(buttons.map(button => [button.textContent, button.getAttribute('aria-pressed')]),
        [['TeX', 'false'], ['Preview', 'true']]);
    const preview = f.pre.querySelector('.math-preview');
    assert.equal(preview.getAttribute('data-exclude-from-markdown'), 'true');
    const render = f.renders.at(-1);
    assert.ok(render.target === preview);
    assert.deepEqual([render.tex, render.displayMode], ['\\frac{a}{b}\n', true]);
    // Display state and the rendered formula are not document content.
    assert.equal(f.domUtils.getCleanedHTML(), html);
});

test('empty math blocks load with the TeX input visible without changing their source or focus', async t => {
    for (const tex of ['', '\n', ' \t\n\u200B\u2060\uFEFF']) {
        await t.test(JSON.stringify(tex), async t => {
            const html = `<pre><code class="language-math" data-mdw-math-delimiter="$$">${tex}</code></pre>`;
            const f = await codeBlockFixture(t, html);
            assert.equal(f.pre.getAttribute('data-math-view'), 'code');
            const buttons = Array.from(f.pre.querySelectorAll('.code-block-view-btn'));
            assert.deepEqual(buttons.map(button => [button.textContent, button.getAttribute('aria-pressed')]),
                [['TeX', 'true'], ['Preview', 'false']]);
            assert.equal(f.range, null, 'loading must not steal the caret');
            assert.equal(f.pre.querySelector('code').textContent, tex);
            assert.equal(f.domUtils.getCleanedHTML(), html);

            f.click(buttons[0]);
            assert.ok(f.pre.querySelector('code').contains(f.range.startContainer));
            assert.equal(f.range.collapsed, true);
        });
    }
});

test('math input stays open after typing and an explicit Preview choice survives control rebuilding', async t => {
    const f = await codeBlockFixture(t, '<pre><code class="language-math">\n</code></pre>');
    assert.equal(f.pre.getAttribute('data-math-view'), 'code');
    f.pre.querySelector('code').textContent = 'x^2\n';
    f.manager.highlightCodeBlocks();
    assert.equal(f.pre.getAttribute('data-math-view'), 'code');

    f.pre.querySelector('code').textContent = '\n';
    f.click(f.pre.querySelector('.code-block-view-btn[data-math-view="preview"]'));
    f.manager.highlightCodeBlocks();
    assert.equal(f.pre.getAttribute('data-math-view'), 'preview');
    assert.equal(f.pre.querySelector('.code-block-view-btn[data-math-view="preview"]').getAttribute('aria-pressed'), 'true');
});

test('opening a math block source shows the TeX with the caret at its end', async t => {
    const f = await codeBlockFixture(t, '<pre><code class="language-math">x^2\n</code></pre>');
    f.click(f.pre.querySelector('.math-preview'));
    assert.equal(f.pre.getAttribute('data-math-view'), 'code');
    const code = f.pre.querySelector('code');
    assert.ok(code.contains(f.range.startContainer));
    assert.equal(f.range.collapsed, true);
    f.click(f.pre.querySelector('.code-block-view-btn[data-math-view="preview"]'));
    assert.equal(f.pre.getAttribute('data-math-view'), 'preview');
    assert.equal(f.range, null, 'a hidden source keeps no caret');
});

test('changing the language to and from math updates the preview', async t => {
    const f = await codeBlockFixture(t, '<pre><code>x</code></pre>');
    assert.ok(!f.pre.querySelector('.math-preview'));
    f.manager.updateCodeBlockLanguage(f.pre, 'math');
    assert.equal(f.pre.getAttribute('data-math-view'), 'code');
    assert.ok(f.pre.querySelector('.math-preview'));
    f.manager.updateCodeBlockLanguage(f.pre, 'plaintext');
    assert.equal(f.pre.hasAttribute('data-math-view'), false);
    assert.ok(!f.pre.querySelector('.math-preview'));
    assert.ok(!f.pre.querySelector('.code-block-view-toggle'));
});
