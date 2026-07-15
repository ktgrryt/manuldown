// @ts-nocheck

/**
 * Insert an immediately visible plain-text fallback without letting
 * Node.normalize() merge it with the surrounding text while the extension
 * host validates the path. Empty comments are invisible and are discarded by
 * Turndown, so they never become part of the Markdown document.
 */
export function createPastedPathFallback(ownerDocument, pathText) {
    const startBoundary = ownerDocument.createComment('');
    const fallbackNode = ownerDocument.createTextNode(String(pathText || ''));
    const endBoundary = ownerDocument.createComment('');
    const fragment = ownerDocument.createDocumentFragment();
    fragment.appendChild(startBoundary);
    fragment.appendChild(fallbackNode);
    fragment.appendChild(endBoundary);
    return {
        startBoundary,
        fallbackNode,
        endBoundary,
        fragment
    };
}

function hasExactFallbackStructure(pending) {
    if (!pending) return false;
    const { startBoundary, fallbackNode, endBoundary, pathText } = pending;
    const parent = startBoundary?.parentNode || null;
    return !!(
        parent &&
        fallbackNode?.parentNode === parent &&
        endBoundary?.parentNode === parent &&
        startBoundary.nodeType === 8 &&
        fallbackNode.nodeType === 3 &&
        endBoundary.nodeType === 8 &&
        startBoundary.nextSibling === fallbackNode &&
        fallbackNode.nextSibling === endBoundary &&
        fallbackNode.data === pathText
    );
}

export function isPastedPathFallbackIntact(pending, editor) {
    if (!hasExactFallbackStructure(pending) || !editor) return false;
    const { startBoundary, fallbackNode, endBoundary } = pending;
    return !!(
        editor.contains(startBoundary) &&
        editor.contains(fallbackNode) &&
        editor.contains(endBoundary)
    );
}

/**
 * Remove only the invisible boundaries, preserving the literal path as the
 * normal paste result. Identity checks ensure unrelated comments from a
 * document can never be removed through this helper.
 */
export function releasePastedPathFallback(pending) {
    if (!pending) return null;
    const { startBoundary, fallbackNode, endBoundary } = pending;
    if (startBoundary?.parentNode) {
        startBoundary.parentNode.removeChild(startBoundary);
    }
    if (endBoundary?.parentNode) {
        endBoundary.parentNode.removeChild(endBoundary);
    }
    return fallbackNode?.parentNode ? fallbackNode : null;
}

/**
 * Atomically replace the guarded fallback with a validated link or restored
 * selection fragment. The caller must validate the pending structure first.
 */
export function replacePastedPathFallback(pending, replacement) {
    if (!hasExactFallbackStructure(pending) || !replacement) return false;
    const { startBoundary, fallbackNode, endBoundary } = pending;
    const parent = startBoundary.parentNode;

    try {
        parent.insertBefore(replacement, startBoundary);
        parent.removeChild(startBoundary);
        parent.removeChild(fallbackNode);
        parent.removeChild(endBoundary);
        return true;
    } catch (_error) {
        return false;
    }
}
