import pool from '../src/config/db.js';

async function fix() {
  await pool.execute(
    "UPDATE uploaded_tickets SET file_url = 'http://localhost:5000/uploads/359b013a85ed494576b06b3f88c3ef39.jpeg' WHERE id = 1"
  );
  const [rows] = await pool.execute('SELECT * FROM uploaded_tickets');
  console.log('Fixed uploaded_tickets:', rows);
  process.exit(0);
}

fix().catch(err => {
  console.error(err);
  process.exit(1);
});
