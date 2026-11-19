// 赛事整体竞猜（Pick'em）。独立、可重复执行的增量迁移。
//
// pickem_stage_settings：管理员对某阶段的覆盖设置；没有记录即按自动识别（mode = auto）。
//   config 为 JSON，仅 mode = record 时使用：{ wins, losses, top_count, bottom_count, advance_count }。
// pickem_picks：用户在某阶段的竞猜，picks 为 JSON（结构见 server/services/pickem.js）。
//   积分不落库，读取时按当前赛果重算。
function ensurePickemSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS pickem_stage_settings (
            stage_id INTEGER PRIMARY KEY REFERENCES tournament_stages(id) ON DELETE CASCADE,
            mode TEXT NOT NULL CHECK(mode IN ('auto', 'off', 'record', 'elimination')),
            config TEXT,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS pickem_picks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            stage_id INTEGER NOT NULL REFERENCES tournament_stages(id) ON DELETE CASCADE,
            picks TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, stage_id)
        );
        CREATE INDEX IF NOT EXISTS idx_pickem_picks_stage ON pickem_picks(stage_id);
    `);
}

module.exports = { ensurePickemSchema };
