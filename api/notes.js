import Redis from 'ioredis';

let client;
function getClient(){
  if(!client){
    client = new Redis(process.env.REDIS_URL);
  }
  return client;
}

const KEY = 'noted-data';

export default async function handler(req, res) {
  const redis = getClient();
  try {
    if (req.method === 'GET') {
      const raw = await redis.get(KEY);
      return res.status(200).json(raw ? JSON.parse(raw) : { classes: [] });
    }

    if (req.method === 'PUT') {
      const data = req.body;
      if (!data || typeof data !== 'object' || !Array.isArray(data.classes)) {
        return res.status(400).json({ error: 'Invalid data.' });
      }
      await redis.set(KEY, JSON.stringify(data));
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      await redis.del(KEY);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error.' });
  }
}