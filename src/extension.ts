import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './editor/MarkdownEditorProvider';

const MANULDOWN_EDITOR_VIEW_TYPE = 'manulDown.editor';
const MANULDOWN_CONFIGURATION_SECTION = 'manulDown';
const OPEN_BY_DEFAULT_SETTING_KEY = 'openByDefault';
const MARKDOWN_FILE_ASSOCIATION_KEY = '*.md';
const AUTO_OPEN_GUARD_TTL_MS = 2500;
const AUTO_OPEN_SUPPRESS_TTL_MS = 4000;
const SOURCE_CONTROL_SCHEMES = new Set(['git', 'svn', 'hg']);
const SOURCE_CONTROL_LABEL_KEYWORDS = [
    'working tree',
    'index',
    'staged',
    'untracked',
    '作業ツリー',
    'インデックス',
    'ステージ',
    '未追跡',
];

export function activate(context: vscode.ExtensionContext) {
    void removeLegacyMarkdownEditorAssociation();

    // Register the custom editor provider
    const provider = new MarkdownEditorProvider(context);
    const registration = vscode.window.registerCustomEditorProvider(
        MANULDOWN_EDITOR_VIEW_TYPE,
        provider,
        {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
            supportsMultipleEditorsPerDocument: false,
        }
    );

    context.subscriptions.push(registration);

    const autoOpenSuppressedUntil = new Map<string, number>();
    registerOpenByDefaultBehavior(context, autoOpenSuppressedUntil);

    // Register command to open with WYSIWYG editor
    const openEditorCommand = vscode.commands.registerCommand(
        'manulDown.openEditor',
        async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && activeEditor.document.languageId === 'markdown') {
                const uri = activeEditor.document.uri;
                provider.explicitlyRequested = true;
                await vscode.commands.executeCommand('vscode.openWith', uri, MANULDOWN_EDITOR_VIEW_TYPE);
            } else {
                vscode.window.showInformationMessage('Please open a Markdown file first');
            }
        }
    );

    context.subscriptions.push(openEditorCommand);

    // Register command to open with text editor
    const openTextEditorCommand = vscode.commands.registerCommand(
        'manulDown.openTextEditor',
        async () => {
            const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
            const input = activeTab?.input;
            if (input instanceof vscode.TabInputCustom) {
                suppressAutoOpenForUri(autoOpenSuppressedUntil, input.uri);
                await vscode.commands.executeCommand('vscode.openWith', input.uri, 'default');
            }
        }
    );

    context.subscriptions.push(openTextEditorCommand);

    // Register command to toggle between WYSIWYG and text editor
    const toggleEditorCommand = vscode.commands.registerCommand(
        'manulDown.toggleEditor',
        async () => {
            const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
            const input = activeTab?.input;
            if (input instanceof vscode.TabInputCustom) {
                // Currently in WYSIWYG editor -> switch to text editor
                suppressAutoOpenForUri(autoOpenSuppressedUntil, input.uri);
                await vscode.commands.executeCommand('vscode.openWith', input.uri, 'default');
            } else if (input instanceof vscode.TabInputText) {
                // Currently in text editor -> switch to WYSIWYG editor
                provider.explicitlyRequested = true;
                await vscode.commands.executeCommand('vscode.openWith', input.uri, MANULDOWN_EDITOR_VIEW_TYPE);
            }
        }
    );

    context.subscriptions.push(toggleEditorCommand);

    const cursorUpCommand = vscode.commands.registerCommand(
        'manulDown.cursorUp',
        () => {
            const posted = provider.postMessageToActiveEditor({
                type: 'cursorMove',
                direction: 'up',
            });
            if (!posted) {
                vscode.window.showInformationMessage('Open a ManulDown editor to use cursor navigation.');
            }
        }
    );

    context.subscriptions.push(cursorUpCommand);

    const cursorRightCommand = vscode.commands.registerCommand(
        'manulDown.cursorRight',
        () => {
            const posted = provider.postMessageToActiveEditor({
                type: 'cursorMove',
                direction: 'right',
            });
            if (!posted) {
                vscode.window.showInformationMessage('Open a ManulDown editor to use cursor navigation.');
            }
        }
    );

    context.subscriptions.push(cursorRightCommand);

    const tableCommands = [
        { id: 'manulDown.table.insertRowAbove', command: 'insertRowAbove' },
        { id: 'manulDown.table.insertRowBelow', command: 'insertRowBelow' },
        { id: 'manulDown.table.insertColumnLeft', command: 'insertColumnLeft' },
        { id: 'manulDown.table.insertColumnRight', command: 'insertColumnRight' },
        { id: 'manulDown.table.selectCurrentColumn', command: 'selectColumn' },
        { id: 'manulDown.table.selectCurrentRow', command: 'selectRow' },
    ];

    tableCommands.forEach(({ id, command }) => {
        const disposable = vscode.commands.registerCommand(id, () => {
            const posted = provider.postMessageToActiveEditor({
                type: 'tableCommand',
                command,
            });
            if (!posted) {
                vscode.window.showInformationMessage('Open a ManulDown editor to use table commands.');
            }
        });
        context.subscriptions.push(disposable);
    });

    const configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`${MANULDOWN_CONFIGURATION_SECTION}.${OPEN_BY_DEFAULT_SETTING_KEY}`)) {
            void removeLegacyMarkdownEditorAssociation();
        }
    });
    context.subscriptions.push(configurationListener);
}

export function deactivate() {
}

function registerOpenByDefaultBehavior(
    context: vscode.ExtensionContext,
    autoOpenSuppressedUntil: Map<string, number>
): void {
    const recentlyAutoOpened = new Map<string, number>();
    const tabListener = vscode.window.tabGroups.onDidChangeTabs((event) => {
        if (!getOpenByDefaultSetting()) {
            return;
        }

        pruneExpiredEntries(recentlyAutoOpened, AUTO_OPEN_GUARD_TTL_MS);
        pruneExpiredEntries(autoOpenSuppressedUntil, AUTO_OPEN_SUPPRESS_TTL_MS);

        for (const tab of event.opened) {
            const input = tab.input;
            if (!(input instanceof vscode.TabInputText)) {
                continue;
            }

            const targetUri = input.uri;
            if (!isPlainMarkdownFile(targetUri)) {
                continue;
            }

            if (isAutoOpenSuppressed(autoOpenSuppressedUntil, targetUri)) {
                continue;
            }

            if (isSourceControlOpenContext(tab, targetUri)) {
                continue;
            }

            const uriKey = targetUri.toString();
            if (recentlyAutoOpened.has(uriKey)) {
                continue;
            }
            recentlyAutoOpened.set(uriKey, Date.now());

            void openWithManulDownReplacingTextTabs(targetUri);
        }
    });
    context.subscriptions.push(tabListener);
}

function isPlainMarkdownFile(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file') {
        return false;
    }
    return uri.path.toLowerCase().endsWith('.md');
}

function isSourceControlOpenContext(tab: vscode.Tab, targetUri: vscode.Uri): boolean {
    if (hasSourceControlLabel(tab.label)) {
        return true;
    }

    return vscode.window.tabGroups.all.some((group) => group.tabs.some((candidateTab) => {
        const input = candidateTab.input;
        if (input instanceof vscode.TabInputTextDiff) {
            return (
                isSameUri(input.modified, targetUri) &&
                SOURCE_CONTROL_SCHEMES.has(input.original.scheme)
            );
        }

        return (
            input instanceof vscode.TabInputText &&
            SOURCE_CONTROL_SCHEMES.has(input.uri.scheme) &&
            isSamePath(input.uri.path, targetUri.path)
        );
    }));
}

function hasSourceControlLabel(label: string): boolean {
    const normalized = label.trim().toLowerCase();
    if (normalized === '') {
        return false;
    }

    return SOURCE_CONTROL_LABEL_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function isSameUri(left: vscode.Uri, right: vscode.Uri): boolean {
    return left.scheme === right.scheme && isSamePath(left.path, right.path);
}

function isSamePath(leftPath: string, rightPath: string): boolean {
    return toComparablePath(leftPath) === toComparablePath(rightPath);
}

function toComparablePath(pathValue: string): string {
    return process.platform === 'win32' ? pathValue.toLowerCase() : pathValue;
}

function suppressAutoOpenForUri(autoOpenSuppressedUntil: Map<string, number>, uri: vscode.Uri): void {
    if (uri.scheme !== 'file') {
        return;
    }
    autoOpenSuppressedUntil.set(uri.toString(), Date.now());
}

function isAutoOpenSuppressed(autoOpenSuppressedUntil: Map<string, number>, uri: vscode.Uri): boolean {
    const timestamp = autoOpenSuppressedUntil.get(uri.toString());
    if (!timestamp) {
        return false;
    }
    if (Date.now() - timestamp > AUTO_OPEN_SUPPRESS_TTL_MS) {
        autoOpenSuppressedUntil.delete(uri.toString());
        return false;
    }
    return true;
}

function pruneExpiredEntries(entries: Map<string, number>, ttlMs: number): void {
    const now = Date.now();
    entries.forEach((timestamp, key) => {
        if (now - timestamp > ttlMs) {
            entries.delete(key);
        }
    });
}

async function openWithManulDownReplacingTextTabs(targetUri: vscode.Uri): Promise<void> {
    try {
        await vscode.commands.executeCommand(
            'vscode.openWith',
            targetUri,
            MANULDOWN_EDITOR_VIEW_TYPE
        );
    } catch {
        return;
    }

    if (!hasManulDownTabForUri(targetUri)) {
        return;
    }

    const residualTextTabs = vscode.window.tabGroups.all.flatMap((group) =>
        group.tabs.filter((tab) => {
            const input = tab.input;
            return input instanceof vscode.TabInputText && isSameUri(input.uri, targetUri);
        })
    );

    if (residualTextTabs.length > 0) {
        await vscode.window.tabGroups.close(residualTextTabs, true);
    }
}

function hasManulDownTabForUri(targetUri: vscode.Uri): boolean {
    return vscode.window.tabGroups.all.some((group) =>
        group.tabs.some((tab) => {
            const input = tab.input;
            return (
                input instanceof vscode.TabInputCustom &&
                input.viewType === MANULDOWN_EDITOR_VIEW_TYPE &&
                isSameUri(input.uri, targetUri)
            );
        })
    );
}

async function removeLegacyMarkdownEditorAssociation(): Promise<void> {
    const workbenchConfig = vscode.workspace.getConfiguration('workbench');
    const inspected = workbenchConfig.inspect<Record<string, string>>('editorAssociations');
    if (!inspected) {
        return;
    }

    const updates: Array<{ target: vscode.ConfigurationTarget; value: Record<string, string> }> = [];
    const queueUpdate = (
        value: Record<string, string> | undefined,
        target: vscode.ConfigurationTarget
    ): void => {
        if (!value || value[MARKDOWN_FILE_ASSOCIATION_KEY] !== MANULDOWN_EDITOR_VIEW_TYPE) {
            return;
        }
        const { [MARKDOWN_FILE_ASSOCIATION_KEY]: _, ...updatedValue } = value;
        updates.push({ target, value: updatedValue });
    };

    queueUpdate(inspected.globalValue, vscode.ConfigurationTarget.Global);
    queueUpdate(inspected.workspaceValue, vscode.ConfigurationTarget.Workspace);

    if (updates.length === 0) {
        return;
    }

    try {
        for (const update of updates) {
            await workbenchConfig.update('editorAssociations', update.value, update.target);
        }
    } catch {
        vscode.window.showErrorMessage('Failed to update default Markdown editor setting.');
    }
}

function getOpenByDefaultSetting(): boolean {
    return vscode.workspace
        .getConfiguration(MANULDOWN_CONFIGURATION_SECTION)
        .get<boolean>(OPEN_BY_DEFAULT_SETTING_KEY, true);
}

// Made with Bob
