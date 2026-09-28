// Загрузка модулей студии в node: файлы — IIFE, без window пишут в globalThis.Studio.
'use strict';
const path = require('path');

const STATIC_JS = path.join(__dirname, '..', 'static', 'reconstruction', 'js');

function load(...names) {
    for (const name of names) require(path.join(STATIC_JS, name));
    return globalThis.Studio;
}

module.exports = {load, STATIC_JS};
