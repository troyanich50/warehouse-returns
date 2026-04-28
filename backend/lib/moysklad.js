// Поиск возврата покупателя по номеру и обновление доп. поля Видео

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

let cachedEntity = null;

function normalizeAttributes(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.rows)) return input.rows;
  return [];
}

// Сначала ищем документ через filter — получаем его id и сущность
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

  const report = [];
  for (const name of POSSIBLE_ENTITIES) {
    try {
      const url = `${API}/entity/${name}?filter=name=${encodeURIComponent(returnNumber)}&limit=1`;
      const r = await fetch(url, { headers: authHeaders(token) });
      if (!r.ok) {
        report.push(`${name}: HTTP ${r.status}`);
        continue;
      }
      const data = await r.json();
      const rows = data.rows || [];
      report.push(`${name}: найдено ${rows.length}`);
      if (rows.length > 0) {
        cachedEntity = name;
        console.log(`  МойСклад: документ найден в сущности "${name}"`);
        return { entity: name, id: rows[0].id };
      }
    } catch (e) {
      report.push(`${name}: ошибка ${e.message}`);
    }
  }

  throw new Error(`МойСклад: возврат "${returnNumber}" не найден. ${report.join(' | ')}`);
}

// Запрашиваем полный документ по id — здесь attributes будет
async function fetchFullDoc(token, entity, id) {
  const url = `${API}/entity/${entity}/${id}`;
  const r = await fetch(url, { headers: authHeaders(token) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`МойСклад: не удалось получить документ ${id}: ${r.status} ${text}`);
  }
  return r.json();
}

async function updateDocVideoField({ token, entity, doc, fieldName, link }) {
  const existing = normalizeAttributes(doc.attributes);

  console.log(`  МойСклад: в документе ${existing.length} доп. полей: [${existing.map(a => a.name).join(', ')}]`);

  const fieldInDoc = existing.find(a => a.name === fieldName);

  // Если поле уже есть в документе — обновляем, иначе нужны метаданные поля
  let attrPayload;
  if (fieldInDoc) {
    attrPayload = {
      meta: fieldInDoc.meta,
      id: fieldInDoc.id,
      name: fieldInDoc.name,
      value: link,
    };
  } else {
    // Поле ещё ни разу не заполнялось — берём его описание из metadata сущности
    console.log(`  МойСклад: поле "${fieldName}" в документе пустое, ищем в metadata сущности "${entity}"`);
    const metaUrl = `${API}/entity/${entity}/metadata/attributes`;
    const r = await fetch(metaUrl, { headers: authHeaders(token) });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`МойСклад: не удалось получить список атрибутов сущности: ${r.status} ${text}`);
    }
    const data = await r.json();
    const allAttrs = normalizeAttributes(data);
    console.log(`  МойСклад: всего атрибутов в сущности "${entity}": ${allAttrs.length} [${allAttrs.map(a => a.name).join(', ')}]`);
    const fieldMeta = allAttrs.find(a => a.name === fieldName);
    if (!fieldMeta) {
      throw new Error(
        `МойСклад: поле "${fieldName}" не найдено в атрибутах сущности "${entity}". ` +
        `Доступные: [${allAttrs.map(a => a.name).join(', ') || 'нет'}]`
      );
    }
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

  const url = `${API}/entity/${entity}/${doc.id}`;
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
  const { entity, id } = await findReturnIdByNumber(token, returnNumber);
  const doc = await fetchFullDoc(token, entity, id);
  await updateDocVideoField({ token, entity, doc, fieldName, link });
}
