(() => {
    const feedback = document.getElementById('botBindingFeedback');
    document.getElementById('botBindingForm').addEventListener('submit', async event => {
        event.preventDefault();
        try {
            const qq = document.getElementById('botBindingQQ').value.trim();
            const result = await sharedApi('/bot-account/code', { method: 'POST', body: { qq_id: qq } });
            feedback.textContent = `请用 QQ ${qq} 在群内发送：/pick 绑定 ${result.code}（10 分钟内有效）`;
        } catch (error) { feedback.textContent = error.message; }
    });
    document.getElementById('botUnbind').addEventListener('click', async () => {
        try {
            const result = await sharedApi('/bot-account', { method: 'DELETE' });
            feedback.textContent = result.message;
        } catch (error) { feedback.textContent = error.message; }
    });
    function refresh() {
        if (!sharedState.token) { feedback.textContent = ''; return; }
        sharedApi('/bot-account').then(result => {
            feedback.textContent = result.binding ? `已绑定 QQ ${result.binding.qq_id}（已加入 ${result.groups.length} 个群）` : '尚未绑定 QQ';
        }).catch(() => {});
    }
    window.addEventListener('auth-changed', refresh);
    refresh();
})();
