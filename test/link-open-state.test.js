const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domino = require('@mixmark-io/domino');

const source = fs.readFileSync(path.join(__dirname, '..', 'media/editor.js'), 'utf8');
const securitySource = fs.readFileSync(path.join(__dirname, '..', 'media/modules/WorkspaceLinkSecurity.js'), 'utf8');
const security = new Function(`${securitySource.replaceAll('export function ', 'function ')}
    return { linkInputLooksLikeNativeAbsolutePath, getWorkspaceLinkSuggestionQuery, linkInputRequiresWorkspaceResolution };`)();

function extract(name, indent = '        ') {
    const start = source.indexOf(`${indent}function ${name}(`);
    const end = source.indexOf(`\n${indent}}\n`, start);
    assert.ok(start >= 0 && end > start, name);
    return source.slice(start, end + indent.length + 2);
}

function fixture(url = '../outside/notes.md') {
    const window = domino.createWindow('<div id="editor"><a>notes</a></div>');
    const document = window.document;
    const editor = document.getElementById('editor');
    const messages = [];
    const timers = new Map();
    const settingsState = { allowFileLinks: false };
    let timerSequence = 0;
    let saved = 0;
    let opened = 0;
    let hidden = 0;
    const start = source.indexOf('        let linkPopover = null;');
    const end = source.indexOf('        function createLinkPopover()', start);
    const receiveStart = source.indexOf('        receiveLinkOpenState = (message) => {');
    const receiveEnd = source.indexOf('        function syncLinkPopoverOpenButtonState', receiveStart);
    const dependencies = {
        window, document, editor, settingsState, ...security,
        vscode: { postMessage: message => messages.push(message) },
        setTimeout: (callback, delay) => { timers.set(++timerSequence, { callback, delay }); return timerSequence; },
        clearTimeout: id => timers.delete(id),
        repositionLinkPopoverWithinViewport() {},
        saveLinkUrlIfChanged: () => { saved++; },
        navigateToLink: () => { opened++; return true; },
        hideLinkPopover: () => { hidden++; },
        submitLinkPopoverInput() { assert.fail('a stored path should open without rewriting its href'); },
    };
    const ui = new Function(...Object.keys(dependencies), `
        ${source.slice(start, end)}
        let receiveLinkOpenState, refreshLinkOpenState;
        ${['hasExplicitScheme', 'sanitizeLinkHref'].map(name => extract(name, '    ')).join('\n')}
        ${['createLinkPopover', 'isStoredCurrentLinkHref', 'linkPopoverInputNeedsHostResolution',
            'linkPopoverInputAwaitsWorkspaceSuggestion', 'isOpenableLinkUrl', 'resetLinkOpenCheck',
            'getLinkPopoverOpenState', 'syncLinkPopoverOpenButtonState', 'openLink'].map(name => extract(name)).join('\n')}
        ${source.slice(receiveStart, receiveEnd)}
        linkPopover = createLinkPopover();
        linkPopover.style.display = 'flex';
        currentLink = editor.querySelector('a');
        return {
            popover: linkPopover, receive: receiveLinkOpenState, refresh: refreshLinkOpenState, open: openLink,
            setUrl(url, stored = true, inert = false) {
                if (inert) {
                    currentLink.removeAttribute('href');
                    currentLink.setAttribute('data-mdw-preserved-href', url);
                } else {
                    currentLink.setAttribute('href', url);
                    currentLink.removeAttribute('data-mdw-preserved-href');
                }
                linkInputBaselineValue = stored ? url : '../original.md';
                linkPopover.querySelector('input').value = url;
                syncLinkPopoverOpenButtonState(url);
            },
            reset: resetLinkOpenCheck,
        };
    `)(...Object.values(dependencies));
    ui.setUrl(url);
    return {
        ...ui, messages, settingsState,
        button: ui.popover.querySelector('[data-action="open"]'),
        status: ui.popover.querySelector('.link-popover-open-status'),
        get saved() { return saved; },
        get opened() { return opened; },
        get hidden() { return hidden; },
        runTimers(delay) {
            for (const [id, timer] of [...timers]) {
                if (timer.delay === delay) {
                    timers.delete(id);
                    timer.callback();
                }
            }
        },
        reply(properties = {}) {
            const request = messages.filter(message => message.type === 'checkLinkOpen').at(-1);
            assert.ok(request, 'a host permission check was requested');
            return ui.receive({ ...request, type: 'linkOpenState', allowed: true, ...properties });
        },
    };
}

for (const url of ['../outside/notes.md', '~/code']) {
    test(`Open stays disabled and explains the required setting without a settings button for ${url}`, () => {
        const f = fixture(url);
        assert.equal(f.button.disabled, true);
        assert.match(f.status.textContent, /Checking link access/);
        f.open();
        assert.equal(f.opened, 0);
        f.runTimers(120);
        const message = 'Opening files outside the current workspace folder is blocked. Enable Allow File Links in User Settings.';
        f.reply({ allowed: false, message });
        assert.equal(f.button.disabled, true);
        assert.equal(f.button.getAttribute('aria-disabled'), 'true');
        assert.equal(f.status.hidden, false);
        assert.ok(f.status.textContent.includes(message));
        assert.ok(!f.popover.querySelector('[data-action="file-settings"]'));
        f.open();
        assert.equal(f.saved, 0);
        assert.equal(f.opened, 0);
        assert.equal(f.hidden, 0);
    });
}

for (const url of ['./notes.md', '/project/notes.md', 'https://example.com']) {
    test(`host-approved ${url} enables Open`, () => {
        const f = fixture(url);
        assert.equal(f.button.textContent, 'Open');
        assert.equal(f.button.disabled, true);
        f.runTimers(120);
        f.reply();
        assert.equal(f.button.disabled, false);
        assert.equal(f.status.hidden, true);
        f.open();
        assert.equal(f.opened, 1);
        assert.equal(f.saved, 1);
        assert.equal(f.hidden, 1);
    });
}

test('missing files show their own explanation without suggesting a security change', () => {
    const f = fixture('./missing.md');
    f.runTimers(120);
    f.reply({ allowed: false, message: 'This file does not exist or cannot be accessed.' });
    assert.equal(f.button.disabled, true);
    assert.match(f.status.textContent, /does not exist/);
});

test('preserved unsupported destinations remain blocked when the link popup is opened', () => {
    for (const url of ['tel:123', 'javascript:alert(1)', 'vscode://file/a.md']) {
        const f = fixture();
        f.setUrl(url, true, true);
        assert.equal(f.button.disabled, true);
        assert.match(f.status.textContent, /cannot be opened/);
        f.open();
        assert.equal(f.opened, 0);
        assert.equal(f.saved, 0);
        assert.equal(f.messages.length, 0);
        assert.equal(f.popover.ownerDocument.querySelector('a').getAttribute('href'), null);
    }
});

test('editing and reverting a preserved link never restores an unsupported URL as a navigable href', () => {
    const window = domino.createWindow('<div id="editor"><a data-mdw-preserved-href="tel:123">phone</a></div>');
    const editor = window.document.getElementById('editor');
    const link = editor.querySelector('a');
    const input = { value: 'tel:123' };
    let changes = 0;
    const ui = new Function('editor', 'currentLink', 'input', 'notifyChange', `
        const linkInputBaselineValue = 'tel:123';
        const linkPopover = { querySelector: () => input };
        const settingsState = { allowFileLinks: false };
        const linkPopoverInputNeedsHostResolution = () => false;
        const syncLinkPopoverOpenButtonState = () => {};
        ${['hasExplicitScheme', 'sanitizeLinkHref'].map(name => extract(name, '    ')).join('\n')}
        ${['restoreLinkHrefToBaseline', 'saveLinkUrlIfChanged', 'isOpenableLinkUrl'].map(name => extract(name)).join('\n')}
        return { restore: restoreLinkHrefToBaseline, save: saveLinkUrlIfChanged };
    `)(editor, link, input, () => changes++);
    assert.equal(ui.save(), false);
    assert.equal(changes, 0);
    input.value = './partial.md';
    assert.equal(ui.save(), true);
    assert.equal(link.getAttribute('data-mdw-preserved-href'), null);
    assert.equal(ui.restore(), true);
    assert.equal(link.getAttribute('href'), null);
    assert.equal(link.getAttribute('data-mdw-preserved-href'), 'tel:123');
    input.value = 'javascript:alert(1)';
    assert.equal(ui.save({ revertInvalid: false }), false);
    assert.equal(link.getAttribute('href'), null);
    input.value = 'https://example.com';
    assert.equal(ui.save(), true);
    assert.equal(link.getAttribute('href'), input.value);
    assert.equal(link.getAttribute('data-mdw-preserved-href'), null);
});

test('changing settings rechecks a blocked file link and rejects the older permission result', () => {
    const f = fixture('file:///outside/notes.md');
    f.runTimers(120);
    const first = f.messages.at(-1);
    f.reply({ allowed: false, message: 'Opening file:// links is disabled.' });
    f.settingsState.allowFileLinks = true;
    f.refresh();
    assert.equal(f.button.disabled, true);
    f.runTimers(120);
    assert.equal(f.receive({ ...first, allowed: true }), false);
    assert.equal(f.button.disabled, true);
    f.reply();
    assert.equal(f.button.disabled, false);
    assert.equal(f.status.hidden, true);
});

test('old results and timeout callbacks cannot change the status of an edited URL or heading', () => {
    const f = fixture('./first.md');
    f.runTimers(120);
    const first = f.messages.at(-1);
    f.setUrl('./second.md');
    assert.equal(f.receive({ ...first, allowed: true }), false);
    f.runTimers(120);
    f.reply();
    assert.equal(f.button.disabled, false);
    f.setUrl('#heading');
    f.runTimers(5000);
    assert.equal(f.button.disabled, false);
    assert.equal(f.status.hidden, true);
    f.setUrl('command:unsafe');
    f.runTimers(5000);
    assert.equal(f.button.disabled, true);
    assert.match(f.status.textContent, /cannot be opened/);
});

test('validation timeouts fail closed with an explanation and closing discards late results', () => {
    const f = fixture('./notes.md');
    f.runTimers(120);
    f.runTimers(5000);
    assert.equal(f.button.disabled, true);
    assert.match(f.status.textContent, /Could not check this link/);
    f.reset();
    assert.equal(f.reply(), false);
});

test('returning from Settings refreshes a permission check that could not run while the editor was inactive', () => {
    const f = fixture('./notes.md');
    f.runTimers(120);
    f.runTimers(5000);
    const focus = f.popover.ownerDocument.createEvent('Event');
    focus.initEvent('focus', false, false);
    f.popover.ownerDocument.defaultView.dispatchEvent(focus);
    assert.match(f.status.textContent, /Checking link access/);
    f.runTimers(120);
    f.reply();
    assert.equal(f.button.disabled, false);
});
