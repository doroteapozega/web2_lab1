// ovdje radimo povezivanje s bazom
const { Pool } = require("pg");
const dotenv = require("dotenv");
dotenv.config();

let pool;

if (process.env.DATABASE_URL) {
  // kada deployamo na Render
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false, // Render zahtijeva SSL (dopustamo self-signed)
    },
  });
} else {
  // za lokalno
  pool = new Pool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "loto",
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
    ssl: false,
  });
}

module.exports = pool;
