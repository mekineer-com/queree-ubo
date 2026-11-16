import { defaultPersonalCategories, validatePersonalCategories } from '../../src/js/queree/personal-categories.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../../src/queree.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../../src/js/queree.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../src/css/queree.css', import.meta.url), 'utf8');
const categoryKeys = [
    'quereeIncludePublicInterestOrganizations', 'quereeIncludeGovernmentEducation',
    'quereeIncludeProfessionalPublications',
    'quereeIncludeCommercialCorporate',
];

async function popup(saved, options = {}) {
    const button = {
        disabled: true,
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, handler) { this[name] = handler; },
    };
    const writes = [];
    const source = readFileSync(new URL('../../src/js/queree/popup.js', import.meta.url), 'utf8');
    vm.runInNewContext(source.replace(/^import .*;$/m, ''), {
        document: { querySelector: selector => {
            assert.equal(selector, '#quereeSwitch');
            return button;
        } },
        i18n$: key => key,
        vAPI: { messaging: { send: async (channel, message) => {
            if (options.fail) throw new Error('Disconnected');
            assert.equal(channel, 'queree');
            if (message.what === 'getSettings') {
                return { enabled: saved };
            }
            assert.equal(message.what, 'setUserSetting');
            assert.equal(message.name, 'quereeEnabled');
            writes.push(message.value);
            if (options.writeFailure) return { error: 'Storage unavailable' };
            saved = message.value;
            return { value: saved };
        } } },
    });
    await setImmediate();
    return { button, writes };
}

test('popup Q toggles only Quer.ee and restores the saved state on reopening', async () => {
    for (const enabled of [true, false]) {
        const { button, writes } = await popup(enabled);
        assert.equal(button.attributes['aria-pressed'], String(enabled));
        assert.equal(button.disabled, false);
        assert.equal(writes.length, 0);
        for (const expected of [!enabled, enabled]) {
            const pending = button.click();
            assert.equal(button.disabled, true);
            await pending;
            assert.equal(button.attributes['aria-pressed'], String(expected));
            assert.equal(button.title, expected ? 'popupQuereeTurnOff' : 'popupQuereeTurnOn');
            assert.equal(button.disabled, false);
        }
        assert.deepEqual(writes, [!enabled, enabled]);
    }
});

test('popup cannot claim a toggle succeeded when settings are unavailable', async () => {
    const options = {};
    const { button } = await popup(true, options);
    options.fail = true;
    await button.click();
    assert.equal(button.attributes['aria-pressed'], 'false');
    assert.equal(button.disabled, true);
    assert.equal(button.title, 'popupQuereeUnavailable');
    const initial = await popup(undefined);
    assert.equal(initial.button.disabled, true);
    assert.equal(initial.button.title, 'popupQuereeUnavailable');
    const failed = await popup(true, { writeFailure: true });
    await failed.button.click();
    assert.equal(failed.button.attributes['aria-pressed'], 'false');
    assert.equal(failed.button.disabled, true);
    assert.equal(failed.button.title, 'popupQuereeUnavailable');
});

test('popup keeps a separate website link below its native keyboard-accessible Q button', () => {
    const popupHTML = readFileSync(new URL('../../src/popup-fenix.html', import.meta.url), 'utf8');
    assert.match(popupHTML, /<button id="quereeSwitch" type="button"[^>]*disabled>/);
    assert.match(popupHTML, /<a id="quereeWebsite" href="https:\/\/quer\.ee\/"[^>]*>quer\.ee<\/a>/);
    assert.ok(popupHTML.indexOf('id="quereeSwitch"') < popupHTML.indexOf('id="quereeWebsite"'));
    assert.match(popupHTML, /<script src="js\/queree\/popup.js" type="module"><\/script>/);
});

async function dashboard(saved = {}, options = {}) {
    const nodes = new Map();
    const makeNode = () => {
        const classes = new Set();
        return {
            checked: false,
            disabled: false,
            value: '',
            textContent: '',
            children: [],
            classList: {
                toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
                contains(name) { return classes.has(name); },
            },
            events: new Map(),
            closest() { return this; },
            append(node) { this.children.push(node); },
            focus() { this.focused = true; },
        };
    };
    const get = selector => {
        if (!nodes.has(selector)) {
            nodes.set(selector, makeNode());
        }
        return nodes.get(selector);
    };
    get('#quereePersonalEditor').hidden = true;
    get('#quereePersonalControls').disabled = true;
    get('#quereePersonalRow').content = { firstElementChild: { cloneNode() {
        const row = makeNode();
        row.parts = new Map(['input', '.queree-category-name', '.queree-category-edit', '.queree-category-delete']
            .map(selector => [selector, makeNode()]));
        return row;
    } } };
    const checkboxes = Array.from(html.matchAll(/<input\b[^>]*data-setting-type="bool"[^>]*>/g), ([tag]) => {
        const name = /data-setting-name="([^"]+)"/.exec(tag)[1];
        const id = /\bid="([^"]+)"/.exec(tag)?.[1];
        const checkbox = get(id ? `#${id}` : `[data-setting-name="${name}"]`);
        checkbox.dataset = { settingName: name };
        return checkbox;
    });
    const details = {
        quereeEnabled: true, quereeCleanHistory: false,
        quereeSimultaneousInspections: 6, quereeRequireSingleDomain: false,
        quereeExcludeAdvertisingSignals: true, quereeExcludeCrossSiteTracking: true,
        quereeExcludeShoppingSignals: true,
        quereePersonalCategories: structuredClone(defaultPersonalCategories),
        ...Object.fromEntries(categoryKeys.map(name => [name, name !== 'quereeIncludeCommercialCorporate'])),
        ...saved,
    };
    const messages = [];
    const contribution = { hasKey: false, consent: false, ...options.contribution };
    const storageListeners = new Set();
    const permissionRequests = [];
    const permissionRemovals = [];
    const controls = [
        ...checkboxes,
        ...[
            '[data-setting-name="quereeSimultaneousInspections"]',
            '#quereeContribute', '#quereeInvitationKey', '#quereeSaveKey', '#quereeClearKey',
            '#quereePersonalControls', '#quereePersonalListControls', '#quereeAddCategory',
            '#quereeCategoryName', '#quereeCategoryEntries', '#quereeCancelCategory',
        ].map(get),
    ];
    const self = {};
    vm.runInNewContext(script.replace(/^import .*;$/gm, ''), {
        self,
        validatePersonalCategories,
        qs$: (node, selector) => typeof node === 'string' ? get(node) : node.parts.get(selector),
        qsa$: selector => {
            if (selector === 'input, button, textarea, fieldset') {
                return [...controls, ...get('#quereePersonalList').children.flatMap(row => [
                    row.parts.get('input'), row.parts.get('.queree-category-edit'), row.parts.get('.queree-category-delete'),
                ])];
            }
            assert.equal(selector, '[data-setting-type="bool"]');
            return checkboxes;
        },
        dom: {
            on(node, type, handler) {
                (typeof node === 'string' ? get(node) : node).events.set(type, handler);
            },
            attr(node, name, value) { node[name] = value; },
            clear(node) { node.children.length = 0; },
        },
        browser: { storage: { onChanged: { addListener(listener) { storageListeners.add(listener); } } }, permissions: {
            request: async permissions => {
                permissionRequests.push(permissions);
                if (options.permissionError) throw new Error('Permission unavailable');
                return options.granted !== false;
            },
            remove: async permissions => { permissionRemovals.push(permissions); },
        } },
        vAPI: { messaging: { send: (channel, message) => {
            messages.push({ channel, ...JSON.parse(JSON.stringify(message)) });
            const reply = () => {
                if (channel === 'dashboard') {
                    if (!message.name) return { ...details };
                    assert.fail('Quer.ee settings must use acknowledged saves');
                }
                if (message.what === 'setUserSetting') {
                    details[message.name] = message.value;
                    return { value: message.value };
                }
                if (message.what === 'getSettings') {
                    return { personalCategories: details.quereePersonalCategories };
                }
                if (message.what === 'setPersonalCategories') {
                    details.quereePersonalCategories = validatePersonalCategories(message.categories);
                    return { categories: details.quereePersonalCategories };
                }
                if (message.what === 'setContributionKey') {
                    contribution.hasKey = message.key !== '';
                    if (!contribution.hasKey) contribution.consent = false;
                }
                if (message.what === 'setContributionConsent') contribution.consent = message.consent;
                return { ...contribution };
            };
            return Promise.resolve(options.reply ? options.reply(channel, message, reply) : reply());
        } } },
    });
    await setImmediate();
    const setting = name => checkboxes.find(item => item.dataset.settingName === name);
    const change = (name, value) => {
        const checkbox = setting(name);
        checkbox.checked = value;
        return checkbox.events.get('change')({ target: checkbox });
    };
    const fire = (selector, type = 'click') => {
        const node = typeof selector === 'string' ? get(selector) : selector;
        return node.events.get(type)({ target: node, preventDefault() {} });
    };
    const category = index => get('#quereePersonalList').children[index].parts;
    const storageChanged = async (changes, area = 'local') => {
        for (const listener of storageListeners) listener(changes, area);
        await setImmediate();
    };
    return { get, setting, change, fire, category, self, messages, details, controls, permissionRequests, permissionRemovals,
        contribution, storageChanged };
}

test('native settings load existing choices without writes and default single-domain off', async () => {
    const { setting, messages, details } = await dashboard({
        quereeIncludeGovernmentEducation: false, quereeIncludeProfessionalPublications: false,
    });
    for (const name of categoryKeys) assert.equal(setting(name).checked, details[name]);
    assert.equal(setting('quereeRequireSingleDomain').checked, false);
    assert.equal(messages.filter(message => 'name' in message).length, 0);
});

test('single-domain saves only its queree-prefixed native key and restores a saved true', async () => {
    const { setting, change, messages, details } = await dashboard({ quereeRequireSingleDomain: true });
    assert.equal(setting('quereeRequireSingleDomain').checked, true);
    for (const checked of [false, true]) {
        await change('quereeRequireSingleDomain', checked);
        assert.deepEqual(messages.at(-1), {
            channel: 'queree', what: 'setUserSetting', name: 'quereeRequireSingleDomain', value: checked,
        });
        for (const name of categoryKeys) assert.equal(setting(name).checked, details[name]);
    }
});

test('corporate indicator follows loaded state and checkbox changes; category save key is unchanged', async () => {
    const { get, change, messages } = await dashboard({ quereeIncludeCommercialCorporate: true });
    const mark = get('#quereeCorporateIndicator');
    assert.equal(mark.classList.contains('enabled'), true);
    assert.equal(mark.tabIndex, 0);
    for (const checked of [false, true]) {
        await change('quereeIncludeCommercialCorporate', checked);
        assert.equal(mark.classList.contains('enabled'), checked);
        assert.equal(mark.tabIndex, checked ? 0 : -1);
        assert.deepEqual(messages.at(-1), {
            channel: 'queree', what: 'setUserSetting', name: 'quereeIncludeCommercialCorporate', value: checked,
        });
    }
});

test('settings markup keeps four builtin keys, personal editor, warning space and mobile stacking', () => {
    assert.deepEqual(Array.from(html.matchAll(/data-setting-name="(quereeInclude[^"]+)"/g), match => match[1]), categoryKeys);
    assert.match(html, /Site categories/);
    assert.match(html, /Site characteristics/);
    assert.doesNotMatch(html, /quereeIncludeCommunityContributions/);
    assert.match(html, /id="quereePersonalEditor" hidden/);
    assert.match(html, /id="quereeCategoryEntries"[^>]*aria-describedby="quereePersonalStatus"/);
    assert.match(html, /id="quereeCategoryName"[^>]*aria-describedby="quereePersonalStatus"/);
    assert.match(html, /id="quereePersonalStatus"[^>]*role="status"/);
    assert.match(html, /<span>Corporations<\/span>/);
    assert.ok(html.indexOf('<span>Professional publications</span>') < html.indexOf('<span>Corporations</span>'));
    assert.ok(html.indexOf('<span>Corporations</span>') < html.indexOf('class="queree-personal-categories"'));
    assert.match(html, /aria-label="Corporate sites are included\."/);
    assert.doesNotMatch(html, /settings-toggle/);
    assert.match(css, /\.queree-corporate-indicator\s*\{[^}]*width: 1ch;[^}]*visibility: hidden;/);
    assert.match(css, /\.queree-corporate-indicator\.enabled:focus::after/);
    assert.match(css, /@media \(max-width: 760px\)\s*\{\s*\.queree-search-options\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
});

test('personal editor loads the shared starter without writes; edits, toggles and deletion persist', async () => {
    const ui = await dashboard();
    const writes = () => ui.messages.filter(message => message.what === 'setPersonalCategories');
    assert.equal(ui.category(0).get('.queree-category-name').textContent, 'Social platforms');
    assert.equal(ui.category(0).get('input').checked, true);
    assert.equal(ui.get('#quereePersonalControls').disabled, false);
    assert.equal(writes().length, 0);
    const checkbox = ui.category(0).get('input');
    checkbox.checked = false;
    await ui.fire(checkbox, 'change');
    assert.equal(ui.details.quereePersonalCategories[0].enabled, false);
    assert.equal(ui.category(0).get('input').focused, true);
    assert.equal(ui.get('#quereePersonalStatus').textContent, '');

    await ui.fire(ui.category(0).get('.queree-category-edit'));
    assert.equal(ui.get('#quereeCategoryEntries').value, defaultPersonalCategories[0].entries.join('\n'));
    ui.get('#quereeCategoryName').value = ' Forums ';
    ui.get('#quereeCategoryEntries').value = ' Reddit.com/*\r\n\nhttps://Example.org/page#:~:text=part\nhttps://example.org/page\n';
    assert.equal(ui.self.hasUnsavedData(), true);
    await ui.fire('#quereePersonalEditor', 'submit');
    const expected = [{ name: 'Forums', enabled: false, entries: ['reddit.com/*', 'https://example.org/page'] }];
    assert.deepEqual(ui.details.quereePersonalCategories, expected);
    assert.equal(ui.get('#quereePersonalEditor').hidden, true);
    assert.equal(ui.get('#quereePersonalStatus').textContent, 'Personal categories saved.');
    assert.equal(ui.self.hasUnsavedData(), false);
    const reopened = await dashboard({ quereePersonalCategories: ui.details.quereePersonalCategories });
    assert.equal(reopened.category(0).get('.queree-category-name').textContent, 'Forums');
    assert.equal(reopened.category(0).get('input').checked, false);

    await ui.fire('#quereeAddCategory');
    ui.get('#quereeCategoryName').value = '<Local notes>';
    ui.get('#quereeCategoryEntries').value = 'notes.example.org/*';
    await ui.fire('#quereePersonalEditor', 'submit');
    assert.equal(ui.category(1).get('.queree-category-name').textContent, '<Local notes>');
    assert.equal(ui.category(1).get('input').checked, true);
    assert.equal(ui.details.quereePersonalCategories.length, 2);
    await ui.fire(ui.category(0).get('.queree-category-delete'));
    assert.equal(ui.details.quereePersonalCategories[0].name, '<Local notes>');
    await ui.fire(ui.category(0).get('.queree-category-delete'));
    assert.deepEqual(ui.details.quereePersonalCategories, []);
    assert.equal((await dashboard({ quereePersonalCategories: [] })).get('#quereePersonalList').children.length, 0);
    assert.equal(writes().length, 5);
    assert.ok(writes().every(message => message.channel === 'queree'));
    assert.equal(ui.messages.some(message => 'name' in message), false);
    for (const key of categoryKeys) assert.equal(ui.setting(key).checked, ui.details[key]);
});

test('cancel discards only the editor draft and leaves personal and builtin settings untouched', async () => {
    const ui = await dashboard();
    await ui.fire(ui.category(0).get('.queree-category-edit'));
    assert.equal(ui.self.hasUnsavedData(), false);
    ui.get('#quereeCategoryName').value = 'Discard me';
    ui.get('#quereeCategoryEntries').value = 'different.example/*';
    assert.equal(ui.get('#quereePersonalListControls').disabled, true);
    assert.equal(ui.self.hasUnsavedData(), true);
    await ui.fire('#quereeCancelCategory');
    assert.equal(ui.self.hasUnsavedData(), false);
    assert.equal(ui.get('#quereePersonalListControls').disabled, false);
    assert.equal(ui.get('#quereeAddCategory').focused, true);
    await ui.fire(ui.category(0).get('.queree-category-edit'));
    assert.equal(ui.get('#quereeCategoryName').value, 'Social platforms');
    assert.equal(ui.get('#quereeCategoryEntries').value, defaultPersonalCategories[0].entries.join('\n'));
    assert.equal(ui.messages.some(message => message.what === 'setPersonalCategories'), false);
    await ui.fire('#quereeCancelCategory');
    const checkbox = ui.category(0).get('input');
    checkbox.checked = false;
    await ui.fire(checkbox, 'change');
    assert.equal(ui.get('#quereePersonalStatus').textContent, '');
    assert.deepEqual(ui.details.quereePersonalCategories, [{ ...defaultPersonalCategories[0], enabled: false }],
        'Toggling after Cancel saves only the checkbox, never the canceled draft');
});

test('page/site overlaps and invalid entries stay inline without writing or losing the draft', async () => {
    for (const entries of ['https://www.reddit.com/page', 'reddit.com/*']) {
        const ui = await dashboard();
        await ui.fire('#quereeAddCategory');
        ui.get('#quereeCategoryName').value = 'Other';
        ui.get('#quereeCategoryEntries').value = entries;
        await ui.fire('#quereePersonalEditor', 'submit');
        assert.equal(ui.get('#quereePersonalStatus').textContent, 'Page already in Social platforms.');
        assert.equal(ui.get('#quereePersonalStatus').classList.contains('error'), true);
        assert.equal(ui.get('#quereePersonalEditor').hidden, false);
        assert.equal(ui.get('#quereeCategoryEntries').value, entries);
        assert.equal(ui.self.hasUnsavedData(), true);
        assert.equal(ui.messages.some(message => message.what === 'setPersonalCategories'), false);
        ui.get('#quereeCategoryEntries').value = 'other.example/path/*';
        await ui.fire('#quereePersonalEditor', 'submit');
        assert.equal(ui.get('#quereePersonalStatus').textContent, 'Enter a page address or site.com/*.');
        ui.get('#quereeCategoryEntries').value = 'other.example/*';
        ui.get('#quereeCategoryName').value = '   ';
        await ui.fire('#quereePersonalEditor', 'submit');
        assert.equal(ui.get('#quereePersonalStatus').textContent, 'Enter a category name.');
        ui.get('#quereeCategoryName').value = 'Other';
        await ui.fire('#quereePersonalEditor', 'submit');
        assert.equal(ui.details.quereePersonalCategories.length, 2);
        assert.equal(ui.get('#quereePersonalStatus').classList.contains('error'), false);
    }
});

test('privileged validation errors restore toggles and preserve editable drafts for retry', async () => {
    const options = {};
    const ui = await dashboard({}, options);
    options.reply = (channel, message, reply) => message.what === 'setPersonalCategories'
        ? { error: 'Page already in Another category.' } : reply();
    const checkbox = ui.category(0).get('input');
    checkbox.checked = false;
    await ui.fire(checkbox, 'change');
    assert.equal(checkbox.checked, true);
    assert.equal(ui.get('#quereePersonalControls').disabled, false);
    assert.equal(ui.get('#quereePersonalStatus').textContent, 'Page already in Another category.');
    await ui.fire('#quereeAddCategory');
    ui.get('#quereeCategoryName').value = 'Notes';
    ui.get('#quereeCategoryEntries').value = 'notes.example/*';
    await ui.fire('#quereePersonalEditor', 'submit');
    assert.equal(ui.get('#quereePersonalEditor').hidden, false);
    assert.equal(ui.get('#quereeCategoryName').value, 'Notes');
    assert.equal(ui.get('#quereeCategoryEntries').value, 'notes.example/*');
    assert.equal(ui.details.quereePersonalCategories.length, 1);
    options.reply = (channel, message, reply) => {
        if (message.what !== 'setPersonalCategories') return reply();
        const result = reply();
        result.categories[1].name = 'Confirmed notes';
        return result;
    };
    await ui.fire('#quereePersonalEditor', 'submit');
    assert.equal(ui.category(1).get('.queree-category-name').textContent, 'Confirmed notes');
});

test('unconfirmed personal saves disable controls, retain the draft and never announce success', async () => {
    for (const failure of [undefined, null, {}, new Error('Disconnected')]) {
        const options = {};
        const ui = await dashboard({}, options);
        await ui.fire(ui.category(0).get('.queree-category-edit'));
        ui.get('#quereeCategoryName').value = 'Unsaved name';
        options.reply = (channel, message, reply) => {
            if (message.what !== 'setPersonalCategories') return reply();
            if (failure instanceof Error) throw failure;
            return failure;
        };
        await ui.fire('#quereePersonalEditor', 'submit');
        assertUnavailable(ui);
        assert.match(ui.get('#quereePersonalStatus').textContent, /Settings unavailable/);
        assert.equal(ui.get('#quereePersonalEditor').hidden, false);
        assert.equal(ui.get('#quereeCategoryName').value, 'Unsaved name');
        assert.equal(ui.category(0).get('.queree-category-name').textContent, 'Social platforms');
        assert.equal(ui.self.hasUnsavedData(), true);
    }
});

test('missing personal settings disable the pane rather than inventing a replacement starter', async () => {
    for (const reply of [undefined, {}, { personalCategories: null }]) {
        const ui = await dashboard({}, { reply: (channel, message, original) =>
            message.what === 'getSettings' ? reply : original() });
        assertUnavailable(ui);
        assert.match(ui.get('#quereePersonalStatus').textContent, /Settings unavailable/);
        assert.equal(ui.get('#quereePersonalList').children.length, 0);
        assert.equal(ui.messages.some(message => message.what === 'setPersonalCategories'), false);
    }
});

test('delayed personal saves lock the editor and cannot override an unavailable state', async () => {
    const options = {};
    const ui = await dashboard({}, options);
    let finish;
    options.reply = (channel, message, reply) => {
        if (message.what !== 'setPersonalCategories') return reply();
        return new Promise(resolve => { finish = () => resolve(reply()); });
    };
    await ui.fire(ui.category(0).get('.queree-category-edit'));
    ui.get('#quereeCategoryName').value = 'New name';
    const pending = ui.fire('#quereePersonalEditor', 'submit');
    assert.equal(ui.get('#quereePersonalControls').disabled, true);
    assert.equal(ui.get('#quereePersonalEditor').hidden, false);
    assert.equal(ui.get('#quereePersonalStatus').textContent, '');
    options.reply = () => undefined;
    await ui.fire('#quereeClearKey');
    assertUnavailable(ui);
    finish();
    await pending;
    assertUnavailable(ui);
    assert.match(ui.get('#quereePersonalStatus').textContent, /Settings unavailable/);
    assert.equal(ui.get('#quereePersonalEditor').hidden, false);
    assert.equal(ui.category(0).get('.queree-category-name').textContent, 'Social platforms');
});

test('Shopping signals is enabled by default and can be disabled independently', async () => {
    const { setting, change, messages } = await dashboard();
    assert.equal(setting('quereeExcludeShoppingSignals').checked, true);
    await change('quereeExcludeShoppingSignals', false);
    assert.deepEqual(messages.at(-1), {
        channel: 'queree', what: 'setUserSetting', name: 'quereeExcludeShoppingSignals', value: false,
    });
    assert.match(html, /<span>Shopping signals<\/span>/);
    assert.doesNotMatch(html, /quereeExcludeReferralSignals/);
});

test('Advertising signals defaults on, saves independently and restores the saved choice', async () => {
    const { setting, change, messages } = await dashboard();
    assert.equal(setting('quereeExcludeAdvertisingSignals').checked, true);
    await change('quereeExcludeAdvertisingSignals', false);
    assert.deepEqual(messages.at(-1), {
        channel: 'queree', what: 'setUserSetting', name: 'quereeExcludeAdvertisingSignals', value: false,
    });
    assert.equal(setting('quereeExcludeShoppingSignals').checked, true);
    assert.equal((await dashboard({ quereeExcludeAdvertisingSignals: false }))
        .setting('quereeExcludeAdvertisingSignals').checked, false);
    assert.match(html, /<span>Advertising signals<\/span>/);
    const background = readFileSync(new URL('../../src/js/background.js', import.meta.url), 'utf8');
    assert.match(background, /quereeExcludeAdvertisingSignals: true/);
});

test('Cross-site tracking defaults on, saves independently and restores the saved choice', async () => {
    const { setting, change, messages } = await dashboard();
    assert.equal(setting('quereeExcludeCrossSiteTracking').checked, true);
    await change('quereeExcludeCrossSiteTracking', false);
    assert.deepEqual(messages.at(-1), {
        channel: 'queree', what: 'setUserSetting', name: 'quereeExcludeCrossSiteTracking', value: false,
    });
    assert.equal(setting('quereeExcludeAdvertisingSignals').checked, true);
    assert.equal(setting('quereeExcludeShoppingSignals').checked, true);
    assert.equal((await dashboard({ quereeExcludeCrossSiteTracking: false }))
        .setting('quereeExcludeCrossSiteTracking').checked, false);
    assert.match(html, /<span>Cross-site tracking<\/span>/);
    const name = 'data-setting-name="quereeExcludeCrossSiteTracking"';
    assert.ok(html.indexOf('data-setting-name="quereeExcludeAdvertisingSignals"') < html.indexOf(name));
    assert.ok(html.indexOf(name) < html.indexOf('data-setting-name="quereeExcludeShoppingSignals"'));
    assert.match(html, /aria-describedby="queree-tracking-description"/);
    assert.match(html, /id="queree-tracking-description"/);
    const background = readFileSync(new URL('../../src/js/background.js', import.meta.url), 'utf8');
    assert.match(background, /quereeExcludeCrossSiteTracking: true/);
});

function assertUnavailable(ui) {
    assert.equal(ui.controls.every(control => control.disabled), true);
    for (const id of ['#quereeHistoryStatus', '#quereeContributionStatus']) {
        assert.match(ui.get(id).textContent, /Settings unavailable.*could not be confirmed.*Reload/);
    }
}

test('missing and failed initial replies disable controls with accessible feedback', async () => {
    for (const failure of [undefined, null, false, new Error('Disconnected')]) {
        const ui = await dashboard({}, { reply: () => {
            if (failure instanceof Error) throw failure;
            return failure;
        } });
        assertUnavailable(ui);
        assert.equal(ui.messages.length, 1);
    }
    for (const id of ['quereeHistoryStatus', 'quereeContributionStatus']) {
        assert.match(html, new RegExp(`id="${id}"[^>]*role="status"`));
    }
});

test('native saves acknowledge false settings, including history', async () => {
    const ui = await dashboard({ quereeCleanHistory: true });
    for (const name of ['quereeEnabled', 'quereeCleanHistory', 'quereeRequireSingleDomain']) {
        await ui.change(name, false);
        assert.equal(ui.setting(name).checked, false);
        assert.equal(ui.setting(name).disabled, false);
        assert.deepEqual(ui.messages.at(-1), { channel: 'queree', what: 'setUserSetting', name, value: false });
    }
    assert.equal(ui.get('#quereeHistoryStatus').textContent, 'History cleanup is off');
});

test('lost or failed writes restore confirmed choices, indicators and concurrency', async () => {
    for (const stage of ['write', 'rejected', 'throw', 'mismatch']) {
        for (const name of ['quereeIncludeCommercialCorporate', 'quereeCleanHistory', 'quereeExcludeCrossSiteTracking', 'quereeSimultaneousInspections']) {
            const options = {};
            const ui = await dashboard({
                quereeIncludeCommercialCorporate: true, quereeCleanHistory: true,
            }, options);
            options.reply = (channel, message, reply) => {
                if (message.what !== 'setUserSetting') return reply();
                if (stage === 'throw') throw new Error('Disconnected');
                if (stage === 'mismatch') return { value: 'wrong' };
                if (stage === 'rejected') return { error: 'Storage unavailable' };
                return undefined;
            };
            if (name === 'quereeSimultaneousInspections') {
                const input = ui.get('[data-setting-name="quereeSimultaneousInspections"]');
                input.value = '3';
                await ui.fire('[data-setting-name="quereeSimultaneousInspections"]', 'change');
                assert.equal(input.value, 6);
            } else {
                await ui.change(name, false);
                assert.equal(ui.setting(name).checked, true);
            }
            assertUnavailable(ui);
            assert.equal(ui.get('#quereeCorporateIndicator').classList.contains('enabled'), true);
        }
    }
});

test('delayed native replies cannot announce an unconfirmed save or clear an unavailable state', async () => {
    const options = {};
    const ui = await dashboard({}, options);
    let finish;
    options.reply = (channel, message, reply) => {
        if (message.name !== 'quereeCleanHistory') return reply();
        return new Promise(resolve => { finish = resolve; });
    };
    const pending = ui.change('quereeCleanHistory', true);
    await setImmediate();
    assert.equal(ui.setting('quereeCleanHistory').disabled, true);
    assert.equal(ui.get('#quereeHistoryStatus').textContent, 'History cleanup is off');
    options.reply = () => undefined;
    ui.get('#quereeInvitationKey').value = `qk_${'a'.repeat(43)}`;
    await ui.fire('#quereeSaveKey');
    assertUnavailable(ui);
    finish({ value: true });
    await pending;
    assertUnavailable(ui);
    assert.equal(ui.setting('quereeCleanHistory').checked, false);
    assert.notEqual(ui.get('#quereeInvitationKey').value, '');
});

test('invalid concurrency uses the established default while valid limits still clamp', async () => {
    const ui = await dashboard();
    const selector = '[data-setting-name="quereeSimultaneousInspections"]';
    for (const [input, expected] of [['', 6], ['invalid', 6], ['0', 6], ['-2', 1], ['12', 8], ['3', 3]]) {
        ui.get(selector).value = input;
        await ui.fire(selector, 'change');
        assert.equal(ui.get(selector).value, expected);
        assert.equal(ui.messages.at(-1).value, expected);
    }
    const background = readFileSync(new URL('../../src/js/background.js', import.meta.url), 'utf8');
    assert.match(background, /quereeSimultaneousInspections: 6/);
});

test('contribution refresh failures use the same unavailable state', async () => {
    for (const failure of [undefined, null, false, new Error('Disconnected')]) {
        const ui = await dashboard({}, { reply: (channel, message, reply) => {
            if (channel !== 'queree') return reply();
            if (failure instanceof Error) return Promise.reject(failure);
            return failure;
        } });
        assertUnavailable(ui);
    }
});

test('Background contribution changes refresh status and consent without changing a typed key', async () => {
    const ui = await dashboard({}, { contribution: { hasKey: true, consent: true, queued: 2 } });
    const reads = () => ui.messages.filter(message => message.what === 'getContributionState').length;
    ui.get('#quereeInvitationKey').value = 'unfinished key';
    assert.match(ui.get('#quereeContributionStatus').textContent, /2 waiting to send/);
    await ui.storageChanged({ anotherKey: {} });
    await ui.storageChanged({ quereeContributionState: {} }, 'sync');
    assert.equal(reads(), 1, 'Unrelated changes do not fetch contribution state');
    Object.assign(ui.contribution, { queued: 0, discarded: 1, lastError: 'authentication' });
    await ui.storageChanged({ quereeContributionState: {} });
    assert.match(ui.get('#quereeContributionStatus').textContent, /1 discarded.*key was not accepted/);
    assert.doesNotMatch(ui.get('#quereeContributionStatus').textContent, /waiting to send/);
    Object.assign(ui.contribution, { consent: false, lastError: '' });
    await ui.storageChanged({ quereeContributionState: {} });
    assert.equal(ui.get('#quereeContribute').checked, false, 'Revoked Firefox consent reaches the open pane');
    assert.equal(ui.get('#quereeInvitationKey').value, 'unfinished key');
    ui.contribution.hasKey = false;
    await ui.storageChanged({ quereeContributionState: {} });
    assert.equal(ui.get('#quereeContribute').disabled, true);
    assert.equal(ui.get('#quereeRequestKey').hidden, false);
});

test('A delayed contribution snapshot cannot overwrite a newer background update', async () => {
    const options = { contribution: { hasKey: true, consent: true, queued: 2 } };
    const ui = await dashboard({}, options);
    let resolveOld;
    options.reply = (_channel, message, reply) => message.what === 'getContributionState'
        ? new Promise(resolve => { resolveOld = resolve; }) : reply();
    await ui.storageChanged({ quereeContributionState: {} });
    options.reply = undefined;
    Object.assign(ui.contribution, { consent: false, queued: 0 });
    await ui.storageChanged({ quereeContributionState: {} });
    resolveOld({ hasKey: true, consent: true, queued: 2 });
    await setImmediate();
    assert.equal(ui.get('#quereeContribute').checked, false);
    assert.doesNotMatch(ui.get('#quereeContributionStatus').textContent, /waiting to send/);
});

test('unsuccessful key saves and clears retain typed keys; successful ones clear them', async () => {
    const key = `qk_${'a'.repeat(43)}`;
    for (const selector of ['#quereeSaveKey', '#quereeClearKey']) {
        for (const failure of [undefined, null, false, new Error('Disconnected')]) {
            const options = { contribution: { hasKey: true } };
            const ui = await dashboard({}, options);
            options.reply = (channel, message, reply) => {
                if (message.what !== 'setContributionKey') return reply();
                if (failure instanceof Error) throw failure;
                return failure;
            };
            ui.get('#quereeInvitationKey').value = ` ${key} `;
            await ui.fire(selector);
            assert.equal(ui.get('#quereeInvitationKey').value, ` ${key} `);
            assertUnavailable(ui);
        }
        const ui = await dashboard();
        assert.equal(ui.get('#quereeRequestKey').hidden, false);
        ui.get('#quereeInvitationKey').value = key;
        await ui.fire(selector);
        assert.equal(ui.get('#quereeInvitationKey').value, '');
        assert.equal(ui.messages.at(-1).key, selector === '#quereeSaveKey' ? key : '');
        assert.equal(ui.get('#quereeRequestKey').hidden, selector === '#quereeSaveKey');
    }
    const ui = await dashboard();
    ui.get('#quereeInvitationKey').value = 'not a key';
    const count = ui.messages.length;
    await ui.fire('#quereeSaveKey');
    assert.equal(ui.messages.length, count);
    assert.equal(ui.get('#quereeInvitationKey').value, 'not a key');
    assert.match(ui.get('#quereeContributionStatus').textContent, /Invitation key is invalid/);
});

test('the invitation request link opens a preaddressed email', () => {
    assert.match(html, /href="mailto:support@quer\.ee\?subject=Quer\.ee%20invitation%20request">Request an invitation key<\/a>/);
});

test('contribution consent follows confirmed state and only removes permission after confirmation', async () => {
    for (const enabled of [true, false]) {
        for (const failure of [undefined, false, new Error('Disconnected')]) {
            const options = { contribution: { hasKey: true, consent: !enabled } };
            const ui = await dashboard({}, options);
            options.reply = (channel, message, reply) => {
                if (message.what !== 'setContributionConsent') return reply();
                if (failure instanceof Error) throw failure;
                return failure;
            };
            ui.get('#quereeContribute').checked = enabled;
            await ui.fire('#quereeContribute', 'change');
            assert.equal(ui.get('#quereeContribute').checked, !enabled);
            assert.equal(ui.permissionRemovals.length, 0);
            assertUnavailable(ui);
        }
    }
    const ui = await dashboard({}, { contribution: { hasKey: true } });
    for (const enabled of [true, false]) {
        ui.get('#quereeContribute').checked = enabled;
        await ui.fire('#quereeContribute', 'change');
        assert.equal(ui.get('#quereeContribute').checked, enabled);
        assert.equal(ui.get('#quereeContribute').disabled, false);
    }
    assert.equal(ui.permissionRequests.length, 1);
    assert.equal(ui.permissionRemovals.length, 1);
});

test('denied or failed Firefox permissions do not save contribution consent', async () => {
    for (const options of [{ granted: false }, { permissionError: true }]) {
        const ui = await dashboard({}, { ...options, contribution: { hasKey: true } });
        const count = ui.messages.length;
        ui.get('#quereeContribute').checked = true;
        await ui.fire('#quereeContribute', 'change');
        assert.equal(ui.get('#quereeContribute').checked, false);
        assert.equal(ui.messages.length, count);
        assert.match(ui.get('#quereeContributionStatus').textContent, /Firefox data permission is required/);
    }
});

test('contribution errors have readable explanations rather than raw codes', async () => {
    for (const [lastError, explanation] of [
        ['key_required', /invitation key is required/],
        ['authentication', /key was not accepted/],
        ['quota_exhausted', /quota is exhausted.*replacement key/],
        ['temporary', /temporarily unavailable.*retry automatically/],
        ['timeout', /did not respond in time.*retry automatically/],
        ['transport', /Could not connect.*retry automatically/],
        ['invalid_response', /unreadable reply.*retry automatically/],
        ['server_418', /rejected the upload.*retry automatically/],
        ['Some pages could not be contributed', /Some pages could not be contributed/],
    ]) {
        const ui = await dashboard({}, { contribution: { hasKey: true, queued: 2, discarded: 3, lastError } });
        const status = ui.get('#quereeContributionStatus').textContent;
        assert.match(status, explanation);
        assert.match(status, /2 waiting to send.*3 discarded/);
        assert.doesNotMatch(status, /Last error:|key_required|authentication|server_418|invalid_response/);
    }
});
