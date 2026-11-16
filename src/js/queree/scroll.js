/*******************************************************************************

    Quer.ee bounded inspection scrolling
    Copyright (C) 2026-present Marcos
    SPDX-License-Identifier: GPL-3.0-or-later

*/

(( ) => {
    const element = document.scrollingElement || document.body;
    if ( element === null ) { return; }
    const viewport = Math.max(window.innerHeight, 1);
    const top = Math.max(window.scrollY, element.scrollTop);
    const end = Math.max(element.scrollHeight - viewport, 0);
    if ( top >= end - 1 ) { return { moved: false }; }
    const target = Math.min(top + Math.floor(viewport * 0.9), end);
    window.scrollTo({ top: target, left: 0, behavior: 'instant' });
    const actual = Math.max(window.scrollY, element.scrollTop);
    return { moved: actual > top };
})()
