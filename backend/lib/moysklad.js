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

async function findReturnByNumber(token, returnNumber) {
  if (cachedEntity) {
    const url = `${API}/entity/${cachedEntity}?filter=name=${encodeURIComponent(returnNumber)}&limit=1`;
    const r = await fetch(url, { headers: authHeaders(token) });
    if (r.ok) {
      const data = await r.json();
      if (data.rows && data.rows.length > 0) return { entity: cachedEntity, doc: data.rows[0] };
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
        return { entity: name, doc: rows[0] };
      }
    } catch (e) {
      report.push(`${name}: ошибка ${e.message}`);
    }
  }

  throw new Error(`МойСклад: возврат "${returnNumber}" не найден. ${report.join(' | ')}`);
}

async function updateDocVideoField({ token, entity, doc, fieldName, link }) {
  const existing = normalizeAttributes(doc.attributes);

  console.log(`  МойСклад: в документе ${existing.length} доп. полей: [${existing.map(a => a.name).join(', ')}]`);

  const fieldInDoc = existing.find(a => a.name === fieldName);
  if (!fieldInDoc) {
    throw new Error(
      `МойСклад: поле "${fieldName}" не найдено в документе. ` +
      `Доступные поля в документе: [${existing.map(a => a.name).join(', ') || 'нет ни одного'}]`
    );
  }

  const attrPayload = {
    meta: fieldInDoc.meta,
    id: fieldInDoc.id,
    name: fieldInDoc.name,
    value: link,
  };

  const updatedAttrs = existing.map(a =>
    a.id === fieldInDoc.id
      ? attrPayload
      : { meta: a.meta, id: a.id, name: a.name, value: a.value }
  );

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
  const { entity, doc } = await findReturnByNumber(token, returnNumber);
  await updateDocVideoField({ token, entity, doc, fieldName, link });
}
