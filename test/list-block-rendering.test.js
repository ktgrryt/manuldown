const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const domino = require('@mixmark-io/domino');

function loadModules() {
    const originalLoad = Module._load;
    const vscode = {
        workspace: {
            getWorkspaceFolder: () => null,
            getConfiguration: () => ({ get: (_key, fallback) => fallback }),
        },
        window: {},
    };
    Module._load = function (request, parent, isMain) {
        return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
    };
    try {
        return {
            MarkdownDocument: require('../out/editor/MarkdownDocument').MarkdownDocument,
            MarkdownEditorProvider: require('../out/editor/MarkdownEditorProvider').MarkdownEditorProvider,
        };
    } finally {
        Module._load = originalLoad;
    }
}
const { MarkdownDocument, MarkdownEditorProvider } = loadModules();
const textDocument = source => ({
    getText: () => source,
    uri: { scheme: 'file', path: '/workspace/document.md', fsPath: '/workspace/document.md', authority: '' },
});
const render = source => domino.createWindow(new MarkdownDocument(textDocument(source)).toHtml()).document;

for (const [name, source, selector, text] of [
    ['quote', '- > quote\n', 'li blockquote p', 'quote'],
    ['ordered quote', '3. > quote\n', 'li blockquote p', 'quote'],
    ['nested quote', '- parent\n  - > quote\n', 'li li blockquote p', 'quote'],
    ['heading', '- # heading\n', 'li h1', 'heading'],
    ['task quote', '- [ ] > quote\n', 'li blockquote p', 'quote'],
    ['loose task quote', '- [x] > quote\n\n- next\n', 'li blockquote p', 'quote'],
    ['code', '- ```js\n  const x = 1;\n  ```\n', 'li pre code', 'const x = 1;\n'],
    ['task code', '- [ ] ```md\n  - literal\n  ```\n', 'li pre code', '- literal\n'],
    ['ordered code', '3. ```js\n   const x = 1;\n   ```\n', 'li pre code', 'const x = 1;\n'],
    ['nested code', '- parent\n  - ~~~js\n    const x = 1;\n    ~~~\n', 'li li pre code', 'const x = 1;\n'],
    ['code with Markdown-looking content', '- ```md\n  - literal\n  > quote\n\n  <NAME> <VALUE>\n  ```\n', 'li pre code', '- literal\n> quote\n\n<NAME> <VALUE>\n'],
    ['code with repeated blank lines', '- ```text\n  before\n\n\n  after\n  ```\n', 'li pre code', 'before\n\n\nafter\n'],
    ['code with literal HTML', '- ```html\n  <div>\n\n  text\n  </div>\n  ```\n', 'li pre code', '<div>\n\ntext\n</div>\n'],
    ['code with literal references', '- ```md\n  [ref]: target.md\n\n  literal\n  ```\n', 'li pre code', '[ref]: target.md\n\nliteral\n'],
    ['quoted code with tabs and blank lines', '- > ```make\n  > target:\n  >\n  > \tcommand\n  > ```\n', 'li blockquote pre code', 'target:\n\n\tcommand\n'],
    ['task quoted code', '- [x] > ```make\n  > target:\n  >\n  > \tcommand\n  > ```\n', 'li blockquote pre code', 'target:\n\n\tcommand\n'],
    ['indented code', '-     echo hello\n', 'li pre code', 'echo hello\n'],
    ['ordered indented code', '1.     echo hello\n', 'li pre code', 'echo hello\n'],
    ['indented code with a literal checkbox', '-     [ ] echo hello\n', 'li pre code', '[ ] echo hello\n'],
    ['indented code with extra content indentation', '-       echo hello\n', 'li pre code', '  echo hello\n'],
    ['indented code with Markdown-looking continuation', '-     echo hello\n      - literal\n      > quote\n', 'li pre code', 'echo hello\n- literal\n> quote\n'],
    ['quoted indented code', '> -     echo hello\n>       - literal\n', 'li pre code', 'echo hello\n- literal\n'],
    ['nested indented code', '- parent\n    -     echo hello\n', 'li li pre code', 'echo hello\n'],
    ['four-space nested code with tabs', '- parent\n    - ```make\n      \tcommand\n      ```\n', 'li li pre code', '\tcommand\n'],
    ['deeply nested code with tabs', '- parent\n    - child\n        - ```make\n          \tcommand\n          ```\n', 'li li li pre code', '\tcommand\n'],
    ['four-space nested quoted code', '- parent\n    - > ```make\n      > target:\n      >\n      > \tcommand\n      > ```\n', 'li li blockquote pre code', 'target:\n\n\tcommand\n'],
]) {
    test(`list-leading ${name} survives loading, editing and saving`, () => {
        const document = textDocument(source);
        const root = render(source);
        const target = root.querySelector(selector);
        assert.ok(target, source);
        assert.equal(target.textContent, text, source);
        assert.doesNotMatch(root.body.textContent, /MDW_/);
        const hadCheckbox = !!root.querySelector('li input[type="checkbox"]');
        const provider = new MarkdownEditorProvider({});
        assert.equal(provider.htmlToMarkdown(root.body.innerHTML, document), source);
        target.textContent = text.replace(/\n$/, '') + ' changed' + (text.endsWith('\n') ? '\n' : '');
        const saved = provider.htmlToMarkdown(root.body.innerHTML, document);
        const reopened = render(saved);
        assert.equal(reopened.querySelector(selector)?.textContent, target.textContent, saved);
        assert.doesNotMatch(saved, /MDW_/);
        assert.equal(provider.htmlToMarkdown(reopened.body.innerHTML, textDocument(saved)), saved);
        assert.equal(!!reopened.querySelector('li input[type="checkbox"]'), hadCheckbox);
    });
}

test('triple-backtick inline code with backticks does not become a block fence', () => {
    for (const prefix of ['', '- ', '1. ']) {
        const source = `${prefix}\`\`\`a \`b\` c\`\`\`\n\nHello\n`;
        const document = textDocument(source);
        const root = render(source);
        const code = root.querySelector('code');
        assert.equal(code.textContent, 'a `b` c', source);
        assert.ok(!root.querySelector('pre'), source);
        assert.equal(root.querySelectorAll('p').length, prefix ? 1 : 2);
        const provider = new MarkdownEditorProvider({});
        assert.equal(provider.htmlToMarkdown(root.body.innerHTML, document), source);
        code.textContent = 'a `new-b` c';
        const saved = provider.htmlToMarkdown(root.body.innerHTML, document);
        const reopened = render(saved);
        assert.equal(reopened.querySelector('code').textContent, 'a `new-b` c');
        assert.ok(!reopened.querySelector('pre'), saved);
        assert.equal(reopened.querySelector('p:last-child').textContent, 'Hello');
        assert.doesNotMatch(saved, /MDW_/);
    }
});

test('a fence-looking indented code line does not protect later ordinary blocks', () => {
    const source = '-     ```js\n      echo hello\n      ```\n\n> quote\n>\n> next\n';
    const root = render(source);
    assert.equal(root.querySelector('li pre code').textContent, '```js\necho hello\n```\n');
    assert.equal(root.querySelectorAll('blockquote p').length, 3);
    assert.doesNotMatch(root.body.textContent, /MDW_/);
    root.querySelector('li pre code').textContent += 'changed\n';
    const saved = new MarkdownEditorProvider({}).htmlToMarkdown(root.body.innerHTML, textDocument(source));
    assert.equal(render(saved).querySelector('li pre code').textContent, '```js\necho hello\n```\nchanged\n');
    assert.equal(render(saved).querySelectorAll('blockquote p').length, 3);
});
