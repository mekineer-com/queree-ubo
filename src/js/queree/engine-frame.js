/*******************************************************************************

    Quer.ee policy engine
    Copyright (C) 2026-present Marcos

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*/

import { CompiledListReader } from '../static-filtering-io.js';
import { FilteringContext } from '../filtering-context.js';
import publicSuffixList from '../../lib/publicsuffixlist/publicsuffixlist.js';
import { shouldStrictBlock } from '../strict-blocking.js';
import staticNetFilteringEngine from '../static-net-filtering.js';

const fctxt = new FilteringContext();
let ready = false;

function matchRequest(details) {
    fctxt.redirectURL = undefined;
    fctxt.fromDetails(details)
        .setMethod(details.method)
        .setIPAddress(details.ipaddress)
        .setTabOrigin(details.tabOriginURL || details.originURL);
    if ( fctxt.itype !== fctxt.MAIN_FRAME ) {
        const result = staticNetFilteringEngine.matchRequest(fctxt);
        return {
            result,
            raw: staticNetFilteringEngine.toLogData()?.raw || '',
        };
    }
    const { result, logData } = shouldStrictBlock(fctxt, false);
    const response = { result, raw: logData?.raw || '' };
    if ( result === 1 ) { return response; }

    // Keep native non-blocked modifier order; never skip a canceled root.
    staticNetFilteringEngine.transformURL(fctxt);
    if ( staticNetFilteringEngine.hasQuery(fctxt) ) {
        staticNetFilteringEngine.filterQuery(fctxt);
    }
    staticNetFilteringEngine.urlSkip(fctxt, false);
    if ( fctxt.redirectURL !== undefined ) {
        response.redirectURL = fctxt.redirectURL;
    }
    return response;
}

function matchHeaders(details, responseHeaders, requestHeaders) {
    fctxt.fromDetails(details)
        .setMethod(details.method)
        .setIPAddress(details.ipaddress)
        .setTabOrigin(details.tabOriginURL || details.originURL);
    const result = staticNetFilteringEngine.matchHeaders(
        fctxt,
        responseHeaders,
        requestHeaders
    );
    return {
        result,
        raw: staticNetFilteringEngine.toLogData()?.raw || '',
    };
}

const root = document.documentElement;

root.addEventListener('quereePolicyCommand', ( ) => {
    let response;
    try {
        if ( ready === false ) { throw new Error('Policy engine is not ready'); }
        const command = JSON.parse(root.dataset.quereeCommand);
        if ( command.what === 'matchRequest' ) {
            response = matchRequest(command.details);
        } else if ( command.what === 'matchHeaders' ) {
            response = matchHeaders(
                command.details,
                command.responseHeaders,
                command.requestHeaders
            );
        } else {
            throw new Error(`Unknown policy command: ${command.what}`);
        }
    } catch (reason) {
        response = {
            error: reason instanceof Error ? reason.message : String(reason),
        };
    }
    root.dataset.quereeResponse = JSON.stringify(response);
});

addEventListener('message', event => {
    if ( event.source !== parent ) { return; }
    const details = event.data;
    if ( details?.what === 'reset' ) {
        ready = false;
        staticNetFilteringEngine.reset();
        root.dataset.quereeLoadState = 'reset';
        return;
    }
    if ( details?.what !== 'load' ) { return; }
    try {
        ready = false;
        root.dataset.quereeLoadState = 'loading';
        staticNetFilteringEngine.reset();
        publicSuffixList.fromSelfie(details.pslSelfie);
        for ( const content of details.compiledLists ) {
            staticNetFilteringEngine.fromCompiled(new CompiledListReader(content));
        }
        staticNetFilteringEngine.freeze();
        staticNetFilteringEngine.optimize();
        ready = true;
        root.dataset.quereeLoadResult = JSON.stringify({
            filterCount: staticNetFilteringEngine.getFilterCount(),
        });
        root.dataset.quereeLoadState = 'ready';
    } catch (reason) {
        root.dataset.quereeLoadResult = JSON.stringify({
            error: reason instanceof Error ? reason.message : String(reason),
        });
        root.dataset.quereeLoadState = 'error';
    }
});
