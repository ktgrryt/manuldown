/**
 * Fits the table of contents panel to the editor width.
 *
 * The panel keeps the width the user chose while the body stays at least
 * TOC_BODY_MIN_WIDTH wide. When the editor gets narrower, the body keeps
 * that width and the panel gives up the space until it closes; only then
 * does the body shrink. Widening the editor reverses the same steps.
 *
 * Choosing a panel width that leaves the body narrower than that (by dragging
 * or with the keyboard) records the body width as a lower limit, so the panel
 * stays where it was dropped. The editor drops the limit again once it is
 * wide enough for the chosen panel width and a TOC_BODY_MIN_WIDTH body.
 *
 * editor.css computes the rendered width with the same formula as
 * fitTocPanelWidth(), so the panel follows the editor edge within the
 * browser's own layout of each frame.
 */
export const TOC_BODY_MIN_WIDTH = 400;

/**
 * @param {number|null} bodyMinWidth - A lower body limit from fitTocBodyMinWidth().
 * @returns {number} The body width below which the panel shrinks.
 */
export function getTocBodyMinWidth(bodyMinWidth) {
    return bodyMinWidth === null ? TOC_BODY_MIN_WIDTH : Math.min(TOC_BODY_MIN_WIDTH, bodyMinWidth);
}

/**
 * @param {number} containerWidth - Width shared by the body and the panel.
 * @param {number} preferredWidth - The panel width the user chose.
 * @param {number|null} [bodyMinWidth] - A lower body limit from fitTocBodyMinWidth().
 * @returns {number} The panel width to render.
 */
export function fitTocPanelWidth(containerWidth, preferredWidth, bodyMinWidth = null) {
    const availableWidth = containerWidth - getTocBodyMinWidth(bodyMinWidth);
    return Math.max(0, Math.min(preferredWidth, Math.round(availableWidth)));
}

/**
 * @param {number} containerWidth - Width shared by the body and the panel.
 * @param {number} width - The panel width the user just chose.
 * @returns {number|null} The body limit that keeps the panel at that width,
 *     or null when the body stays TOC_BODY_MIN_WIDTH wide anyway.
 */
export function fitTocBodyMinWidth(containerWidth, width) {
    const bodyWidth = Math.max(0, Math.round(containerWidth - width));
    return bodyWidth < TOC_BODY_MIN_WIDTH ? bodyWidth : null;
}

/**
 * @param {number} containerWidth - Width shared by the body and the panel.
 * @param {number} preferredWidth - The panel width the user chose.
 * @param {number|null} bodyMinWidth - The current body limit.
 * @returns {number|null} The limit to keep after the editor was resized.
 */
export function releaseTocBodyMinWidth(containerWidth, preferredWidth, bodyMinWidth) {
    if (bodyMinWidth === null) return null;
    return containerWidth - preferredWidth >= TOC_BODY_MIN_WIDTH ? null : bodyMinWidth;
}

/**
 * Collapses an open panel, or brings back the width a collapsed panel had.
 * When nothing would come back (a narrow editor or a zero width closed the
 * panel), the panel opens at the chosen width, or the default one.
 *
 * @param {Object} layout
 * @param {number} layout.containerWidth - Width shared by the body and the panel.
 * @param {number} layout.preferredWidth - The panel width the user chose.
 * @param {number|null} layout.bodyMinWidth - The current body limit.
 * @param {boolean} layout.collapsed - Whether the panel is collapsed.
 * @param {number} defaultWidth - The panel width to open a zero-width panel at.
 * @returns {{ preferredWidth: number, bodyMinWidth: number|null, collapsed: boolean }}
 */
export function toggleTocPanelCollapsed(layout, defaultWidth) {
    const { containerWidth, preferredWidth, bodyMinWidth, collapsed } = layout;
    const openWidth = fitTocPanelWidth(containerWidth, preferredWidth, bodyMinWidth);
    if (!collapsed && openWidth > 0) {
        return { preferredWidth, bodyMinWidth, collapsed: true };
    }
    if (openWidth > 0) {
        return { preferredWidth, bodyMinWidth, collapsed: false };
    }
    const width = preferredWidth > 0 ? preferredWidth : defaultWidth;
    return {
        preferredWidth: width,
        bodyMinWidth: fitTocBodyMinWidth(containerWidth, width),
        collapsed: false
    };
}
