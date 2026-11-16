import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/js/queree/search-results.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function helper(name) {
    const match = source.match(new RegExp(`^    (?:async )?function ${name}\\([\\s\\S]*?^    }`, 'm'));
    assert.ok(match, `Missing source helper: ${name}`);
    return match[0];
}

// A small DOM double for the adapter shapes, not a remote-HTML parser.
function element(tag, text = '') {
    let textNode = { textContent: text };
    return {
        tagName: tag.toUpperCase(), children: [], style: {}, dataset: {}, attributeValues: {},
        checkVisibility() { return this.visible !== false; },
        get sheet() { return tag === 'style' ? { cssRules: [ { cssText: text } ] } : undefined; },
        get attributes() { return Object.entries(this.attributeValues).map(([name, value]) => ({ name, value })); },
        get classList() { return { add: name => { this.className += ` ${name}`; } }; },
        get textContent() { return text + this.children.map(node => node.textContent).join(''); },
        set textContent(value) { text = value; textNode = { textContent: value }; this.children = []; },
        get firstChild() { return text ? textNode : this.children[0] || null; },
        get lastElementChild() { return this.children.at(-1) || null; },
        setAttribute(name, value) { this.attributeValues[name] = value; this[name] = value; },
        getAttribute(name) { return this.attributeValues[name] ?? this[name] ?? null; },
        hasAttribute(name) { return this.getAttribute(name) !== null; },
        removeAttribute(name) { delete this.attributeValues[name]; delete this[name]; },
        matches(selector) {
            if ( selector === '*' ) { return true; }
            const role = selector.match(/^\[role="([^"]+)"\]$/);
            if ( role !== null ) { return this.getAttribute('role') === role[1]; }
            if ( selector === '#b_results > li.b_algo h2' ) {
                return tag === 'h2' && this.closest('li.b_algo') !== null;
            }
            if ( selector === '#b_results > li.b_algo' ) { selector = 'li.b_algo'; }
            if ( selector === ':is(.news-card, .newscard)' ) {
                return this.matches('.news-card') || this.matches('.newscard');
            }
            if ( selector === '.news-card a.title' || selector === '.newscard a.title' ) {
                return this.matches('a.title') && this.closest(selector.split(' ')[0]) !== null;
            }
            if ( selector === '.b_caption p' ) {
                return tag === 'p' && this.closest('.b_caption') !== null;
            }
            const match = selector.match(/^([a-z0-9]+)?(?:#([\w-]+))?(?:\.([\w-]+))?(\[href\])?$/i);
            return match !== null && (match[1] === undefined || match[1] === tag) &&
                (match[2] === undefined || match[2] === this.id) &&
                (match[3] === undefined || (this.className || '').split(' ').includes(match[3])) &&
                (match[4] === undefined || typeof this.href === 'string');
        },
        closest(selector) {
            return this.matches(selector) ? this : this.parentElement?.closest(selector) || null;
        },
        querySelectorAll(selector) {
            return this.children.flatMap(node => [
                ...(selector.split(',').some(part => node.matches(part.trim())) ? [ node ] : []),
                ...node.querySelectorAll(selector),
            ]);
        },
        querySelector(selector) {
            if ( selector === ':scope > .b_pag' ) {
                return this.children.find(node => node.matches('.b_pag')) || null;
            }
            return this.querySelectorAll(selector)[0] || null;
        },
        append(...nodes) { for ( const node of nodes ) { this.insertBefore(node, null); } },
        after(node) {
            const siblings = this.parentElement.children;
            this.parentElement.insertBefore(node, siblings[siblings.indexOf(this) + 1] || null);
        },
        insertBefore(node, before) {
            node.remove();
            node.parentElement = this;
            this.children.splice(before === null ? this.children.length : this.children.indexOf(before), 0, node);
        },
        remove() {
            if ( !this.parentElement ) { return; }
            const siblings = this.parentElement.children;
            siblings.splice(siblings.indexOf(this), 1);
            this.parentElement = null;
        },
        cloneNode(deep) {
            const clone = Object.assign(element(tag, text), { className: this.className, href: this.href });
            for ( const [ name, value ] of Object.entries(this.attributeValues) ) { clone.setAttribute(name, value); }
            if ( deep ) { clone.append(...this.children.map(node => node.cloneNode(true))); }
            return clone;
        },
        addEventListener(type, callback) { this[type] = callback; },
    };
}

function fixture(engine = 'Google', previous) {
    const news = engine === 'Bing News';
    const bing = engine.startsWith('Bing');
    const location = new URL(previous?.state.location.href || `https://www.${bing ? 'bing' : 'google'}.com/${news ? 'news/' : ''}search?q=pond`);
    const body = previous?.body || element('body');
    const panelRoot = previous?.panelRoot || element('div');
    panelRoot.id = news ? 'contentid' : bing ? 'b_content' : 'search';
    const root = previous?.root || element(bing && !news ? 'ol' : 'div');
    root.id = news ? 'algocore' : bing ? 'b_results' : 'rso';
    if ( previous === undefined ) { body.append(panelRoot); panelRoot.append(root); }
    const timers = new Map();
    const frames = [];
    const imports = [];
    let timerId = 0;
    let now = 0;
    const state = {
        URL, TextDecoder, Uint8Array, atob, location, Date: { now: () => now },
        enabled: true, running: false, generation: 1, simultaneousInspections: 6, processed: new WeakMap(),
        settingsRevision: -1, sourceControls: undefined,
        activeBatches: new Set(),
        paginationTarget: 10, paginationAuto: true, paginationComplete: false, paginationLoading: false,
        paginationNext: undefined, paginationCancel: undefined, paginationButton: undefined,
        paginationSource: undefined, mobileInspection: { mobile: false },
        requireSingleDomain: false, excludeAdvertisingSignals: true, excludeCrossSiteTracking: true, excludeShoppingSignals: true,
        recorded: new Map(), panel: element('aside'), window: { innerWidth: 1000, innerHeight: 800 },
        setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: id => timers.delete(id), scans: 0,
        scheduleScan() { state.scans += 1; },
        document: {
            URL: location.href, readyState: 'complete', hidden: false, body, documentElement: body,
            get baseURI() { return this.URL; },
            querySelectorAll: selector => body.querySelectorAll(selector),
            querySelector: selector => body.querySelector(selector),
            importNode(node, deep) {
                imports.push({ node, deep });
                return node.cloneNode(deep);
            },
            createElement(tag) {
                const node = element(tag);
                if ( tag === 'iframe' ) {
                    node.contentDocument = { URL: 'about:blank', readyState: 'complete', querySelector: () => null };
                    frames.push(node);
                }
                return node;
            },
        },
    };
    const names = [ 'searchEngineAdapter', 'resultAnchor', 'resultContent', 'resultURL', 'resultTitle',
        'reasonApplies', 'excludedBySettings', 'hiddenBySettings', 'searchIdentity', 'nextResultURL', 'nextResultPage',
        'restorePagination', 'resultCounts', 'needsCharacteristicMeasurement',
        'loadNativeResultPage', 'loadNextResultPage', 'appendResultPage', 'renderPagination', 'maybeLoadMore',
        'onResultClick', 'onPageShow', 'collect' ];
    const api = vm.runInNewContext(names.map(helper).join('\n') +
        '\nlet adapter = searchEngineAdapter(location.hostname, location.pathname);' +
        `\n;({ ${names.join(', ')}, get adapter() { return adapter; } })`, state);
    api.restorePagination();
    state.sourceSearchIdentity = api.searchIdentity(location.href, true);
    function result(url, title = 'Search title', description = 'Search description') {
        const row = element(bing && !news ? 'li' : 'div');
        row.className = news ? 'news-card' : bing ? 'b_algo' : 'MjjYud';
        const heading = element(news ? 'a' : bing ? 'h2' : 'h3', bing ? '' : title);
        const anchor = news ? heading : element('a', bing ? title : '');
        anchor.href = url;
        if ( news ) {
            anchor.className = 'title itemlink';
            anchor.append(element('h2', title));
            row.append(anchor);
        }
        else if ( bing ) { heading.append(anchor); row.append(heading); }
        else { anchor.append(heading); row.append(anchor); }
        const caption = element('div', bing && !news ? '' : description);
        caption.className = news ? 'snippet' : bing ? 'b_caption' : 'VwiC3b';
        if ( bing && !news ) { caption.append(element('p', description)); }
        row.append(caption);
        root.append(row);
        return { row, heading, anchor };
    }
    function next(href, wrapped = false) {
        const anchor = element('a');
        anchor.href = href;
        if ( bing ) { anchor.className = 'sb_pagN'; }
        else if ( wrapped ) { const span = element('span'); span.id = 'nn'; anchor.append(span); }
        else { anchor.id = 'pnnext'; }
        body.append(anchor);
        return anchor;
    }
    function tick(ms = 250) {
        now += ms;
        const callbacks = [ ...timers.values() ];
        timers.clear();
        for ( const callback of callbacks ) { callback(); }
    }
    return { state, api, root, panelRoot, body, frames, imports, timers, result, next, tick };
}

function presentation(f) {
    let now = 0;
    let id = 0;
    const timers = new Map();
    const swaps = [];
    Object.assign(f.state, f.api, {
        mobileInspection: {}, activeItems: new Map(), activeBatches: new Set(['batch']), shuttingDown: false,
        emptyStored: false, hidingUnavailable: false, excludedVisible: false,
        stylesheetOperationsPending: 0, selectorReasons: new Map(), toggle: undefined,
        status: element('span', 'Restoring results'), summaryTimer: undefined, summaryHoldDuration: 2000,
        progressTimer: undefined, progressCompleted: 0, progressTotal: 0, progressDots: 0,
        selectorsForExcludedResult: anchor => [ anchor.href ],
        matchedExcludedContainers: () => Array.from(f.state.selectorReasons, () => ({})),
        getComputedStyle: () => ({ display: 'none' }),
        async addExclusionSelectors(selectors, replace = false) {
            if ( replace ) { f.state.selectorReasons.clear(); swaps.push(selectors); }
            for ( const [ selector, label ] of selectors ) { f.state.selectorReasons.set(selector, label); }
        },
        setTimeout(callback, delay) { timers.set(++id, { callback, at: now + delay }); return id; },
        clearTimeout: timer => timers.delete(timer),
    });
    const names = [ 'exclusionLabel', 'unresolvedLabel', 'renderInspectionTabLink', 'openInspectionTab', 'apply', 'rememberDecision', 'needsCharacteristicMeasurement', 'refreshCharacteristic', 'onMessage',
        'updateStatus', 'renderProgress', 'stopProgress', 'animateProgress', 'startProgress',
        'updateProgress', 'holdStatusSummary' ];
    const api = vm.runInNewContext(names.map(helper).join('\n') + `;({ ${names.join(', ')} })`, f.state);
    Object.assign(f.state, api);
    return { ...api, swaps, async advance(ms) {
        const end = now + ms;
        for (;;) {
            const next = [ ...timers ].sort((a, b) => a[1].at - b[1].at)[0];
            if ( next === undefined || next[1].at > end ) { break; }
            now = next[1].at;
            timers.delete(next[0]);
            next[1].callback();
            await settle();
        }
        now = end;
    } };
}

for ( const engine of [ 'Google', 'Bing' ] ) {
    test(`${engine}: credential-bearing direct and decoded result URLs are skipped`, () => {
        const f = fixture(engine);
        for ( const url of [ 'https://user@personal.example/', 'https://:pass@personal.example/',
            'https://user:pass@personal.example/' ] ) {
            f.result(url);
            f.result(engine === 'Google'
                ? `https://www.google.com/url?q=${encodeURIComponent(url)}`
                : `https://www.bing.com/ck/a?u=a1${Buffer.from(url).toString('base64url')}`);
        }
        f.result('https://personal.example/ordinary');
        assert.deepEqual(Array.from(f.api.collect(), item => item.url), [ 'https://personal.example/ordinary' ]);
    });
}

test('Finished ad, tracking and shopping findings stay finished when their display filters are off', () => {
    const f = fixture();
    const p = presentation(f);
    Object.assign(f.state, { excludeAdvertisingSignals: false, excludeCrossSiteTracking: false, excludeShoppingSignals: false });
    for ( const [ kind, text ] of [ [ 'advertising', 'Advertising' ], [ 'cross_site_tracking', 'Cross-site tracking' ], [ 'commercial_store', 'Shopping' ] ] ) {
        f.result(`https://personal.example/${kind}`);
        const [ item ] = f.api.collect();
        const decision = { verdict: 'exclude', reasons: [ { kind } ] };
        p.rememberDecision(item, decision);
        p.apply(item, decision, []);
        assert.equal(item.heading.querySelector('.queree-unresolved'), null);
        assert.equal(item.heading.querySelector('.queree-characteristic').textContent, text);
        p.apply(item, { verdict: 'candidate' }, []);
        assert.equal(item.heading.querySelector('.queree-characteristic'), null);
    }
    assert.equal(f.api.resultCounts().retained, 3);
    p.updateStatus();
    assert.equal(f.state.status.textContent, '0 excluded, 0 unresolved (still checking)');
    f.result('https://personal.example/unresolved');
    const [ unfinished ] = f.api.collect();
    p.apply(unfinished, { verdict: 'unresolved', reasons: [ { kind: 'timeout' } ] }, []);
    assert.ok(unfinished.heading.querySelector('.queree-unresolved'));
    p.updateStatus();
    assert.equal(f.state.status.textContent, '0 excluded, 1 unresolved (still checking)');
});

test('Shopping negatives avoid rebuilds; changed exclusions preserve labels without interrupting progress', async () => {
    const f = fixture();
    const p = presentation(f);
    f.result('https://personal.example/ordinary');
    f.result('https://personal.example/shopping');
    const items = f.api.collect();
    Object.assign(f.state, { running: true, activeItems: new Map(items.map(item => [ item.id, item ])) });
    p.startProgress(items);
    const deliver = (item, decision) => p.onMessage({ what: 'quereeInspectionProgress',
        batchId: 'batch', decision: { id: item.id, ...decision } });
    const panel = f.state.panel;
    deliver(items[0], { verdict: 'candidate', shopping_signals: false });
    await settle();
    assert.equal(p.swaps.length, 0, 'A missing-to-false Shopping signal does not rebuild the list');
    await p.advance(400);
    assert.equal(f.state.status.textContent, '1 of 2 results inspected.');
    const shopping = { verdict: 'exclude', shopping_signals: true, reasons: [ { kind: 'commercial_store' } ] };
    deliver(items[1], shopping);
    await settle();
    assert.equal(p.swaps.length, 1, 'An actual Shopping mismatch still refreshes the hiding rules');
    assert.equal(f.state.selectorReasons.size, 1);
    deliver(items[0], { verdict: 'candidate', shopping_signals: false });
    deliver(items[1], shopping);
    await settle();
    assert.equal(p.swaps.length, 1, 'Repeated final decisions do not rebuild again');
    deliver(items[1], { verdict: 'exclude', reasons: [ { kind: 'cross_site_tracking' } ] });
    await settle();
    assert.equal(f.state.selectorReasons.get(items[1].url), 'Cross-site tracking');
    assert.equal(p.swaps.length, 1, 'A new finished reason updates its label without restarting progress');
    await p.advance(400);
    assert.equal(f.state.status.textContent, '2 of 2 results inspected..');
    deliver(items[1], { verdict: 'candidate', shopping_signals: false });
    await settle();
    assert.equal(p.swaps.length, 2, 'A released result removes stale hiding selectors');
    assert.equal(f.state.selectorReasons.size, 0);
    assert.equal(f.state.summaryTimer, undefined, 'Rebuilding during inspection must not replace progress');
    await p.advance(400);
    assert.equal(f.state.status.textContent, '2 of 2 results inspected...');
    assert.equal(f.state.panel, panel);

    p.stopProgress();
    Object.assign(f.state, { running: false, activeBatches: new Set() });
    p.holdStatusSummary();
    f.result('https://personal.example/later');
    const later = f.api.collect().filter(item => f.state.recorded.has(item.url) === false);
    p.startProgress([ ...later, later[0] ]);
    assert.equal(f.state.progressTotal, 3, 'Appended pages keep cumulative deduplicated counts');
    await p.advance(1999);
    assert.equal(f.state.status.textContent, '0 excluded, 0 unresolved');
    await p.advance(1);
    assert.match(f.state.status.textContent, /^2 of 3 results inspected/);
    p.stopProgress();
});

test('Finished single-domain measurements replace provisional hiding labels', async () => {
    for ( const single_domain of [ false, true ] ) {
        const f = fixture();
        const p = presentation(f);
        Object.assign(f.state, { requireSingleDomain: true, running: true });
        f.result('https://personal.example/measured');
        const [ item ] = f.api.collect();
        const selectors = [];
        p.apply(item, undefined, selectors);
        await f.state.addExclusionSelectors(selectors);
        const decision = { verdict: 'candidate', single_domain };
        assert.equal(p.rememberDecision(item, decision), true);
        p.apply(item, decision, []);
        await p.refreshCharacteristic(false);
        assert.equal(f.state.selectorReasons.size, single_domain ? 0 : 1);
        if ( single_domain === false ) {
            assert.equal(f.state.selectorReasons.get(item.url), 'Not single-domain');
        }
    }
});

for ( const engine of [ 'Google', 'Bing' ] ) {
    test(`${engine}: real resultURL strips directives without erasing route fragments`, () => {
        const f = fixture(engine);
        for ( const [ href, expected ] of [
            [ 'https://personal.example/article#:~:text=highlight', 'https://personal.example/article' ],
            [ 'https://personal.example/article#chapter:~:text=highlight', 'https://personal.example/article#chapter' ],
            [ 'https://personal.example/article#other', 'https://personal.example/article#other' ],
        ] ) {
            const { anchor } = f.result(href);
            assert.equal(f.api.resultURL(anchor).href, expected);
        }
    });

    test(`${engine}: next links preserve query, origin, path and increasing offset`, () => {
        const f = fixture(engine);
        const offset = f.api.adapter.offsetParameter;
        for ( const href of [
            `https://other.example/search?q=pond&${offset}=10`,
            `http://${f.state.location.host}/search?q=pond&${offset}=10`,
            `/sorry/?q=pond&${offset}=10`, `/search?q=other&${offset}=10`,
            `/search?q=pond&${offset}=0`, `/search?q=pond&${offset}=-10`,
            '/search?q=pond', `/search?q=pond&${offset}=NaN`,
            `/search?q=pond&${offset}=nope`, `/search?q=pond&${offset}=1.5`,
            'http://[', 'javascript:alert(1)',
        ] ) { f.next(href); }
        assert.equal(f.api.nextResultPage(), null, 'Invalid next links are skipped, not thrown or followed');
        const href = `/search?q=pond&${offset}=10&engineToken=keep`;
        f.next(href, true);
        assert.equal(f.api.nextResultPage(), new URL(href, f.state.location).href);
        assert.equal(f.api.nextResultPage(f.state.document,
            `${f.state.location.href}&${offset}=10`), null, 'A fetched page cannot point backwards or to itself');
    });

    test(`${engine}: keyboard-added query padding cannot stop paging when every result is excluded`, async () => {
        const f = fixture(engine);
        f.state.location.searchParams.set('q', ' short shorts ');
        const clean = new URL(f.state.location);
        clean.searchParams.set('q', 'short shorts');
        clean.searchParams.set(f.api.adapter.offsetParameter, '10');
        f.next(clean.href);
        f.result('https://shop.example/shorts');
        f.state.recorded.set('https://shop.example/shorts', {
            verdict: 'exclude', reasons: [ { kind: 'advertising' } ],
        });
        assert.equal(f.api.resultCounts().retained, 0);
        assert.equal(f.api.nextResultPage(), clean.href);
        const loading = f.api.maybeLoadMore();
        assert.equal(f.frames.length, 1, 'Follow the native next link despite zero retained results');
        assert.equal(f.frames[0].src, clean.href);
        f.state.paginationAuto = false;
        f.state.paginationCancel();
        await loading;
        const quoted = new URL(clean);
        quoted.searchParams.set('q', '"short shorts "');
        const different = new URL(quoted);
        different.searchParams.set('q', '"short shorts"');
        assert.notEqual(f.api.searchIdentity(quoted), f.api.searchIdentity(different),
            'Spaces inside quotes remain part of the query');
    });

    test(`${engine}: append discards duplicate directives, preserves routes and source order`, () => {
        const f = fixture(engine);
        const page = fixture(engine);
        const old = f.result('https://personal.example/article');
        page.result('https://personal.example/article#:~:text=duplicate');
        const first = page.result('https://personal.example/article#chapter:~:text=highlight', '<b>Plain title</b>');
        page.result('https://personal.example/article#chapter:~:text=another');
        page.result('https://personal.example/article#other');
        page.result('javascript:alert(1)');
        for ( const tag of [ 'script', 'style', 'link', 'base', 'meta', 'template', 'animate', 'set', 'audio', 'video' ] ) {
            const active = element(tag, tag === 'style' ? 'body { display:none }' : 'remoteCode()');
            active.setAttribute('autoplay', '');
            first.row.append(active);
        }
        for ( const href of [ 'javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,active', 'https://[invalid' ] ) {
            const link = element('a', 'Extra link');
            link.setAttribute('href', href);
            first.row.append(link);
        }
        const ordinaryLink = element('a', 'Cached page');
        ordinaryLink.setAttribute('href', 'https://personal.example/cached');
        first.row.append(ordinaryLink);
        const relativeLink = element('a', 'Relative link');
        relativeLink.setAttribute('href', '/relative');
        relativeLink.setAttribute('ping', 'https://ping.example/');
        first.row.append(relativeLink);
        const svgLink = element('a');
        svgLink.setAttribute('xlink:href', 'javascript:alert(1)');
        first.row.append(svgLink);
        first.anchor.setAttribute('onclick', 'remoteCode()');
        first.row.setAttribute('jscontroller', 'remoteController');
        const widget = element('div', 'About this result');
        widget.setAttribute('role', 'button');
        first.row.append(widget);
        const favicon = element('img');
        favicon.setAttribute('src', 'https://personal.example/favicon.ico');
        first.anchor.append(favicon);
        const address = element('cite', 'personal.example › article');
        first.row.append(address);
        first.heading.className = 'native-title';
        first.row.querySelector(f.api.adapter.descriptionSelector).className += ' native-caption';
        first.anchor.onclick = () => assert.fail('Remote event handler was copied');
        assert.equal(f.api.appendResultPage(page.state.document, page.state.location.href), 2);
        const items = Array.from(f.api.collect());
        assert.deepEqual(items.map(item => item.url), [
            'https://personal.example/article', 'https://personal.example/article#chapter',
            'https://personal.example/article#other',
        ]);
        assert.equal(items[0].anchor, old.anchor, 'Already loaded results survive appending');
        assert.equal(items[1].result_title, '<b>Plain title</b>');
        assert.equal(items[1].result_description, 'Search description');
        assert.equal(items[1].anchor.onclick, undefined);
        const copy = items[1].anchor.closest(f.api.adapter.containerSelector);
        assert.equal(copy.getAttribute('jscontroller'), null);
        assert.equal(copy.querySelector('[role="button"]'), null);
        assert.equal(copy.querySelector('img').getAttribute('src'), favicon.getAttribute('src'));
        assert.equal(copy.querySelector('cite').textContent, address.textContent);
        assert.equal(copy.querySelector(engine === 'Bing' ? 'h2' : 'h3').className, 'native-title');
        assert.ok(copy.querySelector('.native-caption'));
        assert.notEqual(copy, first.row, 'Copy the display without moving the rendered page');
        assert.equal(f.imports.length, 2);
        assert.equal(f.imports[0].node, first.row, 'Foreign results must be imported into this document, not cloned in their old realm');
        assert.equal(f.imports[0].deep, true);
        assert.equal(f.root.querySelectorAll('script').length, 0);
        assert.equal(copy.querySelectorAll('style, link, base, meta, template, animate, set, audio, video').length, 0);
        const links = copy.querySelectorAll('a');
        for ( const link of links.filter(node => node.textContent === 'Extra link') ) {
            assert.equal(link.getAttribute('href'), null, 'Active or malformed secondary links lose their targets');
        }
        assert.equal(links.find(node => node.textContent === 'Cached page').href, ordinaryLink.href);
        assert.equal(links.find(node => node.textContent === 'Relative link').href,
            new URL('/relative', page.state.document.baseURI).href);
        assert.equal(links.find(node => node.textContent === 'Relative link').getAttribute('ping'), null);
        assert.ok(links.every(node => node.getAttribute('xlink:href') === null));
        assert.ok(first.row.querySelector('style'), 'Sanitizing a clone must not alter the fetched document');
        assert.equal(f.api.appendResultPage(page.state.document), 0, 'Repeating a page adds nothing');
        f.state.recorded.set(items[0].url, { verdict: 'candidate' });
        f.state.recorded.set(items[1].url, { verdict: 'candidate' });
        f.result('https://personal.example/article#chapter:~:text=duplicate');
        assert.equal(f.api.resultCounts().retained, 2, 'Counting and collection use the same normalized keys');
    });

    test(`${engine}: copied links preserve the fetched document's effective base URI`, () => {
        const f = fixture(engine);
        const page = fixture(engine);
        page.state.document.URL = `${page.state.location.href}&${page.api.adapter.offsetParameter}=10`;
        const baseURI = 'https://personal.example/base/?from=base';
        Object.defineProperty(page.state.document, 'baseURI', { value: baseURI });
        const destination = new URL('article', baseURI).href;
        const result = page.result(destination);
        // Native anchors expose a resolved href while retaining the relative attribute.
        result.anchor.setAttribute('href', 'article');
        result.anchor.href = destination;
        for ( const attribute of [ 'href', 'xlink:href' ] ) {
            for ( const relative of [ 'details', '/elsewhere', '?page=2', '#chapter' ] ) {
                const link = element('a', `${attribute}: ${relative}`);
                link.setAttribute(attribute, relative);
                result.row.append(link);
            }
        }
        assert.equal(f.api.appendResultPage(page.state.document), 1);
        const [ item ] = f.api.collect();
        assert.equal(item.url, destination, 'The copied result keeps its original destination');
        const copy = item.anchor.closest(f.api.adapter.containerSelector);
        for ( const attribute of [ 'href', 'xlink:href' ] ) {
            for ( const relative of [ 'details', '/elsewhere', '?page=2', '#chapter' ] ) {
                const link = copy.querySelectorAll('a').find(node => node.textContent === `${attribute}: ${relative}`);
                assert.equal(link.getAttribute(attribute), new URL(relative, baseURI).href);
            }
        }
        assert.equal(result.anchor.getAttribute('href'), 'article', 'The fetched document stays unchanged');
    });
}

test('Google append prefers the inner result root and falls back to the adapter panel root', () => {
    for ( const innerRoot of [ true, false ] ) {
        const f = fixture();
        const page = fixture();
        page.result('https://personal.example/appended');
        if ( innerRoot === false ) { f.root.remove(); }
        assert.equal(f.api.appendResultPage(page.state.document), 1);
        const parent = innerRoot ? f.root : f.panelRoot;
        assert.equal(parent.children[0].className, 'MjjYud queree-appended-result');
        assert.equal(parent.children.length, 1, 'Do not append beside the preferred inner result root');
    }
});

test('Bing News reuses collection and card copying without matching regular Bing links', () => {
    const f = fixture('Bing News');
    const first = f.result('https://news.example/first', 'First article');
    f.result('https://news.example/second', 'Second article');
    const navigation = element('a', 'Not an article');
    navigation.className = 'title';
    navigation.href = 'https://www.bing.com/news/search?q=other';
    f.body.append(navigation);
    const items = f.api.collect();
    assert.deepEqual(Array.from(items, item => item.result_title), [ 'First article', 'Second article' ]);
    assert.equal(items[0].anchor, first.heading, 'The News title is itself the link');
    assert.equal(items[0].result_description, 'Search description', 'Read the News card snippet');
    const [ selector ] = f.api.adapter.exclusionSelectors([
        f.api.adapter.titlePath('[href="https://news.example/first"]'),
    ]);
    assert.equal(selector, ':is(.news-card, .newscard):has(a.title[href="https://news.example/first"])');
    assert.equal(f.api.nextResultPage(), null, 'Do not invent paging when Bing provides no next link');
    f.state.recorded.set(items[0].url, { verdict: 'exclude' });
    f.state.recorded.set(items[1].url, { verdict: 'candidate' });
    assert.equal(f.api.resultCounts().retained, 1);
    const appended = fixture('Bing News');
    assert.equal(appended.api.appendResultPage(f.state.document), 2);
    assert.equal(appended.api.collect().length, 2);
    assert.equal(appended.api.appendResultPage(f.state.document), 0);
});

test('Bing mobile News uses coreid/newscard markup and title links without heading tags', () => {
    const f = fixture('Bing News');
    f.panelRoot.id = 'coreid';
    f.root.id = 'coreresults';
    const first = f.result('https://news.example/mobile-one');
    const second = f.result('https://news.example/mobile-two');
    for ( const [ index, item ] of [ first, second ].entries() ) {
        item.row.className = 'newscard vr';
        item.anchor.textContent = `Mobile news ${index}`;
        item.row.querySelector('.snippet').remove();
    }
    const items = f.api.collect();
    assert.deepEqual(Array.from(items, item => item.result_title), [ 'Mobile news 0', 'Mobile news 1' ]);
    assert.equal(items[0].anchor, first.anchor);
    f.state.recorded.set(items[0].url, { verdict: 'exclude', reasons: [ { kind: 'advertising' } ] });
    f.state.recorded.set(items[1].url, { verdict: 'candidate' });
    assert.equal(f.api.resultCounts().retained, 1);
    const desktop = fixture('Bing News');
    assert.equal(desktop.api.appendResultPage(f.state.document), 2);
    assert.equal(desktop.api.collect().length, 2, 'The shared adapter also recognizes imported mobile cards');
});

function nativeNewsFixture() {
    const f = fixture('Bing News');
    const configuration = element('span');
    configuration.id = 'infinite-scroll-config';
    f.body.append(configuration);
    const calls = [];
    const loader = { StartAjax(force) { assert.equal(this, loader); calls.push(force); } };
    f.state.window.wrappedJSObject = { ResponsiveNewsInfiniteScroll: loader };
    f.result('https://news.example/first');
    f.state.recorded.set('https://news.example/first', { verdict: 'candidate' });
    return { ...f, configuration, calls, loader };
}

test('Bing News exposes More for its native loader without inventing a Next URL', async () => {
    const f = nativeNewsFixture();
    assert.equal(f.api.nextResultPage(), null);
    f.api.renderPagination();
    assert.equal(f.state.paginationButton.textContent, 'More results');
    assert.equal(f.state.paginationButton.disabled, false);
    assert.equal(f.calls.length, 0);
    const pending = f.api.maybeLoadMore();
    assert.deepEqual(f.calls, [ true ], 'Force Bing to load without scrolling the reader');
    assert.equal(f.frames.length, 0);
    f.result('https://news.example/next');
    f.tick();
    await pending;
    assert.equal(f.state.scans, 1, 'Native cards use the existing inspection scan');
    assert.equal(f.imports.length, 0, 'Do not copy or rebuild cards Bing already inserted');
    assert.equal(f.api.collect().length, 2);
    assert.equal(f.timers.size, 0);
});

test('Stopping and resuming Bing News shares the existing native request', async () => {
    const f = nativeNewsFixture();
    const pending = f.api.maybeLoadMore();
    assert.equal(f.state.paginationButton.textContent, 'Stop loading');
    await f.api.maybeLoadMore();
    f.state.paginationButton.click({ isTrusted: true });
    assert.equal(f.state.paginationAuto, false);
    assert.equal(f.state.paginationLoading, true, 'Bing still owns the in-flight request');
    assert.equal(f.state.paginationButton.textContent, 'More results');
    f.state.paginationButton.click({ isTrusted: true });
    assert.equal(f.state.paginationAuto, true);
    assert.equal(f.state.paginationTarget, 11);
    assert.equal(f.calls.length, 1, 'Resume must not force a second request while the first is pending');
    f.result('https://news.example/next');
    f.tick();
    await pending;
    assert.equal(f.calls.length, 1);
    assert.equal(f.state.paginationLoading, false);
    assert.equal(f.state.paginationCancel, undefined);
});

test('Bing News stops at ten retained results and recognizes native loader removal', async () => {
    const f = nativeNewsFixture();
    for ( let i = 1; i < 10; i++ ) {
        const url = `https://news.example/${i}`;
        f.result(url);
        f.state.recorded.set(url, { verdict: 'candidate' });
    }
    await f.api.maybeLoadMore();
    assert.equal(f.state.paginationComplete, true);
    assert.equal(f.calls.length, 0);
    f.state.paginationButton.click({ isTrusted: true });
    assert.equal(f.state.paginationTarget, 20);
    assert.equal(f.calls.length, 1);
    f.configuration.remove();
    f.tick();
    await settle();
    assert.equal(f.state.paginationButton.textContent, 'No more results');
    assert.equal(f.api.resultCounts().retained, 10);
});

for ( const outcome of [ 'stop', 'navigation', 'timeout', 'throw' ] ) {
    test(`Bing native loading settles safely on ${outcome}`, async () => {
        const f = nativeNewsFixture();
        if ( outcome === 'throw' ) { f.loader.StartAjax = () => { throw Error('Native loader failed'); }; }
        const pending = f.api.maybeLoadMore();
        if ( outcome === 'stop' ) {
            f.state.paginationButton.click({ isTrusted: true });
            f.result('https://news.example/late');
            f.tick();
        } else if ( outcome === 'navigation' ) {
            f.state.enabled = false;
            f.state.generation++;
            f.state.paginationCancel();
        } else if ( outcome === 'timeout' ) { f.tick(30000); }
        await pending;
        assert.equal(f.state.paginationLoading, false);
        assert.equal(f.state.paginationCancel, undefined);
        assert.equal(f.timers.size, 0);
        assert.equal(f.api.resultCounts().retained, 1, 'Existing results stay intact');
        if ( outcome === 'stop' ) {
            assert.equal(f.state.paginationAuto, false);
            await f.api.maybeLoadMore();
            assert.equal(f.calls.length, 1, 'A stopped cycle cannot request another batch');
        }
        if ( outcome === 'timeout' || outcome === 'throw' ) {
            assert.equal(f.state.paginationButton.textContent, 'Next page unavailable. Retry');
        }
    });
}

test('A marker without Bing\'s loader cannot claim load-more support', () => {
    const f = nativeNewsFixture();
    delete f.state.window.wrappedJSObject.ResponsiveNewsInfiniteScroll.StartAjax;
    f.api.renderPagination();
    assert.equal(f.state.paginationButton, undefined);
});

test('Mobile Bing scrolls a hidden native page past duplicates without resetting the visible loader', async () => {
    const f = nativeNewsFixture();
    delete f.state.window.wrappedJSObject.ResponsiveNewsInfiniteScroll;
    f.state.window.wrappedJSObject.MobileNewsVerticalInfiniteScrollVNext = {
        Init() { assert.fail('Never reset the visible mobile loader'); },
    };
    f.api.collect();
    const saved = f.state.recorded.get('https://news.example/first');
    const pending = f.api.maybeLoadMore();
    const frame = f.frames[0];
    assert.equal(frame.src, f.state.location.href, 'Let Bing supply its own page offsets and requests');
    const page = fixture('Bing News');
    page.result('https://news.example/first');
    page.body.scrollHeight = 5000;
    let scrolls = 0;
    frame.contentWindow = { scrollTo(x, y) { assert.deepEqual([ x, y ], [ 0, 5000 ]); scrolls++; } };
    showPage(f, page);
    f.tick();
    assert.equal(scrolls, 1, 'Duplicate results keep the hidden scroller going');
    assert.notEqual(frame.parentElement, null);
    page.result('https://news.example/new');
    f.tick();
    await pending;
    assert.equal(frame.parentElement, null);
    assert.equal(f.state.recorded.get('https://news.example/first'), saved);
    assert.deepEqual(Array.from(f.api.collect(), item => item.url), [ 'https://news.example/new' ],
        'Existing cards and checks are not submitted for inspection again');
    assert.equal(f.calls.length, 0);
});

test('Stop cancels the mobile hidden page without removing visible results', async () => {
    const f = nativeNewsFixture();
    delete f.state.window.wrappedJSObject.ResponsiveNewsInfiniteScroll;
    f.state.window.wrappedJSObject.MobileNewsVerticalInfiniteScrollVNext = { Init() {} };
    const pending = f.api.maybeLoadMore();
    f.state.paginationButton.click({ isTrusted: true });
    await pending;
    assert.equal(f.frames[0].parentElement, null);
    assert.equal(f.state.paginationAuto, false);
    assert.equal(f.api.resultCounts().retained, 1);
    assert.equal(f.timers.size, 0);
});

test('Bing News is a search source, while Bing Videos remains outside inspection', () => {
    for ( const [ path, expected ] of [ [ '/search', true ], [ '/news/search', true ],
        [ '/videos/search', false ], [ '/images/search', false ] ] ) {
        assert.equal(vm.runInNewContext(helper('isSearchPage') + ';isSearchPage()', {
            location: new URL(`https://www.bing.com${path}?q=pond`),
        }), expected, path);
    }
    const registration = JSON.parse(readFileSync(new URL('../../platform/firefox/manifest.json', import.meta.url), 'utf8'))
        .content_scripts.find(item => item.js.includes('/js/queree/search-results.js'));
    assert.ok(registration.matches.includes('https://www.bing.com/news/search*'));
    assert.ok(registration.matches.every(pattern => pattern.includes('/videos/') === false));
});

test('Google grouped videos keep individual boundaries, descriptions and retained counts', () => {
    const f = fixture();
    const wrapper = element('div');
    wrapper.className = 'MjjYud';
    f.root.append(wrapper);
    const cards = [];
    for ( let i = 0; i < 10; i++ ) {
        const result = f.result(`https://video.example/${i}`, `Video ${i}`, `Description ${i}`);
        result.row.className = '';
        const card = element('div');
        wrapper.append(card);
        card.append(result.row);
        cards.push(card);
    }
    const items = f.api.collect();
    assert.equal(items.length, 10);
    assert.equal(wrapper.className, 'MjjYud', 'Do not mark the shared batch as an individual result');
    for ( let i = 0; i < items.length; i++ ) {
        assert.equal(items[i].result_description, `Description ${i}`);
        assert.equal(cards[i].matches('.queree-result'), true);
        assert.equal(cards[i].querySelectorAll('h3').length, 1);
        f.state.recorded.set(items[i].url, { verdict: i === 0 ? 'exclude' : 'candidate' });
    }
    assert.equal(f.api.resultCounts().retained, 9, 'One excluded video leaves its nine neighbors');
    const [ selector ] = f.api.adapter.exclusionSelectors([ 'a[href="https://video.example/0"] h3' ]);
    assert.equal(selector, ':is(.MjjYud, .queree-result):has(a[href="https://video.example/0"] h3):not(:has(:is(.MjjYud, .queree-result) a[href="https://video.example/0"] h3))');

    const next = fixture();
    assert.equal(next.api.appendResultPage(f.state.document), 10);
    assert.equal(next.api.collect().length, 10);
    assert.ok(next.root.children.every(row => row.querySelectorAll('h3').length === 1));
});

test('Google News role headings use the normal collection, exclusion and pagination paths', async () => {
    const page = fixture();
    const wrapper = element('div');
    wrapper.className = 'MjjYud';
    page.root.append(wrapper);
    for ( let i = 0; i < 10; i++ ) {
        const card = element('div');
        const anchor = element('a');
        anchor.href = `https://news.example/article-${i}`;
        const title = element('div', `Article ${i}`);
        title.setAttribute('role', 'heading');
        title.setAttribute('aria-level', '3');
        const description = element('div', `News description ${i}`);
        description.className = 'UqSP2b';
        anchor.append(title, description);
        card.append(anchor);
        wrapper.append(card);
    }
    const dialogTitle = element('div', 'Feedback');
    dialogTitle.setAttribute('role', 'heading');
    page.body.append(dialogTitle);
    const items = page.api.collect();
    assert.equal(items.length, 10, 'Ignore headings outside actual search-result links');
    assert.equal(wrapper.querySelectorAll('.queree-result').length, 10);
    for ( let i = 0; i < items.length; i++ ) {
        assert.equal(items[i].result_title, `Article ${i}`);
        assert.equal(items[i].result_description, `News description ${i}`);
    }
    assert.match(page.api.adapter.titlePath('a[href="https://news.example/article-0"]'), /\[role="heading"\]/);
    const f = fixture();
    f.state.location.searchParams.set('tbm', 'nws');
    page.state.document.URL = 'https://www.google.com/search?q=pond&tbm=nws&start=10';
    const loaded = f.api.loadNextResultPage(page.state.document.URL);
    showPage(f, page);
    f.tick();
    assert.equal(await loaded, page.state.document, 'A news-only page is recognized when it finishes loading');
    assert.equal(f.api.appendResultPage(page.state.document), 10);
    assert.equal(f.api.collect().length, 10);
    assert.equal(f.api.collect().length, 0, 'Do not inspect unchanged articles twice');
});

test('Copied results retain missing native styles without restyling the original page or duplicating CSS', () => {
    const f = fixture();
    const shared = element('style', '.native-title { color: blue; }');
    f.body.append(shared);
    const css = '.chapters { display:flex; width:max-content; } .chapter { flex:none; width:120px; }';
    for ( const suffix of [ 'first', 'second' ] ) {
        const page = fixture();
        page.body.append(element('style', shared.textContent));
        const result = page.result(`https://video.example/${suffix}`);
        const nativeStyle = element('style', css);
        result.row.append(nativeStyle);
        assert.equal(f.api.appendResultPage(page.state.document), 1);
        const copied = f.root.querySelector('.queree-appended-result');
        assert.equal(copied.querySelector('style'), null, 'Raw styles must not escape their result');
        assert.equal(result.row.querySelector('style'), nativeStyle, 'The source page stays intact');
    }
    const styles = f.root.querySelectorAll('style');
    assert.equal(styles.length, 1, 'Reuse card styles across additional pages; shared first-page CSS is not copied');
    assert.equal(styles[0].textContent, `:where(.queree-appended-result) {\n${css}\n}`);
    const duplicate = fixture();
    duplicate.result('https://video.example/first');
    duplicate.body.append(element('style', '.unused { color:red; }'));
    assert.equal(f.api.appendResultPage(duplicate.state.document), 0);
    assert.equal(f.root.querySelectorAll('style').length, 1, 'A duplicate-only page adds no styles');
});

for ( const engine of [ 'Google', 'Bing' ] ) {
    test(`${engine}: next links and rendered redirects preserve filters but tolerate tracking changes`, async () => {
        const filters = engine === 'Google'
            ? [ [ 'tbs', 'qdr:w' ], [ 'udm', '14' ], [ 'safe', 'active' ] ]
            : [ [ 'filters', 'ex1:ez5_1' ], [ 'scope', 'web' ], [ 'mkt', 'es-PE' ] ];
        for ( const [ name, value ] of filters ) {
            const f = fixture(engine);
            f.state.location.searchParams.set(name, value);
            const base = f.state.location.href;
            const next = new URL(base);
            next.searchParams.set(f.api.adapter.offsetParameter, '10');
            next.searchParams.set('tracking', 'new-next-token');
            const dropped = new URL(next);
            dropped.searchParams.delete(name);
            const changed = new URL(next);
            changed.searchParams.append(name, 'different');
            for ( const invalid of [ dropped, changed ] ) {
                assert.equal(f.api.nextResultURL(invalid.href, base), null, `Do not lose or change ${name}`);
                f.next(invalid.href);
            }
            f.next(next.href);
            assert.equal(f.api.nextResultPage(), next.href, 'Only the link preserving the selected filters is followed');
            const page = fixture(engine);
            page.result('https://personal.example/filtered');
            const rejected = f.api.loadNextResultPage(next.href);
            showPage(f, page).URL = dropped.href;
            f.tick();
            assert.equal(await rejected, undefined, `A rendered redirect cannot silently drop ${name}`);
            const accepted = f.api.loadNextResultPage(next.href);
            const doc = showPage(f, page);
            const tracked = new URL(next);
            tracked.searchParams.set('tracking', 'redirect-token');
            doc.URL = tracked.href;
            f.tick();
            assert.equal(await accepted, doc, 'Tracking-token changes do not change search identity');
        }
    });
}

for ( const [ label, decision, settings, expected ] of [
    [ 'pending', undefined, {}, 0 ],
    [ 'accepted', { verdict: 'candidate' }, {}, 1 ],
    [ 'unresolved', { verdict: 'unresolved' }, {}, 0 ],
    [ 'excluded', { verdict: 'exclude', reasons: [ { kind: 'advertising' } ] }, {}, 0 ],
    [ 'finished advertising shown', { verdict: 'exclude', checks_complete: true, shopping_signals: false, reasons: [ { kind: 'advertising' } ] }, { excludeAdvertisingSignals: false }, 1 ],
    [ 'tracking hidden', { verdict: 'exclude', reasons: [ { kind: 'cross_site_tracking' } ] }, {}, 0 ],
    [ 'finished tracking shown', { verdict: 'exclude', checks_complete: true, shopping_signals: false, reasons: [ { kind: 'cross_site_tracking' } ] }, { excludeCrossSiteTracking: false }, 1 ],
    [ 'fresh incomplete tracking does not reach target', { verdict: 'exclude', reasons: [ { kind: 'cross_site_tracking' } ] }, { excludeCrossSiteTracking: false }, 0 ],
    [ 'cached tracking awaits remaining checks', { verdict: 'exclude', cached: true, reasons: [ { kind: 'cross_site_tracking' } ] }, { excludeCrossSiteTracking: false }, 0 ],
    [ 'waived tracking with ads still hidden', { verdict: 'exclude', reasons: [ { kind: 'cross_site_tracking' }, { kind: 'advertising' } ] }, { excludeCrossSiteTracking: false }, 0 ],
    [ 'waived ads with tracking still hidden', { verdict: 'exclude', reasons: [ { kind: 'advertising' }, { kind: 'cross_site_tracking' } ] }, { excludeAdvertisingSignals: false }, 0 ],
    [ 'personal overrides tracking', { verdict: 'exclude', reasons: [ { kind: 'cross_site_tracking' } ], personal_category: { enabled: true } }, {}, 1 ],
    [ 'personal hides waived tracking', { verdict: 'exclude', reasons: [ { kind: 'cross_site_tracking' } ], personal_category: { enabled: false } }, { excludeCrossSiteTracking: false }, 0 ],
    [ 'finished shopping shown', { verdict: 'exclude', checks_complete: true, shopping_signals: true, reasons: [ { kind: 'commercial_store' } ] }, { excludeShoppingSignals: false }, 1 ],
    [ 'waived ads with shopping still hidden', { verdict: 'exclude', shopping_signals: true, reasons: [ { kind: 'advertising' } ] }, { excludeAdvertisingSignals: false }, 0 ],
    [ 'waived ads with another exclusion', { verdict: 'exclude', reasons: [ { kind: 'advertising' }, { kind: 'scam' } ] }, { excludeAdvertisingSignals: false }, 0 ],
    [ 'listed affiliate publisher hidden', { verdict: 'exclude', reasons: [ { kind: 'affiliate_publisher' } ] }, {}, 0 ],
    [ 'listed publisher shown when ads off', { verdict: 'exclude', checks_complete: true, shopping_signals: false, reasons: [ { kind: 'affiliate_publisher' } ] }, { excludeAdvertisingSignals: false }, 1 ],
    [ 'listed affiliate link hidden', { verdict: 'exclude', reasons: [ { kind: 'affiliate_tracked_link' } ] }, {}, 0 ],
    [ 'listed link shown when ads off', { verdict: 'exclude', checks_complete: true, shopping_signals: false, reasons: [ { kind: 'affiliate_tracked_link' } ] }, { excludeAdvertisingSignals: false }, 1 ],
    [ 'listed link still hidden by tracking', { verdict: 'exclude', reasons: [ { kind: 'affiliate_tracked_link' }, { kind: 'cross_site_tracking' } ] }, { excludeAdvertisingSignals: false }, 0 ],
    [ 'listed publisher still hidden by tracking', { verdict: 'exclude', reasons: [ { kind: 'affiliate_publisher' }, { kind: 'cross_site_tracking' } ] }, { excludeAdvertisingSignals: false }, 0 ],
    [ 'shopping observation', { verdict: 'candidate', shopping_signals: true }, {}, 0 ],
    [ 'shopping shown', { verdict: 'candidate', shopping_signals: true }, { excludeShoppingSignals: false }, 1 ],
    [ 'single-domain mismatch', { verdict: 'candidate', single_domain: false }, { requireSingleDomain: true }, 0 ],
    [ 'single-domain unconfirmed', { verdict: 'candidate' }, { requireSingleDomain: true }, 0 ],
    [ 'single-domain match', { verdict: 'candidate', single_domain: true }, { requireSingleDomain: true }, 1 ],
    [ 'personal hidden', { verdict: 'candidate', personal_category: { enabled: false } }, {}, 0 ],
    [ 'personal shown without inspection', { verdict: 'uninspected', personal_category: { enabled: true } }, { requireSingleDomain: true }, 1 ],
    [ 'file shown without inspection', { verdict: 'uninspected', domain_only: true, shopping_signals: false }, { requireSingleDomain: true }, 1 ],
    [ 'shopping-domain file hidden', { verdict: 'uninspected', domain_only: true, shopping_signals: true }, { requireSingleDomain: true, excludeShoppingSignals: true }, 0 ],
    [ 'waived file exclusion is finished', { verdict: 'exclude', domain_only: true, shopping_signals: false, reasons: [ { kind: 'advertising' } ] }, { requireSingleDomain: true, excludeAdvertisingSignals: false }, 1 ],
    [ 'personal unresolved', { verdict: 'unresolved', personal_category: { enabled: true } }, {}, 0 ],
    [ 'personal overrides observed exclusion', { verdict: 'exclude', shopping_signals: true, personal_category: { enabled: true } }, { requireSingleDomain: true }, 1 ],
] ) {
    test(`Finished retained count: ${label}`, () => {
        const f = fixture();
        const url = 'https://personal.example/article';
        f.result(url);
        f.result(`${url}#:~:text=duplicate`);
        if ( decision !== undefined ) { f.state.recorded.set(url, decision); }
        // Cached observations for results no longer in the DOM do not count.
        f.state.recorded.set('https://personal.example/gone', { verdict: 'candidate' });
        Object.assign(f.state, settings, { excludedVisible: true });
        assert.equal(f.api.resultCounts().retained, expected);
        if ( label === 'cached tracking awaits remaining checks' ) {
            assert.equal(f.api.resultCounts().pending, 1, 'Duplicate URLs count as one pending reinspection');
        }
        if ( label === 'fresh incomplete tracking does not reach target' ) {
            assert.equal(f.api.resultCounts().pending, 0, 'A timed-out fresh inspection stays incomplete, not pending forever');
        }
    });
}

function readyToPage(engine = 'Google') {
    const f = fixture(engine);
    f.result('https://personal.example/first');
    f.state.recorded.set('https://personal.example/first', { verdict: 'candidate' });
    f.next(`${f.state.location.pathname}?q=pond&${f.api.adapter.offsetParameter}=10`);
    return f;
}

function showPage(f, page, readyState = 'complete') {
    const frame = f.frames.at(-1);
    const doc = page.state.document;
    Object.assign(doc, { URL: frame.src, readyState });
    frame.contentDocument = doc;
    return doc;
}

function lifecycle(f) {
    Object.assign(f.state, {
        emptyTimer: undefined, scanTimer: undefined, summaryTimer: undefined,
        observer: undefined, style: undefined, toggle: undefined, mobileQ: undefined, mobileHelp: undefined,
        stopProgress() {}, changeStylesheets() {}, appliedStylesheets: new Set(),
        selectorReasons: new Map(), exclusionStylesheets: new Map(), activeItems: new Map(),
        shuttingDown: false, settingEnabled: true,
        MutationObserver: class { observe() {} disconnect() {} },
        scan() {}, retryMobileInspection() {}, isSearchPage: () => true, isGoogleImages: () => false,
    });
    const names = [ 'stop', 'start', 'syncSearchMode', 'onMessage' ];
    return vm.runInNewContext(names.map(helper).join('\n') + `;({ ${names.join(', ')} })`, f.state);
}

test('One frame at a time; Stop cancels without losing results, More resumes for ten more', async () => {
    const f = readyToPage();
    const pending = f.api.maybeLoadMore();
    assert.equal(f.frames.length, 1);
    assert.equal(f.state.paginationButton.textContent, 'Stop loading');
    await f.api.maybeLoadMore();
    assert.equal(f.frames.length, 1, 'Repeated scans cannot start a second page load');
    f.state.paginationButton.click({ isTrusted: true });
    await pending;
    assert.equal(f.frames[0].parentElement, null);
    assert.equal(f.timers.size, 0);
    assert.equal(f.state.paginationCancel, undefined);
    assert.equal(f.state.paginationLoading, false);
    assert.equal(f.state.paginationAuto, false);
    assert.equal(f.state.paginationButton.textContent, 'More results');
    assert.equal(f.api.resultCounts().retained, 1);
    f.state.paginationButton.click({ isTrusted: true });
    assert.equal(f.state.paginationTarget, 11, 'Resume requests ten beyond the currently retained count');
    assert.equal(f.frames.length, 2);
    assert.equal(f.frames[1].src, f.frames[0].src, 'Resume retries the canceled page');
    const page = fixture();
    page.result('https://personal.example/second');
    showPage(f, page);
    f.tick();
    await settle();
    assert.equal(f.state.scans, 1, 'Appended results go through the existing inspection scan');
    assert.equal(f.api.collect().length, 2);
    assert.equal(f.state.paginationNext, null);
    assert.equal(f.state.paginationButton.disabled, true);
    assert.equal(f.state.paginationButton.textContent, 'No more results');
    assert.equal(f.frames[1].parentElement, null);
});

for ( const engine of [ 'Google', 'Bing', 'Bing News' ] ) {
    test(`${engine}: following a result cancels only the fetch and Back resumes the same target`, async () => {
        const f = readyToPage(engine);
        const pending = f.api.maybeLoadMore();
        f.state.running = true;
        const anchor = f.root.querySelector('a[href]');
        f.api.onResultClick({ target: anchor, isTrusted: true, button: 0 });
        assert.equal(f.frames[0].parentElement, null, 'Cancel before the link navigates');
        await pending;
        assert.equal(f.state.paginationAuto, true, 'Navigation is not Stop');
        assert.equal(f.state.paginationButton.dataset.problem, undefined, 'Navigation is not a fetch failure');
        assert.equal(f.state.running, true, 'Website inspections keep running');
        const target = f.state.paginationTarget;
        const resumed = f.api.maybeLoadMore();
        assert.equal(f.frames.length, 2, 'If navigation leaves this document alive, normal loading can continue');
        let reconnects = 0;
        Object.assign(f.state, {
            vAPI: { messaging: { destroyPort() { reconnects += 1; } } },
            refreshSettings() { f.api.maybeLoadMore(); }, retryMobileInspection() {},
        });
        await f.api.onPageShow({ persisted: true });
        assert.equal(reconnects, 1);
        assert.equal(f.frames.length, 2, 'Back joins the existing fetch rather than duplicating it');
        assert.equal(f.frames[1].src, f.frames[0].src, 'Retry the interrupted page, not the first page');
        assert.equal(f.state.paginationTarget, target, 'Back does not request ten extra results');
        f.state.paginationButton.click({ isTrusted: true });
        await resumed;
        await settle();
        await f.api.onPageShow({ persisted: true });
        assert.equal(f.state.paginationAuto, false, 'Another Back cannot undo an explicit Stop');
        assert.equal(f.frames.length, 2, 'A stopped search stays stopped');
    });
}

test('Modified, new-tab, download and cancelled clicks leave pagination running', async () => {
    const f = readyToPage();
    const pending = f.api.maybeLoadMore();
    const anchor = f.root.querySelector('a[href]');
    const click = { target: anchor, isTrusted: true, button: 0 };
    for ( const extra of [ { isTrusted: false }, { defaultPrevented: true }, { button: 1 },
        { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true } ] ) {
        f.api.onResultClick({ ...click, ...extra });
    }
    for ( const target of [ '_blank', 'another-window' ] ) {
        anchor.setAttribute('target', target);
        f.api.onResultClick(click);
    }
    anchor.removeAttribute('target');
    anchor.setAttribute('download', '');
    f.api.onResultClick(click);
    anchor.removeAttribute('download');
    anchor.href = `${f.state.location.href}#section`;
    f.api.onResultClick(click);
    assert.notEqual(f.frames[0].parentElement, null);
    f.state.paginationButton.click({ isTrusted: true });
    await pending;
});

test('Paging keeps a full queue, stops at ten, and More advances the retained target', async () => {
    const f = readyToPage();
    f.state.recorded.clear();
    await f.api.maybeLoadMore();
    assert.equal(f.frames.length, 0, 'Initial results are inspected before fetching another page');
    f.state.recorded.set('https://personal.example/first', { verdict: 'candidate' });
    for ( let i = 0; i < 6; i++ ) { f.result(`https://pending.example/${i}`); }
    f.state.running = true;
    await f.api.maybeLoadMore();
    assert.equal(f.frames.length, 0, 'Do not fetch ahead while all inspection slots have waiting work');
    for ( let i = 1; i < 10; i++ ) {
        const url = `https://personal.example/${i}`;
        f.result(url);
        f.state.recorded.set(url, { verdict: 'candidate' });
    }
    await f.api.maybeLoadMore();
    assert.equal(f.frames.length, 0);
    assert.equal(f.state.paginationComplete, true, 'Reaching the target completes this loading cycle');
    assert.equal(f.state.paginationButton.textContent, 'More results');
    for ( let i = 0; i < 6; i++ ) {
        f.state.recorded.set(`https://pending.example/${i}`, { verdict: 'exclude', reasons: [ { kind: 'advertising' } ] });
    }
    f.state.paginationButton.click({ isTrusted: true });
    assert.equal(f.state.paginationTarget, 20);
    assert.equal(f.state.paginationComplete, false, 'More starts a fresh loading cycle');
    assert.equal(f.frames.length, 1);
    f.state.paginationButton.click({ isTrusted: true });
    await settle();
});

test('A slow final inspection does not hold idle slots; reaching ten cancels the next fetch', async () => {
    const f = readyToPage();
    f.state.simultaneousInspections = 4;
    f.state.running = true;
    f.result('https://slow.example/');
    const pending = f.api.maybeLoadMore();
    assert.equal(f.frames.length, 1, 'Fetch the next page while the slow inspection continues');
    const page = fixture();
    for ( let i = 0; i < 10; i++ ) { page.result(`https://next.example/${i}`); }
    page.next('https://www.google.com/search?q=pond&start=20');
    showPage(f, page);
    f.tick();
    await pending;
    await f.api.maybeLoadMore();
    assert.equal(f.frames.length, 1, 'The appended page supplies enough work without more fetching');
    for ( let i = 0; i < 10; i++ ) {
        f.state.recorded.set(`https://next.example/${i}`, { verdict: 'exclude', reasons: [ { kind: 'advertising' } ] });
    }
    const refill = f.api.maybeLoadMore();
    assert.equal(f.frames.length, 2, 'Refill again when only the slow page remains unfinished');
    for ( let i = 0; i < 10; i++ ) {
        f.state.recorded.set(`https://next.example/${i}`, { verdict: 'candidate' });
    }
    await f.api.maybeLoadMore();
    await refill;
    assert.equal(f.state.paginationComplete, true);
    assert.equal(f.frames[1].parentElement, null, 'Reaching the target releases the unneeded search frame');
    assert.equal(f.state.running, true, 'The slow inspection is not canceled');
    assert.equal(f.state.paginationAuto, true, 'Completion is not recorded as a failed fetch or explicit Stop');
    assert.equal(f.state.paginationButton.dataset.problem, undefined);
    await f.api.maybeLoadMore();
    assert.equal(f.frames.length, 2, 'A finished cycle does not restart on redraw');
});

for ( const characteristic of [ 'requireSingleDomain', 'excludeCrossSiteTracking' ] ) {
    test(`Tightening ${characteristic} refills the existing target unless the user explicitly stopped`, async () => {
        const f = readyToPage();
        if ( characteristic === 'excludeCrossSiteTracking' ) {
            f.state.excludeCrossSiteTracking = false;
            f.state.recorded.set('https://personal.example/first', {
                verdict: 'exclude', checks_complete: true, shopping_signals: false,
                reasons: [ { kind: 'cross_site_tracking' } ],
            });
        }
        for ( let i = 1; i < 10; i++ ) {
            const url = `https://personal.example/${i}`;
            f.result(url);
            f.state.recorded.set(url, { verdict: 'candidate', single_domain: true });
        }
        await f.api.maybeLoadMore();
        assert.equal(f.frames.length, 0);
        const ui = presentation(f);
        Object.assign(f.state, { settingsGeneration: 0, personalCategories: '[]',
            renderInspectionDebugMode() {}, syncSearchMode() {} });
        ui.onMessage({ what: 'quereeSettingsChanged', enabled: true,
            personalCategories: [], requireSingleDomain: false,
            excludeAdvertisingSignals: true, excludeCrossSiteTracking: true, excludeShoppingSignals: true,
            [characteristic]: true });
        await settle();
        assert.equal(f.state.paginationComplete, false, 'A deliberate filter change permits refilling');
        assert.equal(f.api.resultCounts().retained, 9);
        const pending = f.api.maybeLoadMore();
        assert.equal(f.frames.length, 1, 'A stricter filter restarts paging without a More click');
        assert.equal(f.state.paginationTarget, 10);
        f.state.paginationButton.click({ isTrusted: true });
        await pending;
        await f.api.maybeLoadMore();
        assert.equal(f.frames.length, 1, 'The same deficit cannot undo explicit Stop');
        assert.equal(f.state.paginationAuto, false);
    });
}

for ( const engine of [ 'Google', 'Bing' ] ) {
    test(`${engine}: completed ten-plus results stay complete through tab return and reinjection`, async () => {
        for ( const count of [ 10, 12 ] ) {
            const f = readyToPage(engine);
            for ( let i = 1; i < count; i++ ) {
                const url = `https://personal.example/${i}`;
                f.result(url);
                f.state.recorded.set(url, { verdict: 'candidate' });
            }
            await f.api.maybeLoadMore();
            assert.equal(f.state.paginationComplete, true);
            assert.equal(JSON.parse(f.body.getAttribute('data-queree-pagination')).complete, true);
            f.state.document.hidden = true;
            await f.api.maybeLoadMore();
            for ( const row of f.root.children.slice(-3) ) { row.remove(); }
            f.state.document.hidden = false;
            assert.ok(f.api.resultCounts().retained < 10, 'A redraw can temporarily shrink the visible count');
            await f.api.maybeLoadMore();
            assert.equal(f.frames.length, 0, 'Returning must not refill a completed cycle');
            const fresh = fixture(engine, f);
            for ( const item of fresh.api.collect() ) {
                fresh.state.recorded.set(item.url, { verdict: 'candidate' });
            }
            await fresh.api.maybeLoadMore();
            assert.equal(fresh.frames.length, 0, 'Reinjection must preserve completion, not just the target');
            const retained = fresh.api.resultCounts().retained;
            fresh.state.paginationButton.click({ isTrusted: true });
            assert.equal(fresh.state.paginationComplete, false);
            assert.equal(fresh.state.paginationTarget, retained + 10);
            assert.equal(fresh.frames.length, 1, 'More explicitly starts another cycle');
            fresh.state.paginationButton.click({ isTrusted: true });
            await settle();
        }
    });
}

test('Idle More requests another ten instead of silently switching automatic paging off', async () => {
    const f = readyToPage();
    f.api.renderPagination();
    assert.equal(f.state.paginationAuto, true);
    assert.equal(f.state.paginationButton.textContent, 'More results');
    f.state.paginationButton.click({ isTrusted: true });
    assert.equal(f.state.paginationTarget, 11);
    assert.equal(f.frames.length, 1);
    f.state.paginationButton.click({ isTrusted: true });
    await settle();
});

test('Page-specific failures and exclusions keep paging toward ten retained results', async () => {
    for ( const engine of [ 'Google', 'Bing' ] ) {
        for ( const kind of [ 'firefox_restricted', 'challenge_page', 'inspection_reply_unavailable', 'advertising' ] ) {
            const f = readyToPage(engine);
            f.state.recorded.set('https://personal.example/first', {
                verdict: kind === 'advertising' ? 'exclude' : 'unresolved', reasons: [ { kind } ],
            });
            const pending = f.api.maybeLoadMore();
            assert.equal(f.frames.length, 1, `${engine}: ${kind}`);
            assert.equal(f.state.paginationAuto, true);
            assert.equal(f.state.paginationButton.dataset.problem, undefined);
            const page = fixture(engine);
            page.result('https://personal.example/second');
            page.next(`/search?q=pond&${f.api.adapter.offsetParameter}=20`);
            showPage(f, page);
            f.tick();
            await pending;
            f.state.recorded.set('https://personal.example/second', {
                verdict: 'unresolved', reasons: [ { kind: 'firefox_restricted' } ],
            });
            const following = f.api.maybeLoadMore();
            assert.equal(f.frames.length, 2, 'An all-unresolved appended page is not exhaustion');
            assert.equal(f.state.paginationButton.dataset.problem, undefined);
            f.state.paginationButton.click({ isTrusted: true });
            await following;
            assert.equal(f.state.paginationAuto, false, 'Explicit Stop still stops loading');
        }
    }
});

test('Private searches and missing inspection tabs pause without stopping or blaming the next page', async () => {
    for ( const kind of [ 'private_window_unsupported', 'private_tab_needed' ] ) {
        const f = readyToPage();
        f.state.recorded.set('https://personal.example/first', { verdict: 'unresolved', reasons: [ { kind } ] });
        await f.api.maybeLoadMore();
        assert.equal(f.frames.length, 0);
        assert.equal(f.state.paginationAuto, true);
        assert.equal(f.state.paginationComplete, false);
        assert.equal(f.state.paginationButton.dataset.problem, undefined);
        if ( kind === 'private_tab_needed' ) {
            f.state.mobileInspection = { mobile: true, tabsReady: true, ready: false, background: 'paused' };
            const pending = f.api.maybeLoadMore();
            assert.equal(f.frames.length, 1, 'An amber diagnostic does not block usable inspection tabs');
            f.state.paginationCancel();
            await pending;
        }
    }
    const f = readyToPage();
    f.state.mobileInspection = { mobile: true, tabsReady: false };
    await f.api.maybeLoadMore();
    assert.equal(f.frames.length, 0, 'Missing setup also pauses a cached search');
    assert.equal(f.state.paginationAuto, true);
    f.state.mobileInspection.tabsReady = true;
    const pending = f.api.maybeLoadMore();
    assert.equal(f.frames.length, 1, 'Finishing setup resumes the same loading cycle');
    f.state.paginationCancel();
    await pending;
});

test('Native hidden results do not satisfy the ten-result target', () => {
    const f = readyToPage();
    const result = f.result('https://native-hidden.example/');
    result.row.visible = false;
    f.state.recorded.set(result.anchor.href, { verdict: 'candidate' });
    assert.equal(f.api.resultCounts().retained, 1);
});

test('A forged saved pagination target is bounded by the existing result frontier', () => {
    const f = readyToPage();
    f.body.setAttribute('data-queree-pagination', JSON.stringify({
        source: f.state.paginationSource, target: Number.MAX_SAFE_INTEGER, auto: true, complete: false,
    }));
    const fresh = fixture('Google', f);
    assert.equal(fresh.state.paginationTarget, 11);
});

test('Progress animation mutations do not rescan the result page', () => {
    const f = readyToPage();
    const api = lifecycle(f);
    let notify;
    f.state.MutationObserver = class {
        constructor(callback) { notify = callback; }
        observe() {}
        disconnect() {}
    };
    const progress = {};
    f.state.panel = { contains: node => node === progress };
    f.state.emptyStored = false;
    f.state.enabled = false;
    api.start();
    const initial = f.state.scans;
    notify([ { target: progress } ]);
    assert.equal(f.state.scans, initial);
    notify([ { target: f.root }, { target: progress } ]);
    assert.equal(f.state.scans, initial + 1, 'Real result mutations still trigger collection');
});

test('Disable uses the real stop helper to cancel and release a pending frame', async () => {
    const f = readyToPage();
    const api = lifecycle(f);
    const pending = f.api.maybeLoadMore();
    api.stop();
    await pending;
    assert.equal(f.state.enabled, false);
    assert.equal(f.state.paginationCancel, undefined);
    assert.equal(f.frames[0].parentElement, null);
    assert.equal(f.timers.size, 0);
    assert.equal(f.state.scans, 0);
    assert.equal(f.root.querySelectorAll('h3').length, 1, 'Disable does not delete loaded results');
});

test('Stop/start preserves automatic or paused mode', () => {
    for ( const automatic of [ true, false ] ) {
        const f = readyToPage();
        const api = lifecycle(f);
        const next = 'https://www.google.com/search?q=pond&start=30';
        Object.assign(f.state, { paginationAuto: automatic, paginationTarget: 30, paginationNext: next });
        api.stop();
        api.start();
        assert.equal(f.state.paginationAuto, automatic);
        assert.equal(f.state.paginationTarget, 30);
        assert.equal(f.state.paginationNext, next);
    }
});

test('URL notifications preserve tracking changes but retire meaningful changes after early restore', () => {
    for ( const engine of [ 'Google', 'Bing' ] ) {
        for ( const changed of [ 'query', 'mode', 'offset' ] ) {
            const f = readyToPage(engine);
            const api = lifecycle(f);
            const next = new URL(f.state.location);
            next.searchParams.set(f.api.adapter.offsetParameter, '20');
            Object.assign(f.state, { paginationAuto: false, paginationTarget: 30,
                paginationNext: next.href, running: true });
            f.result('https://personal.example/appended').row.className += ' queree-appended-result';
            f.api.renderPagination();
            const marker = f.body.getAttribute('data-queree-pagination');
            const generation = f.state.generation;
            f.state.location.searchParams.set('tracking', 'new-token');
            api.onMessage({ what: 'quereeSearchURLChanged' });
            assert.equal(f.state.generation, generation, 'Tracking-only notifications do not restart inspection');
            assert.equal(f.state.running, true);
            assert.equal(f.state.recorded.size, 1);
            assert.equal(f.state.paginationNext, next.href);
            assert.equal(f.state.paginationTarget, 30);
            assert.equal(f.state.paginationAuto, false);
            assert.equal(f.body.getAttribute('data-queree-pagination'), marker);
            assert.equal(f.root.querySelectorAll('.queree-appended-result').length, 1);
            if ( changed === 'query' ) { f.state.location.searchParams.set('q', 'different'); }
            if ( changed === 'mode' ) { f.state.location.searchParams.set(engine === 'Google' ? 'udm' : 'scope', 'different'); }
            if ( changed === 'offset' ) { f.state.location.searchParams.set(f.api.adapter.offsetParameter, '10'); }
            // Pagination may notice navigation before the background notification arrives.
            f.api.restorePagination();
            f.api.renderPagination();
            api.onMessage({ what: 'quereeSearchURLChanged' });
            assert.ok(f.state.generation > generation, changed);
            assert.equal(f.state.recorded.size, 0, 'Retire decisions from the previous search');
            assert.equal(f.state.paginationAuto, true);
            assert.equal(f.state.paginationTarget, 10);
            assert.equal(f.state.paginationNext, undefined);
            assert.equal(f.body.getAttribute('data-queree-pagination'), null);
            assert.equal(f.root.querySelectorAll('.queree-appended-result').length, 0);
            assert.equal(f.root.querySelectorAll(f.api.adapter.headingSelector).length, 1);
            const resetGeneration = f.state.generation;
            api.onMessage({ what: 'quereeSearchURLChanged' });
            assert.equal(f.state.generation, resetGeneration, 'Duplicate notifications cannot reset twice');
        }
    }
});

test('Bing route changes select the matching Web or News adapter', () => {
    const f = readyToPage('Bing');
    const api = lifecycle(f);
    f.state.location.pathname = '/news/search';
    api.onMessage({ what: 'quereeSearchURLChanged' });
    assert.equal(f.api.adapter.headingSelector, '.news-card a.title, .newscard a.title');
    f.state.location.pathname = '/search';
    api.onMessage({ what: 'quereeSearchURLChanged' });
    assert.equal(f.api.adapter.headingSelector, '#b_results > li.b_algo h2');
});

test('Reinjection restores the saved frontier, target and pause while retaining appended rows', async () => {
    for ( const automatic of [ true, false ] ) {
        for ( const hasNext of [ true, false ] ) {
            const f = readyToPage();
            f.state.paginationTarget = 30;
            const pending = f.api.maybeLoadMore();
            const page = fixture();
            page.result('https://personal.example/second');
            if ( hasNext ) { page.next('/search?q=pond&start=20'); }
            showPage(f, page);
            f.tick();
            await pending;
            if ( automatic === false ) {
                f.state.running = true;
                f.api.renderPagination();
                f.state.paginationButton.click({ isTrusted: true });
            }
            lifecycle(f).stop();
            // Browser/engine tracking changes must not invalidate the saved search.
            f.state.location.searchParams.set('ved', 'different-token');
            const fresh = fixture('Google', f);
            const next = hasNext ? 'https://www.google.com/search?q=pond&start=20' : null;
            assert.equal(fresh.state.paginationNext, next);
            assert.equal(fresh.state.paginationTarget, 12, 'Saved targets cannot exceed the visible frontier by more than one batch');
            assert.equal(fresh.state.paginationAuto, automatic);
            const items = Array.from(fresh.api.collect());
            assert.deepEqual(items.map(item => item.url), [
                'https://personal.example/first', 'https://personal.example/second',
            ]);
            for ( const item of items ) { fresh.state.recorded.set(item.url, { verdict: 'candidate', cached: true }); }
            const resumed = fresh.api.maybeLoadMore();
            assert.equal(fresh.frames.length, automatic && hasNext ? 1 : 0);
            if ( automatic && hasNext ) {
                assert.equal(fresh.frames[0].src, next, 'Resume at the frontier, not the original page-ten link');
                fresh.state.paginationButton.click({ isTrusted: true });
            }
            await resumed;
        }
    }
});

test('Restoration rejects a different query, offset, filter or a saved frontier that drops filters', () => {
    for ( const changed of [ 'query', 'offset', 'filter', 'frontier' ] ) {
        const f = readyToPage();
        f.state.location.searchParams.set('tbs', 'qdr:w');
        f.api.restorePagination();
        Object.assign(f.state, { paginationTarget: 30, paginationAuto: false,
            paginationNext: 'https://www.google.com/search?q=pond&tbs=qdr%3Aw&start=20' });
        f.api.renderPagination();
        if ( changed === 'query' ) { f.state.location.searchParams.set('q', 'different'); }
        if ( changed === 'offset' ) { f.state.location.searchParams.set('start', '10'); }
        if ( changed === 'filter' ) { f.state.location.searchParams.set('tbs', 'qdr:d'); }
        if ( changed === 'frontier' ) {
            const marker = JSON.parse(f.body.getAttribute('data-queree-pagination'));
            marker.next = 'https://www.google.com/search?q=pond&start=20';
            f.body.setAttribute('data-queree-pagination', JSON.stringify(marker));
        }
        const fresh = fixture('Google', f);
        assert.equal(fresh.state.paginationNext, undefined, changed);
        assert.equal(fresh.state.paginationTarget, 10, changed);
        assert.equal(fresh.state.paginationAuto, true, changed);
    }
});

test('Background searches keep loading; tab returns do not duplicate work and shutdown cleans listeners', async () => {
    const f = readyToPage();
    lifecycle(f);
    const listeners = new Map();
    let shutdown;
    Object.assign(f.state.document, {
        addEventListener(type, listener) {
            if ( listeners.has(type) === false ) { listeners.set(type, new Set()); }
            listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    });
    Object.assign(f.state.window, { addEventListener() {}, removeEventListener() {} });
    Object.assign(f.state, {
        onPageShow() {}, onResultClick: f.api.onResultClick,
        browser: { runtime: { onMessage: { addListener() {}, removeListener() {} } } },
        vAPI: { shutdown: { add: callback => { shutdown = callback; } } },
    });
    const from = source.indexOf("    window.addEventListener('pageshow'");
    const to = source.indexOf('\n    await refreshSettings();', from);
    assert.ok(from >= 0 && to > from, 'Missing listener registration/shutdown section');
    vm.runInNewContext(source.slice(from, to), f.state);
    const emit = () => Promise.all(Array.from(listeners.get('visibilitychange'), listener => listener()));
    f.state.document.hidden = true;
    const loading = emit();
    assert.equal(f.frames.length, 1, 'A hidden search must keep fetching toward its target');
    assert.equal(f.state.paginationAuto, true, 'Hiding the source is not an explicit Stop');
    f.state.running = true;
    await emit();
    assert.equal(f.state.running, true, 'Visibility does not cancel ongoing website inspections');
    f.state.running = false;
    f.state.document.hidden = false;
    await emit();
    assert.equal(f.frames.length, 1, 'Returning must join the existing load, not start another');
    f.state.document.hidden = true;
    await emit();
    assert.notEqual(f.frames[0].parentElement, null, 'Switching away does not cancel the in-flight page');
    shutdown();
    await loading;
    assert.equal(f.frames[0].parentElement, null);
    assert.equal(f.timers.size, 0);
    assert.equal(listeners.get('visibilitychange').size, 0, 'Shutdown removes both visibility handlers');
    f.state.document.hidden = false;
    await emit();
    assert.equal(f.frames.length, 1, 'A removed listener cannot restart pagination after shutdown');
});

for ( const engine of [ 'Google', 'Bing' ] ) {
    test(`${engine}: frame rejects results whose actual URL differs from the requested search`, async () => {
        for ( const field of [ 'origin', 'pathname', 'query', 'offset', 'missing offset' ] ) {
            const f = fixture(engine);
            const offset = f.api.adapter.offsetParameter;
            const requested = `${f.state.location.href}&${offset}=10`;
            const pending = f.api.loadNextResultPage(requested);
            const page = fixture(engine);
            page.result('https://personal.example/redirected');
            const doc = showPage(f, page);
            const actual = new URL(requested);
            if ( field === 'origin' ) { actual.hostname = 'other.example'; }
            if ( field === 'pathname' ) { actual.pathname = '/other'; }
            if ( field === 'query' ) { actual.searchParams.set('q', 'different'); }
            if ( field === 'offset' ) { actual.searchParams.set(offset, '20'); }
            if ( field === 'missing offset' ) { actual.searchParams.delete(offset); }
            doc.URL = actual.href;
            f.tick();
            assert.equal(await pending, undefined, `${field} must match even when the document has result headings`);
            assert.equal(f.frames[0].parentElement, null);
            assert.equal(f.timers.size, 0);
        }
    });
}

test('Frame accepts native completion immediately or parsed results at the fixed deadline', async () => {
    for ( const readyState of [ 'complete', 'interactive', 'loading' ] ) {
        const f = readyToPage();
        const pending = f.api.loadNextResultPage('https://www.google.com/search?q=pond&start=10');
        const page = fixture();
        page.result('https://personal.example/second');
        const doc = showPage(f, page, readyState);
        f.tick();
        if ( readyState !== 'complete' ) {
            assert.notEqual(f.frames[0].parentElement, null);
            f.tick(29749);
            assert.notEqual(f.frames[0].parentElement, null, 'Parsed results wait for completion until 30 seconds');
            // Changing result content cannot extend the fixed deadline.
            page.result('https://personal.example/late');
            f.tick(1);
        }
        assert.equal(await pending, readyState === 'loading' ? undefined : doc);
        assert.equal(f.frames[0].parentElement, null);
        assert.equal(f.timers.size, 0, 'Native completion does not require another quiet-network interval');
    }
});

test('Challenge and timeout remove the frame and stop automatic requests', async () => {
    for ( const [ engine, challenge ] of [
        [ 'Google', '/sorry/index' ], [ 'Bing', '/turing/challenge' ],
        [ 'Google', 'form' ], [ 'Google', undefined ],
    ] ) {
        const f = readyToPage(engine);
        const pending = f.api.maybeLoadMore();
        if ( challenge !== undefined ) {
            const page = fixture(engine);
            page.result('https://personal.example/not-a-usable-page');
            const doc = showPage(f, page);
            if ( challenge === 'form' ) {
                const query = doc.querySelector;
                doc.querySelector = selector => selector.includes('#captcha-form') ? element('form') : query(selector);
            } else {
                doc.URL = new URL(challenge, f.state.location).href;
            }
        }
        f.tick(challenge !== undefined ? 250 : 30000);
        await pending;
        assert.equal(f.state.paginationAuto, false);
        assert.equal(f.state.paginationLoading, false);
        assert.equal(f.frames[0].parentElement, null);
        assert.equal(f.timers.size, 0);
        await f.api.maybeLoadMore();
        assert.equal(f.frames.length, 1, 'No automatic retry loop after failure');
        assert.equal(f.api.resultCounts().retained, 1);
    }
});

test('Late navigation, filter or disable replies cannot append; tracking-only changes remain valid', async () => {
    for ( const changed of [ 'generation', 'enabled', 'query', 'offset', 'filter', 'tracking' ] ) {
        const f = readyToPage();
        const pending = f.api.maybeLoadMore();
        const page = fixture();
        page.result('https://personal.example/stale');
        showPage(f, page);
        if ( changed === 'generation' ) { f.state.generation += 1; }
        if ( changed === 'enabled' ) { f.state.enabled = false; }
        if ( changed === 'query' ) { f.state.location.searchParams.set('q', 'different'); }
        if ( changed === 'offset' ) { f.state.location.searchParams.set('start', '10'); }
        if ( changed === 'filter' ) { f.state.location.searchParams.set('tbs', 'qdr:d'); }
        if ( changed === 'tracking' ) { f.state.location.searchParams.set('ved', 'different-token'); }
        f.tick();
        await pending;
        assert.equal(f.api.collect().length, changed === 'tracking' ? 2 : 1, changed);
        assert.equal(f.state.scans, changed === 'tracking' ? 1 : 0, changed);
        assert.equal(f.frames[0].parentElement, null);
    }
});

test('A duplicate-only page follows a valid next link without appending or reinspecting duplicates', async () => {
    const f = readyToPage();
    const pending = f.api.maybeLoadMore();
    const page = fixture();
    page.result('https://personal.example/first');
    page.next('/search?q=pond&start=20');
    showPage(f, page);
    f.tick();
    await pending;
    assert.equal(f.api.collect().length, 1);
    assert.equal(f.state.paginationNext, 'https://www.google.com/search?q=pond&start=20');
    assert.equal(f.state.recorded.size, 1);
    const following = f.api.maybeLoadMore();
    assert.equal(f.frames.length, 2);
    assert.equal(f.frames[1].src, f.state.paginationNext);
    f.state.paginationCancel();
    await following;
});

test('The following request uses the fetched page next link, not the original page link', async () => {
    const f = readyToPage();
    const pending = f.api.maybeLoadMore();
    const page = fixture();
    page.result('https://personal.example/second');
    page.next('/search?q=pond&start=20&token=preserved');
    showPage(f, page);
    f.tick();
    await pending;
    f.state.recorded.set('https://personal.example/second', { verdict: 'candidate' });
    const following = f.api.maybeLoadMore();
    assert.equal(f.frames[1].src, 'https://www.google.com/search?q=pond&start=20&token=preserved');
    f.state.paginationCancel();
    await following;
});

for ( const engine of [ 'Google', 'Bing' ] ) {
    test(`${engine}: reusing a title anchor inspects its new address`, () => {
        const f = fixture(engine);
        const p = presentation(f);
        const { anchor, heading } = f.result('https://personal.example/old');
        const [ previous ] = f.api.collect();
        assert.ok(previous);
        assert.equal(f.api.collect().length, 0);
        const oldLabel = element('span', 'Old finding');
        oldLabel.className = 'queree-characteristic';
        heading.append(oldLabel);
        anchor.href = 'https://personal.example/new';
        const [ item ] = f.api.collect();
        assert.equal(item.url, anchor.href);
        assert.equal(item.result_title.includes('Old finding'), false);
        assert.equal(f.api.collect().length, 0, 'An unchanged address is not inspected twice');
        const pending = [];
        p.apply(previous, { verdict: 'exclude', reasons: [ { kind: 'advertising' } ] }, pending);
        assert.equal(pending.length, 0, 'A late old decision cannot hide the replacement address');
        p.apply(item, { verdict: 'candidate' }, pending);
        assert.equal(heading.querySelector('.queree-characteristic'), null);
    });

    test(`${engine}: a grouped wrapper cannot reappend an already retained title`, () => {
        const f = fixture(engine);
        f.result('https://personal.example/existing');
        const page = fixture(engine);
        const first = page.result('https://personal.example/existing');
        const second = page.result('https://personal.example/new');
        second.row.className = '';
        first.row.append(second.row);
        assert.equal(f.api.appendResultPage(page.state.document), 1);
        assert.deepEqual(Array.from(f.api.collect(), item => item.url), [
            'https://personal.example/existing', 'https://personal.example/new',
        ]);
    });
}

test('Five slow title taps toggle debug, with pauses resetting the count', () => {
    let click;
    let toggles = 0;
    const bind = vm.runInNewContext(helper('bindDebugGesture') + ';bindDebugGesture', {
        vAPI: { messaging: { send(channel, message) {
            assert.equal(channel, 'queree');
            assert.equal(message.what, 'toggleKeepUnresolvedTabs');
            toggles += 1;
        } } },
    });
    bind({ addEventListener(type, callback) { assert.equal(type, 'click'); click = callback; } });
    const tap = (timeStamp, isTrusted = true) => click({ timeStamp, isTrusted });
    tap(0);
    tap(100);
    assert.equal(toggles, 0, 'A double-tap is not the debug gesture');
    for ( const time of [ 5000, 6500, 8000, 9500 ] ) { tap(time); }
    assert.equal(toggles, 0);
    tap(10000, false);
    assert.equal(toggles, 0, 'Synthetic clicks do not count');
    tap(11000);
    assert.equal(toggles, 1, 'Five taps spaced 1.5 seconds apart enable debug');
    for ( const time of [ 15000, 17000, 19000, 21000, 23000 ] ) { tap(time); }
    assert.equal(toggles, 2, 'The same slow gesture disables debug');
    for ( const time of [ 27000, 29000, 31000, 33000, 37000 ] ) { tap(time); }
    assert.equal(toggles, 2, 'A long pause starts a new gesture');
});

test('Synthesized More and Stop clicks cannot request or cancel another page', async () => {
    const f = readyToPage();
    f.api.renderPagination();
    f.state.paginationButton.click({ isTrusted: false });
    assert.equal(f.frames.length, 0);
    const pending = f.api.maybeLoadMore();
    f.state.paginationButton.click({ isTrusted: false });
    assert.equal(f.state.paginationAuto, true);
    assert.notEqual(f.frames[0].parentElement, null);
    f.state.paginationButton.click({ isTrusted: true });
    await pending;
});

test('Progress dots stay visible without replacing the announced count every tick', () => {
    const f = fixture();
    const p = presentation(f);
    Object.assign(f.state, { progressCompleted: 3, progressTotal: 10, progressDots: 1 });
    p.renderProgress();
    const text = f.state.status.firstChild;
    const dots = f.state.status.lastElementChild;
    assert.equal(dots.getAttribute('aria-hidden'), 'true');
    assert.equal(f.state.status.textContent, '3 of 10 results inspected.');
    f.state.progressDots = 2;
    p.renderProgress();
    assert.equal(f.state.status.firstChild, text);
    assert.equal(f.state.status.lastElementChild, dots);
    assert.equal(f.state.status.textContent, '3 of 10 results inspected..');
});

test('Empty pages still loading after the deadline cannot schedule a zero-delay retry loop', () => {
    const scheduled = [];
    const context = {
        emptyStored: false, emptyTimer: undefined, emptyStartedAt: 0,
        sourceSettleDelay: 5000, unknownSourceDeadline: 120000,
        Date: { now: () => 120001 },
        setTimeout(callback, delay) { scheduled.push(delay); return 1; },
    };
    vm.runInNewContext(helper('scheduleEmptyResult') + ';scheduleEmptyResult()', context);
    assert.deepEqual(scheduled, [5000]);
});

test('Challenge detection uses engine markup rather than words in the search query', () => {
    const context = {
        location: { pathname: '/search' },
        document: { title: 'captcha - Google Search', body: { textContent: 'No results found for captcha' },
            querySelector: () => null },
        adapter: { noResults: text => /no results found for/i.test(text) },
    };
    const status = vm.runInNewContext(helper('emptySourceStatus') + ';emptySourceStatus', context);
    assert.equal(status(), 'no_results');
    context.document.body.textContent = 'unusual traffic verify you are human';
    assert.equal(status(), 'unrecognized_markup');
    context.document.querySelector = () => element('form');
    assert.equal(status(), 'challenge');
    context.document.querySelector = () => null;
    context.location.pathname = '/turing/captcha';
    assert.equal(status(), 'challenge');
});

test('Mobile Q rejects synthesized setup and an unchecked state is not diagnosed as failure', async () => {
    const panel = element('aside');
    panel.append(element('strong', 'Quer.ee'));
    const requests = [];
    const copied = [];
    const context = {
        panel, mobileQ: undefined, mobileHelp: undefined,
        mobileInspection: { mobile: true, ready: false, tabsReady: true, background: 'unchecked' },
        backgroundSettingsCopied: false, backgroundSettingsURL: 'chrome://settings-example',
        enabled: false,
        document: { createElement: element },
        navigator: { clipboard: { async writeText(text) { copied.push(text); } } },
        vAPI: { messaging: { async send(channel, message) {
            requests.push({ channel, ...message });
            return { mobile: true, ready: false, tabsReady: true, background: 'unchecked' };
        } } },
    };
    const names = [ 'renderMobileInspection', 'showBackgroundSetup', 'prepareMobileInspection', 'setMobileInspection' ];
    const api = vm.runInNewContext(names.map(helper).join('\n') + `;({ ${names.join(', ')} })`, context);
    api.renderMobileInspection();
    assert.equal(context.mobileHelp.hidden, true);
    assert.doesNotMatch(context.mobileHelp.textContent, /dom\.suspend|not running|set.*false/);
    context.mobileQ.click({ isTrusted: false });
    await settle();
    assert.equal(requests.length, 0);
    assert.equal(copied.length, 0);
    context.mobileQ.click({ isTrusted: true });
    await settle();
    assert.equal(requests.length, 1);
    assert.deepEqual(copied, [context.backgroundSettingsURL]);
    assert.doesNotMatch(context.mobileHelp.textContent, /dom\.suspend|not running|set.*false/);
    api.setMobileInspection({ mobile: true, ready: true, tabsReady: true, background: 'running' });
    assert.equal(context.mobileHelp.hidden, true);
});

test('Startup checks recovered tabs once; shared failures and passes do not retry on page changes', async () => {
    const panel = element('aside');
    panel.append(element('strong', 'Quer.ee'));
    let requests = 0;
    const context = {
        panel, mobileQ: undefined, mobileHelp: undefined,
        mobileInspection: { mobile: true, tabsReady: false, ready: false, background: 'unchecked', revision: 1 },
        backgroundSettingsCopied: false, backgroundSettingsURL: 'chrome://settings-example',
        enabled: true, recorded: new Map(), processed: new WeakMap(), scheduleScan() {},
        document: { hidden: true, createElement: element },
        navigator: { clipboard: { async writeText() {} } },
        vAPI: { messaging: { async send() {
            requests += 1;
            return { ...context.mobileInspection, background: 'unavailable', revision: context.mobileInspection.revision + 1,
                problem: 'background_check_failed' };
        } } },
    };
    const names = [ 'renderMobileInspection', 'showBackgroundSetup', 'prepareMobileInspection',
        'setMobileInspection', 'retryMobileInspection' ];
    const api = vm.runInNewContext(names.map(helper).join('\n') + `;({ ${names.join(', ')} })`, context);
    api.renderMobileInspection();
    api.setMobileInspection({ ...context.mobileInspection, tabsReady: true, revision: 2 });
    assert.equal(requests, 0, 'An initial setup waits while its search is hidden');
    context.document.hidden = false;
    await api.retryMobileInspection();
    assert.equal(requests, 1, 'Initial setup works even without an inspection batch');
    assert.match(context.mobileHelp.textContent, /Tap Q to retry/);
    await api.retryMobileInspection();
    await api.retryMobileInspection();
    assert.equal(requests, 1, 'Ordinary returns cannot repeat a failed diagnostic');
    api.setMobileInspection({ ...context.mobileInspection, revision: 4 });
    await api.retryMobileInspection();
    assert.equal(requests, 1, 'Ordinary state updates do not queue another attempt');
    context.mobileQ.click({ isTrusted: true });
    await settle();
    assert.equal(requests, 2, 'Q remains a manual retry after failure');
    await api.retryMobileInspection();
    assert.equal(requests, 2, 'Returning from the manual attempt cannot repeat it');
    api.setMobileInspection({ ...context.mobileInspection, ready: true, background: 'running', revision: 6 });
    await api.retryMobileInspection();
    assert.equal(requests, 2, 'The existing settings-return check can publish its pass without another check');
    assert.equal(context.mobileHelp.hidden, true);
    context.mobileInspection = { mobile: false, ready: false };
    api.setMobileInspection({ mobile: true, tabsReady: true, ready: false, background: 'unchecked', revision: 7 });
    await settle();
    await api.retryMobileInspection();
    assert.equal(requests, 3, 'A restarted extension checks its recovered pool on the first visible search');
    context.mobileInspection = { mobile: false, ready: false };
    api.setMobileInspection({ mobile: true, tabsReady: true, ready: false, background: 'unavailable', revision: 9 });
    await api.retryMobileInspection();
    assert.equal(requests, 3, 'A later search reuses the shared failed attempt instead of starting another');
    context.mobileInspection = { mobile: false, ready: false };
    api.setMobileInspection({ mobile: true, tabsReady: true, ready: true, background: 'running', revision: 10 });
    await api.retryMobileInspection();
    assert.equal(requests, 3, 'A later search reuses the shared pass');
});

test('Long result lists keep every exclusion within bounded stylesheet batches', async () => {
    const changes = [];
    const context = {
        selectorReasons: new Map(), exclusionStylesheets: new Map(), excludedVisible: false,
        maxExcludedSelectors: 256, maxExclusionCSSLength: 64 * 1024,
        stylesheetOperation: Promise.resolve(), hidingUnavailable: false,
        async changeStylesheets(add, remove) { changes.push({ add, remove }); },
    };
    const names = [ 'exclusionCSS', 'exclusionMarkerCSS', 'addExclusionSelectors' ];
    const api = vm.runInNewContext(names.map(helper).join('\n') + `;({ ${names.join(', ')} })`, context);
    const entries = Array.from({ length: 1100 }, (_, index) => [ `#result-${index}`, 'Advertising' ]);
    await api.addExclusionSelectors(entries);
    assert.equal(context.hidingUnavailable, false);
    assert.equal(context.selectorReasons.size, entries.length);
    assert.equal(context.exclusionStylesheets.size, 5);
    assert.ok(changes[0].add.every(css => css.length <= context.maxExclusionCSSLength));
    for ( const [ selector ] of entries ) {
        assert.ok(changes[0].add.some(css => css.includes(`${selector},`) || css.includes(`${selector})`)));
    }
    const previous = Array.from(context.exclusionStylesheets.keys());
    await api.addExclusionSelectors([], true);
    assert.deepEqual(Array.from(changes[1].remove), previous);
    assert.equal(context.exclusionStylesheets.size, 0);
    await api.addExclusionSelectors([ ['#' + 'x'.repeat(17000), 'Advertising'],
        ['#' + 'y'.repeat(17000), 'Shopping'] ]);
    assert.equal(context.exclusionStylesheets.size, 2, 'Character limits split batches before the selector-count limit');
    assert.equal(context.hidingUnavailable, false);
    assert.ok(changes[2].add.every(css => css.length <= context.maxExclusionCSSLength));
});
