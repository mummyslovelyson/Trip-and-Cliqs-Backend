import pool from '../config/db.js';

/**
 * Insert a notification for a user.
 * @param {{ userId: number, title: string, message?: string, type?: string }} n
 */
export const sendNotification = async ({ userId, title, message = '', type = 'info' }) => {
  try {
    await pool.execute(
      `INSERT INTO notifications (user_id, title, message, type, is_read) VALUES (?, ?, ?, ?, 0)`,
      [userId, title, message, type],
    );
  } catch (err) {
    console.error('[notifications] insert failed:', err.message);
  }
};

export const sendNotificationToMany = async (userIds, { title, message = '', type = 'info' }) => {
  if (!userIds.length) return;
  try {
    const values = userIds.map((uid) => [uid, title, message, type, 0]);
    const placeholders = values.map(() => '(?, ?, ?, ?, 0)').join(', ');
    const flat = values.flat();
    await pool.execute(
      `INSERT INTO notifications (user_id, title, message, type, is_read) VALUES ${placeholders}`,
      flat,
    );
  } catch (err) {
    console.error('[notifications] bulk insert failed:', err.message);
  }
};

export default sendNotification;
