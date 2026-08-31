const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
// Render Postgres requires TLS for its database URLs.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const app = express();
app.use(express.json());
app.use(express.static(__dirname));
const validStates = new Set(['available','in_use','blocked','lost','damaged','suspended','disposed','returned','pending_activation']);

async function seedAdmin() {
  // Kept here as a safe compatibility migration for deployments created before
  // equipment damage reporting was added.
  await pool.query(`CREATE TABLE IF NOT EXISTS equipment_damage_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid NOT NULL REFERENCES agents(id),
    item text NOT NULL, condition text NOT NULL, damaged_on date NOT NULL,
    reported_on date NOT NULL DEFAULT current_date, notes text NOT NULL,
    reported_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
  )`);
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return;
  const found = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
  if (!found.rowCount) await pool.query(
    "INSERT INTO users (username, full_name, password_hash, role) VALUES ($1,$2,$3,'admin')",
    [username, process.env.ADMIN_NAME || 'Administrator', await bcrypt.hash(password, 12)]);
}
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Please sign in again.' }); }
}
function canWrite(req, res, next) {
  if (req.user.role === 'agent') return res.status(403).json({ error: 'Read-only access.' });
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
  next();
}
async function teamLeaderOwnsTeam(req, teamId) {
  if (req.user.role !== 'team_leader') return true;
  const r = await pool.query('SELECT 1 FROM teams WHERE id=$1 AND leader_user_id=$2 AND is_active=true', [teamId, req.user.id]);
  return r.rowCount > 0;
}
async function teamLeaderOwnsAgent(req, agentId) {
  if (req.user.role !== 'team_leader') return true;
  const r = await pool.query(`SELECT 1 FROM agent_team_history h JOIN teams t ON t.id=h.team_id WHERE h.agent_id=$1 AND h.ended_at IS NULL AND t.leader_user_id=$2 AND t.is_active=true`, [agentId, req.user.id]);
  return r.rowCount > 0;
}
async function audit(client, actorId, action, objectType, objectId, value) {
  await client.query('INSERT INTO audit_logs(actor_id,action,object_type,object_id,new_value) VALUES($1,$2,$3,$4,$5)', [actorId, action, objectType, objectId || null, value || null]);
}
app.post('/api/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query('SELECT id,username,full_name,role,password_hash FROM users WHERE username=$1 AND is_active=true', [username]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) return res.status(401).json({ error: 'Incorrect username or password.' });
    const token = jwt.sign({ id:user.id, username:user.username, name:user.full_name, role:user.role }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id:user.id, username:user.username, name:user.full_name, role:user.role } });
  } catch (e) { next(e); }
});
app.get('/api/bootstrap', auth, async (req, res, next) => {
  try {
    const [sims, agents, teams, usage, logs, users, damageReports] = await Promise.all([
      pool.query(`SELECT s.id,s.sim_number AS number,s.msisdn,s.iccid,s.provider AS network,s.sim_type AS type,s.current_status AS status,s.current_balance AS balance,s.notes,s.added_at AS "createdAt",a.assigned_at AS "assignedAt",ag.full_name AS agent,ag.employee_id AS "agentId",t.name AS team
        FROM sim_cards s LEFT JOIN LATERAL (SELECT * FROM sim_assignments WHERE sim_id=s.id AND removed_at IS NULL ORDER BY assigned_at DESC LIMIT 1) a ON true LEFT JOIN agents ag ON ag.id=a.agent_id LEFT JOIN teams t ON t.id=a.team_id ORDER BY s.added_at DESC`),
      pool.query(`SELECT a.id,a.full_name AS name,a.employee_id AS "employeeId",a.phone,a.status,t.name AS team,COALESCE(history_leader.full_name,current_leader.full_name) AS "teamLeader" FROM agents a LEFT JOIN LATERAL (SELECT * FROM agent_team_history WHERE agent_id=a.id AND ended_at IS NULL LIMIT 1) h ON true LEFT JOIN teams t ON t.id=h.team_id LEFT JOIN users history_leader ON history_leader.id=h.team_leader_id LEFT JOIN users current_leader ON current_leader.id=t.leader_user_id WHERE $1 <> 'team_leader' OR t.leader_user_id=$2 ORDER BY a.full_name`, [req.user.role, req.user.id]),
      pool.query(`SELECT t.id,t.name,t.is_active AS active,t.created_at AS "createdAt",t.leader_user_id AS "leaderUserId",u.full_name AS leader
        FROM teams t LEFT JOIN users u ON u.id=t.leader_user_id ORDER BY t.name`),
      pool.query(`SELECT u.id,u.week_start AS week,s.sim_number AS number,COALESCE(a.full_name,'Unassigned') AS agent,COALESCE(t.name,'Inventory') AS team,u.airtime_purchased AS airtime,u.data_used_mb AS data,(u.airtime_purchased+u.sms_bundle_purchased+u.calling_minutes_purchased+u.data_bundle_purchased) AS total,actor.full_name AS by FROM weekly_sim_usage u JOIN sim_cards s ON s.id=u.sim_id LEFT JOIN agents a ON a.id=u.agent_id LEFT JOIN teams t ON t.id=u.team_id JOIN users actor ON actor.id=u.submitted_by ORDER BY u.created_at DESC`),
      pool.query(`SELECT l.occurred_at AS at,l.action,l.object_type AS obj,COALESCE(l.new_value->>'note','') AS note,COALESCE(u.full_name,'System') AS by FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id ORDER BY l.occurred_at DESC LIMIT 100`),
      req.user.role === 'admin' ? pool.query('SELECT id,username,full_name AS name,role,is_active AS active,created_at AS "createdAt" FROM users ORDER BY created_at') : Promise.resolve({ rows: [] }),
      pool.query(`SELECT r.id,a.full_name AS agent,r.item,r.condition,r.damaged_on AS "damagedOn",r.reported_on AS "reportedOn",r.notes,r.created_at AS "createdAt" FROM equipment_damage_reports r JOIN agents a ON a.id=r.agent_id ORDER BY r.created_at DESC`)
    ]);
    const histories = await pool.query(`
      SELECT h.sim_id,h.occurred_at AS at,('Status changed ' || COALESCE(h.previous_status::text,'new') || ' → ' || h.new_status::text) AS action,h.notes AS note,u.full_name AS by
      FROM sim_status_history h LEFT JOIN users u ON u.id=h.changed_by
      UNION ALL
      SELECT a.sim_id,a.assigned_at AS at,CASE WHEN a.removed_at IS NULL THEN 'Assigned to ' || ag.full_name ELSE 'Previous assignment closed' END AS action,a.reason AS note,u.full_name AS by
      FROM sim_assignments a JOIN agents ag ON ag.id=a.agent_id LEFT JOIN users u ON u.id=a.assigned_by
      ORDER BY at DESC`);
    const bySim = {}; histories.rows.forEach(h => (bySim[h.sim_id] ||= []).push(h));
    res.json({ sims:sims.rows.map(s => ({...s, history:bySim[s.id] || []})), agents:agents.rows, teams:teams.rows, usage:usage.rows, audit:logs.rows, users:users.rows, damageReports:damageReports.rows });
  } catch (e) { next(e); }
});
app.post('/api/sims', auth, canWrite, async (req,res,next) => {
  const { number, msisdn, iccid, network='Unspecified', type, status='available', notes='' } = req.body;
  if (!number || !validStates.has(status)) return res.status(400).json({error:'SIM number and a valid status are required.'});
  const c = await pool.connect(); try { await c.query('BEGIN'); const q=await c.query('INSERT INTO sim_cards(sim_number,msisdn,iccid,provider,sim_type,current_status,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[number,msisdn||null,iccid||null,network,type||null,status,notes,req.user.id]); await c.query('INSERT INTO sim_status_history(sim_id,new_status,changed_by,notes) VALUES($1,$2,$3,$4)',[q.rows[0].id,status,req.user.id,notes]); await audit(c,req.user.id,'SIM created','sim_card',q.rows[0].id,{note:notes}); await c.query('COMMIT'); res.status(201).json(q.rows[0]); } catch(e) { await c.query('ROLLBACK'); next(e); } finally {c.release();}
});
app.post('/api/sims/:id/status', auth, canWrite, async (req,res,next) => {
  const { status, note='' }=req.body; if(!validStates.has(status)) return res.status(400).json({error:'Invalid status.'});
  const c=await pool.connect(); try { await c.query('BEGIN'); const old=await c.query('SELECT current_status FROM sim_cards WHERE id=$1 FOR UPDATE',[req.params.id]); if(!old.rowCount) throw Object.assign(new Error('SIM not found'),{status:404}); await c.query('UPDATE sim_cards SET current_status=$1,status_reason=$2 WHERE id=$3',[status,note,req.params.id]); await c.query('INSERT INTO sim_status_history(sim_id,previous_status,new_status,changed_by,notes) VALUES($1,$2,$3,$4,$5)',[req.params.id,old.rows[0].current_status,status,req.user.id,note]); await audit(c,req.user.id,'SIM status updated','sim_card',req.params.id,{note}); await c.query('COMMIT'); res.json({ok:true}); }catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()}
});
app.post('/api/usage', auth, canWrite, async (req,res,next) => { const c=await pool.connect(); try { const b=req.body; await c.query('BEGIN'); const q=await c.query(`INSERT INTO weekly_sim_usage(sim_id,agent_id,team_id,week_start,week_end,airtime_purchased,sms_bundle_purchased,calling_minutes_purchased,data_bundle_purchased,data_used_mb,sms_used,notes,submitted_by) SELECT s.id,a.agent_id,a.team_id,$2,$2::date+6,$3,$4,$5,$6,$7,$8,$9,$10 FROM sim_cards s LEFT JOIN LATERAL(SELECT agent_id,team_id FROM sim_assignments WHERE sim_id=s.id AND removed_at IS NULL LIMIT 1)a ON true WHERE s.id=$1 RETURNING id`,[b.sim,b.week,b.airtime||0,b.sms||0,b.calls||0,b.bundle||0,b.data||0,b.smsUsed||0,b.note||'',req.user.id]); if(!q.rowCount) throw Object.assign(new Error('SIM not found.'),{status:404}); await audit(c,req.user.id,'Weekly usage submitted','sim_card',b.sim,{note:`Week starting ${b.week}`}); await c.query('COMMIT'); res.status(201).json(q.rows[0]); }catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()} });
app.post('/api/teams', auth, canWrite, async (req,res,next) => { const c=await pool.connect(); try { const b=req.body; if(!b.name) return res.status(400).json({error:'Team name is required.'}); await c.query('BEGIN'); if(b.leaderUserId){const leader=await c.query("SELECT id FROM users WHERE id=$1 AND role='team_leader' AND is_active=true",[b.leaderUserId]); if(!leader.rowCount)return res.status(400).json({error:'Selected team leader must be an active Team Leader user.'});} const r=await c.query('INSERT INTO teams(name,leader_user_id) VALUES($1,$2) RETURNING id',[b.name,b.leaderUserId||null]); await audit(c,req.user.id,'Team created','team',r.rows[0].id,{note:`${b.name}${b.leaderUserId?' · Team leader assigned':''}`}); await c.query('COMMIT'); res.status(201).json(r.rows[0]); }catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()} });
app.post('/api/agents', auth, canWrite, async (req,res,next) => { const c=await pool.connect(); try { const b=req.body; if(!b.name||!b.employeeId||!b.teamId) return res.status(400).json({error:'Name, employee ID, and team are required.'}); await c.query('BEGIN'); const team=await c.query('SELECT leader_user_id FROM teams WHERE id=$1 AND is_active=true',[b.teamId]); if(!team.rowCount)throw Object.assign(new Error('Choose an active team.'),{status:400}); const a=await c.query('INSERT INTO agents(employee_id,full_name,phone,status) VALUES($1,$2,$3,$4) RETURNING id',[b.employeeId,b.name,b.phone||null,b.status||'active']); await c.query('INSERT INTO agent_team_history(agent_id,team_id,team_leader_id,changed_by,reason) VALUES($1,$2,$3,$4,$5)',[a.rows[0].id,b.teamId,team.rows[0].leader_user_id,req.user.id,b.note||'Agent added']); await audit(c,req.user.id,'Agent created','agent',a.rows[0].id,{note:b.note||'',teamId:b.teamId,teamLeaderId:team.rows[0].leader_user_id}); await c.query('COMMIT');res.status(201).json(a.rows[0]); }catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()} });
app.post('/api/sims/:id/assign', auth, canWrite, async (req,res,next) => { const c=await pool.connect(); try { const b=req.body;if(!b.agentId||!b.teamId)return res.status(400).json({error:'Agent and team are required.'});await c.query('BEGIN');await c.query('SELECT id FROM sim_cards WHERE id=$1 FOR UPDATE',[req.params.id]);await c.query('UPDATE sim_assignments SET removed_at=now(),removed_by=$1,reason=$2 WHERE sim_id=$3 AND removed_at IS NULL',[req.user.id,b.note||'Reassigned',req.params.id]);await c.query('INSERT INTO sim_assignments(sim_id,agent_id,team_id,assigned_by,reason) VALUES($1,$2,$3,$4,$5)',[req.params.id,b.agentId,b.teamId,req.user.id,b.note||'']);await c.query("UPDATE sim_cards SET current_status='in_use' WHERE id=$1",[req.params.id]);await audit(c,req.user.id,'SIM assigned','sim_card',req.params.id,{note:b.note||''});await c.query('COMMIT');res.json({ok:true});}catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()} });
app.post('/api/damage-reports', auth, canWrite, async (req,res,next) => { const c=await pool.connect(); try { const b=req.body;if(!b.agentId||!b.item||!b.condition||!b.damagedOn||!b.notes)return res.status(400).json({error:'Complete the damage report.'});await c.query('BEGIN');const r=await c.query('INSERT INTO equipment_damage_reports(agent_id,item,condition,damaged_on,reported_on,notes,reported_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[b.agentId,b.item,b.condition,b.damagedOn,b.reportedOn||b.damagedOn,b.notes,req.user.id]);await audit(c,req.user.id,'Equipment damage reported','agent',b.agentId,{note:`${b.item} · ${b.condition}`});await c.query('COMMIT');res.status(201).json(r.rows[0]); }catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()} });
app.post('/api/users', auth, adminOnly, async (req,res,next) => { try { if(req.user.role!=='admin')return res.status(403).json({error:'Administrator access is required.'}); const b=req.body;if(!b.username||!b.name||!b.password||!b.role)return res.status(400).json({error:'Complete all user fields.'});const r=await pool.query('INSERT INTO users(username,full_name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id',[b.username,b.name,await bcrypt.hash(b.password,12),b.role]);res.status(201).json(r.rows[0]); }catch(e){next(e)} });
app.put('/api/users/:id', auth, adminOnly, async (req,res,next) => { const c=await pool.connect(); try { if(req.user.role!=='admin')return res.status(403).json({error:'Administrator access is required.'});const b=req.body;if(!b.username||!b.name||!b.role)return res.status(400).json({error:'Complete all user fields.'});await c.query('BEGIN');const r=await c.query(`UPDATE users SET username=$1,full_name=$2,role=$3,is_active=$4,password_hash=COALESCE($5,password_hash) WHERE id=$6 RETURNING id`,[b.username,b.name,b.role,b.active!==false,b.password?await bcrypt.hash(b.password,12):null,req.params.id]);if(!r.rowCount)throw Object.assign(new Error('User not found.'),{status:404});await audit(c,req.user.id,'User login updated','user',req.params.id,{note:b.username});await c.query('COMMIT');res.json({ok:true}); }catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()} });
app.delete('/api/users/:id', auth, adminOnly, async (req,res,next) => { const c=await pool.connect();try {if(req.user.role!=='admin')return res.status(403).json({error:'Administrator access is required.'});if(req.user.id===req.params.id)return res.status(400).json({error:'You cannot deactivate your own account.'});await c.query('BEGIN');const r=await c.query('UPDATE users SET is_active=false,deactivated_at=now() WHERE id=$1 RETURNING id',[req.params.id]);if(!r.rowCount)throw Object.assign(new Error('User not found.'),{status:404});await audit(c,req.user.id,'User deactivated','user',req.params.id,{});await c.query('COMMIT');res.json({ok:true});}catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()} });
app.put('/api/teams/:id', auth, canWrite, async (req,res,next) => { const c=await pool.connect();try { const b=req.body;if(!b.name)return res.status(400).json({error:'Team name is required.'});await c.query('BEGIN');if(b.leaderUserId){const leader=await c.query("SELECT id FROM users WHERE id=$1 AND role='team_leader' AND is_active=true",[b.leaderUserId]);if(!leader.rowCount)return res.status(400).json({error:'Selected team leader must be an active Team Leader user.'});}const r=await c.query('UPDATE teams SET name=$1,leader_user_id=$2,is_active=$3,deactivated_at=CASE WHEN $3 THEN NULL ELSE now() END WHERE id=$4 RETURNING id',[b.name,b.leaderUserId||null,b.active!==false,req.params.id]);if(!r.rowCount)throw Object.assign(new Error('Team not found.'),{status:404});await audit(c,req.user.id,'Team updated','team',req.params.id,{note:`${b.name}${b.leaderUserId?' · Team leader assigned':''}`});await c.query('COMMIT');res.json({ok:true}); }catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()} });
app.put('/api/agents/:id', auth, canWrite, async (req,res,next) => { const c=await pool.connect();try{const b=req.body;if(!b.name||!b.employeeId||!b.teamId)return res.status(400).json({error:'Name, employee ID, and team are required.'});await c.query('BEGIN');const current=await c.query('SELECT h.team_id FROM agent_team_history h WHERE h.agent_id=$1 AND h.ended_at IS NULL FOR UPDATE',[req.params.id]);if(!current.rowCount)throw Object.assign(new Error('Agent not found or has no active team.'),{status:404});const team=await c.query('SELECT leader_user_id FROM teams WHERE id=$1 AND is_active=true',[b.teamId]);if(!team.rowCount)throw Object.assign(new Error('Choose an active team.'),{status:400});const updated=await c.query('UPDATE agents SET full_name=$1,employee_id=$2,phone=$3,status=$4 WHERE id=$5 RETURNING id',[b.name,b.employeeId,b.phone||null,b.status||'active',req.params.id]);if(!updated.rowCount)throw Object.assign(new Error('Agent not found.'),{status:404});if(current.rows[0].team_id!==b.teamId){await c.query('UPDATE agent_team_history SET ended_at=now() WHERE agent_id=$1 AND ended_at IS NULL',[req.params.id]);await c.query('INSERT INTO agent_team_history(agent_id,team_id,team_leader_id,changed_by,reason) VALUES($1,$2,$3,$4,$5)',[req.params.id,b.teamId,team.rows[0].leader_user_id,req.user.id,b.note||'Updated from agent profile']);await c.query('UPDATE sim_assignments SET team_id=$1 WHERE agent_id=$2 AND removed_at IS NULL',[b.teamId,req.params.id]);}await audit(c,req.user.id,'Agent updated','agent',req.params.id,{note:b.note||'',teamId:b.teamId,teamLeaderId:team.rows[0].leader_user_id});await c.query('COMMIT');res.json({ok:true});}catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()} });
app.post('/api/agents/:id/transfer', auth, canWrite, async (req,res,next) => { const c=await pool.connect();try{const b=req.body;if(!b.teamId)return res.status(400).json({error:'Choose a team.'});await c.query('BEGIN');const team=await c.query('SELECT leader_user_id FROM teams WHERE id=$1 AND is_active=true',[b.teamId]);if(!team.rowCount)throw Object.assign(new Error('Choose an active team.'),{status:400});await c.query('UPDATE agent_team_history SET ended_at=now() WHERE agent_id=$1 AND ended_at IS NULL',[req.params.id]);await c.query('INSERT INTO agent_team_history(agent_id,team_id,team_leader_id,changed_by,reason) VALUES($1,$2,$3,$4,$5)',[req.params.id,b.teamId,team.rows[0].leader_user_id,req.user.id,b.note||'Transferred']);await c.query('UPDATE sim_assignments SET team_id=$1 WHERE agent_id=$2 AND removed_at IS NULL',[b.teamId,req.params.id]);await audit(c,req.user.id,'Agent transferred','agent',req.params.id,{note:b.note||'',teamId:b.teamId,teamLeaderId:team.rows[0].leader_user_id});await c.query('COMMIT');res.json({ok:true});}catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()} });
app.post('/api/agents/deactivate', auth, canWrite, async (req,res,next) => { const c=await pool.connect();try{const ids=[...new Set(req.body?.ids||[])];if(!ids.length)return res.status(400).json({error:'Select at least one agent.'});await c.query('BEGIN');const result=await c.query("UPDATE agents SET status='left_organization',deactivated_at=now() WHERE id=ANY($1::uuid[]) AND status<>'left_organization' RETURNING id",[ids]);for(const row of result.rows)await audit(c,req.user.id,'Agent deactivated','agent',row.id,{note:'Bulk deactivation'});await c.query('COMMIT');res.json({count:result.rowCount});}catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()} });
app.delete('/api/agents/:id', auth, canWrite, async (req,res,next) => { const c=await pool.connect();try {await c.query('BEGIN');const r=await c.query("UPDATE agents SET status='left_organization',deactivated_at=now() WHERE id=$1 RETURNING id",[req.params.id]);if(!r.rowCount)throw Object.assign(new Error('Agent not found.'),{status:404});await audit(c,req.user.id,'Agent deactivated','agent',req.params.id,{});await c.query('COMMIT');res.json({ok:true}); }catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()} });
app.post('/api/agents/:id/numbers', auth, canWrite, async (req,res,next) => { const c=await pool.connect();try{const b=req.body;if(!b.number||!validStates.has(b.status||'in_use'))return res.status(400).json({error:'A phone number and valid status are required.'});await c.query('BEGIN');const a=await c.query('SELECT h.team_id FROM agent_team_history h WHERE h.agent_id=$1 AND h.ended_at IS NULL',[req.params.id]);if(!a.rowCount)throw Error('Agent has no active team.');const s=await c.query("INSERT INTO sim_cards(sim_number,provider,sim_type,current_status,notes,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[b.number,b.network||'Unspecified',b.type||null,b.status||'in_use',b.notes||'',req.user.id]);await c.query('INSERT INTO sim_assignments(sim_id,agent_id,team_id,assigned_by,reason) VALUES($1,$2,$3,$4,$5)',[s.rows[0].id,req.params.id,a.rows[0].team_id,req.user.id,b.notes||'Added from agent']);await c.query('INSERT INTO sim_status_history(sim_id,new_status,changed_by,notes) VALUES($1,$2,$3,$4)',[s.rows[0].id,b.status||'in_use',req.user.id,b.notes||'Added from agent']);await audit(c,req.user.id,'Phone number added','sim_card',s.rows[0].id,{note:b.notes||''});await c.query('COMMIT');res.status(201).json(s.rows[0]);}catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()} });
app.get('*', (_,res) => res.sendFile(path.join(__dirname,'index.html')));
app.use((err,req,res,next) => { console.error(err); res.status(err.status || 500).json({error: err.code === '23505' ? 'That record already exists.' : err.message || 'Server error.'}); });
seedAdmin().then(() => app.listen(process.env.PORT || 10000, '0.0.0.0', () => console.log('SIMHQ running'))).catch(e => { console.error(e); process.exit(1); });
