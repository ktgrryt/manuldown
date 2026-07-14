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
        this.undoHistoryBytes = 0;
        this.redoHistoryBytes = 0;
        this.isRestoringState = false;
        this.saveStateTimeout = null;
    }

    estimateSelectionBytes(selection) {
        if (!selection) return 0;
        try {
            return JSON.stringify(selection).length * 2;
        } catch {
            return 0;
        }
    }

    createState() {
        const html = this.editor.innerHTML;
        const selection = this.saveSelection();
        return {
            html,
            selection,
            byteSize: (html.length * 2) + this.estimateSelectionBytes(selection)
        };
    }

    getStateByteSize(state) {
        if (!state) return 0;
        if (Number.isSafeInteger(state.byteSize) && state.byteSize >= 0) {
            return state.byteSize;
        }
        return (String(state.html || '').length * 2) + this.estimateSelectionBytes(state.selection);
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
        if (deduplicate && latestState && latestState.html === state.html) {
            this.undoHistoryBytes -= this.getStateByteSize(latestState);
            latestState.selection = state.selection;
            latestState.byteSize = state.byteSize;
            this.undoHistoryBytes += this.getStateByteSize(latestState);
            this.trimHistory();
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

        const range = selection.getRangeAt(0);
        
        /**
         * ノードのパスを取得（エディタからの相対位置）
         */
        const getNodePath = (node) => {
            const path = [];
            let current = node;
            
            while (current && current !== this.editor) {
                const parent = current.parentNode;
                if (!parent) break;
                
                const index = Array.from(parent.childNodes).indexOf(current);
                path.unshift(index);
                current = parent;
            }
            
            return path;
        };

        return {
            startPath: getNodePath(range.startContainer),
            startOffset: range.startOffset,
            endPath: getNodePath(range.endContainer),
            endOffset: range.endOffset,
            collapsed: range.collapsed
        };
    }

    /**
     * 保存された選択範囲を復元
     * @param {Object|null} savedSelection - 保存された選択範囲の情報
     */
    restoreSelection(savedSelection) {
        if (!savedSelection) return;

        const selection = window.getSelection();
        if (!selection) return;

        /**
         * パスからノードを取得
         */
        const getNodeByPath = (path) => {
            let node = this.editor;
            
            for (const index of path) {
                if (!node.childNodes[index]) {
                    return null;
                }
                node = node.childNodes[index];
            }
            
            return node;
        };

        try {
            const startNode = getNodeByPath(savedSelection.startPath);
            const endNode = getNodeByPath(savedSelection.endPath);

            if (!startNode || !endNode) return;

            const range = document.createRange();
            range.setStart(startNode, Math.min(savedSelection.startOffset, startNode.length || startNode.childNodes.length || 0));
            range.setEnd(endNode, Math.min(savedSelection.endOffset, endNode.length || endNode.childNodes.length || 0));

            selection.removeAllRanges();
            selection.addRange(range);
        } catch (error) {
            console.error('Error restoring selection:', error);
        }
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
        if (this.isRestoringState) {
            return;
        }
        
        // 保留中の保存タイムアウトをクリア
        if (this.saveStateTimeout) {
            clearTimeout(this.saveStateTimeout);
            this.saveStateTimeout = null;
        }
        
        this.pushUndoState(this.createState());
    }

    /**
     * デバウンス付きで状態を保存（テキスト入力用）
     */
    saveStateDebounced() {
        if (this.isRestoringState) return;
        
        if (this.saveStateTimeout) {
            clearTimeout(this.saveStateTimeout);
        }
        
        this.saveStateTimeout = setTimeout(() => {
            this.saveState();
            this.saveStateTimeout = null;
        }, 500); // 最後の入力から0.5秒後に状態を保存
    }

    /**
     * Undo操作を実行
     * @param {Function} notifyCallback - 変更を通知するコールバック
     */
    performUndo(notifyCallback) {
        // 保留中の保存があれば即座に実行
        if (this.saveStateTimeout) {
            clearTimeout(this.saveStateTimeout);
            this.saveStateTimeout = null;
            
            // 現在の状態を保存（保留中の保存を実行）
            this.pushUndoState(this.createState());
            
        }
        
        // undoStackが空、または1つしかない場合は何もしない
        if (this.undoStack.length <= 1) {
            return;
        }

        // The backing TextDocument can receive the same keyboard Undo through
        // VS Code. Declare the exact history direction before restoring the DOM
        // so the extension host can keep both sides in one transaction.
        if (this.vscodeApi) {
            this.vscodeApi.postMessage({ type: 'undoRedo', direction: 'undo' });
        }
        
        this.isRestoringState = true;
        
        // 現在の状態（undoStackの最後）をRedoスタックに移動
        const currentState = this.undoStack.pop();
        this.undoHistoryBytes -= this.getStateByteSize(currentState);
        this.redoStack.push(currentState);
        this.redoHistoryBytes += this.getStateByteSize(currentState);
        
        // Undoスタックから前の状態を復元
        const state = this.undoStack[this.undoStack.length - 1];
        const scrollTop = this.editor.scrollTop;
        this.editor.innerHTML = state.html;
        this.restoreSelection(state.selection);
        this.editor.scrollTop = scrollTop;

        this.isRestoringState = false;

        // エディタにフォーカスを維持（スクロールを防止）
        const scrollTopAfter = this.editor.scrollTop;
        setTimeout(() => {
            try { this.editor.focus({ preventScroll: true }); } catch (e) { this.editor.focus(); }
            this.editor.scrollTop = scrollTopAfter;
        }, 0);
        
        // VSCodeに変更を通知
        if (notifyCallback) {
            notifyCallback();
        }
    }

    /**
     * Redo操作を実行
     * @param {Function} notifyCallback - 変更を通知するコールバック
     */
    performRedo(notifyCallback) {
        // 保留中の入力があれば先に履歴へ保存する。内容が変わっていれば
        // Redo履歴がクリアされるため、未保存の入力を上書きしない。
        if (this.saveStateTimeout) {
            clearTimeout(this.saveStateTimeout);
            this.saveStateTimeout = null;
            this.pushUndoState(this.createState());
        }
        
        if (this.redoStack.length === 0) return;

        if (this.vscodeApi) {
            this.vscodeApi.postMessage({ type: 'undoRedo', direction: 'redo' });
        }
        
        this.isRestoringState = true;
        
        // Redoスタックから状態を復元
        const state = this.redoStack.pop();
        this.redoHistoryBytes -= this.getStateByteSize(state);
        this.undoStack.push(state);
        this.undoHistoryBytes += this.getStateByteSize(state);
        const scrollTop = this.editor.scrollTop;
        this.editor.innerHTML = state.html;
        this.restoreSelection(state.selection);
        this.editor.scrollTop = scrollTop;

        this.isRestoringState = false;

        // エディタにフォーカスを維持（スクロールを防止）
        const scrollTopAfter = this.editor.scrollTop;
        setTimeout(() => {
            try { this.editor.focus({ preventScroll: true }); } catch (e) { this.editor.focus(); }
            this.editor.scrollTop = scrollTopAfter;
        }, 0);
        
        // VSCodeに変更を通知
        if (notifyCallback) {
            notifyCallback();
        }
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
        this.undoStack = [];
        this.redoStack = [];
        this.undoHistoryBytes = 0;
        this.redoHistoryBytes = 0;
    }
}

// Made with Bob
