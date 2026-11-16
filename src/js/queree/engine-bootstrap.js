/*******************************************************************************

    Quer.ee policy engine bootstrap
    Copyright (C) 2026-present Marcos

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

*/

document.documentElement.dataset.quereeBootstrap = 'started';
import('./engine-frame.js').then(( ) => {
    document.documentElement.dataset.quereeBootstrap = 'ready';
}).catch(reason => {
    globalThis.quereePolicyEngineError = reason instanceof Error
        ? reason.message
        : String(reason);
    document.documentElement.dataset.quereeBootstrap =
        `error: ${globalThis.quereePolicyEngineError}`;
});
