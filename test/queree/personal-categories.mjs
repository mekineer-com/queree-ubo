import {
    defaultPersonalCategories,
    matchPersonalCategory,
    personalDisplayRecord,
    validatePersonalCategories,
} from '../../src/js/queree/personal-categories.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const category = (name, entries, enabled = true) => ({ name, entries, enabled });
const normalize = (...values) => validatePersonalCategories(values);
const groups = normalize(
    category(' Favorites ', ['EXAMPLE.org/*', 'https://elsewhere.test/page']),
    category('Hidden', ['https://other.test/secret'], false)
);
assert.equal(groups[0].name, 'Favorites');
assert.equal(groups[0].entries[0], 'example.org/*');
for ( const url of ['https://example.org/', 'http://example.org/path', 'https://sub.example.org/path?a=b'] ) {
    assert.equal(matchPersonalCategory(url, groups).name, 'Favorites');
}
for ( const url of ['https://notexample.org/', 'https://example.org.evil.test/', 'https://other.test/secretary',
    'https://elsewhere.test/page/child', 'http://elsewhere.test/page', 'https://elsewhere.test/page?new=1'] ) {
    assert.equal(matchPersonalCategory(url, groups), undefined, url);
}
assert.equal(matchPersonalCategory('https://elsewhere.test/page#:~:text=highlight', groups).name, 'Favorites');
assert.equal(matchPersonalCategory('https://other.test/secret', groups).enabled, false);
assert.equal(matchPersonalCategory('https://quora.com/question', defaultPersonalCategories).enabled, true);
for ( const host of [ 'instagram.com', 'www.instagram.com', 'tiktok.com', 'vm.tiktok.com',
    'threads.com', 'www.threads.com', 'threads.net', 'www.threads.net' ] ) {
    assert.equal(matchPersonalCategory(`https://${host}/post`, defaultPersonalCategories).enabled, true);
    assert.equal(matchPersonalCategory(`https://${host}.example.org/post`, defaultPersonalCategories), undefined);
}
for ( const url of [ 'https://user@example.org/', 'https://:pass@example.org/',
    'https://user:pass@example.org/', 'https://[invalid', 'ftp://example.org/file' ] ) {
    assert.equal(matchPersonalCategory(url, groups), undefined, url);
    const result = { url, verdict: 'unresolved' };
    assert.deepEqual(personalDisplayRecord(result, groups), { ...result, personal_category: undefined },
        'An unsupported result address must not reject the whole reply');
    assert.equal(personalDisplayRecord({ url: 'https://example.org/', original_url: url }, groups)
        .personal_category, undefined, 'The original search address must also be safe to match');
}
assert.deepEqual(normalize(category('Duplicates', ['example.org/*', 'example.org/*']))[0].entries, ['example.org/*']);
for ( const [first, second] of [
    ['example.org/*', 'https://example.org/page'],
    ['https://sub.example.org/page', 'example.org/*'],
    ['example.org/*', 'sub.example.org/*'],
    ['https://example.org/page#one', 'https://example.org/page#one:~:text=highlight'],
] ) {
    assert.throws(() => normalize(category('Existing', [first]), category('New', [second])),
        { message: 'Page already in Existing.' });
}
for ( const entry of ['*', 'https://example.org/path/*', 'ftp://example.org/file',
    'https://user:pass@example.org/', 'https://example.org/?next=*', 'example.org:123/*'] ) {
    assert.throws(() => normalize(category('Invalid', [entry])), /Enter a page address/, entry);
}
assert.throws(() => normalize(category('Same', []), category(' same ', [])), /already used/);
assert.throws(() => normalize(category(' ', [])), /category name/);
const routed = normalize(category('Private', ['https://app.example/#/private']),
    category('Public', ['https://app.example/#/public']));
assert.equal(matchPersonalCategory('https://app.example/#/private', routed).name, 'Private');
assert.equal(matchPersonalCategory('https://app.example/#/public', routed).name, 'Public');
assert.equal(matchPersonalCategory('https://app.example/', routed), undefined);
const observation = { url: 'https://example.org/page', verdict: 'exclude', reasons: [{ kind: 'advertising' }] };
const display = personalDisplayRecord(observation, groups);
assert.equal(display.verdict, 'exclude', 'Showing a result must not grant index admission');
assert.deepEqual(display.personal_category, { name: 'Favorites', enabled: true });
assert.equal(observation.personal_category, undefined, 'Do not mutate shared observations');
assert.equal(personalDisplayRecord({ ...observation, original_url: 'https://other.test/secret' }, groups)
    .personal_category.enabled, false, 'Display overrides belong to the search-result address');

// Exercise the actual privileged save boundary, not just the editor's validation.
const source = readFileSync(new URL('../../src/js/queree/messaging.js', import.meta.url), 'utf8');
const writes = [];
const settings = { quereePersonalCategories: defaultPersonalCategories,
    quereeEnabled: true, quereeSimultaneousInspections: 6 };
let failWrite = false;
let pendingWrite;
const handle = vm.runInNewContext(source.slice(source.indexOf('let settingWrite ='),
    source.indexOf('export function registerQuereeMessaging')) + ';onMessage', {
    µb: { userSettings: settings, userSettingsDefault: { ...settings }, isReadyPromise: Promise.resolve() },
    validatePersonalCategories,
    vAPI: { messaging: { UNHANDLED: 'unhandled' } },
    browser: { storage: { local: { set: async value => {
        if ( pendingWrite ) { await pendingWrite; }
        if ( failWrite ) { throw Error('Storage unavailable'); }
        writes.push(value);
    } } } },
});
assert.equal(handle({ what: 'setPersonalCategories', categories: groups }, {}, () => assert.fail()), 'unhandled');
let reply;
await handle({ what: 'setPersonalCategories', categories: groups }, { privileged: true }, result => { reply = result; });
assert.equal(writes.length, 1);
assert.deepEqual(reply.categories, groups);
const saved = settings.quereePersonalCategories;
await handle({ what: 'setPersonalCategories', categories: [category('', [])] }, { privileged: true }, result => { reply = result; });
assert.match(reply.error, /category name/);
assert.equal(writes.length, 1);
failWrite = true;
await handle({ what: 'setPersonalCategories', categories: [] }, { privileged: true }, result => { reply = result; });
assert.equal(reply.error, 'Storage unavailable');
assert.equal(settings.quereePersonalCategories, saved, 'A failed save must restore the active settings');
console.log('Passed: personal-category normalization, membership, overlaps, display-only overrides and privileged persistence');

assert.equal(handle({ what: 'setUserSetting', name: 'quereeEnabled', value: false }, {},
    () => assert.fail()), 'unhandled');
for ( const [name, value] of [ ['quereeEnabled', 'false'], ['quereePersonalCategories', false],
    ['quereeSimultaneousInspections', 0], ['quereeSimultaneousInspections', 9],
    ['quereeSimultaneousInspections', true], ['quereeSimultaneousInspections', 1.5],
    ['unrelatedSetting', false] ] ) {
    await handle({ what: 'setUserSetting', name, value }, { privileged: true }, result => { reply = result; });
    assert.equal(reply.error, 'Invalid Quer.ee setting.');
}
await handle({ what: 'setUserSetting', name: 'quereeEnabled', value: false }, { privileged: true }, result => { reply = result; });
assert.equal(reply.error, 'Storage unavailable');
assert.equal(settings.quereeEnabled, true, 'Failed native writes restore the active value');
failWrite = false;
let release;
pendingWrite = new Promise(resolve => { release = resolve; });
let replies = 0;
const first = handle({ what: 'setUserSetting', name: 'quereeEnabled', value: false },
    { privileged: true }, () => { replies += 1; });
const second = handle({ what: 'setUserSetting', name: 'quereeEnabled', value: true },
    { privileged: true }, () => { replies += 1; });
await Promise.resolve();
assert.equal(replies, 0, 'A save is not acknowledged before Firefox finishes writing');
release();
await Promise.all([first, second]);
assert.equal(replies, 2);
assert.equal(settings.quereeEnabled, true);
assert.deepEqual(writes.slice(-2).map(value => value.quereeEnabled), [false, true],
    'Concurrent saves retain their requested order');

console.log('Passed: acknowledged native settings, validation and ordered saves');
