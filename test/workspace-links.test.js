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
    normalizeNativeAbsolutePathForLink,
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
const editorCss = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'editor.css'),
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
        with: (changes) => createRemoteUri(
            changes.path ?? uriPath,
            changes.authority ?? authority
        ),
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

test('remote workspace checks reject symbolic links in any path component', async () => {
    const root = createRemoteUri('/workspace/root');
    const statTypes = new Map([
        ['/workspace/root', 2],
        ['/workspace/root/docs', 2],
        ['/workspace/root/docs/safe.md', 1],
        ['/workspace/root/escape', 2 | 64],
        ['/workspace/root/escape/secret.md', 1],
    ]);
    const readStat = async (uri) => {
        if (!statTypes.has(uri.path)) throw new Error('missing');
        return { type: statTypes.get(uri.path) };
    };

    assert.equal(
        await isUriSecurelyWithinDirectory(
            createRemoteUri('/workspace/root/docs/safe.md'),
            root,
            readStat
        ),
        true
    );
    assert.equal(
        await isUriSecurelyWithinDirectory(
            createRemoteUri('/workspace/root/escape/secret.md'),
            root,
            readStat
        ),
        false
    );
    assert.equal(
        await isUriSecurelyWithinDirectory(
            createRemoteUri('/workspace/root/docs/safe.md'),
            root
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

test('pasted native paths accept only bounded local absolute path syntax', () => {
    assert.equal(
        normalizeNativeAbsolutePathForLink('/workspace/docs/read me.md', 'darwin'),
        '/workspace/docs/read me.md'
    );
    assert.equal(
        normalizeNativeAbsolutePathForLink('/workspace/docs/../target#1.md', 'linux'),
        '/workspace/target#1.md'
    );
    assert.equal(
        normalizeNativeAbsolutePathForLink('C:/workspace/docs/read me.md', 'win32'),
        'C:\\workspace\\docs\\read me.md'
    );

    for (const unsafePath of [
        './target.md',
        '../target.md',
        '~/target.md',
        'file:///workspace/target.md',
        '//server/share/file.md',
        ' /workspace/target.md',
        '/workspace/target.md\n',
        '/workspace/\u202etarget.md',
        `/${'a'.repeat(4096)}`,
        'C:\\workspace\\target.md',
    ]) {
        assert.equal(normalizeNativeAbsolutePathForLink(unsafePath, 'linux'), null, unsafePath);
    }
    for (const unsafePath of [
        'C:relative.md',
        '\\\\server\\share\\file.md',
        '\\\\?\\C:\\workspace\\file.md',
        'C:\\workspace\\file.md:stream',
        '/workspace/target.md',
    ]) {
        assert.equal(normalizeNativeAbsolutePathForLink(unsafePath, 'win32'), null, unsafePath);
    }
});

test('Webview path detection keeps raw suspicious clipboard text out of host requests', async () => {
    const { getPastedAbsolutePathCandidate } = await workspaceLinkSecurityModulePromise;
    for (const safePath of [
        '/workspace/docs/read me.md',
        'C:\\workspace\\docs\\target.md',
        'C:/workspace/docs/target.md',
    ]) {
        assert.equal(getPastedAbsolutePathCandidate(safePath), safePath, safePath);
    }
    for (const unsafePath of [
        './target.md',
        '~/target.md',
        'file:///workspace/target.md',
        '//server/share/file.md',
        '\\\\server\\share\\file.md',
        'C:relative.md',
        ' /workspace/target.md',
        '/workspace/target.md\n',
        '/workspace/\u202etarget.md',
        `/${'a'.repeat(4096)}`,
    ]) {
        assert.equal(getPastedAbsolutePathCandidate(unsafePath), null, unsafePath);
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

test('inline link path guard blocks whitespace-wrapped native paths before href mutation', async () => {
    const {
        getWorkspaceLinkSuggestionQuery,
        linkInputLooksLikeNativeAbsolutePath,
        linkInputRequiresWorkspaceResolution,
    } = await workspaceLinkSecurityModulePromise;
    for (const pathInput of [
        '/Users/example/workspace/target.md',
        ' /Users/example/workspace/target.md',
        '\u00a0/Users/example/workspace/target.md',
        'C:\\workspace\\target.md',
        '\tC:\\workspace\\target.md ',
    ]) {
        assert.equal(linkInputLooksLikeNativeAbsolutePath(pathInput), true, pathInput);
    }
    for (const urlInput of [
        'https://example.com/docs',
        'mailto:person@example.com',
        './relative.md',
        'plain-relative.md',
    ]) {
        assert.equal(linkInputLooksLikeNativeAbsolutePath(urlInput), false, urlInput);
    }

    assert.equal(getWorkspaceLinkSuggestionQuery('test3'), 'test3');
    assert.equal(getWorkspaceLinkSuggestionQuery('docs/test3'), 'docs/test3');
    for (const blockedQuery of [
        'x',
        ' https',
        'https://example.com',
        'mailto:person@example.com',
        'javascript:alert(1)',
        '/Users/example/test3.md',
        'C:\\workspace\\test3.md',
        './test3.md',
        '../test3.md',
        'test\n3',
        'test\u202e3',
        'x'.repeat(257),
    ]) {
        assert.equal(getWorkspaceLinkSuggestionQuery(blockedQuery), null, blockedQuery);
    }
    assert.equal(linkInputRequiresWorkspaceResolution('./test3.md'), true);
    assert.equal(linkInputRequiresWorkspaceResolution('../test3.md'), true);
    assert.equal(linkInputRequiresWorkspaceResolution('test3'), false);
});

test('inline workspace suggestions are debounced, request-scoped, and rendered as text', () => {
    assert.match(editorSource, /role="combobox"/);
    assert.match(editorSource, /role="listbox"/);
    assert.match(editorSource, /setTimeout\(\(\) => \{[\s\S]*?requestWorkspaceLinkSuggestions[\s\S]*?\}, 150\)/);
    assert.match(editorSource, /type: 'cancelWorkspaceLinkSuggestions'/);
    assert.match(editorSource, /type: 'resolveWorkspaceLinkSuggestion'/);
    assert.match(editorSource, /searchRequestId: suggestion\?\.searchRequestId \|\| ''/);
    assert.match(editorSource, /candidateId: suggestion\?\.candidateId \|\| ''/);
    assert.match(editorSource, /requestId !== activeLinkSuggestionRequestId/);
    assert.match(editorSource, /query !== activeLinkSuggestionQuery/);
    assert.match(editorSource, /input\.value !== query/);
    assert.match(editorSource, /sanitizeInsertedLinkHref\(item\?\.path, 'workspace'\)/);
    assert.match(editorSource, /function linkPopoverInputAwaitsWorkspaceSuggestion/);
    assert.match(editorSource, /openButton\.disabled = isBusy \|\| awaitsWorkspaceSuggestion/);
    assert.match(editorSource, /applyButton\.disabled = isBusy \|\| awaitsWorkspaceSuggestion/);
    assert.match(
        editorSource,
        /e\.preventDefault\(\);[\s\S]*?linkPopoverInputAwaitsWorkspaceSuggestion\(input\.value\)[\s\S]*?return;/
    );

    const receiverStart = editorSource.indexOf('receiveWorkspaceLinkSuggestions = (message) =>');
    const receiverEnd = editorSource.indexOf('function repositionLinkPopoverWithinViewport', receiverStart);
    const receiverSource = editorSource.slice(receiverStart, receiverEnd);
    assert.match(receiverSource, /document\.createElement\('button'\)/);
    assert.match(receiverSource, /label\.textContent = item\.label/);
    assert.match(receiverSource, /pathText\.textContent = item\.path/);
    assert.doesNotMatch(receiverSource, /innerHTML/);
    assert.match(editorSource, /event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'/);
    assert.match(editorSource, /event\.key === 'Enter'/);
    assert.match(editorSource, /event\.key === 'Escape'/);
    assert.match(
        editorSource,
        /input\.addEventListener\('compositionstart',[\s\S]*?linkInputIsComposing = true/
    );
    assert.match(editorSource, /isLinkInputImeInteraction\(event, input\)/);
    assert.match(
        editorSource,
        /linkInputIsComposing \|\|[\s\S]*?compositionUpdateGate\.composing/
    );
    assert.match(editorSource, /document\.addEventListener\('visibilitychange'/);
    assert.match(
        editorSource,
        /document\.visibilityState !== 'visible'[\s\S]*?clearWorkspaceLinkSuggestions\(\{ cancelHost: true \}\)/
    );
    assert.match(
        editorSource,
        /document\.activeElement === input &&[\s\S]*?isLinkInputImeInteraction\(e, input\)/
    );
    assert.match(
        editorCss,
        /\.link-popover-suggestion\s*\{[\s\S]*?box-sizing: border-box/
    );
    assert.match(
        editorSource,
        /if \(requestKind === 'suggestion'\)[\s\S]*?clearWorkspaceLinkSuggestions\(\{ cancelHost: true \}\)/
    );
    assert.match(
        editorSource,
        /linkPopoverInputNeedsHostResolution\(input\.value\)[\s\S]*?restoreLinkHrefToBaseline\(\)/
    );
});

test('link entry opens the inline URL or path UI without a native Files action', () => {
    const requestStart = editorSource.indexOf(
        'requestWorkspaceLink = () =>',
        editorSource.indexOf('function selectionCanBecomeWorkspaceLink')
    );
    const requestEnd = editorSource.indexOf('function insertSelectedWorkspaceLink', requestStart);
    const requestSource = editorSource.slice(requestStart, requestEnd);
    assert.match(requestSource, /openInlineLinkPopover\(range\.cloneRange\(\), existingLink\)/);
    assert.doesNotMatch(requestSource, /vscode\.postMessage/);

    assert.match(editorSource, /placeholder="URL or workspace file path"/);
    assert.doesNotMatch(editorSource, /data-action="browse"|Files…/);
    assert.match(editorSource, /data-action="apply">Apply<\/button>/);
    assert.match(editorSource, /type: 'requestLinkInputResolution'/);
    assert.doesNotMatch(editorSource, /type: 'requestWorkspaceLink'/);
    assert.match(editorSource, /linkPopoverInputNeedsHostResolution\(input\.value\)/);
    assert.match(
        editorSource,
        /linkInputBaselineValue = input\.value;[\s\S]*?syncLinkPopoverOpenButtonState\(input\.value\)/
    );
    assert.match(editorSource, /shouldApplyInlineLinkResponse\(requestId\)/);
    assert.match(
        editorSource,
        /finishInlineLinkRequest\(requestId, true, href\);[\s\S]*?notifyChangeImmediate\(\)/
    );
    assert.match(
        editorSource,
        /function openLink\(\)[\s\S]*?linkPopoverInputNeedsHostResolution\(input\.value\)[\s\S]*?submitLinkPopoverInput\(\)/
    );

    assert.match(pickerSource, /resolveLinkInput/);
    assert.match(pickerSource, /normalizeExternalLinkHref\(rawInput\)/);
    assert.match(
        pickerSource,
        /resolvePastedAbsolutePath\(\s*document,\s*rawInput,\s*token/
    );
    assert.match(pickerSource, /resolveWorkspaceRelativePath\(document, rawInput, token\)/);
    assert.doesNotMatch(pickerSource, /pickWorkspaceFileLink|showQuickPick/);
    assert.doesNotMatch(pickerSource, /targetKind: '(?:external|workspace)'/);
    assert.doesNotMatch(pickerSource, /vscode\.window\.showInputBox/);
    assert.match(pickerSource, /kind: 'external'/);
    assert.match(pickerSource, /kind: 'workspace'/);
    assert.doesNotMatch(pickerSource, /(?:fetch|openExternal)/);
});

test('selected-text path paste keeps a literal fallback until a host-only relative link resolves', () => {
    assert.match(editorSource, /getPastedAbsolutePathCandidate\(rawExternalPastedText\)/);
    assert.match(editorSource, /e\.isTrusted === true/);
    assert.match(editorSource, /originalContents = range\.extractContents\(\)/);
    assert.match(editorSource, /createPastedPathFallback\(document, pathText\)/);
    assert.match(editorSource, /isPastedPathFallbackIntact\(pending, editor\)/);
    assert.match(editorSource, /type: 'requestPastedPathLink'/);
    assert.match(editorSource, /PASTED_PATH_LINK_TIMEOUT_MS = 2000/);
    assert.match(editorSource, /case 'pastedPathLinkRejected':/);
    assert.match(editorSource, /finalizePendingPastedPathLink/);
    assert.match(editorSource, /sanitizeInsertedLinkHref\(message\.href, message\.linkKind\)/);
    assert.match(editorSource, /replacePastedPathFallback\(pending, link\)/);
    assert.match(editorSource, /releasePastedPathFallback\(pending\)/);
    assert.doesNotMatch(
        editorSource.slice(
            editorSource.indexOf('function beginPastedPathLinkRequest'),
            editorSource.indexOf('function tryOverrideGlobalProperty')
        ),
        /innerHTML/
    );
});

test('workspace discovery is host-owned without the obsolete native picker protocol', () => {
    assert.doesNotMatch(providerSource, /case 'requestWorkspaceLink':/);
    assert.doesNotMatch(pickerSource, /pickWorkspaceFileLink|pickWorkspaceLink|showQuickPick/);
    assert.match(pickerSource, /new vscode\.RelativePattern\(workspaceFolder, '\*\*\/\*'\)/);
    assert.match(pickerSource, /maxWorkspaceFiles = 2000/);
    assert.match(pickerSource, /isUriSecurelyWithinDirectory/);
    assert.match(pickerSource, /resolvePastedAbsolutePath/);
    assert.doesNotMatch(pickerSource, /(?:fetch|openExternal)/);
});

test('inline URL or path input is bounded and resolved entirely by the host', () => {
    const requestCaseStart = providerSource.indexOf("case 'requestLinkInputResolution':");
    const nextCaseStart = providerSource.indexOf("case 'cancelWorkspaceLinkRequest':", requestCaseStart);
    assert.ok(requestCaseStart >= 0 && nextCaseStart > requestCaseStart);
    const requestCase = providerSource.slice(requestCaseStart, nextCaseStart);

    assert.match(requestCase, /workspaceLinkRequestIdPattern\.test\(requestId\)/);
    assert.match(requestCase, /rawInput\.length > 4096/);
    assert.match(requestCase, /activeWorkspaceLinkRequest !== null/);
    assert.match(requestCase, /resolveLinkInput\(\s*document,\s*rawInput/);
    assert.match(
        requestCase,
        /resolveLinkInput\(\s*document,\s*rawInput,\s*cancellation\.token/
    );
    assert.match(requestCase, /linkKind: selection\.kind/);
    assert.doesNotMatch(
        requestCase,
        /message\.(?:root|documentUri|workspaceFolder|allowOutside|href|label|linkKind)/
    );

    const cancelCaseStart = providerSource.indexOf("case 'cancelWorkspaceLinkRequest':");
    const cancelCaseEnd = providerSource.indexOf("case 'openImage':", cancelCaseStart);
    const cancelCase = providerSource.slice(cancelCaseStart, cancelCaseEnd);
    assert.match(cancelCase, /activeRequest\.cancellation\.cancel\(\)/);
    assert.doesNotMatch(cancelCase, /activeWorkspaceLinkRequest = null/);
    assert.match(pickerSource, /readCancellationAwareStat/);
});

test('pasted path protocol is request-scoped and ignores Webview trust-boundary fields', () => {
    const requestCaseStart = providerSource.indexOf("case 'requestPastedPathLink':");
    const nextCaseStart = providerSource.indexOf("case 'requestWorkspaceLinkSuggestions':", requestCaseStart);
    assert.ok(requestCaseStart >= 0 && nextCaseStart > requestCaseStart);
    const requestCase = providerSource.slice(requestCaseStart, nextCaseStart);

    assert.match(requestCase, /pastedPathLinkRequestIdPattern\.test\(requestId\)/);
    assert.match(requestCase, /activePastedPathLinkRequestId !== null/);
    assert.match(requestCase, /resolvePastedAbsolutePath\(document, pathText\)/);
    assert.match(requestCase, /linkKind: selection\.kind/);
    assert.doesNotMatch(
        requestCase,
        /message\.(?:root|documentUri|workspaceFolder|allowOutside|href|label)/
    );
});

test('Webview accepts picker results only for a live exact request and inserts text-only DOM', () => {
    assert.match(editorSource, /takePendingWorkspaceLinkInsertion\(requestId\)/);
    assert.match(editorSource, /shouldApplyInlineLinkResponse\(requestId\)/);
    assert.match(editorSource, /pending\.revision !== localUpdateRevision/);
    assert.match(editorSource, /sanitizeInsertedLinkHref\(message\.href, message\.linkKind\)/);
    assert.match(editorSource, /document\.createElement\('a'\)/);
    assert.match(editorSource, /link\.textContent = label/);
    assert.match(editorSource, /stateManager\.beginChangeAtSelection\(insertionHistorySelection\)/);
    assert.match(editorSource, /stateManager\.commitStateAfterChange\(\{/);
    assert.match(editorSource, /case 'workspaceLinkCancelled':/);
    assert.match(editorSource, /discardPendingWorkspaceLinkInsertion/);
    assert.match(editorSource, /type: 'cancelWorkspaceLinkRequest'/);
    assert.match(
        editorSource,
        /linkPopoverInputNeedsHostResolution\(input\.value\)[\s\S]*?restoreLinkHrefToBaseline\(\)/
    );
    assert.match(editorSource, /linkInputLooksLikeNativeAbsolutePath,/);
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
