const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

function importModule(name) {
    const source = fs.readFileSync(path.join(__dirname, '../media/modules', name), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const managerModule = importModule('CalloutManager.js');
const domUtilsModule = importModule('DOMUtils.js');

class TestRange {
    constructor() { this.collapsed = true; }
    setStart(node, offset) {
        this.startContainer = node; this.startOffset = offset;
        if (this.collapsed) { this.endContainer = node; this.endOffset = offset; }
    }
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
}

async function fixture(html, options = {}) {
    const { CalloutManager } = await managerModule;
    const window = domino.createWindow(`<div id="editor" contenteditable="true">${html}</div>`);
    const document = window.document, editor = document.getElementById('editor');
    window.btoa = btoa;
    window.TextEncoder = TextEncoder;
    let range = null;
    const selection = {
        get rangeCount() { return range ? 1 : 0; }, getRangeAt: () => range,
        removeAllRanges() { range = null; }, addRange(value) { range = value; }
    };
    window.getSelection = () => selection;
    document.createRange = () => new TestRange();
    const before = [], after = [];
    const manager = new CalloutManager(editor, {
        beforeChange: () => before.push(editor.innerHTML),
        onChange: () => after.push(editor.innerHTML), ...options
    });
    return { window, document, editor, manager, before, after, range: () => range,
        caret(node, offset = node.nodeType === 3 ? node.length : node.childNodes.length) {
            range = new TestRange(); range.setStart(node, offset);
        }
    };
}

const key = (name, options = {}) => ({ key: name, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, ...options });
const input = (type, data = null, options = {}) => ({ inputType: type, data, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, ...options });
const decode = (node, name) => Buffer.from(node.getAttribute(`data-mdw-callout-${name}`), 'base64').toString('utf8');

test('quote declaration confirms on Enter and preserves a custom title, fold sign and editable body nodes', async () => {
    const f = await fixture('<p>Before</p><blockquote><p>[!warning]- 日本語の警告</p><p><strong>Body</strong></p></blockquote><p>After</p>');
    const body = f.editor.querySelector('strong');
    f.caret(f.editor.querySelector('blockquote p').firstChild);
    const event = key('Enter');
    assert.equal(f.manager.handleKeydown(event), true);
    assert.equal(event.defaultPrevented, true);
    const block = f.editor.querySelector('[data-mdw-callout]');
    assert.equal(decode(block, 'header'), '> [!warning]- 日本語の警告');
    assert.equal(block.getAttribute('data-mdw-callout-variant'), 'warning');
    assert.equal(block.querySelector('.mdw-callout-title').textContent, '日本語の警告');
    assert.equal(block.querySelector('strong'), body);
    assert.equal(f.range().startContainer, body.parentElement);
    assert.equal(f.editor.firstElementChild.textContent, 'Before');
    assert.equal(f.editor.lastElementChild.textContent, 'After');
    assert.equal(f.before.length, 1); assert.equal(f.after.length, 1);
});

test('plain quote text can become a callout when a native insertParagraph confirms it', async () => {
    const f = await fixture('<p>&gt; [!NOTE]</p>');
    f.caret(f.editor.querySelector('p').firstChild);
    const event = input('insertParagraph');
    assert.equal(f.manager.handleBeforeInput(event), true);
    assert.equal(event.defaultPrevented, true);
    assert.ok(f.editor.querySelector('.mdw-callout-content p br'));
});

test('typing a quote declaration leaves room for a custom title until Enter', async () => {
    const f = await fixture('<blockquote><p>[!NOTE]</p></blockquote>');
    f.caret(f.editor.querySelector('p').firstChild);
    assert.equal(f.manager.handleInput(input('insertText', ']')), false);
    assert.equal(f.editor.querySelectorAll('[data-mdw-callout]').length, 0);
});

test('closed Qiita, Zenn and generic containers share variants and retain source labels and headers', async () => {
    for (const [header, variant, label] of [
        [':::note info', 'note', 'info'], [':::note warn', 'warning', 'warn'],
        [':::note alert', 'caution', 'alert'], [':::message alert', 'caution', 'alert'],
        [':::message', 'note', 'message'], [':::warning Custom title', 'warning', 'Custom title'], ['::: tip', 'tip', 'tip'],
    ]) {
        const f = await fixture(`<p>${header}</p><p><em>Body</em></p><p>:::</p>`);
        const body = f.editor.querySelector('em');
        f.caret(f.editor.lastElementChild.firstChild);
        assert.equal(f.manager.handleInput(input('insertText', ':')), true, header);
        const block = f.editor.querySelector('[data-mdw-callout]');
        assert.equal(decode(block, 'header'), header);
        assert.equal(decode(block, 'footer'), ':::');
        assert.equal(block.getAttribute('data-mdw-callout-variant'), variant);
        assert.equal(block.querySelector('.mdw-callout-title').textContent, label);
        assert.equal(block.querySelector('em'), body);
        assert.equal(block.hasAttribute('data-mdw-callout-source'), false);
        assert.equal(f.range().startContainer, body.parentElement);
        assert.equal(f.range().startOffset, body.parentElement.childNodes.length);
    }
});

test('container wrapping keeps paragraphs, lists and code editable without touching their DOM', async () => {
    const f = await fixture('<p>Before</p><p>::::info</p><p>One</p><p><a href="https://example.test">Two</a></p><ul><li>Item</li></ul><pre><code>:::</code></pre><p>::::</p><p>After</p>');
    const list = f.editor.querySelector('ul'), code = f.editor.querySelector('code'), link = f.editor.querySelector('a');
    f.caret(f.editor.children[6].firstChild);
    assert.equal(f.manager.convertContainer(), true);
    const content = f.editor.querySelector('.mdw-callout-content');
    assert.equal(content.querySelector('ul'), list); assert.equal(content.querySelector('code'), code);
    assert.equal(content.querySelector('a'), link);
    assert.equal(content.children.length, 4);
    assert.equal(f.editor.lastElementChild.textContent, 'After');
});

test('unknown, incomplete, nested ambiguous and literal-code declarations do not become callouts', async () => {
    const examples = [
        '<p>:::unknown</p><p>Body</p><p>:::</p>',
        '<p>:::warning</p><p>Body</p>',
        '<p>::::note</p><p>:::unknown</p><p>Body</p><p>::::</p>',
        '<p>::::warning</p><p>Body</p><p>:::</p>',
        '<pre><code>:::warning\nBody\n:::</code></pre>',
        '<p><code>:::warning\nBody\n:::</code></p>',
        '<blockquote><p>[!unknown]</p></blockquote>',
        '<blockquote><p>[!constructor]</p></blockquote>',
        '<p>!!! constructor</p><p>    Body</p>',
        '<blockquote><p>[!WARNING</p></blockquote>'
    ];
    for (const html of examples) {
        const f = await fixture(html);
        const last = f.editor.querySelector('code') || f.editor.querySelector('blockquote p') || f.editor.lastElementChild;
        f.caret(last.firstChild);
        const original = f.editor.innerHTML;
        assert.equal(f.manager.handleKeydown(key('Enter')), false, html);
        assert.equal(f.manager.handleInput(input('insertText', ':')), false, html);
        assert.equal(f.editor.innerHTML, original);
    }
});

test('IME input and noncollapsed selections never trigger live conversion', async () => {
    const f = await fixture('<p>:::note warn</p><p>Body</p><p>:::</p>');
    f.caret(f.editor.lastElementChild.firstChild);
    assert.equal(f.manager.handleInput(input('insertText', ':', { isComposing: true })), false);
    assert.equal(f.manager.handleKeydown(key('Enter', { keyCode: 229 })), false);
    f.range().collapsed = false;
    assert.equal(f.manager.handleInput(input('insertText', ':')), false);
    f.range().collapsed = true;
    f.manager.isComposing = () => true;
    assert.equal(f.manager.handleKeydown(key('Enter')), false);
    assert.equal(f.editor.querySelectorAll('[data-mdw-callout]').length, 0);
});

test('MkDocs recognizes only an indented body and retains custom-title/folding declarations', async () => {
    const f = await fixture('<p>Before</p><p>???+ warning "注意"</p><p>    A <strong>bold</strong></p><p>    B</p><p>After</p>');
    const strong = f.editor.querySelector('strong');
    f.caret(f.editor.children[3].firstChild);
    assert.equal(f.manager.handleKeydown(key('Enter')), true);
    const block = f.editor.querySelector('[data-mdw-callout]');
    assert.equal(decode(block, 'header'), '???+ warning "注意"');
    assert.equal(block.getAttribute('data-mdw-callout-format'), 'mkdocs');
    assert.equal(block.querySelector('strong'), strong);
    assert.equal(block.querySelector('.mdw-callout-content p').textContent, 'A bold');
    assert.equal(f.range().startContainer, block.querySelector('.mdw-callout-content').lastElementChild);
    assert.equal(f.editor.lastElementChild.textContent, 'After');
    const invalid = await fixture('<p>!!! warning</p><p>Body</p>');
    invalid.caret(invalid.editor.lastElementChild.firstChild);
    assert.equal(invalid.manager.convertMkdocs(), false);
});

test('Backspace and Delete at body boundaries retain the callout and surrounding paragraphs', async () => {
    const f = await fixture('<p>Before</p><div data-mdw-callout="true"><div class="mdw-callout-title" contenteditable="false">Note</div><div class="mdw-callout-content"><p>Body</p></div></div><p>After</p>');
    const body = f.editor.querySelector('.mdw-callout-content p').firstChild, original = f.editor.innerHTML;
    f.caret(body, 0);
    const backspace = key('Backspace');
    assert.equal(f.manager.handleKeydown(backspace), true); assert.equal(backspace.defaultPrevented, true);
    f.caret(body, body.length);
    const deletion = input('deleteContentForward');
    assert.equal(f.manager.handleBeforeInput(deletion), true); assert.equal(deletion.defaultPrevented, true);
    f.caret(body, 2);
    assert.equal(f.manager.handleKeydown(key('Backspace')), false);
    assert.equal(f.editor.innerHTML, original);
});

test('Enter on the last empty body paragraph exits without removing an empty callout', async () => {
    const f = await fixture('<div data-mdw-callout="true"><div class="mdw-callout-title" contenteditable="false">Note</div><div class="mdw-callout-content"><p><br></p></div></div><p>After</p>');
    const block = f.editor.firstElementChild;
    f.caret(block.querySelector('p'), 0);
    assert.equal(f.manager.handleKeydown(key('Enter')), true);
    assert.equal(f.editor.firstElementChild, block);
    assert.ok(block.querySelector('.mdw-callout-content p br'));
    assert.equal(f.range().startContainer, block.nextElementSibling);
    assert.equal(f.editor.lastElementChild.textContent, 'After');
});

test('callout bodies form an editing root and cannot reach an enclosing quote', async () => {
    const { DOMUtils } = await domUtilsModule;
    const f = await fixture('<blockquote><div data-mdw-callout="true"><div class="mdw-callout-content"><p>Body</p><ul><li>Item</li></ul></div></div></blockquote>');
    const utils = new DOMUtils(f.editor), body = f.editor.querySelector('p').firstChild;
    assert.equal(utils.getEditingRoot(body), f.editor.querySelector('.mdw-callout-content'));
    assert.equal(utils.getParentElement(body, 'BLOCKQUOTE'), null);
    assert.equal(utils.getParentElement(f.editor.querySelector('li').firstChild, 'UL'), f.editor.querySelector('ul'));
});

test('local rich clipboard import survives metadata stripping and retains nested callouts safely', async () => {
    const f = await fixture('');
    const outer = f.manager.createBlock({ header: ':::note warn', footer: ':::', format: 'container', type: 'warn', variant: 'warning', title: '<img src=x>' });
    const inner = f.manager.createBlock({ header: '> [!TIP]', footer: '', format: 'quote', type: 'TIP', variant: 'tip', title: 'Tip' });
    inner.lastElementChild.innerHTML = '<p><strong>Body</strong></p>';
    outer.lastElementChild.appendChild(inner);
    const prepared = f.manager.prepareClipboardImport(outer.outerHTML, true);
    const container = f.document.createElement('div'); container.innerHTML = prepared.html;
    container.querySelectorAll('*').forEach(node => {
        node.removeAttribute('class');
        Array.from(node.attributes).filter(attr => attr.name.startsWith('data-')).forEach(attr => node.removeAttribute(attr.name));
    });
    f.manager.restoreClipboardImport(container, prepared);
    const restored = container.querySelector('[data-mdw-callout]');
    assert.equal(decode(restored, 'header'), ':::note warn');
    assert.equal(restored.querySelectorAll('[data-mdw-callout]').length, 1);
    assert.equal(restored.querySelector('.mdw-callout-title').textContent, '<img src=x>');
    assert.equal(restored.querySelectorAll('img').length, 0);
    assert.equal(restored.querySelector('strong').textContent, 'Body');
    assert.equal(f.manager.prepareClipboardImport(outer.outerHTML, false).blocks.length, 0);
});

test('Undo and Redo restore callout metadata and edited rich content with the normal history manager', async () => {
    const { StateManager } = await importModule('StateManager.js');
    const f = await fixture('<p>:::note warn</p><p><strong>Body</strong></p><p>:::</p>');
    const history = new StateManager(f.editor, {});
    history.saveSelection = () => null;
    history.restoreSelection = () => true;
    history.finishHistoryRestore = () => history.rebaseCurrentHistoryStateComparable();
    f.manager.beforeChange = () => history.saveState();
    f.manager.onChange = () => history.commitStateAfterChange();
    const literal = f.editor.innerHTML;
    history.seedState();
    f.caret(f.editor.lastElementChild.firstChild);
    assert.equal(f.manager.convertContainer(), true);
    const converted = f.editor.innerHTML;
    history.saveState();
    f.editor.querySelector('strong').textContent = 'Edited';
    history.commitStateAfterChange();
    const edited = f.editor.innerHTML;
    assert.equal(history.performUndo(), true);
    assert.equal(f.editor.innerHTML, converted);
    assert.equal(history.performUndo(), true);
    assert.equal(f.editor.innerHTML, literal);
    assert.equal(history.performRedo(), true);
    assert.equal(f.editor.innerHTML, converted);
    assert.equal(history.performRedo(), true);
    assert.equal(f.editor.innerHTML, edited);
    assert.equal(decode(f.editor.querySelector('[data-mdw-callout]'), 'header'), ':::note warn');
});
