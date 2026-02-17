import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './editor/MarkdownEditorProvider';

const MARKDOWN_ASSOCIATION_PROMPT_KEY = 'manulDown.markdownAssociationPromptShown';
const MANULDOWN_EDITOR_VIEW_TYPE = 'manulDown.editor';
const MANULDOWN_CONFIGURATION_SECTION = 'manulDown';
const OPEN_BY_DEFAULT_SETTING_KEY = 'openByDefault';
const MARKDOWN_FILE_ASSOCIATION_KEY = '*.md';

export function activate(context: vscode.ExtensionContext) {
    void initializeDefaultMarkdownAssociation(context);

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
            void syncDefaultMarkdownAssociationWithSetting();
        }
    });
    context.subscriptions.push(configurationListener);
}

export function deactivate() {
}

async function initializeDefaultMarkdownAssociation(context: vscode.ExtensionContext): Promise<void> {
    await promptForDefaultMarkdownAssociation(context);
    await syncDefaultMarkdownAssociationWithSetting();
}

async function promptForDefaultMarkdownAssociation(context: vscode.ExtensionContext): Promise<void> {
    const hasPrompted = context.globalState.get<boolean>(MARKDOWN_ASSOCIATION_PROMPT_KEY, false);
    if (hasPrompted) {
        return;
    }

    if (!getOpenByDefaultSetting()) {
        await context.globalState.update(MARKDOWN_ASSOCIATION_PROMPT_KEY, true);
        return;
    }

    const editorAssociations = getEditorAssociations();

    if (editorAssociations[MARKDOWN_FILE_ASSOCIATION_KEY] === MANULDOWN_EDITOR_VIEW_TYPE) {
        await context.globalState.update(MARKDOWN_ASSOCIATION_PROMPT_KEY, true);
        return;
    }

    const setDefaultAction = 'Set as Default';
    const skipAction = 'No';
    const selection = await vscode.window.showInformationMessage(
        'Set ManulDown as the default editor for Markdown files (*.md)?',
        { modal: true },
        setDefaultAction,
        skipAction
    );

    if (selection === setDefaultAction) {
        try {
            await setOpenByDefaultSetting(true);
            vscode.window.showInformationMessage('ManulDown is now the default editor for Markdown files.');
            await context.globalState.update(MARKDOWN_ASSOCIATION_PROMPT_KEY, true);
            return;
        } catch {
            vscode.window.showErrorMessage('Failed to save the default Markdown editor setting.');
            return;
        }
    }

    try {
        await setOpenByDefaultSetting(false);
    } catch {
        vscode.window.showErrorMessage('Failed to save the default Markdown editor setting.');
        return;
    }

    await context.globalState.update(MARKDOWN_ASSOCIATION_PROMPT_KEY, true);
}

async function syncDefaultMarkdownAssociationWithSetting(): Promise<void> {
    const openByDefault = getOpenByDefaultSetting();
    const workbenchConfig = vscode.workspace.getConfiguration('workbench');
    const editorAssociations = getEditorAssociations();
    const currentAssociation = editorAssociations[MARKDOWN_FILE_ASSOCIATION_KEY];

    if (openByDefault) {
        if (currentAssociation === MANULDOWN_EDITOR_VIEW_TYPE) {
            return;
        }

        const updatedEditorAssociations: Record<string, string> = {
            ...editorAssociations,
            [MARKDOWN_FILE_ASSOCIATION_KEY]: MANULDOWN_EDITOR_VIEW_TYPE,
        };

        try {
            await workbenchConfig.update(
                'editorAssociations',
                updatedEditorAssociations,
                vscode.ConfigurationTarget.Global
            );
        } catch {
            vscode.window.showErrorMessage('Failed to update default Markdown editor setting.');
        }
        return;
    }

    if (currentAssociation !== MANULDOWN_EDITOR_VIEW_TYPE) {
        return;
    }

    const { [MARKDOWN_FILE_ASSOCIATION_KEY]: _, ...updatedEditorAssociations } = editorAssociations;
    try {
        await workbenchConfig.update(
            'editorAssociations',
            updatedEditorAssociations,
            vscode.ConfigurationTarget.Global
        );
    } catch {
        vscode.window.showErrorMessage('Failed to update default Markdown editor setting.');
    }
}

function getOpenByDefaultSetting(): boolean {
    return vscode.workspace
        .getConfiguration(MANULDOWN_CONFIGURATION_SECTION)
        .get<boolean>(OPEN_BY_DEFAULT_SETTING_KEY, true);
}

async function setOpenByDefaultSetting(value: boolean): Promise<void> {
    await vscode.workspace
        .getConfiguration(MANULDOWN_CONFIGURATION_SECTION)
        .update(OPEN_BY_DEFAULT_SETTING_KEY, value, vscode.ConfigurationTarget.Global);
}

function getEditorAssociations(): Record<string, string> {
    return vscode.workspace.getConfiguration('workbench').get<Record<string, string>>('editorAssociations') ?? {};
}

// Made with Bob
