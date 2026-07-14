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

async function cleanTableCell(cellHTML) {
    const window = domino.createWindow(
        `<div id="editor"><table><tbody><tr><td>${cellHTML}</td></tr></tbody></table></div>`
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
        const cleanedHTML = new DOMUtils(editor).getCleanedHTML();
        const resultWindow = domino.createWindow(`<div id="result">${cleanedHTML}</div>`);
        const cell = resultWindow.document.querySelector('td');
        return {
            html: cell.innerHTML,
            text: cell.textContent,
        };
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
