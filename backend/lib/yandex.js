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

async function ensureFolder(token, folder) {
  const url = `${API}/resources?path=${encodeURIComponent(folder)}`;
  const r = await fetch(url, { method: 'PUT', headers: authHeaders(token) });
  if (r.status === 201 || r.status === 409) return;
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Не удалось создать папку "${folder}": ${r.status} ${text}`);
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

/**
 * Подобрать уникальное имя файла, перебирая суффиксы.
 * @param {string} suffixStrategy — 'new' (для возвратов: name_new, name_new_2)
 *                                  или 'numeric' (для отгрузок: name_1, name_2)
 */
async function resolveUniqueName(token, folderPath, baseName, suffixStrategy = 'new') {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);

  // 1. Пробуем оригинальное имя
  let candidate = baseName;
  let candidatePath = `${folderPath}/${candidate}`;
  if (!(await resourceExists(token, candidatePath))) {
    return candidate;
  }

  if (suffixStrategy === 'numeric') {
    // Стратегия для отгрузок: name_1, name_2, ...
    for (let i = 1; i <= 100; i++) {
      candidate = `${stem}_${i}${ext}`;
      candidatePath = `${folderPath}/${candidate}`;
      if (!(await resourceExists(token, candidatePath))) {
        return candidate;
      }
    }
  } else {
    // Стратегия по умолчанию для возвратов: name_new, name_new_2, ...
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
