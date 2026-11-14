const express = require('express');
const { getLolAssets, publicAssets } = require('../services/lolAssets');

const router = express.Router();

// LoL 英雄 / 装备索引（GRID 英文名 → Data Dragon id、中文名、定位标签），前端按需加载一次
router.get('/assets', async (req, res) => {
    const assets = publicAssets(await getLolAssets());
    if (!assets) return res.status(503).json({ error: 'LoL 素材暂不可用' });
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(assets);
});

module.exports = router;
