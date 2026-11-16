/* Shared policy-frame command transport; GPL-3.0-or-later. */

export function policyFrame(id = 'quereePolicyEngine') {
    return document.getElementById(id)?.contentWindow;
}

export async function waitForPolicyEngine(id = 'quereePolicyEngine') {
    let state = 'frame missing';
    for ( let i = 0; i < 200; i++ ) {
        const frame = policyFrame(id);
        let bootstrap;
        if ( frame !== undefined ) {
            bootstrap = frame.document.documentElement.dataset.quereeBootstrap;
            state = `${frame.location.href} (${frame.document.readyState}; ${bootstrap || 'not started'})`;
        }
        if ( bootstrap?.startsWith('error: ') ) {
            throw new Error(bootstrap.slice(7));
        }
        if ( bootstrap === 'ready' ) { return frame; }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Quer.ee policy frame did not load: ${state}`);
}

export async function loadPolicyFrame(frame, details) {
    const root = frame.document.documentElement;
    root.dataset.quereeLoadState = '';
    frame.postMessage({ what: 'load', ...details }, location.origin);
    for ( let i = 0; i < 1200; i++ ) {
        const state = root.dataset.quereeLoadState;
        if ( state === 'ready' || state === 'error' ) {
            const result = JSON.parse(root.dataset.quereeLoadResult || '{}');
            if ( result.error ) { throw new Error(result.error); }
            return result;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Quer.ee policy profile did not finish loading');
}

export function policyCommand(command, id = 'quereePolicyEngine') {
    const frame = policyFrame(id);
    const root = frame.document.documentElement;
    root.dataset.quereeCommand = JSON.stringify(command);
    root.dataset.quereeResponse = '';
    const event = frame.document.createEvent('Event');
    event.initEvent('quereePolicyCommand', false, false);
    root.dispatchEvent(event);
    const response = JSON.parse(root.dataset.quereeResponse || '{}');
    if ( response.error ) { throw new Error(response.error); }
    return response;
}
