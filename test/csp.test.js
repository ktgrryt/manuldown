const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const providerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'editor', 'MarkdownEditorProvider.ts'),
    'utf8'
);
const editorSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'editor.js'),
    'utf8'
);
const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);

function createMockUri(uriPath, scheme = 'file') {
    return {
        scheme,
        authority: '',
        path: uriPath,
        fsPath: uriPath,
        toString: () => `${scheme}://${uriPath}`,
    };
}

function loadProviderWithConfiguration(configurationValues) {
    const vscodeMock = {
        Uri: {
            file: (fsPath) => createMockUri(fsPath),
            joinPath: (base, ...segments) => createMockUri(
                path.posix.join(base.path, ...segments),
                base.scheme
            ),
        },
        ExtensionMode: { Production: 1, Development: 2, Test: 3 },
        workspace: {
            getConfiguration: () => ({
                get: (key, defaultValue) => Object.prototype.hasOwnProperty.call(configurationValues, key)
                    ? configurationValues[key]
                    : defaultValue,
            }),
        },
    };
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') {
            return vscodeMock;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const modulePath = require.resolve('../out/editor/MarkdownEditorProvider');
        delete require.cache[modulePath];
        const { MarkdownEditorProvider } = require(modulePath);
        return new MarkdownEditorProvider({
            extensionUri: createMockUri('/extension'),
            extensionMode: vscodeMock.ExtensionMode.Production,
            extension: { packageJSON: { version: '1.0.0' } },
        });
    } finally {
        Module._load = originalLoad;
    }
}

function renderWebviewHtml(provider) {
    const webview = {
        cspSource: 'https://*.vscode-cdn.net',
        asWebviewUri: (uri) => ({
            toString: () => `https://file+.vscode-resource.vscode-cdn.net${uri.path}`,
        }),
    };
    return provider.getHtmlForWebview(webview, {});
}

function getImageSources(html) {
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
    return csp.match(/img-src ([^;]+);/)[1];
}

function getInlineSettings(html) {
    const match = html.match(/window\.__manulDownSettings = (.*?);<\/script>/);
    assert.ok(match, 'The inline settings script must exist');
    return JSON.parse(match[1]);
}

function extractEditorFunction(name) {
    const start = editorSource.indexOf(`    function ${name}(`);
    assert.notEqual(start, -1, `${name} is defined in editor.js`);
    const end = editorSource.indexOf('\n    }\n', start);
    return editorSource.slice(start, end + '\n    }'.length);
}

function loadClassifyImageSource(settingsState, remoteImagesPermittedByCsp) {
    const sources = [
        'classifyImageSourceForEditor',
        'isWebviewResourceUrl',
        'isInternalWebviewCdnUrl',
        'isLikelyAbsoluteFsPath',
        'hasExplicitScheme',
    ].map(extractEditorFunction);
    return new Function(
        'settingsState',
        'remoteImagesPermittedByCsp',
        'window',
        `${sources.join('\n\n')}\nreturn classifyImageSourceForEditor;`
    )(
        settingsState,
        remoteImagesPermittedByCsp,
        { location: { href: 'https://webview.vscode-cdn.net/index.html' } }
    );
}

test('Webview CSP disables script attributes and requires nonces for script elements', () => {
    const cspMatch = providerSource.match(
        /Content-Security-Policy" content="([^"]+)"/
    );
    assert.ok(cspMatch, 'The Webview CSP meta tag must exist');
    const csp = cspMatch[1];

    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-\$\{nonce\}'/);
    assert.match(csp, /script-src-elem 'nonce-\$\{nonce\}'/);
    assert.match(csp, /script-src-attr 'none'/);
    assert.match(csp, /style-src-attr 'unsafe-inline'/);
});

test('Webview CSP no longer grants the legacy vscode-resource scheme', () => {
    const cspMatch = providerSource.match(
        /Content-Security-Policy" content="([^"]+)"/
    );
    assert.ok(cspMatch);
    assert.doesNotMatch(cspMatch[1], /vscode-resource:/);
});

test('Webview CSP refuses remote images unless the user allows them', () => {
    const blockedHtml = renderWebviewHtml(loadProviderWithConfiguration({}));
    assert.equal(getImageSources(blockedHtml), 'https://*.vscode-cdn.net data:');

    const allowedHtml = renderWebviewHtml(loadProviderWithConfiguration({
        'security.allowRemoteImages': true,
    }));
    assert.equal(getImageSources(allowedHtml), 'https://*.vscode-cdn.net https: data:');
});

test('non-boolean settings fall back to their defaults', () => {
    const provider = loadProviderWithConfiguration({
        'toolbar.visible': '</script><img src=https://evil.example/p.png>',
        'security.allowRemoteImages': 'true',
        'security.allowRemoteImageImport': 1,
        'security.allowFileLinks': 'yes',
    });
    const html = renderWebviewHtml(provider);

    assert.doesNotMatch(html, /evil\.example/);
    assert.equal(getImageSources(html), 'https://*.vscode-cdn.net data:');
    const settings = getInlineSettings(html);
    assert.equal(settings.toolbarVisible, true);
    assert.equal(settings.allowRemoteImages, false);
    assert.equal(settings.allowRemoteImageImport, false);
    assert.equal(settings.allowFileLinks, false);
    assert.doesNotMatch(providerSource, /get<boolean>\('security\./);
});

test('inline settings cannot close their script element', () => {
    const provider = loadProviderWithConfiguration({});
    const originalSettings = provider.getWebviewSettings();
    provider.getWebviewSettings = () => ({
        ...originalSettings,
        probe: '</script><img src=https://evil.example/p.png>',
    });
    const html = renderWebviewHtml(provider);

    assert.doesNotMatch(html, /<\/script><img/);
    assert.equal(
        getInlineSettings(html).probe,
        '</script><img src=https://evil.example/p.png>'
    );
});

test('security settings can only be configured in user settings', () => {
    const properties = packageJson.contributes.configuration.properties;
    for (const key of [
        'manulDown.security.allowRemoteImages',
        'manulDown.security.allowRemoteImageImport',
        'manulDown.security.allowFileLinks',
    ]) {
        assert.equal(properties[key].scope, 'application', key);
    }
});

test('remote images enabled after load stay blocked until the editor is reopened', () => {
    const src = 'https://example.com/p.png';
    assert.equal(
        loadClassifyImageSource({ allowRemoteImages: true }, true)(src).kind,
        'direct'
    );
    assert.equal(
        loadClassifyImageSource({ allowRemoteImages: true }, false)(src).kind,
        'blocked-remote'
    );
    assert.equal(
        loadClassifyImageSource({ allowRemoteImages: false }, true)(src).kind,
        'blocked-remote'
    );
    assert.match(
        editorSource,
        /const remoteImagesPermittedByCsp = settingsState\.allowRemoteImages;/
    );
});

test('Webview CSP loads fonts, such as the KaTeX fonts, only from the extension', () => {
    const csp = providerSource.match(/Content-Security-Policy" content="([^"]+)"/)[1];
    assert.match(csp, /font-src \$\{webview\.cspSource\};/);
});
