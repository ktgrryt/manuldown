# Carbon Icons

The SVGs in this directory are an unmodified subset of IBM's
[`@carbon/icons` 11.92.0](https://www.npmjs.com/package/@carbon/icons/v/11.92.0),
licensed under [Apache License 2.0](./LICENSE).

Copyright IBM Corp. 2016, 2023. The upstream license also includes
Copyright 2015 IBM Corp.

`manifest.json` records the package version, npm distribution integrity, and
original SVG paths. A 16 px source is used when available; otherwise the
package's 32 px source is displayed at 16 px, as in Carbon's own icon exports.

Run `node scripts/bundle-icons.js` from the repository root to regenerate
`icons.css`. ManulDown converts the SVGs to CSS masks and adds theme color
inheritance and class names; the original artwork is unchanged. Icons are
decorative, with accessible names supplied by their controls.

The SVGs, this attribution, and the full upstream `LICENSE` are included in
the extension distribution. The rest of ManulDown retains its existing license.
