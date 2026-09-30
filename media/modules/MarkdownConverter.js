// @ts-nocheck
/**
 * Markdown変換モジュール
 * Markdown構文をHTMLに変換する機能を提供
 */

export class MarkdownConverter {
    constructor(editor, domUtils, options = {}) {
        this.editor = editor;
        this.domUtils = domUtils;
        this.applyImageSourcePolicy = typeof options.applyImageSourcePolicy === 'function'
            ? options.applyImageSourcePolicy
            : null;
    }

    isIgnorableText(text) {
        return (text || '').replace(/[\u200B\u2060\u00A0]/g, '').trim() === '';
    }

    trimBoundaryNodes(nodes, { trimLeadingBreak = false, trimTrailingBreak = false } = {}) {
        if (!Array.isArray(nodes) || nodes.length === 0) return;

        if (trimLeadingBreak) {
            while (nodes.length > 0) {
                const first = nodes[0];
                if (first.nodeType === Node.TEXT_NODE && this.isIgnorableText(first.textContent || '')) {
                    nodes.shift();
                    continue;
                }
                if (first.nodeType === Node.ELEMENT_NODE && first.tagName === 'BR') {
                    nodes.shift();
                    continue;
                }
                break;
            }
        }

        if (trimTrailingBreak) {
            while (nodes.length > 0) {
                const last = nodes[nodes.length - 1];
                if (last.nodeType === Node.TEXT_NODE && this.isIgnorableText(last.textContent || '')) {
                    nodes.pop();
                    continue;
                }
                if (last.nodeType === Node.ELEMENT_NODE && last.tagName === 'BR') {
                    nodes.pop();
                    continue;
                }
                break;
            }
        }
    }

    hasMeaningfulNodes(nodes) {
        if (!Array.isArray(nodes) || nodes.length === 0) return false;
        return nodes.some((node) => {
            if (!node) return false;
            if (node.nodeType === Node.TEXT_NODE) {
                return !this.isIgnorableText(node.textContent || '');
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return false;
            return node.tagName !== 'BR';
        });
    }

    isInsideCode(node) {
        let current = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentNode;
        while (current && current !== this.editor) {
            if (current.tagName === 'CODE' || current.tagName === 'PRE') {
                return true;
            }
            current = current.parentNode;
        }
        return false;
    }

    /**
     * Whether textNode starts a line of its block: only ignorable text, or a
     * <br> that ends the previous line, precedes it in a block-level parent.
     * Text inside inline formatting, or after other content, never does.
     */
    isAtLineStart(textNode) {
        const parent = textNode && textNode.parentNode;
        if (!parent) return false;
        if (parent !== this.editor && !/^(?:P|DIV|LI|H[1-6]|BLOCKQUOTE|TD|TH)$/.test(parent.tagName || '')) {
            return false;
        }
        for (let sibling = textNode.previousSibling; sibling; sibling = sibling.previousSibling) {
            if (sibling.nodeType === Node.TEXT_NODE) {
                if (!this.isIgnorableText(sibling.textContent || '')) return false;
                continue;
            }
            if (sibling.nodeType === Node.ELEMENT_NODE) {
                return sibling.tagName === 'BR';
            }
        }
        return true;
    }

    /** Like isAtLineStart, but also no <br> may precede textNode. */
    isAtBlockStart(textNode) {
        if (!this.isAtLineStart(textNode)) return false;
        for (let sibling = textNode.previousSibling; sibling; sibling = sibling.previousSibling) {
            if (sibling.nodeType === Node.ELEMENT_NODE) return false;
        }
        return true;
    }

    /**
     * Replace the line that textNode starts with blockElement without touching
     * the rest of its parent: other lines of a paragraph become paragraphs of
     * their own, and a parent is only replaced when textNode is all it holds.
     */
    replaceLineWithBlock(textNode, blockElement) {
        const parent = textNode.parentElement;
        if (!parent || parent === this.editor) {
            textNode.parentNode.replaceChild(blockElement, textNode);
            return;
        }
        if (this.splitParagraphAndInsertBlock(textNode, blockElement)) {
            return;
        }
        const otherNodes = Array.from(parent.childNodes).filter((node) => node !== textNode);
        if (/^(?:P|DIV|H[1-6])$/.test(parent.tagName) && !this.hasMeaningfulNodes(otherNodes)) {
            parent.replaceWith(blockElement);
            return;
        }
        textNode.parentNode.replaceChild(blockElement, textNode);
    }

    /** Move the nodes that follow textNode in its parent to the end of target. */
    moveContentAfter(textNode, target) {
        let node = textNode.nextSibling;
        while (node) {
            const next = node.nextSibling;
            target.appendChild(node);
            node = next;
        }
    }

    /**
     * A marker typed at the start of an existing list item only removes the
     * marker (and adds a checkbox for "[ ]"): the item keeps its other inline
     * content and nested lists. Returns the text node that holds the item text.
     */
    stripItemStartMarker(textNode, itemText, isTaskItem = false, taskChecked = false) {
        const listItem = textNode.parentNode;
        const replacement = document.createTextNode(itemText);
        textNode.replaceWith(replacement);
        if (isTaskItem) {
            const hasCheckbox = Array.from(listItem.children).some(
                (child) => child.tagName === 'INPUT' && child.type === 'checkbox'
            );
            if (!hasCheckbox) {
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                if (taskChecked) {
                    checkbox.checked = true;
                    checkbox.setAttribute('checked', '');
                }
                listItem.insertBefore(checkbox, replacement);
            }
        }
        return replacement;
    }

    /**
     * Offset in rawText of the character at normalizedOffset, where the
     * normalized text drops caret controls and no-break spaces.
     */
    toRawOffset(rawText, normalizedOffset) {
        let kept = 0;
        for (let i = 0; i < rawText.length; i++) {
            if (/[​⁠ ]/.test(rawText[i])) continue;
            if (kept === normalizedOffset) return i;
            kept++;
        }
        return rawText.length;
    }

    /**
     * The raw text between two normalized offsets with only the caret controls
     * removed: no-break spaces are user text (Chromium inserts them for
     * consecutive spaces) and must survive a conversion.
     */
    rawSlice(rawText, normalizedStart, normalizedEnd) {
        const start = this.toRawOffset(rawText, normalizedStart);
        const end = normalizedEnd === undefined ? rawText.length : this.toRawOffset(rawText, normalizedEnd);
        return rawText.slice(start, end).replace(/[​⁠]/g, '');
    }

    splitParagraphAndInsertBlock(textNode, blockElement) {
        const parent = textNode && textNode.parentElement;
        if (!parent || parent.tagName !== 'P') return false;
        const parentContainer = parent.parentNode;
        if (!parentContainer) return false;

        const beforeNodes = [];
        const afterNodes = [];
        let passedTarget = false;
        Array.from(parent.childNodes).forEach((node) => {
            if (node === textNode) {
                passedTarget = true;
                return;
            }
            if (passedTarget) {
                afterNodes.push(node);
            } else {
                beforeNodes.push(node);
            }
        });

        if (beforeNodes.length === 0 && afterNodes.length === 0) {
            return false;
        }

        this.trimBoundaryNodes(beforeNodes, { trimTrailingBreak: true });
        this.trimBoundaryNodes(afterNodes, { trimLeadingBreak: true });

        const beforeHasMeaningful = this.hasMeaningfulNodes(beforeNodes);
        const afterHasMeaningful = this.hasMeaningfulNodes(afterNodes);

        const beforeParagraph = beforeHasMeaningful ? document.createElement('p') : null;
        const afterParagraph = afterHasMeaningful ? document.createElement('p') : null;

        if (beforeParagraph) {
            beforeNodes.forEach((node) => beforeParagraph.appendChild(node));
        }
        if (afterParagraph) {
            afterNodes.forEach((node) => afterParagraph.appendChild(node));
        }

        if (!passedTarget) {
            return false;
        }

        textNode.remove();
        parentContainer.insertBefore(blockElement, parent);
        if (beforeParagraph) {
            parentContainer.insertBefore(beforeParagraph, blockElement);
        }
        if (afterParagraph) {
            if (blockElement.nextSibling) {
                parentContainer.insertBefore(afterParagraph, blockElement.nextSibling);
            } else {
                parentContainer.appendChild(afterParagraph);
            }
        }
        parent.remove();
        return true;
    }

    /**
     * 隣接する同じタイプのリストをマージする
     * @param {HTMLElement} listElement - マージ対象のリスト要素(UL/OL)
     * @returns {HTMLElement} マージ後のリスト要素
     */
    mergeAdjacentLists(listElement) {
        if (!listElement) return listElement;
        const tagName = listElement.tagName;

        // 前の兄弟とマージ
        const prev = listElement.previousElementSibling;
        if (prev && prev.tagName === tagName) {
            while (listElement.firstChild) {
                prev.appendChild(listElement.firstChild);
            }
            listElement.remove();
            listElement = prev;
        }

        // 次の兄弟とマージ
        const next = listElement.nextElementSibling;
        if (next && next.tagName === tagName) {
            while (next.firstChild) {
                listElement.appendChild(next.firstChild);
            }
            next.remove();
        }

        return listElement;
    }

    /**
     * 指定位置のMarkdown記号がバックスラッシュでエスケープされているか判定
     * @param {string} text - 判定対象テキスト
     * @param {number} markerIndex - 記号の開始インデックス
     * @returns {boolean} エスケープされている場合true
     */
    isEscapedAt(text, markerIndex) {
        if (typeof text !== 'string' || markerIndex <= 0 || markerIndex > text.length) {
            return false;
        }

        let backslashCount = 0;
        for (let i = markerIndex - 1; i >= 0 && text[i] === '\\'; i--) {
            backslashCount++;
        }

        return backslashCount % 2 === 1;
    }

    /**
     * 入力直後の "\*" のような単一エスケープを表示上の記号へ反映する
     * (例: "\*" -> "*")
     * @param {Text} textNode
     * @param {number} cursorOffset
     * @param {Selection} selection
     * @param {Function} notifyCallback
     * @returns {boolean} 変換が行われた場合true
     */
    applySingleCharacterEscapeAtCursor(textNode, cursorOffset, selection, notifyCallback) {
        if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return false;
        if (typeof cursorOffset !== 'number' || cursorOffset <= 1) return false;

        // コード内ではMarkdownエスケープを自動反映しない
        const inCode = !!this.domUtils.getParentElement(textNode, 'CODE');
        if (inCode) return false;

        const rawText = textNode.textContent || '';
        if (cursorOffset > rawText.length) return false;

        const markerIndex = cursorOffset - 1;
        const marker = rawText[markerIndex];

        // Markdownでエスケープ対象になりやすい記号のみ対象にする
        if (!/[`*_{}\[\]()#+.!|>~-]/.test(marker)) {
            return false;
        }

        // 直前がバックスラッシュ1個のときだけ "\*" -> "*" を適用
        if (rawText[markerIndex - 1] !== '\\') return false;
        if (markerIndex - 2 >= 0 && rawText[markerIndex - 2] === '\\') return false;

        const nextText = rawText.slice(0, markerIndex - 1) + rawText.slice(markerIndex);
        textNode.textContent = nextText;

        const nextOffset = Math.max(0, cursorOffset - 1);
        const range = document.createRange();
        range.setStart(textNode, Math.min(nextOffset, nextText.length));
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);

        if (notifyCallback) notifyCallback();
        return true;
    }

    /**
     * Markdown構文をHTMLに変換
     * @param {Function} notifyCallback - 変更を通知するコールバック
     * @returns {boolean} 変換が実行された場合true、それ以外はfalse
     */
    /**
     * @param {Function} notifyCallback
     * @param {Object} [options]
     * @param {string|null} [options.insertedText] - Text the triggering input
     *   (keystroke or IME commit) inserted before the caret, when known.
     */
    convertMarkdownSyntax(notifyCallback, options = {}) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return false;

        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        let textNode = container.nodeType === 3 ? container : null;
        let cursorOffset = null;
        const isMeaningfulTextNode = (node) => {
            if (!node || node.nodeType !== 3) return false;
            const text = (node.textContent || '').replace(/[\u200B\u2060\u00A0]/g, '');
            return text.trim() !== '';
        };
        const findDirectTextNode = (element) => {
            if (!element) return null;
            const walker = document.createTreeWalker(
                element,
                NodeFilter.SHOW_TEXT,
                {
                    acceptNode: (node) => {
                        if (!isMeaningfulTextNode(node)) {
                            return NodeFilter.FILTER_SKIP;
                        }
                        let parent = node.parentElement;
                        while (parent && parent !== element) {
                            if (parent.tagName === 'UL' || parent.tagName === 'OL') {
                                return NodeFilter.FILTER_REJECT;
                            }
                            parent = parent.parentElement;
                        }
                        return NodeFilter.FILTER_ACCEPT;
                    }
                }
            );
            return walker.nextNode();
        };

        if (textNode) {
            cursorOffset = range.startOffset;
        } else if (container.nodeType === 1) {
            const childNodes = container.childNodes;
            const before = range.startOffset > 0 ? childNodes[range.startOffset - 1] : null;
            const after = childNodes[range.startOffset] || null;

            if (before && before.nodeType === Node.TEXT_NODE && isMeaningfulTextNode(before)) {
                textNode = before;
                cursorOffset = before.textContent.length;
            } else if (after && after.nodeType === Node.TEXT_NODE && isMeaningfulTextNode(after)) {
                textNode = after;
                cursorOffset = 0;
            } else if (before && before.nodeType === Node.ELEMENT_NODE) {
                textNode = this.domUtils.getLastTextNode(before);
                if (textNode) {
                    cursorOffset = textNode.textContent.length;
                }
            } else if (after && after.nodeType === Node.ELEMENT_NODE) {
                textNode = this.domUtils.getFirstTextNode(after);
                if (textNode) {
                    cursorOffset = 0;
                }
            }
        }

        if ((!textNode || !isMeaningfulTextNode(textNode)) && container.nodeType === 1) {
            const fallbackNode = findDirectTextNode(container);
            if (fallbackNode) {
                textNode = fallbackNode;
                cursorOffset = fallbackNode === range.startContainer ? range.startOffset : fallbackNode.textContent.length;
            }
        }

        if (!textNode || textNode.nodeType !== 3 || cursorOffset === null) return false;

        // Code holds literal text; what is typed there is never formatting.
        if (this.isInsideCode(textNode)) return false;

        const rawText = textNode.textContent || '';
        if (this.applySingleCharacterEscapeAtCursor(textNode, cursorOffset, selection, notifyCallback)) {
            return true;
        }
        const normalizedText = rawText.replace(/[\u200B\u2060\u00A0]/g, '');
        const normalizedCursorOffset = rawText.slice(0, cursorOffset).replace(/[\u200B\u2060\u00A0]/g, '').length;
        const isInTableCell = !!(
            this.domUtils.getParentElement(textNode, 'TD') ||
            this.domUtils.getParentElement(textNode, 'TH')
        );
        const isInListItem = !!this.domUtils.getParentElement(textNode, 'LI');
        const isInHeading = !!(
            this.domUtils.getParentElement(textNode, 'H1') ||
            this.domUtils.getParentElement(textNode, 'H2') ||
            this.domUtils.getParentElement(textNode, 'H3') ||
            this.domUtils.getParentElement(textNode, 'H4') ||
            this.domUtils.getParentElement(textNode, 'H5') ||
            this.domUtils.getParentElement(textNode, 'H6')
        );

        // Block shortcuts ("# ", "- ", "1. ", "> ", "---") apply only to a
        // marker at the start of a line that the user has just typed: removing
        // the inserted text must leave the marker alone before the caret. Text
        // such as an escaped "\# title", or " - " later in a line, stays text.
        const toMarkerText = (value) => String(value || '')
            .replace(/[​⁠]/g, '')
            .replace(/ /g, ' ');
        const textBeforeCaret = toMarkerText(rawText.slice(0, cursorOffset));
        const insertedText = typeof options.insertedText === 'string'
            ? toMarkerText(options.insertedText)
            : null;
        const blockMarkerTyped = (markerOnlyPattern, { requireBlockStart = false } = {}) => {
            const atStart = requireBlockStart
                ? this.isAtBlockStart(textNode)
                : this.isAtLineStart(textNode);
            if (!atStart) return false;
            if (insertedText === null) return true;
            if (!textBeforeCaret.endsWith(insertedText)) return false;
            return markerOnlyPattern.test(textBeforeCaret) ||
                markerOnlyPattern.test(textBeforeCaret.slice(0, textBeforeCaret.length - insertedText.length));
        };

        // 見出し構文をチェック（行頭）
        const headingMatch = normalizedText.match(/^\s*(#{1,6})\s+(.+)$/);
        if (!isInTableCell && !isInListItem && headingMatch && blockMarkerTyped(/^\s*#{1,6}\s+$/)) {
            const level = headingMatch[1].length;
            const content = headingMatch[2];
            const headingTag = 'h' + level;

            const heading = document.createElement(headingTag);
            heading.textContent = content;

            this.replaceLineWithBlock(textNode, heading);

            // カーソル位置を復元
            const newRange = document.createRange();
            const textContent = heading.firstChild;
            if (textContent) {
                const newOffset = Math.min(content.length, normalizedCursorOffset - headingMatch[1].length - 1);
                newRange.setStart(textContent, Math.max(0, newOffset));
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
            }

            if (notifyCallback) notifyCallback();
            return true;
        }

        // 太字構文をチェック **text**
        // As in CommonMark, the text inside the delimiters must not start or
        // end with whitespace ("5 * 3 *" stays text).
        const boldMatch = normalizedText.match(/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/);
        if (boldMatch && normalizedCursorOffset === normalizedText.length) {
            const boldStart = normalizedText.length - boldMatch[0].length;
            const boldClosingStart = normalizedText.length - 2;
            const boldIsEscaped =
                this.isEscapedAt(normalizedText, boldStart) ||
                this.isEscapedAt(normalizedText, boldClosingStart);
            if (boldIsEscaped) {
                // 明示的にエスケープされた "**" は装飾へ変換しない
            } else {
                const beforeText = this.rawSlice(rawText, 0, boldStart);
                const boldText = this.rawSlice(rawText, boldStart + 2, boldClosingStart);

                const fragment = document.createDocumentFragment();

                if (beforeText) {
                    fragment.appendChild(document.createTextNode(beforeText));
                }

                const strong = document.createElement('strong');
                strong.textContent = boldText;
                fragment.appendChild(strong);

                // 後ろにスペースを追加
                const spacer = document.createTextNode(' ');
                fragment.appendChild(spacer);

                textNode.parentNode.replaceChild(fragment, textNode);

                // 太字テキストの後にカーソルを設定
                // (the fragment is empty once inserted, so keep the spacer node)
                const newRange = document.createRange();
                newRange.setStart(spacer, 1);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                if (notifyCallback) notifyCallback();
                return true;
            }
        }

        // イタリック構文をチェック *text*
        const italicMatch = normalizedText.match(/(?<!\*)\*([^*\s](?:[^*]*[^*\s])?)\*(?!\*)$/);
        if (italicMatch && normalizedCursorOffset === normalizedText.length) {
            const italicStart = normalizedText.length - italicMatch[0].length;
            const italicClosingStart = normalizedText.length - 1;
            const italicIsEscaped =
                this.isEscapedAt(normalizedText, italicStart) ||
                this.isEscapedAt(normalizedText, italicClosingStart);
            if (italicIsEscaped) {
                // 明示的にエスケープされた "*" は装飾へ変換しない
            } else {
                const beforeText = this.rawSlice(rawText, 0, italicStart);
                const italicText = this.rawSlice(rawText, italicStart + 1, italicClosingStart);

                const fragment = document.createDocumentFragment();

                if (beforeText) {
                    fragment.appendChild(document.createTextNode(beforeText));
                }

                const em = document.createElement('em');
                em.textContent = italicText;
                fragment.appendChild(em);

                // 後ろにスペースを追加
                const spacer = document.createTextNode(' ');
                fragment.appendChild(spacer);

                textNode.parentNode.replaceChild(fragment, textNode);

                // イタリックテキストの後にカーソルを設定
                // (the fragment is empty once inserted, so keep the spacer node)
                const newRange = document.createRange();
                newRange.setStart(spacer, 1);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                if (notifyCallback) notifyCallback();
                return true;
            }
        }

        // 取り消し線構文をチェック ~~text~~（カーソル直前の範囲で判定）
        const beforeCursorText = normalizedText.slice(0, normalizedCursorOffset);
        const strikeMatch = beforeCursorText.match(/~~([^~]+)~~(\s*)$/);
        if (strikeMatch) {
            const matchedText = strikeMatch[0];
            const trailingSpace = strikeMatch[2] || '';
            const strikeStart = beforeCursorText.length - matchedText.length;
            const strikeClosingStart = beforeCursorText.length - trailingSpace.length - 2;
            const strikeIsEscaped =
                this.isEscapedAt(beforeCursorText, strikeStart) ||
                this.isEscapedAt(beforeCursorText, strikeClosingStart);
            if (strikeIsEscaped) {
                // 明示的にエスケープされた "~~" は装飾へ変換しない
            } else {
                const strikeText = this.rawSlice(rawText, strikeStart + 2, strikeClosingStart);
                const beforeText = this.rawSlice(rawText, 0, strikeStart);
                const afterText = this.rawSlice(rawText, normalizedCursorOffset);

                const fragment = document.createDocumentFragment();

                if (beforeText) {
                    fragment.appendChild(document.createTextNode(beforeText));
                }

                const del = document.createElement('del');
                del.textContent = strikeText;
                fragment.appendChild(del);

                const spacerText = trailingSpace !== '' ? trailingSpace : ' ';
                const spacerNode = document.createTextNode(spacerText);
                fragment.appendChild(spacerNode);

                if (afterText) {
                    fragment.appendChild(document.createTextNode(afterText));
                }

                textNode.parentNode.replaceChild(fragment, textNode);

                // 取り消し線テキストの後にカーソルを設定
                const newRange = document.createRange();
                newRange.setStart(spacerNode, spacerNode.textContent.length);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                if (notifyCallback) notifyCallback();
                return true;
            }
        }

        // インラインコード構文をチェック `code`
        // カーソル位置基準で判定し、既存テキストの途中入力（例: aa`bb`cc）も変換対象にする
        const codeMatch = beforeCursorText.match(/`([^`]+)`$/);
        const parentIsCode = textNode.parentNode && textNode.parentNode.tagName === 'CODE';

        if (codeMatch && !parentIsCode) {
            const matchedText = codeMatch[0];
            const codeStart = beforeCursorText.length - matchedText.length;
            const beforeText = this.rawSlice(rawText, 0, codeStart);
            // Code keeps its spaces as ordinary spaces, not no-break spaces.
            const codeText = this.rawSlice(rawText, codeStart + 1, beforeCursorText.length - 1)
                .replace(/ /g, ' ');
            const afterText = this.rawSlice(rawText, normalizedCursorOffset);

            const parent = textNode.parentElement;
            const fragment = document.createDocumentFragment();

            if (beforeText) {
                fragment.appendChild(document.createTextNode(beforeText));
            }

            const code = document.createElement('code');
            code.textContent = codeText;
            fragment.appendChild(code);

            const spacer = document.createTextNode('');
            fragment.appendChild(spacer);

            if (afterText) {
                fragment.appendChild(document.createTextNode(afterText));
            }

            // テキストノードをフラグメントで置き換え
            const parentNode = textNode.parentNode;
            parentNode.replaceChild(fragment, textNode);

            const newRange = document.createRange();
            newRange.setStart(spacer, 0);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);

            if (notifyCallback) notifyCallback();
            return true;
        }

        // 水平線構文をチェック --- (3つ以上のハイフンのみ)
        const hrMatch = normalizedText.match(/^-{3,}$/);
        // An <hr> cannot live inside a list item or heading; there "---" stays text.
        if (!isInTableCell && !isInListItem && !isInHeading && hrMatch && blockMarkerTyped(/^-{3,}$/)) {
            const hr = document.createElement('hr');

            this.replaceLineWithBlock(textNode, hr);

            // 水平線の後に新しい段落を作成してカーソルを移動
            const newParagraph = document.createElement('p');
            newParagraph.appendChild(document.createElement('br'));
            if (hr.nextSibling) {
                hr.parentNode.insertBefore(newParagraph, hr.nextSibling);
            } else {
                hr.parentNode.appendChild(newParagraph);
            }

            const newRange = document.createRange();
            newRange.setStart(newParagraph, 0);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);

            if (notifyCallback) notifyCallback();
            return true;
        }

        // 順序なしリスト構文をチェック - item / - [ ] task
        const ulMatch = normalizedText.match(/^\s*[-*]\s+(.*)$/);
        if (
            !isInTableCell &&
            !isInHeading &&
            ulMatch &&
            blockMarkerTyped(/^\s*[-*]\s+(?:\[( |x|X)\]\s*)?$/, { requireBlockStart: isInListItem })
        ) {
            const rawContent = ulMatch[1] ?? '';
            const content = rawContent.trim() === '' ? '' : rawContent;
            const taskMatch = rawContent.match(/^\[( |x|X)\](.*)$/);
            const isTaskItem = !!(
                taskMatch &&
                (taskMatch[2] === '' || /^[ \u00A0]/.test(taskMatch[2] || ''))
            );
            const taskChecked = !!(isTaskItem && taskMatch[1].toLowerCase() === 'x');
            const taskText = isTaskItem
                ? (taskMatch[2] || '').replace(/^[ \u00A0]/, '')
                : '';
            const listText = isTaskItem ? taskText : content;

            const li = document.createElement('li');
            let textContentNode = null;
            if (isTaskItem) {
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                if (taskChecked) {
                    checkbox.checked = true;
                    checkbox.setAttribute('checked', '');
                }
                li.appendChild(checkbox);
                textContentNode = document.createTextNode(listText === '' ? '' : listText);
                li.appendChild(textContentNode);
            } else if (content) {
                li.textContent = content;
                textContentNode = li.firstChild;
            } else {
                textContentNode = document.createTextNode('');
                li.appendChild(textContentNode);
            }

            const parent = textNode.parentElement;
            let ul = this.domUtils.getParentElement(textNode, 'UL');

            if (!ul) {
                // OLの中にいる場合、リストタイプを変換する（ネストしない）
                const existingOl = this.domUtils.getParentElement(textNode, 'OL');
                if (existingOl && parent && parent.tagName === 'LI') {
                    const currentLi = parent;
                    ul = document.createElement('ul');

                    const siblings = Array.from(existingOl.children);
                    const index = siblings.indexOf(currentLi);

                    existingOl.after(ul);

                    // 現在のLIの後ろにある兄弟要素を新しいOLに移動
                    const siblingsAfter = siblings.slice(index + 1);
                    if (siblingsAfter.length > 0) {
                        const newOl = document.createElement('ol');
                        siblingsAfter.forEach(s => newOl.appendChild(s));
                        ul.after(newOl);
                    }

                    this.moveContentAfter(textNode, li);
                    currentLi.remove();
                    ul.appendChild(li);

                    if (existingOl.children.length === 0) {
                        existingOl.remove();
                    }
                } else {
                    ul = document.createElement('ul');
                    this.replaceLineWithBlock(textNode, ul);
                    ul.appendChild(li);
                }
            } else {
                if (parent && parent.tagName === 'LI') {
                    textContentNode = this.stripItemStartMarker(textNode, listText, isTaskItem, taskChecked);
                } else {
                    textNode.parentNode.replaceChild(li, textNode);
                }
            }

            // 隣接する同タイプのリストをマージ
            this.mergeAdjacentLists(ul);

            // カーソル位置を復元
            const newRange = document.createRange();
            if (textContentNode) {
                const markerLength = ulMatch[0].length - listText.length;
                const newOffset = Math.min(listText.length, Math.max(0, normalizedCursorOffset - markerLength));
                newRange.setStart(textContentNode, isTaskItem && listText.length === 0 ? 0 : newOffset);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
            }

            if (notifyCallback) notifyCallback();
            return true;
        }

        // 順序付きリスト構文をチェック 1. item
        const olMatch = normalizedText.match(/^\s*\d+\.\s+(.*)$/);
        if (
            !isInTableCell &&
            !isInHeading &&
            olMatch &&
            blockMarkerTyped(/^\s*\d+\.\s+$/, { requireBlockStart: isInListItem })
        ) {
            const rawContent = olMatch[1] ?? '';
            const content = rawContent.trim() === '' ? '' : rawContent;

            const li = document.createElement('li');
            let textContentNode = null;
            if (content) {
                li.textContent = content;
                textContentNode = li.firstChild;
            } else {
                textContentNode = document.createTextNode('');
                li.appendChild(textContentNode);
            }

            const parent = textNode.parentElement;
            let ol = this.domUtils.getParentElement(textNode, 'OL');

            if (!ol) {
                // ULの中にいる場合、リストタイプを変換する（ネストしない）
                const existingUl = this.domUtils.getParentElement(textNode, 'UL');
                if (existingUl && parent && parent.tagName === 'LI') {
                    const currentLi = parent;
                    ol = document.createElement('ol');

                    const siblings = Array.from(existingUl.children);
                    const index = siblings.indexOf(currentLi);

                    existingUl.after(ol);

                    // 現在のLIの後ろにある兄弟要素を新しいULに移動
                    const siblingsAfter = siblings.slice(index + 1);
                    if (siblingsAfter.length > 0) {
                        const newUl = document.createElement('ul');
                        siblingsAfter.forEach(s => newUl.appendChild(s));
                        ol.after(newUl);
                    }

                    this.moveContentAfter(textNode, li);
                    currentLi.remove();
                    ol.appendChild(li);

                    if (existingUl.children.length === 0) {
                        existingUl.remove();
                    }
                } else {
                    ol = document.createElement('ol');
                    this.replaceLineWithBlock(textNode, ol);
                    ol.appendChild(li);
                }
            } else {
                if (parent && parent.tagName === 'LI') {
                    textContentNode = this.stripItemStartMarker(textNode, content);
                } else {
                    textNode.parentNode.replaceChild(li, textNode);
                }
            }

            // 隣接する同タイプのリストをマージ
            this.mergeAdjacentLists(ol);

            // カーソル位置を復元
            const newRange = document.createRange();
            if (textContentNode) {
                const markerLength = olMatch[0].length - content.length;
                const newOffset = Math.min(content.length, Math.max(0, normalizedCursorOffset - markerLength));
                newRange.setStart(textContentNode, newOffset);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
            }

            if (notifyCallback) notifyCallback();
            return true;
        }

        // 引用構文をチェック > text（テキストが必要）
        const blockquoteMatch = normalizedText.match(/^\s*>\s+(.+)$/);
        if (!isInTableCell && !isInListItem && blockquoteMatch && blockMarkerTyped(/^\s*>\s+$/)) {
            const content = blockquoteMatch[1];

            const blockquote = document.createElement('blockquote');
            const p = document.createElement('p');
            p.textContent = content;
            const textContentNode = p.firstChild;
            blockquote.appendChild(p);

            this.replaceLineWithBlock(textNode, blockquote);

            // カーソル位置を復元
            const newRange = document.createRange();
            if (textContentNode) {
                const markerLength = blockquoteMatch[0].length - content.length;
                const newOffset = Math.min(content.length, Math.max(0, normalizedCursorOffset - markerLength));
                newRange.setStart(textContentNode, newOffset);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);
            }

            if (notifyCallback) notifyCallback();
            return true;
        }

        // URL自動リンク化をチェック（URLの後にスペースで確定）
        const textBeforeCursor = normalizedText.slice(0, normalizedCursorOffset);

        // Markdown画像構文をチェック ![alt](src)
        const markdownImageMatch = textBeforeCursor.match(/!\[([^\]\n]*)\]\(([^)\n]+)\)$/);
        if (markdownImageMatch) {
            const matchIndex = markdownImageMatch.index ?? -1;
            const isEscapedImageSyntax = this.isEscapedAt(textBeforeCursor, matchIndex);
            if (!isEscapedImageSyntax) {
                const alt = (markdownImageMatch[1] || '')
                    .replace(/\\\]/g, ']')
                    .replace(/\\\[/g, '[');
                const rawTarget = (markdownImageMatch[2] || '').trim();
                const targetMatch = rawTarget.match(/^(<[^>]+>|[^\s]+)(?:\s+["'][^"']*["'])?$/);
                let src = targetMatch ? targetMatch[1] : '';
                if (src && src.startsWith('<') && src.endsWith('>')) {
                    src = src.slice(1, -1);
                }
                src = (src || '')
                    .replace(/\\\)/g, ')')
                    .replace(/\\\(/g, '(')
                    .trim();

                if (src !== '') {
                    const beforeImage = normalizedText.slice(0, matchIndex);
                    const afterCursorText = normalizedText.slice(normalizedCursorOffset);

                    // コード内にいる場合はスキップ
                    const parentIsCode = textNode.parentNode && textNode.parentNode.tagName === 'CODE';
                    if (!parentIsCode) {
                        const fragment = document.createDocumentFragment();

                        if (beforeImage) {
                            fragment.appendChild(document.createTextNode(beforeImage));
                        }

                        const image = document.createElement('img');
                        image.setAttribute('alt', alt);
                        if (this.applyImageSourcePolicy) {
                            image.setAttribute('data-md-path', src);
                            this.applyImageSourcePolicy(image, src, { markdownPath: src });
                        } else {
                            image.setAttribute('src', src);
                        }
                        fragment.appendChild(image);

                        let trailingTextNode = null;
                        if (afterCursorText) {
                            trailingTextNode = document.createTextNode(afterCursorText);
                            fragment.appendChild(trailingTextNode);
                        }

                        textNode.parentNode.replaceChild(fragment, textNode);

                        // カーソルを画像の直後（後続テキストがあればその先頭）へ設定
                        const newRange = document.createRange();
                        if (trailingTextNode) {
                            newRange.setStart(trailingTextNode, 0);
                        } else {
                            newRange.setStartAfter(image);
                        }
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);

                        if (notifyCallback) notifyCallback();
                        return true;
                    }
                }
            }
        }

        // Markdownリンク構文をチェック [text](url)
        const markdownLinkMatch = textBeforeCursor.match(/\[([^\]\n]+)\]\(([^)\n]+)\)$/);
        if (markdownLinkMatch) {
            const matchIndex = markdownLinkMatch.index ?? -1;
            const isImageSyntax = matchIndex > 0 && textBeforeCursor[matchIndex - 1] === '!';
            const isEscapedLinkSyntax = this.isEscapedAt(textBeforeCursor, matchIndex);
            if (!isImageSyntax && !isEscapedLinkSyntax) {
                const label = (markdownLinkMatch[1] || '')
                    .replace(/\\\]/g, ']')
                    .replace(/\\\[/g, '[');
                const rawTarget = (markdownLinkMatch[2] || '').trim();
                const targetMatch = rawTarget.match(/^(<[^>]+>|[^\s]+)(?:\s+["'][^"']*["'])?$/);
                let href = targetMatch ? targetMatch[1] : '';
                if (href && href.startsWith('<') && href.endsWith('>')) {
                    href = href.slice(1, -1);
                }
                href = (href || '')
                    .replace(/\\\)/g, ')')
                    .replace(/\\\(/g, '(')
                    .trim();

                if (label !== '' && href !== '') {
                    const beforeLink = normalizedText.slice(0, matchIndex);
                    const afterCursorText = normalizedText.slice(normalizedCursorOffset);

                    // 既にリンク内またはコード内にいる場合はスキップ
                    const parentLink = textNode.parentElement && textNode.parentElement.closest
                        ? textNode.parentElement.closest('a')
                        : null;
                    const parentIsCode = textNode.parentNode && textNode.parentNode.tagName === 'CODE';
                    if (!parentLink && !parentIsCode) {
                        const fragment = document.createDocumentFragment();

                        if (beforeLink) {
                            fragment.appendChild(document.createTextNode(beforeLink));
                        }

                        const link = document.createElement('a');
                        link.setAttribute('href', href);
                        link.textContent = label;
                        fragment.appendChild(link);

                        let trailingTextNode = null;
                        if (afterCursorText) {
                            trailingTextNode = document.createTextNode(afterCursorText);
                            fragment.appendChild(trailingTextNode);
                        }

                        textNode.parentNode.replaceChild(fragment, textNode);

                        // カーソルをリンクの直後（後続テキストがあればその先頭）へ設定
                        const newRange = document.createRange();
                        if (trailingTextNode) {
                            newRange.setStart(trailingTextNode, 0);
                        } else {
                            newRange.setStartAfter(link);
                        }
                        newRange.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(newRange);

                        if (notifyCallback) notifyCallback();
                        return true;
                    }
                }
            }
        }

        const urlAutoLinkMatch = textBeforeCursor.match(/(https?:\/\/[^\s]+)\s$/);
        if (urlAutoLinkMatch) {
            const url = urlAutoLinkMatch[1];
            const matchIndex = urlAutoLinkMatch.index;
            const beforeUrl = normalizedText.slice(0, matchIndex);
            const afterCursorText = normalizedText.slice(normalizedCursorOffset);

            // 既にリンク内またはコード内にいる場合はスキップ
            const parentLink = textNode.parentElement && textNode.parentElement.closest
                ? textNode.parentElement.closest('a')
                : null;
            const parentIsCode = textNode.parentNode && textNode.parentNode.tagName === 'CODE';
            if (!parentLink && !parentIsCode) {
                const fragment = document.createDocumentFragment();

                if (beforeUrl) {
                    fragment.appendChild(document.createTextNode(beforeUrl));
                }

                const link = document.createElement('a');
                link.href = url;
                link.textContent = url;
                fragment.appendChild(link);

                // スペースを追加
                const spacerNode = document.createTextNode(' ');
                fragment.appendChild(spacerNode);

                if (afterCursorText) {
                    fragment.appendChild(document.createTextNode(afterCursorText));
                }

                textNode.parentNode.replaceChild(fragment, textNode);

                // カーソルをスペースの後に設定
                const newRange = document.createRange();
                newRange.setStart(spacerNode, 1);
                newRange.collapse(true);
                selection.removeAllRanges();
                selection.addRange(newRange);

                if (notifyCallback) notifyCallback();
                return true;
            }
        }

        // 変換が実行されなかった
        return false;
    }
}

// Made with Bob
