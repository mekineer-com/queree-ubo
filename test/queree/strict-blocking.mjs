import { CompiledListReader, CompiledListWriter } from '../../src/js/static-filtering-io.js';
import { AstFilterParser } from '../../src/js/static-filtering-parser.js';
import { FilteringContext } from '../../src/js/filtering-context.js';
import assert from 'node:assert/strict';
import { domainToASCII } from 'node:url';
import publicSuffixList from '../../src/lib/publicsuffixlist/publicsuffixlist.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { shouldStrictBlock } from '../../src/js/strict-blocking.js';
import staticNetFilteringEngine from '../../src/js/static-net-filtering.js';

// Exercise the frame's synchronous command boundary with the real native engine.
const root = { dataset: {}, addEventListener(type, fn) { this[type] = fn; } };
const parent = {};
let receiveMessage;
const frameSource = readFileSync(new URL(
    '../../src/js/queree/engine-frame.js', import.meta.url
), 'utf8');
runInNewContext(frameSource.replace(/^import .*;\n/gm, ''), {
    CompiledListReader, FilteringContext, publicSuffixList,
    staticNetFilteringEngine, shouldStrictBlock,
    document: { documentElement: root }, parent,
    addEventListener(type, fn) { receiveMessage = fn; },
});

const filters = [];
const cases = [];
const states = [ 'none', 'block', 'important', 'except' ];
const expected = [ [ 0, 1, 1, 2 ], [ 1, 1, 1, 2 ], [ 1, 1, 1, 1 ], [ 2, 2, 1, 2 ] ];
for ( let g = 0; g < states.length; g++ ) {
    for ( let s = 0; s < states.length; s++ ) {
        const hostname = `g${g}s${s}.example`;
        for ( const [ state, explicit ] of [ [ g, false ], [ s, true ] ] ) {
            if ( state === 0 ) { continue; }
            const options = [];
            if ( explicit ) { options.push('doc'); }
            if ( state === 2 ) { options.push('important'); }
            filters.push(`${state === 3 ? '@@' : ''}||${hostname}^${options.length ? '$' + options.join(',') : ''}`);
        }
        cases.push([ `${states[g]}/${states[s]}`, `https://${hostname}/page`, expected[g][s] ]);
    }
}
filters.push(
    '||add-friendso.blogspot.com^',
    '||explicit.example/path$doc',
    '||path.example/advertising',
    'boundary',
    '/^https?:\\/\\/fqdn\\.example\\.?\\//',
    '/.*/',
    '||skip.example^$doc,urlskip=?url',
    '||clean.example^$doc,removeparam=tracking',
    '@@||clean.example/keep$doc,removeparam=tracking',
    '||except-clean.example^$doc',
    '@@||except-clean.example^$doc',
    '||except-clean.example^$doc,removeparam=tracking',
    '||transform.example^$doc,uritransform=/old/new/',
    '||order.example^$doc,uritransform=/old/new/',
    '||order.example^$doc,removeparam=tracking',
    '||order.example^$doc,urlskip=?url',
    '||query-first.example^$doc,removeparam=tracking',
    '||query-first.example^$doc,urlskip=?url',
    '||blocked.example^',
    '||blocked.example^$doc,urlskip=?url -blocked',
    '||blocked.example^$doc,removeparam=tracking',
    '||blocked.example^$doc,uritransform=/old/new/'
);
filters.push('/about:blank.*/$popup,domain=peliculasmega1k.com');
cases.push(
    [ 'listed tenant', 'https://add-friendso.blogspot.com/', 1 ],
    [ 'listed descendant', 'https://sub.add-friendso.blogspot.com/', 1 ],
    [ 'unlisted tenant', 'https://other.blogspot.com/', 0 ],
    [ 'explicit path', 'https://explicit.example/path', 1 ],
    [ 'implicit path', 'https://path.example/advertising', 0 ],
    [ 'hostname end', 'https://boundary/', 1 ],
    [ 'hostname prefix only', 'https://boundary.example/', 0 ],
    [ 'path token only', 'https://ordinary.example/boundary', 0 ],
    [ 'FQDN boundary', 'https://fqdn.example./', 1 ],
    [ 'tokenless pattern', 'https://ordinary.example/', 0 ]
);

const writer = new CompiledListWriter();
const parser = new AstFilterParser({
    trustedSource: true,
    maxTokenLength: staticNetFilteringEngine.MAX_TOKEN_LENGTH,
});
const compiler = staticNetFilteringEngine.createCompiler(parser);
compiler.start(writer);
for ( const filter of filters ) {
    parser.parse(filter);
    assert.equal(parser.hasError(), false, filter);
    assert.equal(compiler.compile(parser, writer), true, filter);
}
compiler.finish(writer);
parser.finish();
publicSuffixList.parse('example\ncom\nblogspot.com\n', domainToASCII);
receiveMessage({ source: parent, data: {
    what: 'load',
    pslSelfie: publicSuffixList.toSelfie(),
    compiledLists: [ writer.toString() ],
} });
assert.equal(root.dataset.quereeLoadState, 'ready', root.dataset.quereeLoadResult);

function match(url, type = 'main_frame', originURL = url) {
    root.dataset.quereeCommand = JSON.stringify({
        what: 'matchRequest',
        details: { url, type, originURL, tabOriginURL: originURL, method: 'GET' },
    });
    root.quereePolicyCommand();
    const response = JSON.parse(root.dataset.quereeResponse);
    assert.equal(response.error, undefined);
    return response;
}

for ( const [ label, url, result ] of cases ) {
    for ( const logging of [ false, true ] ) {
        const context = new FilteringContext().fromDetails({ url, originURL: url, type: 'main_frame' });
        const native = shouldStrictBlock(context, logging);
        assert.equal(native.result, result, `${label}, logging=${logging}`);
        assert.equal(context.type, 'main_frame', label);
        assert.deepEqual(match(url), { result, raw: native.logData?.raw || '' }, label);
    }
}

const target = 'https://destination.example/article?keep=1#section';
const encoded = encodeURIComponent(target);
assert.equal(match(`https://skip.example/?url=${encoded}`).redirectURL, target);
assert.equal(match('https://clean.example/?tracking=x&keep=1#section').redirectURL,
    'https://clean.example/?keep=1#section');
assert.equal(match('https://clean.example/keep?tracking=x').redirectURL, undefined);
const excepted = match('https://except-clean.example/?tracking=x&keep=1');
assert.equal(excepted.result, 2);
assert.equal(excepted.redirectURL, 'https://except-clean.example/?keep=1',
    'explicitly allowed roots still use native modifiers');
assert.equal(excepted.raw, '@@||except-clean.example^$document',
    'modifier matching must not replace the selected exception evidence');
assert.equal(match('https://transform.example/old').redirectURL, 'https://transform.example/new');
assert.equal(match(`https://order.example/old?tracking=x&url=${encoded}`).redirectURL,
    `https://order.example/new?tracking=x&url=${encoded}`, 'transform takes precedence');
assert.equal(match(`https://query-first.example/?tracking=x&url=${encoded}`).redirectURL,
    `https://query-first.example/?url=${encoded}`, 'removeparam precedes urlskip');
const blocked = match(`https://blocked.example/old?tracking=x&url=${encoded}`);
assert.equal(blocked.result, 1);
assert.equal(blocked.redirectURL, undefined, 'blocked roots must not be cleaned or skipped');
assert.equal(blocked.raw, '||blocked.example^', 'retain the selected blocking rule');
assert.equal(match('https://transform.example/old').redirectURL, 'https://transform.example/new');
assert.equal(match('https://transform.example/old', 'script').redirectURL, undefined,
    'a reused context must not leak a previous redirect into a subresource');
assert.equal(match('https://transform.example/old').redirectURL, 'https://transform.example/new');
assert.equal(match('https://ordinary.example/').redirectURL, undefined,
    'a reused context must not leak a previous redirect into a root');
assert.equal(match('https://path.example/advertising', 'script').result, 1,
    'subresources retain ordinary matching, not strict-block hostname validation');
assert.equal(match('about:blank', 'popup', 'https://peliculasmega1k.com/').raw,
    '/about:blank.*/$popup,from=peliculasmega1k.com', 'Native popup rules support non-HTTP targets');

console.log(`Strict blocking: ${cases.length} root cases with logging on/off, native modifiers and frame command boundary passed`);
