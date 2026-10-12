/**
 * images.js -- question figures: upload (admin) and serving (public).
 *
 * Role: replaces the Google Drive thumbnails the old system used (an
 * undocumented endpoint that sometimes failed to load in class). An image is
 * stored once in R2 under `img/<sha256 of its bytes>` and served from the
 * Worker at /img/<hash>.
 *
 * Why the content hash is the name:
 *   - the same figure uploaded twice is stored once;
 *   - the URL can never change content, so browsers may cache it for a year
 *     ("immutable") and 60 students loading one figure cost one fetch each;
 *   - a replaced figure gets a NEW url, so a stale cache cannot show the old one.
 *
 * Safety: the type is decided from the file's own first bytes, never from the
 * Content-Type the client claims, and only raster formats are accepted (an SVG
 * can carry scripts). Responses carry `nosniff` so a browser never reinterprets
 * the bytes as something else.
 */

import { HttpError } from './http.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;   // the admin page downscales to <= 1600 px first
const HASH_RE = /^[a-f0-9]{64}$/;

/** Returns the MIME type for the bytes, or null when it is not an accepted raster image. */
export function sniffImageType(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) { return 'image/png'; }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) { return 'image/jpeg'; }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) { return 'image/gif'; }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) { return 'image/webp'; }
  return null;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * POST /api/admin/images -- the request body IS the image (raw bytes).
 * The original file name travels in the X-Filename header, URL-encoded.
 */
export async function uploadImage(c) {
  const { env, deps, request } = c;
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_IMAGE_BYTES) { throw new HttpError(413, 'too_large', 'Image is larger than 2 MB'); }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength === 0) { throw new HttpError(400, 'bad_request', 'Empty body'); }
  if (buffer.byteLength > MAX_IMAGE_BYTES) { throw new HttpError(413, 'too_large', 'Image is larger than 2 MB'); }

  const mime = sniffImageType(new Uint8Array(buffer));
  if (!mime) { throw new HttpError(415, 'bad_type', 'Only PNG, JPEG, GIF or WebP images are accepted'); }

  const hash = await sha256Hex(buffer);
  const known = await env.DB.prepare('SELECT hash FROM images WHERE hash = ?').bind(hash).first();
  if (!known) {
    await env.FILES.put('img/' + hash, buffer, { httpMetadata: { contentType: mime } });
    let name = '';
    try { name = decodeURIComponent(request.headers.get('X-Filename') || ''); } catch (e) { name = ''; }
    await env.DB.prepare(
      'INSERT OR IGNORE INTO images (hash, mime, size_bytes, original_name, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(hash, mime, buffer.byteLength, name.slice(0, 200), c.teacher.email, deps.now()).run();
  }
  return { body: { success: true, hash, url: '/img/' + hash, size: buffer.byteLength, mime, existed: !!known } };
}

/**
 * GET /img/<hash> -- public, no session: the figures are part of the exam page
 * every student sees. Returns null when the path is not an image path so the
 * router can fall through to its 404.
 */
export async function serveImage(request, env, pathname) {
  const m = /^\/img\/([a-f0-9]{64})$/.exec(pathname);
  if (!m || (request.method !== 'GET' && request.method !== 'HEAD')) { return null; }
  if (!HASH_RE.test(m[1])) { return null; }
  const object = await env.FILES.get('img/' + m[1]);
  if (!object) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(request.method === 'HEAD' ? null : object.body, {
    status: 200,
    headers: {
      'Content-Type': (object.httpMetadata && object.httpMetadata.contentType) || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
