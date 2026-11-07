// 实时比分 / 单图比分（GRID Open Access 补充数据）。独立、可重复执行的增量迁移。
//
// match_live_links：本地比赛 ↔ GRID series 的关联与系列赛实时状态。
//   link_method = auto（自动按队名+时间配对）/ manual（管理员指定）/ none（管理员屏蔽，不再自动配对）。
//   team1_id 记录写入时本地 team1 的队伍 id；PandaScore 之后若对调主客队，读取时据此翻转比分。
//   team_map 为 JSON：{ "<本地队伍id>": "<GRID 队伍id>" }。
// match_games：每张地图的回合比分，方向同 match_live_links.team1_id。
// 这两张表只用于展示，不参与结算：赛果与积分仍以 PandaScore / 管理员录入为准。
function ensureLiveSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS match_live_links (
            match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
            source TEXT NOT NULL DEFAULT 'grid',
            series_id TEXT,
            link_method TEXT NOT NULL CHECK(link_method IN ('auto', 'manual', 'none')),
            link_score REAL,
            team1_id INTEGER,
            team_map TEXT,
            started INTEGER NOT NULL DEFAULT 0,
            finished INTEGER NOT NULL DEFAULT 0,
            team1_score INTEGER,
            team2_score INTEGER,
            state_updated_at TEXT,
            last_polled_at TEXT,
            last_error TEXT,
            linked_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_match_live_links_series
            ON match_live_links(source, series_id) WHERE series_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS match_games (
            match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL,
            map_name TEXT,
            team1_rounds INTEGER,
            team2_rounds INTEGER,
            winner TEXT CHECK(winner IN ('team1', 'team2')),
            status TEXT NOT NULL CHECK(status IN ('upcoming', 'ongoing', 'finished')),
            updated_at TEXT NOT NULL,
            PRIMARY KEY (match_id, sequence)
        );
    `);
    // BP 流程（JSON 数组，方向同 team1_id）：[{ sequence, type: ban|pick|decider, map, team, side? }]
    const linkColumns = db.prepare('PRAGMA table_info(match_live_links)').all().map(column => column.name);
    if (!linkColumns.includes('veto')) db.exec('ALTER TABLE match_live_links ADD COLUMN veto TEXT');
}

module.exports = { ensureLiveSchema };
