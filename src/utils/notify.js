import pool from '../config/db.js';

/**
 * Insert a notification for a user.
 * @param {{ userId: number, title: string, message?: string, type?: string }} n
 */
export const sendNotification = async ({ userId, title, message = '', type = 'info' }) => {
  try {
    await pool.execute(
      `INSERT INTO notifications (user_id, title, message, type, is_read) VALUES (?, ?, ?, ?, FALSE)`,
      [userId, title, message, type],
    );
  } catch (err) {
    console.error('[notifications] insert failed:', err.message);
  }
};

export const sendNotificationToMany = async (userIds, { title, message = '', type = 'info', link = '' }) => {
  if (!userIds.length) return;
  try {
    const values = userIds.map((uid) => [uid, title, message, type, link]);
    const placeholders = values.map(() => '(?, ?, ?, ?, ?, FALSE)').join(', ');
    const flat = values.flat();
    await pool.execute(
      `INSERT INTO notifications (user_id, title, message, type, link, is_read) VALUES ${placeholders}`,
      flat,
    );
  } catch (err) {
    console.error('[notifications] bulk insert failed:', err.message);
  }
};

/**
 * Dispatches a notification to all active platform administrators.
 * @param {{ title: string, message?: string, type?: string, link?: string }} n
 */
export const notifyAdmins = async ({ title, message = '', type = 'system', link = '' }) => {
  try {
    const [admins] = await pool.execute(
      `SELECT id FROM users WHERE role IN ('admin', 'system_admin', 'superadmin') AND status = 'active'`
    );
    if (!admins || !admins.length) return;

    for (const admin of admins) {
      await pool.execute(
        `INSERT INTO notifications (user_id, title, message, type, link, is_read) VALUES (?, ?, ?, ?, ?, FALSE)`,
        [admin.id, title, message, type, link]
      );
    }
  } catch (err) {
    console.error('[notifyAdmins] failed:', err.message);
  }
};

export default sendNotification;
