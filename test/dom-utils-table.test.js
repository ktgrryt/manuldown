const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');
const TurndownService = require('turndown');

const domUtilsSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'DOMUtils.js'),
    'utf8'
);
const domUtilsModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(domUtilsSource).toString('base64')}`
);
const pastedPathLinkDomSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'PastedPathLinkDOM.js'),
    'utf8'
);
const pastedPathLinkDomModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(pastedPathLinkDomSource).toString('base64')}`
);

async function cleanEditorHTML(editorHTML, options = {}, prepare = () => {}) {
    const window = domino.createWindow(
        `<div id="editor">${editorHTML}</div>`
    );
    const editor = window.document.querySelector('#editor');
    const nodeListPrototype = Object.getPrototypeOf(editor.querySelectorAll('a'));
    const previousForEach = nodeListPrototype.forEach;
    const previousDocument = global.document;
    const previousNode = global.Node;

    // Domino intentionally exposes a minimal NodeList. The production webview
    // provides NodeList#forEach, which getCleanedHTML uses throughout.
    nodeListPrototype.forEach = Array.prototype.forEach;
    global.document = window.document;
    global.Node = window.Node;

    try {
        prepare(editor);
        const { DOMUtils } = await domUtilsModulePromise;
        return new DOMUtils(editor).getCleanedHTML(options);
    } finally {
        if (previousForEach === undefined) {
            delete nodeListPrototype.forEach;
        } else {
            nodeListPrototype.forEach = previousForEach;
        }
        if (previousDocument === undefined) {
            delete global.document;
        } else {
            global.document = previousDocument;
        }
        if (previousNode === undefined) {
            delete global.Node;
        } else {
            global.Node = previousNode;
        }
    }
}

async function cleanTableCell(cellHTML) {
    const cleanedHTML = await cleanEditorHTML(
        `<table><tbody><tr><td>${cellHTML}</td></tr></tbody></table>`
    );
    const resultWindow = domino.createWindow(`<div id="result">${cleanedHTML}</div>`);
    const cell = resultWindow.document.querySelector('td');
    return {
        html: cell.innerHTML,
        text: cell.textContent,
    };
}

test('editor cleanup excludes transient cursor and selection classes', async () => {
    const cleanedHTML = await cleanEditorHTML(
        '<hr class="selected">' +
        '<ul><li><input type="checkbox" class="cursor-on">task</li></ul>' +
        '<p><img src="image.png" class="photo image-caret-left-edge image-caret-right-edge"></p>' +
        '<table class="md-table"><tbody><tr><td>cell</td></tr></tbody></table>'
    );

    assert.doesNotMatch(cleanedHTML, /\bselected\b/);
    assert.doesNotMatch(cleanedHTML, /\bcursor-on\b/);
    assert.doesNotMatch(cleanedHTML, /\bimage-caret-(?:left|right)-edge\b/);
    assert.doesNotMatch(cleanedHTML, /\bmd-table\b/);
    assert.match(cleanedHTML, /class="photo"/);
});

test('editor cleanup removes transient inline-code caret anchors', async () => {
    const cleanedHTML = await cleanEditorHTML(
        '<p>\uFEFF<code>' +
        '<span class="md-inline-code-left-caret-anchor" ' +
        'data-inline-code-left-caret-anchor="true" ' +
        'data-exclude-from-markdown="true" contenteditable="false"></span>' +
        'aaa</code>\u200B</p>',
        {}, editor => {
            const paragraph = editor.querySelector('p');
            paragraph.firstChild.mdwCaretAnchor = '\uFEFF';
            paragraph.lastChild.mdwCaretAnchor = '\u200B';
        }
    );

    assert.equal(cleanedHTML, '<p><code>aaa</code></p>');
});

test('editor cleanup preserves unmarked zero-width characters adjacent to code', async () => {
    const html = '<p>\uFEFF<code>aaa</code>\u200B\u2060</p>';
    assert.equal(await cleanEditorHTML(html), html);
});

test('table line normalization preserves user zero-width text and code', async () => {
    const text = 'a\u200bb\u2060c\ufeffd';
    const result = await cleanTableCell(`<div>${text}</div><div><code>${text}</code></div>`);
    assert.equal(result.text, `${text}<br>${text}`);
    assert.ok(result.html.includes(`<code>${text}</code>`));
    const bomOnly = await cleanTableCell('<div>\ufeff</div>');
    assert.equal(bomOnly.text, '\ufeff');
});

test('live DOM cleanup preserves the inline-code caret marker', async () => {
    const window = domino.createWindow(
        '<div id="editor"><p><code>' +
        '<span class="md-inline-code-left-caret-anchor" ' +
        'data-inline-code-left-caret-anchor="true" ' +
        'data-exclude-from-markdown="true" contenteditable="false"></span>' +
        'aaa</code></p></div>'
    );
    const editor = window.document.querySelector('#editor');
    const nodeListPrototype = Object.getPrototypeOf(editor.querySelectorAll('span'));
    const previousForEach = nodeListPrototype.forEach;
    nodeListPrototype.forEach = Array.prototype.forEach;

    try {
        const { DOMUtils } = await domUtilsModulePromise;
        new DOMUtils(editor).cleanupGhostStyles();

        assert.ok(editor.querySelector('.md-inline-code-left-caret-anchor'));
        assert.equal(editor.querySelector('code').textContent, 'aaa');
    } finally {
        nodeListPrototype.forEach = previousForEach;
    }
});

test('live DOM cleanup preserves generated table structure handles', async () => {
    const window = domino.createWindow(
        '<div id="editor"><table><tbody><tr><td>' +
        '<span class="md-table-structure-handle md-table-row-handle" ' +
        'data-exclude-from-markdown="true" contenteditable="false"></span>' +
        '<span class="pasted-style">cell</span>' +
        '</td></tr></tbody></table></div>'
    );
    const editor = window.document.querySelector('#editor');
    const nodeListPrototype = Object.getPrototypeOf(editor.querySelectorAll('span'));
    const previousForEach = nodeListPrototype.forEach;
    nodeListPrototype.forEach = Array.prototype.forEach;

    try {
        const { DOMUtils } = await domUtilsModulePromise;
        new DOMUtils(editor).cleanupGhostStyles();

        assert.ok(editor.querySelector('.md-table-structure-handle'));
        assert.ok(!editor.querySelector('.pasted-style'));
        assert.equal(editor.querySelector('td').textContent, 'cell');
    } finally {
        if (previousForEach === undefined) {
            delete nodeListPrototype.forEach;
        } else {
            nodeListPrototype.forEach = previousForEach;
        }
    }
});

test('live DOM cleanup preserves table overlay geometry while removing pasted styles', async () => {
    const window = domino.createWindow(
        '<div id="editor">' +
        '<div class="md-table-wrapper"><table><tbody><tr><td>cell</td></tr></tbody></table>' +
        '<div class="md-table-structure-outline active" data-exclude-from-markdown="true" ' +
        'contenteditable="false" style="left: 12px; top: 8px; width: 100px; height: 32px"></div></div>' +
        '<div class="md-table-insert-line vertical" data-exclude-from-markdown="true" ' +
        'contenteditable="false" style="display: block; left: 12px; top: 8px; height: 64px"></div>' +
        '<div class="md-table-insert-line horizontal" data-exclude-from-markdown="true" ' +
        'contenteditable="false" style="display: none; left: 12px; top: 40px; width: 100px"></div>' +
        '<p style="color: red"><span style="font-size: 24px">pasted text</span></p>' +
        '<div class="md-table-insert-line" style="display: block">pasted lookalike</div>' +
        '</div>'
    );
    const editor = window.document.querySelector('#editor');
    const overlays = Array.from(editor.querySelectorAll('[data-exclude-from-markdown="true"]'));
    const styles = overlays.map(overlay => overlay.getAttribute('style'));
    const nodeListPrototype = Object.getPrototypeOf(editor.querySelectorAll('span'));
    const previousForEach = nodeListPrototype.forEach;
    nodeListPrototype.forEach = Array.prototype.forEach;

    try {
        const { DOMUtils } = await domUtilsModulePromise;
        new DOMUtils(editor).cleanupGhostStyles();

        assert.deepEqual(overlays.map(overlay => overlay.getAttribute('style')), styles);
        assert.equal(editor.querySelector('p').getAttribute('style'), null);
        assert.ok(!editor.querySelector('span'));
        assert.equal(editor.lastElementChild.getAttribute('style'), null);
        assert.equal(editor.querySelector('p').textContent, 'pasted text');
    } finally {
        if (previousForEach === undefined) {
            delete nodeListPrototype.forEach;
        } else {
            nodeListPrototype.forEach = previousForEach;
        }
    }

    const cleanedHTML = await cleanEditorHTML(editor.innerHTML);
    assert.doesNotMatch(cleanedHTML, /md-table-structure-outline|data-exclude-from-markdown|style=/);
    assert.doesNotMatch(cleanedHTML, /md-table-insert-line (?:vertical|horizontal)/);
    assert.match(cleanedHTML, /<td>cell<\/td>/);
});

test('history comparison canonicalizes asynchronously reconstructed image UI', async () => {
    const cleanedHTML = await cleanEditorHTML(
        '<p><img alt="diagram|320x180" data-md-path="./diagram.png" ' +
        'data-image-resolve-id="request-1" data-remote-image-blocked="true" ' +
        'src="https://webview.invalid/resolved" width="320" height="180" ' +
        'style="width: 320px; height: 180px; aspect-ratio: 16 / 9; border: 1px solid red"></p>',
        { historyComparable: true }
    );

    assert.match(cleanedHTML, /src="\.\/diagram\.png"/);
    assert.doesNotMatch(cleanedHTML, /data-image-resolve-id|data-remote-image-blocked/);
    assert.doesNotMatch(cleanedHTML, /\s(?:width|height)="/);
    assert.doesNotMatch(cleanedHTML, /(?:width|height|aspect-ratio)\s*:/);
    assert.match(cleanedHTML, /border:\s*1px solid red/);
});

test('pasted path fallback survives editor normalization and restores selected link text', async () => {
    const pastedPath = '/Users/ryoto/code/test-md/test3.md';
    const window = domino.createWindow(
        '<div id="editor">' +
        '<p id="target">にリンクを貼る</p>' +
        '<span class="md-table-structure-handle">transient control</span>' +
        '</div>'
    );
    const editor = window.document.querySelector('#editor');
    const target = window.document.querySelector('#target');
    const nodeListPrototype = Object.getPrototypeOf(editor.querySelectorAll('span'));
    const previousForEach = nodeListPrototype.forEach;
    const previousDocument = global.document;
    const previousNode = global.Node;
    nodeListPrototype.forEach = Array.prototype.forEach;
    global.document = window.document;
    global.Node = window.Node;

    try {
        const { DOMUtils } = await domUtilsModulePromise;
        const {
            createPastedPathFallback,
            isPastedPathFallbackIntact,
            releasePastedPathFallback,
            replacePastedPathFallback,
        } = await pastedPathLinkDomModulePromise;
        const fallback = createPastedPathFallback(window.document, pastedPath);
        target.insertBefore(fallback.fragment, target.firstChild);
        const pending = { ...fallback, pathText: pastedPath };

        assert.equal(isPastedPathFallbackIntact(pending, editor), true);
        new DOMUtils(editor).cleanupGhostStyles();
        assert.equal(isPastedPathFallbackIntact(pending, editor), true);
        assert.equal(fallback.fallbackNode.data, pastedPath);
        const pendingMarkdown = new TurndownService().turndown(
            new DOMUtils(editor).getCleanedHTML()
        );
        assert.match(pendingMarkdown, /\/Users\/ryoto\/code\/test-md\/test3\.md/);
        assert.doesNotMatch(pendingMarkdown, /<!--|-->/);

        const originalSelection = window.document.createDocumentFragment();
        originalSelection.appendChild(window.document.createTextNode('ここ'));
        const link = window.document.createElement('a');
        link.setAttribute('href', './test3.md');
        link.appendChild(originalSelection);
        assert.equal(replacePastedPathFallback(pending, link), true);
        assert.equal(
            target.innerHTML,
            '<a href="./test3.md">ここ</a>にリンクを貼る'
        );
        assert.equal(editor.innerHTML.includes('<!---->'), false);

        const rejectedFallback = createPastedPathFallback(window.document, pastedPath);
        while (target.firstChild) {
            target.removeChild(target.firstChild);
        }
        target.appendChild(rejectedFallback.fragment);
        target.appendChild(window.document.createTextNode('のまま'));
        const rejectedPending = { ...rejectedFallback, pathText: pastedPath };
        new DOMUtils(editor).cleanupGhostStyles();
        assert.equal(isPastedPathFallbackIntact(rejectedPending, editor), true);
        assert.equal(releasePastedPathFallback(rejectedPending), rejectedFallback.fallbackNode);
        assert.equal(target.textContent, `${pastedPath}のまま`);
        assert.equal(editor.innerHTML.includes('<!---->'), false);

        while (target.firstChild) {
            target.removeChild(target.firstChild);
        }
        const tamperedFallback = createPastedPathFallback(window.document, pastedPath);
        target.appendChild(tamperedFallback.fragment);
        const tamperedPending = { ...tamperedFallback, pathText: pastedPath };
        tamperedFallback.fallbackNode.data += 'に追記';
        const unexpectedLink = window.document.createElement('a');
        unexpectedLink.setAttribute('href', './test3.md');
        unexpectedLink.textContent = 'ここ';
        assert.equal(isPastedPathFallbackIntact(tamperedPending, editor), false);
        assert.equal(replacePastedPathFallback(tamperedPending, unexpectedLink), false);
        releasePastedPathFallback(tamperedPending);
        assert.equal(target.textContent, `${pastedPath}に追記`);
    } finally {
        if (previousForEach === undefined) {
            delete nodeListPrototype.forEach;
        } else {
            nodeListPrototype.forEach = previousForEach;
        }
        if (previousDocument === undefined) {
            delete global.document;
        } else {
            global.document = previousDocument;
        }
        if (previousNode === undefined) {
            delete global.Node;
        } else {
            global.Node = previousNode;
        }
    }
});

test('table cleanup preserves formatting and visual line boundaries', async () => {
    const explicitBreak = await cleanTableCell(
        '<strong>Bold</strong><br><a href="/docs"><em>Docs</em></a>'
    );
    assert.deepEqual(explicitBreak, {
        html: '<strong>Bold</strong>&lt;br&gt;<a href="/docs"><em>Docs</em></a>',
        text: 'Bold<br>Docs',
    });

    const blockLines = await cleanTableCell(
        '<div><strong>First</strong></div><p><code>second value</code></p>'
    );
    assert.deepEqual(blockLines, {
        html: '<strong>First</strong>&lt;br&gt;<code>second value</code>',
        text: 'First<br>second value',
    });

    const whitespaceSensitiveCode = await cleanTableCell(
        '<code> a  b </code><br><code> c  d </code>'
    );
    assert.deepEqual(whitespaceSensitiveCode, {
        html: '<code> a  b </code>&lt;br&gt;<code> c  d </code>',
        text: ' a  b <br> c  d ',
    });

    const consecutiveBreaks = await cleanTableCell('<br><br><code>A</code><br>');
    assert.deepEqual(consecutiveBreaks, {
        html: '&lt;br&gt;&lt;br&gt;<code>A</code>',
        text: '<br><br>A',
    });

    const formattedList = await cleanTableCell(
        '<ul><li><strong>one</strong></li><li><a href="/two">two</a></li></ul>'
    );
    assert.deepEqual(formattedList, {
        html: '- <strong>one</strong>&lt;br&gt;- <a href="/two">two</a>',
        text: '- one<br>- two',
    });
});
