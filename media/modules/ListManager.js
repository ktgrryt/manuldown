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

    _getLastDirectListItem(listElement) {
        if (!listElement || (listElement.tagName !== 'UL' && listElement.tagName !== 'OL')) {
            return null;
        }
        const children = Array.from(listElement.children || []);
        for (let i = children.length - 1; i >= 0; i--) {
            const child = children[i];
            if (child && child.tagName === 'LI') {
                return child;
            }
        }
        return null;
    }

    _findTailListItem(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) {
            return null;
        }

        if (node.tagName === 'LI') {
            return node;
        }

        const directListItem = this._getLastDirectListItem(node);
        if (directListItem) {
            return directListItem;
        }

        const children = Array.from(node.children || []);
        for (let i = children.length - 1; i >= 0; i--) {
            const candidate = this._findTailListItem(children[i]);
            if (candidate) {
                return candidate;
            }
        }
        return null;
    }

    _findPreviousIndentTargetListItem(listItem, parentList) {
        if (!parentList) return null;

        let current = parentList;
        while (current && current !== this.editor) {
            let prev = current.previousElementSibling;
            while (prev) {
                const candidate = this._findTailListItem(prev);
                if (candidate && candidate !== listItem && candidate.tagName === 'LI') {
                    return candidate;
                }
                prev = prev.previousElementSibling;
            }
            current = current.parentElement;
        }
        return null;
    }

    /**
     * リストアイテムをインデント（ネスト）
     * @param {HTMLElement} listItem - インデントするリストアイテム
     * @param {Text} textNode - テキストノード（未使用だが互換性のため保持）
     * @param {number} offset - オフセット（未使用だが互換性のため保持）
     */
    indentListItem(listItem, textNode, offset) {
        const parentList = listItem.parentElement;
        let previousSibling = listItem.previousElementSibling;
        if (!previousSibling || previousSibling.tagName !== 'LI') {
            previousSibling = this._findPreviousIndentTargetListItem(listItem, parentList);
        }
        if (!previousSibling) {
            // エディタのフォーカスを維持
            this.editor.focus();
            return;
        }
        

        // 移動前に現在の選択範囲を保存
        const selection = window.getSelection();
        const currentRange = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        const cursorNode = currentRange ? currentRange.startContainer : null;
        const cursorOffset = currentRange ? currentRange.startOffset : 0;

        // 前の兄弟要素がサブリスト(<ul>または<ol>)の場合、
        // そのサブリストの最後の<li>を前の兄弟要素として扱う
        if (previousSibling.tagName === 'UL' || previousSibling.tagName === 'OL') {
            const lastLi = previousSibling.lastElementChild;
            if (lastLi && lastLi.tagName === 'LI') {
                previousSibling = lastLi;
            } else {
                this.editor.focus();
                return;
            }
        }

        // 前の兄弟要素の中のサブリストを探す
        // 重要: 前の兄弟要素が<li>の場合、その中の最後のサブリストを探す
        // これにより、正しいネスト構造が維持される
        let sublist = null;
        
        // 前の兄弟要素が<li>の場合、その中の最後のサブリストを探す
        if (previousSibling.tagName === 'LI') {
            // 前の兄弟要素の直接の子要素を逆順でチェック（最後のサブリストを見つける）
            const children = Array.from(previousSibling.children);
            for (let i = children.length - 1; i >= 0; i--) {
                const child = children[i];
                if (child.tagName === 'UL' || child.tagName === 'OL') {
                    sublist = child;
                    break;
                }
            }
            
            // サブリストが存在しない場合は作成
            if (!sublist) {
                sublist = document.createElement(parentList.tagName);
                // 重要: 前の兄弟要素(<li>)の最後の子要素として追加
                previousSibling.appendChild(sublist);
            }
        } else {
            // 前の兄弟要素が<li>でない場合（通常はありえないが念のため）
            sublist = document.createElement(parentList.tagName);
            previousSibling.appendChild(sublist);
        }

        // リストアイテムをサブリストに移動
        sublist.appendChild(listItem);
        if (parentList && parentList.children.length === 0) {
            parentList.remove();
        }
        
        // カーソルとフォーカスを復元
        // DOMが更新されるまで待つためにrequestAnimationFrameを使用
        requestAnimationFrame(() => {
            // エディタにフォーカスを確保
            this.editor.focus();
            
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
                console.error('[ListManager.indentListItem] Failed to set cursor:', e);
            }
        });
    }

    /**
     * リストアイテムをアウトデント（ネスト解除）
     * @param {HTMLElement} listItem - アウトデントするリストアイテム
     * @param {Text} textNode - テキストノード（未使用だが互換性のため保持）
     * @param {number} offset - オフセット（未使用だが互換性のため保持）
     */
    outdentListItem(listItem, textNode, offset) {
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
            const isEmpty = directTextContent.replace(/[\u00A0\u200B]/g, '').trim() === '';
            
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
                
                // 後続の兄弟要素がある場合、それらを新しいサブリストに移動
                if (followingSiblings.length > 0) {
                    // 新しいサブリストを作成
                    const newSublist = document.createElement(parentList.tagName);
                    
                    // 後続の兄弟要素を新しいサブリストに移動
                    followingSiblings.forEach(sibling => {
                        newSublist.appendChild(sibling);
                    });
                    
                    // 新しいサブリストを移動したリストアイテムに追加
                    listItem.appendChild(newSublist);
                }
                
                // 既存のサブリストがあった場合、それも追加
                if (existingSublist) {
                    listItem.appendChild(existingSublist);
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
                            child.textContent.replace(/[\u00A0\u200B]/g, '').trim() !== '') {
                            hasDirectText = true;
                            break;
                        } else if (child.nodeType === Node.ELEMENT_NODE &&
                                   child.tagName !== 'UL' && child.tagName !== 'OL' &&
                                   child.textContent.replace(/[\u00A0\u200B]/g, '').trim() !== '') {
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
                        const anchorNode = document.createTextNode('\u200B');
                        if (nextNode) {
                            listItem.insertBefore(anchorNode, nextNode);
                        } else {
                            listItem.appendChild(anchorNode);
                        }
                    } else {
                        const text = nextNode.textContent || '';
                        if (/^[ \u00A0]/.test(text)) {
                            nextNode.textContent = text.slice(1) || '\u200B';
                        } else if (text === '') {
                            nextNode.textContent = '\u200B';
                        }
                    }
                } else {
                    // すべての子ノードを削除（<br>を含む）
                    while (listItem.firstChild) {
                        listItem.removeChild(listItem.firstChild);
                    }
                    // カーソル配置用の単一のテキストノードを追加
                    const newTextNode = document.createTextNode('');
                    listItem.appendChild(newTextNode);
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
        const normalizedText = (listItem.textContent || '').replace(/[\u00A0\u200B]/g, '').trim();
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
