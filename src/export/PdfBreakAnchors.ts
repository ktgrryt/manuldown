import { createHash } from 'crypto';
import { ExportBlock } from './PdfExportSession';

// Stored privately by document URI. No Markdown comments, PDF coordinates, or
// editor decorations are needed to retain export-only layout preferences.
export type PdfBreakAnchor = {
    fingerprint: string; kind: string; excerpt: string;
    before?: string; after?: string; heading?: string;
    occurrence: number; count: number;
};

export const pdfBreakStorageKey = (uri: string): string =>
    `manulDown.pdf.breaks.${createHash('sha256').update(uri).digest('hex')}`;

export function createBreakAnchors(blocks: readonly ExportBlock[], breaks: ReadonlySet<string>): PdfBreakAnchor[] {
    return blocks.flatMap((block, index) => {
        if (!index || !block.source || !breaks.has(block.id)) { return []; }
        const same = blocks.filter(other => other.source?.fingerprint === block.source!.fingerprint);
        return [{ fingerprint: block.source.fingerprint, kind: block.kind, excerpt: block.source.excerpt,
            before: blocks[index - 1]?.source?.fingerprint, after: blocks[index + 1]?.source?.fingerprint,
            heading: blocks.slice(0, index).reverse().find(other => other.heading)?.source?.fingerprint,
            occurrence: same.indexOf(block), count: same.length }];
    });
}

function validAnchor(value: any): value is PdfBreakAnchor {
    return value && typeof value.fingerprint === 'string' && /^[a-f0-9]{32}$/.test(value.fingerprint) &&
        typeof value.kind === 'string' && typeof value.excerpt === 'string' && value.excerpt.length <= 2048 &&
        Number.isInteger(value.occurrence) && value.occurrence >= 0 && Number.isInteger(value.count) && value.count > 0 &&
        ['before', 'after', 'heading'].every(key => value[key] === undefined ||
            typeof value[key] === 'string' && /^[a-f0-9]{32}$/.test(value[key]));
}

function similarity(left: string, right: string): number {
    const pairs = (text: string) => {
        const normalized = text.replace(/\s+/g, ' ').trim();
        return new Set(Array.from({ length: Math.max(0, normalized.length - 1) }, (_, i) => normalized.slice(i, i + 2)));
    };
    const a = pairs(left), b = pairs(right);
    return a.size + b.size ? 2 * [...a].filter(pair => b.has(pair)).length / (a.size + b.size) : 0;
}

/** Prefer exact source identity and neighbors; never substitute a deleted block by its old ordinal. */
export function restoreBreakAnchors(blocks: readonly ExportBlock[], stored: unknown): { breaks: string[]; dropped: number } {
    const values = stored && typeof stored === 'object' && 'version' in stored && stored.version === 1 &&
        'anchors' in stored && Array.isArray(stored.anchors) ? stored.anchors : [];
    const anchors = values.filter(validAnchor) as PdfBreakAnchor[];
    const breaks = new Set<string>();
    let dropped = 0;
    for (const anchor of anchors) {
        const exact = blocks.map((block, index) => ({ block, index }))
            .filter(({ block }) => block.source?.fingerprint === anchor.fingerprint && block.kind === anchor.kind);
        let target: ExportBlock | undefined;
        if (exact.length === 1) { target = exact[0].block; }
        else if (exact.length > 1) {
            const scored = exact.map(({ block, index }, occurrence) => ({ block,
                score: (anchor.before && blocks[index - 1]?.source?.fingerprint === anchor.before ? 4 : 0) +
                    (anchor.after && blocks[index + 1]?.source?.fingerprint === anchor.after ? 4 : 0) +
                    (anchor.heading && blocks.slice(0, index).reverse().find(other => other.heading)?.source?.fingerprint === anchor.heading ? 2 : 0) +
                    (exact.length === anchor.count && occurrence === anchor.occurrence ? 1 : 0),
            })).sort((a, b) => b.score - a.score);
            if (scored[0].score > scored[1].score) { target = scored[0].block; }
        } else {
            const previous = blocks.map((block, i) => block.source?.fingerprint === anchor.before ? i : -1).filter(i => i >= 0);
            const following = blocks.map((block, i) => block.source?.fingerprint === anchor.after ? i : -1).filter(i => i >= 0);
            // An edited block between two unchanged neighbors is unambiguous.
            // A removed block leaves no candidate between those neighbors.
            if (previous.length === 1 && following.length === 1 && following[0] === previous[0] + 2) {
                const candidate = blocks[previous[0] + 1];
                if (candidate.source && candidate.kind === anchor.kind) { target = candidate; }
            } else if (previous.length === 1 || following.length === 1) {
                const candidates = blocks.filter((block, index) => index > 0 && block.source && block.kind === anchor.kind &&
                    (previous.length !== 1 || index === previous[0] + 1) &&
                    (following.length !== 1 || index === following[0] - 1));
                if (candidates.length === 1 && similarity(anchor.excerpt, candidates[0].source!.excerpt) >= .72) { target = candidates[0]; }
            }
        }
        if (target && target !== blocks[0]) { breaks.add(target.id); } else { dropped++; }
    }
    return { breaks: [...breaks], dropped };
}
