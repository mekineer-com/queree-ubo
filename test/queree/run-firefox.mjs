/* globals Buffer, process */

import {
    clickElement,
    execute,
    extensionUUID,
    navigate,
    sleep,
    webdriverRequest,
} from '../../tools/queree-webdriver.mjs';
import { execFileSync, spawn } from 'node:child_process';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { replaceOnce, verifyFixtureSources } from '../../tools/queree-fixture-sources.mjs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { defaultPersonalCategories } from '../../src/js/queree/personal-categories.js';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '../..');
const socialFixtureCategories = defaultPersonalCategories.map(category => ({
    ...category, entries: [ ...category.entries, 'community.localhost/*' ],
}));
const sourceXPI = resolve(root, process.env.QUEREE_TEST_XPI || 'dist/build/uBlock0.firefox.xpi');
const geckodriver = process.env.GECKODRIVER || 'geckodriver';
const firefoxBinary = process.env.FIREFOX_BINARY || '/usr/bin/firefox-esr';
const work = await mkdtemp(resolve(tmpdir(), 'queree-firefox-test-'));
const extension = resolve(work, 'extension');
const testXPI = resolve(work, 'queree-test.xpi');
const inspectionTimeout = 90000;
const readinessConcurrency = 4;
const historyNavigationOnly = process.argv.includes('--history-navigation-only');
const startupOnly = process.argv.includes('--startup-only');
const singleDomainOnly = process.argv.includes('--single-domain-only');
const nonHtmlOnly = process.argv.includes('--non-html-only');
const explanationsOnly = process.argv.includes('--explanations-only');
const shoppingOnly = process.argv.includes('--shopping-only');
const malwareOnly = process.argv.includes('--malware-only');
const sharedOnly = process.argv.includes('--shared-only');
const retentionOnly = process.argv.includes('--retention-only');
const personalOnly = process.argv.includes('--personal-only');
const paginationStayOnly = process.argv.includes('--pagination-stay-only');
const paginationOnly = process.argv.includes('--pagination-only') || paginationStayOnly;
const routesOnly = process.argv.includes('--routes-only');
const startupSettings = {
    ...(startupOnly ? { quereeEnabled: false } : {}),
    ...JSON.parse(process.env.QUEREE_TEST_STARTUP_SETTINGS || '{}'),
    ...(malwareOnly || sharedOnly ? { selectedFilterLists: [], autoUpdate: false } : {}),
    ...(retentionOnly || personalOnly ? { selectedFilterLists: [ 'adguard-generic', 'ublock-badware', 'urlhaus-1' ], autoUpdate: false } : {}),
    ...(paginationOnly || routesOnly ? { selectedFilterLists: [], autoUpdate: false } : {}),
};
const inspectionCleanupAllowance = 10000;

let slowActive = 0;
let maxSlowActive = 0;
let delayedChallengeVisits = 0;
let cleanChallengeVisits = 0;
let challengeCookieHeader = '';
let adVisits = 0;
let cachePageVisits = 0;
let cleanCookieHeader = '';
let historyConcurrentVisits = 0;
let communityVisits = 0;
const readinessExpected = {
    // These never contain clean content: catch the ads or leave them unresolved.
    'blank-200': [ 'exclude', 'unresolved' ],
    'blank-202': [ 'exclude', 'unresolved' ],
    blank: 'unresolved',
    hidden: 'unresolved',
    revealed: 'candidate',
    changing: 'exclude',
    timer: 'exclude',
    fetching: 'exclude',
    polling: 'candidate',
    minimal: 'candidate',
    'failed-background-fetch': 'candidate',
    image: 'candidate',
    'empty-svg': 'unresolved',
    'empty-video': 'unresolved',
    'empty-canvas': 'unresolved',
    'broken-style': 'candidate',
    'broken-navigation': 'unresolved',
    socket: 'candidate',
};
const scriptletStates = [];
const contributionRequests = [];
const exclusionRequests = [];
let sharedLoadingVisits = 0;
let sharedQueuedVisits = 0;
let sharedLoadingCancelled = 0;
const sharedLoadingStarted = Promise.withResolvers();
const upgradedSockets = new Set();
const navigationVisits = new Map();
const singleDomainVisits = new Map();
const singleDomainResources = new Set();
const shoppingVisits = new Map();
const shoppingKinds = [ 'software', 'offer', 'plain', 'referral', 'sponsored', 'ad' ];
const malwareVisits = new Map();
const paginationVisits = [];
const nonHtmlKinds = [ 'html.pdf', 'xhtml', 'pdf.html', 'text', 'attachment', 'error' ];

function page(body, title = 'Fixture') {
    return `<!doctype html><meta charset="utf-8"><title>${title}</title>${body}`;
}

const server = createServer((request, response) => {
    if ( request.url === '/search-non-html' ) {
        const origin = `http://localhost:${server.address().port}`;
        response.end(page(`<main id="search">${nonHtmlKinds.map(kind =>
            `<div class="MjjYud" id="file-${kind.replace('.', '-')}"><a href="${origin}/non-html/${kind}"><h3>${kind}</h3></a></div>`
        ).join('')}</main>`, 'Response type fixture'));
        return;
    }
    if ( request.url?.startsWith('/non-html/') ) {
        const kind = request.url.slice('/non-html/'.length);
        const types = { 'html.pdf': 'text/html', xhtml: 'application/xhtml+xml',
            'pdf.html': 'application/pdf', text: 'text/plain', attachment: 'application/octet-stream', error: 'text/plain' };
        response.setHeader('content-type', types[kind]);
        if ( kind === 'attachment' ) { response.setHeader('content-disposition', 'attachment; filename="fixture.bin"'); }
        if ( kind === 'error' ) { response.statusCode = 404; }
        response.end(kind === 'xhtml'
            ? '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>XHTML fixture</title></head><body><p>Personal XHTML notebook.</p></body></html>'
            : kind === 'html.pdf' ? page('<p>Personal HTML notebook.</p>') : 'Fixture file content');
        return;
    }
    if ( request.url?.startsWith('/malware/') ) {
        malwareVisits.set(request.url, (malwareVisits.get(request.url) || 0) + 1);
        response.setHeader('content-type', 'text/html; charset=utf-8');
        if ( request.url === '/malware/redirect' ) {
            response.writeHead(302, { location: '/malware/root/payload' });
            response.end();
        } else if ( request.url === '/malware/header' ) {
            response.setHeader('x-queree-malware', 'payload');
            response.end(page('<p>Local header fixture.</p>'));
        } else if ( request.url === '/malware/script.js' ) {
            response.setHeader('content-type', 'application/javascript');
            response.end('window.quereeMalwareScriptExecuted = true;');
        } else {
            response.end(page('<p>A fictional personal garden notebook.</p>' +
                (request.url === '/malware/subresource'
                    ? '<script src="/malware/script.js"></script>' : '') +
                (request.url === '/malware/good' ? `<script>
                    window.quereePersonalScriptlet = 0;
                    setTimeout(() => fetch('/state-probe?frame=malware-inspection&value=' +
                        window.quereePersonalScriptlet), 100);
                </script>` : ''), 'Local malware control'));
        }
        return;
    }
    if ( request.url?.startsWith('/search-shopping') ) {
        const origin = `http://localhost:${server.address().port}`;
        response.end(page(`<main id="search">${shoppingKinds.map(kind =>
            `<div class="MjjYud" id="shopping-${kind}"><a href="${origin}/shopping/${kind}"><h3>${kind}</h3></a></div>`
        ).join('')}</main>`, 'Shopping signals fixture'));
        return;
    }
    if ( request.url?.startsWith('/shopping/') ) {
        shoppingVisits.set(request.url, (shoppingVisits.get(request.url) || 0) + 1);
        response.setHeader('content-type', 'text/html; charset=utf-8');
        const kind = request.url.slice('/shopping/'.length);
        const extra = kind === 'software'
            ? '<script>window.Shopify = { shop: "fictional" }; window.ShopifyAnalytics = {};</script>'
            : kind === 'offer'
                ? '<script type="application/ld+json">{"@type":"Product","name":"Fictional bowl","offers":{"@type":"Offer","price":"12.00"}}</script>'
                : kind === 'referral'
                    ? [ 1, 2, 3 ].map(id => `<a href="https://open.spotify.com/track/fictional-${id}">Track ${id}</a>`).join('')
                : kind === 'sponsored'
                    ? '<a rel="sponsored" href="https://merchant.invalid/product">Sponsored link</a>'
                : kind === 'ad'
                    ? '<script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>'
                    : '<p>I wrote about Shopify, but do not run that software.</p>';
        response.end(page('<p>A fictional personal notebook.</p>' + extra, `Shopping ${kind}`));
        return;
    }
    if ( request.url === '/search-single-domain' ) {
        // Ordinary pages exercise resource inspection; internal Social skips it.
        const origin = `http://localhost:${server.address().port}`;
        response.end(page(`<main id="search">${['own', 'linked', 'external', 'unknown'].map(kind =>
            `<div class="MjjYud" id="single-${kind}"><a href="${origin}/single-domain/${kind}"><h3>${kind}</h3></a></div>`
        ).join('')}</main>`, 'Single-domain fixture'));
        return;
    }
    if ( request.url?.startsWith('/single-domain/') ) {
        const key = `${request.headers.host}${request.url}`;
        singleDomainVisits.set(key, (singleDomainVisits.get(key) || 0) + 1);
        if ( request.url.startsWith('/single-domain/resource.js?') ) {
            // Hold actual resources until the browser has asserted pending hiding.
            response.setHeader('content-type', 'application/javascript');
            singleDomainResources.add(response);
            response.on('close', () => singleDomainResources.delete(response));
            return;
        }
        response.setHeader('content-type', 'text/html; charset=utf-8');
        if ( request.url === '/single-domain/unknown' ) {
            response.end(page('<p>Checking your browser</p>', 'Just a moment...'));
            return;
        }
        const kind = request.url.slice('/single-domain/'.length);
        const host = kind === 'external' ? '127.0.0.1' : 'localhost';
        response.end(page(`<p>A personal garden notebook.</p>
            <script src="http://${host}:${server.address().port}/single-domain/resource.js?${kind}"></script>
            ${kind === 'linked' ? `<a href="http://127.0.0.1:${server.address().port}/single-domain/link-target">Another notebook</a>` : ''}`,
        `Single-domain ${kind}`));
        return;
    }
    if ( request.url?.startsWith('/search-history-navigation') ) {
        const origin = `http://localhost:${server.address().port}`;
        const suffix = request.url.includes('timeout=1') ? '?stuck=1' : '';
        response.end(page(`<main id="search">${Array.from({ length: 9 }, (_, i) =>
            `<div class="MjjYud" id="history-result-${i}"><a href="${origin}/history-page-${i}${suffix}"><h3>History result ${i}</h3></a></div>`
        ).join('')}</main><a id="leave-search" href="/clean">Visit a result</a>
        <script>
            window.restoreEvents = [];
            addEventListener('pageshow', event => restoreEvents.push(event.persisted));
        </script>`, 'History navigation fixture'));
        return;
    }
    if ( request.url?.startsWith('/history-page-') ) {
        navigationVisits.set(request.url, (navigationVisits.get(request.url) || 0) + 1);
        const respond = () => response.end(page('<p>Personal history fixture page.</p>'));
        if ( request.url.startsWith('/history-page-0') ) { respond(); }
        else {
            const timer = setTimeout(respond, request.url.includes('stuck=1') ? 40000 : 1000);
            response.on('close', () => clearTimeout(timer));
        }
        return;
    }
    if ( request.url === '/v1/exclusions' ) {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const exclusions = body.urls.filter(url => /\/shared-(?:loading|queued)$/.test(url)).map(url => ({
                url, observed_at: new Date(Date.now() - 170 * 864e5).toISOString(),
                reasons: [{ kind: 'advertising' }],
            }));
            const reply = () => {
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify({ schema: 1, exclusions }));
            };
            // Do not call a cache hit "in-flight cancellation" before a visit exists.
            if ( exclusions.length ) { sharedLoadingStarted.promise.then(reply); }
            else { reply(); }
        });
        return;
    }
    if ( request.url === '/v1/discoveries' ) {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', ( ) => {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            (body.exclusions ? exclusionRequests : contributionRequests).push({
                authorization: request.headers.authorization,
                body,
            });
            response.setHeader('content-type', 'application/json');
            response.statusCode = 202;
            response.end(JSON.stringify(body.schema === 2
                ? body.exclusions
                    ? { schema: 2, results: body.exclusions.map((_,index) => ({ index, status: 'acknowledged' })) }
                    : { schema: 2, status: 'acknowledged' }
                : {
                    schema: 1,
                    results: body.urls.map((url, index) => ({
                        index, status: 'acknowledged',
                    })),
                }
            ));
        });
        return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if ( request.url?.startsWith('/search-shared') ) {
        const origin = `http://localhost:${server.address().port}`;
        response.end(page(`<main id="search">${['loading','clean','queued'].map(kind =>
            `<div class="MjjYud"><a href="${origin}/shared-${kind}"><h3>Shared ${kind}</h3></a></div>`
        ).join('')}</main>`));
        return;
    }
    if ( request.url === '/shared-loading' ) {
        sharedLoadingVisits++;
        sharedLoadingStarted.resolve();
        const timer = setTimeout(() => response.end(page('A page which should be cancelled during loading.')), 8000);
        response.on('close', () => {
            clearTimeout(timer);
            if ( response.writableEnded === false ) { sharedLoadingCancelled++; }
        });
        return;
    }
    if ( request.url === '/shared-queued' ) {
        sharedQueuedVisits++;
        response.end(page('A page which should be cancelled while queued.'));
        return;
    }
    if ( request.url === '/shared-clean' ) {
        response.end(page('<p>Independent local inspection of a small personal garden.</p>'));
        return;
    }
    if ( request.url === '/search-readiness' ) {
        const origin = `http://localhost:${server.address().port}`;
        response.end(page(`<main id="search">${Object.keys(readinessExpected)
            .map(name => `<div class="MjjYud" id="ready-${name}"><a href="${origin}/readiness/${name}"><h3>${name}</h3></a></div>`)
            .join('')}</main>`));
        return;
    }
    if ( request.url?.startsWith('/readiness/') ) {
        const kind = request.url.slice('/readiness/'.length);
        const ad = 'fetch("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js")';
        switch ( kind ) {
        case 'failed-background-fetch':
            response.end(page('<p>Readable page for signed-out visitors.</p><script>fetch("/readiness/account")</script>'));
            break;
        case 'account':
            response.statusCode = 401;
            response.end('Sign in to access account details.');
            break;
        case 'blank-200':
        case 'blank-202':
            response.statusCode = kind === 'blank-202' ? 202 : 200;
            response.end(page('<script>setTimeout(() => location.href="/ad",5000)</script>'));
            break;
        case 'blank':
            response.end(page('<script>const hiddenScriptText="Not page content"</script>', 'A title alone is not content'));
            break;
        case 'hidden':
            response.end(page('<div style="opacity:0"><p>Hidden text does not count.</p></div>'));
            break;
        case 'revealed':
            response.end(page('<p id="text" hidden>Personal page.</p><script>setTimeout(()=>document.getElementById("text").hidden=false,5000)</script>'));
            break;
        case 'changing':
            response.end(page(`<p id="text">Starting</p><script>
                const text=document.getElementById('text').firstChild;
                setInterval(()=>text.data=String(Date.now()),400);
                setTimeout(()=>${ad},6000);
            </script>`));
            break;
        case 'fetching':
            response.end(page(`<p>Loading content</p><script>fetch('/readiness/slow').then(()=>${ad})</script>`));
            break;
        case 'timer':
            response.end(page(`<p>Article already visible.</p><script>setTimeout(()=>${ad},6000)</script>`));
            break;
        case 'polling':
            response.end(page('<p>Busy page</p><script>setInterval(()=>fetch("/readiness/ping"),400)</script>'));
            break;
        case 'slow':
            setTimeout(( ) => response.end('content'), 6000);
            break;
        case 'ping':
            response.end('ping');
            break;
        case 'image':
            response.end(page('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="green"/></svg>'));
            break;
        case 'empty-svg':
            response.end(page('<svg width="100" height="100"></svg>'));
            break;
        case 'empty-video':
            response.end(page('<video width="100" height="100"></video>'));
            break;
        case 'empty-canvas':
            response.end(page('<canvas width="100" height="100"></canvas>'));
            break;
        case 'broken-style':
            response.end(page('<link rel="stylesheet" href="/readiness/missing.css"><p>Unstyled page.</p>'));
            break;
        case 'missing.css':
            response.statusCode = 404;
            response.end('missing');
            break;
        case 'broken-navigation':
            response.end(page('<p>Old page.</p><script>setTimeout(()=>location.href="/readiness/aborted",1000)</script>'));
            break;
        case 'aborted':
            response.destroy();
            break;
        case 'socket':
            response.end(page('<p>Page with a persistent socket.</p><script>window.socket=new WebSocket("ws://"+location.host+"/readiness/socket")</script>'));
            break;
        default:
            response.end(page('<p>Hi.</p>'));
        }
        return;
    }
    if ( request.url === '/search-waf' ) {
        const origin = `http://localhost:${server.address().port}`;
        response.end(page(`<main id="search">
            <div class="MjjYud" id="waf-delayed-result"><a href="${origin}/waf-delayed"><h3>Delayed challenge</h3></a></div>
            <div class="MjjYud" id="waf-clean-result"><a href="${origin}/waf-clean"><h3>Recovering clean page</h3></a></div>
            <div class="MjjYud" id="waf-stuck-result"><a href="${origin}/waf-stuck"><h3>Unfinished challenge</h3></a></div>
            <div class="MjjYud" id="accepted-result"><a href="${origin}/accepted"><h3>Ordinary accepted page</h3></a></div>
        </main>`));
        return;
    }
    if ( request.url === '/waf-stuck' ||
        request.url === '/waf-delayed' && delayedChallengeVisits++ === 0 ||
        request.url === '/waf-clean' && cleanChallengeVisits++ === 0
    ) {
        // No provider marker: generic 403s must get the same recovery window.
        response.statusCode = 403;
        response.setHeader('set-cookie', 'queree_check=passed; Path=/; SameSite=Lax');
        response.end(page(request.url === '/waf-stuck'
            ? '<p>Access denied.</p>'
            : '<script>setTimeout(() => location.reload(), 5000)</script>', 'Unavailable'));
        return;
    }
    if ( request.url === '/waf-clean' ) {
        challengeCookieHeader = request.headers.cookie || '';
        response.end(page('<p>Ordinary page after the browser check.</p>'));
        return;
    }
    if ( request.url === '/waf-delayed' ) {
        response.end(page('<script>fetch("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js")</script>'));
        return;
    }
    if ( request.url === '/accepted' ) {
        response.statusCode = 202;
        response.end(page('<p>Ordinary page without a browser challenge.</p>'));
        return;
    }
    if ( request.url?.startsWith('/search-concurrency') ) {
        const origin = `http://localhost:${server.address().port}`;
        response.end(page(`
            <main id="search">
                <div class="MjjYud"><a href="${origin}/slow-a"><h3>Slow A</h3></a></div>
                <div class="MjjYud"><a href="${origin}/slow-b"><h3>Slow B</h3></a></div>
            </main>
        `, 'Concurrency fixture'));
        return;
    }
    if ( request.url === '/search-history' ) {
        const origin = `http://localhost:${server.address().port}`;
        response.end(page(`<main id="search">
            <div class="MjjYud"><a href="${origin}/history-concurrent"><h3>Concurrent visit</h3></a></div>
            <div class="MjjYud"><a href="${origin}/history-delete"><h3>Inspection only</h3></a></div>
            <div class="MjjYud"><a href="${origin}/history-prior"><h3>Prior visit</h3></a></div>
        </main>`, 'History fixture'));
        return;
    }
    if ( request.url === '/search-history-disable' ) {
        const origin = `http://localhost:${server.address().port}`;
        response.end(page(`<main id="search">
            <div class="MjjYud"><a href="${origin}/history-disabled"><h3>Disable cleanup</h3></a></div>
        </main>`, 'History disable fixture'));
        return;
    }
    if ( request.url?.startsWith('/search-community') ) {
        const port = server.address().port;
        response.end(page(`
            <main id="search">
                ${['plain', 'ad'].map(kind => `<div class="MjjYud" id="community-${kind}"><a href="http://community.localhost:${port}/community/${kind}"><h3>${kind} community page</h3></a></div>`).join('')}
            </main>
        `, 'Community fixture'));
        return;
    }
    if ( request.url === '/community/plain' || request.url === '/community/ad' ) {
        communityVisits += 1;
        response.end(page(`<p>An independent contributor's garden notebook.</p>
            ${request.url === '/community/ad'
                ? '<script>fetch("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js")</script>'
                : ''}`, 'Community page'));
        return;
    }
    if ( request.url?.startsWith('/search-errors') ) {
        const origin = `http://localhost:${server.address().port}`;
        response.end(page(`
            <main id="search">
                <div class="MjjYud" id="missing-result"><a href="${origin}/missing"><h3>Missing page</h3></a></div>
                <div class="MjjYud" id="redirect-community-result"><a href="${origin}/to-community"><h3>Redirected community page</h3></a></div>
                <div class="MjjYud" id="download-result"><a href="${origin}/download"><h3>Download response</h3></a></div>
            </main>
        `, 'Error fixture'));
        return;
    }
    if ( request.url?.startsWith('/search-navigation') ) {
        const origin = `http://localhost:${server.address().port}`;
        response.end(page(`
            <main id="search">
                <div class="MjjYud" id="navigation-result"><a href="${origin}/late-navigation"><h3>Late navigation</h3></a></div>
            </main>
        `, 'Navigation fixture'));
        return;
    }
    if ( request.url?.startsWith('/search-route-events') ) {
        const origin = `http://localhost:${server.address().port}`;
        const paths = [ 'encoded%20name?value=a%2Fb#chapter', '%C3%B1?value=%2520#part',
            'plain#section:~:text=Hello%20world' ];
        response.end(page(`<main id="search">${paths.map((path, i) =>
            `<div class="MjjYud"><a href="${origin}/route-events/${path}"><h3>Route ${i}</h3></a></div>`
        ).join('')}</main>`, 'Route events fixture'));
        return;
    }
    if ( request.url?.startsWith('/route-events/') ) {
        response.setHeader('content-type', 'text/html');
        if ( request.url === '/route-events/late.js' ) {
            response.setHeader('content-type', 'application/javascript');
            setTimeout(() => response.end('window.routeResourceLoaded = true;'), 750);
        } else {
            response.end(page('<p>Hello world. Ordinary personal page.</p><script defer src="/route-events/late.js"></script>'));
        }
        return;
    }
    if ( request.url?.startsWith('/search-bing') ) {
        const origin = `http://localhost:${server.address().port}`;
        let excludedTarget = `${origin}/bing-prefix`;
        while ( excludedTarget.length % 3 !== 0 ) { excludedTarget += 'x'; }
        const cleanTarget = `${excludedTarget}?clean=1`;
        const excludedEncoded = Buffer.from(excludedTarget).toString('base64url');
        const cleanEncoded = Buffer.from(cleanTarget).toString('base64url');
        if ( cleanEncoded.startsWith(excludedEncoded) === false ) {
            throw new Error('Bing prefix fixture is invalid');
        }
        response.end(page(`
            <main id="b_content"><ol id="b_results">
                <li class="b_algo" id="bing-result"><h2><a href="https://www.bing.com/ck/a?p=old&u=a1${excludedEncoded}&x=1">Bing ad page</a></h2></li>
                <li class="b_algo" id="bing-prefix-result"><h2><a href="https://www.bing.com/ck/a?p=other&u=a1${cleanEncoded}&x=1">Bing clean prefix page</a></h2></li>
                <li class="b_algo" id="bing-direct-result"><h2><a href="${origin}/ad?bing-direct=1">Bing direct ad page</a></h2></li>
            </ol></main>
        `, 'Bing fixture'));
        return;
    }
    if ( request.url?.startsWith('/search-affiliate') ) {
        const origin = `http://localhost:${server.address().port}`;
        response.end(page(`
            <main id="search">
                <div class="MjjYud" id="affiliate-spotify"><a href="${origin}/affiliate/spotify"><h3>Music links</h3></a></div>
                <div class="MjjYud" id="affiliate-sponsored"><a href="${origin}/affiliate/sponsored"><h3>Sponsored referral</h3></a></div>
                <div class="MjjYud" id="affiliate-newsletter"><a href="${origin}/affiliate/newsletter"><h3>Newsletter links</h3></a></div>
                <div class="MjjYud" id="affiliate-prose"><a href="${origin}/affiliate/prose"><h3>Affiliate prose</h3></a></div>
            </main>
        `, 'Affiliate fixture'));
        return;
    }
    if ( request.url?.startsWith('/search-cache') ) {
        const origin = `http://localhost:${server.address().port}`;
        response.end(page(`<main id="search">
            <div class="MjjYud"><a href="${origin}/cache-page"><h3>Cache page</h3></a></div>
        </main>`, 'Cache fixture'));
        return;
    }
    if ( request.url?.startsWith('/search-news-pagination') || request.url?.startsWith('/native-news-batch') ) {
        const url = new URL(request.url, `http://localhost:${server.address().port}`);
        const mobile = url.searchParams.get('layout') === 'mobile';
        const batch = Number(url.searchParams.get('batch'));
        const first = [ 0, 2, 6, 10 ][batch];
        const count = [ 2, 4, 4, 10 ][batch];
        const urls = Array.from({ length: count }, (_, i) =>
            `http://community.localhost:${server.address().port}/news/${first + i}`);
        if ( batch !== 0 ) { urls.push(`http://blocked.localhost:${server.address().port}/news/${batch}`); }
        const rows = urls.map((href, i) => mobile
            ? `<div class="newscard vr"><div class="caption noimg"><div class="bottom"><span class="source">Native source</span></div>
                <a class="title itemlink" href="${href}">News ${first + i}</a></div></div>`
            : `<div class="news-card newsitem cardcommon">
            <div class="news-card-body"><div class="caption"><div class="t_s"><div class="t_t">
            <a class="title" href="${href}"><h2>News ${first + i}</h2></a></div></div>
            <div class="snippet">Native news snippet</div></div></div></div>`).join('');
        response.setHeader('content-type', 'text/html');
        if ( url.pathname === '/native-news-batch' ) {
            setTimeout(() => response.end(rows), batch === 3 ? 2000 : 100);
        } else {
            response.end(page(`<style>#algocore { display:block; }
                #coreresults { display:grid; grid-template-columns:1fr 1fr; }
                .newscard { min-height:500px; }</style>
                <main id="${mobile ? 'coreid' : 'contentid'}"><div id="${mobile ? 'coreresults' : 'algocore'}">${rows}</div>
                <span id="infinite-scroll-config"></span></main><script>
                window.nativeNewsCalls = [];
                window.nativeNewsActive = 0;
                function loadBatch(force) {
                    if (window.nativeNewsActive !== 0 || window.nativeNewsCalls.length === 3) { return; }
                    if (!${mobile} && force !== true) { throw Error('Unforced native load'); }
                    window.nativeNewsActive++;
                    const batch = window.nativeNewsCalls.push(force);
                    fetch('/native-news-batch?layout=${mobile ? 'mobile' : 'desktop'}&batch='+batch).then(response=>response.text()).then(html=>{
                        document.querySelector('#algocore, #coreresults').insertAdjacentHTML('beforeend',html);
                        if (batch === 3) { document.querySelector('#infinite-scroll-config').remove(); }
                    }).finally(()=>{ window.nativeNewsActive--; });
                }
                if (${mobile}) {
                    window.MobileNewsVerticalInfiniteScrollVNext = { Init() { loadBatch(true); } };
                    window.addEventListener('scroll',()=>{ if (window !== window.top) { loadBatch(false); } });
                    window.MobileNewsVerticalInfiniteScrollVNext.Init();
                } else { window.ResponsiveNewsInfiniteScroll = { StartAjax:loadBatch }; }
                </script>`, 'Bing News native pagination fixture'));
        }
        return;
    }
    if ( request.url?.startsWith('/search-pagination') ) {
        const url = new URL(request.url, `http://localhost:${server.address().port}`);
        const bing = url.searchParams.get('engine') === 'bing';
        const offset = Number(url.searchParams.get(bing ? 'first' : 'start'));
        const index = Math.floor(offset / 10);
        paginationVisits.push({ engine: bing ? 'Bing' : 'Google', index });
        const counts = [ 3, 3, 4, 10 ];
        const first = [ 0, 3, 6, 10 ][index];
        const urls = Array.from({length:counts[index]}, (_,i) =>
            `http://community.localhost:${server.address().port}/entry/${first + i}`);
        if ( index === 0 && url.searchParams.has('stay') ) {
            urls[0] = `http://community.localhost:${server.address().port}/stay204`;
        }
        urls.push(`http://blocked.localhost:${server.address().port}/entry/${index}`);
        if ( index === 0 ) { urls.push('https://support.mozilla.org/en-US/questions/1303336'); }
        if ( index === 1 ) {
            urls.push(`http://community.localhost:${server.address().port}/${url.searchParams.has('stay') ? 'stay204' : 'entry/0'}`);
        }
        const icon = '<img class="native-icon" width="16" height="16" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">';
        const rows = urls.map((href,i) => {
            const address = `<div class="native-address native-page-${index}">${icon}<cite>${new URL(href).host}</cite></div>`;
            const widget = '<button onclick="window.remoteWidget = true">About this result</button>';
            return bing
                ? `<li class="b_algo" data-native-page="${index}">${address}<h2><a href="${href}">Result ${i}</a></h2><div class="b_caption"><p>Notebook</p></div>${widget}</li>`
                : `<div class="MjjYud" data-native-page="${index}"><a href="${href}">${address}<h3>Result ${i}</h3></a><div class="VwiC3b">Notebook</div>${widget}</div>`;
        }).join('');
        const next = new URL(url);
        next.searchParams.set(bing ? 'first' : 'start', String((index + 1) * 10 + (bing ? 1 : 0)));
        const link = index < 3 ? `<a ${bing ? 'class="sb_pagN"' : 'id="pnnext"'} href="${next.href}">Next</a>` : '';
        const nativeStyle = `<style>
            #rso > .MjjYud, #b_results > .b_algo { margin-block: 0 24px; padding: 0 8px; }
            #rso .VwiC3b, #b_results .b_caption p { font: 14px/22px serif; }
            .native-address { display: flex; gap: 6px; font: 12px/18px sans-serif; }
            .native-page-${index} { --queree-native-page: ${index}; }
            body { --queree-native-body: ${index}; }
        </style>`;
        const html = page(nativeStyle + (bing ? `<main id="b_content"><ol id="b_results">${rows}</ol>${link}</main>`
            : `<main id="search"><div id="rso">${rows}</div>${link}</main>`), 'Pagination fixture');
        if ( index === 3 ) { setTimeout(() => response.end(html), 2000); }
        else { response.end(html); }
        return;
    }
    if ( request.url?.startsWith('/search-personal') ) {
        const origin = `http://localhost:${server.address().port}`;
        response.end(page(`<main id="search">
            <div class="MjjYud" id="clean-result"><a href="${origin}/cache-page"><h3>Garden notebook</h3></a></div>
            <div class="MjjYud" id="ad-result"><a href="${origin}/ad"><h3>Advertising page</h3></a></div>
        </main>`, 'Personal categories fixture'));
        return;
    }
    if ( request.url?.startsWith('/search') ) {
        const origin = `http://localhost:${server.address().port}`;
        response.setHeader('set-cookie', 'queree_personal=secret; Path=/; SameSite=Lax');
        response.end(page(`
            <main id="search">
                <div class="MjjYud" id="ad-group"><div class="MjjYud" id="ad-result"><div data-snhf><a href="${origin}/ad"><div><h3>Ad page</h3></div></a></div><div data-sncf>Ad page snippet</div></div></div>
                <div class="MjjYud" id="clean-result"><a href="${origin}/clean"><h3>Clean page</h3></a><div data-sncf>Clean page description</div><a href="${origin}/ad">Citation</a></div>
                <div class="MjjYud" id="challenge-result"><a href="${origin}/challenge"><h3>Challenge page</h3></a></div>
                <div class="MjjYud" id="method-result"><a href="${origin}/method"><h3>HEAD ad request</h3></a></div>
                <div class="MjjYud" id="store-result"><a href="${origin}/store-global"><h3>Store global</h3></a></div>
            </main>
            <script>
                let sourceAttempts = 0;
                const reportSourceState = () => {
                    if (window.quereePersonalScriptlet === undefined && sourceAttempts++ < 20) {
                        setTimeout(reportSourceState, 100);
                        return;
                    }
                    fetch('/state-probe?frame=source&value=' +
                        window.quereePersonalScriptlet);
                };
                reportSourceState();
            </script>
            <iframe src="/source-frame"></iframe>
        `, 'Search fixture'));
        return;
    }
    if ( request.url === '/source-frame' ) {
        response.end(page(`<script>
            let attempts = 0;
            const report = () => {
                if (window.quereePersonalScriptlet === undefined && attempts++ < 20) {
                    setTimeout(report, 100);
                    return;
                }
                fetch('/state-probe?frame=source-iframe&value=' +
                    window.quereePersonalScriptlet);
            };
            report();
        </script>`));
        return;
    }
    if ( request.url === '/ad' || request.url?.startsWith('/ad?') ) {
        adVisits += 1;
        response.end(page(`<script>
            window.quereePersonalScriptlet = 0;
        </script><iframe src="/ad-frame"></iframe>`));
        return;
    }
    if ( request.url?.startsWith('/bing-prefix') ) {
        response.end(request.url.includes('?clean=1')
            ? page('<p>Personal page with no advertising requests.</p>')
            : page('<script>fetch("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js")</script>')
        );
        return;
    }
    if ( request.url?.startsWith('/affiliate/') ) {
        let body;
        if ( request.url === '/affiliate/spotify' ) {
            body = [ 1, 2, 3 ].map(id =>
                `<a href="https://open.spotify.com/track/fictional-${id}">Track</a>`).join('');
        } else if ( request.url === '/affiliate/newsletter' ) {
            body = [ 1, 2, 3 ].map(id =>
                `<a href="https://newsletter.example/read/fictional-${id}">Newsletter</a>`).join('');
        } else if ( request.url === '/affiliate/sponsored' ) {
            body = '<a rel="sponsored" href="https://ordinary.example/offer">Offer</a>';
        } else {
            body = '<p>When you buy through our links, we may earn a commission.</p>' +
                '<a href="https://ordinary.example/">Get Pricing</a>';
        }
        response.end(page(body));
        return;
    }
    if ( request.url === '/ad-frame' ) {
        response.end(page(`<script>
            window.quereePersonalScriptlet = 0;
            setTimeout(async () => {
                await fetch('/state-probe?frame=1&value=' +
                    window.quereePersonalScriptlet + '&windowName=' +
                    encodeURIComponent(window.name));
                fetch('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?' +
                    Date.now());
            }, 100);
        </script>`));
        return;
    }
    if ( request.url === '/method' ) {
        response.end(page('<script>fetch("https://abcdefgh.xyz/", { method: "HEAD" })</script>'));
        return;
    }
    if ( request.url === '/store-global' ) {
        response.end(page(`
            <p>$10.00</p><button class="add-to-cart">Add to cart</button>
            <script type="application/ld+json">{"@type":"Product","name":"Fictional bowl","offers":{"@type":"Offer","price":"10.00"}}</script>
            <script>window.Shopify = { shop: 'fixture' }; window.ShopifyAnalytics = {};</script>
        `));
        return;
    }
    if ( request.url === '/download' ) {
        response.setHeader('content-disposition', 'attachment; filename="fixture.bin"');
        response.setHeader('content-type', 'application/octet-stream');
        response.end('not a page');
        return;
    }
    if ( request.url === '/challenge' ) {
        response.end(page('<p>Checking your browser</p>', 'Just a moment...'));
        return;
    }
    if ( request.url?.startsWith('/state-probe') ) {
        const url = new URL(request.url, 'http://localhost');
        scriptletStates.push({
            frame: url.searchParams.get('frame'),
            value: url.searchParams.get('value'),
            windowName: url.searchParams.get('windowName'),
        });
        response.setHeader('content-type', 'text/plain');
        response.end('recorded');
        return;
    }
    if ( request.url === '/missing' ) {
        response.statusCode = 404;
        response.end(page('<p>Missing</p>', 'Not found'));
        return;
    }
    if ( request.url === '/to-community' ) {
        response.statusCode = 302;
        response.setHeader(
            'location',
            `http://community.localhost:${server.address().port}/community/plain`
        );
        response.end();
        return;
    }
    if ( request.url === '/late-navigation' ) {
        response.end(page('<script>setTimeout(() => location.href = "/clean?late=1", 1000)</script>'));
        return;
    }
    if ( request.url === '/stay204' ) {
        response.writeHead(204);
        response.end();
        return;
    }
    if ( request.url === '/clean' ) {
        cleanCookieHeader = request.headers.cookie || '';
        response.end(page('<p>Personal page with no advertising requests.</p>', 'Clean page'));
        return;
    }
    if ( request.url === '/cache-page' ) {
        cachePageVisits += 1;
        response.end(page('<p>Cacheable personal page.</p>', 'Cache page'));
        return;
    }
    if ( request.url === '/history-delete' ) {
        response.end(page(`<p>Inspection-only page.</p><script>
            document.cookie = 'queree_inspection=1; SameSite=Lax';
            localStorage.setItem('queree-inspection', '1');
            indexedDB.open('queree-inspection');
        </script>`));
        return;
    }
    if ( request.url === '/history-concurrent' ) {
        const respond = ( ) => response.end(page('<p>Concurrent history control.</p>'));
        if ( historyConcurrentVisits++ === 0 ) {
            setTimeout(respond, 5000);
        } else {
            respond();
        }
        return;
    }
    if ( request.url === '/history-prior' || request.url === '/history-disabled' ) {
        response.end(page('<p>Ordinary history control.</p>'));
        return;
    }
    if ( request.url?.startsWith('/slow-') ) {
        slowActive += 1;
        maxSlowActive = Math.max(maxSlowActive, slowActive);
        setTimeout(( ) => {
            slowActive -= 1;
            response.end(request.url === '/slow-a'
                ? page('<script>fetch("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js")</script>')
                : page('<p>Slow personal page.</p>')
            );
        }, 1000);
        return;
    }
    response.end(page('<p>Personal page with no advertising requests.</p>', 'Clean page'));
});

server.on('upgrade', (request, socket) => {
    upgradedSockets.add(socket);
    socket.on('close', ( ) => upgradedSockets.delete(socket));
    const accept = createHash('sha1')
        .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
    socket.on('error', ( ) => { });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
        `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
});

async function configure(endpoint, session, extensionURL, changes) {
    await navigate(endpoint, session, `${extensionURL}/queree.html`);
    await sleep(500);
    const result = await webdriverRequest(
        endpoint,
        `/session/${session}/execute/async`,
        {
            script: `
                const done = arguments[arguments.length - 1];
                (async () => {
                    const changes = ${JSON.stringify(changes)};
                    const initiallyReady = await vAPI.messaging.send('default', { what: 'readyToFilter' });
                    let ready = initiallyReady;
                    const deadline = Date.now() + 90000;
                    while ( ready !== true && Date.now() < deadline ) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                        ready = await vAPI.messaging.send('default', { what: 'readyToFilter' });
                    }
                    if ( ready !== true ) { throw new Error('uBO did not finish native startup'); }
                    if ( changes.contributionKey !== undefined ) {
                        await vAPI.messaging.send('queree', {
                            what: 'setContributionKey',
                            key: changes.contributionKey,
                        });
                    }
                    if ( changes.whitelist ) {
                        await vAPI.messaging.send('default', {
                            what: 'setWhitelist', whitelist: changes.whitelist,
                        });
                    }
                    if ( changes.userFilters ) {
                        await vAPI.messaging.send('dashboard', {
                            what: 'writeUserFilters', content: changes.userFilters,
                            enabled: true, trusted: false,
                        });
                        await vAPI.messaging.send('dashboard', {
                            what: 'reloadAllFilters',
                        });
                    }
                    for ( const [ name, value ] of Object.entries(changes.settings || {}) ) {
                        await vAPI.messaging.send('dashboard', {
                            what: 'userSettings', name, value,
                        });
                    }
                    done({ ok: true, waitedForNativeStartup: initiallyReady !== true });
                })().catch(reason => done({ error: reason.message }));
            `,
            args: [],
        }
    );
    if ( result?.error ) { throw new Error(result.error); }
    if ( result?.waitedForNativeStartup ) { console.error('Firefox fixture: waited for native startup before configuration'); }
    if ( changes.requireSingleDomain !== undefined ) {
        const selector = '[data-setting-name="quereeRequireSingleDomain"]';
        const element = await webdriverRequest(endpoint, `/session/${session}/element`, {
            using: 'css selector', value: selector,
        });
        const id = element['element-6066-11e4-a52e-4f735466cecf'];
        const selected = await webdriverRequest(endpoint, `/session/${session}/element/${id}/selected`);
        if ( selected !== changes.requireSingleDomain ) {
            await webdriverRequest(endpoint, `/session/${session}/element/${id}/click`, {});
        }
        await waitForValue(endpoint, session, `
            return vAPI.messaging.send('queree', { what: 'getSettings' }).then(settings =>
                settings.requireSingleDomain === ${changes.requireSingleDomain} &&
                document.querySelector('${selector}').checked === ${changes.requireSingleDomain}
            );
        `, value => value === true);
    }
    if ( changes.contributionConsent !== undefined ) {
        // Direct fixture messages bypass the settings page's refreshContribution().
        await navigate(endpoint, session, `${extensionURL}/queree.html`);
        await sleep(500);
        const element = await webdriverRequest(
            endpoint,
            `/session/${session}/element`,
            { using: 'css selector', value: '#quereeContribute' }
        );
        const id = element['element-6066-11e4-a52e-4f735466cecf'];
        let enabled = false;
        for ( let attempt = 0; attempt < 50; attempt++ ) {
            enabled = await webdriverRequest(
                endpoint,
                `/session/${session}/element/${id}/enabled`
            );
            if ( enabled ) { break; }
            await sleep(100);
        }
        if ( enabled === false ) {
            throw new Error('Invitation key did not enable contribution consent');
        }
        let selected = await webdriverRequest(
            endpoint,
            `/session/${session}/element/${id}/selected`
        );
        if ( selected !== changes.contributionConsent ) {
            await webdriverRequest(
                endpoint,
                `/session/${session}/element/${id}/click`,
                {}
            );
            for ( let attempt = 0; attempt < 50; attempt++ ) {
                selected = await webdriverRequest(
                    endpoint,
                    `/session/${session}/element/${id}/selected`
                );
                if ( selected === changes.contributionConsent ) { break; }
                await sleep(100);
            }
        }
        if ( selected !== changes.contributionConsent ) {
            throw new Error('Firefox did not apply contribution consent');
        }
        let state;
        for ( let attempt = 0; attempt < 50; attempt++ ) {
            state = await webdriverRequest(
                endpoint,
                `/session/${session}/execute/async`,
                {
                    script: `
                        const done = arguments[arguments.length - 1];
                        vAPI.messaging.send('queree', {
                            what: 'getContributionState',
                        }).then(done);
                    `,
                    args: [],
                }
            );
            if ( state?.consent === changes.contributionConsent ) { break; }
            await sleep(100);
        }
        if ( state?.consent !== changes.contributionConsent ) {
            throw new Error(`Contribution gate did not change: ${JSON.stringify(state)}`);
        }
    }
}

async function configureAside(endpoint, session, extensionURL, changes) {
    const current = await webdriverRequest(endpoint, `/session/${session}/window`);
    const created = await webdriverRequest(endpoint, `/session/${session}/window/new`, {
        type: 'tab',
    });
    await webdriverRequest(endpoint, `/session/${session}/window`, {
        handle: created.handle,
    });
    await configure(endpoint, session, extensionURL, changes);
    await fetch(`${endpoint}/session/${session}/window`, { method: 'DELETE' });
    await webdriverRequest(endpoint, `/session/${session}/window`, { handle: current });
}

async function clearDecisionCacheAside(endpoint, session, extensionURL) {
    const current = await webdriverRequest(endpoint, `/session/${session}/window`);
    const created = await webdriverRequest(endpoint, `/session/${session}/window/new`, {
        type: 'tab',
    });
    await webdriverRequest(endpoint, `/session/${session}/window`, {
        handle: created.handle,
    });
    await navigate(endpoint, session, `${extensionURL}/queree.html`);
    const state = await webdriverRequest(
        endpoint,
        `/session/${session}/execute/async`,
        {
            script: `
                const done = arguments[arguments.length - 1];
                vAPI.messaging.send('queree', {
                    what: 'clearDecisionCache',
                }).then(() => vAPI.messaging.send('queree', {
                    what: 'getDecisionCacheState',
                })).then(done).catch(reason => done({ error: reason.message }));
            `,
            args: [],
        }
    );
    await fetch(`${endpoint}/session/${session}/window`, { method: 'DELETE' });
    await webdriverRequest(endpoint, `/session/${session}/window`, { handle: current });
    if ( state?.count !== 0 ) {
        throw new Error(`Decision-cache clear failed: ${JSON.stringify(state)}`);
    }
}

async function enableHistoryCleanup(endpoint, session, extensionURL) {
    await navigate(endpoint, session, `${extensionURL}/queree.html`);
    const element = await webdriverRequest(
        endpoint,
        `/session/${session}/element`,
        { using: 'css selector', value: '#quereeCleanHistory' }
    );
    const elementId = element['element-6066-11e4-a52e-4f735466cecf'];
    const selected = await webdriverRequest(
        endpoint,
        `/session/${session}/element/${elementId}/selected`
    );
    if ( selected === false ) {
        await webdriverRequest(
            endpoint,
            `/session/${session}/element/${elementId}/click`,
            {}
        );
    }
    const state = await webdriverRequest(
        endpoint,
        `/session/${session}/execute/async`,
        {
            script: `
                const done = arguments[arguments.length - 1];
                Promise.all([
                    browser.permissions.contains({ permissions: [ 'history' ] }),
                    vAPI.messaging.send('dashboard', { what: 'userSettings' }),
                ]).then(([ permitted, settings ]) => done({
                    permitted,
                    enabled: settings.quereeCleanHistory === true,
                })).catch(reason => done({ error: reason.message }));
            `,
            args: [],
        }
    );
    if ( state.error || state.permitted !== true || state.enabled !== true ) {
        throw new Error(`Default history cleanup failed: ${JSON.stringify(state)}`);
    }
}

async function disableHistoryCleanupAside(endpoint, session, extensionURL) {
    const current = await webdriverRequest(endpoint, `/session/${session}/window`);
    const created = await webdriverRequest(endpoint, `/session/${session}/window/new`, {
        type: 'tab',
    });
    await webdriverRequest(endpoint, `/session/${session}/window`, {
        handle: created.handle,
    });
    await navigate(endpoint, session, `${extensionURL}/queree.html`);
    const element = await webdriverRequest(
        endpoint,
        `/session/${session}/element`,
        { using: 'css selector', value: '#quereeCleanHistory' }
    );
    const elementId = element['element-6066-11e4-a52e-4f735466cecf'];
    await webdriverRequest(
        endpoint,
        `/session/${session}/element/${elementId}/click`,
        {}
    );
    const state = await webdriverRequest(
        endpoint,
        `/session/${session}/execute/async`,
        {
            script: `
                const done = arguments[arguments.length - 1];
                Promise.all([
                    browser.permissions.contains({ permissions: [ 'history' ] }),
                    vAPI.messaging.send('dashboard', { what: 'userSettings' }),
                ]).then(([ permitted, settings ]) => done({
                    permitted,
                    enabled: settings.quereeCleanHistory === true,
                })).catch(reason => done({ error: reason.message }));
            `,
            args: [],
        }
    );
    await fetch(`${endpoint}/session/${session}/window`, { method: 'DELETE' });
    await webdriverRequest(endpoint, `/session/${session}/window`, { handle: current });
    if ( state.error || state.permitted !== true || state.enabled !== false ) {
        throw new Error(`History cleanup disable failed: ${JSON.stringify(state)}`);
    }
}

async function readInspectionState(endpoint, session, extensionURL, urls) {
    const current = await webdriverRequest(endpoint, `/session/${session}/window`);
    const created = await webdriverRequest(endpoint, `/session/${session}/window/new`, {
        type: 'tab',
    });
    await webdriverRequest(endpoint, `/session/${session}/window`, {
        handle: created.handle,
    });
    await navigate(endpoint, session, `${extensionURL}/queree.html`);
    const result = await webdriverRequest(
        endpoint,
        `/session/${session}/execute/async`,
        {
            script: `
                const done = arguments[arguments.length - 1];
                const urls = ${JSON.stringify(urls)};
                Promise.all(urls.map(url => browser.history.getVisits({ url })))
                    .then(async visits => {
                        const stored = await browser.storage.local.get([
                            'quereeInspectionCookieStoreIds',
                            'quereeTestScriptletRegistrations',
                            'quereeTestInspectionCookieStoreIds',
                        ]);
                        const hiddenMarkers = await Promise.all(
                            (await browser.tabs.query({ hidden: true })).map(tab =>
                                browser.sessions.getTabValue(tab.id, 'quereeInspection')
                                    .catch(() => false)
                            )
                        );
                        const identities = await browser.contextualIdentities.query({});
                        const ids = new Set(stored.quereeTestInspectionCookieStoreIds || []);
                        for ( const identity of identities ) {
                            if ( identity.name === 'Quer.ee inspection' ) { ids.add(identity.cookieStoreId); }
                        }
                        const cookies = (await Promise.all(Array.from(ids, async storeId => {
                            try { return await browser.cookies.getAll({ storeId }); }
                            catch (reason) {
                                if ( identities.some(identity => identity.cookieStoreId === storeId) ) { throw reason; }
                                return []; // Removed stores are no longer addressable.
                            }
                        }))).flat();
                        done({
                            visits: visits.map(items => items.length),
                            containers: identities.filter(identity => ids.has(identity.cookieStoreId)).length,
                            checkedContainers: ids.size,
                            owned: stored.quereeInspectionCookieStoreIds?.length || 0,
                            inspectionTabs: hiddenMarkers.filter(value => value === true).length,
                            scriptletRegistrations:
                                stored.quereeTestScriptletRegistrations || 0,
                            cookies: cookies.length,
                        });
                    })
                    .catch(reason => done({ error: reason.message }));
            `,
            args: [],
        }
    );
    await fetch(`${endpoint}/session/${session}/window`, { method: 'DELETE' });
    await webdriverRequest(endpoint, `/session/${session}/window`, { handle: current });
    if ( result.error ) { throw new Error(`Inspection-state read failed: ${result.error}`); }
    return result;
}

async function waitForResults(endpoint, session, timeout = 180000) {
    let result;
    const deadline = Date.now() + timeout;
    while ( Date.now() < deadline ) {
        result = await execute(endpoint, session, `
            const panel = document.querySelector('#queree-results-control');
            const hidden = selector => {
                const node = document.querySelector(selector);
                return node === null
                    ? undefined
                    : getComputedStyle(node).display === 'none';
            };
            return {
                status: panel?.querySelector('span')?.textContent || '',
                adHidden: hidden('#ad-result'),
                cleanHidden: hidden('#clean-result'),
                challengeHidden: hidden('#challenge-result'),
                methodHidden: hidden('#method-result'),
                storeHidden: hidden('#store-result'),
                missingHidden: hidden('#missing-result'),
                downloadHidden: hidden('#download-result'),
                redirectCommunityHidden: hidden('#redirect-community-result'),
                navigationHidden: hidden('#navigation-result'),
                communityPlainHidden: hidden('#community-plain'),
                communityAdHidden: hidden('#community-ad'),
                bingHidden: hidden('#bing-result'),
                bingPrefixHidden: hidden('#bing-prefix-result'),
                bingDirectHidden: hidden('#bing-direct-result'),
                affiliateSpotifyHidden: hidden('#affiliate-spotify'),
                affiliateSponsoredHidden: hidden('#affiliate-sponsored'),
                affiliateNewsletterHidden: hidden('#affiliate-newsletter'),
                affiliateProseHidden: hidden('#affiliate-prose'),
                wafDelayedHidden: hidden('#waf-delayed-result'),
                wafCleanHidden: hidden('#waf-clean-result'),
                wafStuckHidden: hidden('#waf-stuck-result'),
                acceptedHidden: hidden('#accepted-result'),
                unresolved: document.querySelectorAll('.queree-unresolved').length,
                reasons: Array.from(document.querySelectorAll('.queree-unresolved'), node => ({
                    reason: node.dataset.reason,
                    detail: node.title,
                })),
            };
        `);
        if (
            /^\d+ of \d+ results inspected\.{0,3}$/.test(result.status) === false &&
            result.status.endsWith('(still checking)') === false &&
            result.status !== ''
        ) {
            return result;
        }
        await sleep(500);
    }
    throw new Error(`Results did not finish: ${JSON.stringify(result)}`);
}

async function waitForValue(endpoint, session, script, accept, timeout = 5000) {
    const deadline = Date.now() + timeout;
    let value;
    while ( Date.now() < deadline ) {
        value = await execute(endpoint, session, script);
        if ( accept(value) ) { return value; }
        await sleep(100);
    }
    throw new Error(`Timed out waiting for browser value: ${JSON.stringify(value)}`);
}

async function waitForDuplicateCount(endpoint, session, stage, script, accept) {
    try {
        return await waitForValue(endpoint, session, script, accept);
    } catch (reason) {
        let diagnostics;
        try {
            diagnostics = await execute(endpoint, session, `
                document.dispatchEvent(new Event('quereeFixtureDuplicateDiagnostics'));
                const attribute = 'data-queree-fixture-duplicate-diagnostics';
                const snapshot = document.documentElement.getAttribute(attribute);
                document.documentElement.removeAttribute(attribute);
                return snapshot === null
                    ? { error: 'Test-only duplicate diagnostics hook unavailable' }
                    : JSON.parse(snapshot);
            `);
        } catch (error) {
            diagnostics = { error: String(error) };
        }
        throw new Error(`${reason.message}\nDuplicate-count diagnostics (${stage}): ${JSON.stringify(diagnostics)}`,
            { cause: reason });
    }
}

async function runMalwareMode(endpoint, session, extensionURL, origin) {
    await navigate(endpoint, session, `${extensionURL}/queree.html`);
    const message = (channel, request) => webdriverRequest(endpoint, `/session/${session}/execute/async`, {
        script: `const done = arguments[arguments.length - 1];
            vAPI.messaging.send(${JSON.stringify(channel)}, ${JSON.stringify(request)})
                .then(done).catch(reason => done({ error: reason.message }));`,
        args: [],
    }).then(result => {
        if ( result?.error ) { throw new Error(result.error); }
        return result;
    });
    const assert = (condition, detail) => { if ( !condition ) { throw new Error(detail); } };
    const profile = await message('quereeMalwareFixture', { what: 'load' });
    assert(profile.realLists.map(list => list.key).sort().join(',') === 'ublock-badware,urlhaus-1' &&
        profile.realLists.every(list => list.filters > 100) && profile.loadedFilters > 100 &&
        profile.productionFilters === profile.expectedProductionFilters,
        `Full malware profiles not loaded: ${JSON.stringify(profile)}`);
    assert(profile.selected.length === 1 && profile.selected[0] === 'user-filters' &&
        profile.framesReady && profile.framesDistinct,
    `Independent frames or deselected startup failed: ${JSON.stringify(profile)}`);
    assert(profile.adException.result === 2 && profile.malwareException.result === 1,
        `Advertising exception leaked into malware frame: ${JSON.stringify(profile)}`);
    assert(profile.adLocal.result !== 1 && profile.malwareLocal.result === 1,
        `Fixture leaked into advertising frame: ${JSON.stringify(profile)}`);
    // A working ordinary-tab control makes absence in inspections meaningful.
    await navigate(endpoint, session, `${origin}/source-frame`);
    const ordinaryScriptlet = await waitForValue(endpoint, session,
        'return window.quereePersonalScriptlet;', value => value === 1);
    await navigate(endpoint, session, `${extensionURL}/queree.html`);
    let batch = 0;
    const inspect = async urls => {
        const results = await message('queree', {
            what: 'inspectResults', batchId: `malware-native-${++batch}`,
            items: urls.map((url, id) => ({ id: String(id), url })),
        });
        assert(results.length === urls.length, `Incomplete native malware results: ${JSON.stringify(results)}`);
        return results;
    };
    const socialOrigin = origin.replace('localhost', 'community.localhost');
    const excludedURLs = [ `${origin}/malware/root/payload`, `${origin}/malware/redirect`,
        `${origin}/malware/subresource`, `${origin}/malware/header` ];
    const exclusions = await inspect(excludedURLs);
    assert(exclusions.every(result => result.verdict === 'exclude' &&
        result.reasons?.some(reason => reason.kind === 'malware' && reason.rule)),
    `Native malware enforcement failed: ${JSON.stringify(exclusions)}`);
    assert((malwareVisits.get('/malware/root/payload') || 0) === 0 &&
        (malwareVisits.get('/malware/script.js') || 0) === 0,
    `Blocked local fixture reached the server: ${JSON.stringify([...malwareVisits])}`);
    const visitsBeforeSocial = JSON.stringify([...malwareVisits]);
    const social = await inspect([ `${socialOrigin}/malware/root/payload`, `${socialOrigin}/malware/subresource` ]);
    assert(social.every(result => result.verdict === 'uninspected' && result.personal_category?.enabled === true),
        `Internal Social must skip malware processing: ${JSON.stringify(social)}`);
    assert(JSON.stringify([...malwareVisits]) === visitsBeforeSocial, 'Internal Social opened a page');
    const allowedURLs = [ `${origin}/malware/good`, `${origin}/malware/root/payload-clean`, `${origin}/malware/cache` ];
    const allowed = await inspect(allowedURLs);
    assert(allowed.every(result => result.verdict === 'candidate'),
        `Ordinary/path-precision controls failed: ${JSON.stringify(allowed)}`);
    assert(scriptletStates.some(state => state.frame === 'malware-inspection' && state.value === '0'),
        `Missing positive inspection scriptlet control: ${JSON.stringify(scriptletStates)}`);
    assert(scriptletStates.filter(state => state.frame === 'malware-inspection').every(state => state.value === '0'),
        `Personal scriptlet reached a malware inspection: ${JSON.stringify(scriptletStates)}`);
    const accepted = await inspect([ allowedURLs[2] ]);
    assert(accepted[0].verdict === 'candidate' && accepted[0].cached === true,
        `Positive cache setup failed: ${JSON.stringify(accepted)}`);
    const cacheVisits = malwareVisits.get('/malware/cache');
    const refreshed = await message('quereeMalwareFixture', { what: 'block-cache' });
    assert(JSON.stringify(refreshed.selected) === JSON.stringify(profile.selected),
        'Malware profile loading changed ordinary selected lists');
    const replayed = await inspect([ allowedURLs[2] ]);
    assert(replayed[0].verdict === 'candidate' && replayed[0].cached === true,
        `A valid saved decision should replay without starting a new inspection: ${JSON.stringify(replayed)}`);
    await message('queree', { what: 'clearDecisionCache' });
    const fresh = await inspect([ allowedURLs[2] ]);
    assert(fresh[0].verdict === 'exclude' && fresh[0].cached !== true &&
        fresh[0].reasons?.[0]?.kind === 'malware',
    `A fresh inspection bypassed the malware check: ${JSON.stringify(fresh)}`);
    assert(malwareVisits.get('/malware/cache') === cacheVisits, 'Replay or fresh malware check opened the page');
    const historyURLs = [ ...excludedURLs, ...allowedURLs ];
    const state = await readInspectionState(endpoint, session, extensionURL, historyURLs);
    // An uncommitted redirect source is deliberately not eligible for history deletion.
    const historyClean = state.visits.every((count, index) => count === 0 ||
        (historyURLs[index] === `${origin}/malware/redirect` && count === 1));
    assert(state.inspectionTabs === 0 && state.containers === 0 && state.owned === 0 &&
        state.checkedContainers > 1 && state.cookies === 0 &&
        state.scriptletRegistrations > 0 && historyClean,
    `Malware fixture leaked inspection resources: ${JSON.stringify(state)}`);
    console.log(JSON.stringify({ passed: true, malware: { profile, ordinaryScriptlet,
        exclusions, social, allowed, accepted, fresh, cleanup: state } }, null, 2));
}

async function checkSharedExclusions(endpoint, session, extensionURL, origin) {
    const reportsBeforeShared = exclusionRequests.length;
    await configureAside(endpoint, session, extensionURL, {
        settings: { quereeSimultaneousInspections: 1 },
    });
    await navigate(endpoint, session, `${origin}/search-shared`);
    const result = await waitForResults(endpoint, session);
    if ( result.status !== '2 excluded, 0 unresolved' ||
        sharedLoadingVisits !== 1 || sharedLoadingCancelled !== 1 || sharedQueuedVisits !== 0 ||
        exclusionRequests.length !== reportsBeforeShared ) {
        throw new Error(`Shared exclusion cancellation failed: ${JSON.stringify({
            result, sharedLoadingVisits, sharedLoadingCancelled, sharedQueuedVisits,
            exclusionReports: exclusionRequests.length - reportsBeforeShared,
        })}`);
    }
    const cleanup = await readInspectionState(endpoint, session, extensionURL,
        [ 'loading', 'clean', 'queued' ].map(kind => `${origin}/shared-${kind}`));
    if ( cleanup.inspectionTabs !== 0 || cleanup.containers !== 0 || cleanup.owned !== 0 ||
        cleanup.cookies !== 0 || cleanup.checkedContainers < 2 ) {
        throw new Error(`Shared exclusion cleanup failed: ${JSON.stringify(cleanup)}`);
    }
    return { result, sharedLoadingVisits, sharedLoadingCancelled, sharedQueuedVisits, cleanup };
}

async function runRetentionMode(endpoint, session, extensionURL, origin) {
    const message = (channel, request) => webdriverRequest(endpoint, `/session/${session}/execute/async`, {
        script: `const done = arguments[arguments.length - 1];
            vAPI.messaging.send(${JSON.stringify(channel)}, ${JSON.stringify(request)})
                .then(done).catch(error => done({error:String(error)}));`, args: [],
    }).then(reply => {
        if ( reply?.error ) { throw Error(reply.error); }
        return reply;
    });
    const assert = (condition, detail) => { if ( !condition ) { throw Error(detail); } };
    const readTabs = () => execute(endpoint, session, `return browser.tabs.query({hidden:true}).then(tabs =>
        Promise.all(tabs.map(async tab => ({id:tab.id,url:tab.url,cookieStoreId:tab.cookieStoreId,
            marked:await browser.sessions.getTabValue(tab.id,'quereeInspection')}))))`);
    let batch = 0;
    const inspect = async url => {
        const results = await message('queree', { what: 'inspectResults',
            batchId: `retention-${++batch}`, items: [ { id: 'retention', url } ] });
        assert(results.length === 1, `Missing retention verdict: ${JSON.stringify(results)}`);
        return results[0];
    };
    const on = await message('queree', { what: 'toggleKeepUnresolvedTabs' });
    assert(on.keepUnresolvedTabs === true, 'Debug toggle did not enable retention');
    const failure = await inspect(`${origin}/waf-stuck`);
    assert(failure.verdict === 'unresolved', `Failure was not unresolved: ${JSON.stringify(failure)}`);
    const retained = await readTabs();
    assert(retained.length === 1 && retained[0].url === `${origin}/waf-stuck` && retained[0].marked === true,
        `Failed page was cleared or extra tabs accumulated: ${JSON.stringify({retained,verdict:failure.verdict,reasons:failure.reasons})}`);
    const body = await execute(endpoint, session, `return browser.tabs.executeScript(${retained[0].id},
        {code:'document.body.innerText'}).then(value=>value[0])`);
    assert(body.includes('Access denied.'), 'Failure content was not retained');
    const clean = await inspect(`${origin}/clean`);
    assert(clean.verdict === 'candidate', `A retained slot prevented the next inspection: ${JSON.stringify(clean)}`);
    const afterClean = await readTabs();
    assert(afterClean.length === 1 && afterClean[0].id === retained[0].id,
        'Further processing replaced the unresolved page');
    assert(cleanCookieHeader.includes('queree_check=') === false, 'Desktop replacement reused failed-page cookies');
    const second = await inspect(`${origin}/waf-stuck`);
    const accumulated = await readTabs();
    assert(second.verdict === 'unresolved' && accumulated.length === 2 &&
        accumulated.some(tab => tab.id === retained[0].id),
        'Unresolved pages did not accumulate in distinct tabs');
    const cached = await inspect(`${origin}/clean`);
    assert(cached.cached === true && (await readTabs()).length === 2,
        'Saved decisions should not create tabs or erase retained evidence');
    const off = await message('queree', { what: 'toggleKeepUnresolvedTabs' });
    assert(off.keepUnresolvedTabs === false, 'Debug toggle did not disable retention');
    await waitForValue(endpoint, session, `return browser.tabs.query({hidden:true}).then(tabs=>tabs.length)`, count => count === 0);
    const shortcut = await execute(endpoint, session,
        `return browser.commands.getAll().then(commands=>commands.find(c=>c.name==='queree-toggle-keep-unresolved'))`);
    assert(shortcut === null, `Obsolete debug shortcut remains: ${JSON.stringify(shortcut)}`);
    const cleanup = await execute(endpoint, session, `return browser.storage.local.get('quereeInspectionCookieStoreIds')
        .then(state=>(state.quereeInspectionCookieStoreIds || []).length)`);
    assert(cleanup === 0 && contributionRequests.length === 0, 'Inspection state or test uploads remain');
    console.log(JSON.stringify({passed:true,retention:{failure:failure.verdict,retained,accumulated,clean:clean.verdict,
        cached:cached.cached,remainingTabs:0,remainingContainers:cleanup,uploads:contributionRequests.length}}));
}

async function runPersonalMode(endpoint, session, extensionURL, origin) {
    const assert = (condition, detail) => { if ( !condition ) { throw Error(detail); } };
    const ready = () => waitForValue(endpoint, session,
        `return document.querySelector('#quereePersonalControls')?.disabled`, value => value === false, 60000);
    const stateScript = `return {
        status: document.querySelector('#queree-results-control span')?.textContent || '',
        ad: getComputedStyle(document.querySelector('#ad-result')).display === 'none',
        clean: getComputedStyle(document.querySelector('#clean-result')).display === 'none',
        label: document.querySelector('#ad-result .queree-characteristic')?.textContent || '',
    };`;
    const settled = (excluded, label) => waitForValue(endpoint, session, stateScript,
        state => state.status === `${excluded} excluded, 0 unresolved` &&
            (label === undefined || state.label === label), 120000);
    const editAside = async script => {
        const current = await webdriverRequest(endpoint, `/session/${session}/window`);
        const created = await webdriverRequest(endpoint, `/session/${session}/window/new`, { type: 'tab' });
        await webdriverRequest(endpoint, `/session/${session}/window`, { handle: created.handle });
        try {
            await navigate(endpoint, session, `${extensionURL}/queree.html`);
            await ready();
            await execute(endpoint, session, script);
            await waitForValue(endpoint, session,
                `return document.querySelector('#quereePersonalStatus').textContent`,
                value => value === 'Personal categories saved.');
        } finally {
            await fetch(`${endpoint}/session/${session}/window`, { method: 'DELETE' });
            await webdriverRequest(endpoint, `/session/${session}/window`, { handle: current });
        }
    };
    await configure(endpoint, session, extensionURL, { settings: { quereeSimultaneousInspections: 2 } });
    await ready();
    const name = 'Garden "notes" \\ pages';
    await execute(endpoint, session, `
        document.querySelector('#quereeAddCategory').click();
        document.querySelector('#quereeCategoryName').value = ${JSON.stringify(name)};
        document.querySelector('#quereeCategoryEntries').value = ${JSON.stringify(`${origin}/cache-page\n${origin}/ad`)};
        document.querySelector('#quereePersonalEditor').requestSubmit();
    `);
    await waitForValue(endpoint, session, `return document.querySelector('#quereePersonalStatus').textContent`,
        value => value === 'Personal categories saved.');
    await execute(endpoint, session, `document.querySelector('#quereeAddCategory').click();
        document.querySelector('#quereeCategoryName').value = 'Duplicate';
        document.querySelector('#quereeCategoryEntries').value = ${JSON.stringify(`${origin}/ad`)};
        document.querySelector('#quereePersonalEditor').requestSubmit();`);
    await waitForValue(endpoint, session, `return document.querySelector('#quereePersonalStatus').textContent`,
        value => value === `Page already in ${name}.`);
    await execute(endpoint, session, `document.querySelector('#quereeCancelCategory').click();
        document.querySelector('#quereePersonalList .queree-category-row:last-child input').click();`);
    await waitForValue(endpoint, session, `return document.querySelector('#quereePersonalStatus').textContent`,
        value => value === 'Personal categories saved.');

    await navigate(endpoint, session, `${origin}/search-personal`);
    const hidden = await settled(2);
    assert(hidden.ad && hidden.clean && adVisits === 0 && cachePageVisits === 0,
        `Personal hide opened pages: ${JSON.stringify({hidden,adVisits,cachePageVisits})}`);
    await clickElement(endpoint, session, '#queree-results-control button');
    const marker = await waitForValue(endpoint, session,
        `return getComputedStyle(document.querySelector('#ad-result'), '::before').content`,
        value => value.includes('Garden') && value.includes('notes'));
    await editAside(`document.querySelector('#quereePersonalList .queree-category-row:last-child input').click();`);
    const shown = await settled(0, 'Advertising');
    assert(shown.ad === false && shown.clean === false && adVisits === 1 && cachePageVisits === 1,
        `Personal show lost inspection evidence: ${JSON.stringify({shown,adVisits,cachePageVisits})}`);
    await editAside(`document.querySelector('#quereePersonalList .queree-category-row:last-child input').click();`);
    await settled(2);
    await editAside(`document.querySelector('#quereePersonalList .queree-category-row:last-child input').click();`);
    await settled(0, 'Advertising');
    await navigate(endpoint, session, `${origin}/search-personal?reload=1`);
    const cached = await settled(0, 'Advertising');
    assert(adVisits === 1 && cachePageVisits === 1,
        `Category edits or reload repeated inspections: ${JSON.stringify({adVisits,cachePageVisits})}`);
    await editAside(`document.querySelector('#quereePersonalList .queree-category-row:last-child .queree-category-delete').click();`);
    const removed = await settled(1);
    assert(removed.ad && removed.clean === false && adVisits === 1 && cachePageVisits === 1,
        'Deleting the override did not restore the cached Advertising exclusion');
    await navigate(endpoint, session, `${origin}/search-community`);
    await waitForValue(endpoint, session,
        `return document.querySelector('#queree-results-control span')?.textContent`,
        value => value === '0 excluded, 0 unresolved');
    await editAside(`document.querySelector('#quereePersonalList .queree-category-row:first-child input').click();`);
    await waitForValue(endpoint, session,
        `return document.querySelector('#queree-results-control span')?.textContent`,
        value => value === '2 excluded, 0 unresolved');
    assert(communityVisits === 0, 'Internal Social opened inspection pages');
    await navigate(endpoint, session, `${extensionURL}/queree.html`);
    const cleanup = await execute(endpoint, session, `return Promise.all([
        browser.tabs.query({hidden:true}),
        browser.storage.local.get('quereeInspectionCookieStoreIds'),
    ]).then(([tabs,state])=>({tabs:tabs.length,containers:(state.quereeInspectionCookieStoreIds || []).length}));`);
    assert(cleanup.tabs === 0 && cleanup.containers === 0 &&
        contributionRequests.length === 0 && exclusionRequests.length === 0,
        `Personal fixture leaked resources or uploaded: ${JSON.stringify(cleanup)}`);
    console.log(JSON.stringify({passed:true,personal:{hidden,shown,cached,removed,marker,
        adVisits,cachePageVisits,communityVisits,cleanup,uploads:contributionRequests.length}}));
}

async function runPaginationMode(endpoint, session, extensionURL, origin) {
    // WebDriver's element-click helper installs an unload listener. Use pointer
    // input here so the test itself does not interfere with Firefox's Back cache.
    const pointerClick = async selector => {
        const point = await execute(endpoint, session, `
            const node = document.querySelector(${JSON.stringify(selector)});
            node.scrollIntoView({block:'center'});
            const rect = node.getBoundingClientRect();
            return {x:Math.round(rect.x + rect.width / 2),y:Math.round(rect.y + rect.height / 2)};
        `);
        await webdriverRequest(endpoint, `/session/${session}/actions`, { actions: [{
            type:'pointer', id:'queree-back-cache', parameters:{pointerType:'mouse'},
            actions:[ {type:'pointerMove',duration:0,origin:'viewport',...point},
                {type:'pointerDown',button:0}, {type:'pointerUp',button:0} ],
        }] });
    };
    const visitResultAndBack = async label => {
        const token = await execute(endpoint, session, `
            const token = crypto.randomUUID();
            document.documentElement.setAttribute('data-queree-fixture-token', token);
            document.documentElement.removeAttribute('data-queree-fixture-restored');
            addEventListener('pageshow', event => document.documentElement.setAttribute(
                'data-queree-fixture-restored', String(event.persisted)), {once:true});
            addEventListener('pagehide', event => history.replaceState({
                frames:document.querySelectorAll('iframe').length, persisted:event.persisted,
                paging:document.documentElement.getAttribute('data-queree-pagination')
            }, ''), {once:true});
            return token;
        `);
        await pointerClick('#rso .MjjYud h3, #b_results h2 a[href]');
        await waitForValue(endpoint, session, 'return location.pathname', path => path?.startsWith('/entry/') === true);
        await webdriverRequest(endpoint, `/session/${session}/back`, {});
        const restored = await execute(endpoint, session, `return {
            token:document.documentElement.getAttribute('data-queree-fixture-token'),
            persisted:document.documentElement.getAttribute('data-queree-fixture-restored'),
            leaving:history.state};`);
        if ( restored.token !== token || restored.persisted !== 'true' ) {
            throw Error(`Firefox did not keep ${label}: ${JSON.stringify(restored)}`);
        }
    };
    // Source-only decisions isolate paging from already-tested filter compilation.
    await configure(endpoint, session, extensionURL, { settings: {
        // Serialize source-only decisions so prefetch cannot race the exact page-count check.
        quereeSimultaneousInspections: 1,
        quereePersonalCategories: [ ...socialFixtureCategories,
            { name: 'Skip', enabled: false, entries: ['blocked.localhost/*'] } ],
    } });
    // First-install UI can select another tab; this test exercises the visible search.
    await execute(endpoint, session,
        `return browser.tabs.getCurrent().then(tab => browser.tabs.update(tab.id, {active:true}));`);
    const stateScript = `return {
        status:document.querySelector('#queree-results-control span')?.textContent || '',
        button:document.querySelector('.queree-more-results')?.textContent || '',
        hidden:document.querySelector('.queree-more-results')?.hidden,
        frames:document.querySelectorAll('iframe').length,
        visible:!document.hidden,
        paging:document.documentElement.getAttribute('data-queree-pagination'),
        good:Array.from(document.querySelectorAll('h3,h2')).filter(h=>
            h.closest('a')?.href.includes('community.localhost') || h.querySelector('a')?.href.includes('community.localhost')).length,
    };`;
    const results = [];
    for ( const [ engine, layout, width ] of [
        [ 'google', 'desktop', 1100 ], [ 'google', 'mobile', 420 ],
        [ 'bing', 'desktop', 1100 ], [ 'bing', 'mobile', 420 ],
    ] ) {
        if ( paginationStayOnly ) { break; }
        await webdriverRequest(endpoint, `/session/${session}/window/rect`, { width, height: 900 });
        const visitsStart = paginationVisits.length;
        const searchURL = `${origin}/search-pagination?q=notebook-${layout}&engine=${engine}`;
        await navigate(endpoint, session, searchURL);
        await waitForValue(endpoint, session, stateScript, state => state.frames === 1);
        const sourceWindow = await webdriverRequest(endpoint, `/session/${session}/window`);
        const aside = await webdriverRequest(endpoint, `/session/${session}/window/new`, { type: 'tab' });
        let background;
        try {
            await webdriverRequest(endpoint, `/session/${session}/window`, { handle: aside.handle });
            await navigate(endpoint, session, `${extensionURL}/queree.html`);
            const readBackground = `return browser.tabs.query({}).then(tabs => {
                const tab = tabs.find(tab => tab.url === ${JSON.stringify(searchURL)});
                return browser.tabs.executeScript(tab.id, {code:${JSON.stringify(`(() => { ${stateScript} })()`)}});
            }).then(([state]) => state);`;
            background = await waitForValue(endpoint, session, readBackground, state =>
                state.visible === false && state.good === 10 && state.frames === 0 &&
                state.status === '3 excluded, 1 unresolved' && state.button === 'More results', 30000);
        } finally {
            await fetch(`${endpoint}/session/${session}/window`, { method: 'DELETE' });
            await webdriverRequest(endpoint, `/session/${session}/window`, { handle: sourceWindow });
        }
        const first = await waitForValue(endpoint, session, stateScript,
            state => state.good === 10 && state.status === '3 excluded, 1 unresolved' && state.frames === 0 && state.button === 'More results', 30000);
        const visited = paginationVisits.slice(visitsStart).filter(page => page.engine.toLowerCase() === engine).map(page => page.index);
        const appearance = await execute(endpoint, session, `
            const original = document.querySelector('#rso > .MjjYud, #b_results > .b_algo');
            const appended = document.querySelector('.queree-appended-result');
            const metrics = row => {
                const style = getComputedStyle(row);
                const caption = getComputedStyle(row.querySelector('.VwiC3b, .b_caption p'));
                return [style.margin, style.padding, caption.font].join('|');
            };
            return {sameStyle:metrics(original) === metrics(appended),
                laterPageStyle:getComputedStyle(appended.querySelector('.native-address')).getPropertyValue('--queree-native-page').trim() === appended.dataset.nativePage,
                originalPageUnchanged:getComputedStyle(document.body).getPropertyValue('--queree-native-body').trim() === '0',
                scopeSupported:typeof CSSScopeRule !== 'undefined',
                copiedStyleCount:document.querySelectorAll('.queree-appended-style').length,
                icon:appended.querySelector('img.native-icon')?.complete,
                address:appended.querySelector('cite')?.textContent,
                nativeLinks:Array.from(appended.querySelectorAll('a[href]')).every(a => a instanceof HTMLAnchorElement),
                widgets:appended.querySelectorAll('button, [onclick], script').length};
        `);
        if ( appearance.sameStyle !== true || appearance.laterPageStyle !== true || appearance.originalPageUnchanged !== true || appearance.icon !== true ||
            !appearance.address || appearance.nativeLinks !== true || appearance.widgets !== 0 ) {
            throw Error(`Result appearance changed: ${JSON.stringify(appearance)}`);
        }
        if ( JSON.stringify(visited) !== '[0,1,2]' ) { throw Error(`Wrong automatic paging: ${JSON.stringify(visited)}`); }
        await visitResultAndBack(`${engine}/${layout}/finished`);
        const restored = await waitForValue(endpoint, session, stateScript, state =>
            state.good === 10 && state.frames === 0 && state.status === first.status && state.button === first.button);
        if ( JSON.parse(restored.paging).complete !== true || paginationVisits.length !== visitsStart + visited.length ) {
            throw Error(`Back restarted a finished search: ${JSON.stringify(restored)}`);
        }
        const title = `return document.querySelector('#queree-results-control strong').textContent;`;
        const point = await execute(endpoint, session, `
            const rect = document.querySelector('#queree-results-control strong').getBoundingClientRect();
            return {x:Math.round(rect.x + rect.width / 2),y:Math.round(rect.y + rect.height / 2)};
        `);
        for ( const expected of ['Quer.ee (debug)', 'Quer.ee'] ) {
            await webdriverRequest(endpoint, `/session/${session}/actions`, { actions: [{
                type:'pointer', id:'queree-debug-title', parameters:{pointerType:'mouse'},
                actions:[ {type:'pointerMove',duration:0,origin:'viewport',...point},
                    ...Array.from({length:5},()=>[
                        {type:'pointerDown',button:0}, {type:'pointerUp',button:0}, {type:'pause',duration:120},
                    ]).flat() ],
            }] });
            await waitForValue(endpoint, session, title, value => value === expected);
        }
        await pointerClick('.queree-more-results');
        await waitForValue(endpoint, session, stateScript, state => state.frames === 1 && state.button === 'Stop loading');
        await pointerClick('.queree-more-results');
        const stopped = await waitForValue(endpoint, session, stateScript, state => state.frames === 0 && state.good === 10 && state.button === 'More results');
        const stoppedVisits = paginationVisits.length;
        await visitResultAndBack(`${engine}/${layout}/stopped`);
        const stoppedBack = await execute(endpoint, session, stateScript);
        if ( stoppedBack.frames !== 0 || stoppedBack.good !== 10 ||
            JSON.parse(stoppedBack.paging).auto !== false || paginationVisits.length !== stoppedVisits ) {
            throw Error(`Back undid Stop: ${JSON.stringify(stoppedBack)}`);
        }
        await pointerClick('.queree-more-results');
        await waitForValue(endpoint, session, stateScript, state => state.frames === 1);
        await visitResultAndBack(`${engine}/${layout}/in-flight`);
        const more = await waitForValue(endpoint, session, stateScript,
            state => state.good === 20 && state.status === '4 excluded, 1 unresolved' && state.frames === 0 &&
                state.hidden === false && state.button === 'No more results', 30000);
        if ( paginationVisits.slice(visitsStart).filter(page => page.engine.toLowerCase() === engine && page.index === 0).length !== 1 ) {
            throw Error('Back reloaded the first search page');
        }
        results.push({engine,layout,background,first,restored,appearance,debugGesture:true,stopped,stoppedBack,more,inflightBack:true});
        console.log(`Firefox Back checks passed: ${engine}/${layout}`);
    }
    await navigate(endpoint, session, `${origin}/search-pagination?q=stay-on-source&engine=google&stay=1`);
    await waitForValue(endpoint, session, stateScript,
        state => state.good === 10 && state.frames === 0 && state.button === 'More results' &&
            state.status === '3 excluded, 1 unresolved' && JSON.parse(state.paging).complete === true, 30000);
    const documentStart = await execute(endpoint, session, 'return performance.timeOrigin');
    await pointerClick('.queree-more-results');
    await waitForValue(endpoint, session, stateScript, state => state.frames === 1);
    await pointerClick('#rso .MjjYud h3');
    const stayed = await waitForValue(endpoint, session, stateScript,
        state => state.good === 20 && state.frames === 0 && state.button === 'No more results' &&
            state.status === '4 excluded, 1 unresolved' && JSON.parse(state.paging).complete === true, 30000);
    if ( JSON.parse(stayed.paging).target !== 20 ) { throw Error('A cancelled navigation changed the loading target'); }
    if ( await execute(endpoint, session, 'return performance.timeOrigin') !== documentStart ) {
        throw Error('The 204 response unexpectedly navigated away from the source');
    }
    console.log('Firefox 204 result kept the document and continued loading to twenty retained results');
    if ( paginationStayOnly ) {
        console.log(JSON.stringify({passed:true,pagination:{stayed,uploads:0}}));
        return;
    }
    const news = [];
    for ( const [ layout, width ] of [ [ 'desktop', 1100 ], [ 'mobile', 420 ] ] ) {
        await webdriverRequest(endpoint, `/session/${session}/window/rect`, { width, height: 900 });
        await navigate(endpoint, session, `${origin}/search-news-pagination?engine=bing-news&layout=${layout}&q=notebook-${layout}`);
        const readNews = `return {
            good:Array.from(document.querySelectorAll('.news-card a.title, .newscard a.title')).filter(a=>a.href.includes('community.localhost')).length,
            status:document.querySelector('#queree-results-control span')?.textContent || '',
            button:document.querySelector('.queree-more-results')?.textContent,
            frames:document.querySelectorAll('iframe').length,calls:window.nativeNewsCalls?.length,
            active:window.nativeNewsActive,display:getComputedStyle(document.querySelector('#algocore, #coreresults')).display,
            scroll:scrollY,auto:JSON.parse(document.documentElement.getAttribute('data-queree-pagination') || '{}').auto
        };`;
        const initial = await waitForValue(endpoint, session, readNews, state =>
            state.good === 10 && state.calls === (layout === 'mobile' ? 1 : 2) &&
                state.status === '2 excluded, 0 unresolved' && state.button === 'More results', 30000);
        if ( initial.frames !== 0 || initial.display !== (layout === 'mobile' ? 'grid' : 'block') ) {
            throw Error(`Native Bing News layout changed: ${JSON.stringify(initial)}`);
        }
        // Exercise trusted button presses while Bing's third batch is still pending.
        await clickElement(endpoint, session, '.queree-more-results');
        await waitForValue(endpoint, session, readNews, state => state.button === 'Stop loading' &&
            (layout === 'mobile' ? state.frames === 1 : state.calls === 3));
        await clickElement(endpoint, session, '.queree-more-results');
        const stopped = await waitForValue(endpoint, session, readNews, state => state.auto === false && state.button === 'More results');
        await clickElement(endpoint, session, '.queree-more-results');
        const complete = await waitForValue(endpoint, session, readNews, state =>
            state.good === 20 && state.calls === (layout === 'mobile' ? 1 : 3) && state.active === 0 &&
                state.frames === 0 && state.button === (layout === 'mobile' ? 'More results' : 'No more results'), 30000);
        if ( complete.scroll !== initial.scroll || complete.frames !== 0 ) {
            throw Error(`Native Bing News moved the reader or created a frame: ${JSON.stringify(complete)}`);
        }
        news.push({ layout, initial, stopped, complete });
    }
    if ( communityVisits !== 0 || contributionRequests.length !== 0 || exclusionRequests.length !== 0 ) {
        throw Error('Paging opened Social pages or uploaded test data');
    }
    console.log(JSON.stringify({passed:true,pagination:{results,stayed,news,visits:paginationVisits,uploads:0}}));
}

await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
});

let driver;
let session;
console.error('Firefox fixture: work directory', work);
try {
    execFileSync('unzip', [ '-q', sourceXPI, '-d', extension ]);
    await verifyFixtureSources(root, extension);
    if ( startupOnly || malwareOnly || sharedOnly || retentionOnly || personalOnly || paginationOnly || routesOnly || process.env.QUEREE_TEST_STARTUP_SETTINGS !== undefined ) {
        const startupPath = resolve(extension, 'js/start.js');
        const startup = await readFile(startupPath, 'utf8');
        await writeFile(startupPath,
            `await browser.storage.local.set(${JSON.stringify(startupSettings)});\n` + startup
        );
    }
    const manifestPath = resolve(extension, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if ( nonHtmlOnly ) { manifest.permissions.push('downloads'); }
    manifest.content_scripts.at(-1).matches.push('http://127.0.0.1/*');
    manifest.content_scripts.at(-1).matches.push('http://localhost/*');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const backgroundPath = resolve(extension, 'js/background.js');
    const background = await readFile(backgroundPath, 'utf8');
    await writeFile(backgroundPath, replaceOnce(background, 'autoUpdate: true', 'autoUpdate: false'));
    const resultsPath = resolve(extension, 'js/queree/search-results.js');
    const results = await readFile(resultsPath, 'utf8');
    const fixtureScope = replaceOnce(results,
        'function isSearchPage() {',
        "function isSearchPage() {\n        if (['localhost', '127.0.0.1'].includes(location.hostname)) { return location.protocol === 'http:' && location.pathname.startsWith('/search'); }"
    );
    let fixtureResults = replaceOnce(fixtureScope,
        'function searchEngineAdapter(hostname, pathname) {',
        "function searchEngineAdapter(hostname, pathname) {\n        if (['localhost', '127.0.0.1'].includes(hostname)) { const engine = new URL(location.href).searchParams.get('engine'); hostname = engine?.startsWith('bing') ? 'www.bing.com' : 'www.google.com'; if (engine === 'bing-news') { pathname = '/news/search'; } }"
    );
    fixtureResults = replaceOnce(fixtureResults,
        "    window.addEventListener('pageshow', onPageShow);",
        `    function captureDuplicateCountDiagnostics() {
        const selectors = Array.from(selectorReasons, ([ selector, reason ]) => ({ selector, reason }));
        let matchedContainers = [], selectorError;
        try {
            if ( selectors.length !== 0 ) {
                matchedContainers = Array.from(document.querySelectorAll(
                    selectors.map(item => item.selector).join(',')
                ), node => ({ id: node.id, className: node.className }));
            }
        } catch (error) { selectorError = String(error); }
        const rows = [
            [ 'ad-result', '/ad' ], [ 'method-result', '/method' ],
            [ 'store-result', '/store-global' ], [ 'extra-ad-result', '/ad' ],
        ].map(([ id, path ]) => {
            const row = document.getElementById(id);
            const heading = row?.querySelector(adapter.headingSelector);
            const anchor = heading ? resultAnchor(heading) : undefined;
            const url = (anchor && resultURL(anchor))?.href || new URL(path, location.href).href;
            const decision = recorded.get(url);
            return {
                id, present: row !== null, href: anchor?.href, decisionURL: url,
                display: row ? getComputedStyle(row).display : null,
                parentId: row?.parentElement?.id, html: row?.outerHTML,
                savedDecision: decision === undefined ? null : {
                    verdict: decision.verdict, reasons: decision.reasons,
                    single_domain: decision.single_domain, shopping_signals: decision.shopping_signals,
                    cached: decision.cached, checks_complete: decision.checks_complete,
                    inspection_error: decision.inspection_error, personal_category: decision.personal_category,
                },
                exclusionSelectorMatches: row === null ? [] : selectors.filter(item => {
                    try { return row.matches(item.selector); } catch { return false; }
                }),
            };
        });
        document.documentElement.setAttribute('data-queree-fixture-duplicate-diagnostics', JSON.stringify({
            summary: status?.textContent, rows, selectors, matchedContainers, selectorError,
            running, activeBatches: Array.from(activeBatches), stylesheetOperationsPending,
            excludedVisible, hidingUnavailable,
        }));
    }
    document.addEventListener('quereeFixtureDuplicateDiagnostics', captureDuplicateCountDiagnostics);
    vAPI.shutdown.add(() => document.removeEventListener('quereeFixtureDuplicateDiagnostics', captureDuplicateCountDiagnostics));
    window.addEventListener('pageshow', onPageShow);`
    );
    await writeFile(resultsPath, fixtureResults);
    const contributionPath = resolve(extension, 'js/queree/contribution.js');
    const contributionSource = await readFile(contributionPath, 'utf8');
    const fixtureContribution = replaceOnce(contributionSource,
        "const endpoint = 'https://api.quer.ee/v1/discoveries';",
        `const endpoint = 'http://localhost:${server.address().port}/v1/discoveries';`
    );
    await writeFile(contributionPath, fixtureContribution);
    const controllerPath = resolve(extension, 'js/queree/controller.js');
    const controllerSource = await readFile(controllerPath, 'utf8');
    let fixtureController = replaceOnce(controllerSource,
        'isLANAddress(address) ||',
        "(isLANAddress(address) && address !== '127.0.0.1' && address !== '::1') ||"
    );
    if ( routesOnly ) {
        fixtureController = `const routeFixtureEvents = globalThis.quereeFixtureRouteEvents = [];\n` + fixtureController;
        for ( const [ anchor, injected ] of [
            [ 'browser.webNavigation.onCommitted.addListener(details => {',
                `const fixtureJob = inspectionTabs.get(details.tabId);
                if (details.frameId === 0 && /^https?:/.test(details.url) && fixtureJob?.url.includes('/route-events/')) {
                    routeFixtureEvents.push({kind:'commit',url:fixtureJob.url,eventURL:details.url});
                }` ],
            [ 'browser.tabs.onUpdated.addListener((tabId, changeInfo) => {',
                `const fixtureJob = inspectionTabs.get(tabId);
                if (changeInfo.url && fixtureJob?.url.includes('/route-events/')) {
                    routeFixtureEvents.push({kind:'updated',url:fixtureJob.url,eventURL:changeInfo.url});
                }` ],
            [ '    job.documentURLs.add(job.destinationURL);\n    job.routeId = (job.routeId || 0) + 1;',
                `if (job.url.includes('/route-events/')) {
                    routeFixtureEvents.push({kind:'reset',url:job.url,eventURL:url,requests:job.requests.size});
                }` ],
        ] ) {
            fixtureController = replaceOnce(fixtureController, anchor, anchor + '\n' + injected);
        }
    }
    if ( historyNavigationOnly || retentionOnly || routesOnly ) {
        // Exercise real cleanup and navigation with short local-fixture deadlines.
        // Filter preparation has its own unchanged production deadline.
        for ( const [ from, to ] of [
            [ 'const observationPeriod = 20000;', 'const observationPeriod = 2000;' ],
            [ 'const inspectionTimeout = 70000;', `const inspectionTimeout = ${retentionOnly || routesOnly ? 15000 : 6000};` ],
            [ 'const inspectionPollInterval = 3000;', 'const inspectionPollInterval = 250;' ],
            [ 'const scrollInterval = 750;', 'const scrollInterval = 100;' ],
            [ 'const scrollLimit = 20;', 'const scrollLimit = 3;' ],
        ] ) {
            fixtureController = replaceOnce(fixtureController, from, to);
        }
    }
    if ( malwareOnly ) {
        // Test-only channel in the disposable XPI. Keep both complete real feeds;
        // append small local rules only to the isolated malware frame.
        fixtureController += `
const malwareFixtureOrigin = ${JSON.stringify(`http://localhost:${server.address().port}`)};
const malwareFixtureRules = [
    '|'+malwareFixtureOrigin+'/malware/root/payload|$all',
    '|'+malwareFixtureOrigin+'/malware/script.js|$script',
    '|'+malwareFixtureOrigin.replace('localhost', 'community.localhost')+'/malware/root/payload|$all',
    '|'+malwareFixtureOrigin+'/malware/header|$all,header=x-queree-malware:payload',
    '||googletagmanager.com/queree-malware-fixture$all',
];
vAPI.messaging.listen({ name: 'quereeMalwareFixture', listener(request, sender, callback) {
    if ( sender.privileged !== true ) { return vAPI.messaging.UNHANDLED; }
    return (async () => {
        await loadMalwareEngine();
        await loadEngine();
        if ( request.what === 'block-cache' ) {
            malwareFixtureRules.push('|'+malwareFixtureOrigin+'/malware/cache|$all');
        }
        const lists = await Promise.all(requiredMalwareLists.map(key => µb.getCompiledFilterList(key)));
        const before = JSON.stringify(µb.selectedFilterLists);
        const goodFilters = new Set(), badFilters = new Set();
        const realLists = lists.map(list => {
            const block = list.content.match(/#block-start-NETWORK_FILTERS:GOOD\\n([\\s\\S]*?)#block-end-NETWORK_FILTERS:GOOD/);
            if ( !block ) { throw new Error('Missing full malware feed: '+list.assetKey); }
            let filters = 0;
            for ( let i = 0; i < block[1].length; i++ ) {
                if ( block[1].charCodeAt(i) === 10 ) { filters += 1; }
            }
            for ( const line of block[1].split('\\n').filter(Boolean) ) { goodFilters.add(line); }
            const bad = list.content.match(/#block-start-NETWORK_FILTERS:BAD\\n([\\s\\S]*?)#block-end-NETWORK_FILTERS:BAD/);
            for ( const line of (bad?.[1] || '').split('\\n').filter(Boolean) ) { badFilters.add(line); }
            return { key: list.assetKey, filters };
        });
        const malwareFrame = policyFrame('quereeMalwareEngine');
        const productionFilters = request.what === 'load'
            ? JSON.parse(malwareFrame.document.documentElement.dataset.quereeLoadResult).filterCount : undefined;
        const expectedProductionFilters = Array.from(goodFilters).filter(line => badFilters.has(line) === false).length;
        if ( request.what === 'load' && (productionFilters !== expectedProductionFilters || productionFilters <= 100 ||
            malwareFrame.document.documentElement.dataset.quereeLoadState !== 'ready') ) {
            throw new Error('Production malware profile differs from complete feeds: '+JSON.stringify({
                productionFilters, expectedProductionFilters, realLists,
            }));
        }
        const adLists = await Promise.all(requiredLists.map(key => µb.getCompiledFilterList(key)));
        await loadPolicyFrame(policyFrame(), {
            compiledLists: [ ...profileCompiledLists(adLists),
                µb.compileFilters([
                    '||googletagmanager.com/queree-malware-fixture$script',
                    '@@||googletagmanager.com/queree-malware-fixture$script',
                ].join('\\n'), {
                    assetKey: 'queree-ad-exception-fixture',
                }) ],
            pslSelfie: publicSuffixList.toSelfie(),
        });
        const loaded = await loadPolicyFrame(malwareFrame, {
            compiledLists: [ ...lists.map(list => list.content),
                µb.compileFilters(malwareFixtureRules.join('\\n'), { assetKey: 'queree-malware-fixture' }) ],
            pslSelfie: publicSuffixList.toSelfie(),
        });
        if ( before !== JSON.stringify(µb.selectedFilterLists) ) { throw new Error('Selected lists changed'); }
        const details = url => ({ url, method: 'GET', type: 'main_frame', originURL: url, tabOriginURL: url });
        const exception = { ...details('https://www.googletagmanager.com/queree-malware-fixture'), type: 'script' };
        const local = details(malwareFixtureOrigin+'/malware/root/payload');
        return {
            selected: µb.selectedFilterLists.slice(), realLists, productionFilters,
            expectedProductionFilters, loadedFilters: loaded.filterCount,
            framesDistinct: malwareFrame !== policyFrame(),
            framesReady: [ malwareFrame, policyFrame() ].every(frame =>
                frame.document.documentElement.dataset.quereeLoadState === 'ready'),
            adException: policyCommand({ what: 'matchRequest', details: exception }),
            malwareException: matchMalwareRequest(exception),
            adLocal: policyCommand({ what: 'matchRequest', details: local }),
            malwareLocal: matchMalwareRequest(local),
        };
    })().then(callback).catch(reason => callback({ error: reason.message }));
} });
`;
    }
    await writeFile(controllerPath, fixtureController);
    const contributionCorePath = resolve(
        extension, 'js/queree/contribution-core.js'
    );
    const contributionCore = await readFile(contributionCorePath, 'utf8');
    let fixtureContributionCore = contributionCore;
    for ( const [ from, to ] of [
        [ "hostname === 'localhost' ||", "hostname === 'queree-invalid-fixture' ||" ],
        [ "localSuffixes.some(suffix => hostname === suffix.slice(1) || hostname.endsWith(suffix)) ||", "localSuffixes.some(suffix => (hostname === suffix.slice(1) || hostname.endsWith(suffix)) && hostname !== 'localhost' && hostname !== 'community.localhost') ||" ],
        [ "hostname.includes('.') === false ||", "hostname === 'queree-single-label-fixture' ||" ],
    ] ) {
        fixtureContributionCore = replaceOnce(fixtureContributionCore, from, to);
    }
    await writeFile(contributionCorePath, fixtureContributionCore);
    const communityDomainsPath = resolve(extension, 'js/queree/community-domains.js');
    const communityDomainsSource = await readFile(communityDomainsPath, 'utf8');
    const fixtureCommunityDomains = replaceOnce(communityDomainsSource,
        'export const communityDomains = [',
        "export const communityDomains = [\n    'community.localhost',"
    );
    await writeFile(communityDomainsPath, fixtureCommunityDomains);
    const inspectionContextPath = resolve(
        extension,
        'js/queree/inspection-context.js'
    );
    const inspectionContext = await readFile(inspectionContextPath, 'utf8');
    let fixtureInspectionContext = replaceOnce(inspectionContext,
        'const ownedCookieStoreIds = new Set();',
        'const ownedCookieStoreIds = new Set();\nconst fixtureCreatedCookieStoreIds = new Set();');
    fixtureInspectionContext = replaceOnce(fixtureInspectionContext,
        'ownedCookieStoreIds.add(identity.cookieStoreId);\n        activeCookieStoreIds.add(identity.cookieStoreId);',
        `fixtureCreatedCookieStoreIds.add(identity.cookieStoreId);
        await browser.storage.local.set({
            quereeTestInspectionCookieStoreIds: Array.from(fixtureCreatedCookieStoreIds),
        });
        ownedCookieStoreIds.add(identity.cookieStoreId);
        activeCookieStoreIds.add(identity.cookieStoreId);`
    );
    await writeFile(inspectionContextPath, fixtureInspectionContext);
    const scriptletPath = resolve(extension, 'js/scriptlet-filtering.js');
    const scriptletSource = await readFile(scriptletPath, 'utf8');
    const fixtureScriptlets = replaceOnce(scriptletSource,
        'const promise = browser.contentScripts.register(options).then(handle => {',
        `const promise = browser.contentScripts.register(options).then(handle => {
            browser.storage.local.get('quereeTestScriptletRegistrations').then(stored =>
                browser.storage.local.set({
                    quereeTestScriptletRegistrations:
                        (stored.quereeTestScriptletRegistrations || 0) + 1,
                })
            );`
    );
    await writeFile(scriptletPath, fixtureScriptlets);
    execFileSync('zip', [ '-qr', testXPI, '.' ], { cwd: extension });

    const port = 4461;
    const endpoint = `http://127.0.0.1:${port}`;
    driver = spawn(geckodriver, [ '--port', String(port) ], { stdio: ['ignore', 'inherit', 'inherit'] });
    for ( let attempt = 0; attempt < 100; attempt++ ) {
        try {
            await webdriverRequest(endpoint, '/status');
            break;
        } catch {
            await sleep(100);
        }
    }

    const created = await webdriverRequest(endpoint, '/session', {
        capabilities: { alwaysMatch: {
            browserName: 'firefox',
            pageLoadStrategy: 'eager',
            'moz:firefoxOptions': {
                ...(firefoxBinary === undefined ? {} : { binary: firefoxBinary }),
                args: [ '-headless' ],
                prefs: {
                    'browser.shell.checkDefaultBrowser': false,
                    'browser.startup.page': 0,
                    'datareporting.healthreport.uploadEnabled': false,
                    'extensions.webextOptionalPermissionPrompts': false,
                },
            },
        } },
    });
    session = created.sessionId;
    console.error('Firefox fixture: browser started');
    await webdriverRequest(endpoint, `/session/${session}/timeouts`, {
        pageLoad: 30000,
        script: 120000,
    });
    await webdriverRequest(endpoint, `/session/${session}/moz/addon/install`, {
        path: testXPI,
        temporary: true,
    });
    console.error('Firefox fixture: extension installed');
    const uuid = await extensionUUID(created.capabilities['moz:profile']);
    const extensionURL = `moz-extension://${uuid}`;
    if ( startupOnly ) {
        await navigate(endpoint, session, `${extensionURL}/queree.html`);
        const readState = () => webdriverRequest(endpoint, `/session/${session}/execute/async`, {
            script: `
                const done = arguments[arguments.length - 1];
                (async () => {
                    const ready = await vAPI.messaging.send('default', { what: 'readyToFilter' });
                    if ( ready !== true ) { return { ready }; }
                    const settings = await vAPI.messaging.send('queree', { what: 'getSettings' });
                    const lists = await vAPI.messaging.send('dashboard', { what: 'getLists' });
                    return { ready, enabled: settings.enabled,
                        lists: Object.keys(lists.current).filter(key => lists.current[key].off !== true),
                        networkFilters: lists.netFilterCount, cosmeticFilters: lists.cosmeticFilterCount };
                })().then(done).catch(reason => done({ error: reason.message }));
            `,
            args: [],
        });
        let initial;
        for ( let attempt = 0; attempt < 60; attempt++ ) {
            initial = await readState();
            if ( initial.ready || initial.error ) { break; }
            await sleep(1000);
        }
        const verify = state => {
            if ( state.ready !== true || state.enabled !== startupSettings.quereeEnabled ) {
                throw new Error(`Startup settings were not applied: ${JSON.stringify(state)}`);
            }
            const expectedLists = startupSettings.selectedFilterLists;
            if ( expectedLists !== undefined &&
                JSON.stringify(state.lists.slice().sort()) !== JSON.stringify(expectedLists.slice().sort()) ) {
                throw new Error(`Startup filter selection differs: ${JSON.stringify(state)}`);
            }
            if ( expectedLists?.length === 0 && (state.networkFilters !== 0 || state.cosmeticFilters !== 0) ) {
                throw new Error(`Disabled filters were loaded: ${JSON.stringify(state)}`);
            }
        };
        verify(initial);
        console.error(`Firefox fixture: startup ready ${JSON.stringify(initial)}`);
        await sleep(60000);
        const final = await readState();
        verify(final);
        console.log(JSON.stringify({ passed: true, startup: { initial, final, observedSeconds: 60 } }));
    } else if ( paginationOnly ) {
        await runPaginationMode(endpoint, session, extensionURL, `http://localhost:${server.address().port}`);
    } else if ( routesOnly ) {
        await configure(endpoint, session, extensionURL, { settings: {
            quereeRequireSingleDomain: false, quereeExcludeCrossSiteTracking: false,
        } });
        await navigate(endpoint, session, `http://localhost:${server.address().port}/search-route-events`);
        const result = await waitForResults(endpoint, session);
        if ( result.unresolved !== 0 ) { throw new Error(`Route inspection failed: ${JSON.stringify(result)}`); }
        await navigate(endpoint, session, `${extensionURL}/queree.html`);
        const events = await execute(endpoint, session, `return browser.runtime.getBackgroundPage().then(page => page.quereeFixtureRouteEvents);`);
        const commits = events.filter(event => event.kind === 'commit');
        const updated = events.filter(event => event.kind === 'updated');
        if ( commits.length !== 3 || new Set(updated.map(event => event.url)).size !== 3 ||
            events.some(event => event.kind === 'reset') ) {
            throw new Error(`Ordinary navigation reset route evidence: ${JSON.stringify(events)}`);
        }
        console.log(JSON.stringify({ passed: true, routes: { result, events } }));
    } else if ( personalOnly ) {
        await runPersonalMode(endpoint, session, extensionURL, `http://localhost:${server.address().port}`);
    } else if ( retentionOnly ) {
        await configure(endpoint, session, extensionURL, { settings: { quereeSimultaneousInspections: 1 } });
        await runRetentionMode(endpoint, session, extensionURL, `http://localhost:${server.address().port}`);
    } else {
    await configure(endpoint, session, extensionURL, {
        userFilters: 'localhost##+js(set-constant, quereePersonalScriptlet, 1)\n',
        settings: {
            autoUpdate: false,
            quereePersonalCategories: socialFixtureCategories,
            ...(historyNavigationOnly ? { quereeSimultaneousInspections: 2 } : {}),
            ...(singleDomainOnly ? { quereeSimultaneousInspections: 4 } : {}),
        },
        contributionKey: `qk_${'x'.repeat(43)}`,
        contributionConsent: true,
    });
    await enableHistoryCleanup(endpoint, session, extensionURL);
    console.error('Firefox fixture: configured');
    await sleep(1000);

    const origin = `http://localhost:${server.address().port}`;
    if ( malwareOnly ) {
        await runMalwareMode(endpoint, session, extensionURL, origin);
    } else if ( sharedOnly ) {
        // Warm the real profiles before timing the short shared lookup deadline.
        await navigate(endpoint, session, `${origin}/search-cache?shared-warmup=1`);
        await waitForResults(endpoint, session);
        const sharedExclusions = await checkSharedExclusions(endpoint, session, extensionURL, origin);
        console.log(JSON.stringify({ passed: true, sharedExclusions }, null, 2));
    } else if ( shoppingOnly ) {
        const trackingEnabled = await execute(endpoint, session, `
            return document.querySelector('[data-setting-name="quereeExcludeCrossSiteTracking"]')?.checked;
        `);
        const defaultEnabled = await execute(endpoint, session, `
            return document.querySelector('[data-setting-name="quereeExcludeShoppingSignals"]')?.checked;
        `);
        if ( defaultEnabled !== true ) { throw new Error('Shopping signals must default on'); }
        if ( await execute(endpoint, session, `return document.querySelector('[data-setting-name="quereeExcludeAdvertisingSignals"]')?.checked;`) !== true ) {
            throw new Error('Advertising signals must default on');
        }
        await navigate(endpoint, session, `${origin}/search-shopping`);
        const stateScript = `return {
            status: document.querySelector('#queree-results-control span')?.textContent || '',
            hidden: ${JSON.stringify(shoppingKinds)}.filter(kind =>
                getComputedStyle(document.querySelector('#shopping-' + kind)).display === 'none'),
        };`;
        const settled = (state, hidden) => state.status.startsWith(`${hidden.length} `) &&
            state.status.endsWith(', 0 unresolved') && JSON.stringify(state.hidden) === JSON.stringify(hidden);
        const checked = await waitForValue(endpoint, session, stateScript, state =>
            settled(state, ['software', 'offer', 'sponsored', 'ad']), 100000);
        const expectedVisits = Object.fromEntries(shoppingVisits);
        await configureAside(endpoint, session, extensionURL, {
            settings: { quereeExcludeShoppingSignals: false },
        });
        const unchecked = await waitForValue(endpoint, session, stateScript, state =>
            settled(state, ['sponsored', 'ad']));
        await configureAside(endpoint, session, extensionURL, {
            settings: { quereeExcludeAdvertisingSignals: false },
        });
        const bothOff = await waitForValue(endpoint, session, stateScript, state =>
            settled(state, []), inspectionTimeout + inspectionCleanupAllowance);
        // The ad check stopped early while enabled. Turning it off can require
        // one fresh inspection for tracking, not an instant cache-only redraw.
        if ( trackingEnabled ) { expectedVisits['/shopping/ad'] += 1; }
        if ( JSON.stringify(Object.fromEntries(shoppingVisits)) !== JSON.stringify(expectedVisits) ) {
            throw new Error(`Only the incomplete ad observation may be rechecked: ${JSON.stringify({
                expected: expectedVisits, actual: Object.fromEntries(shoppingVisits),
            })}`);
        }
        await configureAside(endpoint, session, extensionURL, {
            settings: { quereeExcludeShoppingSignals: true, quereeExcludeAdvertisingSignals: true },
        });
        await waitForValue(endpoint, session, stateScript, state =>
            JSON.stringify(state) === JSON.stringify(checked));
        await navigate(endpoint, session, `${origin}/search-shopping?cached=1`);
        const cached = await waitForValue(endpoint, session, stateScript, state =>
            JSON.stringify(state) === JSON.stringify(checked), 10000);
        if ( JSON.stringify(Object.fromEntries(shoppingVisits)) !== JSON.stringify(expectedVisits) ) {
            throw new Error('Completed checks must be reused without further page inspections');
        }
        for ( let attempt = 0; contributionRequests.length < 4 && attempt < 50; attempt++ ) {
            await sleep(100);
        }
        for ( const [ kind, expected ] of [ ['software', true], ['offer', true], ['plain', false], ['referral', false] ] ) {
            const observations = contributionRequests.filter(({ body }) =>
                body.document?.url === `${origin}/shopping/${kind}`);
            if ( observations.length !== 1 || observations[0].body.decision.shopping_signals !== expected ||
                Object.hasOwn(observations[0].body.decision, 'referral_signals') ||
                observations[0].body.decision.verdict !== 'candidate' ) {
                throw new Error(`Shopping contribution boundary failed for ${kind}`);
            }
        }
        const cleanup = await readInspectionState(endpoint, session, extensionURL, []);
        if ( cleanup.inspectionTabs !== 0 || cleanup.owned !== 0 ) {
            throw new Error(`Shopping inspection cleanup failed: ${JSON.stringify(cleanup)}`);
        }
        console.log(JSON.stringify({ passed: true, shopping: {
            trackingEnabled, checked, unchecked, bothOff, cached, visits: Object.fromEntries(shoppingVisits), cleanup,
        } }));
    } else if ( historyNavigationOnly ) {
        navigationVisits.clear();
        const reloadURL = `${origin}/search-history-navigation?reload=1`;
        await navigate(endpoint, session, reloadURL);
        await waitForValue(endpoint, session, `
            return {
                status: document.querySelector('#queree-results-control span')?.textContent || '',
                problems: [...document.querySelectorAll('.queree-unresolved')].map(node => ({
                    reason: node.dataset.reason, detail: node.title,
                })),
            };
        `, value => /^[1-8] of 9 results inspected/.test(value.status), 120000);
        await navigate(endpoint, session, reloadURL);
        const reloaded = await waitForResults(endpoint, session, 60000);
        if ( reloaded.unresolved !== 0 || navigationVisits.size !== 9 ||
            Array.from(navigationVisits.values()).some(count => count !== 1) ) {
            throw new Error(`Reload repeated or lost inspections: ${JSON.stringify({
                reloaded, visits: Object.fromEntries(navigationVisits),
            })}`);
        }
        const reloadCleanup = await readInspectionState(endpoint, session, extensionURL, []);
        if ( reloadCleanup.inspectionTabs !== 0 || reloadCleanup.owned !== 0 ) {
            throw new Error(`Reload cleanup failed: ${JSON.stringify(reloadCleanup)}`);
        }
        console.log(JSON.stringify({ passed: true, reload: reloaded,
            visits: Object.fromEntries(navigationVisits), cleanup: reloadCleanup }));
        await clearDecisionCacheAside(endpoint, session, extensionURL);
        for ( const timeout of [ false, true ] ) {
        navigationVisits.clear();
        await navigate(endpoint, session, `${origin}/search-history-navigation${timeout ? '?timeout=1' : ''}`);
        const before = await waitForValue(endpoint, session, `
            return document.querySelector('#queree-results-control span')?.textContent || '';
        `, value => /^[1-8] of 9 results inspected/.test(value), 45000);
        await execute(endpoint, session, `document.querySelector('#leave-search').click()`);
        await waitForValue(endpoint, session, 'return location.pathname', value => value === '/clean');
        await sleep(timeout ? 35000 : 1000);
        const whileAway = timeout
            ? await readInspectionState(endpoint, session, extensionURL, [])
            : undefined;
        if ( timeout && (whileAway.inspectionTabs !== 0 || whileAway.owned !== 0) ) {
            throw new Error(`Timeout did not clean up while away: ${JSON.stringify(whileAway)}`);
        }
        await webdriverRequest(endpoint, `/session/${session}/back`, {});
        const restored = await execute(endpoint, session, 'return window.restoreEvents');
        if ( restored?.includes(true) !== true ) {
            throw new Error(`Search page was not restored from history cache: ${JSON.stringify(restored)}`);
        }
        const after = await waitForResults(endpoint, session, 60000);
        const expectedUnresolved = timeout ? 8 : 0;
        if ( after.unresolved !== expectedUnresolved || after.status !== `0 excluded, ${expectedUnresolved} unresolved` ) {
            throw new Error(`Back navigation lost inspections: ${JSON.stringify(after)}`);
        }
        if ( Array.from(navigationVisits.values()).some(count => count !== 1) ) {
            throw new Error('Back navigation repeated an inspection or restarted a timeout');
        }
        const cleanup = await readInspectionState(endpoint, session, extensionURL, []);
        if ( cleanup.inspectionTabs !== 0 || cleanup.owned !== 0 ) {
            throw new Error(`Inspection cleanup failed: ${JSON.stringify(cleanup)}`);
        }
        console.log(JSON.stringify({ passed: true, timeout, before, restored, after, whileAway, cleanup, visits: Object.fromEntries(navigationVisits) }));
        }
    } else if ( nonHtmlOnly ) {
    await configureAside(endpoint, session, extensionURL, {
        requireSingleDomain: true, settings: { quereePersonalCategories: [] },
    });
    await navigate(endpoint, session, `${origin}/search-non-html`);
    const finished = await waitForResults(endpoint, session, inspectionTimeout + inspectionCleanupAllowance);
    const rows = await execute(endpoint, session, `return ${JSON.stringify(nonHtmlKinds)}.map(kind => {
        const node = document.getElementById('file-' + kind.replace('.', '-'));
        const label = node.querySelector('.queree-unresolved, .queree-characteristic');
        return { kind, hidden: getComputedStyle(node).display === 'none',
            label: label?.textContent || '', reason: label?.dataset.reason };
    });`);
    if ( finished.unresolved !== 1 || rows.some(row => row.kind !== 'error' && (row.hidden || row.label)) ||
        rows.find(row => row.kind === 'error')?.reason !== 'http_error' ) {
        throw new Error(`Non-HTML result display failed: ${JSON.stringify({ finished, rows })}`);
    }
    for ( let attempt = 0; contributionRequests.length < 2 && attempt < 100; attempt++ ) { await sleep(100); }
    await sleep(1500);
    const documents = contributionRequests.map(({ body }) => body.document?.url).sort();
    const expected = [ `${origin}/non-html/html.pdf`, `${origin}/non-html/xhtml` ].sort();
    if ( JSON.stringify(documents) !== JSON.stringify(expected) || exclusionRequests.length !== 0 ) {
        throw new Error(`Non-HTML contribution boundary failed: ${JSON.stringify({ contributionRequests, exclusionRequests })}`);
    }
    await navigate(endpoint, session, `${extensionURL}/queree.html`);
    const downloads = await execute(endpoint, session, 'return browser.downloads.search({});');
    if ( downloads.length !== 0 ) { throw new Error(`Unexpected downloads: ${JSON.stringify(downloads)}`); }
    console.log(JSON.stringify({ passed: true, nonHtml: { finished, rows, documents, downloads } }));
    } else if ( singleDomainOnly ) {
    const defaultRequirement = await execute(endpoint, session, `
        const checkbox = document.querySelector('[data-setting-name="quereeRequireSingleDomain"]');
        return checkbox !== null && checkbox.disabled === false && checkbox.checked === false;
    `);
    if ( defaultRequirement !== true ) {
        throw new Error('Single-domain checkbox missing, disabled or not off by default');
    }
    await configureAside(endpoint, session, extensionURL, {
        requireSingleDomain: true,
        settings: { quereePersonalCategories: [] },
    });
    const reportsBefore = exclusionRequests.length;
    const contributionsBefore = contributionRequests.length;
    const singleDomainOrigin = origin;
    await navigate(endpoint, session, `${origin}/search-single-domain`);
    const stateScript = `
        return {
            status: document.querySelector('#queree-results-control span')?.textContent || '',
            results: ['own', 'linked', 'external', 'unknown'].map(kind => {
                const node = document.querySelector('#single-' + kind);
                const label = node?.querySelector('.queree-characteristic, .queree-unresolved');
                return {
                    kind,
                    hidden: node !== null && getComputedStyle(node).display === 'none',
                    label: label?.textContent || '',
                    reason: label?.dataset.reason,
                };
            }),
        };
    `;
    const pending = await waitForValue(endpoint, session, stateScript, state =>
        state.status.includes('of 4 results inspected') &&
        state.results.every(result => result.hidden && result.label === 'Single-domain unconfirmed')
    );
    if ( singleDomainResources.size !== 3 ) {
        // Wait for all three real resource requests, without releasing any early.
        for ( let attempt = 0; singleDomainResources.size !== 3 && attempt < 100; attempt++ ) {
            await sleep(100);
        }
    }
    const port = server.address().port;
    const expectedVisits = {
        [`localhost:${port}/single-domain/own`]: 1,
        [`localhost:${port}/single-domain/linked`]: 1,
        [`localhost:${port}/single-domain/external`]: 1,
        [`localhost:${port}/single-domain/unknown`]: 1,
        [`localhost:${port}/single-domain/resource.js?own`]: 1,
        [`localhost:${port}/single-domain/resource.js?linked`]: 1,
        [`127.0.0.1:${port}/single-domain/resource.js?external`]: 1,
    };
    const visitsMatch = () => singleDomainVisits.size === Object.keys(expectedVisits).length &&
        Object.entries(expectedVisits).every(([url, count]) => singleDomainVisits.get(url) === count);
    if ( singleDomainResources.size !== 3 || visitsMatch() === false ) {
        throw new Error(`Single-domain resource requests missing or link followed: ${JSON.stringify(Object.fromEntries(singleDomainVisits))}`);
    }
    for ( const response of singleDomainResources ) { response.end('window.fixtureResourceLoaded = true;'); }
    await waitForResults(endpoint, session, inspectionTimeout + inspectionCleanupAllowance);
    const completed = await waitForValue(endpoint, session, stateScript, state =>
        state.status === '2 excluded, 1 unresolved' &&
        state.results.every(result => result.hidden === ['external', 'unknown'].includes(result.kind)) &&
        state.results[2].label === 'Not single-domain' &&
        state.results[3].label === 'Single-domain unconfirmed' &&
        state.results[3].reason === 'challenge_page'
    );
    for ( let attempt = 0; contributionRequests.length < contributionsBefore + 3 && attempt < 100; attempt++ ) {
        await sleep(100);
    }
    const contributions = contributionRequests.slice(contributionsBefore);
    if ( contributions.length !== 3 || ['own', 'linked', 'external'].some(kind => {
        const matches = contributions.filter(({body}) => body.document?.url === `${singleDomainOrigin}/single-domain/${kind}`);
        const body = matches[0]?.body;
        return matches.length !== 1 || body.schema !== 2 ||
            body.decision?.verdict !== 'candidate' ||
            body.decision.single_domain !== (kind !== 'external') ||
            typeof body.document.body !== 'string' || body.document.body === '' ||
            Object.hasOwn(body.document, 'single_domain') ||
            JSON.stringify(body).includes('require_single_domain') ||
            JSON.stringify(body).includes('requireSingleDomain');
    }) || exclusionRequests.length !== reportsBefore ) {
        throw new Error(`Single-domain contribution boundary failed: ${JSON.stringify({ contributions, exclusionRequests })}`);
    }
    await clickElement(endpoint, session, '#queree-results-control button');
    const shown = await waitForValue(endpoint, session, stateScript, state =>
        state.results.every(result => result.hidden === false) &&
        state.results[2].label === 'Not single-domain' &&
        state.results[3].label === 'Single-domain unconfirmed'
    );
    await clickElement(endpoint, session, '#queree-results-control button');
    await waitForValue(endpoint, session, stateScript, state =>
        state.results[2].hidden && state.results[3].hidden
    );
    await configureAside(endpoint, session, extensionURL, { requireSingleDomain: false });
    const disabled = await waitForValue(endpoint, session, stateScript, state =>
        state.status === '0 excluded, 1 unresolved' &&
        state.results.every(result => result.hidden === false) &&
        state.results[2].label === ''
    );
    await configureAside(endpoint, session, extensionURL, { requireSingleDomain: true });
    const enabledAgain = await waitForValue(endpoint, session, stateScript, state =>
        state.status === completed.status &&
        JSON.stringify(state.results) === JSON.stringify(completed.results)
    );
    await sleep(1000);
    if ( visitsMatch() === false || contributionRequests.length !== contributionsBefore + 3 ||
        exclusionRequests.length !== reportsBefore ) {
        throw new Error(`Single-domain toggles revisited or shared an exclusion: ${JSON.stringify(Object.fromEntries(singleDomainVisits))}`);
    }
    console.log(JSON.stringify({ passed: true, singleDomain: {
        pending, completed, shown, disabled, enabledAgain,
        visits: Object.fromEntries(singleDomainVisits),
        decisions: contributions.map(({body}) => body.decision),
    } }, null, 2));
    } else {
    scriptletStates.length = 0;
    await navigate(endpoint, session, `${origin}/search`);
    const result = await waitForResults(endpoint, session);
    const cosmetic = await execute(endpoint, session, `
        const display = selector =>
            getComputedStyle(document.querySelector(selector)).display;
        const original = document.querySelector('#ad-result');
        const replacement = original.cloneNode(true);
        original.replaceWith(replacement);
        const replaced = display('#ad-result');
        const moved = document.createElement('div');
        moved.id = 'ad-result';
        moved.className = 'MjjYud';
        moved.append(replacement.querySelector('a'));
        replacement.replaceWith(moved);
        const movedDisplay = display('#ad-result');
        const group = display('#ad-group');
        const neighbor = display('#clean-result');
        const reported = Number.parseInt(
            document.querySelector('#queree-results-control span').textContent,
            10
        );
        const hidden = Array.from(
            document.querySelectorAll('.MjjYud')
        ).filter(node => getComputedStyle(node).display === 'none').length;
        return { replaced, movedDisplay, group, neighbor, reported, hidden };
    `);
    if (
        cosmetic.replaced !== 'none' || cosmetic.movedDisplay !== 'none' ||
        cosmetic.group === 'none' || cosmetic.neighbor === 'none' ||
        cosmetic.reported !== cosmetic.hidden
    ) {
        throw new Error(`Cosmetic result hiding failed: ${JSON.stringify(cosmetic)}`);
    }
    await sleep(7500);
    if ( adVisits !== 1 ) {
        throw new Error(`DOM replacement repeated inspection ${adVisits} times`);
    }
    await execute(endpoint, session, `
        const extra = document.createElement('div');
        extra.id = 'extra-ad-result';
        extra.className = 'MjjYud';
        extra.innerHTML = '<a href="${origin}/ad"><h3>Repeated ad result</h3></a>';
        document.querySelector('#search').append(extra);
    `);
    cosmetic.insertedCount = await waitForDuplicateCount(
        endpoint,
        session,
        'after duplicate insertion',
        `return document.querySelector('#queree-results-control span').textContent;`,
        value => value.startsWith('4 excluded')
    );
    await execute(endpoint, session,
        `document.querySelector('#extra-ad-result').remove();`
    );
    cosmetic.removedCount = await waitForDuplicateCount(
        endpoint,
        session,
        'after duplicate removal',
        `return document.querySelector('#queree-results-control span').textContent;`,
        value => value.startsWith('3 excluded')
    );
    if ( adVisits !== 1 ) {
        throw new Error(`Repeated URL was inspected ${adVisits} times`);
    }
    await clickElement(endpoint, session, '#queree-results-control button');
    cosmetic.shown = await waitForValue(
        endpoint,
        session,
        `return getComputedStyle(document.querySelector('#ad-result')).display;`,
        value => value !== 'none'
    );
    cosmetic.marker = await waitForValue(
        endpoint,
        session,
        `return getComputedStyle(document.querySelector('#ad-result'), '::before').content;`,
        value => value.includes('Advertising')
    );
    cosmetic.cleanMarker = await execute(
        endpoint,
        session,
        `return getComputedStyle(document.querySelector('#clean-result'), '::before').content;`
    );
    await clickElement(endpoint, session, '#queree-results-control button');
    await execute(endpoint, session, `
        document.querySelector('#search').append(document.createElement('i'));
    `);
    cosmetic.hiddenAgain = await waitForValue(
        endpoint,
        session,
        `return getComputedStyle(document.querySelector('#ad-result')).display;`,
        value => value === 'none'
    );
    cosmetic.statusAfterToggle = await waitForValue(
        endpoint,
        session,
        `return document.querySelector('#queree-results-control span').textContent;`,
        value => value.includes('results inspected') === false
    );
    if (
        cosmetic.shown === 'none' || cosmetic.hiddenAgain !== 'none' ||
        cosmetic.cleanMarker.includes('Advertising') ||
        cosmetic.statusAfterToggle.includes('unavailable')
    ) {
        throw new Error(`Cosmetic toggle failed: ${JSON.stringify(cosmetic)}`);
    }
    const unresolvedPlacement = await execute(endpoint, session, `
        const label = document.querySelector('#challenge-result .queree-unresolved');
        return label === null ? null : {
            belowTitle: label.parentElement === document.querySelector('#challenge-result h3'),
            display: getComputedStyle(label).display,
        };
    `);
    if ( unresolvedPlacement?.belowTitle !== true || unresolvedPlacement.display !== 'block' ) {
        throw new Error(`Unresolved label is not below title: ${JSON.stringify(unresolvedPlacement)}`);
    }
    if ( explanationsOnly ) {
        await navigate(endpoint, session, `${origin}/search?cached=1`);
        await waitForResults(endpoint, session);
        if ( adVisits !== 1 ) { throw new Error(`Cached ad was revisited ${adVisits} times`); }
        await clickElement(endpoint, session, '#queree-results-control button');
        const cachedMarker = await waitForValue(endpoint, session,
            `return getComputedStyle(document.querySelector('#ad-result'), '::before').content;`,
            value => value.includes('Advertising'));
        await navigate(endpoint, session, `${origin}/search-bing?engine=bing`);
        const bing = await waitForResults(endpoint, session);
        if ( bing.bingHidden !== true || bing.bingPrefixHidden !== false || bing.bingDirectHidden !== true ) {
            throw new Error(`Bing result hiding failed: ${JSON.stringify(bing)}`);
        }
        await clickElement(endpoint, session, '#queree-results-control button');
        const bingMarker = await waitForValue(endpoint, session,
            `return getComputedStyle(document.querySelector('#bing-result'), '::before').content;`,
            value => value.includes('Advertising'));
        console.log(JSON.stringify({ passed: true, cosmetic, cachedMarker, bingMarker, adVisits }, null, 2));
    } else {
    await execute(endpoint, session, `
        const original = document.querySelector('#challenge-result');
        original.replaceWith(original.cloneNode(true));
    `);
    await sleep(500);
    const unresolvedLabels = await execute(
        endpoint, session,
        `return document.querySelectorAll('#challenge-result .queree-unresolved').length;`
    );
    if ( unresolvedLabels !== 1 ) {
        throw new Error(`Unresolved label duplicated ${unresolvedLabels} times`);
    }

    const expected = {
        adHidden: true,
        cleanHidden: false,
        challengeHidden: false,
        methodHidden: true,
        storeHidden: true,
        unresolved: 1,
    };
    const failures = Object.entries(expected).filter(
        ([ key, value ]) => result[key] !== value
    );
    if ( failures.length !== 0 ) {
        throw new Error(`Unexpected result: ${JSON.stringify(result)}`);
    }
    if (
        scriptletStates.some(state =>
            state.frame === '1' &&
            state.value === '0' &&
            state.windowName === ''
        ) === false
    ) {
        throw new Error(`Inspection marker/scriptlet isolation failed: ${JSON.stringify(scriptletStates)}`);
    }
    if (
        scriptletStates.some(state =>
            state.frame === 'source' && state.value === '1'
        ) === false ||
        scriptletStates.some(state =>
            state.frame === 'source-iframe' && state.value === '1'
        ) === false ||
        cleanCookieHeader.includes('queree_personal=')
    ) {
        throw new Error(`Container isolation failed: ${JSON.stringify({
            scriptletStates, cleanCookieHeader,
        })}`);
    }
    for ( let attempt = 0; contributionRequests.length === 0 && attempt < 100; attempt++ ) {
        await sleep(100);
    }
    const contribution = contributionRequests[0];
    if (
        contributionRequests.length !== 1 ||
        contribution.authorization !== `Bearer qk_${'x'.repeat(43)}` ||
        contribution.body.schema !== 2 ||
        contribution.body.document?.url !== `${origin}/clean` ||
        typeof contribution.body.document?.body !== 'string' ||
        contribution.body.document.body === '' ||
        contribution.body.result?.description !== 'Clean page description' ||
        typeof contribution.body.submission_id !== 'string' || contribution.body.submission_id === '' ||
        Object.keys(contribution.body).sort().join(',') !== 'decision,document,producer,result,schema,submission_id'
    ) {
        throw new Error(`Contribution boundary failed: ${JSON.stringify(contributionRequests)}`);
    }

    await navigate(endpoint, session, `${origin}/search-cache`);
    const cacheFirst = await waitForResults(endpoint, session);
    for ( let attempt = 0; contributionRequests.length < 2 && attempt < 100; attempt++ ) {
        await sleep(100);
    }
    if (
        cacheFirst.status !== '0 excluded, 0 unresolved' ||
        cachePageVisits !== 1 || contributionRequests.length !== 2
    ) {
        throw new Error(`Decision-cache first pass failed: ${JSON.stringify({
            cacheFirst, cachePageVisits, contributions: contributionRequests.length,
        })}`);
    }
    await navigate(endpoint, session, `${origin}/search-cache?repeat=1`);
    const cacheHit = await waitForResults(endpoint, session);
    await sleep(500);
    if (
        cacheHit.status !== '0 excluded, 0 unresolved' ||
        cachePageVisits !== 1 || contributionRequests.length !== 2
    ) {
        throw new Error(`Decision-cache hit failed: ${JSON.stringify({
            cacheHit, cachePageVisits, contributions: contributionRequests.length,
        })}`);
    }
            const sharedExclusions = await checkSharedExclusions(endpoint, session, extensionURL, origin);
    await configureAside(endpoint, session, extensionURL, {
        contributionConsent: false,
        settings: { quereeSimultaneousInspections: 6 },
    });
    await clearDecisionCacheAside(endpoint, session, extensionURL);
    await navigate(endpoint, session, `${origin}/search-cache?cleared=1`);
    const cacheCleared = await waitForResults(endpoint, session);
    if (
        cacheCleared.status !== '0 excluded, 0 unresolved' ||
        cachePageVisits !== 2
    ) {
        throw new Error(`Decision-cache clear failed: ${JSON.stringify({
            cacheCleared, cachePageVisits,
        })}`);
    }

    const historyURLs = [
        `${origin}/history-delete`,
        `${origin}/history-prior`,
        `${origin}/history-concurrent`,
    ];
    await navigate(endpoint, session, historyURLs[1]);
    await navigate(endpoint, session, `${origin}/search-history`);
    for ( let attempt = 0; historyConcurrentVisits === 0 && attempt < 100; attempt++ ) {
        await sleep(100);
    }
    if ( historyConcurrentVisits === 0 ) {
        throw new Error('Concurrent inspection did not start');
    }
    const historySearchWindow = await webdriverRequest(
        endpoint,
        `/session/${session}/window`
    );
    const ordinaryVisit = await webdriverRequest(
        endpoint,
        `/session/${session}/window/new`,
        { type: 'tab' }
    );
    await webdriverRequest(endpoint, `/session/${session}/window`, {
        handle: ordinaryVisit.handle,
    });
    await navigate(endpoint, session, historyURLs[2]);
    await webdriverRequest(endpoint, `/session/${session}/window`, {
        handle: historySearchWindow,
    });
    const historyResult = await waitForResults(endpoint, session);
    if (
        historyResult.status !== '0 excluded, 0 unresolved' ||
        historyResult.unresolved !== 0
    ) {
        throw new Error(`History fixture filtering changed: ${JSON.stringify(historyResult)}`);
    }
    const inspectionState = await readInspectionState(
        endpoint,
        session,
        extensionURL,
        historyURLs
    );
    if (
        inspectionState.visits[0] !== 0 ||
        inspectionState.visits[1] < 1 ||
        inspectionState.visits[2] < 1 ||
        inspectionState.containers !== 0 ||
        inspectionState.checkedContainers < 2 ||
        inspectionState.owned !== 0 ||
        inspectionState.scriptletRegistrations < 1 ||
        inspectionState.scriptletRegistrations > 20 ||
        inspectionState.cookies !== 0
    ) {
        throw new Error(`Inspection cleanup failed: ${JSON.stringify(inspectionState)}`);
    }
    await webdriverRequest(endpoint, `/session/${session}/window`, {
        handle: ordinaryVisit.handle,
    });
    await fetch(`${endpoint}/session/${session}/window`, { method: 'DELETE' });
    await webdriverRequest(endpoint, `/session/${session}/window`, {
        handle: historySearchWindow,
    });

    const disabledHistoryURL = `${origin}/history-disabled`;
    await navigate(endpoint, session, `${origin}/search-history-disable`);
    await disableHistoryCleanupAside(endpoint, session, extensionURL);
    const disabledHistoryResult = await waitForResults(endpoint, session);
    if ( disabledHistoryResult.status !== '0 excluded, 0 unresolved' ) {
        throw new Error(
            `History-disable filtering changed: ${JSON.stringify(disabledHistoryResult)}`
        );
    }
    await enableHistoryCleanup(endpoint, session, extensionURL);
    const disabledHistoryState = await readInspectionState(
        endpoint,
        session,
        extensionURL,
        [ disabledHistoryURL ]
    );
    if (
        disabledHistoryState.visits[0] < 1 ||
        disabledHistoryState.containers !== 0
    ) {
        throw new Error(
            `Disabled history cleanup was not preserved: ${JSON.stringify(disabledHistoryState)}`
        );
    }

    await clearDecisionCacheAside(endpoint, session, extensionURL);
    await configure(endpoint, session, extensionURL, {
        whitelist: 'localhost',
    });
    await navigate(endpoint, session, `${origin}/search?trusted=1`);
    let trusted = await waitForResults(endpoint, session);
    if ( trusted.reasons.some(reason => reason.reason === 'profile_updated') ) {
        await sleep(500);
        await navigate(endpoint, session, `${origin}/search?trusted=2`);
        trusted = await waitForResults(endpoint, session);
    }
    if ( trusted.adHidden !== true || trusted.methodHidden !== true ) {
        throw new Error(`Trusted-site isolation failed: ${JSON.stringify(trusted)}`);
    }

    await navigate(endpoint, session, `${origin}/search-bing?engine=bing`);
    const bing = await waitForResults(endpoint, session);
    if (
        bing.bingHidden !== true || bing.bingPrefixHidden !== false ||
        bing.bingDirectHidden !== true
    ) {
        throw new Error(`Bing selector isolation failed: ${JSON.stringify(bing)}`);
    }
    const bingRerendered = await execute(endpoint, session, `
        const original = document.querySelector('#bing-result');
        const replacement = original.cloneNode(true);
        replacement.querySelector('a').href =
            replacement.querySelector('a').href.replace('p=old', 'p=new');
        original.replaceWith(replacement);
        return getComputedStyle(replacement).display === 'none';
    `);
    if ( bingRerendered === false ) {
        throw new Error('Bing click-token change revealed an excluded result');
    }

    await configure(endpoint, session, extensionURL, {
        settings: { quereeSimultaneousInspections: 2 },
    });
    await navigate(endpoint, session, `${origin}/search-affiliate`);
    const affiliate = await waitForResults(endpoint, session);
    if (
        affiliate.affiliateSpotifyHidden !== false ||
        affiliate.affiliateSponsoredHidden !== true ||
        affiliate.affiliateNewsletterHidden !== false ||
        affiliate.affiliateProseHidden !== false ||
        affiliate.unresolved !== 0
    ) {
        throw new Error(`Affiliate evidence failed: ${JSON.stringify(affiliate)}`);
    }
    maxSlowActive = 0;
    await navigate(endpoint, session, `${origin}/search-concurrency`);
    const streaming = await waitForValue(
        endpoint,
        session,
        `
            const status = document.querySelector(
                '#queree-results-control span'
            )?.textContent || '';
            return {
                status,
                hidden: getComputedStyle(
                    document.querySelector('#search .MjjYud')
                ).display === 'none',
            };
        `,
        value => value.status.startsWith('1 of 2 results inspected') && value.hidden,
        30000
    );
    const concurrency = await waitForResults(endpoint, session);
    if ( maxSlowActive !== 2 ) {
        throw new Error(`Expected two simultaneous inspections, saw ${maxSlowActive}`);
    }
    if ( concurrency.status.startsWith('1 excluded') === false ) {
        throw new Error(`Streamed exclusion was lost: ${JSON.stringify(concurrency)}`);
    }

    await configureAside(endpoint, session, extensionURL, {
        settings: { quereePersonalCategories: socialFixtureCategories },
    });
    await navigate(endpoint, session, `${origin}/search-errors`);
    const errors = await waitForResults(endpoint, session);
    const errorReasons = new Set(errors.reasons.map(reason => reason.reason));
    if (
        errors.missingHidden !== false ||
        errors.downloadHidden !== false ||
        errors.redirectCommunityHidden !== false ||
        errors.unresolved !== 1 ||
        errorReasons.has('http_error') === false
    ) {
        throw new Error(`Error/redirect policy failed: ${JSON.stringify(errors)}`);
    }

    await navigate(endpoint, session, `${origin}/search-navigation`);
    const navigation = await waitForResults(endpoint, session);
    if ( navigation.navigationHidden !== false || navigation.unresolved !== 0 ) {
        throw new Error(`Navigation settling failed: ${JSON.stringify(navigation)}`);
    }

    await navigate(endpoint, session, `${origin}/search-waf`);
    const waf = await waitForResults(endpoint, session);
    if (
        waf.wafDelayedHidden !== true || waf.wafCleanHidden !== false || waf.wafStuckHidden !== false ||
        waf.acceptedHidden !== false || waf.unresolved !== 1 ||
        waf.reasons[0]?.reason !== 'http_error' ||
        cleanChallengeVisits !== 2 || /queree_check=passed/.test(challengeCookieHeader) === false
    ) {
        throw new Error(`Generic recovery failed: ${JSON.stringify({ waf, cleanChallengeVisits, challengeCookieHeader })}`);
    }

    await configure(endpoint, session, extensionURL, {
        settings: { quereeSimultaneousInspections: readinessConcurrency },
    });
    await navigate(endpoint, session, `${origin}/search-readiness`);
    const readinessTimeout =
        Math.ceil(Object.keys(readinessExpected).length / readinessConcurrency) *
        (inspectionTimeout + inspectionCleanupAllowance) + 10000;
    await waitForResults(endpoint, session, readinessTimeout);
    const readiness = await execute(endpoint, session, `
        return Object.fromEntries(Array.from(document.querySelectorAll('[id^="ready-"]'), node => [
            node.id.slice(6), getComputedStyle(node).display === 'none' ? 'exclude' :
                node.querySelector('.queree-unresolved') ? 'unresolved' : 'candidate'
        ]));
    `);
    if ( Object.entries(readinessExpected).some(([ key, value ]) =>
        Array.isArray(value) ? value.includes(readiness[key]) === false : readiness[key] !== value
    ) ) {
        const reasons = await execute(endpoint, session, `
            return Array.from(document.querySelectorAll('[id^="ready-"]'), node => ({
                id: node.id,
                reason: node.querySelector('.queree-unresolved')?.dataset.reason,
            }));
        `);
        throw new Error(`Readiness checks failed: ${JSON.stringify({ readiness, reasons })}`);
    }

    await clearDecisionCacheAside(endpoint, session, extensionURL);
    await configureAside(endpoint, session, extensionURL, {
        settings: { quereePersonalCategories: socialFixtureCategories },
    });
    await navigate(endpoint, session, `${origin}/search-community`);
    const communityDefault = await waitForResults(endpoint, session);
    if (
        communityDefault.communityPlainHidden !== false ||
        communityDefault.communityAdHidden !== false ||
        communityDefault.status !== '0 excluded, 0 unresolved' ||
        communityDefault.unresolved !== 0
    ) {
        throw new Error(`Social starter visibility failed: ${JSON.stringify(communityDefault)}`);
    }
    await configureAside(endpoint, session, extensionURL, {
        settings: { quereePersonalCategories: socialFixtureCategories.map(category => ({ ...category, enabled: false })) },
    });
    await navigate(endpoint, session, `${origin}/search-community?community=off`);
    const communityDisabled = await waitForResults(endpoint, session);
    if ( communityDisabled.communityPlainHidden !== true || communityDisabled.communityAdHidden !== true ||
        communityDisabled.status !== '2 excluded, 0 unresolved' || communityDisabled.unresolved !== 0 ) {
        throw new Error(`Community control did not hide both results: ${JSON.stringify(communityDisabled)}`);
    }
    await clickElement(endpoint, session, '#queree-results-control button');
    communityDisabled.markers = await waitForValue(endpoint, session, `
        return ['plain', 'ad'].map(kind =>
            getComputedStyle(document.querySelector('#community-' + kind), '::before').content
        );
    `, markers => markers.every(marker => marker.includes('Hidden by setting: Social platforms')));
    await configureAside(endpoint, session, extensionURL, {
        settings: { quereePersonalCategories: [] },
    });
    await navigate(endpoint, session, `${origin}/search-community?category=removed`);
    const communityRemoved = await waitForResults(endpoint, session);
    if ( communityRemoved.communityPlainHidden !== false || communityRemoved.communityAdHidden !== false ||
        communityRemoved.status !== '0 excluded, 0 unresolved' || communityVisits !== 0 ) {
        throw new Error(`Editing the Social starter changed the internal no-inspection rule: ${JSON.stringify({ communityRemoved, communityVisits })}`);
    }
    await configureAside(endpoint, session, extensionURL, {
        settings: { quereePersonalCategories: socialFixtureCategories },
    });

    await clearDecisionCacheAside(endpoint, session, extensionURL);
    await navigate(endpoint, session, `${origin}/search?before-disable=1`);
    const beforeDisable = await waitForResults(endpoint, session);
    if ( beforeDisable.adHidden !== true ) {
        throw new Error('Disable fixture did not begin with a hidden result');
    }
    await configureAside(endpoint, session, extensionURL, {
        settings: { quereeEnabled: false },
    });
    const disabledPanel = await waitForValue(
        endpoint, session,
        `return document.querySelector('#queree-results-control') !== null;`,
        value => value === false
    );
    if ( disabledPanel ) { throw new Error('Quer.ee ran while disabled'); }
    const restoredResult = await execute(
        endpoint,
        session,
        `return getComputedStyle(document.querySelector('#ad-result')).display === 'none';`
    );
    if ( restoredResult === true ) {
        throw new Error('Disabling Quer.ee left a result hidden');
    }

    console.log(JSON.stringify({
        passed: true,
        cosmetic,
        scriptletIsolation: result,
        trustedIsolation: trusted,
        bing,
        affiliate,
        sharedExclusions,
        concurrency: { maxActive: maxSlowActive, result: concurrency },
        streaming,
        errors,
        navigation,
        waf,
        readiness,
        communityDefault,
        communityDisabled,
        communityRemoved,
        inspectionCleanup: inspectionState,
        disabledHistoryCleanup: disabledHistoryState,
        disabled: true,
    }, null, 2));
    }
    }
    }
} finally {
    if ( session !== undefined ) {
        await fetch(`http://127.0.0.1:4461/session/${session}`, {
            method: 'DELETE',
        }).catch(( ) => { });
    }
    driver?.kill('SIGTERM');
    for ( const socket of upgradedSockets ) { socket.destroy(); }
    server.close();
    await rm(work, { recursive: true, force: true });
}
