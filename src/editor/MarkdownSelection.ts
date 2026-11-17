import { MarkdownDocument } from './MarkdownDocument';
import { EditorTextSelection, mapTextOffset, projectEditorText } from './EditorSelection';
const { createWindow } = require('@mixmark-io/domino');

function projectedHtml(html: string): string {
    const root = createWindow(`<div id="selection-root">${html}</div>`).document.getElementById('selection-root');
    return projectEditorText(root).text;
}

/** Positions are computed against the current document; no selection markers are saved. */
export class MarkdownSelectionMap {
    private source: string;
    private original: string;
    private originalOffsets: number[] = [0];
    private rendered: string;
    private blocks: Array<{ start: number; end: number; text: string; renderedStart: number }>;

    constructor(document: MarkdownDocument, source: string) {
        const blocks = document.getSourceBlocks().filter(block => !block.inline);
        this.original = source;
        this.source = source.replace(/\r\n?/g, '\n');
        for (let index = 0; index < source.length; index++) {
            if (source[index] === '\r' && source[index + 1] === '\n') { index++; }
            this.originalOffsets.push(index + 1);
        }
        this.rendered = projectedHtml(document.toHtml());
        let cursor = 0;
        this.blocks = blocks.map(block => {
            const fullText = projectedHtml(block.html);
            let text = fullText;
            const exactStart = text ? this.rendered.indexOf(text, cursor) : -1;
            if (exactStart < 0) { text = fullText.replace(/^\n+|\n+$/g, ''); }
            let renderedStart = text ? this.rendered.indexOf(text, cursor) : cursor;
            // Footnote definitions are displayed in reference order, independently
            // of their source order. Locate those moved fragments as well.
            if (renderedStart < 0 && text) { renderedStart = this.rendered.indexOf(text); }
            if (renderedStart < 0) { renderedStart = cursor; }
            cursor = renderedStart + text.length;
            return { start: block.start, end: block.end, text, renderedStart };
        });
        if (!this.blocks.length) {
            this.blocks.push({ start: 0, end: this.source.length, text: this.rendered, renderedStart: 0 });
        }
    }

    toSource(selection: EditorTextSelection): EditorTextSelection {
        const convert = (offset: number): number => {
            const block = this.blocks.find(value => offset >= value.renderedStart &&
                offset <= value.renderedStart + value.text.length) ||
                [...this.blocks].reverse().find(value => value.renderedStart <= offset) || this.blocks[0];
            if (!block) { return 0; }
            const normalized = block.start + mapTextOffset(block.text, this.source.slice(block.start, block.end), offset - block.renderedStart);
            return this.originalOffsets[normalized] ?? this.original.length;
        };
        return { anchor: convert(selection.anchor), active: convert(selection.active) };
    }

    toRendered(selection: EditorTextSelection): EditorTextSelection {
        const convert = (offset: number): number => {
            offset = this.original.slice(0, offset).replace(/\r\n?/g, '\n').length;
            const block = this.blocks.find(value => offset >= value.start && offset < value.end) ||
                this.blocks[this.blocks.length - 1];
            if (!block) { return 0; }
            return block.renderedStart + mapTextOffset(this.source.slice(block.start, block.end), block.text, offset - block.start);
        };
        return { anchor: convert(selection.anchor), active: convert(selection.active) };
    }
}
