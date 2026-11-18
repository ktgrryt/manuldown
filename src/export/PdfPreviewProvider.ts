import * as vscode from 'vscode';
import * as path from 'path';
import { getNonce } from '../utils/getNonce';
import { buildPdfContent } from './PdfHtmlBuilder';
import { PdfExportSession } from './PdfExportSession';
import { renderPdf } from './BrowserPdfRenderer';
import { getPdfPreviewHtml } from './PdfPreviewHtml';
import { createBreakAnchors, pdfBreakStorageKey, restoreBreakAnchors } from './PdfBreakAnchors';

type Capture = () => Promise<{ source: string; version: number }>;
type Preview = {
    panel: vscode.WebviewPanel; document: vscode.TextDocument; capture: Capture;
    resolveImage: (source: string) => Promise<string | null>;
    session?: PdfExportSession; sessionId: string; version: number; source?: string;
    ready: boolean; disposed: boolean; reloading: boolean; busy: boolean; saving: boolean;
    loadId: number; displayedRevision: number; error: string; persistenceError: string;
    controller?: AbortController;
};

export class PdfPreviewProvider implements vscode.Disposable {
    private previews = new Map<string, Preview>();
    private subscriptions: vscode.Disposable[];
    private persistence: Promise<void> = Promise.resolve();

    constructor(private readonly context: vscode.ExtensionContext) {
        this.subscriptions = [vscode.workspace.onDidChangeTextDocument(event => {
            const entry = this.previews.get(event.document.uri.toString());
            if (entry?.session && event.document.version !== entry.version) {
                entry.session.markStale();
                entry.controller?.abort();
                entry.busy = false;
                this.postState(entry);
            }
        }), vscode.workspace.onDidChangeConfiguration(event => {
            for (const entry of this.previews.values()) {
                if (event.affectsConfiguration('manulDown.pdf.browserPath') && entry.session && !entry.session.stale) {
                    entry.session.invalidatePdf();
                    void this.generate(entry);
                }
                if (event.affectsConfiguration('manulDown.security.allowRemoteImages') && entry.session) {
                    entry.session.markStale();
                    entry.controller?.abort();
                    entry.busy = false;
                    this.postState(entry);
                }
            }
        })];
    }

    async open(document: vscode.TextDocument, capture: Capture, resolveImage: Preview['resolveImage']): Promise<void> {
        if (vscode.env.remoteName || vscode.env.uiKind !== vscode.UIKind.Desktop) {
            void vscode.window.showInformationMessage('PDF export currently supports local workspaces in VS Code Desktop.');
            return;
        }
        const key = document.uri.toString();
        const existing = this.previews.get(key);
        if (existing) {
            existing.document = document;
            existing.capture = capture;
            existing.resolveImage = resolveImage;
            existing.panel.reveal();
            // The editor can still have a resize queued when Export is clicked again.
            await this.reload(existing, true);
            return;
        }
        const panel = vscode.window.createWebviewPanel('manulDown.pdfPreview', `PDF — ${path.basename(document.uri.path)}`,
            vscode.ViewColumn.Active, {
                enableScripts: true, retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
            });
        const entry: Preview = {
            panel, document, capture, resolveImage, sessionId: getNonce(), version: document.version,
            ready: false, disposed: false, reloading: true, busy: false, saving: false,
            loadId: 0, displayedRevision: -1, error: '', persistenceError: '',
        };
        this.previews.set(key, entry);
        panel.webview.onDidReceiveMessage(message => { void this.handleMessage(entry, message).catch(error => {
            if (!entry.disposed) { entry.error = this.errorMessage(error); this.postState(entry); }
        }); });
        panel.onDidDispose(() => {
            entry.disposed = true;
            entry.loadId++;
            entry.controller?.abort();
            this.previews.delete(key);
        });
        panel.webview.html = getPdfPreviewHtml(panel.webview, this.context.extensionUri);
        await this.reload(entry);
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : 'Could not prepare the PDF. Please try again.';
    }

    private postState(entry: Preview): void {
        if (entry.disposed || !entry.ready) { return; }
        const session = entry.session;
        void entry.panel.webview.postMessage({
            type: 'state', sessionId: entry.sessionId, revision: session?.revision ?? -1,
            documentName: path.basename(entry.document.uri.path),
            layout: session?.layout,
            blocks: session?.content.blocks.map(({ id, label, kind, heading }) => ({ id, label, kind, heading })) || [],
            breaks: [...(session?.breaks || [])],
            busy: entry.busy, reloading: entry.reloading, saving: entry.saving, stale: session?.stale || false,
            canExport: !!session?.canExport && entry.displayedRevision === session.revision && !entry.busy && !entry.reloading && !entry.saving,
            canUndo: session?.canUndo || false, canRedo: session?.canRedo || false,
            warnings: [...new Set([...(session?.content.warnings || []), ...(session?.pdf?.warnings || []),
                ...(entry.persistenceError ? [entry.persistenceError] : [])])],
            error: entry.error,
        });
    }

    private postPdf(entry: Preview): void {
        if (!entry.ready || entry.disposed || !entry.session?.canExport || !entry.session.pdf) { return; }
        void entry.panel.webview.postMessage({ type: 'pdf', sessionId: entry.sessionId,
            revision: entry.session.revision, data: entry.session.pdf.bytes.toString('base64'),
            boundaries: entry.session.pdf.boundaries });
    }

    private persistBreaks(entry: Preview): Promise<void> {
        if (!entry.session) { return Promise.resolve(); }
        const key = pdfBreakStorageKey(entry.document.uri.toString());
        const value = { version: 1, anchors: createBreakAnchors(entry.session.content.blocks, entry.session.breaks) };
        // Serialize writes, including across close/reopen and rapid undo/redo.
        this.persistence = this.persistence.then(async () => {
            try {
                await this.context.globalState.update(key, value);
                entry.persistenceError = '';
            } catch {
                entry.persistenceError = 'Page breaks could not be saved. Your adjustments still apply to this preview.';
            }
            this.postState(entry);
        });
        return this.persistence;
    }

    private async reload(entry: Preview, reuseCurrent = false): Promise<void> {
        if (entry.disposed || entry.saving) { return; }
        const loadId = ++entry.loadId;
        entry.reloading = true;
        this.postState(entry);
        try {
            const snapshot = await entry.capture();
            if (entry.disposed || loadId !== entry.loadId) { return; }
            const current = entry.session;
            const rendering = entry.busy && !entry.controller?.signal.aborted;
            if (reuseCurrent && current && !current.stale && (current.canExport || rendering) && !entry.error &&
                snapshot.version === entry.version && snapshot.source === entry.source &&
                snapshot.version === entry.document.version) { return; }
            entry.controller?.abort();
            entry.error = '';
            entry.displayedRevision = -1;
            const content = await buildPdfContent(snapshot.source, entry.document.uri, entry.resolveImage);
            if (entry.disposed || loadId !== entry.loadId) { return; }
            const layout = entry.session?.layout || this.context.globalState.get('manulDown.pdf.layout');
            await this.persistence;
            if (entry.disposed || loadId !== entry.loadId) { return; }
            const stored = entry.session ? { version: 1, anchors: createBreakAnchors(entry.session.content.blocks, entry.session.breaks) }
                : this.context.globalState.get(pdfBreakStorageKey(entry.document.uri.toString()));
            const restored = restoreBreakAnchors(content.blocks, stored);
            if (restored.dropped) {
                content.warnings.push(`${restored.dropped} page break${restored.dropped === 1 ? '' : 's'} removed because the source blocks were removed or could not be identified.`);
            }
            entry.session = new PdfExportSession(content, layout, restored.breaks);
            entry.sessionId = getNonce();
            entry.version = snapshot.version;
            entry.source = snapshot.source;
            if (entry.document.version !== snapshot.version) { entry.session.markStale(); }
            const persisted = !entry.session.stale && (restored.breaks.length || restored.dropped)
                ? this.persistBreaks(entry) : Promise.resolve();
            await this.generate(entry);
            await persisted;
        } catch (error) {
            if (!entry.disposed && loadId === entry.loadId) {
                // A failed refresh must not enable export of the old document.
                entry.controller?.abort();
                entry.session?.markStale();
                entry.error = this.errorMessage(error);
            }
        } finally {
            if (!entry.disposed && loadId === entry.loadId) {
                entry.reloading = false;
                this.postState(entry);
            }
        }
    }

    private async generate(entry: Preview): Promise<void> {
        const session = entry.session;
        if (entry.disposed || !session || session.stale) { return; }
        entry.controller?.abort();
        const controller = new AbortController();
        entry.controller = controller;
        const revision = session.revision;
        entry.busy = true;
        entry.error = '';
        entry.displayedRevision = -1;
        this.postState(entry);
        try {
            const result = await renderPdf({
                mediaRoot: vscode.Uri.joinPath(this.context.extensionUri, 'media').fsPath,
                html: session.content.html, title: path.basename(entry.document.uri.path),
                layout: { ...session.layout }, breaks: [...session.breaks], signal: controller.signal,
                browserPath: vscode.workspace.getConfiguration('manulDown').get<string>('pdf.browserPath', ''),
            });
            if (!entry.disposed && !controller.signal.aborted && entry.session === session &&
                session.acceptPdf(revision, result.bytes, result.warnings, result.boundaries)) { this.postPdf(entry); }
        } catch (error) {
            if (!entry.disposed && !controller.signal.aborted && entry.session === session) { entry.error = this.errorMessage(error); }
        } finally {
            if (entry.controller === controller) {
                entry.busy = false;
                this.postState(entry);
            }
        }
    }

    private async handleMessage(entry: Preview, message: any): Promise<void> {
        if (entry.disposed || !message || typeof message.type !== 'string') { return; }
        if (message.type === 'ready') {
            entry.ready = true;
            this.postState(entry);
            this.postPdf(entry);
            return;
        }
        if (message.type === 'reload') { await this.reload(entry); return; }
        if (message.type === 'settings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'manulDown.pdf.browserPath');
            return;
        }
        const session = entry.session;
        if (!session || message.sessionId !== entry.sessionId) { return; }
        if (message.type === 'displayed' && message.revision === session.revision) {
            entry.displayedRevision = message.revision;
            this.postState(entry);
            return;
        }
        if (message.type === 'displayError' && message.revision === session.revision) {
            entry.displayedRevision = -1;
            entry.error = 'The PDF preview could not be displayed. Refresh the preview and try again.';
            this.postState(entry);
            return;
        }
        if (entry.reloading) { return; }
        if (message.type === 'export') { await this.save(entry, message.revision); return; }
        if (session.stale || entry.saving) { return; }
        let changed = false;
        if (message.type === 'layout') {
            changed = session.setLayout(message.layout);
            if (changed) { void this.context.globalState.update('manulDown.pdf.layout', session.layout).then(undefined, () => {}); }
        }
        // A boundary belongs to one displayed revision, never to an old canvas.
        if (message.type === 'break' && !entry.busy && message.revision === session.revision &&
            entry.displayedRevision === session.revision) { changed = session.setBreak(message.id, message.enabled); }
        if (message.type === 'resetBreaks') { changed = session.resetBreaks(); }
        if (message.type === 'undo' || message.type === 'redo') { changed = session.history(message.type); }
        if (changed) {
            // Printing does not depend on the storage write completing.
            const persisted = this.persistBreaks(entry);
            await this.generate(entry);
            await persisted;
        }
    }

    private async save(entry: Preview, revision: unknown): Promise<void> {
        const session = entry.session;
        if (!session?.canExport || !session.pdf || revision !== session.revision ||
            entry.displayedRevision !== revision || entry.busy || entry.reloading || entry.saving ||
            entry.document.version !== entry.version || entry.document.getText() !== entry.source) { return; }
        const bytes = session.pdf.bytes;
        entry.error = '';
        entry.saving = true;
        this.postState(entry);
        let temporary: vscode.Uri | undefined;
        try {
            const suggested = entry.document.uri.with({ path: entry.document.uri.path.replace(/\.md$/i, '') + '.pdf' });
            const target = await vscode.window.showSaveDialog({ defaultUri: suggested, filters: { pdf: ['pdf'] }, saveLabel: 'Export PDF' });
            if (!target || entry.disposed) { return; }
            if (!/\.pdf$/i.test(target.path)) { throw new Error('Choose a filename ending in .pdf.'); }
            temporary = target.with({ path: `${target.path}.${getNonce()}.tmp` });
            await vscode.workspace.fs.writeFile(temporary, bytes);
            await vscode.workspace.fs.rename(temporary, target, { overwrite: true });
            temporary = undefined;
            // A notification can stay open indefinitely; it must not keep the
            // preview's save/layout controls disabled after the file is written.
            void (async () => {
                const action = await vscode.window.showInformationMessage('PDF exported.', 'Open PDF');
                if (action === 'Open PDF') { await vscode.env.openExternal(target); }
            })().catch(error => console.error('[PDF open]', error));
        } catch (error) { entry.error = this.errorMessage(error); }
        finally {
            if (temporary) { await vscode.workspace.fs.delete(temporary).then(undefined, () => {}); }
            entry.saving = false;
            this.postState(entry);
        }
    }

    dispose(): void {
        for (const entry of [...this.previews.values()]) { entry.controller?.abort(); entry.panel.dispose(); }
        for (const subscription of this.subscriptions) { subscription.dispose(); }
        this.previews.clear();
    }
}
