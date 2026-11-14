// LoL 英雄 / 装备素材（Riot Data Dragon）：GRID 给的是英文名，这里映射成 Data Dragon id、中文名和定位标签。
//
// 索引（几十 KB）缓存在 data/lol-cache/index.json，每 24 小时最多刷新一次；拉取失败时继续用旧缓存。
// 图片由 /api/images/lol/... 代理并落盘缓存，用户浏览器不直连国外 CDN。
// LOL_DDRAGON_BASE 可改成国内镜像（路径结构需与官方一致）。
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'lol-cache');
const INDEX_FILE = path.join(CACHE_DIR, 'index.json');
const REFRESH_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 20000;

let index = null;
let loading = null;

const baseUrl = () => (process.env.LOL_DDRAGON_BASE || 'https://ddragon.leagueoflegends.com').replace(/\/+$/, '');
// "K'Sante" / "Dr. Mundo" / "Nunu & Willump" → ksante / drmundo / nunuwillump
const normalizeName = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Data Dragon HTTP ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

// Data Dragon 原始数据 → 精简索引（纯函数，便于单测）
function buildIndex(version, championsEn, championsZh, itemsEn, itemsZh) {
    const champions = {};
    for (const [id, champion] of Object.entries(championsEn || {})) {
        const zh = championsZh?.[id];
        // 中文数据里 name 是称号（九尾妖狐），title 才是常用名（阿狸）
        champions[id] = { id, en: champion.name, zh: zh?.title || zh?.name || champion.name, epithet: zh?.name || null, tags: champion.tags || [] };
    }
    const items = {};
    for (const [id, item] of Object.entries(itemsEn || {})) {
        // 同名装备有竞技场 / 大乱斗等变体：只收召唤师峡谷（地图 11）可用的那件
        if (item?.maps && item.maps['11'] === false) continue;
        const key = normalizeName(item.name);
        if (!key || items[key]) continue;
        items[key] = { id, en: item.name, zh: itemsZh?.[id]?.name || item.name };
    }
    const championKeys = {};
    for (const champion of Object.values(champions)) {
        championKeys[normalizeName(champion.en)] = champion.id;
        championKeys[normalizeName(champion.id)] = champion.id;
    }
    return { version, fetched_at: new Date().toISOString(), champions, championKeys, items };
}

function readCache() {
    try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { return null; }
}

function writeCache(data) {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const temp = `${INDEX_FILE}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(data));
        fs.renameSync(temp, INDEX_FILE);
    } catch {
        // 写盘失败只影响下次启动，不影响本次
    }
}

async function refresh() {
    const base = baseUrl();
    const [version] = await getJson(`${base}/api/versions.json`);
    const cdn = `${base}/cdn/${version}/data`;
    const [championsEn, championsZh, itemsEn, itemsZh] = await Promise.all([
        getJson(`${cdn}/en_US/champion.json`), getJson(`${cdn}/zh_CN/champion.json`),
        getJson(`${cdn}/en_US/item.json`), getJson(`${cdn}/zh_CN/item.json`)
    ]);
    return buildIndex(version, championsEn.data, championsZh.data, itemsEn.data, itemsZh.data);
}

// 返回索引；过期时后台刷新，没有任何缓存时等待首次拉取（失败返回 null）
async function getLolAssets() {
    if (!index) index = readCache();
    const stale = !index || Date.now() - Date.parse(index.fetched_at || 0) > REFRESH_MS;
    if (stale && !loading) {
        loading = refresh()
            .then(fresh => { index = fresh; writeCache(fresh); return fresh; })
            .catch(error => { console.warn('[LoL 素材] Data Dragon 拉取失败:', error.message); return index; })
            .finally(() => { loading = null; });
    }
    if (!index && loading) return loading;
    return index;
}

function championId(assets, name) {
    return assets?.championKeys?.[normalizeName(name)] || null;
}

function itemId(assets, name) {
    return assets?.items?.[normalizeName(name)]?.id || null;
}

// 前端用的精简版：英文名（GRID 写法）→ { id, zh, tags }；装备英文名 → { id, zh }
function publicAssets(assets) {
    if (!assets) return null;
    const champions = {};
    for (const champion of Object.values(assets.champions)) champions[normalizeName(champion.en)] = { id: champion.id, zh: champion.zh, tags: champion.tags };
    const items = {};
    for (const [key, item] of Object.entries(assets.items)) items[key] = { id: item.id, zh: item.zh };
    return { version: assets.version, champions, items };
}

function imageUrl(assets, kind, id) {
    if (!assets?.version || !/^[A-Za-z0-9]+$/.test(String(id))) return null;
    const folder = kind === 'champion' ? 'champion' : kind === 'item' ? 'item' : null;
    if (!folder) return null;
    if (folder === 'champion' && !assets.champions[id]) return null;
    if (folder === 'item' && !Object.values(assets.items).some(item => item.id === String(id))) return null;
    return `${baseUrl()}/cdn/${assets.version}/img/${folder}/${id}.png`;
}

module.exports = { getLolAssets, buildIndex, publicAssets, championId, itemId, imageUrl, normalizeName };
