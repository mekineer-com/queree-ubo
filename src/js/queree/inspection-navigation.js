/*******************************************************************************

    Quer.ee Android inspection navigation
    Copyright (C) 2026-present Marcos
    SPDX-License-Identifier: GPL-3.0-or-later

*/

const target = new URLSearchParams(window.location.search).get('url');
// Page-driven navigation avoids Fennec's app handoff for direct tab loads.
if ( target !== null && /^https?:\/\//.test(target) ) {
    window.location.replace(target);
}
