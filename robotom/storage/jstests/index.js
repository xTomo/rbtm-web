// Тесты логики просмотрщика кадров хранилища: `node --test robotom/storage/jstests/` (каталог разрешается в этот файл —
// node 22+ сам каталог не обходит) или `node --test "robotom/storage/jstests/*.test.js"`.
'use strict';
const fs = require('fs');
const path = require('path');

for (const name of fs.readdirSync(__dirname).sort()) {
    if (name.endsWith('.test.js')) require(path.join(__dirname, name));
}
