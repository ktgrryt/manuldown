const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createWindow } = require('@mixmark-io/domino');
const { loadPdfModules, uri } = require('./helpers/pdf-modules');

let target;
let failRename;
const writes = [], renames = [], deletes = [], notices = [];
const { exportHtml, buildHtmlPage, buildPdfContent } = loadPdfModules({
    window: {
        showSaveDialog: async () => target,
        showInformationMessage: message => notices.push(message),
        showWarningMessage: message => notices.push(message),
    },
    workspace: { fs: {
        writeFile: async (...args) => writes.push(args),
        rename: async (...args) => { if (failRename) throw new Error('Save failed'); renames.push(args); },
        delete: async value => deletes.push(value),
    } },
});
const root = uri(path.resolve(__dirname, '..'));
const sourceUri = uri('/workspace/日本語.md');
test.beforeEach(() => {
    target = uri('/workspace/日本語.html');
    failRename = false;
    for (const list of [writes, renames, deletes, notices]) list.length = 0;
});

test('HTML page embeds renderers and fonts, escapes its title and uses a responsive layout', async () => {
    const content = await buildPdfContent('# 見出し\n\n$x^2$\n\n```mermaid\ngraph LR; A-->B\n```', sourceUri, async () => null);
    const html = await buildHtmlPage(path.join(root.path, 'media'), content.html, '</title><script>alert(1)</script>');
    const document = createWindow(html).document;
    assert.equal(document.title, '</title><script>alert(1)</script>');
    assert.equal(document.querySelectorAll('script[src],link[href]').length, 0);
    assert.match(html, /data:font\/woff2;base64,/);
    assert.match(html, /"format":"html"/);
    assert.match(html, /max-width: 960px/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /connect-src 'none'/);
});

test('HTML export saves synchronized content and embedded images using an atomic replacement', async () => {
    await exportHtml(root, sourceUri, async () => ({ source: '# 最新の編集\n\n![image](./image.png)' }),
        async () => 'data:image/png;base64,aGVsbG8=');
    assert.equal(writes.length, 1);
    const document = createWindow(writes[0][1].toString()).document;
    assert.equal(document.querySelector('h1').textContent, '最新の編集');
    assert.equal(document.querySelector('img').getAttribute('src'), 'data:image/png;base64,aGVsbG8=');
    assert.match(writes[0][0].path, /\.html\..+\.tmp$/);
    assert.equal(renames[0][1], target);
    assert.deepEqual(renames[0][2], { overwrite: true });
    assert.equal(notices[0], 'HTML exported.');
});

test('cancelling or choosing the source document does not capture or write', async () => {
    const capture = () => assert.fail('Capture is unnecessary');
    target = undefined;
    await exportHtml(root, sourceUri, capture, async () => null);
    target = sourceUri;
    await assert.rejects(exportHtml(root, sourceUri, capture, async () => null), /filename/);
    assert.equal(writes.length, 0);
});

test('capture failures leave the destination untouched', async () => {
    await assert.rejects(exportHtml(root, sourceUri, async () => { throw new Error('Edit conflict'); }, async () => null), /Edit conflict/);
    assert.equal(writes.length, 0);
});

test('failed saves remove the temporary file and report failure', async () => {
    failRename = true;
    await assert.rejects(exportHtml(root, sourceUri, async () => ({ source: 'Text' }), async () => null), /Save failed/);
    assert.equal(deletes[0], writes[0][0]);
    assert.equal(notices.length, 0);
});

test('missing images are visible and reported after exporting', async () => {
    await exportHtml(root, sourceUri, async () => ({ source: '![missing](./absent.png)' }), async () => null);
    assert.match(writes[0][1].toString(), /Image unavailable: missing/);
    assert.match(notices[0], /Image unavailable or blocked: missing/);
});
