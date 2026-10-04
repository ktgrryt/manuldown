const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const source = fs.readFileSync(path.join(__dirname, '..', 'media/modules/FootnoteManager.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media/editor.js'), 'utf8');
const ref = key => `<sup data-mdw-footnote-ref="${key}" contenteditable="false"><a>?</a></sup>`;
const note = key => `<div data-mdw-footnote-definition="${key}"><div class="mdw-footnote-content"><p>Note ${key}</p></div></div>`;

function importClipboard(f, html, trusted = false) {
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
        const requestImageSrcResolution = () => { throw new Error('Clipboard must not resolve local images'); };
        ${editorSource.slice(constantsStart, constantsEnd)}
        ${functions.join('\n')}
        return createSanitizedContainerFromHtml;
    `)(f.window.document, f.window.Node, f.window);
    const prepared = f.manager.prepareClipboardImport(html);
    const container = sanitize(prepared.html, { allowLocalImageResolution: false });
    const definitions = f.manager.restoreClipboardImport(container, prepared, trusted);
    return { container, definitions };
}

async function fixture(html) {
    const { FootnoteManager } = await modulePromise;
    const window = domino.createWindow(`<div id="editor" contenteditable="true">${html}</div>`);
    const editor = window.document.getElementById('editor');
    editor.focus = () => {};
    let currentRange = null;
    window.getSelection = () => ({
        rangeCount: currentRange ? 1 : 0,
        getRangeAt: () => currentRange,
        removeAllRanges: () => { currentRange = null; },
        addRange: range => { currentRange = range; }
    });
    window.document.createRange = () => ({
        selectNodeContents: function (node) {
            this.startContainer = this.endContainer = node;
            this.startOffset = 0;
            this.endOffset = node.childNodes.length;
        },
        setStartAfter: function (node) {
            this.startContainer = this.endContainer = node.parentNode;
            this.startOffset = this.endOffset = Array.from(node.parentNode.childNodes).indexOf(node) + 1;
        },
        setStartBefore: function (node) {
            this.startContainer = this.endContainer = node.parentNode;
            this.startOffset = this.endOffset = Array.from(node.parentNode.childNodes).indexOf(node);
        },
        setStart: function (node, offset) { this.startContainer = node; this.startOffset = offset; },
        setEnd: function (node, offset) {
            this.endContainer = node;
            this.endOffset = offset;
            this.collapsed = this.startContainer === node && this.startOffset === offset;
        },
        collapse: function () {
            this.collapsed = true;
            this.endContainer = this.startContainer;
            this.endOffset = this.startOffset;
        }
    });
    const history = [];
    let changes = 0;
    const manager = new FootnoteManager(editor, {
        saveState: () => history.push(editor.innerHTML),
        commitStateAfterChange: () => history.push(editor.innerHTML)
    }, { onChange: () => { changes++; } });
    const select = (node, endOffset = 0, startOffset = endOffset) => {
        currentRange = {
            startContainer: node, endContainer: node,
            startOffset, endOffset, collapsed: startOffset === endOffset,
            cloneRange: () => ({
                collapse: atStart => assert.equal(atStart, false),
                insertNode: element => {
                    const tail = node.splitText(endOffset);
                    node.parentNode.insertBefore(element, tail);
                }
            })
        };
    };
    return { manager, editor, window, history, select, changes: () => changes };
}

test('footnotes use reference order, share repeated numbers and update after deletion', async () => {
    const { manager, editor } = await fixture(`<p>${ref('b')}${ref('a')}${ref('b')}</p>${note('a')}${note('b')}${note('unused')}`);
    manager.refresh();
    assert.deepEqual(Array.from(editor.querySelectorAll('sup a')).map(node => node.textContent), ['1', '2', '1']);
    assert.deepEqual(Array.from(editor.querySelectorAll('.mdw-footnote-backref')).map(node => node.textContent), ['1 ↩', '2 ↩', '[unused] ↩']);
    assert.deepEqual(Array.from(editor.querySelectorAll('[data-mdw-footnote-definition]'))
        .map(node => node.getAttribute('data-mdw-footnote-definition')), ['b', 'a', 'unused']);
    const references = editor.querySelectorAll('sup');
    references[0].remove();
    manager.refresh();
    assert.deepEqual(Array.from(editor.querySelectorAll('sup a')).map(node => node.textContent), ['1', '2']);
    assert.equal(editor.querySelectorAll('[data-mdw-footnote-definition]').length, 3);
    assert.deepEqual(Array.from(editor.querySelectorAll('[data-mdw-footnote-definition]'))
        .map(node => node.getAttribute('data-mdw-footnote-definition')), ['a', 'b', 'unused']);
});

test('arrows and Mac Ctrl+B/Ctrl+F step across each reference as one atomic position', async () => {
    const f = await fixture(`<p>Before${ref('a')}${ref('b')}After</p>${note('a')}${note('b')}`);
    f.manager.refresh();
    const [first, second] = Array.from(f.editor.querySelectorAll('sup'));
    const before = first.previousSibling;
    const after = second.nextSibling;
    const original = f.editor.innerHTML;
    for (const keys of [{ key: 'ArrowRight' }, { key: 'f', ctrlKey: true }]) {
        f.select(before, before.textContent.length);
        const event = { ...keys, preventDefault() {}, stopPropagation() {} };
        assert.equal(f.manager.handleKeydown(event, true), true);
        assert.equal(f.manager.getRange().startContainer, first.parentNode);
        assert.equal(f.manager.getRange().startOffset, 2);
        assert.equal(f.manager.handleKeydown(event, true), true);
        assert.equal(f.manager.getRange().startContainer, after);
        assert.equal(f.manager.getRange().startOffset, 0);
    }
    for (const keys of [{ key: 'ArrowLeft' }, { key: 'b', ctrlKey: true }]) {
        f.select(after, 0);
        const event = { ...keys, preventDefault() {}, stopPropagation() {} };
        assert.equal(f.manager.handleKeydown(event, true), true);
        assert.equal(f.manager.getRange().startContainer, second.parentNode);
        assert.equal(f.manager.getRange().startOffset, 2);
        assert.equal(f.manager.handleKeydown(event, true), true);
        assert.equal(f.manager.getRange().startContainer, before);
        assert.equal(f.manager.getRange().startOffset, before.textContent.length);
    }
    assert.equal(f.editor.innerHTML, original);
    assert.equal(f.history.length, 0);
    assert.equal(f.changes(), 0);
});

test('reference navigation preserves text selections, modified keys and active composition', async () => {
    const f = await fixture(`<p>Before${ref('a')}After</p>${note('a')}`);
    const reference = f.editor.querySelector('sup');
    const before = reference.previousSibling;
    for (const [keys, mac] of [
        [{ key: 'ArrowRight', shiftKey: true }, true],
        [{ key: 'ArrowRight', altKey: true }, true],
        [{ key: 'ArrowRight', metaKey: true }, true],
        [{ key: 'ArrowRight', ctrlKey: true }, true],
        [{ key: 'ArrowRight', isComposing: true }, true],
        [{ key: 'ArrowRight', keyCode: 229 }, true],
        [{ key: 'f', ctrlKey: true }, false],
    ]) {
        f.select(before, before.textContent.length);
        const range = f.manager.getRange();
        assert.equal(f.manager.handleKeydown({ ...keys, preventDefault() {}, stopPropagation() {} }, mac), false);
        assert.equal(f.manager.getRange(), range);
    }
    f.select(before, before.textContent.length, 0);
    const selected = f.manager.getRange();
    assert.equal(f.manager.moveAcrossReference(f.window.getSelection(), 'forward'), false);
    assert.equal(f.manager.getRange(), selected);
    for (const [direction, node, offset] of [
        ['forward', reference.nextSibling, 0], ['backward', before, before.textContent.length],
    ]) {
        f.select(reference.firstChild.firstChild, 1, 0);
        assert.equal(f.manager.moveAcrossReference(f.window.getSelection(), direction), true);
        assert.equal(f.manager.getRange().startContainer, node);
        assert.equal(f.manager.getRange().startOffset, offset);
    }
});

test('a caret inside a reference recovers to its local edge in both body text and note text', async () => {
    for (const nested of [false, true]) {
        const paragraph = `<p>Before${ref('b')}After</p>`;
        const f = await fixture(nested ? `<div data-mdw-footnote-definition="a"><div class="mdw-footnote-content">${paragraph}</div></div>${note('b')}` : paragraph + note('b'));
        const reference = f.editor.querySelector('sup');
        const number = reference.firstChild.firstChild;
        for (const [offset, target, targetOffset] of [
            [0, reference.previousSibling, 6], [1, reference.nextSibling, 0],
        ]) {
            f.select(number, offset);
            assert.equal(f.manager.normalizeCaret(), true);
            assert.equal(f.manager.getRange().startContainer, target);
            assert.equal(f.manager.getRange().startOffset, targetOffset);
        }
        f.select(number, 1, 0);
        const selected = f.manager.getRange();
        assert.equal(f.manager.normalizeCaret(), false);
        assert.equal(f.manager.getRange(), selected);
        assert.equal(f.history.length, 0);
    }
});

test('copying a reference includes its note and local paste keeps the shared annotation', async () => {
    const f = await fixture(`<p>Body${ref('a')}</p>${note('a')}`);
    f.manager.refresh();
    const wrapper = f.window.document.createElement('div');
    wrapper.innerHTML = f.editor.querySelector('p').outerHTML;
    f.manager.appendClipboardDefinitions(wrapper);
    assert.equal(wrapper.querySelectorAll('[data-mdw-footnote-definition]').length, 1);
    assert.doesNotMatch(wrapper.innerHTML, /data-mdw-footnote-backref|data-mdw-footnote-delete/);
    const { container, definitions } = importClipboard(f, wrapper.innerHTML, true);
    assert.equal(definitions.length, 0);
    assert.equal(container.querySelector('sup').getAttribute('data-mdw-footnote-ref'), 'a');
    assert.equal(container.querySelector('sup').getAttribute('contenteditable'), 'false');
    while (container.firstChild) f.editor.appendChild(container.firstChild);
    f.manager.refresh();
    assert.deepEqual(Array.from(f.editor.querySelectorAll('sup a')).map(node => node.textContent), ['1', '1']);
    assert.equal(f.editor.querySelectorAll('[data-mdw-footnote-definition]').length, 1);
});

test('cutting the whole annotated selection can restore the note body from the clipboard', async () => {
    const f = await fixture(`<p>Body${ref('a')}</p>${note('a')}`);
    const wrapper = f.window.document.createElement('div');
    wrapper.innerHTML = f.editor.innerHTML;
    f.manager.appendClipboardDefinitions(wrapper);
    f.editor.innerHTML = '';
    const { container, definitions } = importClipboard(f, wrapper.innerHTML, true);
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].querySelector('.mdw-footnote-content').textContent, 'Note a');
    while (container.firstChild) f.editor.appendChild(container.firstChild);
    definitions.forEach(definition => f.editor.appendChild(definition));
    f.manager.refresh();
    assert.equal(f.editor.querySelector('sup').getAttribute('data-mdw-footnote-ref'), 'a');
    assert.equal(f.editor.querySelector('.mdw-footnote-backref').textContent, '1 ↩');
});

test('cross-editor or forged clipboard notes cannot overwrite existing notes or import active HTML', async () => {
    const f = await fixture(`<p>Body${ref('a')}</p>${note('a')}`);
    const html = `<p>Pasted${ref('a')}</p><div data-mdw-footnote-definition="a" data-mdw-footnote-source="Zm9yZ2Vk">` +
        '<a data-mdw-footnote-delete="a">×</a><div class="mdw-footnote-content"><p onclick="alert(1)">New <strong>note</strong></p>' +
        '<script>alert(1)</script><a href="javascript:alert(1)" data-mdw-footnote-delete="a">Text</a>' +
        '<img src="/secret.png"><img src="https://example.com/image.png" onerror="alert(1)"></div></div>';
    const { container, definitions } = importClipboard(f, html);
    assert.equal(definitions.length, 1);
    const key = definitions[0].getAttribute('data-mdw-footnote-definition');
    assert.notEqual(key, 'a');
    assert.equal(container.querySelector('sup').getAttribute('data-mdw-footnote-ref'), key);
    assert.equal(f.editor.querySelector('.mdw-footnote-content').textContent, 'Note a');
    const body = definitions[0].querySelector('.mdw-footnote-content');
    assert.equal(body.querySelector('strong').textContent, 'note');
    assert.doesNotMatch(body.innerHTML, /<script|onclick|onerror|javascript:|data-mdw-footnote-delete|secret/);
    assert.equal(body.querySelector('img').getAttribute('data-remote-image-blocked'), 'true');
    assert.match(body.querySelector('img').getAttribute('src'), /^data:image/);
    assert.equal(definitions[0].hasAttribute('data-mdw-footnote-source'), false);
});

test('alternate percent encodings cannot bypass clipboard label collision checks', async () => {
    const f = await fixture(`<p>Body${ref('a')}</p>${note('a')}`);
    const { container, definitions } = importClipboard(f, `<p>${ref('%61')}</p>${note('a')}`);
    assert.equal(definitions.length, 1);
    assert.notEqual(definitions[0].getAttribute('data-mdw-footnote-definition'), 'a');
    assert.equal(container.querySelector('sup').getAttribute('data-mdw-footnote-ref'), definitions[0].getAttribute('data-mdw-footnote-definition'));
    assert.equal(f.editor.querySelector('.mdw-footnote-content').textContent, 'Note a');
});

test('clipboard imports preserve references inside notes and include transitive definitions once', async () => {
    const f = await fixture(`<p>Body${ref('a')}</p><div data-mdw-footnote-definition="a"><div class="mdw-footnote-content"><p>A${ref('b')}</p></div></div>${note('b')}`);
    const wrapper = f.window.document.createElement('div');
    wrapper.innerHTML = f.editor.querySelector('p').outerHTML;
    f.manager.appendClipboardDefinitions(wrapper);
    assert.equal(wrapper.querySelectorAll('[data-mdw-footnote-definition]').length, 2);
    f.editor.innerHTML = '';
    const { container, definitions } = importClipboard(f, wrapper.innerHTML);
    assert.equal(definitions.length, 2);
    while (container.firstChild) f.editor.appendChild(container.firstChild);
    definitions.forEach(definition => f.editor.appendChild(definition));
    f.manager.refresh();
    assert.deepEqual(Array.from(f.editor.querySelectorAll('sup a')).map(node => node.textContent), ['1', '2']);
    assert.deepEqual(Array.from(f.editor.querySelectorAll('.mdw-footnote-backref')).map(node => node.textContent), ['1 ↩', '2 ↩']);
});

test('copying only a note creates an independent note and missing references stay missing', async () => {
    const f = await fixture(`<p>Body${ref('a')}</p>${note('a')}`);
    const { container, definitions } = importClipboard(f, f.editor.querySelector('[data-mdw-footnote-definition]').outerHTML, true);
    assert.equal(container.textContent, '');
    assert.equal(definitions.length, 1);
    assert.notEqual(definitions[0].getAttribute('data-mdw-footnote-definition'), 'a');
    const missing = importClipboard(f, `<p>${ref('a')}</p>`);
    assert.equal(missing.definitions.length, 0);
    assert.notEqual(missing.container.querySelector('sup').getAttribute('data-mdw-footnote-ref'), 'a');
});

test('insertion preserves selected text, avoids label collisions and focuses the editable note', async () => {
    const f = await fixture(`<p>Selected text${ref('2')}</p>${note('1')}`);
    const text = f.editor.querySelector('p').firstChild;
    f.select(text, 8);
    assert.equal(f.manager.insert(), true);
    const references = f.editor.querySelectorAll('sup');
    assert.equal(references[0].getAttribute('data-mdw-footnote-ref'), '3');
    assert.equal(f.editor.querySelector('p').textContent, 'Selected1 text2');
    const inserted = f.editor.querySelector('[data-mdw-footnote-definition="3"]');
    assert.equal(inserted.nextElementSibling.getAttribute('data-mdw-footnote-definition'), '1');
    assert.equal(f.manager.getRange().startContainer, inserted.querySelector('p'));
    assert.equal(f.history.length, 2);
    assert.equal(f.changes(), 1);
});

test('insertion is unavailable inside code, links and footnote bodies', async () => {
    const f = await fixture(`<pre><code>Code</code></pre><p><code>inline</code><a href="#x">link</a></p>${note('1')}`);
    for (const selector of ['pre code', 'p code', 'p a', '.mdw-footnote-content p']) {
        f.select(f.editor.querySelector(selector).firstChild);
        assert.equal(f.manager.canInsert(), false, selector);
        assert.equal(f.manager.insert(), false, selector);
    }
    assert.equal(f.changes(), 0);
    assert.equal(f.history.length, 0);
});

test('inserting between existing references orders note rows before saving history', async () => {
    const f = await fixture(`<p>First${ref('a')} gap${ref('b')} end</p>${note('a')}${note('b')}`);
    f.manager.refresh();
    f.select(f.editor.querySelector('sup').nextSibling, 2);
    assert.equal(f.manager.insert(), true);
    const keys = () => Array.from(f.editor.querySelectorAll('[data-mdw-footnote-definition]'))
        .map(node => node.getAttribute('data-mdw-footnote-definition'));
    assert.deepEqual(keys(), ['a', '1', 'b']);
    assert.deepEqual(Array.from(f.editor.querySelectorAll('.mdw-footnote-backref')).map(node => node.textContent), ['1 ↩', '2 ↩', '3 ↩']);
    assert.equal(f.manager.getRange().startContainer, f.editor.querySelector('[data-mdw-footnote-definition="1"] p'));
    f.editor.innerHTML = f.history[0];
    f.manager.refresh();
    assert.deepEqual(keys(), ['a', 'b']);
    f.editor.innerHTML = f.history[1];
    f.manager.refresh();
    assert.deepEqual(keys(), ['a', '1', 'b']);
});

test('reordering notes preserves body blocks, rich note nodes and the active selection', async () => {
    const f = await fixture(`<p>${ref('b')}${ref('a')}</p>${note('a')}<p id="body-after">Following body</p>${note('b')}${note('unused')}`);
    const content = f.editor.querySelector('[data-mdw-footnote-definition="a"] p').firstChild;
    const body = f.editor.querySelector('#body-after');
    const bodyIndex = Array.from(f.editor.childNodes).indexOf(body);
    f.select(content, 5, 2);
    f.manager.refresh();
    assert.equal(f.editor.childNodes[bodyIndex], body);
    assert.equal(f.editor.querySelector('[data-mdw-footnote-definition="a"] p').firstChild, content);
    assert.equal(f.manager.getRange().startContainer, content);
    assert.equal(f.manager.getRange().startOffset, 2);
    assert.equal(f.manager.getRange().endContainer, content);
    assert.equal(f.manager.getRange().endOffset, 5);
    assert.deepEqual(Array.from(f.editor.querySelectorAll('.mdw-footnote-backref')).map(node => node.textContent), ['1 ↩', '2 ↩', '[unused] ↩']);
    const range = f.manager.getRange();
    const html = f.editor.innerHTML;
    f.manager.refresh();
    assert.equal(f.editor.innerHTML, html);
    assert.equal(f.manager.getRange(), range);
    assert.equal(f.changes(), 0);
    assert.equal(f.history.length, 0);
});

test('clicking a repeated reference returns to that specific occurrence', async () => {
    const f = await fixture(`<p>${ref('a')}${ref('a')}</p>${note('a')}`);
    const caretTargets = [];
    f.manager.placeCaret = (node, atStart) => caretTargets.push({ node, atStart });
    f.manager.setup();
    const references = f.editor.querySelectorAll('sup');
    const click = node => {
        const event = f.window.document.createEvent('Event');
        event.initEvent('click', true, true);
        node.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
    };
    click(references[1].querySelector('a'));
    click(f.editor.querySelector('[data-mdw-footnote-backref]'));
    assert.equal(caretTargets[0].node, f.editor.querySelector('.mdw-footnote-content'));
    assert.equal(caretTargets[0].atStart, true);
    assert.equal(caretTargets[1].node, references[1]);
    assert.equal(caretTargets[1].atStart, false);
    assert.equal(f.changes(), 0);
});

test('returning from a footnote reveals the reference below the toolbar without scrolling ancestors', async () => {
    const f = await fixture(`<p>Before${ref('a')}after</p>${note('a')}`);
    const reference = f.editor.querySelector('sup');
    const focusOptions = [];
    Object.defineProperty(f.editor, 'focus', { value: options => focusOptions.push(options) });
    Object.defineProperties(f.editor, {
        clientHeight: { value: 500 },
        scrollHeight: { value: 2400 }
    });
    Object.defineProperty(f.window, 'getComputedStyle', { value: () => ({ paddingTop: '40px' }) });
    reference.scrollIntoView = () => assert.fail('Footnote navigation must not scroll outer containers');
    for (const toolbarBottom of [46, 96]) {
        f.editor.scrollTop = 1500;
        f.editor.getBoundingClientRect = () => ({ top: toolbarBottom });
        reference.getBoundingClientRect = () => ({ top: -780 });
        f.editor.scrollTo = options => {
            assert.equal(options.behavior, 'instant');
            f.editor.scrollTop = options.top;
        };
        assert.equal(f.manager.goToReference('a'), true);
        const revealedTop = -780 + 1500 - f.editor.scrollTop;
        assert.ok(revealedTop >= toolbarBottom + 16, 'The reference line must clear the toolbar');
        assert.ok(revealedTop < toolbarBottom + 500, 'The reference must remain in the editor viewport');
        assert.equal(f.manager.getRange().startContainer, reference.parentNode);
        assert.equal(f.manager.getRange().startOffset, 2);
    }
    assert.deepEqual(focusOptions, [{ preventScroll: true }, { preventScroll: true }]);
    assert.equal(f.changes(), 0);
});

test('footnote navigation handles the document edges and reveals the beginning of a tall note', async () => {
    const f = await fixture(`<p>${ref('a')}</p>${note('a')}`);
    const reference = f.editor.querySelector('sup');
    const paragraph = f.editor.querySelector('.mdw-footnote-content p');
    Object.defineProperties(f.editor, {
        clientHeight: { value: 400 },
        scrollHeight: { value: 2000 }
    });
    f.editor.getBoundingClientRect = () => ({ top: 0 }); // Toolbar hidden.
    Object.defineProperty(f.window, 'getComputedStyle', { value: () => ({ paddingTop: '20px' }) });
    f.editor.scrollTo = options => { f.editor.scrollTop = options.top; };
    f.editor.scrollTop = 300;
    reference.getBoundingClientRect = () => ({ top: -290 });
    f.manager.goToReference('a');
    assert.equal(f.editor.scrollTop, 0, 'References near the document start do not scroll above it');
    f.editor.scrollTop = 0;
    paragraph.getBoundingClientRect = () => ({ top: 1900, height: 1200, bottom: 3100 });
    f.manager.goToDefinition(reference);
    assert.equal(f.editor.scrollTop, 1600, 'Navigation stays within the editor scroll range');
    f.editor.scrollTop = 0;
    paragraph.getBoundingClientRect = () => ({ top: 800, height: 1200, bottom: 2000 });
    f.manager.goToDefinition(reference);
    assert.equal(f.editor.scrollTop, 780, 'A tall note reveals its beginning, where the caret was placed');
    f.editor.scrollTop = 0;
    f.manager.revealCaretTarget(paragraph, { getClientRects: () => [{ top: 1700, height: 20, bottom: 1720 }] });
    assert.equal(f.editor.scrollTop, 1600, 'An end caret in a tall paragraph is revealed using its own line, not the paragraph top');
});

test('missing definitions stay visible without discarding their references', async () => {
    const { manager, editor } = await fixture(`<p>${ref('missing')}</p>`);
    manager.refresh();
    assert.equal(editor.querySelector('sup').classList.contains('mdw-footnote-missing'), true);
    assert.equal(manager.goToDefinition(editor.querySelector('sup')), false);
    assert.equal(editor.querySelector('sup').textContent, '1');
});

test('navigation into note controls restores a visible editable caret without changing content', async () => {
    const f = await fixture(`<p>Body${ref('a')}</p>${note('a')}`);
    f.manager.refresh();
    const definition = f.editor.querySelector('[data-mdw-footnote-definition]');
    const content = definition.querySelector('.mdw-footnote-content');
    content.innerHTML = '<p><br></p><p>Last paragraph</p>';
    const html = f.editor.innerHTML;
    f.select(definition.querySelector('.mdw-footnote-backref').firstChild, 0);
    assert.equal(f.manager.normalizeCaret(), true);
    assert.equal(f.manager.getRange().startContainer, content.firstChild);
    assert.equal(f.manager.getRange().startOffset, 0);
    assert.equal(f.manager.normalizeCaret(), false, 'The corrected caret is stable');
    f.select(definition.querySelector('.mdw-footnote-delete').firstChild, 0);
    assert.equal(f.manager.normalizeCaret(), true);
    assert.equal(f.manager.getRange().startContainer, content.lastChild.firstChild);
    assert.equal(f.manager.getRange().startOffset, 'Last paragraph'.length);
    assert.equal(f.editor.innerHTML, html);
    assert.equal(f.history.length, 0);
    assert.equal(f.changes(), 0);
});

test('footnote jumps and layout boundaries enter rich text instead of list or flex wrappers', async () => {
    const f = await fixture(`<p>${ref('a')}</p>${note('a')}`);
    f.manager.refresh();
    const definition = f.editor.querySelector('[data-mdw-footnote-definition]');
    const content = definition.querySelector('.mdw-footnote-content');
    content.innerHTML = '\n<ul>\n<li><strong>First</strong></li>\n<li>Last</li>\n</ul>\n';
    const first = content.querySelector('strong').firstChild;
    const last = content.querySelectorAll('li')[1].firstChild;
    assert.equal(f.manager.goToDefinition(f.editor.querySelector('sup')), true);
    assert.equal(f.manager.getRange().startContainer, first);
    assert.equal(f.manager.getRange().startOffset, 0);
    f.select(definition, 1);
    assert.equal(f.manager.normalizeCaret(), true);
    assert.equal(f.manager.getRange().startContainer, first);
    f.select(content, content.childNodes.length);
    assert.equal(f.manager.normalizeCaret(), true);
    assert.equal(f.manager.getRange().startContainer, last);
    assert.equal(f.manager.getRange().startOffset, 4);
    f.select(content.querySelector('ul'), 0);
    assert.equal(f.manager.normalizeCaret(), true);
    assert.equal(f.manager.getRange().startContainer, first);
});

test('normal note editing, text selections and ordinary body carets remain unchanged', async () => {
    const f = await fixture(`<p>Body${ref('a')}</p>${note('a')}`);
    f.manager.refresh();
    const content = f.editor.querySelector('.mdw-footnote-content');
    content.innerHTML = '<div>Native editable line</div>';
    const text = content.firstChild.firstChild;
    for (const [node, start, end] of [[text, 3, 3], [text, 2, 5], [f.editor.firstChild.firstChild, 2, 2]]) {
        f.select(node, end, start);
        const range = f.manager.getRange();
        assert.equal(f.manager.normalizeCaret(), false);
        assert.equal(f.manager.getRange(), range);
    }
    content.innerHTML = '<div></div>';
    f.select(content.firstChild, 0);
    assert.equal(f.manager.normalizeCaret(), false, 'Empty native blocks do not schedule endless selection corrections');
});

test('removing a footnote removes every reference, renumbers the remainder and preserves undo snapshots', async () => {
    const f = await fixture(`<p>A${ref('a')} and B${ref('b')} again${ref('a')}.</p>${note('a')}${note('b')}`);
    f.manager.refresh();
    assert.equal(f.manager.remove('a'), true);
    assert.equal(f.editor.querySelectorAll('sup').length, 1);
    assert.equal(f.editor.querySelector('sup a').textContent, '1');
    assert.equal(f.editor.querySelector('p').textContent, 'A and B1 again.');
    assert.equal(f.editor.querySelectorAll('[data-mdw-footnote-definition]').length, 1);
    assert.equal(f.changes(), 1);
    f.editor.innerHTML = f.history[0];
    f.manager.refresh();
    assert.equal(f.editor.querySelectorAll('sup').length, 3);
    assert.equal(f.editor.querySelectorAll('[data-mdw-footnote-definition]').length, 2);
    f.editor.innerHTML = f.history[1];
    f.manager.refresh();
    assert.equal(f.editor.querySelectorAll('sup').length, 1);
});

test('an unreferenced note can be removed and malformed labels do not break refresh', async () => {
    const f = await fixture(`${note('unused')}${note('%invalid')}`);
    f.manager.refresh();
    assert.equal(f.manager.remove('unused'), true);
    assert.equal(f.manager.remove('nonexistent'), false);
    assert.equal(f.changes(), 1);
});

test('derived numbering and navigation controls do not create history changes', async t => {
    const f = await fixture(`<p>${ref('a')}</p>${note('a')}`);
    const prototype = Object.getPrototypeOf(f.editor.querySelectorAll('a'));
    const originalForEach = prototype.forEach;
    prototype.forEach = Array.prototype.forEach;
    t.after(() => {
        if (originalForEach === undefined) delete prototype.forEach;
        else prototype.forEach = originalForEach;
    });
    const domSource = fs.readFileSync(path.join(__dirname, '..', 'media/modules/DOMUtils.js'), 'utf8');
    const { DOMUtils } = await import(`data:text/javascript;base64,${Buffer.from(domSource).toString('base64')}`);
    const domUtils = new DOMUtils(f.editor);
    f.manager.refresh();
    const baseline = domUtils.getCleanedHTML({ historyComparable: true });
    f.editor.querySelector('sup').id = 'mdw-fnref-a-2';
    f.editor.querySelector('sup a').textContent = '12';
    f.editor.querySelector('sup a').title = 'Changed display title';
    f.editor.querySelector('.mdw-footnote-backref').textContent = '12 ↩';
    assert.equal(domUtils.getCleanedHTML({ historyComparable: true }), baseline);
    f.editor.querySelector('.mdw-footnote-content p').textContent = 'Changed note';
    assert.notEqual(domUtils.getCleanedHTML({ historyComparable: true }), baseline);
});

function deletionEvent(overrides = {}) {
    return {
        key: 'Backspace',
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        ...overrides
    };
}

test('Backspace and Delete keep note editing boundaries separate from their controls', async () => {
    const f = await fixture(`<p>Body${ref('a')}</p>${note('a')}`);
    f.manager.refresh();
    const content = f.editor.querySelector('.mdw-footnote-content');
    const text = content.querySelector('p').firstChild;
    const html = f.editor.innerHTML;
    f.select(text, 0);
    const backward = deletionEvent();
    assert.equal(f.manager.handleKeydown(backward), true);
    assert.equal(backward.defaultPrevented, true);
    f.select(text, text.textContent.length);
    const forward = deletionEvent({ inputType: 'deleteContentForward' });
    assert.equal(f.manager.handleBeforeInput(forward), true);
    assert.equal(forward.defaultPrevented, true);
    assert.equal(f.editor.innerHTML, html);
    assert.equal(f.history.length, 0);
    assert.equal(f.changes(), 0);
    f.select(text, 3);
    assert.equal(f.manager.handleKeydown(deletionEvent()), false, 'Ordinary note text remains editable');
    content.innerHTML = '<p><br></p>';
    f.select(content.firstChild, 0);
    assert.equal(f.manager.handleKeydown(deletionEvent()), true);
    assert.equal(f.manager.handleKeydown(deletionEvent({key:'Delete'})), true);
    assert.equal(content.innerHTML, '<p><br></p>');
});

test('deletion inside a multi-paragraph note still merges its own paragraphs', async () => {
    const f = await fixture(`<p>${ref('a')}</p>${note('a')}`);
    const content = f.editor.querySelector('.mdw-footnote-content');
    content.innerHTML = '<p>First</p>\n<p>Second</p>';
    f.select(content.lastChild.firstChild, 0);
    assert.equal(f.manager.handleKeydown(deletionEvent()), false);
    f.select(content.firstChild.firstChild, 5);
    assert.equal(f.manager.handleKeydown(deletionEvent({key:'Delete'})), false);
});

test('macOS Ctrl+H protects the note boundary while leaving text deletion to the editor', async () => {
    const f = await fixture(`<p>Body${ref('a')}</p>${note('a')}`);
    f.manager.refresh();
    const text = f.editor.querySelector('.mdw-footnote-content p').firstChild;
    const html = f.editor.innerHTML;
    f.select(text, 0);
    const event = deletionEvent({ key: 'h', ctrlKey: true });
    assert.equal(f.manager.handleKeydown(event, true), true);
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.editor.innerHTML, html);
    f.select(text, 3);
    assert.equal(f.manager.handleKeydown(deletionEvent({ key: 'h', ctrlKey: true }), true), false);
    f.select(text, 0);
    assert.equal(f.manager.handleKeydown(deletionEvent({ key: 'h', ctrlKey: true }), false), false);
});

test('first-line list, quote, code and heading conversions are available inside footnotes', async () => {
    for (const html of ['<ul><li>List</li></ul>', '<blockquote><p>Quote</p></blockquote>', '<pre><code>Code</code></pre>', '<h2><br></h2>']) {
        const f = await fixture(`<p>${ref('a')}</p>${note('a')}`);
        f.manager.refresh();
        const content = f.editor.querySelector('.mdw-footnote-content');
        content.innerHTML = html;
        const paragraph = content.querySelector('li, p, code, h2');
        const target = paragraph.firstChild.nodeType === 3 ? paragraph.firstChild : paragraph;
        f.select(target, 0);
        assert.equal(f.manager.handleKeydown(deletionEvent()), false, 'The editor can convert the first structured line');
        assert.equal(f.manager.handleKeydown(deletionEvent({ key: 'h', ctrlKey: true }), true), false);
        assert.equal(f.manager.handleBeforeInput(deletionEvent({ inputType: 'deleteContentBackward' })), true,
            'Native deletion still cannot merge the note with its controls');
    }
});

test('refresh restores an editing body if native deletion removed its empty wrapper', async () => {
    const f = await fixture(`<p>${ref('a')}</p>${note('a')}`);
    f.manager.refresh();
    const definition = f.editor.querySelector('[data-mdw-footnote-definition]');
    definition.querySelector('.mdw-footnote-content').remove();
    f.select(definition, 1);
    f.manager.refresh();
    assert.equal(definition.querySelector('.mdw-footnote-content').innerHTML, '<p><br></p>');
    assert.equal(f.manager.getRange().startContainer, definition.querySelector('.mdw-footnote-content p'));
    assert.equal(definition.lastChild.getAttribute('data-mdw-footnote-delete'), 'a');
    assert.equal(f.editor.querySelectorAll('sup').length, 1);
});

test('deleting all note text keeps the native caret in its empty editing body', async () => {
    const f = await fixture(`<p>Body${ref('a')}</p>${note('a')}`);
    f.manager.refresh();
    const definition = f.editor.querySelector('[data-mdw-footnote-definition]');
    const content = definition.querySelector('.mdw-footnote-content');
    content.innerHTML = '<p></p>\n';
    content.firstChild.appendChild(f.window.document.createTextNode(''));
    // Chromium puts the collapsed caret before the body, next to the backref.
    f.select(definition, 1);
    f.manager.refresh();
    assert.equal(content.innerHTML, '<p><br></p>\n');
    assert.equal(f.manager.getRange().startContainer, content.firstChild);
    assert.equal(f.manager.handleKeydown(deletionEvent()), true);
    assert.equal(f.manager.handleKeydown(deletionEvent({key:'Delete'})), true);
    assert.equal(definition.querySelector('.mdw-footnote-content'), content);
    assert.equal(f.editor.querySelectorAll('sup').length, 1);
});

test('Backspace removes the last reference and its definition without changing surrounding text', async () => {
    const f = await fixture(`<p>Before${ref('a')}after${ref('b')}end</p>${note('a')}${note('b')}`);
    f.manager.refresh();
    const followingText = f.editor.querySelector('sup').nextSibling;
    f.select(followingText, 0);
    const event = deletionEvent();
    assert.equal(f.manager.handleKeydown(event), true);
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.editor.querySelector('p').textContent, 'Beforeafter1end');
    assert.equal(f.editor.querySelectorAll('[data-mdw-footnote-definition]').length, 1);
    assert.equal(f.editor.querySelector('[data-mdw-footnote-definition]').getAttribute('data-mdw-footnote-definition'), 'b');
    assert.equal(f.manager.getRange().startContainer, f.editor.querySelector('p'));
    assert.equal(f.manager.getRange().startOffset, 1);
    assert.equal(f.history.length, 2);
    assert.equal(f.changes(), 1);
});

test('deleting one repeated reference preserves its note and renumbers in reading order', async () => {
    const f = await fixture(`<p>${ref('a')}Text${ref('b')}again${ref('a')}end</p>${note('a')}${note('b')}`);
    f.manager.refresh();
    f.select(f.editor.querySelector('p'), 1);
    assert.equal(f.manager.handleKeydown(deletionEvent()), true);
    assert.deepEqual(Array.from(f.editor.querySelectorAll('sup a')).map(node => node.textContent), ['1', '2']);
    assert.equal(f.editor.querySelectorAll('[data-mdw-footnote-definition]').length, 2);
    assert.deepEqual(Array.from(f.editor.querySelectorAll('.mdw-footnote-backref')).map(node => node.textContent), ['1 ↩', '2 ↩']);
});

test('Delete and beforeinput handle references atomically in headings, lists and tables', async () => {
    for (const html of [
        `<h2>Text${ref('a')}tail</h2>`,
        `<ul><li>Text${ref('a')}tail</li></ul>`,
        `<table><tbody><tr><td>Text${ref('a')}tail</td></tr></tbody></table>`
    ]) {
        const f = await fixture(`${html}${note('a')}`);
        f.manager.refresh();
        const precedingText = f.editor.querySelector('sup').previousSibling;
        f.select(precedingText, precedingText.textContent.length);
        assert.equal(f.manager.handleBeforeInput(deletionEvent({inputType:'deleteContentForward'})), true);
        assert.equal(f.editor.querySelectorAll('sup').length, 0);
        assert.equal(f.editor.querySelectorAll('[data-mdw-footnote-definition]').length, 0);
        assert.equal(f.editor.textContent, 'Texttail');
    }
    const f = await fixture(`<p>${ref('a')}tail</p>${note('a')}`);
    f.select(f.editor.querySelector('p'), 0);
    assert.equal(f.manager.handleKeydown(deletionEvent({key:'Delete'})), true);
});

test('a reference-only paragraph remains editable without empty superscript or formatting wrappers', async () => {
    const f = await fixture(`<p><strong><em>${ref('a')}</em></strong></p>${note('a')}`);
    f.select(f.editor.querySelector('em'), 1);
    assert.equal(f.manager.handleKeydown(deletionEvent()), true);
    assert.equal(f.editor.innerHTML, '<p><br></p>');
    assert.equal(f.manager.getRange().startContainer, f.editor.querySelector('p'));
    assert.equal(f.manager.getRange().startOffset, 0);
});

test('a selected reference is deleted as one element rather than having its number regenerated', async () => {
    const f = await fixture(`<p>Before${ref('a')}after</p>${note('a')}`);
    f.select(f.editor.querySelector('p'), 2, 1);
    assert.equal(f.manager.handleKeydown(deletionEvent()), true);
    assert.equal(f.editor.innerHTML, '<p>Beforeafter</p>');
});

test('reference deletion leaves ordinary characters, line boundaries, modified shortcuts and IME input to the editor', async () => {
    const f = await fixture(`<p>Text${ref('a')}tail</p><p>Next</p>${note('a')}`);
    const nextText = f.editor.querySelector('sup').nextSibling;
    f.select(nextText, 1);
    assert.equal(f.manager.handleKeydown(deletionEvent()), false);
    f.select(f.editor.querySelectorAll('p')[1].firstChild, 0);
    assert.equal(f.manager.handleKeydown(deletionEvent()), false);
    f.select(nextText, 0);
    for (const overrides of [{isComposing:true}, {keyCode:229}, {ctrlKey:true}, {metaKey:true}, {altKey:true}]) {
        assert.equal(f.manager.handleKeydown(deletionEvent(overrides)), false);
    }
    assert.equal(f.manager.handleBeforeInput(deletionEvent({inputType:'deleteContentBackward', isComposing:true})), false);
    assert.equal(f.manager.handleBeforeInput(deletionEvent({inputType:'deleteContentBackward', cancelable:false})), false);
    assert.equal(f.history.length, 0);
});

test('reference and note deletion are one undo step and redo restores the deletion', async () => {
    const f = await fixture(`<p>Before${ref('a')}after</p>${note('a')}`);
    f.manager.refresh();
    const stateSource = fs.readFileSync(path.join(__dirname, '..', 'media/modules/StateManager.js'), 'utf8');
    const { StateManager } = await import(`data:text/javascript;base64,${Buffer.from(stateSource).toString('base64')}`);
    const history = new StateManager(f.editor, {postMessage: () => {}});
    history.saveSelection = () => null;
    history.restoreSelection = () => {};
    f.manager.stateManager = history;
    history.seedState();
    f.select(f.editor.querySelector('sup').nextSibling, 0);
    assert.equal(f.manager.handleKeydown(deletionEvent()), true);
    assert.equal(f.editor.innerHTML, '<p>Beforeafter</p>');
    assert.equal(history.undoStack.length, 2);
    assert.equal(history.performUndo(() => f.manager.refresh()), true);
    assert.equal(f.editor.querySelectorAll('sup').length, 1);
    assert.equal(f.editor.querySelectorAll('[data-mdw-footnote-definition]').length, 1);
    assert.equal(history.performRedo(() => f.manager.refresh()), true);
    assert.equal(f.editor.innerHTML, '<p>Beforeafter</p>');
});

test('native selection deletion prunes only notes whose final references were deleted', async () => {
    const f = await fixture(`<p>Text${ref('a')}middle${ref('b')}end</p>${note('a')}${note('b')}${note('unused')}`);
    f.manager.refresh();
    // A broad text selection is handled by the editor's normal deletion rules.
    f.select(f.editor.querySelector('p'), 3, 0);
    assert.equal(f.manager.handleBeforeInput(deletionEvent({inputType:'deleteContentBackward'})), false);
    f.editor.querySelector('sup').remove();
    f.manager.reconcileReferenceDeletion();
    f.manager.refresh();
    assert.deepEqual(Array.from(f.editor.querySelectorAll('[data-mdw-footnote-definition]'))
        .map(node => node.getAttribute('data-mdw-footnote-definition')), ['b', 'unused']);
    assert.equal(f.editor.querySelector('sup a').textContent, '1');
    assert.equal(f.manager.referencesBeforeDelete, null);
});

test('loading or restoring history cancels pending deletion cleanup', async () => {
    const f = await fixture(`<p>Text${ref('a')}</p>${note('a')}`);
    f.manager.captureReferencesBeforeDelete();
    f.manager.cancelPendingDelete();
    f.editor.querySelector('sup').remove();
    f.manager.reconcileReferenceDeletion();
    assert.equal(f.editor.querySelectorAll('[data-mdw-footnote-definition]').length, 1);
});
