// Загрузка файла на Яндекс.Диск + публикация + получение публичной ссылки
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://cloud-api.yandex.net/v1/disk';

function authHeaders(token) {
  return {
    'Authorization': `OAuth ${token}`,
    'Accept': 'application/json',
  };
}

// Создаём папку. Если несколько уровней (например "Видео склад/Возвраты") — создаём по очереди.
async function ensureFolder(token, folderPath) {
  // folderPath начинается с / и не имеет завершающего /
  // Разбиваем на части и создаём от корня вглубь.
  const parts = folderPath.replace(/^\/+/, '').split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const url = `${API}/resources?path=${encodeURIComponent('/' + current)}`;
    const r = await fetch(url, { method: 'PUT', headers: authHeaders(token) });
    if (r.status === 201 || r.status === 409) continue;
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Не удалось создать папку "/${current}": ${r.status} ${text}`);
    }
  }
}

async function resourceExists(token, remotePath) {
  const url = `${API}/resources?path=${encodeURIComponent(remotePath)}&fields=path`;
  const r = await fetch(url, { headers: authHeaders(token) });
  if (r.status === 200) return true;
  if (r.status === 404) return false;
  const text = await r.text();
  throw new Error(`Не удалось проверить существование файла: ${r.status} ${text}`);
}

async function resolveUniqueName(token, folderPath, baseName, suffixStrategy = 'new') {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);

  let candidate = baseName;
  let candidatePath = `${folderPath}/${candidate}`;
  if (!(await resourceExists(token, candidatePath))) {
    return candidate;
  }

  if (suffixStrategy === 'numeric') {
    for (let i = 1; i <= 100; i++) {
      candidate = `${stem}_${i}${ext}`;
      candidatePath = `${folderPath}/${candidate}`;
      if (!(await resourceExists(token, candidatePath))) {
        return candidate;
      }
    }
  } else {
    candidate = `${stem}_new${ext}`;
    candidatePath = `${folderPath}/${candidate}`;
    if (!(await resourceExists(token, candidatePath))) {
      return candidate;
    }
    for (let i = 2; i <= 50; i++) {
      candidate = `${stem}_new_${i}${ext}`;
      candidatePath = `${folderPath}/${candidate}`;
      if (!(await resourceExists(token, candidatePath))) {
        return candidate;
      }
    }
  }

  throw new Error(`Не удалось подобрать уникальное имя для "${baseName}"`);
}

async function getUploadUrl(token, remotePath) {
  const url = `${API}/resources/upload?path=${encodeURIComponent(remotePath)}&overwrite=false`;
  const r = await fetch(url, { headers: authHeaders(token) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Не удалось получить URL загрузки: ${r.status} ${text}`);
  }
  const data = await r.json();
  return data.href;
}

async function uploadFile(uploadUrl, localPath) {
  const stat = fs.statSync(localPath);
  const stream = fs.createReadStream(localPath);
  const r = await fetch(uploadUrl, {
    method: 'PUT',
    body: stream,
    duplex: 'half',
    headers: { 'Content-Length': String(stat.size) },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Загрузка не удалась: ${r.status} ${text}`);
  }
}

async function publishResource(token, remotePath) {
  const url = `${API}/resources/publish?path=${encodeURIComponent(remotePath)}`;
  const r = await fetch(url, { method: 'PUT', headers: authHeaders(token) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Не удалось опубликовать файл: ${r.status} ${text}`);
  }
}

async function getResourceMeta(token, remotePath) {
  const url = `${API}/resources?path=${encodeURIComponent(remotePath)}&fields=public_url,file,name,path`;
  const r = await fetch(url, { headers: authHeaders(token) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Не удалось получить метаданные: ${r.status} ${text}`);
  }
  return r.json();
}

export async function uploadToYandexDisk({ token, folder, remoteName, localPath, suffixStrategy }) {
  if (!token) throw new Error('Не указан YANDEX_DISK_TOKEN');

  // folder может быть:
  //   "Возвраты"
  //   "Видео склад/Возвраты"
  //   "/Видео склад/Возвраты"
  // Нормализуем — убираем ведущие/конечные слэши, потом добавляем один в начало.
  const cleanFolder = String(folder || '').replace(/^\/+|\/+$/g, '');
  const folderPath = cleanFolder ? `/${cleanFolder}` : '';

  if (cleanFolder) await ensureFolder(token, folderPath);

  const finalName = cleanFolder
    ? await resolveUniqueName(token, folderPath, remoteName, suffixStrategy)
    : remoteName;

  if (finalName !== remoteName) {
    console.log(`  Yandex Disk: имя "${remoteName}" занято, использую "${finalName}"`);
  }

  const remotePath = cleanFolder ? `${folderPath}/${finalName}` : `/${finalName}`;
  const uploadUrl = await getUploadUrl(token, remotePath);
  await uploadFile(uploadUrl, localPath);
  await publishResource(token, remotePath);

  const meta = await getResourceMeta(token, remotePath);
  if (!meta.public_url) {
    throw new Error('Файл загружен, но не получена публичная ссылка');
  }
  return meta.public_url;
}
