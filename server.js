const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const fs = require("fs");

// Load .env file
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8")
    .split("\n")
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) return;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && !process.env[key]) process.env[key] = val;
    });
}

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";
const PORT = process.env.PORT || 3000;

const app = express();

app.use(cors());
app.use(express.json({ limit: "5mb" }));

// 静态文件服务（前端 build 产物）
app.use(express.static(path.join(__dirname, "../client/dist")));

// 健康检查
app.get("/health", (_req, res) => res.json({ ok: true }));

// ============================================================
// 飞书 API 辅助函数
// ============================================================

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

async function feishuFetch(path, init = {}) {
  const url = `${FEISHU_BASE_URL}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok || (data.code !== undefined && data.code !== 0)) {
    const msg = data.msg || `Feishu API error ${response.status}`;
    throw new Error(msg);
  }
  return data;
}

async function getTenantAccessToken() {
  const appId = getRequiredEnv("FEISHU_APP_ID");
  const appSecret = getRequiredEnv("FEISHU_APP_SECRET");
  const data = await feishuFetch("/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  return data.tenant_access_token;
}

async function getExistingFields(token, appToken, tableId) {
  const fields = new Map();
  let pageToken = "";

  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (pageToken) query.set("page_token", pageToken);

    const data = await feishuFetch(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/fields?${query.toString()}`,
      { headers: { authorization: `Bearer ${token}` } }
    );

    for (const field of data.data?.items || []) {
      if (field.field_name) fields.set(field.field_name, field);
    }
    pageToken = data.data?.has_more ? data.data?.page_token || "" : "";
  } while (pageToken);

  return fields;
}

// ============================================================
// POST /api/submit
// ============================================================

app.post("/api/submit", async (req, res) => {
  try {
    const { fieldValues } = req.body || {};

    if (!fieldValues || typeof fieldValues !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid payload: fieldValues required" });
    }

    const appToken = getRequiredEnv("FEISHU_APP_TOKEN");
    const tableId = getRequiredEnv("FEISHU_TABLE_ID");

    // Step 1: 获取 tenant_access_token
    const token = await getTenantAccessToken();

    // Step 2: 读取现有字段
    const existingFields = await getExistingFields(token, appToken, tableId);

    // Step 3: 只保留飞书表里存在的字段
    const filteredFields = {};
    let skippedCount = 0;

    for (const [fieldName, value] of Object.entries(fieldValues)) {
      if (!existingFields.has(fieldName)) {
        skippedCount++;
        continue;
      }
      if (value === undefined || value === null || value === "") continue;

      const field = existingFields.get(fieldName);
      // 文本字段类型 type=1，确保值是字符串
      if (field.type === 1 && typeof value !== "string") {
        filteredFields[fieldName] = String(value);
      } else {
        filteredFields[fieldName] = value;
      }
    }

    if (Object.keys(filteredFields).length === 0) {
      return res.status(400).json({
        ok: false,
        error: "No matching Feishu fields found. Please create the fields from the Excel template first.",
      });
    }

    // Step 4: 新增记录
    const data = await feishuFetch(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ fields: filteredFields }),
      }
    );

    return res.json({
      ok: true,
      recordId: data.data?.record?.record_id || "",
      submittedFieldCount: Object.keys(filteredFields).length,
      skippedFieldCount: skippedCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[/api/submit] Error:", message);
    return res.status(500).json({ ok: false, error: message });
  }
});

// 所有其他路径 → 兜回到 index.html（支持 SPA 路由）
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "../client/dist/index.html"), (err) => {
    if (err) res.status(404).send("Not found");
  });
});

const server = http.createServer(app);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
  console.log(`   API endpoint: http://0.0.0.0:${PORT}/api/submit`);
  console.log(`   Frontend:    http://0.0.0.0:${PORT}/`);
});
