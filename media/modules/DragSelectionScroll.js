// Only selections whose mousedown was cancelled for manual caret placement
// need assistance. Browser-owned text selections keep their native scrolling.
const NATIVE_SCROLL_GRACE_MS = 200;

export class DragSelectionScroll {
    constructor(editor, { resolveFocusRange, getAnchorRange, isEnabled }) {
        this.editor = editor;
        this.document = editor.ownerDocument;
        this.window = this.document.defaultView;
        this.resolveFocusRange = resolveFocusRange;
        this.getAnchorRange = getAnchorRange;
        this.isEnabled = isEnabled;
        this.drag = null;
        this.pointerSelection = null;
        this.frame = null;
        this.lastTimestamp = null;
        this.observedScrollTop = null;
        this.idleSince = null;

        editor.addEventListener('mousedown', event => this.start(event), true);
        this.document.addEventListener('mousemove', event => this.move(event));
        this.document.addEventListener('mouseup', () => this.stop(), true);
        this.document.addEventListener('dragstart', () => this.stop(), true);
        this.document.addEventListener('pointercancel', () => this.stop(), true);
        // Explicit scrolling and its momentum belong entirely to the browser.
        this.document.addEventListener('wheel', () => this.pauseForWheel(), { passive: true, capture: true });
        this.document.addEventListener('visibilitychange', () => {
            if (this.document.visibilityState === 'hidden') this.stop();
        });
        this.window.addEventListener('blur', () => this.stop());
    }

    start(event) {
        this.stop();
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return;
        const target = event.target.nodeType === 1 ? event.target : event.target.parentElement;
        if (!target || target.isContentEditable === false ||
            target.closest('input, textarea, select, button, [data-exclude-from-markdown="true"]')) return;
        this.pointerSelection = { x: event.clientX, y: event.clientY, moved: false };
        this.drag = { startX: event.clientX, startY: event.clientY,
            x: event.clientX, y: event.clientY, anchor: null };
    }

    move(event) {
        if (!this.pointerSelection) return;
        if ((event.buttons & 1) !== 1 || !this.isEnabled()) {
            this.stop();
            return;
        }
        const pointer = this.pointerSelection;
        if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 3) pointer.moved = true;
        if (!this.drag) return;
        const drag = this.drag;
        drag.x = event.clientX;
        drag.y = event.clientY;
        if (drag.wheelPosition) {
            if (Math.hypot(drag.x - drag.wheelPosition.x, drag.y - drag.wheelPosition.y) <= 3) return;
            drag.wheelPosition = null;
        }
        if (!drag.anchor) {
            if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) <= 3) return;
            // A cancelled mousedown has no native selection autoscroll. Keep
            // its original anchor, even for an upward (backward) selection.
            const manualAnchor = this.getAnchorRange();
            if (!manualAnchor) {
                // Observe the native gesture so caret reveal cannot compete
                // with it, without taking over its selection or scrolling.
                this.cancelFrame();
                this.drag = null;
                return;
            }
            drag.anchor = manualAnchor.cloneRange();
            drag.anchorNode = manualAnchor.startContainer;
        }
        if (!this.editor.contains(drag.anchorNode) || drag.anchor.startContainer !== drag.anchorNode) {
            this.stop();
            return;
        }
        const viewport = this.getViewport();
        if (!viewport || !this.getSpeed(viewport)) {
            this.cancelFrame();
            return;
        }
        this.schedule();
    }

    get isSelectingWithPointer() {
        return this.pointerSelection?.moved === true;
    }

    getViewport() {
        const rect = this.editor.getBoundingClientRect();
        // Bottom padding can make the editor taller than a short pane. Its
        // overflow-hidden container, rather than that padding box, is visible.
        const clip = this.editor.closest('.editor-container')?.getBoundingClientRect?.();
        const top = Math.max(0, rect.top + this.editor.clientTop, clip?.top ?? -Infinity);
        const bottom = Math.min(this.window.innerHeight,
            rect.top + this.editor.clientTop + this.editor.clientHeight, clip?.bottom ?? Infinity);
        const left = Math.max(0, rect.left + this.editor.clientLeft, clip?.left ?? -Infinity);
        const right = Math.min(this.window.innerWidth,
            rect.left + this.editor.clientLeft + this.editor.clientWidth, clip?.right ?? Infinity);
        return bottom > top + 4 && right > left + 4 ? { top, bottom, left, right } : null;
    }

    getSpeed({ top, bottom }) {
        const band = Math.min(40, (bottom - top) / 3);
        const y = this.drag.y;
        if (y < top + band) return -(120 + 780 * Math.min(1, (top + band - y) / band));
        if (y > bottom - band) return 120 + 780 * Math.min(1, (y - bottom + band) / band);
        return 0;
    }

    schedule() {
        if (this.frame !== null) return;
        if (this.observedScrollTop === null) this.observedScrollTop = this.editor.scrollTop;
        this.frame = this.window.requestAnimationFrame(timestamp => this.tick(timestamp));
    }

    tick(timestamp) {
        this.frame = null;
        const drag = this.drag;
        if (!drag || !this.isEnabled() || !this.getAnchorRange() ||
            !this.editor.contains(drag.anchorNode) || drag.anchor.startContainer !== drag.anchorNode) {
            this.stop();
            return;
        }
        const viewport = this.getViewport();
        const speed = viewport ? this.getSpeed(viewport) : 0;
        if (!speed) {
            this.cancelFrame();
            return;
        }
        const previousTimestamp = this.lastTimestamp ?? timestamp;
        this.lastTimestamp = timestamp;
        const before = this.editor.scrollTop;
        const maxScroll = Math.max(0, this.editor.scrollHeight - this.editor.clientHeight);
        if ((speed < 0 && before <= 0) || (speed > 0 && before >= maxScroll)) {
            this.cancelFrame();
            return;
        }
        const nativeScrolled = before !== this.observedScrollTop;
        this.observedScrollTop = before;
        if (nativeScrolled || this.idleSince === null) this.idleSince = timestamp;
        if (timestamp - this.idleSince < NATIVE_SCROLL_GRACE_MS) {
            // Native scrolling may start after the mousemove or on a later
            // frame. Observe it first, and leave its speed and selection alone.
            this.schedule();
            return;
        }
        const elapsed = Math.min(50, Math.max(0,
            timestamp - Math.max(previousTimestamp, this.idleSince + NATIVE_SCROLL_GRACE_MS)));
        this.editor.scrollTop = Math.max(0, Math.min(maxScroll, before + speed * elapsed / 1000));
        // Do not mistake our own last write for progress by the browser.
        this.observedScrollTop = this.editor.scrollTop;

        // Hit-test inside the visible editor even when the pointer is over the
        // toolbar or outside the Webview. Recompute after every scroll frame.
        const x = Math.max(viewport.left + 2, Math.min(viewport.right - 2, drag.x));
        const y = Math.max(viewport.top + 2, Math.min(viewport.bottom - 2, drag.y));
        const focus = this.resolveFocusRange(x, y);
        const selection = this.window.getSelection();
        if (focus && selection && this.editor.contains(focus.startContainer)) {
            if (typeof selection.setBaseAndExtent === 'function') {
                selection.setBaseAndExtent(drag.anchor.startContainer, drag.anchor.startOffset,
                    focus.startContainer, focus.startOffset);
            } else {
                const range = drag.anchor.cloneRange();
                if (range.compareBoundaryPoints(0, focus) <= 0) {
                    range.setEnd(focus.startContainer, focus.startOffset);
                } else {
                    range.setStart(focus.startContainer, focus.startOffset);
                }
                selection.removeAllRanges();
                selection.addRange(range);
            }
        }
        this.schedule();
    }

    pauseForWheel() {
        this.cancelFrame();
        if (this.drag) this.drag.wheelPosition = { x: this.drag.x, y: this.drag.y };
    }

    cancelFrame() {
        if (this.frame !== null) this.window.cancelAnimationFrame(this.frame);
        this.frame = null;
        this.lastTimestamp = null;
        this.observedScrollTop = null;
        this.idleSince = null;
    }

    stop() {
        this.cancelFrame();
        this.drag = null;
        this.pointerSelection = null;
    }
}
