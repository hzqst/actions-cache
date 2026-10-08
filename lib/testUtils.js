"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setInput = setInput;
// See: https://github.com/actions/toolkit/blob/master/packages/core/src/core.ts#L67
function getInputName(name) {
    return `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
}
function setInput(name, value) {
    process.env[getInputName(name)] = value;
}
