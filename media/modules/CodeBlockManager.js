// @ts-nocheck
/**
 * コードブロック管理モジュール
 * コードブロックのシンタックスハイライト、言語選択、コピー機能を提供
 */

export class CodeBlockManager {
    constructor(editor, cursorManager = null, vscodeApi = null) {
        this.editor = editor;
        this.cursorManager = cursorManager;
        this.vscode = vscodeApi;
        this.SUPPORTED_LANGUAGES = [
            'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'csharp',
            'php', 'ruby', 'go', 'rust', 'swift', 'kotlin', 'scala',
            'html', 'css', 'scss', 'sass', 'less',
            'json', 'xml', 'yaml', 'toml',
            'markdown', 'latex', 'mermaid',
            'sql', 'graphql',
            'bash', 'shell', 'powershell',
            'dockerfile', 'makefile',
            'r', 'matlab', 'julia',
            'perl', 'lua', 'haskell', 'elixir', 'erlang',
            'clojure', 'scheme', 'lisp',
            'dart', 'objectivec',
            'plaintext', 'text'
        ].sort((a, b) => {
            const aLower = a.toLowerCase();
            const bLower = b.toLowerCase();
            if (aLower === 'plaintext' && bLower !== 'plaintext') return -1;
            if (bLower === 'plaintext' && aLower !== 'plaintext') return 1;
            return aLower.localeCompare(bLower);
        });

        this._isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        this.mermaidInitialized = false;
        this.mermaidRenderHandles = new WeakMap();
        this.mermaidRenderTokens = new WeakMap();
        this.mermaidCache = new WeakMap();
        this.mermaidIdCounter = 0;
        this._initMermaid();
    }

    _getTrailingNewlineCount(text) {
        if (!text) {
            return 0;
        }
        let count = 0;
        for (let i = text.length - 1; i >= 0 && text[i] === '\n'; i--) {
            count++;
        }
        return count;
    }

    _ensureTrailingNewlines(codeBlock, trailingNewlines) {
        if (!codeBlock || trailingNewlines <= 0) {
            return;
        }
        const currentText = codeBlock.textContent || '';
        let currentCount = 0;
        for (let i = currentText.length - 1; i >= 0 && currentText[i] === '\n'; i--) {
            currentCount++;
        }
        const missing = trailingNewlines - currentCount;
        if (missing > 0) {
            codeBlock.appendChild(document.createTextNode('\n'.repeat(missing)));
        }
    }

    _initMermaid() {
        if (this.mermaidInitialized) {
            return;
        }
        if (typeof window === 'undefined' || !window.mermaid) {
            return;
        }
        try {
            window.mermaid.initialize({
                startOnLoad: false,
                securityLevel: 'strict',
                theme: 'base',
                themeVariables: {
                    fontFamily: 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif)',
                    fontSize: '13px',
                    background: '#ffffff',
                    primaryColor: '#ffffff',
                    primaryBorderColor: '#444444',
                    primaryTextColor: '#111111',
                    lineColor: '#444444',
                    secondaryColor: '#ffffff',
                    tertiaryColor: '#ffffff'
                }
            });
            this.mermaidInitialized = true;
        } catch (error) {
            console.error('Failed to initialize Mermaid:', error);
        }
    }

    _isMermaidLanguage(language) {
        return (language || '').toLowerCase() === 'mermaid';
    }

    _getMermaidCode(codeBlock) {
        if (!codeBlock) {
            return '';
        }
        return (codeBlock.textContent || '').replace(/\u200B/g, '');
    }

    _ensureMermaidPreview(pre) {
        if (!pre) {
            return null;
        }
        let preview = pre.querySelector('.mermaid-preview');
        if (!preview) {
            preview = document.createElement('div');
            preview.className = 'mermaid-preview';
            preview.contentEditable = 'false';
            preview.setAttribute('data-exclude-from-markdown', 'true');
            pre.appendChild(preview);
        }
        return preview;
    }

    _clearMermaidPreview(pre) {
        if (!pre) {
            return;
        }
        const preview = pre.querySelector('.mermaid-preview');
        if (preview) {
            preview.remove();
        }
        this.mermaidCache.delete(pre);
        this.mermaidRenderTokens.delete(pre);
    }

    _scheduleMermaidRender(pre, codeBlock, immediate = false) {
        if (!pre || !codeBlock) {
            return;
        }
        if (immediate) {
            this._renderMermaid(pre, codeBlock);
            return;
        }
        const existingHandle = this.mermaidRenderHandles.get(pre);
        if (existingHandle) {
            clearTimeout(existingHandle);
        }
        const handle = setTimeout(() => {
            this._renderMermaid(pre, codeBlock);
        }, 150);
        this.mermaidRenderHandles.set(pre, handle);
    }

    _applyMermaidSvg(preview, svg, bindFunctions) {
        if (!preview) {
            return;
        }
        preview.classList.remove('mermaid-error');
        preview.innerHTML = svg;
        if (typeof bindFunctions === 'function') {
            try {
                bindFunctions(preview);
            } catch (error) {
                console.warn('Mermaid bindFunctions failed:', error);
            }
        }
    }

    _renderMermaid(pre, codeBlock) {
        this._initMermaid();
        if (typeof window === 'undefined' || !window.mermaid) {
            const preview = this._ensureMermaidPreview(pre);
            preview.classList.add('mermaid-error');
            preview.textContent = 'Mermaid library is not available.';
            return;
        }

        const code = this._getMermaidCode(codeBlock);
        if (code.trim() === '') {
            this._clearMermaidPreview(pre);
            return;
        }

        const cached = this.mermaidCache.get(pre);
        if (cached && cached.code === code && cached.svg) {
            const preview = this._ensureMermaidPreview(pre);
            this._applyMermaidSvg(preview, cached.svg, null);
            return;
        }

        const token = Symbol('mermaid-render');
        this.mermaidRenderTokens.set(pre, token);

        const renderId = `mermaid-${++this.mermaidIdCounter}`;
        let result;
        try {
            result = window.mermaid.render(renderId, code);
        } catch (error) {
            const preview = this._ensureMermaidPreview(pre);
            preview.classList.add('mermaid-error');
            preview.textContent = `Mermaid render error: ${error.message || error}`;
            return;
        }

        const applyResult = (svg, bindFunctions) => {
            if (this.mermaidRenderTokens.get(pre) !== token) {
                return;
            }
            const preview = this._ensureMermaidPreview(pre);
            this._applyMermaidSvg(preview, svg, bindFunctions);
            this.mermaidCache.set(pre, { code, svg });
        };

        if (typeof result === 'string') {
            applyResult(result, null);
        } else if (result && typeof result.then === 'function') {
            result.then((payload) => {
                if (!payload) {
                    throw new Error('Mermaid render returned empty result');
                }
                const svg = payload.svg || payload;
                applyResult(svg, payload.bindFunctions);
            }).catch((error) => {
                if (this.mermaidRenderTokens.get(pre) !== token) {
                    return;
                }
                const preview = this._ensureMermaidPreview(pre);
                preview.classList.add('mermaid-error');
                preview.textContent = `Mermaid render error: ${error.message || error}`;
            });
        } else if (result && result.svg) {
            applyResult(result.svg, result.bindFunctions);
        } else {
            const preview = this._ensureMermaidPreview(pre);
            preview.classList.add('mermaid-error');
            preview.textContent = 'Mermaid render error: unexpected result.';
        }
    }


    _getSvgSize(svgText) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(svgText, 'image/svg+xml');
            const svg = doc.documentElement;
            let width = parseFloat(svg.getAttribute('width') || '');
            let height = parseFloat(svg.getAttribute('height') || '');
            if ((!width || !height) && svg.hasAttribute('viewBox')) {
                const viewBox = svg.getAttribute('viewBox').split(/\s+/).map(value => parseFloat(value));
                if (viewBox.length === 4) {
                    width = width || viewBox[2];
                    height = height || viewBox[3];
                }
            }
            if (!width || !height) {
                width = 800;
                height = 600;
            }
            return { width, height };
        } catch (error) {
            return { width: 800, height: 600 };
        }
    }

    _prepareMermaidSvgForExport(svgText) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(svgText, 'image/svg+xml');
            const svg = doc.documentElement;

            const widthAttr = svg.getAttribute('width') || '';
            const heightAttr = svg.getAttribute('height') || '';
            const isPercent = (value) => value && value.trim().endsWith('%');

            let width = parseFloat(widthAttr);
            let height = parseFloat(heightAttr);

            if (!width || !height || isPercent(widthAttr) || isPercent(heightAttr)) {
                if (svg.hasAttribute('viewBox')) {
                    const viewBox = svg.getAttribute('viewBox').split(/\s+/).map(value => parseFloat(value));
                    if (viewBox.length === 4) {
                        width = viewBox[2];
                        height = viewBox[3];
                    }
                }
            }

            if (!width || !height) {
                width = 800;
                height = 600;
            }

            svg.setAttribute('width', String(width));
            svg.setAttribute('height', String(height));
            if (!svg.getAttribute('preserveAspectRatio')) {
                svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            }

            const serialized = new XMLSerializer().serializeToString(svg);
            return { svgText: serialized, width, height };
        } catch (error) {
            const fallbackSize = this._getSvgSize(svgText);
            return { svgText, width: fallbackSize.width, height: fallbackSize.height };
        }
    }

    _downloadDataUrl(dataUrl, filename) {
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    _saveMermaidImage(dataUrl, mimeType, filename) {
        if (this.vscode && typeof this.vscode.postMessage === 'function') {
            this.vscode.postMessage({
                type: 'saveImage',
                dataUrl,
                mimeType,
                insert: false,
                source: 'mermaid'
            });
            return;
        }
        this._downloadDataUrl(dataUrl, filename);
    }

    _exportMermaidSvg(pre, filename) {
        const cached = this.mermaidCache.get(pre);
        if (!cached || !cached.svg) {
            console.warn('No mermaid SVG available for export');
            return;
        }
        const prepared = this._prepareMermaidSvgForExport(cached.svg);
        const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(prepared.svgText)}`;
        this._saveMermaidImage(svgDataUrl, 'image/svg+xml', filename);
    }

    _exportMermaidPng(pre, filename) {
        const cached = this.mermaidCache.get(pre);
        if (!cached || !cached.svg) {
            console.warn('No mermaid SVG available for export');
            return;
        }
        const prepared = this._prepareMermaidSvgForExport(cached.svg);
        const { width, height, svgText } = prepared;
        const img = new Image();
        img.onload = () => {
            const ratio = window.devicePixelRatio || 1;
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.floor(width * ratio));
            canvas.height = Math.max(1, Math.floor(height * ratio));
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                console.warn('Failed to get canvas context for PNG export');
                return;
            }
            ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);
            const pngDataUrl = canvas.toDataURL('image/png');
            this._saveMermaidImage(pngDataUrl, 'image/png', filename);
        };
        img.onerror = () => {
            console.warn('Failed to load SVG for PNG export, falling back to SVG download');
            this._exportMermaidSvg(pre, filename.replace(/\.png$/i, '.svg'));
        };
        const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
        img.src = svgDataUrl;
    }

    /**
     * すべてのコードブロックをハイライト
     */
    highlightCodeBlocks() {
        const prismAvailable = typeof Prism !== 'undefined';
        if (!prismAvailable) {
            console.error('Prism is not defined');
        }
        
        const codeBlocks = this.editor.querySelectorAll('pre code');
        
        codeBlocks.forEach((block) => {
            const pre = block.parentElement;
            
            // クラスから言語名を抽出
            const match = block.className.match(/language-(\w+)/);
            
            if (match) {
                const language = match[1];

                if (this._isMermaidLanguage(language)) {
                    block.textContent = this._getMermaidCode(block);
                    this.addCodeBlockControls(pre, language);
                    this._scheduleMermaidRender(pre, block, true);
                    return;
                }
                
                // 言語の文法を取得
                let grammar = prismAvailable ? Prism.languages[language] : null;
                if (!grammar) {
                    console.warn('Grammar not found for language:', language, 'Available:', prismAvailable ? Object.keys(Prism.languages) : []);
                    this.addCodeBlockControls(pre, language);
                    this._clearMermaidPreview(pre);
                    return;
                }
                
                // プレーンテキストの内容を取得
                const code = block.textContent;
                const trailingNewlines = this._getTrailingNewlineCount(code);
                
                try {
                    // コードをトークン化
                    const tokens = Prism.tokenize(code, grammar);
                    
                    // ハイライトされたHTMLを構築
                    const html = Prism.Token.stringify(Prism.util.encode(tokens), language);
                    
                    // コードブロックの内容を更新
                    block.innerHTML = html;
                    this._ensureTrailingNewlines(block, trailingNewlines);
                    
                    // コントロールを追加
                    this.addCodeBlockControls(pre, language);
                    this._clearMermaidPreview(pre);
                } catch (error) {
                    console.error('Error highlighting code block:', error);
                    this.addCodeBlockControls(pre, language);
                    this._clearMermaidPreview(pre);
                }
            } else {
                // 言語が指定されていない
                this.addCodeBlockControls(pre, '');
                this._clearMermaidPreview(pre);
            }
        });
    }

    /**
     * 単一のコードブロックをハイライト
     * @param {HTMLElement} codeBlock - ハイライトするコードブロック
     */
    highlightSingleCodeBlock(codeBlock) {
        // 言語クラスがない場合はハイライトしない
        const languageMatch = codeBlock.className.match(/language-(\w+)/);
        if (!languageMatch) {
            return;
        }
        
        const language = languageMatch[1];

        if (this._isMermaidLanguage(language)) {
            const preBlock = codeBlock.parentElement;
            if (preBlock) {
                this._scheduleMermaidRender(preBlock, codeBlock);
            }
            return;
        }

        if (typeof Prism === 'undefined') {
            return;
        }
        
        // テキスト内容に対する相対的なカーソル位置を保存
        const selection = window.getSelection();
        let savedOffset = 0;
        let hasFocus = false;
        
        if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            if (codeBlock.contains(range.startContainer)) {
                hasFocus = true;
                let offset = null;
                if (this.cursorManager) {
                    offset = this.cursorManager.getCodeBlockCursorOffset(codeBlock, range);
                }
                if (offset !== null && offset !== undefined) {
                    savedOffset = offset;
                } else {
                    // コードブロックの先頭からの文字オフセットを計算
                    const preRange = document.createRange();
                    preRange.selectNodeContents(codeBlock);
                    preRange.setEnd(range.startContainer, range.startOffset);
                    savedOffset = preRange.toString().length;
                }
            }
        }
        
        // プレーンテキストの内容を取得
        const code = codeBlock.textContent;
        const trailingNewlines = this._getTrailingNewlineCount(code);
        
        // Prismを使用してコードをトークン化
        let grammar = Prism.languages[language];
        if (!grammar) {
            return;
        }
        
        // コードをトークン化
        const tokens = Prism.tokenize(code, grammar);
        
        // ハイライトされたHTMLを構築
        const html = Prism.Token.stringify(Prism.util.encode(tokens), language);
        
        // コードブロックの内容を更新
        codeBlock.innerHTML = html;
        this._ensureTrailingNewlines(codeBlock, trailingNewlines);
        
        // コードブロックにフォーカスがあった場合、カーソル位置を復元
        if (hasFocus) {
            try {
                if (this.cursorManager) {
                    this.cursorManager.setCodeBlockCursorOffset(codeBlock, selection, savedOffset);
                    return;
                }

                // 保存されたオフセットのテキストノードを見つける
                let currentOffset = 0;
                let targetNode = null;
                let targetOffset = 0;
                
                const walker = document.createTreeWalker(
                    codeBlock,
                    NodeFilter.SHOW_TEXT,
                    null
                );
                
                while (walker.nextNode()) {
                    const node = walker.currentNode;
                    const nodeLength = node.textContent.length;
                    
                    if (currentOffset + nodeLength >= savedOffset) {
                        targetNode = node;
                        targetOffset = savedOffset - currentOffset;
                        break;
                    }
                    
                    currentOffset += nodeLength;
                }
                
                // 選択範囲を復元
                if (targetNode) {
                    const newRange = document.createRange();
                    const offset = Math.min(targetOffset, targetNode.textContent.length);
                    newRange.setStart(targetNode, offset);
                    newRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(newRange);
                }
            } catch (e) {
                console.error('Error restoring cursor:', e);
            }
        }
    }

    /**
     * コードブロックに言語ラベルとコピーボタンを追加
     * @param {HTMLElement} pre - pre要素
     * @param {string} language - 言語名
     */
    addCodeBlockControls(pre, language) {
        const isMermaid = this._isMermaidLanguage(language);
        
        // 既存のコントロールを削除
        const existingToolbar = pre.querySelector('.code-block-toolbar');
        if (existingToolbar) {
            const parent = existingToolbar.parentNode;
            if (parent) {
                parent.removeChild(existingToolbar);
            }
        }
        
        if (!isMermaid) {
            this._clearMermaidPreview(pre);
        }

        // ツールバーを作成
        const toolbar = document.createElement('div');
        toolbar.className = 'code-block-toolbar';
        toolbar.contentEditable = 'false';
        toolbar.setAttribute('data-exclude-from-markdown', 'true');
        
        // 言語ラベルを追加（常に作成、空でも）
        const langLabel = document.createElement('span');
        langLabel.className = 'code-block-language';
        langLabel.textContent = language || 'plaintext';
        langLabel.title = 'Click to change language';
        
        // サジェストドロップダウンを作成
        const suggestionBox = document.createElement('div');
        suggestionBox.className = 'language-suggestions';
        suggestionBox.style.display = 'none';
        toolbar.appendChild(suggestionBox);
        
        let selectedIndex = -1;
        let handleInput, handleKeydown, handleKeypress, finishEditing;
        
        // サジェストを表示する関数
        const showSuggestions = (filter) => {
            const filtered = this.SUPPORTED_LANGUAGES.filter(lang =>
                lang.toLowerCase().includes(filter.toLowerCase())
            );
            
            if (filtered.length === 0) {
                suggestionBox.style.display = 'none';
                selectedIndex = -1;
                return;
            }
            
            suggestionBox.innerHTML = '';
            selectedIndex = 0;
            
            filtered.forEach((lang, index) => {
                const item = document.createElement('div');
                item.className = 'language-suggestion-item';
                if (index === 0) {
                    item.classList.add('selected');
                }
                item.textContent = lang;
                
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    // イベントリスナーを削除
                    langLabel.removeEventListener('input', handleInput);
                    langLabel.removeEventListener('keydown', handleKeydown);
                    langLabel.removeEventListener('keypress', handleKeypress);
                    langLabel.removeEventListener('blur', finishEditing);
                    
                    langLabel.textContent = lang;
                    suggestionBox.style.display = 'none';
                    langLabel.classList.remove('editing');
                    langLabel.contentEditable = 'false';
                    
                    // コードブロックの言語を直接更新
                    this.updateCodeBlockLanguage(pre, lang);
                });
                
                item.addEventListener('mouseenter', () => {
                    suggestionBox.querySelectorAll('.language-suggestion-item').forEach(el => {
                        el.classList.remove('selected');
                    });
                    item.classList.add('selected');
                    selectedIndex = index;
                });
                
                suggestionBox.appendChild(item);
            });
            
            suggestionBox.style.display = 'block';
        };
        
        // サジェストを非表示にする関数
        const hideSuggestions = () => {
            suggestionBox.style.display = 'none';
            selectedIndex = -1;
        };
        
        // 言語ラベルをクリックで編集可能にする
        const beginEditing = (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }

            if (langLabel.classList.contains('editing')) {
                return;
            }

            const currentLang = langLabel.textContent;
            langLabel.classList.add('editing');
            langLabel.contentEditable = 'true';
            langLabel.focus();

            // すべてのテキストを選択
            const range = document.createRange();
            range.selectNodeContents(langLabel);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);

            // 最初にすべてのサジェストを表示
            showSuggestions('');

            // 入力を処理してサジェストをフィルタ
            handleInput = () => {
                const text = langLabel.textContent.trim();
                showSuggestions(text);
            };

            const moveCursorToCodeStart = () => {
                const codeBlock = pre.querySelector('code');
                if (!codeBlock) return;
                const selection = window.getSelection();
                if (!selection) return;
                const textNode = document.createTreeWalker(codeBlock, NodeFilter.SHOW_TEXT, null).nextNode();
                const targetNode = textNode || codeBlock;
                const range = document.createRange();
                range.setStart(targetNode, 0);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
            };

            // ブラー（編集終了）を処理
            finishEditing = () => {
                langLabel.classList.remove('editing');
                langLabel.contentEditable = 'false';
                hideSuggestions();

                let newLang = langLabel.textContent.trim().toLowerCase();
                if (!newLang) {
                    newLang = 'plaintext';
                }

                // 言語が変更された場合は更新
                if (newLang !== currentLang.toLowerCase()) {
                    this.updateCodeBlockLanguage(pre, newLang);
                } else {
                    langLabel.textContent = currentLang;
                }
                moveCursorToCodeStart();

                // イベントリスナーを削除
                langLabel.removeEventListener('input', handleInput);
                langLabel.removeEventListener('keydown', handleKeydown);
                langLabel.removeEventListener('keypress', handleKeypress);
            };

            // EnterとEscapeキーを処理
            handleKeydown = (e) => {
                const suggestions = suggestionBox.querySelectorAll('.language-suggestion-item');
                const hasSuggestions = suggestions.length > 0;
                const moveSelection = (delta) => {
                    if (!hasSuggestions) return;
                    selectedIndex = (selectedIndex + delta + suggestions.length) % suggestions.length;
                    suggestions.forEach((item, idx) => {
                        item.classList.toggle('selected', idx === selectedIndex);
                    });
                    suggestions[selectedIndex].scrollIntoView({ block: 'nearest' });
                };
                
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    e.stopPropagation();
                    moveSelection(1);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    e.stopPropagation();
                    moveSelection(-1);
                } else if (e.key === 'Tab') {
                    e.preventDefault();
                    e.stopPropagation();
                    const delta = e.shiftKey ? -1 : 1;
                    moveSelection(delta);
                } else if (this._isMac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
                    e.preventDefault();
                    e.stopPropagation();
                    moveSelection(1);
                } else if (this._isMac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
                    e.preventDefault();
                    e.stopPropagation();
                    moveSelection(-1);
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (selectedIndex >= 0 && suggestions[selectedIndex]) {
                        const selectedLang = suggestions[selectedIndex].textContent;
                        
                        // イベントリスナーを削除
                        langLabel.removeEventListener('input', handleInput);
                        langLabel.removeEventListener('keydown', handleKeydown);
                        langLabel.removeEventListener('keypress', handleKeypress);
                        langLabel.removeEventListener('blur', finishEditing);
                        
                        // UIを即座に更新 - 最初に編集を無効化
                        langLabel.classList.remove('editing');
                        langLabel.contentEditable = 'false';
                        hideSuggestions();
                        langLabel.textContent = selectedLang;
                        
                        // コードブロックの言語を更新
                        this.updateCodeBlockLanguage(pre, selectedLang);

                        // カーソルをコードブロック先頭へ移動
                        moveCursorToCodeStart();
                    } else {
                        langLabel.blur();
                    }
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    langLabel.textContent = currentLang;
                    hideSuggestions();
                    langLabel.blur();
                }
            };
            
            // Enterで改行を作成しないようにする
            handleKeypress = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                }
            };
            
            langLabel.addEventListener('input', handleInput);
            langLabel.addEventListener('blur', finishEditing, { once: true });
            langLabel.addEventListener('keydown', handleKeydown);
            langLabel.addEventListener('keypress', handleKeypress);
        };

        langLabel.__startEditing = beginEditing;

        langLabel.addEventListener('click', (e) => {
            beginEditing(e);
        });
        
        toolbar.appendChild(langLabel);

        const actionGroup = document.createElement('div');
        actionGroup.className = 'code-block-actions';
        
        // コピーボタンを追加
        const copyBtn = document.createElement('button');
        copyBtn.className = 'code-block-copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.title = 'Copy code to clipboard';
        copyBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            const code = pre.querySelector('code');
            if (code) {
                const text = code.textContent;
                navigator.clipboard.writeText(text).then(() => {
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => {
                        copyBtn.textContent = 'Copy';
                    }, 2000);
                }).catch(err => {
                    console.error('Failed to copy:', err);
                    copyBtn.textContent = 'Failed';
                    setTimeout(() => {
                        copyBtn.textContent = 'Copy';
                    }, 2000);
                });
            }
        });
        actionGroup.appendChild(copyBtn);

        if (isMermaid) {
            const exportSvgBtn = document.createElement('button');
            exportSvgBtn.className = 'code-block-export-btn';
            exportSvgBtn.textContent = 'SVG';
            exportSvgBtn.title = 'Save Mermaid diagram as SVG';
            exportSvgBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._exportMermaidSvg(pre, 'mermaid-diagram.svg');
            });
            actionGroup.appendChild(exportSvgBtn);

            const exportPngBtn = document.createElement('button');
            exportPngBtn.className = 'code-block-export-btn';
            exportPngBtn.textContent = 'PNG';
            exportPngBtn.title = 'Save Mermaid diagram as PNG';
            exportPngBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._exportMermaidPng(pre, 'mermaid-diagram.png');
            });
            actionGroup.appendChild(exportPngBtn);
        }

        toolbar.appendChild(actionGroup);
        
        // ツールバーをpreの先頭に挿入
        pre.insertBefore(toolbar, pre.firstChild);

        if (isMermaid) {
            const code = pre.querySelector('code');
            if (code) {
                this._scheduleMermaidRender(pre, code, true);
            }
        }
    }

    /**
     * コードブロックの言語を更新して再ハイライト
     * @param {HTMLElement} pre - pre要素
     * @param {string} newLang - 新しい言語名
     */
    updateCodeBlockLanguage(pre, newLang) {
        const code = pre.querySelector('code');
        if (!code) return;

        const isMermaid = this._isMermaidLanguage(newLang);
        
        // 古い言語クラスを削除
        const oldClasses = Array.from(code.classList).filter(cls => cls.startsWith('language-'));
        oldClasses.forEach(cls => code.classList.remove(cls));
        
        // 新しい言語クラスを追加
        if (newLang && newLang !== 'plaintext') {
            code.className = `language-${newLang}`;
        } else {
            code.className = '';
        }
        
        // コードブロックを再ハイライト
        if (typeof Prism !== 'undefined' && newLang && newLang !== 'plaintext' && !isMermaid) {
            const trailingNewlines = this._getTrailingNewlineCount(code.textContent);
            Prism.highlightElement(code);
            this._ensureTrailingNewlines(code, trailingNewlines);
        }
        
        // 新しい言語でツールバーを更新
        this.addCodeBlockControls(pre, newLang);
    }
}

// Made with Bob
