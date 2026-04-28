502 — это «сервер ушёл и не вернулся». Скорее всего, при коммите файла что-то сломалось — недостающая запятая, лишний символ. Сервис не смог запуститься после деплоя, и Render отдаёт 502 на любой запрос.
Шаг 1: проверьте логи Render
Откройте Render → ваш Web Service → Logs. Найдите свежие строки после последнего деплоя. Там должно быть либо:

SyntaxError: ... или ReferenceError: ... — синтаксическая ошибка в коде
Или процесс падает циклически — Exited with status 1 много раз подряд

Пришлите сюда логи сразу после строки ==> Running 'cd backend && npm start' — там увидим точную ошибку.
Шаг 2: пришлите текущий moysklad.js
Параллельно — давайте я посмотрю, что у вас сейчас в файле. В GitHub откройте backend/lib/moysklad.js → нажмите Raw → скопируйте всё → вставьте сюда. Я найду место, где сломалось.
Альтернатива — давайте я дам вам полный файл целиком
Вместо точечных правок (которые мы делаем уже не первый раз и явно с ошибками) — вот полный готовый moysklad.js. Замените весь файл на этот код:
js// Поиск возврата покупателя по номеру и обновление доп. поля "Видео"
const API = 'https://api.moysklad.ru/api/remap/1.2';

const POSSIBLE_ENTITIES = ['salesreturn', 'customerreturn', 'purchasereturn'];

function authHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json;charset=utf-8',
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip',
  };
}

let entityName = null;
let metadataCache = null;
let metadataCacheTime = 0;
const METADATA_TTL = 60 * 60 * 1000;

// Универсально достаём массив attributes — он бывает в форме [...] или {rows:[...]}
function normalizeAttributes(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.rows)) return input.rows;
  return [];
}

async function detectEntityName(token) {
  if (entityName) return entityName;

  const errors = [];
  for (const name of POSSIBLE_ENTITIES) {
    try {
      const r = await fetch(`${API}/entity/${name}/metadata`, { headers: authHeaders(token) });
      if (r.ok) {
        entityName = name;
        console.log(`  МойСклад: использую сущность "${name}"`);
        return name;
      }
      const text = await r.text();
      errors.push(`${name}: ${r.status} ${text.slice(0, 200)}`);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(`МойСклад: ни один эндпоинт возврата покупателя не подошёл. Попытки: ${errors.join(' | ')}`);
}

async function getReturnMetadata(token) {
  const now = Date.now();
  if (metadataCache && now - metadataCacheTime < METADATA_TTL) return metadataCache;

  const name = await detectEntityName(token);
  const r = await fetch(`${API}/entity/${name}/metadata`, { headers: authHeaders(token) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`МойСклад: метаданные не получены: ${r.status} ${text}`);
  }
  const data = await r.json();
  metadataCache = data;
  metadataCacheTime = now;
  return data;
}

async function findVideoAttribute(token, fieldName) {
  const meta = await getReturnMetadata(token);
  const attrs = normalizeAttributes(meta.attributes);

  console.log(`  МойСклад: найдено ${attrs.length} доп. полей в метаданных`);

  const found = attrs.find(a => a.name === fieldName);
  if (!found) {
    const available = attrs.map(a => `"${a.name}"`).join(', ') || '(нет)';
    throw new Error(`МойСклад: поле "${fieldName}" не найдено. Доступные: ${available}`);
  }
  return found;
}

async function findReturnByNumber(token, returnNumber) {
  const name = await detectEntityName(token);
  const url = `${API}/entity/${name}?filter=name=${encodeURIComponent(returnNumber)}&limit=1`;
  const r = await fetch(url, { headers: authHeaders(token) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`МойСклад: поиск не удался: ${r.status} ${text}`);
  }
  const data = await r.json();
  const rows = data.rows || [];
  if (rows.length === 0) {
    throw new Error(`МойСклад: возврат "${returnNumber}" не найден`);
  }
  return rows[0];
}

async function updateAttribute(token, returnEntity, attributeMeta, value) {
  const existing = normalizeAttributes(returnEntity.attributes);

  const attrPayload = {
    meta: attributeMeta.meta,
    id: attributeMeta.id,
    name: attributeMeta.name,
    value: value,
  };

  const updatedAttrs = [];
  let replaced = false;
  for (const a of existing) {
    if (a.id === attributeMeta.id) {
      updatedAttrs.push(attrPayload);
      replaced = true;
    } else {
      updatedAttrs.push({ meta: a.meta, id: a.id, name: a.name, value: a.value });
    }
  }
  if (!replaced) updatedAttrs.push(attrPayload);

  const name = await detectEntityName(token);
  const url = `${API}/entity/${name}/${returnEntity.id}`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({ attributes: updatedAttrs }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`МойСклад: обновление не удалось: ${r.status} ${text}`);
  }
}

export async function updateReturnVideoField({ token, fieldName, returnNumber, link }) {
  if (!token) throw new Error('Не указан MOYSKLAD_TOKEN');
  const attributeMeta = await findVideoAttribute(token, fieldName);
  const returnEntity = await findReturnByNumber(token, returnNumber);
  await updateAttribute(token, returnEntity, attributeMeta, link);
}
