import { marked, Lexer, Tokenizer } from 'marked';

export const MAX_QUOTE_DEPTH = 2;
export const MAX_CALLOUT_DEPTH = 1;

type Nesting = { quotes: number; callouts: number };
const nestingByLexer = new WeakMap<Lexer, Nesting>();
let initialNesting: Nesting = { quotes: 0, callouts: 0 };

// Rendering is synchronous. Nested document renderers restore the enclosing
// context so helper lexers cannot accidentally reset the callout limit.
export function withMarkdownNesting<T>(callouts: number, render: () => T): T {
    const previous = initialNesting;
    initialNesting = { quotes: 0, callouts };
    try { return render(); } finally { initialNesting = previous; }
}

export function markdownNesting(lexer: Lexer): Nesting {
    let nesting = nestingByLexer.get(lexer);
    if (!nesting) {
        nesting = { ...initialNesting };
        nestingByLexer.set(lexer, nesting);
    }
    return nesting;
}

/** Stop before Marked recursively tokenizes a third quotation. */
export function boundedBlockquote(tokenizer: Tokenizer, source: string): any {
    const raw = (tokenizer as any).rules.block.blockquote.exec(source)?.[0];
    if (!raw) { return; }
    const nesting = markdownNesting(tokenizer.lexer);
    if (nesting.quotes >= MAX_QUOTE_DEPTH) {
        return { type: 'nestingSource', raw, kind: 'quote-source' };
    }
    nesting.quotes++;
    try {
        return marked.Tokenizer.prototype.blockquote.call(tokenizer, source);
    } finally {
        nesting.quotes--;
    }
}

/** Context-only lexers disable extensions, but still need the recursion limit. */
export function createBoundedTokenizer(): Tokenizer {
    const tokenizer = new marked.Tokenizer();
    tokenizer.blockquote = source => boundedBlockquote(tokenizer, source);
    return tokenizer;
}
