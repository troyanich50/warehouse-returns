// МойСклад: проверка/создание возврата + обновление поля "Видео"

const API = 'https://api.moysklad.ru/api/remap/1.2';

const POSSIBLE_ENTITIES = ['salesreturn', 'customerreturn', 'purchasereturn'];

// Параметры для автосоздания нового возврата (если по ШК не найден)
const DEFAULT_ORGANIZATION = 'alpatoffltd';
const DEFAULT_STORE = 'ООО "АЛПАТОФФ" Возвраты';
const DEFAULT_AGENT = 'Розничный покупатель';

function authHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json;charset=utf-8',
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip',
  };
}

let cachedEntity = null;

function normalizeAttributes(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.rows)) return input.rows;
  return [];
}

// Поиск документа по номеру в одной из возможных сущностей
async function findReturnIdByNumber(token, returnNumber) {
  if (cachedEntity) {
    const url = `${API}/entity/${cachedEntity}?filter=name=${encodeURIComponent(returnNumber)}&limit=1`;
    const r = await fetch(url, { headers: authHeaders(token) });
    if (r.ok) {
      const data = await r.json();
      if (data.rows && data.rows.length > 0) return { entity: cachedEntity, id: data.rows[0].id };
    }
    cachedEntity = null;
  }

  for (const name of POSSIBLE_ENTITIES) {
    try {
      const url = `${API}/entity/${name}?filter=name=${encodeURIComponent(returnNumber)}&limit=1`;
      const r = await fetch(url, { headers: authHeaders(token) });
      if (!r.ok) continue;
      const data = await r.json();
      if (data.rows && data.rows.length > 0) {
        cachedEntity = name;
        return { entity: name, id: data.rows[0].id };
      }
    } catch {}
  }
  return null; // не найден
}

// Определить рабочую сущность (из любого пустого поиска — нам нужна сущность для создания)
async function detectEntity(token) {
  if (cachedEntity) return cachedEntity;
  for (const name of POSSIBLE_ENTITIES) {
    try {
      const r = await fetch(`${API}/entity/${name}?limit=1`, { headers: authHeaders(token) });
      if (r.ok) {
        cachedEntity = name;
        return name;
      }
    } catch {}
  }
  throw new Error('МойСклад: не удалось определить сущность возврата покупателя');
}

async function fetchFullDoc(token, entity, id) {
  const url = `${API}/entity/${entity}/${id}`;
  const r = await fetch(url, { headers: authHeaders(token) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`МойСклад: не удалось получить документ ${id}: ${r.status} ${text}`);
  }
  return r.json();
}

// Берём metadata атрибута поля по имени
async function getFieldMeta(token, entity, fieldName) {
  const r = await fetch(`${API}/entity/${entity}/metadata/attributes`, { headers: authHeaders(token) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`МойСклад: не удалось получить атрибуты сущности: ${r.status} ${text}`);
  }
  const data = await r.json();
  const allAttrs = normalizeAttributes(data);
  const fieldMeta = allAttrs.find(a => a.name === fieldName);
  if (!fieldMeta) {
    throw new Error(`МойСклад: поле "${fieldName}" не найдено в атрибутах сущности "${entity}"`);
  }
  return fieldMeta;
}

// Поиск справочника по имени (организация, склад, контрагент)
async function findRefByName(token, endpoint, name) {
  const url = `${API}/entity/${endpoint}?filter=name=${encodeURIComponent(name)}&limit=1`;
  const r = await fetch(url, { headers: authHeaders(token) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`МойСклад: не удалось найти "${name}" в ${endpoint}: ${r.status} ${text}`);
  }
  const data = await r.json();
  const rows = data.rows || [];
  if (rows.length === 0) {
    throw new Error(`МойСклад: "${name}" не найден в ${endpoint}`);
  }
  return rows[0];
}

// =============== ПУБЛИЧНЫЕ ФУНКЦИИ ===============

/**
 * Проверка возврата по номеру.
 * Возвращает один из вариантов:
 *   { status: 'not_found' }
 *   { status: 'has_video', videoUrl }
 *   { status: 'ready', entity, id }
 */
export async function checkReturnByNumber({ token, fieldName, returnNumber }) {
  if (!token) throw new Error('Не указан MOYSKLAD_TOKEN');

  const found = await findReturnIdByNumber(token, returnNumber);
  if (!found) return { status: 'not_found' };

  const doc = await fetchFullDoc(token, found.entity, found.id);
  const attrs = normalizeAttributes(doc.attributes);
  const videoAttr = attrs.find(a => a.name === fieldName);

  if (videoAttr && videoAttr.value && String(videoAttr.value).trim() !== '') {
    return { status: 'has_video', videoUrl: String(videoAttr.value) };
  }

  return { status: 'ready', entity: found.entity, id: found.id };
}

/**
 * Создаёт новый возврат покупателя в МойСклад с указанным номером.
 * Возвращает { entity, id }.
 */
export async function createReturn({ token, returnNumber }) {
  if (!token) throw new Error('Не указан MOYSKLAD_TOKEN');

  const entity = await detectEntity(token);

  // Подгружаем справочники (один раз — могли бы кешировать, но запросы быстрые)
  const [organization, store, agent] = await Promise.all([
    findRefByName(token, 'organization', DEFAULT_ORGANIZATION),
    findRefByName(token, 'store', DEFAULT_STORE),
    findRefByName(token, 'counterparty', DEFAULT_AGENT),
  ]);

  const body = {
    name: returnNumber,
    organization: { meta: organization.meta },
    store: { meta: store.meta },
    agent: { meta: agent.meta },
  };

  const r = await fetch(`${API}/entity/${entity}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`МойСклад: не удалось создать возврат: ${r.status} ${text}`);
  }
  const created = await r.json();
  return { entity, id: created.id };
}

/**
 * Записывает ссылку на видео в поле fieldName указанного возврата.
 * Если возврата нет — пробрасывает ошибку (вызывающая сторона должна была его создать).
 */
export async function updateReturnVideoField({ token, fieldName, returnNumber, link, knownEntity, knownId }) {
  if (!token) throw new Error('Не указан MOYSKLAD_TOKEN');

  let entity = knownEntity;
  let id = knownId;

  if (!entity || !id) {
    const found = await findReturnIdByNumber(token, returnNumber);
    if (!found) throw new Error(`МойСклад: возврат "${returnNumber}" не найден`);
    entity = found.entity;
    id = found.id;
  }

  const doc = await fetchFullDoc(token, entity, id);
  const existing = normalizeAttributes(doc.attributes);
  const fieldInDoc = existing.find(a => a.name === fieldName);

  let attrPayload;
  if (fieldInDoc) {
    attrPayload = {
      meta: fieldInDoc.meta,
      id: fieldInDoc.id,
      name: fieldInDoc.name,
      value: link,
    };
  } else {
    const fieldMeta = await getFieldMeta(token, entity, fieldName);
    attrPayload = {
      meta: fieldMeta.meta,
      id: fieldMeta.id,
      name: fieldMeta.name,
      value: link,
    };
  }

  const updatedAttrs = [];
  let replaced = false;
  for (const a of existing) {
    if (fieldInDoc && a.id === fieldInDoc.id) {
      updatedAttrs.push(attrPayload);
      replaced = true;
    } else {
      updatedAttrs.push({ meta: a.meta, id: a.id, name: a.name, value: a.value });
    }
  }
  if (!replaced) updatedAttrs.push(attrPayload);

  const url = `${API}/entity/${entity}/${id}`;
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
