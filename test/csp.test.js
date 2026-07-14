const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const providerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'editor', 'MarkdownEditorProvider.ts'),
    'utf8'
);

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
