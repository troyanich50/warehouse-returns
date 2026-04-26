/**
 * Бэкенд для приложения "Кладовщик · Возвраты"
 *
 * Что делает:
 *   1. Принимает видео + штрихкод от мобильного приложения
 *   2. Загружает видео на Яндекс.Диск с именем {штрихкод}.{ext}
 *   3. Делает файл публичным, получает прямую ссылку
 *   4. Находит документ возврата в МойСклад по номеру
 *   5. Записывает ссылку в дополнительное поле "Видео"
 */

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== НАСТРОЙКИ =====
const API_KEY = process.env.API_KEY;                       // секретный ключ для приложения
const YANDEX_TOKEN = process.env.YANDEX_TOKEN;             // OAuth токен Яндекс.Диска
const MS_TOKEN = process.env.MS_TOKEN;                     // токен МойСклад
const YANDEX_FOLDER = process.env.YANDEX_FOLDER || 'Возвраты'; // папка на диске

// Имя дополнительного поля в МойСклад, куда записываем ссылку
const VIDEO_FIELD_NAME = process.env.VIDEO_FIELD_NAME || 'Видео';

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Папка для временных файлов
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Multer для приёма видео (до 500 МБ)
const upload = multer({
    dest: TMP_DIR,
    limits: { fileSize: 500 * 1024 * 1024 },
});

// Простая защита по API ключу
function requireApiKey(req, res, next) {
    const key = req.header('X-API-Key');
    if (!API_KEY || key !== API_KEY) {
        return res.status(401).json({ error: 'Неверный ключ доступа' });
    }
    next();
}

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====
function log(msg, ...args) {
    console.log(`[${new Date().toISOString()}] ${msg}`, ...args);
}

function err(msg, ...args) {
    console.error(`[${new Date().toISOString()}] ❌ ${msg}`, ...args);
}

// ===== ЯНДЕКС.ДИСК =====
const YA_API = 'https://cloud-api.yandex.net/v1/disk';

async function yaRequest(method, urlPath, body = null) {
    const opts = {
        method,
        headers: {
            'Authorization': `OAuth ${YANDEX_TOKEN}`,
            'Content-Type': 'application/json',
        }
    };
    if (body) opts.body = JSON.stringify(body);

    const r = await fetch(YA_API + urlPath, opts);
    const text = await r.text();

    if (!r.ok) {
        let msg = text;
        try { msg = JSON.parse(text).message || text; } catch {}
        throw new Error(`Яндекс.Диск ${r.status}: ${msg}`);
    }
    return text ? JSON.parse(text) : {};
}

async function ensureYaFolder(folder) {
    try {
        await yaRequest('PUT', `/resources?path=${encodeURIComponent(folder)}`);
        log(`Создана папка на Яндекс.Диске: ${folder}`);
    } catch (e) {
        // Папка уже существует - это ок
        if (!e.message.includes('409')) {
            log(`Папка ${folder} уже существует или ошибка:`, e.message);
        }
    }
}

async function uploadToYandex(localPath, remoteName) {
    await ensureYaFolder(YANDEX_FOLDER);

    const remotePath = `${YANDEX_FOLDER}/${remoteName}`;

    // 1. Получаем upload URL
    const uploadInfo = await yaRequest(
        'GET',
        `/resources/upload?path=${encodeURIComponent(remotePath)}&overwrite=true`
    );

    log(`Получен upload URL для: ${remotePath}`);

    // 2. Заливаем файл по полученному URL
    const fileStream = fs.createReadStream(localPath);
    const fileSize = fs.statSync(localPath).size;

    const uploadResp = await fetch(uploadInfo.href, {
        method: 'PUT',
        body: fileStream,
        headers: {
            'Content-Length': fileSize.toString(),
        }
    });

    if (!uploadResp.ok) {
        throw new Error(`Ошибка загрузки файла на Яндекс.Диск: ${uploadResp.status}`);
    }

    log(`Файл загружен: ${remotePath} (${(fileSize / 1024 / 1024).toFixed(1)} МБ)`);

    // 3. Делаем файл публичным
    await yaRequest(
        'PUT',
        `/resources/publish?path=${encodeURIComponent(remotePath)}`
    );

    // 4. Получаем публичную ссылку
    const meta = await yaRequest(
        'GET',
        `/resources?path=${encodeURIComponent(remotePath)}&fields=public_url,file`
    );

    log(`Публичная ссылка: ${meta.public_url}`);

    return {
        publicUrl: meta.public_url,
        downloadUrl: meta.file,
        path: remotePath,
    };
}

// ===== МОЙСКЛАД =====
const MS_API = 'https://api.moysklad.ru/api/remap/1.2';

async function msRequest(method, urlPath, body = null) {
    const opts = {
        method,
        headers: {
            'Authorization': `Bearer ${MS_TOKEN}`,
            'Accept-Encoding': 'gzip',
            'Content-Type': 'application/json',
        }
    };
    if (body) opts.body = JSON.stringify(body);

    const r = await fetch(MS_API + urlPath, opts);
    const text = await r.text();

    if (!r.ok) {
        let msg = text;
        try {
            const j = JSON.parse(text);
            msg = (j.errors && j.errors[0] && j.errors[0].error) || text;
        } catch {}
        throw new Error(`МойСклад ${r.status}: ${msg}`);
    }
    return text ? JSON.parse(text) : {};
}

async function findReturnByName(returnName) {
    // Ищем возврат покупателя по номеру (полю "name")
    const data = await msRequest(
        'GET',
        `/entity/customerreturn?filter=name=${encodeURIComponent(returnName)}&limit=10`
    );

    if (!data.rows || data.rows.length === 0) {
        throw new Error(`Возврат с номером "${returnName}" не найден в МойСклад`);
    }

    if (data.rows.length > 1) {
        log(`⚠ Найдено несколько возвратов с номером ${returnName}, беру первый`);
    }

    return data.rows[0];
}

async function getVideoFieldMetadata() {
    // Получаем метаданные доп. полей возврата покупателя
    const meta = await msRequest('GET', '/entity/customerreturn/metadata/attributes');

    const field = (meta.rows || []).find(f => f.name === VIDEO_FIELD_NAME);
    if (!field) {
        throw new Error(
            `Дополнительное поле "${VIDEO_FIELD_NAME}" не найдено в Возвратах покупателей. ` +
            `Создайте его в настройках МойСклад.`
        );
    }
    return field;
}

let cachedVideoField = null;
async function getVideoField() {
    if (!cachedVideoField) {
        cachedVideoField = await getVideoFieldMetadata();
        log(`Доп. поле "${VIDEO_FIELD_NAME}" найдено (id: ${cachedVideoField.id}, type: ${cachedVideoField.type})`);
    }
    return cachedVideoField;
}

async function updateReturnVideo(returnId, videoUrl) {
    const field = await getVideoField();

    // Структура attributes для МойСклад API
    const body = {
        attributes: [
            {
                meta: {
                    href: `${MS_API}/entity/customerreturn/metadata/attributes/${field.id}`,
                    type: 'attributemetadata',
                    mediaType: 'application/json',
                },
                id: field.id,
                value: videoUrl,
            }
        ]
    };

    await msRequest('PUT', `/entity/customerreturn/${returnId}`, body);
    log(`Возврат ${returnId} обновлён, поле "${VIDEO_FIELD_NAME}" = ${videoUrl}`);
}

// ===== ОСНОВНОЙ ЭНДПОИНТ =====
app.post('/api/process-return', requireApiKey, upload.single('video'), async (req, res) => {
    const startTime = Date.now();
    let tmpFilePath = null;

    try {
        const barcode = (req.body.barcode || '').trim();
        const filename = (req.body.filename || `${barcode}.mp4`).trim();

        if (!barcode) {
            return res.status(400).json({ error: 'Не указан barcode' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'Видеофайл не получен' });
        }

        tmpFilePath = req.file.path;
        const fileSize = req.file.size;

        log(`📦 Новый возврат: ${barcode} (${(fileSize / 1024 / 1024).toFixed(1)} МБ)`);

        // 1. Загружаем на Яндекс.Диск
        log(`⬆ Загрузка на Яндекс.Диск...`);
        const yandex = await uploadToYandex(tmpFilePath, filename);

        // 2. Находим возврат в МойСклад
        log(`🔍 Поиск возврата в МойСклад: ${barcode}`);
        const returnDoc = await findReturnByName(barcode);

        // 3. Обновляем поле "Видео"
        log(`✏ Обновление поля "${VIDEO_FIELD_NAME}"...`);
        await updateReturnVideo(returnDoc.id, yandex.publicUrl);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log(`✅ Готово за ${elapsed}с: ${barcode}`);

        res.json({
            success: true,
            barcode,
            videoUrl: yandex.publicUrl,
            yandexPath: yandex.path,
            returnId: returnDoc.id,
            elapsed,
        });

    } catch (e) {
        err(`Ошибка обработки: ${e.message}`);
        res.status(500).json({ error: e.message });
    } finally {
        // Удаляем временный файл
        if (tmpFilePath && fs.existsSync(tmpFilePath)) {
            fs.unlink(tmpFilePath, () => {});
        }
    }
});

// ===== ПРОВЕРКА =====
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        time: new Date().toISOString(),
        config: {
            hasApiKey: !!API_KEY,
            hasYandex: !!YANDEX_TOKEN,
            hasMoysklad: !!MS_TOKEN,
            yandexFolder: YANDEX_FOLDER,
            videoFieldName: VIDEO_FIELD_NAME,
        }
    });
});

// Тестовый эндпоинт - проверить настройки токенов
app.get('/api/test', requireApiKey, async (req, res) => {
    const result = { yandex: null, moysklad: null };

    try {
        const r = await fetch(YA_API + '/', {
            headers: { 'Authorization': `OAuth ${YANDEX_TOKEN}` }
        });
        const data = await r.json();
        result.yandex = {
            ok: r.ok,
            user: data.user?.display_name || data.user?.login || 'unknown',
            usedSpace: data.used_space,
            totalSpace: data.total_space,
        };
    } catch (e) {
        result.yandex = { ok: false, error: e.message };
    }

    try {
        const field = await getVideoFieldMetadata();
        result.moysklad = {
            ok: true,
            videoFieldId: field.id,
            videoFieldType: field.type,
        };
    } catch (e) {
        result.moysklad = { ok: false, error: e.message };
    }

    res.json(result);
});

// ===== СТАРТ =====
app.listen(PORT, () => {
    console.log('================================');
    console.log(`  Кладовщик-сервер запущен`);
    console.log(`  Порт: ${PORT}`);
    console.log(`  API ключ: ${API_KEY ? '✓ задан' : '✗ НЕ ЗАДАН'}`);
    console.log(`  Яндекс.Диск: ${YANDEX_TOKEN ? '✓ задан' : '✗ НЕ ЗАДАН'}`);
    console.log(`  МойСклад: ${MS_TOKEN ? '✓ задан' : '✗ НЕ ЗАДАН'}`);
    console.log(`  Папка: /${YANDEX_FOLDER}`);
    console.log(`  Поле: "${VIDEO_FIELD_NAME}"`);
    console.log('================================');
});
