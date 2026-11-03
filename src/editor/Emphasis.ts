import { Lexer } from 'marked';

interface EmphasisWrap {
    delimiter: '*' | '**';
    openingMarker: string;
    closingMarker: string;
}

interface Piece {
    value: string;
    wrap?: EmphasisWrap;
    opening?: boolean;
}

interface Pair {
    opening: Piece;
    closing: Piece;
    active: boolean;
}

// Match Marked's delimiter-flanking rules, including symbols that it treats as
// punctuation. Emoji and other ordinary Unicode characters are left unchanged.
const punctuation = /[\p{P}$+<=>`^|~]/u;
const whitespace = /\s/u;
const escapable = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;

/** Makes newly generated emphasis readable without rewriting document text. */
export class EmphasisBoundarySerializer {
    private readonly wraps: EmphasisWrap[] = [];

    constructor(private readonly namespace: string) { }

    wrap(content: string, delimiter: '*' | '**'): string {
        const prefix = `${this.namespace}EMPHASIS${this.wraps.length}`;
        const wrap = { delimiter, openingMarker: `${prefix}OPENEND`, closingMarker: `${prefix}CLOSEEND` };
        this.wraps.push(wrap);
        return `${wrap.openingMarker}${delimiter}${content}${delimiter}${wrap.closingMarker}`;
    }

    restore(markdown: string): string {
        if (this.wraps.length === 0) {
            return markdown;
        }
        const markers = new Map<string, { wrap: EmphasisWrap; opening: boolean }>();
        for (const wrap of this.wraps) {
            markers.set(wrap.openingMarker + wrap.delimiter, { wrap, opening: true });
            markers.set(wrap.delimiter + wrap.closingMarker, { wrap, opening: false });
            // Incomplete or unused wrappers still must not leak bookkeeping.
            markers.set(wrap.openingMarker, { wrap, opening: true });
            markers.set(wrap.closingMarker, { wrap, opening: false });
        }
        const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(Array.from(markers.keys(), escapeRegExp).join('|'), 'g');
        let pieces: Piece[] = [];
        const appendText = (text: string): void => {
            for (const value of text) {
                pieces.push({ value });
            }
        };
        const pending = new Map<EmphasisWrap, Piece[]>();
        const pairs = new Map<EmphasisWrap, Pair[]>();
        let offset = 0;
        for (const match of markdown.matchAll(pattern)) {
            appendText(markdown.slice(offset, match.index));
            const { wrap, opening } = markers.get(match[0])!;
            if (match[0] !== wrap.openingMarker && match[0] !== wrap.closingMarker) {
                const piece: Piece = { value: wrap.delimiter, wrap, opening };
                pieces.push(piece);
                if (opening) {
                    const starts = pending.get(wrap) ?? [];
                    starts.push(piece);
                    pending.set(wrap, starts);
                } else {
                    const start = pending.get(wrap)?.pop();
                    if (start) {
                        const entries = pairs.get(wrap) ?? [];
                        entries.push({ opening: start, closing: piece, active: true });
                        pairs.set(wrap, entries);
                    }
                }
            }
            offset = match.index! + match[0].length;
        }
        appendText(markdown.slice(offset));
        const orderedPairs = this.wraps.flatMap(wrap => pairs.get(wrap) ?? []);
        const paired = new Set(orderedPairs.flatMap(pair => [pair.opening, pair.closing]));
        for (const piece of pieces) {
            if (!paired.has(piece)) {
                delete piece.wrap;
            }
        }
        const isOrdinary = (value: string | undefined): boolean =>
            value !== undefined && !whitespace.test(value) && !punctuation.test(value);
        const invalid = (piece: Piece, opening: boolean): boolean => {
            let start = pieces.indexOf(piece);
            let end = start + 1;
            // Adjacent nested/sibling generated stars form one delimiter run.
            while (pieces[start - 1]?.wrap) {
                start--;
            }
            while (pieces[end]?.wrap) {
                end++;
            }
            const before = pieces[start - 1]?.value;
            const after = pieces[end]?.value;
            const inside = opening ? after : before;
            const outside = opening ? before : after;
            return inside !== undefined && (whitespace.test(inside) ||
                (punctuation.test(inside) && isOrdinary(outside)));
        };
        const unwrap = (pair: Pair): void => {
            pieces.splice(pieces.indexOf(pair.closing), 1);
            pieces.splice(pieces.indexOf(pair.opening), 1);
            pair.active = false;
        };

        // Children are registered before their parents. Moving their literal
        // brackets out first often also makes a nested parent easy to repair.
        // A later sibling can change a shared star run, so recheck until stable.
        let changed: boolean;
        do {
            changed = false;
            for (const pair of orderedPairs) {
                if (!pair.active || (!invalid(pair.opening, true) && !invalid(pair.closing, false))) {
                    continue;
                }
                const start = pieces.indexOf(pair.opening);
                const end = pieces.indexOf(pair.closing);
                const content = pieces.slice(start + 1, end);
                const { prefix, suffix } = this.literalEdges(content);
                if (prefix + suffix >= content.length || prefix + suffix === 0) {
                    unwrap(pair);
                } else {
                    pieces = pieces.slice(0, start).concat(
                        content.slice(0, prefix), [pair.opening],
                        content.slice(prefix, content.length - suffix), [pair.closing],
                        content.slice(content.length - suffix), pieces.slice(end + 1));
                    // Links, code and other structural Markdown cannot have
                    // their punctuation moved safely. Keep them intact and
                    // omit only the wrapper that still cannot be represented.
                    if (invalid(pair.opening, true) || invalid(pair.closing, false)) {
                        unwrap(pair);
                    }
                }
                changed = true;
            }
        } while (changed);
        return pieces.map(piece => piece.value).join('');
    }

    private literalEdges(content: Piece[]): { prefix: number; suffix: number } {
        const source = content.map(piece => piece.value).join('');
        const literal = new Set<number>();
        let offset = 0;
        for (const token of Lexer.lexInline(source)) {
            if (token.type === 'text' || token.type === 'escape') {
                for (let index = 0; index < token.raw.length; index++) {
                    literal.add(offset + index);
                }
            }
            offset += token.raw.length;
        }
        // Keep escape pairs together, and never move generated delimiters or
        // a structural token (link, code span, nested emphasis, HTML, etc.).
        const units: { start: number; end: number; movable: boolean }[] = [];
        offset = 0;
        for (let index = 0; index < content.length; index++) {
            const piece = content[index];
            const next = content[index + 1];
            const escaped = !piece.wrap && piece.value === '\\' && next && !next.wrap && escapable.test(next.value);
            const value = escaped ? next.value : piece.value;
            const length = piece.value.length + (escaped ? next.value.length : 0);
            // Marked masks emphasis between even escaped backticks as a code
            // candidate. Such a boundary therefore uses the same conservative
            // fallback as a real code span instead of leaving visible stars.
            const movable = !piece.wrap && value !== '`' &&
                Array.from({ length }, (_, position) => offset + position).every(position => literal.has(position)) &&
                (punctuation.test(value) || whitespace.test(value));
            units.push({ start: index, end: index + (escaped ? 2 : 1), movable });
            offset += length;
            if (escaped) {
                index++;
            }
        }
        let first = 0;
        while (units[first]?.movable) {
            first++;
        }
        let last = units.length;
        while (last > first && units[last - 1].movable) {
            last--;
        }
        return {
            prefix: first > 0 ? units[first - 1].end : 0,
            suffix: last < units.length ? content.length - units[last].start : 0,
        };
    }
}
