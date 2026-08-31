// One-time migration. Run only against an empty MySQL SIMHQ database.
const { Client } = require('pg');
const mysql = require('mysql2/promise');
const required = ['SOURCE_DATABASE_URL','DB_HOST','DB_NAME','DB_USER','DB_PASSWORD'];
for (const key of required) if (!process.env[key]) throw new Error(`${key} is required`);

async function main() {
  const source = new Client({ connectionString: process.env.SOURCE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const target = await mysql.createConnection({ host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,charset:'utf8mb4' });
  await source.connect();
  const existing = await target.query('SELECT COUNT(*) AS count FROM users');
  if (existing[0][0].count) throw new Error('Target MySQL database is not empty. Create a fresh database before migrating.');
  const maps = { users:new Map(), teams:new Map(), agents:new Map(), sims:new Map() };
  const insert = async (table, row) => { const keys=Object.keys(row).filter(key=>row[key] !== undefined); const [result]=await target.execute(`INSERT INTO ${table} (${keys.map(key=>`\`${key}\``).join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,keys.map(key=>typeof row[key]==='object'&&row[key]!==null?JSON.stringify(row[key]):row[key])); return result.insertId; };
  const rows = async table => (await source.query(`SELECT * FROM ${table}`)).rows;
  await target.beginTransaction();
  try {
    for (const r of await rows('users')) maps.users.set(r.id,await insert('users',{username:r.username,full_name:r.full_name,password_hash:r.password_hash,role:r.role,is_active:r.is_active,created_at:r.created_at,deactivated_at:r.deactivated_at}));
    for (const r of await rows('teams')) maps.teams.set(r.id,await insert('teams',{name:r.name,leader_user_id:maps.users.get(r.leader_user_id)||null,is_active:r.is_active,created_at:r.created_at,deactivated_at:r.deactivated_at}));
    for (const r of await rows('agents')) maps.agents.set(r.id,await insert('agents',{employee_id:r.employee_id,full_name:r.full_name,user_id:maps.users.get(r.user_id)||null,phone:r.phone,status:r.status,created_at:r.created_at,joined_at:r.joined_at,deactivated_at:r.deactivated_at}));
    for (const r of await rows('agent_team_history')) await insert('agent_team_history',{agent_id:maps.agents.get(r.agent_id),team_id:maps.teams.get(r.team_id),team_leader_id:maps.users.get(r.team_leader_id)||null,started_at:r.started_at,ended_at:r.ended_at,changed_by:maps.users.get(r.changed_by),reason:r.reason});
    for (const r of await rows('sim_cards')) maps.sims.set(r.id,await insert('sim_cards',{sim_number:r.sim_number,msisdn:r.msisdn,iccid:r.iccid,provider:r.provider,sim_type:r.sim_type,current_status:r.current_status,current_balance:r.current_balance,added_at:r.added_at,status_reason:r.status_reason,notes:r.notes,is_active:r.is_active,created_by:maps.users.get(r.created_by)}));
    for (const r of await rows('sim_assignments')) await insert('sim_assignments',{sim_id:maps.sims.get(r.sim_id),agent_id:maps.agents.get(r.agent_id),team_id:maps.teams.get(r.team_id)||null,assigned_at:r.assigned_at,removed_at:r.removed_at,assigned_by:maps.users.get(r.assigned_by),removed_by:maps.users.get(r.removed_by)||null,reason:r.reason});
    for (const r of await rows('sim_status_history')) await insert('sim_status_history',{sim_id:maps.sims.get(r.sim_id),previous_status:r.previous_status,new_status:r.new_status,occurred_at:r.occurred_at,changed_by:maps.users.get(r.changed_by),notes:r.notes});
    for (const r of await rows('weekly_sim_usage')) await insert('weekly_sim_usage',{sim_id:maps.sims.get(r.sim_id),agent_id:maps.agents.get(r.agent_id)||null,team_id:maps.teams.get(r.team_id)||null,week_start:r.week_start,week_end:r.week_end,airtime_purchased:r.airtime_purchased,sms_bundle_purchased:r.sms_bundle_purchased,calling_minutes_purchased:r.calling_minutes_purchased,data_bundle_purchased:r.data_bundle_purchased,data_used_mb:r.data_used_mb,sms_used:r.sms_used,notes:r.notes,submitted_by:maps.users.get(r.submitted_by),created_at:r.created_at});
    for (const r of await rows('audit_logs')) await insert('audit_logs',{occurred_at:r.occurred_at,actor_id:maps.users.get(r.actor_id)||null,action:r.action,object_type:r.object_type,object_id:null,new_value:r.new_value});
    for (const r of await rows('equipment_damage_reports')) await insert('equipment_damage_reports',{agent_id:maps.agents.get(r.agent_id),item:r.item,condition:r.condition,damaged_on:r.damaged_on,reported_on:r.reported_on,notes:r.notes,reported_by:maps.users.get(r.reported_by),created_at:r.created_at});
    await target.commit(); console.log('Migration complete. Verify the MySQL app before retiring Render.');
  } catch (error) { await target.rollback(); throw error; }
  finally { await source.end(); await target.end(); }
}
main().catch(error => { console.error(error); process.exit(1); });
