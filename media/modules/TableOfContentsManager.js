// @ts-nocheck
/**
 * 目次管理モジュール
 * 目次の表示、更新、ナビゲーション機能を提供
 */

export class TableOfContentsManager {
    constructor(editor, tocContainer, tocContent, tocEmpty, options = {}) {
        this.editor = editor;
        this.tocContainer = tocContainer;
        this.tocContent = tocContent;
        this.tocEmpty = tocEmpty;
        this.tocUpdateTimeout = null;
        this.enabled = options.enabled !== false;
        this.observer = null;
        this.headings = [];
        this.tocItems = [];
        this.headingTops = [];
        this.activeIndex = -1;
        this.scrollRaf = null;
        this.onScroll = null;
        this.activeOffset = 12;
        this.scrollAnimationRaf = null;
        this.revealRaf = null;
        this.scrollDuration = this.normalizeScrollDuration(options.scrollDuration);
    }

    /**
     * 目次機能をセットアップ
     */
    setup() {
        this.setTocVisibleState(false);

        // エディタの変更時に目次を更新
        const updateTOCDebounced = () => {
            if (this.tocUpdateTimeout) {
                clearTimeout(this.tocUpdateTimeout);
            }
            this.tocUpdateTimeout = setTimeout(() => {
                this.update();
            }, 300);
        };

        // エディタの変更を監視
        this.observer = new MutationObserver(updateTOCDebounced);
        this.observer.observe(this.editor, {
            childList: true,
            subtree: true,
            characterData: true
        });

        if (!this.onScroll) {
            this.onScroll = () => {
                if (!this.enabled || this.headings.length === 0) return;
                if (this.scrollRaf) return;
                this.scrollRaf = requestAnimationFrame(() => {
                    this.scrollRaf = null;
                    this.updateActiveFromScroll();
                });
            };
        }
        this.editor.addEventListener('scroll', this.onScroll, { passive: true });

        if (!this.enabled) {
            this.hide();
            return;
        }

        this.tocContainer.classList.add('hidden');
        this.update();
    }

    /**
     * 目次の有効/無効を切り替える
     * @param {boolean} enabled - 有効にするかどうか
     */
    setEnabled(enabled) {
        const nextEnabled = Boolean(enabled);
        if (this.enabled === nextEnabled) return;
        this.enabled = nextEnabled;
        if (!this.enabled) {
            this.hide();
            return;
        }
        this.update();
    }

    setScrollDuration(duration) {
        this.scrollDuration = this.normalizeScrollDuration(duration);
    }

    /**
     * 目次を非表示にする
     */
    hide() {
        this.cancelPendingReveal();
        this.tocContainer.classList.add('hidden');
        this.setTocVisibleState(false);
        this.cancelScrollAnimation();
        this.clearActive();
    }

    /**
     * 目次を更新
     */
    update() {
        this.cancelPendingReveal();

        if (!this.enabled) {
            this.hide();
            return;
        }

        const headings = this.editor.querySelectorAll('h1, h2, h3, h4, h5, h6');
        
        if (headings.length === 0) {
            this.tocContent.innerHTML = '<div id="toc-empty">No headings yet</div>';
            this.tocContainer.classList.add('no-headings');
            this.tocContainer.classList.add('hidden');
            this.setTocVisibleState(false);
            this.headings = [];
            this.tocItems = [];
            this.headingTops = [];
            this.clearActive();
            return;
        }

        // 見出しがある場合は目次を表示
        const wasHidden = this.tocContainer.classList.contains('hidden');
        this.tocContainer.classList.remove('no-headings');
        if (!wasHidden) {
            this.tocContainer.classList.remove('hidden');
            this.setTocVisibleState(true);
        }

        this.tocContent.innerHTML = '';
        this.clearActive();
        this.headings = [];
        this.tocItems = [];
        this.headingTops = [];
        
        headings.forEach((heading, index) => {
            const level = parseInt(heading.tagName.substring(1));
            const text = heading.textContent.trim();
            
            if (!text) return;

            const tocItem = document.createElement('div');
            tocItem.className = `toc-item level-${level}`;
            tocItem.textContent = text;
            const tocIndex = this.headings.length;
            tocItem.dataset.index = tocIndex;
            
            // スクロール用に見出しにユニークなIDを追加
            if (!heading.id) {
                heading.id = `heading-${index}`;
            }
            
            tocItem.addEventListener('click', () => {
                this.scrollToHeading(heading);
                this.setActiveIndex(tocIndex, { scrollIntoView: true });
            });
            
            this.headings.push(heading);
            this.tocItems.push(tocItem);
            this.tocContent.appendChild(tocItem);
        });

        this.refreshHeadingPositions();
        this.updateActiveFromScroll(true, { scrollIntoView: !wasHidden });

        if (wasHidden) {
            // Keep the hidden start state for one frame so the browser can animate in.
            this.revealRaf = requestAnimationFrame(() => {
                this.revealRaf = null;
                this.setTocVisibleState(true);
                this.tocContainer.classList.remove('hidden');
            });
        }
    }

    /**
     * 見出しにスクロール
     * @param {HTMLElement} heading - スクロール先の見出し要素
     */
    scrollToHeading(heading) {
        if (!heading || !this.editor.contains(heading)) return;
        const editorRect = this.editor.getBoundingClientRect();
        const headingRect = heading.getBoundingClientRect();
        const rawTargetScrollTop = this.editor.scrollTop + (headingRect.top - editorRect.top);
        const maxScrollTop = Math.max(0, this.editor.scrollHeight - this.editor.clientHeight);
        const targetScrollTop = Math.max(0, Math.min(maxScrollTop, rawTargetScrollTop));
        this.scrollEditorTo(targetScrollTop, this.scrollDuration);
        
        // スクロール先を示すために見出しをフラッシュ
        const originalBackground = heading.style.backgroundColor;
        heading.style.backgroundColor = 'var(--vscode-editor-findMatchHighlightBackground)';
        heading.style.transition = 'background-color 0.3s';
        
        setTimeout(() => {
            heading.style.backgroundColor = originalBackground;
            setTimeout(() => {
                heading.style.transition = '';
            }, 300);
        }, 500);
    }

    /**
     * 目次アイテムをハイライト
     * @param {HTMLElement} tocItem - ハイライトする目次アイテム
     */
    highlightTocItem(tocItem) {
        const index = Number(tocItem.dataset.index);
        if (Number.isNaN(index)) return;
        this.setActiveIndex(index, { scrollIntoView: true });
    }

    refreshHeadingPositions() {
        if (this.headings.length === 0) {
            this.headingTops = [];
            return;
        }
        const editorRect = this.editor.getBoundingClientRect();
        const editorScrollTop = this.editor.scrollTop;
        this.headingTops = this.headings.map(heading => {
            const rect = heading.getBoundingClientRect();
            return rect.top - editorRect.top + editorScrollTop;
        });
    }

    updateActiveFromScroll(force = false, { scrollIntoView = true } = {}) {
        if (!this.enabled || this.headings.length === 0) {
            this.clearActive();
            return;
        }
        if (this.headingTops.length !== this.headings.length) {
            this.refreshHeadingPositions();
        }
        if (this.headingTops.length === 0) {
            this.clearActive();
            return;
        }

        const scrollTop = this.editor.scrollTop + this.activeOffset;
        let nextIndex = 0;

        for (let i = 0; i < this.headingTops.length; i++) {
            if (this.headingTops[i] <= scrollTop) {
                nextIndex = i;
            } else {
                break;
            }
        }

        if (force || nextIndex !== this.activeIndex) {
            this.setActiveIndex(nextIndex, { scrollIntoView });
        }
    }

    setActiveIndex(index, { scrollIntoView = true } = {}) {
        if (index === this.activeIndex && index >= 0) return;
        this.clearActive();
        this.activeIndex = index;
        if (index < 0 || index >= this.tocItems.length) return;
        const tocItem = this.tocItems[index];
        if (!tocItem) return;
        tocItem.classList.add('active');
        if (scrollIntoView) {
            tocItem.scrollIntoView({ block: 'nearest' });
        }
    }

    clearActive() {
        this.tocContent.querySelectorAll('.toc-item.active').forEach(item => {
            item.classList.remove('active');
        });
        this.activeIndex = -1;
    }

    setTocVisibleState(visible) {
        document.body.dataset.tocVisible = visible ? 'true' : 'false';
    }

    normalizeScrollDuration(duration) {
        if (typeof duration !== 'number' || !Number.isFinite(duration)) {
            return 120;
        }
        return Math.max(0, Math.min(2000, Math.round(duration)));
    }

    cancelScrollAnimation() {
        if (this.scrollAnimationRaf !== null) {
            cancelAnimationFrame(this.scrollAnimationRaf);
            this.scrollAnimationRaf = null;
        }
    }

    cancelPendingReveal() {
        if (this.revealRaf !== null) {
            cancelAnimationFrame(this.revealRaf);
            this.revealRaf = null;
        }
    }

    scrollEditorTo(targetScrollTop, duration) {
        this.cancelScrollAnimation();
        if (duration <= 0) {
            this.editor.scrollTop = targetScrollTop;
            return;
        }

        const startScrollTop = this.editor.scrollTop;
        const distance = targetScrollTop - startScrollTop;
        if (Math.abs(distance) < 1) {
            this.editor.scrollTop = targetScrollTop;
            return;
        }

        const startTime = performance.now();
        const step = (now) => {
            const elapsed = now - startTime;
            const progress = Math.min(1, elapsed / duration);
            const easedProgress = 1 - Math.pow(1 - progress, 3);
            this.editor.scrollTop = Math.round(startScrollTop + (distance * easedProgress));
            if (progress < 1) {
                this.scrollAnimationRaf = requestAnimationFrame(step);
                return;
            }
            this.editor.scrollTop = targetScrollTop;
            this.scrollAnimationRaf = null;
        };

        this.scrollAnimationRaf = requestAnimationFrame(step);
    }
}

// Made with Bob
