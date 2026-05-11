-- Migration 028: Virtual portfolios and picks for agent performance tracking
-- Date: 2026-05-11
-- Description: Tracks fake-money portfolios ($100 starting balance) and
--              picks/trades per agent so ROI and performance are visible in the UI.

CREATE TABLE IF NOT EXISTS virtual_portfolios (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id     INTEGER NOT NULL UNIQUE,
    agent_name   TEXT    NOT NULL,
    starting_balance REAL NOT NULL DEFAULT 100.00,
    current_balance  REAL NOT NULL DEFAULT 100.00,
    realized_pnl     REAL NOT NULL DEFAULT 0.00,
    unrealized_pnl   REAL NOT NULL DEFAULT 0.00,
    trade_count  INTEGER NOT NULL DEFAULT 0,
    win_count    INTEGER NOT NULL DEFAULT 0,
    loss_count   INTEGER NOT NULL DEFAULT 0,
    portfolio_type TEXT NOT NULL DEFAULT 'general',
    -- Values: stock | sports | general
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    workspace_id INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS virtual_picks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id     INTEGER NOT NULL,
    agent_name   TEXT    NOT NULL,
    pick_type    TEXT    NOT NULL,
    -- Values: stock | sports
    symbol       TEXT,
    -- Stock ticker (AAPL) or team/matchup (Chiefs vs Raiders)
    description  TEXT    NOT NULL,
    -- Human-readable summary of the pick
    direction    TEXT,
    -- stock: buy|sell  sports: home|away|over|under|draw
    amount       REAL    NOT NULL,
    -- dollars wagered / invested
    entry_price  REAL,
    -- stock entry price OR moneyline/spread odds as decimal
    exit_price   REAL,
    -- stock exit price OR payout received
    odds         TEXT,
    -- sports odds string: "-110", "+250", "EV" etc
    confidence   REAL,
    -- 0.0–1.0 AI confidence
    rationale    TEXT,
    -- why the agent made this pick
    status       TEXT    NOT NULL DEFAULT 'open',
    -- Values: open | won | lost | push | closed | cancelled
    pnl          REAL,
    -- realized profit/loss in dollars
    roi_pct      REAL,
    -- (pnl / amount) * 100
    pick_date    INTEGER NOT NULL DEFAULT (unixepoch()),
    close_date   INTEGER,
    game_date    INTEGER,
    -- for sports: when the game/event is
    extra        TEXT,
    -- JSON blob for sport-specific data (spread, total, league, etc)
    workspace_id INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vportfolio_agent  ON virtual_portfolios(agent_id);
CREATE INDEX IF NOT EXISTS idx_vpick_agent        ON virtual_picks(agent_id);
CREATE INDEX IF NOT EXISTS idx_vpick_status       ON virtual_picks(status);
CREATE INDEX IF NOT EXISTS idx_vpick_type         ON virtual_picks(pick_type);
CREATE INDEX IF NOT EXISTS idx_vpick_date         ON virtual_picks(pick_date DESC);
