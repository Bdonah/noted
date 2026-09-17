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
  const redis = getClient();

  try {
    // Does a password already exist?
    if (req.method === 'DELETE') {
      const raw = await redis.get(KEY);

      return res.status(200).json({
        exists: !!raw
      });
    }

    // Create the initial password
    if (req.method === 'POST') {
      const existing = await redis.get(KEY);

      if (existing) {
        return res.status(409).json({
          error: 'A password is already set.'
        });
      }

      const { password } = req.body || {};

      if (!password || password.length < 4) {
        return res.status(400).json({
          error: 'Password must be at least 4 characters.'
        });
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(password, salt);
      const token = createToken();

      await redis.set(
        KEY,
        JSON.stringify({
          salt,
          hash
        })
      );

      // Store login token for 24 hours
      await redis.set(
        `noted-session:${token}`,
        '1',
        'EX',
        60 * 60 * 24
      );

      return res.status(201).json({
        ok: true,
        token
      });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');

    return res.status(405).json({
      error: 'Method not allowed.'
    });

  } catch (err) {
    console.error('Auth error:', err);

    return res.status(500).json({
      error: 'Server error.'
    });
  }
}