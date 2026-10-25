/* =========================================================
   Cloudflare Worker: принимает бриф с сайта и пересылает
   его в Telegram сообщениями. На сайте этот файл не нужен.

   Переменные окружения (Worker → Settings → Variables and Secrets):
     BOT_TOKEN       — токен бота от @BotFather (тип Secret)
     CHAT_ID         — куда присылать брифы (ваш id или id группы)
     ALLOWED_ORIGIN  — адрес сайта, например https://enikonov565-cloud.github.io
                       (необязательно, но лучше указать — чужие сайты не смогут слать заявки)

   Запросы:
     POST application/json    — сам бриф (текст)
     POST multipart/form-data — один файл-референс (поля briefId, name, index, total, file)
   ========================================================= */

const TG_LIMIT = 4096;        // лимит Telegram на одно сообщение
const SAFE_LIMIT = 3900;      // берём с запасом на теги и служебные подписи
const MAX_FILE = 20 * 1024 * 1024;
const PAUSE_MS = 400;         // пауза между сообщениями, чтобы Telegram не ограничивал

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ ok: false, error: 'Только POST' }, 405, cors);
    if (env.ALLOWED_ORIGIN && !isAllowed(origin, env)) return json({ ok: false, error: 'Чужой сайт' }, 403, cors);
    if (!env.BOT_TOKEN || !env.CHAT_ID) return json({ ok: false, error: 'Worker не настроен: нет BOT_TOKEN или CHAT_ID' }, 500, cors);

    try {
      const type = request.headers.get('Content-Type') || '';
      if (type.includes('multipart/form-data')) {
        await handleFile(request, env);
        return json({ ok: true }, 200, cors);
      }

      const data = await request.json();
      if (data.website) return json({ ok: true }, 200, cors);   // сработала ловушка для ботов
      if (!data || !Array.isArray(data.sections)) return json({ ok: false, error: 'Пустой бриф' }, 400, cors);

      const messages = buildMessages(data);
      for (let i = 0; i < messages.length; i++) {
        await tg(env, 'sendMessage', {
          chat_id: env.CHAT_ID,
          text: messages[i],
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
        if (i < messages.length - 1) await sleep(PAUSE_MS);
      }
      return json({ ok: true, messages: messages.length }, 200, cors);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 502, cors);
    }
  }
};

/* ---------- Сообщения ---------- */
function buildMessages(d) {
  const messages = [];
  const str = v => String(v == null ? '' : v).slice(0, 20000).trim();

  // 1. Сводка: имя, контакт и главное по делу
  const head = [];
  head.push(`<b>📸 Новый бриф${Number(d.attempt) > 1 ? ' (повторная отправка)' : ''}</b>`);
  head.push('');
  head.push(`<b>Имя:</b> ${esc(str(d.name)) || '—'}`);
  head.push(`<b>Контакт:</b> ${contactLink(str(d.contact))}`);
  (Array.isArray(d.summary) ? d.summary : []).forEach(s => {
    const a = str(s && s.a).replace(/\n+/g, ', ');
    if (a) head.push(`<b>${esc(str(s.q))}:</b> ${esc(a)}`);
  });
  const files = Array.isArray(d.files) ? d.files : [];
  if (files.length) head.push(`<b>Файлы:</b> ${files.length} — придут следом`);
  head.push('');
  head.push(`<i>№ ${esc(str(d.id))} · ${esc(formatDate(d.createdAt))}</i>`);
  messages.push(...splitBlocks(head.join('\n').split('\n\n'), ''));

  // 2. Каждый этап — отдельным сообщением, вопросы жирным, пустые не показываем
  d.sections.forEach(section => {
    const title = str(section && section.title);
    const items = (Array.isArray(section.items) ? section.items : [])
      .map(it => ({ q: str(it && it.q), a: str(it && it.a) }))
      .filter(it => it.a);
    if (!items.length) return;
    messages.push(...buildSection(title, items));
  });

  return messages;
}

// Этап: заголовок + вопросы. Если не влезает в одно сообщение — делим по ответам,
// а длинный ответ — по абзацам, строкам, предложениям (не посреди фразы)
function buildSection(title, items) {
  const header = `<b>${esc(title.toUpperCase())}</b>`;
  const contHeader = `<b>${esc(title.toUpperCase())} · продолжение</b>`;
  const blocks = [];
  items.forEach(it => {
    const q = `<b>${esc(it.q)}</b>`;
    const room = SAFE_LIMIT - contHeader.length - q.length - 10;
    splitText(it.a, room).forEach((part, i) => {
      blocks.push(i === 0 ? `${q}\n${esc(part)}` : `<i>(продолжение ответа)</i>\n${esc(part)}`);
    });
  });
  return splitBlocks(blocks, header, contHeader);
}

// Собирает блоки в сообщения, не превышая лимит
function splitBlocks(blocks, header, contHeader = header) {
  const out = [];
  let cur = header;
  blocks.forEach(block => {
    const candidate = cur ? `${cur}\n\n${block}` : block;
    if (candidate.length <= SAFE_LIMIT) { cur = candidate; return; }
    if (cur && cur !== header && cur !== contHeader) out.push(cur);
    cur = contHeader ? `${contHeader}\n\n${block}` : block;
    if (cur.length > TG_LIMIT) cur = cur.slice(0, TG_LIMIT);   // страховка, сюда не попадаем
  });
  if (cur && cur !== header && cur !== contHeader) out.push(cur);
  return out;
}

// Делит текст на части так, чтобы после экранирования каждая была не длиннее max
function splitText(text, max) {
  if (esc(text).length <= max) return [text];
  const levels = [
    { re: /\n\s*\n/, join: '\n\n' },          // абзацы
    { re: /\n/, join: '\n' },                 // строки
    { re: /(?<=[.!?…])\s+/, join: ' ' },      // предложения
    { re: /\s+/, join: ' ' }                  // слова
  ];
  for (const { re, join } of levels) {
    const parts = text.split(re).filter(p => p.trim());
    if (parts.length < 2) continue;
    const out = [];
    let cur = '';
    parts.forEach(p => {
      if (esc(p).length > max) {
        if (cur) { out.push(cur); cur = ''; }
        out.push(...splitText(p, max));
        return;
      }
      const next = cur ? cur + join + p : p;
      if (esc(next).length <= max) cur = next;
      else { out.push(cur); cur = p; }
    });
    if (cur) out.push(cur);
    return out;
  }
  // Одно очень длинное «слово» (например, ссылка) — режем по символам
  const out = [];
  let cur = '';
  for (const ch of text) {
    if (esc(cur + ch).length > max) { out.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/* ---------- Файлы ---------- */
async function handleFile(request, env) {
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new Error('Нет файла');
  if (file.size > MAX_FILE) throw new Error('Файл слишком большой');

  const name = String(form.get('name') || '').slice(0, 100);
  const caption = `Референс ${form.get('index') || ''}/${form.get('total') || ''}` +
    (name ? ` · ${esc(name)}` : '') + ` · № ${esc(String(form.get('briefId') || '').slice(0, 20))}`;

  const body = new FormData();
  body.append('chat_id', env.CHAT_ID);
  body.append('caption', caption);
  body.append('parse_mode', 'HTML');
  body.append('document', file, file.name || 'file');
  await tg(env, 'sendDocument', body, true);
}

/* ---------- Telegram API с повтором при ограничении частоты ---------- */
async function tg(env, method, payload, isForm = false) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, isForm
      ? { method: 'POST', body: payload }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (data.ok) return data;
    if (res.status === 429 && data.parameters && data.parameters.retry_after) {
      await sleep((data.parameters.retry_after + 0.5) * 1000);
      continue;
    }
    if (res.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
    throw new Error(data.description || `Telegram ответил ${res.status}`);
  }
  throw new Error('Telegram не принял сообщение после нескольких попыток');
}

/* ---------- Мелочи ---------- */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Ник Telegram превращаем в ссылку, телефон оставляем текстом
function contactLink(raw) {
  if (!raw) return '—';
  const nick = raw.match(/^(?:@|(?:https?:\/\/)?t\.me\/)([a-z0-9_]{4,32})$/i);
  if (nick) return `<a href="https://t.me/${nick[1]}">@${esc(nick[1])}</a>`;
  return esc(raw);
}

function formatDate(iso) {
  const d = new Date(iso || Date.now());
  if (isNaN(d)) return '';
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) + ' мск';
}

function isAllowed(origin, env) {
  return String(env.ALLOWED_ORIGIN).split(',').map(s => s.trim().replace(/\/$/, '')).includes(origin);
}

function corsHeaders(origin, env) {
  const allow = !env.ALLOWED_ORIGIN ? '*' : (isAllowed(origin, env) ? origin : 'null');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
