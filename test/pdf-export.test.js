const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createWindow } = require('@mixmark-io/domino');
const { loadPdfModules, uri } = require('./helpers/pdf-modules');
const { PdfExportSession, buildPdfContent, normalizePdfLayout, buildPdfPage, createBreakAnchors, restoreBreakAnchors } = loadPdfModules();

const sourceUri = uri('/workspace/notes.md');
const prepare = source => buildPdfContent(source, sourceUri, async () => null);

test('PDF adjustments reject unknown and first-block breaks and keep an independent history', () => {
    const content = { html: '<h1>Title</h1><p>Body</p>', blocks: [
        { id: 'block-0', label: 'Title', kind: 'h1', heading: true },
        { id: 'block-1', label: 'Body', kind: 'p', heading: false },
    ], warnings: [] };
    const session = new PdfExportSession(content);
    assert.equal(session.setBreak('block-0', true), false);
    assert.equal(session.setBreak('arbitrary-selector', true), false);
    assert.equal(session.setBreak('block-1', true), true);
    assert.equal(session.setBreak('block-1', true), false);
    session.setLayout({ paper: 'Letter', landscape: true });
    assert.equal(session.history('undo'), true);
    assert.equal(session.layout.paper, 'A4');
    assert.deepEqual([...session.breaks], ['block-1']);
    session.history('undo');
    assert.equal(session.breaks.size, 0);
    session.history('redo');
    assert.deepEqual([...session.breaks], ['block-1']);
    session.resetBreaks();
    assert.equal(session.canRedo, false);
    assert.equal(content.html, '<h1>Title</h1><p>Body</p>');
});

test('PDF sessions discard stale rendering and invalidate export on edits or adjustments', () => {
    const session = new PdfExportSession({ html: '', blocks: [], warnings: [] });
    assert.equal(session.acceptPdf(0, Buffer.from('first'), []), true);
    assert.equal(session.canExport, true);
    session.setLayout({ landscape: true });
    assert.equal(session.canExport, false);
    assert.equal(session.acceptPdf(0, Buffer.from('late'), []), false);
    assert.equal(session.acceptPdf(1, Buffer.from('latest'), []), true);
    session.markStale();
    assert.equal(session.canExport, false);
    assert.equal(session.acceptPdf(session.revision, Buffer.from('old source'), []), false);
});

test('PDF layout accepts only supported values', () => {
    assert.deepEqual(normalizePdfLayout({ paper: '</style>', landscape: 'yes', margin: -100, fontSize: 300 }), {
        paper: 'A4', landscape: false, margin: 'standard', fontSize: 'standard', pageNumbers: true,
    });
});

test('PDF content preserves source semantics and exposes only output-local block IDs', async () => {
    const source = '# 日本語\n\nText $E=mc^2$.\n\n# 日本語\n\n```mermaid\nflowchart LR\nA --> B\n```\n\n$$x^2$$\n';
    const content = await prepare(source);
    const root = createWindow(content.html).document;
    assert.deepEqual(Array.from(root.querySelectorAll('h1'), node => node.id), ['日本語', '日本語-1']);
    assert.equal(root.querySelector('[data-mdw-math]').textContent, 'E=mc^2');
    assert.equal(root.querySelector('code.language-mermaid').textContent, 'flowchart LR\nA --> B\n');
    assert.ok(root.querySelector('code.language-math'));
    assert.ok(!root.querySelector('[contenteditable]'));
    assert.equal(content.blocks[0].heading, true);
    assert.equal(content.blocks[1].label, 'Text E=mc^2.');
    assert.equal(source.includes('data-export'), false);
});

test('PDF content keeps raw HTML inert and removes executable or local link targets', async () => {
    const content = await prepare('<script>alert(1)</script>\n\n[bad](javascript:alert%281%29) [local](../private.txt) [good](https://example.com)\n');
    const root = createWindow(content.html).document;
    assert.ok(!root.querySelector('script'));
    assert.ok(!root.querySelector('a[href^="javascript:"]'));
    assert.ok(!root.querySelector('a[href^="../"]'));
    assert.equal(root.querySelector('a[href^="https:"]').textContent, 'good');
    assert.ok(root.body.textContent.includes('<script>'));
});

test('PDF content resolves repeated images once and makes missing images visible', async () => {
    const calls = [];
    const data = 'data:image/png;base64,aGVsbG8=';
    const content = await buildPdfContent('![図](./図.png)\n\n![again](./図.png)\n\n![missing](./missing.png)\n', sourceUri, async source => {
        calls.push(source);
        return source.includes('missing') ? null : data;
    });
    const root = createWindow(content.html).document;
    assert.equal(calls.length, 2);
    assert.equal(root.querySelectorAll('img').length, 2);
    assert.equal(root.querySelector('img').getAttribute('src'), data);
    assert.match(root.querySelector('.export-missing-image').textContent, /missing/);
    assert.equal(content.warnings.length, 1);
});

test('PDF footnotes become endnotes with matching internal links', async () => {
    const content = await prepare('Body[^note].\n\n[^note]: A footnote with **formatting**.\n\n## Later\n\nText.\n');
    const root = createWindow(content.html).document;
    const note = root.querySelector('.export-footnotes [data-mdw-footnote-definition]');
    assert.equal(note.id, 'mdw-fn-note');
    assert.equal(root.querySelector('[data-mdw-footnote-ref] a').getAttribute('href'), '#mdw-fn-note');
    assert.ok(note.querySelector('strong'));
    assert.ok(!root.querySelector('main'));
    assert.ok(root.body.lastElementChild.querySelector('.export-footnotes'));
});

test('PDF page is self-contained and applies paper settings only to output', async () => {
    const content = await prepare('# Title\n\n$$x$$\n');
    const html = await buildPdfPage(path.join(__dirname, '..', 'media'), content.html, '</title><script>bad()</script>',
        normalizePdfLayout({ landscape: true }), ['block-1']);
    assert.match(html, /size: A4 landscape/);
    assert.match(html, /data:font\/woff2;base64,/);
    assert.doesNotMatch(html, /url\(fonts\//);
    assert.doesNotMatch(html, /<title><\/title><script>/);
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /"breaks":\["block-1"\]/);
});

test('every exported block maps to a parser source range, including math, tables, lists, TOC and endnotes', async () => {
    const source = '[TOC]\n\n# Title\n\nParagraph[^n] with $x$.\n\n![image](image.png)  \nAfter the image.\n\n' +
        '| A | B |\n|---|---|\n| 1 | 2 |\n\n- one\n- two\n\n```js\nconst x = 1;\n```\n\n' +
        '$$\nx^2\n$$\n\n> [!NOTE]\n> Note text.\n\n[^n]: Footnote text.\n';
    const content = await prepare(source);
    const root = createWindow(`<main>${content.html}</main>`).document.querySelector('main');
    assert.ok(content.blocks.length >= 10);
    assert.equal(content.blocks.length, Array.from(root.children).filter(node => node.textContent.trim() || node.querySelector('img')).length);
    for (const block of content.blocks) {
        assert.ok(block.source, block.label);
        const raw = source.slice(block.source.start, block.source.end).trim();
        assert.equal(block.source.excerpt, raw);
        assert.ok(root.querySelector(`[data-export-block="${block.id}"]`), block.label);
    }
});

test('saved PDF breaks follow unchanged, moved and edited source blocks without falling onto deleted blocks', async () => {
    const source = '# Title\n\nBefore the target.\n\nTarget paragraph with some content.\n\nAfter the target.\n\n## End\n';
    const content = await prepare(source);
    const target = content.blocks[2];
    const stored = { version: 1, anchors: createBreakAnchors(content.blocks, new Set([target.id])) };
    assert.deepEqual(restoreBreakAnchors((await prepare('Inserted.\n\n' + source)).blocks, stored), { breaks: [target.id], dropped: 0 });
    const moved = await prepare(source.replace('Target paragraph with some content.\n\n', '') + '\nTarget paragraph with some content.\n');
    assert.deepEqual(restoreBreakAnchors(moved.blocks, stored), { breaks: [target.id], dropped: 0 });
    const edited = await prepare(source.replace('Target paragraph with some content.', 'Completely rewritten target paragraph.'));
    assert.deepEqual(restoreBreakAnchors(edited.blocks, stored), { breaks: [edited.blocks[2].id], dropped: 0 });
    const deleted = await prepare(source.replace('Target paragraph with some content.\n\n', ''));
    assert.deepEqual(restoreBreakAnchors(deleted.blocks, stored), { breaks: [], dropped: 1 });
    const crlf = await prepare(source.replace(/\n/g, '\r\n'));
    assert.deepEqual(restoreBreakAnchors(crlf.blocks, stored), { breaks: [target.id], dropped: 0 });
});

test('duplicate block anchors use surrounding source rather than changing ordinal IDs', async () => {
    const content = await prepare('# A\n\nRepeated.\n\n# B\n\nRepeated.\n\nEnd.\n');
    const stored = { version: 1, anchors: createBreakAnchors(content.blocks, new Set([content.blocks[3].id])) };
    const changed = await prepare('Repeated.\n\n' + '# A\n\nRepeated.\n\n# B\n\nRepeated.\n\nEnd.\n');
    assert.deepEqual(restoreBreakAnchors(changed.blocks, stored), { breaks: [changed.blocks[4].id], dropped: 0 });
    assert.deepEqual(restoreBreakAnchors(changed.blocks, { version: 999, anchors: stored.anchors }), { breaks: [], dropped: 0 });
});

const preparationModule = import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(
    path.join(__dirname, '../media/modules/ExportPreparation.js'), 'utf8')).toString('base64')}`);

test('PDF capture waits for IME finalization and pending image imports', async () => {
    const { prepareExportSnapshot } = await preparationModule;
    let composing = true;
    let pendingImages = true;
    let snapshots = 0;
    const timer = setTimeout(() => { composing = false; }, 10);
    try {
        const snapshot = await prepareExportSnapshot({
            isComposing: () => composing, hasPendingImages: () => pendingImages,
            createSnapshot: () => { snapshots++; if (snapshots > 1) pendingImages = false; return { content: 'latest', revision: 9 }; },
        });
        assert.equal(snapshot.content, 'latest');
        assert.ok(snapshots >= 2);
    } finally { clearTimeout(timer); }
});

test('PDF capture fails instead of exporting an unfinished composition', async () => {
    const { prepareExportSnapshot } = await preparationModule;
    await assert.rejects(prepareExportSnapshot({
        isComposing: () => true, hasPendingImages: () => false,
        createSnapshot: () => assert.fail('Do not serialize composing text'), timeoutMs: 1,
    }), /Finish the current edit/);
});
