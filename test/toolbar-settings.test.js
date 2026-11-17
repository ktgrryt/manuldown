const assert = require('node:assert/strict');
const test = require('node:test');
const { toolbarItemDefaults, resolveToolbarItems } = require('../out/editor/ToolbarItems');
const manifest = require('../package.json');

test('the toolbar setting exposes a fixed checkbox list with matching runtime defaults', () => {
    const setting = manifest.contributes.configuration.properties['manulDown.toolbar.items'];
    assert.equal(setting.type, 'object');
    assert.equal(setting.additionalProperties, false);
    assert.deepEqual(setting.default, toolbarItemDefaults);
    assert.deepEqual(Object.keys(setting.properties), Object.keys(toolbarItemDefaults));
    for (const [key, property] of Object.entries(setting.properties)) {
        assert.equal(property.type, 'boolean', key);
        assert.equal(property.default, toolbarItemDefaults[key], key);
        assert.ok(property.description, key);
    }
    for (const key of ['link', 'image', 'footnote', 'math', 'mathblock', 'h4', 'h5', 'h6']) {
        assert.equal(setting.default[key], false, key);
    }
});

test('toolbar preferences merge partial checkbox changes and ignore invalid or unknown values', () => {
    const items = resolveToolbarItems({ bold: false, h4: true, image: true, h1: 'false', math: 1,
        extra: '</script><img src=https://evil.example/p.png>' });
    assert.equal(items.bold, false);
    assert.equal(items.h4, true);
    assert.equal(items.image, true);
    assert.equal(items.h1, true);
    assert.equal(items.math, false);
    assert.equal(items.extra, undefined);
    assert.equal(items.h2, true);
    assert.equal(toolbarItemDefaults.bold, true, 'Resolving preferences does not mutate defaults');
    for (const value of [undefined, null, false, 'h4', ['h4']]) {
        assert.deepEqual(resolveToolbarItems(value), toolbarItemDefaults);
    }
});
