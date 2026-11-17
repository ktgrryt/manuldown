const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../media/editor.js'), 'utf8');
const extract = name => {
    const start = source.indexOf(`    function ${name}(`);
    const end = source.indexOf('\n    }\n', start);
    assert.ok(start >= 0 && end > start, `${name} exists`);
    return source.slice(start, end + 6);
};
const functions = [
    'isInternalWebviewCdnUrl', 'isLikelyAbsoluteFsPath', 'hasExplicitScheme', 'isWebviewResourceUrl',
    'sanitizeLinkHref', 'classifyImageSourceForEditor', 'requestImageSrcResolution',
    'applyImageSourcePolicy', 'unwrapElement', 'sanitizeFragmentForEditor',
    'normalizeLoadedEditorBoundaryWhitespace', 'stripEditorControlCharacters',
    'getCheckboxInListItemDirectContent', 'hasCheckbox', 'hasCheckboxAtStart',
    'createCheckboxElement', 'getFirstDirectTextNodeAfterCheckbox', 'ensureCheckboxLeadingSpace',
    'syncCheckboxPlaceholderBreak', 'ensureCheckboxTextAnchor', 'normalizeCheckboxListItems',
].map(extract).join('\n');
const constantsStart = source.indexOf('    const SAFE_EDITOR_TAGS =');
const constantsEnd = source.indexOf('    function isLikelyAbsoluteFsPath(', constantsStart);

function editorLoading(editor, domUtils, options = {}) {
    const document = editor.ownerDocument;
    const window = document.defaultView;
    // Domino does not implement :scope. Production only uses direct-child
    // selectors here, so keep their normal browser meaning in the fixture.
    editor.querySelectorAll('li').forEach(element => {
        const querySelector = element.querySelector;
        Object.defineProperty(element, 'querySelector', {
            configurable: true,
            value(selectors) {
                const match = /^:scope > (.+)$/.exec(selectors);
                return match ? Array.from(this.children).find(child => child.matches(match[1])) || null
                    : querySelector.call(this, selectors);
            },
        });
    });
    return new Function('editor', 'domUtils', 'document', 'window', 'Node', 'NodeFilter', 'vscode', 'settingsState', `
        let imageResolveRequestSeq = 0;
        const remoteImagesPermittedByCsp = false;
        const BLOCKED_REMOTE_IMAGE_PLACEHOLDER_DATA_URL = 'data:image/svg+xml,blocked';
        const CHECKBOX_PLACEHOLDER_BREAK_ATTRIBUTE = 'data-mdw-checkbox-placeholder';
        ${source.slice(constantsStart, constantsEnd)}
        ${functions}
        const cleanup = () => {
            normalizeLoadedEditorBoundaryWhitespace(editor);
            stripEditorControlCharacters(editor, { preserveSelection: false });
        };
        return {
            cleanup,
            sanitize: sanitizeFragmentForEditor,
            initialize() {
                sanitizeFragmentForEditor(editor, { allowInternalMetadata: true });
                cleanup();
                normalizeCheckboxListItems();
                domUtils.cleanupGhostStyles();
                domUtils.ensureInlineCodeSpaces();
            }
        };
    `)(editor, domUtils, document, window, window.Node, window.NodeFilter,
        { postMessage: options.postMessage || (() => {}) }, { allowRemoteImages: false, ...options.settings });
}

module.exports = { editorLoading };
