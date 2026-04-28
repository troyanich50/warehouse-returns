// СКЛАД · ВОЗВРАТЫ — Бэкенд

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { uploadToYandexDisk } from './lib/yandex.js';
import { updateReturnVideoField } from './lib/moysklad.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

const app = express();

// ---------- Раздаём фронтенд ----------
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---------- CORS ----------
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- Загрузка файлов ----------
const UPLOAD_DIR = path.join(process.cwd(), 'tmp');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ---------- Health ----------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    yandex: !!process.env.YANDEX_DISK_TOKEN,
    moysklad: !!process.env.MOYSKLAD_TOKEN,
    folder: process.env.YANDEX_DISK_FOLDER || 'Возвраты',
    field: process.env.MOYSKLAD_VIDEO_FIELD_NAME || 'Видео',
  });
});

// ---------- Главный обработчик загрузки ----------
async function handleUpload(req, res) {
  const startedAt = Date.now();
  const file = req.file;
  const barcode = (req.body.barcode || '').trim();
  const filenameFromClient = (req.body.filename || '').trim();
  const user = (req.body.user || 'unknown').trim();

  console.log(`\n[${new Date().toISOString()}] Upload start`);
  console.log(`  barcode: ${barcode}`);
  console.log(`  filename: ${filenameFromClient}`);
  console.log(`  user: ${user}`);
  console.log(`  file: ${file?.originalname} (${file?.size} bytes, ${file?.mimetype})`);

  if (!file) return res.status(400).json({ success: false, error: 'Видео не получено' });
  if (!barcode) {
    cleanup(file.path);
    return res.status(400).json({ success: false, error: 'Не указан штрихкод' });
  }
  if (!process.env.YANDEX_DISK_TOKEN) {
    cleanup(file.path);
    return res.status(500).json({ success: false, error: 'Не настроен YANDEX_DISK_TOKEN' });
  }

  // Имя на Диске: используем filename от клиента, если он есть, иначе собираем сами
  let remoteName;
  if (filenameFromClient && filenameFromClient.startsWith(barcode)) {
    remoteName = filenameFromClient;
  } else {
    const ext = path.extname(file.originalname) || '.mp4';
    remoteName = `${barcode}${ext}`;
  }

  let warning = null;

  try {
    console.log('  → Yandex Disk: uploading...');
    const link = await uploadToYandexDisk({
      token: process.env.YANDEX_DISK_TOKEN,
      folder: process.env.YANDEX_DISK_FOLDER || 'Returns',
      remoteName,
      localPath: file.path,
    });
    console.log(`  ✓ Yandex Disk: ${link}`);

    if (process.env.MOYSKLAD_TOKEN) {
      try {
        console.log('  → МойСклад: updating return...');
        await updateReturnVideoField({
          token: process.env.MOYSKLAD_TOKEN,
          fieldName: process.env.MOYSKLAD_VIDEO_FIELD_NAME || 'Видео',
          returnNumber: barcode,
          link,
        });
        console.log('  ✓ МойСклад: updated');
      } catch (e) {
        console.error('  ✗ МойСклад error:', e.message);
        warning = `Видео загружено, но МойСклад не обновлён: ${e.message}`;
      }
    } else {
      warning = 'MOYSKLAD_TOKEN не настроен — поле в МойСклад не обновлено';
    }

    cleanup(file.path);
    const duration = Date.now() - startedAt;
    console.log(`  ✓ DONE in ${duration}ms\n`);

    res.json({ success: true, barcode, link, warning, durationMs: duration });
  } catch (e) {
    console.error('  ✗ FATAL:', e);
    cleanup(file.path);
    res.status(500).json({ success: false, error: e.message || 'Внутренняя ошибка' });
  }
}

// Регистрируем endpoint под обоими именами — старым и новым
app.post('/api/upload', upload.single('video'), handleUpload);
app.post('/api/process-return', upload.single('video'), handleUpload);

function cleanup(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

app.listen(PORT, () => {
  console.log('============================================================');
  console.log('  СКЛАД · ВОЗВРАТЫ — backend started');
  console.log(`  Port:        ${PORT}`);
  console.log(`  Yandex.Disk: ${process.env.YANDEX_DISK_TOKEN ? '✓' : '✗ MISSING'}`);
  console.log(`  МойСклад:    ${process.env.MOYSKLAD_TOKEN ? '✓' : '✗ MISSING'}`);
  console.log('============================================================');
});
