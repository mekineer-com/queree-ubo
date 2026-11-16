import { contributionObservation, maxDocumentBodyBytes } from '../../src/js/queree/contribution-core.js';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../..', import.meta.url));
const source = readFileSync(
    root + '/src/js/queree/document-capture.js',
    'utf8'
);

function capture({ title = '', body = '', robots = [], contentType = 'text/html' } = {}) {
    return vm.runInNewContext(source, {
        TextEncoder,
        document: {
            contentType,
            title,
            body: { innerText: body },
            querySelectorAll: selector => {
                assert.equal(selector, 'meta[name="robots" i]');
                return robots.map(content => ({ content }));
            },
        },
        location: { href: 'https://example.net/article#section' },
    });
}

for ( const contentType of [ 'text/plain', 'application/pdf', 'application/json', 'image/svg+xml' ] ) {
    const document = capture({ contentType, body: 'Must not be contributed' });
    assert.equal(document, undefined, contentType);
    assert.equal(contributionObservation({ verdict: 'candidate', url: 'https://example.net/',
        observed_at: new Date().toISOString(), document }, {}), undefined);
}
assert.equal(capture({ contentType: 'application/xhtml+xml', body: 'XHTML' }).body, 'XHTML');

const result = capture({
    title: '\0  A   Per\0sonal\tPage  \0',
    body: '\0 Navigation  link\n\0\n First\tpara\0graph. \r\n Second paragraph. \0',
    robots: [ ' noindex, follow ', '', 'max-snippet:50' ],
});
assert.equal(result.schema, 1);
assert.equal(result.url, 'https://example.net/article#section');
assert.equal(result.title, 'A Personal Page');
assert.equal(
    result.body,
    'Navigation link\nFirst paragraph.\nSecond paragraph.'
);
assert.deepEqual(
    JSON.parse(JSON.stringify(result.indexing_directives.meta_robots)),
    [ 'noindex, follow', 'max-snippet:50' ]
);
assert.equal(result.indexing_directives.complete, true);
assert.equal(result.truncated, false);
assert.deepEqual(
    JSON.parse(JSON.stringify(result.indexing_directives.x_robots_tag)),
    []
);
assert.equal(result.extraction_version, 'rendered-text-v2');

for ( const size of [ 40000, maxDocumentBodyBytes, maxDocumentBodyBytes + 1 ] ) {
    const bounded = capture({ body: 'x'.repeat(size) });
    assert.equal(bounded.body.length, Math.min(size, maxDocumentBodyBytes));
    assert.equal(bounded.truncated, size > maxDocumentBodyBytes);
}
for ( const character of [ '\u00e9', '\u6c34', '\u{1f331}' ] ) {
    const unitBytes = new TextEncoder().encode(character).length;
    const prefix = character.repeat(Math.floor(maxDocumentBodyBytes / unitBytes));
    assert.equal(capture({ body: prefix }).truncated, false);
    const bounded = capture({ body: prefix + character });
    assert.equal(bounded.body, prefix);
    assert.equal(bounded.truncated, true);
    assert(new TextEncoder().encode(bounded.body).length <= maxDocumentBodyBytes);
}
const splitPair = capture({ body: 'x'.repeat(maxDocumentBodyBytes - 1) + '\u{1f331}' });
assert.equal(splitPair.body, 'x'.repeat(maxDocumentBodyBytes - 1));
assert.equal(splitPair.truncated, true);
assert.equal(capture({ title: '\u{1f331}'.repeat(513) }).title, '\u{1f331}'.repeat(512));
assert.ok(capture({ title: 't'.repeat(600) }).title.length === 512);
for ( const [ robots, withdraw ] of [
    [ [ 'noindex', ...Array(8).fill('index, follow') ], true ],
    [ [ 'none', 'follow,'.repeat(100) ], true ],
    [ [ `noindex,${'follow,'.repeat(100)}` ], true ],
    [ Array(8).fill('index, follow').concat('noindex'), false ],
    [ [ `${'index,'.repeat(100)}noindex` ], false ],
] ) {
    const document = capture({ title: 'Private title', body: 'Private text', robots });
    assert.equal(document.indexing_directives.complete, false);
    const observation = contributionObservation({
        verdict: 'candidate', observed_at: new Date(5000).toISOString(), document,
    }, {});
    if ( withdraw ) {
        assert.equal(observation.document.title, '');
        assert.equal(observation.document.body, '');
        assert.deepEqual(observation.document.indexing_directives,
            { complete: true, meta_robots: [ 'noindex' ], x_robots_tag: [] });
    } else {
        assert.equal(observation, undefined,
            'Incomplete captures cannot be admitted or infer noindex from discarded text');
    }
}

console.log('Passed: document capture is normalized and bounded');
