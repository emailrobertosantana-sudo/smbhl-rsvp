-- Step 3 migration
-- 1. event time window  2. contact roles  3. goalie sub pool

ALTER TABLE events ADD COLUMN start_time TEXT;
ALTER TABLE events ADD COLUMN end_time   TEXT;

-- role replaces the is_sub boolean: roster | sub_skater | sub_goalie
ALTER TABLE contacts ADD COLUMN role TEXT NOT NULL DEFAULT 'roster';
UPDATE contacts SET role = 'sub_skater' WHERE is_sub = 1;

-- goalie sub pool
INSERT INTO contacts (player_id,name,email,is_sub,role,token_salt) VALUES ('P0171','Michael Pacheco','trapslash@hotmail.com',1,'sub_goalie','dd6935659681a6e6c2326c25fb2bd8d6') ON CONFLICT(player_id) DO UPDATE SET email=excluded.email, role='sub_goalie', is_sub=1;
INSERT INTO contacts (player_id,name,email,is_sub,role,token_salt) VALUES ('P0011','Alex Chau','alexvochau@gmail.com',1,'sub_goalie','13b5611974353b896696df7efee436ea') ON CONFLICT(player_id) DO UPDATE SET email=excluded.email, role='sub_goalie', is_sub=1;
INSERT INTO contacts (player_id,name,email,is_sub,role,token_salt) VALUES ('P0202','Philippe Charbonneau','philrc.assurances@gmail.com',1,'sub_goalie','a67b1b19068fd3887757b22d58d9784a') ON CONFLICT(player_id) DO UPDATE SET email=excluded.email, role='sub_goalie', is_sub=1;

-- settings: small key/value store (team link salts live here)
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- who can play net: rostered goalies plus the goalie sub pool
ALTER TABLE contacts ADD COLUMN is_goalie INTEGER NOT NULL DEFAULT 0;
UPDATE contacts SET is_goalie = 1 WHERE player_id = 'P0031';  -- Anthony Saragoca
UPDATE contacts SET is_goalie = 1 WHERE player_id = 'P0089';  -- Francois Taillefer
UPDATE contacts SET is_goalie = 1 WHERE player_id = 'P0133';  -- JP Flood
UPDATE contacts SET is_goalie = 1 WHERE player_id = 'P0229';  -- Sean Pichette
UPDATE contacts SET is_goalie = 1 WHERE player_id = 'P0260';  -- Tyler Myrans
UPDATE contacts SET is_goalie = 1 WHERE role = 'sub_goalie';
