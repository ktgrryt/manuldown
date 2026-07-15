const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    buildWorkspaceRelativeHref,
    encodeMarkdownRelativePath,
    extractMarkdownHeadings,
    isNativePathWithinDirectory,
    isUriLexicallyWithinDirectory,
    isUriSecurelyWithinDirectory,
    normalizeExternalLinkHref,
    sanitizeWorkspaceLinkDisplayText,
    slugifyMarkdownHeading,
} = require('../out/utils/workspaceLinks.js');

const providerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'editor', 'MarkdownEditorProvider.ts'),
    'utf8'
);
const pickerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'editor', 'WorkspaceLinkPicker.ts'),
    'utf8'
);
const editorSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'editor.js'),
    'utf8'
);
const toolbarSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'ToolbarManager.js'),
    'utf8'
);
const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'package.json'),
    'utf8'
));
const browserSlugSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'MarkdownHeadingSlug.js'),
    'utf8'
);
const browserSlugModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(browserSlugSource).toString('base64')}`
);
const workspaceLinkSecuritySource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'WorkspaceLinkSecurity.js'),
    'utf8'
);
const workspaceLinkSecurityModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(workspaceLinkSecuritySource).toString('base64')}`
);

function createFileUri(fsPath) {
    return {
        scheme: 'file',
        authority: '',
        path: fsPath.replace(/\\/g, '/'),
        fsPath,
    };
}

function createRemoteUri(uriPath, authority = 'remote') {
    return {
        scheme: 'vscode-remote',
        authority,
        path: uriPath,
        fsPath: uriPath,
    };
}

test('workspace hrefs are relative, prefixed, and encode hostile file-name characters', () => {
    const documentUri = createFileUri('/workspace/docs/current.md');

    assert.equal(
        buildWorkspaceRelativeHref(
            documentUri,
            createFileUri('/workspace/docs/javascript:alert (draft)#1?.md')
        ),
        './javascript%3Aalert%20%28draft%29%231%3F.md'
    );
    assert.equal(
        buildWorkspaceRelativeHref(
            documentUri,
            createFileUri('/workspace/assets/日本語 image.png')
        ),
        '../assets/%E6%97%A5%E6%9C%AC%E8%AA%9E%20image.png'
    );
    assert.equal(encodeMarkdownRelativePath('child/read me.md'), './child/read%20me.md');
    assert.equal(encodeMarkdownRelativePath('../up.md'), '../up.md');
});

test('same-document headings use a fragment and incompatible URI origins are rejected', () => {
    const documentUri = createFileUri('/workspace/docs/current.md');
    assert.equal(
        buildWorkspaceRelativeHref(documentUri, documentUri, 'hello-world'),
        '#hello-world'
    );
    assert.equal(
        buildWorkspaceRelativeHref(
            createRemoteUri('/workspace/current.md', 'first'),
            createRemoteUri('/workspace/target.md', 'second')
        ),
        null
    );
    assert.equal(
        buildWorkspaceRelativeHref(
            createRemoteUri('/workspace/current.md'),
            createFileUri('/workspace/target.md')
        ),
        null
    );
});

test('workspace boundary checks reject sibling-prefix and traversal paths', () => {
    const root = createRemoteUri('/workspace/root');
    assert.equal(
        isUriLexicallyWithinDirectory(createRemoteUri('/workspace/root/docs/a.md'), root),
        true
    );
    assert.equal(
        isUriLexicallyWithinDirectory(createRemoteUri('/workspace/root-evil/a.md'), root),
        false
    );
    assert.equal(
        isUriLexicallyWithinDirectory(createRemoteUri('/workspace/outside/a.md'), root),
        false
    );
    assert.equal(isNativePathWithinDirectory('/workspace/root/a', '/workspace/root'), true);
    assert.equal(isNativePathWithinDirectory('/workspace/root-evil/a', '/workspace/root'), false);
});

test('canonical workspace checks reject a local symlink that escapes the root', async (t) => {
    if (process.platform === 'win32') {
        t.skip('Creating symlinks is not reliably available in Windows CI');
        return;
    }

    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manuldown-link-'));
    const workspaceRoot = path.join(temporaryRoot, 'workspace');
    const outsideRoot = path.join(temporaryRoot, 'outside');
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(outsideRoot);
    fs.writeFileSync(path.join(workspaceRoot, 'safe.md'), '# safe\n');
    fs.writeFileSync(path.join(outsideRoot, 'secret.md'), '# secret\n');
    fs.symlinkSync(outsideRoot, path.join(workspaceRoot, 'escape'));

    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

    assert.equal(
        await isUriSecurelyWithinDirectory(
            createFileUri(path.join(workspaceRoot, 'safe.md')),
            createFileUri(workspaceRoot)
        ),
        true
    );
    assert.equal(
        await isUriSecurelyWithinDirectory(
            createFileUri(path.join(workspaceRoot, 'escape', 'secret.md')),
            createFileUri(workspaceRoot)
        ),
        false
    );
});

test('bounded heading extraction skips front matter and fences and creates stable duplicates', () => {
    const markdown = [
        '---',
        'title: "# not a heading"',
        '---',
        '# Hello *world*',
        '# Hello world',
        '',
        '```md',
        '# hidden',
        '```',
        '',
        '> ## 日本語 [リンク](./x.md)',
        '',
        'Setext `code`',
        '---',
    ].join('\n');

    assert.deepEqual(extractMarkdownHeadings(markdown), [
        { level: 1, label: 'Hello world', slug: 'hello-world' },
        { level: 1, label: 'Hello world', slug: 'hello-world-1' },
        { level: 2, label: '日本語 リンク', slug: '日本語-リンク' },
        { level: 2, label: 'Setext code', slug: 'setext-code' },
    ]);
    assert.equal(extractMarkdownHeadings('# one\n# two\n# three\n', 2).length, 2);
});

test('host and Webview heading sluggers stay aligned', async () => {
    const browserSlug = await browserSlugModulePromise;
    for (const value of [
        'Hello, World!',
        '日本語 見出し',
        'under_score and-dash',
        'Crème brûlée',
    ]) {
        assert.equal(browserSlug.slugifyMarkdownHeading(value), slugifyMarkdownHeading(value));
    }
});

test('picker labels remove controls, bidi overrides, and codicon impersonation', () => {
    assert.equal(
        sanitizeWorkspaceLinkDisplayText('safe\n$(warning)\u202Etxt.exe'),
        'safe $ (warning)txt.exe'
    );
});

test('external URL input is canonicalized without permitting dangerous schemes or spoofing', () => {
    assert.equal(
        normalizeExternalLinkHref('HTTPS://Example.COM/docs?q=1#intro'),
        'https://example.com/docs?q=1#intro'
    );
    assert.equal(
        normalizeExternalLinkHref('http://localhost:3000/path'),
        'http://localhost:3000/path'
    );
    assert.equal(
        normalizeExternalLinkHref('mailto:person@example.com'),
        'mailto:person@example.com'
    );

    for (const unsafeHref of [
        'javascript:alert(1)',
        'command:workbench.action.openSettings',
        'vscode://settings',
        'file:///tmp/secret',
        'data:text/html,<script>alert(1)</script>',
        'blob:https://example.com/id',
        'ftp://example.com/file',
        '//server/share',
        'example.com',
        'https:example.com',
        'https:\\evil.example',
        'https://trusted.example@evil.example/',
        'https://example.com/a b',
        ' https://example.com',
        'https://example.com\n',
        'https://example.com/line\nbreak',
        'https://example.com/%0d%0aheader',
        'https://example.com/%E2%80%AEspoof',
        '\u202ehttps://example.com',
        'mailto:',
        `https://example.com/${'a'.repeat(4096)}`,
    ]) {
        assert.equal(normalizeExternalLinkHref(unsafeHref), null, unsafeHref);
    }
});

test('Webview insertion validation keeps workspace and external link kinds separate', async () => {
    const { sanitizeInsertedLinkHref } = await workspaceLinkSecurityModulePromise;
    for (const safeHref of [
        './README.md',
        '../docs/a%20b.md#section',
        '#same-document',
        './javascript%3Aalert.md',
    ]) {
        assert.equal(sanitizeInsertedLinkHref(safeHref, 'workspace'), safeHref, safeHref);
        assert.equal(sanitizeInsertedLinkHref(safeHref, 'external'), null, safeHref);
    }

    for (const safeHref of [
        'https://example.com/',
        'http://localhost:3000/path?q=1#x',
        'mailto:person@example.com',
    ]) {
        assert.equal(sanitizeInsertedLinkHref(safeHref, 'external'), safeHref, safeHref);
        assert.equal(sanitizeInsertedLinkHref(safeHref, 'workspace'), null, safeHref);
    }

    for (const unsafeHref of [
        'javascript:alert(1)',
        'command:workbench.action.openSettings',
        'vscode://settings',
        'file:///tmp/secret',
        'data:text/html,unsafe',
        'blob:https://example.com/id',
        'ftp://example.com/file',
        '//server/share',
        '/absolute/path',
        'plain-relative.md',
        '.\\windows.md',
        './line\nbreak.md',
        '#two#fragments',
        'https:example.com',
        'https://trusted.example@evil.example/',
        'https://example.com/a b',
        ' https://example.com',
        'https://example.com\n',
        'mailto:person@example.com?body=%0d%0abcc:other@example.com',
        'https://example.com/%E2%80%AEspoof',
        '\u202ehttps://example.com',
    ]) {
        assert.equal(sanitizeInsertedLinkHref(unsafeHref, 'external'), null, unsafeHref);
    }
    assert.equal(sanitizeInsertedLinkHref('https://example.com/', undefined), null);
    assert.equal(
        sanitizeInsertedLinkHref(`https://example.com/${'a'.repeat(4096)}`, 'external'),
        null
    );
});

test('the native link picker offers URL and workspace targets without accepting Webview input', () => {
    assert.match(pickerSource, /targetKind: 'external'/);
    assert.match(pickerSource, /targetKind: 'workspace'/);
    assert.match(pickerSource, /vscode\.window\.showInputBox/);
    assert.match(pickerSource, /normalizeExternalLinkHref\(value\)/);
    assert.match(pickerSource, /const href = normalizeExternalLinkHref\(rawHref\)/);
    assert.match(pickerSource, /kind: 'external'/);
    assert.match(pickerSource, /kind: 'workspace'/);
    assert.doesNotMatch(pickerSource, /(?:fetch|openExternal)/);
    assert.ok(
        pickerSource.indexOf("targetKind: 'external'") <
        pickerSource.indexOf('vscode.workspace.findFiles'),
        'The URL choice should be available before any workspace scan'
    );
});

test('workspace picker protocol keeps discovery host-owned and request scoped', () => {
    const requestCaseStart = providerSource.indexOf("case 'requestWorkspaceLink':");
    const nextCaseStart = providerSource.indexOf("case 'openImage':", requestCaseStart);
    assert.ok(requestCaseStart >= 0 && nextCaseStart > requestCaseStart);
    const requestCase = providerSource.slice(requestCaseStart, nextCaseStart);

    assert.match(requestCase, /workspaceLinkRequestIdPattern\.test\(requestId\)/);
    assert.match(requestCase, /!webviewPanel\.active/);
    assert.match(requestCase, /if \(activeWorkspaceLinkRequest\)/);
    assert.match(requestCase, /this\.workspaceLinkPicker\.pick\(\s*document,/);
    assert.match(requestCase, /linkKind: selection\.kind/);
    assert.doesNotMatch(requestCase, /message\.(?:url|href|label|uri|path|root|glob|document)/);

    assert.match(pickerSource, /new vscode\.RelativePattern\(workspaceFolder, '\*\*\/\*'\)/);
    assert.match(pickerSource, /maxWorkspaceFiles = 2000/);
    assert.match(pickerSource, /maxMarkdownBytes = 1024 \* 1024/);
    assert.match(pickerSource, /isUriSecurelyWithinDirectory/);
    assert.doesNotMatch(pickerSource, /(?:fetch|openExternal)/);
});

test('Webview accepts picker results only for a live exact request and inserts text-only DOM', () => {
    assert.match(editorSource, /takePendingWorkspaceLinkInsertion\(requestId\)/);
    assert.match(editorSource, /pending\.revision !== localUpdateRevision/);
    assert.match(editorSource, /sanitizeInsertedLinkHref\(message\.href, message\.linkKind\)/);
    assert.match(editorSource, /document\.createElement\('a'\)/);
    assert.match(editorSource, /link\.textContent = label/);
    assert.match(editorSource, /stateManager\.beginChangeAtSelection\(insertionHistorySelection\)/);
    assert.match(editorSource, /stateManager\.commitStateAfterChange\(\{/);
    assert.match(editorSource, /case 'workspaceLinkCancelled':/);
    assert.match(editorSource, /discardPendingWorkspaceLinkInsertion/);
    assert.doesNotMatch(
        editorSource.slice(
            editorSource.indexOf('function insertSelectedWorkspaceLink'),
            editorSource.indexOf('function applySettings')
        ),
        /innerHTML/
    );
});

test('link entry points are contributed without stealing picker focus', () => {
    const command = packageJson.contributes.commands.find(
        (entry) => entry.command === 'manulDown.insertWorkspaceLink'
    );
    const keybinding = packageJson.contributes.keybindings.find(
        (entry) => entry.command === 'manulDown.insertWorkspaceLink'
    );
    assert.ok(command);
    assert.equal(command.title, 'Insert Link');
    assert.deepEqual(
        { key: keybinding.key, mac: keybinding.mac },
        { key: 'ctrl+k', mac: 'cmd+k' }
    );
    assert.match(editorSource, /id: 'link'[\s\S]*description: 'Insert a link'/);
    assert.match(toolbarSource, /command !== 'table' && command !== 'link'/);
    assert.match(toolbarSource, /\.toolbar > \.toolbar-btn/);
});

test('relative link and image opening uses canonical workspace validation', () => {
    const openLinkStart = providerSource.indexOf("case 'openLink':");
    const openLinkEnd = providerSource.indexOf("case 'writeClipboard':", openLinkStart);
    const openImageStart = providerSource.indexOf('private async openImageFile');
    const openImageEnd = providerSource.indexOf(
        'private async resolveImageSrcForWebview',
        openImageStart
    );
    assert.match(
        providerSource.slice(openLinkStart, openLinkEnd),
        /await isUriSecurelyWithinDirectory/
    );
    assert.match(
        providerSource.slice(openImageStart, openImageEnd),
        /await isUriSecurelyWithinDirectory/
    );
});
