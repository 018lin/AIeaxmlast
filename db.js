const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { Pool } = require("pg");

let pool;

function getDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
}

function shouldUseSsl(databaseUrl) {
  return process.env.DATABASE_SSL === "true" || databaseUrl.includes("sslmode=require");
}

function getPool() {
  const databaseUrl = getDatabaseUrl();

  if (!databaseUrl) {
    throw new Error("服务端未配置 DATABASE_URL 或 POSTGRES_URL。");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: shouldUseSsl(databaseUrl) ? { rejectUnauthorized: false } : undefined,
    });
  }

  return pool;
}

async function initDatabase() {
  if (!getDatabaseUrl()) {
    console.warn("DATABASE_URL or POSTGRES_URL is not configured. Database APIs will return 503 until it is set.");
    return;
  }

  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  await getPool().query(schema);
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(image\/(?:png|jpe?g|webp));base64,([a-z0-9+/=\s]+)$/i);

  if (!match) {
    throw new Error("图片格式不正确，请上传 PNG、JPG、JPEG 或 WEBP 图片。");
  }

  const mimeType = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");

  if (buffer.length === 0) {
    throw new Error("图片内容为空。");
  }

  return { mimeType, buffer };
}

function toDataUrl(row) {
  return `data:${row.mime_type};base64,${row.image_base64}`;
}

function mapUpload(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.original_name,
    mimeType: row.mime_type,
    image: toDataUrl(row),
    createdAt: row.created_at,
    time: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function asJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function getNumericValue(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

async function createUpload({ kind, name, image }) {
  const { mimeType, buffer } = parseDataUrl(image);
  const result = await getPool().query(
    `
      INSERT INTO uploaded_images (id, kind, original_name, mime_type, image_data)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, kind, original_name, mime_type, encode(image_data, 'base64') AS image_base64, created_at
    `,
    [randomUUID(), kind, name || "未命名图片", mimeType, buffer]
  );

  return mapUpload(result.rows[0]);
}

async function listUploads(kind) {
  const values = [];
  let whereClause = "";

  if (kind) {
    values.push(kind);
    whereClause = "WHERE kind = $1";
  }

  const result = await getPool().query(
    `
      SELECT id, kind, original_name, mime_type, encode(image_data, 'base64') AS image_base64, created_at
      FROM uploaded_images
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT 100
    `,
    values
  );

  return result.rows.map(mapUpload);
}

async function createImageUpload(client, { kind, name, image }) {
  const parsedImage = parseDataUrl(image);
  const id = randomUUID();

  await client.query(
    `
      INSERT INTO uploaded_images (id, kind, original_name, mime_type, image_data)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [id, kind, name || "未命名图片", parsedImage.mimeType, parsedImage.buffer]
  );

  return id;
}

async function deleteUploads(kind) {
  if (!kind) {
    await getPool().query("DELETE FROM uploaded_images");
    return;
  }

  await getPool().query("DELETE FROM uploaded_images WHERE kind = $1", [kind]);
}

async function createPair(payload) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    const paperCrop = parseDataUrl(payload.paperCrop);
    const answerCrop = parseDataUrl(payload.answerCrop);
    const paperCropId = randomUUID();
    const answerCropId = randomUUID();
    const pairId = randomUUID();

    await client.query(
      `
        INSERT INTO uploaded_images (id, kind, original_name, mime_type, image_data)
        VALUES
          ($1, 'paper_crop', $2, $3, $4),
          ($5, 'answer_crop', $6, $7, $8)
      `,
      [
        paperCropId,
        payload.paperCropName || "题目区域裁剪",
        paperCrop.mimeType,
        paperCrop.buffer,
        answerCropId,
        payload.answerCropName || "答案区域裁剪",
        answerCrop.mimeType,
        answerCrop.buffer,
      ]
    );

    const result = await client.query(
      `
        INSERT INTO question_answer_pairs (
          id,
          paper_image_id,
          answer_image_id,
          paper_crop_image_id,
          answer_crop_image_id,
          paper_selection,
          answer_selection
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
        RETURNING id
      `,
      [
        pairId,
        payload.paperImageId || null,
        payload.answerImageId || null,
        paperCropId,
        answerCropId,
        JSON.stringify(payload.paperSelection || {}),
        JSON.stringify(payload.answerSelection || {}),
      ]
    );

    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function listPairs() {
  const result = await getPool().query(`
    SELECT
      p.id,
      p.created_at,
      p.paper_selection,
      p.answer_selection,
      pc.mime_type AS paper_crop_mime_type,
      encode(pc.image_data, 'base64') AS paper_crop_base64,
      ac.mime_type AS answer_crop_mime_type,
      encode(ac.image_data, 'base64') AS answer_crop_base64
    FROM question_answer_pairs p
    JOIN uploaded_images pc ON pc.id = p.paper_crop_image_id
    JOIN uploaded_images ac ON ac.id = p.answer_crop_image_id
    ORDER BY p.created_at DESC
    LIMIT 100
  `);

  return result.rows.map((row) => ({
    id: row.id,
    paperSelection: row.paper_selection,
    answerSelection: row.answer_selection,
    paperCrop: `data:${row.paper_crop_mime_type};base64,${row.paper_crop_base64}`,
    answerCrop: `data:${row.answer_crop_mime_type};base64,${row.answer_crop_base64}`,
    createdAt: row.created_at,
  }));
}

async function createAiGradingHistory(payload) {
  const client = await getPool().connect();
  const result = payload.result && typeof payload.result === "object" ? payload.result : {};

  try {
    await client.query("BEGIN");

    const questionImageId =
      payload.questionImageId ||
      (payload.questionImage
        ? await createImageUpload(client, {
            kind: payload.questionKind === "paper" ? "paper" : "single_question",
            name: payload.questionName || "未命名题目",
            image: payload.questionImage,
          })
        : null);
    const answerImageId =
      payload.answerImageId ||
      (payload.answerImage
        ? await createImageUpload(client, {
            kind: "student_answer",
            name: payload.answerName || "未命名作答",
            image: payload.answerImage,
          })
        : null);

    const insertResult = await client.query(
      `
        INSERT INTO ai_grading_history (
          id,
          question_image_id,
          answer_image_id,
          question_name,
          answer_name,
          max_score,
          rubric,
          model,
          score,
          level,
          analysis,
          deductions,
          suggestions,
          raw_content,
          ai_result
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12::jsonb,
          $13::jsonb,
          $14,
          $15::jsonb
        )
        RETURNING id
      `,
      [
        randomUUID(),
        questionImageId,
        answerImageId,
        payload.questionName || "未命名题目",
        payload.answerName || "未命名作答",
        getNumericValue(result.max_score ?? payload.maxScore) ?? Number(payload.maxScore),
        payload.rubric || "",
        payload.model || "",
        getNumericValue(result.score),
        result.level || "",
        result.analysis || "",
        JSON.stringify(asJsonArray(result.deductions)),
        JSON.stringify(asJsonArray(result.suggestions)),
        payload.rawContent || "",
        Object.keys(result).length ? JSON.stringify(result) : null,
      ]
    );

    await client.query("COMMIT");
    return insertResult.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function listAiGradingHistory() {
  const result = await getPool().query(`
    SELECT
      h.id,
      h.question_name,
      h.answer_name,
      h.max_score,
      h.rubric,
      h.model,
      h.score,
      h.level,
      h.analysis,
      h.deductions,
      h.suggestions,
      h.raw_content,
      h.ai_result,
      h.created_at,
      qi.mime_type AS question_mime_type,
      encode(qi.image_data, 'base64') AS question_base64,
      ai.mime_type AS answer_mime_type,
      encode(ai.image_data, 'base64') AS answer_base64
    FROM ai_grading_history h
    LEFT JOIN uploaded_images qi ON qi.id = h.question_image_id
    LEFT JOIN uploaded_images ai ON ai.id = h.answer_image_id
    ORDER BY h.created_at DESC
    LIMIT 100
  `);

  return result.rows.map((row) => ({
    id: row.id,
    questionName: row.question_name,
    answerName: row.answer_name,
    questionImage: row.question_base64 ? `data:${row.question_mime_type};base64,${row.question_base64}` : "",
    answerImage: row.answer_base64 ? `data:${row.answer_mime_type};base64,${row.answer_base64}` : "",
    maxScore: row.max_score === null ? null : Number(row.max_score),
    rubric: row.rubric,
    model: row.model,
    score: row.score === null ? null : Number(row.score),
    level: row.level,
    analysis: row.analysis,
    deductions: row.deductions,
    suggestions: row.suggestions,
    rawContent: row.raw_content,
    result: row.ai_result,
    createdAt: row.created_at,
  }));
}

async function deleteAiGradingHistory() {
  await getPool().query("DELETE FROM ai_grading_history");
}

module.exports = {
  createAiGradingHistory,
  createPair,
  createUpload,
  deleteAiGradingHistory,
  deleteUploads,
  initDatabase,
  listAiGradingHistory,
  listPairs,
  listUploads,
};
