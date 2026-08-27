const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const app = express();
app.use(express.json());
app.use(express.static(__dirname));
const validStates = new Set(['available','in_use','blocked','lost','damaged','suspended','disposed','returned','pending_activation']);

async function seedAdmin() {
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
    const [sims, agents, teams, usage, logs] = await Promise.all([
      pool.query(`SELECT s.id,s.sim_number AS number,s.msisdn,s.iccid,s.provider AS network,s.sim_type AS type,s.current_status AS status,s.current_balance AS balance,s.added_at AS "createdAt",a.assigned_at AS "assignedAt",ag.full_name AS agent,ag.employee_id AS "agentId",t.name AS team
        FROM sim_cards s LEFT JOIN LATERAL (SELECT * FROM sim_assignments WHERE sim_id=s.id AND removed_at IS NULL ORDER BY assigned_at DESC LIMIT 1) a ON true LEFT JOIN agents ag ON ag.id=a.agent_id LEFT JOIN teams t ON t.id=a.team_id ORDER BY s.added_at DESC`),
      pool.query(`SELECT a.id,a.full_name AS name,a.employee_id AS "employeeId",a.phone,a.status,t.name AS team FROM agents a LEFT JOIN LATERAL (SELECT * FROM agent_team_history WHERE agent_id=a.id AND ended_at IS NULL LIMIT 1) h ON true LEFT JOIN teams t ON t.id=h.team_id ORDER BY a.full_name`),
      pool.query('SELECT id,name,is_active AS active,created_at AS "createdAt" FROM teams ORDER BY name'),
      pool.query(`SELECT u.id,u.week_start AS week,s.sim_number AS number,COALESCE(a.full_name,'Unassigned') AS agent,COALESCE(t.name,'Inventory') AS team,u.airtime_purchased AS airtime,u.data_used_mb AS data,(u.airtime_purchased+u.sms_bundle_purchased+u.calling_minutes_purchased+u.data_bundle_purchased) AS total,actor.full_name AS by FROM weekly_sim_usage u JOIN sim_cards s ON s.id=u.sim_id LEFT JOIN agents a ON a.id=u.agent_id LEFT JOIN teams t ON t.id=u.team_id JOIN users actor ON actor.id=u.submitted_by ORDER BY u.created_at DESC`),
      pool.query(`SELECT l.occurred_at AS at,l.action,l.object_type AS obj,COALESCE(l.new_value->>'note','') AS note,COALESCE(u.full_name,'System') AS by FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id ORDER BY l.occurred_at DESC LIMIT 100`)
    ]);
    const histories = await pool.query(`SELECT sim_id, occurred_at AS at, ('Status changed ' || COALESCE(previous_status::text,'new') || ' → ' || new_status::text) AS action, notes AS note FROM sim_status_history ORDER BY occurred_at DESC`);
    const bySim = {}; histories.rows.forEach(h => (bySim[h.sim_id] ||= []).push(h));
    res.json({ sims:sims.rows.map(s => ({...s, history:bySim[s.id] || []})), agents:agents.rows, teams:teams.rows, usage:usage.rows, audit:logs.rows });
  } catch (e) { next(e); }
});
app.post('/api/sims', auth, canWrite, async (req,res,next) => {
  const { number, msisdn, iccid, network, type, status='available', notes='' } = req.body;
  if (!number || !network || !validStates.has(status)) return res.status(400).json({error:'SIM number, network, and a valid status are required.'});
  const c = await pool.connect(); try { await c.query('BEGIN'); const q=await c.query('INSERT INTO sim_cards(sim_number,msisdn,iccid,provider,sim_type,current_status,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[number,msisdn||null,iccid||null,network,type||null,status,notes,req.user.id]); await c.query('INSERT INTO sim_status_history(sim_id,new_status,changed_by,notes) VALUES($1,$2,$3,$4)',[q.rows[0].id,status,req.user.id,notes]); await audit(c,req.user.id,'SIM created','sim_card',q.rows[0].id,{note:notes}); await c.query('COMMIT'); res.status(201).json(q.rows[0]); } catch(e) { await c.query('ROLLBACK'); next(e); } finally {c.release();}
});
app.post('/api/sims/:id/status', auth, canWrite, async (req,res,next) => {
  const { status, note='' }=req.body; if(!validStates.has(status)) return res.status(400).json({error:'Invalid status.'});
  const c=await pool.connect(); try { await c.query('BEGIN'); const old=await c.query('SELECT current_status FROM sim_cards WHERE id=$1 FOR UPDATE',[req.params.id]); if(!old.rowCount) throw Object.assign(new Error('SIM not found'),{status:404}); await c.query('UPDATE sim_cards SET current_status=$1,status_reason=$2 WHERE id=$3',[status,note,req.params.id]); await c.query('INSERT INTO sim_status_history(sim_id,previous_status,new_status,changed_by,notes) VALUES($1,$2,$3,$4,$5)',[req.params.id,old.rows[0].current_status,status,req.user.id,note]); await audit(c,req.user.id,'SIM status updated','sim_card',req.params.id,{note}); await c.query('COMMIT'); res.json({ok:true}); }catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()}
});
app.post('/api/usage', auth, canWrite, async (req,res,next) => { try { const b=req.body; const q=await pool.query(`INSERT INTO weekly_sim_usage(sim_id,agent_id,team_id,week_start,week_end,airtime_purchased,sms_bundle_purchased,calling_minutes_purchased,data_bundle_purchased,data_used_mb,sms_used,notes,submitted_by) SELECT s.id,a.agent_id,a.team_id,$2,$2::date+6,$3,$4,$5,$6,$7,$8,$9,$10 FROM sim_cards s LEFT JOIN LATERAL(SELECT agent_id,team_id FROM sim_assignments WHERE sim_id=s.id AND removed_at IS NULL LIMIT 1)a ON true WHERE s.id=$1 RETURNING id`,[b.sim,b.week,b.airtime||0,b.sms||0,b.calls||0,b.bundle||0,b.data||0,b.smsUsed||0,b.note||'',req.user.id]); if(!q.rowCount) return res.status(404).json({error:'SIM not found.'}); res.status(201).json(q.rows[0]); }catch(e){next(e)} });
app.get('*', (_,res) => res.sendFile(path.join(__dirname,'index.html')));
app.use((err,req,res,next) => { console.error(err); res.status(err.status || 500).json({error: err.code === '23505' ? 'That record already exists.' : err.message || 'Server error.'}); });
seedAdmin().then(() => app.listen(process.env.PORT || 10000, '0.0.0.0', () => console.log('SIMHQ running'))).catch(e => { console.error(e); process.exit(1); });
