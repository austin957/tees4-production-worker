export const workerSchema = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  identity TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  available_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  claim_token TEXT,
  lease_until INTEGER,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, available_at, created_at);
CREATE TABLE IF NOT EXISTS mockupify_exports (
  id TEXT PRIMARY KEY,
  identity TEXT UNIQUE NOT NULL,
  export_ref TEXT UNIQUE,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mockupify_export_preparations (
  correlation_id TEXT PRIMARY KEY,
  spreadsheet_id TEXT NOT NULL,
  product_sku TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  body TEXT NOT NULL,
  UNIQUE(spreadsheet_id, product_sku)
);
CREATE TABLE IF NOT EXISTS mockupify_export_reservations (
  product_sku TEXT PRIMARY KEY,
  export_id TEXT NOT NULL REFERENCES mockupify_exports(id)
);
CREATE TABLE IF NOT EXISTS mockupify_writer_journal (
  correlation_id TEXT PRIMARY KEY,
  product_sku TEXT UNIQUE NOT NULL,
  batch_id INTEGER UNIQUE,
  design_id INTEGER UNIQUE,
  export_id INTEGER UNIQUE,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mockupify_writer_events (
  sequence INTEGER PRIMARY KEY,
  correlation_id TEXT NOT NULL REFERENCES mockupify_writer_journal(correlation_id),
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mockupify_writer_event_history
  ON mockupify_writer_events(correlation_id, sequence);
CREATE TABLE IF NOT EXISTS mockupify_request_budget (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  new_export INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mockupify_retry_after (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS master_input_fixtures (
  row_number INTEGER PRIMARY KEY,
  cells TEXT NOT NULL,
  fixture TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS master_input_product_sku ON master_input_fixtures(json_extract(cells, '$[7]'));
CREATE TABLE IF NOT EXISTS shopify_products (
  id TEXT PRIMARY KEY,
  artwork_sku TEXT NOT NULL,
  product_sku TEXT NOT NULL,
  fixture TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shopify_product_bindings ON shopify_products(product_sku);
CREATE TABLE IF NOT EXISTS shopify_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES shopify_products(id),
  size TEXT NOT NULL,
  color TEXT NOT NULL,
  sku TEXT
);
CREATE INDEX IF NOT EXISTS shopify_variant_product ON shopify_variants(product_id);
CREATE TABLE IF NOT EXISTS effects (
  key TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  request TEXT NOT NULL,
  details TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS product_bindings (
  id TEXT PRIMARY KEY,
  spreadsheet_id TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  product_sku TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'stale')),
  created_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS active_binding_row ON product_bindings(spreadsheet_id, row_number)
  WHERE status IN ('proposed', 'approved');
CREATE UNIQUE INDEX IF NOT EXISTS active_binding_product ON product_bindings(shop_id, product_id)
  WHERE status IN ('proposed', 'approved');
CREATE UNIQUE INDEX IF NOT EXISTS active_binding_sku ON product_bindings(spreadsheet_id, product_sku)
  WHERE status IN ('proposed', 'approved');
CREATE TABLE IF NOT EXISTS product_binding_events (
  sequence INTEGER PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES product_bindings(id),
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS binding_events_history ON product_binding_events(binding_id, sequence);
CREATE TRIGGER IF NOT EXISTS binding_events_no_update BEFORE UPDATE ON product_binding_events
  BEGIN SELECT RAISE(ABORT, 'Product binding history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS binding_events_no_delete BEFORE DELETE ON product_binding_events
  BEGIN SELECT RAISE(ABORT, 'Product binding history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS binding_events_no_replace BEFORE INSERT ON product_binding_events
  WHEN EXISTS (SELECT 1 FROM product_binding_events WHERE sequence = NEW.sequence)
  BEGIN SELECT RAISE(ABORT, 'Product binding history is append-only'); END;
CREATE TABLE IF NOT EXISTS post_hextom_alerts (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES product_bindings(id),
  first_seen_at INTEGER NOT NULL
);
`;
