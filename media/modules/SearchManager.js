// @ts-nocheck
/**
 * 検索管理モジュール
 * Cmd+F / Ctrl+F による文書内検索、置換、ハイライトを担当
 */
export class SearchManager {
    /**
     * @param {HTMLElement} editor - The contenteditable editor element
     * @param {Object} options
     * @param {(range: Range) => void} options.onWillReplace - Called before replacing editor text
     * @param {(range: Range) => void} options.onDidReplace - Called after replacing editor text
     */
    constructor(editor, options = {}) {
        this.editor = editor;
        this.onWillReplace = typeof options.onWillReplace === 'function'
            ? options.onWillReplace
            : null;
        this.onDidReplace = typeof options.onDidReplace === 'function'
            ? options.onDidReplace
            : null;

        // State
        this.isOpen = false;
        this.query = '';
        this.matches = [];          // Array of Range objects
        this.matchOffsets = [];     // Clean-text offsets corresponding to matches
        this.currentMatchIndex = -1;
        this.caseSensitive = false;

        // DOM references
        this.searchBar = null;
        this.searchInput = null;
        this.replaceInput = null;
        this.matchCountLabel = null;
        this.actionsContainer = null;
        this.prevButton = null;
        this.nextButton = null;
        this.replaceButton = null;
        this.replaceAllButton = null;
        this.caseSensitiveButton = null;
        this.closeButton = null;

        // Saved editor selection (to restore on close)
        this.savedSelection = null;
        this._inputDebounceTimer = null;
        this._refreshDebounceTimer = null;
        this._searchRefreshDebounceMs = 120;
        this._mutationObserver = null;
        this._resizeObserver = null;
        this._reservedSpaceAnimationFrame = null;
        this._composingInputs = new WeakSet();
        this._lastCompositionEndByInput = new WeakMap();
        this._compositionEndGraceMs = 100;

        this._isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

        this._createSearchBar();
        this._observeEditorMutations();
    }

    // ── Public API ──────────────────────────────────────────

    /**
     * Handle search-related keydown events forwarded from editor.js
     * @param {KeyboardEvent} e
     * @returns {boolean} true if the event was handled
     */
    handleKeydown(e) {
        if (this._isMac) {
            if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey &&
                e.key.toLowerCase() === 'f') {
                e.preventDefault();
                e.stopPropagation();
                this.open();
                return true;
            }
        } else {
            if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
                e.key.toLowerCase() === 'f') {
                e.preventDefault();
                e.stopPropagation();
                this.open();
                return true;
            }
        }
        return false;
    }

    open() {
        const selection = window.getSelection();

        // Save current selection for restore on close
        if (selection && selection.rangeCount > 0) {
            this.savedSelection = selection.getRangeAt(0).cloneRange();
        }

        this.isOpen = true;
        this.searchBar.style.display = 'flex';
        this._scheduleReservedSpaceUpdate();

        // If there's a text selection, use it as the initial query
        if (selection && !selection.isCollapsed) {
            const selectedText = selection.toString().trim();
            if (selectedText && selectedText.length < 200 && !selectedText.includes('\n')) {
                this.searchInput.value = selectedText;
                this.query = selectedText;
            }
        }

        this.searchInput.focus();
        this.searchInput.select();

        if (this.query) {
            this._performSearch();
        }
    }

    close() {
        this.isOpen = false;
        this.searchBar.style.display = 'none';
        this._setReservedSpace(0);

        if (this._inputDebounceTimer) {
            clearTimeout(this._inputDebounceTimer);
            this._inputDebounceTimer = null;
        }
        if (this._refreshDebounceTimer) {
            clearTimeout(this._refreshDebounceTimer);
            this._refreshDebounceTimer = null;
        }

        this._clearHighlights();
        this.matches = [];
        this.matchOffsets = [];
        this.currentMatchIndex = -1;
        this._updateMatchCountLabel();

        // Restore selection and focus to editor
        if (this.savedSelection) {
            const selection = window.getSelection();
            if (selection) {
                selection.removeAllRanges();
                try {
                    selection.addRange(this.savedSelection);
                } catch (_) {
                    // Range may be invalid if DOM changed
                }
            }
            this.savedSelection = null;
        }

        this.editor.focus();
    }

    goToNext() {
        if (this.matches.length === 0) return;
        this.currentMatchIndex = (this.currentMatchIndex + 1) % this.matches.length;
        this._updateCurrentMatchHighlight();
        this._scrollToCurrentMatch();
        this._updateMatchCountLabel();
    }

    goToPrevious() {
        if (this.matches.length === 0) return;
        this.currentMatchIndex = (this.currentMatchIndex - 1 + this.matches.length) % this.matches.length;
        this._updateCurrentMatchHighlight();
        this._scrollToCurrentMatch();
        this._updateMatchCountLabel();
    }

    replaceCurrent() {
        this._ensureSearchIsCurrent();
        if (this.currentMatchIndex < 0 || this.currentMatchIndex >= this.matches.length) {
            return false;
        }

        const matchIndex = this.currentMatchIndex;
        const matchOffset = this.matchOffsets[matchIndex] || 0;
        const replacementText = this.replaceInput.value;
        const range = this.matches[matchIndex].cloneRange();

        this._notifyWillReplace(range);
        const caretRange = this._replaceRange(range, replacementText);
        if (!caretRange) {
            return false;
        }

        this.savedSelection = caretRange.cloneRange();
        this._notifyDidReplace(caretRange);
        this._performSearch({
            targetOffset: matchOffset + replacementText.length,
            scrollToCurrentMatch: true
        });
        return true;
    }

    replaceAll() {
        this._ensureSearchIsCurrent();
        if (this.matches.length === 0) {
            return 0;
        }

        const replacementText = this.replaceInput.value;
        const ranges = this.matches.map(range => range.cloneRange());
        const anchorIndex = this.currentMatchIndex >= 0 ? this.currentMatchIndex : 0;
        this._notifyWillReplace(ranges[anchorIndex]);

        let replacedCount = 0;
        let caretRange = null;
        // Replace from the end so earlier Range boundaries remain stable.
        for (let index = ranges.length - 1; index >= 0; index--) {
            const replacedRange = this._replaceRange(ranges[index], replacementText);
            if (replacedRange) {
                replacedCount++;
                if (index === anchorIndex) {
                    caretRange = replacedRange;
                }
            }
        }

        if (replacedCount === 0) {
            return 0;
        }

        if (!caretRange) {
            caretRange = ranges[0].cloneRange();
            caretRange.collapse(true);
        }
        this.savedSelection = caretRange.cloneRange();
        this._notifyDidReplace(caretRange);
        this._performSearch({ scrollToCurrentMatch: false });
        return replacedCount;
    }

    refreshHighlights() {
        if (this.isOpen && this.query) {
            this._performSearch({
                preserveCurrentMatch: true,
                scrollToCurrentMatch: false
            });
        }
    }

    // ── UI Creation ─────────────────────────────────────────

    _createSearchBar() {
        this.searchBar = document.createElement('div');
        this.searchBar.className = 'search-bar';
        this.searchBar.setAttribute('role', 'search');
        this.searchBar.setAttribute('aria-label', 'Find and replace in document');
        this.searchBar.style.display = 'none';

        const searchRow = document.createElement('div');
        searchRow.className = 'search-bar-row';

        // Input container with case-sensitive toggle inside
        const inputContainer = document.createElement('div');
        inputContainer.className = 'search-bar-input-container';

        this.searchInput = document.createElement('input');
        this.searchInput.type = 'text';
        this.searchInput.className = 'search-bar-input';
        this.searchInput.placeholder = 'Find';
        this.searchInput.setAttribute('aria-label', 'Search');

        this.caseSensitiveButton = document.createElement('button');
        this.caseSensitiveButton.className = 'search-bar-btn search-bar-toggle';
        this.caseSensitiveButton.textContent = 'Aa';
        this.caseSensitiveButton.title = 'Match Case';
        this.caseSensitiveButton.setAttribute('aria-pressed', 'false');

        inputContainer.appendChild(this.searchInput);
        inputContainer.appendChild(this.caseSensitiveButton);

        // Match count
        this.matchCountLabel = document.createElement('span');
        this.matchCountLabel.className = 'search-bar-match-count';
        this.matchCountLabel.textContent = '';

        this.actionsContainer = document.createElement('div');
        this.actionsContainer.className = 'search-bar-actions';

        // Navigation buttons
        this.prevButton = document.createElement('button');
        this.prevButton.className = 'search-bar-btn';
        this.prevButton.innerHTML = '&#x2191;';
        this.prevButton.title = 'Previous Match (Shift+Enter)';

        this.nextButton = document.createElement('button');
        this.nextButton.className = 'search-bar-btn';
        this.nextButton.innerHTML = '&#x2193;';
        this.nextButton.title = 'Next Match (Enter)';

        // Close button
        this.closeButton = document.createElement('button');
        this.closeButton.className = 'search-bar-btn search-bar-close';
        this.closeButton.innerHTML = '&#x2715;';
        this.closeButton.title = 'Close (Escape)';

        searchRow.appendChild(inputContainer);
        this.actionsContainer.appendChild(this.matchCountLabel);
        this.actionsContainer.appendChild(this.prevButton);
        this.actionsContainer.appendChild(this.nextButton);
        this.actionsContainer.appendChild(this.closeButton);
        searchRow.appendChild(this.actionsContainer);

        const replaceRow = document.createElement('div');
        replaceRow.className = 'search-bar-row search-bar-replace-row';

        const replaceInputContainer = document.createElement('div');
        replaceInputContainer.className = 'search-bar-input-container';

        this.replaceInput = document.createElement('input');
        this.replaceInput.type = 'text';
        this.replaceInput.className = 'search-bar-input search-bar-replace-input';
        this.replaceInput.placeholder = 'Replace';
        this.replaceInput.setAttribute('aria-label', 'Replace');
        replaceInputContainer.appendChild(this.replaceInput);

        const replaceActions = document.createElement('div');
        replaceActions.className = 'search-bar-actions search-bar-replace-actions';

        this.replaceButton = document.createElement('button');
        this.replaceButton.className = 'search-bar-btn search-bar-text-btn';
        this.replaceButton.textContent = 'Replace';
        this.replaceButton.title = 'Replace Current Match (Enter)';
        this.replaceButton.disabled = true;

        this.replaceAllButton = document.createElement('button');
        this.replaceAllButton.className = 'search-bar-btn search-bar-text-btn';
        this.replaceAllButton.textContent = 'All';
        this.replaceAllButton.title = 'Replace All Matches';
        this.replaceAllButton.disabled = true;

        replaceActions.appendChild(this.replaceButton);
        replaceActions.appendChild(this.replaceAllButton);
        replaceRow.appendChild(replaceInputContainer);
        replaceRow.appendChild(replaceActions);

        this.searchBar.appendChild(searchRow);
        this.searchBar.appendChild(replaceRow);

        // Append inside .editor-container so it's positioned below the toolbar
        const editorContainer = document.querySelector('.editor-container');
        if (editorContainer) {
            editorContainer.appendChild(this.searchBar);
        } else {
            document.body.appendChild(this.searchBar);
        }

        this._bindEvents();
        this._observeSearchBarLayout();
    }

    _bindEvents() {
        this._trackInputComposition(this.searchInput);
        this._trackInputComposition(this.replaceInput);

        this.searchInput.addEventListener('input', () => {
            this.query = this.searchInput.value;
            clearTimeout(this._inputDebounceTimer);
            this._inputDebounceTimer = setTimeout(() => {
                this._inputDebounceTimer = null;
                this._performSearch();
            }, 100);
        });

        this.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (this._isImeConfirmationKeydown(e)) return;
                e.preventDefault();
                if (e.shiftKey) {
                    this.goToPrevious();
                } else {
                    this.goToNext();
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }
        });

        this.replaceInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (this._isImeConfirmationKeydown(e)) return;
                e.preventDefault();
                this.replaceCurrent();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }
        });

        this.nextButton.addEventListener('click', () => this.goToNext());
        this.prevButton.addEventListener('click', () => this.goToPrevious());
        this.replaceButton.addEventListener('click', () => this.replaceCurrent());
        this.replaceAllButton.addEventListener('click', () => this.replaceAll());
        this.closeButton.addEventListener('click', () => this.close());

        this.caseSensitiveButton.addEventListener('click', () => {
            this.caseSensitive = !this.caseSensitive;
            this.caseSensitiveButton.classList.toggle('active', this.caseSensitive);
            this.caseSensitiveButton.setAttribute('aria-pressed',
                this.caseSensitive ? 'true' : 'false');
            this._performSearch();
        });

        // Prevent keydown events from reaching the editor
        this.searchBar.addEventListener('keydown', (e) => {
            // Cmd+F / Ctrl+F while search is open → re-select input text
            const modKey = this._isMac ? e.metaKey : e.ctrlKey;
            if (modKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                e.stopPropagation();
                this.searchInput.select();
                return;
            }
            e.stopPropagation();
        });
    }

    _trackInputComposition(input) {
        input.addEventListener('compositionstart', () => {
            this._composingInputs.add(input);
        });
        input.addEventListener('compositionend', () => {
            this._composingInputs.delete(input);
            this._lastCompositionEndByInput.set(input, Date.now());
        });
    }

    _isImeConfirmationKeydown(e) {
        const input = e.currentTarget || e.target;
        const keyCode = typeof e.keyCode === 'number'
            ? e.keyCode
            : (typeof e.which === 'number' ? e.which : 0);
        const lastCompositionEnd = this._lastCompositionEndByInput.get(input) || 0;
        return !!(
            e.isComposing ||
            keyCode === 229 ||
            this._composingInputs.has(input) ||
            (lastCompositionEnd > 0 && Date.now() - lastCompositionEnd < this._compositionEndGraceMs)
        );
    }

    _ensureSearchIsCurrent() {
        if (this._inputDebounceTimer) {
            clearTimeout(this._inputDebounceTimer);
            this._inputDebounceTimer = null;
        }

        const latestQuery = this.searchInput.value;
        if (latestQuery !== this.query) {
            this.query = latestQuery;
        }
        this._performSearch({
            preserveCurrentMatch: true,
            scrollToCurrentMatch: false
        });
    }

    _replaceRange(range, replacementText) {
        try {
            range.deleteContents();

            const caretRange = document.createRange();
            if (replacementText) {
                const replacementNode = document.createTextNode(replacementText);
                range.insertNode(replacementNode);
                caretRange.setStartAfter(replacementNode);
            } else {
                caretRange.setStart(range.startContainer, range.startOffset);
            }
            caretRange.collapse(true);
            return caretRange;
        } catch (error) {
            console.error('[SearchManager] Error replacing match:', error);
            return null;
        }
    }

    _notifyWillReplace(range) {
        if (!this.onWillReplace) return;
        try {
            this.onWillReplace(range.cloneRange());
        } catch (error) {
            console.error('[SearchManager] onWillReplace callback failed:', error);
        }
    }

    _notifyDidReplace(range) {
        if (!this.onDidReplace) return;
        try {
            this.onDidReplace(range.cloneRange());
        } catch (error) {
            console.error('[SearchManager] onDidReplace callback failed:', error);
        }
    }

    _observeEditorMutations() {
        if (typeof MutationObserver === 'undefined') return;

        this._mutationObserver = new MutationObserver(() => {
            if (!this.isOpen || !this.query) return;

            if (this._refreshDebounceTimer) {
                clearTimeout(this._refreshDebounceTimer);
            }

            this._refreshDebounceTimer = setTimeout(() => {
                this._refreshDebounceTimer = null;
                this.refreshHighlights();
            }, this._searchRefreshDebounceMs);
        });

        this._mutationObserver.observe(this.editor, {
            subtree: true,
            childList: true,
            characterData: true
        });
    }

    _observeSearchBarLayout() {
        if (typeof ResizeObserver === 'undefined' || !this.searchBar) return;

        this._resizeObserver = new ResizeObserver(() => {
            this._scheduleReservedSpaceUpdate();
        });

        this._resizeObserver.observe(this.searchBar);
    }

    _scheduleReservedSpaceUpdate() {
        if (this._reservedSpaceAnimationFrame !== null) {
            cancelAnimationFrame(this._reservedSpaceAnimationFrame);
        }

        this._reservedSpaceAnimationFrame = requestAnimationFrame(() => {
            this._reservedSpaceAnimationFrame = null;
            this._updateReservedSpace();
        });
    }

    _updateReservedSpace() {
        if (!this.searchBar || !this.isOpen) {
            this._setReservedSpace(0);
            return;
        }

        const height = Math.ceil(this.searchBar.getBoundingClientRect().height || 0);
        this._setReservedSpace(height);
    }

    _setReservedSpace(value) {
        document.body.style.setProperty('--search-bar-reserved-height', `${Math.max(0, value)}px`);
    }

    // ── Search Algorithm ────────────────────────────────────

    _performSearch(options = {}) {
        const {
            preserveCurrentMatch = false,
            scrollToCurrentMatch = true,
            targetOffset = null
        } = options;
        const previousMatchIndex = this.currentMatchIndex;

        this._clearHighlights();
        this.matches = [];
        this.matchOffsets = [];
        this.currentMatchIndex = -1;

        if (!this.query || this.query.length === 0) {
            this._updateMatchCountLabel();
            return;
        }

        const searchQuery = this.caseSensitive ? this.query : this.query.toLowerCase();

        // Collect text nodes, skipping UI-only elements
        const textNodes = this._getSearchableTextNodes();

        // Build a clean text buffer (excluding zero-width spaces) with position mapping
        // originalPositions[i] = { node, offset } for each character in cleanText
        const originalPositions = [];
        let cleanText = '';

        for (const node of textNodes) {
            const raw = node.textContent;
            for (let i = 0; i < raw.length; i++) {
                if (raw[i] !== '\u200B' && raw[i] !== '\u2060') {
                    originalPositions.push({ node, offset: i });
                    cleanText += raw[i];
                }
            }
        }

        const searchText = this.caseSensitive ? cleanText : cleanText.toLowerCase();

        // Find all occurrences
        let searchStart = 0;
        while (searchStart < searchText.length) {
            const index = searchText.indexOf(searchQuery, searchStart);
            if (index === -1) break;

            const range = this._cleanPositionToRange(index, searchQuery.length, originalPositions);
            if (range) {
                this.matches.push(range);
                this.matchOffsets.push(index);
            }

            // Find widgets conventionally report non-overlapping matches. This also
            // keeps Replace All deterministic for repeated text such as "aaa" / "aa".
            // An unsafe match across blocks may overlap a valid match inside the next
            // block, so only skip the whole query when a Range was accepted.
            searchStart = index + (range ? searchQuery.length : 1);
        }

        // Apply highlights
        this._applyHighlights();

        // Jump to nearest match
        if (this.matches.length > 0) {
            if (Number.isSafeInteger(targetOffset) && targetOffset >= 0) {
                const targetIndex = this.matchOffsets.findIndex(offset => offset >= targetOffset);
                this.currentMatchIndex = targetIndex >= 0 ? targetIndex : 0;
            } else if (preserveCurrentMatch && previousMatchIndex >= 0) {
                this.currentMatchIndex = Math.min(previousMatchIndex, this.matches.length - 1);
            } else {
                this.currentMatchIndex = this._findNearestMatch();
            }
            this._updateCurrentMatchHighlight();
            if (scrollToCurrentMatch) {
                this._scrollToCurrentMatch();
            }
        }

        this._updateMatchCountLabel();
    }

    _getSearchableTextNodes() {
        const textNodes = [];
        const walker = document.createTreeWalker(
            this.editor,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    const parent = node.parentElement;
                    if (!parent) return NodeFilter.FILTER_REJECT;

                    // Skip code block toolbar elements
                    if (parent.closest('[data-exclude-from-markdown="true"]')) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    if (parent.closest('.code-block-toolbar')) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    // Skip table drag handles
                    if (parent.closest('.row-handle, .col-handle')) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        let node;
        while (node = walker.nextNode()) {
            textNodes.push(node);
        }
        return textNodes;
    }

    _cleanPositionToRange(cleanStart, length, originalPositions) {
        const cleanEnd = cleanStart + length;
        if (cleanStart >= originalPositions.length || cleanEnd > originalPositions.length) {
            return null;
        }

        const start = originalPositions[cleanStart];
        const end = originalPositions[cleanEnd - 1];

        try {
            const range = document.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset + 1);
            return this._rangeCrossesStructuralBoundary(range) ? null : range;
        } catch (e) {
            console.error('[SearchManager] Error creating range:', e);
            return null;
        }
    }

    _rangeCrossesStructuralBoundary(range) {
        const blockSelector = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, div';
        const getBlock = (node) => {
            const element = node && node.nodeType === Node.ELEMENT_NODE
                ? node
                : node?.parentElement;
            return element?.closest(blockSelector) || this.editor;
        };

        if (getBlock(range.startContainer) !== getBlock(range.endContainer)) {
            return true;
        }

        try {
            const fragment = range.cloneContents();
            return !!(
                fragment &&
                typeof fragment.querySelector === 'function' &&
                fragment.querySelector(
                    'br, img, input, hr, [data-exclude-from-markdown="true"], ' +
                    '.code-block-toolbar, .row-handle, .col-handle'
                )
            );
        } catch (_) {
            return true;
        }
    }

    _findNearestMatch() {
        if (!this.savedSelection || this.matches.length === 0) return 0;

        for (let i = 0; i < this.matches.length; i++) {
            try {
                const comparison = this.savedSelection.compareBoundaryPoints(
                    Range.START_TO_START,
                    this.matches[i]
                );
                if (comparison <= 0) {
                    return i;
                }
            } catch (_) {
                // Range comparison may fail if DOM changed
            }
        }
        return 0;
    }

    // ── CSS Custom Highlight API ────────────────────────────

    _applyHighlights() {
        if (!CSS.highlights) {
            console.warn('[SearchManager] CSS Custom Highlight API not supported');
            return;
        }

        const allRanges = this.matches.map(m => {
            const r = new Range();
            r.setStart(m.startContainer, m.startOffset);
            r.setEnd(m.endContainer, m.endOffset);
            return r;
        });

        if (allRanges.length > 0) {
            const highlight = new Highlight(...allRanges);
            CSS.highlights.set('search-matches', highlight);
        }
    }

    _updateCurrentMatchHighlight() {
        if (!CSS.highlights) return;

        if (this.currentMatchIndex >= 0 && this.currentMatchIndex < this.matches.length) {
            const m = this.matches[this.currentMatchIndex];
            const r = new Range();
            r.setStart(m.startContainer, m.startOffset);
            r.setEnd(m.endContainer, m.endOffset);

            const highlight = new Highlight(r);
            CSS.highlights.set('search-current', highlight);
        } else {
            CSS.highlights.delete('search-current');
        }
    }

    _clearHighlights() {
        if (!CSS.highlights) return;
        CSS.highlights.delete('search-matches');
        CSS.highlights.delete('search-current');
    }

    // ── Navigation helpers ──────────────────────────────────

    _scrollToCurrentMatch() {
        if (this.currentMatchIndex < 0 || this.currentMatchIndex >= this.matches.length) return;

        const range = this.matches[this.currentMatchIndex];
        const rect = range.getBoundingClientRect();
        const editorRect = this.editor.getBoundingClientRect();
        const searchBarHeight = this.searchBar.offsetHeight || 40;

        const isAboveViewport = rect.top < editorRect.top + searchBarHeight;
        const isBelowViewport = rect.bottom > editorRect.bottom;

        if (isAboveViewport || isBelowViewport) {
            const editorVisibleHeight = editorRect.height - searchBarHeight;
            const targetScrollTop = this.editor.scrollTop +
                (rect.top - editorRect.top - searchBarHeight) -
                (editorVisibleHeight / 2) +
                (rect.height / 2);

            this.editor.scrollTo({
                top: Math.max(0, targetScrollTop),
                behavior: 'smooth'
            });
        }
    }

    _updateMatchCountLabel() {
        if (this.matches.length === 0) {
            this.matchCountLabel.textContent = this.query ? 'No results' : '';
            this.matchCountLabel.classList.toggle('no-results', !!this.query);
        } else {
            this.matchCountLabel.textContent =
                `${this.currentMatchIndex + 1}/${this.matches.length}`;
            this.matchCountLabel.classList.remove('no-results');
        }

        const hasMatches = this.matches.length > 0;
        this.replaceButton.disabled = !hasMatches;
        this.replaceAllButton.disabled = !hasMatches;
    }
}
