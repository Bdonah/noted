import Redis from 'ioredis';
import crypto from 'crypto';

let client;

function getClient() {
  if (!client) {
    client = new Redis(process.env.REDIS_URL);
  }
  return client;
}

const KEY = 'noted-auth';

function hashPassword(password, salt) {
  return crypto
    .pbkdf2Sync(password, salt, 100000, 64, 'sha512')
    .toString('hex');
}

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');

    return res.status(405).json({
      error: 'Method not allowed.'
    });
  }

  const redis = getClient();

  try {
    const { password } = req.body || {};

    if (!password) {
      return res.status(400).json({
        error: 'Password required.'
      });
    }

    const raw = await redis.get(KEY);

    if (!raw) {
      return res.status(401).json({
        error: 'No password has been set.'
      });
    }

    const auth = JSON.parse(raw);

    const attemptedHash = hashPassword(
      password,
      auth.salt
    );

    if (attemptedHash !== auth.hash) {
      return res.status(401).json({
        error: 'Wrong password.'
      });
    }

    const token = createToken();

    // Session lasts 24 hours
    await redis.set(
      `noted-session:${token}`,
      '1',
      'EX',
      60 * 60 * 24
    );

    return res.status(200).json({
      token
    });

  } catch (err) {
    console.error('Login error:', err);

    return res.status(500).json({
      error: 'Server error.'
    });
  }
}