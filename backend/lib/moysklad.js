// Поиск возврата покупателя по номеру и обновление доп. поля "Видео"
const API = 'https://api.moysklad.ru/api/remap/1.2';

const POSSIBLE_ENTITIES = ['salesreturn', 'customerreturn', 'purchasereturn', 'demand', 'customerorder'];

function authHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json;charset=utf-8',
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip',
  };
}

let entityName = null;

function normalizeAttributes(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.rows)) return input.rows;
  return [];
}

// Перебираем сущности и ищем ту, в метаданных которой есть нужное поле
async function detectEntityWithField(token, fieldName) {
  if (entityName) return entityName;

  const report = [];
  for (const name of POSSIBLE_ENTITIES) {
    try {
      const r = await fetch(`${API}/entity/${name}/metadata`, { headers: authHeaders(token) });
      if (!r.ok) {
        report.push(`  ${name}: HTTP ${r.status}`);
        continue;
      }
      const data = await r.json();
      const attrs = normalizeAttributes(data.attributes);
      const fieldNames = attrs.map(a => a.name);
      report.push(`  ${name}: ${attrs.length} полей [${fieldNames.join(', ')}]`);

      if (attrs.find(a => a.name === fieldName)) {
        entityName = name;
        console.log(`  МойСклад: поле "${fieldName}" найдено в сущности "${name}"`);
        return name;
      }
    } catch (e) {
      report.push(`  ${name}: ошибка ${e.message}`);
    }
  }

  throw new Error(
    `МойСклад: поле "${fieldName}" не найдено ни в одной сущности.\n` +
    `Просмотрено:\n${report.join('\n')}`
  );
}

async function findReturnByNumber(token, returnNumber) {
  const name = entityName;
  if (!name) throw new Error('Сущность ещё не определена');
  const url = `${API}/entity/${name}?filter=name=${encodeURIComponent(returnNumber)}&limit=1`;
  const r = await fetch(url, { headers: authHeaders(token) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`МойСклад: поиск не удался: ${r.status} ${text}`);
  }
  const data = await r.json();
  const rows = data.rows || [];
  if (rows.length === 0) {
    throw new Error(`МойСклад: документ "${returnNumber}" не найден в сущности "${name}"`);
  }
  return rows[0];
}

async function getAttributeMeta(token, fieldName) {
  const r = await fetch(`${API}/entity/${entityName}/metadata`, { headers: authHeaders(token) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`МойСклад: метаданные не получены: ${r.status} ${text}`);
  }
  const data = await r.json();
  const attrs = normalizeAttributes(data.attributes);
  const found = attrs.find(a => a.name === fieldName);
  if (!found) {
    throw new Error(`МойСклад: поле "${fieldName}" пропало из метаданных сущности "${entityName}"`);
  }
  return found;
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

  const url = `${API}/entity/${entityName}/${returnEntity.id}`;
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

  await detectEntityWithField(token, fieldName);
  const attributeMeta = await getAttributeMeta(token, fieldName);
  const returnEntity = await findReturnByNumber(token, returnNumber);
  await updateAttribute(token, returnEntity, attributeMeta, link);
}
