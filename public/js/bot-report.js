// Renders a bot report card (built by bot/core.js) for the QQ bot's headless screenshot.
// The bot calls window.renderReport(card) and screenshots the returned rectangle.
(function () {
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    // Same rule as shared.js proxiedLogoUrl: remote logos go through the site's whitelisted logo proxy.
    const logoUrl = url => !url ? '' : /^\/(?!\/)/.test(url) || url.startsWith('data:') ? url : `/api/images/team-logo?url=${encodeURIComponent(url)}`;
    const logo = url => url ? `<img src="${escape(logoUrl(url))}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'br-logo-empty'}))">` : '<i class="br-logo-empty"></i>';

    function team(item, side) {
        const win = Number(item.win) || 0;
        const state = !win ? '' : win === side ? ' win' : ' lose';
        const name = side === 1 ? item.a : item.b;
        const image = logo(side === 1 ? item.alogo : item.blogo);
        const tagged = side === 1 ? item.atag : item.btag;
        const tag = tagged && tagged.text ? `<em class="br-tag ${/^(up|drop|out|record)$/.test(tagged.tone) ? tagged.tone : 'record'}">${escape(tagged.text)}</em>` : '';
        return side === 1
            ? `<span class="br-team a${state}">${tag}<b>${escape(name)}</b>${image}</span>`
            : `<span class="br-team b${state}">${image}<b>${escape(name)}</b>${tag}</span>`;
    }

    function row(item) {
        const scored = item.mid !== 'vs';
        return `<div class="br-row${item.time ? '' : ' result'}">
            <span class="br-id">#${escape(item.id)}</span>
            ${item.time ? `<span class="br-time">${escape(item.time)}</span>` : ''}
            ${team(item, 1)}
            <span class="br-mid${scored ? ' score' : ''}">${escape(item.mid)}</span>
            ${team(item, 2)}
            <span class="br-meta${/进行中/.test(item.meta || '') ? ' live' : ''}">${item.round ? `<small>${escape(item.round)}</small>` : ''}${item.meta ? `<span>${escape(item.meta)}</span>` : ''}</span>
        </div>`;
    }

    function groupName(text) {
        const [game, ...rest] = String(text).split(' · ');
        return rest.length
            ? `<span class="br-game ${game === 'Valorant' ? 'valorant' : ''}">${escape(game)}</span>${escape(rest.join(' · '))}`
            : escape(text);
    }

    function body(items) {
        let html = '', open = false;
        const close = () => { if (open) { html += '</div>'; open = false; } };
        for (const item of items || []) {
            if (item.t === 'row') {
                if (!open) { html += '<div class="br-group">'; open = true; }
                html += row(item);
                continue;
            }
            close();
            if (item.t === 'section') html += `<div class="br-section">${escape(item.text)}</div>`;
            else if (item.t === 'group') { html += `<div class="br-group"><div class="br-group-name">${groupName(item.text)}</div>`; open = true; }
            else if (item.t === 'note') html += `<p class="br-note">${escape(item.text)}</p>`;
        }
        close();
        return html;
    }

    const settle = image => image.complete ? Promise.resolve() : new Promise(resolve => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
    });

    window.renderReport = async function renderReport(card) {
        const root = document.getElementById('report');
        root.dataset.theme = /^(cs2|valorant)$/.test(card.theme || '') ? card.theme : '';
        root.innerHTML = `<header class="br-head">
                <div><h1>${escape(card.title)}</h1><p>${escape(card.subtitle)}</p></div>
                <img src="/images/prbetlogo-light.png" alt="PRBET">
            </header>
            <div class="br-body">${body(card.items)}</div>
            <footer class="br-foot">${escape(card.footer)}</footer>`;
        // Wait for MiSans and every logo (bounded) so the screenshot never catches fallback glyphs or blanks.
        await Promise.race([
            Promise.all([document.fonts.ready, ...[...root.querySelectorAll('img')].map(settle)]),
            new Promise(resolve => setTimeout(resolve, 8000))
        ]);
        const rect = root.getBoundingClientRect();
        return { x: rect.left, y: rect.top + window.scrollY, width: rect.width, height: rect.height };
    };
})();
