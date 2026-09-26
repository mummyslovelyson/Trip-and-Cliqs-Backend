/**
 * In-memory fake MySQL pool for integration tests.
 *
 * Supports exactly the SQL shapes the exercised controllers issue:
 * simple INSERTs with explicit column lists, UPDATE ... SET ... WHERE,
 * DELETE ... WHERE, and SELECTs with WHERE / JOIN users / ORDER BY /
 * LIMIT / COUNT(*) and (SELECT ...) subselects in the select list.
 *
 * Returns a pool-shaped object ({ execute, query, getConnection }) plus
 * `db` (the in-memory tables, for assertions).
 */
export function createFakeDb() {
  const seq = {
    users: 1, events: 1, ticket_types: 1, notifications: 1,
    audit_logs: 1, organizer_profiles: 1, reviews: 1,
    email_verifications: 1, password_reset_tokens: 1,
    notification_preferences: 1, favorites: 1, tickets: 1,
    organizer_follows: 1, event_meetups: 1, event_meetup_members: 1,
    resale_listings: 1, orders: 1, order_items: 1,
    refresh_tokens: 1, password_history: 1,
    admin_user_notes: 1, user_activity_log: 1,
    pending_registrations: 1, system_settings: 1,
    uploaded_tickets: 1, wallet_transactions: 1, event_views: 1, search_history: 1,
    artist_follows: 1, category_follows: 1, event_reminders: 1,
    user_follows: 1, event_invites: 1, meetup_messages: 1, event_discussions: 1,
  };
  const tables = {
    users: [], events: [], ticket_types: [], notifications: [],
    audit_logs: [], organizer_profiles: [], reviews: [],
    email_verifications: [], password_reset_tokens: [],
    notification_preferences: [], favorites: [], tickets: [],
    organizer_follows: [], event_meetups: [], event_meetup_members: [],
    resale_listings: [], orders: [], order_items: [],
    refresh_tokens: [], password_history: [],
    admin_user_notes: [], user_activity_log: [],
    pending_registrations: [], system_settings: [],
    uploaded_tickets: [], wallet_transactions: [], event_views: [], search_history: [],
    artist_follows: [], category_follows: [], event_reminders: [],
    user_follows: [], event_invites: [], meetup_messages: [], event_discussions: [],
  };

  const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  const today = () => new Date().toISOString().slice(0, 10);

  // First index of `keyword` at parenthesis depth 0 (ignores subselects).
  function topLevelIndex(str, keyword) {
    let depth = 0;
    const upper = str.toUpperCase();
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0 && upper.startsWith(keyword, i)) {
        const before = i === 0 ? ' ' : str[i - 1];
        const after = str[i + keyword.length] ?? ' ';
        if (!/[A-Za-z0-9_.]/.test(before) && !/[A-Za-z0-9_.]/.test(after)) return i;
      }
    }
    return -1;
  }

  // Split on a multi-char separator at parenthesis depth 0.
  function splitTop(str, sep) {
    const parts = [];
    let depth = 0;
    let cur = '';
    let i = 0;
    while (i < str.length) {
      const ch = str[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth === 0 && str.startsWith(sep, i)) {
        parts.push(cur);
        cur = '';
        i += sep.length;
        continue;
      }
      cur += ch;
      i++;
    }
    if (cur.trim() !== '') parts.push(cur);
    return parts;
  }

  function evalToken(token, params, cursor) {
    token = token.trim();
    if (token === '?' || /^\$\d+$/.test(token)) return params[cursor.i++];
    if (/^'(?:[^']|'')*'$/.test(token)) return token.slice(1, -1).replace(/''/g, "'");
    if (/^"(?:[^"]|"")*"$/.test(token)) return token.slice(1, -1).replace(/""/g, '"');
    if (/^[+-]?\d+(\.\d+)?$/.test(token)) return Number(token);
    if (/^true$/i.test(token)) return 1;
    if (/^false$/i.test(token)) return 0;
    if (/^null$/i.test(token)) return null;
    if (/^CURDATE\(\)$/.test(token) || /^CURRENT_DATE\(\)$/.test(token) || /^CURRENT_DATE$/.test(token)) return today();
    if (/^NOW\(\)/i.test(token)) {
      const m = token.match(/INTERVAL\s*'(\d+)\s*(minute|hour|day)s?'/i);
      if (m) {
        const amt = Number(m[1]);
        const unit = m[2].toLowerCase();
        const ms = unit === 'minute' ? amt * 60000 : unit === 'hour' ? amt * 3600000 : amt * 86400000;
        return new Date(Date.now() + ms).toISOString().slice(0, 19).replace('T', ' ');
      }
      return nowIso();
    }
    return undefined;
  }

  // Parse a WHERE condition into { col, op, token } — no params touched yet.
  function parseCond(cond) {
    const raw = cond.trim();
    // Check compound OR/NULL conditions on raw input before any stripping.
    if (/status\s*=\s*'active'\s+OR\s+status\s+IS\s+NULL/i.test(raw)) {
      return { col: 'status', op: 'ACTIVE_OR_NULL', token: '' };
    }
    // Check IN on raw input — the closing ')' must be preserved.
    const inMatch = raw.match(/^[\s(]*([\w.`]+)\s+IN\s*\(([^)]+)\)\s*\)*$/i);
    if (inMatch) {
      const col = inMatch[1].replace(/`/g, '').split('.').pop();
      const list = splitTop(inMatch[2], ',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
      return { col, op: 'IN', list };
    }
    // Now safe to strip wrapping parens for simple conditions.
    cond = raw.replace(/^\(+|\)+$/g, '').trim();
    const nullMatch = cond.match(/^([\w.`]+)\s+IS\s+(NOT\s+)?NULL$/i);
    if (nullMatch) {
      return { col: nullMatch[1].replace(/`/g, '').split('.').pop(), op: nullMatch[2] ? 'IS_NOT_NULL' : 'IS_NULL', token: '' };
    }
    const lowerMatch = cond.match(/^LOWER\(([\w.`]+)\)\s*(=|!=|<>|LIKE)\s*(?:LOWER\((.+)\)|(.+))$/i);
    if (lowerMatch) {
      const col = lowerMatch[1].replace(/`/g, '').split('.').pop();
      const op = lowerMatch[2].toUpperCase();
      const token = (lowerMatch[3] || lowerMatch[4]).trim();
      return { col, op, token, isLower: true };
    }
    const m = cond.match(/^([\w.`]+)\s*(=|!=|<>|>=|<=|>|<|LIKE)\s*(.+)$/i);
    if (!m) throw new Error(`Unsupported WHERE condition: ${cond}`);
    return {
      col: m[1].replace(/`/g, '').split('.').pop(),
      op: m[2].toUpperCase(),
      token: m[3].trim(),
    };
  }

  // Resolve a condition's expected value. Params are positional in SQL order
  // and consumed once per statement — never once per row.
  function resolveCond(cond, params, cursor) {
    if (cond.op === 'IN') return cond;
    return { col: cond.col, op: cond.op, isLower: cond.isLower, want: evalToken(cond.token, params, cursor) };
  }

  function matches(cond, row) {
    let got = row[cond.col];
    let want = cond.want;
    if (cond.isLower) {
      got = String(got ?? '').toLowerCase();
      want = String(want ?? '').toLowerCase();
    }
    if (cond.op === 'ACTIVE_OR_NULL') return got === 'active' || got == null;
    if (cond.op === 'IS_NULL') return got == null;
    if (cond.op === 'IS_NOT_NULL') return got != null;
    if (cond.op === 'IN') {
      return cond.list.includes(String(got));
    }
    switch (cond.op) {
      case '=': return got == want;
      case '!=':
      case '<>': return got != want;
      case '>': return got > want;
      case '>=': return got >= want;
      case '<': return got < want;
      case '<=': return got <= want;
      case 'LIKE': {
        const pattern = String(want ?? '').toLowerCase().replace(/%/g, '');
        return String(got ?? '').toLowerCase().includes(pattern);
      }
      default: throw new Error(`Unsupported operator: ${cond.op}`);
    }
  }

  function insert(sql, params) {
    const m = sql.match(/INSERT(?:\s+IGNORE)? INTO (\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*(?:ON CONFLICT(?:\s+\([^)]*\))?\s+DO NOTHING)?\s*$/i);
    if (!m) throw new Error(`Cannot parse INSERT: ${sql}`);
    const table = m[1];
    const cols = splitTop(m[2], ',').map((c) => c.trim().replace(/`/g, ''));
    const valueTokens = splitTop(m[3], ',');
    const cursor = { i: 0 };
    const row = {};
    cols.forEach((col, idx) => {
      row[col] = evalToken(valueTokens[idx], params, cursor);
    });
    row.id = seq[table]++;
    if (table === 'events') {
      if (row.is_featured === undefined) row.is_featured = 0;
      if (row.approval_status === undefined) row.approval_status = null;
      if (row.created_at === undefined) row.created_at = nowIso();
      if (row.updated_at === undefined) row.updated_at = nowIso();
    }
    if (table === 'users') {
      if (row.status === undefined) row.status = 'active';
      if (row.is_approved === undefined) row.is_approved = 0;
      if (row.email_verified === undefined) row.email_verified = 0;
      if (row.created_at === undefined) row.created_at = nowIso();
    }
    if (table === 'resale_listings') {
      if (row.status === undefined) row.status = 'active';
      if (row.created_at === undefined) row.created_at = nowIso();
    }
    if (table === 'uploaded_tickets') {
      if (row.is_assigned === undefined) row.is_assigned = 0;
      if (row.created_at === undefined) row.created_at = nowIso();
    }
    tables[table].push(row);
    return [{ insertId: row.id, affectedRows: 1, fieldCount: 0 }, []];
  }

  function update(sql, params) {
    const t = sql.match(/UPDATE (\w+)/i)[1];
    const setMatch = sql.match(/SET\s+([\s\S]*?)\s+WHERE/i);
    const whereMatch = sql.match(/WHERE\s+([\s\S]*)$/i);
    if (!setMatch || !whereMatch) throw new Error(`Cannot parse UPDATE: ${sql}`);
    const pairs = splitTop(setMatch[1], ',').map((p) => {
      const pm = p.trim().match(/^([\w.`]+)\s*=\s*(.+)$/i);
      if (!pm) throw new Error(`Unsupported SET pair: ${p}`);
      return pm;
    });
    const cursor = { i: 0 };
    const conditions = splitTop(whereMatch[1], 'AND');
    // SET values precede WHERE params in the statement text, so resolve them
    // first with the same positional cursor.
    const setValues = pairs.map((p) => evalToken(p[2].trim(), params, cursor));
    const conds = conditions.map((c) => resolveCond(parseCond(c), params, cursor));
    const rows = tables[t].filter((row) => conds.every((c) => matches(c, row)));
    const patch = {};
    pairs.forEach((p, idx) => {
      const col = p[1].replace(/`/g, '').split('.').pop();
      patch[col] = setValues[idx];
    });
    for (const row of rows) Object.assign(row, patch);
    return [{ affectedRows: rows.length, changedRows: rows.length }, []];
  }

  function del(sql, params) {
    const t = sql.match(/DELETE FROM (\w+)/i)[1];
    const m = sql.match(/WHERE\s+([\s\S]*)$/i);
    const rawConditions = m ? splitTop(m[1], 'AND') : [];
    const cursor = { i: 0 };
    const resolved = rawConditions.map((c) => ({
      raw: c,
      isSubquery: /\bIN\s*\(\s*SELECT\b/i.test(c),
      cond: /\bIN\s*\(\s*SELECT\b/i.test(c) ? null : resolveCond(parseCond(c), params, cursor),
    }));
    const before = tables[t].length;
    tables[t] = tables[t].filter((row) => {
      for (const { isSubquery, cond } of resolved) {
        if (isSubquery) return true;
        if (!matches(cond, row)) return true;
      }
      return false;
    });
    return [{ affectedRows: before - tables[t].length }, []];
  }

  function select(sql, params) {
    const cursor = { i: 0 };
    const fromIdx = topLevelIndex(sql, 'FROM');
    if (fromIdx < 0) throw new Error(`Cannot parse SELECT: ${sql}`);
    const rest = sql.slice(fromIdx + 4).trim();
    const tableMatch = rest.match(/^(\w+)/);
    const table = tableMatch[1];

    const whereIdx = topLevelIndex(sql, 'WHERE');
    const orderIdx = topLevelIndex(sql, 'ORDER BY');
    const limitIdx = topLevelIndex(sql, 'LIMIT');
    const end = [orderIdx, limitIdx, sql.length].filter((x) => x > whereIdx).sort((a, b) => a - b)[0];
    const whereClause = whereIdx >= 0 ? sql.slice(whereIdx + 5, end) : '';
    // Split top-level OR groups, then each group into AND conditions.
    const orGroups = whereClause ? splitTop(whereClause, ' OR ') : [];
    const parsedOrGroups = orGroups.map((group) => {
      const andConditions = splitTop(group, 'AND');
      return andConditions.map((c) => resolveCond(parseCond(c), params, cursor));
    });
    let rows = parsedOrGroups.length === 0
      ? [...(tables[table] || [])]
      : (tables[table] || []).filter((row) =>
          parsedOrGroups.some((group) => group.every((c) => matches(c, row)))
        );

    // JOIN users → merge organizer fields.
    if (/JOIN\s+users\s+\w+\s+ON\s+u\.id\s*=\s*e\.organizer_id/i.test(sql)) {
      rows = rows.map((e) => {
        const u = tables.users.find((x) => x.id === e.organizer_id);
        return {
          ...e,
          organizer_name: u?.name ?? null,
          organizer_avatar: u?.avatar ?? null,
          email: u?.email ?? null,
          avatar: u?.avatar ?? null,
        };
      });
    }

    // LEFT JOIN organizer_profiles op ON op.user_id = u.id
    if (/JOIN\s+organizer_profiles\s+\w+\s+ON\s+\w+\.user_id\s*=\s*u\.id/i.test(sql)) {
      rows = rows.map((u) => {
        const op = (tables.organizer_profiles || []).find((x) => x.user_id === u.id);
        return {
          ...u,
          organization_name: op?.organization_name ?? null,
          description: op?.description ?? u.description ?? null,
          website: op?.website ?? null,
          logo_url: op?.logo_url ?? null,
          banner_url: op?.banner_url ?? null,
          social_links: op?.social_links ?? null,
          is_verified: op?.is_verified ?? 0,
          approved_at: op?.approved_at ?? null,
          category: op?.category ?? null,
          city: op?.city ?? u.city ?? null,
        };
      });
    }

    // JOIN users u ON u.id = rl.seller_id → merge seller fields.
    if (/JOIN\s+users\s+u\s+ON\s+u\.id\s*=\s*rl\.seller_id/i.test(sql)) {
      rows = rows.map((l) => {
        const u = tables.users.find((x) => x.id === l.seller_id);
        return { ...l, seller_name: u?.name ?? null, seller_avatar: u?.avatar ?? null };
      });
    }

    // JOIN users u ON u.id = t.user_id (tickets & attendees)
    if (/JOIN\s+users\s+u\s+ON\s+u\.id\s*=\s*t\.user_id/i.test(sql)) {
      rows = rows.map((t) => {
        const u = tables.users.find((x) => x.id === t.user_id);
        return {
          ...t,
          id: u?.id ?? t.user_id,
          name: u?.name ?? null,
          avatar: u?.avatar ?? null,
          role: u?.role ?? 'attendee',
        };
      });
    }

    // JOIN users u ON u.id = uf.following_id or follower_id (friends & tribes)
    if (/JOIN\s+users\s+u\s+ON\s+u\.id\s*=\s*uf\.(following_id|follower_id)/i.test(sql)) {
      const isFollowing = /uf\.following_id/i.test(sql);
      rows = rows.map((uf) => {
        const targetId = isFollowing ? uf.following_id : uf.follower_id;
        const u = tables.users.find((x) => x.id === targetId);
        return {
          ...uf,
          id: u?.id ?? targetId,
          name: u?.name ?? null,
          email: u?.email ?? null,
          avatar: u?.avatar ?? null,
          role: u?.role ?? 'attendee',
        };
      });
    }



    // JOIN events e ON e.id = <main>.event_id → merge event fields.
    if (/JOIN\s+events\s+e\s+ON\s+e\.id\s*=\s*(\w+)\.event_id/i.test(sql)) {
      rows = rows.map((r) => {
        const ev = tables.events.find((x) => x.id === r.event_id);
        return {
          ...r,
          title: ev?.title ?? null,
          category: ev?.category ?? null,
          city: ev?.city ?? null,
          organizer_id: ev?.organizer_id ?? null,
          event_title: ev?.title ?? null,
          start_date: ev?.start_date ?? null,
          start_time: ev?.start_time ?? null,
          event_status: ev?.status ?? null,
        };
      });
    }

    // JOIN ticket_types tt ON tt.id = <main>.ticket_type_id → merge type name and price.
    if (/JOIN\s+ticket_types\s+tt\s+ON\s+tt\.id\s*=\s*(\w+)\.ticket_type_id/i.test(sql)) {
      rows = rows.map((r) => {
        const tt = tables.ticket_types.find((x) => x.id === r.ticket_type_id);
        return {
          ...r,
          ticket_type_name: tt?.name ?? null,
          ticket_type_price: tt?.price != null ? Number(tt.price) : null,
        };
      });
    }

    // (SELECT MIN(price) FROM ticket_types ...) AS min_price
    if (/AS\s+min_price/i.test(sql)) {
      rows = rows.map((e) => {
        const prices = tables.ticket_types.filter((tt) => tt.event_id === e.id).map((tt) => Number(tt.price) || 0);
        return { ...e, min_price: prices.length ? Math.min(...prices) : null };
      });
    }
    // (SELECT COUNT(*) FROM tickets ...) AS tickets_sold → 0 (no tickets here)
    if (/AS\s+tickets_sold/i.test(sql)) {
      rows = rows.map((e) => ({ ...e, tickets_sold: 0 }));
    }

    if (orderIdx >= 0) {
      const orderEnd = [limitIdx, sql.length].filter((x) => x > orderIdx).sort((a, b) => a - b)[0];
      const keys = splitTop(sql.slice(orderIdx + 9, orderEnd), ',').map((k) => {
        const km = k.trim().match(/^([\w.]+)\s+(ASC|DESC)$/i);
        if (!km) throw new Error(`Unsupported ORDER BY: ${k}`);
        return { col: km[1].split('.').pop(), dir: km[2].toUpperCase() === 'ASC' ? 1 : -1 };
      });
      rows = rows.sort((a, b) => {
        for (const { col, dir } of keys) {
          const av = a[col];
          const bv = b[col];
          if (av == null && bv == null) continue;
          if (av == null) return dir;
          if (bv == null) return -dir;
          if (av < bv) return -dir;
          if (av > bv) return dir;
        }
        return 0;
      });
    }

    if (limitIdx >= 0) {
      const lm = sql.slice(limitIdx).match(/LIMIT\s+(\?|\d+)(?:\s+OFFSET\s+(\?|\d+))?/i);
      const n = Number(lm[1] === '?' ? params[cursor.i++] : lm[1]);
      const off = lm[2] === '?' ? Number(params[cursor.i++]) : Number(lm[2] || 0);
      rows = rows.slice(off, off + n);
    }

    if (/COUNT\(\*\)\s+AS\s+\w+/i.test(sql)) {
      return [[{ total: rows.length }], []];
    }
    return [rows, []];
  }

  function run(sql, params = []) {
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (/^INSERT(?:\s+IGNORE)? INTO/i.test(norm)) return insert(norm, params);
    if (/^UPDATE/i.test(norm)) return update(norm, params);
    if (/^DELETE FROM/i.test(norm)) return del(norm, params);
    if (/^SELECT/i.test(norm)) return select(norm, params);
    if (/^CREATE TABLE/i.test(norm)) return [[], []];
    throw new Error(`Unhandled SQL: ${sql}`);
  }

  return {
    run,
    query: (sql, params) => Promise.resolve(run(sql, params)),
    execute: (sql, params) => Promise.resolve(run(sql, params)),
    getConnection: async () => ({
      execute: (sql, params) => Promise.resolve(run(sql, params)),
      query: (sql, params) => Promise.resolve(run(sql, params)),
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
    }),
    db: { tables, seq },
  };
}
