export const imageRenderMaxWidthPx = 820;

function positiveDimension(digits = ''): number | null {
    const value = Number(digits);
    return Number.isFinite(value) && value > 0 ? value : null;
}

/** Read the final |W, |WxH, |Wx or |xH suffix written in an image description. */
export function parseImageAltSizeSpec(altText: string) {
    const separator = altText.lastIndexOf('|');
    if (separator >= 0) {
        const size = /^(\d*)(?:x(\d*))?$/i.exec(altText.slice(separator + 1).trim());
        const width = positiveDimension(size?.[1]);
        const height = positiveDimension(size?.[2]);
        if (width || height) {
            return { altText: altText.slice(0, separator), width, height };
        }
    }
    return { altText, width: null, height: null };
}
