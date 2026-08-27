-- Run once on the existing SIMHQ database after the initial schema.
CREATE TABLE IF NOT EXISTS equipment_damage_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id), item text NOT NULL,
  condition text NOT NULL, damaged_on date NOT NULL, reported_on date NOT NULL DEFAULT current_date,
  notes text NOT NULL, reported_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
