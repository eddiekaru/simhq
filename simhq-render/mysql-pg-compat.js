const mysql = require('mysql2/promise');

function convert(text, values = []) {
  text = text.replace(/\$2::date\+6/g, 'DATE_ADD($2, INTERVAL 6 DAY)');
  let params = [];
  let sql = text.replace(/\$(\d+)/g, (_, n) => { params.push(values[Number(n) - 1]); return '?'; })
    .replace(/::text/g, '')
    .replace(/new_value->>'note'/g, "JSON_UNQUOTE(JSON_EXTRACT(new_value,'$.note'))")
    .replace(/\bILIKE\b/gi, 'LIKE')
    .replace(/\('Status changed ' \|\| COALESCE\(previous_status,''\) \|\| ' → ' \|\| new_status\)/g, "CONCAT('Status changed ',COALESCE(previous_status,'new'),' → ',new_status)");
  params = params.map(value => value && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value);
  return { sql, params };
}

class Connection {
  constructor(conn) { this.conn = conn; }
  async query(text, values = []) {
    if (/CREATE TABLE IF NOT EXISTS equipment_damage_reports/i.test(text)) return { rows: [], rowCount: 0 };
    let returning = /\sRETURNING\s+id\s*;?\s*$/i.test(text);
    let { sql, params } = convert(text.replace(/\sRETURNING\s+id\s*;?\s*$/i, ''), values);
    if (/id=ANY\(\?::uuid\[\]\)/i.test(sql)) sql = sql.replace(/id=ANY\(\?::uuid\[\]\)/i, 'id IN (?)');
    const [result] = await this.conn.query(sql, params);
    if (Array.isArray(result)) return { rows: result, rowCount: result.length };
    return { rows: returning && result.insertId ? [{ id: String(result.insertId) }] : [], rowCount: result.affectedRows || 0 };
  }
  release() { this.conn.release(); }
}

class Pool {
  constructor() {
    this.pool = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4' });
  }
  async query(text, values) { const conn = await this.pool.getConnection(); try { return await new Connection(conn).query(text, values); } finally { conn.release(); } }
  async connect() { return new Connection(await this.pool.getConnection()); }
}
module.exports = { Pool };
