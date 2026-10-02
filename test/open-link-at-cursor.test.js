const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const editorSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.js'), 'utf8');
const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
const packageJson = require('../package.json');
const slugSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'modules', 'MarkdownHeadingSlug.js'), 'utf8');
const slugModule = import(`data:text/javascript;base64,${Buffer.from(slugSource).toString('base64')}`);

function extractFunction(name, indent = '    ') {
    const start = editorSource.indexOf(`${indent}function ${name}(`);
    const end = editorSource.indexOf(`\n${indent}}\n`, start);
    assert.ok(start >= 0 && end > start, `${name} exists`);
    return editorSource.slice(start, end + indent.length + 2);
}

async function fixture(html, options = {}) {
    const { assignStableHeadingIds } = await slugModule;
    const window = domino.createWindow(`<div id="editor" contenteditable="true">${html}</div><input id="outside">`);
    const document = window.document;
    const editor = document.getElementById('editor');
    const messages = [];
    let activeElement = editor;
    let selection = null;
    Object.defineProperty(document, 'activeElement', { get: () => activeElement });
    window.getSelection = () => selection;
    const functions = [
        extractFunction('hasExplicitScheme'),
        extractFunction('sanitizeLinkHref'),
        extractFunction('getNodeElement'),
        extractFunction('getClosestAnchor'),
        ...['isOpenableLinkUrl', 'revealLinkAnchor', 'navigateToLink', 'openLinkAtCursor']
            .map(name => extractFunction(name, '        ')),
        extractFunction('getKeyboardEventKeyCode'),
        extractFunction('isImeInteractionKeydown'),
        extractFunction('handleOpenLinkShortcutKeydown')
    ].join('\n');
    const { openLinkAtCursor, handleOpenLinkShortcutKeydown } = new Function(
        'document', 'window', 'Node', 'editor', 'vscode', 'assignStableHeadingIds',
        `const isMac = ${options.isMac !== false};
        const isUpdating = ${!!options.isUpdating};
        const editorLoadFailed = ${!!options.editorLoadFailed};
        const isComposing = ${!!options.isComposing};
        const activeCompositionElement = ${options.activeCompositionElement ? '{}' : 'null'};
        const compositionUpdateGate = ${JSON.stringify({ composing: !!options.composing, finalizing: !!options.finalizing })};
        const settingsState = { allowFileLinks: ${!!options.allowFileLinks} };
        ${functions}
        return { openLinkAtCursor, handleOpenLinkShortcutKeydown };`
    )(document, window, window.Node, editor, { postMessage: message => messages.push(message) }, assignStableHeadingIds);
    return {
        document, editor, messages, openLinkAtCursor, handleOpenLinkShortcutKeydown,
        focus(element) { activeElement = element; },
        caret(node, offset = 0, collapsed = true) {
            selection = { rangeCount: 1, getRangeAt: () => ({ startContainer: node, startOffset: offset, collapsed }) };
        }
    };
}

test('the caret opens external, mail and workspace links without editing the document', async () => {
    for (const url of ['https://example.com/path?q=1', 'mailto:hello@example.com', './notes.md#topic']) {
        const f = await fixture(`<p>before <a href="${url}"><strong>link</strong></a> after</p>`);
        const originalHtml = f.editor.innerHTML;
        const text = f.editor.querySelector('strong').firstChild;
        for (const offset of [0, 2, text.length]) {
            f.caret(text, offset);
            assert.equal(f.openLinkAtCursor(), true);
        }
        assert.deepEqual(f.messages, Array(3).fill({ type: 'openLink', url }));
        assert.equal(f.editor.innerHTML, originalHtml);
    }
});

test('links in a table open from their caret position', async () => {
    const f = await fixture('<table><tbody><tr><td><a href="../notes.md">notes</a></td></tr></tbody></table>');
    f.caret(f.editor.querySelector('a').firstChild, 1);
    assert.equal(f.openLinkAtCursor(), true);
    assert.deepEqual(f.messages, [{ type: 'openLink', url: '../notes.md' }]);
});

test('a Japanese heading fragment scrolls inside the document without a host request', async () => {
    const f = await fixture('<p><a href="#todo%E9%A0%85%E7%9B%AE-1">jump</a></p><h2>TODO項目</h2><h2>TODO項目</h2>');
    const scrolled = [];
    Array.from(f.editor.querySelectorAll('h2')).forEach((heading, index) => {
        heading.scrollIntoView = options => scrolled.push({ index, options });
    });
    f.caret(f.editor.querySelector('a').firstChild, 2);
    assert.equal(f.openLinkAtCursor(), true);
    assert.deepEqual(scrolled, [{ index: 1, options: { block: 'start' } }]);
    assert.deepEqual(f.messages, []);
});

test('missing, outside, adjacent and selected text do not open a link', async () => {
    const f = await fixture('<p>before<a href="https://example.com">link</a>after</p>');
    assert.equal(f.openLinkAtCursor(), false);
    const paragraph = f.editor.querySelector('p');
    const outsideLink = f.document.createElement('a');
    outsideLink.setAttribute('href', 'https://outside.example');
    outsideLink.textContent = 'outside';
    f.document.body.appendChild(outsideLink);
    for (const node of [paragraph.firstChild, paragraph.lastChild, paragraph, outsideLink.firstChild]) {
        f.caret(node);
        assert.equal(f.openLinkAtCursor(), false);
    }
    f.caret(f.editor.querySelector('a').firstChild, 0, false);
    assert.equal(f.openLinkAtCursor(), false);
    assert.deepEqual(f.messages, []);
});

test('typing in an input cannot open a stale editor selection', async () => {
    const f = await fixture('<p><a href="https://example.com">link</a><input><button>button</button></p>');
    f.caret(f.editor.querySelector('a').firstChild, 1);
    for (const element of [f.document.getElementById('outside'), f.editor.querySelector('input'), f.editor.querySelector('button')]) {
        f.focus(element);
        assert.equal(f.openLinkAtCursor(), false);
    }
    assert.deepEqual(f.messages, []);
});

test('composition and document updates block link navigation', async () => {
    for (const flag of ['isUpdating', 'editorLoadFailed', 'isComposing', 'activeCompositionElement', 'composing', 'finalizing']) {
        const f = await fixture('<p><a href="https://example.com">link</a></p>', { [flag]: true });
        f.caret(f.editor.querySelector('a').firstChild, 1);
        assert.equal(f.openLinkAtCursor(), false, flag);
        assert.deepEqual(f.messages, []);
    }
});

test('unsafe schemes and file links retain the existing opening restrictions', async () => {
    for (const url of ['', 'javascript:alert(1)', 'command:workbench.action.closeWindow', 'file:///tmp/notes.md']) {
        const f = await fixture(`<p><a href="${url}">link</a></p>`);
        f.caret(f.editor.querySelector('a').firstChild, 1);
        assert.equal(f.openLinkAtCursor(), false, url);
        assert.deepEqual(f.messages, []);
    }
    const f = await fixture('<p><a href="file:///tmp/notes.md">link</a></p>', { allowFileLinks: true });
    f.caret(f.editor.querySelector('a').firstChild, 1);
    assert.equal(f.openLinkAtCursor(), true);
    assert.deepEqual(f.messages, [{ type: 'openLink', url: 'file:///tmp/notes.md' }]);
});

test('only Cmd+Enter on Mac and Ctrl+Enter on Windows/Linux suppress native Enter', async () => {
    for (const isMac of [true, false]) {
        const f = await fixture('<p>text</p>', { isMac });
        const primaryModifier = isMac ? { metaKey: true } : { ctrlKey: true };
        const events = [
            [{ key: 'Enter', ...primaryModifier }, true],
            [{ key: 'Enter' }, false],
            [{ key: 'Enter', ...(isMac ? { ctrlKey: true } : { metaKey: true }) }, false],
            ...['altKey', 'shiftKey', 'isComposing'].map(flag => [{ key: 'Enter', ...primaryModifier, [flag]: true }, false]),
            [{ key: 'Enter', ...primaryModifier, keyCode: 229 }, false],
            [{ key: 'Enter', metaKey: true, ctrlKey: true }, false]
        ];
        for (const [properties, expected] of events) {
            let prevented = false;
            const event = { ...properties, preventDefault() { prevented = true; } };
            assert.equal(f.handleOpenLinkShortcutKeydown(event), expected);
            assert.equal(prevented, expected);
        }
    }
});

test('the VS Code command executes navigation once after DOM default prevention', async () => {
    const binding = packageJson.contributes.keybindings.find(entry => entry.command === 'manulDown.openLinkAtCursor');
    assert.deepEqual(binding, {
        command: 'manulDown.openLinkAtCursor', key: 'ctrl+enter', mac: 'cmd+enter',
        when: "activeCustomEditorId == 'manulDown.editor' && webviewFocus"
    });
    assert.ok(packageJson.contributes.commands.some(entry => entry.command === binding.command));
    const f = await fixture('<p><a href="https://example.com">link</a></p>');
    f.caret(f.editor.querySelector('a').firstChild, 1);
    assert.equal(f.handleOpenLinkShortcutKeydown({ key: 'Enter', metaKey: true, preventDefault() {} }), true);
    assert.deepEqual(f.messages, []);
    const caseStart = editorSource.indexOf("case 'openLinkAtCursor':");
    const caseEnd = editorSource.indexOf('break;', caseStart);
    assert.ok(caseStart >= 0 && caseEnd > caseStart);
    const receive = new Function('requestOpenLinkAtCursor', editorSource.slice(caseStart + "case 'openLinkAtCursor':".length, caseEnd));
    let executeCommand;
    const commandStart = extensionSource.indexOf('const openLinkAtCursorCommand =');
    const commandEnd = extensionSource.indexOf('context.subscriptions.push(openLinkAtCursorCommand);', commandStart);
    assert.ok(commandStart >= 0 && commandEnd > commandStart);
    new Function('vscode', 'provider', extensionSource.slice(commandStart, commandEnd))({
        commands: { registerCommand(id, callback) { assert.equal(id, binding.command); executeCommand = callback; } }
    }, {
        postMessageToActiveEditor(message) {
            assert.deepEqual(message, { type: 'openLinkAtCursor' });
            receive(f.openLinkAtCursor);
        }
    });
    executeCommand();
    assert.deepEqual(f.messages, [{ type: 'openLink', url: 'https://example.com' }]);
});
