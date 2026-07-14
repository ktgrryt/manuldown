import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './editor/MarkdownEditorProvider';

const MARKDOWN_ASSOCIATION_PROMPT_KEY = 'manulDown.markdownAssociationPromptShown';
const MANULDOWN_EDITOR_VIEW_TYPE = 'manulDown.editor';
const MANULDOWN_CONFIGURATION_SECTION = 'manulDown';
const OPEN_BY_DEFAULT_SETTING_KEY = 'openByDefault';
const MARKDOWN_FILE_ASSOCIATION_KEY = '*.md';
const PREVIOUS_MARKDOWN_ASSOCIATION_KEY = 'manulDown.previousMarkdownEditorAssociation';

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

    const findInEditorCommand = vscode.commands.registerCommand(
        'manulDown.findInEditor',
        async () => {
            const posted = provider.postMessageToActiveEditor(
                {
                    type: 'openSearch',
                },
                {
                    reveal: true,
                }
            );
            if (!posted) {
                await vscode.commands.executeCommand('actions.find');
            }
        }
    );

    context.subscriptions.push(findInEditorCommand);

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
            void syncDefaultMarkdownAssociationWithSetting(context, true);
        }
    });
    context.subscriptions.push(configurationListener);
}

export function deactivate() {
}

async function initializeDefaultMarkdownAssociation(context: vscode.ExtensionContext): Promise<void> {
    const explicitlyAccepted = await promptForDefaultMarkdownAssociation(context);
    const updated = await syncDefaultMarkdownAssociationWithSetting(context, explicitlyAccepted);
    if (explicitlyAccepted && updated) {
        vscode.window.showInformationMessage('ManulDown is now the default editor for Markdown files.');
    }
}

async function promptForDefaultMarkdownAssociation(context: vscode.ExtensionContext): Promise<boolean> {
    const hasPrompted = context.globalState.get<boolean>(MARKDOWN_ASSOCIATION_PROMPT_KEY, false);
    if (hasPrompted) {
        return false;
    }

    if (!getOpenByDefaultSetting()) {
        await context.globalState.update(MARKDOWN_ASSOCIATION_PROMPT_KEY, true);
        return false;
    }

    const editorAssociations = getEditorAssociations();

    if (editorAssociations[MARKDOWN_FILE_ASSOCIATION_KEY] === MANULDOWN_EDITOR_VIEW_TYPE) {
        await context.globalState.update(MARKDOWN_ASSOCIATION_PROMPT_KEY, true);
        return false;
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
            await context.globalState.update(MARKDOWN_ASSOCIATION_PROMPT_KEY, true);
            return true;
        } catch {
            vscode.window.showErrorMessage('Failed to save the default Markdown editor setting.');
            return false;
        }
    }

    try {
        await setOpenByDefaultSetting(false);
    } catch {
        vscode.window.showErrorMessage('Failed to save the default Markdown editor setting.');
        return false;
    }

    await context.globalState.update(MARKDOWN_ASSOCIATION_PROMPT_KEY, true);
    return false;
}

async function syncDefaultMarkdownAssociationWithSetting(
    context: vscode.ExtensionContext,
    allowOverride: boolean
): Promise<boolean> {
    const openByDefault = getOpenByDefaultSetting();
    const workbenchConfig = vscode.workspace.getConfiguration('workbench');
    const editorAssociations = getEditorAssociations();
    const currentAssociation = editorAssociations[MARKDOWN_FILE_ASSOCIATION_KEY];

    if (openByDefault) {
        if (currentAssociation === MANULDOWN_EDITOR_VIEW_TYPE) {
            return false;
        }
        if (currentAssociation && !allowOverride) {
            return false;
        }

        const updatedEditorAssociations: Record<string, string> = {
            ...editorAssociations,
            [MARKDOWN_FILE_ASSOCIATION_KEY]: MANULDOWN_EDITOR_VIEW_TYPE,
        };

        try {
            await context.globalState.update(
                PREVIOUS_MARKDOWN_ASSOCIATION_KEY,
                currentAssociation || undefined
            );
            await workbenchConfig.update(
                'editorAssociations',
                updatedEditorAssociations,
                vscode.ConfigurationTarget.Global
            );
        } catch {
            vscode.window.showErrorMessage('Failed to update default Markdown editor setting.');
            return false;
        }
        return true;
    }

    if (currentAssociation !== MANULDOWN_EDITOR_VIEW_TYPE) {
        return false;
    }

    const previousAssociation = context.globalState.get<string>(PREVIOUS_MARKDOWN_ASSOCIATION_KEY);
    const { [MARKDOWN_FILE_ASSOCIATION_KEY]: _, ...otherEditorAssociations } = editorAssociations;
    const updatedEditorAssociations = previousAssociation
        ? {
            ...otherEditorAssociations,
            [MARKDOWN_FILE_ASSOCIATION_KEY]: previousAssociation,
        }
        : otherEditorAssociations;
    try {
        await workbenchConfig.update(
            'editorAssociations',
            updatedEditorAssociations,
            vscode.ConfigurationTarget.Global
        );
        await context.globalState.update(PREVIOUS_MARKDOWN_ASSOCIATION_KEY, undefined);
    } catch {
        vscode.window.showErrorMessage('Failed to update default Markdown editor setting.');
        return false;
    }
    return true;
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
