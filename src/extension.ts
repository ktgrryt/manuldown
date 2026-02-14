import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './editor/MarkdownEditorProvider';

const MARKDOWN_ASSOCIATION_PROMPT_KEY = 'manulDown.markdownAssociationPromptShown';
const MANULDOWN_EDITOR_VIEW_TYPE = 'manulDown.editor';

export function activate(context: vscode.ExtensionContext) {
    void promptForDefaultMarkdownAssociation(context);

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
}

export function deactivate() {
}

async function promptForDefaultMarkdownAssociation(context: vscode.ExtensionContext): Promise<void> {
    const hasPrompted = context.globalState.get<boolean>(MARKDOWN_ASSOCIATION_PROMPT_KEY, false);
    if (hasPrompted) {
        return;
    }

    const workbenchConfig = vscode.workspace.getConfiguration('workbench');
    const editorAssociations = workbenchConfig.get<Record<string, string>>('editorAssociations') ?? {};

    if (editorAssociations['*.md'] === MANULDOWN_EDITOR_VIEW_TYPE) {
        await context.globalState.update(MARKDOWN_ASSOCIATION_PROMPT_KEY, true);
        return;
    }

    const setDefaultAction = 'Set as Default';
    const skipAction = 'Skip';
    const selection = await vscode.window.showInformationMessage(
        'Set ManulDown as the default editor for Markdown files (*.md)?',
        { modal: true },
        setDefaultAction,
        skipAction
    );

    if (selection === setDefaultAction) {
        const updatedEditorAssociations: Record<string, string> = {
            ...editorAssociations,
            '*.md': MANULDOWN_EDITOR_VIEW_TYPE,
        };

        try {
            await workbenchConfig.update(
                'editorAssociations',
                updatedEditorAssociations,
                vscode.ConfigurationTarget.Global
            );
            vscode.window.showInformationMessage('ManulDown is now the default editor for Markdown files.');
            await context.globalState.update(MARKDOWN_ASSOCIATION_PROMPT_KEY, true);
            return;
        } catch {
            vscode.window.showErrorMessage('Failed to update default Markdown editor setting.');
            return;
        }
    }

    await context.globalState.update(MARKDOWN_ASSOCIATION_PROMPT_KEY, true);
}

// Made with Bob
