// Adapt the file searches in VSCE and TypeScript ESLint while
// tinyglobby's picomatch dependency is affected by GHSA-fc5q-39xc-vjpf.
const { promisify } = require('node:util');
const { glob, globSync, hasMagic } = require('glob');

function globOptions({
    cwd, dot, ignore, caseSensitiveMatch = true, followSymbolicLinks = true, onlyFiles = true, fs,
} = {}) {
    return {
        cwd,
        dot,
        ignore,
        nocase: !caseSensitiveMatch,
        follow: followSymbolicLinks,
        nodir: onlyFiles,
        posix: true,
        // VSCE supplies a readdir hook to count symlinks as files when it
        // packages without following them. Glob also uses a promise API.
        fs: fs && { ...fs, promises: { readdir: promisify(fs.readdir) } },
    };
}

exports.glob = (patterns, options) => glob(patterns, globOptions(options));
exports.globSync = (patterns, options) => globSync(patterns, globOptions(options));
exports.isDynamicPattern = pattern => hasMagic(pattern, { magicalBraces: true });
