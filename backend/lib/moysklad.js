// Поиск возврата покупателя по номеру и обновление доп. поля "Видео"
const API = 'https://api.moysklad.ru/api/remap/1.2';

function authHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json;charset=utf-8',
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip',
  };
}

let metadataCache = null;
let metadataCacheTime = 0;
const METADATA_TTL = 60 * 60 * 1000;

async function getReturnMetadata(token) {
  const now = Date.now();
  if (metadataCache && now - metadataCacheTime < METADATA_TTL) return metadataCache;

  const r = await fetch(`${API}/entity/customerreturn/metadata`, { headers: authHeaders(token) });
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
  const attrs = meta.attributes || [];
  const found = attrs.find(a => a.name === fieldName);
  if (!found) {
    const available = attrs.map(a => `"${a.name}"`).join(', ') || '(нет)';
    throw new Error(`МойСклад: поле "${fieldName}" не найдено. Доступные: ${available}`);
  }
  return found;
}

async function findReturnByNumber(token, returnNumber) {
  const url = `${API}/entity/customerreturn?filter=name=${encodeURIComponent(returnNumber)}&limit=1`;
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
  const existing = returnEntity.attributes || [];

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

  const url = `${API}/entity/customerreturn/${returnEntity.id}`;
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