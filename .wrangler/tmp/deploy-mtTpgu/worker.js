var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
  });
}
__name(json, "json");
async function readGallery(env) {
  const obj = await env.BUCKET.get("data/gallery.json");
  if (!obj) return {};
  return JSON.parse(await obj.text());
}
__name(readGallery, "readGallery");
async function writeGallery(env, gallery) {
  await backupCurrent(env);
  await env.BUCKET.put("data/gallery.json", JSON.stringify(gallery, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });
}
__name(writeGallery, "writeGallery");
var MAX_BACKUPS = 50;
async function backupCurrent(env) {
  const obj = await env.BUCKET.get("data/gallery.json");
  if (!obj) return;
  const content = await obj.text();
  const key = `backups/gallery-${Date.now()}.json`;
  await env.BUCKET.put(key, content, { httpMetadata: { contentType: "application/json" } });
  await pruneBackups(env);
}
__name(backupCurrent, "backupCurrent");
async function pruneBackups(env) {
  const list = await env.BUCKET.list({ prefix: "backups/" });
  if (list.objects.length <= MAX_BACKUPS) return;
  const sorted = [...list.objects].sort((a, b) => a.uploaded - b.uploaded);
  const toDelete = sorted.slice(0, sorted.length - MAX_BACKUPS);
  for (const o of toDelete) await env.BUCKET.delete(o.key);
}
__name(pruneBackups, "pruneBackups");
function isAuthorized(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.ADMIN_PASSWORD}` && !!env.ADMIN_PASSWORD;
}
__name(isAuthorized, "isAuthorized");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    try {
      if (url.pathname === "/api/gallery" && request.method === "GET") {
        const gallery = await readGallery(env);
        return json(gallery);
      }
      if (url.pathname === "/api/verify" && request.method === "POST") {
        if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
        return json({ ok: true });
      }
      if (url.pathname === "/api/upload-file" && request.method === "POST") {
        if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
        const form = await request.formData();
        const file = form.get("file");
        const folder = (form.get("folder") || "misc").toString().replace(/^\/+|\/+$/g, "");
        if (!file) return json({ error: "file\uC740 \uD544\uC218\uC785\uB2C8\uB2E4." }, 400);
        const ext = (file.name.split(".").pop() || "png").toLowerCase();
        const key = `${folder}/${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
        await env.BUCKET.put(key, file.stream(), {
          httpMetadata: { contentType: file.type || "image/png" }
        });
        return json({ ok: true, url: `${env.PUBLIC_BASE_URL}/${key}`, key });
      }
      if (url.pathname === "/api/add-entry" && request.method === "POST") {
        if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
        const body = await request.json();
        const tab = body.tab;
        const entry = body.entry;
        if (!tab || !entry || !entry.src) return json({ error: "tab\uACFC entry.src\uB294 \uD544\uC218\uC785\uB2C8\uB2E4." }, 400);
        const gallery = await readGallery(env);
        if (!gallery[tab]) gallery[tab] = [];
        gallery[tab].push(entry);
        await writeGallery(env, gallery);
        return json({ ok: true, entry });
      }
      if (url.pathname === "/api/update-entry" && request.method === "POST") {
        if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
        const body = await request.json();
        const { tab, index, entry } = body;
        if (!tab || index === void 0 || !entry || !entry.src) {
          return json({ error: "tab, index, entry.src\uB294 \uD544\uC218\uC785\uB2C8\uB2E4." }, 400);
        }
        const gallery = await readGallery(env);
        if (!gallery[tab] || gallery[tab][index] === void 0) {
          return json({ error: "\uC218\uC815\uD560 \uD56D\uBAA9\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." }, 404);
        }
        gallery[tab][index] = entry;
        await writeGallery(env, gallery);
        return json({ ok: true, entry });
      }
      if (url.pathname === "/api/delete" && request.method === "POST") {
        if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
        const { tab, index } = await request.json();
        const gallery = await readGallery(env);
        if (gallery[tab] && gallery[tab][index] !== void 0) {
          gallery[tab].splice(index, 1);
          await writeGallery(env, gallery);
        }
        return json({ ok: true });
      }
      if (url.pathname === "/api/backups" && request.method === "GET") {
        if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
        const list = await env.BUCKET.list({ prefix: "backups/" });
        const items = list.objects.map((o) => ({ key: o.key, uploaded: o.uploaded })).sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
        return json({ ok: true, backups: items });
      }
      if (url.pathname === "/api/restore" && request.method === "POST") {
        if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
        const { key } = await request.json();
        if (!key || !key.startsWith("backups/")) return json({ error: "key\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." }, 400);
        const backupObj = await env.BUCKET.get(key);
        if (!backupObj) return json({ error: "\uD574\uB2F9 \uBC31\uC5C5\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." }, 404);
        const content = await backupObj.text();
        await backupCurrent(env);
        await env.BUCKET.put("data/gallery.json", content, {
          httpMetadata: { contentType: "application/json" }
        });
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
