// Run the existing Express application against MySQL through its pg-compatible adapter.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'pg') return require('./mysql-pg-compat');
  return originalLoad.call(this, request, parent, isMain);
};
if (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USER || !process.env.DB_PASSWORD) {
  throw new Error('DB_HOST, DB_NAME, DB_USER, and DB_PASSWORD are required for MySQL.');
}
process.env.DATABASE_URL ||= 'mysql://configured-by-environment';
require('./server');
