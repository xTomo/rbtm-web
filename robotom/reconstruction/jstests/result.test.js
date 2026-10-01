'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./load');

const S = load('core.js', 'step_result.js');

test('fullVolumeLinks: ссылки на полный объём через раздачу статики; без префикса или файлов — нет', () => {
    const L = S.StepResult.fullVolumeLinks;
    const doc = {full: [
        {name: 'обр 1.386_965_965.1.raw', rel: 'exp-1/reconstruction/обр 1.386_965_965.1.raw', size: 1438000000},
        {name: 'tomo.обр.1.hx', rel: 'exp-1/reconstruction/tomo.обр.1.hx', size: 213}]};
    const got = L(doc, '/reconstruct/static/tomo_data/');
    assert.equal(got.length, 2);
    assert.equal(got[0].href, '/reconstruct/static/tomo_data/exp-1/reconstruction/' +
        encodeURIComponent('обр 1.386_965_965.1.raw'));
    assert.equal(got[0].size, 1438000000);
    assert.equal(L(doc, '/x//')[1].href, '/x/exp-1/reconstruction/' + encodeURIComponent('tomo.обр.1.hx'));
    assert.deepEqual(L(doc, ''), []);
    assert.deepEqual(L({full: []}, '/x/'), []);
    assert.deepEqual(L({}, '/x/'), []);
});
