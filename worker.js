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
 * 5) POST /api/delete      → 관리자 비밀번호를 확인한 뒤, 특정 항목 삭제
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
  await env.BUCKET.put("data/gallery.json", JSON.stringify(gallery, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
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

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
