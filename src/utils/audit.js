import pool from '../config/db.js';

/**
 * Persist an audit log entry.
 * @param {{ userId?: number, action: string, entityType?: string, entityId?: number, details?: object, ipAddress?: string }} entry
 */
export const logAudit = async ({ userId = null, action, entityType = null, entityId = null, details = null, ipAddress = null }) => {
  try {
    await pool.execute(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId,
        action,
        entityType,
        entityId,
        details ? JSON.stringify(details) : null,
        ipAddress,
      ],
    );
  } catch (err) {
    // Audit logging must never break the request flow.
    console.error('[audit] logAudit failed:', err.message);
  }
};

export default logAudit;
