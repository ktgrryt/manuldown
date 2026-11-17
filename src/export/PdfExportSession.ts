export type PdfLayout = {
    paper: 'A4' | 'Letter';
    landscape: boolean;
    margin: 'narrow' | 'standard' | 'wide';
    fontSize: 'small' | 'standard' | 'large';
    pageNumbers: boolean;
};

export type ExportBlock = {
    id: string; label: string; kind: string; heading: boolean;
    source?: { start: number; end: number; fingerprint: string; excerpt: string };
};
export type ExportContent = { html: string; blocks: ExportBlock[]; warnings: string[] };
/** Coordinates describe this printed revision only. They are never persisted. */
export type PdfBoundary = { id: string; page: number; rect: [number, number, number, number]; atPageStart?: boolean };
type Adjustment = { layout: PdfLayout; breaks: string[] };

export const defaultPdfLayout: PdfLayout = {
    paper: 'A4', landscape: false, margin: 'standard', fontSize: 'standard', pageNumbers: true,
};

export function normalizePdfLayout(value: unknown): PdfLayout {
    const input = value && typeof value === 'object' ? value as Partial<PdfLayout> : {};
    return {
        paper: input.paper === 'Letter' ? 'Letter' : 'A4',
        landscape: input.landscape === true,
        margin: input.margin === 'narrow' || input.margin === 'wide' ? input.margin : 'standard',
        fontSize: input.fontSize === 'small' || input.fontSize === 'large' ? input.fontSize : 'standard',
        pageNumbers: input.pageNumbers !== false,
    };
}

/** Adjustments belong to this frozen document, never to the Markdown editor. */
export class PdfExportSession {
    public layout: PdfLayout;
    public breaks = new Set<string>();
    public revision = 0;
    public stale = false;
    public pdf: { bytes: Buffer; revision: number; warnings: string[]; boundaries: PdfBoundary[] } | null = null;
    private undoStack: Adjustment[] = [];
    private redoStack: Adjustment[] = [];

    constructor(public readonly content: ExportContent, layout: unknown = defaultPdfLayout, breaks: readonly string[] = []) {
        this.layout = normalizePdfLayout(layout);
        const allowed = new Set(content.blocks.slice(1).map(block => block.id));
        this.breaks = new Set(breaks.filter(id => allowed.has(id)));
    }

    get canUndo(): boolean { return this.undoStack.length > 0; }
    get canRedo(): boolean { return this.redoStack.length > 0; }
    get canExport(): boolean { return !this.stale && this.pdf?.revision === this.revision; }

    private snapshot(): Adjustment { return { layout: { ...this.layout }, breaks: [...this.breaks] }; }
    private changed(): void { this.revision++; this.pdf = null; }
    private remember(): void {
        this.undoStack.push(this.snapshot());
        if (this.undoStack.length > 50) { this.undoStack.shift(); }
        this.redoStack = [];
    }

    setLayout(value: unknown): boolean {
        const layout = normalizePdfLayout(value);
        if (JSON.stringify(layout) === JSON.stringify(this.layout)) { return false; }
        this.remember();
        this.layout = layout;
        this.changed();
        return true;
    }

    setBreak(id: unknown, enabled: unknown): boolean {
        if (typeof id !== 'string' || typeof enabled !== 'boolean' ||
            !this.content.blocks.slice(1).some(block => block.id === id) || this.breaks.has(id) === enabled) {
            return false;
        }
        this.remember();
        if (enabled) { this.breaks.add(id); } else { this.breaks.delete(id); }
        this.changed();
        return true;
    }

    resetBreaks(): boolean {
        if (!this.breaks.size) { return false; }
        this.remember();
        this.breaks.clear();
        this.changed();
        return true;
    }

    history(direction: 'undo' | 'redo'): boolean {
        const from = direction === 'undo' ? this.undoStack : this.redoStack;
        const to = direction === 'undo' ? this.redoStack : this.undoStack;
        const adjustment = from.pop();
        if (!adjustment) { return false; }
        to.push(this.snapshot());
        this.layout = { ...adjustment.layout };
        this.breaks = new Set(adjustment.breaks);
        this.changed();
        return true;
    }

    markStale(): void {
        if (!this.stale) { this.stale = true; this.changed(); }
    }

    invalidatePdf(): void { this.changed(); }

    acceptPdf(revision: number, bytes: Buffer, warnings: string[], boundaries: PdfBoundary[] = []): boolean {
        if (this.stale || revision !== this.revision) { return false; }
        this.pdf = { bytes, revision, warnings, boundaries };
        return true;
    }
}
