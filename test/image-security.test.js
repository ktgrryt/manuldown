const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fileURLToPath, pathToFileURL } = require('node:url');

function uri(uriPath, scheme = 'file', authority = '') {
    const value = `${scheme}://${authority}${uriPath.split('/').map(encodeURIComponent).join('/')}`;
    return {
        scheme, authority, path: uriPath,
        fsPath: scheme === 'file' ? fileURLToPath(value) : '',
        toString: () => value,
        with: changes => uri(changes.path ?? uriPath, changes.scheme ?? scheme, changes.authority ?? authority),
    };
}
function fileUri(nativePath) {
    const url = pathToFileURL(nativePath);
    return uri(decodeURIComponent(url.pathname), 'file', url.host);
}

let state;
const vscodeMock = {
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: {
        file: fileUri,
        parse: value => {
            const url = new URL(value);
            return uri(decodeURIComponent(url.pathname), url.protocol.slice(0, -1), url.host);
        },
        joinPath: (base, ...parts) => uri(path.posix.join(base.path, ...parts), base.scheme, base.authority),
    },
    workspace: {
        getConfiguration: () => ({ get: (key, fallback) => state.settings[key] ?? fallback }),
        fs: {
            stat: async selected => {
                state.stats.push(selected.fsPath);
                const stat = await fs.stat(selected.fsPath);
                const entry = await fs.lstat(selected.fsPath);
                return { size: stat.size, type: (stat.isDirectory() ? 2 : 1) | (entry.isSymbolicLink() ? 64 : 0) };
            },
            readFile: async selected => {
                state.reads.push(selected.fsPath);
                return fs.readFile(selected.fsPath);
            },
        },
    },
    window: {
        showOpenDialog: async () => state.selection,
        showErrorMessage: message => state.errors.push(message),
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

const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==', 'base64');
const dataUrl = `data:image/png;base64,${imageBytes.toString('base64')}`;

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manuldown-image-security-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    state = { settings: {}, stats: [], reads: [], errors: [], selection: undefined };
    const messages = [];
    const provider = new MarkdownEditorProvider({});
    const document = { uri: fileUri(path.join(workspace, 'doc.md')) };
    const webview = {
        postMessage: async message => { messages.push(message); return true; },
        asWebviewUri: selected => ({ toString: () => `webview-resource:${selected.path}` }),
    };
    return { root, workspace, outside, provider, document, webview, messages, state,
        imageDirectory: path.join(workspace, 'images', 'doc') };
}

test('local URI strings cannot grant file access, even with forged source metadata', async t => {
    const f = await fixture(t);
    const secret = path.join(f.outside, 'secret');
    await fs.writeFile(secret, 'DUMMY_SECRET');
    f.state.settings['security.allowRemoteImageImport'] = true;
    f.state.settings['security.allowFileLinks'] = true;
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        for (const source of ['drop', 'paste', 'internal', 'unknown']) {
            for (const value of [pathToFileURL(secret).href, secret, '../outside/secret', './local.png']) {
                await f.provider.saveImageFromUri(value, f.document, f.webview,
                    { source, requestId: 'image-insert-123-1' });
            }
        }
    } finally {
        console.error = originalConsoleError;
    }
    assert.deepEqual(f.state.stats, []);
    assert.deepEqual(f.state.reads, []);
    assert.equal(f.state.errors.length, 16);
    assert.ok(f.state.errors.every(message => /Local image URLs cannot be imported/.test(message)));
    assert.ok(f.messages.every(message => message.type === 'imageInsertFailed'));
    assert.deepEqual(await fs.readdir(f.workspace), []);
});

test('the Webview refuses local URLs supplied through every drag string format', () => {
    const source = syncFs.readFileSync(path.join(__dirname, '..', 'media/editor.js'), 'utf8');
    const start = source.indexOf('        const isImagePathLike = (value) => {');
    const end = source.indexOf('        const moveCaretToClientPoint =', start);
    const extract = new Function(`${source.slice(start, end)};return extractImageUriFromDataTransfer;`)();
    const policyStart = source.indexOf('    function isImportableImageUri(');
    const policyEnd = source.indexOf('\n    }\n', policyStart) + '\n    }'.length;
    const permits = new Function('settingsState', 'isWebviewResourceUrl',
        `${source.slice(policyStart, policyEnd)};return isImportableImageUri;`
    )({ allowRemoteImageImport: true }, raw => raw.includes('vscode-resource'));
    const local = 'file:///private/secret.png';
    for (const [type, payload] of [
        ['text/uri-list', local], ['public.file-url', local], ['public.url', local],
        ['DownloadURL', `image/png:photo.png:${local}`], ['text/x-moz-url', `${local}\nphoto`],
        ['text/plain', local], ['text/html', `<img src="${local}">`],
    ]) {
        const value = extract({ getData: requested => requested === type ? payload : '' });
        assert.equal(value, local, type);
        assert.equal(permits(value, 'drop'), false, type);
    }
    assert.equal(permits('/private/secret.png', 'drop'), false);
    assert.equal(permits('https://file+.vscode-resource.vscode-cdn.net/secret.png'), false);
    assert.equal(permits(dataUrl), true);
    assert.equal(permits('https://example.com/image.png'), true);
});

test('data URL images still save and insert normally on the local filesystem', async t => {
    const f = await fixture(t);
    assert.equal(await f.provider.saveImageFromDataUrl(dataUrl, 'image/png', f.document, f.webview,
        { requestId: 'image-insert-123-1' }), true);
    assert.deepEqual(await fs.readFile(path.join(f.imageDirectory, 'doc.png')), imageBytes);
    assert.equal(f.messages[0].type, 'insertImage');
    assert.equal(f.messages[0].markdown, '![image](images/doc/doc.png)');
    assert.equal(f.messages[0].requestId, 'image-insert-123-1');
    assert.equal(f.messages[1].type, 'requestSync');
    assert.equal(f.provider.pendingImageSavePaths.size, 0);
});

test('the image picker can still import an explicitly selected outside file', async t => {
    const f = await fixture(t);
    const selected = path.join(f.outside, 'selected.png');
    await fs.writeFile(selected, imageBytes);
    f.state.selection = [fileUri(selected)];
    await f.provider.pickImageForInsertion(f.document, f.webview, 'image-insert-123-1');
    assert.deepEqual(f.state.reads, [selected]);
    assert.deepEqual(await fs.readFile(path.join(f.imageDirectory, 'doc.png')), imageBytes);
    assert.equal(f.messages[0].markdown, '![selected](images/doc/doc.png)');
    assert.deepEqual(f.state.errors, []);
});

test('remote image import still requires the user setting and accepts HTTPS when enabled', async t => {
    const f = await fixture(t);
    let downloads = 0;
    f.provider.fetchRemoteImage = async () => { downloads++; return { bytes: imageBytes, mimeType: 'image/png' }; };
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        await f.provider.saveImageFromUri('https://example.com/photo.png', f.document, f.webview);
        assert.equal(downloads, 0);
        f.state.settings['security.allowRemoteImageImport'] = true;
        await f.provider.saveImageFromUri('https://example.com/photo.png', f.document, f.webview,
            { requestId: 'image-insert-123-1' });
    } finally {
        console.error = originalConsoleError;
    }
    assert.equal(downloads, 1);
    assert.deepEqual(await fs.readFile(path.join(f.imageDirectory, 'doc.png')), imageBytes);
    assert.equal(f.messages[0].type, 'insertImage');
});

for (const nested of [false, true]) {
    test(`image saving rejects an outside directory symlink at ${nested ? 'images/doc' : 'images'}`, async t => {
        if (process.platform === 'win32') return t.skip('Directory symlinks require additional Windows privileges');
        const f = await fixture(t);
        const link = nested ? f.imageDirectory : path.join(f.workspace, 'images');
        if (nested) await fs.mkdir(path.join(f.workspace, 'images'));
        await fs.symlink(f.outside, link);
        await assert.rejects(f.provider.saveImageBytes(imageBytes, 'image/png', f.document, f.webview), /symbolic link/);
        assert.deepEqual(await fs.readdir(f.outside), []);
        assert.deepEqual(f.messages, []);
        assert.equal(f.provider.pendingImageSavePaths.size, 0);
    });
}

test('dangling directory symlinks are rejected without creating their targets', async t => {
    if (process.platform === 'win32') return t.skip('Directory symlinks require additional Windows privileges');
    const f = await fixture(t);
    const missing = path.join(f.outside, 'missing');
    await fs.symlink(missing, path.join(f.workspace, 'images'));
    await assert.rejects(f.provider.saveImageBytes(imageBytes, 'image/png', f.document, f.webview), /symbolic link/);
    assert.deepEqual(await fs.readdir(f.outside), []);
});

test('directory symlinks inside the document and ordinary files cannot act as save directories', async t => {
    const f = await fixture(t);
    const images = path.join(f.workspace, 'images');
    await fs.writeFile(images, 'EXISTING');
    await assert.rejects(f.provider.saveImageBytes(imageBytes, 'image/png', f.document, f.webview), /must be a directory/);
    assert.equal(await fs.readFile(images, 'utf8'), 'EXISTING');
    if (process.platform === 'win32') return;
    await fs.unlink(images);
    const actual = path.join(f.workspace, 'actual-images');
    await fs.mkdir(actual);
    await fs.symlink(actual, images);
    await assert.rejects(f.provider.saveImageBytes(imageBytes, 'image/png', f.document, f.webview), /symbolic link/);
    assert.deepEqual(await fs.readdir(actual), []);
});

test('a save directory replaced by a symlink before filename reservation is rejected', async t => {
    if (process.platform === 'win32') return t.skip('Directory symlinks require additional Windows privileges');
    const f = await fixture(t);
    const reserve = f.provider.reserveImageSaveTarget.bind(f.provider);
    f.provider.reserveImageSaveTarget = async (...args) => {
        const images = path.join(f.workspace, 'images');
        await fs.rename(images, path.join(f.workspace, 'original-images'));
        await fs.symlink(f.outside, images);
        return reserve(...args);
    };
    await assert.rejects(f.provider.saveImageBytes(imageBytes, 'image/png', f.document, f.webview), /symbolic link/);
    assert.deepEqual(await fs.readdir(f.outside), []);
    assert.deepEqual(f.messages, []);
});

test('remote filesystem directory validation rejects symbolic-link components', async t => {
    const f = await fixture(t);
    const originalStat = vscodeMock.workspace.fs.stat;
    const root = uri('/workspace', 'vscode-remote', 'test');
    vscodeMock.workspace.fs.stat = async selected => ({ size: 0,
        type: selected.path === '/workspace/images' ? 2 | 64 : 2 });
    try {
        await assert.rejects(f.provider.assertImageSaveDirectory(
            uri('/workspace/images/doc', 'vscode-remote', 'test'), root), /symbolic link/);
    } finally {
        vscodeMock.workspace.fs.stat = originalStat;
    }
});

test('existing image files and dangling file symlinks are never overwritten or followed', async t => {
    if (process.platform === 'win32') return t.skip('File symlinks require additional Windows privileges');
    const f = await fixture(t);
    await fs.mkdir(f.imageDirectory, { recursive: true });
    const existing = path.join(f.imageDirectory, 'doc.png');
    const secret = path.join(f.outside, 'secret');
    const missing = path.join(f.outside, 'missing');
    await fs.writeFile(existing, 'EXISTING');
    await fs.writeFile(secret, 'DUMMY_SECRET');
    await fs.symlink(secret, path.join(f.imageDirectory, 'doc-2.png'));
    await fs.symlink(missing, path.join(f.imageDirectory, 'doc-3.png'));
    await f.provider.saveImageBytes(imageBytes, 'image/png', f.document, f.webview);
    assert.equal(await fs.readFile(existing, 'utf8'), 'EXISTING');
    assert.equal(await fs.readFile(secret, 'utf8'), 'DUMMY_SECRET');
    await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(path.join(f.imageDirectory, 'doc-4.png')), imageBytes);
    assert.equal(f.messages[0].markdown, '![image](images/doc/doc-4.png)');
});

test('independent editor providers create distinct files during simultaneous image imports', async t => {
    const f = await fixture(t);
    const other = new MarkdownEditorProvider({});
    await Promise.all([
        f.provider.saveImageBytes(imageBytes, 'image/png', f.document, f.webview),
        other.saveImageBytes(Buffer.from([1, 2, 3]), 'image/png', f.document, f.webview),
    ]);
    assert.deepEqual((await fs.readdir(f.imageDirectory)).sort(), ['doc-2.png', 'doc.png']);
    const contents = await Promise.all(['doc.png', 'doc-2.png'].map(name => fs.readFile(path.join(f.imageDirectory, name))));
    assert.ok(contents.some(bytes => bytes.equals(imageBytes)));
    assert.ok(contents.some(bytes => bytes.equals(Buffer.from([1, 2, 3]))));
    assert.equal(new Set(f.messages.filter(message => message.type === 'insertImage').map(message => message.markdown)).size, 2);
    assert.equal(f.provider.pendingImageSavePaths.size, 0);
    assert.equal(other.pendingImageSavePaths.size, 0);
});

test('KaTeX ignores inherited trust settings and its shipped bundle uses the installed version', () => {
    const katex = require('katex');
    const html = katex.renderToString('\\href{javascript:alert(1)}{x}', Object.create({ trust: true }));
    assert.doesNotMatch(html, /href="javascript:/);
    const { version } = require('katex/package.json');
    const shipped = syncFs.readFileSync(path.join(__dirname, '..', 'media/vendor/katex/katex.min.js'), 'utf8');
    assert.ok(shipped.startsWith(`/*! KaTeX ${version} |`));
    assert.equal(require.resolve('katex', { paths: [require.resolve('mermaid/package.json')] }), require.resolve('katex'));
});
