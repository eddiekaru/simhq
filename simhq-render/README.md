# SIMHQ on Render

## First deployment

1. Create a Render **Postgres** database in the same region as the web service.
2. Run `sim-management-schema.sql` once against that database using the **PSQL Command** shown in Render's database **Connect** menu.
3. Create a Render **Web Service** from this project with build command `npm install` and start command `npm start`.
4. Add these environment variables on the web service:
   - `DATABASE_URL`: the database **Internal Database URL**
   - `JWT_SECRET`: a long random secret
   - `ADMIN_USERNAME`: your first administrator username
   - `ADMIN_PASSWORD`: a strong first administrator password
   - `ADMIN_NAME`: the administrator's display name

The administrator is created automatically on the first service start only if no matching username exists. Remove `ADMIN_PASSWORD` from Render after the first successful login.

## Local run

Set `DATABASE_URL`, `JWT_SECRET`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD`, then run `npm install` and `npm start`.
