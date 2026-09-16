import Redis from 'ioredis';

let client;
function getClient(){
  if(!client){
    client = new Redis(process.env.REDIS_URL);
  }
  return client;
}

const KEY = 'noted-auth';

export default async function handler(req, res) {
  const redis = getClient();
  try {
    if (req.method === 'GET') {
      const raw = await redis.get(KEY);
      return res.status(200).json(raw ? JSON.parse(raw) : null);
    }

    if (req.method === 'POST') {
      const existing = await redis.get(KEY);
      if (existing) {
        return res.status(409).json({ error: 'A password is already set.' });
      }
      const { salt, hash } = req.body || {};
      if (!salt || !hash) {
        return res.status(400).json({ error: 'Missing salt or hash.' });
      }
      await redis.set(KEY, JSON.stringify({ salt, hash }));
      return res.status(201).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      await redis.del(KEY);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error.' });
  }
}