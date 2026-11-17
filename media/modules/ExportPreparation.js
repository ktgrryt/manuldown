/** Wait for committed text and imported images without touching editor history. */
export async function prepareExportSnapshot({ isComposing, hasPendingImages, createSnapshot, timeoutMs = 12000 }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isComposing()) {
            const snapshot = createSnapshot();
            if (!hasPendingImages() && !isComposing()) return snapshot;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Finish the current edit or image import, then open PDF preview again.');
}
