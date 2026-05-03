// МойСклад: проверка/создание возврата + обновление поля "Видео" + статусы + комментарии

const API = 'https://api.moysklad.ru/api/remap/1.2';

const POSSIBLE_ENTITIES = ['salesreturn', 'customerreturn', 'purchasereturn'];

const DEFAULT_ORGANIZATION = 'alpatoffltd';
const DEFAULT_STORE = 'ООО "АЛПАТОФФ" Возвраты';
const DEFAULT_AGENT = 'Розничный покупатель';

const STATUS_NEW = 'Новый';
const STATUS_UNPACKED = 'Распакован';
const STATUS_ATTENTION = 'Требует внимания';

function authHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json;charset=utf-8',
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip',
  };
}

let cachedEntity = null;
let cachedStatuses = null; // map: name → state object

function normalizeAttributes(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.rows)) return input.rows;
  return [];
}

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
  return null;
}

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

// Загружаем все статусы сущности (один раз кешируем)
async function loadStatuses(token, entity) {
  if (cachedStatuses) return cachedStatuses;
  const r = await fetch(`${API}/entity/${entity}/metadata`, { headers: authHeaders(token) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`МойСклад: не удалось получить metadata: ${r.status} ${text}`);
  }
  const data = await r.json();
  const states = Array.isArray(data.states) ? data.states : [];
  const map = {};
  for (const s of states) map[s.name] = s;
  cachedStatuses = map;
  console.log(`  МойСклад: загружено статусов: ${Object.keys(map).length} [${Object.keys(map).join(', ')}]`);
  return map;
}

async function getStatusMeta(token, entity, statusName) {
  const map = await loadStatuses(token, entity);
  const status = map[statusName];
  if (!status) {
    throw new Error(`МойСклад: статус "${statusName}" не найден. Доступные: ${Object.keys(map).join(', ')}`);
  }
  return status;
}

// =============== ПУБЛИЧНЫЕ ФУНКЦИИ ===============

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
 * Создаёт новый возврат. Сразу ставит статус "Новый".
 */
export async function createReturn({ token, returnNumber }) {
  if (!token) throw new Error('Не указан MOYSKLAD_TOKEN');

  const entity = await detectEntity(token);

  const [organization, store, agent] = await Promise.all([
    findRefByName(token, 'organization', DEFAULT_ORGANIZATION),
    findRefByName(token, 'store', DEFAULT_STORE),
    findRefByName(token, 'counterparty', DEFAULT_AGENT),
  ]);

  // Пробуем найти статус "Новый" — если его нет, создадим документ без статуса
  let stateBlock = null;
  try {
    const statusMeta = await getStatusMeta(token, entity, STATUS_NEW);
    stateBlock = { meta: statusMeta.meta };
  } catch (e) {
    console.warn(`  МойСклад: ${e.message} — создаём возврат без статуса`);
  }

  const body = {
    name: returnNumber,
    organization: { meta: organization.meta },
    store: { meta: store.meta },
    agent: { meta: agent.meta },
  };
  if (stateBlock) body.state = stateBlock;

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
 * Записывает ссылку на видео + опционально меняет статус и/или добавляет комментарий.
 * @param {string} statusName — имя статуса для установки (например, "Распакован" или "Требует внимания").
 *                              Если не указано — статус не меняется.
 * @param {string} comment    — текст для добавления в поле "Комментарий" документа.
 *                              Если не указан — комментарий не меняется.
 */
export async function updateReturnVideoField({
  token,
  fieldName,
  returnNumber,
  link,
  statusName,
  comment,
  knownEntity,
  knownId,
}) {
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

  // Собираем тело PUT-запроса
  const body = { attributes: updatedAttrs };

  // Если просили — обновляем статус
  if (statusName) {
    try {
      const statusMeta = await getStatusMeta(token, entity, statusName);
      body.state = { meta: statusMeta.meta };
      console.log(`  МойСклад: статус будет изменён на "${statusName}"`);
    } catch (e) {
      console.warn(`  МойСклад: не удалось установить статус "${statusName}": ${e.message}`);
      // Не падаем — главное чтобы видео сохранилось
    }
  }

  // Если просили — добавляем комментарий
  if (comment && comment.trim()) {
    const existingComment = doc.description || '';
    const stamp = new Date().toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const newLine = `[${stamp}] ${comment.trim()}`;
    body.description = existingComment
      ? `${existingComment}\n${newLine}`
      : newLine;
    console.log(`  МойСклад: добавляется комментарий: ${newLine}`);
  }

  const url = `${API}/entity/${entity}/${id}`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`МойСклад: обновление не удалось: ${r.status} ${text}`);
  }
}
