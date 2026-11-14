// Website-styled report images: drive the Edge that ships with Windows over the DevTools protocol.
// No npm packages: Node 22+'s global WebSocket + fetch. Edge is started per image and closed afterwards
// so it only holds memory for the few seconds a render takes.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

// Bracket screenshots lay the stage out this wide so the site never auto-collapses round columns.
const LAYOUT_WIDTH = 2400;

const EDGE_PATHS = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe')
].filter(Boolean);

function findEdge(configured) {
    const found = [configured, ...EDGE_PATHS].filter(Boolean).find(file => fs.existsSync(file));
    if (!found) throw new Error('未找到 Microsoft Edge（可在 config.json 设置 edgePath）');
    return found;
}

async function waitFor(check, ms, what) {
    const until = Date.now() + ms;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > until) throw new Error(`等待${what}超时`);
        await sleep(150);
    }
}

function connect(url) {
    const socket = new WebSocket(url);
    const pending = new Map(), listeners = new Set();
    let next = 0;
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            const { resolve, reject } = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) reject(new Error(`${message.error.message}`)); else resolve(message.result);
        } else if (message.method) for (const listener of listeners) listener(message);
    });
    const failAll = error => { for (const { reject } of pending.values()) reject(error); pending.clear(); };
    socket.addEventListener('close', () => failAll(new Error('Edge 连接已关闭')));
    return new Promise((resolve, reject) => {
        socket.addEventListener('error', () => reject(new Error('无法连接 Edge 调试端口')), { once: true });
        socket.addEventListener('open', () => resolve({
            send(method, params = {}) {
                const id = ++next;
                socket.send(JSON.stringify({ id, method, params }));
                return new Promise((ok, fail) => pending.set(id, { resolve: ok, reject: fail }));
            },
            once(method, ms) {
                return new Promise((ok, fail) => {
                    const timer = setTimeout(() => { listeners.delete(listener); fail(new Error(`等待 ${method} 超时`)); }, ms);
                    const listener = message => { if (message.method === method) { clearTimeout(timer); listeners.delete(listener); ok(message.params); } };
                    listeners.add(listener);
                });
            },
            close() { try { socket.close(); } catch { /* already closed */ } }
        }), { once: true });
    });
}

// A fresh profile per launch: a lingering Edge from the previous image can never hand the new launch
// over to itself. Leftovers that were still locked last time are removed on the next run.
function freshProfile(root) {
    fs.mkdirSync(root, { recursive: true });
    for (const name of fs.readdirSync(root)) {
        try { fs.rmSync(path.join(root, name), { recursive: true, force: true, maxRetries: 2 }); } catch { /* still locked */ }
    }
    return fs.mkdtempSync(path.join(root, 'run-'));
}

async function withPage(config, profileRoot, task) {
    if (typeof WebSocket !== 'function') throw new Error('网站风格图片需要 Node.js 22+（当前版本缺少内置 WebSocket）');
    const profileDir = freshProfile(profileRoot);
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    const edge = spawn(findEdge(config.edgePath), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-background-networking', '--disable-sync', '--hide-scrollbars', '--mute-audio',
        '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profileDir}`, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
    let exited = false;
    edge.once('exit', () => { exited = true; });
    let client;
    try {
        const port = await waitFor(() => {
            if (exited) throw new Error('Edge 启动后立即退出');
            try { return fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]; } catch { return null; }
        }, 20000, ' Edge 启动');
        const target = await waitFor(async () => {
            const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
            return list.find(item => item.type === 'page');
        }, 10000, ' Edge 页面');
        client = await connect(target.webSocketDebuggerUrl);
        await client.send('Page.enable');
        await client.send('Runtime.enable');
        // Light theme and a fixed 2x scale so text stays crisp after QQ compresses the image.
        await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
        // The site formats times in the browser's zone; reports are Beijing time whatever this machine is set to.
        await client.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
        return await task(client);
    } finally {
        if (client) { await client.send('Browser.close').catch(() => {}); client.close(); }
        await Promise.race([new Promise(resolve => edge.once('exit', resolve)), sleep(5000)]);
        if (!exited) edge.kill();
        await sleep(300);
        try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* removed next run */ }
    }
}

async function evaluate(client, expression) {
    const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`页面脚本错误：${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`.slice(0, 300));
    return result.result.value;
}

async function open(client, url, width, height) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
    const loaded = client.once('Page.loadEventFired', 30000);
    loaded.catch(() => {}); // A failed navigation throws below; this wait must not become an unhandled rejection.
    const navigation = await client.send('Page.navigate', { url });
    if (navigation.errorText) throw new Error(`打开 ${url} 失败：${navigation.errorText}`);
    await loaded;
}

// Grow the viewport until it covers the crop, re-measure, then capture inside the viewport.
// (captureBeyondViewport resizes the page mid-capture, which makes the site re-render.)
async function capture(client, measure, outFile, minWidth) {
    let rect = await evaluate(client, measure);
    for (let pass = 0; pass < 3; pass++) {
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) throw new Error('页面没有可截取的内容');
        const width = Math.max(minWidth, Math.ceil(rect.x + rect.width)), height = Math.ceil(rect.y + rect.height);
        await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
        await sleep(300);
        const again = await evaluate(client, measure);
        const stable = ['x', 'y', 'width', 'height'].every(key => Math.abs(again[key] - rect[key]) < 1);
        rect = again;
        if (stable) break;
    }
    const shot = await client.send('Page.captureScreenshot', { format: 'png',
        clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height), scale: 1 } });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
    return outFile;
}

// Daily / weekly report: public/bot-report.html styled by the site's own CSS and fonts.
function screenshotCard(config, profileDir, card, outFile) {
    return withPage(config, profileDir, async client => {
        await open(client, `${config.siteUrl}/bot-report.html`, 720, 1200);
        await waitFor(() => evaluate(client, 'typeof window.renderReport === "function"'), 10000, '报告页面脚本');
        await evaluate(client, `window.renderReport(${JSON.stringify(card)})`);
        const measure = '(() => { const r = document.getElementById("report").getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()';
        return capture(client, measure, outFile, 720);
    });
}

// Header colours per game: CS2 blue, Valorant red, LoL gold.
const THEMES = {
    cs2: { head: '#16263a', accent: '#3d8bd9', sub: '#b6c6d8' },
    valorant: { head: '#2b1519', accent: '#ff4655', sub: '#d9b9bd' },
    lol: { head: '#1e1b12', accent: '#c89b3c', sub: '#d8cdb4' }
};
const theme = name => THEMES[name] || THEMES.cs2;

// Runs inside the real tournament page: isolate every stage that holds one of the given matches
// (a group stage that ended yesterday + playoffs starting today end up in one image), mark yesterday's
// and today's matches, and return the crop rectangle. The bracket keeps the site's own code and CSS.
const ISOLATE_STAGE = `async (spec, colors) => {
    const wait = async (check, ms) => { const end = Date.now() + ms; for (;;) { const v = check(); if (v) return v; if (Date.now() > end) return null; await new Promise(r => setTimeout(r, 150)); } };
    if (!await wait(() => document.querySelector('.ar-focus-stages'), 20000)) throw new Error('赛事页面未加载');
    const ids = spec.matchIds.map(Number);
    const card = (root, id) => root.querySelector('[data-match-id="' + id + '"]') || root.querySelector('#match-row-' + id) || root.querySelector('[onclick*="focusTournamentMatch(' + id + ')"]');
    const stages = [...document.querySelectorAll('.tournament-stage-block')].filter(stage => ids.some(id => card(stage, id)));
    if (!stages.length) throw new Error('赛事页面中找不到这些比赛');
    const views = stages.map(stage => stage.querySelector('[data-bracket-view]'));
    if (views.some(view => !view)) throw new Error('该阶段没有赛程图');
    for (const stage of stages) stage.open = true;
    // tournaments.js re-renders the whole detail page on some resizes; that would undo the isolation below.
    if (typeof state === 'object' && state) state.activeTournamentData = null;
    // Keep only the paths from <body> to each bracket view; lift max-width so the site lays every round
    // out at full width instead of auto-collapsing columns.
    const keep = new Set();
    for (const view of views) for (let node = view; node && node !== document.documentElement; node = node.parentElement) keep.add(node);
    for (const node of keep) {
        for (const sibling of node.parentElement ? node.parentElement.children : []) if (!keep.has(sibling)) sibling.style.display = 'none';
        for (const [name, value] of [['max-width', 'none'], ['width', '${LAYOUT_WIDTH}px'], ['margin', '0'], ['overflow', 'visible']]) node.style.setProperty(name, value, 'important');
        if (!views.includes(node)) { node.style.setProperty('padding', '0', 'important'); node.style.setProperty('border', '0', 'important'); }
    }
    // Swiss grids stretch to whatever width they get (tiny text in a wide image); they need no collapse guard.
    for (const view of views) if (view.querySelector('.sw2-match') && !view.querySelector('.de-card, .pb2-card')) view.style.setProperty('width', '1320px', 'important');
    const style = document.createElement('style');
    style.textContent = 'html,body{background:var(--surface-input)!important;margin:0!important;padding:0!important}'
        + '.bracket-toolbar,.bracket-overflow-hint{display:none!important}.pb2-title[role="button"]::after{content:none!important}'
        + '[data-bracket-view]{border:0!important;border-radius:0!important;box-shadow:none!important}'
        + '.bracket-scroll-shell,.bracket-viewport{overflow:visible!important}'
        + '.brx-head{display:flex;align-items:center;justify-content:space-between;gap:24px;box-sizing:border-box;padding:16px 22px 14px;background:' + colors.head + ';border-bottom:4px solid ' + colors.accent + ';color:#f5f7fa;font-family:MiSans,"Microsoft YaHei",sans-serif}'
        + '.brx-head b{display:block;font-size:26px;line-height:1.2}.brx-head small{display:block;margin-top:4px;color:' + colors.sub + ';font-size:15px;font-weight:500}'
        + '.brx-head>img{height:34px;flex:none}.brx-title{display:flex;align-items:center;gap:14px;min-width:0}'
        + '.brx-mark{width:56px;height:56px;flex:none;box-sizing:border-box;padding:6px;border-radius:4px;background:#fff;object-fit:contain}.brx-legend{display:flex;gap:16px;margin-top:8px;color:#f5f7fa;font-size:14px;font-weight:600}'
        + '.brx-legend>span{display:inline-flex;align-items:center;gap:6px}.brx-legend .brx-chip{position:static;font-size:12px;line-height:18px;padding:0 6px;font-style:normal}'
        + '.brx-stage{box-sizing:border-box;margin-top:6px;padding:10px 22px 0;color:var(--text-heading);font:700 17px/1.3 MiSans,"Microsoft YaHei",sans-serif}'
        + '.brx-stage::before{content:"";display:inline-block;width:4px;height:16px;margin-right:8px;vertical-align:-2px;background:' + colors.accent + '}'
        // Same small chip the site puts above upcoming cards: muted for yesterday, game colour for today.
        + '.brx-chip{position:absolute;left:0;bottom:calc(100% + 2px);z-index:2;padding:0 5px;border-radius:2px;font:700 10px/14px MiSans,"Microsoft YaHei",sans-serif;white-space:nowrap;pointer-events:none}'
        + '.brx-chip.y{background:#e3e8ee;color:#4f5f70}.brx-chip.t{background:' + colors.accent + ';color:#fff}'
        + '.brx-dim [data-match-id]:not(.brx-y):not(.brx-t){opacity:.4;filter:grayscale(.6)}';
    document.head.appendChild(style);
    const chip = (cls, text) => { const tag = document.createElement('span'); tag.className = 'brx-chip ' + cls; tag.textContent = text; return tag; };
    const mark = (list, cls, text) => {
        for (const id of list || []) for (const view of views) {
            const node = view.querySelector('[data-match-id="' + Number(id) + '"]');
            if (!node) continue;
            node.classList.add('brx-' + cls);
            // A card that already carries the site's own chip (start time / LIVE / 赛果待更新) keeps only that one.
            const slot = node.parentElement;
            if ([...slot.children].some(child => child.classList.contains('bracket-chip'))) continue;
            // Cards clip their overflow, so the chip sits in the card's parent, just above the card.
            if (getComputedStyle(slot).position === 'static') slot.style.position = 'relative';
            const tag = chip(cls, text);
            // Packed layouts (Swiss columns) have no gap above the card: tuck the chip inside its left edge.
            const box = node.getBoundingClientRect(), above = node.previousElementSibling, below = node.nextElementSibling;
            const room = Math.min(above ? box.top - above.getBoundingClientRect().bottom : 99, below ? below.getBoundingClientRect().top - box.bottom : 99);
            if (room < 16) {
                // Keep the card's own border (the site draws it with box-shadow) and add the bar on top.
                const own = getComputedStyle(node).boxShadow;
                node.style.setProperty('box-shadow', 'inset 4px 0 0 ' + (cls === 'y' ? '#9aa8b6' : colors.accent) + (own && own !== 'none' ? ', ' + own : ''), 'important');
                continue;
            }
            // Centred above the card, like the site's start-time chips.
            tag.style.left = (node.offsetLeft + node.offsetWidth / 2) + 'px';
            tag.style.transform = 'translateX(-50%)';
            tag.style.top = (node.offsetTop - 16) + 'px';
            tag.style.bottom = 'auto';
            slot.appendChild(tag);
        }
    };
    mark(spec.yesterday, 'y', '昨日');
    mark(spec.today, 't', '今日');
    const highlighted = (spec.yesterday || []).length + (spec.today || []).length > 0;
    if (highlighted) for (const view of views) view.classList.add('brx-dim');
    const head = document.createElement('div');
    head.className = 'brx-head brx-band';
    head.innerHTML = '<div class="brx-title"><div class="brx-text"><b></b><small></small></div></div><img src="/images/prpicklogo-light.png" alt="">';
    head.querySelector('b').textContent = spec.caption[0] || '';
    head.querySelector('small').textContent = spec.caption[1] || '';
    // Tournament logo beside its name: admin upload first, then the site's curated mapping.
    const brand = spec.brand || {};
    const logo = brand.logo || (typeof tournamentLogoUrl === 'function' ? tournamentLogoUrl(brand.fullName || brand.name, brand.game) : '');
    if (logo) {
        const mark = document.createElement('img');
        mark.className = 'brx-mark';
        mark.alt = '';
        mark.referrerPolicy = 'no-referrer';
        mark.addEventListener('error', () => mark.remove(), { once: true });
        mark.src = logo;
        head.firstChild.prepend(mark);
    }
    if (highlighted) {
        const legend = document.createElement('span');
        legend.className = 'brx-legend';
        legend.innerHTML = ((spec.yesterday || []).length ? '<span><i class="brx-chip y">昨日</i>赛果</span>' : '') + ((spec.today || []).length ? '<span><i class="brx-chip t">今日</i>赛程</span>' : '');
        head.querySelector('.brx-text').appendChild(legend);
    }
    views[0].parentElement.insertBefore(head, views[0]);
    // Several stages: name each one above its bracket.
    if (views.length > 1) views.forEach((view, i) => {
        const label = document.createElement('div');
        label.className = 'brx-stage brx-band';
        const title = stages[i].querySelector('.tournament-stage-head h3') || stages[i].querySelector('summary');
        label.textContent = title ? title.textContent.trim() : '';
        view.parentElement.insertBefore(label, view);
    });
    for (const image of document.querySelectorAll('img')) image.loading = 'eager';
    await document.fonts.ready;
    const images = [...head.querySelectorAll('img'), ...views.flatMap(view => [...view.querySelectorAll('img')])];
    await Promise.race([Promise.all(images.map(img => img.complete ? 0 : new Promise(r => { img.onload = img.onerror = r; }))), new Promise(r => setTimeout(r, 8000))]);
    // bracket-ui re-lays out (and un-collapses columns) on its ResizeObserver; give it a few frames.
    await new Promise(r => setTimeout(r, 400));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return window.__bracketBox();
}`;

// The brackets are laid out on a wide canvas (and may be centred in it): crop to the union of their cards,
// titles and lines, and stretch the header / stage labels over exactly that crop.
const BRACKET_BOX = `window.__bracketBox = () => {
    const bands = [...document.querySelectorAll('.brx-band')];
    const views = [...document.querySelectorAll('[data-bracket-view]')].filter(view => view.offsetParent !== null);
    let left = Infinity, right = -Infinity, bottom = -Infinity;
    for (const view of views) {
        const limit = view.getBoundingClientRect().width * 0.8;
        for (const node of view.querySelectorAll('*')) {
            const r = node.getBoundingClientRect();
            if (!r.width || !r.height || r.width > limit || getComputedStyle(node).visibility === 'hidden') continue;
            left = Math.min(left, r.left); right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
        }
    }
    if (!Number.isFinite(left) || !bands.length) throw new Error('赛程图为空');
    const pad = 24, x = Math.max(0, left - pad), width = Math.max(right - left + 2 * pad, 760);
    for (const band of bands) {
        band.style.marginLeft = (x - band.parentElement.getBoundingClientRect().left) + 'px';
        band.style.width = width + 'px';
    }
    const top = bands[0].getBoundingClientRect().top;
    return { x: x + scrollX, y: top + scrollY, width, height: bottom + pad - top };
}`;

// Tournament bracket from tournaments.html: round-finished posts and the per-tournament daily image.
function screenshotBracket(config, profileDir, spec, outFile) {
    return withPage(config, profileDir, async client => {
        const url = `${config.siteUrl}/tournaments.html?tournament=${encodeURIComponent(spec.tournamentId)}`;
        // A wide desktop viewport keeps every round expanded instead of auto-collapsing columns.
        await open(client, url, 1600, 1400);
        await evaluate(client, BRACKET_BOX);
        await evaluate(client, `(${ISOLATE_STAGE})(${JSON.stringify(spec)}, ${JSON.stringify(theme(spec.theme))})`);
        return capture(client, 'window.__bracketBox()', outFile, 1600);
    });
}

module.exports = { findEdge, screenshotCard, screenshotBracket };
