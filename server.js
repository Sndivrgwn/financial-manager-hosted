import 'dotenv/config';
import express from 'express';

const app = express();
const port = Number(process.env.PORT || 3000);
const gasUrl = process.env.GAS_WEB_APP_URL;
const gasApiKey = process.env.FM_API_KEY;

if (!gasUrl || !gasApiKey) {
  console.error('Set GAS_WEB_APP_URL dan FM_API_KEY di file .env.');
  process.exit(1);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/api', async (req, res) => {
  const { method, payload = null } = req.body || {};
  if (typeof method !== 'string' || !method) {
    return res.status(400).json({ success: false, message: 'Method wajib diisi.' });
  }
  try {
    const upstream = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ apiKey: gasApiKey, method, payload }),
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    });
    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); }
    catch { throw new Error(`Apps Script mengembalikan respons tidak valid (HTTP ${upstream.status}). Pastikan URL /exec dan deployment sudah benar.`); }
    if (!upstream.ok) return res.status(502).json({ success: false, message: data.message || 'Google Apps Script gagal memproses permintaan.' });
    if (data && data.success === false) return res.status(400).json(data);
    return res.json(data);
  } catch (error) {
    console.error('API proxy error:', error.message);
    return res.status(502).json({ success: false, message: error.name === 'TimeoutError' ? 'Google Sheets terlalu lama merespons. Coba lagi.' : error.message || 'Tidak dapat menghubungi Google Apps Script.' });
  }
});

app.use(express.static('public', { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(new URL('./public/index.html', import.meta.url).pathname));
app.listen(port, '0.0.0.0', () => console.log(`Financial Manager berjalan di http://localhost:${port}`));
