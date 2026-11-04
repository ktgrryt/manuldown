// @ts-nocheck

let viewerId = 0;

/** A modal canvas for inspecting a rendered Mermaid block without editing it. */
export class MermaidViewer {
    constructor(editor) {
        this.editor = editor;
        this.dialog = null;
        this.id = `mermaid-viewer-${++viewerId}`;
        editor.addEventListener('click', (event) => {
            const button = event.target.closest?.('.code-block-expand-btn');
            if (!button || !editor.contains(button)) return;
            event.preventDefault();
            event.stopPropagation();
            this.open(button.closest('pre'));
        });
    }

    open(pre) {
        if (!this._isMermaidBlock(pre)) return;
        this.close();
        this.pre = pre;
        this.previousFocus = document.activeElement;
        const selection = window.getSelection();
        this.savedRange = selection?.rangeCount && this.editor.contains(selection.getRangeAt(0).commonAncestorContainer)
            ? selection.getRangeAt(0).cloneRange() : null;
        // Editor-wide shortcuts must not act on a selection behind the modal.
        selection?.removeAllRanges();

        const dialog = document.createElement('dialog');
        dialog.className = 'mermaid-viewer';
        dialog.contentEditable = 'false';
        dialog.setAttribute('aria-label', 'Mermaid preview');
        dialog.setAttribute('data-exclude-from-markdown', 'true');
        dialog.innerHTML = `
            <div class="mermaid-viewer-toolbar">
                <strong class="mermaid-viewer-title">Mermaid preview</strong>
                <button type="button" class="mermaid-viewer-close" data-action="close" aria-label="Close preview" title="Close preview (Esc)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18"/></svg>
                </button>
            </div>
            <div class="mermaid-viewer-viewport" tabindex="0" role="region" aria-label="Diagram. Scroll to zoom, drag or use arrow keys to pan.">
                <div class="mermaid-viewer-stage"></div>
                <p class="mermaid-viewer-status" role="status"></p>
            </div>
            <div class="mermaid-viewer-footer">
                <div class="mermaid-viewer-actions" role="group" aria-label="Diagram controls">
                    <div class="mermaid-viewer-zoom" role="group" aria-label="Zoom">
                        <button type="button" data-action="zoom-out" aria-label="Zoom out" title="Zoom out (−)">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M5 12h14"/></svg>
                        </button>
                        <output class="mermaid-viewer-scale" aria-label="Zoom level" aria-live="polite"></output>
                        <button type="button" data-action="zoom-in" aria-label="Zoom in" title="Zoom in (+)">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M5 12h14M12 5v14"/></svg>
                        </button>
                    </div>
                    <button type="button" class="mermaid-viewer-actual" data-action="actual" aria-label="Actual size (100%)" title="Actual size (0)">
                        <span>100%</span><span class="mermaid-viewer-button-caption">Actual size</span>
                    </button>
                    <button type="button" data-action="fit" title="Fit diagram to view (F)">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/></svg>
                        Fit to view
                    </button>
                </div>
                <p class="mermaid-viewer-hint">Scroll to zoom · Drag to pan · Esc to close</p>
            </div>`;
        this.dialog = dialog;
        this.viewport = dialog.querySelector('.mermaid-viewer-viewport');
        this.stage = dialog.querySelector('.mermaid-viewer-stage');
        this.status = dialog.querySelector('.mermaid-viewer-status');
        this.scaleLabel = dialog.querySelector('.mermaid-viewer-scale');
        this.svgMarkup = null;
        this.drag = null;
        this.width = 0;
        this.height = 0;

        dialog.addEventListener('click', (event) => {
            const action = event.target.closest?.('[data-action]')?.getAttribute('data-action');
            if (action === 'close') this.close();
            else if (action === 'fit') this.fit();
            else if (action === 'actual') this.zoomTo(1);
            else if (action === 'zoom-in') this.zoomTo(this.scale * 1.25);
            else if (action === 'zoom-out') this.zoomTo(this.scale / 1.25);
            event.stopPropagation();
        });
        dialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            this.close();
        });
        dialog.addEventListener('close', () => {
            if (this.dialog === dialog) this.close();
        });
        dialog.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
                event.preventDefault();
                this.close();
                return;
            }
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            const key = event.key.toLowerCase();
            if (key === '+' || key === '=') this.zoomTo(this.scale * 1.25);
            else if (key === '-') this.zoomTo(this.scale / 1.25);
            else if (key === '0') this.zoomTo(1);
            else if (key === 'f') this.fit();
            else if (key.startsWith('arrow') && this.width) {
                this.x += key === 'arrowleft' ? 40 : key === 'arrowright' ? -40 : 0;
                this.y += key === 'arrowup' ? 40 : key === 'arrowdown' ? -40 : 0;
                this.fitted = false;
                this._applyTransform();
            } else return;
            event.preventDefault();
        });
        this.viewport.addEventListener('wheel', (event) => {
            event.preventDefault();
            if (!this.width) return;
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.clientHeight : 1;
            const delta = Math.max(-100, Math.min(100, event.deltaY * unit));
            const rect = this.viewport.getBoundingClientRect();
            this.zoomTo(this.scale * Math.exp(-delta * 0.002), event.clientX - rect.left, event.clientY - rect.top);
        }, { passive: false });
        this.viewport.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || !this.width || this.drag) return;
            event.preventDefault();
            this.viewport.focus({ preventScroll: true });
            this.viewport.setPointerCapture(event.pointerId);
            this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
            this.viewport.classList.add('is-dragging');
        });
        this.viewport.addEventListener('pointermove', (event) => {
            if (this.drag?.id !== event.pointerId) return;
            this.x += event.clientX - this.drag.x;
            this.y += event.clientY - this.drag.y;
            this.drag.x = event.clientX;
            this.drag.y = event.clientY;
            this.fitted = false;
            this._applyTransform();
        });
        const stopDrag = () => {
            this.drag = null;
            this.viewport.classList.remove('is-dragging');
        };
        this.viewport.addEventListener('pointerup', stopDrag);
        this.viewport.addEventListener('pointercancel', stopDrag);
        this.viewport.addEventListener('lostpointercapture', stopDrag);

        document.body.appendChild(dialog);
        dialog.showModal();
        this._syncDiagram();
        this.viewport.focus({ preventScroll: true });
        this.observer = new MutationObserver(() => this._syncDiagram());
        this.observer.observe(this.editor, { childList: true, subtree: true, characterData: true });
        this.resizeObserver = new ResizeObserver(() => {
            if (this.fitted) this.fit();
        });
        this.resizeObserver.observe(this.viewport);
    }

    _isMermaidBlock(pre) {
        return pre && this.editor.contains(pre) &&
            /(?:^|\s)language-mermaid(?:\s|$)/i.test(pre.querySelector('code')?.className || '');
    }

    _syncDiagram() {
        if (!this._isMermaidBlock(this.pre)) {
            this.close();
            return;
        }
        const preview = this.pre.querySelector('.mermaid-preview');
        const svg = preview?.querySelector('svg');
        const markup = svg?.outerHTML || '';
        if (markup === this.svgMarkup) {
            if (!svg) this.status.textContent = preview?.textContent || 'Loading Mermaid diagram…';
            return;
        }
        this.svgMarkup = markup;
        this.stage.replaceChildren();
        this.width = 0;
        this.height = 0;
        this.status.hidden = !!svg;
        this.dialog.querySelectorAll('[data-action]:not([data-action="close"])').forEach(button => {
            button.disabled = !svg;
        });
        if (!svg) {
            this.status.textContent = preview?.textContent || 'Loading Mermaid diagram…';
            this.scaleLabel.textContent = '—';
            return;
        }

        const clone = svg.cloneNode(true);
        // SVG styles and marker references must stay local to this copy.
        const ids = new Map();
        [clone, ...clone.querySelectorAll('[id]')].forEach(node => {
            if (node.id) ids.set(node.id, `${this.id}-${node.id}`);
        });
        const replaceIds = text => text.replace(/#([\w-]+)/g, (match, id) => ids.has(id) ? `#${ids.get(id)}` : match);
        [clone, ...clone.querySelectorAll('*')].forEach(node => {
            for (const attribute of Array.from(node.attributes)) {
                if (attribute.name === 'id') node.id = ids.get(attribute.value);
                else if (attribute.value.includes('#')) node.setAttribute(attribute.name, replaceIds(attribute.value));
                else if (attribute.name === 'aria-labelledby' || attribute.name === 'aria-describedby') {
                    node.setAttribute(attribute.name, attribute.value.split(/\s+/).map(id => ids.get(id) || id).join(' '));
                }
            }
            if (node.tagName.toLowerCase() === 'style') node.textContent = replaceIds(node.textContent);
            if (node.hasAttribute('tabindex') || node.tagName.toLowerCase() === 'a') node.setAttribute('tabindex', '-1');
        });
        // Mermaid often sets width="100%". The viewBox supplies its real size.
        const viewBox = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
        const rect = svg.getBoundingClientRect();
        const dimension = name => {
            const value = svg.getAttribute(name) || '';
            return /^\d+(\.\d+)?(px)?$/.test(value) ? parseFloat(value) : 0;
        };
        this.width = viewBox.length === 4 && viewBox[2] > 0 ? viewBox[2] : dimension('width') || rect.width || 800;
        this.height = viewBox.length === 4 && viewBox[3] > 0 ? viewBox[3] : dimension('height') || rect.height || 600;
        clone.style.width = `${this.width}px`;
        clone.style.height = `${this.height}px`;
        clone.style.maxWidth = 'none';
        this.stage.appendChild(clone);
        this.fit();
    }

    fit() {
        if (!this.width) return;
        const width = this.viewport.clientWidth;
        const height = this.viewport.clientHeight;
        this.scale = Math.min(1, Math.max(1, width - 48) / this.width, Math.max(1, height - 48) / this.height);
        this.x = (width - this.width * this.scale) / 2;
        this.y = (height - this.height * this.scale) / 2;
        this.fitted = true;
        this._applyTransform();
    }

    zoomTo(scale, anchorX = this.viewport.clientWidth / 2, anchorY = this.viewport.clientHeight / 2) {
        if (!this.width) return;
        const next = Math.max(Math.min(0.01, this.scale), Math.min(16, scale));
        const ratio = next / this.scale;
        this.x = anchorX - (anchorX - this.x) * ratio;
        this.y = anchorY - (anchorY - this.y) * ratio;
        this.scale = next;
        this.fitted = false;
        this._applyTransform();
    }

    _applyTransform() {
        this.stage.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
        this.scaleLabel.textContent = `${Math.round(this.scale * 100)}%`;
    }

    close() {
        if (!this.dialog) return;
        const dialog = this.dialog;
        this.dialog = null;
        this.observer?.disconnect();
        this.resizeObserver?.disconnect();
        dialog.close();
        dialog.remove();
        if (this.savedRange && this.editor.contains(this.savedRange.commonAncestorContainer)) {
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(this.savedRange);
        }
        const trigger = this.editor.contains(this.pre) ? this.pre.querySelector('.code-block-expand-btn') : null;
        const focus = trigger || (this.previousFocus?.isConnected ? this.previousFocus : this.editor);
        focus.focus({ preventScroll: true });
        this.savedRange = null;
        this.pre = null;
        this.drag = null;
    }
}
