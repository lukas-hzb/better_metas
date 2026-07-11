const fs = require('fs');

function stringifyJsonAscii(data) {
    return JSON.stringify(data, null, 2).replace(/[^\x00-\x7F]/g, (char) => {
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    });
}

function readJson(filePath, fallback) {
    if (fallback !== undefined && !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAscii(filePath, data) {
    fs.writeFileSync(filePath, stringifyJsonAscii(data));
}

module.exports = {
    stringifyJsonAscii,
    readJson,
    writeJsonAscii,
};
