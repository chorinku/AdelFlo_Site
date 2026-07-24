/**
 * AdelFlo Worker
 * -----------------
 * 이 Worker는 네 가지 역할을 합니다.
 * 1) GET  /api/gallery     → R2에 저장된 gallery.json 을 그대로 반환 (누구나 조회 가능)
 * 2) POST /api/verify      → Authorization 헤더의 비밀번호가 맞는지만 확인 (로그인 페이지용)
 * 3) POST /api/upload-file → 관리자 비밀번호를 확인한 뒤, 이미지 파일 1장을 R2에 저장하고
 *                             URL만 반환 (gallery.json은 건드리지 않음 — 묶음 업로드용)
 * 4) POST /api/add-entry   → 관리자 비밀번호를 확인한 뒤, 완성된 항목
 *                             { src, desc, extra, extraImages? } 을 gallery.json에 추가
 * 5) POST /api/update-entry → 관리자 비밀번호를 확인한 뒤, 기존 항목 하나를 통째로 교체(수정)
 * 6) POST /api/delete      → 관리자 비밀번호를 확인한 뒤, 특정 항목 삭제
 * 7) GET  /api/backups     → 자동 저장된 백업 목록 조회 (관리자 전용)
 * 8) POST /api/restore     → 특정 백업 시점으로 gallery.json 되돌리기 (관리자 전용)
 *
 * 백업 동작 방식:
 * gallery.json이 바뀌기 직전(add-entry / update-entry / delete 호출 시)마다, 바뀌기 "전"
 * 상태를 backups/gallery-<timestamp>.json 으로 자동 저장합니다. 즉 언제든 "수정되기 전"
 * 시점 중 하나로 되돌릴 수 있습니다. 백업은 최근 50개까지만 보관되고 오래된 것은
 * 자동 정리됩니다.
 *
 * 필요한 설정 (wrangler.toml, 또는 Cloudflare 대시보드에서):
 * - R2 버킷 바인딩 이름: BUCKET   (이미 쓰고 있는 pub-a82833... 버킷)
 * - 환경변수(secret) ADMIN_PASSWORD   → 관리자 비밀번호
 * - 환경변수 PUBLIC_BASE_URL          → R2 퍼블릭 접근 주소
 *   예: https://pub-a82833c98a254446bf65db1f16fa9b05.r2.dev
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function readGallery(env) {
  const obj = await env.BUCKET.get("data/gallery.json");
  if (!obj) return {};
  return JSON.parse(await obj.text());
}

async function writeGallery(env, gallery) {
  await backupCurrent(env);
  await env.BUCKET.put("data/gallery.json", JSON.stringify(gallery, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}

const MAX_BACKUPS = 50;

// 현재 gallery.json 내용을 backups/ 아래에 그대로 복사해둔다 (덮어쓰기 직전 호출).
async function backupCurrent(env) {
  const obj = await env.BUCKET.get("data/gallery.json");
  if (!obj) return; // 아직 gallery.json이 없으면(최초 1회) 백업할 것도 없음
  const content = await obj.text();
  const key = `backups/gallery-${Date.now()}.json`;
  await env.BUCKET.put(key, content, { httpMetadata: { contentType: "application/json" } });
  await pruneBackups(env);
}

// 오래된 백업은 최근 MAX_BACKUPS개만 남기고 정리
async function pruneBackups(env) {
  const list = await env.BUCKET.list({ prefix: "backups/" });
  if (list.objects.length <= MAX_BACKUPS) return;
  const sorted = [...list.objects].sort((a, b) => a.uploaded - b.uploaded); // 오래된 것부터
  const toDelete = sorted.slice(0, sorted.length - MAX_BACKUPS);
  for (const o of toDelete) await env.BUCKET.delete(o.key);
}

function isAuthorized(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.ADMIN_PASSWORD}` && !!env.ADMIN_PASSWORD;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // ---- 공개: 갤러리 데이터 조회 ----
      if (url.pathname === "/api/gallery" && request.method === "GET") {
        const gallery = await readGallery(env);
        return json(gallery);
      }

      // ---- 관리자: 비밀번호 검증 전용 (로그인 페이지에서 사용) ----
      if (url.pathname === "/api/verify" && request.method === "POST") {
        if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
        return json({ ok: true });
      }

      // ---- 관리자: 이미지 파일 하나 업로드 (R2에만 저장, gallery.json은 건드리지 않음) ----
      if (url.pathname === "/api/upload-file" && request.method === "POST") {
        if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

        const form = await request.formData();
        const file = form.get("file");
        const folder = (form.get("folder") || "misc").toString().replace(/^\/+|\/+$/g, "");

        if (!file) return json({ error: "file은 필수입니다." }, 400);

        const ext = (file.name.split(".").pop() || "png").toLowerCase();
        const key = `${folder}/${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;

        await env.BUCKET.put(key, file.stream(), {
          httpMetadata: { contentType: file.type || "image/png" },
        });

        return json({ ok: true, url: `${env.PUBLIC_BASE_URL}/${key}`, key });
      }

      // ---- 관리자: 완성된 항목(메인 이미지 + 부가 이미지 묶음)을 gallery.json에 추가 ----
      // body: { tab, entry: { src, desc, extra, extraImages?: [{src, extra}] } }
      if (url.pathname === "/api/add-entry" && request.method === "POST") {
        if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

        const body = await request.json();
        const tab = body.tab;
        const entry = body.entry;
        if (!tab || !entry || !entry.src) return json({ error: "tab과 entry.src는 필수입니다." }, 400);

        const gallery = await readGallery(env);
        if (!gallery[tab]) gallery[tab] = [];
        gallery[tab].push(entry);
        await writeGallery(env, gallery);

        return json({ ok: true, entry });
      }

      // ---- 관리자: 기존 항목 수정 (전체 교체) ----
      // body: { tab, index, entry: { src, desc, extra, extraImages?: [{src, extra}] } }
      if (url.pathname === "/api/update-entry" && request.method === "POST") {
        if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

        const body = await request.json();
        const { tab, index, entry } = body;
        if (!tab || index === undefined || !entry || !entry.src) {
          return json({ error: "tab, index, entry.src는 필수입니다." }, 400);
        }

        const gallery = await readGallery(env);
        if (!gallery[tab] || gallery[tab][index] === undefined) {
          return json({ error: "수정할 항목을 찾을 수 없습니다." }, 404);
        }
        gallery[tab][index] = entry;
        await writeGallery(env, gallery);

        return json({ ok: true, entry });
      }

      // ---- 관리자: 항목 삭제 (이미지 파일은 R2에 남고, 목록에서만 제거) ----
      if (url.pathname === "/api/delete" && request.method === "POST") {
        if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

        const { tab, index } = await request.json();
        const gallery = await readGallery(env);
        if (gallery[tab] && gallery[tab][index] !== undefined) {
          gallery[tab].splice(index, 1);
          await writeGallery(env, gallery);
        }
        return json({ ok: true });
      }

      // ---- 관리자: 자동 백업 목록 조회 ----
      if (url.pathname === "/api/backups" && request.method === "GET") {
        if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

        const list = await env.BUCKET.list({ prefix: "backups/" });
        const items = list.objects
          .map(o => ({ key: o.key, uploaded: o.uploaded }))
          .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded)); // 최신 순
        return json({ ok: true, backups: items });
      }

      // ---- 관리자: 특정 백업 시점으로 되돌리기 ----
      // body: { key: "backups/gallery-1234567890.json" }
      if (url.pathname === "/api/restore" && request.method === "POST") {
        if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

        const { key } = await request.json();
        if (!key || !key.startsWith("backups/")) return json({ error: "key가 올바르지 않습니다." }, 400);

        const backupObj = await env.BUCKET.get(key);
        if (!backupObj) return json({ error: "해당 백업을 찾을 수 없습니다." }, 404);

        const content = await backupObj.text();
        // 되돌리기 전 "현재" 상태도 백업해둔다 (되돌리기 자체도 취소 가능하도록)
        await backupCurrent(env);
        await env.BUCKET.put("data/gallery.json", content, {
          httpMetadata: { contentType: "application/json" },
        });

        return json({ ok: true });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
