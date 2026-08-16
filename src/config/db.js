import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'tribes_cliqs',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 30000,
  family: 4,
  // Encrypt the connection to the database server when DB_SSL=true
  // (recommended for any remote/cloud MySQL). Optionally set DB_SSL_CA to
  // the PEM certificate contents (newlines as \n) to pin the CA.
  ...(process.env.DB_SSL === 'true' && {
    ssl: process.env.DB_SSL_CA
      ? { ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n') }
      : { rejectUnauthorized: false },
  }),
});

export default pool;
