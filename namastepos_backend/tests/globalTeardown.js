// Single Jest globalTeardown — drains the shared pg pool once at the very end.

module.exports = async () => {
  const { pool } = require('../src/config/db');
  await pool.end().catch(() => {});
};
