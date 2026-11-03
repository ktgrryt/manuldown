const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const source = fs.readFileSync(path.join(__dirname, '..', 'media/modules/TableManager.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const formats = [
    ['bold', 'strong', 'b'], ['italic', 'em', 'i'],
    ['strikethrough', 'del', 's'], ['inlinecode', 'code', 'code']
];

async function fixture(t, html) {
    const { TableManager } = await modulePromise;
    const window = domino.createWindow(`<div id="editor">${html}</div>`);
    const document = window.document;
    const editor = document.getElementById('editor');
    const originals = { window: global.window, document: global.document, Node: global.Node };
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
    Object.assign(global, { window, document, Node: window.Node });
    Object.defineProperty(global, 'navigator', { configurable: true, value: { platform: 'MacIntel' } });
    t.after(() => {
        for (const [key, value] of Object.entries(originals)) {
            if (value === undefined) delete global[key];
            else global[key] = value;
        }
        if (navigatorDescriptor) Object.defineProperty(global, 'navigator', navigatorDescriptor);
        else delete global.navigator;
    });
    const calls = [];
    const manager = new TableManager(editor, {
        ensureInlineCodeSpaces: () => calls.push('normalize')
    }, {
        saveState: () => calls.push('save'),
        commitStateAfterChange: () => calls.push('commit')
    });
    manager.notifyChange = () => calls.push('notify');
    const cells = Array.from(editor.querySelectorAll('td, th'));
    return {
        window, document, editor, manager, cells, calls,
        select(indices) {
            cells.forEach(cell => cell.classList.remove('md-table-cell-selected'));
            manager.selectedCells = indices.map(index => cells[index]);
            manager.selectedCells.forEach(cell => cell.classList.add('md-table-cell-selected'));
        }
    };
}

for (const [command, tag] of formats) {
    test(`${command} toggles the full selected rectangle with one history change`, async t => {
        const f = await fixture(t, '<table><tr><th>A</th><td>B</td><td>outside</td></tr>' +
            '<tr><td>C</td><td>D</td><td>unchanged</td></tr></table>');
        const indices = [0, 1, 3, 4];
        f.select(indices);
        const unselected = [f.cells[2].outerHTML, f.cells[5].outerHTML];
        assert.equal(f.manager.getSelectedCellFormatState(command), false);
        assert.equal(f.manager.formatSelectedCells(command), true);
        assert.equal(f.manager.getSelectedCellFormatState(command), true);
        for (const index of indices) {
            assert.equal(f.cells[index].querySelector(tag).textContent, f.cells[index].textContent);
            assert.equal(f.cells[index].classList.contains('md-table-cell-selected'), true);
        }
        assert.deepEqual(f.calls, ['save', 'normalize', 'notify', 'commit']);
        assert.deepEqual([f.cells[2].outerHTML, f.cells[5].outerHTML], unselected);

        assert.equal(f.manager.formatSelectedCells(command), true);
        assert.equal(f.manager.getSelectedCellFormatState(command), false);
        assert.equal(f.editor.querySelectorAll(tag).length, 0);
        assert.deepEqual(f.calls, ['save', 'normalize', 'notify', 'commit', 'save', 'normalize', 'notify', 'commit']);
    });
}

for (const [command, tag, alias] of formats) {
    test(`${command} applies uniformly to mixed cells and recognizes semantic aliases`, async t => {
        const f = await fixture(t, `<table><tr><td><${alias}>already</${alias}></td><td>plain</td></tr></table>`);
        f.select([0, 1]);
        const existing = f.cells[0].firstChild;
        assert.equal(f.manager.getSelectedCellFormatState(command), false);
        f.manager.formatSelectedCells(command);
        assert.equal(f.manager.getSelectedCellFormatState(command), true);
        assert.ok(f.cells[0].firstChild === existing, 'already formatted content is not wrapped again');
        assert.equal(f.cells[0].querySelectorAll(`${tag}, ${alias}`).length, 1);
        assert.equal(f.cells[1].firstChild.tagName, tag.toUpperCase());
        f.manager.formatSelectedCells(command);
        assert.equal(f.cells[0].innerHTML, 'already');
        assert.equal(f.cells[1].innerHTML, 'plain');
    });
}

for (const [command, tag] of formats) {
    test(`${command} wraps escaped source characters externally so formatting can be saved`, async t => {
        const f = await fixture(t, '<table><tr><td><span data-mdw-escaped-character="true">*</span> text</td></tr></table>');
        f.select([0]);
        const escaped = f.cells[0].firstChild;
        f.manager.formatSelectedCells(command);
        assert.equal(escaped.parentElement.tagName, tag.toUpperCase());
        assert.equal(escaped.innerHTML, '*');
        assert.equal(escaped.getAttribute('data-mdw-escaped-character'), 'true');
        f.manager.formatSelectedCells(command);
        assert.ok(f.cells[0].firstChild === escaped);
        assert.equal(f.cells[0].querySelectorAll(tag).length, 0);
    });
}

for (const [command, tag, alias] of formats) {
    test(`${command} merges adjacent marks to avoid saving literal delimiter characters`, async t => {
        const f = await fixture(t, `<table><tr><td>prefix<${alias} data-kept="yes">middle</${alias}>suffix</td></tr></table>`);
        f.select([0]);
        f.manager.formatSelectedCells(command);
        assert.equal(f.cells[0].children.length, 1);
        assert.equal(f.cells[0].textContent, 'prefixmiddlesuffix');
        assert.equal(f.cells[0].firstChild.getAttribute('data-kept'), 'yes');
        assert.equal(f.manager.getSelectedCellFormatState(command), true);
        f.manager.formatSelectedCells(command);
        assert.equal(f.cells[0].innerHTML, 'prefixmiddlesuffix');
        assert.equal(f.cells[0].querySelectorAll(tag).length, 0);
    });
}

test('removing a mark merges remaining adjacent styles without changing their text', async t => {
    const f = await fixture(t, '<table><tr><td><strong><em>A</em></strong><em><strong>B</strong></em></td></tr></table>');
    f.select([0]);
    f.manager.formatSelectedCells('bold');
    assert.equal(f.cells[0].innerHTML, '<em>AB</em>');
});

test('format merging leaves adjacent read-only code outside the editable mark', async t => {
    const f = await fixture(t, '<table><tr><td><code contenteditable="false">readonly</code>editable</td></tr></table>');
    f.select([0]);
    const readonly = f.cells[0].firstChild;
    f.manager.formatSelectedCells('inlinecode');
    assert.ok(f.cells[0].firstChild === readonly);
    assert.equal(readonly.outerHTML, '<code contenteditable="false">readonly</code>');
    assert.equal(readonly.nextSibling.outerHTML, '<code>editable</code>');
});

test('removing bold preserves links, other marks, line breaks, attributes and table handles', async t => {
    const f = await fixture(t, '<table><tr><td data-cell="kept"><strong><b><a href="note.md" title="Keep"><em>日本語</em></a><br> text</b></strong>' +
        '<span class="md-table-structure-handle" data-exclude-from-markdown="true" contenteditable="false"></span></td></tr></table>');
    f.select([0]);
    const link = f.editor.querySelector('a');
    const italic = f.editor.querySelector('em');
    const br = f.editor.querySelector('br');
    const handle = f.editor.querySelector('.md-table-structure-handle');
    const handleHtml = handle.outerHTML;
    f.manager.formatSelectedCells('bold');
    assert.equal(f.editor.querySelectorAll('strong, b').length, 0);
    assert.ok(f.editor.querySelector('a') === link);
    assert.equal(link.getAttribute('href'), 'note.md');
    assert.equal(link.getAttribute('title'), 'Keep');
    assert.ok(f.editor.querySelector('em') === italic);
    assert.ok(f.editor.querySelector('br') === br);
    assert.ok(handle.parentElement === f.cells[0]);
    assert.equal(handle.outerHTML, handleHtml);
    assert.equal(f.cells[0].getAttribute('data-cell'), 'kept');
});

test('row and column selections format only their own cells and retain structure selection', async t => {
    const f = await fixture(t, '<table><tr><th>A</th><th>B</th><th>C</th></tr>' +
        '<tr><td>D</td><td>E</td><td>F</td></tr><tr><td>G</td><td>H</td><td>I</td></tr></table>');
    const table = f.editor.querySelector('table');
    const selection = { type: 'row', table, index: 1 };
    f.manager.structureSelection = selection;
    f.manager.formatSelectedCells('italic');
    assert.ok(f.manager.structureSelection === selection);
    assert.equal(f.manager.getSelectedCellFormatState('italic'), true);
    f.cells.forEach((cell, index) => assert.equal(!!cell.querySelector('em'), [3, 4, 5].includes(index)));
    f.manager.structureSelection = { type: 'col', table, index: 2 };
    f.manager.formatSelectedCells('strikethrough');
    f.cells.forEach((cell, index) => assert.equal(!!cell.querySelector('del'), [2, 5, 8].includes(index)));
    assert.equal(f.manager.getSelectedCellFormatState('strikethrough'), true);
    assert.deepEqual(f.calls, ['save', 'normalize', 'notify', 'commit', 'save', 'normalize', 'notify', 'commit']);
});

test('inline code keeps existing marks while emphasis wraps literal code externally', async t => {
    const f = await fixture(t, '<table><tr><td><code data-source="kept">a*b</code></td><td><strong>marked</strong></td></tr></table>');
    f.select([0]);
    const code = f.cells[0].firstChild;
    f.manager.formatSelectedCells('bold');
    assert.ok(code.parentElement === f.cells[0].firstChild);
    assert.equal(code.parentElement.tagName, 'STRONG');
    assert.equal(code.getAttribute('data-source'), 'kept');
    assert.equal(code.innerHTML, 'a*b');
    f.manager.formatSelectedCells('bold');
    assert.ok(f.cells[0].firstChild === code);
    f.select([1]);
    const strong = f.cells[1].firstChild;
    f.manager.formatSelectedCells('inlinecode');
    assert.ok(f.cells[1].firstChild === strong);
    assert.equal(strong.firstChild.tagName, 'CODE');
    assert.equal(strong.textContent, 'marked');
});

test('atomic and read-only content is excluded without changing its existing formatting', async t => {
    const f = await fixture(t, '<table><tr><td>editable ' +
        '<span contenteditable="false">readonly</span><span data-mdw-opaque-source="true">source</span>' +
        '<span data-mdw-math="inline">x+y</span><sup data-mdw-footnote-ref="a">1</sup>' +
        '<pre><code>literal</code></pre><span data-exclude-from-markdown="true">control</span></td></tr></table>');
    f.select([0]);
    const protectedNodes = Array.from(f.cells[0].children);
    const original = protectedNodes.map(node => node.outerHTML);
    f.manager.formatSelectedCells('bold');
    assert.equal(f.cells[0].firstChild.tagName, 'STRONG');
    protectedNodes.forEach((node, index) => {
        assert.ok(node.parentElement === f.cells[0]);
        assert.equal(node.outerHTML, original[index]);
    });

    f.cells[0].innerHTML = '<strong>editable<span contenteditable="false">atomic</span></strong>';
    const atomic = f.cells[0].querySelector('span');
    f.manager.formatSelectedCells('bold');
    assert.equal(f.cells[0].firstChild.nodeType, 3);
    assert.equal(f.cells[0].firstChild.textContent, 'editable');
    assert.ok(f.cells[0].querySelector('span') === atomic);
    assert.equal(atomic.parentElement.tagName, 'STRONG');
});

test('empty or read-only selected cells consume formatting without inserting marks or history', async t => {
    const f = await fixture(t, '<table><tr><td><br></td><td>\u200B\u2060\uFEFF\u00A0</td>' +
        '<td contenteditable="false">readonly</td></tr></table>');
    f.select([0, 1, 2]);
    const original = f.editor.innerHTML;
    for (const [command] of formats) {
        assert.equal(f.manager.getSelectedCellFormatState(command), false);
        assert.equal(f.manager.formatSelectedCells(command), true);
    }
    assert.equal(f.editor.innerHTML, original);
    assert.deepEqual(f.calls, []);
});

test('unsupported commands and stale selections do not format native caret content', async t => {
    const f = await fixture(t, '<table><tr><td>native caret</td></tr></table>');
    f.manager.selectedCells = [f.cells[0]];
    assert.equal(f.manager.getSelectedCellFormatState('bold'), null);
    assert.equal(f.manager.formatSelectedCells('bold'), false);
    f.select([0]);
    for (const command of ['h1', 'link', 'constructor', '__proto__']) {
        assert.equal(f.manager.getSelectedCellFormatState(command), null);
        assert.equal(f.manager.formatSelectedCells(command), false);
    }
    assert.equal(f.cells[0].innerHTML, 'native caret');
    assert.deepEqual(f.calls, []);
});

test('visible rectangular highlights take precedence over a stale structure selection', async t => {
    const f = await fixture(t, '<table><tr><td>A</td><td>B</td></tr></table>');
    f.select([1]);
    f.manager.structureSelection = { type: 'col', table: f.editor.querySelector('table'), index: 0 };
    f.manager.formatSelectedCells('bold');
    assert.equal(f.cells[0].innerHTML, 'A');
    assert.equal(f.cells[1].querySelector('strong').textContent, 'B');
});
