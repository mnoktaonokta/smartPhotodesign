// Calls to the local Python server.

export async function uploadPhoto(file) {
  const response = await fetch(`/api/images?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    body: file,
  });
  return json(response);
}

export async function fetchPixels(id, { full = false, maxSide = null } = {}) {
  const params = new URLSearchParams();
  if (full) params.set("full", "true");
  if (maxSide) params.set("max_side", String(maxSide));
  const response = await fetch(`/api/images/${id}/pixels?${params}`);
  if (!response.ok) await fail(response);
  const width = Number(response.headers.get("X-Width"));
  const height = Number(response.headers.get("X-Height"));
  const data = new Uint16Array(await response.arrayBuffer());
  return { width, height, data };
}

/** POST ``[uint32 header length][JSON header][parts...]``; parts are referenced by offset in the header. */
export async function postParts(path, header, parts) {
  let offset = 0;
  const described = {};
  const blobs = [];
  for (const [key, part] of Object.entries(parts)) {
    if (!part) continue;
    const bytes = part.bytes;
    described[key] = { ...part.meta, offset, length: bytes.byteLength };
    blobs.push(bytes);
    offset += bytes.byteLength;
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify({ ...header, ...described }));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, headerBytes.byteLength, true);
  const response = await fetch(path, { method: "POST", body: new Blob([length, headerBytes, ...blobs]) });
  if (!response.ok) await fail(response);
  return response;
}

async function json(response) {
  if (!response.ok) await fail(response);
  return response.json();
}

async function fail(response) {
  let message = `Sunucu hatası (${response.status})`;
  try {
    const body = await response.json();
    if (body?.detail) message = body.detail;
  } catch {
    // Non-JSON error body; keep the generic message.
  }
  throw new Error(message);
}
