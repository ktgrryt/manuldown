import mermaid from 'mermaid';

// Expose the bundled Mermaid instance for the existing webview integration.
// Bundling from Mermaid's default export ensures its DOMPurify import resolves
// to the audited top-level dependency instead of the copy embedded in
// Mermaid's prebuilt dist/mermaid.min.js artifact.
window.mermaid = mermaid;
