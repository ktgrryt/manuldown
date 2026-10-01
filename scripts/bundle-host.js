// Bundles the extension host and its runtime dependencies into
// out/extension.js, so the VSIX does not have to ship node_modules.
//
// tsc still compiles every file into out/ for the tests and for `npm run watch`,
// where the unbundled out/extension.js loads node_modules directly. This script
// overwrites only out/extension.js, and .vscodeignore packages only that file.
//
// Usage: node scripts/bundle-host.js [--minify]
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.join(__dirname, '..');
const minify = process.argv.includes('--minify');

const buildOptions = {
    absWorkingDir: repositoryRoot,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // VS Code 1.85 runs extensions on Node.js 18.
    target: 'node18',
    external: ['vscode'],
    minify,
    sourcemap: !minify,
    logLevel: 'warning',
};

function getBundledPackageDirectories(metafile) {
    const directories = new Set();
    for (const input of Object.keys(metafile.inputs)) {
        const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
        if (match) {
            directories.add(path.join(repositoryRoot, match[1]));
        }
    }
    return [...directories].sort();
}

function readLicenseText(packageDirectory) {
    const licenseFile = fs.readdirSync(packageDirectory)
        .find((name) => /^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i.test(name));
    if (!licenseFile) {
        throw new Error(`No license file found in ${packageDirectory}`);
    }
    return fs.readFileSync(path.join(packageDirectory, licenseFile), 'utf8').trim();
}

// The bundled packages carry their copyright notices in LICENSE files, which no
// longer ship once node_modules is left out. Keep them with the code instead.
function buildLicenseComment(packageDirectories) {
    const notices = packageDirectories.map((directory) => {
        const { name, version } = JSON.parse(
            fs.readFileSync(path.join(directory, 'package.json'), 'utf8')
        );
        return `${name} ${version}\n\n${readLicenseText(directory)}`;
    });
    const body = notices.join('\n\n---\n\n').replace(/\*\//g, '* /');
    return `/*! Third-party software bundled into this file:\n\n${body}\n*/`;
}

async function main() {
    // First pass only discovers which packages end up in the bundle.
    const { metafile } = await esbuild.build({
        ...buildOptions,
        minify: false,
        sourcemap: false,
        write: false,
        metafile: true,
    });
    await esbuild.build({
        ...buildOptions,
        footer: { js: buildLicenseComment(getBundledPackageDirectories(metafile)) },
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
