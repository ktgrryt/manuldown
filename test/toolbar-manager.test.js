const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const toolbarManagerSource = fs.readFileSync(
    path.join(__dirname, '..', 'media', 'modules', 'ToolbarManager.js'),
    'utf8'
);
const toolbarManagerModulePromise = import(
    `data:text/javascript;base64,${Buffer.from(toolbarManagerSource).toString('base64')}`
);

async function createToolbarManager() {
    const { ToolbarManager } = await toolbarManagerModulePromise;
    const savedStates = [];
    const manager = new ToolbarManager(
        { focus: () => {} },
        { saveState: () => savedStates.push(true) }
    );
    manager.isSelectionInTableCellContext = () => false;
    manager.isSelectionInListContext = () => false;
    manager.updateToolbarState = () => {};
    return { manager, savedStates };
}

test('clicking the active heading level toggles it back to a paragraph', async () => {
    const { manager, savedStates } = await createToolbarManager();
    const formattedBlocks = [];
    manager.getActiveHeadingCommand = () => 'h1';
    manager.formatBlock = (tag) => formattedBlocks.push(tag);

    manager.executeCommand('h1');

    assert.deepEqual(formattedBlocks, ['p']);
    assert.equal(savedStates.length, 1);
});

test('clicking a different heading level still changes the heading level', async () => {
    const { manager } = await createToolbarManager();
    const formattedBlocks = [];
    manager.getActiveHeadingCommand = () => 'h1';
    manager.formatBlock = (tag) => formattedBlocks.push(tag);

    manager.executeCommand('h2');

    assert.deepEqual(formattedBlocks, ['h2']);
});

test('the active heading button remains enabled and exposes its pressed state', async () => {
    const { manager } = await createToolbarManager();
    const classes = new Set();
    const attributes = new Map();
    const button = {
        disabled: false,
        classList: {
            toggle: (name, enabled) => {
                if (enabled) {
                    classes.add(name);
                } else {
                    classes.delete(name);
                }
            },
        },
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: (name) => attributes.delete(name),
    };
    manager.commandButtons.set('h1', button);
    manager.isSelectionInHeadingContext = () => true;
    manager.isSelectionInCodeBlockContext = () => false;
    manager.getActiveHeadingCommand = () => 'h1';

    manager.updateCommandAvailability();

    assert.equal(button.disabled, false);
    assert.equal(classes.has('is-current-heading'), true);
    assert.equal(classes.has('is-disabled'), false);
    assert.equal(attributes.get('aria-pressed'), 'true');
    assert.equal(attributes.has('aria-disabled'), false);
});
