function stringifyJsonAscii(data) {
    return JSON.stringify(data, null, 2).replace(/[^\x00-\x7F]/g, (char) => {
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    });
}

module.exports = {
    stringifyJsonAscii
};
