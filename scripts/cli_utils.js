function getArg(argv, prefix) {
    const arg = argv.find((value) => value.startsWith(prefix));
    return arg ? arg.slice(prefix.length).trim() : null;
}

function getLowerCaseArg(argv, prefix) {
    return (getArg(argv, prefix) || '').toLowerCase() || null;
}

function parseIntArg(argv, prefix) {
    const value = getArg(argv, prefix);
    if (!value) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

module.exports = {
    getArg,
    getLowerCaseArg,
    parseIntArg,
};
