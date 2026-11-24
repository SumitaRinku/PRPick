// Pick'em 作业总图：把用户在一个赛事里所有已提交阶段的竞猜画成一张长图（宽 1080，高度随阶段数变化）。
// 视觉与单场分享卡一致（固定深色），绘图工具与弹窗来自 share.js 的 window.PrpickShare。
//
//   顶栏      PRPICK 字标 + PICK'EM / 游戏标签
//   赛事      赛事 logo + 赛事名 + 「Pick'em 作业」
//   玩家      头像字母 + 用户名 + 硬币（铜 / 银 / 金 / 钻石）+ 总分 / 满分
//   阶段 × N  瑞士轮 / GSL：第一行全胜晋级 + 全败出局，第二行晋级；淘汰赛：冠军 / 亚军 / 四强
//             每支队一张队标卡片，结果用绿 ✓ / 红 ✕ / 中性（待定）标出
//   底栏      引导文案 + 二维码（指向该赛事的 Pick'em 页）
(function () {
    const W = 1080;
    const TILE_W = 100;
    const TILE_H = 116;
    const TILE_GAP = 12;
    const ROW_H = TILE_H + 22;
    const LABEL_W = 132;

    const COIN_STYLE = {
        bronze: ['#f2c08f', '#b06a35', '#7a4320'],
        silver: ['#ffffff', '#b9c3cc', '#7d8893'],
        gold: ['#fff3b0', '#e2b33c', '#a37516'],
        diamond: ['#e8fdff', '#6fd6ef', '#2a8fb8']
    };

    function kit() {
        return window.PrpickShare;
    }

    function toneColor(tone) {
        const { C } = kit();
        return tone === 'advance' ? C.green : tone === 'eliminate' ? C.red : tone === 'gold' ? C.gold : tone === 'silver' ? '#c7d0d9' : C.blue;
    }

    function drawCoin(ctx, key, cx, cy, r) {
        const [hi, mid, lo] = COIN_STYLE[key] || COIN_STYLE.bronze;
        const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.45, r * 0.1, cx, cy, r);
        g.addColorStop(0, hi);
        g.addColorStop(0.55, mid);
        g.addColorStop(1, lo);
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.45)';
        ctx.shadowBlur = r * 0.4;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.restore();
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.64, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = Math.max(2, r * 0.06);
        ctx.stroke();
        if (key === 'diamond') {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(Math.PI / 4);
            ctx.fillStyle = '#ffffff';
            ctx.shadowColor = 'rgba(20,110,150,0.8)';
            ctx.shadowBlur = r * 0.2;
            const d = r * 0.26;
            ctx.fillRect(-d, -d, d * 2, d * 2);
            ctx.restore();
        }
    }

    // ---------- 版面高度 ----------

    function stageHeight(stage) {
        const rows = stage.kind === 'record' ? 2 : 1;
        return 78 + rows * ROW_H + (stage.kind === 'record' ? 0 : 24) + 28;
    }

    function layoutHeight(stages) {
        return 440 + stages.reduce((sum, stage) => sum + stageHeight(stage) + 20, 0) + 20 + 200;
    }

    // ---------- 各区块 ----------

    function drawBackground(ctx, H) {
        const { C, withAlpha } = kit();
        const base = ctx.createLinearGradient(0, 0, 0, H);
        base.addColorStop(0, C.bg1);
        base.addColorStop(1, C.bg0);
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, W, H);
        const glow = ctx.createRadialGradient(W / 2, 260, 0, W / 2, 260, 700);
        glow.addColorStop(0, withAlpha(C.gold, 0.12));
        glow.addColorStop(1, withAlpha(C.gold, 0));
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, W, H);
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
        const bar = ctx.createLinearGradient(0, 0, W, 0);
        bar.addColorStop(0, C.brand);
        bar.addColorStop(0.5, C.gold);
        bar.addColorStop(1, C.brand);
        ctx.fillStyle = bar;
        ctx.fillRect(0, 0, W, 8);
    }

    function drawHeader(ctx, data, brandImg) {
        const { C, PAD, text, pill } = kit();
        const cy = 72;
        if (brandImg) {
            const h = 50;
            const w = (brandImg.naturalWidth || brandImg.width) * (h / (brandImg.naturalHeight || brandImg.height));
            ctx.drawImage(brandImg, PAD, cy - h / 2, w, h);
        } else {
            text(ctx, 'PRPICK', PAD, cy, { weight: 700, size: 48, color: C.text });
        }
        let x = W - PAD;
        x -= pill(ctx, "PICK'EM", x, cy, { align: 'right', size: 24, color: C.gold, bg: 'rgba(242,182,50,0.10)', border: 'rgba(242,182,50,0.32)' }) + 12;
        const game = data.tournament.game_type;
        if (typeof isGameKey === 'function' && isGameKey(game)) pill(ctx, GAME_REGISTRY[game].pill, x, cy, { align: 'right', size: 24, ...GAME_REGISTRY[game].sharePill });
        ctx.fillStyle = C.line;
        ctx.fillRect(PAD, 128, W - PAD * 2, 2);
    }

    function drawTournament(ctx, data, tourLogo) {
        const { C, PAD, text, roundRect, drawContain } = kit();
        const top = 160;
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
        text(ctx, data.tournament.name, x, top + 26, { weight: 700, size: 42, color: C.text, maxWidth: maxW, minSize: 30 });
        text(ctx, `Pick'em 作业 · ${data.stages.length} 个阶段`, x, top + 72, { weight: 500, size: 27, color: C.textDim, maxWidth: maxW, minSize: 22 });
    }

    function drawPlayer(ctx, data) {
        const { C, PAD, text, roundRect } = kit();
        const x = PAD, y = 284, w = W - PAD * 2, h = 128;
        roundRect(ctx, x, y, w, h, 24);
        ctx.fillStyle = C.panel;
        ctx.fill();
        ctx.strokeStyle = C.panelBorder;
        ctx.lineWidth = 2;
        ctx.stroke();

        const r = 34;
        const ax = x + 36 + r, cy = y + h / 2;
        const avatar = ctx.createLinearGradient(ax - r, cy - r, ax + r, cy + r);
        avatar.addColorStop(0, '#3d8fd6');
        avatar.addColorStop(1, '#245981');
        ctx.beginPath();
        ctx.arc(ax, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = avatar;
        ctx.fill();
        const initial = String(data.user.username || '?').trim().charAt(0).toUpperCase() || '?';
        text(ctx, initial, ax, cy + 2, { weight: 700, size: 34, color: '#fff', align: 'center' });
        text(ctx, data.user.username, ax + r + 22, cy - 16, { weight: 700, size: 36, color: C.text, maxWidth: 380 });
        text(ctx, 'PRPICK 竞猜玩家', ax + r + 22, cy + 24, { weight: 500, size: 24, color: C.textFaint });

        const coin = data.me.coin || { key: 'bronze', label: '铜币' };
        const right = x + w - 36;
        const max = data.coins?.max_points || 0;
        text(ctx, `${data.me.points}`, right, cy - 14, { weight: 700, size: 52, color: C.gold, align: 'right' });
        text(ctx, `/ ${max} 分`, right, cy + 28, { weight: 500, size: 24, color: C.textFaint, align: 'right' });
        const coinX = right - 190;
        drawCoin(ctx, coin.key, coinX, cy - 6, 34);
        text(ctx, coin.label, coinX, cy + 44, { weight: 700, size: 22, color: C.textDim, align: 'center' });
    }

    function drawTile(ctx, entry, x, y, logos, tone) {
        const { C, text, roundRect, drawContain, withAlpha } = kit();
        const result = entry ? entry.result : 'empty';
        const border = result === 'correct' ? C.green : result === 'wrong' ? C.red : entry ? withAlpha(toneColor(tone), 0.45) : 'rgba(255,255,255,0.14)';
        roundRect(ctx, x, y, TILE_W, TILE_H, 14);
        ctx.fillStyle = result === 'correct' ? withAlpha(C.green, 0.12) : result === 'wrong' ? withAlpha(C.red, 0.10) : 'rgba(255,255,255,0.045)';
        ctx.fill();
        if (!entry) ctx.setLineDash([8, 6]);
        ctx.strokeStyle = border;
        ctx.lineWidth = result === 'correct' || result === 'wrong' ? 3 : 2;
        ctx.stroke();
        ctx.setLineDash([]);
        if (!entry) {
            text(ctx, '未选', x + TILE_W / 2, y + TILE_H / 2, { weight: 500, size: 22, color: C.textFaint, align: 'center' });
            return;
        }
        const team = entry.team;
        const logo = logos.get(team.id);
        const lcx = x + TILE_W / 2, lcy = y + 46;
        ctx.save();
        if (result === 'wrong') ctx.globalAlpha = 0.45;
        if (logo?.logo && logo.plate) {
            roundRect(ctx, lcx - 34, lcy - 34, 68, 68, 12);
            ctx.fillStyle = 'rgba(244,247,251,0.94)';
            ctx.fill();
            drawContain(ctx, logo.logo, lcx, lcy, 52);
        } else if (logo?.logo) {
            drawContain(ctx, logo.logo, lcx, lcy, 62);
        } else {
            text(ctx, (team.short_name || team.name || '?').slice(0, 4).toUpperCase(), lcx, lcy, { weight: 700, size: 26, color: C.textDim, align: 'center' });
        }
        ctx.restore();
        text(ctx, team.short_name || team.name, lcx, y + TILE_H - 20, { weight: 700, size: 20, color: result === 'wrong' ? C.textFaint : C.text, align: 'center', maxWidth: TILE_W - 12, minSize: 14 });
        if (result === 'correct' || result === 'wrong') {
            const bx = x + TILE_W - 6, by = y + 6;
            ctx.beginPath();
            ctx.arc(bx, by, 15, 0, Math.PI * 2);
            ctx.fillStyle = result === 'correct' ? C.green : C.red;
            ctx.fill();
            text(ctx, result === 'correct' ? '✓' : '✕', bx, by + 1, { weight: 700, size: 18, color: '#0b121b', align: 'center' });
        }
    }

    // 一组名额：左侧标签 + 若干队卡片；返回占用宽度
    function drawSlotGroup(ctx, slot, x, y, logos) {
        const { C, text } = kit();
        const color = toneColor(slot.tone);
        ctx.fillStyle = color;
        ctx.fillRect(x, y + 10, 5, TILE_H - 20);
        text(ctx, slot.label, x + 18, y + TILE_H / 2 - 16, { weight: 700, size: 24, color: C.text, maxWidth: LABEL_W - 22, minSize: 16 });
        const hits = slot.picks.filter(entry => entry.result === 'correct').length;
        const decided = slot.picks.filter(entry => entry.result !== 'pending').length;
        text(ctx, decided ? `中 ${hits}/${slot.count}` : `${slot.count} 队 · ${slot.points} 分`, x + 18, y + TILE_H / 2 + 18, { weight: 500, size: 19, color: C.textDim, maxWidth: LABEL_W - 22, minSize: 14 });
        let tx = x + LABEL_W;
        for (let i = 0; i < slot.count; i++) {
            drawTile(ctx, slot.picks[i] || null, tx, y, logos, slot.tone);
            tx += TILE_W + TILE_GAP;
        }
        return tx - x;
    }

    function drawStage(ctx, stage, top, logos) {
        const { C, PAD, text, roundRect } = kit();
        const x = PAD, w = W - PAD * 2, h = stageHeight(stage);
        roundRect(ctx, x, top, w, h, 24);
        ctx.fillStyle = C.panel;
        ctx.fill();
        ctx.strokeStyle = C.panelBorder;
        ctx.lineWidth = 2;
        ctx.stroke();

        text(ctx, stage.name, x + 32, top + 42, { weight: 700, size: 32, color: C.text, maxWidth: 520, minSize: 24 });
        const nameW = Math.min(520, kit().measure(ctx, stage.name, 700, 32));
        text(ctx, stage.kindText, x + 32 + nameW + 16, top + 44, { weight: 500, size: 22, color: C.textFaint, maxWidth: 300 });
        const result = stage.result;
        const pending = result.items.length - result.decided;
        if (result.decided) {
            text(ctx, `${result.points}`, x + w - 96, top + 40, { weight: 700, size: 40, color: C.gold, align: 'right' });
            text(ctx, `/${stage.maxPoints} 分`, x + w - 32, top + 44, { weight: 500, size: 22, color: C.textDim, align: 'right' });
        } else {
            text(ctx, stage.locked ? '进行中 · 待结算' : '待开赛', x + w - 32, top + 42, { weight: 700, size: 24, color: C.brandSoft, align: 'right' });
        }
        if (result.decided && pending) text(ctx, `${pending} 项待定`, x + w - 32, top + 74, { weight: 500, size: 19, color: C.textFaint, align: 'right' });

        const bySlot = new Map(stage.slots.map(slot => [slot.key, slot]));
        const rowY = top + 78;
        if (stage.kind === 'record') {
            // 第一行：全胜晋级 + 全败出局；第二行：晋级
            let cx = x + 32;
            for (const key of ['top', 'bottom']) {
                const slot = bySlot.get(key);
                if (!slot) continue;
                cx += drawSlotGroup(ctx, slot, cx, rowY, logos) + 28;
            }
            const advance = bySlot.get('advance');
            if (advance) drawSlotGroup(ctx, advance, x + 32, rowY + ROW_H, logos);
        } else {
            // 淘汰赛：冠军 / 亚军 / 四强 横排，标签在卡片上方
            let cx = x + 32;
            for (const slot of stage.slots) {
                const color = toneColor(slot.tone);
                text(ctx, `${slot.label} · ${slot.points} 分`, cx, rowY + 10, { weight: 700, size: 22, color, maxWidth: slot.count * (TILE_W + TILE_GAP) });
                for (let i = 0; i < slot.count; i++) {
                    drawTile(ctx, slot.picks[i] || null, cx, rowY + 30, logos, slot.tone);
                    cx += TILE_W + TILE_GAP;
                }
                cx += 36;
            }
        }
        return h;
    }

    function drawFooter(ctx, H, qrImg) {
        const { C, PAD, text, roundRect, SITE_LABEL } = kit();
        const top = H - 200;
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
            text(ctx, 'PRPICK', qx + qrSize / 2, qy + qrSize / 2, { weight: 700, size: 26, color: '#182330', align: 'center' });
        }
        const mid = top + (H - top) / 2;
        text(ctx, '扫码来抄我的作业', PAD, mid - 30, { weight: 700, size: 44, color: C.text });
        text(ctx, `PRPICK 赛事竞猜 · ${SITE_LABEL}`, PAD, mid + 30, { weight: 500, size: 26, color: C.textDim, maxWidth: qx - PAD - 40, minSize: 20 });
    }

    // ---------- 组装 ----------

    async function renderPickemSummary(data) {
        const share = kit();
        await share.loadFonts();
        const H = layoutHeight(data.stages);
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');

        const teams = new Map();
        for (const stage of data.stages) for (const slot of stage.slots) for (const entry of slot.picks) teams.set(entry.team.id, entry.team);
        const skipQr = new URLSearchParams(location.search).has('sharetest');
        const target = `${share.SITE_URL}/tournaments.html?tournament=${encodeURIComponent(data.tournament.id)}&view=pickem`;
        const [logoList, tourLogo, brand, qr] = await Promise.all([
            Promise.all([...teams.values()].map(async team => [team.id, await share.loadTeamLogo(team.dark_logo_url, team.logo_url)])),
            share.loadTournamentLogo({ tournament_logo_url: data.tournament.logo_url, tournament_name: data.tournament.name, game_type: data.tournament.game_type }),
            share.loadFirst('/images/prpicklogo-light.png', '/images/prpicklogo.png'),
            skipQr ? Promise.resolve(null) : share.loadImage(`/api/qrcode?text=${encodeURIComponent(target)}&size=320`)
        ]);
        const logos = new Map(logoList);

        drawBackground(ctx, H);
        drawHeader(ctx, data, brand);
        drawTournament(ctx, data, tourLogo);
        drawPlayer(ctx, data);
        let y = 440;
        for (const stage of data.stages) y += drawStage(ctx, stage, y, logos) + 20;
        drawFooter(ctx, H, qr);
        return canvas;
    }

    async function sharePickemSummary() {
        if (!window.PrpickShare) return;
        const data = typeof window.getPickemShareData === 'function' ? window.getPickemShareData() : null;
        if (!data?.stages.length) {
            alert('请先提交至少一个阶段的 Pick\'em');
            return;
        }
        await window.PrpickShare.showCanvas(() => renderPickemSummary(data), {
            title: "分享我的 Pick'em 作业",
            fileName: `prpick-pickem-${data.tournament.id}.png`,
            tall: true
        });
    }

    window.sharePickemSummary = sharePickemSummary;
    window.renderPickemSummary = renderPickemSummary;
})();
