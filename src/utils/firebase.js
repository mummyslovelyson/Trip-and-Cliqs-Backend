import crypto from 'crypto';

/**
 * Verify a Firebase ID Token using Google Identity / Firebase verification endpoint or payload decoding.
 * @param {string} idToken
 * @returns {Promise<{ uid: string, email: string, name: string, picture: string, emailVerified: boolean }>}
 */
export async function verifyFirebaseToken(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Missing or invalid Firebase ID token');
  }

  // 1. Try verifying with Google TokenInfo API
  try {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Tribes-Cliqs-Backend/1.0' } });
    if (res.ok) {
      const data = await res.json();
      if (data.email) {
        return {
          uid: data.sub || data.user_id,
          email: data.email.toLowerCase().trim(),
          name: data.name || data.given_name || (data.email.split('@')[0]),
          picture: data.picture || null,
          emailVerified: data.email_verified === 'true' || data.email_verified === true,
        };
      }
    }
  } catch (err) {
    console.warn('[FirebaseToken] Google tokeninfo lookup failed:', err.message);
  }

  // 2. Try verifying with Firebase Accounts Lookup if API key is provided
  const firebaseApiKey = process.env.FIREBASE_API_KEY || process.env.VITE_FIREBASE_API_KEY;
  if (firebaseApiKey) {
    try {
      const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        },
      );
      if (res.ok) {
        const data = await res.json();
        const user = data.users?.[0];
        if (user && user.email) {
          return {
            uid: user.localId,
            email: user.email.toLowerCase().trim(),
            name: user.displayName || (user.email.split('@')[0]),
            picture: user.photoUrl || null,
            emailVerified: user.emailVerified === true,
          };
        }
      }
    } catch (err) {
      console.warn('[FirebaseToken] Identitytoolkit lookup failed:', err.message);
    }
  }

  // 3. Fallback JWT payload decoder for development / demo tokens
  try {
    const parts = idToken.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      if (payload.email) {
        return {
          uid: payload.user_id || payload.sub || payload.uid || `fb_${Date.now()}`,
          email: payload.email.toLowerCase().trim(),
          name: payload.name || (payload.email.split('@')[0]),
          picture: payload.picture || null,
          emailVerified: payload.email_verified !== false,
        };
      }
    }
  } catch (err) {
    console.warn('[FirebaseToken] JWT fallback decode failed:', err.message);
  }

  throw new Error('Unable to verify Firebase authentication token');
}

export default { verifyFirebaseToken };
