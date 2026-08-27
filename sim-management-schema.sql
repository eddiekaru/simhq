-- SIMHQ PostgreSQL foundation: append-only history, soft deactivation, RBAC.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE user_role AS ENUM ('admin','supervisor','team_leader','agent');
CREATE TYPE agent_state AS ENUM ('active','suspended','left_organization');
CREATE TYPE sim_state AS ENUM ('available','in_use','blocked','lost','damaged','suspended','disposed','returned','pending_activation');('available','in_use','blocked','lost','damaged','suspended','disposed','returned','pending_activation');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username citext UNIQUE NOT NULL,
  password_hash text NOT NULL, role user_role NOT NULL, is_active boolean NOT NULL DEFAULT true,
  mfa_secret_encrypted text, created_at timestamptz NOT NULL DEFAULT now(), deactivated_at timestamptz
);
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE NOT NULL,
  leader_user_id uuid REFERENCES users(id), is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), deactivated_at timestamptz
);
CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id text UNIQUE NOT NULL, full_name text NOT NULL,
  user_id uuid UNIQUE REFERENCES users(id), phone text, status agent_state NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(), joined_at date, deactivated_at timestamptz
);
CREATE TABLE agent_team_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid NOT NULL REFERENCES agents(id),
  team_id uuid NOT NULL REFERENCES teams(id), team_leader_id uuid REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  changed_by uuid NOT NULL REFERENCES users(id), reason text,
  CHECK (ended_at IS NULL OR ended_at > started_at)
);
CREATE UNIQUE INDEX one_active_team_per_agent ON agent_team_history(agent_id) WHERE ended_at IS NULL;

CREATE TABLE sim_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sim_number text UNIQUE NOT NULL, msisdn text UNIQUE,
  iccid text UNIQUE, imsi text UNIQUE, provider text NOT NULL, sim_type text, current_status sim_state NOT NULL DEFAULT 'available',
  current_balance numeric(14,2), added_at timestamptz NOT NULL DEFAULT now(), activated_at timestamptz,
  blocked_at timestamptz, disposed_at timestamptz, status_reason text, notes text, last_activity_at timestamptz,
  is_active boolean NOT NULL DEFAULT true, created_by uuid NOT NULL REFERENCES users(id)
);
CREATE TABLE sim_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sim_id uuid NOT NULL REFERENCES sim_cards(id),
  agent_id uuid NOT NULL REFERENCES agents(id), team_id uuid REFERENCES teams(id), assigned_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz, assigned_by uuid NOT NULL REFERENCES users(id), removed_by uuid REFERENCES users(id), reason text,
  CHECK (removed_at IS NULL OR removed_at > assigned_at)
);
CREATE UNIQUE INDEX one_active_assignment_per_sim ON sim_assignments(sim_id) WHERE removed_at IS NULL;
CREATE INDEX sim_assignment_agent_history ON sim_assignments(agent_id, assigned_at DESC);
CREATE TABLE sim_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sim_id uuid NOT NULL REFERENCES sim_cards(id),
  previous_status sim_state, new_status sim_state NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid NOT NULL REFERENCES users(id), agent_id uuid REFERENCES agents(id), team_id uuid REFERENCES teams(id), reason text, notes text
);
CREATE INDEX sim_status_timeline ON sim_status_history(sim_id, occurred_at DESC);
CREATE TABLE weekly_sim_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sim_id uuid NOT NULL REFERENCES sim_cards(id), agent_id uuid REFERENCES agents(id), team_id uuid REFERENCES teams(id),
  week_start date NOT NULL, week_end date NOT NULL, airtime_purchased numeric(14,2) NOT NULL DEFAULT 0,
  sms_bundle_purchased numeric(14,2) NOT NULL DEFAULT 0, calling_minutes_purchased numeric(14,2) NOT NULL DEFAULT 0,
  data_bundle_purchased numeric(14,2) NOT NULL DEFAULT 0, data_used_mb numeric(14,2), sms_used numeric(14,2),
  calling_minutes_used numeric(14,2), notes text, submitted_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (week_end >= week_start), UNIQUE(sim_id, week_start)
);
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY, occurred_at timestamptz NOT NULL DEFAULT now(), actor_id uuid REFERENCES users(id),
  action text NOT NULL, object_type text NOT NULL, object_id uuid, previous_value jsonb, new_value jsonb, ip inet, device text
);
CREATE INDEX audit_object_history ON audit_logs(object_type, object_id, occurred_at DESC);

-- Required service transaction: lock SIM, close any active assignment, insert the next assignment,
-- append status history, update the SIM snapshot, then append audit_logs. Never UPDATE history rows.
-- REVOKE UPDATE, DELETE ON sim_assignments, sim_status_history, agent_team_history, weekly_sim_usage, audit_logs FROM app_user;
