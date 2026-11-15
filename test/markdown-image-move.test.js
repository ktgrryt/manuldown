const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { collectMarkdownFilePaths } = require('../out/utils/markdownImagePaths');

function uri(uriPath, scheme = 'file', authority = '', query = '', fragment = '') {
    const encodedPath = uriPath.split('/').map(encodeURIComponent).join('/');
    const value = `${scheme}://${authority}${encodedPath}${query ? `?${query}` : ''}${fragment ? `#${fragment}` : ''}`;
    return {
        scheme, authority, path: uriPath, query, fragment,
        fsPath: scheme === 'file' ? fileURLToPath(value) : uriPath,
        toString: () => value,
        with: changes => uri(changes.path ?? uriPath, changes.scheme ?? scheme,
            changes.authority ?? authority, changes.query ?? query, changes.fragment ?? fragment),
    };
}
function fileUri(nativePath) {
    const url = pathToFileURL(nativePath);
    return uri(decodeURIComponent(url.pathname), 'file', url.host);
}
class Position {
    constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
    constructor(start, end, endLine, endCharacter) {
        if (typeof start === 'number') {
            this.start = new Position(start, end);
            this.end = new Position(endLine, endCharacter);
        } else {
            this.start = start;
            this.end = end;
        }
    }
}
class WorkspaceEdit {
    constructor() { this.operations = []; }
    renameFile(oldUri, newUri, options) { this.operations.push({ kind: 'rename', oldUri, newUri, options }); }
    createFile(selected, options) { this.operations.push({ kind: 'create', uri: selected, options }); }
    deleteFile(selected, options) { this.operations.push({ kind: 'delete', uri: selected, options }); }
    replace(selected, range, newText) { this.operations.push({ kind: 'replace', uri: selected, range, newText }); }
    set(selected, edits) { for (const edit of edits) this.replace(selected, edit.range, edit.newText); }
    get(selected) { return this.operations.filter(op => op.kind === 'replace' && op.uri.toString() === selected.toString()); }
    entries() {
        return [...new Map(this.operations.filter(op => op.kind === 'replace')
            .map(op => [op.uri.toString(), op.uri])).values()].map(selected => [selected, this.get(selected)]);
    }
    get size() { return this.operations.length; }
}
function document(selected, text, dirty = false) {
    const doc = {
        uri: selected, languageId: 'markdown', version: 1, isDirty: dirty, isClosed: false,
        getText: range => range ? text.slice(doc.offsetAt(range.start), doc.offsetAt(range.end)) : text,
        positionAt: offset => {
            const lines = text.slice(0, offset).split('\n');
            return new Position(lines.length - 1, lines.at(-1).length);
        },
        offsetAt: position => {
            const lines = text.split('\n');
            return lines.slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) + position.character;
        },
        setText: value => { text = value; doc.version++; },
    };
    return doc;
}
function missing(error) {
    if (error.code === 'ENOENT') error.code = 'FileNotFound';
    return error;
}
let state;
const vscodeMock = {
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    Position, Range, WorkspaceEdit,
    Disposable: { from: (...items) => ({ dispose: () => { for (const item of items) item.dispose(); } }) },
    Uri: {
        file: fileUri,
        parse: value => {
            const url = new URL(value);
            return uri(decodeURIComponent(url.pathname), url.protocol.slice(0, -1), url.host,
                url.search.slice(1), url.hash.slice(1));
        },
        joinPath: (base, ...parts) => base.with({ path: path.posix.join(base.path, ...parts) }),
    },
    RelativePattern: class RelativePattern { constructor(baseUri, pattern) { this.baseUri = baseUri; this.pattern = pattern; } },
    workspace: {
        get isTrusted() { return state.trusted; },
        get workspaceFolders() { return state.workspaceRoots.map(root => ({ uri: fileUri(root) })); },
        get textDocuments() { return [...state.documents.values()]; },
        getWorkspaceFolder: selected => {
            const root = state.workspaceRoots.find(root => selected.fsPath === root || selected.fsPath.startsWith(root + path.sep));
            return root ? { uri: fileUri(root) } : undefined;
        },
        getConfiguration: section => ({ get: (key, fallback) => state.settings[`${section}.${key}`] ?? state.settings[key] ?? fallback }),
        openTextDocument: async selected => {
            if (state.documents.has(selected.toString())) return state.documents.get(selected.toString());
            const doc = document(selected, await fs.readFile(selected.fsPath, 'utf8'));
            state.documents.set(selected.toString(), doc);
            return doc;
        },
        findFiles: async (_include, _exclude, maxResults) => {
            if (state.findFilesError) throw state.findFilesError;
            const files = [];
            const walk = async directory => {
                for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                    const nativePath = path.join(directory, entry.name);
                    if (entry.isDirectory()) await walk(nativePath);
                    else if (/\.(?:md|markdown)$/i.test(entry.name)) files.push(fileUri(nativePath));
                }
            };
            for (const root of state.workspaceRoots) await walk(root);
            return files.slice(0, maxResults ?? files.length);
        },
        onDidRenameFiles: listener => {
            state.renameListeners.push(listener);
            return { dispose: () => { state.renameListeners = state.renameListeners.filter(value => value !== listener); } };
        },
        onDidDeleteFiles: listener => {
            state.deleteListeners.push(listener);
            return { dispose: () => { state.deleteListeners = state.deleteListeners.filter(value => value !== listener); } };
        },
        onWillRenameFiles: listener => {
            state.listeners.push(listener);
            return { dispose: () => { state.listeners = state.listeners.filter(value => value !== listener); } };
        },
        fs: {
            stat: async selected => {
                try {
                    const entry = await fs.lstat(selected.fsPath);
                    let target = entry;
                    if (entry.isSymbolicLink()) {
                        try { target = await fs.stat(selected.fsPath); } catch {}
                    }
                    return { size: target.size, type: (target.isDirectory() ? 2 : (target.isFile() ? 1 : 0)) |
                        (entry.isSymbolicLink() ? 64 : 0), ctime: target.ctimeMs, mtime: target.mtimeMs };
                } catch (error) { throw missing(error); }
            },
            readFile: async selected => {
                state.reads.push(selected.fsPath);
                if (state.failedReads.has(selected.fsPath)) throw new Error('Unreadable document');
                try { return await fs.readFile(selected.fsPath); } catch (error) { throw missing(error); }
            },
            readDirectory: async selected => {
                try {
                    const entries = await fs.readdir(selected.fsPath, { withFileTypes: true });
                    return entries.map(entry => [entry.name, entry.isSymbolicLink() ? 64 : entry.isDirectory() ? 2 : 1]);
                } catch (error) { throw missing(error); }
            },
        },
    },
    window: { showWarningMessage: message => { state.warnings.push(message); return Promise.resolve(undefined); } },
};
const originalLoad = Module._load;
Module._load = function (name, ...args) {
    return name === 'vscode' ? vscodeMock : originalLoad.call(this, name, ...args);
};
let MarkdownImageMover, registerMarkdownImageMover;
try {
    ({ MarkdownImageMover, registerMarkdownImageMover } = require('../out/editor/MarkdownImageMover'));
} finally {
    Module._load = originalLoad;
}
const uncancelled = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manuldown-image-move-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    state = { workspaceRoots: [workspace], documents: new Map(), settings: {}, trusted: true,
        listeners: [], renameListeners: [], deleteListeners: [], warnings: [], reads: [], failedReads: new Set() };
    const selected = relative => fileUri(path.join(workspace, relative));
    const write = async (relative, contents) => {
        const target = selected(relative);
        await fs.mkdir(path.dirname(target.fsPath), { recursive: true });
        await fs.writeFile(target.fsPath, contents);
        return target;
    };
    const read = relative => fs.readFile(selected(relative).fsPath, 'utf8');
    const exists = async relative => { try { await fs.lstat(selected(relative).fsPath); return true; } catch { return false; } };
    const mover = new MarkdownImageMover();
    const plan = (oldPath = 'docs/doc.md', newPath = 'archive/doc.md', token = uncancelled) =>
        mover.createEdit([{ oldUri: selected(oldPath), newUri: selected(newPath) }], token);
    // Apply returned edits, then the user's original rename. Keep inverse operations
    // so the same file operation can be checked as a complete undoable unit.
    const apply = async (edit, renames = [{ oldUri: selected('docs/doc.md'), newUri: selected('archive/doc.md') }]) => {
        const inverses = [];
        const operations = [...edit.operations, ...renames.map(file => ({ kind: 'rename', ...file }))];
        const textBefore = new Map();
        for (const op of operations) {
            if (op.kind === 'replace') {
                if (!textBefore.has(op.uri.toString())) {
                    const doc = state.documents.get(op.uri.toString());
                    textBefore.set(op.uri.toString(), doc?.getText() ?? await fs.readFile(op.uri.fsPath, 'utf8'));
                }
            }
        }
        const textApplied = new Set();
        for (const op of operations) {
            if (op.kind === 'replace') {
                const key = op.uri.toString();
                if (textApplied.has(key)) continue;
                textApplied.add(key);
                const before = textBefore.get(key);
                const doc = document(op.uri, before);
                let after = before;
                const edits = operations.filter(candidate => candidate.kind === 'replace' && candidate.uri.toString() === key)
                    .map(candidate => ({ ...candidate, start: doc.offsetAt(candidate.range.start), end: doc.offsetAt(candidate.range.end) }))
                    .sort((a, b) => b.start - a.start);
                for (const replacement of edits) after = after.slice(0, replacement.start) + replacement.newText + after.slice(replacement.end);
                await fs.writeFile(op.uri.fsPath, after);
                state.documents.get(key)?.setText(after);
                inverses.push(async () => {
                    await fs.writeFile(op.uri.fsPath, before);
                    state.documents.get(key)?.setText(before);
                });
            } else if (op.kind === 'rename') {
                await fs.mkdir(path.dirname(op.newUri.fsPath), { recursive: true });
                await fs.rename(op.oldUri.fsPath, op.newUri.fsPath);
                inverses.push(async () => {
                    await fs.mkdir(path.dirname(op.oldUri.fsPath), { recursive: true });
                    await fs.rename(op.newUri.fsPath, op.oldUri.fsPath);
                });
            } else if (op.kind === 'create') {
                await fs.mkdir(path.dirname(op.uri.fsPath), { recursive: true });
                await fs.writeFile(op.uri.fsPath, op.options?.contents ?? '', { flag: 'wx' });
                inverses.push(async () => fs.unlink(op.uri.fsPath));
            } else if (op.kind === 'delete') {
                const entry = await fs.lstat(op.uri.fsPath);
                if (entry.isDirectory()) {
                    assert.equal(op.options?.recursive, false, 'directory cleanup must explicitly be non-recursive');
                    await fs.rmdir(op.uri.fsPath);
                    inverses.push(async () => fs.mkdir(op.uri.fsPath));
                } else {
                    const before = await fs.readFile(op.uri.fsPath);
                    await fs.unlink(op.uri.fsPath);
                    inverses.push(async () => {
                        await fs.mkdir(path.dirname(op.uri.fsPath), { recursive: true });
                        await fs.writeFile(op.uri.fsPath, before, { flag: 'wx' });
                    });
                }
            } else {
                throw new Error(`Unexpected operation: ${op.kind}`);
            }
        }
        await mover.cleanupEmptyImageDirectories(operations.filter(op => op.kind === 'rename' || op.kind === 'delete')
            .map(op => op.kind === 'rename' ? op.oldUri : op.uri));
        const undo = async () => {
            for (const inverse of [...inverses].reverse()) await inverse();
            await mover.cleanupEmptyImageDirectories(operations.filter(op => op.kind === 'rename' || op.kind === 'create')
                .map(op => op.kind === 'rename' ? op.newUri : op.uri));
        };
        undo.redo = () => apply(edit, renames);
        return undo;
    };
    return { root, workspace, state, selected, write, read, exists, plan, apply, mover };
}
function assetOperations(edit) { return edit.operations.filter(op => op.kind === 'create' || op.kind === 'rename'); }

test('moving only a Markdown file also moves its referenced dedicated images without changing the relative path', async t => {
    const f = await fixture(t);
    const markdown = '# Notes\n\n![image](images/doc/doc.png)\n';
    await f.write('docs/doc.md', markdown);
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    await f.write('docs/images/doc/unused.png', 'UNUSED');
    const edit = await f.plan();
    assert.equal(await f.exists('archive/images/doc/doc.png'), false, 'planning must not change files');
    assert.equal(assetOperations(edit).length, 1);
    await f.apply(edit);
    assert.equal(await f.read('archive/doc.md'), markdown);
    assert.equal(await f.read('archive/images/doc/doc.png'), 'IMAGE');
    assert.equal(await f.exists('docs/images/doc/doc.png'), false);
    assert.equal(await f.read('docs/images/doc/unused.png'), 'UNUSED');
});

test('renaming Markdown changes its dedicated image directory and only the image URLs', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '*unchanged*  \r\n![description](images/doc/doc.png "caption")\r\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const edit = await f.plan('docs/doc.md', 'archive/renamed.md');
    await f.apply(edit, [{ oldUri: f.selected('docs/doc.md'), newUri: f.selected('archive/renamed.md') }]);
    assert.equal(await f.read('archive/renamed.md'), '*unchanged*  \r\n![description](images/renamed/doc.png "caption")\r\n');
    assert.equal(await f.read('archive/images/renamed/doc.png'), 'IMAGE');
});

test('ordinary links to an image inside the moved document follow its new location too', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n[download](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const edit = await f.plan('docs/doc.md', 'archive/renamed.md');
    await f.apply(edit, [{ oldUri: f.selected('docs/doc.md'), newUri: f.selected('archive/renamed.md') }]);
    assert.equal(await f.read('archive/renamed.md'), '![image](images/renamed/doc.png)\n[download](images/renamed/doc.png)\n');
});

test('images referenced by another Markdown document are copied and keep their existing references working', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'SHARED');
    await f.write('overview.md', '![shared](docs/images/doc/doc.png)\n');
    const edit = await f.plan();
    assert.equal(assetOperations(edit)[0].kind, 'create');
    await f.apply(edit);
    assert.equal(await f.read('archive/images/doc/doc.png'), 'SHARED');
    assert.equal(await f.read('docs/images/doc/doc.png'), 'SHARED');
    assert.equal(await f.read('overview.md'), '![shared](docs/images/doc/doc.png)\n');
});

test('normal links and unsaved Markdown references also protect shared image files', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'SHARED');
    const other = await f.write('other.md', '# No saved reference\n');
    state.documents.set(other.toString(), document(other, '[download](docs/images/doc/doc.png)\n', true));
    const edit = await f.plan();
    assert.equal(assetOperations(edit)[0].kind, 'create');
    await f.apply(edit);
    assert.equal(await f.read('docs/images/doc/doc.png'), 'SHARED');
});

test('occupied target image names are preserved and the moved Markdown uses a free numbered filename', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'SOURCE');
    await f.write('archive/images/doc/doc.png', 'EXISTING');
    await f.write('archive/images/doc/doc-2.png', 'EXISTING TWO');
    const edit = await f.plan();
    await f.apply(edit);
    assert.equal(await f.read('archive/doc.md'), '![image](images/doc/doc-3.png)\n');
    assert.equal(await f.read('archive/images/doc/doc.png'), 'EXISTING');
    assert.equal(await f.read('archive/images/doc/doc-2.png'), 'EXISTING TWO');
    assert.equal(await f.read('archive/images/doc/doc-3.png'), 'SOURCE');
});

test('multiple references to one image schedule a single move and update every occurrence', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![first](images/doc/doc.png)\n![second](./images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const edit = await f.plan('docs/doc.md', 'archive/renamed.md');
    assert.equal(assetOperations(edit).length, 1);
    await f.apply(edit, [{ oldUri: f.selected('docs/doc.md'), newUri: f.selected('archive/renamed.md') }]);
    assert.equal(await f.read('archive/renamed.md'), '![first](images/renamed/doc.png)\n![second](./images/renamed/doc.png)\n');
});

test('moving a document uses its current unsaved image references', async t => {
    const f = await fixture(t);
    const selected = await f.write('docs/doc.md', '# Saved document\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    state.documents.set(selected.toString(), document(selected, '# Unsaved\n![image](images/doc/doc.png)\n', true));
    const edit = await f.plan();
    assert.equal(assetOperations(edit).length, 1);
    assert.equal(assetOperations(edit)[0].oldUri.path, f.selected('docs/images/doc/doc.png').path);
});

test('images outside the dedicated directory, remote images, and code examples are not moved', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', [
        '![shared](../assets/shared.png)',
        '![remote](https://example.com/image.png)',
        '`![example](images/doc/code.png)`',
        '```md', '![example](images/doc/fenced.png)', '```', '',
    ].join('\n'));
    await f.write('assets/shared.png', 'SHARED');
    await f.write('docs/images/doc/code.png', 'CODE');
    await f.write('docs/images/doc/fenced.png', 'FENCED');
    const edit = await f.plan();
    assert.deepEqual(edit.operations, []);
});

test('explicitly moving the parent folder needs no extra image operations', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const edit = await f.plan('docs', 'archive');
    assert.deepEqual(edit.operations, []);
});

test('images explicitly included in the same move are not renamed twice', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const files = [
        { oldUri: f.selected('docs/doc.md'), newUri: f.selected('archive/doc.md') },
        { oldUri: f.selected('docs/images/doc'), newUri: f.selected('archive/images/doc') },
    ];
    const edit = await f.mover.createEdit(files, uncancelled);
    assert.equal(assetOperations(edit).length, 0);
});

test('image destinations also avoid paths reserved by the original multi-file move', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'DOCUMENT IMAGE');
    await f.write('loose.png', 'SELECTED IMAGE');
    const files = [
        { oldUri: f.selected('docs/doc.md'), newUri: f.selected('archive/doc.md') },
        { oldUri: f.selected('loose.png'), newUri: f.selected('archive/images/doc/doc.png') },
    ];
    const edit = await f.mover.createEdit(files, uncancelled);
    await f.apply(edit, files);
    assert.equal(await f.read('archive/doc.md'), '![image](images/doc/doc-2.png)\n');
    assert.equal(await f.read('archive/images/doc/doc.png'), 'SELECTED IMAGE');
    assert.equal(await f.read('archive/images/doc/doc-2.png'), 'DOCUMENT IMAGE');
});

test('multiple documents moving to one directory reserve distinct image destinations', async t => {
    const f = await fixture(t);
    await f.write('one/doc.md', '![one](images/doc/doc.png)\n');
    await f.write('two/doc.md', '![two](images/doc/doc.png)\n');
    await f.write('one/images/doc/doc.png', 'ONE');
    await f.write('two/images/doc/doc.png', 'TWO');
    const files = [
        { oldUri: f.selected('one/doc.md'), newUri: f.selected('archive/first.md') },
        { oldUri: f.selected('two/doc.md'), newUri: f.selected('archive/second.md') },
    ];
    const edit = await f.mover.createEdit(files, uncancelled);
    const targets = assetOperations(edit).map(op => (op.newUri || op.uri).path);
    assert.equal(new Set(targets).size, 2);
    await f.apply(edit, files);
    assert.equal(await f.read('archive/images/first/doc.png'), 'ONE');
    assert.equal(await f.read('archive/images/second/doc.png'), 'TWO');
});

test('the Markdown move, rewritten reference, and image move form one reversible operation', async t => {
    const f = await fixture(t);
    const original = '![image](images/doc/doc.png)\n';
    await f.write('docs/doc.md', original);
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    await f.write('archive/images/doc/doc.png', 'EXISTING');
    const undo = await f.apply(await f.plan());
    assert.equal(await f.read('archive/doc.md'), '![image](images/doc/doc-2.png)\n');
    await undo();
    assert.equal(await f.read('docs/doc.md'), original);
    assert.equal(await f.read('docs/images/doc/doc.png'), 'IMAGE');
    assert.equal(await f.read('archive/images/doc/doc.png'), 'EXISTING');
    assert.equal(await f.exists('archive/doc.md'), false);
    assert.equal(await f.exists('archive/images/doc/doc-2.png'), false);
});

test('cancelling the file operation leaves every file and document unchanged', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const token = { ...uncancelled, isCancellationRequested: true };
    const edit = await f.plan('docs/doc.md', 'archive/doc.md', token);
    assert.deepEqual(edit.operations, []);
    assert.equal(await f.read('docs/images/doc/doc.png'), 'IMAGE');
    assert.equal(await f.exists('archive/doc.md'), false);
});

test('typing while images are inspected discards the stale move plan', async t => {
    const f = await fixture(t);
    const selected = await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const current = document(selected, '![image](images/doc/doc.png)\n', true);
    state.documents.set(selected.toString(), current);
    const originalStat = vscodeMock.workspace.fs.stat;
    vscodeMock.workspace.fs.stat = async image => {
        if (image.path === f.selected('docs/images/doc/doc.png').path) {
            current.setText('# New text\n');
        }
        return originalStat(image);
    };
    try {
        const edit = await f.plan();
        assert.deepEqual(edit.operations, []);
        assert.equal(current.getText(), '# New text\n');
        assert.equal(await f.read('docs/images/doc/doc.png'), 'IMAGE');
    } finally {
        vscodeMock.workspace.fs.stat = originalStat;
    }
});

test('cancellation during workspace scanning discards every prepared operation', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const token = { ...uncancelled, isCancellationRequested: false };
    const originalFindFiles = vscodeMock.workspace.findFiles;
    vscodeMock.workspace.findFiles = async (...args) => {
        const found = await originalFindFiles(...args);
        token.isCancellationRequested = true;
        return found;
    };
    try {
        const edit = await f.plan('docs/doc.md', 'archive/doc.md', token);
        assert.deepEqual(edit.operations, []);
        assert.equal(await f.read('docs/images/doc/doc.png'), 'IMAGE');
    } finally {
        vscodeMock.workspace.findFiles = originalFindFiles;
    }
});

for (const linkAt of ['source directory', 'source image', 'target directory']) {
    test(`image moves refuse a symbolic link at the ${linkAt}`, async t => {
        if (process.platform === 'win32') return t.skip('File symlinks require additional privileges');
        const f = await fixture(t);
        await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
        const outside = path.join(f.root, 'outside');
        await fs.mkdir(outside);
        await fs.writeFile(path.join(outside, 'doc.png'), 'OUTSIDE');
        if (linkAt === 'source directory') {
            await fs.mkdir(path.join(f.workspace, 'docs/images'), { recursive: true });
            await fs.symlink(outside, f.selected('docs/images/doc').fsPath);
        } else if (linkAt === 'source image') {
            await fs.mkdir(f.selected('docs/images/doc').fsPath, { recursive: true });
            await fs.symlink(path.join(outside, 'doc.png'), f.selected('docs/images/doc/doc.png').fsPath);
        } else {
            await f.write('docs/images/doc/doc.png', 'SOURCE');
            await fs.mkdir(f.selected('archive').fsPath, { recursive: true });
            await fs.symlink(outside, f.selected('archive/images').fsPath);
        }
        const edit = await f.plan();
        assert.equal(assetOperations(edit).length, 0);
        assert.equal(await fs.readFile(path.join(outside, 'doc.png'), 'utf8'), 'OUTSIDE');
    });
}

test('unreadable workspace Markdown is treated conservatively as potentially sharing the image', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const unreadable = await f.write('unreadable.md', '![shared](docs/images/doc/doc.png)\n');
    state.failedReads.add(unreadable.fsPath);
    const edit = await f.plan();
    assert.equal(assetOperations(edit)[0].kind, 'create');
});

test('the rename listener waits synchronously for its edit and can be disabled in settings', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const registration = registerMarkdownImageMover();
    assert.equal(state.listeners.length, 1);
    const promises = [];
    state.listeners[0]({ files: [{ oldUri: f.selected('docs/doc.md'), newUri: f.selected('archive/doc.md') }],
        token: uncancelled, waitUntil: promise => promises.push(promise) });
    assert.equal(promises.length, 1, 'waitUntil must be called before the event callback returns');
    assert.equal(assetOperations(await promises[0]).length, 1);
    state.settings['manulDown.images.moveWithDocument'] = false;
    const disabled = [];
    state.listeners[0]({ files: [{ oldUri: f.selected('docs/doc.md'), newUri: f.selected('archive/doc.md') }],
        token: uncancelled, waitUntil: promise => disabled.push(promise) });
    for (const promise of disabled) assert.deepEqual((await promise).operations, []);
    registration.dispose();
    assert.equal(state.listeners.length, 0);
});

for (const mode of ['always', 'prompt']) {
    test(`image moves defer to the built-in Markdown updater in ${mode} mode without changing files`, async t => {
        const f = await fixture(t);
        state.settings['markdown.updateLinksOnFileMove.enabled'] = mode;
        const original = '![image](images/doc/doc.png)\n';
        await f.write('docs/doc.md', original);
        await f.write('docs/images/doc/doc.png', 'DOCUMENT IMAGE');
        await f.write('archive/images/doc/doc.png', 'EXISTING');
        await f.write('overview.md', '![shared](docs/images/doc/doc.png)\n');
        const edit = await f.plan();
        assert.deepEqual(edit.operations, []);
        assert.equal(await f.read('docs/doc.md'), original);
        assert.equal(await f.read('docs/images/doc/doc.png'), 'DOCUMENT IMAGE');
        assert.equal(await f.read('archive/images/doc/doc.png'), 'EXISTING');
        assert.equal(await f.exists('archive/doc.md'), false);
        assert.equal(state.settings['markdown.updateLinksOnFileMove.enabled'], mode);
    });
}

for (const referenceStyle of ['file URI', 'absolute native path', 'workspace-relative root path']) {
    test(`a shared image referenced by a ${referenceStyle} is copied`, async t => {
        const f = await fixture(t);
        await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
        const image = await f.write('docs/images/doc/doc.png', 'SHARED');
        const href = referenceStyle === 'file URI' ? pathToFileURL(image.fsPath).href :
            referenceStyle === 'absolute native path' ? image.fsPath : '/docs/images/doc/doc.png';
        await f.write('overview.Md', `![shared](<${href}>)\n`);
        const edit = await f.plan();
        assert.equal(assetOperations(edit)[0].kind, 'create');
        const undo = await f.apply(edit);
        assert.equal(await f.read('docs/images/doc/doc.png'), 'SHARED');
        assert.equal(await f.read('archive/images/doc/doc.png'), 'SHARED');
        await undo();
        assert.equal(await f.read('docs/images/doc/doc.png'), 'SHARED');
        assert.equal(await f.exists('archive/images/doc/doc.png'), false);
    });
}

test('HTML image queries preserve entity escaping when the document is renamed', async t => {
    const f = await fixture(t);
    const original = '<img src="images/doc/doc.png?view=1&amp;zoom=2" alt="image">\n';
    await f.write('docs/doc.md', original);
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const edit = await f.plan('docs/doc.md', 'archive/renamed.md');
    await f.apply(edit, [{ oldUri: f.selected('docs/doc.md'), newUri: f.selected('archive/renamed.md') }]);
    assert.equal(await f.read('archive/renamed.md'), '<img src="images/renamed/doc.png?view=1&amp;zoom=2" alt="image">\n');
    assert.equal(await f.read('archive/images/renamed/doc.png'), 'IMAGE');
});

test('images and image download links inside footnotes follow a document rename', async t => {
    const f = await fixture(t);
    const original = 'Body[^note]\n\n[^note]: ![image](images/doc/doc.png "caption")\n    [download](images/doc/doc.png)\n';
    await f.write('docs/doc.md', original);
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const edit = await f.plan('docs/doc.md', 'archive/renamed.md');
    await f.apply(edit, [{ oldUri: f.selected('docs/doc.md'), newUri: f.selected('archive/renamed.md') }]);
    assert.equal(await f.read('archive/renamed.md'), original.replaceAll('images/doc/', 'images/renamed/'));
    assert.equal(await f.read('archive/images/renamed/doc.png'), 'IMAGE');
});

test('an explicit directory move into the image destination can complete without losing either image', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'DOCUMENT IMAGE');
    await f.write('incoming/doc.png', 'INCOMING IMAGE');
    const files = [
        { oldUri: f.selected('docs/doc.md'), newUri: f.selected('archive/doc.md') },
        { oldUri: f.selected('incoming'), newUri: f.selected('archive/images/doc') },
    ];
    const edit = await f.mover.createEdit(files, uncancelled);
    await f.apply(edit, files);
    const reference = collectMarkdownFilePaths(await f.read('archive/doc.md'))[0];
    const target = path.resolve(f.workspace, 'archive', decodeURIComponent(reference.path));
    assert.equal(await fs.readFile(target, 'utf8'), 'DOCUMENT IMAGE');
    assert.equal(await f.read('archive/images/doc/doc.png'), 'INCOMING IMAGE');
});

test('a regular file blocking the destination directory keeps the original image accessible', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'DOCUMENT IMAGE');
    await f.write('archive/images/doc', 'BLOCKER');
    const edit = await f.plan();
    assert.equal(assetOperations(edit).length, 0);
    await f.apply(edit);
    const reference = collectMarkdownFilePaths(await f.read('archive/doc.md'))[0];
    const target = path.resolve(f.workspace, 'archive', decodeURIComponent(reference.path));
    assert.equal(await fs.readFile(target, 'utf8'), 'DOCUMENT IMAGE');
    assert.equal(await f.read('archive/images/doc'), 'BLOCKER');
});

function directoryDeletes(edit) { return edit.operations.filter(op => op.kind === 'delete'); }

test('moving the last document image removes its empty dedicated folder and images parent', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const edit = await f.plan();
    assert.deepEqual(directoryDeletes(edit), [], 'directory cleanup runs after the successful file move');
    await f.apply(edit);
    assert.equal(await f.exists('docs/images/doc'), false);
    assert.equal(await f.exists('docs/images'), false);
    assert.equal(await f.exists('docs'), true, 'the Markdown parent itself remains');
    assert.equal(await f.read('archive/images/doc/doc.png'), 'IMAGE');
});

for (const retainedFile of ['unused.png', '.keep', '.DS_Store']) {
    test(`image cleanup preserves the source folders when ${retainedFile} remains`, async t => {
        const f = await fixture(t);
        await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
        await f.write('docs/images/doc/doc.png', 'IMAGE');
        await f.write(`docs/images/doc/${retainedFile}`, 'RETAINED');
        const edit = await f.plan();
        assert.deepEqual(directoryDeletes(edit), []);
        await f.apply(edit);
        assert.equal(await f.read(`docs/images/doc/${retainedFile}`), 'RETAINED');
        assert.equal(await f.exists('docs/images/doc'), true);
        assert.equal(await f.exists('docs/images'), true);
    });
}

test('image cleanup keeps folders containing shared images that were copied', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'SHARED');
    await f.write('overview.md', '![shared](docs/images/doc/doc.png)\n');
    const edit = await f.plan();
    assert.deepEqual(directoryDeletes(edit), []);
    await f.apply(edit);
    assert.equal(await f.read('docs/images/doc/doc.png'), 'SHARED');
    assert.equal(await f.exists('docs/images'), true);
});

test('nested empty image folders are cleaned from leaves upward and restored by Undo and Redo', async t => {
    const f = await fixture(t);
    const original = '![image](images/doc/nested/deep/doc.png)\n';
    await f.write('docs/doc.md', original);
    await f.write('docs/images/doc/nested/deep/doc.png', 'IMAGE');
    const edit = await f.plan();
    assert.deepEqual(directoryDeletes(edit), []);
    const undo = await f.apply(edit);
    assert.equal(await f.exists('docs/images'), false);
    assert.equal(await f.read('archive/images/doc/nested/deep/doc.png'), 'IMAGE');
    await undo();
    assert.equal(await f.read('docs/doc.md'), original);
    assert.equal(await f.read('docs/images/doc/nested/deep/doc.png'), 'IMAGE');
    assert.equal(await f.exists('archive/doc.md'), false);
    const undoAgain = await undo.redo();
    assert.equal(await f.exists('docs/images'), false);
    assert.equal(await f.read('archive/doc.md'), original);
    assert.equal(await f.read('archive/images/doc/nested/deep/doc.png'), 'IMAGE');
    await undoAgain();
    assert.equal(await f.read('docs/images/doc/nested/deep/doc.png'), 'IMAGE');
});

test('renaming within the same Markdown folder removes only the old dedicated image folder', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const files = [{ oldUri: f.selected('docs/doc.md'), newUri: f.selected('docs/renamed.md') }];
    const edit = await f.mover.createEdit(files, uncancelled);
    assert.deepEqual(directoryDeletes(edit), []);
    await f.apply(edit, files);
    assert.equal(await f.exists('docs/images/doc'), false);
    assert.equal(await f.read('docs/images/renamed/doc.png'), 'IMAGE');
    assert.equal(await f.read('docs/renamed.md'), '![image](images/renamed/doc.png)\n');
    assert.equal(await f.exists('docs/images'), true);
});

test('batch Markdown moves clean their common images parent once after both dedicated folders', async t => {
    const f = await fixture(t);
    await f.write('docs/one.md', '![one](images/one/one.png)\n');
    await f.write('docs/two.md', '![two](images/two/two.png)\n');
    await f.write('docs/images/one/one.png', 'ONE');
    await f.write('docs/images/two/two.png', 'TWO');
    const files = [
        { oldUri: f.selected('docs/one.md'), newUri: f.selected('archive/one.md') },
        { oldUri: f.selected('docs/two.md'), newUri: f.selected('archive/two.md') },
    ];
    const edit = await f.mover.createEdit(files, uncancelled);
    assert.deepEqual(directoryDeletes(edit), []);
    const undo = await f.apply(edit, files);
    assert.equal(await f.exists('docs/images'), false);
    assert.equal(await f.read('archive/images/one/one.png'), 'ONE');
    assert.equal(await f.read('archive/images/two/two.png'), 'TWO');
    await undo();
    assert.equal(await f.read('docs/images/one/one.png'), 'ONE');
    assert.equal(await f.read('docs/images/two/two.png'), 'TWO');
});

test('a file arriving after planning prevents empty-folder cleanup and is preserved', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const edit = await f.plan();
    assert.deepEqual(directoryDeletes(edit), []);
    await f.write('docs/images/doc/arrived-later.png', 'NEW CONTENT');
    await f.apply(edit);
    assert.equal(await f.read('archive/images/doc/doc.png'), 'IMAGE');
    assert.equal(await f.read('docs/images/doc/arrived-later.png'), 'NEW CONTENT');
    assert.equal(await f.exists('docs/images/doc'), true);
});

test('empty-folder cleanup leaves an explicitly selected source image directory for the original move', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const files = [
        { oldUri: f.selected('docs/doc.md'), newUri: f.selected('archive/doc.md') },
        { oldUri: f.selected('docs/images/doc'), newUri: f.selected('separate-images') },
    ];
    const edit = await f.mover.createEdit(files, uncancelled);
    assert.deepEqual(directoryDeletes(edit), []);
    await f.apply(edit, files);
    assert.equal(await f.read('separate-images/doc.png'), 'IMAGE');
    const reference = collectMarkdownFilePaths(await f.read('archive/doc.md'))[0];
    assert.equal(await fs.readFile(path.resolve(f.workspace, 'archive', decodeURIComponent(reference.path)), 'utf8'), 'IMAGE');
});

test('registered rename notifications clean source folders and clean the destination again after Undo', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'IMAGE');
    const cleanupTasks = [];
    const originalCleanup = MarkdownImageMover.prototype.cleanupEmptyImageDirectories;
    MarkdownImageMover.prototype.cleanupEmptyImageDirectories = function (...args) {
        const task = originalCleanup.apply(this, args);
        cleanupTasks.push(task);
        return task;
    };
    const registration = registerMarkdownImageMover();
    try {
        const files = [{ oldUri: f.selected('docs/doc.md'), newUri: f.selected('archive/doc.md') }];
        let planning;
        state.listeners[0]({ files, token: uncancelled, waitUntil: promise => { planning = promise; } });
        const edit = await planning;
        const undo = await f.apply(edit, files);
        const allRenames = [...edit.operations.filter(op => op.kind === 'rename'), ...files];
        state.renameListeners[0]({ files: allRenames });
        await Promise.all(cleanupTasks);
        assert.equal(await f.exists('docs/images'), false);
        await undo();
        state.renameListeners[0]({ files: allRenames.map(file => ({ oldUri: file.newUri, newUri: file.oldUri })) });
        await Promise.all(cleanupTasks);
        assert.equal(await f.read('docs/images/doc/doc.png'), 'IMAGE');
        assert.equal(await f.exists('archive/images'), false);
    } finally {
        registration.dispose();
        MarkdownImageMover.prototype.cleanupEmptyImageDirectories = originalCleanup;
    }
    assert.equal(state.listeners.length, 0);
    assert.equal(state.renameListeners.length, 0);
    assert.equal(state.deleteListeners.length, 0);
});

test('registered delete notifications clean copied-image folders when the document move is undone', async t => {
    const f = await fixture(t);
    await f.write('docs/doc.md', '![image](images/doc/doc.png)\n');
    await f.write('docs/images/doc/doc.png', 'SHARED');
    await f.write('overview.md', '![shared](docs/images/doc/doc.png)\n');
    const cleanupTasks = [];
    const originalCleanup = MarkdownImageMover.prototype.cleanupEmptyImageDirectories;
    MarkdownImageMover.prototype.cleanupEmptyImageDirectories = function (...args) {
        const task = originalCleanup.apply(this, args);
        cleanupTasks.push(task);
        return task;
    };
    const registration = registerMarkdownImageMover();
    try {
        const files = [{ oldUri: f.selected('docs/doc.md'), newUri: f.selected('archive/doc.md') }];
        let planning;
        state.listeners[0]({ files, token: uncancelled, waitUntil: promise => { planning = promise; } });
        const edit = await planning;
        const copy = edit.operations.find(op => op.kind === 'create');
        const undo = await f.apply(edit, files);
        await undo();
        state.deleteListeners[0]({ files: [copy.uri] });
        await Promise.all(cleanupTasks);
        assert.equal(await f.read('docs/images/doc/doc.png'), 'SHARED');
        assert.equal(await f.exists('archive/images'), false);
    } finally {
        registration.dispose();
        MarkdownImageMover.prototype.cleanupEmptyImageDirectories = originalCleanup;
    }
});
