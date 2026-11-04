// 赛事厂牌 logo 公共模块：主页 / 前台各页 / 管理后台共用。
// 必须在 shared.js / app.js / admin.js 之前加载。
// 精选映射按赛事名关键词匹配本地文件（public/images/tournament/），未命中不显示。

const TOURNAMENT_LOGOS = [
    { file: '/images/tournament/blast-bounty.webp', game: 'cs2', keys: ['blast bounty'] },
    { file: '/images/tournament/blast-open.webp', game: 'cs2', keys: ['blast open'] },
    { file: '/images/tournament/blast-rival.webp', game: 'cs2', keys: ['blast rival'] },
    { file: '/images/tournament/epl.png', game: 'cs2', keys: ['esl pro league', 'epl'] },
    { file: '/images/tournament/xpl.png', game: 'cs2', keys: ['xse pro league', 'xpl'] },
    { file: '/images/tournament/ewc.png', game: 'cs2', keys: ['esports world cup', 'ewc'] },
    { file: '/images/tournament/fissure.webp', game: 'cs2', keys: ['fissure'] },
    { file: '/images/tournament/iem.png', game: 'cs2', keys: ['iem'] },
    { file: '/images/tournament/pgl.webp', game: 'cs2', keys: ['pgl'] },
    { file: '/images/tournament/stake-pulse.png', game: 'cs2', keys: ['stake pulse'] },
    { file: '/images/tournament/stake-ranked.png', game: 'cs2', keys: ['stake ranked'] },
    { file: '/images/tournament/starladder.webp', game: 'cs2', keys: ['starladder', 'star ladder'] },
    { file: '/images/tournament/thunderpick.png', game: 'cs2', keys: ['thunderpick'] },
    { file: '/images/tournament/vct-americas.png', game: 'valorant', keys: ['vct americas'] },
    { file: '/images/tournament/vct-champions.png', game: 'valorant', keys: ['vct champions'] },
    { file: '/images/tournament/vct-cn.png', game: 'valorant', keys: ['vct china', 'vct cn'] },
    { file: '/images/tournament/vct-emea.png', game: 'valorant', keys: ['vct emea'] },
    { file: '/images/tournament/vct-masters.png', game: 'valorant', keys: ['vct masters'] },
    { file: '/images/tournament/vct-pacific.png', game: 'valorant', keys: ['vct pacific'] }
];

function tournamentLogoUrl(name, gameType) {
    const lower = String(name || '').toLowerCase();
    if (!lower) return '';
    // Game Changers 无独立 logo，避免误挂对应赛区的标
    if (lower.includes('game changers')) return '';
    for (const item of TOURNAMENT_LOGOS) {
        if (gameType && item.game !== gameType) continue;
        if (item.keys.some(key => lower.includes(key))) return item.file;
    }
    return '';
}

// logo 优先级：管理员手动上传（/uploads/ 本地文件）> 按名称匹配的精选映射；远端 URL 不使用
// 暗色模式专用 logo 约定：精选映射文件的同目录同名 -dark 变体（如 iem.png -> iem-dark.png）。
// 暗色主题下自动优先使用 -dark 变体（白色版），文件不存在时回退原图 + 浅色底板（style.css）。
const darkVariantMissing = new Set();

function darkVariantPath(file) {
    return String(file).replace(/(\.[^.]+)$/, '-dark$1');
}

function tournamentLogoSrc(src) {
    if (document.documentElement.getAttribute('data-theme') !== 'dark') return src;
    if (!src.startsWith('/images/tournament/')) return src;
    const dark = darkVariantPath(src);
    return darkVariantMissing.has(dark) ? src : dark;
}

function tournamentLogo(name, gameType, logoUrl) {
    const src = (logoUrl && logoUrl.startsWith('/uploads/')) ? logoUrl : tournamentLogoUrl(name, gameType);
    if (!src) return '';
    const use = tournamentLogoSrc(src);
    return `<img class="tournament-logo" src="${use}" data-light="${src}" data-try="${use}" data-variant="${use === src ? 'light' : 'dark'}" alt="" loading="lazy" referrerpolicy="no-referrer" onload="tournamentLogoLoaded(this)" onerror="tournamentLogoError(this)">`;
}

// ===== 深色 logo 暗色模式处理 =====
// 赛事回看页的 logo 可能没有 -dark 变体（尤其是管理员上传的黑色 logo），
// 在暗色底上几乎不可见。这里采样一次亮度与彩度，把深色 logo 分两种处理方式：
//   invert —— 接近黑白的深色 logo：反色后变成浅色字标，保持原有版式；
//   plate  —— 深色但带品牌色的 logo：反色会把红色变浅、蓝色变橙，改为垫浅色底板；
// 已自带亮色元素或整体够亮的 logo 不动。
// 采样结果写入 data-dark-logo，主题切换时直接复用，避免重复绘制。
const DARK_LOGO_LUMINANCE = 110; // 0-255，平均亮度低于该值才可能需要处理
const DARK_LOGO_LIGHT_RATIO = 0.25; // 亮色像素占比达到该值，视为已自带亮色元素
const DARK_LOGO_CHROMA = 0.2; // 平均彩度达到该值，视为带品牌色的 logo

function analyzeTournamentLogo(img) {
    if (!img.naturalWidth || !img.naturalHeight) return '';
    try {
        const size = 32;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        // 等比居中绘制：非正方形 logo（如 EWC 75×15 的长条字标）也能取到真实笔画
        const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
        const width = img.naturalWidth * scale;
        const height = img.naturalHeight * scale;
        ctx.drawImage(img, (size - width) / 2, (size - height) / 2, width, height);
        const { data } = ctx.getImageData(0, 0, size, size);
        let luminance = 0;
        let chroma = 0;
        let lightWeight = 0;
        let weight = 0;
        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i + 3] / 255;
            if (alpha < 0.15) continue; // 透明区域不参与统计
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            // 彩度取绝对差值而非 HSV 饱和度：近黑的深蓝/深灰单像素饱和度接近 1，
            // 但视觉上就是黑色，按饱和度统计会把它们误判成彩色 logo 而漏掉反色。
            chroma += (Math.max(r, g, b) - Math.min(r, g, b)) / 255 * alpha;
            luminance += value * alpha;
            weight += alpha;
            if (value >= 150) lightWeight += alpha;
        }
        if (!weight || lightWeight / weight >= DARK_LOGO_LIGHT_RATIO) return '';
        if (luminance / weight >= DARK_LOGO_LUMINANCE) return '';
        return chroma / weight >= DARK_LOGO_CHROMA ? 'plate' : 'invert';
    } catch (error) {
        return ''; // 跨域或解码失败：保持原样
    }
}

function applyTournamentLogoInvert(img) {
    if (img.dataset.darkLogo === undefined && img.complete && img.naturalWidth) {
        // -dark 变体本身就是给暗色底设计的，不再二次处理
        img.dataset.darkLogo = img.dataset.variant === 'dark' ? '' : analyzeTournamentLogo(img);
    }
    const mode = document.documentElement.getAttribute('data-theme') === 'dark' ? img.dataset.darkLogo : '';
    img.classList.toggle('tournament-logo-invert', mode === 'invert');
    img.classList.toggle('tournament-logo-plate', mode === 'plate');
}

function tournamentLogoLoaded(img) {
    applyTournamentLogoInvert(img);
}
window.tournamentLogoLoaded = tournamentLogoLoaded;

// -dark 变体 404 时回退原图；原图也失败则移除（与旧行为一致）
function tournamentLogoError(img) {
    img.onerror = null;
    const light = img.dataset.light;
    if (img.dataset.try === light) { img.remove(); return; }
    darkVariantMissing.add(img.dataset.try);
    img.dataset.try = light;
    img.dataset.variant = 'light';
    // 换源后重新采样亮度，避免沿用上一张图的判断结果
    delete img.dataset.darkLogo;
    img.classList.remove('tournament-logo-invert', 'tournament-logo-plate');
    img.src = light;
}
window.tournamentLogoError = tournamentLogoError;

// 主题切换后（theme.js 派发 theme-changed）给已渲染的赛事 logo 即时换源
function applyTournamentLogoTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.querySelectorAll('img.tournament-logo[data-light]').forEach(img => {
        const light = img.dataset.light;
        const darkPath = darkVariantPath(light);
        const want = dark && light.startsWith('/images/tournament/') && !darkVariantMissing.has(darkPath) ? darkPath : light;
        if (want !== img.dataset.try) {
            img.onerror = tournamentLogoError;
            img.dataset.try = want;
            img.dataset.variant = want === light ? 'light' : 'dark';
            // 换源后亮度可能完全不同（如 -dark 白色变体），需重新采样
            delete img.dataset.darkLogo;
            img.classList.remove('tournament-logo-invert', 'tournament-logo-plate');
            img.src = want;
        }
        applyTournamentLogoInvert(img);
    });
    applyTeamLogoTheme(dark);
}
window.addEventListener('theme-changed', applyTournamentLogoTheme);

// ===== 队标暗色变体（PandaScore dark_mode_image_url）=====
// img 由各页面的 logo()/logoHtml() 渲染，带 data-light/data-dark（均为代理 URL）。
// 暗色失败回退亮色，亮色也失败显示占位（与旧行为一致）。
function teamLogoError(img) {
    img.onerror = null;
    if (img.dataset.try === 'dark' && img.dataset.light) {
        img.dataset.try = 'light';
        img.dataset.variant = 'light';
        img.src = img.dataset.light;
        return;
    }
    img.replaceWith(Object.assign(document.createElement('div'), { className: 'placeholder', textContent: 'TEAM' }));
}
window.teamLogoError = teamLogoError;

function applyTeamLogoTheme(dark) {
    document.querySelectorAll('img[data-team-logo][data-dark]').forEach(img => {
        if (!img.dataset.dark) return;
        const next = dark ? img.dataset.dark : (img.dataset.light || img.dataset.dark);
        img.dataset.try = dark ? 'dark' : 'light';
        img.dataset.variant = dark ? 'dark' : 'light';
        img.onerror = teamLogoError;
        img.src = next;
    });
}

window.tournamentLogoUrl = tournamentLogoUrl;
window.tournamentLogo = tournamentLogo;
