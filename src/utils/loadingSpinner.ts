/** Inline so loading feedback also works before external stylesheets arrive. */
export function getLoadingSpinnerCss(selector: string): string {
    return `${selector} {
        width: var(--loading-spinner-size, 24px);
        height: var(--loading-spinner-size, 24px);
        box-sizing: border-box;
        flex-shrink: 0;
        border: var(--loading-spinner-width, 2px) solid var(--vscode-editorWidget-border, #555555);
        border-top-color: var(--vscode-progressBar-background, #0e70c0);
        border-radius: 50%;
        animation: manuldown-loading-spin 0.8s linear infinite;
    }
    @keyframes manuldown-loading-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { ${selector} { animation: none; } }`;
}
