const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const uri = uriPath => ({
    path: uriPath, fsPath: uriPath, scheme: 'file',
    toString: () => `file://${uriPath}`,
    with: changes => uri(changes.path ?? uriPath),
});
let state;
const vscodeMock = {
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.posix.join(base.path, ...parts)) },
    workspace: {
        getConfiguration: () => ({ get: (_key, fallback) => fallback }),
        fs: {
            stat: async selected => { state.stats.push(selected); return { size: state.size }; },
            readFile: async selected => { state.reads.push(selected); return Uint8Array.from([1, 2, 3]); },
        },
    },
    window: {
        showOpenDialog: async options => {
            state.dialogs.push(options);
            return state.selection;
        },
        showErrorMessage: message => { state.errors.push(message); },
    },
};
const originalLoad = Module._load;
Module._load = function (name, ...args) {
    return name === 'vscode' ? vscodeMock : originalLoad.call(this, name, ...args);
};
let MarkdownEditorProvider;
try {
    ({ MarkdownEditorProvider } = require('../out/editor/MarkdownEditorProvider'));
} finally {
    Module._load = originalLoad;
}

function fixture() {
    state = { selection: [uri('/outside-workspace/diagram.png')], size: 3, dialogs: [], stats: [], reads: [], errors: [] };
    const provider = new MarkdownEditorProvider({});
    const saves = [];
    const messages = [];
    provider.saveImageBytes = async (...args) => { saves.push(args); };
    const webview = { postMessage: async message => { messages.push(message); return true; } };
    const document = { uri: uri('/workspace/doc.md') };
    const requestId = 'image-insert-123-1';
    return { provider, saves, messages, webview, document, requestId };
}

test('the image picker imports the user-selected file and preserves the insertion request', async () => {
    const f = fixture();
    await f.provider.pickImageForInsertion(f.document, f.webview, f.requestId);

    assert.equal(state.dialogs.length, 1);
    assert.equal(state.dialogs[0].canSelectFiles, true);
    assert.equal(state.dialogs[0].canSelectFolders, false);
    assert.equal(state.dialogs[0].canSelectMany, false);
    assert.equal(state.dialogs[0].defaultUri.path, '/workspace');
    assert.ok(state.dialogs[0].filters.images.includes('png'));
    assert.equal(state.reads[0].path, '/outside-workspace/diagram.png');
    assert.equal(f.saves.length, 1);
    assert.deepEqual(Array.from(f.saves[0][0]), [1, 2, 3]);
    assert.equal(f.saves[0][1], 'image/png');
    assert.deepEqual(f.saves[0][4], { requestId: f.requestId, altText: 'diagram' });
    assert.deepEqual(f.messages, []);
});

test('cancelling the picker releases the pending insertion without reading or saving a file', async () => {
    const f = fixture();
    state.selection = undefined;
    await f.provider.pickImageForInsertion(f.document, f.webview, f.requestId);

    assert.deepEqual(state.reads, []);
    assert.deepEqual(f.saves, []);
    assert.deepEqual(state.errors, []);
    assert.deepEqual(f.messages, [{ type: 'imageInsertFailed', requestId: f.requestId }]);
    assert.equal(f.provider.imagePickerOpen, false);
});

test('an oversized chosen image is rejected before reading or saving it', async () => {
    const f = fixture();
    state.size = 21 * 1024 * 1024;
    await f.provider.pickImageForInsertion(f.document, f.webview, f.requestId);

    assert.deepEqual(state.reads, []);
    assert.deepEqual(f.saves, []);
    assert.match(state.errors[0], /Image is too large/);
    assert.deepEqual(f.messages, [{ type: 'imageInsertFailed', requestId: f.requestId }]);
});

test('a repeated request cannot open another picker while the first one is pending', async () => {
    const f = fixture();
    let completePicker;
    state.selection = new Promise(resolve => { completePicker = resolve; });
    const first = f.provider.pickImageForInsertion(f.document, f.webview, f.requestId);
    await f.provider.pickImageForInsertion(f.document, f.webview, 'image-insert-123-2');
    assert.equal(state.dialogs.length, 1);
    assert.deepEqual(f.messages, [{ type: 'imageInsertFailed', requestId: 'image-insert-123-2' }]);
    completePicker([uri('/outside-workspace/diagram.png')]);
    await first;
    assert.equal(f.saves.length, 1);
    assert.equal(f.provider.imagePickerOpen, false);
});

test('invalid insertion requests do not open a picker', async () => {
    const f = fixture();
    await f.provider.pickImageForInsertion(f.document, f.webview, '../../image.png');
    assert.deepEqual(state.dialogs, []);
    assert.deepEqual(state.reads, []);
    assert.deepEqual(f.saves, []);
});
