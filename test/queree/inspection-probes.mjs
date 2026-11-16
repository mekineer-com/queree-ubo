import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = name => readFileSync(new URL(
    `../../src/js/queree/${name}.js`, import.meta.url
), 'utf8');

const scrollSource = source('scroll');
const scroll = { scrollTop: 0, scrollHeight: 1000 };
let allowScroll = true;
const scrollContext = vm.createContext({
    document: { scrollingElement: scroll },
    window: {
        innerHeight: 100,
        scrollY: 0,
        scrollTo({ top, behavior }) {
            assert.equal(behavior, 'instant', 'Do not inherit CSS smooth scrolling');
            if ( allowScroll ) { scroll.scrollTop = top; }
        },
    },
});
let result = vm.runInContext(scrollSource, scrollContext);
assert.equal(result.moved, true);
assert.equal(scroll.scrollTop, 90);
allowScroll = false;
result = vm.runInContext(scrollSource, scrollContext);
assert.equal(result.moved, false, 'A canceled scroll is not reported as progress');
allowScroll = true;
scroll.scrollTop = 880;
result = vm.runInContext(scrollSource, scrollContext);
assert.equal(result.moved, true);
result = vm.runInContext(scrollSource, scrollContext);
assert.equal(result.moved, false);

console.log('Passed: inspection scrolling measures actual movement');

const rootsSource = source('inspection-dom');
const readinessSource = source('readiness');
const makeElement = (doc, localName = 'div') => ({
    ownerDocument: doc,
    localName,
    shown: true,
    busy: false,
    checkVisibility: function() { return this.shown; },
    closest: () => null,
    matches: function() { return this.busy; },
    querySelectorAll: () => [],
});
const makeScope = (doc, host) => {
    const scope = {
        ownerDocument: doc,
        host,
        elements: [],
        text: [],
        media: [],
        busy: false,
        visits: 0,
        querySelector: function() { return this.busy ? {} : null; },
        querySelectorAll(selector) {
            if ( selector === '*' ) { this.visits += 1; return this.elements; }
            if ( selector === 'img, svg, video' ) { return this.media; }
            return [];
        },
    };
    if ( doc === undefined ) {
        scope.readyState = 'complete';
        scope.defaultView = { frameElement: null };
        scope.body = makeElement(scope, 'body');
        scope.body.querySelectorAll = selector => scope.querySelectorAll(selector);
        scope.createTreeWalker = container => {
            const nodes = (container === scope.body ? scope : container).text;
            let index = 0;
            return {
                nextNode() {
                    if ( index === nodes.length ) { return false; }
                    this.currentNode = nodes[index++];
                    return true;
                },
            };
        };
    }
    return scope;
};
const top = makeScope();
const closedHost = makeElement(top);
const closed = makeScope(top, closedHost);
closedHost.shadowRoot = null;
closedHost.openOrClosedShadowRoot = closed;
const frameElement = makeElement(top, 'iframe');
const frame = makeScope();
frame.defaultView.frameElement = frameElement;
frameElement.contentDocument = frame;
const nestedHost = makeElement(frame);
const nested = makeScope(frame, nestedHost);
nestedHost.openOrClosedShadowRoot = nested;
const nestedFrameElement = makeElement(frame, 'frame');
const nestedFrame = makeScope();
nestedFrame.defaultView.frameElement = nestedFrameElement;
nestedFrameElement.contentDocument = nestedFrame;
const inaccessibleFrame = makeElement(top, 'iframe');
Object.defineProperty(inaccessibleFrame, 'contentDocument', {
    get() { throw new Error('Cross-origin access denied'); },
});
const opaqueFrame = { ...makeElement(top, 'iframe'), contentDocument: null };
top.elements = [ closedHost, inaccessibleFrame, opaqueFrame ];
closed.elements = [ frameElement ];
frame.elements = [ nestedHost ];
nested.elements = [ nestedFrameElement ];
// Repeated exposure must not duplicate a scope or recurse forever.
nestedFrame.elements = [ { localName: 'frame', contentDocument: top } ];
const context = vm.createContext({
    document: top,
    location: { href: 'https://personal.example/top' },
    NodeFilter: { SHOW_TEXT: 4 },
});
assert.throws(() => vm.runInContext(readinessSource, context), /__quereeInspectionRoots/,
    'Readiness also requires the shared helper');
assert.equal(vm.runInContext(rootsSource, context), undefined,
    'Initializer must not return a function or DOM object through Firefox executeScript');
const scopes = Array.from(context.__quereeInspectionRoots());
assert.deepEqual(scopes, [ top, closed, frame, nested, nestedFrame ]);
assert.equal(scopes.every(root => root.visits === 1), true, 'Visit each reachable scope once');
result = vm.runInContext(readinessSource, context);
assert.equal(result.url, context.location.href);
assert.equal(result.complete, true, 'Inaccessible frames do not force DOM readiness unresolved');
assert.equal(result.content, false, 'An empty shadow/frame tree is not content');
// Text directly under a shadow root has no parentElement.
closed.text = [ { textContent: 'Shadow-only article', parentElement: null } ];
assert.equal(vm.runInContext(readinessSource, context).content, true);
closedHost.shown = false;
assert.equal(vm.runInContext(readinessSource, context).content, false,
    'A hidden shadow host cannot establish visible content');
closedHost.shown = true;
closed.text = [];
nestedFrame.text = [ { textContent: 'Nested frame article', parentElement: nestedFrame.body } ];
assert.equal(vm.runInContext(readinessSource, context).content, true);
frameElement.shown = false;
assert.equal(vm.runInContext(readinessSource, context).content, false,
    'Frame content must be visible through every embedding frame');
frameElement.shown = true;
frame.readyState = 'loading';
assert.equal(vm.runInContext(readinessSource, context).complete, true, 'An unfinished frame does not veto the top document');
frame.readyState = 'complete';
top.readyState = 'interactive';
assert.equal(vm.runInContext(readinessSource, context).complete, true,
    'A parsed document can be inspected while optional resources are still loading');
top.readyState = 'loading';
assert.equal(vm.runInContext(readinessSource, context).complete, false);
top.readyState = 'complete';
for ( const root of scopes ) {
    root.busy = true;
    assert.equal(vm.runInContext(readinessSource, context).complete, true, 'A busy widget does not veto the page');
    root.busy = false;
}
closedHost.busy = true;
assert.equal(vm.runInContext(readinessSource, context).complete, true, 'A busy widget does not veto the page');
closedHost.busy = false;
const laterHost = makeElement(frame);
const later = makeScope(frame, laterHost);
laterHost.openOrClosedShadowRoot = later;
frame.elements.push(laterHost);
assert.equal(context.__quereeInspectionRoots().includes(later), true, 'New shadow roots remain discoverable');
const replacement = makeScope();
replacement.defaultView.frameElement = frameElement;
frameElement.contentDocument = replacement;
assert.equal(context.__quereeInspectionRoots().includes(replacement), true);
assert.equal(context.__quereeInspectionRoots().includes(frame), false);
assert.equal(vm.runInContext(readinessSource, context).content, false);
const image = { ...makeElement(replacement, 'img'), complete: false, naturalWidth: 10 };
replacement.media = [ image ];
assert.equal(vm.runInContext(readinessSource, context).content, false);
image.complete = true;
assert.equal(vm.runInContext(readinessSource, context).content, true,
    'Loaded media in a frame can establish visible content');
image.shown = false;
assert.equal(vm.runInContext(readinessSource, context).content, false);
top.text = [ { textContent: 'Top article still works', parentElement: top.body } ];
assert.equal(vm.runInContext(readinessSource, context).content, true);
console.log('Passed: shared shadow/frame discovery, visible readiness follow current roots');

top.body.shown = false;
top.text = [ { textContent: 'Visible child of a boxless body', parentElement: makeElement(top, 'p') } ];
assert.equal(vm.runInContext(readinessSource, context).content, true,
    'A body without its own visible box does not hide visible children');
