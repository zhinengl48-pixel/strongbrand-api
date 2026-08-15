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
app.use(express.json({ limit: "10mb" }));

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

    if (!data.data?.items) {
      console.log("[getExistingFields] Response:", JSON.stringify(data).slice(0, 300));
    }
    for (const field of data.data?.items || []) {
      if (field.field_name) fields.set(field.field_name, field);
    }
    pageToken = data.data?.has_more ? data.data?.page_token || "" : "";
  } while (pageToken);

  return fields;
}

async function getAttachmentFieldId(token, appToken, tableId) {
  const fields = await getExistingFields(token, appToken, tableId);
  for (const [name, field] of fields.entries()) {
    if (field.type === 17) return { name, fieldId: field.field_id };
  }
  return null;
}

async function uploadPdfToFeishu(token, pdfBase64, fileName, appToken) {
  const buffer = Buffer.from(pdfBase64, "base64");
  const url = `${FEISHU_BASE_URL}/drive/v1/files/upload_all`;

  const form = new FormData();
  form.append("file_name", fileName);
  form.append("parent_type", "bitable_file");
  form.append("parent_node", appToken);
  form.append("size", String(buffer.length));
  form.append("mime", "application/pdf");
  form.append("file", new Blob([buffer], { type: "application/pdf" }), fileName);

  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Upload failed (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok || (data.code !== undefined && data.code !== 0)) {
    throw new Error(data.msg || `Upload failed: ${text.slice(0, 200)}`);
  }
  return data.data?.file_token;
}

async function attachPdfToRecord(token, appToken, tableId, recordId, fieldName, fileToken, fileName, fileSize) {
  const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      fields: {
        [fieldName]: [{ file_token: fileToken, name: fileName, size: fileSize }],
      },
    }),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Attach failed (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok || (data.code !== undefined && data.code !== 0)) {
    throw new Error(data.msg || "PDF attach failed");
  }
}

// ============================================================
// POST /api/submit
// ============================================================

app.post("/api/submit", async (req, res) => {
  try {
    const { fieldValues, pdfBase64, pdfFileName } = req.body || {};

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

    const recordId = data.data?.record?.record_id || "";

    // Step 5: 上传并附加 PDF（如果有）
    let pdfAttached = false;
    let pdfError = null;
    if (pdfBase64 && pdfFileName && recordId) {
      try {
        const attachmentField = await getAttachmentFieldId(token, appToken, tableId);
        if (attachmentField) {
          console.log(`[PDF] Found attachment field: ${attachmentField.name} (${attachmentField.fieldId})`);
          const fileToken = await uploadPdfToFeishu(token, pdfBase64, pdfFileName, appToken);
          const pdfSize = Buffer.from(pdfBase64, "base64").length;
          console.log(`[PDF] Uploaded, token: ${fileToken}, size: ${pdfSize}`);
          await attachPdfToRecord(token, appToken, tableId, recordId, attachmentField.name, fileToken, pdfFileName, pdfSize);
          console.log(`[PDF] Attached ${pdfFileName} to record ${recordId}`);
          pdfAttached = true;
        } else {
          pdfError = "No attachment field found in table";
        }
      } catch (err) {
        pdfError = err.message;
        console.error("[/api/submit] PDF attachment error:", err.message);
      }
    }

    return res.json({
      ok: true,
      recordId,
      submittedFieldCount: Object.keys(filteredFields).length,
      skippedFieldCount: skippedCount,
      pdfAttached,
      pdfError,
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
