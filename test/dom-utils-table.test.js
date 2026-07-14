const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const domUtilsSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'DOMUtils.js'),
    'utf8'
);
const domUtilsModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(domUtilsSource).toString('base64')}`
);

async function cleanEditorHTML(editorHTML, options = {}) {
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
