// 竞猜分享卡 v2：1080×1350（4:5 竖版，适配朋友圈 / QQ 空间 / 微博信息流）canvas 合成。
//
// 视觉：沿用站内 HLTV 式深海军蓝扁平皮肤，分享图固定深色（不随站点主题切换），保证传播出去的观感一致。
//   0-128      顶栏：PRBET 字标 + 游戏 / 赛制标签
//   128-300    赛事信息：赛事 logo + 赛事名 + 阶段 + 开赛时间
//   300-760    对阵英雄区：双方队标（队伍主色光晕）+ 队名，中央 VS 或实际比分，所选队伍金色描边与「我的选择」角标
//   780-1060   预测面板：我的预测比分（大号数字）+ 右侧结果印章（完美命中 / 猜中胜者 / 未命中 / 待结算 / 弃权）
//   1060-1140  预测人：头像字母 + 用户名 + 累计积分
//   1160-1350  底栏：引导文案 + 站点地址 + 二维码（指向对应赛事回看页）
//
// 数据入口：宿主页提供 window.getMatchForShare(matchId) / window.getShareContext()。
(function () {
    const W = 1080;
    const H = 1350;
    const PAD = 64;
    const SITE_URL = 'https://prbet.gekichumai.cn';
    const SITE_LABEL = 'prbet.gekichumai.cn';
    const FONT_FAMILY = 'MiSans, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

    const C = {
        bg0: '#0b121b',
        bg1: '#111c29',
        panel: 'rgba(255,255,255,0.035)',
        panelBorder: 'rgba(255,255,255,0.08)',
        line: 'rgba(255,255,255,0.08)',
        text: '#eef3f8',
        textDim: '#9fb0c3',
        textFaint: '#5f7287',
        brand: '#3d8fd6',
        brandSoft: '#5a8fc1',
        gold: '#f2b632',
        green: '#3ccf7d',
        blue: '#5aa7ea',
        red: '#f06464',
        amber: '#f0a640'
    };

    // 结果档位：exact 完美命中（比分全中）/ winner 猜中胜者 / miss 未命中 / pending 等待 / forfeit 弃权
    const OUTCOME = {
        exact: { color: C.green, title: '完美命中', sub: '比分全中' },
        winner: { color: C.blue, title: '猜中胜者', sub: '胜者正确' },
        miss: { color: C.red, title: '未命中', sub: '下次再战' },
        forfeit: { color: C.amber, title: '弃权', sub: '本场不计分' },
        upcoming: { color: C.brandSoft, title: '等待开赛', sub: '预测已锁定' },
        live: { color: C.red, title: '比赛进行中', sub: '静候结果' },
        settling: { color: C.amber, title: '等待结算', sub: '比赛已结束' }
    };

    let fontsReady = false;
    let currentMatch = null;
    let currentBlob = null;

    // ---------- 资源加载 ----------

    function mapWeight(w) { return w >= 600 ? 700 : 500; }

    async function loadFonts() {
        if (fontsReady) return;
        const faces = [
            { file: 'MiSans-Medium.woff2', weight: '500' },
            { file: 'MiSans-Bold.woff2', weight: '700' }
        ];
        await Promise.all(faces.map(async ({ file, weight }) => {
            try {
                const face = new FontFace('MiSans', `url(/fonts/${file})`, { weight });
                await face.load();
                document.fonts.add(face);
            } catch (e) { /* 回退系统字体 */ }
        }));
        fontsReady = true;
    }

    function loadImage(src) {
        return new Promise(resolve => {
            if (!src) return resolve(null);
            const img = new Image();
            img.decoding = 'async';
            img.onload = () => resolve(img.naturalWidth ? img : null);
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }

    async function loadFirst(...sources) {
        for (const src of sources) {
            const img = await loadImage(src);
            if (img) return img;
        }
        return null;
    }

    function proxiedLogo(url) {
        if (!url) return '';
        if (/^\/(?!\/)/.test(url) || url.startsWith('data:')) return url;
        return typeof window.proxiedLogoUrl === 'function' ? window.proxiedLogoUrl(url) : `/api/images/team-logo?url=${encodeURIComponent(url)}`;
    }

    // ---------- 图像分析：主色提取 / 黑白 logo 反色 ----------

    // 采样 logo：返回主色（饱和像素的加权平均）与是否为「深色黑白」logo（深底上需要反色）
    function analyzeLogo(img) {
        const result = { color: null, darkMono: false, darkHeavy: false };
        if (!img) return result;
        try {
            const S = 40;
            const cv = document.createElement('canvas');
            cv.width = S; cv.height = S;
            const cx = cv.getContext('2d', { willReadFrequently: true });
            const ratio = Math.min(S / img.width, S / img.height);
            cx.drawImage(img, (S - img.width * ratio) / 2, (S - img.height * ratio) / 2, img.width * ratio, img.height * ratio);
            const data = cx.getImageData(0, 0, S, S).data;
            let opaque = 0, lumSum = 0, light = 0, colored = 0, dark = 0;
            let rw = 0, gw = 0, bw = 0, wsum = 0;
            for (let i = 0; i < data.length; i += 4) {
                const a = data[i + 3] / 255;
                if (a < 0.4) continue;
                const r = data[i], g = data[i + 1], b = data[i + 2];
                const max = Math.max(r, g, b), min = Math.min(r, g, b);
                const sat = max === 0 ? 0 : (max - min) / max;
                const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                opaque++;
                lumSum += lum;
                if (lum > 170) light++;
                if (lum < 70) dark++;
                if (sat >= 0.25 && max > 40) {
                    colored++;
                    const w = sat * sat * a;
                    rw += r * w; gw += g * w; bw += b * w; wsum += w;
                }
            }
            if (!opaque) return result;
            if (wsum > 0 && colored / opaque > 0.06) {
                result.color = [rw / wsum, gw / wsum, bw / wsum].map(v => Math.round(v));
            }
            result.darkMono = lumSum / opaque < 96 && light / opaque < 0.15 && colored / opaque < 0.5;
            // 大面积深色但带亮部/彩色（如 FURIA 黑豹）：不反色，改为在浅色底板上绘制
            result.darkHeavy = !result.darkMono && dark / opaque > 0.35;
        } catch (e) { /* 跨域污染等：放弃分析 */ }
        return result;
    }

    // 深色黑白 logo：逐像素反色（不用 ctx.filter，Safari 不支持）
    function invertedCopy(img) {
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth || img.width;
        cv.height = img.naturalHeight || img.height;
        const cx = cv.getContext('2d');
        cx.drawImage(img, 0, 0);
        try {
            const d = cx.getImageData(0, 0, cv.width, cv.height);
            for (let i = 0; i < d.data.length; i += 4) {
                d.data[i] = 255 - d.data[i];
                d.data[i + 1] = 255 - d.data[i + 1];
                d.data[i + 2] = 255 - d.data[i + 2];
            }
            cx.putImageData(d, 0, 0);
        } catch (e) { return img; }
        return cv;
    }

    // 把主色调到适合深底光晕的亮度/饱和度
    function glowColor(rgb, fallback) {
        if (!rgb) return fallback;
        let [r, g, b] = rgb.map(v => v / 255);
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0, s = 0;
        const l = (max + min) / 2;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
        }
        return `hsl(${Math.round(h)}, ${Math.round(Math.max(0.55, Math.min(s, 0.85)) * 100)}%, 56%)`;
    }

    function withAlpha(color, alpha) {
        if (color.startsWith('hsl(')) return color.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
        const hex = color.replace('#', '');
        const n = parseInt(hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex, 16);
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }

    // ---------- 绘图工具 ----------

    function font(weight, size) {
        return `${mapWeight(weight)} ${size}px ${FONT_FAMILY}`;
    }

    function roundRect(ctx, x, y, w, h, r) {
        const rr = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    }

    function fitText(ctx, str, maxWidth) {
        let s = String(str ?? '');
        if (ctx.measureText(s).width <= maxWidth) return s;
        while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
        return s + '…';
    }

    // 在 maxWidth 内绘制文字：先逐级缩小字号（不低于 minSize），仍放不下再省略
    function text(ctx, str, x, y, { weight = 500, size = 32, color = C.text, align = 'left', maxWidth = 0, minSize = 0, baseline = 'middle', spacing = 0 } = {}) {
        let s = String(str ?? '');
        let fs = size;
        ctx.font = font(weight, fs);
        if (maxWidth && minSize) {
            while (fs > minSize && ctx.measureText(s).width > maxWidth) {
                fs -= 2;
                ctx.font = font(weight, fs);
            }
        }
        if (maxWidth) s = fitText(ctx, s, maxWidth);
        ctx.fillStyle = color;
        ctx.textAlign = align;
        ctx.textBaseline = baseline;
        if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
        ctx.fillText(s, x, y);
        if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
        return ctx.measureText(s).width + (spacing ? spacing * s.length : 0);
    }

    function measure(ctx, str, weight, size, spacing = 0) {
        ctx.font = font(weight, size);
        return ctx.measureText(String(str ?? '')).width + spacing * String(str ?? '').length;
    }

    function pill(ctx, label, x, y, { size = 24, color = C.textDim, bg = 'rgba(255,255,255,0.06)', border = 'rgba(255,255,255,0.12)', padX = 16, h = 44, align = 'left', weight = 700 } = {}) {
        const w = measure(ctx, label, weight, size) + padX * 2;
        const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
        roundRect(ctx, left, y - h / 2, w, h, 8);
        ctx.fillStyle = bg;
        ctx.fill();
        if (border) {
            ctx.strokeStyle = border;
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        text(ctx, label, left + w / 2, y + 1, { weight, size, color, align: 'center' });
        return w;
    }

    function drawContain(ctx, img, cx, cy, size) {
        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;
        const ratio = Math.min(size / iw, size / ih);
        const w = iw * ratio, h = ih * ratio;
        ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
        return { w, h };
    }

    // ---------- 背景 ----------

    function drawBackground(ctx, glow1, glow2) {
        const base = ctx.createLinearGradient(0, 0, 0, H);
        base.addColorStop(0, C.bg1);
        base.addColorStop(1, C.bg0);
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, W, H);

        // 双方队伍主色光晕（对阵区左右两侧）
        const glow = (x, y, r, color) => {
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            g.addColorStop(0, withAlpha(color, 0.30));
            g.addColorStop(0.55, withAlpha(color, 0.08));
            g.addColorStop(1, withAlpha(color, 0));
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);
        };
        glow(210, 500, 480, glow1);
        glow(W - 210, 500, 480, glow2);

        // 斜向细纹理（HLTV 式数据面板质感）
        ctx.save();
        ctx.globalAlpha = 0.035;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        for (let x = -H; x < W; x += 28) {
            ctx.beginPath();
            ctx.moveTo(x, H);
            ctx.lineTo(x + H, 0);
            ctx.stroke();
        }
        ctx.restore();

        // 顶部品牌色条 + 底部暗角
        const bar = ctx.createLinearGradient(0, 0, W, 0);
        bar.addColorStop(0, withAlpha(glow1, 0.95));
        bar.addColorStop(0.5, C.brand);
        bar.addColorStop(1, withAlpha(glow2, 0.95));
        ctx.fillStyle = bar;
        ctx.fillRect(0, 0, W, 8);
    }

    // ---------- 顶栏 ----------

    function drawHeader(ctx, match, brandImg) {
        const cy = 72;
        if (brandImg) {
            const h = 50;
            const w = (brandImg.naturalWidth || brandImg.width) * (h / (brandImg.naturalHeight || brandImg.height));
            ctx.drawImage(brandImg, PAD, cy - h / 2, w, h);
        } else {
            text(ctx, 'PRBET', PAD, cy, { weight: 700, size: 48, color: C.text });
        }
        let x = W - PAD;
        const format = String(match.format || '').toUpperCase();
        if (format) x -= pill(ctx, format, x, cy, { align: 'right', size: 24 }) + 12;
        const game = match.game_type === 'valorant' ? 'VALORANT' : match.game_type === 'cs2' ? 'CS2' : '';
        if (game) {
            const isVal = match.game_type === 'valorant';
            pill(ctx, game, x, cy, {
                align: 'right', size: 24,
                color: isVal ? '#ff8a96' : '#f2c46b',
                bg: isVal ? 'rgba(255,70,85,0.12)' : 'rgba(242,182,50,0.10)',
                border: isVal ? 'rgba(255,70,85,0.35)' : 'rgba(242,182,50,0.32)'
            });
        }
        ctx.fillStyle = C.line;
        ctx.fillRect(PAD, 128, W - PAD * 2, 2);
    }

    // ---------- 赛事信息 ----------

    function formatMatchTime(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        const p = n => String(n).padStart(2, '0');
        const now = new Date();
        const year = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}-`;
        const week = '日一二三四五六'[date.getDay()];
        return `${year}${p(date.getMonth() + 1)}-${p(date.getDate())} 周${week} ${p(date.getHours())}:${p(date.getMinutes())}`;
    }

    function drawTournament(ctx, match, tourLogo) {
        const top = 168;
        let x = PAD;
        if (tourLogo) {
            const size = 88;
            roundRect(ctx, x, top, size, size, 16);
            ctx.fillStyle = 'rgba(255,255,255,0.05)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.10)';
            ctx.lineWidth = 2;
            ctx.stroke();
            drawContain(ctx, tourLogo, x + size / 2, top + size / 2, size - 22);
            x += size + 24;
        }
        const maxW = W - PAD - x;
        text(ctx, match.tournament_name || '赛事', x, top + 26, { weight: 700, size: 42, color: C.text, maxWidth: maxW, minSize: 32 });
        const stage = match.name && match.name !== match.tournament_name ? match.name : '';
        const time = formatMatchTime(match.match_time);
        const sub = stage && time ? `${stage}，${time} 开赛` : stage || (time ? `${time} 开赛` : '');
        text(ctx, sub, x, top + 74, { weight: 500, size: 27, color: C.textDim, maxWidth: maxW, minSize: 22 });
    }

    // ---------- 对阵英雄区 ----------

    function drawTeam(ctx, team, cx, picked, glow) {
        const cy = 470;
        const size = 236;
        const x = cx - size / 2, y = cy - size / 2;

        // 队标底板：半透明玻璃 + 队伍色描边；被选中的一方金色描边 + 外发光
        ctx.save();
        if (picked) {
            ctx.shadowColor = withAlpha(C.gold, 0.55);
            ctx.shadowBlur = 48;
        }
        roundRect(ctx, x, y, size, size, 36);
        const tile = ctx.createLinearGradient(x, y, x, y + size);
        tile.addColorStop(0, 'rgba(255,255,255,0.075)');
        tile.addColorStop(1, 'rgba(255,255,255,0.025)');
        ctx.fillStyle = tile;
        ctx.fill();
        ctx.restore();
        roundRect(ctx, x, y, size, size, 36);
        ctx.strokeStyle = picked ? C.gold : withAlpha(glow, 0.38);
        ctx.lineWidth = picked ? 5 : 3;
        ctx.stroke();

        if (team.logo && team.plate) {
            roundRect(ctx, cx - 92, cy - 92, 184, 184, 26);
            ctx.fillStyle = 'rgba(244,247,251,0.94)';
            ctx.fill();
            drawContain(ctx, team.logo, cx, cy, 140);
        } else if (team.logo) drawContain(ctx, team.logo, cx, cy, 156);
        else text(ctx, (team.short || 'TBD').slice(0, 4).toUpperCase(), cx, cy + 2, { weight: 700, size: 56, color: C.textFaint, align: 'center' });

        if (picked) {
            // 「我的选择」角标：压在队标底板上沿
            const label = '我的选择';
            const w = measure(ctx, label, 700, 24) + 36;
            roundRect(ctx, cx - w / 2, y - 22, w, 44, 22);
            ctx.fillStyle = C.gold;
            ctx.fill();
            text(ctx, label, cx, y + 1, { weight: 700, size: 24, color: '#1b1405', align: 'center' });
        }

        text(ctx, team.short || 'TBD', cx, cy + size / 2 + 56, { weight: 700, size: 56, color: picked ? C.gold : C.text, align: 'center', maxWidth: 380, minSize: 36 });
        if (team.full && team.full !== team.short) {
            text(ctx, team.full, cx, cy + size / 2 + 108, { weight: 500, size: 28, color: C.textDim, align: 'center', maxWidth: 380, minSize: 22 });
        }
    }

    function drawCenter(ctx, match, outcomeKey) {
        const cx = W / 2;
        const cy = 470;
        const hasScore = match.team1_score !== null && match.team1_score !== undefined
            && match.team2_score !== null && match.team2_score !== undefined
            && ['exact', 'winner', 'miss', 'settling', 'forfeit', 'live'].includes(outcomeKey)
            && !(outcomeKey === 'live' && match.team1_score === 0 && match.team2_score === 0);
        if (hasScore) {
            const s1 = Number(match.team1_score), s2 = Number(match.team2_score);
            const live = outcomeKey === 'live';
            text(ctx, live ? '实时比分' : '最终比分', cx, cy - 92, { weight: 700, size: 24, color: C.textFaint, align: 'center', spacing: 4 });
            text(ctx, s1, cx - 30, cy + 4, { weight: 700, size: 104, color: s1 > s2 ? C.text : C.textFaint, align: 'right' });
            text(ctx, ':', cx, cy, { weight: 700, size: 64, color: C.textFaint, align: 'center' });
            text(ctx, s2, cx + 30, cy + 4, { weight: 700, size: 104, color: s2 > s1 ? C.text : C.textFaint, align: 'left' });
        } else {
            // VS 徽记：菱形底 + 粗体字
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(Math.PI / 4);
            roundRect(ctx, -54, -54, 108, 108, 18);
            ctx.fillStyle = 'rgba(255,255,255,0.05)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.14)';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.restore();
            text(ctx, 'VS', cx, cy + 3, { weight: 700, size: 52, color: C.text, align: 'center', spacing: 2 });
        }
    }

    // ---------- 预测面板 + 结果印章 ----------

    function drawPrediction(ctx, match, outcomeKey, pickedSide) {
        const p = match.user_prediction;
        const x = PAD, y = 800, w = W - PAD * 2, h = 240;
        const outcome = OUTCOME[outcomeKey];

        roundRect(ctx, x, y, w, h, 28);
        ctx.fillStyle = C.panel;
        ctx.fill();
        ctx.strokeStyle = C.panelBorder;
        ctx.lineWidth = 2;
        ctx.stroke();
        // 左侧结果色条
        ctx.save();
        roundRect(ctx, x, y, w, h, 28);
        ctx.clip();
        ctx.fillStyle = outcome.color;
        ctx.fillRect(x, y, 8, h);
        ctx.restore();

        text(ctx, '我的预测', x + 48, y + 52, { weight: 700, size: 28, color: C.textDim, spacing: 3 });

        const s1 = p.predicted_team1_score, s2 = p.predicted_team2_score;
        const hasScore = s1 !== null && s1 !== undefined && s2 !== null && s2 !== undefined;
        const scoreY = y + 150;
        if (hasScore) {
            const left = x + 48;
            let cx = left;
            cx += text(ctx, s1, cx, scoreY, { weight: 700, size: 128, color: pickedSide === 1 ? C.gold : C.text });
            cx += 18;
            cx += text(ctx, ':', cx, scoreY - 8, { weight: 700, size: 80, color: C.textFaint });
            cx += 18;
            cx += text(ctx, s2, cx, scoreY, { weight: 700, size: 128, color: pickedSide === 2 ? C.gold : C.text });
            const short1 = match.team1_short_name || match.team1_name || '';
            const short2 = match.team2_short_name || match.team2_name || '';
            const winner = pickedSide === 1 ? short1 : pickedSide === 2 ? short2 : '';
            if (winner) text(ctx, `看好 ${winner} 获胜`, cx + 32, scoreY + 6, { weight: 500, size: 28, color: C.textDim, maxWidth: 300 });
        } else {
            const short = pickedSide === 1 ? (match.team1_short_name || match.team1_name) : (match.team2_short_name || match.team2_name);
            text(ctx, `${short || '—'} 获胜`, x + 48, scoreY, { weight: 700, size: 72, color: C.gold, maxWidth: 520, minSize: 48 });
        }

        drawStamp(ctx, outcomeKey, p, x + w - 180, y + h / 2);
    }

    function drawStamp(ctx, outcomeKey, p, cx, cy) {
        const o = OUTCOME[outcomeKey];
        const settledHit = outcomeKey === 'exact' || outcomeKey === 'winner';
        const main = settledHit ? `+${p.points_earned}` : o.title;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-0.12);
        const sw = 280, sh = 190;
        roundRect(ctx, -sw / 2, -sh / 2, sw, sh, 22);
        ctx.fillStyle = withAlpha(o.color, 0.12);
        ctx.fill();
        ctx.strokeStyle = o.color;
        ctx.lineWidth = 5;
        ctx.stroke();
        roundRect(ctx, -sw / 2 + 11, -sh / 2 + 11, sw - 22, sh - 22, 14);
        ctx.strokeStyle = withAlpha(o.color, 0.45);
        ctx.lineWidth = 2;
        ctx.stroke();
        if (settledHit) {
            text(ctx, main, 0, -22, { weight: 700, size: 84, color: o.color, align: 'center' });
            text(ctx, `${o.title}得分`, 0, 50, { weight: 700, size: 26, color: o.color, align: 'center', spacing: 2 });
        } else {
            text(ctx, main, 0, -20, { weight: 700, size: main.length > 4 ? 42 : 54, color: o.color, align: 'center', maxWidth: sw - 40, minSize: 34 });
            text(ctx, o.sub, 0, 44, { weight: 500, size: 26, color: withAlpha(o.color, 0.85), align: 'center', spacing: 2 });
        }
        ctx.restore();
    }

    // ---------- 预测人 ----------

    function drawUser(ctx, user) {
        const cy = 1100;
        const r = 36;
        const ax = PAD + r;
        const initial = String(user.username || '?').trim().charAt(0).toUpperCase() || '?';
        const g = ctx.createLinearGradient(ax - r, cy - r, ax + r, cy + r);
        g.addColorStop(0, '#3d8fd6');
        g.addColorStop(1, '#245981');
        ctx.beginPath();
        ctx.arc(ax, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
        text(ctx, initial, ax, cy + 2, { weight: 700, size: 36, color: '#fff', align: 'center' });

        const nameX = ax + r + 22;
        const nameW = text(ctx, user.username || '', nameX, cy - 16, { weight: 700, size: 36, color: C.text, maxWidth: 520 });
        text(ctx, 'PRBET 竞猜玩家', nameX, cy + 24, { weight: 500, size: 24, color: C.textFaint });
        void nameW;

        const score = Number(user.total_score) || 0;
        const right = W - PAD;
        const unitW = text(ctx, '累计积分', right, cy + 24, { weight: 500, size: 24, color: C.textFaint, align: 'right' });
        void unitW;
        text(ctx, String(score), right, cy - 14, { weight: 700, size: 48, color: C.gold, align: 'right' });
    }

    // ---------- 底栏 ----------

    function drawFooter(ctx, qrImg) {
        const top = 1170;
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(0, top, W, H - top);
        ctx.fillStyle = C.line;
        ctx.fillRect(0, top, W, 2);

        const qrSize = 132;
        const qx = W - PAD - qrSize;
        const qy = top + (H - top - qrSize) / 2;
        roundRect(ctx, qx - 10, qy - 10, qrSize + 20, qrSize + 20, 14);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        if (qrImg) {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(qrImg, qx, qy, qrSize, qrSize);
            ctx.imageSmoothingEnabled = true;
        } else {
            text(ctx, 'PRBET', qx + qrSize / 2, qy + qrSize / 2, { weight: 700, size: 26, color: '#182330', align: 'center' });
        }

        const mid = top + (H - top) / 2;
        text(ctx, '扫码一起来猜', PAD, mid - 30, { weight: 700, size: 44, color: C.text });
        text(ctx, `CS2 与 Valorant 免费赛事竞猜，访问 ${SITE_LABEL}`, PAD, mid + 30, { weight: 500, size: 26, color: C.textDim, maxWidth: qx - PAD - 40, minSize: 20 });
    }

    // ---------- 组装 ----------

    function outcomeOf(match) {
        const p = match.user_prediction;
        if (match.is_forfeit) return 'forfeit';
        const settled = p.points_earned !== null && p.points_earned !== undefined;
        if (settled) {
            if (p.points_earned <= 0) return 'miss';
            const exact = match.team1_score !== null && match.team1_score !== undefined
                && Number(p.predicted_team1_score) === Number(match.team1_score)
                && Number(p.predicted_team2_score) === Number(match.team2_score);
            return exact ? 'exact' : 'winner';
        }
        const status = match.display_status || match.home_phase || match.status;
        if (status === 'finished') return 'settling';
        const started = match.match_time && new Date(match.match_time).getTime() <= Date.now();
        if (status === 'ongoing' || status === 'live' || (status !== 'upcoming' && started)) return 'live';
        return started ? 'live' : 'upcoming';
    }

    function shareTargetUrl(match) {
        return match.tournament_id ? `${SITE_URL}/tournaments.html?tournament=${encodeURIComponent(match.tournament_id)}` : SITE_URL;
    }

    async function loadTeamLogo(darkUrl, lightUrl) {
        // 深色画布：优先 PandaScore 白色版；没有则用原版，深色黑白 logo 再做反色
        const dark = darkUrl ? await loadImage(proxiedLogo(darkUrl)) : null;
        const light = await loadImage(proxiedLogo(lightUrl));
        const analysis = analyzeLogo(light || dark);
        let logo = dark || light;
        if (!dark && light && analysis.darkMono) logo = invertedCopy(light);
        return { logo, color: analysis.color, plate: !dark && !!light && analysis.darkHeavy };
    }

    async function loadTournamentLogo(match) {
        const resolve = typeof window.tournamentLogoUrl === 'function' ? window.tournamentLogoUrl : null;
        const uploaded = match.tournament_logo_url && String(match.tournament_logo_url).startsWith('/uploads/') ? match.tournament_logo_url : '';
        const src = uploaded || (resolve ? resolve(match.tournament_name, match.game_type) : '');
        if (!src) return null;
        const darkSrc = src.startsWith('/images/tournament/') ? src.replace(/(\.[^.]+)$/, '-dark$1') : '';
        const img = await loadFirst(darkSrc, src);
        if (!img) return null;
        return analyzeLogo(img).darkMono ? invertedCopy(img) : img;
    }

    async function renderShareCard(match, user) {
        await loadFonts();
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');

        const skipQr = new URLSearchParams(location.search).has('sharetest');
        const [team1, team2, tourLogo, brand, qr] = await Promise.all([
            loadTeamLogo(match.team1_dark_logo_url, match.team1_logo_url),
            loadTeamLogo(match.team2_dark_logo_url, match.team2_logo_url),
            loadTournamentLogo(match),
            loadFirst('/images/prbetlogo-light.png', '/images/prbetlogo.png'),
            skipQr ? Promise.resolve(null) : loadImage(`/api/qrcode?text=${encodeURIComponent(shareTargetUrl(match))}&size=320`)
        ]);

        const p = match.user_prediction;
        const pickedSide = p.predicted_winner_id != null && String(p.predicted_winner_id) === String(match.team1_id) ? 1
            : p.predicted_winner_id != null && String(p.predicted_winner_id) === String(match.team2_id) ? 2 : 0;
        const outcomeKey = outcomeOf(match);
        const glow1 = glowColor(team1.color, '#3d8fd6');
        const glow2 = glowColor(team2.color, '#d65a5a');

        drawBackground(ctx, glow1, glow2);
        drawHeader(ctx, match, brand);
        drawTournament(ctx, match, tourLogo);
        drawTeam(ctx, { logo: team1.logo, plate: team1.plate, short: match.team1_short_name || match.team1_name, full: match.team1_name }, 250, pickedSide === 1, glow1);
        drawTeam(ctx, { logo: team2.logo, plate: team2.plate, short: match.team2_short_name || match.team2_name, full: match.team2_name }, W - 250, pickedSide === 2, glow2);
        drawCenter(ctx, match, outcomeKey);
        drawPrediction(ctx, match, outcomeKey, pickedSide);
        drawUser(ctx, user);
        drawFooter(ctx, qr);
        return canvas;
    }

    function canvasToBlob(canvas) {
        return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
    }

    // ---------- 弹窗 ----------

    function fileName() {
        return `prbet-${currentMatch ? currentMatch.id : 'share'}.png`;
    }

    function flash(modal, message) {
        const hint = modal.querySelector('.share-hint');
        if (!hint) return;
        hint.textContent = message;
        hint.classList.add('flash');
        clearTimeout(flash.timer);
        flash.timer = setTimeout(() => {
            hint.classList.remove('flash');
            hint.textContent = hint.dataset.default || '';
        }, 2200);
    }

    function ensureModal() {
        let modal = document.getElementById('shareModal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'shareModal';
        modal.className = 'modal';
        modal.setAttribute('hidden', '');
        modal.innerHTML = `
            <div class="modal-backdrop" onclick="closeShareModal()"></div>
            <section class="modal-panel share-panel" role="dialog" aria-modal="true" aria-labelledby="shareTitle">
                <div class="modal-head">
                    <h2 id="shareTitle">分享我的竞猜</h2>
                    <button class="modal-close" type="button" onclick="closeShareModal()" aria-label="关闭">×</button>
                </div>
                <div class="share-body">
                    <div class="share-canvas-wrap"><img id="shareImage" alt="竞猜分享图"></div>
                    <div class="share-actions">
                        <button type="button" class="button" id="shareDownload">保存图片</button>
                        <button type="button" class="button ghost" id="shareCopy" hidden>复制图片</button>
                        <button type="button" class="button ghost" id="shareNative" hidden>分享到…</button>
                    </div>
                    <p class="share-hint" data-default="移动端可长按图片保存，或下载后分享到社交平台">移动端可长按图片保存，或下载后分享到社交平台</p>
                </div>
            </section>`;
        document.body.appendChild(modal);

        modal.querySelector('#shareDownload').addEventListener('click', () => {
            const img = modal.querySelector('#shareImage');
            if (!img.src) return;
            const a = document.createElement('a');
            a.href = img.src;
            a.download = fileName();
            document.body.appendChild(a);
            a.click();
            a.remove();
        });
        modal.querySelector('#shareCopy').addEventListener('click', async () => {
            if (!currentBlob) return;
            try {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': currentBlob })]);
                flash(modal, '已复制到剪贴板，可直接粘贴到聊天窗口');
            } catch (e) {
                flash(modal, '复制失败，请改用保存图片');
            }
        });
        modal.querySelector('#shareNative').addEventListener('click', async () => {
            if (!currentBlob) return;
            try {
                const file = new File([currentBlob], fileName(), { type: 'image/png' });
                await navigator.share({ files: [file], title: 'PRBET 竞猜' });
            } catch (e) { /* 用户取消 */ }
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !modal.hasAttribute('hidden')) closeShareModal();
        });
        return modal;
    }

    async function sharePrediction(matchId) {
        const finder = typeof window.getMatchForShare === 'function' ? window.getMatchForShare : null;
        const context = typeof window.getShareContext === 'function' ? window.getShareContext() : {};
        const match = finder ? finder(matchId) : null;
        if (!match || !match.user_prediction) return;
        const user = context.user;
        if (!user) return;
        const modal = ensureModal();
        const img = modal.querySelector('#shareImage');
        const wrap = modal.querySelector('.share-canvas-wrap');
        img.removeAttribute('src');
        currentBlob = null;
        modal.querySelector('#shareCopy').hidden = true;
        modal.querySelector('#shareNative').hidden = true;
        wrap.classList.add('loading');
        modal.removeAttribute('hidden');
        document.body.classList.add('modal-open');
        try {
            currentMatch = match;
            const canvas = await renderShareCard(match, user);
            img.src = canvas.toDataURL('image/png');
            currentBlob = await canvasToBlob(canvas);
            if (currentBlob) {
                const file = new File([currentBlob], fileName(), { type: 'image/png' });
                modal.querySelector('#shareNative').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
                modal.querySelector('#shareCopy').hidden = !(window.ClipboardItem && navigator.clipboard && navigator.clipboard.write && window.isSecureContext);
            }
        } catch (error) {
            alert('分享图生成失败：' + (error.message || '请稍后重试'));
            closeShareModal();
        } finally {
            wrap.classList.remove('loading');
        }
    }

    function closeShareModal() {
        const modal = document.getElementById('shareModal');
        if (modal) modal.setAttribute('hidden', '');
        document.body.classList.remove('modal-open');
    }

    window.sharePrediction = sharePrediction;
    window.closeShareModal = closeShareModal;
    // 供测试 / 调试直接渲染（不弹窗）
    window.renderPrbetShareCard = renderShareCard;
})();
