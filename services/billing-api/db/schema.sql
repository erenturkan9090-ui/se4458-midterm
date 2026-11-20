-- Mobile Provider Billing - PostgreSQL schema
-- Money is stored as integer cents to avoid floating point rounding.

CREATE TABLE IF NOT EXISTS subscribers (
  subscriber_no VARCHAR(20) PRIMARY KEY,
  full_name     VARCHAR(100) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  username      VARCHAR(50) PRIMARY KEY,
  password_hash VARCHAR(100) NOT NULL,
  role          VARCHAR(20) NOT NULL CHECK (role IN ('SUBSCRIBER', 'ADMIN')),
  subscriber_no VARCHAR(20) REFERENCES subscribers(subscriber_no),
  CHECK ((role = 'SUBSCRIBER' AND subscriber_no IS NOT NULL) OR role = 'ADMIN')
);

CREATE TABLE IF NOT EXISTS usage_records (
  id            BIGSERIAL PRIMARY KEY,
  subscriber_no VARCHAR(20) NOT NULL REFERENCES subscribers(subscriber_no),
  year          SMALLINT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month         SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  usage_type    VARCHAR(10) NOT NULL CHECK (usage_type IN ('PHONE', 'INTERNET')),
  amount        INTEGER NOT NULL CHECK (amount > 0), -- minutes or MB
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_period ON usage_records (subscriber_no, year, month);

CREATE TABLE IF NOT EXISTS bills (
  subscriber_no         VARCHAR(20) NOT NULL REFERENCES subscribers(subscriber_no),
  year                  SMALLINT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month                 SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  phone_minutes         INTEGER NOT NULL DEFAULT 0,
  internet_mb           INTEGER NOT NULL DEFAULT 0,
  phone_charge_cents    INTEGER NOT NULL DEFAULT 0,
  internet_charge_cents INTEGER NOT NULL DEFAULT 0,
  total_cents           INTEGER NOT NULL CHECK (total_cents >= 0),
  paid_cents            INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  status                VARCHAR(20) NOT NULL CHECK (status IN ('UNPAID', 'PARTIALLY_PAID', 'PAID')),
  calculated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subscriber_no, year, month)
);

CREATE TABLE IF NOT EXISTS payments (
  transaction_id VARCHAR(64) PRIMARY KEY,          -- duplicate IDs rejected by PK
  subscriber_no  VARCHAR(20) NOT NULL,
  year           SMALLINT NOT NULL,
  month          SMALLINT NOT NULL,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (subscriber_no, year, month) REFERENCES bills(subscriber_no, year, month)
);
