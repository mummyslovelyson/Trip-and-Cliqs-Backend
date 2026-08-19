import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../.env') });

async function initDb() {
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = parseInt(process.env.DB_PORT, 10) || 5432;
  const user = process.env.DB_USER || 'postgres';
  const password = process.env.DB_PASSWORD || '';
  const dbName = process.env.DB_NAME || 'tribes_cliqs';

  console.log(`[initDb] target=${host}:${port} user=${user} db=${dbName} ssl=${process.env.DB_SSL}`);

  let connection;
  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      connection = new pg.Client({
        host,
        port,
        user,
        password,
        database: dbName,
        connectionTimeoutMillis: 30000,
        ssl: process.env.DB_SSL === 'true'
          ? { rejectUnauthorized: false }
          : false,
      });
      await connection.connect();
      break;
    } catch (err) {
      console.error(`[initDb] connection attempt ${attempt}/${MAX_RETRIES} failed: ${err.code || err.message}`);
      if (attempt < MAX_RETRIES) {
        const delay = attempt * 5000;
        console.log(`[initDb] retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }

  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      console.log('Executing schema.sql...');
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      await connection.query(schemaSql);
      console.log('✅ Database schema created/updated successfully!');
    } else {
      console.warn('⚠️ schema.sql not found at', schemaPath);
    }

    const bcrypt = (await import('bcryptjs')).default;
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@tribesandcliqs.com';
    const { rows: adminRows } = await connection.query(
      `SELECT id FROM users WHERE role = 'admin' LIMIT 1`,
    );

    if (adminRows.length === 0) {
      const adminPass = process.env.ADMIN_PASSWORD || 'Admin@TC2024';
      if (!process.env.ADMIN_PASSWORD && process.env.NODE_ENV === 'production') {
        console.warn('⚠️ ADMIN_PASSWORD is not set — the seed admin account uses the default password. Set ADMIN_PASSWORD before deploying.');
      }
      const adminHash = await bcrypt.hash(adminPass, 12);
      await connection.query(
        `INSERT INTO users (name, email, password, role, status, is_approved, email_verified)
         VALUES ('System Administrator', $1, $2, 'admin', 'active', TRUE, TRUE)`,
        [adminEmail, adminHash],
      );
      console.log('✅ Seed admin account created.');
    } else {
      console.log('✅ Admin account already exists — skipping seed (password untouched).');
    }
  } catch (err) {
    console.error('❌ Database initialization error:', err.message);
  } finally {
    if (connection) await connection.end();
  }
}

initDb().catch((err) => {
  console.error('⚠️ Database initialization failed — server will start but DB-dependent routes may error until the database is reachable.');
  console.error('   Error:', err.message);
});
