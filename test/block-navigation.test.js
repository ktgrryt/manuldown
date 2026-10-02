const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

function importModule(relativePath) {
    const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const domUtilsModulePromise = importModule('media/modules/DOMUtils.js');
const cursorManagerModulePromise = importModule('media/modules/CursorManager.js');
const tableManagerModulePromise = importModule('media/modules/TableManager.js');
const editorSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'editor.js'),
    'utf8'
);

function childIndex(node) {
    return Array.from(node.parentNode.childNodes).indexOf(node);
}

class TestRange {
    constructor() {
        this.startContainer = null;
        this.startOffset = 0;
        this.endContainer = null;
        this.endOffset = 0;
        this.collapsed = true;
    }

    get commonAncestorContainer() {
        return this.startContainer;
    }

    setStart(container, offset) {
        this.startContainer = container;
        this.startOffset = offset;
        if (this.collapsed || !this.endContainer) {
            this.endContainer = container;
            this.endOffset = offset;
        }
        this.collapsed = this.startContainer === this.endContainer &&
            this.startOffset === this.endOffset;
    }

    setEnd(container, offset) {
        this.endContainer = container;
        this.endOffset = offset;
        this.collapsed = this.startContainer === this.endContainer &&
            this.startOffset === this.endOffset;
    }

    setStartBefore(node) {
        this.setStart(node.parentNode, childIndex(node));
    }

    setStartAfter(node) {
        this.setStart(node.parentNode, childIndex(node) + 1);
    }

    setEndAfter(node) {
        this.setEnd(node.parentNode, childIndex(node) + 1);
    }

    collapse(toStart) {
        if (toStart) {
            this.endContainer = this.startContainer;
            this.endOffset = this.startOffset;
        } else {
            this.startContainer = this.endContainer;
            this.startOffset = this.endOffset;
        }
        this.collapsed = true;
    }

    selectNode(node) {
        this.setStartBefore(node);
        this.setEndAfter(node);
    }

    selectNodeContents(node) {
        this.startContainer = node;
        this.startOffset = 0;
        this.endContainer = node;
        this.endOffset = node.childNodes.length;
        this.collapsed = false;
    }

    cloneRange() {
        return Object.assign(new TestRange(), this);
    }

    // Only equality is read by the editor code under test.
    compareBoundaryPoints(_how, other) {
        return this.startContainer === other.startContainer && this.startOffset === other.startOffset ? 0 : 1;
    }

    getBoundingClientRect() {
        return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    }

    getClientRects() {
        return [];
    }

    toString() {
        return '';
    }
}

TestRange.START_TO_START = 0;
TestRange.END_TO_END = 2;

class TestSelection {
    constructor(range) {
        this._range = range;
    }

    get rangeCount() {
        return this._range ? 1 : 0;
    }

    get isCollapsed() {
        return !!this._range?.collapsed;
    }

    getRangeAt() {
        return this._range;
    }

    removeAllRanges() {
        this._range = null;
    }

    addRange(range) {
        this._range = range;
    }
}

// The editor lives next to other Webview chrome, as it does in the real page,
// so a caret that leaves the editor is observable.
async function createFixture(editorHtml) {
    const domWindow = domino.createWindow(
        `<div id="editor">${editorHtml}</div><div id="toc-resizer"><p>outside</p></div>`
    );
    const editor = domWindow.document.getElementById('editor');
    domWindow.HTMLElement.prototype.getBoundingClientRect = () => (
        { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }
    );
    domWindow.HTMLElement.prototype.getClientRects = () => [];
    domWindow.document.createRange = () => new TestRange();
    domWindow.document.elementFromPoint = () => null;
    domWindow.document.caretRangeFromPoint = () => null;
    domWindow.getComputedStyle = () => ({ lineHeight: '20px', fontSize: '16px' });
    const selection = new TestSelection(null);
    domWindow.getSelection = () => selection;

    // Domino intentionally exposes a minimal NodeList. The production webview
    // provides NodeList#forEach, which isImageOnlyBlockElement uses.
    const nodeListPrototype = Object.getPrototypeOf(editor.querySelectorAll('img'));
    const previousForEach = nodeListPrototype.forEach;
    nodeListPrototype.forEach = Array.prototype.forEach;

    const previousGlobals = {
        document: global.document,
        window: global.window,
        Node: global.Node,
        NodeFilter: global.NodeFilter,
        Range: global.Range,
    };
    global.document = domWindow.document;
    global.window = domWindow;
    global.Node = domWindow.Node;
    global.NodeFilter = {
        SHOW_ELEMENT: 1,
        SHOW_TEXT: 4,
        FILTER_ACCEPT: 1,
        FILTER_REJECT: 2,
        FILTER_SKIP: 3,
    };
    global.Range = TestRange;

    const { DOMUtils } = await domUtilsModulePromise;
    const { CursorManager } = await cursorManagerModulePromise;
    const domUtils = new DOMUtils(editor);
    const cursorManager = new CursorManager(editor, domUtils);

    return {
        editor,
        domUtils,
        cursorManager,
        selection,
        placeCaret(container, offset) {
            const range = new TestRange();
            range.setStart(container, offset);
            range.collapse(true);
            selection.addRange(range);
            return range;
        },
        restoreGlobals() {
            nodeListPrototype.forEach = previousForEach;
            for (const [key, value] of Object.entries(previousGlobals)) {
                if (value === undefined) {
                    delete global[key];
                } else {
                    global[key] = value;
                }
            }
        },
    };
}

function extractEditorFunction(name) {
    const start = editorSource.indexOf(`    function ${name}(`);
    assert.notEqual(start, -1, `${name} is defined in editor.js`);
    const end = editorSource.indexOf('\n    }\n', start);
    return editorSource.slice(start, end + '\n    }'.length);
}

// Loads editor.js functions into one scope. `stubs` stands in for helpers the
// tested paths do not reach.
function loadEditorFunctions(fixture, names, stubs = {}) {
    const sources = names.map(extractEditorFunction);
    const stubNames = Object.keys(stubs);
    const factory = new Function(
        'editor',
        'domUtils',
        'cursorManager',
        'notifyChange',
        ...stubNames,
        `${sources.join('\n\n')}\nreturn { ${names.join(', ')} };`
    );
    return factory(
        fixture.editor,
        fixture.domUtils,
        fixture.cursorManager,
        () => {},
        ...stubNames.map(name => stubs[name])
    );
}

const CODE_BLOCK_NAVIGATION = [
    'enterCodeBlockFromAbove',
    'selectCodeBlockLanguageLabel',
    'setCodeBlockLanguageNavSelection',
    'moveCursorToCodeBlockLastContentLineEnd',
    'getCodeBlockLastNavigableLineIndex',
    'getPreviousElementSibling',
    'getNextElementSibling',
    'isNavigationExcludedElement',
    'placeCollapsedCaret',
    'placeCursorAtElementBoundary',
];

function loadLabelNavigation(fixture) {
    const navigation = loadEditorFunctions(fixture, [
        'moveCursorAboveCodeBlockFromLabel',
        'moveCursorAboveCodeBlockFromLabelToLineEnd',
        ...CODE_BLOCK_NAVIGATION,
    ]);
    const label = () => fixture.editor.querySelector('.code-block-language');
    return {
        up: () => navigation.moveCursorAboveCodeBlockFromLabel(label()),
        left: () => navigation.moveCursorAboveCodeBlockFromLabelToLineEnd(label()),
    };
}

// Describes the selected node as text: a failed assertion on a domino node
// takes very long to print.
function selectedNode(fixture) {
    const range = fixture.selection.getRangeAt(0);
    const node = range.collapsed ? null : range.startContainer.childNodes[range.startOffset];
    if (!node) return 'caret';
    return node.className ? `${node.tagName}.${node.className.split(' ')[0]}` : node.tagName;
}

// marked leaves newline text nodes between the tags of a list or a quote.
const CODE_BLOCK =
    '<pre><div class="code-block-toolbar"><span class="code-block-language">plaintext</span></div>' +
    '<code>mvn liberty:dev\n</code></pre>';
const LIST_ABOVE_CODE_BLOCK =
    '<h2>Deploying the Application to Liberty</h2>\n' +
    '<p>To deploy the application on Liberty you can do one of the following:</p>\n' +
    '<ul>\n<li>Install the Liberty tools IDE plugin</li>\n' +
    '<li>Add the Liberty tools plugin to the build configuration.</li>\n</ul>\n' +
    CODE_BLOCK;

test('ArrowUp from a code block language label enters the last item of the list above', async () => {
    const fixture = await createFixture(LIST_ABOVE_CODE_BLOCK);
    try {
        const { up } = loadLabelNavigation(fixture);

        assert.equal(up(), true);

        const range = fixture.selection.getRangeAt(0);
        assert.equal(range.collapsed, true);
        assert.equal(range.startContainer.data, 'Add the Liberty tools plugin to the build configuration.');
    } finally {
        fixture.restoreGlobals();
    }
});

test('ArrowUp from a code block language label enters the deepest last list item', async () => {
    const fixture = await createFixture(
        '<ul>\n<li>parent\n<ul>\n<li>child</li>\n</ul>\n</li>\n</ul>\n' + CODE_BLOCK
    );
    try {
        const { up } = loadLabelNavigation(fixture);

        assert.equal(up(), true);

        assert.equal(fixture.selection.getRangeAt(0).startContainer.data, 'child');
    } finally {
        fixture.restoreGlobals();
    }
});

test('ArrowLeft from a code block language label goes to the end of the list or quote above', async () => {
    const cases = [
        [LIST_ABOVE_CODE_BLOCK, 'Add the Liberty tools plugin to the build configuration.'],
        ['<blockquote>\n<p>quoted text</p>\n</blockquote>\n' + CODE_BLOCK, 'quoted text'],
    ];
    for (const [html, expectedText] of cases) {
        const fixture = await createFixture(html);
        try {
            const { left } = loadLabelNavigation(fixture);

            assert.equal(left(), true);

            const range = fixture.selection.getRangeAt(0);
            assert.equal(range.startContainer.data, expectedText);
            assert.equal(range.startOffset, expectedText.length);
        } finally {
            fixture.restoreGlobals();
        }
    }
});

test('loading removes the line feeds marked writes between list, quote and table tags', async () => {
    const fixture = await createFixture('');
    try {
        const { normalizeLoadedEditorBoundaryWhitespace } =
            loadEditorFunctions(fixture, ['normalizeLoadedEditorBoundaryWhitespace']);
        const container = fixture.editor.ownerDocument.createElement('div');
        container.innerHTML =
            '<ul>\n<li>one</li>\n<li><p>loose</p>\n</li>\n</ul>\n' +
            '<ol>\n<li>parent\n<ul>\n<li>child</li>\n</ul>\n</li>\n</ol>\n' +
            '<blockquote>\n<p>quote</p>\n</blockquote>\n' +
            '<table>\n<thead>\n<tr>\n<th>a</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>b</td>\n</tr>\n</tbody>\n</table>\n' +
            '<ul>\n<li><code>a</code> <code>b</code></li>\n</ul>\n' +
            '<pre><code>x\n\ny\n</code></pre>\n';

        normalizeLoadedEditorBoundaryWhitespace(container);

        assert.equal(
            container.innerHTML,
            '<ul><li>one</li><li><p>loose</p></li></ul>' +
            // "parent\n" is item text, not a formatting node.
            '<ol><li>parent\n<ul><li>child</li></ul></li></ol>' +
            '<blockquote><p>quote</p></blockquote>' +
            '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>' +
            '<ul><li><code>a</code> <code>b</code></li></ul>' +
            '<pre><code>x\n\ny\n</code></pre>'
        );
    } finally {
        fixture.restoreGlobals();
    }
});

test('the block before another one is the last block, not an inline element of it', async () => {
    const cases = [
        ['<p>first<br>second</p>', 'P'],
        ['<p>text <code>code</code></p>', 'P'],
        ['<blockquote><p>quoted</p></blockquote>', 'P'],
        ['<ul><li>parent<ul><li>child</li></ul></li></ul>', 'LI'],
        ['<ul><li><input type="checkbox"> task</li></ul>', 'LI'],
        [CODE_BLOCK, 'PRE'],
    ];
    for (const [html, expectedTag] of cases) {
        const fixture = await createFixture(`${html}<p>next</p>`);
        try {
            const next = fixture.editor.lastElementChild;

            const prev = fixture.cursorManager._getPrevNavigableElementInDocument(next);

            assert.equal(prev.tagName, expectedTag, html);
        } finally {
            fixture.restoreGlobals();
        }
    }
});

function loadQuoteExit(fixture) {
    return loadEditorFunctions(fixture, [
        'exitBlockquoteAfter',
        'getPreferredFirstTextNodeForElement',
        'isEffectivelyEmptyBlock',
        ...CODE_BLOCK_NAVIGATION,
    ], {
        hasCheckboxAtStart: () => false,
        getFirstDirectTextNodeAfterCheckbox: () => null,
        getFirstDirectTextNode: () => null,
        getLastDirectTextNode: () => null,
    }).exitBlockquoteAfter;
}

test('leaving a quote selects a following HR instead of a caret inside it', async () => {
    const fixture = await createFixture('<blockquote><p>quoted</p></blockquote><hr><p>after</p>');
    try {
        const exitBlockquoteAfter = loadQuoteExit(fixture);
        const quoted = fixture.editor.querySelector('blockquote p').firstChild;
        fixture.placeCaret(quoted, quoted.data.length);

        exitBlockquoteAfter({ preferTopLevelGap: true, direction: 'down' });

        assert.equal(selectedNode(fixture), 'HR');
    } finally {
        fixture.restoreGlobals();
    }
});

test('leaving a quote enters a following code block as leaving a paragraph does', async () => {
    for (const direction of ['down', 'right']) {
        const fixture = await createFixture(`<blockquote><p>quoted</p></blockquote>${CODE_BLOCK}`);
        try {
            const exitBlockquoteAfter = loadQuoteExit(fixture);
            const quoted = fixture.editor.querySelector('blockquote p').firstChild;
            fixture.placeCaret(quoted, quoted.data.length);

            exitBlockquoteAfter({ preferTopLevelGap: true, direction });

            if (direction === 'down') {
                assert.equal(selectedNode(fixture), 'SPAN.code-block-language');
            } else {
                const range = fixture.selection.getRangeAt(0);
                assert.equal(range.startContainer.data, 'mvn liberty:dev\n');
                assert.equal(range.startOffset, 0);
            }
        } finally {
            fixture.restoreGlobals();
        }
    }
});

function loadHRNavigation(fixture) {
    const { navigateFromHR } = loadEditorFunctions(fixture, ['navigateFromHR', ...CODE_BLOCK_NAVIGATION]);
    return (direction) => navigateFromHR(fixture.editor.querySelector('hr'), direction);
}

test('ArrowUp from an HR enters the last item of the list above', async () => {
    const fixture = await createFixture('<ul><li>first</li><li>last</li></ul><hr><p>after</p>');
    try {
        const navigate = loadHRNavigation(fixture);

        assert.equal(navigate('up'), true);

        assert.equal(fixture.selection.getRangeAt(0).startContainer.data, 'last');
    } finally {
        fixture.restoreGlobals();
    }
});

test('ArrowDown from an HR selects the label of a following code block', async () => {
    const fixture = await createFixture(`<hr>${CODE_BLOCK}`);
    try {
        const navigate = loadHRNavigation(fixture);

        assert.equal(navigate('down'), true);

        assert.equal(selectedNode(fixture), 'SPAN.code-block-language');
    } finally {
        fixture.restoreGlobals();
    }
});

test('ArrowDown from the last HR skips editor-only chrome and opens a paragraph', async () => {
    const fixture = await createFixture(
        '<p>before</p><hr>' +
        '<div class="md-table-insert-line" data-exclude-from-markdown="true" contenteditable="false"></div>'
    );
    try {
        const navigate = loadHRNavigation(fixture);
        const hr = fixture.editor.querySelector('hr');

        assert.equal(navigate('down'), true);

        const paragraph = hr.nextSibling;
        assert.equal(paragraph.tagName, 'P');
        assert.equal(fixture.selection.getRangeAt(0).startContainer === paragraph, true);
    } finally {
        fixture.restoreGlobals();
    }
});

test('content cleanup keeps the code block toolbar intact', async () => {
    const fixture = await createFixture(
        '<pre><div class="code-block-toolbar"><div class="language-suggestions" style="display: none;"></div>' +
        '<span class="code-block-language">js</span></div><code>x</code></pre>' +
        '<p><span style="color: red">pasted</span></p>'
    );
    try {
        const label = fixture.editor.querySelector('.code-block-language');
        const suggestions = fixture.editor.querySelector('.language-suggestions');
        fixture.placeCaret(fixture.editor.querySelector('.code-block-toolbar'), 1);

        fixture.domUtils.cleanupGhostStyles();

        // A label selected for navigation must survive the cleanup that runs
        // before every change notification.
        assert.equal(fixture.editor.querySelector('.code-block-language') === label, true);
        assert.equal(suggestions.getAttribute('style'), 'display: none;');
        assert.equal(fixture.editor.querySelector('p').innerHTML, 'pasted');
    } finally {
        fixture.restoreGlobals();
    }
});

async function createTableExitManager(fixture, calls) {
    const { TableManager } = await tableManagerModulePromise;
    return new TableManager(fixture.editor, fixture.domUtils, null, {
        placeCaretAtBlockLastLineStart: (block) => {
            calls.push(['lastLineStart', block.tagName]);
            return true;
        },
        placeCaretAtCodeBlockLastLineEnd: (pre) => {
            calls.push(['codeLastLineEnd', pre.tagName]);
            return true;
        },
        selectCodeBlockLanguageLabel: (pre) => {
            calls.push(['selectLabel', pre.tagName]);
            return true;
        },
    });
}

const TABLE = '<div class="md-table-wrapper"><table><tbody><tr><td>cell</td></tr></tbody></table></div>';

const NAVIGATION_TABLE =
    '<div class="md-table-wrapper">' +
    '<div class="md-table-edge md-table-edge-left" data-table-edge="left">&nbsp;</div>' +
    '<table><thead><tr><th><br></th><th><br></th></tr></thead>' +
    '<tbody><tr><td><br></td><td><br></td></tr></tbody></table>' +
    '<div class="md-table-edge md-table-edge-right" data-table-edge="right">&nbsp;</div></div>';

async function createTableNavigationManager(fixture) {
    const { TableManager } = await tableManagerModulePromise;
    // Domino does not expose HTMLElement.dataset.
    fixture.editor.querySelectorAll('.md-table-edge').forEach(edge => {
        edge.dataset = { tableEdge: edge.getAttribute('data-table-edge') };
    });
    return new TableManager(fixture.editor, fixture.domUtils, null);
}

test('vertical keys pass through a table left edge without entering its cells', async () => {
    for (const useCtrl of [false, true]) {
        const fixture = await createFixture('<p><br></p>' + NAVIGATION_TABLE + '<p><br></p>');
        try {
            const manager = await createTableNavigationManager(fixture);
            manager._isMac = true;
            const { moveCursorDownFromEmptyBlock } = loadEditorFunctions(fixture, [
                'moveCursorDownFromEmptyBlock',
                'isEffectivelyEmptyBlock',
                'getNextElementSibling',
                'isNavigationExcludedElement',
                'getPreferredFirstTextNodeForElement',
            ], { getSingleImageFromImageOnlyBlock: () => null });
            const above = fixture.editor.firstElementChild;
            const below = fixture.editor.lastElementChild;
            const leftEdge = fixture.editor.querySelector('.md-table-edge-left');
            const originalHTML = fixture.editor.innerHTML;
            const press = (direction) => {
                let prevented = false;
                const event = {
                    key: useCtrl ? (direction === 'down' ? 'n' : 'p') : (direction === 'down' ? 'ArrowDown' : 'ArrowUp'),
                    ctrlKey: useCtrl,
                    preventDefault() { prevented = true; },
                };
                const handled = useCtrl ? manager.handleCtrlNavKeydown(event) : manager.handleArrowKeydown(event);
                assert.equal(handled, true);
                assert.equal(prevented, true);
            };

            fixture.placeCaret(above, 0);
            assert.equal(moveCursorDownFromEmptyBlock(fixture.selection.getRangeAt(0), fixture.selection), true);
            assert.equal(leftEdge.contains(fixture.selection.getRangeAt(0).startContainer), true);

            press('down');
            assert.equal(fixture.selection.getRangeAt(0).startContainer === below, true);
            assert.equal(fixture.selection.getRangeAt(0).startOffset, 0);

            press('up');
            assert.equal(leftEdge.contains(fixture.selection.getRangeAt(0).startContainer), true);
            press('up');
            assert.equal(fixture.selection.getRangeAt(0).startContainer === above, true);
            assert.equal(fixture.editor.innerHTML, originalHTML);
        } finally {
            fixture.restoreGlobals();
        }
    }
});

test('ArrowDown from the left edge of a final table creates a following empty line', async () => {
    const fixture = await createFixture(NAVIGATION_TABLE);
    try {
        const manager = await createTableNavigationManager(fixture);
        const wrapper = fixture.editor.firstElementChild;
        fixture.placeCaret(wrapper.querySelector('.md-table-edge-left').firstChild, 0);

        assert.equal(manager.handleArrowKeydown({ key: 'ArrowDown', preventDefault() {} }), true);

        const paragraph = wrapper.nextSibling;
        assert.equal(paragraph.tagName, 'P');
        assert.equal(paragraph.innerHTML, '<br>');
        assert.equal(fixture.selection.getRangeAt(0).startContainer === paragraph, true);
    } finally {
        fixture.restoreGlobals();
    }
});

test('ArrowRight and Tab still enter the first cell from a table left edge', async () => {
    const fixture = await createFixture(NAVIGATION_TABLE);
    try {
        const manager = await createTableNavigationManager(fixture);
        const leftEdge = fixture.editor.querySelector('.md-table-edge-left');
        const firstCell = fixture.editor.querySelector('th');
        for (const key of ['ArrowRight', 'Tab']) {
            fixture.placeCaret(leftEdge.firstChild, 0);
            const event = { key, preventDefault() {} };

            assert.equal(key === 'Tab' ? manager.handleTabKeydown(event) : manager.handleArrowKeydown(event), true);

            assert.equal(fixture.selection.getRangeAt(0).startContainer === firstCell, true);
            assert.equal(fixture.selection.getRangeAt(0).startOffset, 0);
        }
    } finally {
        fixture.restoreGlobals();
    }
});

test('leaving a table upward lands where leaving a paragraph does', async () => {
    for (const [above, expected] of [['<p>above</p>', 'lastLineStart'], [CODE_BLOCK, 'codeLastLineEnd']]) {
        const fixture = await createFixture(above + TABLE);
        try {
            const calls = [];
            const manager = await createTableExitManager(fixture, calls);

            manager._moveCursorBeforeWrapper(fixture.editor.querySelector('.md-table-wrapper'), true);

            assert.deepEqual(calls.map(call => call[0]), [expected]);
        } finally {
            fixture.restoreGlobals();
        }
    }
});

test('leaving a table into a code block selects its label downward and enters the code otherwise', async () => {
    for (const direction of ['down', 'right']) {
        const fixture = await createFixture(TABLE + CODE_BLOCK);
        try {
            const calls = [];
            const manager = await createTableExitManager(fixture, calls);

            manager._moveCursorAfterWrapper(fixture.editor.querySelector('.md-table-wrapper'), direction);

            if (direction === 'down') {
                assert.deepEqual(calls, [['selectLabel', 'PRE']]);
            } else {
                assert.deepEqual(calls, []);
                assert.equal(fixture.selection.getRangeAt(0).startContainer.data, 'mvn liberty:dev\n');
            }
        } finally {
            fixture.restoreGlobals();
        }
    }
});

// The editor stylesheet makes every image display: block. Domino ignores a
// plain assignment to window.getComputedStyle.
function useBlockImages() {
    Object.defineProperty(window, 'getComputedStyle', {
        configurable: true,
        value: (element) => ({
            display: element.tagName === 'IMG' ? 'block' : 'inline',
            lineHeight: '20px',
            fontSize: '16px',
        }),
    });
}

test('a paragraph with images is split into text and image lines', async () => {
    const fixture = await createFixture(
        '<p>before <img src="a.png"> <a href="https://example.com"><img src="b.png"></a>' +
        '<strong>after</strong> text</p>'
    );
    try {
        useBlockImages();
        const paragraph = fixture.editor.querySelector('p');

        const items = fixture.cursorManager._getImageLineItems(paragraph);

        // The space between the images is not a line of its own.
        assert.deepEqual(
            items.map(item => item.image ? `image:${item.nodes[0].tagName}` : `text:${item.nodes.length}`),
            ['text:1', 'image:IMG', 'image:A', 'text:2']
        );
    } finally {
        fixture.restoreGlobals();
    }
});

test('ArrowUp and ArrowDown stop at each of two images in one paragraph', async () => {
    const fixture = await createFixture('<p><img src="a.png"> <img src="b.png"></p>');
    try {
        useBlockImages();
        const paragraph = fixture.editor.querySelector('p');
        fixture.placeCaret(paragraph, 0);

        assert.equal(fixture.cursorManager._moveVerticallyAcrossBlockImages(fixture.selection, 'down'), true);
        let range = fixture.selection.getRangeAt(0);
        assert.equal(range.startContainer === paragraph, true);
        assert.equal(range.startOffset, 2);

        assert.equal(fixture.cursorManager._moveVerticallyAcrossBlockImages(fixture.selection, 'up'), true);
        range = fixture.selection.getRangeAt(0);
        assert.equal(range.startOffset, 0);

        // Leaving the paragraph is left to the block navigation.
        assert.equal(fixture.cursorManager._moveVerticallyAcrossBlockImages(fixture.selection, 'up'), false);
    } finally {
        fixture.restoreGlobals();
    }
});

test('the start of text right after an image is the image right edge', async () => {
    // editor.js puts the right-edge caret there when text follows the image.
    // ArrowRight must then leave the edge instead of stepping to <p>@1 first.
    for (const html of ['<p><img src="a.png"> caption</p>', '<p><a href="https://example.com"><img src="a.png"></a> caption</p>']) {
        const fixture = await createFixture(html);
        try {
            const image = fixture.editor.querySelector('img');
            const caption = fixture.editor.querySelector('p').lastChild;
            const manager = fixture.cursorManager;

            fixture.placeCaret(caption, 0);
            assert.equal(manager._isCollapsedRangeAtNodeBoundary(fixture.selection.getRangeAt(0), image, 'after'), true, html);

            fixture.placeCaret(caption, 1);
            assert.equal(manager._isCollapsedRangeAtNodeBoundary(fixture.selection.getRangeAt(0), image, 'after'), false, html);
        } finally {
            fixture.restoreGlobals();
        }
    }
});

test('entering a block from above stops at an image on its first line', async () => {
    const fixture = await createFixture('<hr><ul><li><img src="a.png"> caption</li></ul>');
    try {
        useBlockImages();
        const navigate = loadHRNavigation(fixture);
        const item = fixture.editor.querySelector('li');

        assert.equal(navigate('down'), true);

        const range = fixture.selection.getRangeAt(0);
        assert.equal(range.startContainer === item, true);
        assert.equal(range.startOffset, 0);
    } finally {
        fixture.restoreGlobals();
    }
});
