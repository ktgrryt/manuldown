// @ts-nocheck
/**
 * 状態管理モジュール
 * Undo/Redo履歴の管理と選択範囲の保存/復元を担当
 */

export class StateManager {
    constructor(editor, vscodeApi, options = {}) {
        this.editor = editor;
        this.vscodeApi = vscodeApi;
        this.undoStack = [];
        this.redoStack = [];
        this.maxHistorySize = Number.isSafeInteger(options.maxHistorySize) && options.maxHistorySize > 0
            ? options.maxHistorySize
            : 100;
        this.maxHistoryBytes = Number.isSafeInteger(options.maxHistoryBytes) && options.maxHistoryBytes > 0
            ? options.maxHistoryBytes
            : 32 * 1024 * 1024;
        this.getComparableHtml = typeof options.getComparableHtml === 'function'
            ? options.getComparableHtml
            : null;
        this.undoHistoryBytes = 0;
        this.redoHistoryBytes = 0;
        this.isRestoringState = false;
        this.saveStateTimeout = null;
        this.historyRestoreTimeout = null;
        this.pendingSaveSelection = null;
        this.pendingChangeSelection = null;
    }

    estimateSelectionBytes(selection) {
        if (!selection) return 0;
        try {
            return JSON.stringify(selection).length * 2;
        } catch {
            return 0;
        }
    }

    getCurrentComparableHtml() {
        if (this.getComparableHtml) {
            try {
                const comparableHtml = this.getComparableHtml();
                if (typeof comparableHtml === 'string') {
                    return comparableHtml;
                }
            } catch (_error) {
                // Fall back to the restorable DOM snapshot below.
            }
        }
        return this.editor.innerHTML;
    }

    getStateComparableHtml(state) {
        if (!state) return '';
        return typeof state.comparableHtml === 'string'
            ? state.comparableHtml
            : String(state.html || '');
    }

    rebaseCurrentHistoryStateComparable() {
        const state = this.undoStack[this.undoStack.length - 1];
        if (!state) return false;

        const comparableHtml = this.getCurrentComparableHtml();
        if (this.getStateComparableHtml(state) === comparableHtml) {
            return false;
        }

        // History restoration deliberately installs the raw DOM snapshot first,
        // then rebuilds presentation-only UI (Prism spans, table wrappers, etc.).
        // Treat that normalized live DOM as another representation of this same
        // state. Otherwise the next Undo/Redo mistakes it for a user edit and
        // pushUndoState() clears the Redo stack.
        const previousByteSize = this.getStateByteSize(state);
        state.comparableHtml = comparableHtml === state.html ? null : comparableHtml;
        state.byteSize = (String(state.html || '').length * 2) +
            (typeof state.comparableHtml === 'string' ? state.comparableHtml.length * 2 : 0) +
            this.estimateSelectionBytes(state.selection);
        this.undoHistoryBytes += state.byteSize - previousByteSize;
        this.trimHistory();
        return true;
    }

    createState(selection = this.saveSelection()) {
        // getCleanedHTML can synchronize live checkbox attributes, so read the
        // restorable DOM only after producing the UI-independent comparison HTML.
        const comparableHtml = this.getCurrentComparableHtml();
        const html = this.editor.innerHTML;
        const storedComparableHtml = comparableHtml === html ? null : comparableHtml;
        return {
            html,
            comparableHtml: storedComparableHtml,
            selection,
            byteSize: (html.length * 2) +
                (storedComparableHtml ? storedComparableHtml.length * 2 : 0) +
                this.estimateSelectionBytes(selection)
        };
    }

    getStateByteSize(state) {
        if (!state) return 0;
        if (Number.isSafeInteger(state.byteSize) && state.byteSize >= 0) {
            return state.byteSize;
        }
        return (String(state.html || '').length * 2) +
            (typeof state.comparableHtml === 'string' ? state.comparableHtml.length * 2 : 0) +
            this.estimateSelectionBytes(state.selection);
    }

    clearRedoHistory() {
        this.redoStack = [];
        this.redoHistoryBytes = 0;
    }

    trimHistory() {
        while (
            (
                this.undoStack.length + this.redoStack.length > this.maxHistorySize ||
                this.undoHistoryBytes + this.redoHistoryBytes > this.maxHistoryBytes
            )
        ) {
            if (this.undoStack.length > 1) {
                const removedState = this.undoStack.shift();
                this.undoHistoryBytes -= this.getStateByteSize(removedState);
                continue;
            }
            if (this.redoStack.length > 0) {
                const removedState = this.redoStack.shift();
                this.redoHistoryBytes -= this.getStateByteSize(removedState);
                continue;
            }
            break;
        }
        this.undoHistoryBytes = Math.max(0, this.undoHistoryBytes);
        this.redoHistoryBytes = Math.max(0, this.redoHistoryBytes);
    }

    pushUndoState(state, { clearRedo = true, deduplicate = true } = {}) {
        const latestState = this.undoStack[this.undoStack.length - 1];
        if (
            deduplicate &&
            latestState &&
            this.getStateComparableHtml(latestState) === this.getStateComparableHtml(state)
        ) {
            // selection is the anchor of the change that created this snapshot.
            // Moving the caret without changing HTML must not rewrite that anchor.
            return false;
        }

        if (clearRedo) {
            this.clearRedoHistory();
        }
        this.undoStack.push(state);
        this.undoHistoryBytes += this.getStateByteSize(state);
        this.trimHistory();
        return true;
    }

    /**
     * 現在の選択範囲を保存
     * @returns {Object|null} 選択範囲の情報、または選択がない場合null
     */
    saveSelection() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return null;

        return this.saveRange(selection.getRangeAt(0));
    }

    /**
     * 現在のSelectionを動かさず、指定Rangeを履歴用bookmarkへ変換する。
     * @param {Range|null} range
     * @returns {Object|null}
     */
    saveRange(range) {
        if (!range) return null;

        const isNodeInEditor = (node) => !!(
            node &&
            (
                node === this.editor ||
                (typeof this.editor.contains === 'function' && this.editor.contains(node))
            )
        );
        if (!isNodeInEditor(range.startContainer) || !isNodeInEditor(range.endContainer)) {
            return null;
        }
        
        /**
         * ノードのパスを取得（エディタからの相対位置）
         */
        const getNodePath = (node) => {
            const path = [];
            let current = node;
            
            while (current && current !== this.editor) {
                const parent = current.parentNode;
                if (!parent) return null;
                
                const index = Array.from(parent.childNodes).indexOf(current);
                if (index < 0) return null;
                path.unshift(index);
                current = parent;
            }
            
            return current === this.editor ? path : null;
        };

        const startPath = getNodePath(range.startContainer);
        const endPath = getNodePath(range.endContainer);
        if (!startPath || !endPath) return null;

        return {
            startPath,
            startOffset: range.startOffset,
            endPath,
            endOffset: range.endOffset,
            collapsed: range.collapsed
        };
    }

    /**
     * 保存された選択範囲を復元
     * @param {Object|null} savedSelection - 保存された選択範囲の情報
     * @returns {boolean} 復元できた場合true
     */
    restoreSelection(savedSelection) {
        if (!savedSelection) return false;

        const selection = window.getSelection();
        if (!selection) return false;

        /**
         * パスからRangeの境界を取得。Undo/Redoでノードが消えた場合は、
         * 最も深くまで一致した祖先の最寄りオフセットを使う。
         */
        const getBoundaryByPath = (path, savedOffset) => {
            if (!Array.isArray(path)) return null;

            const isCharacterDataNode = (node) => !!(
                node &&
                (node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8)
            );
            const getMaxOffset = (node) => isCharacterDataNode(node)
                ? String(node.data ?? node.textContent ?? '').length
                : (node && node.childNodes ? node.childNodes.length : 0);
            const normalizedOffset = Number.isSafeInteger(savedOffset) && savedOffset >= 0
                ? savedOffset
                : 0;
            let node = this.editor;
            
            for (const index of path) {
                if (!Number.isSafeInteger(index) || index < 0) {
                    return null;
                }
                // Syntax highlighting can flatten a saved SPAN > text path into one
                // text node. Keep the character offset instead of falling to its start.
                if (isCharacterDataNode(node)) {
                    return {
                        node,
                        offset: Math.min(normalizedOffset, getMaxOffset(node))
                    };
                }
                if (!node.childNodes) return null;
                if (!node.childNodes[index]) {
                    return {
                        node,
                        offset: Math.min(index, node.childNodes.length)
                    };
                }
                node = node.childNodes[index];
            }
            
            return {
                node,
                offset: Math.min(normalizedOffset, getMaxOffset(node))
            };
        };

        try {
            const startBoundary = getBoundaryByPath(
                savedSelection.startPath,
                savedSelection.startOffset
            );
            const endBoundary = getBoundaryByPath(
                savedSelection.endPath,
                savedSelection.endOffset
            );

            if (!startBoundary || !endBoundary) return false;

            const range = document.createRange();
            range.setStart(startBoundary.node, startBoundary.offset);
            if (savedSelection.collapsed) {
                range.collapse(true);
            } else {
                range.setEnd(endBoundary.node, endBoundary.offset);
            }

            selection.removeAllRanges();
            selection.addRange(range);
            return true;
        } catch (error) {
            console.error('Error restoring selection:', error);
            return false;
        }
    }

    restoreHistorySelection(primarySelection, fallbackSelection) {
        if (primarySelection && this.restoreSelection(primarySelection)) {
            return true;
        }
        if (fallbackSelection && fallbackSelection !== primarySelection) {
            return this.restoreSelection(fallbackSelection);
        }
        return false;
    }

    focusEditorWithoutScrolling() {
        try {
            this.editor.focus({ preventScroll: true });
        } catch (e) {
            this.editor.focus();
        }
    }

    finishHistoryRestore(
        primarySelection,
        fallbackSelection,
        notifyCallback,
        afterSelectionRestoreCallback,
        preservedScrollTop = null
    ) {
        const restoreFocusAndSelection = () => {
            this.focusEditorWithoutScrolling();
            this.restoreHistorySelection(primarySelection, fallbackSelection);
            if (Number.isFinite(preservedScrollTop)) {
                // Replacing innerHTML and restoring a selection can make Chromium
                // drift upward inside the editor's large bottom padding. Keep the
                // previous viewport until the caret reveal performs the one needed
                // adjustment toward the actual change.
                this.editor.scrollTop = preservedScrollTop;
            }
        };

        try {
            if (notifyCallback) {
                notifyCallback();
            }
        } finally {
            this.rebaseCurrentHistoryStateComparable();
            // The normalization callback can rebuild nodes (notably syntax-highlighted
            // code), so apply the change anchor again after all synchronous DOM work.
            try {
                restoreFocusAndSelection();
            } finally {
                if (this.historyRestoreTimeout) {
                    clearTimeout(this.historyRestoreTimeout);
                }
                this.historyRestoreTimeout = setTimeout(() => {
                    this.historyRestoreTimeout = null;
                    restoreFocusAndSelection();
                    if (afterSelectionRestoreCallback) {
                        // Reveal only after the final focus/selection pass. Calling it
                        // for both passes lets two layout phases fight over scrollTop.
                        afterSelectionRestoreCallback(preservedScrollTop);
                    }
                }, 0);
            }
        }
    }

    mapHistorySelectionToCurrentDom(primarySelection, fallbackSelection) {
        const restored = this.restoreHistorySelection(primarySelection, fallbackSelection);
        if (!restored) return null;

        // History bookmarks belong to the DOM snapshot that was edited. Once the
        // target HTML is installed, capture the successfully mapped position again
        // so later normalization/highlighting never reuses a source-DOM node path.
        return this.saveSelection();
    }

    takePendingSaveSelection() {
        if (this.saveStateTimeout) {
            clearTimeout(this.saveStateTimeout);
            this.saveStateTimeout = null;
        }
        const selection = this.pendingSaveSelection;
        this.pendingSaveSelection = null;
        return selection;
    }

    captureCurrentStateForHistory() {
        if (this.historyRestoreTimeout) {
            clearTimeout(this.historyRestoreTimeout);
            this.historyRestoreTimeout = null;
        }
        const pendingSelection = this.takePendingSaveSelection();
        const liveSelection = this.saveSelection();
        const latestState = this.undoStack[this.undoStack.length - 1];

        const currentComparableHtml = this.getCurrentComparableHtml();
        if (
            !latestState ||
            this.getStateComparableHtml(latestState) !== currentComparableHtml
        ) {
            const changeSelection = pendingSelection || this.pendingChangeSelection || liveSelection;
            this.pushUndoState(this.createState(changeSelection));
        }

        this.pendingChangeSelection = null;
        return liveSelection;
    }

    /**
     * デフォルトのカーソル位置を設定（エディタの最初）
     */
    setDefaultCursorPosition() {
        try {
            const selection = window.getSelection();
            if (!selection) return;

            // エディタの最初の要素を探す
            let firstElement = this.editor.firstChild;
            
            // 最初のテキストノードまたは要素を見つける
            while (firstElement && firstElement.nodeType !== 3 && firstElement.nodeType !== 1) {
                firstElement = firstElement.nextSibling;
            }

            if (firstElement) {
                const range = document.createRange();
                
                if (firstElement.nodeType === 3) {
                    // テキストノードの場合
                    range.setStart(firstElement, 0);
                } else {
                    // 要素ノードの場合
                    range.setStart(firstElement, 0);
                }
                
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        } catch (error) {
            console.error('Error setting default cursor position:', error);
        }
    }

    /**
     * 現在のエディタ状態をUndoスタックに保存
     */
    saveState() {
        this.beginChangeAtSelection(null);
    }

    /**
     * 指定位置で始まるプログラム編集の変更前状態を保存する。
     * @param {Object|null} changeSelection
     */
    beginChangeAtSelection(changeSelection) {
        if (this.isRestoringState) {
            return;
        }

        const liveSelection = this.saveSelection();
        const pendingSelection = this.takePendingSaveSelection();
        this.pushUndoState(this.createState(
            pendingSelection || this.pendingChangeSelection || liveSelection
        ));
        // saveState() is the pre-change API used by toolbar, table and keyboard
        // operations. First it commits any preceding programmatic change above;
        // then it keeps this operation's location until its new HTML is captured.
        this.pendingChangeSelection = changeSelection || liveSelection;
    }

    /**
     * 変更後のDOMを即座に履歴へ確定する。
     * @param {Object} options
     * @param {boolean} options.preferLiveSelection - 変更前保存を伴わない操作ではtrue
     * @param {Object|null} options.changeSelection - 非同期編集などの明示的な変更位置
     */
    commitStateAfterChange({ preferLiveSelection = false, changeSelection = null } = {}) {
        if (this.isRestoringState) return;

        const liveSelection = this.saveSelection();
        const pendingSelection = this.takePendingSaveSelection();
        const resolvedChangeSelection = changeSelection || (
            preferLiveSelection
                ? liveSelection
                : (pendingSelection || this.pendingChangeSelection || liveSelection)
        );
        this.pushUndoState(this.createState(resolvedChangeSelection));
        this.pendingChangeSelection = null;
    }

    /**
     * 読み込み直後の基準状態を保存する。次の変更用アンカーは作らない。
     */
    seedState() {
        if (this.isRestoringState) return;

        this.takePendingSaveSelection();
        this.pendingChangeSelection = null;
        this.pushUndoState(this.createState(this.saveSelection()));
    }

    /**
     * デバウンス付きで状態を保存（テキスト入力用）
     */
    saveStateDebounced() {
        if (this.isRestoringState) return;

        // Capture the caret at input time. Waiting 500ms must not let a later click
        // replace the edit anchor with an unrelated location.
        this.pendingSaveSelection = this.saveSelection();
        if (this.saveStateTimeout) {
            clearTimeout(this.saveStateTimeout);
        }
        
        this.saveStateTimeout = setTimeout(() => {
            this.saveStateTimeout = null;
            const pendingSelection = this.pendingSaveSelection;
            this.pendingSaveSelection = null;
            const pushed = this.pushUndoState(this.createState(pendingSelection));
            if (pushed) {
                this.pendingChangeSelection = null;
            }
        }, 500); // 最後の入力から0.5秒後に状態を保存
    }

    /**
     * Undo操作を実行
     * @param {Function} notifyCallback - 変更を通知するコールバック
     * @param {Function} afterSelectionRestoreCallback - 変更箇所を表示するコールバック
     */
    performUndo(notifyCallback, afterSelectionRestoreCallback) {
        const liveSelection = this.captureCurrentStateForHistory();
        const preservedScrollTop = Number.isFinite(this.editor.scrollTop)
            ? this.editor.scrollTop
            : null;
        
        // undoStackが空、または1つしかない場合は何もしない
        if (this.undoStack.length <= 1) {
            return false;
        }

        this.isRestoringState = true;
        
        // 現在の状態（undoStackの最後）をRedoスタックに移動
        const currentState = this.undoStack.pop();
        this.undoHistoryBytes -= this.getStateByteSize(currentState);
        this.redoStack.push(currentState);
        this.redoHistoryBytes += this.getStateByteSize(currentState);
        
        // Undoスタックから前の状態を復元
        const state = this.undoStack[this.undoStack.length - 1];
        const changeSelection = currentState.selection;
        const fallbackSelection = state.selection || liveSelection;
        this.editor.innerHTML = state.html;
        // Some normalization steps inspect the active caret, so restore once before
        // the callback. Save that mapped target-DOM position for all later restores.
        const mappedSelection = this.mapHistorySelectionToCurrentDom(
            changeSelection,
            fallbackSelection
        );

        this.isRestoringState = false;
        this.finishHistoryRestore(
            mappedSelection || changeSelection,
            fallbackSelection,
            notifyCallback,
            afterSelectionRestoreCallback,
            preservedScrollTop
        );
        return true;
    }

    /**
     * Redo操作を実行
     * @param {Function} notifyCallback - 変更を通知するコールバック
     * @param {Function} afterSelectionRestoreCallback - 変更箇所を表示するコールバック
     */
    performRedo(notifyCallback, afterSelectionRestoreCallback) {
        // A new unsaved DOM state invalidates Redo even when it came from a
        // programmatic edit that did not schedule the normal debounce.
        const liveSelection = this.captureCurrentStateForHistory();
        const preservedScrollTop = Number.isFinite(this.editor.scrollTop)
            ? this.editor.scrollTop
            : null;
        
        if (this.redoStack.length === 0) return false;

        this.isRestoringState = true;
        
        // Redoスタックから状態を復元
        const previousState = this.undoStack[this.undoStack.length - 1];
        const state = this.redoStack.pop();
        this.redoHistoryBytes -= this.getStateByteSize(state);
        this.undoStack.push(state);
        this.undoHistoryBytes += this.getStateByteSize(state);
        const changeSelection = state.selection;
        const fallbackSelection = (previousState && previousState.selection) || liveSelection;
        this.editor.innerHTML = state.html;
        const mappedSelection = this.mapHistorySelectionToCurrentDom(
            changeSelection,
            fallbackSelection
        );

        this.isRestoringState = false;
        this.finishHistoryRestore(
            mappedSelection || changeSelection,
            fallbackSelection,
            notifyCallback,
            afterSelectionRestoreCallback,
            preservedScrollTop
        );
        return true;
    }

    /**
     * 状態復元中かどうかを取得
     * @returns {boolean} 状態復元中の場合true
     */
    isRestoring() {
        return this.isRestoringState;
    }

    /**
     * 履歴をクリア
     */
    clearHistory() {
        if (this.saveStateTimeout) {
            clearTimeout(this.saveStateTimeout);
            this.saveStateTimeout = null;
        }
        if (this.historyRestoreTimeout) {
            clearTimeout(this.historyRestoreTimeout);
            this.historyRestoreTimeout = null;
        }
        this.pendingSaveSelection = null;
        this.pendingChangeSelection = null;
        this.undoStack = [];
        this.redoStack = [];
        this.undoHistoryBytes = 0;
        this.redoHistoryBytes = 0;
    }
}

// Made with Bob
