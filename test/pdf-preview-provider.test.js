const assert = require('node:assert/strict');
const test = require('node:test');
const { loadPdfModules, uri } = require('./helpers/pdf-modules');

let changeListener;
let capturedVersion = 1;
const initialSource = '# Title\n\nFirst paragraph.\n\n## Second section\n\nBody.\n';
let source = initialSource;
const document = { uri: uri('/workspace/document.md'), getText: () => source, get version() { return capturedVersion; } };
const writes = [];
const renames = [];
let savedTarget = uri('/workspace/export.pdf');
const panels = [];
const fakeVscode = {
    env: { remoteName: undefined, uiKind: 1, language: 'ja', openExternal: async () => true },
    UIKind: { Desktop: 1 }, ViewColumn: { Active: 1 },
    workspace: {
        getConfiguration: () => ({ get: (_key, fallback) => fallback }),
        onDidChangeTextDocument: callback => { changeListener = callback; return { dispose() {} }; },
        onDidChangeConfiguration: () => ({ dispose() {} }),
        fs: {
            writeFile: async (target, bytes) => writes.push([target, bytes]),
            rename: async (...args) => renames.push(args), delete: async () => {},
        },
    },
    window: {
        createWebviewPanel() {
            const listeners = [];
            const panel = {
                messages: [], reveal() {},
                webview: { cspSource: 'https://test.invalid', asWebviewUri: target => target,
                    onDidReceiveMessage() {}, postMessage: async message => { panel.messages.push(message); return true; } },
                onDidDispose: listener => listeners.push(listener),
                dispose: () => listeners.forEach(listener => listener()),
            };
            panels.push(panel); return panel;
        },
        showSaveDialog: async () => savedTarget,
        showInformationMessage: async () => undefined,
    },
    commands: { executeCommand: async () => {} },
};
const { PdfPreviewProvider, renderer, pdfBreakStorageKey } = loadPdfModules(fakeVscode);
const originalRenderer = renderer.renderPdf;
const calls = [];
const preferences = new Map();
const context = { extensionUri: uri('/extension'), globalState: {
    get: key => preferences.get(key), update: async (key, value) => { preferences.set(key, value); },
} };

test.beforeEach(() => {
    capturedVersion = 1;
    source = initialSource;
    preferences.clear();
    writes.length = 0; renames.length = 0; panels.length = 0; calls.length = 0;
    savedTarget = uri('/workspace/export.pdf');
    renderer.renderPdf = async options => {
        calls.push(options);
        return { bytes: Buffer.from(`%PDF-${calls.length}`), warnings: [] };
    };
});
test.after(() => { renderer.renderPdf = originalRenderer; });

async function fixture(t, capture = async () => ({ source, version: capturedVersion })) {
    const provider = new PdfPreviewProvider(context);
    t.after(() => provider.dispose());
    await provider.open(document, capture, async () => null);
    const entry = provider.previews.get(document.uri.toString());
    await provider.handleMessage(entry, { type: 'ready' });
    const message = (type, extra = {}) => provider.handleMessage(entry, {
        type, sessionId: entry.sessionId, revision: entry.session.revision, ...extra,
    });
    return { provider, entry, message };
}

test('PDF preview saves the displayed PDF bytes without regenerating at export time', async t => {
    const { entry, message } = await fixture(t);
    await message('export');
    assert.equal(writes.length, 0, 'No export until the viewer confirms its display');
    await message('displayed');
    const bytes = entry.session.pdf.bytes;
    await message('export');
    assert.equal(calls.length, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][1], bytes);
    assert.equal(renames[0][1].path, '/workspace/export.pdf');
    assert.deepEqual(renames[0][2], { overwrite: true });
});

test('PDF preview uses English controls even when VS Code is Japanese', async t => {
    const { entry } = await fixture(t);
    const html = entry.panel.webview.html;
    assert.match(html, /<html lang="en">/);
    assert.match(html, /PDF preview/);
    assert.match(html, /Page breaks/);
    assert.match(html, /Click a line between blocks/);
    assert.match(html, /Zoom level/);
    assert.doesNotMatch(html, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u);
});

test('page breaks regenerate only the PDF and require a fresh display acknowledgement', async t => {
    const { entry, message } = await fixture(t);
    await message('displayed');
    const original = document.getText();
    const id = entry.session.content.blocks[2].id;
    await message('break', { id, enabled: true });
    assert.deepEqual(calls.at(-1).breaks, [id]);
    assert.equal(document.getText(), original);
    await message('export');
    assert.equal(writes.length, 0);
    await message('displayed');
    await message('export');
    assert.equal(writes.length, 1);
    await message('undo');
    assert.equal(entry.session.breaks.size, 0);
});

test('the export notification does not block further preview adjustments', async t => {
    const original = fakeVscode.window.showInformationMessage;
    fakeVscode.window.showInformationMessage = () => new Promise(() => {});
    t.after(() => { fakeVscode.window.showInformationMessage = original; });
    const { entry, message } = await fixture(t);
    await message('displayed');
    await message('export');
    assert.equal(writes.length, 1);
    assert.equal(entry.saving, false);
    const id = entry.session.content.blocks[2].id;
    await message('break', { id, enabled: true });
    assert.deepEqual(calls.at(-1).breaks, [id]);
});

test('document changes invalidate the preview and refresh preserves source-associated breaks', async t => {
    const { entry, message } = await fixture(t);
    await message('layout', { layout: { paper: 'Letter', landscape: true } });
    await message('displayed');
    const id = entry.session.content.blocks[2].id;
    await message('break', { id, enabled: true });
    source = '# Inserted title\n\nNew paragraph.\n\n' + source;
    capturedVersion++;
    changeListener({ document });
    assert.equal(entry.session.stale, true);
    await message('displayed');
    await message('export');
    assert.equal(writes.length, 0);
    await message('reload');
    assert.equal(entry.session.stale, false);
    assert.deepEqual([...entry.session.breaks], [id]);
    assert.equal(entry.session.layout.paper, 'Letter');
    assert.equal(entry.session.layout.landscape, true);
});

test('page breaks survive preview disposal and a new provider, including persisted undo and redo', async t => {
    const first = await fixture(t);
    await first.message('displayed');
    const id = first.entry.session.content.blocks[2].id;
    await first.message('break', { id, enabled: true });
    const stored = preferences.get(pdfBreakStorageKey(document.uri.toString()));
    assert.equal(stored.version, 1);
    assert.equal(stored.anchors.length, 1);
    assert.equal('rect' in stored.anchors[0], false);
    first.provider.dispose();
    source = 'New introduction.\n\n' + source;
    capturedVersion++;
    const second = await fixture(t);
    assert.deepEqual([...second.entry.session.breaks], [id]);
    await second.message('displayed');
    await second.message('break', { id, enabled: false });
    assert.equal(preferences.get(pdfBreakStorageKey(document.uri.toString())).anchors.length, 0);
    await second.message('undo');
    assert.deepEqual([...second.entry.session.breaks], [id]);
    assert.equal(preferences.get(pdfBreakStorageKey(document.uri.toString())).anchors.length, 1);
    await second.message('redo');
    assert.equal(preferences.get(pdfBreakStorageKey(document.uri.toString())).anchors.length, 0);
    assert.equal(source.includes('pagebreak'), false);
});

test('deleted source breaks are removed with a notice and stale-canvas clicks are ignored', async t => {
    const { entry, message } = await fixture(t);
    const id = entry.session.content.blocks[2].id;
    await message('break', { id, enabled: true });
    assert.equal(entry.session.breaks.size, 0, 'No clicks before the current PDF has been displayed');
    await message('displayed');
    await message('break', { id, enabled: true });
    await message('break', { id, enabled: false, revision: 0 });
    assert.deepEqual([...entry.session.breaks], [id]);
    source = source.replace('## Second section\n\n', '');
    capturedVersion++;
    changeListener({ document });
    await message('reload');
    assert.equal(entry.session.breaks.size, 0);
    assert.match(entry.session.content.warnings.join(' '), /1 page break.*removed/);
    assert.equal(preferences.get(pdfBreakStorageKey(document.uri.toString())).anchors.length, 0);
});

test('persistence errors are visible without losing this preview or preventing export', async t => {
    const update = context.globalState.update;
    context.globalState.update = async () => { throw new Error('Disk full'); };
    t.after(() => { context.globalState.update = update; });
    const { entry, message } = await fixture(t);
    await message('displayed');
    await message('break', { id: entry.session.content.blocks[2].id, enabled: true });
    assert.equal(entry.session.breaks.size, 1);
    assert.match(entry.panel.messages.filter(message => message.type === 'state').at(-1).warnings.join(' '), /could not be saved/);
    await message('displayed');
    await message('export');
    assert.equal(writes.length, 1);
});

test('failed refresh cannot export the old document and cancelling save writes nothing', async t => {
    let fail = false;
    const { entry, message } = await fixture(t, async () => {
        if (fail) throw new Error('Finish the current edit');
        return { source, version: capturedVersion };
    });
    await message('displayed');
    savedTarget = undefined;
    await message('export');
    assert.equal(writes.length, 0);
    fail = true;
    await message('reload');
    assert.equal(entry.session.stale, true);
    assert.match(entry.error, /Finish the current edit/);
    savedTarget = uri('/workspace/export.pdf');
    await message('export');
    assert.equal(writes.length, 0);
});

test('late generation results cannot replace the latest layout', async t => {
    const { provider, entry, message } = await fixture(t);
    const pending = [];
    renderer.renderPdf = options => new Promise(resolve => pending.push({ options, resolve }));
    const earlier = message('layout', { layout: { landscape: true } });
    await new Promise(resolve => setImmediate(resolve));
    const latest = message('layout', { layout: { paper: 'Letter', landscape: true } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending[0].options.signal.aborted, true);
    pending[1].resolve({ bytes: Buffer.from('%PDF-latest'), warnings: [] });
    await latest;
    pending[0].resolve({ bytes: Buffer.from('%PDF-late'), warnings: [] });
    await earlier;
    assert.equal(entry.session.pdf.bytes.toString(), '%PDF-latest');
    assert.equal(entry.busy, false);
    provider.dispose();
    assert.equal(pending[1].options.signal.aborted, true);
});
