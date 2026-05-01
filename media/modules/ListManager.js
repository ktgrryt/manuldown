// @ts-nocheck
/**
 * リスト管理モジュール
 * リストアイテムのインデント、アウトデント、カーソル復元を担当
 */

export class ListManager {
    constructor(editor, domUtils) {
        this.editor = editor;
        this.domUtils = domUtils;
    }

    _isListElement(element) {
        return !!(element && (element.tagName === 'UL' || element.tagName === 'OL'));
    }

    _getDirectNestedLists(listItem) {
        if (!listItem || listItem.tagName !== 'LI') {
            return [];
        }
        return Array.from(listItem.children || []).filter((child) => this._isListElement(child));
    }

    _hasDirectTextContent(listItem) {
        if (!listItem || listItem.tagName !== 'LI') {
            return false;
        }
        let directText = '';
        for (const child of Array.from(listItem.childNodes || [])) {
            if (child.nodeType === Node.TEXT_NODE) {
                directText += child.textContent || '';
                continue;
            }
            if (child.nodeType === Node.ELEMENT_NODE && !this._isListElement(child)) {
                directText += child.textContent || '';
            }
        }
        return directText.replace(/[\u00A0\u200B\u2060\uFEFF]/g, '').trim() !== '';
    }

    _markIndentWrapper(listItem) {
        if (!listItem || listItem.tagName !== 'LI') {
            return;
        }
        listItem.setAttribute('data-mdw-indent-wrapper', 'true');
        listItem.classList.add('nested-list-only');
    }

    _clearSourceIndentMetadata(listItem) {
        if (!listItem || listItem.tagName !== 'LI') {
            return;
        }
        listItem.removeAttribute('data-mdw-source-indent');
        Array.from(listItem.querySelectorAll ? listItem.querySelectorAll('li[data-mdw-source-indent]') : [])
            .forEach((child) => child.removeAttribute('data-mdw-source-indent'));
    }

    _createIndentWrapper(parentList, referenceNode = null) {
        if (!this._isListElement(parentList)) {
            return null;
        }
        const wrapper = document.createElement('li');
        this._markIndentWrapper(wrapper);
        const sublist = document.createElement(parentList.tagName);
        wrapper.appendChild(sublist);
        parentList.insertBefore(wrapper, referenceNode);
        return { wrapper, sublist };
    }

    _ensureDirectSublist(listItem, tagName) {
        if (!listItem || listItem.tagName !== 'LI') {
            return null;
        }
        const normalizedTagName = tagName === 'OL' ? 'OL' : 'UL';
        let sublist = Array.from(listItem.children || []).find(
            (child) => child.tagName === normalizedTagName
        );
        if (!sublist) {
            sublist = document.createElement(normalizedTagName);
            listItem.appendChild(sublist);
        }
        return sublist;
    }

    _detachDirectNestedLists(listItem) {
        const nestedLists = this._getDirectNestedLists(listItem);
        nestedLists.forEach((nestedList) => nestedList.remove());
        return nestedLists;
    }

    _collectFollowingListItems(listItem) {
        const followingSiblings = [];
        let nextSibling = listItem ? listItem.nextElementSibling : null;
        while (nextSibling) {
            const sibling = nextSibling;
            nextSibling = nextSibling.nextElementSibling;
            if (sibling.tagName === 'LI') {
                followingSiblings.push(sibling);
            }
        }
        return followingSiblings;
    }

    _cleanupEmptyWrapper(wrapper) {
        if (!wrapper || wrapper.tagName !== 'LI') {
            return;
        }
        if (this._hasDirectTextContent(wrapper)) {
            wrapper.removeAttribute('data-mdw-indent-wrapper');
            wrapper.classList.remove('nested-list-only');
            return;
        }
        const nestedLists = this._getDirectNestedLists(wrapper).filter(
            (list) => Array.from(list.children || []).some((child) => child.tagName === 'LI')
        );
        if (nestedLists.length === 0) {
            wrapper.remove();
            return;
        }
        if (wrapper.getAttribute('data-preserve-empty') !== 'true') {
            this._markIndentWrapper(wrapper);
        }
    }

    _restoreCursorInMovedListItem(listItem, cursorNode, cursorOffset, fallbackOffset = 0) {
        requestAnimationFrame(() => {
            this.editor.focus();

            const selection = window.getSelection();
            if (!selection) return;

            let targetTextNode = this.domUtils.getFirstTextNode(listItem);
            if (!targetTextNode) {
                targetTextNode = document.createTextNode('');
                const firstSublist = this._getDirectNestedLists(listItem)[0] || null;
                listItem.insertBefore(targetTextNode, firstSublist);
            }

            if (cursorNode && listItem.contains(cursorNode)) {
                try {
                    const range = document.createRange();
                    const safeOffset = Math.max(0, Math.min(
                        cursorOffset,
                        cursorNode.nodeType === Node.TEXT_NODE
                            ? (cursorNode.textContent || '').length
                            : (cursorNode.childNodes ? cursorNode.childNodes.length : 0)
                    ));
                    range.setStart(cursorNode, safeOffset);
                    range.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(range);
                    return;
                } catch (e) {
                }
            }

            try {
                const range = document.createRange();
                range.setStart(
                    targetTextNode,
                    Math.max(0, Math.min(fallbackOffset, (targetTextNode.textContent || '').length))
                );
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
            } catch (e) {
                console.error('[ListManager] Failed to restore cursor:', e);
            }
        });
    }

    /**
     * リストアイテムをインデント（ネスト）
     * @param {HTMLElement} listItem - インデントするリストアイテム
     * @param {Text} textNode - テキストノード（未使用だが互換性のため保持）
     * @param {number} offset - オフセット（未使用だが互換性のため保持）
     */
    indentListItem(listItem, textNode, offset) {
        this._clearSourceIndentMetadata(listItem);

        const parentList = listItem.parentElement;
        let previousSibling = listItem.previousElementSibling;
        if (!this._isListElement(parentList)) {
            this.editor.focus();
            return;
        }

        // 移動前に現在の選択範囲を保存
        const selection = window.getSelection();
        const currentRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        const cursorNode = currentRange ? currentRange.startContainer : null;
        const cursorOffset = currentRange ? currentRange.startOffset : 0;

        let sublist = null;
        let targetParentItem = null;
        if (previousSibling && previousSibling.tagName === 'LI') {
            targetParentItem = previousSibling;
            sublist = this._ensureDirectSublist(previousSibling, parentList.tagName);
        } else {
            const wrapperInfo = this._createIndentWrapper(parentList, listItem);
            if (!wrapperInfo) {
                this.editor.focus();
                return;
            }
            targetParentItem = wrapperInfo.wrapper;
            sublist = wrapperInfo.sublist;
        }

        const detachedNestedLists = this._detachDirectNestedLists(listItem);
        sublist.appendChild(listItem);

        detachedNestedLists.forEach((nestedList) => {
            if (nestedList.tagName === sublist.tagName) {
                while (nestedList.firstElementChild) {
                    sublist.appendChild(nestedList.firstElementChild);
                }
                nestedList.remove();
            } else if (targetParentItem) {
                targetParentItem.insertBefore(nestedList, sublist.nextSibling);
            }
        });

        if (parentList && parentList.children.length === 0) {
            parentList.remove();
        }

        this._cleanupEmptyWrapper(targetParentItem);
        this._restoreCursorInMovedListItem(listItem, cursorNode, cursorOffset, 0);
    }

    _outdentListItemIndependently(listItem) {
        const parentList = listItem ? listItem.parentElement : null;
        if (!this._isListElement(parentList)) {
            return false;
        }

        const grandParentItem = parentList.parentElement;
        if (!grandParentItem || grandParentItem.tagName !== 'LI') {
            return false;
        }

        const grandParentList = grandParentItem.parentElement;
        if (!this._isListElement(grandParentList)) {
            return false;
        }

        this._clearSourceIndentMetadata(listItem);

        const selection = window.getSelection();
        const currentRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        const cursorNode = currentRange ? currentRange.startContainer : null;
        const cursorOffset = currentRange ? currentRange.startOffset : 0;

        const detachedNestedLists = this._detachDirectNestedLists(listItem);
        const followingSiblings = this._collectFollowingListItems(listItem);
        const insertBeforeNode = grandParentItem.nextSibling;

        grandParentList.insertBefore(listItem, insertBeforeNode);

        let continuationSublist = null;
        const ensureContinuationSublist = () => {
            if (!continuationSublist || !continuationSublist.isConnected) {
                continuationSublist = this._ensureDirectSublist(listItem, parentList.tagName);
            }
            return continuationSublist;
        };

        detachedNestedLists.forEach((nestedList) => {
            const wrapper = document.createElement('li');
            this._markIndentWrapper(wrapper);
            wrapper.appendChild(nestedList);
            ensureContinuationSublist().appendChild(wrapper);
        });

        followingSiblings.forEach((sibling) => {
            ensureContinuationSublist().appendChild(sibling);
        });

        if (parentList.children.length === 0) {
            parentList.remove();
        }

        this._cleanupEmptyWrapper(grandParentItem);
        this._restoreCursorInMovedListItem(listItem, cursorNode, cursorOffset, 0);
        return true;
    }

    /**
     * リストアイテムをアウトデント（ネスト解除）
     * @param {HTMLElement} listItem - アウトデントするリストアイテム
     * @param {Text} textNode - テキストノード（未使用だが互換性のため保持）
     * @param {number} offset - オフセット（未使用だが互換性のため保持）
     */
    outdentListItem(listItem, textNode, offset) {
        if (this._outdentListItemIndependently(listItem)) {
            return;
        }

        const parentList = listItem.parentElement;
        const grandParentItem = parentList.parentElement;
        
        if (grandParentItem && grandParentItem.tagName === 'LI') {
            const grandParentList = grandParentItem.parentElement;
            const index = Array.from(grandParentList.children).indexOf(grandParentItem);
            
            // 移動前に現在の選択範囲を保存
            const selection = window.getSelection();
            const currentRange = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
            const cursorNode = currentRange ? currentRange.startContainer : null;
            const cursorOffset = currentRange ? currentRange.startOffset : 0;
            
            // リストアイテムの直接のテキストコンテンツを取得（サブリストを除く）
            let directTextContent = '';
            for (let child of listItem.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    directTextContent += child.textContent;
                } else if (child.nodeType === Node.ELEMENT_NODE &&
                           child.tagName !== 'UL' && child.tagName !== 'OL') {
                    directTextContent += child.textContent;
                }
            }
            const isEmpty = directTextContent.replace(/[\u00A0\u200B\u2060]/g, '').trim() === '';
            
            // 現在のリストアイテムの後続の兄弟要素を保存
            const followingSiblings = [];
            let nextSibling = listItem.nextElementSibling;
            while (nextSibling) {
                followingSiblings.push(nextSibling);
                nextSibling = nextSibling.nextElementSibling;
            }
            
            // リストアイテム内の既存のサブリストを保存
            const existingSublist = Array.from(listItem.children).find(
                child => child.tagName === 'UL' || child.tagName === 'OL'
            );
            
            // 空のリストアイテムで、サブリストがある場合
            if (isEmpty && existingSublist) {
                
                // 空のリストアイテムをアウトデント（親リストの次の位置に移動）
                grandParentList.insertBefore(listItem, grandParentList.children[index + 1]);
                
                // 既存のサブリストはそのまま保持（listItemに付いたまま）
                // これにより、構造は以下のようになる：
                // - a
                //   - (空のlistItem)
                //     - c (existingSublist内)
                
                // 後続の兄弟要素がある場合、それらをexistingSublistに追加
                if (followingSiblings.length > 0) {
                    followingSiblings.forEach(sibling => {
                        existingSublist.appendChild(sibling);
                    });
                }
                
                // 空のサブリストをクリーンアップ
                if (parentList.children.length === 0) {
                    parentList.remove();
                }
                
                // カーソル位置とフォーカスを復元
                requestAnimationFrame(() => {
                    this.editor.focus();
                    
                    const selection = window.getSelection();
                    if (selection) {
                        // アウトデントしたリストアイテムにカーソルを配置
                        let targetNode = this.domUtils.getFirstTextNode(listItem);
                        if (!targetNode) {
                            const textNode = document.createTextNode('');
                            listItem.insertBefore(textNode, existingSublist);
                            targetNode = textNode;
                        }
                        
                        try {
                            const range = document.createRange();
                            range.setStart(targetNode, 0);
                            range.collapse(true);
                            selection.removeAllRanges();
                            selection.addRange(range);
                        } catch (e) {
                            console.error('Failed to restore cursor:', e);
                        }
                    }
                });
                
                return; // 早期リターンして、以降の処理をスキップ
            } else {
                // 通常のアウトデント処理
                // リストアイテムの直接のテキストコンテンツのみを保持するために、
                // サブリストを一時的に削除
                if (existingSublist) {
                    existingSublist.remove();
                }
                
                // アイテムを親の後に移動
                grandParentList.insertBefore(listItem, grandParentList.children[index + 1]);
                
                // 既存のサブリストは先に戻し、元の子要素順を維持する。
                if (existingSublist) {
                    listItem.appendChild(existingSublist);
                }

                // 後続の兄弟要素は、同じ種類の既存サブリストがあれば末尾にマージし、
                // なければ新しいサブリストとして追加する。
                if (followingSiblings.length > 0) {
                    const targetSublist = existingSublist && existingSublist.tagName === parentList.tagName
                        ? existingSublist
                        : document.createElement(parentList.tagName);

                    followingSiblings.forEach(sibling => {
                        targetSublist.appendChild(sibling);
                    });

                    if (targetSublist !== existingSublist) {
                        listItem.appendChild(targetSublist);
                    }
                }
            }
            
            // 空のサブリストをクリーンアップ
            if (parentList.children.length === 0) {
                parentList.remove();
                
                // 親リストを削除した後、その親リストアイテム（grandParentItem）が
                // テキストコンテンツを持たず、サブリストのみを持っている場合、
                // そのサブリストを親リストアイテムの親リストに移動
                if (grandParentItem) {
                    
                    // まず、空白のみのテキストノードとBRタグを削除
                    const childNodesToRemove = [];
                    for (let child of grandParentItem.childNodes) {
                        if (child.nodeType === Node.TEXT_NODE && child.textContent.trim() === '') {
                            childNodesToRemove.push(child);
                        } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') {
                            childNodesToRemove.push(child);
                        }
                    }
                    childNodesToRemove.forEach(node => node.remove());
                    
                    // grandParentItemの直接のテキストコンテンツを取得（サブリストを除く）
                    let hasDirectText = false;
                    for (let child of grandParentItem.childNodes) {
                        if (child.nodeType === Node.TEXT_NODE &&
                            child.textContent.replace(/[\u00A0\u200B\u2060]/g, '').trim() !== '') {
                            hasDirectText = true;
                            break;
                        } else if (child.nodeType === Node.ELEMENT_NODE &&
                                   child.tagName !== 'UL' && child.tagName !== 'OL' &&
                                   child.textContent.replace(/[\u00A0\u200B\u2060]/g, '').trim() !== '') {
                            // 他の要素（strong, em, codeなど）にテキストがある場合
                            hasDirectText = true;
                            break;
                        }
                    }
                    
                    
                    // 直接のテキストがなく、サブリストのみの場合
                    if (!hasDirectText) {
                        const sublists = Array.from(grandParentItem.children).filter(
                            child => child.tagName === 'UL' || child.tagName === 'OL'
                        );
                        
                        
                        if (sublists.length > 0 && grandParentList) {
                            // サブリスト内のすべてのアイテムを親リストに移動
                            sublists.forEach(sublist => {
                                const items = Array.from(sublist.children);
                                items.forEach(item => {
                                    grandParentList.insertBefore(item, grandParentItem.nextSibling);
                                });
                                sublist.remove();
                            });
                            
                            // 空になったgrandParentItemを削除
                            grandParentItem.remove();
                        }
                    }
                }
            }
            
            // リストアイテムが空だった場合、またはBRタグのみの場合、クリーンアップ
            if (isEmpty) {
                const checkbox = listItem.querySelector(':scope > input[type="checkbox"]');
                if (checkbox) {
                    // チェックボックスは保持し、他の子ノードを整理
                    const keepNodes = new Set([checkbox]);
                    const children = Array.from(listItem.childNodes);
                    children.forEach(child => {
                        if (keepNodes.has(child)) return;
                        if (child.nodeType === Node.ELEMENT_NODE &&
                            (child.tagName === 'UL' || child.tagName === 'OL')) {
                            return;
                        }
                        child.remove();
                    });

                    // チェックボックス直後にカーソルアンカーを確保
                    const nextNode = checkbox.nextSibling;
                    if (!nextNode || nextNode.nodeType !== Node.TEXT_NODE) {
                        const anchorNode = document.createTextNode('');
                        if (nextNode) {
                            listItem.insertBefore(anchorNode, nextNode);
                        } else {
                            listItem.appendChild(anchorNode);
                        }
                    } else {
                        const text = nextNode.textContent || '';
                        if (/^[ \u00A0]/.test(text)) {
                            nextNode.textContent = text.slice(1) || '';
                        } else if (text === '') {
                            nextNode.textContent = '';
                        }
                    }
                } else {
                    // ネストしたサブリストは保持し、それ以外の子ノードのみ削除する。
                    // 空アイテムのアウトデント時に後続兄弟をサブリストへ移すため、
                    // ここでサブリストを消すと項目が失われる。
                    const children = Array.from(listItem.childNodes);
                    children.forEach(child => {
                        if (child.nodeType === Node.ELEMENT_NODE &&
                            (child.tagName === 'UL' || child.tagName === 'OL')) {
                            return;
                        }
                        child.remove();
                    });

                    // カーソル配置用のテキストノードを先頭に確保
                    const firstSublist = Array.from(listItem.children).find(
                        child => child.tagName === 'UL' || child.tagName === 'OL'
                    );
                    const anchorNode = document.createTextNode('');
                    if (firstSublist) {
                        listItem.insertBefore(anchorNode, firstSublist);
                    } else {
                        listItem.appendChild(anchorNode);
                    }
                }
            } else {
                // 空でない場合でも、先頭のBRタグを削除
                const firstChild = listItem.firstChild;
                if (firstChild && firstChild.nodeType === Node.ELEMENT_NODE && firstChild.tagName === 'BR') {
                    firstChild.remove();
                }
            }
            
            // カーソル位置とフォーカスを復元
            // DOMが更新されるまで待つためにrequestAnimationFrameを使用
            requestAnimationFrame(() => {
                // エディタにフォーカスを確保
                this.editor.focus();
                
                const selection = window.getSelection();
                if (!selection) return;
                
                // リストアイテムにテキストノードがあることを確認
                let targetTextNode = this.domUtils.getFirstTextNode(listItem);
                if (!targetTextNode) {
                    // テキストノードが存在しない場合は作成
                    targetTextNode = document.createTextNode('');
                    // サブリストの前に挿入
                    const firstChild = listItem.firstChild;
                    if (firstChild && (firstChild.tagName === 'UL' || firstChild.tagName === 'OL')) {
                        listItem.insertBefore(targetTextNode, firstChild);
                    } else {
                        listItem.insertBefore(targetTextNode, firstChild);
                    }
                }
                
                // カーソルが実際にこのリストアイテム内にあった場合のみ復元を試みる
                if (cursorNode && listItem.contains(cursorNode)) {
                    try {
                        const range = document.createRange();
                        range.setStart(cursorNode, cursorOffset);
                        range.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(range);
                        return;
                    } catch (e) {
                    }
                }
                
                // フォールバック：テキストノードの先頭にカーソルを配置
                try {
                    const range = document.createRange();
                    range.setStart(targetTextNode, 0);
                    range.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(range);
                } catch (e) {
                    console.error('[ListManager.outdentListItem] Failed to set cursor:', e);
                }
            });
        } else {
            // ネストされたリストにない場合、フォーカスを維持
            this.editor.focus();
        }
    }

    /**
     * リストアイテム内のカーソル位置を復元
     * @param {HTMLElement} listItem - リストアイテム
     * @param {Text} originalTextNode - 元のテキストノード
     * @param {number} originalOffset - 元のオフセット
     */
    restoreCursorInListItem(listItem, originalTextNode, originalOffset) {
        const selection = window.getSelection();
        if (!selection) return;

        // リストアイテムが空または空白のみかチェック
        const normalizedText = (listItem.textContent || '').replace(/[\u00A0\u200B\u2060]/g, '').trim();
        const isEmpty = normalizedText === '';
        
        if (isEmpty) {
            // 空のリストアイテムの場合、カーソル配置用のテキストノードを確保
            // 既存の内容をまず削除
            while (listItem.firstChild) {
                listItem.removeChild(listItem.firstChild);
            }
            
            // 空のテキストノードを作成
            const emptyTextNode = document.createTextNode('');
            listItem.appendChild(emptyTextNode);
            
            // 空のテキストノードの先頭にカーソルを設定
            const range = document.createRange();
            range.setStart(emptyTextNode, 0);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            return;
        }

        // 移動したリストアイテム内のテキストノードを見つける
        const textNodes = this.domUtils.getTextNodes(listItem);
        let targetNode = textNodes[0];
        let targetOffset = 0;

        // 同じテキストノードを見つけるか、最初のものを使用
        for (let node of textNodes) {
            if (node.textContent === originalTextNode.textContent) {
                targetNode = node;
                targetOffset = Math.min(originalOffset, node.textContent.length);
                break;
            }
        }

        if (targetNode) {
            const range = document.createRange();
            range.setStart(targetNode, targetOffset);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
        }
    }
}

// Made with Bob
