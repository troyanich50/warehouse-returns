// Загрузка файла на Яндекс.Диск + публикация + получение публичной ссылки
import fs from 'node:fs';

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

async function getUploadUrl(token, remotePath) {
  const url = `${API}/resources/upload?path=${encodeURIComponent(remotePath)}&overwrite=true`;
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

export async function uploadToYandexDisk({ token, folder, remoteName, localPath }) {
  if (!token) throw new Error('Не указан YANDEX_DISK_TOKEN');

  const cleanFolder = String(folder || '').replace(/^\/+|\/+$/g, '');
  const remotePath = cleanFolder ? `/${cleanFolder}/${remoteName}` : `/${remoteName}`;

  if (cleanFolder) await ensureFolder(token, `/${cleanFolder}`);
  const uploadUrl = await getUploadUrl(token, remotePath);
  await uploadFile(uploadUrl, localPath);
  await publishResource(token, remotePath);

  const meta = await getResourceMeta(token, remotePath);
  if (!meta.public_url) {
    throw new Error('Файл загружен, но не получена публичная ссылка');
  }
  return meta.public_url;
}