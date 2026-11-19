const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

function load() {
    const frames = [];
    const document = { createDocumentFragment() { throw Error('fragment failure'); } };
    const source = readFileSync(process.env.BCP_SOURCE || 'extension.js', 'utf8').replace('export default {', 'const extension = {');
    const api = runInNewContext(`${source}
        ({ computeItemKey, ensureStar, handlePaletteKeydown, decorateAndApplyPinning, reorderMenu, scheduleDecorate,
           setState(v) { if ('portal' in v) portalEl = v.portal;
             if ('open' in v) paletteOpen = v.open; if ('observer' in v) menuObserver = v.observer;
             if ('observed' in v) menuObservedEl = v.observed; if ('sort' in v) sessionSortMode = v.sort; },
           setEnsure(fn) { ensureSortControls = fn; },
           state() { return { decoratePending, decorateRaf, decorateInProgress, reorderInProgress }; } })`,
        { document, requestAnimationFrame: fn => (frames.push(fn), frames.length), cancelAnimationFrame() {} });
    return { ...api, frames, document };
}
function classes(active = false) {
    let value = active;
    return { contains: () => value, add: () => { value = true; }, remove: () => { value = false; } };
}
function keyboardItem(active = false) {
    return { classList: classes(active), dataset: {}, visible: true, getClientRects() { return this.visible ? [1] : []; }, scrollIntoView() {}, click() { this.clicked = true; } };
}
function keyboardFixture(api) {
    const first = keyboardItem(true), second = keyboardItem();
    const menu = { dataset: { bcpReordered: '1' }, querySelectorAll() { return [first, second]; }, querySelector() { return [first, second].find(i => i.classList.contains()) || null; } };
    api.setState({open: true, portal: {querySelector: () => menu}});
    const press = key => { const event = {key, preventDefault() { this.prevented = true; }, stopPropagation() {}}; api.handlePaletteKeydown(event); return event; };
    return { first, second, press };
}
function menuFixture(api) {
    const menu = { dataset: {}, children: [], querySelectorAll: () => [], querySelector: () => null, addEventListener() {} };
    const portal = { querySelector(selector) { return selector === '.rm-command-palette__menu' ? menu : null; } };
    const observer = { observing: true, disconnect() { this.observing = false; }, observe() { this.observing = true; } };
    api.setState({portal, open: true, observer, observed: menu});
    return {menu, portal, observer};
}

test('new shortcut on reused item changes its key', () => {
    const api = load(), label = { textContent: 'Open' }, shortcuts = [];
    const item = { contains: () => true, querySelector: () => label, querySelectorAll: () => shortcuts };
    assert.equal(api.computeItemKey(item).key, 'open');
    shortcuts.push({textContent: 'Ctrl+X'});
    assert.equal(api.computeItemKey(item).key, 'open||ctrl+x');

    let currentLabel = {textContent: 'Open'}, queries = 0;
    const reusedItem = {contains: node => node === currentLabel,
        querySelector: () => { queries++; return currentLabel; }, querySelectorAll: () => []};
    assert.equal(api.computeItemKey(reusedItem).key, 'open');
    currentLabel = {textContent: 'Open'};
    queries = 0;
    for (let i = 0; i < 5; i++) assert.equal(api.computeItemKey(reusedItem).key, 'open');
    assert.equal(queries, 1);
});
test('arrow navigation reads current visibility', () => {
    const api = load(), {first, second, press} = keyboardFixture(api);
    press('ArrowDown'); first.classList.add(); second.classList.remove(); second.visible = false;
    press('ArrowDown');
    assert.equal(first.classList.contains(), true);
    assert.equal(second.classList.contains(), false);
});
test('Enter activates current item without moving selection', () => {
    const api = load(), {first, second, press} = keyboardFixture(api);
    assert.equal(press('Enter').prevented, true);
    assert.equal(first.clicked, true);
    assert.equal(second.classList.contains(), false);
});
test('decoration requests during an active pass get a frame', () => {
    const api = load(), {portal} = menuFixture(api);
    let calls = 0;
    api.setEnsure(() => { if (++calls === 1) api.scheduleDecorate(); });
    api.decorateAndApplyPinning(portal);
    assert.equal(api.state().decoratePending, true);
    assert.equal(api.frames.length, 1);
    api.frames.shift()();
    assert.equal(calls, 2);
    assert.equal(api.state().decoratePending, false);
});
test('stars are created fully and not rewritten on another pass', () => {
    const api = load(), attrs = new Map();
    let writes = 0, text = '', title = '', star;
    api.document.createElement = () => ({
        dataset: {},
        get textContent() { return text; }, set textContent(v) { text = v; writes++; },
        get title() { return title; }, set title(v) { title = v; writes++; },
        getAttribute: key => attrs.get(key) || null,
        setAttribute(key, value) { attrs.set(key, value); writes++; },
        addEventListener() {},
    });
    const label = { contains: el => el === star, querySelector: () => star,
        prepend(el) { star = el; } };
    const item = { contains: el => el === label, querySelector: () => label };
    api.ensureStar(item, false, 'open');
    assert.ok(star);
    assert.equal(star.dataset.bcpKey, 'open');
    assert.equal(text, '☆');
    assert.equal(attrs.get('data-pinned'), '0');
    assert.equal(attrs.get('aria-pressed'), 'false');
    assert.equal(attrs.get('aria-label'), 'Pin command');
    assert.equal(title, 'Pin command');
    const initialWrites = writes;
    api.ensureStar(item, false, 'open');
    assert.equal(writes, initialWrites);
});
test('interrupted star state is completed on the next pass', () => {
    const api = load(), attrs = new Map();
    let fail = true;
    const star = {dataset: {}, textContent: '', title: '',
        getAttribute: key => attrs.get(key) || null,
        setAttribute(key, value) {
            if (key === 'aria-pressed' && fail) { fail = false; throw Error('star failure'); }
            attrs.set(key, value);
        }};
    const label = {contains: el => el === star, querySelector: () => star};
    const item = {contains: el => el === label, querySelector: () => label};
    assert.throws(() => api.ensureStar(item, false, 'open'), /star failure/);
    api.ensureStar(item, false, 'open');
    assert.equal(attrs.get('aria-pressed'), 'false');
    assert.equal(attrs.get('aria-label'), 'Pin command');
    assert.equal(star.title, 'Pin command');
});
test('failed native restoration can be retried', () => {
    const api = load(); let fail = false;
    api.document.createDocumentFragment = () => {
        if (fail) { fail = false; throw Error('fragment failure'); }
        return {children: [], appendChild(el) {
            el.parent.children.splice(el.parent.children.indexOf(el), 1);
            this.children.push(el); el.parent = this;
        }};
    };
    const menu = {dataset: {}, children: [], querySelector: () => null,
        appendChild(fragment) {
            for (const el of [...fragment.children]) {
                fragment.children.splice(fragment.children.indexOf(el), 1);
                this.children.push(el); el.parent = this;
            }
        }};
    const items = ['Zulu', 'Alpha'].map((name, baseIndex) => {
        const el = {name, parent: menu, matches: () => true};
        menu.children.push(el);
        return {el, key: name.toLowerCase(), labelLower: name.toLowerCase(), baseIndex};
    });
    api.setState({sort: 'A → Z'});
    api.reorderMenu(menu, items);
    assert.deepEqual(menu.children.map(el => el.name), ['Alpha', 'Zulu']);
    api.setState({sort: 'Roam native'}); fail = true;
    assert.throws(() => api.reorderMenu(menu, items), /fragment failure/);
    assert.equal(menu.dataset.bcpReordered, '1');
    api.reorderMenu(menu, items);
    assert.deepEqual(menu.children.map(el => el.name), ['Zulu', 'Alpha']);
    assert.equal(menu.dataset.bcpReordered, '0');
});
test('failed decoration restores observation and releases the guard', () => {
    const api = load(), {portal, observer} = menuFixture(api);
    api.setEnsure(() => { throw Error('decoration failure'); });
    assert.throws(() => api.decorateAndApplyPinning(portal), /decoration failure/);
    assert.equal(observer.observing, true);
    assert.equal(api.state().decorateInProgress, false);
});
test('failed reordering releases the guard', () => {
    const api = load(); api.setState({sort: 'A → Z'});
    const el = {dataset: {}, querySelector: () => null, children: [], appendChild() {}};
    assert.throws(() => api.reorderMenu(el, [{el: {}, key: 'a', labelLower: 'a', baseIndex: 0}]), /fragment failure/);
    assert.equal(api.state().reorderInProgress, false);
});
