# Namecheap cPanel MySQL deployment

1. In phpMyAdmin, select `simmlkxf_simhq`, choose **Import**, and import `mysql-schema.sql`.
2. Create a Node.js application using Node **20.20.2**, Production mode, application root `simhq`, and startup file `server-mysql.js`.
3. Deploy the `codex/mysql-migration` branch to that application root, then run `npm install` from the Node.js application terminal.
4. Add these environment variables in cPanel:
   - `DB_HOST=localhost`
   - `DB_NAME=simmlkxf_simhq`
   - `DB_USER=` your cPanel MySQL user
   - `DB_PASSWORD=` that user's password
   - `JWT_SECRET=` a long random value
   - `ADMIN_USERNAME=admin`
   - `ADMIN_PASSWORD=` a strong temporary first-login password
   - `ADMIN_NAME=Administrator`
   - `NODE_ENV=production`
5. Restart the Node.js application. Remove `ADMIN_PASSWORD` after the first successful administrator login.

The MySQL schema starts a fresh database. Existing Render PostgreSQL data must be exported and transformed before it can be imported; do not shut down the Render site until that data migration is verified.
