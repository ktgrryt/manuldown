// @ts-nocheck

/**
 * A DOMRect can be present but still contain no measurable caret position.
 * Keep this check independent from DOM globals so the scroll math is testable.
 */
export function isUsableCaretRect(rect) {
    if (!rect) return false;

    const top = Number(rect.top);
    const bottom = Number(rect.bottom);
    const left = Number(rect.left);
    const right = Number(rect.right);
    if (![top, bottom, left, right].every(Number.isFinite)) return false;

    return bottom >= top && right >= left && (bottom > top || right > left);
}

/**
 * CursorManager occasionally has to fall back to an element's complete bounds.
 * A collapsed selection represents one edge of that element, not both edges.
 */
export function collapseRectToCaretEdge(rect, atEnd = false) {
    if (!rect) return null;

    const left = Number(rect.left);
    const right = Number(rect.right);
    const top = Number(rect.top);
    const bottom = Number(rect.bottom);
    if (![left, right, top, bottom].every(Number.isFinite)) return null;

    const x = atEnd ? right : left;
    const y = atEnd ? bottom : top;
    return {
        left: x,
        right: x,
        top: y,
        bottom: y,
        width: 0,
        height: 0,
        x,
        y
    };
}

/**
 * Calculate the smallest scroll adjustment that reveals a caret rectangle.
 * Coordinates for the viewport and target are viewport-relative DOMRect values.
 */
export function calculateCaretRevealScrollTop({
    scrollTop,
    scrollHeight,
    clientHeight,
    viewportTop,
    viewportBottom,
    targetTop,
    targetBottom,
    margin = 8
}) {
    const values = [
        scrollTop,
        scrollHeight,
        clientHeight,
        viewportTop,
        viewportBottom,
        targetTop,
        targetBottom,
        margin
    ].map(Number);
    if (!values.every(Number.isFinite)) return scrollTop;

    const [
        currentScrollTop,
        currentScrollHeight,
        currentClientHeight,
        currentViewportTop,
        currentViewportBottom,
        currentTargetTop,
        currentTargetBottom,
        currentMargin
    ] = values;
    const safeMargin = Math.max(0, currentMargin);
    const visibleTop = currentViewportTop + safeMargin;
    const visibleBottom = currentViewportBottom - safeMargin;
    const targetHeight = Math.max(0, currentTargetBottom - currentTargetTop);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    let nextScrollTop = currentScrollTop;

    // Atomic selections can be taller than the viewport. If the viewport is
    // already inside that element, moving between its two edges would oscillate.
    if (targetHeight > visibleHeight) {
        if (currentTargetTop <= visibleTop && currentTargetBottom >= visibleBottom) {
            return currentScrollTop;
        }
        if (currentTargetTop > visibleTop) {
            nextScrollTop += currentTargetTop - visibleTop;
        } else if (currentTargetBottom < visibleBottom) {
            nextScrollTop += currentTargetBottom - visibleBottom;
        }
    } else if (currentTargetTop < visibleTop) {
        nextScrollTop += currentTargetTop - visibleTop;
    } else if (currentTargetBottom > visibleBottom) {
        nextScrollTop += currentTargetBottom - visibleBottom;
    }

    const maxScrollTop = Math.max(0, currentScrollHeight - currentClientHeight);
    return Math.max(0, Math.min(maxScrollTop, nextScrollTop));
}

/**
 * Keep a restored caret at the same vertical position inside the editor viewport.
 * This compensates for delayed browser scroll anchoring after focus/selection
 * restoration, even when the caret never becomes fully invisible.
 */
export function calculateCaretAnchorScrollTop({
    scrollTop,
    scrollHeight,
    clientHeight,
    currentCaretViewportOffset,
    desiredCaretViewportOffset
}) {
    const values = [
        scrollTop,
        scrollHeight,
        clientHeight,
        currentCaretViewportOffset,
        desiredCaretViewportOffset
    ].map(Number);
    if (!values.every(Number.isFinite)) return scrollTop;

    const [
        currentScrollTop,
        currentScrollHeight,
        currentClientHeight,
        currentCaretOffset,
        desiredCaretOffset
    ] = values;
    const nextScrollTop = currentScrollTop + currentCaretOffset - desiredCaretOffset;
    const maxScrollTop = Math.max(0, currentScrollHeight - currentClientHeight);
    return Math.max(0, Math.min(maxScrollTop, nextScrollTop));
}
